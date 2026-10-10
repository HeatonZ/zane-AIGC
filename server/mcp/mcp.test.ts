import sharp from "sharp";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { aiHarness } from "../testing/aiSupport.js";
import { createThirdPartyJsonRequester } from "../execution/thirdPartyJsonRequest.js";
import { id } from "../testing/testSupport.js";
import { aiOperations } from "../ai/operations.js";
import type { ApiResult } from "./httpClient.js";
import type { AssetRecord, AssetReference } from "../domain/productionContracts.js";

async function connect(t: Parameters<typeof aiHarness>[0], base: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.resolve("server/mcp/index.ts")], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === "string")), ZANE_BASE_URL: base }, stderr: "pipe" });
  let errors = ""; transport.stderr?.on("data", chunk => { errors += chunk; });
  const client = new Client({ name: "zane-mcp-test", version: "1.0.0" });
  t.after(async () => { await client.close(); });
  try { await client.connect(transport); } catch (error) { throw new Error(String(error) + "\n" + errors); }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok("content" in result);
    return { result, payload: result.structuredContent as ApiResult };
  };
  return { client, call };
}

test("真实stdio MCP：工具schema/资源/提示词发现，发布场景→预检→审核→完成→局部重做", async t => {
  const calls: string[] = [];
  const h = await aiHarness(t, { review: true, executor: { kind: "fake", async execute({ step }) { calls.push(step.id); return { value: "MCP " + step.id }; } } });
  const { client, call } = await connect(t, h.base);
  const tools = await client.listTools(); assert.deepEqual(tools.tools.map(tool => tool.name).sort(), aiOperations.map(operation => operation.name).sort());
  const submitSchema = tools.tools.find(tool => tool.name === "submit_scene")!.inputSchema; assert.ok(submitSchema.required?.includes("versionId")); assert.ok(submitSchema.required?.includes("runId"));
  assert.equal(tools.tools.find(tool => tool.name === "prepare_scene")!.annotations?.readOnlyHint, true); assert.equal(tools.tools.find(tool => tool.name === "submit_scene")!.annotations?.idempotentHint, false);
  const resources = await client.listResources(); assert.deepEqual(resources.resources.map(resource => resource.uri).sort(), ["zane://capabilities", "zane://guide", "zane://openapi", "zane://scenes"]);
  const guide = await client.readResource({ uri: "zane://guide" }); assert.ok("text" in guide.contents[0]); assert.match(String(guide.contents[0].text), /响应丢失/);
  const openapi = await client.readResource({ uri: "zane://openapi" }); assert.ok("text" in openapi.contents[0]); assert.equal(JSON.parse(String(openapi.contents[0].text)).openapi, "3.1.0");
  const prompt = await client.getPrompt({ name: "operate-workbench", arguments: { goal: "测试接管" } }); assert.match(JSON.stringify(prompt), /测试接管/);
  assert.equal((await call("get_workbench")).payload.ok, true); assert.equal((await call("list_scenes")).payload.ok, true); assert.equal((await call("list_capabilities")).payload.ok, true);
  assert.equal((await call("prepare_scene", { sceneId: "demo", versionId: "version-a", inputValues: {} })).payload.ok, true);
  const bad = await call("submit_scene", { sceneId: "demo", inputValues: {} }); assert.equal(bad.result.isError, true); assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);
  const runId = id("mcp-approved-run");
  assert.equal((await call("submit_scene", { sceneId: "demo", versionId: "version-a", inputValues: {}, runId })).payload.ok, true);
  const waiting = (await call("wait_run", { runId, timeoutSeconds: 2 })).payload.data as { status: string; pendingReview: { id: string } }; assert.equal(waiting.status, "waiting"); assert.deepEqual(calls, ["first"]);
  assert.equal((await call("review_run", { runId, reviewId: waiting.pendingReview.id, action: "approve" })).payload.ok, true);
  await call("wait_run", { runId, timeoutSeconds: 2 });
  const stale = await call("review_run", { runId, reviewId: waiting.pendingReview.id, action: "approve" }); assert.equal(stale.result.isError, true); assert.equal(stale.payload.error?.code, "REVIEW_CONFLICT"); assert.equal(stale.payload.requestId, "ai-test-request");
  const done = (await call("get_run", { runId })).payload.data as { status: string; outputs: Array<{ value: string }> }; assert.equal(done.status, "completed"); assert.equal(done.outputs[0].value, "MCP last");
  const changes = { rerunSteps: [{ stepId: "last" }] };
  const preview = await call("preview_rerun", { sourceRunId: runId, changes }); assert.equal(preview.payload.ok, true); assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 1);
  const newId = id("mcp-rerun"); assert.equal((await call("rerun", { sourceRunId: runId, runId: newId, changes })).payload.ok, true); await call("wait_run", { runId: newId, timeoutSeconds: 2 });
  assert.deepEqual(calls, ["first", "last", "last"]);
  const events = (await call("get_run_events", { runId: newId, after: 0, limit: 1 })).payload.data as { events: unknown[]; hasMore: boolean }; assert.equal(events.events.length, 1); assert.equal(events.hasMore, true);
});

