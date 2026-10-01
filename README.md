# Agent Pipeline — see what your AI agent is actually doing

An Omarchy bar widget that renders **one pipeline per agent request**: how the
request was classified, which model tier it was routed to, what memory was
retrieved, which tools ran, and whether the result was verified — with timing,
tokens and cost.

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

That is enough to explain an agent run to someone who has never seen one: what it classified
the request as, which model it chose, what it retrieved, which tools it ran, and what went wrong.

![pipeline graph](preview.png)

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
      { "id": "input",  "label": "Owner 命令",  "x": 8,   "y": 158, "w": 116, "h": 46 },
      { "id": "router", "label": "分类 / 路由", "x": 156, "y": 158, "w": 124, "h": 46 }
    ],
    "edges": [ { "from": "input", "to": "router" } ]
  },
  "requests": [
    {
      "id": "req-42", "at": "2026-10-01T15:17:00Z", "title": "memory-eval 命令注册在哪里？",
      "state": "done", "taskClass": "lookup", "route": "cheap", "model": "zai/glm-5.3-flash",
      "durationMs": 15500,
      "tokens": { "input": 352, "output": 166, "cacheRead": 4928, "costUsd": 0.00028 },
      "nodes": [
        { "id": "router",  "status": "ok",      "detail": "lookup → cheap", "ms": 239 },
        { "id": "memory",  "status": "ok",      "detail": "1 条检索注入",    "ms": 2793 },
        { "id": "model",   "status": "ok",      "detail": "zai/glm-5.3-flash", "ms": 11989 },
        { "id": "tools",   "status": "ok",      "detail": "2 次工具调用",    "ms": 0 },
        { "id": "verify",  "status": "ok",      "detail": "用量已记录",      "ms": 1 }
      ],
      "edges": [ { "from": "input", "to": "router" }, { "from": "router", "to": "memory" } ],
      "issues": [ { "level": "warn", "node": "model", "detail": "codex 达限额，降级到 GLM" } ]
    }
  ]
}
```

Omit `architecture` and the widget falls back to the pipeline it ships with, so a runtime only
has to write `requests`. `status` accepts `ok`, `running`, `warn`, `error`, `skipped`;
`state` accepts `running`, `done`, `error`; `issues[].level` accepts `info`, `warn`, `error`.

## Recording a request

The bundled writer keeps the file tidy (atomic writes, a lock, most recent 30 requests) and
never fails loudly, so instrumentation cannot break the agent it observes:

```bash
# optional: describe your own architecture once (omit to use the shipped pipeline)
agent-pipeline architecture --file my-graph.json

agent-pipeline start --id "$REQ" --title "memory-eval 命令注册在哪里？" --agent entrepreneur-agent
agent-pipeline node  --id "$REQ" --node router --status ok --detail "lookup → cheap"     --ms 239
agent-pipeline node  --id "$REQ" --node memory --status ok --detail "1 条检索注入"        --ms 2793
agent-pipeline node  --id "$REQ" --node model  --status ok --detail "zai/glm-5.3-flash"  --ms 11989
agent-pipeline node  --id "$REQ" --node tools  --status ok --detail "2 次工具调用"        --ms 0
agent-pipeline issue --id "$REQ" --level warn --node model --detail "codex 达限额，降级到 GLM"
agent-pipeline end   --id "$REQ" --state done --duration-ms 15500 \
  --tokens-json '{"input":352,"output":166,"cacheRead":4928,"costUsd":0.00028}'
```

Recording a node also marks the edge that feeds it as traversed, so edges never have to be
listed by hand. `step --name ...` still works and renders as a plain list for runtimes that do
not describe a graph. Other subcommands: `emit --json '<object>'` (whole request at once),
`clear`, `demo` (sample graph + request).

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
