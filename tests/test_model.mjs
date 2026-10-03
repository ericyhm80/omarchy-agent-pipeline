// Node regression test for Model.js — the health scoring engine.
//
// Model.js is a QML `.pragma library`, which node cannot parse, and it exports
// nothing for node. So this test strips the pragma and appends the exports, runs
// the pure functions, and checks the documented scores. Run: `node tests/test_model.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modelPath = path.join(here, "..", "Model.js");
let src = fs.readFileSync(modelPath, "utf8").replace(/^\.pragma library[^\n]*\n/, "");
src += "\nexport { parse, computeHealth, healthRows, healthColorKey, fmtScore, fmtCost, runtimeFacts, cacheHitPct, tokensPerSec, HEALTH, windowStats, headlineFacts, windowLines, scoreSeries, sparkBars, ageLabel, isSettled, isWaiting, instrumentStatus, jevStats, architectureFor, edgeTraversed };\n";
const tmp = path.join(os.tmpdir(), `agent-pipeline-model-${process.pid}.mjs`);
fs.writeFileSync(tmp, src);
const Model = await import(`file://${tmp}?t=${Date.now()}`);
fs.unlinkSync(tmp);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  \u2713", name); }
  else { fail++; console.log("  \u2717", name, extra === undefined ? "" : extra); }
}
const req = (o) => Object.assign({ id: "r", at: "2026-10-02T00:00:00Z", state: "done", durationMs: 1000 }, o);

const jevPayload = Model.parse(JSON.stringify({ requests: [], jevEvents: [
  { source: "token-router", status: "success", inputTokens: 566, outputTokens: 111,
    costUsd: 0.000023772, priceModel: "jev-1.13.0", latencyMs: 200 },
  { source: "model-router", status: "error", latencyMs: 600 },
] }));
const jevSummary = Model.jevStats(jevPayload.jevEvents);
ok("JEV events survive request-store parsing", jevPayload.jevEvents.length === 2);
ok("JEV global stats distinguish successful and failed API calls", jevSummary.calls === 2 &&
   jevSummary.success === 1 && jevSummary.failed === 1, JSON.stringify(jevSummary));
ok("JEV global stats break down both participating code paths", jevSummary.tokenRouter === 1 &&
   jevSummary.modelRouter === 1, JSON.stringify(jevSummary));
ok("JEV usage, priced cost and mean latency aggregate with partial-cost coverage", jevSummary.usageReported === 1 &&
   jevSummary.inputTokens === 566 && jevSummary.outputTokens === 111 && jevSummary.avgMs === 400 &&
   jevSummary.costReported === 1 && Math.abs(jevSummary.costUsd - 0.000023772) < 1e-12,
   JSON.stringify(jevSummary));
ok("sub-cent cost formatting does not round a real JEV charge to zero", Model.fmtCost(0.000023772) === "$0.000024");
ok("sub-micro-dollar cost formatting uses a truthful upper bound", Model.fmtCost(0.00000042) === "<$0.000001");

// a settled, clean run: stability/robustness 100, security has no evidence -> null
let h = Model.computeHealth([req({})]);
ok("clean run stability 100", h.stability.score === 100, h.stability.score);
ok("clean run robustness 100", h.robustness.score === 100, h.robustness.score);
ok("security unknown without telemetry", h.security.score === null && h.security.level === "unknown", h.security.score);
ok("no alert on a clean window", h.alert === false, h.alertReason);
h = Model.computeHealth([req({ nodes: [{ id: "jev", status: "warn", detail: "rules fallback" }] })]);
ok("JEV availability warning is visible but does not alter health scores",
   h.stability.score === 100 && h.robustness.score === 100, JSON.stringify(h));

// one errored run is "watch", not "alert"
h = Model.computeHealth([req({ state: "error" })]);
ok("error run stability 75", h.stability.score === 75, h.stability.score);
ok("error run robustness 82 without fallback", h.robustness.score === 82, h.robustness.score);
ok("single error is watch, not alert", h.alert === false && h.stability.level === "watch", h.alertReason);

// a run that errored but recovered is robust
h = Model.computeHealth([req({ state: "error", signals: [{ dimension: "robustness", kind: "fallback_used", level: "info" }] })]);
ok("fallback keeps robustness 100", h.robustness.score === 100, h.robustness.score);
ok("fallback does not hide instability", h.stability.score === 75, h.stability.score);

