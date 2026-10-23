import * as z from "zod/v4";
import { HttpError } from "../errors.js";
import type { JsonValue } from "./types.js";
import { feedbackMessageMaxLength } from "./feedbackContracts.js";
import { id, runId } from "../ai/schemas.js";

/** 步骤级「带上下文交给 Agent」的输入/输出契约（契约名 x-step-agent-feedback v1）。
 *
 *  与反馈重做（preview_rerun/rerun 的 changes.feedback、review_run redo 的 feedback）的区别：
 *  那条链路会带着反馈重新执行这一步、把新结果写进运行；本契约只把反馈连同执行期上下文交给
 *  该步骤原本调用的 Agent 一次，返回原文与按输出契约解析的修订结果，**不重做、不排队、不新建
 *  运行、不写运行记录、不发布、不生成媒体**。它不是「预览计划」，而是一次可丢弃的修订请求；
 *  要真正采纳必须显式走反馈重做链路（反馈文本与重做链路共享同一长度上限与同一份校验）。 */

export const requestStepAgentFeedback = z.object({
  runId,
  stepId: id.describe("运行快照里真实存在的 Hermes 步骤 ID；显示名不是 ID。不是 Hermes 步骤返回 400 STEP_FEEDBACK_STEP_KIND"),
  itemIndex: z.int().nonnegative().optional().describe("for_each 步骤的逐项编号（0 基），省略表示整步；可反馈条件与重做链路同一份校验，不满足返回 400 INVALID_FEEDBACK（同样的反馈在重做链路里也会被拒绝）"),
  message: z.string().trim().min(1).max(feedbackMessageMaxLength).describe("反馈意见本身（最多 " + feedbackMessageMaxLength + " 字），与重做链路共用同一长度上限与校验"),
  context: z.object({
    artifact: z.string().min(1).max(2_000).describe("反馈针对的产物/字段（某个输出端口、某段文本、某个镜头编号），让 Agent 知道该看哪里").optional(),
    observation: z.string().min(1).max(4_000).describe("观察到的具体问题，尽量写可核对的现象或证据；不要写「再优化一下」这类无法验收的话").optional(),
    expectation: z.string().min(1).max(4_000).describe("期望改成什么样；只写这次要改的部分，未涉及的内容应保持不动").optional(),
    constraints: z.string().min(1).max(4_000).describe("必须保持不动的约束（不可改的事实、必须保留的段落、字数或格式限制）").optional(),
  }).strict().describe("结构化的补充上下文，随反馈一起交给 Agent；它不是流程输入，不参与模板渲染与输出校验").optional(),
}).strict();

export const stepAgentFeedbackResult = z.object({
  runId,
  stepId: id,
  itemIndex: z.int().nonnegative().optional(),
  revision: z.string().describe("本次回复的内容指纹（含每次新生成的反馈ID与时间）；只用于核对回执是否属于同一份回复，不是运行 revision，也不代表任何已保存状态"),
  agentReply: z.string().describe("Agent 本次回复原文，不裁剪首尾空白；它没有写入运行，下次回复前不会被读取回来"),
  replyParsed: z.literal(true).describe("回复已通过该步骤声明的输出契约校验；解析/校验失败时不返回本结果，而是 502 STEP_FEEDBACK_AGENT_FAILED 并带一段原文用于诊断"),
  outputs: z.record(z.string(), z.json()).describe("按该步骤声明的输出端口解析校验后的修订结果；逐项步骤里就是该项的新结果。媒体端口只回固定引用与数量，不回本机路径"),
  originalOutputs: z.record(z.string(), z.json()).describe("反馈针对的那份原结果（整步=步骤输出，逐项=该项输出），用于逐字段对比"),
  context: z.object({ stepId: id, itemIndex: z.int().nonnegative().optional(), feedback: z.string().describe("实际拼进提示词的反馈文本（message + 结构化上下文）；提示词其余部分不返回"), at: z.string() }).strict(),
  durationMs: z.int().nonnegative(),
  agentPromptOmitted: z.literal(true).describe("固定为 true：完整提示词含本机归档媒体路径，只在运行记录里，不在本结果里返回"),
  nextAction: z.string().describe("要采纳修订就显式走反馈重做链路（review_run redo 带 feedback，或 preview_rerun/rerun 的 changes.feedback）；只想换措辞再问一次就按同一坐标重新提交 request_step_agent_feedback"),
});

