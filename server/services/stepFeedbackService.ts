import type { RunRecord, SavedSettings, RunStep } from "../domain/types.js";
import type { JsonValue } from "../domain/types.js";
import type { Identity } from "./accessService.js";
import type { StepFeedbackRecord } from "../domain/feedbackContracts.js";
import type { StepAgentFeedbackRequest } from "../domain/stepAgentFeedback.js";
import { captureStepFeedback, feedbackForStep, validateStepFeedback } from "../domain/stepFeedback.js";
import { rebuildStepExecutionContext, resolveStepExecutionContextInputs } from "../execution/stepContextRebuild.js";
import { contentRevision } from "../domain/sceneContent.js";
import { externalizeRuntimeValue } from "../domain/workflowValues.js";
import { HttpError } from "../errors.js";
import { createStepAgentFeedbackRequest, projectRevisedOutputs, stepAgentFeedbackMessage } from "../domain/stepAgentFeedback.js";

/** 把反馈连同执行期上下文交给该步骤原本调用的 Agent 一次，返回原文与按输出契约解析的修订结果。
 *
 *  与反馈重做链路（preview_rerun/rerun 的 changes.feedback、review_run redo）的分工：
 *  - 那条链路会带反馈重新执行这一步、把新结果写进运行；本服务只发一次请求，**不重做、不排队、
 *    不新建运行、不写运行记录、不发布、不生成媒体**，因此不碰 RunService 的并发与状态机；
 *  - 反馈文本、目标步骤与可反馈条件共用同一个 validateStepFeedback（同一上限与校验），
 *    两条路给出的意见口径一致，不会一条接受另一条拒绝；
 *  - 提示词完全复用执行期路径（模板渲染 + 步骤输入 + 输出契约 + 附件构造），反馈只作为附录注入：
 *    不改模板、不改场景、不改已发布快照。 */

/** 仅取执行期调用 Hermes 需要的字段，便于测试注入。 */
export interface StepAgentFeedbackExecution {
  step: RunStep;
  inputValues: Record<string, JsonValue>;
  stepValues: Map<string, Record<string, JsonValue>>;
  types: Map<string, string>;
  settings: SavedSettings;
  feedback?: import("../domain/feedbackContracts.js").HermesFeedbackContext;
  itemIndex?: number;
  signal?: AbortSignal;
}

export interface StepAgentFeedbackResult {
  /** 模型原文（不裁剪）；解析失败时也可能有值，用于诊断。 */
  raw: string;
  /** 通过该步骤输出契约校验后的结果；解析失败时抛出而不是返回半成品。 */
  outputs: Record<string, JsonValue>;
}

export interface StepAgentFeedbackRunner {
  runStepFeedback(options: StepAgentFeedbackExecution): Promise<StepAgentFeedbackResult>;
}

/** 诊断原文上限：只在失败响应里回一段，完整回复不进任何持久化记录。 */
export const MAX_DIAGNOSTIC_RAW = 4_000;

export class StepFeedbackService {
  constructor(
    private readonly options: {
      loadSettings(): Promise<SavedSettings>;
      getRun(projectDirectory: string, runId: string): Promise<RunRecord | undefined>;
      runner?: StepAgentFeedbackRunner;
    },
  ) {}

  /** 默认执行路径与 index.ts 注册的 core.hermes 执行器一致，只多一步：把模型原文一起带回来。 */
  private runner(): StepAgentFeedbackRunner {
    return this.options.runner ?? {
      runStepFeedback: async execution => {
        if (execution.step.kind !== "hermes") throw new Error("只能对 Hermes 步骤提交反馈");
        const { runHermesStep } = await import("../execution/hermesStep.js");
        return runHermesStep(execution.step, execution.inputValues, execution.stepValues, execution.types, execution.settings, execution.signal, execution.feedback, undefined, undefined, { captureRawReply: true });
      },
    };
  }

