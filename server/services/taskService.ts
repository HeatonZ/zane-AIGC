import { randomUUID } from "node:crypto";
import type { JsonValue, RunStatus, RunSubmitter } from "../domain/types.js";
import { asRecord } from "../domain/workflowValues.js";
import {
  TASK_DOCUMENT_MAX_BYTES, TASK_ITEM_LIMIT, TASK_NOTE_MAX_LENGTH, TASK_NAME_MAX_LENGTH,
  TASK_ITEM_LABEL_MAX_LENGTH, taskItemState, taskProgress, taskStatusOf,
  type TaskItem, type TaskItemState, type TaskRecord, type TaskView,
} from "../domain/taskContracts.js";
import { HttpError } from "../errors.js";
import { accessPagination } from "./accessService.js";
import type { AiSceneService } from "./aiSceneService.js";
import type { RunService } from "./runService.js";
import type { SqliteStore } from "../storage/sqliteStore.js";

const COLLECTION = "tasks";
const ACTIVE: TaskItemState[] = ["queued", "running", "cancelling"];
const RUN_ID = /^[a-f0-9-]{36}$/i;

export interface TaskAccess { ownerUserId?: string; submitter?: RunSubmitter; authorize(): void }
interface TaskViewOptions { includeItems: boolean; includeInputs: boolean }
/** 运行状态投影：进度完全由运行记录推导，不单独维护会与运行漂移的状态机。 */
type RunStates = Map<string, { status: RunStatus; reviewId?: string; error?: string }>;

/**
 * 任务：把「一个项目连续出几十张图」从几十条互不相关的运行记录变成一个有进度、可重跑、可汇总的容器。
 * 每个任务项固定自己的「已发布场景 + versionId + 输入」，确认后一次性提交为互相独立的运行，
 * 完全复用现有运行队列的并发上限、排队、审核与重启恢复——不新建调度器，也不新建旁路任务库。
 */
export class TaskService {
  private readonly busy = new Set<string>();
  constructor(private readonly store: SqliteStore, private readonly scenes: AiSceneService, private readonly runs: RunService) {}

  private async project() { return (await this.scenes.loadSettings()).projectDirectory; }
  private requireProject(project: string) { if (!project) throw new HttpError(409, "请先在集成连接中配置项目目录", "PROJECT_NOT_CONFIGURED"); return project; }
  private get(project: string, id: string): TaskRecord {
    const task = this.store.getDocument<TaskRecord>(project, COLLECTION, id);
    if (!task) throw new HttpError(404, "任务不存在", "OBJECT_NOT_FOUND");
    return task;
  }
  /** 同一任务的确认/重跑/取消串行化，避免并发确认重复提交同一批运行。 */
  private async locked<T>(project: string, id: string, operation: () => Promise<T>): Promise<T> {
    const key = project + "\n" + id;
    if (this.busy.has(key)) throw new HttpError(409, "正在处理此任务，请稍后重试", "TASK_BUSY");
    this.busy.add(key);
    try { return await operation(); } finally { this.busy.delete(key); }
  }
  private put(project: string, task: TaskRecord, expectedRevision: number) {
    try {
      return this.store.putDocumentChecked(project, COLLECTION, task, expectedRevision, () => {
        if (Buffer.byteLength(JSON.stringify(task)) > TASK_DOCUMENT_MAX_BYTES) throw new HttpError(413, "任务内容超过 4MB，请减少任务项或缩小输入", "TASK_TOO_LARGE");
      });
    } catch (error) {
      if ((error as Error).message === "DOCUMENT_CONFLICT") throw new HttpError(409, "任务已变化，请读取同一任务对账后重试", "TASK_REVISION_CONFLICT");
      throw error;
    }
  }
  private async states(project: string, tasks: readonly TaskRecord[]): Promise<RunStates> {
    return this.store.runStatuses(project, tasks.flatMap(task => task.items.flatMap(item => [item.runId, ...(item.previousRunIds ?? [])])).filter((id): id is string => Boolean(id)));
  }
  private view(task: TaskRecord, states: RunStates, options: TaskViewOptions): TaskView {
    // 投影函数要的是纯状态映射；审核/错误另行取用，避免把两种信息混在一个 Map 里反复重建。
    const statuses = new Map<string, RunStatus>([...states].map(([id, value]) => [id, value.status]));
    const progress = taskProgress(task, statuses);
    const items = task.items.map(item => {
      const live = item.runId ? states.get(item.runId) : undefined;
      return {
        itemId: item.itemId, label: item.label, sceneId: item.sceneId, versionId: item.versionId,
        state: taskItemState(task, item, statuses),
        ...(item.runId ? { runId: item.runId } : {}), ...(live?.reviewId ? { reviewId: live.reviewId } : {}),
        // 只统计真实存在的运行记录：提交失败预留的 runId 从未成为运行，不该算作一次尝试。
        attemptCount: (item.runId && states.has(item.runId) ? 1 : 0) + (item.previousRunIds ?? []).filter(id => states.has(id)).length,
        ...(item.lastError ?? live?.error ? { lastError: item.lastError ?? live?.error } : {}),
        ...(item.submittedAt ? { submittedAt: item.submittedAt } : {}),
        ...(options.includeInputs ? { inputValues: item.inputValues, inputValuesOmitted: false } : { inputValuesOmitted: true }),
      };
    });
    return {
      taskId: task.id, revision: task.revision, name: task.name, ...(task.note ? { note: task.note } : {}),
      status: taskStatusOf(task, statuses), progress,
      createdAt: task.createdAt, updatedAt: task.updatedAt,
      ...(task.confirmedAt ? { confirmedAt: task.confirmedAt } : {}), ...(task.cancelledAt ? { cancelledAt: task.cancelledAt } : {}),
      itemCount: task.items.length,
      // 只报告真实存在的运行记录：提交失败的项虽然预留了 runId（用于响应丢失对账），
      // 但它没有运行记录，列进 runIds 会让调用方以为已经跑过。
      runIds: task.items.map(item => item.runId).filter((id): id is string => typeof id === "string" && states.has(id)),
      sceneIds: [...new Set(task.items.map(item => item.sceneId))],
      ...(options.includeItems ? { items, itemsOmitted: false } : { itemsOmitted: true }),
    };
  }

