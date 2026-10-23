import * as z from "zod/v4";
import { id, runId, runStatuses } from "../ai/schemas.js";
import { accessPage } from "../ai/accessSchemas.js";

/** 任务质检通道（仅管理员）的机器契约。
 *
 *  为什么需要它：管理员可以用 get_run 读到完整运行记录，但那是一份「执行快照」，不是
 *  「质检材料」——它同时包含全部步骤、输入、绑定与媒体坐标，且提示词/回复/预算没有边界，
 *  第三方质检员（人或另一个AI）难以稳定地据此给出可比对的结论。本通道提供三件事：
 *    1) 只读的质检材料包（get_run_audit）：把一次运行压缩成有界、带省略标记的证据索引；
 *    2) 结构化质检意见（submit/get/list/update_run_critique）：结论可持久化、可revision保护地收敛；
 *    3) 直连 Hermes 的第三方质检（audit_run_with_hermes）：用固定提示词与固定输出契约调用
 *       管理员已启用的 Hermes Profile，把模型回复严格解析成一条质检意见。
 *
 *  边界（与既有能力一致，不新建旁路）：
 *    - 全部操作仅管理员；普通用户入口的 publicRequestAllowed 白名单不含这些路径；
 *    - 质检意见保存在服务端 SQLite 的 run-critiques 集合，revision 冲突保护，不写第二份业务库；
 *    - 只读材料包不内联最终输出值（用 get_run_outputs 分页读），不返回本机路径，不执行生成；
 *    - audit_run_with_hermes 是唯一可能计费的执行操作：一次请求不自动重试，响应丢失用同一
 *      critiqueId 读取质检记录对账，不换 ID 重投。 */

/** Machine contract for the run quality channel; mirrored into the AI OpenAPI as x-run-quality. */
export const RUN_QUALITY_CONTRACT = {
  version: "1",
  scope: "管理员对一次运行做第三方质检：有界证据包 + 结构化质检意见 + 直连 Hermes 评审",
  access: {
    role: "admin",
    userEntry: "不出现在用户专用入口白名单；普通用户读取自己的运行仍用 get_own_run/get_own_step_result",
    note: "质检意见是管理员侧的运维产物，不是用户反馈；用户问题仍走 submit_system_feedback",
  },
  routes: {
    audit: { method: "GET", path: "/api/v1/runs/{runId}/audit" },
    createCritique: { method: "POST", path: "/api/v1/runs/{runId}/critiques" },
    listCritiques: { method: "GET", path: "/api/v1/runs/{runId}/critiques" },
    getCritique: { method: "GET", path: "/api/v1/quality/critiques/{critiqueId}" },
    updateCritique: { method: "PATCH", path: "/api/v1/quality/critiques/{critiqueId}" },
    hermesAudit: { method: "POST", path: "/api/v1/runs/{runId}/audit/hermes" },
  },
  auditPacket: {
    bound: "每条提示词/回复按 promptLimit 截断（默认2000、最大8000码点），整包内联提示词字节有硬预算；超出部分显式标记 promptOmitted 并给出 promptPage 续读坐标",
    itemSample: "for_each 步骤只内联前 itemSample 项（默认2、最大10）的提示词与回复；其余项用 get_step_result 的 itemIndex 分页读取",
    values: "输入值经 scrubBusinessValue 去本机路径后内联，受字节预算约束；步骤输出与最终输出只给元数据，值用 get_step_result/get_run_outputs 读",
    noPaths: "不返回本机路径、运行归档目录、绑定配置或能力内部实现，只返回可解释业务结果所需字段",
  },
  critique: {
    verdicts: ["pass", "warn", "fail"],
    severities: ["info", "minor", "major", "critical"],
    statuses: ["open", "accepted", "dismissed", "fixed"],
    sources: ["manual", "agent", "hermes"],
    lifecycle: {
      open: ["accepted", "dismissed"],
      accepted: ["fixed", "dismissed"],
      dismissed: ["open"],
      fixed: ["open"],
    },
    idempotency: "critiqueId 由客户端预生成；重复 ID 返回 409 RUN_CRITIQUE_ALREADY_EXISTS，不是幂等成功",
    revision: "更新状态必须带当前 revision；409 RUN_CRITIQUE_REVISION_CONFLICT 后重读，不盲重试",
    writeScope: "submit_run_critique 只接受 source=manual|agent；source=hermes 只能由 audit_run_with_hermes 写入",
  },
  hermesAudit: {
    paid: "会真实调用管理员已启用的 Hermes Profile 一次（可能计费），不自动重试",
    output: "固定输出契约 verdict/score/summary/findings/recommendations；JSON 不可严格解析或字段不符时保持失败且不写入质检记录",
    recovery: "响应丢失用同一 critiqueId 调 get_run_critique 对账；记录不存在时由操作者显式决定是否重跑（会再次计费）",
  },
  errors: [
    "ADMIN_REQUIRED", "INVALID_RUN_QUALITY_REQUEST", "RUN_NOT_FOUND", "RUN_PREPARING",
    "RUN_CRITIQUE_NOT_FOUND", "RUN_CRITIQUE_ALREADY_EXISTS", "RUN_CRITIQUE_REVISION_CONFLICT", "RUN_CRITIQUE_STATE_CONFLICT",
    "RUN_AUDIT_STEP_NOT_FOUND", "RUN_AUDIT_PROFILE_UNAVAILABLE", "RUN_AUDIT_PROFILE_NOT_FOUND",
    "RUN_AUDIT_TIMEOUT", "RUN_AUDIT_INVALID_OUTPUT", "RUN_AUDIT_HERMES_FAILED",
  ],
} as const;

