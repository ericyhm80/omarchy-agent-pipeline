import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The pipeline panel: one request rendered as the steps the agent actually
// took (classify, route, retrieve, act, verify) with timing, tokens and cost,
// then the most recent requests for context.
Panel {
  id: root
  moduleName: "io.github.ericyhm80.agent-pipeline"
  ipcTarget: "io.github.ericyhm80.agent-pipeline"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color accent: Color.accent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property string dataPath: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state"))
    + "/omarchy/agent-pipeline/requests.json"

  property var snapshot: Model.parse("")
  readonly property var requests: snapshot.requests
  readonly property var latest: requests.length > 0 ? requests[0] : null
  readonly property var recent: requests.length > 1
    ? requests.slice(1, Math.min(requests.length, 7))
    : []

  function refresh() {
    dataView.reload()
  }

  function stateColor(state) {
    var key = Model.stateColorKey(state)
    if (key === "accent") return root.accent
    if (key === "urgent") return root.urgent
    if (key === "normal") return root.foreground
    return root.dim
  }

  function stepColor(status) {
    var s = String(status || "").toLowerCase()
    if (s === "error" || s === "failed") return root.urgent
    if (s === "warn" || s === "skipped") return root.accent
    if (s === "running") return root.accent
    return root.foreground
  }

  // ---- Panel lifecycle contract used by the bar and the popout coordinator
  function open() {
    refresh()
    root.controller.show()
  }

  function close() {
    setCenterHoverRevealSuppressed(false)
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && typeof root.bar.setCenterHoverRevealSuppressed === "function")
      root.bar.setCenterHoverRevealSuppressed(value)
    else if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  readonly property bool popoutSwitchClosing: false

  function closeForPopoutSwitch() {
    root.close()
  }

  FileView {
    id: dataView
    path: root.dataPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.snapshot = Model.parse(text())
    onLoadFailed: root.snapshot = Model.parse("")
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(460))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(620))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()

      Column {
        id: column
        width: parent.width
        spacing: Style.space(10)

        // ---- header -------------------------------------------------------
        Row {
          width: parent.width
          spacing: Style.space(8)

          Text {
            text: "Agent pipeline"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.subtitle
            font.bold: true
          }

          Item { width: parent.width - x - stateBadge.width; height: 1 }

          Rectangle {
            id: stateBadge
            width: badgeLabel.implicitWidth + Style.space(12)
            height: badgeLabel.implicitHeight + Style.space(4)
            radius: height / 2
            color: Qt.rgba(root.stateColor(latest ? latest.state : "idle").r,
                           root.stateColor(latest ? latest.state : "idle").g,
                           root.stateColor(latest ? latest.state : "idle").b, 0.18)
            border.width: 1
            border.color: root.stateColor(latest ? latest.state : "idle")

            Text {
              id: badgeLabel
              anchors.centerIn: parent
              text: String(latest ? (latest.state || "unknown") : "idle").toUpperCase()
              color: root.stateColor(latest ? latest.state : "idle")
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }
          }
        }

        Text {
          width: parent.width
          visible: !root.latest
          text: "No requests recorded yet. Any agent runtime can write " + dataPath
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          wrapMode: Text.WordWrap
        }

        // ---- newest request ----------------------------------------------
        Column {
          width: parent.width
          spacing: Style.space(6)
          visible: !!root.latest

          Text {
            width: parent.width
            text: root.latest ? (root.latest.title || "(untitled request)") : ""
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            font.bold: true
            elide: Text.ElideRight
          }

          Text {
            width: parent.width
            text: {
              if (!root.latest) return ""
              var bits = []
              if (root.latest.taskClass) bits.push("class " + root.latest.taskClass)
              if (root.latest.route) bits.push("route " + root.latest.route)
              if (root.latest.model) bits.push(root.latest.model)
              if (root.latest.agent) bits.push(root.latest.agent)
              return bits.join("  ·  ")
            }
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }

          Text {
            width: parent.width
            text: {
              if (!root.latest) return ""
              var t = root.latest.tokens || {}
              var bits = ["total " + (Model.fmtMs(Model.totalMs(root.latest)) || "0ms")]
              if (t.input) bits.push("in " + Model.fmtTokens(t.input))
              if (t.output) bits.push("out " + Model.fmtTokens(t.output))
              if (t.cacheRead) bits.push("cache " + Model.fmtTokens(t.cacheRead))
              var cost = Model.fmtCost(t.costUsd)
              if (cost !== "") bits.push(cost)
              if (root.latest.at) bits.push(Model.shortClock(root.latest.at))
              return bits.join("  ·  ")
            }
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }

          Rectangle {
            width: parent.width
            height: 1
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
          }

          Repeater {
            model: root.latest ? (root.latest.steps || []) : []

            Row {
              required property var modelData
              width: column.width
              spacing: Style.space(8)

              Text {
                text: Model.stepMark(modelData.status)
                color: root.stepColor(modelData.status)
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.bold: true
              }

              Text {
                text: String(modelData.name || "")
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
                width: Style.space(90)
              }

              Text {
                text: String(modelData.detail || "")
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                width: column.width - Style.space(90) - Style.space(80) - Style.space(24)
                elide: Text.ElideRight
              }

              Text {
                text: Model.fmtMs(modelData.ms)
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                horizontalAlignment: Text.AlignRight
                width: Style.space(56)
              }
            }
          }
        }

        // ---- recent requests ---------------------------------------------
        Rectangle {
          width: parent.width
          height: 1
          visible: root.recent.length > 0
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
        }

        Text {
          visible: root.recent.length > 0
          text: "RECENT"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.bold: true
        }

        Repeater {
          model: root.recent

          Row {
            required property var modelData
            width: column.width
            spacing: Style.space(8)

            Text {
              text: "●"
              color: root.stateColor(modelData.state)
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Text {
              text: Model.shortClock(modelData.at)
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              width: Style.space(44)
            }

            Text {
              text: String(modelData.title || modelData.id || "")
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
              width: column.width - Style.space(44) - Style.space(120) - Style.space(24)
            }

            Text {
              text: String(modelData.taskClass || "")
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignRight
              width: Style.space(100)
              elide: Text.ElideRight
            }
          }
        }

        Text {
          width: parent.width
          text: "Any runtime can append to " + dataPath
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideMiddle
        }
      }
    }
  }
}