  async list(query: { limit?: number; cursor?: string }, actorId: string) {
    const project = this.requireProject(await this.project());
    const tasks = this.store.listDocuments<TaskRecord>(project, COLLECTION).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const states = await this.states(project, tasks);
    // 目录快照分页绑定 id+revision：任务被确认/重跑后旧游标返回 409，而不是拼接两个快照。
    const page = accessPagination(tasks.map(task => ({ id: task.id, revision: task.revision })), query, "tasks:" + actorId, tasks.map(task => task.id));
    const byId = new Map(tasks.map(task => [task.id, task]));
    return { ...page, items: page.items.map(entry => this.view(byId.get(entry.id)!, states, { includeItems: false, includeInputs: false })), nextAction: "get_task" as const };
  }
  async detail(id: string) {
    const project = this.requireProject(await this.project());
    const task = this.get(project, id);
    const states = await this.states(project, [task]);
    return { task: this.view(task, states, { includeItems: true, includeInputs: true }), nextAction: task.confirmedAt ? "rerun_task_item" : "confirm_task" as const };
  }

  /** 逐项校验场景/发布版/输入并固定素材版本；复用发布快照的输入契约，不另建一套校验。 */
  private async validateItems(items: unknown[]) {
    if (!items.length) throw new HttpError(400, "任务至少需要一个任务项", "INVALID_TASK");
    if (items.length > TASK_ITEM_LIMIT) throw new HttpError(400, "任务项最多 " + TASK_ITEM_LIMIT + " 项", "INVALID_TASK");
    const prepared: Array<{ label: string; sceneId: string; versionId: string; inputValues: Record<string, JsonValue> }> = [];
    for (const [index, raw] of items.entries()) {
      const item = asRecord(raw) ?? {};
      const sceneId = typeof item.sceneId === "string" ? item.sceneId : "";
      const versionId = typeof item.versionId === "string" ? item.versionId : "";
      if (!sceneId || !versionId) throw new HttpError(400, "第 " + (index + 1) + " 项缺少场景或发布版本", "INVALID_TASK");
      const inputValues = asRecord(item.inputValues);
      if (!inputValues) throw new HttpError(400, "第 " + (index + 1) + " 项输入无效", "INVALID_TASK");
      const named = typeof item.label === "string" && item.label.trim() ? item.label.trim().slice(0, TASK_ITEM_LABEL_MAX_LENGTH) : undefined;
      const label = named ?? "第 " + (index + 1) + " 项";
      // 复用发布快照的输入契约校验（类型/必填/选项/素材版本），但把失败归属到具体项：
      // 否则 200 项里报「字段 flag 的数据类型不匹配」无法定位是哪一行。
      const checked = await this.scenes.prepare(sceneId, versionId, inputValues as Record<string, JsonValue>)
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          throw new HttpError(error instanceof HttpError ? error.status : 400, "第 " + (index + 1) + " 项" + (named ? "（" + named + "）" : "") + "：" + reason, error instanceof HttpError ? error.code : "INVALID_TASK");
        });
      prepared.push({ label, sceneId, versionId, inputValues: checked.inputValues });
    }
    return prepared;
  }
  private async owner(access: TaskAccess) { return { ownerUserId: access.ownerUserId, submitter: access.submitter }; }

  async create(raw: unknown, access: TaskAccess) {
    access.authorize();
    const body = asRecord(raw) ?? {};
    const project = this.requireProject(await this.project());
    const id = String(body.taskId ?? "");
    if (!RUN_ID.test(id)) throw new HttpError(400, "任务编号无效", "INVALID_TASK");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new HttpError(400, "请填写任务名称", "INVALID_TASK");
    if (name.length > TASK_NAME_MAX_LENGTH) throw new HttpError(400, "任务名称最多 " + TASK_NAME_MAX_LENGTH + " 字", "INVALID_TASK");
    const note = typeof body.note === "string" ? body.note : "";
    if (note.length > TASK_NOTE_MAX_LENGTH) throw new HttpError(400, "任务说明过长", "INVALID_TASK");
    if (!Array.isArray(body.items)) throw new HttpError(400, "任务项必须是数组", "INVALID_TASK");
    // 响应丢失后重试必须按原 ID 对账，而不是再建一个任务。
    if (this.store.getDocument<TaskRecord>(project, COLLECTION, id)) throw new HttpError(409, "任务编号已存在，请读取同一任务对账", "TASK_ALREADY_EXISTS");
    const prepared = await this.validateItems(body.items);
    const now = new Date().toISOString();
    const { ownerUserId, submitter } = await this.owner(access);
    const task: TaskRecord = {
      id, revision: 0, name, ...(note ? { note } : {}), createdAt: now, updatedAt: now,
      ...(ownerUserId ? { ownerUserId } : {}), ...(submitter ? { submitter } : {}),
      items: prepared.map(item => ({ itemId: randomUUID(), ...item })),
    };
    const saved = this.put(project, task, 0);
    const states = await this.states(project, [saved]);
    return { task: this.view(saved, states, { includeItems: true, includeInputs: true }), nextAction: "confirm_task" as const };
  }

  /** 只在确认前的中间态允许整体替换任务项；确认后输入冻结，只能单项重跑。 */
  async update(id: string, raw: unknown, access: TaskAccess) {
    access.authorize();
    const body = asRecord(raw) ?? {};
    const project = this.requireProject(await this.project());
    return this.locked(project, id, async () => {
      const task = this.get(project, id);
      if (task.revision !== body.revision) throw new HttpError(409, "任务已变化，请重新读取", "TASK_REVISION_CONFLICT", { currentRevision: task.revision });
      if (task.confirmedAt) throw new HttpError(409, "任务已确认，输入已冻结；请用 rerun_task_item 重跑单项", "TASK_ALREADY_CONFIRMED");
      const next: TaskRecord = { ...task };
      if (body.name !== undefined) {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name || name.length > TASK_NAME_MAX_LENGTH) throw new HttpError(400, "任务名称无效", "INVALID_TASK");
        next.name = name;
      }
      if (body.note !== undefined) {
        const note = typeof body.note === "string" ? body.note : "";
        if (note.length > TASK_NOTE_MAX_LENGTH) throw new HttpError(400, "任务说明过长", "INVALID_TASK");
        if (note) next.note = note; else delete next.note;
      }
      if (body.items !== undefined) {
        if (!Array.isArray(body.items)) throw new HttpError(400, "任务项必须是数组", "INVALID_TASK");
        const prepared = await this.validateItems(body.items);
        // 按位置保留 itemId：编辑表格行不会让已有项的标识漂移。
        next.items = prepared.map((item, index) => ({ itemId: task.items[index]?.itemId ?? randomUUID(), ...item }));
      }
      next.updatedAt = new Date().toISOString();
      const saved = this.put(project, next, task.revision);
      const states = await this.states(project, [saved]);
      return { task: this.view(saved, states, { includeItems: true, includeInputs: true }), nextAction: "confirm_task" as const };
    });
  }

  /**
   * 确认并批量提交。确认是一次性单向冻结：为每个任务项预先分配稳定 runId 后先落库，
   * 再逐项提交。因此响应丢失后重试会用同一批 runId 对账（已存在的运行被识别为已提交），
   * 不会重复提交，也不会重复计费。
   */
  async confirm(id: string, raw: unknown, access: TaskAccess) {
    access.authorize();
    const body = asRecord(raw) ?? {};
    const project = this.requireProject(await this.project());
    return this.locked(project, id, async () => {
      let task = this.get(project, id);
      const alreadyConfirmed = Boolean(task.confirmedAt);
      if (!alreadyConfirmed) {
        if (task.revision !== body.revision) throw new HttpError(409, "任务已变化，请重新读取", "TASK_REVISION_CONFLICT", { currentRevision: task.revision });
        if (task.cancelledAt) throw new HttpError(409, "任务已取消，不能确认", "TASK_CANCELLED");
        if (!task.items.length) throw new HttpError(400, "任务没有可提交的项", "INVALID_TASK");
        task = this.put(project, {
          ...task, confirmedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          items: task.items.map(item => item.runId ? item : { ...item, runId: randomUUID() }),
        }, task.revision);
      }
      const submitted: Array<{ itemId: string; runId: string }> = [];
      const failures: Array<{ itemId: string; message: string }> = [];
      const items: TaskItem[] = [];
      let changed = false;
      for (const item of task.items) {
        if (!item.runId) { items.push(item); continue; }
        // 已有运行记录说明这项此前就提交过（响应丢失后的重试）：只复用，不计入本次 submitted，
        // 否则调用方无法区分「这次真的提交了 2 项」和「本来就已经有 2 项」，会误判重复计费。
        if (this.store.getRun(project, item.runId)) { items.push(item); continue; }
        try {
          // 每次提交都重新读取发布快照并校验输入：确认后场景可能已重新发布或素材已被归档。
          const prepared = await this.scenes.prepare(item.sceneId, item.versionId, item.inputValues);
          await this.runs.submit({ runId: item.runId, runTitle: (task.name + " · " + item.label).slice(0, 120), workflow: prepared.workflow, inputValues: prepared.inputValues },
            { ownerUserId: access.ownerUserId ?? task.ownerUserId ?? "@operator", submitter: access.submitter ?? task.submitter, authorize: access.authorize });
          submitted.push({ itemId: item.itemId, runId: item.runId });
          items.push({ ...item, submittedAt: new Date().toISOString(), lastError: undefined });
          changed = true;
        } catch (error) {
          // 单项失败不阻断整批：其余项继续提交，失败项在任务里标红并可单独重跑。
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ itemId: item.itemId, message });
          items.push({ ...item, lastError: message });
          changed = true;
        }
      }
      // 纯重读（响应丢失后重试、所有项都已有运行记录）不写库：无意义的写入会推进 revision，
      // 让其他调用方基于旧 revision 的合法请求突然 409。
      const saved = changed ? this.put(project, { ...task, items, updatedAt: new Date().toISOString() }, task.revision) : task;
      const states = await this.states(project, [saved]);
      return {
        task: this.view(saved, states, { includeItems: true, includeInputs: false }), alreadyConfirmed,
        submitted, failures, nextAction: failures.length ? "rerun_task_item" : "get_task" as const,
      };
    });
  }

  /** 单项重跑：只追加新运行并保留旧 runId，便于回溯这一项实际生成过什么。 */
  async rerunItem(id: string, raw: unknown, access: TaskAccess) {
    access.authorize();
    const body = asRecord(raw) ?? {};
    const project = this.requireProject(await this.project());
    return this.locked(project, id, async () => {
      const task = this.get(project, id);
      if (task.revision !== body.revision) throw new HttpError(409, "任务已变化，请重新读取", "TASK_REVISION_CONFLICT", { currentRevision: task.revision });
      if (!task.confirmedAt) throw new HttpError(409, "任务尚未确认，请先确认后再重跑", "TASK_NOT_CONFIRMED");
      if (task.cancelledAt) throw new HttpError(409, "任务已取消，不能重跑", "TASK_CANCELLED");
      const itemId = String(body.itemId ?? "");
      const item = task.items.find(candidate => candidate.itemId === itemId);
      if (!item) throw new HttpError(404, "任务项不存在", "OBJECT_NOT_FOUND");
      const live = item.runId ? this.store.getRun(project, item.runId) : undefined;
      if (live && ACTIVE.includes(live.status)) throw new HttpError(409, "这一项正在执行，请先取消或等待结束", "TASK_ITEM_ACTIVE");
      if (live?.status === "waiting") throw new HttpError(409, "这一项正在等待人工确认，请先在运行记录里处理审核", "REVIEW_REQUIRED");
      const runId = randomUUID();
      const prepared = await this.scenes.prepare(item.sceneId, item.versionId, item.inputValues);
      const run = await this.runs.submit({ runId, runTitle: (task.name + " · " + item.label).slice(0, 120), workflow: prepared.workflow, inputValues: prepared.inputValues },
        { ownerUserId: access.ownerUserId ?? task.ownerUserId ?? "@operator", submitter: access.submitter ?? task.submitter, authorize: access.authorize });
      const saved = this.put(project, {
        ...task, updatedAt: new Date().toISOString(),
        items: task.items.map(candidate => candidate.itemId === itemId
          ? {
            ...candidate, runId: run.runId, lastError: undefined, submittedAt: new Date().toISOString(),
            // 只把真实存在过的运行记为历史：提交失败时预留的 runId 从未成为运行记录，
            // 记进 previousRunIds 会让 attemptCount 虚高并指向不存在的运行。
            previousRunIds: [...(candidate.previousRunIds ?? []), ...(candidate.runId && this.store.getRun(project, candidate.runId) ? [candidate.runId] : [])],
          }
          : candidate),
      }, task.revision);
      const states = await this.states(project, [saved]);
      return { task: this.view(saved, states, { includeItems: true, includeInputs: false }), nextAction: "get_task" as const };
    });
  }

  /** 取消任务：标记取消并尽力取消仍在排队/执行/待确认的项；已完成的项保留结果。 */
  async cancel(id: string, raw: unknown, access: TaskAccess) {
    access.authorize();
    const body = asRecord(raw) ?? {};
    const project = this.requireProject(await this.project());
    return this.locked(project, id, async () => {
      const task = this.get(project, id);
      if (task.revision !== body.revision) throw new HttpError(409, "任务已变化，请重新读取", "TASK_REVISION_CONFLICT", { currentRevision: task.revision });
      if (!task.cancelledAt) {
        const marked = this.put(project, { ...task, cancelledAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, task.revision);
        for (const item of marked.items) {
          if (!item.runId) continue;
          const live = this.store.getRun(project, item.runId);
          if (!live) continue;
          if (!ACTIVE.includes(live.status) && live.status !== "waiting") continue;
          // 取消是尽力而为：某一项已结束或无法停止时不影响其余项。
          try { await this.runs.cancel(project, item.runId); } catch { /* 单项取消失败由该项真实状态反映 */ }
        }
      }
      const saved = this.get(project, id);
      const states = await this.states(project, [saved]);
      return { task: this.view(saved, states, { includeItems: true, includeInputs: false }), nextAction: "get_task" as const };
    });
  }

  /** 删除任务记录：不删除历史运行、媒体或素材。有在途项时拒绝，避免删掉正在跑的任务视图。 */
  async remove(id: string, raw: unknown, access: TaskAccess) {
    access.authorize();
    const body = asRecord(raw) ?? {};
    const project = this.requireProject(await this.project());
    return this.locked(project, id, async () => {
      const task = this.get(project, id);
      if (task.revision !== body.revision) throw new HttpError(409, "任务已变化，请重新读取", "TASK_REVISION_CONFLICT", { currentRevision: task.revision });
      const states = await this.states(project, [task]);
      const active = task.items.filter(item => {
        const status = item.runId ? states.get(item.runId)?.status : undefined;
        return status ? ACTIVE.includes(status) || status === "waiting" : false;
      });
      if (active.length) throw new HttpError(409, "任务仍有 " + active.length + " 项在排队、执行或等待确认，请先取消任务", "TASK_ITEM_ACTIVE");
      return { taskId: id, deleted: this.store.deleteDocument(project, COLLECTION, id), nextAction: "list_tasks" as const };
    });
  }
}
