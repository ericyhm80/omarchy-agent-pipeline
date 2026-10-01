// Report every pi run to the Agent Pipeline bar widget.
//
// The web console instruments itself; this extension does the same for CLI and
// any other pi session, through the documented state file the widget watches.
// Instrumentation must never break the agent it observes: every emit is
// fire-and-forget with a short timeout inside try/catch.
export default function (pi) {
  // A host that instruments itself (the web console) sets this, so the same run
  // is not reported twice — the host knows more about the run than we can see here.
  const selfInstrumented = (() => {
    try { return String(process.env.AGENT_PIPELINE_SELF || "").toLowerCase() === "off"; }
    catch { return false; }
  })();
  if (selfInstrumented) return;

  let id = "";
  let startedAt = 0;
  let toolCalls = 0;
  let usage = null;
  let running = false;

  async function patch(obj) {
    try {
      await pi.exec("agent-pipeline", ["patch", JSON.stringify(obj)], { timeout: 5000 });
    } catch (err) {
      // ignore: the widget is a viewer, not a dependency
    }
  }

  pi.on("before_agent_start", async (event) => {
    id = "pi-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    startedAt = Date.now();
    toolCalls = 0;
    usage = null;
    running = true;
    const prompt = String(event?.prompt ?? "");
    const title = prompt.trim().split("\n")[0].slice(0, 120);
    await patch({
      id,
      title,
      agent: "pi-cli",
      state: "running",
      nodes: [
        { id: "input", status: "ok", detail: prompt.length + " chars", ms: 0 },
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

  pi.on("tool_call", async (event) => {
    if (!running) return;
    toolCalls += 1;
    await patch({
      id,
      nodes: [{ id: "tools", status: "running", detail: String(event?.toolName ?? "tool") + (toolCalls > 1 ? " (+" + (toolCalls - 1) + ")" : ""), ms: 0 }]
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
    await patch({
      id,
      state: "done",
      durationMs,
      tokens,
      nodes: [
        { id: "model", status: "ok", detail, ms: durationMs },
        { id: "tools", status: toolCalls ? "ok" : "skipped", detail: toolCalls ? toolCalls + " tool calls" : "no tools needed", ms: 0 },
        { id: "verify", status: usage ? "ok" : "warn", detail: usage ? "usage captured" : "no usage captured", ms: 0 },
        { id: "output", status: "ok", detail: "returned to terminal", ms: 0 }
      ],
      issues: usage ? [] : [{ level: "warn", node: "verify", detail: "no usage captured for this run" }]
    });
  });
}