// --- absorbed vs unabsorbed tool failures (the 2026-10-02 miscalibration) -----
// The runtime emits `tool_recovered` when a tool that failed later succeeds in the
// same run. An absorbed failure is not a degradation; an unabsorbed one still is.
const robFail = { dimension: "robustness", kind: "tool_failure", level: "warn", detail: "tool error in bash" };
const robRec = { dimension: "robustness", kind: "tool_recovered", level: "info", detail: "tool bash succeeded" };

h = Model.computeHealth([req({ signals: [robFail, robRec] })]);
ok("cancelled tool failure costs nothing", h.robustness.score === 100, h.robustness.score);

// the real recorded request pi-mur4zokx-wodj: 4 tool errors, all absorbed, R showed 68
h = Model.computeHealth([req({ signals: [robFail, robFail, robFail, robFail, robRec, robRec, robRec, robRec] })]);
ok("4 absorbed tool failures => 100 (this is what pinned R at 68)", h.robustness.score === 100, h.robustness.score);

// the gate must still be able to fail: no recovery evidence => full cost
h = Model.computeHealth([req({ signals: [robFail, robFail, robFail, robFail] })]);
ok("4 uncancelled tool failures => 68", h.robustness.score === 68, h.robustness.score);

h = Model.computeHealth([req({ signals: [robFail, robFail, robRec] })]);
ok("1 of 2 failures recovered => 92", h.robustness.score === 92, h.robustness.score);
ok("drivers count only the uncancelled failure", h.robustness.drivers[0].key === "tool_failure" && h.robustness.drivers[0].count === 1, JSON.stringify(h.robustness.drivers));

h = Model.computeHealth([req({ signals: [robRec, robFail] })]);
ok("a recovery with nothing to cancel is a no-op, not a credit", h.robustness.score === 92, h.robustness.score);

h = Model.computeHealth([req({ signals: [robFail, { dimension: "robustness", kind: "recovered", level: "info" }] })]);
ok("run-level `recovered` does not cancel a tool failure", h.robustness.score === 92, h.robustness.score);

h = Model.computeHealth([req({ signals: [robRec] }), req({ signals: [robFail] })]);
ok("recovery does not leak into another request", h.robustness.score === 92, h.robustness.score);

// --- FACTS, not claims (0.7.3): absorption is derived from what happened ------
// `toolLog` records every finished tool call. A failure is absorbed when a later
// call of the SAME tool succeeded. The `tool_recovered` claim is no longer needed,
// and is ignored when facts are on record (counting both would double the penalty).
const fact = (tool, ok) => ({ tool: tool, ok: ok, ms: 12 });
const failBash = fact("bash", false);

h = Model.computeHealth([req({ toolLog: [failBash, fact("bash", true)] })]);
ok("facts: a failure absorbed by the same tool costs nothing", h.robustness.score === 100, h.robustness.score);
ok("facts: no driver when nothing is uncancelled", h.robustness.drivers.length === 0, JSON.stringify(h.robustness.drivers));
ok("facts: the request still counts as evidence", h.robustness.coverage === 1, h.robustness.coverage);

h = Model.computeHealth([req({ toolLog: [failBash, fact("edit", true)] })]);
ok("facts: another tool's success is not a recovery", h.robustness.score === 92, h.robustness.score);

h = Model.computeHealth([req({ toolLog: [fact("bash", true), failBash] })]);
ok("facts: a success BEFORE the failure absorbs nothing", h.robustness.score === 92, h.robustness.score);

h = Model.computeHealth([req({ toolLog: [failBash, failBash, fact("bash", true)] })]);
ok("facts: 2 failures, 1 retry => 1 still costs", h.robustness.score === 92, h.robustness.score);
ok("facts: driver counts the uncancelled failure", h.robustness.drivers[0].key === "tool_failure" && h.robustness.drivers[0].count === 1, JSON.stringify(h.robustness.drivers));

h = Model.computeHealth([req({ toolLog: [fact("bash", false), fact("edit", false), fact("bash", true)] })]);
ok("facts: cancellation is per tool name", h.robustness.score === 92, h.robustness.score);

