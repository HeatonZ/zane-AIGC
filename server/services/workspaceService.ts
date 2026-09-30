import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { asRecord } from "../domain/workflowValues.js";
import { HttpError } from "../errors.js";
import { log } from "../observability/logger.js";
import { writeJsonFile } from "../storage/jsonFileStore.js";
import { SqliteStore } from "../storage/sqliteStore.js";

export function normalizeWorkspacePayload(value: unknown) {
  const body = asRecord(value);
  const workflows = body ? asRecord(body.workflows) : undefined;
  const sceneVersions = body && body.sceneVersions !== undefined ? asRecord(body.sceneVersions) : undefined;
  if (body?.format !== undefined && body.format !== "zane-studio.workspace/v1") {
    throw new HttpError(400, "服务端工作区版本不兼容，已停止初始化以保护现有数据");
  }
  if (!body || !Array.isArray(body.scenes) || !workflows || !Array.isArray(body.optionPresets) || !Array.isArray(body.drafts)
    || (body.sceneVersions !== undefined && !sceneVersions)) {
    throw new HttpError(400, "工作区数据格式无效");
  }
  if (body.scenes.length > 500 || Object.keys(workflows).length > 500 || body.optionPresets.length > 500 || body.drafts.length > 5000
    || (sceneVersions && Object.keys(sceneVersions).length > 500)) {
    throw new HttpError(400, "工作区数据规模超出限制");
  }
  if (sceneVersions && Object.values(sceneVersions).some((record) => {
    const candidate = asRecord(record);
    return candidate && Array.isArray(candidate.versions) && candidate.versions.length > 10;
  })) throw new HttpError(400, "每个场景最多保存 10 个已发布版本");
  for (const [name, values] of [["scenes", body.scenes], ["optionPresets", body.optionPresets], ["drafts", body.drafts]] as const) {
    const ids = new Set<string>();
    for (const value of values) {
      const record = asRecord(value);
      if (typeof record?.id !== "string" || !record.id || ids.has(record.id)) throw new HttpError(400, `工作区 ${name} 包含无效或重复的 ID`);
      ids.add(record.id);
    }
  }
  if (Object.values(workflows).some((value) => !asRecord(value))) throw new HttpError(400, "工作流配置格式无效");
  return {
    format: "zane-studio.workspace/v1",
    scenes: body.scenes,
    workflows,
    optionPresets: body.optionPresets,
    drafts: body.drafts,
    ...(sceneVersions ? { sceneVersions } : {}),
  };
}

function identifiedRecords(values: unknown[], key: string) {
  const records = new Map<string, unknown>();
  for (const value of values) {
    const record = asRecord(value);
    if (typeof record?.[key] === "string") records.set(record[key] as string, value);
  }
  return records;
}

function mergeIdentifiedCollection(base: unknown[], desired: unknown[], current: unknown[], key: string) {
  const baseById = identifiedRecords(base, key);
  const desiredById = identifiedRecords(desired, key);
  const mergedById = identifiedRecords(current, key);
  const changedIds = new Set([...baseById.keys(), ...desiredById.keys()]);

  for (const id of changedIds) {
    const wasPresent = baseById.has(id);
    const isPresent = desiredById.has(id);
    if (wasPresent === isPresent && (!isPresent || isDeepStrictEqual(baseById.get(id), desiredById.get(id)))) continue;
    if (!isDeepStrictEqual(baseById.get(id), mergedById.get(id)) && !isDeepStrictEqual(desiredById.get(id), mergedById.get(id))) throw new HttpError(409, `配置 ${id} 已被另一设备修改，请重新读取后再保存`, "WORKSPACE_CONFLICT");
    if (isPresent) mergedById.set(id, desiredById.get(id));
    else mergedById.delete(id);
  }

  const result: unknown[] = [];
  const emitted = new Set<string>();
  for (const value of current) {
    const record = asRecord(value);
    const id = typeof record?.[key] === "string" ? record[key] as string : undefined;
    if (!id) result.push(value);
    else if (mergedById.has(id) && !emitted.has(id)) {
      result.push(mergedById.get(id));
      emitted.add(id);
    }
  }
  for (const [id] of desiredById) {
    if (mergedById.has(id) && !emitted.has(id)) result.push(mergedById.get(id));
  }
  return result;
}