test("真实stdio MCP：本地流式上传、固定版本、metadata revision冲突，媒体Range", async t => {
  const h = await aiHarness(t); const { call } = await connect(t, h.base);
  const file = path.join(h.root, "参考素材.png"); await writeFile(file, "0123456789");
  const uploaded = await call("upload_asset", { createId: randomUUID(), filePath: file, name: "角色", kind: "image", category: "character" }); assert.equal(uploaded.payload.ok, true);
  const { asset, reference } = uploaded.payload.data as { asset: AssetRecord; reference: AssetReference };
  assert.equal(reference.assetVersion, 1);
  assert.equal(((await call("get_asset_version", { assetId: asset.id, version: 1 })).payload.data as { version: { bytes: number } }).version.bytes, 10);
  const range = await fetch(h.base + reference.previewUrl!, { headers: { Range: "bytes=2-5" } }); assert.equal(range.status, 206); assert.equal(await range.text(), "2345");
  const updated = await call("update_asset", { assetId: asset.id, revision: asset.revision, name: "角色新版" }); assert.equal(updated.payload.ok, true);
  const conflict = await call("update_asset", { assetId: asset.id, revision: asset.revision, name: "不能覆盖" }); assert.equal(conflict.payload.error?.status, 409); assert.equal(conflict.result.isError, true);
  const reread = (await call("get_asset", { assetId: asset.id })).payload.data as { asset: AssetRecord }; assert.equal(reread.asset.name, "角色新版"); assert.equal(reread.asset.currentVersion, 1);
  const missing = await call("upload_asset", { createId: randomUUID(), filePath: path.join(h.root, "missing.png"), kind: "image" }); assert.equal(missing.payload.error?.outcome, "rejected"); assert.equal(missing.payload.error?.code, "LOCAL_INPUT_ERROR");
});


test("真实stdio MCP：单场景创建编辑校验发布、输入契约和指定结果完整闭环", async t => {
  const h = await aiHarness(t); const { client, call } = await connect(t, h.base);
  const tools = await client.listTools(); assert.equal(tools.tools.find(tool => tool.name === "validate_scene_draft")?.annotations?.readOnlyHint, true);
  const created = await call("create_scene", { scene: { id: "mcp-foundation", title: "通用新业务" }, workflow: { name: "通用新业务", inputs: [{ key: "text", type: "text", required: true, defaultValue: "默认输入" }, { key: "internal_mode", type: "text", required: true, hidden: true }, { key: "quantity", type: "number", required: false, minimum: 2, maximum: 8 }], steps: [{ id: "first", name: "本地步骤", kind: "fake", outputs: [{ key: "value", type: "text" }] }], outputs: [{ key: "result", label: "结果", type: "text", sourceRef: "step.first.outputs.value" }] } });
  assert.equal(created.payload.ok, true); let draft = created.payload.data as Record<string, any>;
  const invalidDefault = await call("update_scene_draft", { sceneId: draft.sceneId, revision: draft.revision, workflow: { ...draft.workflow, inputs: draft.workflow.inputs.map((field: any, index: number) => index === 0 ? { ...field, defaultValue: 42 } : field) } }); assert.equal(invalidDefault.payload.ok, true); draft = invalidDefault.payload.data as Record<string, any>;
  const rejectedDefault = await call("validate_scene_draft", { sceneId: draft.sceneId, revision: draft.revision }); assert.equal(rejectedDefault.payload.error?.code, "INPUT_TYPE_MISMATCH");
  const correctedDefault = await call("update_scene_draft", { sceneId: draft.sceneId, revision: draft.revision, workflow: { ...draft.workflow, inputs: draft.workflow.inputs.map((field: any, index: number) => index === 0 ? { ...field, defaultValue: "更新默认" } : field) } }); assert.equal(correctedDefault.payload.ok, true); draft = correctedDefault.payload.data as Record<string, any>;
  const missingHiddenDefault = await call("validate_scene_draft", { sceneId: draft.sceneId, revision: draft.revision }); assert.equal(missingHiddenDefault.payload.error?.code, "HIDDEN_REQUIRED_INPUT_DEFAULT_MISSING");
  const correctedHiddenDefault = await call("update_scene_draft", { sceneId: draft.sceneId, revision: draft.revision, workflow: { ...draft.workflow, inputs: draft.workflow.inputs.map((field: any) => field.key === "internal_mode" ? { ...field, defaultValue: "safe" } : field) } }); assert.equal(correctedHiddenDefault.payload.ok, true); draft = correctedHiddenDefault.payload.data as Record<string, any>;
  const updated = await call("update_scene_draft", { sceneId: draft.sceneId, revision: draft.revision, scene: { ...draft.scene, title: "修改后的业务" } }); assert.equal(updated.payload.ok, true); draft = updated.payload.data as Record<string, any>;
  const stale = await call("update_scene_draft", { sceneId: draft.sceneId, revision: (created.payload.data as any).revision, scene: draft.scene }); assert.equal(stale.payload.error?.code, "RESOURCE_REVISION_CONFLICT"); assert.ok(stale.payload.error?.details?.currentRevision);
  assert.equal((await call("validate_scene_draft", { sceneId: draft.sceneId, revision: draft.revision })).payload.ok, true);
  const publicationId = randomUUID(); const published = await call("publish_scene", { sceneId: draft.sceneId, revision: draft.revision, publicationId }); assert.equal(published.payload.ok, true);
  const replay = await call("publish_scene", { sceneId: draft.sceneId, revision: draft.revision, publicationId }); assert.equal((replay.payload.data as any).created, false);
  const selected = await call("get_scene", { sceneId: draft.sceneId, versionId: publicationId }); const selectedData = selected.payload.data as any; assert.ok(selectedData.inputSchema); assert.ok(selectedData.inputExamples); assert.equal(selectedData.inputDefaults.text, "更新默认"); assert.equal(selectedData.inputDefaults.internal_mode, "safe"); assert.equal(selectedData.inputSchema.properties.internal_mode["x-hidden"], true); assert.equal(selectedData.inputRequirements.find((field: any) => field.key === "internal_mode").hidden, true); assert.equal(selectedData.inputSchema.properties.quantity.anyOf[1].minimum, 2); assert.equal(selectedData.inputSchema.properties.quantity.anyOf[1].maximum, 8); assert.equal(selectedData.inputRequirements.find((field: any) => field.key === "quantity").required, false);
  const prepared = await call("prepare_scene", { sceneId: draft.sceneId, versionId: publicationId, inputValues: {} }); assert.equal(prepared.payload.ok, true); assert.equal((prepared.payload.data as any).inputValues.text, "更新默认"); assert.equal((prepared.payload.data as any).inputValues.internal_mode, "safe");
  for (const quantity of [2, 8]) assert.equal((await call("prepare_scene", { sceneId: draft.sceneId, versionId: publicationId, inputValues: { quantity } })).payload.ok, true);
  for (const quantity of [1, 9]) { const rejected = await call("prepare_scene", { sceneId: draft.sceneId, versionId: publicationId, inputValues: { quantity } }); assert.equal(rejected.payload.error?.code, "INPUT_OUT_OF_RANGE"); }
  const runId = randomUUID(); assert.equal((await call("submit_scene", { sceneId: draft.sceneId, versionId: publicationId, runId, inputValues: {} })).payload.ok, true); await call("wait_run", { runId, timeoutSeconds: 2 });
  assert.equal((await call("get_run_outputs", { runId, outputKey: "result" })).payload.ok, true); assert.equal((await call("get_step_result", { runId, stepId: "first", outputKey: "value" })).payload.ok, true);
  assert.equal((await call("save_option_preset", { preset: { id: "mcp-options", name: "新选项", options: ["一", "二"] } })).payload.ok, true);
  const page = (await call("list_option_presets", { q: "mcp-options" })).payload.data as any; assert.equal(page.presets[0].id, "mcp-options");
  assert.equal((await call("delete_option_preset", { presetId: "mcp-options", revision: page.presets[0].revision })).payload.ok, true);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 1);
});

