#!/usr/bin/env python3
"""Regression test for the agent-pipeline writer (bin/agent-pipeline).

The writer refuses to write outside $XDG_STATE_HOME, so this test points it at a
throwaway directory and never touches real telemetry. Run: python3 tests/test_cli.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLI = HERE.parent / "bin" / "agent-pipeline"

passed = 0
failed = 0


def ok(name: str, cond: bool, extra: object = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print("  \u2713", name)
    else:
        failed += 1
        print("  \u2717", name, extra)


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        env = dict(os.environ, XDG_STATE_HOME=tmp)

        def run(*args: str) -> int:
            return subprocess.run([sys.executable, str(CLI), *args], env=env,
                                  capture_output=True, text=True).returncode

        run("start", "--id", "R1", "--title", "review", "--agent", "pi-cli")
        run("signal", "--id", "R1", "--dimension", "stability", "--kind", "retry", "--level", "warn", "--detail", "502")
        run("signal", "--id", "R1", "--dimension", "security", "--kind", "human_gate_bypass",
            "--level", "error", "--detail", "no sign-off", "--weight", "35")
        run("patch", json.dumps({
            "id": "R1",
            "metrics": {"toolCalls": 5, "apiCalls": 3},
            "env": {"provider": "z.ai", "sandbox": True},
            "signals": [{"dimension": "robustness", "kind": "fallback_used", "level": "info", "detail": "glm"}],
        }))
        run("end", "--id", "R1", "--state", "done", "--duration-ms", "8200",
            "--tokens-json", '{"input":1200,"output":90,"cacheRead":4000,"costUsd":0.002}',
            "--metrics-json", '{"retries":1}', "--env-json", '{"region":"cn"}')
        # signal on an unknown id must create the request, not crash
        run("signal", "--id", "R2", "--dimension", "security", "--kind", "no_risk_detected", "--level", "info")
        # a bad patch must be swallowed, never raise
        run("patch", "not json")

        store = Path(tmp) / "omarchy" / "agent-pipeline" / "requests.json"
        ok("store written", store.exists())
        data = json.loads(store.read_text(encoding="utf-8"))
        rows = {r["id"]: r for r in data["requests"]}
        ok("two requests recorded", set(rows) == {"R1", "R2"}, list(rows))
        r1 = rows["R1"]
        ok("metrics merged across patch and end", r1["metrics"] == {"toolCalls": 5, "apiCalls": 3, "retries": 1}, r1["metrics"])
        ok("env merged across patch and end", r1["env"] == {"provider": "z.ai", "sandbox": True, "region": "cn"}, r1["env"])
        ok("three signals recorded", len(r1["signals"]) == 3, r1["signals"])
        ok("signal weight kept", any(s.get("weight") == 35 for s in r1["signals"]))
        ok("state and duration set", r1["state"] == "done" and r1["durationMs"] == 8200.0, (r1["state"], r1.get("durationMs")))
        ok("unknown id auto-created", "signals" in rows["R2"] and len(rows["R2"]["signals"]) == 1)
        ok("no leftover temp file", not (store.parent / "requests.tmp").exists())

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
