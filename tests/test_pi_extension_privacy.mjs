import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const secret = "PROMPT_CONTENT_MUST_NOT_ENTER_TELEMETRY_7a43";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repoRoot, "examples/pi-extension/agent-pipeline.ts");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-pi-privacy-"));
const modulePath = path.join(tempDir, "extension.mjs");
fs.copyFileSync(source, modulePath);
const { default: extension } = await import(pathToFileURL(modulePath).href);
const handlers = new Map();
const patches = [];
const pi = {
  on: (name, callback) => handlers.set(name, callback),
  exec: async (_command, args) => {
    if (args?.[0] === "patch") patches.push(JSON.parse(args[1]));
    return { code: 0, stdout: "", stderr: "" };
  },
};
try {
  extension(pi);
  await handlers.get("before_agent_start")({ prompt: secret }, { model: { id: "safe-model" } });
  await handlers.get("agent_settled")();
  const persisted = JSON.stringify(patches);
  if (persisted.includes(secret)) throw new Error("prompt content leaked into the reporter payload");
  const initial = patches.find((patch) => patch.title !== undefined);
  if (initial?.title !== "Pi turn") throw new Error("Pi request title must be generic and prompt-free");
  console.log("PASS: Pi reporter records no prompt text or prompt-derived title");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