test("真实stdio MCP：第三方请求分页发现、固定发布、冲突保护和原ID对账", async t => {
  const received: Array<{ url: string; method: string; authorization?: string; body: unknown }> = [];
  const previousKey = process.env.TEST_MCP_IMAGE_KEY;
  process.env.TEST_MCP_IMAGE_KEY = "mcp-only-fixture-key";
  t.after(() => { if (previousKey === undefined) delete process.env.TEST_MCP_IMAGE_KEY; else process.env.TEST_MCP_IMAGE_KEY = previousKey; });
  const h = await aiHarness(t, { thirdPartyRequest: createThirdPartyJsonRequester({
    async resolve() { return [{ address: "93.184.216.34", family: 4 }]; },
    async send(request) {
      received.push({ url: request.url.href, method: request.method, authorization: request.headers.Authorization, body: JSON.parse(request.body!.toString()) });
      return { status: 202, contentType: "application/json", body: Buffer.from('{"task_id":"third-party-job-1","status":"queued"}') };
    },
  }) });
  const { call } = await connect(t, h.base);
  const catalog: any[] = []; let cursor: string | undefined;
  do {
    const page = (await call("list_capabilities", { limit: 2, ...(cursor ? { cursor } : {}) })).payload.data as any;
    assert.ok(page.capabilities.length <= 2); catalog.push(...page.capabilities);
    cursor = page.hasMore ? page.nextCursor : undefined;
    if (page.hasMore) assert.ok(cursor);
  } while (cursor);
  assert.equal(new Set(catalog.map(item => item.id)).size, catalog.length);
  const capability = catalog.find(item => item.id === "core.http_request");
  assert.ok(capability); assert.equal(capability.legacy.kind, "capability"); assert.ok(capability.config.some((field: any) => field.key === "apiKeyEnv"));
  const original = (await call("get_scene_draft", { sceneId: "demo" })).payload.data as any;
  const workflow = {
    name: "第三方请求闭环",
    inputs: [{ key: "prompt", label: "提示词", type: "text", required: true }],
    steps: [{ id: "submit_image", name: "提交生图", kind: "capability", capabilityId: "core.http_request", capabilityVersion: capability.version,
      capabilityConfig: { url: "https://images.example.net/v1/generations", method: "POST", apiKeyEnv: "TEST_MCP_IMAGE_KEY", bodyTemplate: { prompt: "{{prompt}}", size: "1024x1024" }, timeoutSeconds: 60 },
      inputs: [{ key: "prompt", label: "提示词", sourceRef: "input.prompt" }],
      outputs: [{ key: "response", label: "第三方任务", type: "json" }, { key: "status", label: "HTTP状态", type: "number" }] }],
    outputs: [{ key: "job", label: "任务回执", type: "json", sourceRef: "step.submit_image.outputs.response" }],
  };
  const invalid = structuredClone(workflow); invalid.steps[0]!.capabilityConfig.url = "http://127.0.0.1/private";
  const invalidSaved = await call("update_scene_draft", { sceneId: "demo", revision: original.revision, workflow: invalid });
  assert.equal(invalidSaved.payload.ok, true);
  const invalidRevision = (invalidSaved.payload.data as any).revision;
  const validation = (await call("validate_scene_draft", { sceneId: "demo", revision: invalidRevision })).payload;
  assert.equal(validation.ok, false); assert.equal(validation.error?.code, "INVALID_HTTP_REQUEST_CONFIG");
  assert.equal((await call("publish_scene", { sceneId: "demo", revision: invalidRevision, publicationId: randomUUID() })).payload.ok, false);
  const updated = await call("update_scene_draft", { sceneId: "demo", revision: invalidRevision, workflow });
  assert.equal(updated.payload.ok, true); const draft = updated.payload.data as any;
  const stale = await call("update_scene_draft", { sceneId: "demo", revision: invalidRevision, workflow: invalid });
  assert.equal(stale.payload.error?.status, 409);
  const validated = await call("validate_scene_draft", { sceneId: "demo", revision: draft.revision });
  assert.equal(validated.payload.ok, true); assert.equal((validated.payload.data as any).valid, true);
  // Discard publication acknowledgement and reconcile only the preselected ID.
  const publicationId = randomUUID(); await call("publish_scene", { sceneId: "demo", revision: draft.revision, publicationId });
  const published = await call("get_scene", { sceneId: "demo", versionId: publicationId }); assert.equal(published.payload.ok, true);
  const prepared = await call("prepare_scene", { sceneId: "demo", versionId: publicationId, inputValues: { prompt: "A red fox in watercolor" } });
  assert.equal(prepared.payload.ok, true); assert.equal(received.length, 0);
  assert.ok(((published.payload.data as any).boundaries.externalSteps as any[]).some(step => step.capabilityId === "core.http_request" && step.mayCostMoney));
  const edited = structuredClone(workflow); edited.steps[0]!.capabilityConfig.url = "https://edited.example.net/never-called";
  const current = (await call("get_scene_draft", { sceneId: "demo" })).payload.data as any;
  assert.equal((await call("update_scene_draft", { sceneId: "demo", revision: current.revision, workflow: edited })).payload.ok, true);
  // Simulate an unavailable submit acknowledgement: no new ID and no automatic resubmission.
  const runId = randomUUID(); const submission = { sceneId: "demo", versionId: publicationId, runId, inputValues: { prompt: "A red fox in watercolor" } };
  await call("submit_scene", submission);
  assert.equal((await call("get_run", { runId })).payload.ok, true);
  const done = (await call("wait_run", { runId, timeoutSeconds: 2 })).payload.data as any; assert.equal(done.status, "completed");
  const duplicate = await call("submit_scene", submission); assert.equal(duplicate.payload.error?.status, 409);
  const stepResult = await call("get_step_result", { runId, stepId: "submit_image" }); assert.equal(stepResult.payload.ok, true);
  assert.match(JSON.stringify(stepResult.payload.data), /third-party-job-1/);
  assert.doesNotMatch(JSON.stringify((await call("get_run", { runId })).payload.data), /mcp-only-fixture-key/);
  assert.deepEqual(received, [{ url: "https://images.example.net/v1/generations", method: "POST", authorization: "Bearer mcp-only-fixture-key", body: { prompt: "A red fox in watercolor", size: "1024x1024" } }]);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 1);
});


