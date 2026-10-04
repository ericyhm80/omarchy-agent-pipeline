# Agent Pipeline — customer guide

Agent Pipeline is a local Omarchy panel for viewing agent activity reported by an
adapter. Installing the panel does **not** automatically connect an agent.

## Install and open

```bash
omarchy plugin add https://github.com/ericyhm80/omarchy-agent-pipeline --enable
```

Open the Agent Pipeline bar widget (left-click), then click **CONNECT** in its
header. The settings page shows the supported reporter choices and their setup
status. Setup actions happen only after you click **CONNECT**; opening the page
checks only known reporter config paths. It does not scan running processes, read
transcripts or agent documentation, or make network requests.

## Connect Codex CLI

1. In the panel's **Connect** page, click **CONNECT** on the Codex card.
2. The helper merges only Agent Pipeline hooks into `CODEX_HOME/hooks.json` (or
   `~/.codex/hooks.json` when `CODEX_HOME` is unset). If a file already exists, it
   first creates an owner-only backup and preserves unrelated settings and hooks.
3. In Codex, run `/hooks` and review/trust the hooks. Start a new turn; if Codex
   does not show the hooks, restart Codex and check `/hooks` again.

The reporter records lifecycle events, safe tool labels/statuses, and durations. It
does not store prompts, command arguments, tool output, transcripts, or working
paths. The panel's **REMOVE** action removes only the hooks that point to this
plugin; the backup is retained.

## Connect Pi

1. In the panel's **Connect** page, click **CONNECT** on the Pi card.
2. The helper installs the bundled prompt-safe extension and makes the bundled
   writer available to Pi. It will not overwrite an existing extension or command.
3. In Pi, run `/reload` or restart Pi. Start a new turn to see it in the panel.

Pi reports a generic title (`Pi turn`), tool events, and reported token usage; it
does not send prompt text or prompt-derived titles. **REMOVE** deletes only an
unchanged bundled extension and a CLI link created by this setup flow. If an older
or customized extension already occupies the target path, setup refuses to replace
it; back it up and remove it yourself only if you intend to replace it.

## Manual reporting for other agents

Claude Code, OpenClaw, Hermes, GrokBot, and any runtime whose operator can run
this CLI can report chosen checkpoints. These agents do **not** have bundled
automatic adapters: nothing connects until the customer explicitly runs the
commands. The panel records only the milestones you choose; it does not watch
the agent or infer what happened. Run these commands from one shell and keep it
open while the task is in progress:

```bash
PIPE="$HOME/.config/omarchy/plugins/io.github.ericyhm80.agent-pipeline/bin/agent-pipeline"
REQ="manual-$(date +%s%N)-$$"
AGENT=claude-code  # or openclaw, hermes, grokbot, or your own agent ID

# Before the agent task:
"$PIPE" start --id "$REQ" --title "Manual agent turn" --agent "$AGENT"

# While it runs, issue this only when you choose to record a checkpoint:
"$PIPE" node --id "$REQ" --node tools --status ok --detail "manual checkpoint"

# When the task ends:
"$PIPE" end --id "$REQ" --state done
```

Use `--state error` for a failed task. Use `--status running`, `ok`, `wait`, or
`error` on `node` to reflect a safe checkpoint. Only pass non-sensitive metadata you
intend to display. Never pass prompts, prompt summaries, command arguments, tool
output, transcripts, keys, or secrets. This is manual instrumentation, not automatic
agent discovery or tool-call capture.

## Remove and uninstall

To stop reporting, click **REMOVE** for each connected runtime before uninstalling
the plugin. It removes only configurations/files that this helper can identify as
belonging to Agent Pipeline; user changes and backups are preserved. Then, if desired:

```bash
omarchy plugin remove io.github.ericyhm80.agent-pipeline
```

The local history at `$XDG_STATE_HOME/omarchy/agent-pipeline/` (usually
`~/.local/state/omarchy/agent-pipeline/`) is separate from the plugin. Delete that
directory only if you also want to erase the recorded panel history.
