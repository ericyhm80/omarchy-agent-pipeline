# Agent Pipeline — see what your AI agent is actually doing

An Omarchy bar widget that renders **one pipeline per agent request**: how the
request was classified, which model tier it was routed to, what memory was
retrieved, which tools ran, and whether the result was verified — with timing,
tokens and cost. Above the graph it also scores the running architecture on
**stability, robustness and security**, and under the run it shows every runtime
metric, so a glance tells you both what happened and how healthy the system is.

It exists for two audiences:

- **Operators**, who want to know why an answer cost what it cost.
- **Teachers and customers**, who want to *watch* an agent work instead of being
  told it does. The panel is the picture you point at while explaining
  "classify → route → retrieve → act → verify".

![pipeline panel](preview.png)

## What it shows

The panel draws the agent's architecture as a **graph**, not a list:

- **nodes** are the stages (input, routing, context assembly, memory retrieval, model call,
  tools, verification, human gate, output) positioned by the data itself;
- **edges** are how information travels, with labels;
- the path a request **actually took** is highlighted, and while it is still running small
  dots flow along those edges;
- each node carries its own state (`ok` / `running` / `warn` / `error` / `skipped`), a short
  detail and its own duration;
- under the graph: the request's duration, tokens (input / output / cache), cost, model, and
  every problem encountered (`issues`).
- the canvas is sized to the graph's own bounding box, so the panel stays compact whatever a
  runtime draws, and the UI is English throughout;
- above the graph, **architecture health** — stability / robustness / security
  scores with a one-line alert when one slips;
- a **window summary** — runs, success rate, spend, cache hit rate, median latency,
  rate and recency — and an **outcome strip** of the last runs;
- a **trend sparkline** inside each gauge, oldest to newest, with the sample size `n`;
- under the run, every **runtime fact** it recorded: duration, tokens in/out/cache,
  cost, cache hit rate, throughput, tool calls, api calls, retries, fallbacks,
  errors, and the provider/model.

While a request is still running the panel is **live**: the active node is highlighted, small
dots flow along the edges it has traversed, the duration counts up, and the path fills in as the
run progresses. It is a synchronized view of the run, not a post-mortem — which is what makes it
usable for explaining an agent to someone who has never seen one: what it classified the request
as, which model it chose, what it retrieved, which tools it ran, and what went wrong.

![pipeline graph](preview.png)

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

agent-pipeline start --id "$REQ" --title "Where is the memory-eval command registered?" --agent entrepreneur-agent
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

## Who reports

Anything can report: a host that runs agents (a console, a CI job, a script) simply writes the JSON
above, and the widget shows it — that is how the web console and this repo's own `agent-pipeline`
CLI work. Two small conventions keep the picture clean:

- **Instrumentation must never break the agent it observes.** The bundled writer swallows its own
  failures, and the example extension wraps every emit in try/catch.
- **One reporter per run.** If a host already reports its own runs and *also* spawns pi (or any
  tool) that has its own global reporter, the host should set `AGENT_PIPELINE_SELF=off` for those
  child processes; the example extension stands down when it sees that variable, so a run is never
  reported twice (and the host's richer report is the one that survives).

`examples/pi-extension/agent-pipeline.ts` is a working reporter for the **pi** coding agent: drop it
in `~/.pi/agent/extensions/` and every pi session — terminal and headless — appears in the widget,
with the prompt as the title, per-tool updates, and real token usage at the end.

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
omarchy plugin enable io.github.ericyhm80.agent-pipeline --section center
agent-pipeline demo        # see it with sample data
```

## Development note

Saving a QML file reloads the plugin automatically. **A change to `Model.js`
(the scoring engine) needs a full `omarchy restart shell`**: `.pragma library`
modules are cached and a plugin rescan alone will not pick them up.

## Privacy

The widget only reads the local state file above. It makes no network requests,
collects nothing, and sends nothing anywhere. Whatever your agent writes into
that file is what you see.

## Uninstall

```bash
omarchy plugin remove io.github.ericyhm80.agent-pipeline
rm -f ~/.local/bin/agent-pipeline
rm -rf ~/.local/state/omarchy/agent-pipeline
```

## License

MIT — see [LICENSE](LICENSE).
