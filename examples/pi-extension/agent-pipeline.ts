// Report every pi run to the Agent Pipeline bar widget.
//
// The web console instruments itself; this extension does the same for CLI and
// any other pi session, through the documented state file the widget watches.
// It reports not just the pipeline but the runtime picture — provider, metrics,
// and the stability / robustness / security signals the widget scores.
//
// Instrumentation must never break the agent it observes: every emit is
// fire-and-forget with a short timeout inside try/catch. The risk scan records
// a pattern *label only* — never the command text — so secrets cannot leak into
// the state file.
export default function (pi) {
  // A host that instruments itself (the web console) sets this, so the same run
  // is not reported twice — the host knows more about the run than we can see here.
  const selfInstrumented = (() => {
    try { return String(process.env.AGENT_PIPELINE_SELF || "").toLowerCase() === "off"; }
    catch { return false; }
  })();
  if (selfInstrumented) return;

  // Which instrument is loaded, recorded on every run.
  //
  // A live process keeps the code it loaded until pi reloads or restarts it, so
  // "the file is fixed" and "the running agent uses the fix" are different claims.
  // Measured 2026-10-03: after the extension on disk was fixed at 16:38Z, a run at
  // 18:41Z still reported tool failures with no recovery - because that process had
  // loaded the old code. The number was honest about the instrument, not the agent,
  // and nothing in the UI said so. So the runtime now publishes what it LOADED
  // (id, version, time, pid); the writer records what is on disk NOW next to it,
  // and the panel says whether the scores can be trusted yet.
  const EXT_ID = "agent-pipeline";
  const EXT_VERSION = "0.7.8";
  const LOADED_AT = new Date().toISOString();
  function procPid() {
    try { return Number(process.pid) || 0; } catch { return 0; }
  }

  // Conservative, label-only command scan. A match never blocks anything — it is
  // one security data point the runtime reports about itself.
  const RISK_PATTERNS = [
    { re: /\bsudo\b/, label: "privilege escalation (sudo)" },
    { re: /rm\s+-[a-z]*[rf][a-z]*\s+(\/|~)(\s|\/|$)/, label: "recursive delete of root or home" },
    { re: /(curl|wget)[^\n|]*\|\s*(ba|z)?sh\b/, label: "piping remote content to a shell" },
    { re: /git\s+push\b[^\n]*(\s--force(\s|$)|\s-f(\s|$))/, label: "force push" },
    { re: /chmod\s+(-R\s+)?777\b/, label: "world-writable chmod" },
    { re: /:\(\)\s*\{.*\};\s*:/, label: "fork bomb" }
  ];
  function scanCommand(cmd) {
    const text = String(cmd || "");
    for (const p of RISK_PATTERNS) {
      if (p.re.test(text)) return p.label;
    }
    return "";
  }

  let id = "";
  let startedAt = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let toolMs = 0;
  const toolStart = {};       // toolCallId -> start time, for per-tool duration
  let apiCalls = 0;
  let providerStatus = [];       // non-2xx statuses seen this run
  let risks = new Set();         // risk labels matched this run
  let commands = 0;              // bash commands scanned (for coverage, not content)
  let fallback = false;
  let usage = null;
  let running = false;

  async function patch(obj) {
    try {
      await pi.exec("agent-pipeline", ["patch", JSON.stringify(obj)], { timeout: 5000 });
    } catch (err) {
      // ignore: the widget is a viewer, not a dependency
    }
  }

  pi.on("before_agent_start", async (event, ctx) => {
    id = "pi-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    startedAt = Date.now();
    toolCalls = 0;
    toolErrors = 0;
    toolMs = 0;
    for (const k in toolStart) delete toolStart[k];
    apiCalls = 0;
    providerStatus = [];
    risks = new Set();
    commands = 0;
    fallback = false;
    usage = null;
    running = true;
    // Never persist prompt text or a prompt-derived title in shared telemetry.
    const title = "Pi turn";
    let provider = "", modelId = "";
    try {
      provider = String(ctx?.model?.provider ?? "");
      modelId = String(ctx?.model?.id ?? ctx?.model?.name ?? "");
    } catch { /* viewer only */ }
    await patch({
      id,
      title,
      agent: "pi-cli",
      state: "running",
      model: modelId,
      env: { provider, model: modelId },
      instrument: { id: EXT_ID, extVersion: EXT_VERSION, loadedAt: LOADED_AT, pid: procPid() },
      nodes: [
        { id: "input", status: "ok", detail: "user turn", ms: 0 },
        { id: "router", status: "skipped", detail: "cli: no router stage", ms: 0 },
        { id: "context", status: "skipped", detail: "cli: session carries context", ms: 0 },
        { id: "memory", status: "skipped", detail: "cli: retrieval via tools", ms: 0 }
      ]
    });
  });

  pi.on("message_start", async (event) => {
    if (!running) return;
    if (String(event?.message?.role ?? "") !== "assistant") return;
    await patch({ id, nodes: [{ id: "model", status: "running", detail: "model call", ms: 0 }] });
  });

  pi.on("after_provider_response", async (event) => {
    if (!running) return;
    apiCalls += 1;
    const status = Number(event?.status ?? 0);
    if (status >= 200 && status < 300) return;
    providerStatus.push(status);
    const kind = status === 429 ? "rate_limit" : (status >= 500 ? "provider_outage" : "model_error");
    const detail = "HTTP " + status + " from provider";
    await patch({
      id,
      metrics: { apiCalls, errors: providerStatus.length },
      signals: [{ dimension: "stability", kind, level: "warn", detail, node: "model" }]
    });
  });

  pi.on("tool_call", async (event) => {
    if (!running) return;
    toolCalls += 1;
    const toolName = String(event?.toolName ?? "tool");
    const args = event?.args ?? {};
    if (event?.toolCallId !== undefined) toolStart[String(event.toolCallId)] = Date.now();
    if (toolName === "bash") {
      commands += 1;
      const label = scanCommand(args.command ?? args.cmd ?? "");
      if (label && !risks.has(label)) {
        risks.add(label);
        await patch({
          id,
          signals: [{ dimension: "security", kind: "risky_command", level: "warn", detail: label, node: "tools" }]
        });
      }
    }
    await patch({
      id,
      metrics: { toolCalls },
      nodes: [{ id: "tools", status: "running", detail: toolName + (toolCalls > 1 ? " (+" + (toolCalls - 1) + ")" : ""), ms: 0 }]
    });
  });

  pi.on("tool_execution_end", async (event) => {
    if (!running) return;
    const toolName = String(event?.toolName ?? "tool");
    const key = event?.toolCallId !== undefined ? String(event.toolCallId) : null;
    let ms = 0;
    if (key !== null && toolStart[key] !== undefined) {
      ms = Math.max(0, Date.now() - toolStart[key]);
      toolMs += ms;
      delete toolStart[key];
    }
    const ok = !event?.isError;
    if (!ok) toolErrors += 1;
    // FACTS, not claims: one entry per finished tool call, in completion order.
    // The scorer DERIVES absorption from this log — an earlier failure of a tool is
    // absorbed when a later call of the SAME tool succeeds in the same run. So no
    // in-memory counter and no compensating `tool_recovered` signal is needed.
    // Why the counter had to go (measured 2026-10-03): it lived inside one pi
    // process, so a reload started from zero and every failure recorded before the
    // reload stayed uncancellable forever — R read 84% for a run whose two failures
    // the session log shows were absorbed 11s and 2s later. A fact survives the
    // reload that a counter does not; the failure signal below is kept only as a
    // human-readable observation (the score no longer depends on it).
    const fact = { tool: toolName, ok: ok, ms: ms };
    if (ok) {
      await patch({ id, metrics: { toolCalls, toolErrors }, toolLog: [fact] });
      return;
    }
    await patch({
      id,
      metrics: { toolCalls, toolErrors },
      toolLog: [fact],
      signals: [{ dimension: "robustness", kind: "tool_failure", level: "warn",
                  detail: "tool error in " + toolName, node: "tools" }]
    });
  });

  pi.on("model_select", async (event) => {
    if (!running) return;
    fallback = true;   // the model changed mid-run: a fallback/switch happened
    let provider = "", modelId = "";
    try {
      provider = String(event?.model?.provider ?? "");
      modelId = String(event?.model?.id ?? event?.model?.name ?? "");
    } catch { /* viewer only */ }
    await patch({
      id,
      model: modelId,
      env: { provider, model: modelId },
      metrics: { fallbacks: 1 },
      signals: [{ dimension: "robustness", kind: "fallback_used", level: "info",
                  detail: "switched to " + (modelId || "another model") }]
    });
  });

  pi.on("agent_end", async (event) => {
    const messages = event?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg && msg.role === "assistant" && msg.usage) { usage = msg.usage; break; }
    }
  });

  pi.on("agent_settled", async () => {
    if (!running) return;
    running = false;
    const durationMs = Date.now() - startedAt;
    const u = usage || {};
    const tokens = {
      input: Number(u.input ?? 0),
      output: Number(u.output ?? 0),
      cacheRead: Number(u.cacheRead ?? 0),
      costUsd: Number((u.cost && u.cost.total) || 0)
    };
    const detail = tokens.input || tokens.output
      ? (tokens.input + tokens.output) + " tokens"
      : "completed";

    const signals = [];
    if (fallback) signals.push({ dimension: "robustness", kind: "recovered", level: "info", detail: "run completed after fallback" });
    if (providerStatus.length) signals.push({ dimension: "robustness", kind: "degraded", level: "info",
      detail: "completed despite " + providerStatus.length + " provider error(s)" });
    // mark security coverage: the run's commands were scanned and none were risky
    if (risks.size === 0) signals.push({ dimension: "security", kind: "no_risk_detected", level: "info",
      detail: commands + " command(s) scanned, no high-risk pattern" });

    await patch({
      id,
      state: "done",
      durationMs,
      tokens,
      metrics: { toolCalls, toolErrors, toolMs, apiCalls, fallbacks: fallback ? 1 : 0, errors: providerStatus.length },
      nodes: [
        { id: "model", status: "ok", detail, ms: durationMs },
        { id: "tools", status: toolCalls ? (toolErrors ? "warn" : "ok") : "skipped",
          detail: toolCalls ? toolCalls + " tool calls" + (toolErrors ? ", " + toolErrors + " failed" : "") : "no tools needed", ms: toolMs },
        { id: "verify", status: usage ? "ok" : "warn", detail: usage ? "usage captured" : "no usage captured", ms: 0 },
        { id: "output", status: "ok", detail: "returned to terminal", ms: 0 }
      ],
      signals,
      issues: usage ? [] : [{ level: "warn", node: "verify", detail: "no usage captured for this run" }]
    });
  });
}
