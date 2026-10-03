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
    return { updatedAt: "", requests: [], jevEvents: [], invalid: true }
  }
  if (!data || !data.requests || !Array.isArray(data.requests))
    return { updatedAt: "", requests: [], jevEvents: [], invalid: true }
  var rows = data.requests.slice()
  rows.sort(function(a, b) { return String(b.at || "") > String(a.at || "") ? 1 : -1 })
  return { updatedAt: String(data.updatedAt || ""), requests: rows,
           jevEvents: Array.isArray(data.jevEvents) ? data.jevEvents.slice() : [], invalid: false,
           instrument: (data.instrument && typeof data.instrument === "object") ? data.instrument : null }
}

// Which instrument produced these numbers, and is it still the one on disk?
//
// A live agent process keeps the extension code it loaded until it is reloaded or
// restarted, so "the file is fixed" and "the running agent uses the fix" are two
// different claims. Measured 2026-10-03: a process holding the old extension kept
// reporting absorbed failures as penalties for 40 minutes after the fix landed,
// and the panel showed that as a property of the agent. The runtime now reports
// what it LOADED; the writer records what is on disk; this compares them.
function isoTimestamp(value) {
  var d = new Date(String(value || ""))
  if (isNaN(d.getTime())) return String(value || "?")
  function p(n) { return (n < 10 ? "0" : "") + n }
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes())
}

