import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { aiHarness } from "../testing/aiSupport.js";
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
