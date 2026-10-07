import "./smoke-auth.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// Compiled workbench + real stdio MCP + loopback fake Hermes. No production or model access.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "zane-hermes-json-"));
const project = path.join(temporary, "project");
await mkdir(project);
const shots = Array.from({ length: 15 }, (_, index) => ({ index: index + 1, seconds: 8, visual_description: `镜头${index + 1}；字符串中的 } 不应删除`, dialogue: [] }));
const expected = { storyboard: "完整15镜；合计120秒。", shots };
const broken = JSON.stringify({ storyboard: expected.storyboard }) + ',"shots":' + JSON.stringify(shots) + '}';
const whitespaceExpected = { storyboard: "商品事实\n保持黑色\r\n禁区\t不虚构参数", shots: shots.map(shot => ({ ...shot, visual_description: shot.visual_description + "\n完整不截断" })) };
const whitespaceSource = JSON.stringify(whitespaceExpected).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
const upstream = new Map();
let admissions = 0;
const mock = createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  try {
    assert.equal(request.headers.authorization, "Bearer json-smoke-only");
    if (request.method === "POST" && request.url === "/v1/runs") {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const content = body.input[0].content;
      const runId = randomUUID(); admissions++;
      assert.ok(content.includes("字符串内的换行、回车、制表符"), "shared output prompt declares JSON escaping");
      const output = content.includes("CASE:invalid") ? broken + "附加说明"
        : content.includes("CASE:wrong-type") ? '{"storyboard":"完整"},"shots":"不是JSON"}'
        : content.includes("CASE:whitespace-extra") ? whitespaceSource + "附加说明"
        : content.includes("CASE:whitespace-duplicate") ? whitespaceSource.replace(',"shots":', ',"storyboard":"overwrite","shots":')
        : content.includes("CASE:whitespace") ? whitespaceSource : broken;
      upstream.set(runId, output);
      response.end(JSON.stringify({ run_id: runId, status: "queued" })); return;
    }
    const runId = /^\/v1\/runs\/([^/]+)$/.exec(request.url)?.[1];
    if (request.method === "GET" && upstream.has(runId)) {
      response.end(JSON.stringify({ run_id: runId, status: "completed", output: upstream.get(runId) })); return;
    }
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "hermes-agent" }] })); return; }
    response.statusCode = 404; response.end(JSON.stringify({ error: "unexpected mock endpoint" }));
  } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); }
});
let child, exited, logs = "";
const client = new Client({ name: "hermes-output-smoke", version: "1" });
const bounded = async (promise, ms = 20_000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Hermes JSON smoke timeout\n" + logs.slice(-3000))), ms); })]); }
  finally { clearTimeout(timer); }
};
try {
  await new Promise(resolve => mock.listen(0, "127.0.0.1", resolve));
  const mockBase = "http://127.0.0.1:" + mock.address().port;
  child = spawn(process.execPath, [path.join(root, "dist-server/index.js"), "--production"], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", API_HOST: "127.0.0.1", API_PORT: "0", APP_DATA_DIR: path.join(temporary, "data"), ZANE_PROJECT_DIR: project, HERMES_HOME: path.join(temporary, "unused-hermes"), HERMES_API_BASE_URL: mockBase, HERMES_API_KEY: "json-smoke-only", HERMES_RETRY_ATTEMPTS: "0", COMFYUI_BASE_URL: "http://127.0.0.1:1", ZANE_SHUTDOWN_TIMEOUT_MS: "1000" },
  });
  exited = new Promise(resolve => child.once("exit", resolve));
  const base = await bounded(new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", code => reject(new Error("Isolated backend exited " + code + "\n" + logs)));
    child.stderr.on("data", chunk => { logs += chunk; });
    child.stdout.on("data", chunk => { logs += chunk; const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs); if (match) resolve(match[1]); });
  }));
  let ready = false;
  for (let i = 0; i < 100; i++) { if ((await fetch(base + "/api/ready", { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.ok(ready);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist-server/mcp/index.js")], cwd: root, env: { ...process.env, ZANE_BASE_URL: base }, stderr: "pipe" });
  transport.stderr?.on("data", chunk => { logs += chunk; });
  await bounded(client.connect(transport));
  const call = async (name, args = {}) => {
    const result = await bounded(client.callTool({ name, arguments: args }));
    assert.ok(!result.isError && result.structuredContent?.ok, JSON.stringify(result));
    return result.structuredContent.data;
  };
  const sceneId = "hermes-output-smoke";
  const workflow = { sceneId, name: "通用Hermes JSON隔离验收", inputs: [{ key: "case", type: "text", required: true }], steps: [{ id: "writer", name: "Writer", kind: "hermes", hermesProfile: "default", promptTemplate: "CASE:{{input.case}}", inputs: [], outputs: [{ key: "storyboard", type: "text" }, { key: "shots", type: "json" }] }], outputs: [{ key: "shots", type: "json", sourceRef: "step.writer.outputs.shots" }] };
  const draft = await call("create_scene", { scene: { id: sceneId, title: workflow.name, summary: "只访问本地假Hermes" }, workflow });
  const versionId = randomUUID();
  await call("validate_scene_draft", { sceneId, revision: draft.revision });
  await call("publish_scene", { sceneId, revision: draft.revision, publicationId: versionId });
  const conflict = await client.callTool({ name: "publish_scene", arguments: { sceneId, revision: "0".repeat(64), publicationId: randomUUID() } });
  assert.ok(conflict.isError, "stale revision remains rejected");
  const invalid = await client.callTool({ name: "submit_scene", arguments: { sceneId, versionId, runId: randomUUID(), inputValues: { case: "valid" }, unexpected: true } });
  assert.ok(invalid.isError); assert.equal(admissions, 0);
  const wait = async runId => {
    for (let i = 0; i < 100; i++) { const run = await call("get_run", { runId }); if (!["queued", "running", "cancelling"].includes(run.status)) return run; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error("run did not settle");
  };
  const submit = async value => {
    const runId = randomUUID(); // Saved before sending; reads below use this exact ID.
    const inputValues = { case: value };
    await call("prepare_scene", { sceneId, versionId, inputValues });
    await call("submit_scene", { sceneId, versionId, runId, inputValues });
    return wait(runId);
  };
  const [valid, invalidJson] = await Promise.all([submit("valid"), submit("invalid")]);
  assert.equal(valid.status, "completed"); assert.deepEqual(valid.steps[0].outputs, expected);
  assert.equal(invalidJson.status, "failed"); assert.match(invalidJson.error, /Hermes 输出 JSON 格式无效/);
  assert.equal(invalidJson.steps[0].outputs, undefined);
  const beforeReads = admissions;
  // Simulated lost receipt: reconcile the same ID by reads, never re-submit.
  assert.deepEqual((await call("get_run", { runId: valid.runId })).steps[0].outputs, expected);
  const recovered = [];
  let offset = 0;
  do {
    const page = await call("get_step_result", { runId: valid.runId, stepId: "writer", outputKey: "shots", valueOffset: offset, valueLimit: 4 });
    assert.equal(page.outputs[0].valuePage.total, 15);
    recovered.push(...page.outputs[0].value);
    offset = page.outputs[0].valuePage.nextValueOffset;
  } while (offset !== undefined);
  assert.deepEqual(recovered, shots);
  const end = await call("get_step_result", { runId: valid.runId, stepId: "writer", outputKey: "shots", valueOffset: 15, valueLimit: 4 });
  assert.deepEqual(end.outputs[0].value, []);
  assert.equal(admissions, beforeReads, "read-only reconciliation and pagination never generate");
  const wrongType = await submit("wrong-type");
  assert.equal(wrongType.status, "failed"); assert.match(wrongType.error, /JSON/);
  assert.equal(admissions, 3, "one upstream request per explicit submission; no automatic retries");
  const whitespace = await submit("whitespace");
  assert.equal(whitespace.status, "completed"); assert.deepEqual(whitespace.steps[0].outputs, whitespaceExpected);
  const beforeWhitespaceReads = admissions;
  const textPage = await call("get_step_result", { runId: whitespace.runId, stepId: "writer", outputKey: "storyboard", textOffset: 0, textLimit: 1000 });
  assert.equal(textPage.outputs[0].value, whitespaceExpected.storyboard);
  const fullShots = await call("get_step_result", { runId: whitespace.runId, stepId: "writer", outputKey: "shots", valueLimit: 20 });
  assert.deepEqual(fullShots.outputs[0].value, whitespaceExpected.shots);
  assert.deepEqual((await call("get_run", { runId: whitespace.runId })).steps[0].outputs, whitespaceExpected);
  assert.equal(admissions, beforeWhitespaceReads, "same-ID reconciliation and pagination never replay model calls");
  for (const testcase of ["whitespace-extra", "whitespace-duplicate"]) {
    const rejected = await submit(testcase);
    assert.equal(rejected.status, "failed"); assert.match(rejected.error, /Hermes 输出 JSON 格式无效/); assert.equal(rejected.steps[0].outputs, undefined);
  }
  assert.equal(admissions, 6, "each explicit isolated submission calls mock Hermes once, including failures");
  const openapi = await (await fetch(base + "/api/v1/ai/openapi.json")).json();
  assert.equal(openapi["x-hermes-output-json"].modelRetry, "none");
  assert.equal(openapi["x-hermes-output-json"].version, "2");
  assert.ok(openapi["x-hermes-output-json"].recovery.includes("escape_literal_lf_cr_tab_inside_json_strings"));
  assert.equal(openapi["x-hermes-output-json"].recoveryComposition, "one_recovery_family_only");
  assert.match(logs, /hermes.output_json_repaired/);
  console.log("Hermes JSON smoke passed: real stdio MCP, published snapshot, 15-shot/linebreak recovery without value changes, malformed/duplicate/type failure, stale revision, parallel runs, lost-receipt reconciliation, pagination; no real generation.");
} finally {
  await client.close().catch(() => undefined);
  if (child?.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited; clearTimeout(timer);
  }
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  // mkdtemp returned this absolute, task-owned directory; never production data.
  await rm(temporary, { recursive: true, force: true });
}
