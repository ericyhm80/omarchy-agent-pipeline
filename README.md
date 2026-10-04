# Agent Pipeline — see what your AI agent is actually doing

**0.8.0:** a first-view evidence card and clickable request-path nodes distinguish
reported events from unobserved stages, with a bounded next check instead of an
unproven root cause. Metrics and recent runs are expandable; the card background
can be clear, glass, or solid. The new Marketplace artwork includes a genuine
local Pi run, not fabricated agent activity. The local popup component is derived
from Omarchy's MIT-licensed KeyboardPanel; see [third-party notices](THIRD_PARTY_NOTICES.md).

**0.7.8:** explicit, reversible opt-in Connect flow for Codex CLI and Pi; a manual
CLI checkpoint path for Claude Code, OpenClaw, Hermes, GrokBot, and other runtimes.
Pi request titles are prompt-free. JEV call telemetry is observational only,
never affects health scores, and remains unpriced when version or usage is unknown.

An Omarchy bar widget that shows **reported evidence for one agent request**:
which stages actually emitted events, what path they reported, and where the
record has blind spots. Its first-view finding names a reported symptom and a
next check, not an unverified root cause. When provided by the runtime, timing,
tokens, cost and health signals remain available under **RUN METRICS**. A missing
event never proves a stage did not run.

It exists for two audiences:

- **Operators**, who want to know why an answer cost what it cost.
- **Teachers and customers**, who want to *watch* an agent work instead of being
  told it does. The panel is the picture you point at while explaining
  "classify → route → retrieve → act → verify".

![Agent Pipeline marketplace preview, featuring a real Pi run in the panel](preview.png)

The preview is a promotional layout around a cropped capture of a live Pi run,
not a fabricated UI. The finding and event counts reflect only what that reporter
submitted, not a promise of full architecture coverage or future performance.
The Pi reporter uses the fixed title `Pi turn` and does not save the prompt.
The card background is selectable (CLEAR / GLASS / SOLID); the capture uses
SOLID for legibility.

## What it shows

The panel draws the agent's architecture as a **graph**, not a list:

- **nodes** are the stages (input, routing, context assembly, memory retrieval, model call,
  tools, verification, human gate, output) positioned by the data itself;
- **edges** are how information travels, with labels;
- the path a request **actually took** is highlighted, and while it is still running small
  dots flow along those edges;
- solid nodes/edges are reported events; dashed ones have no reported event in
  this run (this is **not** proof the stage was skipped). The fallback template
  is a display aid, not a discovered agent architecture;
- each reported node carries its state (`ok` / `running` / `warn` / `error` / `skipped`),
  a reporter-supplied detail and its reported duration (only send non-sensitive metadata);
- under the graph: the request's duration, tokens (input / output / cache), cost, model, and
  every problem encountered (`issues`).
- the canvas is sized to the graph's own bounding box, so the panel stays compact whatever a
  runtime draws, and the UI is English throughout;
- above the graph, a bounded **finding** with reported evidence, blind spots and
  a suggested check. It is not an automatic root-cause claim;
- under **RUN METRICS**, **architecture health** — stability / robustness /
  security scores with an alert that remains visible when one slips;
- a **window summary** — runs, success rate, spend, cache hit rate, median latency,
  rate and recency — and an **outcome strip** of the last runs;
- a separate **JEV API summary** for the latest up to 200 external attempts across
  `token-router` and `model-router`: successes/failures, returned usage tokens,
  average latency and cost coverage. It records no prompts, API keys, or provider
  error text. Since the API returns usage but not a price, cost is calculated only
  when the response's version has a matching official published rate (Jev 1.13:
  $0.042/M input tokens, output free; https://docs.typesafe.ai/models); unknown cases
  are marked unpriced, never zero. JEV telemetry never changes architecture health
  scores;
- a **trend sparkline** inside each gauge, oldest to newest, with the sample size `n`;
- under the run, every **runtime fact** it recorded: duration, tokens in/out/cache,
  cost, cache hit rate, throughput, tool calls, api calls, retries, fallbacks,
  errors, and the provider/model.