test("真实stdio MCP：第三方请求重试字段经草稿/发布到真实执行器生效", async t => {
  const received: Array<{ authorization?: string; body: unknown }> = [];
  const variable = "TEST_MCP_RETRY_KEY"; const previousKey = process.env[variable];
  process.env[variable] = "mcp-only-retry-key";
  t.after(() => { if (previousKey === undefined) delete process.env[variable]; else process.env[variable] = previousKey; });
  let attempts = 0;
  const h = await aiHarness(t, { thirdPartyRequest: createThirdPartyJsonRequester({
    async resolve() { return [{ address: "93.184.216.34", family: 4 }]; },
    async send(request) {
      attempts += 1;
      received.push({ authorization: request.headers.Authorization, body: JSON.parse(request.body!.toString()) });
      if (attempts === 1) return { status: 503, contentType: "application/json", body: Buffer.from('{"error":"busy"}') };
      return { status: 200, contentType: "application/json", body: Buffer.from('{"task_id":"third-party-retry-job-1"}') };
    },
  }) });
  const { call } = await connect(t, h.base);
  const catalog = (await call("list_capabilities", { limit: 100 })).payload.data as any;
  const capability = catalog.capabilities.find((item: any) => item.id === "core.http_request");
  assert.ok(capability); assert.ok(capability.config.some((field: any) => field.key === "retries"));
  assert.ok(capability.config.some((field: any) => field.key === "retryDelaySeconds"));
  const config: Record<string, unknown> = { url: "https://images.example.net/v1/generations", method: "POST", apiKeyEnv: variable, bodyTemplate: { prompt: "{{prompt}}", size: "1024x1024" }, timeoutSeconds: 30, retries: 2, retryDelaySeconds: 0 };
  const workflow = { name: "第三方请求重试闭环", inputs: [{ key: "prompt", label: "提示词", type: "text", required: true }], steps: [{ id: "submit", name: "提交生图", kind: "capability", capabilityId: "core.http_request", capabilityVersion: capability.version, capabilityConfig: config, inputs: [{ key: "prompt", label: "提示词", sourceRef: "input.prompt" }], outputs: [{ key: "response", label: "第三方任务", type: "json" }, { key: "status", label: "HTTP状态", type: "number" }] }], outputs: [{ key: "job", label: "任务回执", type: "json", sourceRef: "step.submit.outputs.response" }] };
  const created = await call("create_scene", { scene: { id: "mcp-http-retry", title: "重试夹具" }, workflow }); assert.equal(created.payload.ok, true);
  const draft = (created.payload.data as any).revision;
  assert.equal((await call("validate_scene_draft", { sceneId: "mcp-http-retry", revision: draft })).payload.ok, true);
  const retryPublication = randomUUID();
  assert.equal((await call("publish_scene", { sceneId: "mcp-http-retry", revision: draft, publicationId: retryPublication })).payload.ok, true);
  assert.equal((await call("prepare_scene", { sceneId: "mcp-http-retry", versionId: retryPublication, inputValues: { prompt: "A red fox in watercolor" } })).payload.ok, true);
  const runId = randomUUID();
  assert.equal((await call("submit_scene", { sceneId: "mcp-http-retry", versionId: retryPublication, runId, inputValues: { prompt: "A red fox in watercolor" } })).payload.ok, true);
  assert.equal(((await call("wait_run", { runId, timeoutSeconds: 5 })).payload.data as any).status, "completed");
  assert.equal(received.length, 2); assert.deepEqual(received[0], received[1]);
  assert.equal(received[0]!.authorization, "Bearer mcp-only-retry-key");
  assert.deepEqual(received[0]!.body, { prompt: "A red fox in watercolor", size: "1024x1024" });
  assert.match(JSON.stringify((await call("get_step_result", { runId, stepId: "submit" })).payload.data), /third-party-retry-job-1/);
  // The same published flow without the retry fields keeps exactly one request.
  const current = (await call("get_scene_draft", { sceneId: "mcp-http-retry" })).payload.data as any;
  const single = structuredClone(workflow); delete (single.steps[0]!.capabilityConfig as Record<string, unknown>).retries; delete (single.steps[0]!.capabilityConfig as Record<string, unknown>).retryDelaySeconds;
  assert.equal((await call("update_scene_draft", { sceneId: "mcp-http-retry", revision: current.revision, workflow: single })).payload.ok, true);
  const singleDraft = ((await call("get_scene_draft", { sceneId: "mcp-http-retry" })).payload.data as any).revision;
  assert.equal((await call("validate_scene_draft", { sceneId: "mcp-http-retry", revision: singleDraft })).payload.ok, true);
  const singlePublication = randomUUID();
  assert.equal((await call("publish_scene", { sceneId: "mcp-http-retry", revision: singleDraft, publicationId: singlePublication })).payload.ok, true);
  const singleRun = randomUUID();
  assert.equal((await call("submit_scene", { sceneId: "mcp-http-retry", versionId: singlePublication, runId: singleRun, inputValues: { prompt: "A blue owl" } })).payload.ok, true);
  assert.equal(((await call("wait_run", { runId: singleRun, timeoutSeconds: 5 })).payload.data as any).status, "completed");
  assert.equal(received.length, 3);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 2);
});


