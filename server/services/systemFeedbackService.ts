import * as z from "zod/v4";
import { AccessService, accessPagination, type Identity } from "./accessService.js";
import { HttpError } from "../errors.js";
import { createSystemFeedback, handleSystemFeedback, systemFeedbackKey, systemFeedbackQuery, type SystemFeedback } from "../domain/systemFeedbackContracts.js";

const COLLECTION = "system-feedback";
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, "系统反馈参数无效：" + result.error.message, "INVALID_SYSTEM_FEEDBACK");
  return result.data;
}
/** Human support inbox only. Never forwards feedback to Hermes, workflow execution or evolution. */
export class SystemFeedbackService {
  constructor(readonly access: AccessService, readonly loadProject: () => Promise<string>) {}
  private authorize(identity: Identity, admin: boolean) {
    const current = this.access.refresh(identity);
    if (admin && current.role !== "admin") throw new HttpError(403, "需要管理员权限", "ADMIN_REQUIRED");
    return current;
  }
  async get(identity: Identity, input: unknown, admin = false) {
    const { feedbackId } = parse(systemFeedbackKey, input);
    this.authorize(identity, admin);
    const project = await this.loadProject(); this.authorize(identity, admin);
    const feedback = this.access.store.getDocument<SystemFeedback>(project, COLLECTION, feedbackId);
    if (!feedback || (!admin && feedback.userId !== identity.id)) throw new HttpError(404, "系统反馈不存在", "OBJECT_NOT_FOUND");
    return { feedback, nextAction: admin ? "handle_system_feedback" : "get_own_system_feedback" };
  }
  async list(identity: Identity, input: unknown, admin = false) {
    const query = parse(systemFeedbackQuery, input);
    this.authorize(identity, admin); const project = await this.loadProject(); this.authorize(identity, admin);
    const all = this.access.store.listDocuments<SystemFeedback>(project, COLLECTION)
      .filter(item => (admin || item.userId === identity.id) && (!query.status || item.status === query.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const summaries = all.map(({ description: _description, reply: _reply, ...item }) => ({ ...item, descriptionOmitted: true as const, replyOmitted: true as const }));
    return { ...accessPagination(summaries, query, (admin ? "admin-feedback:" : "own-feedback:") + identity.id, query.status ?? null), nextAction: admin ? "get_system_feedback" : "get_own_system_feedback" };
  }
  async create(identity: Identity, input: unknown) {
    const data = parse(createSystemFeedback, input);
    this.authorize(identity, false); const project = await this.loadProject();
    const actor = this.authorize(identity, false);
    const now = new Date().toISOString();
    try {
      const feedback = this.access.store.putDocumentChecked<SystemFeedback>(project, COLLECTION, {
        id: data.feedbackId, revision: 0, userId: actor.id, submitterName: actor.displayName,
        title: data.title, category: data.category, description: data.description, ...(data.runId ? { runId: data.runId } : {}),
        status: "pending", reply: "", createdAt: now, updatedAt: now,
      }, 0, () => {
        const current = this.authorize(identity, false);
        if (data.runId) {
          const run = this.access.store.getRun(project, data.runId);
          if (!run || (current.role !== "admin" && run.ownerUserId !== current.id)) throw new HttpError(404, "关联任务不存在", "OBJECT_NOT_FOUND");
        }
      });
      return { feedback, nextAction: "get_own_system_feedback" };
    } catch (error) {
      if ((error as Error).message === "DOCUMENT_CONFLICT") throw new HttpError(409, "反馈ID已存在；读取原ID对账，不重复提交", "SYSTEM_FEEDBACK_ALREADY_EXISTS");
      throw error;
    }
  }
  async handle(identity: Identity, input: unknown) {
    const data = parse(handleSystemFeedback, input);
    const { feedback: current } = await this.get(identity, { feedbackId: data.feedbackId }, true);
    if (data.revision !== current.revision) throw new HttpError(409, "反馈版本冲突；读取原ID和当前revision后再决定", "SYSTEM_FEEDBACK_REVISION_CONFLICT");
    const project = await this.loadProject();
    if (data.status === "pending") throw new HttpError(409, "已提交反馈不能改回待处理；重新处理请选择处理中", "SYSTEM_FEEDBACK_STATE_CONFLICT");
    if (["resolved", "rejected"].includes(current.status) && data.status !== "processing") throw new HttpError(409, "已结束反馈须先显式重新处理", "SYSTEM_FEEDBACK_STATE_CONFLICT");
    try {
      const feedback = this.access.store.putDocumentChecked<SystemFeedback>(project, COLLECTION, {
        ...current, status: data.status, reply: data.reply, handledBy: identity.id, updatedAt: new Date().toISOString(),
      }, data.revision, () => { this.authorize(identity, true); });
      return { feedback, nextAction: "get_system_feedback" };
    } catch (error) {
      if ((error as Error).message === "DOCUMENT_CONFLICT") throw new HttpError(409, "反馈版本冲突；读取原ID和当前revision后再决定", "SYSTEM_FEEDBACK_REVISION_CONFLICT");
      throw error;
    }
  }
}