export type StepAgentFeedbackRequest = z.output<typeof requestStepAgentFeedback>;
export type StepAgentFeedbackContext = NonNullable<StepAgentFeedbackRequest["context"]>;

/** 机器契约：与 OpenAPI 的 x-step-agent-feedback 同源，说明「它做什么、明确不做什么」。 */
export const STEP_AGENT_FEEDBACK_CONTRACT = {
  version: "1",
  scope: "管理员把一个已完成步骤的反馈连同执行期上下文交给该步骤原本调用的 Agent 一次，拿回修订结果作为参考",
  access: {
    role: "admin",
    userEntry: "不出现在用户专用入口白名单；普通用户只能走系统反馈或本人审核",
    note: "它不是运行、不是重做、不是质检意见：不写运行记录、不改场景、不发布、不生成媒体",
  },
  route: { method: "POST", path: "/api/v1/runs/{runId}/steps/{stepId}/feedback" },
  context: {
    source: "按运行快照重建：解析后的步骤输入、上游步骤结果、for_each 逐项来源项与 iteration.item、被修订的原结果、该步骤当时的 hermesProfile/hermesProvider/hermesModel",
    prompt: "模板渲染、输出契约与附件构造复用执行期同一路径；反馈作为附录注入，不改模板与快照",
    omitted: "响应不返回完整提示词（含本机归档媒体路径）；媒体端口只回固定引用与数量",
  },
  boundaries: {
    noRedo: "不排队、不新建运行、不写运行记录（含 feedbackHistory）、不改状态或 revision；要采纳修订必须显式走 review_run redo 或 preview_rerun/rerun 的 changes.feedback",
    validation: "与反馈重做链路共用同一份反馈校验与长度上限：目标必须是运行快照里真实存在的 Hermes 步骤，接受/拒绝口径一致",
    cost: "真实调用模型、可能计费、一次请求不自动重试；解析或输出校验失败返回 502 并带一段有界原文（不写入任何记录）",
    reconciliation: "本操作没有可对账的持久记录：回执丢失时读运行记录可确认「什么都没发生」，是否重发（会再次计费）由操作者决定",
  },
} as const;

/** 解析并校验调用方输入；字段级原因直接进错误消息，不用调用方猜。 */
export function createStepAgentFeedbackRequest(input: unknown): StepAgentFeedbackRequest {
  const parsed = requestStepAgentFeedback.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "步骤反馈参数无效：" + parsed.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; "), "INVALID_STEP_FEEDBACK_REQUEST");
  return parsed.data;
}

/** 反馈正文与结构化上下文合并后的实际反馈文本；独立成函数以便契约测试固定拼接格式。 */
export function stepAgentFeedbackMessage(message: string, context?: StepAgentFeedbackContext): string {
  if (!context) return message;
  const lines = [
    context.artifact ? `产物：${context.artifact}` : undefined,
    context.observation ? `观察到的问题：${context.observation}` : undefined,
    context.expectation ? `期望结果：${context.expectation}` : undefined,
    context.constraints ? `必须保持不动：${context.constraints}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return lines.length ? `${message}\n\n补充上下文：\n${lines.join("\n")}` : message;
}

/** 声明为媒体的输出端口只回固定引用与数量：本机路径、临时 URL 都不进响应。
 *  与业务运行详情（businessRun 的 mediaInput）同一口径——调用方要媒体本身走运行结果/导出接口。 */
export function projectRevisedOutputs(outputs: Record<string, JsonValue>, declared: Array<{ key: string; type: string }>): Record<string, JsonValue> {
  const types = new Map(declared.map(output => [output.key, output.type]));
  return Object.fromEntries(Object.entries(outputs).map(([key, value]) => {
    const type = types.get(key) ?? "";
    if (!["image", "video", "audio", "image_list", "video_list", "audio_list"].includes(type)) return [key, value];
    const items = Array.isArray(value) ? value : value === null || value === undefined || value === "" ? [] : [value];
    return [key, {
      mediaCount: items.length,
      items: items.map(item => {
        const record = typeof item === "object" && item !== null && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
        if (!record || typeof record.assetId !== "string" || !Number.isSafeInteger(record.assetVersion)) return { locatorOmitted: true };
        return { assetId: record.assetId, assetVersion: record.assetVersion as number, ...(typeof record.assetName === "string" ? { assetName: record.assetName } : {}) };
      }),
    }];
  }));
}
