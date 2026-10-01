.pragma library

// Data contract (documented in README): a single JSON file that any agent
// runtime can write.
//
// {
//   "updatedAt": "2026-10-01T12:00:00Z",
//   "requests": [
//     {
//       "id": "req-1", "at": "...", "title": "定价决策", "agent": "entrepreneur-agent",
//       "state": "running|done|error", "taskClass": "strategy", "route": "strong",
//       "model": "zai/glm-5.3-highspeed",
//       "tokens": { "input": 1200, "output": 90, "cacheRead": 4000, "costUsd": 0.002 },
//       "steps": [ { "name": "classify", "status": "ok", "detail": "...", "ms": 0 } ]
//     }
//   ]
// }

function parse(text) {
  var data = null
  try {
    data = JSON.parse(String(text || ""))
  } catch (err) {
    return { updatedAt: "", requests: [], invalid: true }
  }
  if (!data || !data.requests || !Array.isArray(data.requests))
    return { updatedAt: "", requests: [], invalid: true }
  var rows = data.requests.slice()
  rows.sort(function(a, b) { return String(b.at || "") > String(a.at || "") ? 1 : -1 })
  return { updatedAt: String(data.updatedAt || ""), requests: rows, invalid: false }
}

// Shipped default graph, mirroring the writer's default so the widget renders
// something meaningful before any runtime defines its own architecture.
var DEFAULT_ARCH = {
  width: 712, height: 236,
  nodes: [
    { id: "input",      label: "命令输入",    labelEn: "Input",              x: 6,   y: 96,  w: 122, h: 42 },
    { id: "router",     label: "分类 / 路由", labelEn: "Classify + Route",   x: 146, y: 96,  w: 128, h: 42 },
    { id: "context",    label: "上下文装配",  labelEn: "Context",            x: 292, y: 12,  w: 122, h: 42 },
    { id: "memory",     label: "记忆检索",    labelEn: "Memory",             x: 292, y: 96,  w: 122, h: 42 },
    { id: "model",      label: "模型调用",    labelEn: "Model",              x: 292, y: 180, w: 122, h: 42 },
    { id: "tools",      label: "工具执行",    labelEn: "Tools",              x: 432, y: 138, w: 118, h: 42 },
    { id: "verify",     label: "校验 / 遥测", labelEn: "Verify",             x: 432, y: 54,  w: 118, h: 42 },
    { id: "human_gate", label: "人工确认",    labelEn: "Human Gate",         x: 584, y: 180, w: 122, h: 42 },
    { id: "output",     label: "输出完成",    labelEn: "Output",             x: 584, y: 54,  w: 122, h: 42 }
  ],
  edges: [
    { from: "input", to: "router" },
    { from: "router", to: "context", label: "上下文" },
    { from: "router", to: "memory", label: "检索" },
    { from: "context", to: "model" },
    { from: "memory", to: "model" },
    { from: "model", to: "tools", label: "需要工具" },
    { from: "model", to: "verify", label: "回答" },
    { from: "tools", to: "verify" },
    { from: "verify", to: "output" },
    { from: "verify", to: "human_gate", label: "需人工" }
  ]
}

// Bounding box of the drawn graph, so the canvas can be sized to the content
// instead of to the declared canvas area (keeps the panel compact).
function contentBounds(arch) {
  var nodes = (arch && arch.nodes) || []
  if (!nodes.length) return { x: 0, y: 0, w: arch && arch.width || 712, h: arch && arch.height || 236 }
  var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i]
    x1 = Math.min(x1, Number(n.x) || 0)
    y1 = Math.min(y1, Number(n.y) || 0)
    x2 = Math.max(x2, (Number(n.x) || 0) + (Number(n.w) || 0))
    y2 = Math.max(y2, (Number(n.y) || 0) + (Number(n.h) || 0))
  }
  var pad = 20   // room for the per-node caption line under each card
  return { x: Math.max(0, x1 - 4), y: Math.max(0, y1 - 4), w: (x2 - x1) + 8, h: (y2 - y1) + pad }
}


