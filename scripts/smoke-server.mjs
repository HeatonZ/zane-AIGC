import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "zane-smoke-"));
const data = path.join(temporary, "data");
const project = path.join(temporary, "project");
await mkdir(project);
let child;
let exited;
let logs = "";

async function bounded(promise, milliseconds = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Smoke timeout\n${logs.slice(-3000)}`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function start() {
  logs = "";
  child = spawn(process.execPath, [path.join(root, "dist-server", "index.js"), "--production"], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", API_HOST: "127.0.0.1", API_PORT: "0", APP_DATA_DIR: data, ZANE_PROJECT_DIR: project, HERMES_HOME: path.join(temporary, "unused-hermes"), COMFYUI_BASE_URL: "http://127.0.0.1:1", ZANE_SHUTDOWN_TIMEOUT_MS: "1000" },
  });
  const processRef = child;
  exited = new Promise((resolve) => processRef.once("exit", resolve));
  const listening = new Promise((resolve, reject) => {
    processRef.on("error", reject);
    processRef.stderr.on("data", (chunk) => { logs += chunk; });
    processRef.stdout.on("data", (chunk) => {
      logs += chunk;
      const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);
      if (match) resolve(match[1]);
    });
    processRef.once("exit", (code) => reject(new Error(`Server exited (${code})\n${logs}`)));
  });
  const base = await bounded(listening);
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await fetch(`${base}/api/ready`, { signal: AbortSignal.timeout(1000) });
    if (response.ok) return base;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server not ready\n${logs}`);
}
async function stop() {
  if (!child) return;
  const processRef = child;
  if (processRef.exitCode === null && processRef.signalCode === null) processRef.kill("SIGTERM");
  try { await bounded(exited, 10000); }
  catch (error) { processRef.kill("SIGKILL"); await exited; throw error; }
  finally { child = undefined; }
}
async function json(base, url, body) {
  const response = await fetch(`${base}${url}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok, `${url}: ${response.status} ${await response.clone().text()}`);
  assert.ok(response.headers.get("x-request-id"));
  return response.json();
}
try {
  let base = await start();
  const page = await fetch(base);
  assert.equal(page.status, 200); assert.match(await page.text(), /<div id="root">/);
  assert.equal((await json(base, "/api/health")).storage, "sqlite");
  assert.equal((await json(base, "/api/workspace")).workspace, null);
  const workspace = { format: "zane-studio.workspace/v1", scenes: [], workflows: {}, optionPresets: [], drafts: [], sceneVersions: {} };
  assert.equal((await json(base, "/api/workspace/initialize", workspace)).workspace.revision, 1);
  const runId = randomUUID();
  const workflow = {
    sceneId: "smoke", name: "本地条件冒烟", inputs: [{ key: "flag", type: "boolean", required: true }],
    steps: [{ id: "condition", name: "条件", kind: "control", outputs: [{ key: "result", type: "boolean" }], control: { type: "condition", match: "all", rules: [{ id: "rule", leftRef: "input.flag", operator: "equals", valueSource: "literal", rightValue: "true", rightRef: "" }] } }],
    outputs: [{ key: "result", type: "boolean", sourceRef: "step.condition.outputs.result" }],
  };
  const submitted = await json(base, "/api/v1/runs", { runId, workflow, inputValues: { flag: true } });
  assert.equal(submitted.status, "queued");
  const stream = await fetch(`${base}/api/v1/runs/${runId}/events`, { signal: AbortSignal.timeout(5000) });
  assert.match(stream.headers.get("content-type"), /text\/event-stream/);
  assert.match(await stream.text(), /"status":"completed"/);
  const run = await json(base, `/api/v1/runs/${runId}`);
  assert.equal(run.status, "completed"); assert.equal(run.outputs[0].value, true);
  assert.ok((await stat(path.join(data, "zane.db"))).size > 0);
  assert.ok((await stat(path.join(project, ".zane", "runs", runId, "outputs", "result.json"))).size > 0);
  assert.ok((await json(base, `/api/v1/runs/${runId}/events/history`)).events.length >= 4);
  await stop();
  base = await start();
  assert.equal((await json(base, "/api/workspace")).workspace.revision, 1);
  assert.equal((await json(base, `/api/v1/runs/${runId}`)).status, "completed");
  assert.equal((await json(base, "/api/v1/runs?limit=1")).runs[0].runId, runId);
  console.log("PASS: compiled server / static UI / workspace / async run / SSE / archive / restart persistence (isolated data, no generation calls)");
} finally {
  await stop();
  const resolved = path.resolve(temporary);
  assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}zane-smoke-`));
  await rm(resolved, { recursive: true, force: true });
}
