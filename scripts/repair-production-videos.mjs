import { workbenchFetch } from "./workbench-auth.mjs";
/** Two-scene production configuration repair. Dry-run by default; never submits model jobs. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { validateWorkflowShape } from "../server/domain/workflowValidation.ts";
import { createSceneVersion } from "../src/lib/sceneVersions.ts";
import { publishedSnapshot } from "./audit-production.mjs";

export const VIDEO_REPAIR_TARGETS = Object.freeze([
  { sceneId: "scene_8ea4173e-d278-4703-9bec-418498ace6ee", title: "AI文生视频", reference: false },
  { sceneId: "scene_3a95a9cb-ed5e-468f-aac9-59b670b1f979", title: "AI参考生视频", reference: true },
]);
const REFERENCE_MARKER = "[Zane 参考图约束]";

export function repairVideoWorkflow(workflow, { reference, saveNodeId = "92", referenceNodeId = "192" }) {
  const next = structuredClone(workflow);
  for (const step of next.steps) {
    if (step.kind === "comfyui" || step.comfyui === undefined) continue;
    assert.equal(step.kind, "hermes", "Unexpected non-Comfy step with legacy configuration");
    assert.equal(step.comfyui.workflowFile, "", "Do not discard a nonempty legacy workflow");
    assert.deepEqual(step.comfyui.bindings, [], "Do not discard nonempty legacy bindings");
    assert.ok(Object.keys(step.comfyui).every(key => ["workflowFile", "bindings"].includes(key)), "Do not discard adapter-specific configuration");
    delete step.comfyui;
  }
  const candidates = next.steps.filter(step => step.kind === "comfyui" && step.comfyui?.workflowFile === "Zane/video_UI.json");
  assert.equal(candidates.length, 1, "Expected exactly one known H3 generation step");
  const generate = candidates[0];
  const videoBindings = generate.comfyui.bindings.filter(binding => binding.direction === "output" && binding.type === "video_list");
  assert.equal(videoBindings.length, 1, "Expected exactly one final video binding");
  assert.equal(videoBindings[0].property, "video");
  videoBindings[0].nodeId = String(saveNodeId);
  assert.ok(next.outputs.some(output => output.type === "video_list" && output.sourceRef === `step.${generate.id}.outputs.${videoBindings[0].key}`), "Final output must expose the actual generation step");
  if (reference) {
    assert.ok(next.inputs.some(field => field.key === "references" && field.type === "image_list" && field.required === true), "Reference images must be required");
    const input = generate.inputs.find(item => item.key === "references");
    if (input) assert.equal(input.sourceRef, "input.references", "Do not silently replace a different reference source");
    else generate.inputs.push({ key: "references", label: "参考图", sourceRef: "input.references", valueSource: "reference" });
    const binding = generate.comfyui.bindings.find(item => item.direction === "input" && item.key === "references");
    const desired = { key: "references", label: "参考图", direction: "input", nodeId: String(referenceNodeId), property: "ref_images", type: "image_list", sourceRef: "input.references", valueSource: "reference", required: true };
    if (binding) {
      assert.equal(binding.sourceRef, desired.sourceRef, "Do not replace a different reference binding");
      Object.assign(binding, desired);
    } else generate.comfyui.bindings.push(desired);
    for (const step of next.steps.filter(step => step.kind === "hermes")) {
      if (!(step.inputs ?? []).some(item => item.sourceRef === "input.references")) step.inputs.push({ key: "references", label: "有序参考图", sourceRef: "input.references", valueSource: "reference" });
      if (!(step.promptTemplate ?? "").includes(REFERENCE_MARKER)) {
        step.promptTemplate = `${step.promptTemplate ?? ""}\n\n${REFERENCE_MARKER}\n输入参考图将按原顺序直接传入 H3 模型；第1张对应 <Picture 1>，后续依次对应 <Picture 2> 等。严格保留参考图的主体外观、结构、颜色及用户指定构图；不虚构未上传的参考图，不擅自新增主体、对白或音乐。输出只需用户指定时长的一个连续镜头，明确引用实际存在的 Picture 编号。`;
      }
    }
  }
  validateWorkflowShape(next);
  return next;
}

export function prepareVideoRepair(workspace, graphNodes, schema) {
  const saves = graphNodes.filter(node => node.type === "SaveVideo" && node.outputProperties.includes("video"));
  const references = graphNodes.filter(node => node.type === "MiniMaxH3ReferenceToVideo");
  assert.equal(saves.length, 1, "Ambiguous actual video output node");
  assert.equal(references.length, 1, "Ambiguous actual H3 reference node");
  const imageSchema = schema.input?.optional?.ref_images ?? schema.input?.required?.ref_images;
  assert.equal(imageSchema?.[0], "COMFY_AUTOGROW_V3", "Installed H3 node must support real reference image ports");
  assert.ok(imageSchema?.[1]?.template?.max >= 1);
  const desired = structuredClone(workspace);
  const changes = [];
  for (const target of VIDEO_REPAIR_TARGETS) {
    const published = publishedSnapshot(workspace, target.sceneId);
    assert.ok(published, `Missing published scene ${target.title}`);
    const scene = workspace.scenes.find(item => item.id === target.sceneId);
    assert.equal(scene?.title, target.title);
    assert.deepEqual(workspace.workflows[target.sceneId], published.workflow, `Unpublished user edits in ${target.title}; do not overwrite them`);
    const workflow = repairVideoWorkflow(published.workflow, { reference: target.reference, saveNodeId: saves[0].id, referenceNodeId: references[0].id });
    if (JSON.stringify(workflow) === JSON.stringify(published.workflow)) continue;
    const version = createSceneVersion(scene, workflow, workspace.optionPresets);
    desired.workflows[target.sceneId] = workflow;
    // Preserve every existing version, rather than pruning old user history.
    desired.sceneVersions[target.sceneId] = { ...desired.sceneVersions[target.sceneId], publishedVersionId: version.id, versions: [...desired.sceneVersions[target.sceneId].versions, version] };
    changes.push({ ...target, previousPublishedVersionId: published.id, publishedVersionId: version.id, version: version.version, workflow });
  }
  return { desired, changes };
}

export function assertUntargetedWorkspacePreserved(before, after) {
  const allowed = new Set(VIDEO_REPAIR_TARGETS.map(item => item.sceneId));
  for (const key of ["format", "scenes", "optionPresets", "drafts"]) assert.deepEqual(after[key], before[key], `Unexpected changes to ${key}`);
  assert.deepEqual(Object.keys(after.workflows).sort(), Object.keys(before.workflows).sort());
  assert.deepEqual(Object.keys(after.sceneVersions).sort(), Object.keys(before.sceneVersions).sort());
  for (const id of Object.keys(before.workflows)) if (!allowed.has(id)) assert.deepEqual(after.workflows[id], before.workflows[id], `Unexpected changes to workflow ${id}`);
  for (const id of Object.keys(before.sceneVersions)) if (!allowed.has(id)) assert.deepEqual(after.sceneVersions[id], before.sceneVersions[id], `Unexpected changes to published scene ${id}`);
  for (const id of allowed) for (const oldVersion of before.sceneVersions[id].versions) assert.deepEqual(after.sceneVersions[id].versions.find(version => version.id === oldVersion.id), oldVersion, "Existing versions must remain unchanged");
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { "apply": { type: "boolean", default: false }, "base-url": { type: "string", default: "http://127.0.0.1:8799" }, "output-dir": { type: "string", default: ".local/production-video-retest-20261001" } } });
  const base = new URL(values["base-url"]);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) && !base.username && !base.password, "Production repair must target the local service");
  const output = path.resolve(values["output-dir"]); await mkdir(output, { recursive: true });
  const json = async (route, options = {}) => {
    const response = await workbenchFetch(new URL(route, base), { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error(`${route}: HTTP ${response.status} ${(await response.text()).slice(0,1500)}`);
    return response.json();
  };
  const workspace = (await json("/api/workspace")).workspace;
  assert.ok(workspace, "No initialized production workspace");
  const detail = await json(`/api/comfyui/workflow?filename=${encodeURIComponent("Zane/video_UI.json")}`);
  const settings = await json("/api/settings");
  const comfyBase = new URL(settings.comfyuiBaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(comfyBase.hostname) && !comfyBase.username && !comfyBase.password);
  const schemas = await (await fetch(new URL("/object_info/MiniMaxH3ReferenceToVideo", comfyBase), { signal: AbortSignal.timeout(10000) })).json();
  const { desired, changes } = prepareVideoRepair(workspace, detail.nodes, schemas.MiniMaxH3ReferenceToVideo);
  assertUntargetedWorkspacePreserved(workspace, desired);
  const report = { checkedAt: new Date().toISOString(), baseUrl: base.origin, apply: values.apply, changes: changes.map(({ workflow, ...change }) => change), otherScenesUntouched: true, sharedComfyGraphModified: false, modelJobsSubmitted: 0 };
  await writeFile(path.join(output, "repair-plan.json"), JSON.stringify(report,null,2));
  for (const change of changes) await writeFile(path.join(output, `${change.reference ? "reference-video" : "text-video"}-repaired-workflow.json`), JSON.stringify(change.workflow,null,2));
  if (!values.apply || !changes.length) { console.log(JSON.stringify(report,null,2)); return report; }
  const health = await json("/api/health");
  assert.equal(health.status, "ok"); assert.equal(health.worker.active, 0); assert.equal(health.worker.queued, 0); assert.equal(health.worker.preparing ?? 0, 0);
  const backup = path.join(output, `workspace-before-publication-${Date.now()}.json`);
  await writeFile(backup, JSON.stringify(workspace,null,2));
  const updated = (await json("/api/workspace/merge", { method: "POST", body: JSON.stringify({ base: workspace, workspace: desired }) })).workspace;
  assertUntargetedWorkspacePreserved(workspace, updated);
  for (const change of changes) {
    assert.equal(updated.sceneVersions[change.sceneId].publishedVersionId, change.publishedVersionId, "Production did not confirm the new version");
    assert.deepEqual(publishedSnapshot(updated, change.sceneId).workflow, change.workflow);
  }
  await writeFile(path.join(output, "workspace-after-publication.json"), JSON.stringify(updated,null,2));
  const result = { ...report, appliedAt: new Date().toISOString(), backup, revision: updated.revision };
  await writeFile(path.join(output, "repair-applied.json"), JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2)); return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();