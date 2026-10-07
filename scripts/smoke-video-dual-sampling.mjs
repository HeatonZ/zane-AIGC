import "./smoke-auth.mjs";
/** Real stdio MCP scene-migration loop against a temporary compiled backend. No generation. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { migrateVideoSampling, DUAL_VIDEO_FILES } from "../server/domain/videoWorkflowMigration.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "zane-dual-video-smoke-"));
const project = path.join(temporary, "project"); await mkdir(project);
const client = new Client({ name: "dual-video-smoke", version: "1.0.0" });
const node = (id, type, inputProperties = [], outputProperties = []) => ({ id, type, inputProperties, outputProperties });
const nodes = [node("92", "SaveVideo", [], ["video"]), node("115", "ResolutionSelector", ["aspect_ratio", "megapixels"]), node("155", "PrimitiveFloat", ["value"]), node("192", "MiniMaxH3ReferenceToVideo", ["prompt", "length"]), node("152", "CreateVideo", ["fps"]), node("196", "SelfLiftAvatarH3Sampler"), node("197", "H3SigmaRefiner"), node("201", "String", ["String"])];
const schema = { input: { optional: { ref_images: ["COMFY_AUTOGROW_V3", {}], ref_audios: ["COMFY_AUTOGROW_V3", {}] } } };
let child, exited, logs = "";
const bounded = async promise => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Dual video smoke timeout\n" + logs.slice(-4000))), 30000); })]); } finally { clearTimeout(timer); } };
try {
  child = spawn(process.execPath, [path.join(root, "dist-server/index.js"), "--production"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, API_HOST: "127.0.0.1", API_PORT: "0", APP_DATA_DIR: path.join(temporary, "data"), ZANE_PROJECT_DIR: project, HERMES_HOME: path.join(temporary, "no-hermes"), COMFYUI_BASE_URL: "http://127.0.0.1:1", ZANE_SHUTDOWN_TIMEOUT_MS: "1000" } });
  exited = new Promise(resolve => child.once("exit", resolve));
  const base = await bounded(new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => reject(Error("Temporary backend exited " + code))); child.stderr.on("data", chunk => { logs += chunk; }); child.stdout.on("data", chunk => { logs += chunk; const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs); if (match) resolve(match[1]); }); }));
  for (let i = 0; ; i++) { if ((await fetch(base + "/api/ready")).ok) break; assert.ok(i < 50); await new Promise(resolve => setTimeout(resolve, 50)); }
  await bounded(client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist-server/mcp/index.js")], cwd: root, env: { ...process.env, ZANE_BASE_URL: base }, stderr: "pipe" })));
  const call = async (name, args = {}) => { const result = await bounded(client.callTool({ name, arguments: args })); assert.ok(!result.isError && result.structuredContent?.ok, name + ": " + JSON.stringify(result)); return result.structuredContent.data; };
  const reject = async (name, args, code) => { const result = await client.callTool({ name, arguments: args }); assert.equal(result.isError, true); if (code) assert.equal(result.structuredContent.error.code, code); };
  const targets = [["text", "text-to-video-repaired"], ["reference", "reference-to-video-repaired"], ["no-design", "text-to-video-repaired"], ["long", "long-text-to-video"]];
  const untouched = await call("create_scene", { scene: { id: "untouched", title: "其他用户草稿" }, workflow: { sceneId: "untouched", name: "必须保留", inputs: [], steps: [{ id: "manual", name: "用户配置", kind: "manual", inputs: [], outputs: [] }], outputs: [] } });
  for (const [variant, filename] of targets) {
    const pkg = JSON.parse(await readFile(path.join(root, "examples/scenes", filename + ".json"), "utf8"));
    const sceneId = "dual-" + variant;
    const mode = variant === "long" ? "json" : "text";
    const workflow = { ...pkg.workflow, sceneId };
    const generate = workflow.steps.find(step => step.kind === "comfyui" && step.comfyui?.workflowFile.startsWith("Zane/video"));
    generate.comfyui.workflowFile = mode === "json" ? "Zane/video_json.json" : "Zane/video_UI.json";
    if (mode === "json") generate.comfyui.bindings.find(binding => binding.key === "shot_json").nodeId = "196";
    if (variant === "no-design") { workflow.steps.shift(); workflow.steps[0].promptTemplate = "直接使用{{input.thought}}"; }
    const initial = await call("create_scene", { scene: { ...pkg.scene, id: sceneId, title: "隔离双采 " + variant }, workflow, optionPresets: pkg.optionPresets });
    const previousId = randomUUID(); await call("publish_scene", { sceneId, revision: initial.revision, publicationId: previousId });
    const draft = await call("get_scene_draft", { sceneId });
    const migrated = migrateVideoSampling(draft.workflow, mode, nodes, schema);
    // Discard the write reply; read the same scene to reconcile the new workflow/revision.
    await call("update_scene_draft", { sceneId, revision: draft.revision, workflow: migrated });
    const next = await call("get_scene_draft", { sceneId });
    await reject("update_scene_draft", { sceneId, revision: draft.revision, workflow }, "RESOURCE_REVISION_CONFLICT");
    const invalid = structuredClone(next.workflow); invalid.steps.find(step => step.id === generate.id).comfyui.bindings[0].nodeId = "";
    await reject("update_scene_draft", { sceneId, revision: next.revision, workflow: invalid });
    assert.equal((await call("get_scene_draft", { sceneId })).revision, next.revision);
    // Reconcile a discarded update reply by reading the same object, without replay/overwrite.
    const reconciled = await call("get_scene_draft", { sceneId }); assert.deepEqual(reconciled.workflow, next.workflow);
    assert.equal((await call("validate_scene_draft", { sceneId, revision: next.revision })).valid, true);
    assert.equal((await call("get_scene", { sceneId })).versionId, previousId, "Saving/validating cannot publish");
    const publicationId = randomUUID();
    // Deliberately discard the publication response, then resolve the saved ID through MCP.
    await call("publish_scene", { sceneId, revision: next.revision, publicationId });
    const current = await call("get_scene", { sceneId, versionId: publicationId });
    const saved = current.workflow.steps.find(step => step.id === generate.id);
    assert.equal(saved.comfyui.workflowFile, DUAL_VIDEO_FILES[mode]);
    assert.deepEqual(saved.comfyui.bindings, next.workflow.steps.find(step => step.id === generate.id).comfyui.bindings);
    assert.equal((await call("publish_scene", { sceneId, revision: next.revision, publicationId })).created, false);
    await reject("publish_scene", { sceneId, revision: next.revision, publicationId: randomUUID() }, "RESOURCE_REVISION_CONFLICT");
    const old = await call("get_scene", { sceneId, versionId: previousId }); assert.equal(old.workflow.steps.find(step => step.id === generate.id).comfyui.workflowFile, mode === "json" ? "Zane/video_json.json" : "Zane/video_UI.json");
    if (mode === "json") { assert.equal(saved.comfyui.bindings.find(binding => binding.key === "shot_json").nodeId, "201"); assert.equal(saved.comfyui.bindings.find(binding => binding.key === "fps").literalValue, "24"); assert.equal(saved.comfyui.adapter, "long_text_video"); }
    const after = await call("get_scene_draft", { sceneId }); assert.equal(after.versions.length, 2);
  }
  assert.deepEqual((await call("get_scene_draft", { sceneId: "untouched" })).workflow, untouched.workflow);
  const runs = await call("list_runs", { limit: 1 }); assert.equal(runs.runs.length, 0);
  const health = await (await fetch(base + "/api/health")).json(); assert.equal(health.worker.active, 0); assert.equal(health.worker.queued, 0);
  console.log("PASS: four dual-sampling variants / real stdio MCP -> shared scene service -> SQLite / revision conflicts / invalid binding / publication response reconciliation / immutable old versions / no generation");
} catch (error) { console.error(error); if (logs) console.error(logs.slice(-4000)); process.exitCode = 1; }
finally {
  await client.close().catch(() => undefined);
  if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); try { await bounded(exited); } catch { child.kill("SIGKILL"); await exited; } }
  const resolved = path.resolve(temporary); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith("zane-dual-video-smoke-"));
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
