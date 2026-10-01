#!/usr/bin/env bash
# Wrap any command so its run shows up as a pipeline in the bar widget.
# Usage:  ./wrap-any-command.sh "定价策略评审" -- your-agent-cli --prompt "..."
set -uo pipefail

title="${1:-agent run}"; shift || true
[ "${1:-}" = "--" ] && shift

req="req-$RANDOM-$$"
start_ms=$(date +%s%3N)

agent-pipeline start --id "$req" --title "$title"
agent-pipeline step  --id "$req" --name classify --status ok --detail "manual run" --ms 0

"$@"
rc=$?

end_ms=$(date +%s%3N)
agent-pipeline step --id "$req" --name run --status "$([ $rc -eq 0 ] && echo ok || echo error)" \
  --detail "$*" --ms "$((end_ms - start_ms))"
agent-pipeline end --id "$req" --state "$([ $rc -eq 0 ] && echo done || echo error)"
exit $rc
