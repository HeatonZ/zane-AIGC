import { isDeepStrictEqual } from "node:util";
import { buildSceneDiff, diffValue } from "../domain/sceneDiff.js";
import type { SceneDiffPage, SceneDiffValuePage } from "../domain/sceneDiffContracts.js";
import type { SceneDiffQuery, SceneDiffValueQuery } from "../ai/sceneDiffSchemas.js";
import { asRecord, splitWorkflowReference } from "../domain/workflowValues.js";
import { contentRevision, referencedPresetIds, sceneContent, sceneContentHash } from "../domain/sceneContent.js";
import { validateWorkflowShape, validateCarryReferences, validateStartConditionReferences } from "../domain/workflowValidation.js";
import { isEmptyWorkflowInput, validateWorkflowInputs } from "../domain/inputValidation.js";
import type { RunWorkflowDefinition } from "../domain/types.js";
import type { ExecutorRegistry } from "../execution/executorRegistry.js";
import { HttpError } from "../errors.js";
import type { SceneCreate, SceneUpdate } from "../ai/sceneSchemas.js";
import type { WorkspaceService } from "./workspaceService.js";

type Workspace = Record<string, unknown>;
const records = (value: unknown) => (Array.isArray(value) ? value : []).map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
const versionsFor = (workspace: Workspace, sceneId: string) => asRecord(asRecord(workspace.sceneVersions)?.[sceneId]) ?? { publishedVersionId: null, versions: [] };
export function sceneDraftFromWorkspace(workspace: Workspace, sceneId: string) {
  const scene = records(workspace.scenes).find(scene => scene.id === sceneId);
  if (!scene) throw new HttpError(404, "没有找到此场景", "SCENE_NOT_FOUND");
  const workflow = asRecord(asRecord(workspace.workflows)?.[sceneId]) ?? null;
  const content = sceneContent(scene, workflow, records(workspace.optionPresets));
  const record = versionsFor(workspace, sceneId);
  const missingPresetIds = [...referencedPresetIds(workflow)].filter(id => !content.optionPresets.some(preset => preset.id === id));
  const published = records(record.versions).find(version => version.id === record.publishedVersionId);
  return { view: "draft" as const, sceneId, workspaceRevision: workspace.revision ?? null, revision: contentRevision({ content, missingPresetIds, versions: record }), contentHash: sceneContentHash(content), ...structuredClone(content), missingPresetIds, publishedVersionId: typeof record.publishedVersionId === "string" ? record.publishedVersionId : null, versions: records(record.versions).map(version => ({ versionId: version.id, version: version.version, publishedAt: version.publishedAt })), draftMatchesPublished: Boolean(published && (asRecord(published.publication)?.draftContentHash === sceneContentHash(content) || sceneContentHash(sceneContent(asRecord(published.scene) ?? {}, asRecord(published.workflow) ?? null, records(published.optionPresets))) === sceneContentHash(content))) };
}
function assertRevision(resource: string, expected: string, actual: string) {
  if (expected !== actual) throw new HttpError(409, "此配置已被修改，请读取当前对象后重新决策", "RESOURCE_REVISION_CONFLICT", { resource, expectedRevision: expected, currentRevision: actual, conflicts: [{ path: resource, reason: "revision_changed" }], nextAction: "read_current_resource" });
}
function normalizedScene(value: Record<string, unknown>) {
  return { shortTitle: value.title, summary: "", description: "", cover: "", accent: "green", stages: [], ...structuredClone(value) };
}
function normalizedWorkflow(sceneId: string, value: Record<string, unknown>) {
  if (value.sceneId !== undefined && value.sceneId !== sceneId) throw new HttpError(400, "workflow.sceneId必须与目标场景一致", "SCENE_ID_MISMATCH");
  if (value.publishedScene !== undefined) throw new HttpError(400, "草稿不能自行设置publishedScene来源标记", "INVALID_SCENE_DRAFT");
  validateWorkflowShape(value);
  const flow = { name: sceneId, ...structuredClone(value), sceneId } as unknown as RunWorkflowDefinition;
  if (flow.steps.length > 100 || flow.inputs.length > 200) throw new HttpError(400, "工作流规模超出限制", "INVALID_WORKFLOW");
  flow.inputs = flow.inputs.map(field => ({ label: field.key, required: false, ...field }));
  flow.outputs = flow.outputs.map(field => ({ label: field.key, ...field }));
  flow.steps = flow.steps.map(step => ({ promptTemplate: "", ...step, inputs: (step.inputs ?? []).map(input => ({ label: input.key, sourceRef: "", ...input })), outputs: (step.outputs ?? []).map(output => ({ label: output.key, description: "", ...output })), ...(step.comfyui ? { comfyui: { ...step.comfyui, bindings: step.comfyui.bindings ?? [] } } : {}) }));
  const ids = new Set<string>();
  for (const step of flow.steps) {
    if (!step.id || !step.name || !step.kind || ids.has(step.id)) throw new HttpError(400, "步骤ID、名称、执行方式缺失或ID重复", "INVALID_WORKFLOW");
    ids.add(step.id);
  }
  validateCarryReferences(flow);
  validateStartConditionReferences(flow);
  return flow as unknown as Record<string, unknown>;
}
function installNewPresets(workspace: Workspace, supplied: Array<Record<string, unknown>>, workflow: Record<string, unknown>) {
  const referenced = referencedPresetIds(workflow);
  const presets = records(workspace.optionPresets);
  const seen = new Set<string>();
  for (const preset of supplied) {
    const id = String(preset.id);
    if (seen.has(id)) throw new HttpError(400, "预设ID重复", "INVALID_OPTION_PRESET");
    seen.add(id);
    if (!referenced.has(id)) throw new HttpError(400, "只能随场景添加该流程引用的选项预设", "UNREFERENCED_OPTION_PRESET");
    const current = presets.find(item => item.id === id);
    if (current && !isDeepStrictEqual(current, preset)) throw new HttpError(409, "共享预设已有不同内容，请单独读取并用revision修改", "OPTION_PRESET_CONFLICT", { presetId: id, currentRevision: contentRevision(current), nextAction: "read_option_presets" });
    if (!current) presets.push(structuredClone(preset));
  }
  workspace.optionPresets = presets;
}
function resolvedWorkflow(workflow: Record<string, unknown>, presets: Array<Record<string, unknown>>) {
  const flow = structuredClone(workflow) as unknown as RunWorkflowDefinition;
  flow.inputs = flow.inputs.map(field => {
    const presetId = asRecord(field)?.optionPresetId;
    if (!presetId) return field;
    const preset = presets.find(preset => preset.id === presetId);
    if (!preset || !Array.isArray(preset.options) || preset.options.some(option => typeof option !== "string")) throw new HttpError(400, "引用的选项预设缺失或无效：" + String(presetId), "INVALID_OPTION_PRESET");
    return { ...field, options: preset.options as string[] };
  });
  return flow;
}
function validateReferences(flow: RunWorkflowDefinition) {
  const inputs = new Set(flow.inputs.map(input => input.key));
  const steps = new Map(flow.steps.map((step, index) => [step.id, { step, index }]));
  const check = (reference: string | undefined, before: number, path: string) => {
    if (!reference || reference.startsWith("iteration.")) return;
    const root = splitWorkflowReference(reference)?.root;
    const input = root?.startsWith("input.") ? root.slice(6) : undefined;
    const step = root ? /^step\.([a-zA-Z0-9_-]+)\.outputs\.([a-zA-Z0-9_]+)$/.exec(root) : undefined;
    const target = step ? steps.get(step[1]) : undefined;
    if (input !== undefined ? inputs.has(input) : target && target.index < before && target.step.outputs?.some(output => output.key === step![2])) return;
    throw new HttpError(400, "流程引用不存在、未声明或引用后续步骤：" + reference, "INVALID_WORKFLOW_REFERENCE", { path, reference });
  };
  flow.steps.forEach((step, index) => {
    step.inputs?.filter(input => input.valueSource !== "literal").forEach(input => check(input.sourceRef, index, "steps/" + step.id + "/inputs/" + input.key));
    step.comfyui?.bindings?.filter(binding => binding.direction === "input" && binding.valueSource !== "literal").forEach(binding => check(binding.sourceRef, index, "steps/" + step.id + "/bindings/" + binding.key));
    check(step.execution?.sourceRef, index, "steps/" + step.id + "/execution/sourceRef");
    check(step.execution?.carry?.initialSourceRef, index, "steps/" + step.id + "/execution/carry/initialSourceRef");
    step.control?.rules.forEach(rule => { check(rule.leftRef, index, "steps/" + step.id + "/rules/" + rule.id); if (rule.valueSource === "reference") check(rule.rightRef, index, "steps/" + step.id + "/rules/" + rule.id); });
    if (step.runCondition) { const condition = steps.get(step.runCondition.conditionStepId); if (!condition || condition.index >= index) throw new HttpError(400, "条件步骤不存在或位于后续", "INVALID_WORKFLOW_REFERENCE", { path: "steps/" + step.id + "/runCondition" }); }
  });
  check(flow.execution?.sourceRef, 0, "execution/sourceRef");
  flow.outputs.forEach(output => check(output.sourceRef, flow.steps.length, "outputs/" + output.key));
}

