import { asRecord } from "../domain/workflowValues.js";
import { compareDrafts } from "../domain/draftFavorites.js";
import { HttpError } from "../errors.js";
import { draftFavoriteRequest, type DraftFavoriteRequest } from "../ai/taskDraftSchemas.js";
import { accessPagination } from "./accessService.js";
import type { WorkspaceService } from "./workspaceService.js";

/** Admin-only legacy task drafts remain in the existing authoritative workspace, not a second database. */
export class TaskDraftService {
  constructor(private readonly workspace: WorkspaceService) {}
  private async snapshot() {
    const snapshot = await this.workspace.get();
    if (!snapshot) throw new HttpError(409, "工作区尚未初始化", "WORKSPACE_NOT_INITIALIZED");
    return snapshot;
  }
  private records(snapshot: Record<string, unknown>) {
    return (Array.isArray(snapshot.drafts) ? snapshot.drafts : []).map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
  }
  private find(snapshot: Record<string, unknown>, id: string) {
    const draft = this.records(snapshot).find(item => item.id === id);
    if (!draft) throw new HttpError(404, "任务草稿不存在", "OBJECT_NOT_FOUND");
    return draft;
  }
  private view(draft: Record<string, unknown>, revision: number, includeValues = false) {
    const runId = asRecord(draft.runResult)?.runId;
    return {
      id: String(draft.id), revision, sceneId: String(draft.sceneId ?? ""), title: String(draft.title ?? ""),
      ...(typeof draft.runTitle === "string" ? { runTitle: draft.runTitle } : {}),
      createdAt: String(draft.createdAt ?? ""), status: draft.status === "completed" || draft.status === "failed" ? draft.status : "draft" as const,
      isFavorite: draft.isFavorite === true,
      ...(includeValues && typeof draft.summary === "string" ? { summary: draft.summary } : {}),
      ...(includeValues && asRecord(draft.inputValues) ? { inputValues: draft.inputValues } : {}),
      ...(typeof runId === "string" ? { runId } : {}),
      summaryOmitted: !includeValues && draft.summary !== undefined,
      inputValuesOmitted: !includeValues && draft.inputValues !== undefined,
      runResultOmitted: draft.runResult !== undefined,
    };
  }
  async list(query: { limit?: number; cursor?: string }, actorId: string) {
    const snapshot = await this.snapshot(); const revision = Number(snapshot.revision);
    const all = this.records(snapshot).sort(compareDrafts).map(draft => this.view(draft, revision));
    return { ...accessPagination(all, query, "task-drafts:" + actorId, revision), workspaceRevision: revision, nextAction: "get_task_draft" as const };
  }
  async get(id: string) {
    const snapshot = await this.snapshot(); const revision = Number(snapshot.revision);
    return { draft: this.view(this.find(snapshot, id), revision, true), revision, nextAction: "get_task_draft" as const };
  }
  async setFavorite(id: string, input: DraftFavoriteRequest, authorize: () => void) {
    if (!draftFavoriteRequest.safeParse(input).success) throw new HttpError(400, "收藏参数无效", "INVALID_AI_REQUEST");
    const saved = await this.workspace.mutateScoped(current => {
      authorize();
      const draft = this.find(current, id);
      if (current.revision !== input.revision) throw new HttpError(409, "草稿版本冲突，请读取同一ID对账", "DRAFT_REVISION_CONFLICT", { currentRevision: current.revision });
      if ((draft.isFavorite === true) === input.isFavorite) return { result: undefined };
      return { workspace: { ...current, drafts: this.records(current).map(item => item.id === id ? { ...item, isFavorite: input.isFavorite } : item).sort(compareDrafts) }, result: undefined };
    });
    const revision = Number(saved.workspace.revision);
    return { draft: this.view(this.find(saved.workspace, id), revision), revision, nextAction: "get_task_draft" as const };
  }
}
