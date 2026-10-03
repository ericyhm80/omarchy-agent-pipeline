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

  readonly property bool alarming: healthAlert || worst > 0 || (!!latest && String(latest.state) === "error")

  // Architecture health, so the glyph can turn urgent before a score is low.
  readonly property var health: Model.computeHealth(requests)
  readonly property bool healthAlert: health.alert === true
  readonly property var windowStats: Model.windowStats(requests)
  // The weakest scored dimension, security first on a tie — it is the one that
  // must never slip. null when nothing has been scored yet.
  readonly property var worstDim: {
    var order = ["security", "stability", "robustness"]
    var letter = { security: "Sec", stability: "S", robustness: "R" }
    var best = null
    for (var i = 0; i < order.length; i++) {
      var d = health[order[i]]
      if (d.score === null) continue
      if (best === null || d.score < best.score)
        best = { key: order[i], letter: letter[order[i]], score: d.score, level: d.level }
    }
    return best
  }
  readonly property bool busy: running > 0 || (!!latest && String(latest.state) === "running")

  function reload() {
    dataView.reload()
  }

  function parseText(text) {
    snapshot = Model.parse(text)
  }

  function tooltip() {
    var scores = "S " + Model.fmtScore(health.stability.score)
      + " · R " + Model.fmtScore(health.robustness.score)
      + " · Sec " + Model.fmtScore(health.security.score)

    // The window in short, and the weakest dimension, so hovering answers
    // both "how has it been?" and "what is wrong?" without opening the panel.
    var s = windowStats
    var win = []
    if (s.settled) {
      win.push(s.settled + " runs")
      if (s.successRate !== null) win.push(s.successRate + "% ok")
      var c = Model.fmtCost(s.totalCost); if (c !== "") win.push(c)
      if (s.cacheHitPct !== null) win.push("cache " + s.cacheHitPct + "%")
      if (s.medianMs) win.push("median " + Model.fmtMs(s.medianMs))
      var age = Model.ageLabel(s.lastAgeMs); if (age !== "") win.push(age)
    }
    var lines = [scores]
    if (win.length) lines.push(win.join(" · "))
    if (worstDim && worstDim.level !== "good") lines.push("weak: " + worstDim.letter + " " + worstDim.score)

    // A number is only as good as the instrument that produced it: say so here too,
    // so a glance at the bar is enough to know the scores came from older code.
    var inst = Model.instrumentStatus(snapshot)
    if (inst.state === "stale" || inst.state === "unregistered")
      lines.push("instrument mismatch: loaded "
        + (inst.loaded ? String(inst.loaded.extVersion || "?") : "unregistered")
        + " / disk " + (inst.disk ? String(inst.disk.version || "?") : "?"))

    if (!latest) return "Agent pipeline — " + lines.join("  |  ") + " (no requests yet)"
    var parts = [String(latest.state || "").toUpperCase()]
    if (latest.title) parts.push(String(latest.title))
    if (latest.taskClass) parts.push(String(latest.taskClass))
    if (latest.model) parts.push(String(latest.model))
    if (running > 0) parts.push(running + " running")
    return parts.join(" · ") + "\n" + lines.join("\n")
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
