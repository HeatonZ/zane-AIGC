import type { WorkspaceSnapshot } from "../types";
import type { RetainedSaveQueue } from "./retainedSaveQueue";
import type { WorkspaceStatus } from "../../server/domain/workspaceContracts";

/** A server read is never merged with browser defaults, migrated or republished. */
export function readAuthoritativeWorkspace(value: unknown): WorkspaceSnapshot {
  const record = value as Partial<WorkspaceSnapshot> | null;
  if (!record || record.format !== "zane-studio.workspace/v1" || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1
    || !Array.isArray(record.scenes) || !Array.isArray(record.optionPresets) || !Array.isArray(record.drafts)
    || !record.workflows || typeof record.workflows !== "object" || Array.isArray(record.workflows)
    || (record.sceneVersions !== undefined && (!record.sceneVersions || typeof record.sceneVersions !== "object" || Array.isArray(record.sceneVersions)))) {
    throw new Error("权威工作区格式不兼容，已停止同步；不会使用本机默认场景替代");
  }
  // A pre-versioning workspace has no executable publication until explicitly published.
  return { ...record, sceneVersions: record.sceneVersions ?? {} } as WorkspaceSnapshot;
}

/** Startup reads server authority only; there is no browser-owned workspace copy. */
export async function loadAuthoritativeWorkspace(readWorkspace: () => Promise<{ workspace: WorkspaceSnapshot | null }>): Promise<WorkspaceSnapshot | null> {
  const response = await readWorkspace();
  return response.workspace === null ? null : readAuthoritativeWorkspace(response.workspace);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 只保留本次真正改动的部分，避免把整份工作区上传。
 *
 * 公网链路上行只有约 38 KB/s（下行 1.2 MB/s），而整份工作区约 3 MB，
 * base 与 desired 各带一份就是 6 MB：一次保存要 160 秒，必然撞上边缘节点 524。
 * 服务端 merge 本来就是三方合并——未出现在 base/desired 里的集合与键按"未修改"处理，
 * 保留 current 的值，所以只送改动集合与改动键是等价的。
 *
 * 判定按"节点内容是否相同"而不是引用：本机编辑后的对象是新引用，
 * 但其余场景/草稿/版本仍是原引用或深相等，不会白白上传。
 */
export function diffWorkspaceForMerge(base: WorkspaceSnapshot, desired: WorkspaceSnapshot): { base: WorkspaceSnapshot; workspace: WorkspaceSnapshot } {
  const keepScenes = (before: WorkspaceSnapshot, after: WorkspaceSnapshot) => {
    const beforeById = new Map(before.scenes.map(scene => [scene.id, scene]));
    // 注意取 after 里的对象（改动后的值）；base 侧必须另外用 before 里的原值，
    // 否则服务端会看到两侧相同而判定为"未修改"。
    const scenes = after.scenes.filter(scene => !sameValue(beforeById.get(scene.id), scene));
    // 顺序变化也是改动：服务端要靠完整序列判断是否重排。
    const reordered = before.scenes.length !== after.scenes.length
      || after.scenes.some((scene, index) => before.scenes[index]?.id !== scene.id);
    return reordered ? after.scenes : scenes;
  };
  const keepDrafts = (before: WorkspaceSnapshot, after: WorkspaceSnapshot) => {
    const beforeById = new Map(before.drafts.map(draft => [draft.id, draft]));
    return after.drafts.filter(draft => !sameValue(beforeById.get(draft.id), draft));
  };
  const keepPresets = (before: WorkspaceSnapshot, after: WorkspaceSnapshot) => {
    const beforeById = new Map(before.optionPresets.map(preset => [preset.id, preset]));
    return after.optionPresets.filter(preset => !sameValue(beforeById.get(preset.id), preset));
  };
  const keepWorkflows = (before: WorkspaceSnapshot, after: WorkspaceSnapshot) => Object.fromEntries(
    Object.entries(after.workflows).filter(([id, workflow]) => !sameValue(before.workflows[id], workflow)),
  );
  const keepVersions = (before: WorkspaceSnapshot, after: WorkspaceSnapshot) => Object.fromEntries(
    Object.entries(after.sceneVersions).filter(([id, record]) => !sameValue(before.sceneVersions[id], record)),
  );

  const scenes = keepScenes(base, desired);
  const drafts = keepDrafts(base, desired);
  const optionPresets = keepPresets(base, desired);
  const workflows = keepWorkflows(base, desired);
  const sceneVersions = keepVersions(base, desired);
  // 删除也必须是改动：desired 里少了谁，就要让服务端看到"少了"。
  const removedScenes = base.scenes.filter(scene => !desired.scenes.some(current => current.id === scene.id));
  const removedDrafts = base.drafts.filter(draft => !desired.drafts.some(current => current.id === draft.id));
  const removedPresets = base.optionPresets.filter(preset => !desired.optionPresets.some(current => current.id === preset.id));
  const removedWorkflows = Object.keys(base.workflows).filter(id => !(id in desired.workflows));
  const removedVersions = Object.keys(base.sceneVersions).filter(id => !(id in desired.sceneVersions));

  const trimmed = (snapshot: WorkspaceSnapshot, keep: { scenes: WorkspaceSnapshot["scenes"]; drafts: WorkspaceSnapshot["drafts"]; optionPresets: WorkspaceSnapshot["optionPresets"]; workflows: WorkspaceSnapshot["workflows"]; sceneVersions: WorkspaceSnapshot["sceneVersions"] }) => ({
    ...snapshot,
    scenes: keep.scenes,
    drafts: keep.drafts,
    optionPresets: keep.optionPresets,
    workflows: keep.workflows,
    sceneVersions: keep.sceneVersions,
  });

  // base 侧必须放「改动前的原值」，服务端才能算出改动；放改后的值会被判成"未修改"。
  // 同时要带上被删除项，服务端才能识别"从有到无"。
  const baseById = <T extends { id: string }>(items: T[]) => new Map(items.map(item => [item.id, item]));
  const baseScenes = scenes.map(scene => baseById(base.scenes).get(scene.id) ?? scene);
  const baseDrafts = drafts.map(draft => baseById(base.drafts).get(draft.id) ?? draft);
  const basePresets = optionPresets.map(preset => baseById(base.optionPresets).get(preset.id) ?? preset);
  const baseWorkflows = Object.fromEntries(Object.keys(workflows).map(id => [id, base.workflows[id]]));
  const baseVersions = Object.fromEntries(Object.keys(sceneVersions).map(id => [id, base.sceneVersions[id]]));

  return {
    base: trimmed(base, {
      scenes: [...baseScenes, ...removedScenes],
      drafts: [...baseDrafts, ...removedDrafts],
      optionPresets: [...basePresets, ...removedPresets],
      workflows: { ...baseWorkflows, ...Object.fromEntries(removedWorkflows.map(id => [id, base.workflows[id]])) },
      sceneVersions: { ...baseVersions, ...Object.fromEntries(removedVersions.map(id => [id, base.sceneVersions[id]])) },
    }),
    workspace: trimmed(desired, { scenes, drafts, optionPresets, workflows, sceneVersions }),
  };
}

/** Preserve unchanged object identity so unrelated AI edits do not reset UI forms.
 * Only the identical object is skipped: a revision is *not* a content identity,
 * because a local edit stays on the current revision until the server confirms it,
 * so comparing revisions here would silently revert the user's own unsaved edit and
 * reuse that stale working copy as the base of the next write (bogus merge conflict).
 * `share` below keeps identity per node, so unrelated forms still keep their state. */
export function retainWorkspaceReferences(previous: WorkspaceSnapshot, incoming: WorkspaceSnapshot): WorkspaceSnapshot {
  if (previous === incoming) return previous;
  const share = (before: unknown, after: unknown): unknown => {
    if (JSON.stringify(before) === JSON.stringify(after)) return before;
    if (Array.isArray(after)) {
      const old = Array.isArray(before) ? before : [];
      return after.map((item, index) => {
        const id = item && typeof item === "object" ? item.id : undefined;
        const match = id === undefined ? old[index] : old.find(value => value?.id === id);
        return share(match, item);
      });
    }
    if (after && typeof after === "object") {
      const old = before && typeof before === "object" ? before as Record<string, unknown> : {};
      return Object.fromEntries(Object.entries(after).map(([key, value]) => [key, share(old[key], value)]));
    }
    return after;
  };
  return share(previous, incoming) as WorkspaceSnapshot;
}

/** Explicit user replacement: read successfully and recheck edits before discarding pending writes. */
export async function replaceWorkspaceFromAuthority(options: {
  current(): WorkspaceSnapshot;
  queue: Pick<RetainedSaveQueue<WorkspaceSnapshot>, "pendingCount" | "latest" | "discard">;
  readWorkspace(): Promise<{ workspace: WorkspaceSnapshot | null }>;
  discardPending: boolean;
  canApply?(): boolean;
  apply(workspace: WorkspaceSnapshot): void;
}) {
  if (!options.discardPending && options.queue.pendingCount) throw new Error("本机还有未同步配置，请先处理保存回执");
  const base = options.current();
  const pending = options.queue.latest;
  const response = await options.readWorkspace();
  const workspace = readAuthoritativeWorkspace(response.workspace);
  if (options.current() !== base || options.queue.latest !== pending || options.canApply?.() === false) throw new Error("读取期间有新编辑或保存回执，已保留本机内容，请稍后刷新");
  if (options.discardPending && !options.queue.discard()) throw new Error("当前仍有配置请求在提交，未替换本机内容");
  options.apply(workspace);
}

export type WorkspaceClientStatus = WorkspaceStatus & { readMode?: "metadata" | "legacy-snapshot" };

export type WorkspaceSyncOutcome = "unchanged" | "applied" | "deferred" | "missing" | "stale" | "failed";
interface WorkspaceSyncOptions {
  current(): WorkspaceSnapshot;
  blocked(): boolean;
  readStatus(): Promise<WorkspaceClientStatus>;
  readWorkspace(): Promise<{ workspace: WorkspaceSnapshot | null }>;
  observed(status: WorkspaceClientStatus): void;
  apply(workspace: WorkspaceSnapshot): void;
  failed(error: Error): void;
}

/** Poll metadata; fetch a full snapshot only after a revision change. Never overwrite edits made during either read. */
export class WorkspaceSynchronizer {
  private running?: Promise<WorkspaceSyncOutcome>;
  private stopped = false;
  constructor(private readonly options: WorkspaceSyncOptions) {}
  stop() { this.stopped = true; }
  refresh(): Promise<WorkspaceSyncOutcome> {
    if (this.stopped) return Promise.resolve("stale");
    if (this.running) return this.running;
    const operation = this.read();
    this.running = operation;
    void operation.finally(() => { if (this.running === operation) this.running = undefined; });
    return operation;
  }
  private async read(): Promise<WorkspaceSyncOutcome> {
    const base = this.options.current();
    try {
      const status = await this.options.readStatus();
      if (this.stopped) return "stale";
      if (status.authority !== "sqlite" || typeof status.initialized !== "boolean" || status.catalogView !== "draft" || status.executionView !== "published"
        || (status.initialized ? !Number.isSafeInteger(status.workspaceRevision) || Number(status.workspaceRevision) < 1 : status.workspaceRevision !== null)) throw new Error("后台不支持权威工作区同步契约，请核对当前服务版本与地址");
      if (this.options.current() !== base) return "deferred";
      this.options.observed(status);
      if (!status.initialized) {
        this.options.failed(new Error("权威工作区尚未初始化；保留当前内容但停止自动同步"));
        return "missing";
      }
      if (status.workspaceRevision === base.revision) return "unchanged";
      if (this.options.current() !== base || this.options.blocked()) return "deferred";
      const response = await this.options.readWorkspace();
      if (this.stopped) return "stale";
      if (this.options.current() !== base || this.options.blocked()) return "deferred";
      const workspace = readAuthoritativeWorkspace(response.workspace);
      if (Number(workspace.revision) < Number(status.workspaceRevision)) throw new Error("工作区在读取期间变化，请重新核对当前后台；未应用旧快照");
      this.options.apply(workspace);
      return "applied";
    } catch (reason) {
      if (this.stopped) return "stale";
      this.options.failed(reason instanceof Error ? reason : new Error("读取权威工作区失败"));
      return "failed";
    }
  }
}