While a request is still running the panel is **live**: the active node is highlighted, small
dots flow along the edges it has traversed, the duration counts up, and the path fills in as the
run progresses. It is a synchronized view of the run, not a post-mortem — which is what makes it
usable for explaining an agent to someone who has never seen one: what it classified the request
as, which model it chose, what it retrieved, which tools it ran, and what went wrong.

The **REQUEST PATH** card keeps the reported execution path prominent. Click a
node to inspect its bounded status, duration and adjacent edge count, plus a
blind-spot warning and a suggested next check. Clicking again closes the
inspector. It displays a safe stage ID rather than copying arbitrary node labels
or details; it does not read prompts, commands or tool output. Reporter-submitted
status is not independent proof of what happened inside an agent. **RUN METRICS**
and **RECENT** can be expanded for telemetry and history without crowding the
first view.

## JEV call telemetry

`agent-pipeline jev-event` appends one privacy-minimal record per actual TypeSafe
System One API attempt observed after this telemetry was installed. The bounded
`jevEvents` list retains the newest 200 records, including source (`token-router` /
`model-router`), result, model, elapsed
time, and token usage only when the provider reports it. Disabled routing and
missing credentials are not counted as external calls. In the company-web workflow, the base graph is `Input → Rules → Route` and contains
no JEV node. A JEV branch is inserted only after budget authorization and immediately
before TypeSafe I/O. If a valid JEV classification is used, Rules and JEV both feed
Route; if the call fails or its result is unused, the attempted JEV node is a warning
and Rules is the Route fallback. Disabled, unconfigured, unavailable, or budget-denied
requests show no JEV node or per-request JEV metrics. Its caption contains only model/class, latency, reported usage,
and version-priced cost; never the prompt, key, or raw provider error. The following
Route node shows the selected policy/model. This per-request graph is distinct from
the global `jevEvents` summary. Cost is calculated only from the version-matched official
input-token rate; unknown versions/usages remain unpriced and fail closed in the
company's budget gate.

## Architecture health

Above the graph the panel scores the architecture on three dimensions over the
last 20 settled requests, from what the runtime actually recorded. Nothing is
invented — a dimension with no evidence reads `n/a`, never a perfect score:

| dimension | the question it answers | evidence it is scored from |
|---|---|---|
| **stability** | does a run do its job? | errored runs, warnings, failed stages, retry / timeout / rate-limit / provider-outage signals |
| **robustness** | does it degrade **and recover** gracefully? | errors with and without a fallback, **tool failures derived from the recorded tool facts** (a later success of the same tool absorbs an earlier failure), degraded runs |
| **security** | does it respect the gate and contain risk? | the security signals a runtime reports: gate bypass, secret exposure, sandbox / policy violations, prompt injection, risky commands |

Each score is `100` minus the penalties of its signals and run outcomes (the
weights live in one place, `Model.js` → `HEALTH`). Colours: **≥85** normal,
**70–84** watch, **<70** alert, **n/a** unknown. When a score is in alert the bar
glyph turns urgent and the panel shows one line naming the worst dimension and
its top driver:

```
⚠ architecture health: security 55 — secret exposure ×1
```

Signals are the runtime's own observations — the only way the widget can know
what it cannot see (a human gate that was skipped, a sandbox violation, a stealth
exception). A signal's default penalty comes from its `kind`; pass `--weight N` to
override it for one signal.

### Which instrument produced these numbers?

The panel always names the instrument, because a score is a statement about the
agent **as the runtime running it understood it** — and a live agent process keeps
the extension code it loaded until it is reloaded or restarted. "The file is
fixed" and "the running agent uses the fix" are two different claims.

Measured 2026-10-03: after the extension on disk was fixed, a process that had
loaded the old code kept reporting absorbed failures as penalties for 40 minutes.
The number was honest about the instrument, and nothing on screen said so — it
read like a property of the agent.

The extension publishes what it **loaded**, and the writer records what is on
disk next to it:

```json
"instrument": {
  "id": "agent-pipeline",
  "extVersion": "0.7.4",
  "loadedAt": "2026-10-03T03:41:32.000Z",
  "pid": 3183597,
  "disk": { "version": "0.7.4", "sha256": "1068ed9b…",
            "mtime": "2026-10-03T03:41:32Z", "checkedAt": "2026-10-03T04:08:51Z" }
}
```

`loaded === disk` → quiet line (`instrument 0.7.4 - disk agrees (loaded 10-03 03:41)`).
Different versions → bold warning, and the bar tooltip repeats it:

```
instrument is stale: the process loaded 0.7.2 but disk has 0.7.4
- these scores come from older code; reload the agent before trusting them
```

No version reported at all → `instrument not registered`, which is what an older
extension looks like, and is the honest reading of "these numbers came from a
version nobody can name". A missing extension file records nothing rather than a
fabricated version. The indicator never changes a score — a stale instrument is a
caveat about what the numbers describe, not a reason to adjust them.

### A failure that was absorbed is not a degradation

How does the widget know a failure was absorbed? It reads the recorded **facts**:
the `toolLog` array of a request holds one entry per finished tool call, in
completion order.

```json
"toolLog": [ { "tool": "bash", "ok": false, "ms": 1200 },
              { "tool": "bash", "ok": true,  "ms": 980 } ]
```

A failure is absorbed when a later call of the **same tool** succeeds in the same
request — one success absorbs one earlier failure. That is derived at scoring time,
so nothing has to be negotiated between two signals, and the derivation cannot
depend on the state of the process that recorded it.

Why facts and not a claim: the first version of this fix had the runtime keep a
per-tool counter in its own memory and emit a `tool_recovered` signal on a retry.
That counter lives inside one process. A reload started it from zero, and every
failure recorded before the reload could never be cancelled afterwards — the
panel showed 68, then 60, then 84 for runs whose failures a session log shows were
absorbed seconds later, and each time the number could only be repaired by
hand-writing recovery claims into the store. A metric that needs manual backfill
is not a metric. Facts survive the reload; a counter does not.

Backwards compatible: a request **without** `toolLog` still scores by the old
claim rule (a `tool_recovered` signal cancels the most recent unmatched
`tool_failure` in the same request, kind-matched, never across requests, and a
no-op when there is nothing to cancel). When facts *are* present the tool signals
are ignored for scoring — counting both would double the penalty — but a
`tool_failure` signal is still recorded and shown as evidence. A whole-run
`recovered` (the run finished after a fallback) is a different claim and does
**not** cancel tool failures.

The failure itself is recorded and displayed either way; only the score and the
driver list drop the absorbed ones. An unabsorbed failure — nothing succeeded
after it — still costs its full weight, so the dimension can still go down.

Older requests can be given their facts from the runtime's own session log, which
is independent evidence (it survives the instrumentation being replaced):

```bash
agent-pipeline reconcile --session-log ~/.pi/agent/sessions/<id>.jsonl --dry-run
agent-pipeline reconcile --session-log ~/.pi/agent/sessions/<id>.jsonl --apply
agent-pipeline reconcile --session-log ~/.pi/agent/sessions/<id>.jsonl --verify
```

It writes nothing without `--apply`; `--apply` backs the store up first and tags
the request with `toolLogSource` (where the facts came from). `--verify`
re-derives the facts of requests that already have them and compares — so the
reconstruction can be caught being wrong. Requests whose window contains no tool
results are skipped with a warning, never filled in with a guess.

## The window, not just one run

A score is a current value. The panel also summarises the whole window, so both
the direction and the cost are visible:

- a **headline** — `runs 19 · ok 100% · cost $0.044 · per run $0.0023 · cache 96% · median 1.9m · rate 8/h · today 20 · last 2m ago`;
- an **outcome strip** — the last runs, oldest on the left, coloured by result, so a cluster of failures is visible before reading any number;
- a **trend sparkline** in each gauge (one bar per settled run) and the sample size `n`;
- deeper lines, only when there is something to say: where the time went (`time: tools 38% · model 62%`), waiting-on-human, provider errors, security coverage (`security reported 0/19` — why the score is `n/a`), recurring problems, and the model mix.