export class SceneDraftService {
  constructor(readonly workspace: WorkspaceService, readonly executors: ExecutorRegistry) {}
  async get(sceneId: string) {
    const workspace = await this.workspace.get();
    if (!workspace) throw new HttpError(409, "工作区尚未初始化", "WORKSPACE_NOT_INITIALIZED");
    return sceneDraftFromWorkspace(workspace, sceneId);
  }
  private async diffSnapshot(sceneId: string, expectedRevision?: string, expectedHash?: string) {
    const workspace = await this.workspace.get();
    if (!workspace) throw new HttpError(409, "工作区尚未初始化", "WORKSPACE_NOT_INITIALIZED");
    const draft = sceneDraftFromWorkspace(workspace, sceneId);
    if (expectedHash && expectedHash !== draft.contentHash) throw new HttpError(409, "当前编辑与服务端草稿尚未一致，请等待保存或重新读取", "SCENE_DRAFT_CHANGED", { sceneId, contentHash: draft.contentHash, currentRevision: draft.revision, nextAction: "get_scene_draft" });
    const record = versionsFor(workspace, sceneId);
    const version = records(record.versions).find(item => item.id === record.publishedVersionId);
    if (record.publishedVersionId && !version) throw new HttpError(409, "当前发布快照不存在，请重新读取场景", "SCENE_VERSION_UNAVAILABLE");
    if (version && (!asRecord(version.scene) || !asRecord(version.workflow) || typeof version.version !== "string" || typeof version.publishedAt !== "string")) throw new HttpError(409, "发布快照格式无效", "INVALID_SCENE_VERSION");
    const baseline = version ? { versionId: String(version.id), version: String(version.version), publishedAt: String(version.publishedAt) } : null;
    const preparationWarnings: SceneDiffPage["preparationWarnings"] = [];
    const workflow = structuredClone(draft.workflow);
    // The same local normalization as publish(), without validation, writes or execution.
    if (workflow && Array.isArray(workflow.steps)) workflow.steps = workflow.steps.map(raw => {
      try { return this.executors.prepareStep(raw as RunWorkflowDefinition["steps"][number]); }
      catch (error) {
        if (!(error instanceof HttpError)) throw error;
        preparationWarnings.push({ stepId: String(asRecord(raw)?.id ?? ""), message: error.message });
        return raw;
      }
    });
    const after = sceneContent(draft.scene, workflow, draft.optionPresets);
    const publishedWorkflow = version ? structuredClone(asRecord(version.workflow)!) : null;
    // Legacy/UI publications may predate capability pinning. Normalize only those
    // unpinned steps locally for a like-for-like view; never rewrite the snapshot
    // or replace an explicitly pinned historical capability version.
    if (publishedWorkflow && Array.isArray(publishedWorkflow.steps)) publishedWorkflow.steps = publishedWorkflow.steps.map(raw => {
      const step = asRecord(raw);
      if (step?.capabilityId && step.capabilityVersion) return raw;
      try { return this.executors.prepareStep(raw as RunWorkflowDefinition["steps"][number]); }
      catch (error) { if (!(error instanceof HttpError)) throw error; return raw; }
    });
    const before = version ? sceneContent(asRecord(version.scene)!, publishedWorkflow, records(version.optionPresets)) : null;
    const revision = contentRevision({ sceneId, draftRevision: draft.revision, baseline, before, after, preparationWarnings });
    if (expectedRevision && revision !== expectedRevision) throw new HttpError(409, "草稿、当前发布版或能力配置已变化，请重新读取差异第一页", "SCENE_DIFF_CHANGED", { sceneId, expectedRevision, currentRevision: revision, nextAction: "get_scene_draft_diff" });
    return { draft, baseline, revision, preparationWarnings, changes: buildSceneDiff(before, after) };
  }
  async diff(sceneId: string, query: SceneDiffQuery): Promise<SceneDiffPage> {
    const snapshot = await this.diffSnapshot(sceneId, query.revision, query.contentHash);
    let offset = 0;
    if (query.cursor) {
      let cursor: Record<string, unknown> | undefined;
      try { cursor = asRecord(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))); } catch { /* reject below */ }
      if (!cursor || cursor.sceneId !== sceneId || typeof cursor.revision !== "string" || !/^[a-f0-9]{64}$/.test(cursor.revision) || !Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0) throw new HttpError(400, "差异游标无效或不属于此场景", "INVALID_SCENE_DIFF_CURSOR");
      if (cursor.revision !== snapshot.revision) throw new HttpError(409, "差异已变化，请重新读取第一页", "SCENE_DIFF_CHANGED", { sceneId, currentRevision: snapshot.revision, nextAction: "get_scene_draft_diff" });
      offset = cursor.offset as number;
      if (offset > snapshot.changes.length) throw new HttpError(400, "差异游标超出范围", "INVALID_SCENE_DIFF_CURSOR");
    }
    const summary: SceneDiffPage["summary"] = { added: 0, removed: 0, changed: 0, reordered: 0 };
    for (const change of snapshot.changes) summary[change.kind]++;
    const changes: SceneDiffPage["changes"] = [];
    let remaining = 65536;
    for (const { beforePresent, afterPresent, ...change } of snapshot.changes.slice(offset, offset + query.limit)) {
      if (remaining < 2) break;
      const before = diffValue(change.before, beforePresent, 0, Math.min(query.valueLimit, remaining - 1));
      remaining -= Array.from(before.text).length;
      const after = diffValue(change.after, afterPresent, 0, Math.min(query.valueLimit, remaining));
      remaining -= Array.from(after.text).length;
      changes.push({ ...change, before, after });
    }
    const nextOffset = offset + changes.length, hasMore = nextOffset < snapshot.changes.length;
    return { sceneId, revision: snapshot.revision, draftRevision: snapshot.draft.revision, contentHash: snapshot.draft.contentHash, baseline: snapshot.baseline, comparisonBasis: "publication-ready", preparationWarnings: snapshot.preparationWarnings, hasChanges: snapshot.changes.length > 0, summary, total: snapshot.changes.length, valueBudgetChars: 65536, changes, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({ sceneId, revision: snapshot.revision, offset: nextOffset })).toString("base64url") : null, nextAction: hasMore ? "read_more_changes" : snapshot.changes.length ? "validate_scene_draft" : "get_scene" };
  }
  async diffValue(sceneId: string, query: SceneDiffValueQuery): Promise<SceneDiffValuePage> {
    const snapshot = await this.diffSnapshot(sceneId, query.revision);
    const change = snapshot.changes.find(item => item.changeId === query.changeId);
    if (!change) throw new HttpError(404, "没有找到此差异项", "SCENE_DIFF_CHANGE_NOT_FOUND");
    const value = diffValue(change[query.side], query.side === "before" ? change.beforePresent : change.afterPresent, query.offset, query.limit);
    if (query.offset > value.totalChars) throw new HttpError(400, "读取位置超出差异值范围", "INVALID_SCENE_DIFF_OFFSET");
    return { sceneId, revision: snapshot.revision, changeId: query.changeId, side: query.side, value, nextAction: value.complete ? "get_scene_draft_diff" : "read_more_value" };
  }
  async create(input: SceneCreate) {
    const sceneId = input.scene.id;
    const workflow = normalizedWorkflow(sceneId, input.workflow);
    const result = await this.workspace.mutateScoped(current => {
      const existing = records(current.scenes).find(scene => scene.id === sceneId);
      if (existing) throw new HttpError(409, "场景ID已存在；读取该场景对账，不要换ID自动重建", "SCENE_ALREADY_EXISTS", { sceneId, currentRevision: sceneDraftFromWorkspace(current, sceneId).revision });
      installNewPresets(current, input.optionPresets ?? [], workflow);
      current.scenes = [...records(current.scenes), normalizedScene(input.scene)];
      current.workflows = { ...asRecord(current.workflows), [sceneId]: workflow };
      current.sceneVersions = { ...asRecord(current.sceneVersions), [sceneId]: { publishedVersionId: null, versions: [] } };
      return { workspace: current, result: { created: true } };
    }, true);
    return { ...sceneDraftFromWorkspace(result.workspace, sceneId), ...result.result };
  }
  async update(sceneId: string, input: SceneUpdate) {
    if (!input.scene && !input.workflow && !input.optionPresets) throw new HttpError(400, "至少提供scene、workflow或optionPresets之一", "INVALID_SCENE_DRAFT");
    if (input.scene && input.scene.id !== sceneId) throw new HttpError(400, "scene.id必须与目标场景一致", "SCENE_ID_MISMATCH");
    const result = await this.workspace.mutateScoped(current => {
      const before = sceneDraftFromWorkspace(current, sceneId);
      assertRevision("/scenes/" + sceneId + "/draft", input.revision, before.revision);
      const workflow = input.workflow ? normalizedWorkflow(sceneId, input.workflow) : before.workflow;
      if (input.optionPresets) { if (!workflow) throw new HttpError(400, "先提供流程再添加预设", "INVALID_SCENE_DRAFT"); installNewPresets(current, input.optionPresets, workflow); }
      if (input.scene) current.scenes = records(current.scenes).map(scene => scene.id === sceneId ? normalizedScene(input.scene!) : scene);
      if (input.workflow) current.workflows = { ...asRecord(current.workflows), [sceneId]: workflow };
      return { workspace: current, result: {} };
    });
    return sceneDraftFromWorkspace(result.workspace, sceneId);
  }
  private validated(draft: ReturnType<typeof sceneDraftFromWorkspace>) {
    if (!draft.workflow) throw new HttpError(400, "场景缺少流程草稿", "INVALID_SCENE_DRAFT");
    if (draft.missingPresetIds.length) throw new HttpError(400, "选项预设缺失", "INVALID_OPTION_PRESET", { presetIds: draft.missingPresetIds });
    const flow = resolvedWorkflow(normalizedWorkflow(draft.sceneId, draft.workflow), draft.optionPresets);
    validateReferences(flow);
    for (const field of flow.inputs) {
      const value = asRecord(field)?.defaultValue;
      if (field.hidden && field.required && isEmptyWorkflowInput(field, value)) {
        const label = String(asRecord(field)?.label ?? field.key);
        throw new HttpError(400, `隐藏的必填字段“${label}”需要配置非空默认值`, "HIDDEN_REQUIRED_INPUT_DEFAULT_MISSING", { inputKey: field.key, nextAction: "set_default_or_show_input" });
      }
      if (value !== undefined && value !== null && value !== "") validateWorkflowInputs({ ...flow, inputs: [{ ...field, required: false }] }, { [field.key]: value as never });
    }
    // Installed capability validators are local; no executor or remote service is invoked.
    flow.steps.forEach(step => this.executors.prepareStep(step));
    return flow;
  }
  async validate(sceneId: string, revision: string) {
    const draft = await this.get(sceneId);
    assertRevision("/scenes/" + sceneId + "/draft", revision, draft.revision);
    this.validated(draft);
    return { sceneId, revision, valid: true, validationScope: "draft-shape-references-defaults-presets-capabilities", externalServicesChecked: false, nextAction: "publish_scene" };
  }
  async publish(sceneId: string, revision: string, publicationId: string) {
    const result = await this.workspace.mutateScoped(current => {
      const draft = sceneDraftFromWorkspace(current, sceneId);
      const record = versionsFor(current, sceneId);
      const existing = records(record.versions).find(version => version.id === publicationId);
      if (existing) {
        if (asRecord(existing.publication)?.expectedRevision !== revision) throw new HttpError(409, "publicationId已用于不同发布请求", "PUBLICATION_ID_CONFLICT", { publicationId });
        return { result: { created: false, version: structuredClone(existing), isCurrentPublished: record.publishedVersionId === publicationId } };
      }
      assertRevision("/scenes/" + sceneId + "/draft", revision, draft.revision);
      this.validated(draft);
      const snapshotWorkflow = structuredClone(draft.workflow)!;
      // Pin installed capabilities into the immutable snapshot; preserve editor input presets.
      snapshotWorkflow.steps = (snapshotWorkflow.steps as RunWorkflowDefinition["steps"]).map(step => this.executors.prepareStep(step));
      const content = sceneContent(draft.scene, snapshotWorkflow, draft.optionPresets);
      const version = { id: publicationId, version: sceneContentHash(content), publishedAt: new Date().toISOString(), ...structuredClone(content), publication: { expectedRevision: revision, draftContentHash: draft.contentHash } };
      const versions = [...records(record.versions), version].slice(-10);
      current.sceneVersions = { ...asRecord(current.sceneVersions), [sceneId]: { ...record, publishedVersionId: publicationId, versions } };
      return { workspace: current, result: { created: true, version, isCurrentPublished: true } };
    });
    return { sceneId, versionId: publicationId, version: result.result.version.version, publishedAt: result.result.version.publishedAt, created: result.result.created, isCurrentPublished: result.result.isCurrentPublished, revision: sceneDraftFromWorkspace(result.workspace, sceneId).revision, nextAction: "get_scene" };
  }
  async restore(sceneId: string, revision: string, versionId: string) {
    const result = await this.workspace.mutateScoped(current => {
      const draft = sceneDraftFromWorkspace(current, sceneId);
      assertRevision("/scenes/" + sceneId + "/draft", revision, draft.revision);
      const version = records(versionsFor(current, sceneId).versions).find(version => version.id === versionId);
      if (!version) throw new HttpError(409, "发布版本不在保留范围内", "SCENE_VERSION_UNAVAILABLE");
      const scene = asRecord(version.scene); const originalWorkflow = asRecord(version.workflow);
      if (!scene || !originalWorkflow) throw new HttpError(409, "发布快照格式无效", "INVALID_SCENE_VERSION");
      const workflow = normalizedWorkflow(sceneId, originalWorkflow);
      const presets = records(current.optionPresets);
      const remap = new Map<string, string>(); const createdPresetIds: string[] = [];
      for (const preset of records(version.optionPresets)) {
        const existing = presets.find(item => item.id === preset.id);
        if (!existing) { presets.push(structuredClone(preset)); createdPresetIds.push(String(preset.id)); continue; }
        if (isDeepStrictEqual(existing, preset)) continue;
        const newId = String(preset.id).slice(0, 150) + "-restored-" + contentRevision(preset).slice(0, 12);
        const renamed = { ...structuredClone(preset), id: newId };
        const collision = presets.find(item => item.id === newId);
        if (collision && !isDeepStrictEqual(collision, renamed)) throw new HttpError(409, "恢复预设ID冲突", "OPTION_PRESET_CONFLICT", { presetId: newId });
        if (!collision) { presets.push(renamed); createdPresetIds.push(newId); }
        remap.set(String(preset.id), newId);
      }
      const remapField = (value: unknown) => { const field = asRecord(value); if (field && typeof field.optionPresetId === "string" && remap.has(field.optionPresetId)) field.optionPresetId = remap.get(field.optionPresetId); };
      records(workflow.inputs).forEach(remapField);
      records(workflow.steps).forEach(step => records(asRecord(step.comfyui)?.bindings).forEach(binding => remapField(binding.sourceInputFormat)));
      current.scenes = records(current.scenes).map(item => item.id === sceneId ? structuredClone(scene) : item);
      current.workflows = { ...asRecord(current.workflows), [sceneId]: workflow };
      current.optionPresets = presets;
      return { workspace: current, result: { restoredFromVersionId: versionId, createdPresetIds } };
    });
    return { ...sceneDraftFromWorkspace(result.workspace, sceneId), ...result.result, nextAction: "validate_scene_draft" };
  }
  async delete(sceneId: string, revision: string) {
    const result = await this.workspace.mutateScoped(current => {
      assertRevision("/scenes/" + sceneId + "/draft", revision, sceneDraftFromWorkspace(current, sceneId).revision);
      current.scenes = records(current.scenes).filter(scene => scene.id !== sceneId);
      current.workflows = Object.fromEntries(Object.entries(asRecord(current.workflows) ?? {}).filter(([id]) => id !== sceneId));
      current.sceneVersions = Object.fromEntries(Object.entries(asRecord(current.sceneVersions) ?? {}).filter(([id]) => id !== sceneId));
      current.drafts = records(current.drafts).filter(draft => draft.sceneId !== sceneId);
      return { workspace: current, result: { sceneId, deleted: true } };
    });
    return { ...result.result, workspaceRevision: result.workspace.revision, preservedRuns: true, preservedAssets: true };
  }
  async listPresets(q = "", limit = 20, cursor?: string) {
    let after = "";
    if (cursor) {
      try { const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); if (decoded.q !== q || typeof decoded.after !== "string") throw new Error(); after = decoded.after; }
      catch { throw new HttpError(400, "选项预设分页游标无效", "INVALID_CURSOR"); }
    }
    const current = await this.workspace.get();
    const all = records(current?.optionPresets).filter(preset => !q || (String(preset.name) + " " + String(preset.id)).toLocaleLowerCase().includes(q.toLocaleLowerCase())).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const remaining = all.filter(preset => !after || String(preset.id).localeCompare(after) > 0); const page = remaining.slice(0, limit); const hasMore = remaining.length > page.length;
    return { initialized: Boolean(current), workspaceRevision: current?.revision ?? null, presets: page.map(preset => ({ ...preset, revision: contentRevision(preset), usedBySceneIds: records(current?.scenes).filter(scene => referencedPresetIds(asRecord(asRecord(current?.workflows)?.[String(scene.id)]) ?? null).has(String(preset.id))).map(scene => scene.id) })), hasMore, ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ q, after: page[page.length - 1].id })).toString("base64url") } : {}) };
  }
  async savePreset(preset: Record<string, unknown>, revision?: string) {
    const result = await this.workspace.mutateScoped(current => {
      const presets = records(current.optionPresets); const previous = presets.find(item => item.id === preset.id);
      if (previous) {
        if (!revision) throw new HttpError(409, "预设已存在，修改需要当前revision", "OPTION_PRESET_ALREADY_EXISTS", { presetId: preset.id, currentRevision: contentRevision(previous) });
        assertRevision("/option-presets/" + String(preset.id), revision, contentRevision(previous));
      } else if (revision) throw new HttpError(409, "预设已不存在，请重新读取", "OPTION_PRESET_NOT_FOUND");
      current.optionPresets = previous ? presets.map(item => item.id === preset.id ? structuredClone(preset) : item) : [...presets, structuredClone(preset)];
      return { workspace: current, result: { created: !previous } };
    }, true);
    return { ...result.result, preset: { ...structuredClone(preset), revision: contentRevision(preset) }, workspaceRevision: result.workspace.revision };
  }
  async deletePreset(presetId: string, revision: string) {
    const result = await this.workspace.mutateScoped(current => {
      const preset = records(current.optionPresets).find(item => item.id === presetId);
      if (!preset) throw new HttpError(404, "没有找到此预设", "OPTION_PRESET_NOT_FOUND");
      assertRevision("/option-presets/" + presetId, revision, contentRevision(preset));
      const using = records(current.scenes).filter(scene => referencedPresetIds(asRecord(asRecord(current.workflows)?.[String(scene.id)]) ?? null).has(presetId)).map(scene => scene.id);
      if (using.length) throw new HttpError(409, "预设仍被草稿引用，先解除引用再删除", "OPTION_PRESET_IN_USE", { presetId, sceneIds: using });
      current.optionPresets = records(current.optionPresets).filter(item => item.id !== presetId);
      return { workspace: current, result: { presetId, deleted: true } };
    });
    return { ...result.result, workspaceRevision: result.workspace.revision, preservedPublishedSnapshots: true };
  }
}
