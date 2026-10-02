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
    { id: "input",      label: "Input",            x: 6,   y: 96,  w: 122, h: 42 },
    { id: "router",     label: "Classify + Route", x: 146, y: 96,  w: 128, h: 42 },
    { id: "context",    label: "Context",          x: 292, y: 12,  w: 122, h: 42 },
    { id: "memory",     label: "Memory",           x: 292, y: 96,  w: 122, h: 42 },
    { id: "model",      label: "Model",            x: 292, y: 180, w: 122, h: 42 },
    { id: "tools",      label: "Tools",            x: 432, y: 138, w: 118, h: 42 },
    { id: "verify",     label: "Verify",           x: 432, y: 54,  w: 118, h: 42 },
    { id: "human_gate", label: "Human Gate",       x: 584, y: 180, w: 122, h: 42 },
    { id: "output",     label: "Output",           x: 584, y: 54,  w: 122, h: 42 }
  ],
  edges: [
    { from: "input", to: "router" },
    { from: "router", to: "context", label: "context" },
    { from: "router", to: "memory", label: "retrieve" },
    { from: "context", to: "model" },
    { from: "memory", to: "model" },
    { from: "model", to: "tools", label: "needs tools" },
    { from: "model", to: "verify", label: "answer" },
    { from: "tools", to: "verify" },
    { from: "verify", to: "output" },
    { from: "verify", to: "human_gate", label: "needs human" }
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


// Per-request architecture wins over the global one, so a run can draw its own
// graph (an orchestrator run draws its plan: steps as nodes, depends_on as edges).
function architectureFor(data, request) {
  var a = request && request.architecture
  if (a && a.nodes && a.nodes.length) return a
  return architecture(data)
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

// ================================================================ health ==
// Stability / robustness / security, computed mechanically from what a runtime
// actually recorded. Nothing is invented: a dimension with no evidence reads
// "unknown" (n/a), never a perfect score, and every score below 100 carries the
// drivers that pulled it down so the number stays explainable.
//
// All weights are ASSUMPTIONS, kept in one place so they can be tuned. They are
// penalties subtracted from 100 over a rolling window of settled requests.
// Signals (dimension/kind/level/detail/weight) are the runtime's own
// observations; `weight` overrides the default for a kind.
var HEALTH = {
  window: 20,
  alertFloor: 70,
  watchFloor: 85,
  request: { errorState: 25, warnIssue: 5, errorIssue: 10, errorNode: 10, cap: 50 },
  robustness: { errorNoFallback: 18, providerOutageUnrecovered: 12, cap: 50 },
  signals: {
    stability:  { retry: 5, timeout: 12, rate_limit: 8, provider_outage: 15, model_error: 12, custom: 5 },
    robustness: { unhandled: 8, provider_outage: 12, tool_failure: 8, degraded: 2,
                  recovered: 0, fallback_used: 0, custom: 5 },
    security:   { secret_exposure: 45, external_send_unauthorized: 40, human_gate_bypass: 35,
                  sandbox_violation: 35, policy_violation: 30, prompt_injection: 25,
                  stealth_unauthorized: 25, risky_command: 10, custom: 10,
                  no_risk_detected: 0, human_gate_ok: 0, gate_enforced: 0 }
  },
  label: {
    errorState: "errored runs", warnIssue: "warnings", errorIssue: "errors", errorNode: "failed stages",
    retry: "retries", timeout: "timeouts", rate_limit: "rate limits", provider_outage: "provider outages",
    model_error: "model errors",
    errorNoFallback: "errors without fallback", unhandled: "unhandled issues", tool_failure: "tool failures",
    degraded: "degraded runs",
    secret_exposure: "secret exposure", external_send_unauthorized: "unauthorized external sends",
    human_gate_bypass: "human-gate bypasses", sandbox_violation: "sandbox violations",
    policy_violation: "policy violations", prompt_injection: "prompt injection",
    stealth_unauthorized: "unauthorized stealth", risky_command: "risky commands"
  }
}

function signalPenalty(dimension, sig) {
  var table = HEALTH.signals[dimension] || {}
  if (sig && sig.weight !== undefined && sig.weight !== null && isFinite(Number(sig.weight)))
    return Number(sig.weight)
  var k = String((sig && sig.kind) || "custom")
  if (table[k] !== undefined) return Number(table[k])
  return Number(table.custom || 5)
}

function labelFor(key) { return HEALTH.label[key] || String(key || "").replace(/_/g, " ") }

function bump(bag, key, penalty) {
  if (!penalty) return
  var row = bag[key] || (bag[key] = { key: key, label: labelFor(key), count: 0, penalty: 0 })
  row.count += 1
  row.penalty += penalty
}

function topDrivers(bag) {
  var out = []
  for (var k in bag) if (Object.prototype.hasOwnProperty.call(bag, k)) out.push(bag[k])
  out.sort(function(a, b) { return b.penalty - a.penalty })
  return out.slice(0, 3)
}

function applySignals(signals, dimension, bag) {
  var total = 0
  for (var i = 0; i < signals.length; i++) {
    var sig = signals[i] || {}
    if (String(sig.dimension || "") !== dimension) continue
    var pen = signalPenalty(dimension, sig)
    total += pen
    if (pen > 0) bump(bag, String(sig.kind || "custom"), pen)
  }
  return total
}

function clampScore(v) { return Math.max(0, Math.min(100, Math.round(v))) }

function healthLevel(score) {
  if (score === null || score === undefined) return "unknown"
  if (score >= HEALTH.watchFloor) return "good"
  if (score >= HEALTH.alertFloor) return "watch"
  return "alert"
}

function dimension(key, score, coverage, bag) {
  return { key: key, score: score, coverage: coverage, level: healthLevel(score), drivers: topDrivers(bag) }
}

// A dimension is only scored when there is evidence for it; otherwise score is
// null and the UI shows n/a instead of a misleading 100.
function computeHealth(requests, window) {
  var w = window || HEALTH.window
  var rows = (requests || []).slice(0, w)
  var settled = 0, secCoverage = 0, secCritical = false
  var stabPenalty = 0, robPenalty = 0, secPenalty = 0
  var stabBag = {}, robBag = {}, secBag = {}

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {}
    var state = String(r.state || "")
    var signals = r.signals || []
    var isSettled = state === "done" || state === "error" || Number(r.durationMs || 0) > 0
    if (isSettled) settled++

    var hasRecovery = false, hasFallback = false, outage = false
    for (var s = 0; s < signals.length; s++) {
      var kind = String((signals[s] || {}).kind || "")
      if (kind === "recovered") hasRecovery = true
      if (kind === "fallback_used") hasFallback = true
      if (kind === "provider_outage") outage = true
    }

    if (isSettled) {
      // ---- stability: did the run do its job?
      var p = 0
      if (state === "error") { p += HEALTH.request.errorState; bump(stabBag, "errorState", HEALTH.request.errorState) }
      var iss = r.issues || []
      for (var j = 0; j < iss.length; j++) {
        var lvl = String((iss[j] || {}).level || "")
        if (lvl === "error") { p += HEALTH.request.errorIssue; bump(stabBag, "errorIssue", HEALTH.request.errorIssue) }
        else if (lvl === "warn") { p += HEALTH.request.warnIssue; bump(stabBag, "warnIssue", HEALTH.request.warnIssue) }
      }
      var nodes = r.nodes || [], nodeErr = 0
      for (var n = 0; n < nodes.length; n++) {
        var st = String((nodes[n] || {}).status || "")
        if (st === "error" || st === "failed") nodeErr++
      }
      // only count failed stages directly when no issue already named them
      if (nodeErr && iss.length === 0) { var np = nodeErr * HEALTH.request.errorNode; p += np; bump(stabBag, "errorNode", np) }
      p += applySignals(signals, "stability", stabBag)
      stabPenalty += Math.min(p, HEALTH.request.cap)

      // ---- robustness: did it degrade and recover gracefully?
      var q = 0
      if (state === "error" && !hasRecovery && !hasFallback) {
        q += HEALTH.robustness.errorNoFallback; bump(robBag, "errorNoFallback", HEALTH.robustness.errorNoFallback)
      }
      if (outage && !hasRecovery && !hasFallback) {
        q += HEALTH.robustness.providerOutageUnrecovered; bump(robBag, "providerOutageUnrecovered", HEALTH.robustness.providerOutageUnrecovered)
      }
      q += applySignals(signals, "robustness", robBag)
      robPenalty += Math.min(q, HEALTH.robustness.cap)
    }

    // ---- security: only what the runtime explicitly reported
    var secSignals = 0
    for (var t = 0; t < signals.length; t++) {
      var sg = signals[t] || {}
      if (String(sg.dimension || "") !== "security") continue
      secSignals++
      var pen = signalPenalty("security", sg)
      if (pen > 0) bump(secBag, String(sg.kind || "custom"), pen)
      if (String(sg.level || "") === "error" && pen > 0) secCritical = true
      secPenalty += pen
    }
    if (secSignals > 0) secCoverage++
  }

  var stability = dimension("stability", settled ? clampScore(100 - stabPenalty) : null, settled, stabBag)
  var robustness = dimension("robustness", settled ? clampScore(100 - robPenalty) : null, settled, robBag)
  var security = dimension("security", secCoverage ? clampScore(100 - secPenalty) : null, secCoverage, secBag)

  // security first — it is the dimension that must never slip
  var dims = [security, stability, robustness]
  var alertReason = ""
  for (var d = 0; d < dims.length; d++) {
    if (dims[d].level === "alert") {
      var drv = dims[d].drivers.length ? " — " + dims[d].drivers[0].label + " ×" + dims[d].drivers[0].count : ""
      alertReason = dims[d].key + " " + dims[d].score + drv
      break
    }
  }
  if (secCritical && !alertReason) alertReason = "security: " + (security.drivers[0] ? security.drivers[0].label : "critical signal")

  return {
    window: w, considered: rows.length, settled: settled,
    stability: stability, robustness: robustness, security: security,
    alert: !!alertReason, alertReason: alertReason
  }
}

function healthRows(health) {
  return [
    { key: "stability",  label: "STABILITY",  score: health.stability.score,  level: health.stability.level,  coverage: health.stability.coverage },
    { key: "robustness", label: "ROBUSTNESS", score: health.robustness.score, level: health.robustness.level, coverage: health.robustness.coverage },
    { key: "security",   label: "SECURITY",   score: health.security.score,   level: health.security.level,   coverage: health.security.coverage }
  ]
}

function healthColorKey(level) {
  if (level === "good") return "normal"
  if (level === "watch") return "accent"
  if (level === "alert") return "urgent"
  return "dim"
}

function fmtScore(score) {
  if (score === null || score === undefined) return "n/a"
  return String(Math.round(score))
}

// ------------------------------------------------------- runtime metrics --
// Everything a run recorded, summarised as label/value facts so the panel can
// show the whole runtime picture, not just the headline numbers.
function cacheHitPct(request) {
  var t = (request && request.tokens) || {}
  var denom = Number(t.input || 0) + Number(t.cacheRead || 0)
  if (denom <= 0) return null
  return Math.round(100 * Number(t.cacheRead || 0) / denom)
}

function tokensPerSec(request) {
  var d = Number((request && request.durationMs) || 0)
  if (d <= 0) return null
  var t = (request && request.tokens) || {}
  var out = Number(t.output || 0) + Number(t.input || 0)
  if (out <= 0) return null
  return Math.round(out / (d / 1000))
}

function runtimeFacts(request) {
  if (!request) return []
  var t = request.tokens || {}, m = request.metrics || {}, e = request.env || {}
  var out = []
  function add(label, value) {
    if (value === undefined || value === null) return
    var v = String(value)
    if (v === "" || v === "0") return
    out.push({ label: label, value: v })
  }
  add("duration", fmtMs(durationMs(request)))
  add("model", request.model)
  add("provider", e.provider)
  add("agent", request.agent)
  add("route", request.route)
  add("class", request.taskClass)
  add("tok in", fmtTokens(t.input))
  add("tok out", fmtTokens(t.output))
  add("cache", fmtTokens(t.cacheRead))
  add("cost", fmtCost(t.costUsd))
  var hit = cacheHitPct(request)
  if (hit !== null) add("cache hit", hit + "%")
  var tps = tokensPerSec(request)
  if (tps !== null) add("tok/s", tps)
  add("tools", m.toolCalls)
  add("api", m.apiCalls)
  add("retries", m.retries)
  add("fallbacks", m.fallbacks)
  add("errors", m.errors)
  var probs = problemCount(request)
  if (probs) add("issues", probs)
  return out
}

function shortClock(iso) {
  var d = new Date(String(iso || ""))
  if (isNaN(d.getTime())) return ""
  if (typeof Qt !== "undefined" && Qt.formatTime) return Qt.formatTime(d, "HH:mm")
  return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2)
}

// Node (tests) can import this file after stripping the QML-only pragma.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parse: parse, computeHealth: computeHealth, healthRows: healthRows,
    healthColorKey: healthColorKey, fmtScore: fmtScore, runtimeFacts: runtimeFacts,
    cacheHitPct: cacheHitPct, tokensPerSec: tokensPerSec, HEALTH: HEALTH
  }
}
