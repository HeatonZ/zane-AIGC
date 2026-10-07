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
  const catalog = await call("list_capabilities", { tier: "basic", limit: 1 });
  assert.equal(catalog.selectionPolicy.defaultTier, "basic"); assert.ok(catalog.nextCursor && catalog.hasMore);
  let cursor = catalog.nextCursor; const capabilities = [...catalog.capabilities];
  while (cursor) { const page = await call("list_capabilities", { tier: "basic", limit: 2, cursor }); assert.equal(page.revision, catalog.revision); capabilities.push(...page.capabilities); cursor = page.nextCursor; }
  assert.equal(capabilities.length, new Set(capabilities.map(item => item.id)).size);
  assert.ok(capabilities.every(item => item.usage.tier === "basic"));
  assert.ok(capabilities.some(item => item.id === "media.select_references"));
  assert.ok(capabilities.find(item => item.id === "media.image_layout").inputs.find(input => input.key === "layout").valueSchema.properties);
  assert.equal((await raw("list_capabilities", { tier: "specialized", cursor: catalog.nextCursor })).error.code, "INVALID_CAPABILITY_CURSOR");
  const invalid = await client.callTool({ name: "list_capabilities", arguments: { tier: "not-a-tier" } }); assert.equal(invalid.isError, true);
  const specialized = await call("list_capabilities", { tier: "specialized", limit: 100 });
  assert.equal(specialized.capabilities.find(item => item.id === "comfyui.commerce_pack").usage.compatibilityOnly, true);
  assert.ok(specialized.capabilities.some(item => item.id === "comfyui.long_text_video" && item.label.includes("H3")));
  const httpCatalog = await (await fetch(base + "/api/v1/capabilities?tier=basic&limit=1")).json(); assert.equal(httpCatalog.revision, catalog.revision);

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

  const report = { status: "passed", compiledBackend: true, realStdioMcp: true, isolated: true, baseUrl: base, temporary, sceneId: pkg.scene.id, versionId, runId, rerunId, imageCount: media.length, media, generationExecuted: false, externalSteps: [], checks: ["basic-tier-pagination-and-schema", "legacy-compatibility-discovery", "HTTP-MCP-shared-catalog", "asset-upload", "draft-revision-conflict", "publish-id-reconciliation", "fixed-publication-preflight", "run-id-reconciliation", "parallel-basic-composition", "output-and-step-pagination", "image-dimensions-sha256-HEAD-Range", "selective-item-rerun", "original-run-and-artifact-immutability"] };
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
