import type { WorkspaceSnapshot } from "../types";
import type { RetainedSaveQueue, PendingSave } from "./retainedSaveQueue";
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

/** A recovery outbox is intent only. Reject incompatible entries without dropping or replaying them. */
export function parseRetainedWorkspaceEdits(raw: string | null): PendingSave<WorkspaceSnapshot>[] {
  let entries: unknown;
  try { entries = raw === null ? [] : JSON.parse(raw); }
  catch { throw new Error("待提交编辑不可读，原始数据已保留；不会用它创建场景"); }
  if (!Array.isArray(entries)) throw new Error("待提交编辑格式不兼容，原始数据已保留；不会用它创建场景");
  for (const entry of entries) {
    readAuthoritativeWorkspace(entry?.base);
    readAuthoritativeWorkspace(entry?.desired);
  }
  return entries as PendingSave<WorkspaceSnapshot>[];
}

/** Startup reads server authority only; retained browser edits are intentionally not an input. */
export async function loadAuthoritativeWorkspace(readWorkspace: () => Promise<{ workspace: WorkspaceSnapshot | null }>): Promise<WorkspaceSnapshot | null> {
  const response = await readWorkspace();
  return response.workspace === null ? null : readAuthoritativeWorkspace(response.workspace);
}

/** Preserve unchanged object identity so unrelated AI edits do not reset UI forms. */
export function retainWorkspaceReferences(previous: WorkspaceSnapshot, incoming: WorkspaceSnapshot): WorkspaceSnapshot {
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

/** Explicit user replacement: read successfully and recheck edits before discarding an outbox. */
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
  if (options.discardPending && !options.queue.discard()) throw new Error("当前仍有配置请求在提交或本地存储失败；未替换本机内容");
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