function architecture(data) {
  var a = data && data.architecture
  if (!a || !a.nodes || !a.nodes.length) return DEFAULT_ARCH
  return a
}

function nodeSubtitle(node) {
  return String((node && (node.labelEn || "")) || "")
}

function nodeById(arch, id) {
  var nodes = (arch && arch.nodes) || []
  for (var i = 0; i < nodes.length; i++)
    if (String(nodes[i].id) === String(id)) return nodes[i]
  return null
}

// Node state for a request: { status, detail, ms } or null when untouched.
function nodeState(request, id) {
  var rows = (request && request.nodes) || []
  for (var i = 0; i < rows.length; i++)
    if (String(rows[i].id) === String(id)) return rows[i]
  return null
}

function nodeStatus(request, id) {
  var row = nodeState(request, id)
  return row ? String(row.status || "") : ""
}

function nodeDetail(request, id) {
  var row = nodeState(request, id)
  return row ? String(row.detail || "") : ""
}

function nodeMs(request, id) {
  var row = nodeState(request, id)
  return row ? Number(row.ms || 0) : 0
}

function edgeTraversed(request, from, to) {
  var edges = (request && request.edges) || []
  for (var i = 0; i < edges.length; i++)
    if (String(edges[i].from) === String(from) && String(edges[i].to) === String(to)) return true
  return false
}

function durationMs(request) {
  if (!request) return 0
  if (request.durationMs) return Number(request.durationMs)
  if (request.steps) return totalMs(request)
  var rows = request.nodes || []
  var sum = 0
  for (var i = 0; i < rows.length; i++) sum += Number(rows[i].ms || 0)
  return sum
}

function issues(request) {
  return (request && request.issues) || []
}

function problemCount(request) {
  var rows = issues(request)
  var n = 0
  for (var i = 0; i < rows.length; i++)
    if (String(rows[i].level || "") !== "info") n++
  return n
}

function stateColorKey(state) {
  var s = String(state || "").toLowerCase()
  if (s === "running") return "accent"
  if (s === "done") return "normal"
  if (s === "error") return "urgent"
  return "dim"
}

function runningCount(requests) {
  var n = 0
  for (var i = 0; i < requests.length; i++)
    if (String(requests[i].state || "") === "running") n++
  return n
}

function stepMark(status) {
  var s = String(status || "").toLowerCase()
  if (s === "ok" || s === "done" || s === "success") return "✓"
  if (s === "error" || s === "failed") return "✕"
  if (s === "running") return "•"
  if (s === "skipped") return "·"
  return "!"
}

function minLevel(status) {
  var s = String(status || "").toLowerCase()
  if (s === "error" || s === "failed") return 2
  if (s === "warn" || s === "skipped") return 1
  return 0
}

function worstStepLevel(request) {
  var steps = (request && request.steps) || []
  var level = 0
  for (var i = 0; i < steps.length; i++)
    level = Math.max(level, minLevel(steps[i].status))
  if (String(request && request.state) === "error") level = Math.max(level, 2)
  return level
}

function fmtMs(ms) {
  var v = Number(ms || 0)
  if (!isFinite(v) || v <= 0) return ""
  if (v < 1000) return Math.round(v) + "ms"
  if (v < 60000) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + "s"
  return (v / 60000).toFixed(1) + "m"
}

function fmtTokens(n) {
  var v = Number(n || 0)
  if (!isFinite(v) || v <= 0) return "0"
  if (v < 1000) return String(Math.round(v))
  if (v < 1000000) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + "k"
  return (v / 1000000).toFixed(2) + "M"
}

function fmtCost(usd) {
  var v = Number(usd || 0)
  if (!isFinite(v) || v <= 0) return ""
  if (v < 0.01) return "$" + v.toFixed(4)
  return "$" + v.toFixed(3)
}

function totalMs(request) {
  var steps = (request && request.steps) || []
  var sum = 0
  for (var i = 0; i < steps.length; i++) sum += Number(steps[i].ms || 0)
  return sum
}

function shortClock(iso) {
  var d = new Date(String(iso || ""))
  if (isNaN(d.getTime())) return ""
  return Qt.formatTime(d, "HH:mm")
}
