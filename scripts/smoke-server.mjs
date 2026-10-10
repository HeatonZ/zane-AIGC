import "./smoke-auth.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, writeFile, unlink } from "node:fs/promises";
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
  const catalog = await json(base, "/api/v1/capabilities");
  assert.equal(catalog.schemaVersion, 1);
  const template = catalog.capabilities.find((item) => item.id === "core.code");
  assert.equal(template.version, "1"); assert.equal(template.usage.compatibilityOnly, undefined);
  assert.ok(!("execute" in template));
  // 已退役的低频执行方式仍注册可执行（兼容旧发布快照），但不再作为新步骤候选。
  for (const id of ["text.template", "media.select_references", "media.image_layout", "core.manual"]) {
    assert.equal(catalog.capabilities.find((item) => item.id === id).usage.compatibilityOnly, true, id);
  }
  const capabilityRunId = randomUUID();
  const capabilityWorkflow = {
    sceneId: "capability-smoke", name: "能力包与局部重做冒烟", inputs: [{ key: "text", type: "text", required: true }],
    steps: [
      { id: "draft", name: "原文", kind: "capability", capabilityId: "core.code", capabilityVersion: "1", capabilityConfig: { code: 'return { text: "原文：" + (inputs.text ?? "") };', timeoutMs: 5000 }, inputs: [{ key: "text", sourceRef: "input.text" }], outputs: [{ key: "text", type: "text" }] },
      { id: "publish", name: "发布文案", kind: "capability", capabilityId: "core.code", capabilityVersion: "1", capabilityConfig: { code: 'return { text: "发布：" + (inputs.text ?? "") };', timeoutMs: 5000 }, inputs: [{ key: "text", sourceRef: "step.draft.outputs.text" }], outputs: [{ key: "text", type: "text" }] },
      { id: "independent", name: "独立分支", kind: "capability", capabilityId: "core.code", capabilityVersion: "1", capabilityConfig: { code: 'return { text: "不变" };', timeoutMs: 5000 }, inputs: [], outputs: [{ key: "text", type: "text" }] },
    ],
    outputs: [{ key: "result", type: "text", sourceRef: "step.publish.outputs.text" }],
  };
  await json(base, "/api/v1/runs", { runId: capabilityRunId, workflow: capabilityWorkflow, inputValues: { text: "样例" } });
  const sourceStream = await fetch(base + "/api/v1/runs/" + capabilityRunId + "/events", { signal: AbortSignal.timeout(5000) });
  assert.match(await sourceStream.text(), /"status":"completed"/);
  const source = await json(base, "/api/v1/runs/" + capabilityRunId);
  assert.equal(source.outputs[0].value, "发布：原文：样例");
  assert.equal(source.workflow.steps[0].capabilityVersion, "1");
  const changes = { outputOverrides: [{ stepId: "draft", outputs: { text: "手动修订" } }] };
  const preview = await json(base, "/api/v1/runs/" + capabilityRunId + "/rerun/preview", { changes });
  assert.deepEqual(preview.steps.map((step) => step.action), ["replace", "run", "reuse"]);
  assert.equal((await json(base, "/api/v1/runs")).runs.length, 2, "preview must not create a run");
  const revisionId = randomUUID();
  const revisionSubmission = await json(base, "/api/v1/runs/" + capabilityRunId + "/rerun", { runId: revisionId, changes });
  assert.equal(revisionSubmission.status, "queued");
  const revisionStream = await fetch(base + "/api/v1/runs/" + revisionId + "/events", { signal: AbortSignal.timeout(5000) });
  assert.match(await revisionStream.text(), /"status":"completed"/);
  const revision = await json(base, "/api/v1/runs/" + revisionId);
  assert.equal(revision.outputs[0].value, "发布：手动修订");
  assert.equal(revision.rerunFromRunId, capabilityRunId);
  assert.equal(revision.steps[0].replaced, true);
  assert.equal(revision.steps[2].reusedFromRunId, capabilityRunId);
  assert.deepEqual(await json(base, "/api/v1/runs/" + capabilityRunId), source);
  // A local replacement is copied before 202; its preview does not depend on
  // the original file or a running ComfyUI instance.
  const replacementFile = path.join(temporary, "selected-image.png");
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1EAAAAASUVORK5CYII=", "base64");
  await writeFile(replacementFile, imageBytes);
  const mediaWorkflow = {
    sceneId: "media-smoke", name: "本地图片替换", inputs: [],
    steps: [{ id: "media", name: "图片", kind: "manual", inputs: [{ key: "images", valueSource: "literal", literalType: "image_list", literalValue: JSON.stringify([replacementFile]) }], outputs: [{ key: "images", type: "image_list" }] }],
    outputs: [{ key: "images", type: "image_list", sourceRef: "step.media.outputs.images" }],
  };
  const mediaSource = await json(base, "/api/v1/runs", { workflow: mediaWorkflow, inputValues: {} });
  const mediaSourceStream = await fetch(base + "/api/v1/runs/" + mediaSource.runId + "/events", { signal: AbortSignal.timeout(5000) });
  assert.match(await mediaSourceStream.text(), /"status":"completed"/);
  const mediaRevision = await json(base, "/api/v1/runs/" + mediaSource.runId + "/rerun", { changes: { outputOverrides: [{ stepId: "media", outputs: { images: [replacementFile] } }] } });
  await unlink(replacementFile);
  const mediaRevisionStream = await fetch(base + "/api/v1/runs/" + mediaRevision.runId + "/events", { signal: AbortSignal.timeout(5000) });
  assert.match(await mediaRevisionStream.text(), /"status":"completed"/);
  const mediaResult = await json(base, "/api/v1/runs/" + mediaRevision.runId);
  const storedMedia = mediaResult.outputs[0].value[0];
  assert.ok(storedMedia.startsWith(mediaResult.artifacts.directory));
  const mediaRoute = "/api/v1/runs/" + mediaRevision.runId + "/media/" + encodeURIComponent(path.basename(storedMedia));
  const mediaResponse = await fetch(base + mediaRoute);
  assert.equal(mediaResponse.status, 200); assert.deepEqual(Buffer.from(await mediaResponse.arrayBuffer()), imageBytes);
  await stop();
  base = await start();
  assert.equal((await json(base, "/api/workspace")).workspace.revision, 1);
  assert.equal((await json(base, `/api/v1/runs/${runId}`)).status, "completed");
  assert.equal((await json(base, "/api/v1/runs?limit=1")).runs[0].runId, mediaRevision.runId);
  assert.deepEqual(await json(base, "/api/v1/runs/" + capabilityRunId), source);
  assert.deepEqual(await json(base, "/api/v1/runs/" + revisionId), revision);
  assert.deepEqual(Buffer.from(await (await fetch(base + mediaRoute)).arrayBuffer()), imageBytes);
  console.log("PASS: compiled server / static UI / workspace / capability discovery & execution / revision preview & selective rerun / local replacement media / SSE / archive / restart persistence (isolated data, no generation calls)");
} finally {
  await stop();
  const resolved = path.resolve(temporary);
  assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}zane-smoke-`));
  await rm(resolved, { recursive: true, force: true });
}
