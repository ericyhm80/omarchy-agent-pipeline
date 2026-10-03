#!/usr/bin/env python3
"""Offline Codex-hook integration test using a temporary writer store."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "bin" / "codex-hook.py"
WRITER = ROOT / "bin" / "agent-pipeline"


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def send(env: dict[str, str], event_name: str, **fields: object) -> str:
    payload = {
        "hook_event_name": event_name,
        "session_id": "session-private-id",
        "turn_id": "turn-private-id",
        "cwd": "/private/workspace",
        "model": "gpt-5.4-codex",
        **fields,
    }
    proc = subprocess.run(
        ["python3", str(HOOK), "--event", event_name],
        input=json.dumps(payload), text=True, capture_output=True,
        env=env, timeout=10, check=False,
    )
    check(proc.returncode == 0, f"hook failed: {event_name}")
    if event_name in {"Stop", "Interrupt", "SubagentStop"}:
        check(proc.stdout.strip() == "{}", f"invalid {event_name} hook output")
    else:
        check(proc.stdout == "", f"unexpected hook stdout for {event_name}")
    return proc.stdout


def main() -> int:
    prompt_secret = "PROMPT_MUST_NOT_PERSIST_9d318"
    command_secret = "COMMAND_MUST_NOT_PERSIST_574ac"
    output_secret = "OUTPUT_MUST_NOT_PERSIST_850cd"
    answer_secret = "ANSWER_MUST_NOT_PERSIST_72f81"
    agent_secret = "SUBAGENT_OUTPUT_MUST_NOT_PERSIST_836ab"
    with tempfile.TemporaryDirectory() as td:
        env = os.environ.copy()
        env["XDG_STATE_HOME"] = td
        env["AGENT_PIPELINE_BIN"] = str(WRITER)
        send(env, "UserPromptSubmit", prompt=prompt_secret)
        send(env, "PreToolUse", tool_name="Bash", tool_use_id="tool-id-1",
             tool_input={"command": command_secret})
        send(env, "PostToolUse", tool_name="Bash", tool_use_id="tool-id-1",
             tool_input={"command": command_secret},
             tool_response={"exit_code": 2, "output": output_secret})
        send(env, "PreToolUse", tool_name="Fileedit", tool_use_id="tool-id-2",
             tool_input={"path": "/private/workspace/generated.html"})
        send(env, "PostToolUse", tool_name="Fileedit", tool_use_id="tool-id-2",
             tool_response={"status": "success", "content": "PRIVATE_HTML_CONTENT"})
        send(env, "SubagentStart", agent_id="agent-private-id", agent_type="reviewer")
        send(env, "SubagentStop", agent_id="agent-private-id", agent_type="reviewer",
             agent_transcript_path="/private/agent/transcript.jsonl",
             last_assistant_message=agent_secret)
        send(env, "Stop", last_assistant_message=answer_secret)

        store = Path(td) / "omarchy/agent-pipeline/requests.json"
        payload = json.loads(store.read_text(encoding="utf-8"))
        row = payload["requests"][0]
        nodes = {node["id"]: node for node in row["nodes"]}
        edges = {(edge["from"], edge["to"]) for edge in row["edges"]}
        check(row["title"] == "Codex turn" and row["agent"] == "codex-cli"
              and row["state"] == "done", "turn row is not correlated as a Codex run")
        check(nodes["tool_01"]["status"] == "warn" and row["metrics"]["toolCalls"] == 2
              and row["metrics"]["toolErrors"] == 1,
              "per-call tool lifecycle or explicit nonzero exit status was not recorded")
        tool_labels = {node["id"]: node.get("label") for node in row["architecture"]["nodes"]}
        arch_nodes = {node["id"]: node for node in row["architecture"]["nodes"]}
        check(nodes["tool_02"]["status"] == "ok" and tool_labels["tool_02"] == "File edit",
              "file-edit tool label was not normalized into a visible workflow node")
        check(arch_nodes["tool_01"]["y"] == arch_nodes["tool_02"]["y"]
              and row["architecture"]["height"] < 200,
              "tool events should use the compact multi-column graph layout")
        check(nodes["subagent_01"]["status"] == "ok" and row["metrics"]["subagentCalls"] == 1,
              "Codex subagent start/return was not recorded as a separate node")
        check({("input", "model"), ("model", "tool_01"), ("tool_01", "model"),
               ("model", "tool_02"), ("tool_02", "model"),
               ("model", "subagent_01"), ("subagent_01", "model"),
               ("model", "output")} <= edges,
              "traversed Codex model/tool/subagent/output edges are incomplete")

        send(env, "UserPromptSubmit", session_id="session-no-tools", turn_id="turn-no-tools",
             prompt="ANOTHER_PRIVATE_PROMPT")
        send(env, "Stop", session_id="session-no-tools", turn_id="turn-no-tools",
             last_assistant_message="PRIVATE_REPLY")
        rows = json.loads(store.read_text(encoding="utf-8"))["requests"]
        no_tool_row = next(item for item in rows if item["agent"] == "codex-cli" and item["id"] != row["id"])
        check("tools" not in {node["id"] for node in no_tool_row["architecture"]["nodes"]},
              "no-tool turn should not display an unused tools node")

        persisted = store.read_text(encoding="utf-8")
        sidecar = Path(td) / "omarchy/agent-pipeline/codex-hook-state"
        persisted += "".join(path.read_text(encoding="utf-8") for path in sidecar.glob("*.json"))
        check(not any(secret in persisted for secret in
                       (prompt_secret, command_secret, output_secret, answer_secret, agent_secret,
                        "/private/workspace", "/private/agent/transcript.jsonl", "PRIVATE_REPLY",
                        "PRIVATE_HTML_CONTENT", "generated.html")),
              "Codex prompt/command/output/workspace data leaked into persisted telemetry")
        for state_file in sidecar.glob("*.json"):
            check(state_file.stat().st_mode & 0o777 == 0o600,
                  "Codex hook sidecar should be owner-only")

    print("PASS: Codex hooks correlate turn/tool activity without persisting prompt or payload data")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
