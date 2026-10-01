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
  readonly property var requests: snapshot.requests

  // Which run the graph is showing. 0 = newest (the live one); the arrow keys or
  // a click on a row in RECENT inspect an earlier run without losing the live view.
  property int selectedIndex: 0
  readonly property int shownIndex: requests.length === 0 ? 0 : Math.min(selectedIndex, requests.length - 1)
  readonly property var active: requests.length > 0 ? requests[shownIndex] : null
  readonly property bool viewingNewest: shownIndex === 0
  readonly property var latest: requests.length > 0 ? requests[0] : null
  // Each run may carry its own graph (an orchestrator run draws its plan).
  readonly property var arch: Model.architectureFor(snapshot, active)
  onActiveChanged: graph.requestPaint()
  readonly property var recent: requests.length > 1
    ? requests.slice(1, Math.min(requests.length, 6))
    : []

  // Flow animation: only while a request is in flight, so an idle bar costs nothing.
  property real phase: 0
  property double nowMs: Date.now()

  // While a request is in flight the panel ticks its own clock, so the duration
  // counts up instead of showing 0 until the run finishes.
  function liveDurationMs() {
    if (!root.active) return 0
    var done = Model.durationMs(root.active)
    if (done) return done
    var started = Date.parse(String(root.active.at || ""))
    if (isNaN(started)) return 0
    return Math.max(0, root.nowMs - started)
  }
  readonly property bool animating: !!active && String(active.state) === "running"
  readonly property var activeIssues: Model.issues(active)
  readonly property int problems: Model.problemCount(active)

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
    if (String(state || "") === "waiting_human") return root.accent
    var key = Model.stateColorKey(state)
    if (key === "accent") return root.accent
    if (key === "urgent") return root.urgent
    if (key === "normal") return root.foreground
    return root.dim
  }

  function stateLabel(state) {
    var s = String(state || "").toLowerCase()
    if (s === "done") return "DONE"
    if (s === "running") return "RUNNING"
    if (s === "waiting_human") return "WAITING · HUMAN"
    if (s === "error") return "ERROR"
    return "IDLE"
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
      root.nowMs = Date.now()
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
      onMoveRequested: function(dx, dy) {
        if (dy === 0 || root.requests.length === 0) return
        root.selectedIndex = Math.max(0, Math.min(root.requests.length - 1, root.shownIndex + (dy > 0 ? 1 : -1)))
      }

      Column {
        id: column
        width: parent.width
        spacing: Style.space(8)

        // ---------------------------------------------------------- header
        Row {
          width: parent.width
          spacing: Style.space(8)

          Text {
            text: "Agent Pipeline"
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

          Text {
            visible: root.requests.length > 1 && !root.viewingNewest
            text: "· viewing " + (root.shownIndex + 1) + "/" + root.requests.length
            color: root.accent
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Text {
            visible: root.viewingNewest && !!root.latest && String(root.latest.state) === "running"
            text: "· LIVE"
            color: root.accent
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
          }

          Item { width: Math.max(0, parent.width - x - stateBadge.width); height: 1 }

          Rectangle {
            id: stateBadge
            width: badgeLabel.implicitWidth + Style.space(12)
            height: badgeLabel.implicitHeight + Style.space(4)
            radius: height / 2
            color: root.withAlpha(root.stateColor(active ? active.state : "idle"), 0.18)
            border.width: 1
            border.color: root.stateColor(active ? active.state : "idle")

            Text {
              id: badgeLabel
              anchors.centerIn: parent
              text: root.stateLabel(active ? active.state : "idle")
              color: root.stateColor(active ? active.state : "idle")
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
          readonly property var bounds: Model.contentBounds(root.arch)
          height: Math.round(width * bounds.h / bounds.w)
          antialiasing: true

          onPaint: {
            var ctx = getContext("2d")
            ctx.reset()
            ctx.clearRect(0, 0, width, height)

            var arch = root.arch
            var b = bounds
            var k = width / b.w
            ctx.save()
            ctx.translate(-b.x * k, -b.y * k)
            ctx.scale(k, k)

            // ---- edges -------------------------------------------------
            var edges = arch.edges || []
            for (var i = 0; i < edges.length; i++) {
              var e = edges[i]
              var a = Model.nodeById(arch, e.from)
              var c = Model.nodeById(arch, e.to)
              if (!a || !c) continue
              var x1 = a.x + a.w, y1 = a.y + a.h / 2
              var x2 = c.x, y2 = c.y + c.h / 2
              var mid = (x1 + x2) / 2
              var live = Model.edgeTraversed(root.active, e.from, e.to)

              ctx.strokeStyle = live ? root.withAlpha(root.accent, 0.9) : root.withAlpha(root.foreground, 0.14)
              ctx.lineWidth = live ? 1.6 : 1
              ctx.beginPath()
              ctx.moveTo(x1, y1)
              ctx.bezierCurveTo(mid, y1, mid, y2, x2, y2)
              ctx.stroke()

              // information flowing along the path the request took
              if (live && root.animating) {
                for (var d = 0; d < 3; d++) {
                  var t = (root.phase + d / 3) % 1.0
                  ctx.beginPath()
                  ctx.arc(bezier(t, x1, mid, mid, x2), bezier(t, y1, y1, y2, y2), 2.1, 0, Math.PI * 2)
                  ctx.fillStyle = root.accent
                  ctx.fill()
                }
              }
              // Label placement: skip short hops (the text would sit on a node
              // caption) and lift the rest clear of the cards.
              if (e.label && Math.abs(x2 - x1) > 96) {
                ctx.fillStyle = root.withAlpha(root.dim, 0.8)
                ctx.font = "400 8px " + root.fontFamily
                var lx = bezier(0.5, x1, mid, mid, x2)
                var ly = bezier(0.5, y1, y1, y2, y2)
                var text = String(e.label)
                ctx.fillText(text, lx - ctx.measureText(text).width / 2, ly - 7)
              }
            }

            // ---- nodes -------------------------------------------------
            var nodes = arch.nodes || []
            for (var n = 0; n < nodes.length; n++) {
              var node = nodes[n]
              var status = Model.nodeStatus(root.active, node.id)
              var color = nodeColor(status)
              var r = 7

              ctx.beginPath()
              ctx.moveTo(node.x + r, node.y)
              ctx.arcTo(node.x + node.w, node.y, node.x + node.w, node.y + node.h, r)
              ctx.arcTo(node.x + node.w, node.y + node.h, node.x, node.y + node.h, r)
              ctx.arcTo(node.x, node.y + node.h, node.x, node.y, r)
              ctx.arcTo(node.x, node.y, node.x + node.w, node.y, r)
              ctx.closePath()
              ctx.fillStyle = status ? root.withAlpha(color, status === "error" ? 0.2 : 0.11)
                                     : root.withAlpha(root.foreground, 0.04)
              ctx.fill()
              ctx.strokeStyle = status ? color : root.withAlpha(root.foreground, 0.2)
              ctx.lineWidth = (status === "error" || status === "running") ? 1.7 : 1
              ctx.stroke()

              // Chinese name on the card, English + runtime detail underneath
              ctx.fillStyle = status ? color : root.dim
              ctx.font = "600 10.5px " + root.fontFamily
              var label = String(node.label || node.id)
              ctx.fillText(label, node.x + node.w / 2 - ctx.measureText(label).width / 2, node.y + node.h / 2 + 3.5)

              var bits = []
              var en = Model.nodeSubtitle(node)
              if (en && en !== String(node.label || "")) bits.push(en)
              var detail = Model.nodeDetail(root.active, node.id)
              if (detail) bits.push(detail)
              var ms = Model.fmtMs(Model.nodeMs(root.active, node.id))
              if (ms) bits.push(ms)
              var sub = bits.join(" · ")
              if (sub !== "") {
                ctx.fillStyle = root.withAlpha(root.dim, 0.95)
                ctx.font = "400 8px " + root.fontFamily
                if (ctx.measureText(sub).width > node.w + 34)
                  sub = sub.slice(0, Math.max(6, Math.floor(sub.length * (node.w + 34) / ctx.measureText(sub).width) - 1)) + "…"
                ctx.fillText(sub, node.x + node.w / 2 - ctx.measureText(sub).width / 2, node.y + node.h + 10)
              }
            }

            ctx.restore()
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
          visible: !!root.active
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
        }

        Text {
          width: parent.width
          visible: root.requests.length === 0
          text: "No requests recorded yet. Any agent runtime can append to " + root.dataPath
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          wrapMode: Text.WordWrap
        }

        Text {
          width: parent.width
          visible: !!root.active
          text: root.active ? (root.active.title || "(untitled request)") : ""
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
          elide: Text.ElideRight
        }

        Text {
          width: parent.width
          visible: !!root.active
          text: {
            if (!root.active) return ""
            var t = root.active.tokens || {}
            var dur = Model.fmtMs(root.liveDurationMs()) || "0ms"
            var bits = ["Duration " + dur + (root.animating ? "  (running)" : "")]
            if (t.input) bits.push("In " + Model.fmtTokens(t.input))
            if (t.output) bits.push("Out " + Model.fmtTokens(t.output))
            if (t.cacheRead) bits.push("Cache " + Model.fmtTokens(t.cacheRead))
            var cost = Model.fmtCost(t.costUsd)
            if (cost !== "") bits.push(cost)
            if (root.active.model) bits.push(root.active.model)
            return bits.join("  ·  ")
          }
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        // --------------------------------------------------------- problems
        Repeater {
          model: root.activeIssues

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

          Rectangle {
            required property var modelData
            required property int index
            width: column.width
            height: recentRow.implicitHeight + Style.space(4)
            radius: 6
            color: (root.shownIndex === index + 1)
              ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.14)
              : "transparent"

            MouseArea {
              anchors.fill: parent
              cursorShape: Qt.PointingHandCursor
              onClicked: root.selectedIndex = (root.shownIndex === index + 1) ? 0 : index + 1
            }

            Row {
              id: recentRow
              width: parent.width
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

        Text {
          width: parent.width
          visible: root.requests.length > 1
          text: root.viewingNewest
            ? "Newest run · ↑↓ or click a row to inspect an earlier one"
            : "Inspecting run " + (root.shownIndex + 1) + " of " + root.requests.length + " · ↑↓ to move, click it again for the newest"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
  }
}