Every figure is derived from recorded fields. A field that is absent is hidden,
never shown as a zero, and `n` is always visible so a score built on two runs is
not mistaken for a trend.

## How it gets data

The plugin is passive: it watches one documented local file and makes no network requests.

```
$XDG_STATE_HOME/omarchy/agent-pipeline/requests.json      # usually ~/.local/state/...
```

```json
{
  "updatedAt": "2026-10-01T15:17:00Z",
  "instrument": { "id": "agent-pipeline", "extVersion": "0.7.4",
                  "loadedAt": "...", "disk": { "version": "0.7.4", "sha256": "..." } },
  "architecture": {
    "width": 720, "height": 380,
    "nodes": [
      { "id": "input",  "label": "Input",           "x": 6,   "y": 96,  "w": 122, "h": 42 },
      { "id": "router", "label": "Classify + Route", "x": 146, "y": 96,  "w": 128, "h": 42 }
    ],
    "edges": [ { "from": "input", "to": "router" } ]
  },
  "requests": [
    {
      "id": "req-42", "at": "2026-10-01T15:17:00Z", "title": "Where is the memory-eval command registered?",
      "state": "done", "taskClass": "lookup", "route": "cheap", "model": "zai/glm-5.3-flash",
      "durationMs": 15500,
      "tokens": { "input": 352, "output": 166, "cacheRead": 4928, "costUsd": 0.00028 },
      "env": { "provider": "z.ai", "model": "glm-5.3-flash" },
      "metrics": { "toolCalls": 2, "apiCalls": 3, "retries": 0, "fallbacks": 1, "toolErrors": 0 },
      "nodes": [
        { "id": "router",  "status": "ok",      "detail": "lookup → cheap", "ms": 239 },
        { "id": "memory",  "status": "ok",      "detail": "1 item retrieved", "ms": 2793 },
        { "id": "model",   "status": "ok",      "detail": "zai/glm-5.3-flash", "ms": 11989 },
        { "id": "tools",   "status": "ok",      "detail": "2 tool calls", "ms": 0 },
        { "id": "verify",  "status": "ok",      "detail": "telemetry recorded", "ms": 1 }
      ],
      "edges": [ { "from": "input", "to": "router" }, { "from": "router", "to": "memory" } ],
      "issues": [ { "level": "warn", "node": "model", "detail": "codex hit its limit, fell back to GLM" } ],
      "toolLog": [ { "tool": "bash", "ok": false, "ms": 1200 },
                   { "tool": "bash", "ok": true,  "ms": 980 } ],
      "signals": [
        { "dimension": "stability",  "kind": "provider_outage",  "level": "warn", "detail": "z.ai 502" },
        { "dimension": "robustness", "kind": "fallback_used",    "level": "info", "detail": "continued on GLM" },
        { "dimension": "security",   "kind": "no_risk_detected", "level": "info", "detail": "3 commands scanned" }
      ]
    }
  ]
}
```

A request may also carry its **own** `architecture`: that is how a multi-step (orchestrator) run
draws its plan — the steps become nodes and `depends_on` becomes edges — instead of the shared
pipeline graph. The panel picks the request's graph when it has one and the global graph otherwise.

Omit `architecture` and the widget falls back to the pipeline it ships with, so a runtime only
has to write `requests`. `status` accepts `ok`, `running`, `warn`, `error`, `skipped`;
`state` accepts `running`, `done`, `error`; `issues[].level` accepts `info`, `warn`, `error`.
`toolLog[]` accepts `{tool, ok, ms}` — the tool facts robustness is derived from; a request
without it is scored from its signals instead (see above).
`signals[].dimension` accepts `stability`, `robustness`, `security`; `signals[].kind` is one of
the documented kinds (`provider_outage`, `retry`, `timeout`, `rate_limit`, `model_error`,
`fallback_used`, `tool_failure`, `tool_recovered`, `degraded`, `recovered`, `secret_exposure`,
`external_send_unauthorized`, `human_gate_bypass`, `sandbox_violation`, `policy_violation`,
`prompt_injection`, `stealth_unauthorized`, `risky_command`, `no_risk_detected`, …). An unknown
kind uses a small default; set `signals[].weight` to override one signal. `metrics` and `env`
are free-form and rendered as runtime facts. The widget keeps the newest 30 requests and shows
the newest by default.

