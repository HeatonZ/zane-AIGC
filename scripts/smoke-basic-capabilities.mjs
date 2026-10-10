import "./smoke-auth.mjs";
/** Compiled HTTP + real stdio MCP E2E. Temporary project/SQLite only; no external generation. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "zane-basic-e2e-"));
const project = path.join(temporary, "project");
await mkdir(project);
const client = new Client({ name: "zane-basic-e2e", version: "1.0.0" });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let child, exited, logs = "";
const bounded = async (promise, milliseconds = 20000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Basic E2E timeout\n" + logs.slice(-4000))), milliseconds); })]); }
  finally { clearTimeout(timer); }
};
try {
  child = spawn(process.execPath, [path.join(root, "dist-server/index.js"), "--production"], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", API_HOST: "127.0.0.1", API_PORT: "0", APP_DATA_DIR: path.join(temporary, "data"), ZANE_PROJECT_DIR: project, HERMES_HOME: path.join(temporary, "no-hermes"), COMFYUI_BASE_URL: "http://127.0.0.1:1", ZANE_SHUTDOWN_TIMEOUT_MS: "1000", ZANE_MAX_ACTIVE_RUNS: "2" },
  });
  exited = new Promise(resolve => child.once("exit", resolve));
  const base = await bounded(new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => reject(new Error("Isolated backend exited " + code + "\n" + logs)));
    child.stderr.on("data", chunk => { logs += chunk; });
    child.stdout.on("data", chunk => { logs += chunk; const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs); if (match) resolve(match[1]); });
  }));
  const ready = await fetch(base + "/api/ready"); assert.equal(ready.status, 200);
  const initialized = await fetch(base + "/api/workspace/initialize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "zane-studio.workspace/v1", scenes: [], workflows: {}, optionPresets: [], drafts: [], sceneVersions: {} }) });
  assert.equal(initialized.status, 200);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist-server/mcp/index.js")], cwd: root, env: { ...process.env, ZANE_BASE_URL: base }, stderr: "pipe" });
  transport.stderr?.on("data", chunk => { logs += chunk; });
  await bounded(client.connect(transport));
  const raw = async (name, arguments_ = {}) => (await client.callTool({ name, arguments: arguments_ })).structuredContent;
  const call = async (name, arguments_ = {}) => { const result = await raw(name, arguments_); assert.equal(result?.ok, true, name + ": " + JSON.stringify(result)); return result.data; };
  // Compiled production entry uses the same persistent scheduler setting as HTTP/MCP.
  const concurrency = await call("get_task_concurrency");
  assert.equal(concurrency.revision, 0); assert.equal(concurrency.maxActiveRuns, 2);
  await call("update_task_concurrency", { revision: 0, maxActiveRuns: 3 }); // drop receipt, then reconcile
  const concurrencySaved = await call("get_task_concurrency");
  assert.equal(concurrencySaved.revision, 1); assert.equal(concurrencySaved.maxActiveRuns, 3);
  assert.deepEqual(await (await fetch(base + "/api/v1/settings/task-concurrency")).json(), concurrencySaved);
  assert.equal((await raw("update_task_concurrency", { revision: 0, maxActiveRuns: 4 })).error.code, "RESOURCE_REVISION_CONFLICT");
  await call("update_task_concurrency", { revision: concurrencySaved.revision, maxActiveRuns: 2 });
  console.log("Task concurrency compiled MCP acceptance passed: singleton SQLite + live scheduler + revision conflict + lost receipt reconciliation; no tasks submitted.");
  const catalog = await call("list_capabilities", { limit: 1 });
  assert.equal(catalog.selectionPolicy.sceneSpecificLogic, "core.code"); assert.ok(catalog.nextCursor && catalog.hasMore);
  let cursor = catalog.nextCursor; const capabilities = [...catalog.capabilities];
  while (cursor) { const page = await call("list_capabilities", { limit: 2, cursor }); assert.equal(page.revision, catalog.revision); capabilities.push(...page.capabilities); cursor = page.nextCursor; }
  assert.equal(capabilities.length, new Set(capabilities.map(item => item.id)).size);
  assert.ok(capabilities.every(item => typeof item.usage.whenToUse === "string" && item.usage.whenToUse));
  // 退役的执行方式仍留在目录里执行旧快照，但标记 compatibilityOnly，不再作为新步骤候选。
  for (const id of ["media.select_references", "media.image_layout", "text.template", "core.manual"]) assert.equal(capabilities.find(item => item.id === id).usage.compatibilityOnly, true, id);
  assert.equal(capabilities.find(item => item.id === "core.code").usage.compatibilityOnly, undefined);
  assert.ok(capabilities.find(item => item.id === "media.image_layout").inputs.find(input => input.key === "layout").valueSchema.properties);
  assert.equal((await raw("list_capabilities", { cursor: "not-a-cursor" })).error.code, "INVALID_CAPABILITY_CURSOR");
  const invalid = await client.callTool({ name: "list_capabilities", arguments: { limit: 0 } }); assert.equal(invalid.isError, true);
  const unknownQuery = await client.callTool({ name: "list_capabilities", arguments: { tier: "specialized" } }); assert.equal(unknownQuery.isError, true, "未声明的查询参数必须拒绝，不再有基础/专用分层");
  const retired = await call("list_capabilities", { limit: 100 });
  assert.equal(retired.capabilities.find(item => item.id === "comfyui.commerce_pack").usage.compatibilityOnly, true);
  assert.ok(retired.capabilities.some(item => item.id === "comfyui.long_text_video" && item.label.includes("H3")));
  const httpCatalog = await (await fetch(base + "/api/v1/capabilities?limit=1")).json(); assert.equal(httpCatalog.revision, catalog.revision);

  const source = path.join(temporary, "input.png");
  const sourceBytes = await sharp({ create: { width: 80, height: 100, channels: 3, background: "#b6c7a4" } }).png().toBuffer();
  await writeFile(source, sourceBytes);
  const asset = await call("upload_asset", { createId: randomUUID(), filePath: source, kind: "image", name: "隔离端到端源图", category: "material" });
  const pkg = JSON.parse(await readFile(path.join(root, "examples/scenes/basic-image-layout.json"), "utf8"));
  let draft = await call("create_scene", { scene: pkg.scene, workflow: pkg.workflow });
  const originalRevision = draft.revision;
  draft = await call("update_scene_draft", { sceneId: pkg.scene.id, revision: originalRevision, workflow: { ...pkg.workflow, name: "基础能力编译产物端到端验收" } });
  assert.equal((await raw("update_scene_draft", { sceneId: pkg.scene.id, revision: originalRevision, workflow: pkg.workflow })).error.status, 409);
  await call("validate_scene_draft", { sceneId: pkg.scene.id, revision: draft.revision });
  const versionId = randomUUID(); const publicationArgs = { sceneId: pkg.scene.id, revision: draft.revision, publicationId: versionId };
  await call("publish_scene", publicationArgs);
  const reconciled = await call("publish_scene", publicationArgs); assert.equal(reconciled.versionId, versionId); assert.equal(reconciled.created, false);
  const published = await call("get_scene", { sceneId: pkg.scene.id, versionId }); assert.ok(published.inputSchema.properties.layouts);
  const inputValues = { images: [asset.reference], selection: { images: [1] }, layouts: [
    { width: 320, height: 400, margin: 16, title: "基础封面" },
    { width: 400, height: 320, margin: 16, caption: "无需场景定制" },
    { width: 360, height: 360, background: "#fafaf7", title: "标题 & <b>原样文字</b>" },
  ] };
  const prepared = await call("prepare_scene", { sceneId: pkg.scene.id, versionId, inputValues });
  assert.deepEqual(prepared.boundaries.externalSteps, []); assert.equal(prepared.externalServicesChecked, false);
  const runId = randomUUID(); const submission = { sceneId: pkg.scene.id, versionId, runId, inputValues };
  // Deliberately discard the first response, then reconcile ONLY the pre-saved ID.
  await call("submit_scene", submission);
  assert.equal((await call("get_run", { runId })).runId, runId);
  assert.equal((await raw("submit_scene", submission)).error.code, "RUN_ALREADY_EXISTS");
  const completed = await call("wait_run", { runId, timeoutSeconds: 20 }); assert.equal(completed.status, "completed", JSON.stringify(completed));
  const originalRun = await call("get_run", { runId });
  const manifests = []; const media = []; let valueOffset = 0;
  do {
    const outputs = await call("get_run_outputs", { runId, outputKey: "layout_manifest", includeValues: true, valueLimit: 1, valueOffset });
    const output = outputs.outputs[0]; assert.equal(output.valueOmitted, undefined); manifests.push(...output.value);
    if (!output.valuePage.hasMore) break; assert.ok(output.valuePage.nextValueOffset > valueOffset); valueOffset = output.valuePage.nextValueOffset;
  } while (true);
  assert.equal(manifests.length, inputValues.layouts.length);
  const images = await call("get_run_outputs", { runId, outputKey: "images", includeValues: true, valueLimit: 10 });
  assert.equal(images.outputs[0].valuePage.complete, true); assert.equal(images.outputs[0].mediaReferences.length, manifests.length);
  for (const [index, reference] of images.outputs[0].mediaReferences.entries()) {
    const url = new URL(reference.url, base); assert.equal(url.origin, base);
    const head = await fetch(url, { method: "HEAD" }); assert.equal(head.status, 200); assert.match(head.headers.get("content-type"), /^image\//);
    const response = await fetch(url); assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer());
    const metadata = await sharp(bytes).metadata(); assert.equal(metadata.width, inputValues.layouts[index].width); assert.equal(metadata.height, inputValues.layouts[index].height);
    assert.equal(manifests[index].format, "zane-image-layout/item-v1"); assert.equal(manifests[index].sha256, digest(bytes)); assert.equal(manifests[index].sourceRunId, runId);
    const range = await fetch(url, { headers: { Range: "bytes=0-15" } }); assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 16));
    media.push({ url: reference.url, sha256: digest(bytes), width: metadata.width, height: metadata.height });
  }
  assert.equal(new Set(manifests.map(item => item.outputFile)).size, manifests.length, "parallel foreach artifacts must not overwrite");
  assert.equal(digest(await readFile(source)), digest(sourceBytes), "source stays immutable");
  const stepResult = await call("get_step_result", { runId, stepId: "layout", limit: 1, includeValues: false }); assert.equal(stepResult.hasMore, true); assert.ok(stepResult.nextCursor);
  const nextStepResult = await call("get_step_result", { runId, stepId: "layout", limit: 1, includeValues: false, cursor: stepResult.nextCursor }); assert.equal(nextStepResult.revision, stepResult.revision);
  const changes = { rerunSteps: [{ stepId: "layout", itemIndexes: [1] }] };
  const preview = await call("preview_rerun", { sourceRunId: runId, changes }); assert.equal(preview.steps.find(item => item.stepId === "references").action, "reuse");
  assert.deepEqual(preview.steps.find(item => item.stepId === "layout").runItemIndexes, [1]);
  const rerunId = randomUUID(); await call("rerun", { sourceRunId: runId, runId: rerunId, changes });
  assert.equal((await call("wait_run", { runId: rerunId, timeoutSeconds: 20 })).status, "completed");
  const rerun = await call("get_run", { runId: rerunId }); assert.equal(rerun.steps.find(item => item.stepId === "layout").items[0].reusedFromRunId, runId);
  const rerunImages = await call("get_run_outputs", { runId: rerunId, outputKey: "images", includeValues: true, valueLimit: 10 });
  assert.equal(rerunImages.outputs[0].mediaReferences.length, manifests.length);
  for (const [index, reference] of rerunImages.outputs[0].mediaReferences.entries()) {
    const response = await fetch(new URL(reference.url, base)); assert.equal(response.status, 200);
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), media[index].sha256, "reused ancestor and rerun output-media resolve correctly");
  }
  assert.deepEqual(await call("get_run", { runId }), originalRun, "rerun does not mutate original history");
  for (const item of media) assert.equal(digest(Buffer.from(await (await fetch(new URL(item.url, base))).arrayBuffer())), item.sha256, "rerun does not mutate original images");
  assert.equal((await call("list_runs", { limit: 10 })).runs.length, 2);

  // Business groups become a single physical list; exercise the new ports through real MCP and the shared service.
  const referenceCapability=capabilities.find(item=>item.id==="media.select_references");
  assert.deepEqual(referenceCapability.outputs.filter(output=>output.required===false).map(output=>[output.key,output.type]),[["bundle","json"],["images","image_list"],["audios","audio_list"],["videos","video_list"]]);
  const mergeId="basic-merged-media";
  const mergeWorkflow={sceneId:mergeId,name:"classified-to-physical-lists",inputs:[{key:"left",type:"image_list",required:true},{key:"right",type:"image_list",required:true},{key:"empty",type:"image_list"},{key:"voices",type:"audio_list"},{key:"clips",type:"video_list"},{key:"selection",type:"json",required:true}],steps:[{id:"references",name:"选择分类并按媒体类型合并",kind:"capability",capabilityId:referenceCapability.id,capabilityVersion:referenceCapability.version,capabilityConfig:{groups:[{key:"left",kind:"image",tag:"Character"},{key:"empty",kind:"image",tag:"Empty"},{key:"right",kind:"image",tag:"Prop"},{key:"voices",kind:"audio",tag:"Voice"},{key:"clips",kind:"video",tag:"Clip"}]},inputs:[...["left","right","empty","voices","clips","selection"].map(key=>({key,sourceRef:"input."+key})),{key:"prompt",valueSource:"literal",literalType:"text",literalValue:"<Character 1> + <Prop 1>"}],outputs:referenceCapability.outputs.map(({key,type})=>({key,type}))}],outputs:[...["images","audios","videos"].map(key=>({key,type:key==="images"?"image_list":key==="audios"?"audio_list":"video_list",sourceRef:"step.references.outputs."+key})),{key:"prompt",type:"text",sourceRef:"step.references.outputs.prompt"}]};
  let mergeDraft=await call("create_scene",{scene:{id:mergeId,title:"隔离合并媒体"},workflow:mergeWorkflow});
  await call("validate_scene_draft",{sceneId:mergeId,revision:mergeDraft.revision});
  const mergePublicationId=randomUUID();await call("publish_scene",{sceneId:mergeId,revision:mergeDraft.revision,publicationId:mergePublicationId});
  const fixedMerge=await call("get_scene",{sceneId:mergeId,versionId:mergePublicationId});assert.equal(fixedMerge.workflow.steps[0].outputs.find(output=>output.key==="images").type,"image_list");
  const mergeRunId=randomUUID();await call("submit_scene",{sceneId:mergeId,versionId:mergePublicationId,runId:mergeRunId,inputValues:{left:[asset.reference],right:[asset.reference],empty:[],voices:[],clips:[],selection:{left:[1],right:[1],empty:[],voices:[],clips:[]}}});
  assert.equal((await call("wait_run",{runId:mergeRunId,timeoutSeconds:20})).status,"completed");
  const firstMergePage=await call("get_run_outputs",{runId:mergeRunId,outputKey:"images",includeValues:true,valueLimit:1,valueOffset:0});
  assert.equal(firstMergePage.outputs[0].valuePage.total,2);assert.equal(firstMergePage.outputs[0].valuePage.hasMore,true);assert.equal(firstMergePage.outputs[0].mediaReferences.length,1);
  const secondMergePage=await call("get_run_outputs",{runId:mergeRunId,outputKey:"images",includeValues:true,valueLimit:1,valueOffset:firstMergePage.outputs[0].valuePage.nextValueOffset});
  assert.equal(secondMergePage.outputs[0].valuePage.hasMore,false);assert.equal(secondMergePage.outputs[0].mediaReferences.length,1);
  for(const key of ["audios","videos"]){const output=await call("get_run_outputs",{runId:mergeRunId,outputKey:key,includeValues:true});assert.equal(output.outputs[0].valuePage.total,0);assert.deepEqual(output.outputs[0].value,[]);}
  const mergePrompt=await call("get_run_outputs",{runId:mergeRunId,outputKey:"prompt",includeValues:true});assert.equal(mergePrompt.outputs[0].value,"<Picture 1> + <Picture 2>");
  for(const page of [firstMergePage,secondMergePage]){const response=await fetch(new URL(page.outputs[0].mediaReferences[0].url,base));assert.equal(response.status,200);assert.equal(digest(Buffer.from(await response.arrayBuffer())),digest(sourceBytes));}
  assert.equal((await raw("update_scene_draft",{sceneId:mergeId,revision:mergeDraft.revision,workflow:mergeWorkflow})).error.code,"RESOURCE_REVISION_CONFLICT");
  assert.equal((await raw("submit_scene",{sceneId:mergeId,versionId:mergePublicationId,runId:mergeRunId,inputValues:{left:[asset.reference],right:[asset.reference],empty:[],voices:[],clips:[],selection:{left:[1],right:[1],empty:[],voices:[],clips:[]}}})).error.code,"RUN_ALREADY_EXISTS");
  mergeDraft=await call("get_scene_draft",{sceneId:mergeId});const invalidMerge=structuredClone(mergeDraft.workflow);invalidMerge.steps[0].outputs.find(output=>output.key==="images").type="audio_list";
  const invalidMergeDraft=await call("update_scene_draft",{sceneId:mergeId,revision:mergeDraft.revision,workflow:invalidMerge});
  assert.equal((await raw("validate_scene_draft",{sceneId:mergeId,revision:invalidMergeDraft.revision})).error.code,"INVALID_CAPABILITY_OUTPUT");
  assert.equal((await call("get_scene",{sceneId:mergeId,versionId:mergePublicationId})).workflow.steps[0].outputs.find(output=>output.key==="images").type,"image_list");
  console.log("Classified-to-physical-list real MCP acceptance passed: typed optional ports + stable duplicate positions + empty groups + independent media kinds + reference numbering + publication isolation + paged outputs; no external generation.");

  // Generic state carry: compiled service + same HTTP/MCP scene schema; no provider/media calls.
  const carrySceneId = "isolated-foreach-carry";
  const carryFlow = { sceneId: carrySceneId, name: "串行状态传递隔离验收", inputs: [{ key: "items", type: "json", required: true }, { key: "seed", type: "text", required: true }],
    steps: [{ id: "chain", name: "逐项文本链", kind: "capability", capabilityId: "text.template", capabilityConfig: { template: "{{previous}}/{{item}}:{{index}}:{{has}}" },
      execution: { mode: "for_each", sourceRef: "input.items", carry: { outputKey: "text", initialSourceRef: "input.seed" } },
      inputs: [{ key: "previous", sourceRef: "iteration.previous" }, { key: "item", sourceRef: "iteration.item" }, { key: "index", sourceRef: "iteration.index" }, { key: "has", sourceRef: "iteration.hasPrevious" }], outputs: [{ key: "text", type: "text" }] }],
    outputs: [{ key: "texts", type: "json", sourceRef: "step.chain.outputs.text" }] };
  let carryDraft = await call("create_scene", { scene: { id: carrySceneId, title: "隔离状态链" }, workflow: carryFlow });
  const carryRevision = carryDraft.revision;
  const invalidCarry = structuredClone(carryDraft.workflow); invalidCarry.steps[0].execution.maxConcurrency = 2;
  assert.equal((await raw("update_scene_draft", { sceneId: carrySceneId, revision: carryRevision, workflow: invalidCarry })).error.code, "INVALID_WORKFLOW");
  const invalidCarryHttp = await fetch(base + "/api/v1/scenes/" + carrySceneId + "/draft", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: carryRevision, workflow: invalidCarry }) });
  assert.equal(invalidCarryHttp.status, 400);
  carryFlow.name = "确认串行配置";
  await call("update_scene_draft", { sceneId: carrySceneId, revision: carryRevision, workflow: carryFlow }); // discard receipt
  carryDraft = await call("get_scene_draft", { sceneId: carrySceneId }); assert.notEqual(carryDraft.revision, carryRevision);
  assert.deepEqual(carryDraft.workflow.steps[0].execution.carry, carryFlow.steps[0].execution.carry);
  assert.equal((await raw("update_scene_draft", { sceneId: carrySceneId, revision: carryRevision, workflow: carryFlow })).error.code, "RESOURCE_REVISION_CONFLICT");
  await call("validate_scene_draft", { sceneId: carrySceneId, revision: carryDraft.revision });
  const carryPublicationId = randomUUID(); const carryPublication = { sceneId: carrySceneId, revision: carryDraft.revision, publicationId: carryPublicationId };
  await call("publish_scene", carryPublication); assert.equal((await call("publish_scene", carryPublication)).created, false);
  const carryPublished = await call("get_scene", { sceneId: carrySceneId, versionId: carryPublicationId });
  assert.equal(carryPublished.workflow.steps[0].execution.carry.outputKey, "text");
  const carryInputs = { items: ["A", "B", "C"], seed: "seed" };
  assert.deepEqual((await call("prepare_scene", { sceneId: carrySceneId, versionId: carryPublicationId, inputValues: carryInputs })).boundaries.externalSteps, []);
  const carryRunId = randomUUID(); await call("submit_scene", { sceneId: carrySceneId, versionId: carryPublicationId, runId: carryRunId, inputValues: carryInputs }); // lost receipt -> same ID
  assert.equal((await call("wait_run", { runId: carryRunId, timeoutSeconds: 20 })).status, "completed");
  const carryRun = await call("get_run", { runId: carryRunId });
  assert.deepEqual(carryRun.steps[0].items.map(item => item.inputs.previous), ["seed", "seed/A:0:true", "seed/A:0:true/B:1:true"]);
  let carryCursor; const carryItems = [];
  do { const page = await call("get_step_result", { runId: carryRunId, stepId: "chain", limit: 1, includeValues: true, ...(carryCursor ? { cursor: carryCursor } : {}) });
    carryItems.push(...page.items); carryCursor = page.nextCursor; assert.equal(page.hasMore, Boolean(carryCursor));
  } while (carryCursor);
  assert.deepEqual(carryItems.map(item => item.index), [0, 1, 2]);
  assert.equal((await raw("get_step_result", { runId: carryRunId, stepId: "chain", itemIndex: 9 })).error.status, 404);
  const carryChanges = { outputOverrides: [{ stepId: "chain", itemIndex: 1, outputs: { text: "manual" } }] };
  const carryPlan = await call("preview_rerun", { sourceRunId: carryRunId, changes: carryChanges });
  assert.deepEqual(carryPlan.steps[0].runItemIndexes, [2]); assert.deepEqual(carryPlan.steps[0].reuseItemIndexes, [0, 1]);
  const carryRerunId = randomUUID(); await call("rerun", { sourceRunId: carryRunId, runId: carryRerunId, changes: carryChanges });
  assert.equal((await call("wait_run", { runId: carryRerunId, timeoutSeconds: 20 })).status, "completed");
  const carryRerun = await call("get_run", { runId: carryRerunId }); assert.deepEqual(carryRerun.steps[0].outputs.text, ["seed/A:0:true", "manual", "manual/C:2:true"]);
  assert.deepEqual(await call("get_run", { runId: carryRunId }), carryRun);
  console.log("for_each carry real stdio MCP passed: schema -> revision/lost receipt -> fixed publication -> local execution -> item pagination -> replacement suffix rerun; no models/media.");

  // Custom code step: local sandbox execution through the same compiled HTTP + stdio MCP services.
  const codeCapability = capabilities.find(item => item.id === "core.code");
  assert.ok(codeCapability && codeCapability.usage.compatibilityOnly === undefined && codeCapability.editor.editableOutputs === true && codeCapability.config.some(field => field.key === "code" && field.type === "textarea"));
  const codeSceneId = "isolated-code-step";
  const codeFlow = { sceneId: codeSceneId, name: "自定义代码隔离验收", inputs: [{ key: "rows", type: "json", required: true }, { key: "prefix", type: "text", required: true }],
    steps: [{ id: "aggregate", name: "汇总代码", kind: "capability", capabilityId: "core.code", capabilityVersion: codeCapability.version,
      capabilityConfig: { code: "const rows = inputs.rows ?? [];\nconst total = rows.reduce((sum, row) => sum + row.amount, 0);\nreturn { count: rows.length, total, summary: inputs.prefix + ':' + rows.length + '/' + total, names: rows.map((row) => row.name) };", timeoutMs: 5000 },
      inputs: [{ key: "rows", sourceRef: "input.rows" }, { key: "prefix", sourceRef: "input.prefix" }],
      outputs: [{ key: "count", type: "number" }, { key: "total", type: "number" }, { key: "summary", type: "text" }, { key: "names", type: "json" }] }],
    outputs: [{ key: "count", type: "number", sourceRef: "step.aggregate.outputs.count" }, { key: "total", type: "number", sourceRef: "step.aggregate.outputs.total" }, { key: "summary", type: "text", sourceRef: "step.aggregate.outputs.summary" }, { key: "names", type: "json", sourceRef: "step.aggregate.outputs.names" }] };
  let codeDraft = await call("create_scene", { scene: { id: codeSceneId, title: "隔离代码步骤" }, workflow: codeFlow });
  // Invalid drafts fail before publication: media output type, bad syntax, out-of-range timeout and empty code.
  for (const [mutate, expected] of [
    [(workflow) => { workflow.steps[0].outputs[0].type = "image"; }, "INVALID_CODE_CONFIG"],
    [(workflow) => { workflow.steps[0].capabilityConfig.code = "return {"; }, "INVALID_CODE_CONFIG"],
    [(workflow) => { workflow.steps[0].capabilityConfig.timeoutMs = 10; }, "INVALID_CODE_CONFIG"],
    [(workflow) => { workflow.steps[0].capabilityConfig.code = ""; }, "INVALID_CAPABILITY_CONFIG"],
  ]) {
    const current = await call("get_scene_draft", { sceneId: codeSceneId });
    const invalid = structuredClone(current.workflow); mutate(invalid);
    const updated = await call("update_scene_draft", { sceneId: codeSceneId, revision: current.revision, workflow: invalid });
    assert.equal((await raw("validate_scene_draft", { sceneId: codeSceneId, revision: updated.revision })).error.code, expected);
  }
  codeFlow.name = "确认汇总配置";
  const staleCodeRevision = (await call("get_scene_draft", { sceneId: codeSceneId })).revision;
  await call("update_scene_draft", { sceneId: codeSceneId, revision: staleCodeRevision, workflow: codeFlow }); // lost receipt
  codeDraft = await call("get_scene_draft", { sceneId: codeSceneId });
  assert.equal(codeDraft.workflow.name, "确认汇总配置");
  assert.equal((await raw("update_scene_draft", { sceneId: codeSceneId, revision: staleCodeRevision, workflow: codeFlow })).error.code, "RESOURCE_REVISION_CONFLICT");
  await call("validate_scene_draft", { sceneId: codeSceneId, revision: codeDraft.revision });
  const codeVersionId = randomUUID(); const codePublication = { sceneId: codeSceneId, revision: codeDraft.revision, publicationId: codeVersionId };
  await call("publish_scene", codePublication); assert.equal((await call("publish_scene", codePublication)).versionId, codeVersionId);
  const codeInputs = { rows: [{ name: "a", amount: 2 }, { name: "b", amount: 3 }], prefix: "sum" };
  const codePrepared = await call("prepare_scene", { sceneId: codeSceneId, versionId: codeVersionId, inputValues: codeInputs });
  assert.deepEqual(codePrepared.boundaries.externalSteps, []);
  assert.equal(codePrepared.externalServicesChecked, false);
  const codeRunId = randomUUID();
  await call("submit_scene", { sceneId: codeSceneId, versionId: codeVersionId, runId: codeRunId, inputValues: codeInputs }); // lost receipt -> same ID
  assert.equal((await call("get_run", { runId: codeRunId })).runId, codeRunId);
  assert.equal((await call("wait_run", { runId: codeRunId, timeoutSeconds: 20 })).status, "completed");
  assert.deepEqual(await Promise.all(["count", "total", "summary", "names"].map(async key => (await call("get_run_outputs", { runId: codeRunId, outputKey: key, includeValues: true })).outputs[0].value)), [2, 5, "sum:2/5", ["a", "b"]]);
  const codeRun = await call("get_run", { runId: codeRunId });
  assert.equal(codeRun.steps[0].capabilityId, "core.code");
  assert.deepEqual(codeRun.steps[0].outputs, { count: 2, total: 5, summary: "sum:2/5", names: ["a", "b"] });
  // Execution-time failures stay explicit; the fixed publication snapshot is never rewritten by a failed run.
  const failFlow = structuredClone(codeFlow); failFlow.steps[0].capabilityConfig.code = "throw new Error(\"sandbox failure\");";
  const failBase = await call("get_scene_draft", { sceneId: codeSceneId }); // publishing advances the content revision
  const failDraft = await call("update_scene_draft", { sceneId: codeSceneId, revision: failBase.revision, workflow: failFlow });
  await call("validate_scene_draft", { sceneId: codeSceneId, revision: failDraft.revision });
  const failVersionId = randomUUID(); await call("publish_scene", { sceneId: codeSceneId, revision: failDraft.revision, publicationId: failVersionId });
  const failRunId = randomUUID(); await call("submit_scene", { sceneId: codeSceneId, versionId: failVersionId, runId: failRunId, inputValues: codeInputs });
  assert.equal((await call("wait_run", { runId: failRunId, timeoutSeconds: 20 })).status, "failed");
  assert.equal((await call("get_run", { runId: failRunId })).error.includes("sandbox failure"), true);
  assert.equal((await raw("submit_scene", { sceneId: codeSceneId, versionId: codeVersionId, runId: codeRunId, inputValues: codeInputs })).error.code, "RUN_ALREADY_EXISTS");
  assert.equal((await call("get_scene", { sceneId: codeSceneId, versionId: codeVersionId })).workflow.steps[0].capabilityConfig.code, codeFlow.steps[0].capabilityConfig.code);
  console.log("Custom code step real stdio MCP passed: unified catalog -> invalid config rejected -> fixed publication -> sandbox execution -> typed outputs -> explicit failure -> snapshot isolation; no models/media.");

  // core.code media outputs: select, reorder and merge media already authorized in this run by file name.
  const otherSource = path.join(temporary, "other.png");
  const otherBytes = await sharp({ create: { width: 60, height: 60, channels: 3, background: "#3d5a80" } }).png().toBuffer();
  await writeFile(otherSource, otherBytes);
  const other = await call("upload_asset", { createId: randomUUID(), filePath: otherSource, kind: "image", name: "隔离第二张源图", category: "material" });
  const mediaSceneId = "isolated-code-media";
  const mediaFlow = { sceneId: mediaSceneId, name: "自定义代码媒体输出隔离验收", inputs: [{ key: "hero", type: "image_list", required: true }, { key: "gallery", type: "image_list" }],
    steps: [{ id: "pick", name: "按文件名选择与合并", kind: "capability", capabilityId: "core.code", capabilityVersion: codeCapability.version,
      capabilityConfig: { code: "const gallery = (inputs.gallery ?? []).map(item => item.filename);\nconst hero = (inputs.hero ?? []).map(item => item.filename);\nreturn { images: [...gallery, ...hero], count: gallery.length + hero.length };", timeoutMs: 5000 },
      inputs: [{ key: "hero", sourceRef: "input.hero" }, { key: "gallery", sourceRef: "input.gallery" }],
      outputs: [{ key: "images", type: "image_list" }, { key: "count", type: "number" }] }],
    outputs: [{ key: "images", type: "image_list", sourceRef: "step.pick.outputs.images" }, { key: "count", type: "number", sourceRef: "step.pick.outputs.count" }] };
  const mediaDraft = await call("create_scene", { scene: { id: mediaSceneId, title: "隔离代码媒体输出" }, workflow: mediaFlow });
  await call("validate_scene_draft", { sceneId: mediaSceneId, revision: mediaDraft.revision });
  const mediaVersionId = randomUUID(); const mediaPublication = { sceneId: mediaSceneId, revision: mediaDraft.revision, publicationId: mediaVersionId };
  await call("publish_scene", mediaPublication); assert.equal((await call("publish_scene", mediaPublication)).versionId, mediaVersionId);
  const mediaPrepared = await call("prepare_scene", { sceneId: mediaSceneId, versionId: mediaVersionId, inputValues: { hero: [asset.reference], gallery: [other.reference, asset.reference] } });
  assert.deepEqual(mediaPrepared.boundaries.externalSteps, []); assert.equal(mediaPrepared.externalServicesChecked, false, "代码不读取素材也不调用外部服务");
  const mediaRunId = randomUUID();
  await call("submit_scene", { sceneId: mediaSceneId, versionId: mediaVersionId, runId: mediaRunId, inputValues: { hero: [asset.reference], gallery: [other.reference, asset.reference] } }); // lost receipt -> same ID
  assert.equal((await call("wait_run", { runId: mediaRunId, timeoutSeconds: 20 })).status, "completed");
  const mediaOutputs = await call("get_run_outputs", { runId: mediaRunId, outputKey: "images", includeValues: true, valueLimit: 10 });
  assert.equal((await call("get_run_outputs", { runId: mediaRunId, outputKey: "count", includeValues: true })).outputs[0].value, 3);
  assert.equal(mediaOutputs.outputs[0].valuePage.total, 3); assert.equal(mediaOutputs.outputs[0].valuePage.complete, true);
  const mergedBytes = [];
  for (const reference of mediaOutputs.outputs[0].mediaReferences) { const response = await fetch(new URL(reference.url, base)); assert.equal(response.status, 200); mergedBytes.push(Buffer.from(await response.arrayBuffer())); }
  assert.deepEqual(mergedBytes.map(bytes => digest(bytes)), [digest(otherBytes), digest(sourceBytes), digest(sourceBytes)], "按文件名合并既有媒体，顺序保持且不产生新媒体");
  // A media port can only reference media the step received; an unknown file name fails at execution, before any output is written.
  const mediaMissing = structuredClone(mediaFlow); mediaMissing.steps[0].capabilityConfig.code = "return { images: [\"missing.png\"], count: 0 };";
  const mediaBase = await call("get_scene_draft", { sceneId: mediaSceneId });
  const mediaMissingDraft = await call("update_scene_draft", { sceneId: mediaSceneId, revision: mediaBase.revision, workflow: mediaMissing });
  await call("validate_scene_draft", { sceneId: mediaSceneId, revision: mediaMissingDraft.revision });
  const mediaMissingVersionId = randomUUID(); await call("publish_scene", { sceneId: mediaSceneId, revision: mediaMissingDraft.revision, publicationId: mediaMissingVersionId });
  const mediaMissingRunId = randomUUID();
  await call("submit_scene", { sceneId: mediaSceneId, versionId: mediaMissingVersionId, runId: mediaMissingRunId, inputValues: { hero: [asset.reference], gallery: [other.reference] } });
  assert.equal((await call("wait_run", { runId: mediaMissingRunId, timeoutSeconds: 20 })).status, "failed");
  assert.equal((await call("get_run", { runId: mediaMissingRunId })).error.includes("missing.png"), true, "未授权媒体文件名必须明确失败");
  assert.equal((await call("get_scene", { sceneId: mediaSceneId, versionId: mediaVersionId })).workflow.steps[0].capabilityConfig.code, mediaFlow.steps[0].capabilityConfig.code, "失败运行不改写固定发布快照");
  console.log("Custom code media outputs real stdio MCP passed: declared media ports -> filename selection/merge of already authorized media -> typed count -> unknown filename rejected -> snapshot isolation; no models, no new media.");
  // Generic start condition: every step can gate itself; a skipped step emits null outputs.
  const startSceneId = "isolated-start-condition";
  const startFlow = { sceneId: startSceneId, name: "开始条件隔离验收", inputs: [{ key: "flag", type: "boolean", required: true }],
    steps: [
      { id: "gated", name: "有条件步骤", kind: "capability", capabilityId: "core.code", capabilityVersion: "1", capabilityConfig: { code: 'return { text: "已执行" };', timeoutMs: 5000 },
        startCondition: { match: "all", rules: [{ id: "rule_start_1", leftRef: "input.flag", operator: "equals", valueSource: "literal", rightValue: "true", rightRef: "" }] },
        inputs: [], outputs: [{ key: "text", type: "text" }] },
      { id: "merge", name: "合并步骤", kind: "capability", capabilityId: "core.code", capabilityVersion: "1", capabilityConfig: { code: "return { text: inputs.gated ?? inputs.fallback };", timeoutMs: 5000 },
        inputs: [{ key: "gated", sourceRef: "step.gated.outputs.text" }, { key: "fallback", valueSource: "literal", literalType: "text", literalValue: "未执行" }], outputs: [{ key: "text", type: "text" }] }],
    outputs: [{ key: "text", type: "text", sourceRef: "step.merge.outputs.text" }] };
  const startDraft = await call("create_scene", { scene: { id: startSceneId, title: "隔离开始条件" }, workflow: startFlow });
  // A start condition referencing a later step or with no rules is rejected at draft write time, before publication.
  const forward = structuredClone(startDraft.workflow); forward.steps[1].startCondition = { match: "all", rules: [{ id: "rule_forward", leftRef: "step.merge.outputs.text", operator: "is_not_empty", valueSource: "literal", rightValue: "", rightRef: "" }] };
  assert.equal((await raw("update_scene_draft", { sceneId: startSceneId, revision: startDraft.revision, workflow: forward })).error.code, "INVALID_WORKFLOW_REFERENCE");
  const invalidRules = structuredClone(startDraft.workflow); invalidRules.steps[0].startCondition = { match: "all", rules: [] };
  assert.equal((await raw("update_scene_draft", { sceneId: startSceneId, revision: startDraft.revision, workflow: invalidRules })).error.code, "INVALID_WORKFLOW");
  const startFinal = await call("get_scene_draft", { sceneId: startSceneId });
  await call("validate_scene_draft", { sceneId: startSceneId, revision: startFinal.revision });
  const startVersionId = randomUUID(); const startPublication = { sceneId: startSceneId, revision: startFinal.revision, publicationId: startVersionId };
  await call("publish_scene", startPublication); assert.equal((await call("publish_scene", startPublication)).versionId, startVersionId);
  const startPrepared = await call("prepare_scene", { sceneId: startSceneId, versionId: startVersionId, inputValues: { flag: false } });
  assert.deepEqual(startPrepared.boundaries.externalSteps, [], "开始条件场景不应包含外部/计费步骤");
  const startRunTrue = randomUUID(); await call("submit_scene", { sceneId: startSceneId, versionId: startVersionId, runId: startRunTrue, inputValues: { flag: true } });
  assert.equal((await call("wait_run", { runId: startRunTrue, timeoutSeconds: 20 })).status, "completed");
  assert.equal((await call("get_run", { runId: startRunTrue })).outputs[0].value, "已执行");
  assert.equal((await call("get_run", { runId: startRunTrue })).steps[0].status, "completed");
  const startRunFalse = randomUUID(); await call("submit_scene", { sceneId: startSceneId, versionId: startVersionId, runId: startRunFalse, inputValues: { flag: false } });
  const startFalseRun = await call("get_run", { runId: startRunFalse });
  assert.equal((await call("wait_run", { runId: startRunFalse, timeoutSeconds: 20 })).status, "completed");
  assert.equal((await call("get_run", { runId: startRunFalse })).outputs[0].value, "未执行");
  assert.equal((await call("get_run", { runId: startRunFalse })).steps[0].status, "skipped");
  assert.equal((await call("get_run", { runId: startRunFalse })).steps[0].message, "开始条件未满足");
  assert.deepEqual((await call("get_run_outputs", { runId: startRunFalse, outputKey: "text", includeValues: true })).outputs[0].value, "未执行");
  console.log("Generic start condition real stdio MCP passed: any-step gating -> skip with null outputs -> downstream default -> invalid rule/later-reference rejected before publication; no models, isolated data.");
  const report = { status: "passed", compiledBackend: true, realStdioMcp: true, isolated: true, baseUrl: base, temporary, sceneId: pkg.scene.id, versionId, runId, rerunId, imageCount: media.length, media, generationExecuted: false, externalSteps: [], checks: ["catalog-pagination-and-schema", "legacy-compatibility-discovery", "HTTP-MCP-shared-catalog", "asset-upload", "draft-revision-conflict", "publish-id-reconciliation", "fixed-publication-preflight", "run-id-reconciliation", "parallel-basic-composition", "output-and-step-pagination", "image-dimensions-sha256-HEAD-Range", "selective-item-rerun", "original-run-and-artifact-immutability"] };
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--hold-ui")) {
    console.log("UI E2E ready: " + base + "; finish by creating " + path.join(temporary, "ui-finished"));
    const deadline = Date.now() + 1800000;
    while (Date.now() < deadline) { try { await access(path.join(temporary, "ui-finished")); break; } catch { await pause(500); } }
  }
} catch (error) { console.error(error); if (logs) console.error(logs.slice(-8000)); process.exitCode = 1; }
finally {
  await client.close().catch(() => undefined);
  if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); try { await bounded(exited, 10000); } catch { child.kill("SIGKILL"); await exited; } }
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("zane-basic-e2e-")) throw new Error("Refusing to remove unexpected E2E directory");
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
