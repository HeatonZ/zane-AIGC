import { randomUUID } from "node:crypto";
import { requestHermesRun } from "../hermesTransport.js";
import { hermesApiEndpoint, readHermesApiConnection } from "../services/hermesProfiles.js";
import { hermesRequestModelFields } from "../domain/hermesModelSelection.js";
import { workflowTimeoutMs } from "../config.js";
import { parseHermesOutput } from "./hermesOutput.js";
import { throwIfAborted } from "./cancellation.js";

/** 直连 Hermes 的第三方质检：与 core.hermes/core.llm 共用同一条网关链路和同一套严格 JSON 解析，
 *  但不属于任何工作流——它不写运行记录、不改场景、不生成媒体，只把一次运行的证据包交给
 *  管理员已启用的 Hermes Profile 评审，并把回复解析成质检意见的字段。
 *
 *  为什么单独一个模块而不是复用 runHermesStep：runHermesStep 需要 RunStep、步骤输入解析、
 *  媒体附件和运行上下文；质检调用没有这些，也不应该被伪装成一次「执行」。两者共享的只有
 *  传输（requestHermesRun）、端点解析（hermesApiEndpoint/readHermesApiConnection）、
 *  请求体模型字段（hermesRequestModelFields）与输出解析（parseHermesOutput）。 */

/** 质检调用的固定输出契约；顺序即提示词中的字段顺序。 */
export const HERMES_AUDIT_OUTPUT_KEYS = ["verdict", "score", "summary", "findings", "recommendations"] as const;

/** 质检提示词的硬上限：证据包由服务端按字节预算裁到远小于此值；超出说明上游拼装出错，
 *  必须在发出付费请求之前失败。 */
export const HERMES_AUDIT_PROMPT_LIMIT_BYTES = 200_000;

const SYSTEM_PROMPT = [
  "你是独立第三方质检员（QA），只评审下面给出的运行证据。",
  "你不重写产物、不补写内容、不调用任何工具、不执行生成，也不猜测证据里没有的信息。",
  "评审要点：提示词是否把要求说清楚；模型回复是否符合该步骤声明的输出契约；产物与输入要求是否一致；",
  "失败与警告是否被正确处理；耗时、并发与重试是否合理；同一问题是否在多个步骤重复出现。",
  "每条结论都必须能定位到具体步骤（有 stepId 就写 stepId），不要给出无法验证的印象式评价。",
  "你没有修改任何运行、场景或素材的权限，也不要把建议写成已经执行的动作。",
].join("\n");

const OUTPUT_CONTRACT = [
  "必须只输出一个 JSON 对象，不要使用 Markdown 代码围栏，不要附加任何解释。",
  "回复的第一个字符必须是 {，最后一个字符必须是 }，除该对象外不得出现其他内容。",
  "字段名必须完全一致，且不得输出未声明的字段：",
  "1. verdict（枚举：pass、warn、fail）：pass=可交付；warn=可用但有明确问题；fail=结果不可用或与要求不符。",
  "2. score（0–100 的整数）：整体质量分，只作趋势参考。",
  "3. summary（字符串，4000 字以内）：一段话结论，说明这次运行整体算不算达标、主要问题是什么。",
  "4. findings（数组，最多 50 条）：每条恰好包含 severity（info、minor、major、critical）、message（问题本身）、可选 category、可选 evidence、可选 stepId、可选 itemIndex。",
  "5. recommendations（字符串数组，最多 20 条）：可执行建议，要能被下一步直接照做（例如用 rerun 的 stepOverrides 改哪个字段、改成什么）。",
  "字符串内的换行、回车、制表符、双引号和反斜杠必须按 JSON 语法转义。数组元素与对象成员之间必须有逗号。",
].join("\n");

/** 回复无法严格解析成质检契约时抛出；`raw` 保留未裁剪原文供管理员诊断，
 *  但绝不因此写入一条内容不可信的质检记录。 */
export class HermesAuditOutputError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "HermesAuditOutputError";
  }
}

export interface HermesAuditTarget {
  profile: string;
  provider?: string;
  model?: string;
}

export interface HermesAuditResult {
  /** 已按严格契约解析并校验过顶层字段的对象；字段映射仍是调用方的责任。 */
  value: Record<string, unknown>;
  /** true 表示回复经过一次确定性修复（多余根括号或字符串内原始控制字符），内容本身未被改写。 */
  repaired: boolean;
  /** 未裁剪的原始回复，只用于失败时的诊断与审计，不写入质检记录正文。 */
  raw: string;
  promptBytes: number;
}

export function buildHermesAuditPrompt(packet: unknown, options: { focus?: string; stepId?: string } = {}) {
  const scope = options.stepId ? `只质检步骤 ${options.stepId}` : "质检整次运行的全部步骤";
  const focus = options.focus?.trim();
  const user = [
    `本次质检范围：${scope}。`,
    ...(focus ? [`本次重点关注：${focus}`] : []),
    "运行证据（JSON；已按字节预算截断并带省略标记，省略不代表没有数据，需要更多内容时按证据里的 nextAction 继续读取）：",
    JSON.stringify(packet),
    "",
    OUTPUT_CONTRACT,
  ].join("\n");
  return { system: SYSTEM_PROMPT, user };
}

/** 一次质检调用 = 一次网关请求，不自动重试；超时/取消都会中断并保留可读错误。 */
export async function requestHermesAudit(options: {
  target: HermesAuditTarget;
  packet: unknown;
  focus?: string;
  stepId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<HermesAuditResult> {
  throwIfAborted(options.signal);
  const { system, user } = buildHermesAuditPrompt(options.packet, { focus: options.focus, stepId: options.stepId });
  const promptBytes = Buffer.byteLength(JSON.stringify([system, user]), "utf8");
  if (promptBytes > HERMES_AUDIT_PROMPT_LIMIT_BYTES) throw new Error(`质检证据包过大（${promptBytes} 字节），已超过单次质检上限；请缩小 promptLimit/itemSample 或改用 stepId 分步质检`);
  const connection = await readHermesApiConnection(options.target.profile);
  const raw = await requestHermesRun({
    startUrl: hermesApiEndpoint(connection.baseUrl, options.target.profile, "runs"),
    statusUrl: (runId) => hermesApiEndpoint(connection.baseUrl, options.target.profile, `runs/${encodeURIComponent(runId)}`),
    stopUrl: (runId) => hermesApiEndpoint(connection.baseUrl, options.target.profile, `runs/${encodeURIComponent(runId)}/stop`),
    headers: { Authorization: `Bearer ${connection.apiKey}`, "Content-Type": "application/json" },
    body: { ...hermesRequestModelFields(options.target.provider, options.target.model), input: [{ role: "system", content: system }, { role: "user", content: user }] },
    idempotencyKey: randomUUID(),
    timeoutMs: options.timeoutMs ?? workflowTimeoutMs(1),
    signal: options.signal,
  });
  let parsed: { value: Record<string, unknown>; repair?: unknown };
  try {
    parsed = parseHermesOutput(raw, HERMES_AUDIT_OUTPUT_KEYS, "Hermes 质检");
  } catch (error) {
    throw new HermesAuditOutputError(error instanceof Error ? error.message : String(error), raw);
  }
  return { value: parsed.value, repaired: Boolean(parsed.repair), raw, promptBytes };
}