// the real 2026-10-03 record pi-murb7gok-1afv: 2 bash failures, both absorbed 11s and
// 2s later, written by the pre-fix extension so no recovery claim exists. R read 84.
h = Model.computeHealth([req({ signals: [robFail, robFail],
                               toolLog: [failBash, fact("bash", true), failBash, fact("bash", true)] })]);
ok("facts beat stale claims: the 84% record derives to 100", h.robustness.score === 100, h.robustness.score);

h = Model.computeHealth([req({ signals: [robFail, robFail], toolLog: [failBash, failBash] })]);
ok("facts beat claims the other way too (no double count)", h.robustness.score === 84, h.robustness.score);

h = Model.computeHealth([req({ toolLog: [failBash, fact("bash", true)],
                               signals: [robFail, { dimension: "robustness", kind: "degraded", level: "info" }] })]);
ok("facts + other robustness kinds still count", h.robustness.score === 98, h.robustness.score);

h = Model.computeHealth([req({ toolLog: [], signals: [robFail] })]);
ok("an empty log is not evidence: the claim rule still applies", h.robustness.score === 92, h.robustness.score);

h = Model.computeHealth([req({ toolLog: [fact("bash", true), fact("edit", true)] })]);
ok("facts with no failure score 100", h.robustness.score === 100, h.robustness.score);

h = Model.computeHealth([req({ state: "running", durationMs: 0, toolLog: [failBash] })]);
ok("facts in a running request are not judged yet", h.robustness.score === null, h.robustness.score);

// three errors cross the alert floor
h = Model.computeHealth([req({ state: "error" }), req({ state: "error" }), req({ state: "error" })]);
ok("repeated errors alert", h.alert === true && h.stability.level === "alert", h.alertReason);

// a security signal is scored, named, and alerts
h = Model.computeHealth([req({ signals: [
  { dimension: "security", kind: "secret_exposure", level: "error", detail: "x" },
  { dimension: "security", kind: "no_risk_detected", level: "info" }
] })]);
ok("security scored 55", h.security.score === 55, h.security.score);
ok("security coverage 1", h.security.coverage === 1, h.security.coverage);
ok("security alert names the driver", /security/.test(h.alertReason) && h.security.drivers[0].key === "secret_exposure", h.alertReason);

// stability signals carry default weights, and a kind is its own driver
h = Model.computeHealth([req({ signals: [{ dimension: "stability", kind: "retry", level: "warn" }] })]);
ok("retry costs 5", h.stability.score === 95, h.stability.score);
ok("retry is the driver", h.stability.drivers[0].key === "retry");

// a signal may override its weight
h = Model.computeHealth([req({ signals: [{ dimension: "security", kind: "risky_command", level: "warn", weight: 50 }] })]);
ok("weight override wins", h.security.score === 50, h.security.score);

// running requests are not judged
h = Model.computeHealth([req({ state: "running", durationMs: 0 })]);
ok("running is not settled", h.settled === 0 && h.stability.score === null, JSON.stringify(h.stability));

// the window caps how many runs count
h = Model.computeHealth(Array.from({ length: 50 }, () => req({ state: "error" })), 10);
ok("window caps at 10", h.settled === 10, h.settled);

// every failed stage counts once when no issue named it
h = Model.computeHealth([req({ nodes: [{ id: "a", status: "error" }, { id: "b", status: "error" }] })]);
ok("two failed stages cost 20", h.stability.score === 80, h.stability.score);

// runtime facts: cache hit rate and throughput
const facts = Model.runtimeFacts(req({
  tokens: { input: 100, output: 900, cacheRead: 900 }, durationMs: 2000,
  model: "glm", metrics: { toolCalls: 3 }
}));
const map = Object.fromEntries(facts.map((f) => [f.label, f.value]));
ok("cache hit 90%", map["cache hit"] === "90%", map["cache hit"]);
ok("throughput 500 tok/s", map["tok/s"] === "500", map["tok/s"]);
ok("tool count shown", map["tools"] === "3", map.tools);
const jevFacts = Object.fromEntries(Model.runtimeFacts(req({ metrics: { jev: {
  enabled: true, attempted: true, status: "success", source: "jev", model: "jev-1.13.0",
  taskClass: "strategy", latencyMs: 214, inputTokens: 566, outputTokens: 111,
  costUsd: 0.000023772
} } })).map((f) => [f.label, f.value]));
ok("per-request runtime facts identify JEV use, model, class, tokens and priced cost",
   jevFacts.JEV === "success · used" && jevFacts["JEV model"] === "jev-1.13.0"
   && jevFacts["JEV class"] === "strategy" && jevFacts["JEV tokens"] === "566 in / 111 out"
   && jevFacts["JEV cost"] === "$0.000024", JSON.stringify(jevFacts));
