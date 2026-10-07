import { updateTaskConcurrency, taskConcurrencyLimit, type TaskConcurrencySettings } from "../domain/taskConcurrencyContracts.js";
import { HttpError } from "../errors.js";
import type { SqliteStore } from "../storage/sqliteStore.js";

const SYSTEM = "@zane-system";
const COLLECTION = "settings";
const ID = "task-concurrency";
interface SavedConcurrency { id: string; revision: number; maxActiveRuns: number }

/** The scheduler, HTTP, MCP and UI all use this one SQLite-backed system setting. */
export class TaskConcurrencyService {
  constructor(
    private readonly store: SqliteStore,
    private readonly defaultLimit: number,
    private readonly worker: () => TaskConcurrencySettings["worker"],
    private readonly onChanged: () => void,
  ) { taskConcurrencyLimit.parse(defaultLimit); }

  private saved() { return this.store.getDocument<SavedConcurrency>(SYSTEM, COLLECTION, ID); }
  getLimit() { return this.saved()?.maxActiveRuns ?? this.defaultLimit; }
  read(): TaskConcurrencySettings {
    const saved = this.saved();
    const { active, queued, preparing } = this.worker();
    return {
      format: "zane-studio.task-concurrency/v1", id: ID, revision: saved?.revision ?? 0,
      maxActiveRuns: saved?.maxActiveRuns ?? this.defaultLimit, defaultMaxActiveRuns: this.defaultLimit,
      source: saved ? "saved" : "environment", scope: "system",
      applyPolicy: "immediate_without_interrupting_active_runs", worker: { active, queued, preparing },
      nextAction: "update_with_revision",
    };
  }
  update(input: unknown, authorize: () => void): TaskConcurrencySettings {
    const parsed = updateTaskConcurrency.safeParse(input);
    if (!parsed.success) throw new HttpError(400, "任务并发必须是 1–32 的整数，且需要当前 revision；不接受未知字段", "INVALID_TASK_CONCURRENCY_REQUEST");
    const { revision, maxActiveRuns } = parsed.data;
    try {
      this.store.putDocumentChecked(SYSTEM, COLLECTION, { id: ID, revision, maxActiveRuns }, revision, authorize);
    } catch (error) {
      if (error instanceof Error && error.message === "DOCUMENT_CONFLICT") {
        throw new HttpError(409, "任务并发配置已变化，请重新读取并核对后保存；不要重放旧请求", "RESOURCE_REVISION_CONFLICT");
      }
      throw error;
    }
    this.onChanged();
    return this.read();
  }
}