## Recording a request

The bundled writer keeps the file tidy (atomic writes, a lock, most recent 30 requests) and
never fails loudly, so instrumentation cannot break the agent it observes:

```bash
# optional: describe your own architecture once (omit to use the shipped pipeline)
agent-pipeline architecture --file my-graph.json

agent-pipeline start --id "$REQ" --title "Agent turn" --agent entrepreneur-agent
agent-pipeline node  --id "$REQ" --node router --status ok --detail "lookup → cheap"     --ms 239
agent-pipeline node  --id "$REQ" --node memory --status ok --detail "1 item retrieved"      --ms 2793
agent-pipeline node  --id "$REQ" --node model  --status ok --detail "zai/glm-5.3-flash"  --ms 11989
agent-pipeline node  --id "$REQ" --node tools  --status ok --detail "2 tool calls"          --ms 0
agent-pipeline issue  --id "$REQ" --level warn --node model --detail "codex hit its limit, fell back to GLM"
agent-pipeline signal --id "$REQ" --dimension robustness --kind fallback_used --level info --detail "continued on GLM"
agent-pipeline signal --id "$REQ" --dimension security --kind human_gate_bypass --level error --detail "L2 sent without sign-off"
# tool facts: one line per finished tool call (a retry of the same tool absorbs the failure)
agent-pipeline patch '{"id":"'"$REQ"'","toolLog":[{"tool":"bash","ok":false,"ms":1200}]}'
agent-pipeline end   --id "$REQ" --state done --duration-ms 15500 \
  --tokens-json '{"input":352,"output":166,"cacheRead":4928,"costUsd":0.00028}' \
  --metrics-json '{"toolCalls":2,"apiCalls":3,"fallbacks":1}' --env-json '{"provider":"z.ai"}'
```

Recording a node also marks the edge that feeds it as traversed, so edges never have to be
listed by hand. `step --name ...` still works and renders as a plain list for runtimes that do
not describe a graph. Other subcommands: `emit --json '<object>'` (whole request at once),
`reconcile --session-log <pi session>` (write missing tool facts from the runtime's own record —
dry run unless `--apply`, and `--verify` re-derives facts that are already there), `clear`,
`demo` (sample graph + request).

## Inspecting earlier runs

The panel opens on the newest run and stays live while one is in flight. To look at an earlier
one, press **↑/↓** or click a row under RECENT: the graph and the summary switch to that run, the
header shows `viewing 3/7`, and clicking the same row again (or pressing ↑ back to the top)
returns to the newest. The newest run keeps recording while you inspect, so nothing is lost.

## Runtime coverage and who reports

**This is not an agent auto-discovery service.** Installing the plugin does not watch
processes, read other agents' transcripts, or automatically identify every coding agent
on the machine. The panel displays only work that an installed reporter or an explicit
CLI/API integration sends to its shared store. See the [customer usage guide](docs/USAGE.md)
for opt-in setup, privacy boundaries, and removal instructions.

| Runtime | Automatic reporting included? | Coverage |
|---|---|---|
| Pi | Optional reporter included | Select **Connect** in the panel to install the prompt-free Pi extension; restart/reload Pi afterward. |
| Sovereign company-web | Yes, in that product integration | Its server emits request-specific routing and model stages. |
| Codex CLI | Optional hook reporter included | Select **Connect** in the panel to merge hooks safely, then review/trust them with `/hooks`. New turns, local tool calls, and subagent activity are reported without prompts, command arguments, or tool output. |
| Claude Code, OpenClaw, Hermes, GrokBot, or another runtime | Manual CLI/API only | With the customer's explicit opt-in, use the local writer to mark chosen lifecycle checkpoints; no bundled adapter or automatic discovery is included yet. See [manual reporting](docs/USAGE.md#manual-reporting-for-other-agents). |

