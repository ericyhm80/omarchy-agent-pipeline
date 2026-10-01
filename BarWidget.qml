import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar pill for the agent pipeline: one glyph whose colour follows the newest
// request, and the panel behind it showing how the agent got to its answer.
//
// Left click opens the pipeline panel, middle click reloads the data file,
// right click closes an open panel.
BarWidget {
  id: root
  moduleName: "io.github.ericyhm80.agent-pipeline"

  readonly property string dataPath: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state"))
    + "/omarchy/agent-pipeline/requests.json"

  property var snapshot: Model.parse("")

  readonly property var requests: snapshot.requests
  readonly property var latest: requests.length > 0 ? requests[0] : null
  readonly property int running: Model.runningCount(requests)
  readonly property int worst: latest ? Model.worstStepLevel(latest) : 0

  readonly property bool alarming: worst > 0 || (!!latest && String(latest.state) === "error")
  readonly property bool busy: running > 0 || (!!latest && String(latest.state) === "running")

  function reload() {
    dataView.reload()
  }

  function parseText(text) {
    snapshot = Model.parse(text)
  }

  function tooltip() {
    if (!latest) return "Agent pipeline — no requests recorded yet"
    var parts = [String(latest.state || "").toUpperCase()]
    if (latest.title) parts.push(String(latest.title))
    if (latest.taskClass) parts.push(String(latest.taskClass))
    if (latest.model) parts.push(String(latest.model))
    if (running > 0) parts.push(running + " running")
    return parts.join(" · ")
  }

  // ---- Panel shape contract (Bar.findPanelWidget requires these on the root)
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item) panelLoader.item.close()
  }

  function togglePanel() {
    if (panelLoader.item) panelLoader.item.toggle()
  }

  readonly property bool popoutSwitchClosing: panelLoader.item
    ? panelLoader.item.popoutSwitchClosing === true
    : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  FileView {
    id: dataView
    path: root.dataPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.parseText(text())
    onLoadFailed: root.parseText("")
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "io.github.ericyhm80.agent-pipeline"

    function refresh(): void { root.reload() }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󱚣"
    active: root.alarming
    tooltipText: root.tooltip()

    onPressed: function(buttonCode) {
      if (buttonCode === Qt.MiddleButton) root.reload()
      else if (buttonCode === Qt.RightButton) root.close()
      else root.togglePanel()
    }
  }
}