test("真实stdio MCP：第三方multipart图片从固定素材到真实执行器、图片分页与原ID对账", async t => {
  const source = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
  const output = await sharp({ create: { width: 12, height: 12, channels: 3, background: "green" } }).png().toBuffer();
  let sends = 0;
  const h = await aiHarness(t, { thirdPartyRequest: createThirdPartyJsonRequester({
    async resolve() { return [{ address: "93.184.216.34", family: 4 }]; },
    async send(request) {
      sends++; const form = await new Response(new Uint8Array(request.body!), { headers: { "content-type": request.headers["content-type"]! } }).formData();
      assert.equal(form.get("model"), "test-image-model"); assert.equal(form.get("prompt"), "preserve product");
      const upload = form.get("image[]") as File; assert.deepEqual(Buffer.from(await upload.arrayBuffer()), source);
      assert.equal(request.headers.cookie, undefined);
      return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({ data: [{ b64_json: output.toString("base64") }, { b64_json: output.toString("base64") }] })) };
    },
  }) });
  const { call } = await connect(t, h.base); const filename = path.join(h.root, "product.png"); await writeFile(filename, source);
  const upload = await call("upload_asset", { createId: randomUUID(), filePath: filename, kind: "image", name: "product fixture" }); assert.equal(upload.payload.ok, true);
  const reference = (upload.payload.data as any).reference;
  const sceneId = "mcp-http-images";
  const workflow = { name: "multipart image fixture", inputs: [{ key: "product_images", type: "image_list", required: true }, { key: "prompt", type: "text", required: true }], steps: [{ id: "image", name: "第三方图片", kind: "capability", capabilityId: "core.http_request", capabilityVersion: "2", capabilityConfig: { url: "https://images.example.net/v1/images/edits", bodyFormat: "multipart", bodyTemplate: { model: "test-image-model", prompt: "{{prompt}}" }, multipartImages: [{ inputKey: "product_images", fieldName: "image[]" }], responseImages: { path: "data", base64Field: "b64_json", expectedCount: 2 } }, inputs: [{ key: "product_images", sourceRef: "input.product_images" }, { key: "prompt", sourceRef: "input.prompt" }], outputs: [{ key: "response", type: "json" }, { key: "status", type: "number" }, { key: "images", type: "image_list" }] }], outputs: [{ key: "images", label: "结果", type: "image_list", sourceRef: "step.image.outputs.images" }] };
  const created = await call("create_scene", { scene: { id: sceneId, title: "multipart fixture" }, workflow }); assert.equal(created.payload.ok, true);
  const draft = created.payload.data as any;
  assert.equal((await call("validate_scene_draft", { sceneId, revision: draft.revision })).payload.ok, true);
  // Plain HTTP public endpoints (any port, public IP literal) validate; loopback stays rejected.
  const http = structuredClone(workflow); http.steps[0]!.capabilityConfig.url = "http://93.184.216.34:3001/v1/images/edits";
  const httpBase = (await call("get_scene_draft", { sceneId })).payload.data as any;
  assert.equal((await call("update_scene_draft", { sceneId, revision: httpBase.revision, workflow: http })).payload.ok, true);
  const httpRevision = ((await call("get_scene_draft", { sceneId })).payload.data as any).revision;
  assert.equal((await call("validate_scene_draft", { sceneId, revision: httpRevision })).payload.ok, true);
  const loopback = structuredClone(http); loopback.steps[0]!.capabilityConfig.url = "http://127.0.0.1:3001/v1/images/edits";
  assert.equal((await call("update_scene_draft", { sceneId, revision: httpRevision, workflow: loopback })).payload.ok, true);
  const loopbackRevision = ((await call("get_scene_draft", { sceneId })).payload.data as any).revision;
  const loopbackValidation = (await call("validate_scene_draft", { sceneId, revision: loopbackRevision })).payload;
  assert.equal(loopbackValidation.ok, false); assert.equal(loopbackValidation.error?.code, "INVALID_HTTP_REQUEST_CONFIG");
  assert.equal((await call("update_scene_draft", { sceneId, revision: loopbackRevision, workflow })).payload.ok, true);
  const versionId = randomUUID(); await call("publish_scene", { sceneId, revision: draft.revision, publicationId: versionId });
  const inputValues = { product_images: [reference], prompt: "preserve product" };
  const preflight = await call("prepare_scene", { sceneId, versionId, inputValues }); assert.equal(preflight.payload.ok, true); assert.equal(sends, 0);
  const changed = structuredClone(workflow); changed.steps[0]!.capabilityConfig.bodyTemplate.model = "draft-not-published";
  const current = (await call("get_scene_draft", { sceneId })).payload.data as any;
  assert.equal((await call("update_scene_draft", { sceneId, revision: current.revision, workflow: changed })).payload.ok, true);
  assert.equal((await call("update_scene_draft", { sceneId, revision: current.revision, workflow })).payload.error?.status, 409);
  const runId = randomUUID(); await call("submit_scene", { sceneId, versionId, runId, inputValues });
  assert.equal((await call("get_run", { runId })).payload.ok, true);
  const done = (await call("wait_run", { runId, timeoutSeconds: 2 })).payload.data as any; assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal((await call("submit_scene", { sceneId, versionId, runId, inputValues })).payload.error?.status, 409); assert.equal(sends, 1);
  const details = await call("get_step_result", { runId, stepId: "image", outputKey: "response" }); assert.match(JSON.stringify(details.payload.data), /decoded_to_images/); assert.doesNotMatch(JSON.stringify(details.payload.data), new RegExp(output.toString("base64")));
  const first = (await call("get_step_result", { runId, stepId: "image", outputKey: "images", valueLimit: 1 })).payload; assert.equal(first.ok, true);
  assert.equal((first.data as any).outputs[0].value.length, 1);
  assert.equal((first.data as any).outputs[0].valuePage.complete, false);
  const second = (await call("get_step_result", { runId, stepId: "image", outputKey: "images", valueLimit: 1, valueOffset: 1 })).payload.data as any;
  assert.equal(second.outputs[0].value.length, 1); assert.equal(second.outputs[0].valuePage.hasMore, false);
  assert.notDeepEqual(second.outputs[0].value, (first.data as any).outputs[0].value);
  const mediaUrl = (first.data as any).outputs[0].mediaReferences[0].url;
  const head = await fetch(h.base + mediaUrl, { method: "HEAD" }); assert.equal(head.status, 200);
  const range = await fetch(h.base + mediaUrl, { headers: { Range: "bytes=0-7" } }); assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), output.subarray(0, 8));
  const mediaExport = await call("get_run_media_export", { runId, outputKey: "images" }); assert.equal(mediaExport.payload.ok, true);
  assert.equal((mediaExport.payload.data as any).fileCount, 2);
  const run = (await call("get_run", { runId })).payload.data as any;
  assert.equal(run.outputs[0].value.length, 2);
});

