#!/usr/bin/env python3
"""Privacy-minimal Codex CLI hook reporter for agent-pipeline.

Persists hashed session/turn identifiers, safe model/tool/agent labels, timings,
and lifecycle outcomes only. Prompts, reasoning, tool arguments, transcripts,
workspace paths, and tool output are never written.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

MAX_EVENT_BYTES = 8 * 1024 * 1024
MAX_VISIBLE_TOOLS = 8
MAX_VISIBLE_SUBAGENTS = 4
TOOL_NAME_RE = re.compile(r"[^A-Za-z0-9_.:-]")
DISPLAY_LABEL_RE = re.compile(r"[^A-Za-z0-9_.: -]")
MODEL_RE = re.compile(r"[^A-Za-z0-9_.:/-]")


def safe_label(value: Any, pattern: re.Pattern[str], limit: int, fallback: str) -> str:
    text = pattern.sub("", str(value or ""))[:limit]
    return text or fallback


def request_id(event: dict[str, Any]) -> str:
    session_id = event.get("session_id")
    turn_id = event.get("turn_id")
    if not isinstance(session_id, str) or not isinstance(turn_id, str) or not session_id or not turn_id:
        return ""
    digest = hashlib.sha256(f"{session_id}\0{turn_id}".encode("utf-8")).hexdigest()[:24]
    return f"codex-{digest}"


def hashed_id(value: Any) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()[:20]


def state_dir() -> Path:
    root = Path(os.environ.get("XDG_STATE_HOME") or (Path.home() / ".local/state"))
    path = root / "omarchy/agent-pipeline/codex-hook-state"
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.chmod(0o700)
    except OSError:
        pass
    cutoff = time.time() - 14 * 24 * 60 * 60
    for stale in path.glob("codex-*.json"):
        try:
            if stale.stat().st_mtime < cutoff:
                stale.unlink()
        except OSError:
            pass
    return path


@contextmanager
def locked_state(rid: str, *, reset: bool = False) -> Iterator[dict[str, Any]]:
    path = state_dir() / f"{rid}.json"
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "r+", encoding="utf-8") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            if reset:
                state: dict[str, Any] = {}
            else:
                fh.seek(0)
                try:
                    state = json.loads(fh.read() or "{}")
                except (json.JSONDecodeError, OSError):
                    state = {}
                if not isinstance(state, dict):
                    state = {}
            state.setdefault("startedAt", time.time())
            state.setdefault("toolStarts", 0)
            state.setdefault("toolCalls", 0)
            state.setdefault("toolErrors", 0)
            state.setdefault("toolReturns", 0)
            state.setdefault("toolNodes", [])
            state.setdefault("activeTools", {})
            state.setdefault("subagentStarts", 0)
            state.setdefault("subagentCalls", 0)
            state.setdefault("subagentNodes", [])
            state.setdefault("activeSubagents", {})
            state.setdefault("activitySeq", 0)
            state.setdefault("model", "")
            yield state
            fh.seek(0)
            fh.truncate()
            fh.write(json.dumps(state, separators=(",", ":")))
            fh.flush()
            os.fsync(fh.fileno())
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _pipeline_bin() -> str | None:
    configured = os.environ.get("AGENT_PIPELINE_BIN")
    if configured:
        return configured
    found = shutil.which("agent-pipeline")
    if found:
        return found
    sibling = Path(__file__).resolve().with_name("agent-pipeline")
    return str(sibling) if sibling.is_file() else None


def emit(*args: str, timeout: float = 1.5) -> bool:
    binary = _pipeline_bin()
    if not binary:
        return False
    try:
        result = subprocess.run(
            [binary, *args], stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=timeout, check=False,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError, ValueError):
        return False


def _list_of_dicts(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def architecture(tool_nodes: list[dict[str, Any]],
                 subagent_nodes: list[dict[str, Any]]) -> dict[str, Any]:
    nodes = [
        {"id": "input", "label": "Input", "x": 4, "y": 96, "w": 82, "h": 42},
        {"id": "model", "label": "Codex", "labelEn": "Codex turn", "x": 136, "y": 96, "w": 112, "h": 42},
        {"id": "output", "label": "Output", "x": 608, "y": 96, "w": 82, "h": 42},
    ]
    edges = [{"from": "input", "to": "model"}, {"from": "model", "to": "output"}]
    activity = ([{"kind": "tool", **item} for item in tool_nodes]
                + [{"kind": "agent", **item} for item in subagent_nodes])
    activity.sort(key=lambda item: int(item.get("seq", 0) or 0))
    for index, item in enumerate(activity):
        node_id = safe_label(item.get("id"), TOOL_NAME_RE, 48, f"activity_{index + 1:02d}")
        is_agent = item.get("kind") == "agent"
        name = safe_label(item.get("name"), DISPLAY_LABEL_RE, 48, "Agent" if is_agent else "Tool")
        if node_id == "tools_more":
            label = "More tools"
        elif node_id == "subagents_more":
            label = "More agents"
        else:
            label = f"Agent: {name}" if is_agent else name
        node_w = 116 if is_agent else 104
        x = 292 + (index % 2) * 156
        y = 24 + (index // 2) * 56
        nodes.append({"id": node_id, "label": label,
                      "labelEn": "Codex subagent" if is_agent else "Codex tool call",
                      "x": x, "y": y, "w": node_w, "h": 42})
        edges.append({"from": "model", "to": node_id})
        if int(item.get("returns", 0) or 0) > 0:
            edges.append({"from": node_id, "to": "model", "label": "result"})
    activity_rows = max(1, (len(activity) + 1) // 2)
    return {"width": 700, "height": max(160, 52 + activity_rows * 56),
            "nodes": nodes, "edges": edges}


def _patch(rid: str, **fields: Any) -> None:
    emit("patch", json.dumps({"id": rid, **fields}, ensure_ascii=False, separators=(",", ":")))


def _node(rid: str, node_id: str, status: str, detail: str, ms: int = 0) -> None:
    emit("node", "--id", rid, "--node", node_id, "--status", status,
         "--detail", detail[:160], "--ms", str(max(0, int(ms))))


def _tool_label(name: str) -> str:
    normalized = re.sub(r"[^a-z0-9]", "", name.lower())
    if normalized in {"bash", "execcommand"}:
        return "Shell"
    if normalized in {"applypatch", "edit", "write", "fileedit", "editfile", "writefile", "createfile"}:
        return "File edit"
    if normalized in {"updateplan", "planupdate"}:
        return "Plan"
    if normalized in {"agent", "spawnagent"}:
        return "Agent tool"
    if normalized.startswith("mcp"):
        return "MCP"
    if normalized == "webrun":
        return "Web run"
    return name[:48] or "Tool"


def _find_node(items: list[dict[str, Any]], node_id: str) -> dict[str, Any] | None:
    return next((item for item in items if item.get("id") == node_id), None)


def _allocate_tool_node(state: dict[str, Any], tool_name: str) -> dict[str, Any]:
    nodes = _list_of_dicts(state.get("toolNodes"))
    start_number = int(state.get("toolStarts", 0))
    if start_number <= MAX_VISIBLE_TOOLS:
        node_id = f"tool_{start_number:02d}"
    else:
        node_id = "tools_more"
    entry = _find_node(nodes, node_id)
    if entry is None:
        entry = {"id": node_id, "name": _tool_label(tool_name), "calls": 0,
                 "returns": 0, "active": 0, "status": "running", "startedAt": time.monotonic()}
        nodes.append(entry)
    entry["calls"] = int(entry.get("calls", 0)) + 1
    entry["active"] = int(entry.get("active", 0)) + 1
    entry["status"] = "running"
    state["toolNodes"] = nodes
    return entry


def _allocate_subagent_node(state: dict[str, Any], agent_type: str) -> dict[str, Any]:
    nodes = _list_of_dicts(state.get("subagentNodes"))
    start_number = int(state.get("subagentStarts", 0))
    node_id = f"subagent_{start_number:02d}" if start_number <= MAX_VISIBLE_SUBAGENTS else "subagents_more"
    entry = _find_node(nodes, node_id)
    if entry is None:
        entry = {"id": node_id, "name": safe_label(agent_type, TOOL_NAME_RE, 48, "Agent"),
                 "calls": 0, "returns": 0, "active": 0, "status": "running"}
        nodes.append(entry)
    entry["calls"] = int(entry.get("calls", 0)) + 1
    entry["active"] = int(entry.get("active", 0)) + 1
    entry["status"] = "running"
    state["subagentNodes"] = nodes
    return entry


def _write_architecture(rid: str, state: dict[str, Any], metrics: dict[str, int] | None = None) -> None:
    patch: dict[str, Any] = {
        "architecture": architecture(_list_of_dicts(state.get("toolNodes")),
                                      _list_of_dicts(state.get("subagentNodes")))
    }
    if metrics is not None:
        patch["metrics"] = metrics
    _patch(rid, **patch)


def begin(event: dict[str, Any], rid: str) -> None:
    model = safe_label(event.get("model"), MODEL_RE, 72, "")
    with locked_state(rid, reset=True) as state:
        state.update({"startedAt": time.time(), "model": model, "toolStarts": 0,
                      "toolCalls": 0, "toolErrors": 0, "toolReturns": 0,
                      "toolNodes": [], "activeTools": {}, "subagentStarts": 0,
                      "subagentCalls": 0, "subagentNodes": [], "activeSubagents": {},
                      "activitySeq": 0})
    args = ["start", "--id", rid, "--title", "Codex turn", "--agent", "codex-cli",
            "--task-class", "codex", "--route", "native"]
    if model:
        args.extend(("--model", model))
    emit(*args)
    _patch(rid, architecture=architecture([], []))
    _node(rid, "input", "ok", "Codex turn received")
    _node(rid, "model", "running", f"Codex · {model}" if model else "Codex turn running")


def tool_start(event: dict[str, Any], rid: str) -> None:
    tool_name = safe_label(event.get("tool_name"), TOOL_NAME_RE, 48, "Tool")
    call_id = event.get("tool_use_id")
    call_key = hashed_id(call_id) if call_id else f"missing-{time.time_ns()}"
    with locked_state(rid) as state:
        state["toolStarts"] = int(state.get("toolStarts", 0)) + 1
        state["activitySeq"] = int(state.get("activitySeq", 0)) + 1
        entry = _allocate_tool_node(state, tool_name)
        entry.setdefault("seq", int(state["activitySeq"]))
        active = state.get("activeTools") if isinstance(state.get("activeTools"), dict) else {}
        active[call_key] = {"nodeId": entry["id"], "name": _tool_label(tool_name),
                            "startedAt": time.monotonic()}
        state["activeTools"] = active
        node_id = entry["id"]
        node_name = entry["name"]
        tool_nodes = _list_of_dicts(state.get("toolNodes"))
        subagent_nodes = _list_of_dicts(state.get("subagentNodes"))
    _patch(rid, architecture=architecture(tool_nodes, subagent_nodes))
    extra = f" ×{entry['calls']}" if node_id == "tools_more" else ""
    _node(rid, node_id, "running", f"{node_name} running{extra}")


def _tool_outcome(event: dict[str, Any]) -> bool | None:
    """Read only explicit scalar outcome metadata, never command/output text."""
    response = event.get("tool_response")
    if not isinstance(response, dict):
        return None
    for key in ("exit_code", "exitCode", "returncode", "return_code"):
        value = response.get(key)
        if type(value) is int:
            return value == 0
    for key in ("is_error", "isError", "failed"):
        value = response.get(key)
        if type(value) is bool:
            return not value
    value = response.get("status")
    if isinstance(value, str):
        lowered = value.lower()
        if lowered in {"ok", "success", "completed"}:
            return True
        if lowered in {"error", "failed", "failure"}:
            return False
    return None


def tool_end(event: dict[str, Any], rid: str) -> None:
    tool_name = safe_label(event.get("tool_name"), TOOL_NAME_RE, 48, "Tool")
    call_id = event.get("tool_use_id")
    outcome = _tool_outcome(event)
    with locked_state(rid) as state:
        active = state.get("activeTools") if isinstance(state.get("activeTools"), dict) else {}
        call_key = hashed_id(call_id) if call_id else ""
        started = active.pop(call_key, None) if call_key else None
        if started is None and not call_key:
            match = next(((key, value) for key, value in active.items()
                          if isinstance(value, dict) and value.get("name") == _tool_label(tool_name)), None)
            if match:
                call_key, started = match
                active.pop(call_key, None)
        if isinstance(started, dict):
            tool_name = _tool_label(str(started.get("name") or _tool_label(tool_name)))
            node_id = safe_label(started.get("nodeId"), TOOL_NAME_RE, 48, "")
        else:
            state["toolStarts"] = int(state.get("toolStarts", 0)) + 1
            state["activitySeq"] = int(state.get("activitySeq", 0)) + 1
            entry = _allocate_tool_node(state, tool_name)
            entry.setdefault("seq", int(state["activitySeq"]))
            node_id = entry["id"]
        state["activeTools"] = active
        nodes = _list_of_dicts(state.get("toolNodes"))
        entry = _find_node(nodes, node_id)
        if entry is None:
            entry = _allocate_tool_node(state, tool_name)
            nodes = _list_of_dicts(state.get("toolNodes"))
            entry = _find_node(nodes, entry["id"])
            node_id = str(entry["id"])
        entry["active"] = max(0, int(entry.get("active", 0)) - 1)
        entry["returns"] = int(entry.get("returns", 0)) + 1
        state["toolCalls"] = int(state.get("toolCalls", 0)) + 1
        state["toolReturns"] = int(state.get("toolReturns", 0)) + 1
        if outcome is False:
            state["toolErrors"] = int(state.get("toolErrors", 0)) + 1
        active_for_node = int(entry.get("active", 0))
        entry["status"] = "running" if active_for_node else "warn" if outcome is False else "ok"
        state["toolNodes"] = nodes
        tool_calls = int(state["toolCalls"])
        tool_errors = int(state["toolErrors"])
        tool_nodes = _list_of_dicts(state.get("toolNodes"))
        subagent_nodes = _list_of_dicts(state.get("subagentNodes"))
    _write_architecture(rid, {"toolNodes": tool_nodes, "subagentNodes": subagent_nodes},
                        {"toolCalls": tool_calls, "toolErrors": tool_errors})
    if outcome is False:
        detail = f"{tool_name} failed; output omitted"
        emit("issue", "--id", rid, "--level", "warn", "--node", node_id, "--detail", detail)
        status = "warn"
    elif active_for_node:
        detail = f"{tool_name} finished; call still active"
        status = "running"
    else:
        detail = f"{tool_name} finished" if outcome is True else f"{tool_name} finished; outcome omitted"
        status = "ok"
    elapsed = 0
    if isinstance(started, dict):
        try:
            elapsed = max(0, round((time.monotonic() - float(started.get("startedAt", 0))) * 1000))
        except (TypeError, ValueError, OverflowError):
            pass
    _node(rid, node_id, status, detail, elapsed)


def subagent_start(event: dict[str, Any], rid: str) -> None:
    agent_id = event.get("agent_id")
    if not isinstance(agent_id, str) or not agent_id:
        return
    agent_type = safe_label(event.get("agent_type"), TOOL_NAME_RE, 48, "Agent")
    with locked_state(rid) as state:
        state["subagentStarts"] = int(state.get("subagentStarts", 0)) + 1
        state["activitySeq"] = int(state.get("activitySeq", 0)) + 1
        entry = _allocate_subagent_node(state, agent_type)
        entry.setdefault("seq", int(state["activitySeq"]))
        active = state.get("activeSubagents") if isinstance(state.get("activeSubagents"), dict) else {}
        active[hashed_id(agent_id)] = {"nodeId": entry["id"], "name": entry["name"]}
        state["activeSubagents"] = active
        node_id = str(entry["id"])
        subagent_nodes = _list_of_dicts(state.get("subagentNodes"))
        tool_nodes = _list_of_dicts(state.get("toolNodes"))
    _patch(rid, architecture=architecture(tool_nodes, subagent_nodes))
    _node(rid, node_id, "running", f"Agent {agent_type} started")


def subagent_stop(event: dict[str, Any], rid: str) -> None:
    agent_id = event.get("agent_id")
    if not isinstance(agent_id, str) or not agent_id:
        return
    with locked_state(rid) as state:
        active = state.get("activeSubagents") if isinstance(state.get("activeSubagents"), dict) else {}
        started = active.pop(hashed_id(agent_id), None)
        if not isinstance(started, dict):
            return
        state["activeSubagents"] = active
        node_id = safe_label(started.get("nodeId"), TOOL_NAME_RE, 48, "")
        nodes = _list_of_dicts(state.get("subagentNodes"))
        entry = _find_node(nodes, node_id)
        if entry is None:
            return
        entry["active"] = max(0, int(entry.get("active", 0)) - 1)
        entry["returns"] = int(entry.get("returns", 0)) + 1
        entry["status"] = "running" if int(entry["active"]) else "ok"
        state["subagentNodes"] = nodes
        state["subagentCalls"] = int(state.get("subagentCalls", 0)) + 1
        tool_nodes = _list_of_dicts(state.get("toolNodes"))
        subagent_nodes = _list_of_dicts(state.get("subagentNodes"))
        calls = int(state["subagentCalls"])
    _write_architecture(rid, {"toolNodes": tool_nodes, "subagentNodes": subagent_nodes},
                        {"subagentCalls": calls})
    _node(rid, node_id, "ok", "Agent returned; transcript omitted")


def finish(event: dict[str, Any], rid: str, *, interrupted: bool) -> None:
    with locked_state(rid) as state:
        tool_calls = int(state.get("toolCalls", 0))
        tool_errors = int(state.get("toolErrors", 0))
        subagent_calls = int(state.get("subagentCalls", 0))
        model = safe_label(state.get("model") or event.get("model"), MODEL_RE, 72, "")
        started_at = float(state.get("startedAt", time.time()))
        tool_nodes = _list_of_dicts(state.get("toolNodes"))
        subagent_nodes = _list_of_dicts(state.get("subagentNodes"))
        for node in tool_nodes:
            if int(node.get("active", 0)) > 0:
                node["status"] = "warn"
        for node in subagent_nodes:
            if int(node.get("active", 0)) > 0:
                node["status"] = "warn"
    metrics = {"toolCalls": tool_calls, "toolErrors": tool_errors, "subagentCalls": subagent_calls}
    _write_architecture(rid, {"toolNodes": tool_nodes, "subagentNodes": subagent_nodes}, metrics)
    duration_ms = max(0, round((time.time() - started_at) * 1000))
    _node(rid, "model", "warn" if interrupted else "ok",
          "Codex turn interrupted" if interrupted else "Codex turn complete", duration_ms)
    for node in tool_nodes:
        if int(node.get("active", 0)) > 0:
            _node(rid, str(node["id"]), "warn", "tool outcome incomplete")
    for node in subagent_nodes:
        if int(node.get("active", 0)) > 0:
            _node(rid, str(node["id"]), "warn", "agent outcome incomplete")
    _node(rid, "output", "skipped" if interrupted else "ok",
          "turn interrupted" if interrupted else "assistant response complete")
    end_args = ["end", "--id", rid, "--state", "error" if interrupted else "done",
                "--duration-ms", str(duration_ms), "--metrics-json",
                json.dumps(metrics, separators=(",", ":"))]
    if model:
        end_args.extend(("--model", model))
    emit(*end_args)


def main() -> int:
    event_choices = ("UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart",
                     "SubagentStop", "Stop", "Interrupt")
    parser = argparse.ArgumentParser()
    parser.add_argument("--event", required=True, choices=event_choices)
    args = parser.parse_args()
    output_json = args.event in {"Stop", "Interrupt", "SubagentStop"}
    try:
        raw = sys.stdin.buffer.read(MAX_EVENT_BYTES + 1)
        if len(raw) <= MAX_EVENT_BYTES:
            event = json.loads(raw.decode("utf-8"))
            if isinstance(event, dict) and event.get("hook_event_name") == args.event:
                rid = request_id(event)
                if rid:
                    if args.event == "UserPromptSubmit":
                        begin(event, rid)
                    elif args.event == "PreToolUse":
                        tool_start(event, rid)
                    elif args.event == "PostToolUse":
                        tool_end(event, rid)
                    elif args.event == "SubagentStart":
                        subagent_start(event, rid)
                    elif args.event == "SubagentStop":
                        subagent_stop(event, rid)
                    else:
                        finish(event, rid, interrupted=args.event == "Interrupt")
    except Exception:
        # Telemetry is best-effort and must never block or alter Codex work.
        pass
    if output_json:
        sys.stdout.write("{}\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
