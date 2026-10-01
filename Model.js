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
