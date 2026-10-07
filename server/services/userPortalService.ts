import { ownReviewRequest } from "../domain/systemFeedbackContracts.js";
import { compareDrafts } from "../domain/draftFavorites.js";
import { draftFavoriteRequest, type DraftFavoriteRequest } from "../ai/taskDraftSchemas.js";
import { accessPagination, AccessService, runSubmitter, type Identity } from "./accessService.js";
import type { AiSceneService } from "./aiSceneService.js";
import type { RunService } from "./runService.js";
import { asRecord, isMediaWorkflowType } from "../domain/workflowValues.js";
import type { JsonValue, RunRecord } from "../domain/types.js";
import type { ResultQuery } from "../ai/sceneSchemas.js";
import { runOutputs, stepResult } from "./runResultService.js";
import { HttpError } from "../errors.js";
import { businessRun, businessRunInputs, BUSINESS_EVENT_TYPES, scrubBusinessValue as scrub } from "./runDetailService.js";
import type { RunInputQuery } from "../ai/accessSchemas.js";
import { isRunId } from "../artifacts/runArtifacts.js";

interface UserDraft { id: string; revision: number; userId: string; sceneId: string; versionId: string; title: string; inputValues: Record<string, JsonValue>; updatedAt: string; isFavorite?: boolean }
export const userRun = businessRun;
export class UserPortalService {
  constructor(readonly access: AccessService, readonly scenes: AiSceneService, readonly runs: RunService) {}
  private async project() { return (await this.scenes.loadSettings()).projectDirectory; }
  async list(identity: Identity, query: { limit?: number; cursor?: string }) {
    const snapshot = await this.scenes.workspace.get(); const current = this.access.refresh(identity);
    const versions = asRecord(snapshot?.sceneVersions); const all: Array<{ id: string; revision: number; sceneId: string; title: string; summary: string; versionId: string; version: string }> = [];
    for (const raw of Array.isArray(snapshot?.scenes) ? snapshot.scenes : []) {
      const scene = asRecord(raw); const id = String(scene?.id);
      if (current.role !== "admin" && !current.sceneIds.includes(id)) continue;
      const record = asRecord(versions?.[id]); const published = Array.isArray(record?.versions) ? record.versions.map(asRecord).find(item => item?.id === record.publishedVersionId) : undefined;
      const details = asRecord(published?.scene);
      if (published && details) all.push({ id, revision: Number(snapshot?.revision ?? 0), sceneId: id, title: String(details.title ?? ""), summary: String(details.summary ?? ""), versionId: String(published.id), version: String(published.version) });
    }
    const page = accessPagination(all, query, "available-scenes:" + current.id, [current.revision,snapshot?.revision]);
    return { ...page, catalogView: "published", nextAction: "get_available_scene" };
  }
  async get(identity: Identity, sceneId: string) {
    this.access.authorizeScene(identity, sceneId); const selected = await this.scenes.get(sceneId);
    this.access.authorizeScene(identity,sceneId);
    const scene = asRecord(selected.scene) ?? {};
    const fields = selected.workflow.inputs.map(field => ({ key: field.key, label: String(asRecord(field)?.label ?? field.key), type: field.type, required: Boolean(field.required), placeholder: String(asRecord(field)?.placeholder ?? ""), ...(field.options ? { options: field.options } : {}) }));
    const inputDefaults = Object.fromEntries(Object.entries(selected.inputDefaults).filter(([key]) => !fields.some(field => field.key === key && isMediaWorkflowType(field.type))));
    const inputSchema = structuredClone(selected.inputSchema);
    const properties = inputSchema.properties as Record<string,unknown>;
    const required = new Set(inputSchema.required as string[]);
    const assetReference = {type:"object",required:["assetId","assetVersion"],properties:{assetId:{type:"string",minLength:1},assetVersion:{type:"integer",minimum:1},assetName:{type:"string"},previewUrl:{type:"string"}},additionalProperties:false};
    for (const field of fields) if (isMediaWorkflowType(field.type)) {
      properties[field.key] = {title:field.label,anyOf:[assetReference,{type:"array",items:assetReference,minItems:field.required ? 1 : 0},...(field.required ? [] : [{type:"null"},{const:""}])]};
      if (field.required) required.add(field.key);
    }
    inputSchema.required = [...required];
    return { sceneId, title: String(scene.title ?? ""), summary: String(scene.summary ?? ""), description: String(scene.description ?? ""), versionId: selected.versionId, version: selected.version, fields, inputDefaults: scrub(inputDefaults), inputSchema: scrub(inputSchema), notices: selected.boundaries.notices, nextAction: "prepare_own_scene" };
  }
  private async safeInputs(identity: Identity, sceneId: string, versionId: string, supplied: Record<string, JsonValue>, allowHistorical = false) {
    this.access.authorizeScene(identity, sceneId); const selected = await this.scenes.get(sceneId, versionId);
    if (!allowHistorical && !selected.isCurrentPublished) throw new HttpError(409, "发布版已变化，请重新打开场景并确认输入", "SCENE_VERSION_CHANGED");
    if (Buffer.byteLength(JSON.stringify(supplied)) > 524288) throw new HttpError(413, "输入超过512KB，请缩小输入", "INPUT_TOO_LARGE");
    const project = await this.project();
    const checkMedia = (value: unknown): void => {
      if (value === "" || value === null || value === undefined) return;
      if (Array.isArray(value)) { value.forEach(checkMedia); return; }
      const reference = asRecord(value);
      if (!reference || typeof reference.assetId !== "string" || !Number.isSafeInteger(reference.assetVersion) || Object.keys(reference).some(key => !["assetId", "assetVersion", "assetName", "previewUrl"].includes(key))) throw new HttpError(400, "媒体输入必须使用本人上传素材的固定版本，不能提交路径或URL", "INVALID_USER_MEDIA");
      const asset = this.scenes.assets.get(project, reference.assetId);
      if (!asset || asset.ownerUserId !== identity.id) throw new HttpError(404, "素材不存在", "OBJECT_NOT_FOUND");
    };
    const checkStructured = (value: unknown): void => {
      if (typeof value === "string" && /^(?:[a-z]:[\\/]|\/(?:home|tmp|var|Users)\/|file:)/i.test(value)) throw new HttpError(400,"用户输入不能引用服务器本机路径","INVALID_USER_MEDIA");
      if (Array.isArray(value)) { value.forEach(checkStructured); return; }
      const record = asRecord(value);
      if (record) {
        if (Object.hasOwn(record,"assetId")) { checkMedia(record); return; }
        if (["path","filePath","locator","__zaneRuntime"].some(key => Object.hasOwn(record,key))) throw new HttpError(400,"结构化媒体必须使用本人固定素材引用","INVALID_USER_MEDIA");
        Object.values(record).forEach(checkStructured);
      }
    };
    Object.values(supplied).forEach(checkStructured);
    const inputValues = { ...supplied };
    for (const field of selected.workflow.inputs) if (isMediaWorkflowType(field.type)) { checkMedia(supplied[field.key]); if (supplied[field.key] === undefined) inputValues[field.key] = ""; }
    return inputValues;
  }
  async prepare(identity: Identity, input: { sceneId: string; versionId: string; inputValues: Record<string, JsonValue> }) {
    const values = await this.safeInputs(identity, input.sceneId, input.versionId, input.inputValues);
    await this.scenes.prepare(input.sceneId, input.versionId, values);
    this.checkSubmission(identity, input.sceneId, input.versionId);
    return { valid: true, sceneId: input.sceneId, versionId: input.versionId, externalServicesChecked: false, nextAction: "confirm_then_submit_own_scene" };
  }
  private checkSubmission(identity: Identity, sceneId: string, versionId?: string) {
    this.access.authorizeScene(identity, sceneId);
    if (versionId) {
      const snapshot = this.access.store.getWorkspace(); const record = asRecord(asRecord(snapshot?.sceneVersions)?.[sceneId]);
      if (record?.publishedVersionId !== versionId) throw new HttpError(409, "发布版已变化，请确认新版本", "SCENE_VERSION_CHANGED");
    }
  }
  async submit(identity: Identity, input: { sceneId: string; versionId: string; inputValues: Record<string, JsonValue>; runId: string; runTitle?: string }) {
    const values = await this.safeInputs(identity, input.sceneId, input.versionId, input.inputValues); const prepared = await this.scenes.prepare(input.sceneId, input.versionId, values);
    const run = await this.runs.submit({ workflow: prepared.workflow, inputValues: prepared.inputValues, runId: input.runId, runTitle: input.runTitle }, { ownerUserId: identity.id, submitter: runSubmitter(identity), authorize: () => this.checkSubmission(identity, input.sceneId, input.versionId) });
    return this.viewRun(await this.project(), run);
  }
  async ownRun(identity: Identity, runId: string) {
    this.access.refresh(identity);
    if (!isRunId(runId)) throw new HttpError(400, "运行ID无效", "INVALID_ACCESS_REQUEST");
    const project = await this.project(); const run = await this.runs.getRun(project, runId);
    if (!run) { if (this.runs.isPreparingFor(project, runId, identity.id)) throw new HttpError(409, "任务正在准备，请查询同一ID", "RUN_PREPARING"); throw new HttpError(404, "任务不存在", "OBJECT_NOT_FOUND"); }
    this.access.refresh(identity);
    if (run.ownerUserId !== identity.id) throw new HttpError(404, "任务不存在", "OBJECT_NOT_FOUND");
    return run;
  }
  private viewRun(project: string, run: RunRecord) {
    return userRun(run, this.access.store.firstEventAt(project, run.runId, "run.started"));
  }
  async getRun(identity: Identity, runId: string) {
    const run = await this.ownRun(identity, runId);
    return this.viewRun(await this.project(), run);
  }
  async inputs(identity: Identity, runId: string, query: RunInputQuery) {
    return businessRunInputs(await this.ownRun(identity, runId), query);
  }
  async activity(identity: Identity, runId: string, query: { afterSequence: number; limit: number }) {
    const run = await this.ownRun(identity, runId);
    const events = this.access.store.events(await this.project(), runId, query.afterSequence, query.limit + 1, BUSINESS_EVENT_TYPES);
    const items = events.slice(0, query.limit).map(event => ({
      sequence: event.sequence, type: event.type, at: event.at,
      ...(event.stepId ? { stepId: event.stepId, stepName: String(scrub(run.workflow.steps.find(step => step.id === event.stepId)?.name ?? event.stepId)) } : {}),
      ...(Number.isSafeInteger(event.payload?.index) && Number(event.payload!.index) >= 0 ? { itemIndex: Number(event.payload!.index) } : {}),
    }));
    return { runId, projection: "business", events: items, nextSequence: items.at(-1)?.sequence ?? query.afterSequence, hasMore: events.length > query.limit, nextAction: "read_run_activity" };
  }
  async listRuns(identity: Identity, query: { limit?: number; cursor?: string }) {
    this.access.refresh(identity); let before: { createdAt: string; runId: string } | undefined;
    if (query.cursor) { try { const page = JSON.parse(Buffer.from(query.cursor, "base64url").toString()); if (page.userId !== identity.id || !isRunId(page.runId) || typeof page.createdAt !== "string" || !Number.isFinite(Date.parse(page.createdAt))) throw new Error(); before = { runId: page.runId, createdAt: page.createdAt }; } catch { throw new HttpError(400, "任务分页游标无效", "INVALID_ACCESS_CURSOR"); } }
    const project = await this.project();
    const page = await this.runs.listRuns(project, { ownerUserId: identity.id, limit: query.limit, before });
    return { items: page.runs.map(run => this.viewRun(project, run)), hasMore: Boolean(page.nextCursor), ...(page.nextCursor ? { nextCursor: Buffer.from(JSON.stringify({ ...page.nextCursor, userId: identity.id })).toString("base64url") } : {}) };
  }
  async outputs(identity: Identity, runId: string, query: ResultQuery, stepId?: string) {
    const run = await this.ownRun(identity, runId);
    // Redact full text before slicing, otherwise a later text segment could reveal
    // the tail of a locator whose prefix lived in the previous segment.
    const safeValues = (values: Record<string, JsonValue> | undefined, id: string, types?: Record<string, string>) => values && Object.fromEntries(Object.entries(values).map(([key,value]) => [key,
      isMediaWorkflowType(types?.[key] ?? run.workflow.steps.find(step => step.id === id)?.outputs?.find(field => field.key === key)?.type ?? "json") ? value : scrub(value) as JsonValue]));
    const safeRun: RunRecord = { ...run,
      outputs: run.outputs.map(output => isMediaWorkflowType(output.type) ? output : { ...output, value: scrub(output.value) as JsonValue }),
      steps: run.steps.map(step => ({ ...step, outputs: safeValues(step.outputs, step.stepId, step.outputTypes),
        ...(step.items ? { items: step.items.map(item => ({ ...item, outputs: safeValues(item.outputs, step.stepId, step.outputTypes) })) } : {}) })),
    };
    const page = stepId ? stepResult(safeRun, stepId, query) : runOutputs(safeRun, query);
    // Media values are locators, not display data. Keep the authorized output URLs and pagination metadata.
    const project = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(project);
      const record = asRecord(value);
      if (record) { const clean = { ...record }; if (isMediaWorkflowType(String(record.type)) && "value" in clean) clean.value = clean.mediaReferences ?? []; return Object.fromEntries(Object.entries(clean).map(([key, entry]) => [key, project(entry)])); }
      return value;
    };
    const result = asRecord(scrub(project(page)))!;
    if ("message" in result) delete result.message;
    if (Array.isArray(result.items)) result.items = result.items.map(item => { const record = asRecord(item)!; return record.error ? {...record,error:"此项执行失败，请联系管理员"} : record; });
    return {...result,projection:"business",internalPathsRedacted:true};
  }
  async action(identity: Identity, runId: string, action: "cancel" | "resume" | "review", input: Record<string, unknown>) {
    const run = await this.ownRun(identity, runId); const project = await this.project();
    if (action === "cancel") { await this.runs.cancel(project, runId); return this.getRun(identity, runId); }
    this.access.authorizeScene(identity, run.sceneId);
    if (action === "review") {
      const decision = ownReviewRequest.safeParse(input);
      if (!decision.success) throw new HttpError(400, "本人审核只允许确认或退回，不允许向Agent提交反馈；请使用系统反馈", "INVALID_ACCESS_REQUEST");
      await this.runs.review(project, runId, decision.data, () => this.checkSubmission(identity, run.sceneId)); return this.getRun(identity, runId); }
    const resumed = await this.runs.submit({ workflow: run.workflow, inputValues: run.inputValues, resumeFromRunId: runId, runId: input.newRunId }, { ownerUserId: identity.id, submitter: runSubmitter(identity), authorize: () => this.checkSubmission(identity, run.sceneId) });
    return this.viewRun(project, resumed);
  }
  async saveDraft(identity: Identity, input: { draftId: string; revision: number; sceneId: string; versionId: string; title: string; inputValues: Record<string, JsonValue> }) {
    await this.safeInputs(identity, input.sceneId, input.versionId, input.inputValues); const project = await this.project();
    const current = this.access.store.getDocument<UserDraft>(project, "user-drafts", input.draftId);
    if (current && current.userId !== identity.id) throw new HttpError(404, "草稿不存在", "OBJECT_NOT_FOUND");
    this.access.authorizeScene(identity, input.sceneId);
    try { return { draft: this.access.store.putDocumentChecked<UserDraft>(project, "user-drafts", { id: input.draftId, revision: input.revision, userId: identity.id, sceneId: input.sceneId, versionId: input.versionId, title: input.title, inputValues: input.inputValues, isFavorite: current?.isFavorite === true, updatedAt: new Date().toISOString() }, input.revision, () => { this.access.authorizeScene(identity, input.sceneId); }), nextAction: "get_own_draft" }; } catch (error) { if ((error as Error).message === "DOCUMENT_CONFLICT") throw new HttpError(409, "草稿版本冲突，请读取同一ID对账", "DRAFT_REVISION_CONFLICT"); throw error; }
  }
  async getDraft(identity: Identity, id: string) { this.access.refresh(identity); const draft = this.access.store.getDocument<UserDraft>(await this.project(), "user-drafts", id); if (!draft || draft.userId !== identity.id) throw new HttpError(404, "草稿不存在", "OBJECT_NOT_FOUND"); return { draft: { ...draft, isFavorite: draft.isFavorite === true } }; }
  async listDrafts(identity: Identity, query: { limit?: number; cursor?: string }) { this.access.refresh(identity); return accessPagination(this.access.store.listDocuments<UserDraft>(await this.project(), "user-drafts").filter(draft => draft.userId === identity.id).sort((left, right) => compareDrafts(left, right, "updatedAt")).map(({ inputValues: _values, ...draft }) => ({ ...draft, isFavorite: draft.isFavorite === true, inputValuesOmitted: true })), query, "drafts:" + identity.id); }
  async setDraftFavorite(identity: Identity, id: string, input: DraftFavoriteRequest) {
    if (!draftFavoriteRequest.safeParse(input).success) throw new HttpError(400, "收藏参数无效", "INVALID_ACCESS_REQUEST");
    const { draft } = await this.getDraft(identity, id); const project = await this.project();
    try {
      const saved = this.access.store.putDocumentChecked<UserDraft>(project, "user-drafts", { ...draft, isFavorite: input.isFavorite }, input.revision, () => { this.access.refresh(identity); });
      return { draft: saved, nextAction: "get_own_draft" };
    } catch (error) {
      if ((error as Error).message === "DOCUMENT_CONFLICT") throw new HttpError(409, "草稿版本冲突，请读取同一ID对账", "DRAFT_REVISION_CONFLICT");
      throw error;
    }
  }
  async upload(identity: Identity, assetId: string, name: string, kind: "image" | "video" | "audio", bytes: Buffer, filename: string) {
    this.access.refresh(identity); const project = await this.project();
    if (this.scenes.assets.get(project, assetId)) throw new HttpError(409, "素材ID已存在，请读取同一ID对账，不重复上传", "ASSET_ALREADY_EXISTS");
    const saved = await this.scenes.assets.save({ name, kind }, { bytes, filename }, { ownerUserId: identity.id, assetId, authorize: () => { this.access.refresh(identity); } });
    return { reference: saved.reference, asset: { id: saved.asset.id, revision: saved.asset.revision, name: saved.asset.name, kind, currentVersion: saved.asset.currentVersion }, nextAction: "save_reference" };
  }
  async getAsset(identity: Identity, id: string) { this.access.refresh(identity); const asset = this.scenes.assets.get(await this.project(), id); if (!asset || asset.ownerUserId !== identity.id) throw new HttpError(404, "素材不存在", "OBJECT_NOT_FOUND"); return { asset: { id: asset.id, revision: asset.revision, name: asset.name, kind: asset.kind, currentVersion: asset.currentVersion }, reference: this.scenes.assets.reference(asset) }; }
}