function mergeSceneCollection(base: unknown[], desired: unknown[], current: unknown[]) {
  const merged = mergeIdentifiedCollection(base, desired, current, "id");
  const baseIds = [...identifiedRecords(base, "id").keys()];
  const desiredIds = [...identifiedRecords(desired, "id").keys()];
  const currentIds = [...identifiedRecords(current, "id").keys()];
  const baseSet = new Set(baseIds);
  const desiredSet = new Set(desiredIds);
  const currentSet = new Set(currentIds);
  // Compare shared scenes only: concurrent additions/deletions are not reorder conflicts.
  const sharedBaseIds = baseIds.filter((id) => desiredSet.has(id) && currentSet.has(id));
  const sharedSet = new Set(sharedBaseIds);
  const sharedDesiredIds = desiredIds.filter((id) => sharedSet.has(id));
  const sharedCurrentIds = currentIds.filter((id) => sharedSet.has(id));
  const addedIds = desiredIds.filter((id) => !baseSet.has(id));
  const desiredOrder = desiredIds.filter((id) => sharedSet.has(id) || !baseSet.has(id));
  // Appending a new scene is not a reorder; moving it earlier in a coalesced save is.
  if (isDeepStrictEqual([...sharedBaseIds, ...addedIds], desiredOrder)) return merged;
  if (!isDeepStrictEqual(sharedBaseIds, sharedCurrentIds) && !isDeepStrictEqual(sharedDesiredIds, sharedCurrentIds)) {
    throw new HttpError(409, "场景顺序已被另一设备修改，请重新读取后再排序", "WORKSPACE_CONFLICT");
  }
  const mergedById = identifiedRecords(merged, "id");
  const ordered: unknown[] = [];
  for (const id of desiredIds) {
    if (mergedById.has(id)) {
      ordered.push(mergedById.get(id));
      mergedById.delete(id);
    }
  }
  // Keep scenes added by another device; new scenes follow the user's ordered list.
  return [...ordered, ...mergedById.values()];
}

function mergeRecordByKey(base: Record<string, unknown>, desired: Record<string, unknown>, current: Record<string, unknown>) {
  const merged = { ...current };
  const changedIds = new Set([...Object.keys(base), ...Object.keys(desired)]);
  for (const id of changedIds) {
    const wasPresent = Object.prototype.hasOwnProperty.call(base, id);
    const isPresent = Object.prototype.hasOwnProperty.call(desired, id);
    if (wasPresent === isPresent && (!isPresent || isDeepStrictEqual(base[id], desired[id]))) continue;
    if (!isDeepStrictEqual(base[id], current[id]) && !isDeepStrictEqual(desired[id], current[id])) throw new HttpError(409, `配置 ${id} 已被另一设备修改，请重新读取后再保存`, "WORKSPACE_CONFLICT");
    if (isPresent) merged[id] = desired[id];
    else delete merged[id];
  }
  return merged;
}

