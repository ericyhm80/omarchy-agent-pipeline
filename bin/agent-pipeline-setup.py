#!/usr/bin/env python3
"""Explicit, local-only setup/teardown for bundled Agent Pipeline reporters.

This helper runs only after a user clicks a connection action in the panel. It
never searches processes, reads transcripts, makes network requests, or captures
agent content. It only inspects and edits the named runtime configuration files.
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import stat
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

PLUGIN_DIR = Path(__file__).resolve().parent.parent
WRITER = PLUGIN_DIR / "bin" / "agent-pipeline"
CODEX_HOOK = PLUGIN_DIR / "bin" / "codex-hook.py"
PI_EXTENSION_SOURCE = PLUGIN_DIR / "examples" / "pi-extension" / "agent-pipeline.ts"
CODEX_EVENTS = (
    "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart",
    "SubagentStop", "Stop", "Interrupt",
)


class SetupError(Exception):
    pass


def _home() -> Path:
    return Path(os.environ.get("HOME") or Path.home()).expanduser()


def _codex_home() -> Path:
    value = os.environ.get("CODEX_HOME")
    return Path(value).expanduser() if value else _home() / ".codex"


def _codex_config() -> Path:
    return _codex_home() / "hooks.json"


def _pi_extension() -> Path:
    return _home() / ".pi" / "agent" / "extensions" / "agent-pipeline.ts"


def _writer_link() -> Path:
    return _home() / ".local" / "bin" / "agent-pipeline"


def _setup_marker() -> Path:
    state_home = Path(os.environ.get("XDG_STATE_HOME") or (_home() / ".local" / "state"))
    return state_home / "omarchy" / "agent-pipeline" / "reporter-setup.json"


def _read_setup_marker() -> dict[str, Any]:
    path = _setup_marker()
    data = _read_json(path)
    return data


def _write_setup_marker(data: dict[str, Any]) -> None:
    path = _setup_marker()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    payload = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp = Path(temp_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    except Exception:
        try:
            temp.unlink()
        except OSError:
            pass
        raise


def _hook_command(event: str) -> str:
    return " ".join((shlex.quote(sys.executable), shlex.quote(str(CODEX_HOOK)),
                     "--event", event))


def _is_our_hook(item: Any, event: str) -> bool:
    if not isinstance(item, dict) or item.get("type") != "command":
        return False
    command = item.get("command")
    if not isinstance(command, str):
        return False
    try:
        expanded = command.replace("${HOME}", str(_home())).replace("$HOME", str(_home()))
        words = shlex.split(expanded)
    except ValueError:
        return False
    if len(words) < 4 or words[-2:] != ["--event", event]:
        return False
    try:
        return Path(words[-3]).resolve() == CODEX_HOOK.resolve()
    except OSError:
        return False


def _read_json(path: Path) -> dict[str, Any]:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise SetupError(f"Cannot inspect {path.name}: {exc.strerror or 'I/O error'}") from exc
    if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
        raise SetupError(f"Refusing to modify non-regular file: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SetupError(f"Cannot safely read {path}: invalid or unreadable JSON") from exc
    if not isinstance(data, dict):
        raise SetupError(f"Cannot safely modify {path}: expected a JSON object")
    return data


def _backup(path: Path) -> None:
    if not path.exists():
        return
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    backup = path.with_name(f"{path.name}.agent-pipeline-{stamp}.bak")
    index = 1
    while backup.exists():
        backup = path.with_name(f"{path.name}.agent-pipeline-{stamp}-{index}.bak")
        index += 1
    source_fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        backup_fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                            | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except Exception:
        os.close(source_fd)
        raise
    try:
        with os.fdopen(source_fd, "rb") as source, os.fdopen(backup_fd, "wb") as target:
            shutil.copyfileobj(source, target)
            target.flush()
            os.fsync(target.fileno())
    except Exception:
        try:
            backup.unlink()
        except OSError:
            pass
        raise


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    _backup(path)
    payload = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp = Path(temp_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        path.chmod(0o600)
    except Exception:
        try:
            temp.unlink()
        except OSError:
            pass
        raise


def _codex_hook_events(data: dict[str, Any]) -> set[str]:
    hooks = data.get("hooks")
    if not isinstance(hooks, dict):
        return set()
    return {
        event for event in CODEX_EVENTS
        if isinstance(hooks.get(event), list) and any(
            isinstance(group, dict) and isinstance(group.get("hooks"), list)
            and any(_is_our_hook(item, event) for item in group["hooks"])
            for group in hooks[event]
        )
    }


def connect_codex() -> dict[str, Any]:
    if not CODEX_HOOK.is_file() or not WRITER.is_file():
        raise SetupError("The bundled Codex reporter or writer is missing")
    path = _codex_config()
    data = _read_json(path)
    hooks = data.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise SetupError("hooks.json has a non-object 'hooks' field; left unchanged")
    added = 0
    for event in CODEX_EVENTS:
        groups = hooks.setdefault(event, [])
        if not isinstance(groups, list):
            raise SetupError(f"hooks.json '{event}' entry is not a list; left unchanged")
        command = _hook_command(event)
        present = any(
            isinstance(group, dict) and isinstance(group.get("hooks"), list)
            and any(_is_our_hook(item, event) for item in group["hooks"])
            for group in groups
        )
        if not present:
            groups.append({"hooks": [{"type": "command", "command": command, "timeout": 3}]})
            added += 1
    if added:
        _write_json(path, data)
    return {"ok": True, "configured": True, "added": added,
            "message": "Hooks configured. Review and trust them in Codex with /hooks."}


def disconnect_codex() -> dict[str, Any]:
    path = _codex_config()
    data = _read_json(path)
    hooks = data.get("hooks")
    if not isinstance(hooks, dict):
        return {"ok": True, "configured": False, "removed": 0,
                "message": "No Agent Pipeline Codex hooks found."}
    removed = 0
    for event in CODEX_EVENTS:
        groups = hooks.get(event)
        if not isinstance(groups, list):
            continue
        kept_groups = []
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                kept_groups.append(group)
                continue
            kept_hooks = []
            for item in group["hooks"]:
                is_ours = _is_our_hook(item, event)
                if is_ours:
                    removed += 1
                else:
                    kept_hooks.append(item)
            if kept_hooks:
                copied = dict(group)
                copied["hooks"] = kept_hooks
                kept_groups.append(copied)
        if kept_groups:
            hooks[event] = kept_groups
        else:
            hooks.pop(event, None)
    if not hooks:
        data.pop("hooks", None)
    if removed:
        _write_json(path, data)
    return {"ok": True, "configured": False, "removed": removed,
            "message": "Only Agent Pipeline Codex hooks were removed."}


def _same_file(path: Path, source: Path) -> bool:
    try:
        return path.is_file() and not path.is_symlink() and path.read_bytes() == source.read_bytes()
    except OSError:
        return False


def _writer_available() -> bool:
    found = shutil.which("agent-pipeline")
    if found:
        try:
            return Path(found).resolve() == WRITER.resolve()
        except OSError:
            return False
    return False


def connect_pi() -> dict[str, Any]:
    if not PI_EXTENSION_SOURCE.is_file() or not WRITER.is_file():
        raise SetupError("The bundled Pi reporter or writer is missing")
    extension = _pi_extension()
    link = _writer_link()
    marker = _read_setup_marker()
    extension.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    link.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    if extension.is_symlink() or (extension.exists() and not _same_file(extension, PI_EXTENSION_SOURCE)):
        raise SetupError(f"Refusing to overwrite existing Pi extension: {extension}")
    if ((link.exists() or link.is_symlink())
            and (not link.is_symlink() or link.resolve() != WRITER.resolve())
            and not _writer_available()):
        raise SetupError(f"Refusing to replace existing command: {link}")
    created_extension = False
    created_link = False
    try:
        if not extension.exists():
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(extension, flags, 0o600)
            created_extension = True
            with os.fdopen(fd, "wb") as stream:
                stream.write(PI_EXTENSION_SOURCE.read_bytes())
                stream.flush()
                os.fsync(stream.fileno())
        if not link.exists() and not link.is_symlink() and not _writer_available():
            link.symlink_to(WRITER.resolve())
            created_link = True
            marker["piCliLinkTarget"] = str(WRITER.resolve())
            _write_setup_marker(marker)
    except OSError:
        if created_link:
            try:
                if link.is_symlink() and link.resolve() == WRITER.resolve():
                    link.unlink()
            except OSError:
                pass
        if created_extension:
            try:
                if _same_file(extension, PI_EXTENSION_SOURCE):
                    extension.unlink()
            except OSError:
                pass
        raise
    return {"ok": True, "configured": True,
            "message": "Pi reporter installed. Restart or reload Pi to activate it."}


def disconnect_pi() -> dict[str, Any]:
    extension = _pi_extension()
    link = _writer_link()
    marker = _read_setup_marker()
    removed = []
    if not extension.is_symlink() and _same_file(extension, PI_EXTENSION_SOURCE):
        extension.unlink()
        removed.append("Pi extension")
    if (marker.get("piCliLinkTarget") == str(WRITER.resolve())
            and link.is_symlink() and link.resolve() == WRITER.resolve()):
        link.unlink()
        marker.pop("piCliLinkTarget", None)
        if marker:
            _write_setup_marker(marker)
        else:
            try:
                _setup_marker().unlink()
            except FileNotFoundError:
                pass
        removed.append("CLI link")
    return {"ok": True, "configured": False, "removed": removed,
            "message": "Only unchanged Agent Pipeline Pi files were removed."}


def status() -> dict[str, Any]:
    try:
        codex_data = _read_json(_codex_config())
        codex_events = _codex_hook_events(codex_data)
        codex_configured = len(codex_events) == len(CODEX_EVENTS)
    except SetupError:
        codex_events = set()
        codex_configured = False
    pi_extension = _same_file(_pi_extension(), PI_EXTENSION_SOURCE)
    link = _writer_link()
    try:
        writer_linked = link.is_symlink() and link.resolve() == WRITER.resolve()
    except OSError:
        writer_linked = False
    pi_ready = pi_extension and (writer_linked or _writer_available())
    return {"ok": True, "codex": bool(codex_events), "codexComplete": codex_configured,
            "codexHookEvents": len(codex_events), "pi": pi_ready,
            "piExtension": pi_extension, "writerAvailable": writer_linked or _writer_available(),
            "message": "Status checks inspect only known reporter config files."}


def main(argv: list[str]) -> int:
    try:
        if argv == ["status"]:
            result = status()
        elif argv == ["connect", "codex"]:
            result = connect_codex()
        elif argv == ["disconnect", "codex"]:
            result = disconnect_codex()
        elif argv == ["connect", "pi"]:
            result = connect_pi()
        elif argv == ["disconnect", "pi"]:
            result = disconnect_pi()
        else:
            result = {"ok": False, "message": "Usage: agent-pipeline-setup.py status|connect|disconnect {codex|pi}"}
    except (OSError, SetupError) as exc:
        result = {"ok": False, "message": str(exc) or "Connection setup failed safely."}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
