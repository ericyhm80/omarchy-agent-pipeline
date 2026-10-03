#!/usr/bin/env python3
"""Offline tests for explicit, privacy-minimal reporter setup actions."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SETUP = ROOT / "bin" / "agent-pipeline-setup.py"
HOOK = ROOT / "bin" / "codex-hook.py"
WRITER = ROOT / "bin" / "agent-pipeline"
PI_SOURCE = ROOT / "examples" / "pi-extension" / "agent-pipeline.ts"
EVENTS = ("UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart",
          "SubagentStop", "Stop", "Interrupt")


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def environment(home: Path, path: Path) -> dict[str, str]:
    path.mkdir(parents=True, exist_ok=True)
    return {**os.environ, "HOME": str(home), "CODEX_HOME": str(home / "codex-home"),
            "XDG_STATE_HOME": str(home / ".local/state"), "PATH": f"{path}:/usr/bin:/bin"}


def invoke(env: dict[str, str], *args: str) -> dict:
    result = subprocess.run([sys.executable, str(SETUP), *args], text=True,
                            capture_output=True, env=env, timeout=10, check=False)
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"setup helper returned invalid JSON: {result.stderr}") from exc
    check((result.returncode == 0) == bool(payload.get("ok")),
          f"exit status should match result: {args}, {payload}")
    return payload


def test_codex_config_is_merged_idempotently_and_reversibly() -> None:
    with tempfile.TemporaryDirectory() as td:
        home = Path(td) / "home"
        home.mkdir()
        env = environment(home, Path(td) / "path")
        config = Path(env["CODEX_HOME"]) / "hooks.json"
        config.parent.mkdir(parents=True)
        original = {"hooks": {"PreToolUse": [{"hooks": [
            {"type": "command", "command": "customer-hook --safe"}
        ]}]}, "customerSetting": {"keep": True}}
        config.write_text(json.dumps(original), encoding="utf-8")
        config.chmod(0o640)

        first = invoke(env, "connect", "codex")
        data = json.loads(config.read_text(encoding="utf-8"))
        check(first.get("added") == len(EVENTS), "all Codex lifecycle events should be installed")
        check(data["customerSetting"] == original["customerSetting"], "unrelated config must survive")
        check(any(item.get("command") == "customer-hook --safe"
                  for group in data["hooks"]["PreToolUse"] for item in group["hooks"]),
              "existing user hook must survive merge")
        for event in EVENTS:
            commands = [item.get("command", "") for group in data["hooks"][event]
                        for item in group.get("hooks", [])]
            check(any(str(HOOK) in command and command.endswith(f"--event {event}")
                      for command in commands), f"{event} hook points to bundled reporter")
        check(config.stat().st_mode & 0o777 == 0o600, "written hooks config must be owner-only")
        backups = list(config.parent.glob("hooks.json.agent-pipeline-*.bak"))
        check(len(backups) == 1 and json.loads(backups[0].read_text()) == original,
              "existing hooks config must be backed up before modification")
        check(backups[0].stat().st_mode & 0o777 == 0o600,
              "config backup must be owner-only even if source mode is broader")
        check(invoke(env, "connect", "codex").get("added") == 0,
              "repeated connect should be idempotent")
        status = invoke(env, "status")
        check(status.get("codex") is True and status.get("codexComplete") is True,
              "status should report all known Codex hooks configured")
        partial_data = json.loads(config.read_text(encoding="utf-8"))
        partial_data["hooks"].pop(EVENTS[-1])
        config.write_text(json.dumps(partial_data), encoding="utf-8")
        partial_status = invoke(env, "status")
        check(partial_status.get("codex") is True and not partial_status.get("codexComplete"),
              "partial Codex setup remains removable from the panel")
        check(invoke(env, "connect", "codex").get("added") == 1,
              "connect completes a partial installation")

        disconnected = invoke(env, "disconnect", "codex")
        data = json.loads(config.read_text(encoding="utf-8"))
        check(disconnected.get("removed") == len(EVENTS), "disconnect removes only our hook entries")
        check(data["customerSetting"] == original["customerSetting"]
              and data["hooks"]["PreToolUse"][0]["hooks"][0]["command"] == "customer-hook --safe",
              "disconnect preserves unrelated hooks and settings")


def test_codex_setup_refuses_malformed_config_without_overwriting() -> None:
    with tempfile.TemporaryDirectory() as td:
        home = Path(td) / "home"
        env = environment(home, Path(td) / "path")
        config = Path(env["CODEX_HOME"]) / "hooks.json"
        config.parent.mkdir(parents=True)
        config.write_text("{broken", encoding="utf-8")
        before = config.read_bytes()
        result = invoke(env, "connect", "codex")
        check(not result["ok"], "malformed config must be rejected")
        check(config.read_bytes() == before, "malformed config must remain unchanged")


def test_pi_setup_installs_only_bundled_files_and_can_disconnect() -> None:
    with tempfile.TemporaryDirectory() as td:
        home = Path(td) / "home"
        env = environment(home, Path(td) / "path")
        result = invoke(env, "connect", "pi")
        extension = home / ".pi/agent/extensions/agent-pipeline.ts"
        writer_link = home / ".local/bin/agent-pipeline"
        check(result["ok"] and extension.read_bytes() == PI_SOURCE.read_bytes(),
              "Pi connect copies the bundled extension verbatim")
        check(writer_link.is_symlink() and writer_link.resolve() == WRITER.resolve(),
              "Pi connect provides the bundled writer without replacing other commands")
        check(invoke(env, "status").get("pi") is True,
              "status recognizes the bundled Pi extension and writer")
        removed = invoke(env, "disconnect", "pi")
        check("Pi extension" in removed["removed"] and "CLI link" in removed["removed"],
              "Pi disconnect removes only matching plugin files")
        check(not extension.exists() and not writer_link.exists(),
              "disconnect removes installed reporter and its writer link")


def test_pi_disconnect_preserves_a_preexisting_writer_link() -> None:
    with tempfile.TemporaryDirectory() as td:
        home = Path(td) / "home"
        env = environment(home, Path(td) / "path")
        extension = home / ".pi/agent/extensions/agent-pipeline.ts"
        writer_link = home / ".local/bin/agent-pipeline"
        extension.parent.mkdir(parents=True)
        writer_link.parent.mkdir(parents=True)
        extension.write_bytes(PI_SOURCE.read_bytes())
        writer_link.symlink_to(WRITER.resolve())
        result = invoke(env, "disconnect", "pi")
        check(result["ok"] and not extension.exists(), "disconnect removes the installed extension")
        check(writer_link.is_symlink() and writer_link.resolve() == WRITER.resolve(),
              "disconnect preserves a pre-existing writer link it did not create")


def test_pi_disconnect_preserves_a_preexisting_extension_symlink() -> None:
    with tempfile.TemporaryDirectory() as td:
        home = Path(td) / "home"
        env = environment(home, Path(td) / "path")
        extension = home / ".pi/agent/extensions/agent-pipeline.ts"
        extension.parent.mkdir(parents=True)
        extension.symlink_to(PI_SOURCE)
        result = invoke(env, "disconnect", "pi")
        check(result["ok"] and extension.is_symlink() and extension.resolve() == PI_SOURCE.resolve(),
              "disconnect never removes an extension symlink it did not install")


def test_pi_setup_never_overwrites_a_customer_extension() -> None:
    with tempfile.TemporaryDirectory() as td:
        home = Path(td) / "home"
        env = environment(home, Path(td) / "path")
        extension = home / ".pi/agent/extensions/agent-pipeline.ts"
        extension.parent.mkdir(parents=True)
        original = b"CUSTOM_PI_EXTENSION_DO_NOT_OVERWRITE\n"
        extension.write_bytes(original)
        result = invoke(env, "connect", "pi")
        check(not result["ok"], "conflicting Pi extension must require manual review")
        check(extension.read_bytes() == original, "customer extension must remain unchanged")
        check(not (home / ".local/bin/agent-pipeline").exists(),
              "failed Pi setup must not leave a partial writer link")


def main() -> int:
    test_codex_config_is_merged_idempotently_and_reversibly()
    test_codex_setup_refuses_malformed_config_without_overwriting()
    test_pi_setup_installs_only_bundled_files_and_can_disconnect()
    test_pi_setup_never_overwrites_a_customer_extension()
    print("PASS: reporter setup is explicit, reversible, idempotent, and preserves user config")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