export const runCritiqueVerdict = z.enum(["pass", "warn", "fail"]);
export const runCritiqueSeverity = z.enum(["info", "minor", "major", "critical"]);
export const runCritiqueStatus = z.enum(["open", "accepted", "dismissed", "fixed"]);
export const runCritiqueSource = z.enum(["manual", "agent", "hermes"]);
export const runAuditStepStatus = z.enum(["pending", "running", "completed", "completed_with_errors", "skipped", "failed", "cancelled"]);

export const runCritiqueFinding = z.object({
  id: id.describe("本条意见在质检记录内的稳定ID（例如 f1）；省略时服务端按数组顺序分配 f1..fN，读取时按它引用而不是按数组下标"),
  severity: runCritiqueSeverity,
  category: z.string().trim().min(1).max(60).describe("可选分类（例如 提示词、输出契约、素材、耗时、成本、稳定性）").optional(),
  message: z.string().trim().min(1).max(2000).describe("问题本身：说清哪一步、期望与实际差在哪"),
  evidence: z.string().trim().max(2000).describe("可选证据：引用提示词/回复/输出的具体片段或坐标，不要粘贴大段原文").optional(),
  stepId: id.optional(),
  itemIndex: z.int().nonnegative().optional(),
}).strict();

/** 提交时的逐条问题：id 可省略（服务端按顺序补 f1..fN），其余与记录一致。 */
export const runCritiqueFindingInput = runCritiqueFinding.extend({ id: id.optional() });

export const runCritiqueModel = z.object({
  profile: z.string().min(1).max(200).optional(),
  provider: z.string().min(1).max(80).optional(),
  model: z.string().min(1).max(200).optional(),
}).strict();