test("真实stdio MCP：第三方生图归档URL经core.code按文件名选择（回归闭环）", async t => {
  // End-to-end reproduction of the recorded failing run: a third-party image
  // request publishes its archived result as a canonical RELATIVE workbench
  // URL, and a core.code step downstream selects that media by file name. The
  // sandbox only ever sees {filename}, so an unparsed relative URL leaves the
  // list empty and the step fails its output validation.
  const output = await sharp({ create: { width: 12, height: 12, channels: 3, background: "green" } }).png().toBuffer();
  const variable = "TEST_MCP_IMAGE_ARCHIVE_KEY"; const previousKey = process.env[variable];
  process.env[variable] = "mcp-only-image-archive-key";
  t.after(() => { if (previousKey === undefined) delete process.env[variable]; else process.env[variable] = previousKey; });
  let sends = 0;
  const h = await aiHarness(t, { thirdPartyRequest: createThirdPartyJsonRequester({
    async resolve() { return [{ address: "93.184.216.34", family: 4 }]; },
    async send() { sends += 1; return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({ data: [{ b64_json: output.toString("base64") }] })) }; },
  }) });
  const { call } = await connect(t, h.base);
  const sceneId = "mcp-http-archive-url";
  const workflow = {
    name: "第三方生图归档URL闭环",
    inputs: [{ key: "prompt", label: "提示词", type: "textarea", required: true }, { key: "images", label: "图", type: "image_list", required: false }, { key: "model", label: "模型", type: "select", required: true, options: ["gpt-image-2.5-sunburst", "gpt-image-2"], defaultValue: "gpt-image-2.5-sunburst" }],
    steps: [
      // 图编辑：仅在提供了参考图时执行，否则跳过且不调用外部服务。
      { id: "generate", name: "图编辑", kind: "capability", capabilityId: "core.http_request", capabilityVersion: "2",
        capabilityConfig: { url: "https://images.example.net/v1/images/edits", method: "POST", apiKeyEnv: variable, apiKeyHeader: "Authorization", apiKeyPrefix: "Bearer ", bodyFormat: "multipart", timeoutSeconds: 60, retries: 0, multipartImages: [{ inputKey: "input_images", fieldName: "image[]" }], responseImages: { path: "data", base64Field: "b64_json", expectedCount: 1 }, bodyTemplate: { model: "{{model}}", prompt: "{{prompt}}" } },
        inputs: [{ key: "input_images", sourceRef: "input.images", selection: { mode: "all" } }, { key: "prompt", sourceRef: "input.prompt" }, { key: "model", sourceRef: "input.model" }],
        outputs: [{ key: "response", type: "json" }, { key: "status", type: "number" }, { key: "images", type: "image_list" }],
        startCondition: { match: "all", rules: [{ id: "rule_edit", leftRef: "input.images", operator: "is_not_empty", valueSource: "literal", rightValue: "", rightRef: "" }] } },
      // 图生成：没有参考图时执行，返回归档后的相对URL。
      { id: "step_mv1pefbo_2", name: "图生成", kind: "capability", capabilityId: "core.http_request", capabilityVersion: "2",
        capabilityConfig: { url: "https://images.example.net/v1/images/generations", method: "POST", apiKeyEnv: variable, apiKeyHeader: "Authorization", apiKeyPrefix: "Bearer ", bodyFormat: "json", timeoutSeconds: 60, retries: 0, responseImages: { path: "data", base64Field: "b64_json", expectedCount: 1 }, bodyTemplate: { model: "{{model}}", prompt: "{{prompt}}", n: 1, response_format: "b64_json" } },
        inputs: [{ key: "prompt", sourceRef: "input.prompt" }, { key: "model", sourceRef: "input.model" }],
        outputs: [{ key: "response", type: "json" }, { key: "status", type: "number" }, { key: "images", type: "image_list" }],
        startCondition: { match: "all", rules: [{ id: "rule_gen", leftRef: "input.images", operator: "is_empty", valueSource: "literal", rightValue: "", rightRef: "" }] } },
      // 合并结果图片：按filename选择，空列表回退到生成结果。
      { id: "merge_images", name: "合并结果图片", kind: "capability", capabilityId: "core.code", capabilityVersion: "1",
        capabilityConfig: { code: 'const edited = (inputs.edit_images ?? []).map((item) => item.filename);\nconst generated = (inputs.gen_images ?? []).map((item) => item.filename);\nreturn { images: edited.length ? edited : generated };', timeoutMs: 5000 },
        inputs: [{ key: "edit_images", sourceRef: "step.generate.outputs.images", referenceType: "image_list" }, { key: "gen_images", sourceRef: "step.step_mv1pefbo_2.outputs.images", referenceType: "image_list" }],
        outputs: [{ key: "images", type: "image_list" }] },
    ],
    outputs: [{ key: "result", label: "生成结果", type: "image_list", sourceRef: "step.merge_images.outputs.images", selection: { mode: "all" } }, { key: "generated", label: "文生图结果", type: "image_list", sourceRef: "step.step_mv1pefbo_2.outputs.images", selection: { mode: "all" } }],
  };
  const created = await call("create_scene", { scene: { id: sceneId, title: "归档URL闭环" }, workflow }); assert.equal(created.payload.ok, true);
  const draft = (created.payload.data as any).revision;
  const validation = (await call("validate_scene_draft", { sceneId, revision: draft })).payload; assert.equal(validation.ok, true, JSON.stringify(validation));
  const versionId = randomUUID();
  assert.equal((await call("publish_scene", { sceneId, revision: draft, publicationId: versionId })).payload.ok, true);
  // 空图片列表：图编辑跳过，图生成执行，合并步骤必须能按文件名选中归档图片。
  const inputValues = { prompt: "两个人", images: [], model: "gpt-image-2.5-sunburst" };
  assert.equal((await call("prepare_scene", { sceneId, versionId, inputValues })).payload.ok, true);
  assert.equal(sends, 0, "预检不得调用第三方接口");
  const runId = randomUUID();
  assert.equal((await call("submit_scene", { sceneId, versionId, runId, inputValues })).payload.ok, true);
  const done = (await call("wait_run", { runId, timeoutSeconds: 20 })).payload.data as any;
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(sends, 1, "只有图生成步骤调用一次第三方接口");
  const run = (await call("get_run", { runId })).payload.data as any;
  const status = Object.fromEntries(run.steps.map((step: any) => [step.stepId, step.status]));
  assert.equal(status.generate, "skipped"); assert.equal(status.step_mv1pefbo_2, "completed"); assert.equal(status.merge_images, "completed");
  // 归档URL必须保留可用文件名：合并步骤选中同一张图，而不是空列表。
  const generated = (await call("get_step_result", { runId, stepId: "step_mv1pefbo_2", outputKey: "images" })).payload.data as any;
  const archivedUrl = generated.outputs[0].value[0];
  assert.match(archivedUrl, new RegExp("^/api/v1/runs/" + runId + "/media/[A-Za-z0-9._-]+\\.png$"));
  // 选中项保留原URL定位符，因此对外仍是同一归档地址；关键是列表非空，即按文件名选择成功。
  const merged = (await call("get_step_result", { runId, stepId: "merge_images", outputKey: "images" })).payload.data as any;
  assert.equal(merged.outputs[0].value.length, 1);
  assert.deepEqual(merged.outputs[0].value, [archivedUrl]);
  // 最终输出同时暴露合并结果与文生图结果，且指向同一归档媒体。
  assert.equal(run.outputs.length, 2);
  assert.deepEqual(run.outputs.map((item: any) => item.key), ["result", "generated"]);
  assert.equal(run.outputs[0].value.length, 1); assert.equal(run.outputs[1].value.length, 1);
  assert.deepEqual(run.outputs[0].value, [archivedUrl]); assert.deepEqual(run.outputs[1].value, [archivedUrl]);
  // 归档媒体可经鉴权地址读取：HEAD与Range走同一固定版本来源。
  const mediaUrl = generated.outputs[0].mediaReferences[0].url;
  const head = await fetch(h.base + mediaUrl, { method: "HEAD" }); assert.equal(head.status, 200);
  const range = await fetch(h.base + mediaUrl, { headers: { Range: "bytes=0-7" } }); assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), output.subarray(0, 8));
  const mediaExport = await call("get_run_media_export", { runId, outputKey: "result" });
  assert.equal(mediaExport.payload.ok, true);
  assert.equal((mediaExport.payload.data as any).fileCount, 1);
  // 响应丢失对账：同一runId重复提交被拒绝，不重复计费。
  assert.equal((await call("submit_scene", { sceneId, versionId, runId, inputValues })).payload.error?.status, 409);
  assert.equal(sends, 1);
});
