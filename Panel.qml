import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The pipeline panel, v0.2: the agent's architecture as a live graph.
// Nodes are the stages of the pipeline, edges are how information travels, and
// the newest request lights the path it actually took — with tokens, duration
// and any problems it ran into, so the whole run is explainable to someone who
// has never seen an agent work.
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
  readonly property color faint: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.28)
  readonly property color accent: Color.accent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property string dataPath: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state"))
    + "/omarchy/agent-pipeline/requests.json"

  property var snapshot: Model.parse("")
  readonly property var arch: Model.architecture(snapshot)
  readonly property var requests: snapshot.requests
  readonly property var latest: requests.length > 0 ? requests[0] : null
  readonly property var recent: requests.length > 1
    ? requests.slice(1, Math.min(requests.length, 6))
    : []

  // Flow animation: only while a request is in flight, so an idle bar costs nothing.
  property real phase: 0
  readonly property bool animating: !!latest && String(latest.state) === "running"
  readonly property var latestIssues: Model.issues(latest)
  readonly property int problems: Model.problemCount(latest)

  function refresh() {
    dataView.reload()
  }

  function nodeColor(status) {
    var s = String(status || "").toLowerCase()
    if (s === "error" || s === "failed") return root.urgent
    if (s === "running") return root.accent
    if (s === "warn") return root.accent
    if (s === "skipped") return root.dim
    if (s === "ok" || s === "done" || s === "success") return root.foreground
    return root.faint
  }

  function stateColor(state) {
    var key = Model.stateColorKey(state)
    if (key === "accent") return root.accent
    if (key === "urgent") return root.urgent
    if (key === "normal") return root.foreground
    return root.dim
  }

  function withAlpha(c, a) {
    return Qt.rgba(c.r, c.g, c.b, a)
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
    onLoaded: {
      root.snapshot = Model.parse(text())
      graph.requestPaint()
    }
    onLoadFailed: {
      root.snapshot = Model.parse("")
      graph.requestPaint()
    }
  }

  Timer {
    interval: 60
    running: root.animating
    repeat: true
    onTriggered: {
      root.phase = (root.phase + 0.06) % 1.0
      graph.requestPaint()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(580))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(720))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()

      Column {
        id: column
        width: parent.width
        spacing: Style.space(8)

        // ---------------------------------------------------------- header
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

          Text {
            visible: root.problems > 0
            text: "⚠ " + root.problems
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Item { width: Math.max(0, parent.width - x - stateBadge.width); height: 1 }

          Rectangle {
            id: stateBadge
            width: badgeLabel.implicitWidth + Style.space(12)
            height: badgeLabel.implicitHeight + Style.space(4)
            radius: height / 2
            color: root.withAlpha(root.stateColor(latest ? latest.state : "idle"), 0.18)
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

        // ------------------------------------------------------- the graph
        Canvas {
          id: graph
          width: column.width
          height: Math.round(width * (root.arch.height || 380) / (root.arch.width || 720))
          antialiasing: true

          onPaint: {
            var ctx = getContext("2d")
            var arch = root.arch
            var sx = width / (arch.width || 720)
            var sy = height / (arch.height || 380)
            ctx.reset()
            ctx.clearRect(0, 0, width, height)

            // ---- edges
            var edges = arch.edges || []
            for (var i = 0; i < edges.length; i++) {
              var e = edges[i]
              var a = Model.nodeById(arch, e.from)
              var b = Model.nodeById(arch, e.to)
              if (!a || !b) continue
              var x1 = (a.x + a.w) * sx, y1 = (a.y + a.h / 2) * sy
              var x2 = b.x * sx, y2 = (b.y + b.h / 2) * sy
              var live = Model.edgeTraversed(root.latest, e.from, e.to)
              ctx.strokeStyle = live ? root.withAlpha(root.accent, 0.85) : root.withAlpha(root.foreground, 0.16)
              ctx.lineWidth = live ? Math.max(1.4, 1.8 * sx) : 1
              ctx.beginPath()
              ctx.moveTo(x1, y1)
              var mid = (x1 + x2) / 2
              ctx.bezierCurveTo(mid, y1, mid, y2, x2, y2)
              ctx.stroke()

              // ---- information flowing along the traversed path
              if (live && root.animating) {
                for (var d = 0; d < 3; d++) {
                  var t = (root.phase + d / 3) % 1.0
                  var px = bezier(t, x1, mid, mid, x2)
                  var py = bezier(t, y1, y1, y2, y2)
                  ctx.beginPath()
                  ctx.arc(px, py, Math.max(1.6, 2.6 * sx), 0, Math.PI * 2)
                  ctx.fillStyle = root.accent
                  ctx.fill()
                }
              }
              if (e.label && sx > 0.55) {
                ctx.fillStyle = root.withAlpha(root.dim, 0.9)
                ctx.font = "500 " + Math.round(9 * sx) + "px " + root.fontFamily
                ctx.fillText(String(e.label), (x1 + x2) / 2 - 18 * sx, (y1 + y2) / 2 - 4 * sx)
              }
            }

            // ---- nodes
            var nodes = arch.nodes || []
            for (var n = 0; n < nodes.length; n++) {
              var node = nodes[n]
              var status = Model.nodeStatus(root.latest, node.id)
              var color = root.nodeColor(status)
              var x = node.x * sx, y = node.y * sy
              var w = node.w * sx, h = node.h * sy
              var r = Math.min(10, h / 4)

              ctx.beginPath()
              ctx.moveTo(x + r, y)
              ctx.arcTo(x + w, y, x + w, y + h, r)
              ctx.arcTo(x + w, y + h, x, y + h, r)
              ctx.arcTo(x, y + h, x, y, r)
              ctx.arcTo(x, y, x + w, y, r)
              ctx.closePath()
              ctx.fillStyle = status
                ? root.withAlpha(color, status === "error" ? 0.22 : 0.12)
                : root.withAlpha(root.foreground, 0.04)
              ctx.fill()
              ctx.strokeStyle = status ? color : root.withAlpha(root.foreground, 0.22)
              ctx.lineWidth = status === "error" || status === "running" ? 2 : 1
              ctx.stroke()

              ctx.fillStyle = status ? color : root.dim
              ctx.font = "600 " + Math.round(11 * sx) + "px " + root.fontFamily
              var label = String(node.label || node.id)
              ctx.fillText(label, x + w / 2 - ctx.measureText(label).width / 2, y + h / 2 + 4 * sy)

              var detail = Model.nodeDetail(root.latest, node.id)
              var ms = Model.fmtMs(Model.nodeMs(root.latest, node.id))
              var sub = [detail, ms].filter(function(v) { return v !== "" }).join(" · ")
              if (sub !== "" && sx > 0.62) {
                ctx.fillStyle = root.withAlpha(root.dim, 0.95)
                ctx.font = "400 " + Math.round(9 * sx) + "px " + root.fontFamily
                var text = sub.length > 26 ? sub.slice(0, 25) + "…" : sub
                ctx.fillText(text, x + w / 2 - ctx.measureText(text).width / 2, y + h + 12 * sy)
              }
            }
          }

          function bezier(t, p0, p1, p2, p3) {
            var u = 1 - t
            return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
          }
        }

        // ----------------------------------------------------- run summary
        Rectangle {
          width: parent.width
          height: 1
          visible: !!root.latest
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
        }

        Text {
          width: parent.width
          visible: !root.latest
          text: "No requests recorded yet. Any agent runtime can write " + root.dataPath
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          wrapMode: Text.WordWrap
        }

        Text {
          width: parent.width
          visible: !!root.latest
          text: root.latest ? (root.latest.title || "(untitled request)") : ""
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
          elide: Text.ElideRight
        }

        Text {
          width: parent.width
          visible: !!root.latest
          text: {
            if (!root.latest) return ""
            var t = root.latest.tokens || {}
            var bits = ["耗时 " + (Model.fmtMs(Model.durationMs(root.latest)) || "0ms")]
            if (t.input) bits.push("输入 " + Model.fmtTokens(t.input))
            if (t.output) bits.push("输出 " + Model.fmtTokens(t.output))
            if (t.cacheRead) bits.push("缓存 " + Model.fmtTokens(t.cacheRead))
            var cost = Model.fmtCost(t.costUsd)
            if (cost !== "") bits.push(cost)
            if (root.latest.model) bits.push(root.latest.model)
            return bits.join("  ·  ")
          }
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        // --------------------------------------------------------- problems
        Repeater {
          model: root.latestIssues

          Row {
            required property var modelData
            width: column.width
            spacing: Style.space(6)

            Text {
              text: String(modelData.level || "info").toUpperCase() === "ERROR" ? "✕" : "⚠"
              color: String(modelData.level || "") === "error" ? root.urgent : root.accent
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }

            Text {
              text: (modelData.node ? "[" + modelData.node + "] " : "") + String(modelData.detail || "")
              color: String(modelData.level || "") === "error" ? root.urgent : root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              width: column.width - Style.space(20)
              wrapMode: Text.WordWrap
            }
          }
        }

        // ----------------------------------------------------------- recent
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
              width: Style.space(42)
            }

            Text {
              text: String(modelData.title || modelData.id || "")
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
              width: column.width - Style.space(42) - Style.space(150) - Style.space(60)
            }

            Text {
              text: Model.fmtMs(Model.durationMs(modelData))
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignRight
              width: Style.space(52)
            }

            Text {
              text: Model.problemCount(modelData) > 0 ? "⚠" + Model.problemCount(modelData) : ""
              color: root.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              width: Style.space(20)
            }
          }
        }
      }
    }
  }
}