function instrumentStatus(snapshot) {
  var ins = (snapshot && snapshot.instrument && typeof snapshot.instrument === "object") ? snapshot.instrument : null
  var disk = (ins && ins.disk && typeof ins.disk === "object") ? ins.disk : null
  var loaded = ins ? String(ins.extVersion || "") : ""
  var onDisk = disk ? String(disk.version || "") : ""
  if (!loaded) {
    return { state: "unregistered", loaded: ins, disk: disk,
             label: onDisk
               ? "instrument not registered: disk has " + onDisk + ", but the running process never reported a version - it is probably still an older extension; reload the agent"
               : "instrument not registered, and no extension version could be read from disk" }
  }
  if (!onDisk) {
    return { state: "unknown", loaded: ins, disk: disk,
             label: "instrument " + loaded + " (loaded " + isoTimestamp(ins.loadedAt) + ") - disk version unreadable" }
  }
  if (loaded === onDisk) {
    return { state: "current", loaded: ins, disk: disk,
             label: "instrument " + loaded + " - disk agrees (loaded " + isoTimestamp(ins.loadedAt) + ")" }
  }
  return { state: "stale", loaded: ins, disk: disk,
           label: "instrument is stale: the process loaded " + loaded + " but disk has " + onDisk
             + " - these scores come from older code; reload the agent before trusting them" }
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

// JEV attempts are global provider facts, separate from pipeline health scores.
// The writer keeps only the newest 200 and never records prompts, keys, or prices.
function jevStats(events) {
  var rows = Array.isArray(events) ? events.slice(-200) : []
  var out = { calls: rows.length, success: 0, failed: 0, usageReported: 0,
              inputTokens: 0, outputTokens: 0, tokenRouter: 0, modelRouter: 0, avgMs: null }
  var totalMs = 0, timed = 0
  for (var i = 0; i < rows.length; i++) {
    var e = rows[i] || {}
    if (String(e.status) === "success") out.success++
    else if (String(e.status) === "error") out.failed++
    var source = String(e.source || "")
    if (source === "token-router") out.tokenRouter++
    else if (source === "model-router") out.modelRouter++
    if (e.inputTokens !== undefined || e.outputTokens !== undefined) out.usageReported++
    out.inputTokens += Math.max(0, num(e.inputTokens))
    out.outputTokens += Math.max(0, num(e.outputTokens))
    var ms = num(e.latencyMs)
    if (ms > 0) { totalMs += ms; timed++ }
  }
  if (timed) out.avgMs = Math.round(totalMs / timed)
  return out
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
                  recovered: 0, fallback_used: 0, tool_recovered: 0, custom: 5 },
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

// Robustness asks "did it degrade *and recover* gracefully?", so a failure that was
// absorbed must not cost anything. Two shapes of evidence can say so, and facts win:
//
//   * `toolLog` — FACTS the runtime wrote as it happened: one entry per finished tool
//     call, in completion order ({tool, ok, ms}). Absorption is DERIVED from them: a
//     failure is absorbed when a later call of the SAME tool succeeded in the same
//     request. Nothing else is inferred.
//   * `signals` — the runtime's own observations, including the claim `tool_recovered`.
//
// Why facts replaced the claim (measured 2026-10-03): the old rule made the runtime
// keep a per-tool counter in ITS OWN MEMORY and emit `tool_recovered` when a retry
// succeeded. A counter does not survive a reload, and a reloaded runtime cannot
// cancel failures recorded before it — so R read 84% for a run whose two failures the
// session log shows were absorbed 11s and 2s later, and the corrupt number could only
// be "fixed" by hand-writing recoveries into the store. Three manual backfills is a
// measurement that does not work. Facts survive the reload that a counter does not,
// and they cannot be improved by hand without becoming a different claim.
//
// Backwards compatible on purpose: a request without facts still scores by the old
// claim rule, so the whole recorded history stays readable and comparable.
function toolFacts(request) {
  var log = request && request.toolLog
  if (!Array.isArray(log) || !log.length) return null
  return log
}

// One success cancels one outstanding failure per tool name (first-come-first-cancelled),
// exactly the rule the runtime used to implement in memory.
function uncancelledToolFailures(log) {
  var pending = {}
  var total = 0
  for (var i = 0; i < log.length; i++) {
    var e = log[i] || {}
    if (!("ok" in e)) continue
    var tool = String(e.tool || "tool")
    if (e.ok) {
      if (pending[tool]) pending[tool] -= 1
      continue
    }
    pending[tool] = (pending[tool] || 0) + 1
  }
  for (var k in pending) {
    if (Object.prototype.hasOwnProperty.call(pending, k) && pending[k] > 0) total += pending[k]
  }
  return total
}

function applyRobustnessSignals(signals, bag, facts) {
  var derived = facts ? uncancelledToolFailures(facts) : null
  var pending = []
  for (var i = 0; i < signals.length; i++) {
    var sig = signals[i] || {}
    if (String(sig.dimension || "") !== "robustness") continue
    var kind = String(sig.kind || "custom")
    // With facts on record the score is derived from them, so the tool claims are
    // ignored here — counting both would double the penalty. The stored signal stays
    // visible as evidence, and a plain `recovered` (whole run survived a fallback)
    // never cancelled a tool failure anyway.
    if (derived !== null && (kind === "tool_failure" || kind === "tool_recovered")) continue
    if (kind === "tool_recovered") {
      for (var j = pending.length - 1; j >= 0; j--) {
        if (pending[j].kind === "tool_failure" && !pending[j].cancelled) {
          pending[j].cancelled = true
          break
        }
      }
      continue
    }
    var pen = signalPenalty("robustness", sig)
    if (pen > 0) pending.push({ kind: kind, pen: pen, cancelled: false })
  }
  var total = 0
  for (var k = 0; k < pending.length; k++) {
    if (pending[k].cancelled) continue
    total += pending[k].pen
    bump(bag, pending[k].kind, pending[k].pen)
  }
  if (derived) {
    var each = Number(HEALTH.signals.robustness.tool_failure || 0)
    for (var d = 0; d < derived; d++) bump(bag, "tool_failure", each)
    total += derived * each
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
      q += applyRobustnessSignals(signals, robBag, toolFacts(r))
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

function healthRows(health, series) {
  var keys = ["stability", "robustness", "security"]
  var labels = { stability: "STABILITY", robustness: "ROBUSTNESS", security: "SECURITY" }
  var out = []
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i], dim = health[k]
    out.push({
      key: k, label: labels[k], score: dim.score, level: dim.level, coverage: dim.coverage,
      bars: (series && series[k]) ? sparkBars(series[k]) : []
    })
  }
  return out
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

// ======================================================= window analytics ==
// One run is a story; the window is the health of the whole system. Everything
// here is derived from recorded fields — when a field is absent the result is
// null/empty and the UI says n/a or hides the line, never a fabricated zero.

function num(v) { var n = Number(v); return isFinite(n) ? n : 0 }

function isSettled(request) {
  var s = String((request && request.state) || "")
  if (s === "done" || s === "error") return true
  return num(request && request.durationMs) > 0
}

var WAITING_STATES = ["waiting", "waiting_human", "waiting-human", "waiting_on_human", "paused", "blocked"]
function isWaiting(request) {
  return WAITING_STATES.indexOf(String((request && request.state) || "").toLowerCase()) >= 0
}

function parseTime(iso) { var t = Date.parse(String(iso || "")); return isNaN(t) ? null : t }

function ageLabel(ms) {
  if (ms === null || ms === undefined || !isFinite(ms) || ms < 0) return ""
  var s = ms / 1000
  if (s < 60) return Math.round(s) + "s ago"
  if (s < 3600) return Math.round(s / 60) + "m ago"
  if (s < 86400) return (s / 3600).toFixed(1) + "h ago"
  return Math.round(s / 86400) + "d ago"
}

function medianOf(arr) {
  if (!arr.length) return null
  var a = arr.slice().sort(function(x, y) { return x - y })
  var m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

function addCount(bag, key, label) {
  var row = bag[key] || (bag[key] = { key: key, label: label, count: 0 })
  row.count += 1
}

function sortedByCount(bag) {
  var out = []
  for (var k in bag) if (Object.prototype.hasOwnProperty.call(bag, k)) out.push(bag[k])
  out.sort(function(a, b) { return b.count - a.count })
  return out
}

function sortedByMs(bag) {
  var out = []
  for (var k in bag) if (Object.prototype.hasOwnProperty.call(bag, k)) out.push(bag[k])
  out.sort(function(a, b) { return b.ms - a.ms })
  return out
}

// Everything the window can tell us, in one plain object the UI can render.
function windowStats(requests, window) {
  var w = window || HEALTH.window
  var rows = (requests || []).slice(0, w)
  var now = Date.now()
  var today = new Date(now); today.setHours(0, 0, 0, 0)

  var settled = 0, done = 0, error = 0, running = 0, waiting = 0
  var cost = 0, tin = 0, tout = 0, tcr = 0
  var durs = []
  var problemBag = {}, modelBag = {}, stageBag = {}
  var secReported = 0, providerErrors = 0, lastProviderErrorAt = ""
  var oldestWaitMs = null, lastAt = "", firstAt = "", todayCount = 0

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {}
    var state = String(r.state || "").toLowerCase()
    var t = r.tokens || {}, m = r.metrics || {}, e = r.env || {}
    var at = parseTime(r.at)

    if (at !== null) {
      if (!lastAt || at > parseTime(lastAt)) lastAt = String(r.at || "")
      if (!firstAt || at < parseTime(firstAt)) firstAt = String(r.at || "")
      if (at >= today.getTime()) todayCount++
    }
    if (state === "running") running++
    if (isWaiting(r)) {
      waiting++
      if (at !== null) { var waitMs = now - at; if (oldestWaitMs === null || waitMs > oldestWaitMs) oldestWaitMs = waitMs }
    }

    if (isSettled(r)) {
      settled++
      if (state === "done") done++
      else if (state === "error") error++
      cost += num(t.costUsd)
      tin += num(t.input); tout += num(t.output); tcr += num(t.cacheRead)
      var d = num(r.durationMs); if (d > 0) durs.push(d)

      var mdl = String(r.model || e.model || "")
      if (mdl) {
        var mb = modelBag[mdl] || (modelBag[mdl] = { key: mdl, count: 0, cost: 0 })
        mb.count++; mb.cost += num(t.costUsd)
      }

      var nodes = r.nodes || []
      for (var n = 0; n < nodes.length; n++) {
        var nms = num((nodes[n] || {}).ms)
        if (nms > 0) {
          var nid = String(nodes[n].id || "?")
          var sb = stageBag[nid] || (stageBag[nid] = { id: nid, ms: 0, share: 0 })
          sb.ms += nms
        }
        var nst = String((nodes[n] || {}).status || "")
        if (nst === "error" || nst === "failed") addCount(problemBag, "stage-failed", "failed stages")
      }

      var iss = r.issues || []
      for (var j = 0; j < iss.length; j++) {
        var lvl = String((iss[j] || {}).level || "")
        if (lvl === "warn" || lvl === "error") addCount(problemBag, "issue-" + lvl, lvl + " issues")
      }
    }

    // signals are the runtime's own observations; count them and the security
    // coverage (how many settled runs reported anything about security)
    var sigs = r.signals || []
    var hasSec = false
    var rowProvErr = num(m.errors)
    for (var g = 0; g < sigs.length; g++) {
      var sg = sigs[g] || {}
      var dim = String(sg.dimension || "")
      var slvl = String(sg.level || "")
      if (dim === "security") hasSec = true
      if (slvl === "warn" || slvl === "error") addCount(problemBag, "sig-" + String(sg.kind || "custom"), labelFor(String(sg.kind || "custom")))
      if (dim === "stability" && (sg.kind === "provider_outage" || sg.kind === "rate_limit" || sg.kind === "model_error")) {
        if (rowProvErr === 0) rowProvErr++
      }
    }
    if (hasSec && isSettled(r)) secReported++
    if (rowProvErr > 0) {
      providerErrors += rowProvErr
      if (at !== null && (lastProviderErrorAt === "" || at > parseTime(lastProviderErrorAt))) lastProviderErrorAt = String(r.at || "")
    }
  }

  // outcome strip, oldest on the left, so the shape of the window is visible
  var strip = []
  for (var s2 = rows.length - 1; s2 >= 0; s2--) {
    var rr = rows[s2] || {}
    var sst = String(rr.state || "").toLowerCase()
    var out = "ok"
    if (sst === "error") out = "error"
    else if (isWaiting(rr)) out = "wait"
    else if (sst === "running") out = "run"
    else {
      var warn = false
      var ii = rr.issues || []
      for (var x = 0; x < ii.length; x++) if (String((ii[x] || {}).level || "") !== "info") warn = true
      var ss = rr.signals || []
      for (var y = 0; y < ss.length; y++) { var L = String((ss[y] || {}).level || ""); if (L === "warn" || L === "error") warn = true }
      var nn = rr.nodes || []
      for (var z = 0; z < nn.length; z++) { var NS = String((nn[z] || {}).status || ""); if (NS === "error" || NS === "failed" || NS === "warn") warn = true }
      if (warn) out = "warn"
    }
    strip.push({ level: out })
  }

  var stages = sortedByMs(stageBag)
  var stageTotal = 0
  for (var p = 0; p < stages.length; p++) stageTotal += stages[p].ms
  for (var q = 0; q < stages.length; q++) stages[q].share = stageTotal > 0 ? Math.round(100 * stages[q].ms / stageTotal) : 0

  var spanMs = (lastAt && firstAt) ? (parseTime(lastAt) - parseTime(firstAt)) : 0
  var runsPerHour = spanMs > 60000 ? Math.round(10 * rows.length / (spanMs / 3600000)) / 10 : null
  var lastAgeMs = lastAt ? now - parseTime(lastAt) : null

  return {
    window: w, considered: rows.length, settled: settled,
    done: done, error: error, running: running, waiting: waiting,
    successRate: settled ? Math.round(100 * done / settled) : null,
    totalCost: cost, avgCost: settled ? cost / settled : null,
    tokens: { input: tin, output: tout, cacheRead: tcr },
    cacheHitPct: (tcr + tin) > 0 ? Math.round(100 * tcr / (tcr + tin)) : null,
    medianMs: medianOf(durs), slowestMs: durs.length ? Math.max.apply(null, durs) : null,
    fastestMs: durs.length ? Math.min.apply(null, durs) : null,
    runsPerHour: runsPerHour, spanMs: spanMs,
    lastAt: lastAt, lastAgeMs: lastAgeMs, todayCount: todayCount,
    problems: sortedByCount(problemBag),
    modelMix: sortedByCount(modelBag),
    stages: stages,
    securityReported: secReported,
    providerErrors: providerErrors, lastProviderErrorAt: lastProviderErrorAt,
    outcomeStrip: strip
  }
}

// The headline: volume, success, money, cache, latency, recency — as many
// label/value facts as the window can honestly support.
function headlineFacts(stats) {
  if (!stats || !stats.settled) return []
  var out = []
  out.push({ label: "runs", value: String(stats.settled) })
  if (stats.successRate !== null) out.push({ label: "ok", value: stats.successRate + "%" })
  var c = fmtCost(stats.totalCost); if (c !== "") out.push({ label: "cost", value: c })
  var pc = fmtCost(stats.avgCost); if (pc !== "") out.push({ label: "per run", value: pc })
  if (stats.cacheHitPct !== null) out.push({ label: "cache", value: stats.cacheHitPct + "%" })
  if (stats.medianMs) out.push({ label: "median", value: fmtMs(stats.medianMs) })
  if (stats.runsPerHour !== null) out.push({ label: "rate", value: stats.runsPerHour + "/h" })
  if (stats.todayCount) out.push({ label: "today", value: String(stats.todayCount) })
  var age = ageLabel(stats.lastAgeMs); if (age !== "") out.push({ label: "last", value: age })
  return out
}

// Deeper window facts, one line each. A line with nothing to say is not emitted.
function windowLines(stats) {
  if (!stats) return []
  var lines = []

  if (stats.stages && stats.stages.length) {
    var parts = []
    for (var i = 0; i < Math.min(3, stats.stages.length); i++) parts.push(stats.stages[i].id + " " + stats.stages[i].share + "%")
    lines.push("time: " + parts.join("  ·  "))
  }

  var g = []
  if (stats.waiting) g.push("waiting on human " + stats.waiting + (stats.oldestWaitMs !== null ? " (" + ageLabel(stats.oldestWaitMs).replace(" ago", "") + ")" : ""))
  if (stats.providerErrors) g.push("provider errors " + stats.providerErrors)
  g.push("security reported " + stats.securityReported + "/" + stats.settled)
  lines.push(g.join("  ·  "))

  if (stats.problems && stats.problems.length) {
    var pp = []
    for (var j = 0; j < Math.min(4, stats.problems.length); j++) pp.push(stats.problems[j].label + " ×" + stats.problems[j].count)
    lines.push("problems: " + pp.join(", "))
  }

  if (stats.modelMix && stats.modelMix.length) {
    var mm = []
    for (var k = 0; k < Math.min(3, stats.modelMix.length); k++) {
      var row = stats.modelMix[k]
      var c = fmtCost(row.cost)
      mm.push(row.key + " ×" + row.count + (c !== "" ? " " + c : ""))
    }
    lines.push("models: " + mm.join("  ·  "))
  }

  return lines
}

// Per-settled-run scores, oldest to newest, for a trend sparkline. Each run is
// scored on its own so the line shows direction, not just the current number.
function scoreSeries(requests, window) {
  var w = window || HEALTH.window
  var rows = (requests || []).slice(0, w).filter(isSettled)
  rows = rows.slice().reverse()
  var out = { stability: [], robustness: [], security: [] }
  for (var i = 0; i < rows.length; i++) {
    var h = computeHealth([rows[i]], 1)
    out.stability.push(h.stability.score)
    out.robustness.push(h.robustness.score)
    out.security.push(h.security.score)
  }
  return out
}

// Sparkline bars: a fraction to scale each bar, and the level to colour it.
function sparkBars(values) {
  var out = []
  for (var i = 0; i < (values || []).length; i++) {
    var v = values[i]
    if (v === null || v === undefined) { out.push({ level: "unknown", frac: 0 }); continue }
    out.push({ level: healthLevel(v), frac: Math.max(0.06, Math.min(1, v / 100)) })
  }
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
    cacheHitPct: cacheHitPct, tokensPerSec: tokensPerSec, HEALTH: HEALTH,
    windowStats: windowStats, headlineFacts: headlineFacts, windowLines: windowLines,
    scoreSeries: scoreSeries, sparkBars: sparkBars, ageLabel: ageLabel,
    isSettled: isSettled, isWaiting: isWaiting, fmtMs: fmtMs, fmtCost: fmtCost, fmtTokens: fmtTokens
  }
}
