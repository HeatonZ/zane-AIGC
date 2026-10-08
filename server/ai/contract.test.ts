import { AI_FOUNDATION_GUIDE } from "./foundationGuide.js";
import { AI_FOUNDATION_FEATURES } from "./features.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createAiOpenApi } from "./openapi.js";
import { aiOperations } from "./operations.js";
import { AI_OPERATOR_GUIDE } from "./guide.js";

test("AI机器契约：每个MCP工具对应OpenAPI，JSON递归引用全部可解析", () => {
  const api = createAiOpenApi(); const names = new Set<string>();
  for (const operation of aiOperations) {
    assert.ok(!names.has(operation.name)); names.add(operation.name);
    const spec = api.paths[operation.path][operation.method.toLowerCase()] as { operationId: string; responses: Record<string, unknown> };
    assert.equal(spec.operationId, operation.name); assert.ok(spec.responses[String(operation.success)]);
  }
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if ("$ref" in value) { const pointer = String(value.$ref); assert.ok(pointer.startsWith("#/"), pointer); let target: unknown = api; for (const key of pointer.slice(2).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"))) target = (target as Record<string, unknown> | undefined)?.[key]; assert.notEqual(target, undefined, "Unresolved " + pointer); }
    for (const child of Object.values(value)) visit(child);
  };
  visit(api);
  const upload = api.paths["/api/v1/assets/upload"].post as { parameters: Array<{ name: string }> }; assert.ok(!upload.parameters.some(parameter => parameter.name === "filePath")); assert.ok(upload.parameters.some(parameter => parameter.name === "X-File-Name"));
  const body = (api.paths["/api/v1/scenes/{sceneId}/runs"].post as { requestBody: { content: Record<string, { schema: { properties: Record<string, unknown>; required: string[] } }> } }).requestBody.content["application/json"].schema;
  assert.ok(!body.properties.sceneId); assert.ok(body.required.includes("versionId")); assert.ok(body.required.includes("runId"));
});

test("管理员运行响应契约声明提交人快照且普通用户响应不暴露归属", () => {
  const api = createAiOpenApi(); const schemas = api.components.schemas as Record<string, any>;
  assert.deepEqual(schemas.RunSubmitter.required, ["userId", "username", "displayName"]);
  for (const field of ["ownerUserId", "submitter"]) assert.ok(field in schemas.RunSummary.properties);
  assert.equal(schemas.RunSummary.properties.submitter.$ref, "#/components/schemas/RunSubmitter");
  assert.equal(schemas.RunRecord.properties.submitter.$ref, "#/components/schemas/RunSubmitter");
  assert.equal(schemas.RunObservation.properties.submitter.$ref, "#/components/schemas/RunSubmitter");
  const list = (api.paths["/api/v1/runs"].get as any).responses[200].content["application/json"].schema;
  assert.equal(list.$ref, "#/components/schemas/RunPage");
  assert.equal(schemas.RunPage.properties.runs.items.$ref, "#/components/schemas/RunSummary");
  const detail = (api.paths["/api/v1/runs/{runId}"].get as any).responses[200].content["application/json"].schema;
  assert.equal(detail.$ref, "#/components/schemas/RunRecord");
  const wait = (api.paths["/api/v1/runs/{runId}/wait"].get as any).responses[200].content["application/json"].schema;
  assert.equal(wait.$ref, "#/components/schemas/RunObservation");
  const ownRun = schemas.UserRun;
  assert.ok(!("ownerUserId" in ownRun.properties)); assert.ok(!("submitter" in ownRun.properties));
});

test("AI文档同源：操作手册及OpenAPI快照与运行时契约一致", async () => {
  assert.equal((await readFile("docs/ai-operator.md", "utf8")).replace(/\r\n/g, "\n"), AI_OPERATOR_GUIDE);
  assert.deepEqual(JSON.parse(await readFile("docs/ai-openapi.json", "utf8")), createAiOpenApi());
});

test("AI契约接受 Hermes 单项反馈和退回意见，拒绝空文本和伪造快照", () => {
  const preview = aiOperations.find(operation => operation.name === "preview_rerun")!.schema;
  const sourceRunId = "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b";
  assert.equal(preview.safeParse({ sourceRunId, changes: { feedback: [{ stepId: "writer", itemIndex: 1, message: "加强冲突" }] } }).success, true);
  assert.equal(preview.safeParse({ sourceRunId, changes: { feedback: [{ stepId: "writer", message: " " }] } }).success, false);
  assert.equal(preview.safeParse({ sourceRunId, changes: { feedback: [{ stepId: "writer", message: "意见", originalOutputs: {} }] } }).success, false);
  const review = aiOperations.find(operation => operation.name === "review_run")!.schema;
  assert.equal(review.safeParse({ runId: sourceRunId, reviewId: "review", action: "redo", feedback: "缩短开头" }).success, true);
});


test("AI基础能力覆盖门禁：每个功能的工具存在，每个工具都有功能归属", () => {
  const operations = new Set(aiOperations.map(operation => operation.name)); const covered = new Set<string>(); const ids = new Set<string>();
  for (const feature of AI_FOUNDATION_FEATURES) {
    assert.ok(!ids.has(feature.id), "重复功能ID：" + feature.id); ids.add(feature.id); assert.ok(feature.description); assert.ok(feature.operations.length);
    for (const name of feature.operations) { assert.ok(operations.has(name), feature.id + "缺少工具：" + name); covered.add(name); }
  }
  for (const operation of aiOperations) assert.ok(covered.has(operation.name), "新工具必须同步登记AI功能矩阵：" + operation.name);
  for (const name of ["create_scene", "get_scene_draft", "update_scene_draft", "validate_scene_draft", "publish_scene", "restore_scene_draft", "delete_scene", "list_option_presets", "save_option_preset", "delete_option_preset", "get_run_outputs", "get_step_result"]) assert.ok(operations.has(name));
});

test("AI基础能力文档由功能矩阵生成，不允许手册与实际工具漂移", async () => {
  assert.equal((await readFile("docs/ai-foundation.md", "utf8")).replace(/\r\n/g, "\n"), AI_FOUNDATION_GUIDE);
});


test("发布OpenAPI同时声明首次201和重复回执200", () => {
  const responses = (createAiOpenApi().paths["/api/v1/scenes/{sceneId}/publish"].post as { responses: Record<string, { content: unknown }> }).responses;
  assert.ok(responses["201"]); assert.ok(responses["200"]); assert.deepEqual(responses["201"].content, responses["200"].content);
});


test("预设读写契约分离：读模型允许revision，写模型拒绝派生字段", () => {
  const api = createAiOpenApi(); const preset = api.components.schemas.OptionPreset as { properties: Record<string, unknown> };
  assert.ok(!("revision" in preset.properties)); assert.ok(!("usedBySceneIds" in preset.properties));
  const save = aiOperations.find(operation => operation.name === "save_option_preset")!.schema;
  assert.equal(save.safeParse({ preset: { id: "p", name: "选项", options: ["a"], revision: "a".repeat(64) } }).success, false);
  const responses = (api.paths["/api/v1/option-presets"].post as { responses: Record<string, { content: Record<string, { schema: { $ref: string } }> }> }).responses;
  assert.equal(responses["200"].content["application/json"].schema.$ref, "#/components/schemas/OptionPresetMutation");
});


test("基础优先目录请求/响应契约包含tier分页与通用媒体值schema", () => {
  const operation = aiOperations.find((item) => item.name === "list_capabilities")!;
  assert.equal(operation.effect, "read"); assert.deepEqual(operation.schema.parse({}), { tier: "all", limit: 50 });
  assert.equal(operation.schema.safeParse({ tier: "basic", limit: 1 }).success, true); assert.equal(operation.schema.safeParse({ tier: "unknown" }).success, false);
  const api = createAiOpenApi();
  assert.ok(api.components.schemas.CapabilityCatalog); assert.ok(api.components.schemas.MediaReferenceGroups); assert.ok(api.components.schemas.ImageLayout);
  const response = (api.paths["/api/v1/capabilities"].get as { responses: Record<string, any> }).responses["200"].content["application/json"].schema;
  assert.equal(response.$ref, "#/components/schemas/CapabilityCatalog");
});

test("认证HTTP契约区分公共初始化/登录与需身份业务；不假装存在密码MCP工具", () => {
  const api = createAiOpenApi();
  for (const [path, method] of [["/api/auth/status", "get"], ["/api/auth/setup", "post"], ["/api/auth/login", "post"]]) {
    const operation = api.paths[path][method] as Record<string, unknown>;
    assert.deepEqual(operation.security, []);
    assert.equal(operation["x-mcp-tool"], undefined);
  }
  const logout = api.paths["/api/v1/self/logout"].post as Record<string, unknown>;
  assert.equal(logout["x-access-role"], "authenticated");
  assert.equal(logout["x-mcp-tool"], undefined);
  assert.ok(Array.isArray(logout.security));
  assert.ok(!aiOperations.some(operation => /auth_(login|setup)/.test(operation.name)));
});


test("素材AI契约：稳定新建/追加版本约束，新字段与分页响应同源", () => {
  const upload = aiOperations.find(operation => operation.name === "upload_asset")!.schema;
  const createId = "00000000-0000-4000-8000-000000000111";
  const metadata = { filePath: "C:/temporary/hero.png", kind: "image" };
  assert.equal(upload.safeParse(metadata).success, false);
  assert.equal(upload.safeParse({ ...metadata, createId, description: "雨夜角色", group: "第一集", tags: ["雨夜"] }).success, true);
  assert.equal(upload.safeParse({ ...metadata, assetId: createId, revision: 1 }).success, true);
  for (const extra of [{ createId, assetId: createId, revision: 1 }, { assetId: createId }, { createId, revision: 1 }, { createId, ownerUserId: "spoof" }, { createId, description: "x".repeat(4001) }]) assert.equal(upload.safeParse({ ...metadata, ...extra }).success, false);
  const query = aiOperations.find(operation => operation.name === "list_assets")!.schema; const defaults = query.parse({}); assert.equal(defaults.limit, 24); assert.equal(defaults.archived, false);
  const api = createAiOpenApi(); const uploadHttp = api.paths["/api/v1/assets/upload"].post as { parameters: Array<{ name: string }> };
  for (const name of ["createId", "description", "group", "tags"]) assert.ok(uploadHttp.parameters.some(parameter => parameter.name === name));
  const responses = (api.paths["/api/v1/assets"].get as { responses: Record<string, { content: { "application/json": { schema: { $ref: string } } } }> }).responses;
  assert.equal(responses["200"].content["application/json"].schema.$ref, "#/components/schemas/AssetPage");
  assert.ok(api.paths["/api/v1/assets/{assetId}/versions"].get); assert.ok(api.paths["/api/v1/assets/{assetId}/versions/{version}"].get);
});

test("流程diff工具与HTTP响应机器契约同源，只读且值读取要求差异revision", () => {
  const api = createAiOpenApi();
  for (const name of ["get_scene_draft_diff", "get_scene_draft_diff_value"]) {
    const op = aiOperations.find(operation => operation.name === name)!;
    assert.equal(op.effect, "read"); assert.equal(op.access ?? "admin", "admin");
    const response = (api.paths[op.path].get as any).responses["200"].content["application/json"].schema;
    assert.ok(response.$ref.endsWith(name.endsWith("_value") ? "/SceneDiffValuePage" : "/SceneDiffPage"));
  }
  const query = aiOperations.find(operation => operation.name === "get_scene_draft_diff")!.schema;
  assert.equal(query.safeParse({ sceneId: "demo", limit: 1, valueLimit: 2, contentHash: "deadbeef" }).success, true);
  assert.equal(query.safeParse({ sceneId: "demo", revision: "bad" }).success, false);
  assert.equal(query.safeParse({ sceneId: "demo", limit: 0 }).success, false);
  const value = aiOperations.find(operation => operation.name === "get_scene_draft_diff_value")!.schema;
  assert.equal(value.safeParse({ sceneId: "demo", changeId: "c".repeat(24), side: "after" }).success, false);
  assert.equal(value.safeParse({ sceneId: "demo", revision: "a".repeat(64), changeId: "c".repeat(24), side: "after", offset: 2, limit: 2 }).success, true);
});

test("收藏机器契约是显式布尔目标值且必须带revision，拒绝伪造归属；HTTP输出有isFavorite和版本", () => {
  for (const name of ["set_task_draft_favorite", "set_own_draft_favorite"]) {
    const operation = aiOperations.find(item => item.name === name)!;
    assert.equal(operation.effect, "write");
    assert.equal(operation.schema.safeParse({ draftId: "stable-id", revision: 1, isFavorite: true }).success, true);
    for (const args of [{ draftId: "stable-id", revision: 1 }, { draftId: "stable-id", isFavorite: true }, { draftId: "stable-id", revision: 0, isFavorite: true }, { draftId: "stable-id", revision: 1, isFavorite: "true" }, { draftId: "stable-id", revision: 1, isFavorite: false, userId: "forged" }]) assert.equal(operation.schema.safeParse(args).success, false, JSON.stringify(args));
  }
  const api = createAiOpenApi();
  for (const name of ["TaskDraft", "UserDraft"]) assert.ok((api.components.schemas[name] as {properties:Record<string,unknown>}).properties.isFavorite);
  assert.equal(aiOperations.find(item => item.name === "set_own_draft_favorite")!.access, "authenticated");
});


test("系统反馈机器契约与普通审核边界：唯一原子工具、默认类型、owner不可伪造和明确返回schema", () => {
  const input = { feedbackId: "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b", title: "问题", description: "详情" };
  const submit = aiOperations.find(operation => operation.name === "submit_system_feedback")!;
  assert.equal(submit.schema.parse(input).category, "bug"); assert.equal(submit.effect, "write"); assert.equal(submit.access, "authenticated");
  assert.equal(submit.schema.safeParse({ ...input, userId: "fake" }).success, false);
  const handle = aiOperations.find(operation => operation.name === "handle_system_feedback")!;
  assert.equal(handle.access ?? "admin", "admin"); assert.equal(handle.effect, "write");
  assert.equal(handle.schema.safeParse({ feedbackId: input.feedbackId, status: "resolved", reply: "回复" }).success, false);
  const ownReview = aiOperations.find(operation => operation.name === "review_own_run")!.schema;
  assert.equal(ownReview.safeParse({ runId: input.feedbackId, reviewId: "review", action: "redo" }).success, true);
  assert.equal(ownReview.safeParse({ runId: input.feedbackId, reviewId: "review", action: "redo", feedback: "不允许直接进入Agent" }).success, false);
  const api = createAiOpenApi();
  assert.equal(((api.paths[submit.path].post as any).responses["201"].content["application/json"].schema).$ref, "#/components/schemas/SystemFeedbackEnvelope");
  assert.ok(api.components.schemas.SystemFeedbackPage); assert.ok(api.components.schemas.SystemFeedbackEnvelope);
});


test("AI草稿媒体引用类型字段显式可操作，拒绝未声明类型与伪造配置", () => {
  const operation = aiOperations.find(item => item.name === "update_scene_draft")!;
  const base = { sceneId: "scene", revision: "a".repeat(64), workflow: { inputs: [], outputs: [], steps: [{ id: "step", name: "step", kind: "hermes", inputs: [{ key: "refs", sourceRef: "iteration.item.references.images", referenceType: "image_list" }] }] } };
  assert.equal(operation.schema.safeParse(base).success, true);
  for (const referenceType of ["image", "json", "unknown"]) {
    const invalid = structuredClone(base); invalid.workflow.steps[0].inputs[0].referenceType = referenceType;
    assert.equal(operation.schema.safeParse(invalid).success, false);
  }
});

test("AI机器契约公开静态开关、命名动态标量与连续序号配置", () => {
  const api = createAiOpenApi() as Record<string, any>;
  assert.equal(api["x-comfy-static-switch"].version, 1);
  assert.equal(api["x-comfy-static-switch"].nodeType, "ComfySwitchNode");
  assert.match(api["x-comfy-static-switch"].emptyOptionalVideo, /clears/);
  assert.match(aiOperations.find(operation => operation.name === "submit_scene")!.description, /x-comfy-static-switch/);
  assert.match(aiOperations.find(operation => operation.name === "update_scene_draft")!.description, /ordinalField/);
  assert.ok(api.components.schemas.DataZipConfig.properties.ordinalField);
  assert.match(AI_OPERATOR_GUIDE, /Writer一次输出制作级storyboard\/shots（不含prompt）/);
  assert.match(AI_OPERATOR_GUIDE, /AIXG一次批量/);
  assert.match(AI_OPERATOR_GUIDE, /共7步、两次AI调用/);
});


test("固定音色上传契约经既有HTTP/MCP入口发现，预检无生成", () => {
  const api = createAiOpenApi();
  const audio = api["x-asset-media-execution"].audioConsumers;
  assert.equal(audio.uploadLimitBytes, 100_000_000);
  assert.equal(audio.previewFallback, false);
  assert.equal(audio.uploadRoute, "/upload/image");
  assert.equal(audio.uploadFormField, "image");
  assert.equal(audio.failure, "fail_before_prompt_submission_no_automatic_retry");
  assert.deepEqual(api.components.schemas.MediaExecutionAccess.const, api["x-asset-media-execution"]);
  assert.match(aiOperations.find(operation => operation.name === "submit_scene")!.description, /audioConsumers/);
  assert.match(AI_OPERATOR_GUIDE, /固定音色的基础ComfyUI上传/);
  assert.ok(AI_FOUNDATION_FEATURES.find(feature => feature.id === "asset-execution-access")!.description.includes("audio_list"));
});
