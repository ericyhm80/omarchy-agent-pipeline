#!/usr/bin/env bash
# Run every agent-pipeline test. Needs python3 (writer) and node (scoring engine).
set -euo pipefail
cd "$(dirname "$0")"
echo "== Model.js — health scoring =="
node test_model.mjs
echo
echo "== bin/agent-pipeline — writer =="
python3 test_cli.py
echo
echo "all agent-pipeline tests passed"