const jevUnknownFacts = Object.fromEntries(Model.runtimeFacts(req({ metrics: { jev: {
  attempted: true, status: "error", source: "rules", costUsd: null
} } })).map((f) => [f.label, f.value]));
ok("attempted JEV call without a versioned price is displayed as unknown, never zero",
   jevUnknownFacts["JEV cost"] === "unknown", JSON.stringify(jevUnknownFacts));

// healthRows shape mirrors the three dimensions
const rows = Model.healthRows(Model.computeHealth([req({})]));
ok("three health rows", rows.length === 3 && rows[2].key === "security", JSON.stringify(rows.map((r) => r.key)));

// parse rejects junk and never throws
ok("parse tolerates junk", Model.parse("not json").invalid === true);
ok("parse sorts newest first", Model.parse(JSON.stringify({ requests: [{ at: "2026-01-01" }, { at: "2026-02-01" }] })).requests[0].at === "2026-02-01");
const requestGraph = { nodes: [{ id: "input" }, { id: "jev" }, { id: "router" }],
                      edges: [{ from: "input", to: "jev" }, { from: "jev", to: "router" }] };
const graphData = Model.parse(JSON.stringify({ requests: [req({ architecture: requestGraph,
  edges: [{ from: "input", to: "jev" }] })] }));
ok("per-request JEV workflow graph overrides the shared graph",
   Model.architectureFor(graphData, graphData.requests[0]).nodes.some((n) => n.id === "jev"));
ok("the active input-to-JEV edge is read from the request facts",
   Model.edgeTraversed(graphData.requests[0], "input", "jev"));

// ------------------------------------------------------ window analytics --
const stats = Model.windowStats([
  req({ state: "done", tokens: { input: 100, output: 50, cacheRead: 900, costUsd: 0.002 }, durationMs: 2000, model: "glm",
        nodes: [{ id: "model", status: "ok", ms: 1800 }, { id: "tools", status: "ok", ms: 200 }] }),
  req({ state: "error", tokens: { input: 10, cacheRead: 0, costUsd: 0.001 }, durationMs: 500, model: "glm",
        nodes: [{ id: "model", status: "error", ms: 500 }] }),
  req({ state: "waiting_human", durationMs: 0 })
]);
ok("window settled 2", stats.settled === 2, stats.settled);
ok("window waiting 1", stats.waiting === 1, stats.waiting);
ok("success rate 50%", stats.successRate === 50, stats.successRate);
ok("total cost 0.003", Math.abs(stats.totalCost - 0.003) < 1e-9, stats.totalCost);
ok("avg cost 0.0015", Math.abs(stats.avgCost - 0.0015) < 1e-9, stats.avgCost);
ok("cache hit 89%", stats.cacheHitPct === 89, stats.cacheHitPct);
ok("median duration 1250", stats.medianMs === 1250, stats.medianMs);
ok("stage share model 92 / tools 8", stats.stages[0].id === "model" && stats.stages[0].share === 92 && stats.stages[1].share === 8, JSON.stringify(stats.stages));
ok("model mix one model, 2 runs", stats.modelMix.length === 1 && stats.modelMix[0].count === 2, JSON.stringify(stats.modelMix));
ok("failed stage counted", stats.problems.some((p) => p.key === "stage-failed" && p.count === 1), JSON.stringify(stats.problems));
ok("strip oldest->newest", stats.outcomeStrip.map((s) => s.level).join(",") === "wait,error,ok", JSON.stringify(stats.outcomeStrip));
ok("security not reported", stats.securityReported === 0, stats.securityReported);
ok("headline has cost and cache", Model.headlineFacts(stats).some((f) => f.label === "cost") && Model.headlineFacts(stats).some((f) => f.label === "cache"));
ok("window line names coverage", Model.windowLines(stats).some((l) => /security reported 0\/2/.test(l)), JSON.stringify(Model.windowLines(stats)));
ok("provider errors summed", Model.windowStats([req({ metrics: { errors: 2 } })]).providerErrors === 2);
ok("coverage counts a reported run", Model.windowStats([req({ signals: [{ dimension: "security", kind: "no_risk_detected", level: "info" }] })]).securityReported === 1);