/** 手工/外部AI提交的质检意见；source=hermes 由 audit_run_with_hermes 独占写入。 */
export const createRunCritique = z.object({
  runId,
  critiqueId: z.uuid().describe("客户端事先生成并保存的 UUID；响应丢失时用同一 ID 读取质检记录对账，不换 ID 重投"),
  verdict: runCritiqueVerdict,
  score: z.int().min(0).max(100).describe("可选 0–100 质量分；不同评分者口径不同，只作趋势参考，不参与自动决策").optional(),
  summary: z.string().trim().min(1).max(4000).describe("一段话结论：这次运行整体算不算达标、主要问题是什么"),
  findings: z.array(runCritiqueFindingInput).max(50).default([]).describe("问题清单；每条给出严重级别，失败级问题必须可定位到步骤或证据"),
  recommendations: z.array(z.string().trim().min(1).max(1000)).max(20).default([]).describe("可执行建议；要能被下一步直接照做（例如用 rerun 的 stepOverrides 改哪个字段）"),
  reviewer: z.string().trim().min(1).max(120).describe("质检者标识：人工写用户名，外部AI写模型或工具名；不写入任何凭证"),
  source: z.enum(["manual", "agent"]).default("manual").describe("manual=人工质检；agent=外部AI通过MCP质检；hermes 只由直连评审操作写入"),
  stepId: id.optional(),
  itemIndex: z.int().nonnegative().optional(),
  model: runCritiqueModel.optional(),
}).strict();

