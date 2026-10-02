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
src += "\nexport { parse, computeHealth, healthRows, healthColorKey, fmtScore, runtimeFacts, cacheHitPct, tokensPerSec, HEALTH };\n";
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

// a settled, clean run: stability/robustness 100, security has no evidence -> null
let h = Model.computeHealth([req({})]);
ok("clean run stability 100", h.stability.score === 100, h.stability.score);
ok("clean run robustness 100", h.robustness.score === 100, h.robustness.score);
ok("security unknown without telemetry", h.security.score === null && h.security.level === "unknown", h.security.score);
ok("no alert on a clean window", h.alert === false, h.alertReason);

// one errored run is "watch", not "alert"
h = Model.computeHealth([req({ state: "error" })]);
ok("error run stability 75", h.stability.score === 75, h.stability.score);
ok("error run robustness 82 without fallback", h.robustness.score === 82, h.robustness.score);
ok("single error is watch, not alert", h.alert === false && h.stability.level === "watch", h.alertReason);

// a run that errored but recovered is robust
h = Model.computeHealth([req({ state: "error", signals: [{ dimension: "robustness", kind: "fallback_used", level: "info" }] })]);
ok("fallback keeps robustness 100", h.robustness.score === 100, h.robustness.score);
ok("fallback does not hide instability", h.stability.score === 75, h.stability.score);

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

// healthRows shape mirrors the three dimensions
const rows = Model.healthRows(Model.computeHealth([req({})]));
ok("three health rows", rows.length === 3 && rows[2].key === "security", JSON.stringify(rows.map((r) => r.key)));

// parse rejects junk and never throws
ok("parse tolerates junk", Model.parse("not json").invalid === true);
ok("parse sorts newest first", Model.parse(JSON.stringify({ requests: [{ at: "2026-01-01" }, { at: "2026-02-01" }] })).requests[0].at === "2026-02-01");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