// score series is chronological (oldest first) even though input is newest first
const ser = Model.scoreSeries([req({}), req({ state: "error" })]);
ok("series chronological", ser.stability.join(",") === "75,100", ser.stability.join(","));
const bars2 = Model.sparkBars([100, null, 60]);
ok("spark bars shape", bars2.length === 3 && bars2[0].frac === 1 && bars2[1].level === "unknown" && bars2[2].level === "alert", JSON.stringify(bars2));
ok("age label minutes", Model.ageLabel(120000) === "2m ago", Model.ageLabel(120000));
ok("healthRows carry bars", Model.healthRows(Model.computeHealth([req({})]), ser)[0].bars.length === 2);

// --- instrument: which extension produced these numbers (0.7.4) ----------------
// A live process keeps the extension code it loaded, so the panel must be able to
// say whether the scores describe the code on disk or an older one. Measured
// 2026-10-03: absorbed failures were scored as penalties for 40 minutes after the
// fix landed, because the running process had loaded the old extension.
const disk = (v, extra) => Object.assign({ version: v, sha256: "a".repeat(64), checkedAt: "2026-10-03T04:00:00Z" }, extra);
const snap = (ins) => Model.parse(JSON.stringify({ updatedAt: "x", requests: [], instrument: ins }));

let st = Model.instrumentStatus(snap({ id: "agent-pipeline", extVersion: "0.7.4", loadedAt: "2026-10-03T03:41:32Z", pid: 1, disk: disk("0.7.4") }));
ok("same version on disk and in the process is current", st.state === "current", st.state);
ok("current label names the version", /0\.7\.4/.test(st.label), st.label);

st = Model.instrumentStatus(snap({ extVersion: "0.7.2", loadedAt: "2026-10-03T03:41:32Z", disk: disk("0.7.4") }));
ok("process older than disk is stale", st.state === "stale", st.state);
ok("stale label names both versions and says reload", /0\.7\.2/.test(st.label) && /0\.7\.4/.test(st.label) && /reload/i.test(st.label), st.label);

// an older extension reports no version at all - the honest reading of "unknown instrument"
st = Model.instrumentStatus(snap({ disk: disk("0.7.4") }));
ok("no reported version is unregistered, not current", st.state === "unregistered", st.state);
ok("unregistered label names the disk version", /0\.7\.4/.test(st.label), st.label);
ok("unregistered is not treated as agreeing", st.state !== "current", st.state);

st = Model.instrumentStatus(Model.parse(JSON.stringify({ updatedAt: "x", requests: [] })));
ok("no instrument block at all is unregistered", st.state === "unregistered", st.state);
ok("missing block mentions no version rather than inventing one", !/0\.\d/.test(st.label), st.label);

st = Model.instrumentStatus(snap({ extVersion: "0.7.4", disk: { version: "", sha256: "x" } }));
ok("registered but unreadable disk is unknown", st.state === "unknown", st.state);
st = Model.instrumentStatus(snap({ extVersion: "0.7.4" }));
ok("registered with no disk block is unknown", st.state === "unknown", st.state);

// the indicator must never move a score: it is a caveat about the instrument
const staleOne = Model.parse(JSON.stringify({ updatedAt: "x", requests: [req({})],
  instrument: { extVersion: "0.7.2", disk: disk("0.7.4") } }));
ok("a stale instrument changes no score", Model.computeHealth(staleOne.requests).stability.score === 100,
  Model.computeHealth(staleOne.requests).stability.score);
ok("parse carries the instrument block", staleOne.instrument && staleOne.instrument.disk.version === "0.7.4");
ok("every state has a label", ["current", "stale", "unknown", "unregistered"].every((s) => {
  const m = { current: { extVersion: "7", disk: disk("7") }, stale: { extVersion: "7", disk: disk("8") },
              unknown: { extVersion: "7" }, unregistered: { disk: disk("8") } }[s];
  const r = Model.instrumentStatus(snap(m));
  return r.state === s && typeof r.label === "string" && r.label.length > 0;
}));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
