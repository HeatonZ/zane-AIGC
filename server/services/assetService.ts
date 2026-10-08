import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import type { JsonValue, RunRecord, RunWorkflowDefinition, SavedSettings } from "../domain/types.js";
import type { AssetRecord, AssetReference, AssetSource, AssetKind, AssetCategory } from "../domain/productionContracts.js";
import { asRecord, normalizeMediaList } from "../domain/workflowValues.js";
import { isRuntimeMediaValue, mediaKindFromWorkflowType, runtimeMediaItemValue } from "../runtimeValue.js";
import { assetReferenceFromMediaUrl } from "../domain/assetMediaReference.js";
import { isRunId, runArtifactPaths } from "../artifacts/runArtifacts.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import { HttpError } from "../errors.js";
import { assetMetadataSchema, assetKindSchema, assetSourceSchema, updateAssetSchema } from "../domain/assetLibraryContracts.js";
import { assetCatalog, ownAssetCatalog, assetEnvelope, assetVersions, assetVersion, parseAssetInput } from "./assetCatalog.js";

export const assetCategories: AssetCategory[] = ["character", "scene", "prop", "voice", "material"];
export const assetMediaUrl = (id: string, version: number) => "/api/v1/assets/" + id + "/versions/" + version + "/media";
export class AssetService {
  constructor(readonly store: SqliteStore, readonly loadSettings: () => Promise<SavedSettings>, readonly getRun: (project: string, id: string) => Promise<RunRecord | undefined>, readonly workbenchBaseUrl?: () => string) {}
  get(project: string, id: string) { return this.store.getDocument<AssetRecord>(project, "assets", id); }
  list(project: string) { return this.store.listDocuments<AssetRecord>(project, "assets"); }
  private required(project: string, id: string) {
    const asset = this.get(project, id);
    if (!asset) throw new HttpError(404, "素材不存在", "ASSET_NOT_FOUND");
    return asset;
  }
  catalog(project: string, query: unknown = {}, actorId = "") { return assetCatalog(this.list(project), query, project, actorId); }
  ownedCatalog(project: string, query: unknown, ownerUserId: string) { return ownAssetCatalog(this.list(project), query, project, ownerUserId, asset => this.reference(asset)); }
  detail(project: string, id: string) { const asset = this.required(project, id); return assetEnvelope(asset, this.reference(asset)); }
  versionsPage(project: string, id: string, query: unknown = {}, actorId = "") { const asset = this.required(project, id); return assetVersions(asset, query, project, actorId, version => this.reference(asset, version)); }
  versionDetail(project: string, id: string, version: number, query: unknown = {}) { const asset = this.required(project, id); return assetVersion(asset, version, query, this.reference(asset, version)); }
  put(project: string, record: AssetRecord, revision: number) {
    try { return this.store.putDocument(project, "assets", record, revision); }
    catch (error) { if ((error as Error).message === "DOCUMENT_CONFLICT") throw new HttpError(409, "素材已被修改，请刷新后重试", "ASSET_CONFLICT", { assetId: record.id, currentRevision: this.get(project, record.id)?.revision }); throw error; }
  }
  file(project: string, id: string, version: number) {
    const asset = this.get(project, id);
    const item = asset?.versions.find(item => item.version === version);
    if (!asset || !item) throw new HttpError(404, "没有找到此素材版本");
    return path.join(project, ".zane", "assets", "blobs", item.filename);
  }
  reference(asset: AssetRecord, version = asset.currentVersion): AssetReference {
    return { assetId: asset.id, assetVersion: version, assetName: asset.name, previewUrl: assetMediaUrl(asset.id, version) };
  }
  async resolveValue(project: string, kind: AssetKind, value: unknown): Promise<JsonValue> {
    if (isRuntimeMediaValue(value)) return Promise.all(value.items.map(item => this.resolveValue(project, kind, item.assetId ? item : runtimeMediaItemValue(item))));
    if (Array.isArray(value)) return Promise.all(value.map(item => this.resolveValue(project, kind, item)));
    const supplied = asRecord(value);
    const ref = supplied && Object.hasOwn(supplied, "assetId") ? supplied
      : asRecord(assetReferenceFromMediaUrl(value, this.workbenchBaseUrl?.()));
    if (!ref) return value as JsonValue;
    const asset = typeof ref.assetId === "string" ? this.get(project, ref.assetId) : undefined;
    if (!asset || asset.kind !== kind || !Number.isSafeInteger(ref.assetVersion) || !asset.versions.some(item => item.version === ref.assetVersion)) throw new HttpError(400, "素材不存在、类型不匹配或未指定有效版本", "INVALID_ASSET_REFERENCE");
    const file = this.file(project, asset.id, ref.assetVersion as number);
    if (!(await stat(file).catch(() => undefined))?.isFile()) throw new HttpError(400, "素材文件已丢失：" + asset.name, "ASSET_FILE_MISSING");
    // Do not emit filename/type: legacy uploaders interpret those as ComfyUI attachments.
    return { ...this.reference(asset, ref.assetVersion as number), path: file } as unknown as JsonValue;
  }
  async resolveInputs(project: string, workflow: RunWorkflowDefinition, values: Record<string, JsonValue>) {
    const resolved = { ...values };
    for (const field of workflow.inputs) {
      const kind = mediaKindFromWorkflowType(field.type);
      if (kind && values[field.key] !== undefined) resolved[field.key] = await this.resolveValue(project, kind, values[field.key]);
    }
    return resolved;
  }
  async source(project: string, raw: unknown): Promise<{ source: AssetSource; kind: AssetKind; value: JsonValue; parameters: Record<string, unknown> }> {
    const body = asRecord(raw);
    if (!body || typeof body.runId !== "string" || !isRunId(body.runId) || typeof body.outputKey !== "string" || !Number.isSafeInteger(body.mediaIndex ?? 0) || Number(body.mediaIndex ?? 0) < 0) throw new HttpError(400, "素材来源无效");
    const run = await this.getRun(project, body.runId);
    if (!run) throw new HttpError(404, "没有找到来源运行");
    let value: JsonValue | undefined, type: string | undefined;
    let parameters: Record<string, unknown> = { workflowName: run.workflowName, inputValues: run.inputValues };
    if (body.stepId !== undefined) {
      if (typeof body.stepId !== "string") throw new HttpError(400, "来源步骤无效");
      const step = run.steps.find(step => step.stepId === body.stepId);
      if (!step || (body.itemIndex === undefined && step.status !== "completed")) throw new HttpError(400, "只能收藏已完成步骤的结果");
      let target = step;
      if (body.itemIndex !== undefined) {
        if (!Number.isSafeInteger(body.itemIndex) || Number(body.itemIndex) < 0) throw new HttpError(400, "来源镜头序号无效");
        const item = step.items?.find(item => item.index === body.itemIndex);
        if (!item || item.status !== "completed") throw new HttpError(400, "来源镜头未完成");
        value = item.outputs?.[body.outputKey];
        parameters = { ...parameters, step: item.stepSnapshot ?? run.workflow.steps.find(step => step.id === body.stepId), inputs: item.inputs, iterationValue: item.value };
      } else { value = target.outputs?.[body.outputKey]; parameters = { ...parameters, step: run.workflow.steps.find(step => step.id === body.stepId), inputs: target.inputs }; }
      type = step.outputTypes?.[body.outputKey] ?? run.workflow.steps.find(step => step.id === body.stepId)?.outputs?.find(output => output.key === body.outputKey)?.type;
    } else {
      if (body.itemIndex !== undefined) throw new HttpError(400, "最终结果不能指定镜头序号");
      const output = run.outputs.find(output => output.key === body.outputKey);
      value = output?.value; type = output?.type;
    }
    const kind = mediaKindFromWorkflowType(type);
    const mediaIndex = Number(body.mediaIndex ?? 0);
    const selected = normalizeMediaList(value)[mediaIndex];
    if (!kind || selected === undefined) throw new HttpError(400, "来源不是有效媒体结果");
    return { source: { runId: run.runId, ...(typeof body.stepId === "string" ? { stepId: body.stepId } : {}), ...(body.itemIndex !== undefined ? { itemIndex: body.itemIndex as number } : {}), outputKey: body.outputKey, mediaIndex }, kind, value: selected, parameters };
  }
  /** Resolve persisted local output addresses only; this operation never fetches or generates media. */
  localMediaFile(project: string, value: JsonValue) {
    const record = asRecord(value);
    const locator = asRecord(record?.locator);
    let source = typeof value === "string" ? value : typeof record?.path === "string" ? record.path : typeof record?.url === "string" ? record.url : locator?.type === "path" && typeof locator.value === "string" ? locator.value : "";
    const archived = /^\/api\/(?:v1\/runs|workflows\/runs)\/([a-f0-9-]{36})\/media\/([^/?]+)$/i.exec(source);
    if (archived && isRunId(archived[1])) {
      let filename: string;
      try { filename = decodeURIComponent(archived[2]); } catch { throw new HttpError(400, "归档媒体文件名无效"); }
      if (!filename || filename === "." || filename === ".." || /[\\/\x00]/.test(filename) || path.basename(filename) !== filename) throw new HttpError(400, "归档媒体文件名无效");
      source = path.join(runArtifactPaths(project, archived[1]).directory, "outputs", "media", filename);
    }
    if (/^\/api\/v1\/assets\//.test(source) && typeof record?.assetId === "string" && Number.isSafeInteger(record.assetVersion)) source = this.file(project, record.assetId, record.assetVersion as number);
    if (!source || /^(?:https?:|data:|\/api\/)/i.test(source)) throw new HttpError(400, "此结果没有本地媒体文件");
    return path.resolve(source);
  }
  async materialize(settings: SavedSettings, value: JsonValue, kind: AssetKind, authorize?: () => void) {
    const record = asRecord(value);
    const locator = asRecord(record?.locator);
    let source = typeof value === "string" ? value : typeof record?.path === "string" ? record.path : typeof record?.url === "string" ? record.url : typeof locator?.value === "string" ? locator.value : "";
    const archived = /^\/api\/(?:v1\/runs|workflows\/runs)\/([a-f0-9-]{36})\/media\/([^/?]+)$/i.exec(source);
    if (archived) source = this.localMediaFile(settings.projectDirectory, value);
    if (!source && typeof record?.file === "string") throw new HttpError(400, "归档结果缺少可解析的媒体地址");
    if (/^\/api\/v1\/assets\//.test(source) && typeof record?.assetId === "string") source = this.file(settings.projectDirectory, record.assetId, Number(record.assetVersion));
    if ((/^\/api\/comfyui\/view/.test(source) || !source) && typeof record?.filename === "string") source = settings.comfyuiBaseUrl + "/view?" + new URLSearchParams({ filename: record.filename, subfolder: String(record.subfolder ?? ""), type: String(record.type ?? "output") });
    if (!source) throw new HttpError(400, "媒体缺少可读取的地址");
    let stream: Readable;
    let originalName = typeof record?.filename === "string" ? record.filename : path.basename(source);
    if (/^https?:/i.test(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(120000) });
      if (!response.ok || !response.body) throw new HttpError(400, "无法下载来源媒体：" + response.status);
      stream = Readable.fromWeb(response.body as unknown as WebStream<Uint8Array>);
      originalName = originalName.split("?")[0] || kind;
    } else if (/^data:/i.test(source)) {
      const match = /^data:([^;]+);base64,([a-z0-9+/=\s]+)$/i.exec(source);
      if (!match) throw new HttpError(400, "媒体 data URL 无效");
      stream = Readable.from(Buffer.from(match[2].replace(/\s/g, ""), "base64"));
      originalName = ({ "image/png": "image.png", "image/jpeg": "image.jpg", "audio/wav": "voice.wav", "video/mp4": "video.mp4" } as Record<string,string>)[match[1]] ?? kind + ".bin";
    } else {
      if (!(await stat(source).catch(() => undefined))?.isFile()) throw new HttpError(400, "无法读取来源媒体文件");
      stream = createReadStream(source);
    }
    return this.storeStream(settings.projectDirectory, stream, originalName, authorize);
  }
  async storeStream(project: string, source: Readable, originalName: string, authorize?: () => void) {
    if (!project) throw new HttpError(400, "请先配置项目目录");
    const directory = path.join(project, ".zane", "assets", "blobs");
    await mkdir(directory, { recursive: true });
    const temp = path.join(directory, ".import-" + randomUUID());
    const hash = createHash("sha256"); let bytes = 0;
    const hashing = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; if (bytes > 250 * 1024 * 1024) { callback(new HttpError(413, "素材不能超过250MB", "ASSET_TOO_LARGE")); return; } hash.update(chunk); callback(null, chunk); } });
    try {
      await pipeline(source, hashing, createWriteStream(temp, { flags: "wx" }));
      if (!bytes) throw new HttpError(400, "不能保存空媒体文件");
      const sha256 = hash.digest("hex");
      const ext = path.extname(originalName).replace(/[^.a-z0-9]/gi, "").slice(0,12).toLowerCase() || ".bin";
      const filename = sha256 + ext;
      const target = path.join(directory, filename);
      const exists = (await stat(target).catch(() => undefined))?.isFile();
      authorize?.();
      if (exists) await unlink(temp); else await rename(temp, target);
      return { sha256, bytes, filename, originalName };
    } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
  }
  async save(raw: unknown, upload?: { bytes: Buffer; filename: string }, access?: { ownerUserId?: string; assetId?: string; authorize(): void }) {
    access?.authorize();
    const body = parseAssetInput(assetMetadataSchema.extend({ source: assetSourceSchema.optional(), kind: assetKindSchema.optional() }), raw);
    const settings = await this.loadSettings();
    const project = settings.projectDirectory;
    if (!project) throw new HttpError(400, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");
    const existing = body.assetId ? this.required(project, body.assetId) : undefined;
    if (body.createId && body.assetId) throw new HttpError(400, "createId与assetId不能同时提供", "INVALID_ASSET_REQUEST");
    if (existing && body.revision !== existing.revision) throw new HttpError(409, "素材已被修改，请刷新后重试", "ASSET_CONFLICT", { assetId: existing.id, currentRevision: existing.revision });
    if (!existing && body.revision !== undefined) throw new HttpError(400, "新建素材不能带revision", "INVALID_ASSET_REQUEST");
    const createId = body.createId ?? access?.assetId ?? randomUUID();
    const duplicate = () => new HttpError(409, "素材ID已存在，请读取同一ID对账，不重复上传或收藏", "ASSET_ALREADY_EXISTS", { assetId: createId, nextAction: "get_asset" });
    if (!existing && this.get(project, createId)) throw duplicate();
    const name = body.name ?? existing?.name;
    const category = body.category ?? existing?.category ?? "material";
    if (!name) throw new HttpError(400, "请填写素材名称", "INVALID_ASSET_REQUEST");
    const origin = upload ? undefined : await this.source(project, body.source);
    const kind = origin?.kind ?? body.kind;
    if (!kind || (existing && existing.kind !== kind) || (category === "voice" && kind !== "audio") || (["character", "scene", "prop"].includes(category) && kind !== "image")) throw new HttpError(400, "素材类型与分类不匹配", "INVALID_ASSET_REQUEST");
    const blob = upload ? await this.storeStream(project, Readable.from(upload.bytes), upload.filename, access?.authorize) : await this.materialize(settings, origin!.value, kind, access?.authorize);
    const now = new Date().toISOString();
    access?.authorize();
    const asset: AssetRecord = existing ?? { ...(access?.ownerUserId ? { ownerUserId: access.ownerUserId } : {}), id: createId, revision: 0, name, category, kind, description: "", group: "", tags: [], createdAt: now, updatedAt: now, currentVersion: 0, versions: [] };
    const version = { ...blob, version: asset.currentVersion + 1, createdAt: now, ...(origin ? { source: origin.source, parameters: origin.parameters } : {}) };
    try {
      const saved = this.put(project, { ...asset, name, category, description: body.description ?? asset.description ?? "", group: body.group ?? asset.group, tags: body.tags ?? asset.tags, updatedAt: now, currentVersion: version.version, versions: [...asset.versions, version] }, existing?.revision ?? 0);
      return { asset: saved, reference: this.reference(saved) };
    } catch (error) { if (!existing && error instanceof HttpError && error.code === "ASSET_CONFLICT") throw duplicate(); throw error; }
  }
  async update(id: string, raw: unknown, authorize?: () => void) {
    authorize?.();
    const body = parseAssetInput(updateAssetSchema, raw);
    const { projectDirectory } = await this.loadSettings();
    const asset = this.required(projectDirectory, id);
    if (body.revision !== asset.revision) throw new HttpError(409, "素材已被修改，请刷新后重试", "ASSET_CONFLICT", { assetId: id, currentRevision: asset.revision });
    const name = body.name ?? asset.name;
    const category = body.category ?? asset.category;
    if ((category === "voice" && asset.kind !== "audio") || (["character", "scene", "prop"].includes(category) && asset.kind !== "image")) throw new HttpError(400, "素材分类与类型不匹配", "INVALID_ASSET_REQUEST");
    authorize?.();
    return this.put(projectDirectory, { ...asset, name, category, description: body.description ?? asset.description ?? "", group: body.group ?? asset.group, tags: body.tags ?? asset.tags, updatedAt: new Date().toISOString(), ...(body.archived === true ? { archivedAt: new Date().toISOString() } : body.archived === false ? { archivedAt: undefined } : {}) }, asset.revision);
  }
}
