import "./smoke-auth.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const withHermes = process.argv.includes("--hermes");
const hermesEnvironment = ["ZANE_HERMES_PYTHON", "ZANE_HERMES_SOURCE", "ZANE_HERMES_PROFILE_HOME"];
if (withHermes && hermesEnvironment.some(key => !process.env[key])) throw new Error("Hermes smoke requires " + hermesEnvironment.join(", ") + "; it never starts chat/gateway.");
const temporary = await mkdtemp(path.join(os.tmpdir(), "zane-ai-smoke-"));
const project = path.join(temporary, "project"); await mkdir(project);
const client = new Client({ name: "zane-ai-smoke", version: "1.0.0" });
let child; let exited; let doctor; let doctorExited; let hermesDoctor; let hermesDoctorExited; let logs = "";
const bounded = async (promise, milliseconds = 20000) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("AI smoke timeout\n" + logs.slice(-4000))), milliseconds); })]); } finally { clearTimeout(timer); } };
try {
  child = spawn(process.execPath, [path.join(root, "dist-server/index.js"), "--production"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "production", API_HOST: "127.0.0.1", API_PORT: "0", APP_DATA_DIR: path.join(temporary, "data"), ZANE_PROJECT_DIR: project, HERMES_HOME: path.join(temporary, "no-hermes"), COMFYUI_BASE_URL: "http://127.0.0.1:1", ZANE_SHUTDOWN_TIMEOUT_MS: "1000" } });
  exited = new Promise(resolve => child.once("exit", resolve));
  const base = await bounded(new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", code => reject(new Error("Isolated backend exited " + code + "\n" + logs)));
    child.stderr.on("data", chunk => { logs += chunk; }); child.stdout.on("data", chunk => { logs += chunk; const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs); if (match) resolve(match[1]); });
  }));
  let ready = false;
  for (let i = 0; i < 50; i++) { if ((await fetch(base + "/api/ready", { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } await new Promise(resolve => setTimeout(resolve, 50)); } assert.ok(ready, "worker ready");
  const scene = { id: "ai-smoke", title: "AI隔离冒烟", summary: "只执行本地条件节点" };
  const condition = (id, review) => ({ id, name: id, kind: "control", review: { enabled: review, instruction: "确认冒烟结果" }, outputs: [{ key: "result", type: "boolean" }], control: { type: "condition", match: "all", rules: [{ id: "rule", leftRef: "input.flag", operator: "equals", valueSource: "literal", rightValue: "true", rightRef: "" }] } });
  const workflow = { sceneId: scene.id, name: scene.title, inputs: [{ key: "flag", type: "boolean", required: true, defaultValue: true }], steps: [condition("check", true), condition("after-review", false)], outputs: [{ key: "result", type: "boolean", sourceRef: "step.after-review.outputs.result" }] };
  const workspace = { format: "zane-studio.workspace/v1", scenes: [scene], workflows: { [scene.id]: workflow }, optionPresets: [], drafts: [], sceneVersions: { [scene.id]: { publishedVersionId: "smoke-version", versions: [{ id: "smoke-version", version: "deadbeef", publishedAt: new Date().toISOString(), scene, workflow, optionPresets: [] }] } } };
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist-server/mcp/index.js")], cwd: root, env: { ...process.env, ZANE_BASE_URL: base }, stderr: "pipe" }); transport.stderr?.on("data", chunk => { logs += chunk; });
  await bounded(client.connect(transport));
  const { aiOperations, AI_CONTRACT_VERSION } = await import("../dist-server/ai/operations.js");
  const tools = await client.listTools(); assert.equal(tools.tools.length, aiOperations.length);
  const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError && result.structuredContent?.ok, name + ": " + JSON.stringify(result)); return result.structuredContent.data; };
  // wait_run may legitimately time out while a slow Windows disk persists the
  // transition. Observe the same ID again; never resubmit or approve on timeout.
  const waitForPause = async (runId) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const observed = await call("wait_run", { runId, timeoutSeconds: 5 });
      if (!["queued", "preparing", "running"].includes(observed.status)) return observed;
      assert.equal(observed.timedOut, true, "active wait response must explicitly time out");
    }
    assert.fail("Isolated run did not reach review or terminal state within 30s: " + runId);
  };
  // A fresh service has no client/default scenes. Empty initialization is shared
  // across HTTP and real MCP; a later initializer can never overwrite it.
  const absentStatus = await call("get_workspace_status");
  assert.equal(absentStatus.initialized, false); assert.equal(absentStatus.workspaceRevision, null);
  const absentCatalog = await call("list_scenes");
  assert.equal(absentCatalog.total, 0); assert.deepEqual(absentCatalog.scenes, []);
  const emptyWorkspace = { format: "zane-studio.workspace/v1", scenes: [], workflows: {}, optionPresets: [], drafts: [], sceneVersions: {} };
  const emptyInit = await call("initialize_workspace", emptyWorkspace);
  assert.equal(emptyInit.created, true); assert.deepEqual(emptyInit.workspace.scenes, []);
  const initialized = await fetch(base + "/api/workspace/initialize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(workspace) });
  assert.equal(initialized.status, 200);
  const ignoredLegacyInitializer = await initialized.json();
  assert.equal(ignoredLegacyInitializer.created, false); assert.deepEqual(ignoredLegacyInitializer.workspace, emptyInit.workspace);
  assert.deepEqual((await call("get_workspace")).workspace, emptyInit.workspace);
  assert.equal((await call("list_scenes")).total, 0);
  // Only this explicit shared-service write provisions the fixture catalog.
  await call("merge_workspace", { base: emptyInit.workspace, workspace });
  // Task draft favorites: compiled stdio MCP -> HTTP -> the existing SQLite authority. No model calls.
  const draftBase = (await call("get_workspace")).workspace;
  const draftFixture = (id, createdAt) => ({ id, sceneId: scene.id, title: id, summary: "复用输入", inputValues: { flag: true }, status: "draft", createdAt });
  await call("merge_workspace", { base: draftBase, workspace: { ...draftBase, drafts: [draftFixture("favorite-old", "2026-09-01T00:00:00.000Z"), draftFixture("favorite-new", "2026-10-05T00:00:00.000Z")] } });
  const draftRead = await call("get_task_draft", { draftId: "favorite-old" }); assert.equal(draftRead.draft.isFavorite, false);
  const draftPage = await call("list_task_drafts", { limit: 1 }); assert.equal(draftPage.items[0].id, "favorite-new");
  // Ignore the mutation receipt and reconcile using the saved original ID.
  await call("set_task_draft_favorite", { draftId: "favorite-old", revision: draftRead.revision, isFavorite: true });
  const favoriteRead = await call("get_task_draft", { draftId: "favorite-old" }); assert.equal(favoriteRead.draft.isFavorite, true); assert.equal(favoriteRead.draft.createdAt, draftRead.draft.createdAt); assert.deepEqual(favoriteRead.draft.inputValues, draftRead.draft.inputValues);
  assert.equal((await (await fetch(base + "/api/v1/task-drafts/favorite-old")).json()).draft.isFavorite, true);
  assert.equal((await call("list_task_drafts", { limit: 1 })).items[0].id, "favorite-old");
  const changedDraftPage = await client.callTool({ name: "list_task_drafts", arguments: { cursor: draftPage.nextCursor } }); assert.equal(changedDraftPage.structuredContent.error.code, "ACCESS_PAGE_CHANGED");
  const staleFavorite = await client.callTool({ name: "set_task_draft_favorite", arguments: { draftId: "favorite-old", revision: draftRead.revision, isFavorite: false } }); assert.equal(staleFavorite.structuredContent.error.code, "DRAFT_REVISION_CONFLICT");
  await call("set_task_draft_favorite", { draftId: "favorite-old", revision: favoriteRead.revision, isFavorite: false }); assert.equal((await call("list_task_drafts", { limit: 1 })).items[0].id, "favorite-new");
  const ownFavoriteId = randomUUID();
  const ownCreated = await call("save_own_draft", { draftId: ownFavoriteId, revision: 0, sceneId: scene.id, versionId: "smoke-version", title: "本人常用输入", inputValues: { flag: true } });
  const ownFavorite = await call("set_own_draft_favorite", { draftId: ownFavoriteId, revision: ownCreated.draft.revision, isFavorite: true }); assert.equal(ownFavorite.draft.isFavorite, true); assert.equal(ownFavorite.draft.updatedAt, ownCreated.draft.updatedAt);
  const ownEdited = await call("save_own_draft", { draftId: ownFavoriteId, revision: ownFavorite.draft.revision, sceneId: scene.id, versionId: "smoke-version", title: "保留收藏", inputValues: { flag: false } }); assert.equal(ownEdited.draft.isFavorite, true);
  assert.equal((await call("list_own_drafts", { limit: 1 })).items[0].isFavorite, true);
  await call("set_own_draft_favorite", { draftId: ownFavoriteId, revision: ownEdited.draft.revision, isFavorite: false }); assert.equal((await call("get_own_draft", { draftId: ownFavoriteId })).draft.isFavorite, false);
  console.log("Task draft favorites MCP acceptance passed: shared SQLite + explicit true/false + preserved content/time + edit retention + pagination invalidation + stale revision + lost receipt reconciliation; no models called.");
  const basicCatalog = await call("list_capabilities", { limit: 1 }); assert.equal(basicCatalog.capabilities.length, 1); assert.ok(basicCatalog.hasMore && basicCatalog.nextCursor); assert.equal(basicCatalog.selectionPolicy.sceneSpecificLogic, "core.code");
  const nextBasics = await call("list_capabilities", { limit: 100, cursor: basicCatalog.nextCursor }); assert.equal(nextBasics.revision, basicCatalog.revision); assert.ok(nextBasics.capabilities.some(item => item.id === "media.image_layout" && item.inputs.some(input => input.key === "layout" && input.valueSchema))); assert.ok(nextBasics.capabilities.some(item => item.id === "media.select_references"));
  assert.equal((await call("get_workbench")).contractVersion, AI_CONTRACT_VERSION); assert.equal((await call("list_scenes")).scenes[0].sceneId, scene.id);
  await client.readResource({ uri: "zane://guide" }); const schema = await client.readResource({ uri: "zane://openapi" }); assert.equal(JSON.parse(schema.contents[0].text).openapi, "3.1.0");
  const selected = await call("get_scene", { sceneId: scene.id }); const preparation = await call("prepare_scene", { sceneId: scene.id, versionId: selected.versionId, inputValues: {} }); assert.equal(preparation.externalServicesChecked, false); assert.deepEqual(preparation.inputValues, { flag: true }); assert.deepEqual(preparation.boundaries.externalSteps, []);
  const runId = randomUUID(); const input = { sceneId: scene.id, versionId: selected.versionId, inputValues: {}, runId };
  await call("submit_scene", input); const waiting = await waitForPause(runId); assert.equal(waiting.status, "waiting"); assert.equal(waiting.nextAction, "review");
  const duplicate = await client.callTool({ name: "submit_scene", arguments: input }); assert.equal(duplicate.isError, true); assert.equal(duplicate.structuredContent.error.code, "RUN_ALREADY_EXISTS");
  const decision = { runId, reviewId: waiting.pendingReview.id, action: "approve" }; await call("review_run", decision); const observed = await waitForPause(runId); assert.equal(observed.status, "completed");
  const done = await call("get_run", { runId }); assert.equal(done.outputs[0].value, true); assert.equal(done.workflow.publishedScene.versionId, "smoke-version");
  const stale = await client.callTool({ name: "review_run", arguments: decision }); assert.equal(stale.structuredContent.error.code, "REVIEW_CONFLICT");
  const changes = { rerunSteps: [{ stepId: "after-review" }] }; const preview = await call("preview_rerun", { sourceRunId: runId, changes }); assert.deepEqual(preview.steps.map(step => step.action), ["reuse", "run"]);
  const rerunId = randomUUID(); await call("rerun", { sourceRunId: runId, runId: rerunId, changes }); assert.equal((await waitForPause(rerunId)).status, "completed");
  const events = await call("get_run_events", { runId, after: 0, limit: 1 }); assert.equal(events.events.length, 1); assert.equal(events.hasMore, true);
  assert.equal((await call("list_runs")).runs.length, 2);
  // Exercise the new foundation using compiled backend + real stdio, without whole-workspace writes.
  const authorityStatus = await call("get_workspace_status");
  const uiWorkspace = await (await fetch(base + "/api/workspace")).json();
  assert.equal(authorityStatus.authority, "sqlite"); assert.equal(authorityStatus.workspaceRevision, uiWorkspace.workspace.revision);
  assert.equal(authorityStatus.catalogView, "draft"); assert.equal(authorityStatus.executionView, "published");
  const foundationSceneId = "ai-foundation-smoke";
  const foundationWorkflow = { name: "AI文生视频流程", inputs: [{ key: "flag", type: "boolean", required: true, defaultValue: true }], steps: [condition("foundation-check", false)], outputs: [{ key: "result", type: "boolean", sourceRef: "step.foundation-check.outputs.result" }] };
  const created = await call("create_scene", { scene: { id: foundationSceneId, title: "基础能力隔离冒烟" }, workflow: foundationWorkflow });
  assert.equal(created.publishedVersionId, null);
  const draft = await call("get_scene_draft", { sceneId: foundationSceneId });
  const scenePage = await call("list_scenes", { limit: 1 });
  assert.equal(scenePage.scenes.length, 1); assert.equal(scenePage.hasMore, true);
  const sceneNext = await call("list_scenes", { limit: 1, cursor: scenePage.nextCursor });
  assert.equal(sceneNext.workspaceRevision, scenePage.workspaceRevision); assert.equal(sceneNext.scenes[0].sceneId, foundationSceneId);
  assert.equal(sceneNext.scenes[0].draftRevision, draft.revision); assert.equal(sceneNext.scenes[0].draftMatchesPublished, false); assert.equal(sceneNext.scenes[0].publishedTitle, null);
  const invalidScenePage = await client.callTool({ name: "list_scenes", arguments: { limit: 0 } }); assert.equal(invalidScenePage.isError, true);
  assert.equal(draft.view, "draft");
  assert.equal(draft.revision, created.revision); assert.ok(!("scenes" in draft));
  const edited = await call("update_scene_draft", { sceneId: foundationSceneId, revision: draft.revision, workflow: { ...draft.workflow, inputs: [{ ...draft.workflow.inputs[0], defaultValue: false }] } });
  await call("validate_scene_draft", { sceneId: foundationSceneId, revision: edited.revision });
  const publicationId = randomUUID();
  const publishArgs = { sceneId: foundationSceneId, revision: edited.revision, publicationId };
  const publication = await call("publish_scene", publishArgs);
  const changedPage = await client.callTool({ name: "list_scenes", arguments: { cursor: scenePage.nextCursor } });
  assert.equal(changedPage.structuredContent.error.code, "SCENE_PAGE_CHANGED");
  const uiAfterPublication = (await (await fetch(base + "/api/workspace")).json()).workspace;
  const publishedCatalog = await call("list_scenes", { limit: 200 });
  assert.equal(publishedCatalog.workspaceRevision, uiAfterPublication.revision);
  assert.deepEqual(publishedCatalog.scenes.map(item => item.sceneId), uiAfterPublication.scenes.map(item => item.id));
  const catalogItem = publishedCatalog.scenes.find(item => item.sceneId === foundationSceneId);
  assert.equal(catalogItem.draftMatchesPublished, true); assert.equal(catalogItem.publishedTitle, uiAfterPublication.sceneVersions[foundationSceneId].versions.at(-1).scene.title);
  assert.equal((await call("get_scene", { sceneId: foundationSceneId, versionId: publicationId })).view, "published");
  assert.equal(publication.versionId, publicationId); assert.equal(publication.created, true);
  assert.equal((await call("publish_scene", publishArgs)).created, false);
  const published = await call("get_scene", { sceneId: foundationSceneId, versionId: publicationId });
  assert.equal(published.inputSchema.properties.flag.type, "boolean"); assert.equal(published.inputDefaults.flag, false); assert.equal(published.inputExamples[0].syntacticallyComplete, true);
  const latestDraft = await call("get_scene_draft", { sceneId: foundationSceneId });
  const changedDraft = await call("update_scene_draft", { sceneId: foundationSceneId, revision: latestDraft.revision, workflow: { ...latestDraft.workflow, inputs: [{ ...latestDraft.workflow.inputs[0], defaultValue: true }] } });
  // Compiled stdio tools exercise new diff fields through the authoritative service.
  const diff = await call("get_scene_draft_diff", { sceneId: foundationSceneId, contentHash: changedDraft.contentHash, limit: 1, valueLimit: 2 });
  assert.equal(diff.baseline.versionId, publicationId); assert.equal(diff.total, 1); assert.equal(diff.changes[0].path, "/workflow/inputs/flag/defaultValue");
  assert.equal(diff.changes[0].after.text, "tr"); assert.equal(diff.changes[0].after.complete, false);
  const diffValue = await call("get_scene_draft_diff_value", { sceneId: foundationSceneId, revision: diff.revision, changeId: diff.changes[0].changeId, side: "after", offset: diff.changes[0].after.nextOffset, limit: 2 });
  assert.equal(diff.changes[0].after.text + diffValue.value.text, "true"); assert.equal(diffValue.value.complete, true);
  assert.deepEqual(await call("get_scene_draft_diff", { sceneId: foundationSceneId, revision: diff.revision, contentHash: changedDraft.contentHash, limit: 1, valueLimit: 2 }), diff);
  const prepared = await call("prepare_scene", { sceneId: foundationSceneId, versionId: publicationId, inputValues: {} });
  assert.equal(prepared.inputValues.flag, false); // Later draft edits cannot change a fixed publication.
  const foundationRunId = randomUUID();
  await call("submit_scene", { sceneId: foundationSceneId, versionId: publicationId, runId: foundationRunId, inputValues: {} });
  assert.equal((await waitForPause(foundationRunId)).status, "completed");
  const outputs = await call("get_run_outputs", { runId: foundationRunId, outputKey: "result" });
  assert.equal(outputs.outputs[0].value, false); assert.equal(outputs.outputs[0].valuePage.complete, true); assert.ok(!("workflow" in outputs));
  const stepOutput = await call("get_step_result", { runId: foundationRunId, stepId: "foundation-check", outputKey: "result" });
  assert.equal(stepOutput.outputs[0].value, false); assert.ok(!("inputValues" in stepOutput));
  const restored = await call("restore_scene_draft", { sceneId: foundationSceneId, revision: changedDraft.revision, versionId: publicationId });
  assert.equal(restored.workflow.inputs[0].defaultValue, false);
  assert.equal((await call("get_scene_draft_diff", { sceneId: foundationSceneId })).hasChanges, false);
  const staleDiff = await client.callTool({ name: "get_scene_draft_diff", arguments: { sceneId: foundationSceneId, revision: diff.revision } }); assert.equal(staleDiff.structuredContent.error.code, "SCENE_DIFF_CHANGED");
  // Display titles come from the chosen scene snapshot, never the independent workflow name.
  assert.equal(published.scene.title, "基础能力隔离冒烟");
  assert.equal(published.workflow.name, "AI文生视频流程");
  const renamed = await call("update_scene_draft", { sceneId: foundationSceneId, revision: restored.revision, scene: { ...restored.scene, title: "AI参考生视频（标题回归）" } });
  assert.equal(renamed.workflow.name, published.workflow.name);
  const invalidTitle = await client.callTool({ name: "update_scene_draft", arguments: { sceneId: foundationSceneId, revision: renamed.revision, scene: { ...renamed.scene, title: 42 } } });
  assert.equal(invalidTitle.isError, true);
  const staleTitle = await client.callTool({ name: "update_scene_draft", arguments: { sceneId: foundationSceneId, revision: restored.revision, scene: restored.scene } });
  assert.equal(staleTitle.structuredContent.error.code, "RESOURCE_REVISION_CONFLICT");
  const renamedItem = (await call("list_scenes", { limit: 200 })).scenes.find(item => item.sceneId === foundationSceneId);
  assert.equal(renamedItem.title, renamed.scene.title); assert.equal(renamedItem.publishedTitle, published.scene.title);
  assert.equal((await call("get_scene", { sceneId: foundationSceneId })).scene.title, published.scene.title);
  const renamedPublishArgs = { sceneId: foundationSceneId, revision: renamed.revision, publicationId: randomUUID() };
  const renamedPublication = await call("publish_scene", renamedPublishArgs);
  assert.equal((await call("get_scene", { sceneId: foundationSceneId })).scene.title, renamed.scene.title);
  const historicalTitle = await call("get_scene", { sceneId: foundationSceneId, versionId: publicationId });
  assert.deepEqual(historicalTitle.scene, published.scene); assert.deepEqual(historicalTitle.workflow, published.workflow);
  assert.equal((await call("get_run", { runId: foundationRunId })).workflowName, published.workflow.name);
  // Simulate a lost publish receipt: reconcile the original ID without changing the publication pointer.
  assert.equal((await call("get_scene", { sceneId: foundationSceneId, versionId: renamedPublishArgs.publicationId })).versionId, renamedPublication.versionId);
  assert.equal((await call("publish_scene", renamedPublishArgs)).created, false);
  const titleDraft = await call("get_scene_draft", { sceneId: foundationSceneId });
  await call("delete_scene", { sceneId: foundationSceneId, revision: titleDraft.revision });
  assert.equal((await call("get_run", { runId: foundationRunId })).status, "completed");
  const preset = await call("save_option_preset", { preset: { id: "foundation-options", name: "选项", options: ["本地测试"] } });
  const presetPage = await call("list_option_presets", { q: "foundation-options", limit: 1 });
  assert.equal(presetPage.presets[0].revision, preset.preset.revision);
  await call("delete_option_preset", { presetId: "foundation-options", revision: preset.preset.revision });
  // Qwen dialect config: real stdio MCP -> shared services/SQLite, without model execution.
  const { qwenImage21PromptStep, QWEN_IMAGE_21_WRITER_REF, QWEN_IMAGE_21_PROMPT_REF } = await import("../dist-server/domain/qwenImagePrompt.js");
  const qwenPackage = JSON.parse(await readFile(path.join(root, "examples/scenes/image-to-image-qwen21.json"), "utf8"));
  const qwenSceneId = "qwen-image-dialect-smoke";
  // Start from the previously-published two-step/eight-field configuration.
  // The MCP edit must remove legacy workflow fields and a seed binding that is now randomized in ComfyUI.
  const legacyGenerator = structuredClone(qwenPackage.workflow.steps[2]);
  legacyGenerator.inputs.push(
    { key: "negative_prompt", label: "反向提示词", sourceRef: "input.negative_prompt" },
    { key: "steps", label: "生成步数", sourceRef: "input.steps" },
    { key: "input_9", label: "空图", sourceRef: "input.empty" },
  );
  legacyGenerator.comfyui.bindings = legacyGenerator.comfyui.bindings.filter(binding => binding.key !== "configured_canvas");
  legacyGenerator.comfyui.bindings.push(
    { key: "negative_prompt", label: "反向提示词", direction: "input", nodeId: "471", property: "negative_prompt", type: "text", sourceRef: "input.negative_prompt", required: false },
    { key: "steps", label: "生成步数", direction: "input", nodeId: "476", property: "steps", type: "number", sourceRef: "input.steps", required: false },
    { key: "input_9", label: "空图", direction: "input", nodeId: "479", property: "switch", type: "boolean", sourceRef: "input.empty", required: false },
  );
  const directWorkflow = {
    ...structuredClone(qwenPackage.workflow), sceneId: qwenSceneId,
    inputs: [...structuredClone(qwenPackage.workflow.inputs),
      { key: "negative_prompt", label: "反向提示词", type: "textarea", required: false },
      { key: "steps", label: "生成步数", type: "number", required: false },
      { key: "empty", label: "空图", type: "boolean", required: false },
    ], steps: [qwenImage21PromptStep(), legacyGenerator],
  };
  const qwenCreated = await call("create_scene", { scene: { ...qwenPackage.scene, id: qwenSceneId }, workflow: directWorkflow });
  const previousQwenVersionId = randomUUID();
  await call("publish_scene", { sceneId: qwenSceneId, revision: qwenCreated.revision, publicationId: previousQwenVersionId });
  const qwenBefore = await call("get_scene_draft", { sceneId: qwenSceneId });
  const qwenWorkflow = structuredClone(qwenPackage.workflow);
  qwenWorkflow.sceneId = qwenSceneId;
  qwenWorkflow.inputs = qwenWorkflow.inputs.filter(input => input.key !== "seed");
  qwenWorkflow.steps[2].inputs = qwenWorkflow.steps[2].inputs.filter(input => input.key !== "seed");
  qwenWorkflow.steps[2].comfyui.bindings = qwenWorkflow.steps[2].comfyui.bindings.filter(binding => binding.key !== "seed");
  const invalidQwen = structuredClone(qwenWorkflow); invalidQwen.steps[0].hermesProfile = 21;
  assert.equal((await client.callTool({ name: "update_scene_draft", arguments: { sceneId: qwenSceneId, revision: qwenBefore.revision, workflow: invalidQwen } })).isError, true);
  assert.equal((await call("get_scene_draft", { sceneId: qwenSceneId })).revision, qwenBefore.revision);
  // Ignore the save receipt, simulating a client that lost it; reconcile the same scene, never replay.
  await client.callTool({ name: "update_scene_draft", arguments: { sceneId: qwenSceneId, revision: qwenBefore.revision, workflow: qwenWorkflow } });
  const qwenSaved = await call("get_scene_draft", { sceneId: qwenSceneId });
  assert.notEqual(qwenSaved.revision, qwenBefore.revision);
  assert.equal(qwenSaved.workflow.steps[0].hermesProfile, "writer");
  assert.equal(qwenSaved.workflow.steps[1].hermesProfile, "aixg");
  assert.equal(qwenSaved.workflow.steps[1].inputs.find(input => input.key === "prompt").sourceRef, QWEN_IMAGE_21_WRITER_REF);
  assert.equal(qwenSaved.workflow.steps[0].promptTemplate, qwenWorkflow.steps[0].promptTemplate);
  assert.deepEqual(qwenSaved.workflow.steps[0].inputs, qwenWorkflow.steps[0].inputs);
  assert.equal(qwenBefore.workflow.inputs.length, 8);
  assert.deepEqual(qwenSaved.workflow.inputs, qwenWorkflow.inputs);
  assert.ok(!JSON.stringify(qwenSaved.workflow).match(/input\.(negative_prompt|steps|empty)\b/));
  assert.deepEqual(qwenSaved.workflow.inputs.map(field => field.key), ["reference_images", "prompt", "ratio", "mp"]);
  assert.equal(qwenSaved.workflow.steps[2].inputs.find(input => input.key === "prompt").sourceRef, QWEN_IMAGE_21_PROMPT_REF);
  assert.equal(qwenSaved.workflow.steps[2].comfyui.bindings.find(binding => binding.key === "prompt").sourceRef, QWEN_IMAGE_21_PROMPT_REF);
  assert.equal(qwenSaved.publishedVersionId, previousQwenVersionId);
  const qwenHttp = await (await fetch(base + "/api/v1/scenes/" + qwenSceneId + "/draft")).json();
  assert.deepEqual(qwenHttp.workflow, qwenSaved.workflow); assert.equal(qwenHttp.revision, qwenSaved.revision);
  const staleQwen = await client.callTool({ name: "update_scene_draft", arguments: { sceneId: qwenSceneId, revision: qwenBefore.revision, workflow: qwenWorkflow } });
  assert.equal(staleQwen.structuredContent.error.code, "RESOURCE_REVISION_CONFLICT");
  assert.equal((await call("validate_scene_draft", { sceneId: qwenSceneId, revision: qwenSaved.revision })).valid, true);
  const oldQwen = await call("get_scene", { sceneId: qwenSceneId, versionId: previousQwenVersionId });
  assert.equal(oldQwen.workflow.steps.length, 2); assert.equal(oldQwen.workflow.steps[0].hermesProfile, "aixg");
  assert.equal(oldQwen.workflow.steps[1].comfyui.bindings.find(binding => binding.key === "prompt").sourceRef, QWEN_IMAGE_21_PROMPT_REF);
  assert.equal(Object.keys(oldQwen.inputSchema.properties).length, 8); assert.ok(Object.hasOwn(oldQwen.inputSchema.properties, "negative_prompt"));
  const qwenPage = await call("list_scenes", { limit: 1 });
  const qwenNext = await call("list_scenes", { limit: 1, cursor: qwenPage.nextCursor });
  assert.equal(qwenNext.scenes[0].sceneId, qwenSceneId); assert.equal(qwenNext.hasMore, false);
  const qwenVersionId = randomUUID();
  await client.callTool({ name: "publish_scene", arguments: { sceneId: qwenSceneId, revision: qwenSaved.revision, publicationId: qwenVersionId } });
  const publishedQwen = await call("get_scene", { sceneId: qwenSceneId, versionId: qwenVersionId });
  assert.equal(publishedQwen.versionId, qwenVersionId); assert.equal(publishedQwen.workflow.steps[0].capabilityId, "core.hermes");
  assert.equal(publishedQwen.workflow.steps[1].capabilityId, "core.hermes");
  assert.equal(publishedQwen.workflow.steps[2].capabilityId, "core.comfyui");
  assert.deepEqual(Object.keys(publishedQwen.inputSchema.properties), ["reference_images", "prompt", "ratio", "mp"]);
  assert.equal(publishedQwen.inputSchema.properties.prompt.title, "想法");
  assert.equal(publishedQwen.inputDefaults.ratio, "1:1 (Square)"); assert.equal(publishedQwen.inputDefaults.mp, 1);
  const qwenInputs = { reference_images: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="], prompt: "只改背景", ratio: "9:16 (Portrait Widescreen)", mp: 1 };
  const qwenExtraInputs = { ...qwenInputs, seed: 20261005, steps: 25, negative_prompt: "多余输入", empty: true };
  const qwenPrepared = await call("prepare_scene", { sceneId: qwenSceneId, versionId: qwenVersionId, inputValues: qwenExtraInputs });
  assert.equal(qwenPrepared.valid, true); assert.deepEqual(qwenPrepared.inputValues, qwenExtraInputs);
  assert.equal(qwenPrepared.inputValues.ratio, qwenInputs.ratio); assert.equal(qwenPrepared.inputValues.mp, qwenInputs.mp);
  for (const [inputValues, code] of [
    [{ ...qwenInputs, reference_images: [] }, "REQUIRED_INPUT_MISSING"],
    [{ ...qwenInputs, prompt: "" }, "REQUIRED_INPUT_MISSING"],
    [{ ...qwenInputs, mp: "1MP" }, "INPUT_TYPE_MISMATCH"],
    [{ ...qwenInputs, ratio: "无效画幅" }, "INVALID_INPUT_OPTION"],
  ]) {
    const invalid = await client.callTool({ name: "prepare_scene", arguments: { sceneId: qwenSceneId, versionId: qwenVersionId, inputValues } });
    assert.equal(invalid.isError, true); assert.equal(invalid.structuredContent.error.code, code);
  }
  // A later draft may gain a field; the already-published four-field contract is immutable.
  const fixedDraft = await call("get_scene_draft", { sceneId: qwenSceneId });
  await call("update_scene_draft", { sceneId: qwenSceneId, revision: fixedDraft.revision, workflow: { ...fixedDraft.workflow, inputs: [...fixedDraft.workflow.inputs, { key: "draft_only", label: "仅草稿", type: "text", required: false }] } });
  assert.deepEqual(Object.keys((await call("get_scene", { sceneId: qwenSceneId, versionId: qwenVersionId })).inputSchema.properties), ["reference_images", "prompt", "ratio", "mp"]);
  assert.equal((await client.callTool({ name: "list_scenes", arguments: { cursor: qwenPage.nextCursor } })).structuredContent.error.code, "SCENE_PAGE_CHANGED");
  const qwenCurrent = await call("get_scene_draft", { sceneId: qwenSceneId });
  const qwenConcurrent = await Promise.all(["A", "B"].map(suffix => fetch(base + "/api/v1/scenes/" + qwenSceneId + "/draft", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: qwenCurrent.revision, scene: { ...qwenCurrent.scene, summary: "并发方言配置" + suffix } }) })));
  assert.deepEqual(qwenConcurrent.map(response => response.status).sort(), [200, 409]);
  const qwenWinner = await qwenConcurrent.find(response => response.status === 200).json();
  const qwenFinal = await call("get_scene_draft", { sceneId: qwenSceneId });
  assert.equal(qwenFinal.scene.summary, qwenWinner.scene.summary); assert.equal(qwenFinal.revision, qwenWinner.revision);
  assert.deepEqual((await call("get_scene", { sceneId: qwenSceneId, versionId: qwenVersionId })).workflow, publishedQwen.workflow);
  assert.deepEqual((await call("get_scene", { sceneId: qwenSceneId, versionId: previousQwenVersionId })).workflow, oldQwen.workflow);
  assert.equal((await call("list_runs", { sceneId: qwenSceneId })).runs.length, 0);
  await call("delete_scene", { sceneId: qwenSceneId, revision: qwenFinal.revision });
  console.log("Qwen Image 2.1 Writer MCP acceptance passed: four declared fields + passthrough seed/extra inputs + writer-to-aixg references + ordered references + shared HTTP draft + validation + stale/concurrent revision + lost receipts + fixed publication + pagination; no models called.");
  // New media-role fields cross real stdio MCP into the same authoritative scene service.
  const longPackage = JSON.parse(await readFile(path.join(root, "examples/scenes/long-text-to-video.json"), "utf8"));
  const longId = longPackage.scene.id;
  const longCreated = await call("create_scene", { scene: longPackage.scene, workflow: longPackage.workflow });
  assert.equal(longCreated.publishedVersionId, null);
  const roleList = workflow => workflow.inputs.filter(field => field.mediaRole).map(field => field.mediaRole);
  assert.deepEqual(roleList(longCreated.workflow), ["character", "scene", "prop", "voice_reference"]);
  const longHttp = await (await fetch(base + "/api/v1/scenes/" + longId + "/draft")).json();
  assert.deepEqual(longHttp.workflow, longCreated.workflow);
  const rolePage = await call("list_scenes", { limit: 1 });
  // Discard the write receipt, then reconcile the original scene ID rather than replaying it.
  await client.callTool({ name: "update_scene_draft", arguments: { sceneId: longId, revision: longCreated.revision, scene: { ...longCreated.scene, summary: "分类素材与逐镜AIXG" } } });
  const longSaved = await call("get_scene_draft", { sceneId: longId });
  assert.equal(longSaved.scene.summary, "分类素材与逐镜AIXG"); assert.notEqual(longSaved.revision, longCreated.revision);
  assert.equal((await client.callTool({ name: "update_scene_draft", arguments: { sceneId: longId, revision: longCreated.revision, workflow: longPackage.workflow } })).structuredContent.error.code, "RESOURCE_REVISION_CONFLICT");
  assert.equal((await client.callTool({ name: "list_scenes", arguments: { cursor: rolePage.nextCursor } })).structuredContent.error.code, "SCENE_PAGE_CHANGED");
  const incompatibleRole = structuredClone(longSaved.workflow); incompatibleRole.inputs.find(field => field.key === "character_assets").mediaRole = "voice_reference";
  const invalidRole = await client.callTool({ name: "update_scene_draft", arguments: { sceneId: longId, revision: longSaved.revision, workflow: incompatibleRole } });
  assert.equal(invalidRole.isError, true);
  const invalidHttp = await fetch(base + "/api/v1/scenes/" + longId + "/draft", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: longSaved.revision, workflow: incompatibleRole }) });
  assert.equal(invalidHttp.status, 400); assert.equal((await call("get_scene_draft", { sceneId: longId })).revision, longSaved.revision);
  const invalidBinding = structuredClone(longSaved.workflow); invalidBinding.steps[2].comfyui.bindings.find(binding => binding.key === "reference_audio").mediaRole = "character";
  assert.equal((await client.callTool({ name: "update_scene_draft", arguments: { sceneId: longId, revision: longSaved.revision, workflow: invalidBinding } })).isError, true);
  assert.equal((await call("validate_scene_draft", { sceneId: longId, revision: longSaved.revision })).valid, true);
  const longVersionId = randomUUID();
  await client.callTool({ name: "publish_scene", arguments: { sceneId: longId, revision: longSaved.revision, publicationId: longVersionId } });
  const longPublished = await call("get_scene", { sceneId: longId, versionId: longVersionId });
  assert.deepEqual(longPublished.inputRequirements.filter(field => field.mediaRole).map(field => field.mediaRole), ["character", "scene", "prop", "voice_reference"]);
  assert.equal(longPublished.inputSchema.properties.voice_reference_audio["x-media-role"], "voice_reference");
  assert.equal(longPublished.workflow.steps[1].hermesProfile, "aixg");
  const roleDraft = await call("get_scene_draft", { sceneId: longId });
  const genericDraft = structuredClone(roleDraft.workflow); genericDraft.inputs.find(field => field.key === "voice_reference_audio").mediaRole = "reference";
  const longChanged = await call("update_scene_draft", { sceneId: longId, revision: roleDraft.revision, workflow: genericDraft });
  assert.equal(longChanged.workflow.inputs.find(field => field.key === "voice_reference_audio").mediaRole, "reference");
  assert.equal((await call("get_scene", { sceneId: longId, versionId: longVersionId })).inputSchema.properties.voice_reference_audio["x-media-role"], "voice_reference");
  const roleConcurrent = await Promise.all(["A", "B"].map(suffix => fetch(base + "/api/v1/scenes/" + longId + "/draft", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: longChanged.revision, scene: { ...longChanged.scene, summary: "素材用途并发" + suffix } }) })));
  assert.deepEqual(roleConcurrent.map(response => response.status).sort(), [200, 409]);
  const longFinal = await call("get_scene_draft", { sceneId: longId });
  assert.equal((await call("list_runs", { sceneId: longId })).runs.length, 0);
  await call("delete_scene", { sceneId: longId, revision: longFinal.revision });
  console.log("Categorized asset + long-video MCP acceptance passed: shared create/read/update + role validation + Writer-to-AIXG prompts + stale/concurrent revision + lost write/publication receipts + pagination + immutable published input roles; no models called.");
  // Repeatable object-array form metadata crosses real stdio MCP into the shared HTTP service.
  const objectArraySceneId = "ai-object-array-form-smoke";
  const objectArrayWorkflow = { sceneId: objectArraySceneId, name: "规格表单", inputs: [{ key: "specs", label: "规格数组", type: "json", required: true, inputMode: "object_array", itemFields: [
    { key: "size", label: "尺寸", type: "select", required: true, options: ["S", "M", "L"] },
    { key: "type", label: "类型", type: "select", required: true, options: ["圆领", "V领"] },
    { key: "stock", label: "库存", type: "number", required: false },
  ] }], steps: [], outputs: [] };
  const objectArrayCreated = await call("create_scene", { scene: { id: objectArraySceneId, title: "对象数组表单" }, workflow: objectArrayWorkflow });
  assert.equal((await call("validate_scene_draft", { sceneId: objectArraySceneId, revision: objectArrayCreated.revision })).valid, true);
  const objectArrayPublicationId = randomUUID();
  const objectArrayPublication = await call("publish_scene", { sceneId: objectArraySceneId, revision: objectArrayCreated.revision, publicationId: objectArrayPublicationId });
  const objectArrayScene = await call("get_scene", { sceneId: objectArraySceneId, versionId: objectArrayPublicationId });
  const objectArraySchema = objectArrayScene.inputSchema.properties.specs;
  assert.equal(objectArraySchema["x-input-mode"], "object_array");
  assert.deepEqual(objectArraySchema.items.required, ["size", "type"]);
  assert.deepEqual(objectArrayScene.inputRequirements.find(field => field.key === "specs").itemFields.map(field => field.key), ["size", "type", "stock"]);
  const objectArrayValues = { specs: [{ size: "S", type: "圆领", stock: 12 }, { size: "M", type: "V领" }] };
  const objectArrayPrepared = await call("prepare_scene", { sceneId: objectArraySceneId, versionId: objectArrayPublicationId, inputValues: objectArrayValues });
  assert.deepEqual(objectArrayPrepared.inputValues.specs, objectArrayValues.specs);
  for (const [inputValues, code] of [
    [{ specs: [{ size: "XL", type: "圆领" }] }, "INVALID_INPUT_OPTION"],
    [{ specs: [{ size: "S" }] }, "REQUIRED_INPUT_MISSING"],
    [{ specs: [{ size: "S", type: "圆领", unexpected: true }] }, "INPUT_TYPE_MISMATCH"],
  ]) {
    const invalid = await client.callTool({ name: "prepare_scene", arguments: { sceneId: objectArraySceneId, versionId: objectArrayPublicationId, inputValues } });
    assert.equal(invalid.structuredContent.error.code, code);
  }
  assert.equal(objectArrayPublication.versionId, objectArrayPublicationId);
  const objectArrayFinalDraft = await call("get_scene_draft", { sceneId: objectArraySceneId });
  await call("delete_scene", { sceneId: objectArraySceneId, revision: objectArrayFinalDraft.revision });
  console.log("Object-array scene input MCP acceptance passed: row field schema + immutable publication + typed preparation + required/option/unknown-field validation; no models called.");
  // The installation doctor itself is also exercised against this isolated backend.
  let doctorLog = ""; doctor = spawn(process.execPath, [path.join(root, "scripts/check-ai-access.mjs")], { cwd: root, windowsHide: true, env: { ...process.env, ZANE_BASE_URL: base }, stdio: ["ignore", "pipe", "pipe"] }); doctor.stdout.on("data", chunk => { doctorLog += chunk; }); doctor.stderr.on("data", chunk => { doctorLog += chunk; });
  doctorExited = new Promise((resolve, reject) => { doctor.once("error", reject); doctor.once("exit", resolve); });
  const code = await bounded(doctorExited); assert.equal(code, 0, doctorLog); assert.match(doctorLog, /"generationExecuted": false/);
  if (withHermes) {
    hermesDoctor = spawn(process.env.ZANE_HERMES_PYTHON, ["-B", path.join(root, "scripts/check-hermes-workbench.py"), "--profile-home", process.env.ZANE_HERMES_PROFILE_HOME, "--hermes-source", process.env.ZANE_HERMES_SOURCE, "--base-url", base, "--expected-project", project], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let hermesLog = "";
    hermesDoctor.stdout.on("data", chunk => { hermesLog += chunk; }); hermesDoctor.stderr.on("data", chunk => { hermesLog += chunk; });
    hermesDoctorExited = new Promise((resolve, reject) => { hermesDoctor.once("error", reject); hermesDoctor.once("exit", resolve); });
    assert.equal(await bounded(hermesDoctorExited, 30000), 0, hermesLog);
    assert.match(hermesLog, /"toolDiscoveryPassed": true/); assert.match(hermesLog, /"backendChecked": true/); assert.match(hermesLog, /"ok": true/); assert.match(hermesLog, /"generationExecuted": false/);
    console.log("Hermes MCP acceptance passed: installed Hermes registration/dispatch + resources/prompts + isolated backend/project + published scene; no model calls, no profile/backend restart.");
    console.log(hermesLog);
  }
  const finalSceneDraft = await call("get_scene_draft", { sceneId: scene.id });
  await call("delete_scene", { sceneId: scene.id, revision: finalSceneDraft.revision });
  assert.equal((await call("list_scenes")).total, 0);
  assert.deepEqual((await (await fetch(base + "/api/workspace")).json()).workspace.scenes, []);
  assert.equal((await call("get_workspace_status")).initialized, true);
  console.log("AI smoke passed: compiled backend + real stdio MCP + empty shared initialization/no implicit defaults + published scene + preflight + stable ID + review + partial rerun + scene draft/publish/restore + input contract + lightweight results + presets + doctor; no external generation, isolated data.");
} catch (error) { console.error(error); if (logs) console.error(logs.slice(-8000)); process.exitCode = 1; }
finally {
  await client.close().catch(() => undefined);
  if (hermesDoctor && hermesDoctor.exitCode === null && hermesDoctor.signalCode === null) { hermesDoctor.kill("SIGTERM"); await hermesDoctorExited.catch(() => undefined); }
  if (doctor && doctor.exitCode === null && doctor.signalCode === null) { doctor.kill("SIGTERM"); await doctorExited.catch(() => undefined); }
  if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); try { await bounded(exited, 10000); } catch { child.kill("SIGKILL"); await exited; } }
  // temporary is the exact directory returned by mkdtemp above, never production data.
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("zane-ai-smoke-")) throw new Error("Refusing to remove unexpected smoke directory");
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
