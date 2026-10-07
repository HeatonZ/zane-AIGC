import { stat } from "node:fs/promises";
import type { JsonValue, RunWorkflowDefinition, SavedSettings } from "../domain/types.js";
import { asRecord, normalizeRunWorkflow } from "../domain/workflowValues.js";
import { validateWorkflowShape, validateCarryReferences } from "../domain/workflowValidation.js";
import { validateWorkflowInputs, workflowInputDefaults } from "../domain/inputValidation.js";
import { sceneInputContract } from "../domain/inputContract.js";
import { SceneDraftService, sceneDraftFromWorkspace } from "./sceneDraftService.js";
import { sceneQuery } from "../ai/sceneSchemas.js";
import { HttpError } from "../errors.js";
import type { ExecutorRegistry } from "../execution/executorRegistry.js";
import type { AssetService } from "./assetService.js";
import type { WorkspaceService } from "./workspaceService.js";

export class AiSceneService {
  readonly drafts: SceneDraftService;
  constructor(readonly workspace: WorkspaceService, readonly executors: ExecutorRegistry, readonly assets: AssetService, readonly loadSettings: () => Promise<SavedSettings>) { this.drafts = new SceneDraftService(workspace, executors); }
  async list(query: { limit?: number; cursor?: string } = {}) {
    const parsed = sceneQuery.safeParse(query);
    if (!parsed.success) throw new HttpError(400, "场景目录分页参数无效", "INVALID_AI_REQUEST");
    const { limit, cursor } = parsed.data;
    const workspace = await this.workspace.get();
    const revision = typeof workspace?.revision === "number" ? workspace.revision : null;
    const all = Array.isArray(workspace?.scenes) ? workspace.scenes : [];
    let offset = 0;
    if (cursor) {
      let decoded: unknown;
      try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
      catch { throw new HttpError(400, "场景目录游标无效", "INVALID_SCENE_CURSOR"); }
      const page = asRecord(decoded);
      if (page?.kind !== "scenes/v1" || !Number.isSafeInteger(page.offset) || Number(page.offset) <= 0 || !(page.revision === null || Number.isSafeInteger(page.revision))) throw new HttpError(400, "场景目录游标无效", "INVALID_SCENE_CURSOR");
      if (page.revision !== revision) throw new HttpError(409, "场景目录已变化，请重新读取第一页", "SCENE_PAGE_CHANGED", { workspaceRevision: revision, nextAction: "list_scenes_from_start" });
      offset = Number(page.offset);
      if (offset >= all.length) throw new HttpError(400, "场景目录游标超出范围", "INVALID_SCENE_CURSOR");
    }
    const versions = asRecord(workspace?.sceneVersions);
    const scenes = all.slice(offset, offset + limit).map(raw => {
      const scene = asRecord(raw) ?? {};
      const draft = sceneDraftFromWorkspace(workspace!, String(scene.id));
      const record = asRecord(versions?.[String(scene.id)]);
      const published = Array.isArray(record?.versions) ? record.versions.map(asRecord).find(version => version?.id === record.publishedVersionId) : undefined;
      const publishedScene = asRecord(published?.scene);
      return { sceneId: scene.id, title: scene.title, summary: scene.summary ?? "", draftRevision: draft.revision, draftMatchesPublished: draft.draftMatchesPublished, publishedTitle: publishedScene?.title ?? null, publishedSummary: publishedScene?.summary ?? null, publishedVersionId: published?.id ?? null, publishedVersion: published?.version ?? null, publishedAt: published?.publishedAt ?? null, versions: Array.isArray(record?.versions) ? record.versions.map(asRecord).filter(Boolean).map(version => ({ versionId: version!.id, version: version!.version, publishedAt: version!.publishedAt })) : [] };
    });
    const hasMore = offset + scenes.length < all.length;
    return { workspaceRevision: revision, initialized: Boolean(workspace), catalogView: "draft" as const, executionView: "published" as const, total: all.length, scenes, hasMore, ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ kind: "scenes/v1", revision, offset: offset + scenes.length })).toString("base64url") } : {}) };
  }
  async get(sceneId: string, versionId?: string) {
    const workspace = await this.workspace.get();
    if (!workspace) throw new HttpError(409, "工作区尚未初始化，请先从工作台初始化场景", "WORKSPACE_NOT_INITIALIZED");
    const scene = Array.isArray(workspace.scenes) ? workspace.scenes.map(asRecord).find(scene => scene?.id === sceneId) : undefined;
    if (!scene) throw new HttpError(404, "没有找到此场景", "SCENE_NOT_FOUND");
    const record = asRecord(asRecord(workspace.sceneVersions)?.[sceneId]);
    const selectedId = versionId ?? record?.publishedVersionId;
    if (typeof selectedId !== "string" || !selectedId) throw new HttpError(409, "此场景尚未发布，不能使用草稿执行", "SCENE_NOT_PUBLISHED");
    const version = Array.isArray(record?.versions) ? record.versions.map(asRecord).find(item => item?.id === selectedId) : undefined;
    if (!version) throw new HttpError(409, "发布版本不存在或已超过保留范围，请重新读取场景", "SCENE_VERSION_UNAVAILABLE");
    const workflowValue = asRecord(version.workflow);
    if (!workflowValue || asRecord(version.scene)?.id !== sceneId || typeof version.version !== "string" || typeof version.publishedAt !== "string") throw new HttpError(409, "发布快照格式无效，请从工作台重新发布", "INVALID_SCENE_VERSION");
    validateWorkflowShape(workflowValue);
    const presets = Array.isArray(version.optionPresets) ? version.optionPresets.map(asRecord) : [];
    const workflow = normalizeRunWorkflow(structuredClone(workflowValue) as unknown as RunWorkflowDefinition);
    validateCarryReferences(workflow);
    workflow.sceneId = sceneId;
    workflow.publishedScene = { versionId: selectedId, version: version.version, publishedAt: version.publishedAt };
    workflow.inputs = workflow.inputs.map(field => {
      const presetId = asRecord(field)?.optionPresetId;
      const preset = presets.find(item => item?.id === presetId);
      if (!presetId) return field;
      if (!preset || !Array.isArray(preset.options) || preset.options.some(option => typeof option !== "string")) throw new HttpError(409, "发布版本的选项预设缺失，请重新发布", "INVALID_SCENE_VERSION");
      return { ...field, options: preset.options as string[] };
    });
    return { view: "published" as const, sceneId, workspaceRevision: workspace.revision, versionId: selectedId, version: version.version, publishedAt: version.publishedAt, isCurrentPublished: selectedId === record?.publishedVersionId, scene: structuredClone(version.scene), workflow, ...sceneInputContract(workflow), boundaries: this.boundaries(workflow) };
  }
  boundaries(workflow: RunWorkflowDefinition) {
    return { externalSteps: workflow.steps.filter(step => step.kind === "hermes" || (step.kind === "comfyui" && step.capabilityId !== "media.video_concat" && step.comfyui?.adapter !== "video_concat")).map(step => ({ stepId: step.id, name: step.name, capabilityId: step.capabilityId ?? null, kind: step.kind, mayCostMoney: true })), reviewSteps: workflow.steps.filter(step => step.review?.enabled).map(step => ({ stepId: step.id, name: step.name, instruction: step.review?.instruction ?? "", scope: step.execution?.mode === "for_each" ? "batch" : "once" })), notices: ["外部服务未在预检中调用，无法保证在线或预估最终费用。", "waiting 必须用当前 reviewId 处理，不能用 resume/rerun 绕过。", "提交和后续审核可能触发付费生成；响应丢失只查询预先保存的 runId。"] };
  }
  async prepare(sceneId: string, versionId: string, supplied: Record<string, JsonValue>) {
    const selected = await this.get(sceneId, versionId);
    const settings = await this.loadSettings();
    if (!settings.projectDirectory) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");
    if (!(await stat(settings.projectDirectory).catch(() => undefined))?.isDirectory()) throw new HttpError(409, "项目目录不存在或不可读取", "PROJECT_DIRECTORY_UNAVAILABLE");
    const known = new Set(selected.workflow.inputs.map(field => field.key));
    const unknown = Object.keys(supplied).filter(key => !known.has(key));
    if (unknown.length) throw new HttpError(400, "场景输入包含未声明的字段：" + unknown.join(", "), "UNKNOWN_SCENE_INPUT");
    const defaults = workflowInputDefaults(selected.workflow);
    const inputValues = { ...defaults, ...structuredClone(supplied) } as Record<string, JsonValue>;
    if (selected.workflow.steps.length > 100 || selected.workflow.inputs.length > 200) throw new HttpError(400, "工作流规模超出限制", "INVALID_WORKFLOW");
    const stepIds = new Set<string>();
    selected.workflow.steps = selected.workflow.steps.map(step => {
      if (!step.id || !step.name || !step.kind || stepIds.has(step.id)) throw new HttpError(400, "步骤配置无效或 ID 重复", "INVALID_WORKFLOW");
      stepIds.add(step.id);
      return this.executors.prepareStep(step);
    });
    // Check asset versions and files without copying inputs or creating run artifacts.
    const resolved = await this.assets.resolveInputs(settings.projectDirectory, selected.workflow, inputValues);
    validateWorkflowInputs(selected.workflow, resolved);
    return { ...selected, valid: true, inputValues, ...sceneInputContract(selected.workflow, resolved), boundaries: this.boundaries(selected.workflow), validationScope: "snapshot-inputs-assets-capabilities", externalServicesChecked: false };
  }
}