  async requestStepAgentFeedback(identity: Identity, input: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    void identity; // 管理员权限由路由中间件负责；这里不接受调用方自报身份。
    const request = createStepAgentFeedbackRequest(input);
    const settings = await this.options.loadSettings();
    const project = settings.projectDirectory;
    if (!project) throw new HttpError(400, "请先在集成连接中配置项目目录", "PROJECT_NOT_CONFIGURED");
    const run = await this.options.getRun(project, request.runId);
    if (!run) throw new HttpError(404, "没有找到此运行", "RUN_NOT_FOUND");
    const step = run.workflow.steps.find(candidate => candidate.id === request.stepId);
    if (!step) throw new HttpError(404, "没有找到此步骤", "STEP_FEEDBACK_STEP_NOT_FOUND", { runId: run.runId, stepId: request.stepId });
    if (step.kind !== "hermes") throw new HttpError(400, "只能对 Hermes 步骤的已完成结果提交反馈", "STEP_FEEDBACK_STEP_KIND", { stepId: step.id, kind: step.kind });
    if (request.itemIndex !== undefined && step.execution?.mode !== "for_each") throw new HttpError(400, "此步骤不是逐项步骤，不能按项反馈", "INVALID_STEP_FEEDBACK_REQUEST", { stepId: step.id });

    // 与重做链路共用同一份可反馈条件校验：只接受 Hermes 步骤/逐项已完成且有输出的结果。
    // 这里刻意不做「更严格」的额外判定——两条路必须对同一条反馈给出一致的接受/拒绝口径。
    const feedback: StepFeedbackRecord = captureStepFeedback(
      run,
      validateStepFeedback(run, { stepId: step.id, ...(request.itemIndex === undefined ? {} : { itemIndex: request.itemIndex }), message: request.message }),
      new Date().toISOString(),
    );

    let stepInputValues: Record<string, JsonValue>;
    let context: ReturnType<typeof rebuildStepExecutionContext>;
    try {
      context = rebuildStepExecutionContext(run, step.id, request.itemIndex);
      stepInputValues = resolveStepExecutionContextInputs(step, context);
    } catch (error) {
      // 上游结果缺失、引用路径不存在、逐项来源不匹配：在付费之前明确失败，不静默发空输入。
      throw new HttpError(409, "无法重建此步骤的执行期输入，请检查上游步骤结果：" + (error instanceof Error ? error.message : String(error)), "STEP_FEEDBACK_CONTEXT_UNAVAILABLE", { runId: run.runId, stepId: step.id });
    }

    const userMessage = stepAgentFeedbackMessage(feedback.message, request.context);
    const notes = feedbackForStep([feedback], step.id, request.itemIndex, context.itemIndex === undefined ? undefined : context.iterationItems?.[context.itemIndex])?.notes ?? [];
    const started = Date.now();
    let result: StepAgentFeedbackResult;
    try {
      result = await this.runner().runStepFeedback({
        step, settings, inputValues: stepInputValues, stepValues: context.values, types: context.types,
        ...(signal ? { signal } : {}),
        ...(context.itemIndex === undefined ? {} : { itemIndex: context.itemIndex }),
        feedback: { notes: notes.map(note => ({ ...note, message: userMessage })), originalOutputs: feedback.originalOutputs },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new HttpError(504, "Agent 反馈请求超时；没有写入任何运行状态，核实后自行决定是否重发（会再次计费）", "STEP_FEEDBACK_TIMEOUT", { runId: run.runId, stepId: step.id });
      const message = error instanceof Error ? error.message : String(error);
      const raw = (error as { raw?: unknown })?.raw;
      throw new HttpError(502, "Agent 反馈请求失败：" + message, "STEP_FEEDBACK_AGENT_FAILED", {
        runId: run.runId, stepId: step.id,
        ...(typeof raw === "string" ? { rawReply: raw.slice(0, MAX_DIAGNOSTIC_RAW), rawReplyTruncated: raw.length > MAX_DIAGNOSTIC_RAW } : {}),
      });
    }

    return {
      runId: run.runId,
      stepId: step.id,
      ...(request.itemIndex === undefined ? {} : { itemIndex: request.itemIndex }),
      revision: contentRevision({ stepId: step.id, itemIndex: request.itemIndex ?? null, at: feedback.createdAt, feedbackId: feedback.id }),
      agentReply: result.raw,
      replyParsed: true,
      outputs: projectRevisedOutputs(result.outputs, step.outputs ?? []),
      // 原结果同样按媒体端口投影：它是运行快照里的外部化值，可能含归档路径，不能原样回给调用方。
      originalOutputs: projectRevisedOutputs(externalizeRuntimeValue(feedback.originalOutputs) as Record<string, JsonValue>, step.outputs ?? []),
      context: { stepId: step.id, ...(request.itemIndex === undefined ? {} : { itemIndex: request.itemIndex }), feedback: userMessage, at: feedback.createdAt },
      durationMs: Date.now() - started,
      agentPromptOmitted: true,
      nextAction: "要采纳修订请显式走反馈重做链路：review_run redo 带 feedback，或 preview_rerun/rerun 的 changes.feedback；只想换措辞再问一次，按同一坐标重新提交 request_step_agent_feedback。本次没有写入任何运行状态。",
    };
  }
}

/** 请求/响应契约由 domain/stepAgentFeedback 提供；这里只做执行期编排，不重复定义字段。 */
export type { StepAgentFeedbackRequest };