export const runCritiqueSchema = z.object({
  id: z.uuid(),
  revision: z.int().positive(),
  runId,
  stepId: id.optional(),
  itemIndex: z.int().nonnegative().optional(),
  verdict: runCritiqueVerdict,
  score: z.int().min(0).max(100).optional(),
  summary: z.string().max(4000),
  findings: z.array(runCritiqueFinding).max(50),
  recommendations: z.array(z.string().max(1000)).max(20),
  reviewer: z.string().max(120),
  source: runCritiqueSource,
  model: runCritiqueModel.optional(),
  status: runCritiqueStatus,
  statusNote: z.string().max(1000).optional(),
  handledBy: z.string().optional().describe("最近一次写入该记录的管理员用户ID：创建时是质检提交人，状态变更时是处理人"),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type RunCritique = z.infer<typeof runCritiqueSchema>;

export const runCritiqueEnvelope = z.object({
  critique: runCritiqueSchema,
  nextAction: z.enum(["get_run_critique", "update_run_critique", "preview_rerun", "get_run_audit"]),
}).strict();

/** 列表只给索引：正文/建议/逐条问题用 get_run_critique 读，避免一次列出几十条全文。 */
export const runCritiqueSummarySchema = runCritiqueSchema
  .omit({ summary: true, findings: true, recommendations: true })
  .extend({ summaryOmitted: z.literal(true), findingsOmitted: z.literal(true), recommendationsOmitted: z.literal(true) });

export const runCritiquePage = z.object({
  revision: z.string(),
  total: z.int().nonnegative(),
  items: z.array(runCritiqueSummarySchema),
  hasMore: z.boolean(),
  nextCursor: z.string().optional(),
  nextAction: z.literal("get_run_critique"),
}).strict();

export const runCritiqueQuery = accessPage.extend({
  runId,
  verdict: runCritiqueVerdict.optional(),
  status: runCritiqueStatus.optional(),
}).strict();

export const runCritiqueKey = z.object({ critiqueId: z.uuid() }).strict();

export const updateRunCritique = runCritiqueKey.extend({
  revision: z.int().positive(),
  status: runCritiqueStatus,
  note: z.string().trim().max(1000).describe("可选处理说明：为什么接受/驳回/判定已修复，便于后续复盘").optional(),
}).strict();

const auditValuePage = z.object({
  kind: z.enum(["scalar", "string", "array", "object"]),
  total: z.int().nonnegative(),
  offset: z.int().nonnegative(),
  count: z.int().nonnegative(),
  pageSize: z.int().nonnegative(),
  complete: z.boolean(),
  hasMore: z.boolean(),
  nextValueOffset: z.int().nonnegative().optional(),
}).strict();

/** 一次 Hermes/LLM 调用的质检视角：实际发出的提示词 + 解析失败时才有的原始回复。 */
export const runAuditAgentSchema = z.object({
  promptAvailable: z.boolean().describe("已执行步骤会记录实际发送的提示词；旧记录或非模型步骤为 false"),
  promptBytes: z.int().nonnegative(),
  prompt: z.string().optional(),
  promptOmitted: z.literal(true).optional(),
  promptOmissionReason: z.enum(["not_recorded", "byte_budget"]).optional(),
  promptPage: auditValuePage,
  responseAvailable: z.boolean().describe("原始未裁剪回复只在 JSON 解析或输出校验失败时保存；false 表示没有失败快照，不代表模型没回复"),
  responseBytes: z.int().nonnegative(),
  response: z.string().optional(),
  responseOmitted: z.literal(true).optional(),
  responsePage: auditValuePage.optional(),
  nextAction: z.string().describe("继续读取的下一步，例如 get_step_result 或 get_run"),
}).strict();

const runAuditItemSchema = z.object({
  index: z.int().nonnegative(),
  status: z.enum(["running", "completed", "skipped", "failed", "cancelled"]),
  durationMs: z.int().nonnegative().optional(),
  outputKeys: z.array(z.string()),
  error: z.literal(true).optional().describe("逐项失败；错误正文按既有契约不在这里回传完整内部信息"),
  agent: runAuditAgentSchema.optional(),
}).strict();

const runAuditOutputSchema = z.object({
  key: id,
  type: z.string(),
  label: z.string().optional(),
  present: z.boolean(),
  valueBytes: z.int().nonnegative(),
  mediaCount: z.int().nonnegative().optional(),
}).strict();

const runAuditSideCounts = z.object({
  total: z.int().nonnegative(), completed: z.int().nonnegative(), partial: z.int().nonnegative(),
  skipped: z.int().nonnegative(), failed: z.int().nonnegative(), cancelled: z.int().nonnegative(),
  running: z.int().nonnegative(), pending: z.int().nonnegative(),
}).strict();

export const runAuditStepSchema = z.object({
  stepId: id,
  order: z.int().nonnegative(),
  name: z.string(),
  kind: z.string(),
  capabilityId: id.optional(),
  capabilityVersion: id.optional(),
  status: runAuditStepStatus,
  startedAt: z.string().optional(),
  durationMs: z.int().nonnegative().optional(),
  message: z.string().optional(),
  warningCount: z.int().nonnegative(),
  warnings: z.array(z.string()).optional(),
  warningsOmitted: z.literal(true).optional().describe("该步骤警告数超过内联上限；完整列表用 get_step_result"),
  reviewStatus: z.enum(["pending", "approved"]).optional(),
  reused: z.boolean(),
  replaced: z.boolean(),
  reusedFromRunId: runId.optional(),
  model: runCritiqueModel.optional().describe("该步骤在运行快照里声明的 Hermes/LLM 目标；直连模式以步骤结果为准"),
  itemProgress: runAuditSideCounts.optional(),
  itemSample: z.array(runAuditItemSchema).optional(),
  itemSampleOmitted: z.int().nonnegative().optional().describe("未内联的逐项数量；用 get_step_result 的 itemIndex 继续读取"),
  agent: runAuditAgentSchema.optional(),
  outputs: z.array(runAuditOutputSchema),
}).strict();

const runAuditInputSchema = z.object({
  key: id,
  label: z.string().optional(),
  type: z.string(),
  required: z.boolean(),
  present: z.boolean(),
  valueBytes: z.int().nonnegative(),
  value: z.json().optional(),
  valueOmitted: z.literal(true).optional(),
  omissionReason: z.enum(["byte_budget"]).optional(),
}).strict();

export const runAuditQuery = z.object({
  runId,
  stepId: id.optional().describe("只看一个步骤；省略时返回全部步骤的质检材料"),
  promptLimit: z.coerce.number().int().min(200).max(8000).default(2000).describe("每条提示词/回复内联的最大 Unicode 码点数；默认2000、最大8000，超出按 promptPage 续读"),
  itemSample: z.coerce.number().int().min(0).max(10).default(2).describe("for_each 步骤内联的逐项数；默认2、最大10，其余用 get_step_result 的 itemIndex 读取"),
}).strict();
export type RunAuditQuery = z.infer<typeof runAuditQuery>;

export const runAuditSchema = z.object({
  runId,
  sceneId: z.string(),
  workflowName: z.string(),
  runTitle: z.string().optional(),
  status: runStatuses,
  projection: z.literal("audit"),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  queueDurationMs: z.int().nonnegative().optional(),
  totalDurationMs: z.int().nonnegative().optional(),
  ownerUserId: z.string().optional(),
  submitter: z.object({ userId: z.string(), username: z.string(), displayName: z.string() }).strict().optional(),
  version: z.object({ versionId: z.string(), version: z.string(), publishedAt: z.string() }).strict().optional(),
  lineage: z.object({ resumedFromRunId: runId.optional(), rerunFromRunId: runId.optional(), feedbackCount: z.int().nonnegative(), reviewDecisionCount: z.int().nonnegative() }).strict(),
  pendingReview: z.object({ id: z.string(), stepId: id, createdAt: z.string(), scope: z.string().optional(), afterItems: z.int().nonnegative().optional(), instruction: z.string().optional() }).strict().optional(),
  inputs: z.array(runAuditInputSchema),
  inputsOmitted: z.int().nonnegative().optional(),
  steps: z.array(runAuditStepSchema),
  outputs: z.array(runAuditOutputSchema.extend({ valueOmitted: z.literal(true).describe("最终输出值不在材料包里内联；用 get_run_outputs 分页读取") })),
  critiqueSummary: z.object({
    total: z.int().nonnegative(),
    open: z.int().nonnegative(),
    byVerdict: z.object({ pass: z.int().nonnegative(), warn: z.int().nonnegative(), fail: z.int().nonnegative() }).strict(),
    latest: runCritiqueSummarySchema.optional(),
  }).strict(),
  evidenceBudget: z.object({
    promptLimitPerCall: z.int().positive(),
    itemSamplePerStep: z.int().nonnegative(),
    promptBytesInlined: z.int().nonnegative(),
    promptBytesBudget: z.int().positive(),
  }).strict(),
  omissionNotes: z.array(z.string()).optional().describe("本次材料包明确省略了什么；省略不等于没有数据"),
  revision: z.string(),
  nextAction: z.enum(["submit_run_critique", "get_run_critique", "inspect_hermes_response", "inspect_outputs"]),
}).strict();
export type RunAudit = z.infer<typeof runAuditSchema>;

/** 直连 Hermes 的第三方质检：用固定提示词与固定输出契约评审一次运行。 */
export const runHermesAudit = z.object({
  runId,
  critiqueId: z.uuid().describe("客户端事先生成并保存的 UUID；质检记录用它做ID，响应丢失时读取同一ID对账，不换ID重投"),
  profile: z.string().min(1).max(200).describe("本机已启用的 Hermes Profile；省略时取工作台已启用列表的第一个，列表为空则拒绝").optional(),
  provider: z.string().max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/).optional(),
  model: z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/).optional(),
  focus: z.string().trim().max(2000).describe("可选：本次质检重点关注什么（例如 提示词与产物是否一致）。它只作为评审要求附加在固定提示词后面，不能改写输出契约").optional(),
  stepId: id.optional().describe("只质检一个步骤；省略时质检整次运行"),
}).strict();

export const runHermesAuditResult = z.object({
  critique: runCritiqueSchema,
  target: z.object({ profile: z.string(), provider: z.string().optional(), model: z.string().optional() }).strict(),
  acceptedFields: z.array(z.string()).describe("模型实际返回且被采纳的顶层字段"),
  repaired: z.boolean().describe("true 表示回复经过一次确定性修复（多余根括号或字符串内原始换行），原始内容未改动"),
  promptBytes: z.int().nonnegative(),
  durationMs: z.int().nonnegative(),
  nextAction: z.literal("get_run_critique"),
}).strict();
