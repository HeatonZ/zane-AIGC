import "./smoke-auth.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Real compiled app, isolated data, loopback-only fake Hermes; never calls a paid provider.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "zane-feedback-smoke-"));
const project = path.join(temporary, "project");
await mkdir(project);
const prompts = [];
const outputs = new Map();
const mock = createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  try {
    assert.equal(request.headers.authorization, "Bearer smoke-only");
    if (request.method === "POST" && request.url === "/v1/runs") {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); const content = body.input[0].content;
      assert.equal(typeof content, "string"); prompts.push(content);
      const runId = randomUUID(); const value = "模拟结果-" + prompts.length;
      outputs.set(runId, JSON.stringify({ value }));
      response.end(JSON.stringify({ run_id: runId, status: "queued" })); return;
    }
    const runId = /^\/v1\/runs\/([^/]+)$/.exec(request.url)?.[1];
    if (request.method === "GET" && outputs.has(runId)) { response.end(JSON.stringify({ run_id: runId, status: "completed", output: outputs.get(runId) })); return; }
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "hermes-agent" }] })); return; }
    response.statusCode = 404; response.end(JSON.stringify({ error: "unexpected mock endpoint" }));
  } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); }
});
await new Promise(resolve => mock.listen(0, "127.0.0.1", resolve));
const mockBase = "http://127.0.0.1:" + mock.address().port;
let child, exited, logs = "";
async function start() {
  logs = "";
  child = spawn(process.execPath, [path.join(root, "dist-server/index.js"), "--production"], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", API_HOST: "127.0.0.1", API_PORT: "0", APP_DATA_DIR: path.join(temporary, "data"), ZANE_PROJECT_DIR: project, HERMES_HOME: path.join(temporary, "unused-hermes"), HERMES_API_BASE_URL: mockBase, HERMES_API_KEY: "smoke-only", HERMES_RETRY_ATTEMPTS: "0", COMFYUI_BASE_URL: "http://127.0.0.1:1", ZANE_SHUTDOWN_TIMEOUT_MS: "1000" },
  });
  exited = new Promise(resolve => child.once("exit", resolve));
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("App startup timed out: " + logs)), 15_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error("App exited " + code + ": " + logs)); });
    child.stderr.on("data", chunk => { logs += chunk; });
    child.stdout.on("data", chunk => {
      logs += chunk;
      const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
}
async function stop() {
  if (child?.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited; clearTimeout(timeout);
  }
}
let base;
async function json(route, body) {
  const response = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
}
async function wait(runId, expected = "completed") {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await json("/api/v1/runs/" + runId);
    if (!["queued", "running", "cancelling"].includes(result.status)) { assert.equal(result.status, expected, JSON.stringify(result)); return result; }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error("Run timed out: " + logs);
}
const textOutput = [{ key: "value", type: "text" }];
const writer = { id: "writer", name: "Hermes编剧", kind: "hermes", hermesProfile: "default", promptTemplate: "写一个简短故事，保留人物设定。", inputs: [], outputs: textOutput };
const literal = id => ({ id, name: id, kind: "manual", inputs: [{ key: "value", valueSource: "literal", literalType: "text", literalValue: id }], outputs: textOutput });
const definition = { sceneId: "feedback-smoke", name: "反馈链路", inputs: [], steps: [literal("prefix"), writer, { id: "tail", name: "后续", kind: "manual", inputs: [{ key: "value", sourceRef: "step.writer.outputs.value" }], outputs: textOutput }, literal("independent")], outputs: [{ key: "result", type: "text", sourceRef: "step.tail.outputs.value" }] };
try {
  base = await start();
  const first = await json("/api/v1/runs", { runId: randomUUID(), workflow: definition, inputValues: {} });
  const original = await wait(first.runId); const before = structuredClone(original);
  assert.equal(original.steps[1].agentPrompt, prompts[0]);
  const changes = { feedback: [{ stepId: "writer", message: "前2秒加入冲突，不要长铺垫" }] };
  const plan = await json("/api/v1/runs/" + original.runId + "/rerun/preview", { changes });
  assert.deepEqual(plan.steps.map(step => step.action), ["reuse", "run", "run", "reuse"]); assert.equal(prompts.length, 1);
  const accepted = await json("/api/v1/runs/" + original.runId + "/rerun", { runId: randomUUID(), changes });
  const revised = await wait(accepted.runId);
  assert.equal(prompts.length, 2); assert.match(prompts[1], /前2秒加入冲突/); assert.match(prompts[1], /模拟结果-1/);
  assert.equal(revised.steps[1].agentPrompt, prompts[1]);
  assert.ok(prompts[1].lastIndexOf("输出要求：") > prompts[1].indexOf("用户反馈与修订任务："));
  assert.equal(revised.feedbackHistory[0].sourceRunId, original.runId);
  assert.equal(revised.workflow.steps[1].promptTemplate, writer.promptTemplate);
  assert.deepEqual(await json("/api/v1/runs/" + original.runId), before);

  const batchDefinition = { ...definition, inputs: [{ key: "items", type: "json", required: true }], steps: [literal("prefix"), { ...writer, execution: { mode: "for_each", sourceRef: "input.items", maxConcurrency: 2 }, inputs: [{ key: "item", label: "当前镜头", sourceRef: "iteration.item" }] }], outputs: [] };
  const batchRun = await json("/api/v1/runs", { runId: randomUUID(), workflow: batchDefinition, inputValues: { items: ["甲", "乙"] } });
  const batch = await wait(batchRun.runId); const callsBefore = prompts.length;
  assert.equal(batch.steps[1].items[0].agentPrompt, prompts[callsBefore - 2]);
  assert.equal(batch.steps[1].items[1].agentPrompt, prompts[callsBefore - 1]);
  const itemRevision = await json("/api/v1/runs/" + batch.runId + "/rerun", { runId: randomUUID(), changes: { feedback: [{ stepId: "writer", itemIndex: 1, message: "只给乙增加转折" }] } });
  const itemResult = await wait(itemRevision.runId);
  assert.equal(prompts.length, callsBefore + 1); assert.match(prompts.at(-1), /当前镜头: 乙/); assert.match(prompts.at(-1), /只给乙增加转折/);
  assert.equal(itemResult.steps[1].items[1].agentPrompt, prompts.at(-1));
  assert.equal(itemResult.steps[1].items[0].agentPrompt, batch.steps[1].items[0].agentPrompt);
  assert.ok(prompts.at(-1).includes(batch.steps[1].items[1].outputs.value));
  assert.ok(!prompts.at(-1).includes(batch.steps[1].items[0].outputs.value));
  assert.equal(itemResult.steps[1].items[0].reusedFromRunId, batch.runId);

  const reviewDefinition = { ...definition, steps: definition.steps.map(step => step.id === "writer" ? { ...step, review: { enabled: true } } : step) };
  const reviewRun = await json("/api/v1/runs", { runId: randomUUID(), workflow: reviewDefinition, inputValues: {} });
  const pending = await wait(reviewRun.runId, "waiting");
  assert.equal(pending.steps[1].agentPrompt, prompts.at(-1));
  await json("/api/v1/runs/" + pending.runId + "/review", { reviewId: pending.pendingReview.id, action: "redo", feedback: "主角动机要清晰" });
  const next = await wait(pending.runId, "waiting");
  assert.match(prompts.at(-1), /主角动机要清晰/); assert.ok(prompts.at(-1).includes(pending.steps[1].outputs.value));
  assert.equal(next.steps[1].agentPrompt, prompts.at(-1));
  assert.notEqual(next.pendingReview.id, pending.pendingReview.id);
  assert.equal(next.reviewHistory[0].feedbackId, next.feedbackHistory[0].id);
  await json("/api/v1/runs/" + next.runId + "/review", { reviewId: next.pendingReview.id, action: "approve" });
  const approved = await wait(next.runId);
  await stop(); base = await start();
  assert.deepEqual(await json("/api/v1/runs/" + revised.runId), revised);
  assert.deepEqual(await json("/api/v1/runs/" + approved.runId), approved);
  console.log("PASS: real Hermes HTTP payload receives feedback + rejected output; full-step / per-item / review-redo / dependency reuse / immutable templates and sources / restart history (isolated loopback mock, no paid generation)");
} finally {
  await stop();
  await new Promise(resolve => mock.close(resolve));
  const resolved = path.resolve(temporary);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + "zane-feedback-smoke-"));
  await rm(resolved, { recursive: true, force: true });
}