The panel's **Connect** page checks only known reporter config paths when opened; it does
not enumerate running processes, read agent docs, or make network requests. Connect
buttons are explicit and reversible: Codex config is backed up with owner-only permissions,
and an existing Pi extension is never overwritten. The Pi reporter is not enabled at install.
The optional Codex reporter is `bin/codex-hook.py`; see
[`examples/codex-hooks/hooks.json`](examples/codex-hooks/hooks.json) for the hook
registrations. Codex requires trust review for non-managed hooks; use `/hooks` in the
Codex CLI to review/trust them. This is explicit opt-in instrumentation, not process
auto-discovery. `~/.codex/hooks.json` is user-level, so the configuration applies to
that user's Codex sessions after trust, not just one window; remove/disable the entries
to stop reporting. Codex also provides `codex exec --json` for non-interactive event
streams; the current reporter uses the Codex CLI hooks API for interactive turns. It
shows explicit execution events, not private model reasoning/chain-of-thought; Codex does
not provide that as a workflow telemetry event. Up to eight tool calls and four subagents
are drawn individually; further calls are bounded and aggregated.

Any host that runs agents can report by writing the JSON above or invoking the CLI; this
is an extension point, not automatic discovery. Two small conventions keep the picture
clean:

- **Instrumentation must never break the agent it observes.** The bundled writer swallows its own
  failures, and the example extension wraps every emit in try/catch.
- **One reporter per run.** If a host already reports its own runs and *also* spawns pi (or any
  tool) that has its own global reporter, the host should set `AGENT_PIPELINE_SELF=off` for those
  child processes; the example extension stands down when it sees that variable, so a run is never
  reported twice (and the host's richer report is the one that survives).

`examples/pi-extension/agent-pipeline.ts` is a working reporter for the **pi** coding agent. The
Connect page installs it to `~/.pi/agent/extensions/`; after Pi reloads, sessions appear with a
generic prompt-free title, per-tool updates, and reported token usage.

## Interaction

| action | result |
|---|---|
| left click | open the pipeline panel |
| middle click | reload the data file |
| right click | close the panel |
| `omarchy-shell shell summon io.github.ericyhm80.agent-pipeline '{}'` | open from a script |
| `omarchy-shell shell hide io.github.ericyhm80.agent-pipeline` | close from a script |

The bar glyph turns accent-coloured while a request is running, and urgent when
the newest request errored or a step reported a warning.

## Install

```bash
omarchy plugin add https://github.com/ericyhm80/omarchy-agent-pipeline --enable
# Open the bar widget and choose CONNECT to opt in to a runtime reporter.
# Preview the panel with sample data (the plugin add command does not install the CLI to PATH):
~/.config/omarchy/plugins/io.github.ericyhm80.agent-pipeline/bin/agent-pipeline demo
```

## Development note

Saving a QML file reloads the plugin automatically. **A change to `Model.js`
(the scoring engine) needs a full `omarchy restart shell`**: `.pragma library`
modules are cached and a plugin rescan alone will not pick them up.

## Privacy

The panel only reads the local state file above and makes no network requests. Optional
reporters write bounded operational metadata to that local file; bundled Codex and Pi
reporters omit prompt text, command arguments, tool output, transcripts, and keys.
Nothing is uploaded by the plugin. See the [customer usage guide](docs/USAGE.md).

## Uninstall

First use the panel's **REMOVE** action for each connected reporter, then uninstall:

```bash
omarchy plugin remove io.github.ericyhm80.agent-pipeline
```

Optionally remove `~/.local/state/omarchy/agent-pipeline/` if you also want to erase
local history. Do not delete `~/.local/bin/agent-pipeline` unless you have verified it
is the Agent Pipeline symlink; the setup helper removes only the link it created.

## License

MIT — see [LICENSE](LICENSE).