export function mergeWorkspacePayload(base: ReturnType<typeof normalizeWorkspacePayload>, desired: ReturnType<typeof normalizeWorkspacePayload>, current: ReturnType<typeof normalizeWorkspacePayload>) {
  const baseWorkflows = base.workflows;
  const desiredWorkflows = desired.workflows;
  const workflows = { ...current.workflows };
  const workflowIds = new Set([...Object.keys(baseWorkflows), ...Object.keys(desiredWorkflows)]);
  for (const id of workflowIds) {
    const wasPresent = Object.prototype.hasOwnProperty.call(baseWorkflows, id);
    const isPresent = Object.prototype.hasOwnProperty.call(desiredWorkflows, id);
    if (wasPresent === isPresent && (!isPresent || isDeepStrictEqual(baseWorkflows[id], desiredWorkflows[id]))) continue;
    if (!isDeepStrictEqual(baseWorkflows[id], current.workflows[id]) && !isDeepStrictEqual(desiredWorkflows[id], current.workflows[id])) throw new HttpError(409, `流程 ${id} 已被另一设备修改，请重新读取后再保存`, "WORKSPACE_CONFLICT");
    if (isPresent) workflows[id] = desiredWorkflows[id];
    else delete workflows[id];
  }
  const drafts = mergeIdentifiedCollection(base.drafts, desired.drafts, current.drafts, "id")
    .sort((left, right) => {
      const leftCreatedAt = asRecord(left)?.createdAt;
      const rightCreatedAt = asRecord(right)?.createdAt;
      return String(rightCreatedAt ?? "").localeCompare(String(leftCreatedAt ?? ""));
    });
  const sceneVersions = mergeRecordByKey(base.sceneVersions ?? {}, desired.sceneVersions ?? {}, current.sceneVersions ?? {});
  return {
    format: "zane-studio.workspace/v1",
    scenes: mergeSceneCollection(base.scenes, desired.scenes, current.scenes),
    workflows,
    optionPresets: mergeIdentifiedCollection(base.optionPresets, desired.optionPresets, current.optionPresets, "id"),
    drafts,
    sceneVersions,
  };
}


export class WorkspaceService {
  private stopping = false;
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: SqliteStore, private readonly exportFile: string) {}
  private lock<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = () => { if (this.stopping) throw new HttpError(503, "工作区服务正在关闭"); return operation(); };
    const result = this.mutation.then(guarded, guarded);
    this.mutation = result.catch(() => undefined);
    return result;
  }
  async get(): Promise<Record<string, unknown> | undefined> {
    const saved = this.store.getWorkspace();
    if (saved) return saved;
    return this.lock(async () => {
      const current = this.store.getWorkspace();
      if (current) return current;
      let contents: string;
      try { contents = await readFile(this.exportFile, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
      let parsed: unknown;
      try { parsed = JSON.parse(contents); }
      catch { throw new HttpError(500, "服务端工作区文件无法解析，已停止迁移以保护现有数据"); }
      let normalized: ReturnType<typeof normalizeWorkspacePayload>;
      try { normalized = normalizeWorkspacePayload(parsed); }
      catch { throw new HttpError(500, "服务端工作区文件格式无效，已停止迁移以保护现有数据"); }
      const imported = this.store.transaction(() => this.store.saveWorkspace(normalized));
      log("info", "workspace.migrated_from_json", { revision: imported.revision });
      return imported;
    });
  }
  async initialize(value: unknown) {
    const candidate = normalizeWorkspacePayload(value);
    await this.get();
    return this.lock(async () => {
      const existing = this.store.getWorkspace();
      if (existing) return { created: false, workspace: existing };
      const workspace = this.store.transaction(() => this.store.saveWorkspace(candidate));
      await this.export(workspace);
      return { created: true, workspace };
    });
  }
  async merge(baseValue: unknown, desiredValue: unknown) {
    const base = normalizeWorkspacePayload(baseValue);
    const desired = normalizeWorkspacePayload(desiredValue);
    await this.get();
    return this.lock(async () => {
      const workspace = this.store.transaction(() => {
        const saved = this.store.getWorkspace();
        if (!saved) throw new HttpError(409, "本机工作区尚未初始化，请先完成初始化");
        const merged = mergeWorkspacePayload(base, desired, normalizeWorkspacePayload(saved));
        return this.store.saveWorkspace(normalizeWorkspacePayload(merged));
      });
      await this.export(workspace);
      return workspace;
    });
  }
  async shutdown() { this.stopping = true; await this.mutation; }
  private async export(workspace: unknown) {
    try { await writeJsonFile(this.exportFile, workspace); }
    catch (error) { log("warn", "workspace.json_export_failed", { error: String(error) }); }
  }
}
