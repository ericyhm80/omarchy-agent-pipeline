#!/usr/bin/env python3
"""Regression test for the agent-pipeline writer (bin/agent-pipeline).

The writer refuses to write outside $XDG_STATE_HOME, so this test points it at a
throwaway directory and never touches real telemetry. Run: python3 tests/test_cli.py
"""
from __future__ import annotations

import hashlib
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
        run("jev-event", "--source", "token-router", "--status", "success", "--model", "jev-1.13.0",
            "--latency-ms", "213.7", "--input-tokens", "566", "--output-tokens", "111",
            "--task-class", "analysis", "--confidence", "0.91", "--agreement", "no",
            "--project-id", "P1", "--cost-usd", "0.000023772", "--price-model", "jev-1.13.0",
            "--input-usd-per-million", "0.042")
        run("jev-event", "--source", "model-router", "--status", "error", "--model", "jev-latest",
            "--latency-ms", "500", "--error-type", "TimeoutError")
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

        request_arch = {"nodes": [{"id": "input"}, {"id": "jev"}, {"id": "router"}],
                        "edges": [{"from": "input", "to": "jev"},
                                  {"from": "jev", "to": "router"}]}
        run("patch", json.dumps({"id": "R4", "architecture": request_arch}))
        run("node", "--id", "R4", "--node", "input", "--status", "ok")
        run("node", "--id", "R4", "--node", "jev", "--status", "running",
            "--detail", "TypeSafe request active")
        rows_after_graph = {r["id"]: r for r in json.loads(store.read_text())["requests"]}
        r4 = rows_after_graph["R4"]
        ok("per-request graph is retained", r4.get("architecture") == request_arch)
        ok("node writer traverses edges from the request-specific graph",
           {tuple((e.get("from"), e.get("to"))) for e in r4.get("edges", [])}
           == {("input", "jev")}, r4.get("edges"))
        ok("live JEV stage is recorded as running without failing the request",
           next(n for n in r4["nodes"] if n["id"] == "jev")["status"] == "running"
           and r4["state"] == "running", r4)

        events = data.get("jevEvents", [])
        ok("JEV call events recorded across call sources", len(events) == 2 and
           {e.get("source") for e in events} == {"token-router", "model-router"}, events)
        ok("JEV event retains outcome and usage metadata", events[0].get("status") == "success" and
           events[0].get("inputTokens") == 566 and events[0].get("outputTokens") == 111 and
           events[0].get("agreement") is False and events[0].get("projectId") == "P1",
           events[0] if events else events)
        ok("JEV event contains no prompt, raw input, key, or state fields", all(
            key.lower() not in {"prompt", "input", "api_key", "apikey", "key", "state"}
            for event in events for key in event), events)
        ok("JEV event records only the supplied, model-versioned cost", events[0].get("costUsd") == 0.000023772
           and events[0].get("priceModel") == "jev-1.13.0" and events[0].get("inputUsdPerMillion") == 0.042
           and "costUsd" not in events[1], events)

        # ---- tool FACTS + the reconcile command that can reconstruct them -----
        def reload() -> dict:
            data_ = json.loads(store.read_text(encoding="utf-8"))
            return {r["id"]: r for r in data_["requests"]}

        run("patch", json.dumps({"id": "R1", "toolLog": [
            {"tool": "bash", "ok": False, "ms": 3}, {"tool": "bash", "ok": True, "ms": 4}]}))
        ok("tool facts appended in order", [e["ok"] for e in reload()["R1"]["toolLog"]] == [False, True],
           reload()["R1"]["toolLog"])
        run("patch", json.dumps({"id": "R1", "toolLog": [{"ok": True}, {"tool": ""}, "nope"],
                                 "toolLogSource": "unit test"}))
        ok("facts without a tool name are dropped, not counted", len(reload()["R1"]["toolLog"]) == 2)
        ok("the provenance of reconstructed facts is stored", reload()["R1"]["toolLogSource"] == "unit test")
        run("patch", json.dumps({"id": "R1", "toolLog": [{"tool": "bash", "ok": True,
                                                              "n": n} for n in range(450)]}))
        capped = reload()["R1"]["toolLog"]
        ok("the fact log is bounded", len(capped) == 400, len(capped))
        ok("the bound keeps the NEWEST facts", capped[-1]["n"] == 449 and capped[0]["n"] == 50, capped[0])

        # a pi session log is independent evidence: build one and reconstruct from it
        import datetime as dt
        epoch_ms = 1790000000000
        started = dt.datetime.fromtimestamp(epoch_ms / 1000, dt.timezone.utc)
        log_path = Path(tmp) / "session.jsonl"
        log_path.write_text("\n".join([
            json.dumps({"type": "session", "version": 3, "id": "s1"}),
            json.dumps({"type": "message", "message": {"role": "user", "content": "hi"}}),
            json.dumps({"type": "message", "message": {"role": "toolResult", "toolName": "bash",
                                                         "isError": True, "timestamp": epoch_ms}}),
            json.dumps({"type": "message", "message": {"role": "toolResult", "toolName": "edit",
                                                         "isError": False, "timestamp": epoch_ms + 5000}}),
            json.dumps({"type": "message", "message": {"role": "toolResult", "toolName": "bash",
                                                         "isError": False, "timestamp": epoch_ms + 11000}}),
            "{not json at all",
        ]), encoding="utf-8")
        run("patch", json.dumps({"id": "R3", "state": "done", "durationMs": 60000,
                                 "signals": [{"dimension": "robustness", "kind": "tool_failure",
                                              "level": "warn", "detail": "tool error in bash"}]}))
        store_data = json.loads(store.read_text(encoding="utf-8"))
        for row in store_data["requests"]:
            if row["id"] == "R3":
                row["at"] = started.isoformat()
        store.write_text(json.dumps(store_data, ensure_ascii=False, indent=2), encoding="utf-8")

        dry = subprocess.run([sys.executable, str(CLI), "reconcile", "--session-log", str(log_path),
                              "--id", "R3", "--json"], env=env, capture_output=True, text=True)
        report = json.loads(dry.stdout)
        row3 = report["rows"][0]
        ok("reconcile reads the session log", report["totalToolResults"] == 3, report["totalToolResults"])
        ok("reconcile derives facts in order", row3["toolResults"] == 3 and row3["failures"] == 1,
           (row3["toolResults"], row3["failures"]))
        ok("reconcile derives the absorption (bash failed once, then succeeded)",
           row3["uncancelled"] == 0, row3["uncancelled"])
        ok("reconcile is a dry run unless asked", row3["action"] == "would-write-facts" and not row3["existingFacts"],
           row3["action"])
        ok("a dry run writes nothing", not reload()["R3"].get("toolLog"), reload()["R3"].get("toolLog"))

        applied = subprocess.run([sys.executable, str(CLI), "reconcile", "--session-log", str(log_path),
                                  "--id", "R3", "--apply", "--json"], env=env, capture_output=True, text=True)
        report = json.loads(applied.stdout)
        ok("--apply writes the facts", report["rows"][0]["action"] == "wrote-facts", report["rows"][0]["action"])
        ok("--apply backs the store up first", bool(report["backup"]) and Path(report["backup"]).exists(),
           report["backup"])
        written = reload()["R3"]
        ok("facts and provenance landed in the store",
           len(written["toolLog"]) == 3 and "reconstructed from session.jsonl" in written["toolLogSource"],
           written.get("toolLogSource"))
        ok("the failure claim is kept as evidence, never rewritten",
           len(written["signals"]) == 1 and written["signals"][0]["kind"] == "tool_failure")

        verify = subprocess.run([sys.executable, str(CLI), "reconcile", "--session-log", str(log_path),
                                 "--id", "R3", "--verify", "--json"], env=env, capture_output=True, text=True)
        ok("verify agrees with the reconstruction it just wrote",
           json.loads(verify.stdout)["rows"][0]["action"] == "verify-match",
           json.loads(verify.stdout)["rows"][0])

        tampered = reload()
        tampered["R3"]["toolLog"][2]["ok"] = False
        store.write_text(json.dumps({"requests": list(tampered.values())}, ensure_ascii=False),
                         encoding="utf-8")
        verify2 = subprocess.run([sys.executable, str(CLI), "reconcile", "--session-log", str(log_path),
                                  "--id", "R3", "--verify", "--json"], env=env, capture_output=True, text=True)
        ok("verify can fail: a tampered fact is caught",
           json.loads(verify2.stdout)["rows"][0]["action"] == "verify-MISMATCH",
           json.loads(verify2.stdout)["rows"][0])

        missing = subprocess.run([sys.executable, str(CLI), "reconcile", "--session-log",
                                  str(Path(tmp) / "nope.jsonl")], env=env, capture_output=True, text=True)
        ok("a missing session log fails loudly instead of guessing", missing.returncode == 1, missing.returncode)

        explicit = subprocess.run([sys.executable, str(CLI), "reconcile", "--session-log", str(log_path),
                                   "--id", "R3", "--dry-run"], env=env, capture_output=True, text=True)
        ok("--dry-run is accepted and writes nothing",
           explicit.returncode == 0 and "dry run" in explicit.stdout and "Wrote facts" not in explicit.stdout,
           explicit.stdout[-120:])
        contra = subprocess.run([sys.executable, str(CLI), "reconcile", "--session-log", str(log_path),
                                 "--id", "R3", "--dry-run", "--apply"], env=env,
                                capture_output=True, text=True)
        ok("contradictory flags are refused, not guessed", contra.returncode == 1, contra.returncode)

        # --- instrument: what the runtime loaded vs what is on disk (0.7.4) -----
        # The test file is the instrument, so its version is ours to change: that is
        # what makes "the process loaded X, the disk has Y" observable instead of a
        # claim. A live agent keeps the code it loaded until it reloads.
        ext = Path(tmp) / "instrument.ts"
        ext.write_text('const EXT_ID = "agent-pipeline";\nconst EXT_VERSION = "9.9.9";\n', encoding="utf-8")
        env_ext = dict(env, PI_AGENT_PIPELINE_EXTENSION=str(ext))

        def run_ext(*args: str):
            return subprocess.run([sys.executable, str(CLI), *args], env=env_ext,
                                  capture_output=True, text=True)

        def store() -> dict:
            return json.loads((Path(tmp) / "omarchy" / "agent-pipeline" / "requests.json").read_text())

        run_ext("patch", json.dumps({"id": "R9", "instrument": {
            "id": "agent-pipeline", "extVersion": "9.9.9",
            "loadedAt": "2026-10-03T03:00:00Z", "pid": 4242}}))
        ins = store().get("instrument") or {}
        ok("the version the runtime loaded is recorded",
           ins.get("extVersion") == "9.9.9" and ins.get("loadedAt") == "2026-10-03T03:00:00Z",
           json.dumps(ins, ensure_ascii=False)[:200])
        ok("the disk side is recorded next to it",
           (ins.get("disk") or {}).get("version") == "9.9.9", ins.get("disk"))
        ok("the disk side is a hash of the real file",
           (ins.get("disk") or {}).get("sha256") == hashlib.sha256(ext.read_bytes()).hexdigest(),
           (ins.get("disk") or {}).get("sha256"))
        ok("the disk side names the path, the mtime and when it was checked",
           all((ins.get("disk") or {}).get(k) for k in ("path", "mtime", "checkedAt")), ins.get("disk"))
        ok("the runtime's report is stamped as seen", bool(ins.get("seenAt")), ins.get("seenAt"))

        # One choke point: any write refreshes the disk side, not just `patch`.
        ext.write_text('const EXT_ID = "agent-pipeline";\nconst EXT_VERSION = "10.0.0";\n', encoding="utf-8")
        run_ext("signal", "--id", "R9", "--dimension", "stability", "--kind", "retry",
                "--level", "warn", "--detail", "502")
        ins = store()["instrument"]
        ok("a later write refreshes the disk side", (ins.get("disk") or {}).get("version") == "10.0.0",
           (ins.get("disk") or {}).get("version"))
        ok("the disk side never overwrites what the process loaded", ins.get("extVersion") == "9.9.9",
           ins.get("extVersion"))
        ok("so the mismatch the panel warns about is observable",
           bool(ins.get("extVersion")) and ins.get("extVersion") != (ins.get("disk") or {}).get("version"),
           ins)

        # Nothing to read: record nothing. An absent instrument is an honest answer;
        # a fabricated version would make the panel claim the scores are current.
        env_gone = dict(env, PI_AGENT_PIPELINE_EXTENSION=str(Path(tmp) / "does-not-exist.ts"))
        subprocess.run([sys.executable, str(CLI), "signal", "--id", "R9", "--dimension", "stability",
                        "--kind", "retry", "--level", "warn", "--detail", "503"],
                       env=env_gone, capture_output=True, text=True)
        ok("a missing extension file records no disk version",
           (store()["instrument"].get("disk")) is None, store()["instrument"].get("disk"))

        bare = Path(tmp) / "no-version.ts"
        bare.write_text("// a file with no EXT_VERSION constant\n", encoding="utf-8")
        env_bare = dict(env, PI_AGENT_PIPELINE_EXTENSION=str(bare))
        subprocess.run([sys.executable, str(CLI), "signal", "--id", "R9", "--dimension", "stability",
                        "--kind", "retry", "--level", "warn", "--detail", "504"],
                       env=env_bare, capture_output=True, text=True)
        ins = store()["instrument"]
        ok("a versionless file yields an empty version, not an invented one",
           (ins.get("disk") or {}).get("version") == "" and ins.get("extVersion") == "9.9.9", ins.get("disk"))

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
