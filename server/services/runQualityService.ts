import * as z from "zod/v4";
import { AccessService, accessPagination, type Identity } from "./accessService.js";
import { HttpError } from "../errors.js";
import { contentRevision } from "../domain/sceneContent.js";
import { isMediaWorkflowType } from "../domain/workflowValues.js";
import type { RunRecord, RunStep, RunStepItemRecord, RunStepRecord, RunSubmitter, SavedSettings } from "../domain/types.js";
import { workflowTimeoutMs } from "../config.js";
import { scrubBusinessValue } from "./runDetailService.js";
import { listHermesProfiles } from "./hermesProfiles.js";
import {
  createRunCritique, runAuditQuery, runCritiqueKey, runCritiqueModel, runCritiqueQuery, runCritiqueSeverity,
  runCritiqueVerdict, runHermesAudit, updateRunCritique,
  type RunAudit, type RunAuditQuery, type RunCritique,
} from "../domain/runQualityContracts.js";
import { HermesAuditOutputError, requestHermesAudit, type HermesAuditResult, type HermesAuditTarget } from "../execution/hermesAudit.js";

const COLLECTION = "run-critiques";
/** 输入值内联总预算；超出部分显式标记并按 get_run 读取原始快照。 */
const INPUT_BYTES_BUDGET = 16 * 1024;
/** get_run_audit 的内联提示词总预算（每条另受 promptLimit 限制）。 */
const AUDIT_PROMPT_BYTES_BUDGET = 48 * 1024;
/** 交给 Hermes 评审的证据包更小：它是付费请求的提示词，不是给人看的完整材料。 */
const HERMES_AUDIT_PROMPT_BYTES_BUDGET = 24 * 1024;
const WARNING_INLINE_LIMIT = 5;
const WARNING_TEXT_LIMIT = 300;
const MESSAGE_TEXT_LIMIT = 500;
const DIAGNOSTIC_RAW_LIMIT = 4000;

export type HermesAuditRunner = (options: { target: HermesAuditTarget; packet: unknown; focus?: string; stepId?: string; timeoutMs: number; signal?: AbortSignal }) => Promise<HermesAuditResult>;

interface AuditBudget { promptBytes: number; promptLimit: number; promptBytesBudget: number }

function parse<S extends z.ZodType>(schema: S, input: unknown, code: string): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, "质检参数无效：" + result.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; "), code);
  return result.data;
}

const countStatuses = (items: Array<{ status: string }>) => ({
  total: items.length,
  completed: items.filter(item => item.status === "completed").length,
  partial: items.filter(item => item.status === "completed_with_errors").length,
  skipped: items.filter(item => item.status === "skipped").length,
  failed: items.filter(item => item.status === "failed").length,
  cancelled: items.filter(item => item.status === "cancelled").length,
  running: items.filter(item => item.status === "running").length,
  pending: items.filter(item => item.status === "pending").length,
});

/** 媒体输入只回固定版本引用，绝不回本机路径或任意 URL（与运行输入投影同一口径）。 */
function mediaInputValue(value: unknown): unknown {
  const reference = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!reference || typeof reference.assetId !== "string" || !Number.isSafeInteger(reference.assetVersion)) return { locatorOmitted: true };
  return { assetId: reference.assetId, assetVersion: reference.assetVersion, ...(typeof reference.assetName === "string" ? { assetName: scrubBusinessValue(reference.assetName) } : {}) };
}

/** 按 Unicode 码点截断文本并记账；预算耗尽时返回显式省略标记而不是静默丢弃。 */
function boundedText(text: string, budget: AuditBudget) {
  const characters = Array.from(text);
  const total = characters.length;
  const bytes = Buffer.byteLength(text, "utf8");
  const slice = characters.slice(0, budget.promptLimit).join("");
  const remaining = budget.promptBytesBudget - budget.promptBytes;
  const sliceBytes = Buffer.byteLength(slice, "utf8");
  const pageSize = budget.promptLimit;
  if (sliceBytes > remaining) {
    return { bytes, omitted: true as const, inline: undefined, page: { kind: "string" as const, total, offset: 0, count: 0, pageSize, complete: false, hasMore: true, nextValueOffset: 0 } };
  }
  budget.promptBytes += sliceBytes;
  const count = Math.min(budget.promptLimit, total);
  const complete = total <= budget.promptLimit;
  return { bytes, omitted: false as const, inline: slice, page: { kind: "string" as const, total, offset: 0, count, pageSize, complete, hasMore: !complete, ...(!complete ? { nextValueOffset: count } : {}) } };
}

function emptyTextPage(pageSize: number) {
  return { kind: "string" as const, total: 0, offset: 0, count: 0, pageSize, complete: true, hasMore: false };
}

function agentEvidence(record: { agentPrompt?: string; agentResponse?: string }, budget: AuditBudget) {
  const prompt = typeof record.agentPrompt === "string" ? record.agentPrompt : undefined;
  const response = typeof record.agentResponse === "string" ? record.agentResponse : undefined;
  if (prompt === undefined && response === undefined) return undefined;
  const promptPart = prompt === undefined ? undefined : boundedText(prompt, budget);
  const responsePart = response === undefined ? undefined : boundedText(response, budget);
  return {
    promptAvailable: prompt !== undefined,
    promptBytes: promptPart?.bytes ?? 0,
    ...(promptPart?.inline !== undefined ? { prompt: promptPart.inline } : {}),
    ...(promptPart?.omitted ? { promptOmitted: true as const, promptOmissionReason: "byte_budget" as const } : {}),
    promptPage: promptPart?.page ?? emptyTextPage(budget.promptLimit),
    responseAvailable: response !== undefined,
    responseBytes: responsePart?.bytes ?? 0,
    ...(responsePart?.inline !== undefined ? { response: responsePart.inline } : {}),
    ...(responsePart?.omitted ? { responseOmitted: true as const } : {}),
    ...(responsePart?.page ? { responsePage: responsePart.page } : {}),
    // 提示词的完整原文只在运行原始快照里；回复可用步骤结果分页续读。
    nextAction: promptPart?.omitted || promptPart?.page.hasMore ? "get_run" : "get_step_result",
  };
}

function outputMetadata(outputs: Record<string, unknown> | undefined, types: Record<string, string> | undefined, declared: RunStep["outputs"]) {
  const entries = new Map<string, { key: string; type: string; label?: string; present: boolean; valueBytes: number; mediaCount?: number }>();
  for (const field of declared ?? []) entries.set(field.key, { key: field.key, type: field.type, ...(field.label ? { label: String(scrubBusinessValue(field.label)) } : {}), present: false, valueBytes: 0 });
  for (const [key, value] of Object.entries(outputs ?? {})) {
    const current = entries.get(key);
    const type = types?.[key] ?? current?.type ?? "json";
    const mediaCount = isMediaWorkflowType(type) ? Array.isArray(value) ? value.length : value === undefined || value === null || value === "" ? 0 : 1 : undefined;
    entries.set(key, {
      key, type, ...(current?.label ? { label: current.label } : {}), present: true,
      valueBytes: Buffer.byteLength(JSON.stringify(value) ?? "null"),
      ...(mediaCount !== undefined ? { mediaCount } : {}),
    });
  }
  return [...entries.values()];
}

function auditStep(stepId: string, order: number, run: RunRecord, query: RunAuditQuery, budget: AuditBudget) {
  const record: RunStepRecord | undefined = run.steps.find(step => step.stepId === stepId);
  const definition: RunStep | undefined = run.workflow.steps.find(step => step.id === stepId);
  const items: RunStepItemRecord[] = record?.items ?? [];
  const warnings = (record?.warnings ?? []);
  const itemWarnings = items.reduce((count, item) => count + (item.warnings?.length ?? 0), 0);
  const warningCount = warnings.length + itemWarnings;
  const sampled = query.itemSample > 0 ? items.slice(0, query.itemSample) : [];
  const model = definition && (definition.hermesProfile || definition.hermesProvider || definition.hermesModel)
    ? runCritiqueModel.parse({ ...(definition.hermesProfile ? { profile: definition.hermesProfile } : {}), ...(definition.hermesProvider ? { provider: definition.hermesProvider } : {}), ...(definition.hermesModel ? { model: definition.hermesModel } : {}) })
    : undefined;
  const agent = record ? agentEvidence(record, budget) : undefined;
  return {
    stepId,
    order,
    name: String(scrubBusinessValue(record?.name ?? definition?.name ?? stepId)),
    kind: String(definition?.kind ?? "unknown"),
    ...(record?.capabilityId ?? definition?.capabilityId ? { capabilityId: String(record?.capabilityId ?? definition?.capabilityId) } : {}),
    ...(record?.capabilityVersion ?? definition?.capabilityVersion ? { capabilityVersion: String(record?.capabilityVersion ?? definition?.capabilityVersion) } : {}),
    status: record?.status ?? "pending" as const,
    ...(record?.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record?.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record?.message ? { message: String(scrubBusinessValue(record.message)).slice(0, MESSAGE_TEXT_LIMIT) } : {}),
    warningCount,
    ...(warnings.length ? { warnings: warnings.slice(0, WARNING_INLINE_LIMIT).map(warning => String(scrubBusinessValue(warning)).slice(0, WARNING_TEXT_LIMIT)) } : {}),
    ...(warningCount > Math.min(warnings.length, WARNING_INLINE_LIMIT) ? { warningsOmitted: true as const } : {}),
    ...(record?.review ? { reviewStatus: record.review.status } : {}),
    reused: Boolean(record?.reusedFromRunId),
    replaced: Boolean(record?.replaced),
    ...(record?.reusedFromRunId ? { reusedFromRunId: record.reusedFromRunId } : {}),
    ...(model ? { model } : {}),
    ...(items.length ? { itemProgress: countStatuses(items) } : {}),
    ...(sampled.length ? { itemSample: sampled.map(item => ({ index: item.index, status: item.status, ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}), outputKeys: Object.keys(item.outputs ?? {}), ...(item.error ? { error: true as const } : {}), ...(() => { const evidence = agentEvidence(item, budget); return evidence ? { agent: evidence } : {}; })() })) } : {}),
    ...(items.length > sampled.length ? { itemSampleOmitted: items.length - sampled.length } : {}),
    ...(agent ? { agent } : {}),
    outputs: outputMetadata(record?.outputs, record?.outputTypes, definition?.outputs),
  };
}

/** 一次运行的质检材料包：有界、可续读、带明确省略标记；不内联最终输出值，不返回本机路径。 */
export function buildRunAudit(run: RunRecord, query: RunAuditQuery, critiques: RunCritique[], options: { promptBytesBudget?: number; submitter?: RunSubmitter } = {}): RunAudit {
  const definitionIds = run.workflow.steps.map(step => step.id);
  const ids = [...new Set([...definitionIds, ...run.steps.map(step => step.stepId)])];
  const selected = query.stepId ? ids.filter(id => id === query.stepId) : ids;
  if (query.stepId && !selected.length) throw new HttpError(404, "没有找到此步骤", "RUN_AUDIT_STEP_NOT_FOUND", { runId: run.runId, stepId: query.stepId });
  const budget: AuditBudget = { promptBytes: 0, promptLimit: query.promptLimit, promptBytesBudget: options.promptBytesBudget ?? AUDIT_PROMPT_BYTES_BUDGET };

  let inputBudget = INPUT_BYTES_BUDGET;
  let inputsOmitted = 0;
  const fields = run.workflow.inputs;
  const inputs = fields.map(field => {
    const present = Object.hasOwn(run.inputValues, field.key);
    const raw = run.inputValues[field.key];
    const value = isMediaWorkflowType(field.type) ? mediaInputValue(raw) : scrubBusinessValue(raw);
    const valueBytes = present ? Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8") : 0;
    const omitted = present && valueBytes > inputBudget;
    if (omitted) inputsOmitted += 1; else inputBudget -= valueBytes;
    return {
      key: field.key,
      type: field.type,
      required: Boolean(field.required),
      present,
      valueBytes,
      ...(present && !omitted ? { value: value as RunAudit["inputs"][number]["value"] } : {}),
      ...(omitted ? { valueOmitted: true as const, omissionReason: "byte_budget" as const } : {}),
    };
  });

  const critiqueSummary = {
    total: critiques.length,
    open: critiques.filter(item => item.status === "open").length,
    byVerdict: {
      pass: critiques.filter(item => item.verdict === "pass").length,
      warn: critiques.filter(item => item.verdict === "warn").length,
      fail: critiques.filter(item => item.verdict === "fail").length,
    },
    ...(() => {
      const latest = critiques[0];
      if (!latest) return {};
      const { summary: _summary, findings: _findings, recommendations: _recommendations, ...rest } = latest;
      return { latest: { ...rest, summaryOmitted: true as const, findingsOmitted: true as const, recommendationsOmitted: true as const } };
    })(),
  };

  const steps = selected.map((stepId, order) => auditStep(stepId, order, run, query, budget));
  const hasResponse = steps.some(step => step.agent?.responseAvailable || step.itemSample?.some(item => item.agent?.responseAvailable));
  const body = {
    runId: run.runId,
    sceneId: run.sceneId,
    workflowName: String(scrubBusinessValue(run.workflowName)),
    ...(run.runTitle ? { runTitle: String(scrubBusinessValue(run.runTitle)) } : {}),
    status: run.status,
    projection: "audit" as const,
    createdAt: run.createdAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt, totalDurationMs: Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.createdAt)) } : {}),
    ...(run.startedAt ? { queueDurationMs: Math.max(0, Date.parse(run.startedAt) - Date.parse(run.createdAt)) } : {}),
    ...(run.ownerUserId ? { ownerUserId: run.ownerUserId } : {}),
    ...(run.submitter ?? options.submitter ? { submitter: run.submitter ?? options.submitter } : {}),
    ...(run.workflow.publishedScene ? { version: { versionId: run.workflow.publishedScene.versionId, version: run.workflow.publishedScene.version, publishedAt: run.workflow.publishedScene.publishedAt } } : {}),
    lineage: {
      ...(run.resumedFromRunId ? { resumedFromRunId: run.resumedFromRunId } : {}),
      ...(run.rerunFromRunId ? { rerunFromRunId: run.rerunFromRunId } : {}),
      feedbackCount: run.feedbackHistory?.length ?? 0,
      reviewDecisionCount: run.reviewHistory?.length ?? 0,
    },
    ...(run.pendingReview ? {
      pendingReview: {
        id: run.pendingReview.id, stepId: run.pendingReview.stepId, createdAt: run.pendingReview.createdAt,
        ...(run.pendingReview.scope ? { scope: String(run.pendingReview.scope) } : {}),
        ...(typeof run.pendingReview.afterItems === "number" ? { afterItems: run.pendingReview.afterItems } : {}),
        ...(run.pendingReview.instruction ? { instruction: String(scrubBusinessValue(run.pendingReview.instruction)).slice(0, MESSAGE_TEXT_LIMIT) } : {}),
      },
    } : {}),
    inputs,
    ...(inputsOmitted ? { inputsOmitted } : {}),
    steps,
    outputs: run.outputs.map(item => ({
      key: item.key, type: item.type, ...(item.label ? { label: String(scrubBusinessValue(item.label)) } : {}), present: true,
      valueBytes: Buffer.byteLength(JSON.stringify(item.value) ?? "null"),
      ...(isMediaWorkflowType(item.type) ? { mediaCount: Array.isArray(item.value) ? item.value.length : item.value === undefined || item.value === null || item.value === "" ? 0 : 1 } : {}),
      valueOmitted: true as const,
    })),
    critiqueSummary,
    evidenceBudget: {
      promptLimitPerCall: query.promptLimit,
      itemSamplePerStep: query.itemSample,
      promptBytesInlined: budget.promptBytes,
      promptBytesBudget: budget.promptBytesBudget,
    },
    omissionNotes: [
      "步骤与最终输出只给元数据，值用 get_step_result / get_run_outputs 分页读取。",
      "输入值受字节预算约束，valueOmitted 表示该字段未内联，原始快照用 get_run 读取。",
      ...(query.itemSample < (run.steps.reduce((count, step) => Math.max(count, step.items?.length ?? 0), 0)) ? ["for_each 只内联每个步骤的前若干项，其余用 get_step_result 的 itemIndex 读取。"] : []),
      "原始回复只在 Hermes 输出解析或校验失败时存在；responseAvailable=false 代表没有失败快照，不代表模型没有回复。",
    ],
    nextAction: critiques.length === 0 ? "submit_run_critique" as const : hasResponse ? "inspect_hermes_response" as const : run.outputs.length ? "inspect_outputs" as const : "get_run_critique" as const,
  };
  return { ...body, revision: contentRevision(body) };
}

/** 任务质检（仅管理员）：有界证据包 + 结构化质检意见 + 直连 Hermes 的第三方评审。
 *  UI/HTTP/MCP 复用本服务；质检意见保存在服务端 SQLite，不新建旁路业务库。 */
export class RunQualityService {
  constructor(
    readonly access: AccessService,
    readonly loadSettings: () => Promise<SavedSettings>,
    readonly getRun: (project: string, runId: string) => Promise<RunRecord | undefined>,
    private readonly isPreparing: (project: string, runId: string) => boolean = () => false,
    private readonly runner: HermesAuditRunner = requestHermesAudit,
    private readonly resolveSubmitter?: (userId: string) => RunSubmitter | undefined,
  ) {}
  private authorize(identity: Identity, admin = true) {
    const current = this.access.refresh(identity);
    if (admin && current.role !== "admin") throw new HttpError(403, "需要管理员权限", "ADMIN_REQUIRED");
    return current;
  }
  private async run(identity: Identity, runId: string) {
    this.authorize(identity);
    const project = (await this.loadSettings()).projectDirectory;
    this.authorize(identity);
    const run = await this.getRun(project, runId);
    if (!run && this.isPreparing(project, runId)) throw new HttpError(409, "运行正在准备，请稍后查询", "RUN_PREPARING", { runId });
    if (!run) throw new HttpError(404, "没有找到此运行", "RUN_NOT_FOUND", { runId });
    return { project, run };
  }
  private critiques(project: string, runId?: string) {
    return this.access.store.listDocuments<RunCritique>(project, COLLECTION)
      .filter(item => (!runId || item.runId === runId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  async audit(identity: Identity, input: unknown) {
    const query = parse(runAuditQuery, input, "INVALID_RUN_QUALITY_REQUEST");
    const { project, run } = await this.run(identity, query.runId);
    const critiques = this.critiques(project, run.runId);
    // 旧记录有归属但没有提交人快照时按当前用户档案补齐，不改写历史（与管理员运行详情同一口径）。
    const submitter = run.submitter ?? (run.ownerUserId ? this.resolveSubmitter?.(run.ownerUserId) : undefined);
    return buildRunAudit(run, query, critiques, submitter ? { submitter } : {});
  }
  async createCritique(identity: Identity, input: unknown) {
    const data = parse(createRunCritique, input, "INVALID_RUN_QUALITY_REQUEST");
    const { project, run } = await this.run(identity, data.runId);
    const actor = this.authorize(identity);
    const now = new Date().toISOString();
    const findings = data.findings.map((finding, index) => ({ ...finding, id: finding.id || "f" + (index + 1) }));
    if (new Set(findings.map(finding => finding.id)).size !== findings.length) throw new HttpError(400, "质检意见的问题ID不能重复", "INVALID_RUN_QUALITY_REQUEST");
    const known = new Set(run.workflow.steps.map(step => step.id));
    for (const finding of findings) {
      if (finding.stepId && !known.has(finding.stepId)) throw new HttpError(400, "质检意见引用了不存在的步骤：" + finding.stepId, "INVALID_RUN_QUALITY_REQUEST");
    }
    if (data.stepId && !known.has(data.stepId)) throw new HttpError(400, "质检意见引用了不存在的步骤：" + data.stepId, "INVALID_RUN_QUALITY_REQUEST");
    try {
      const critique = this.access.store.putDocumentChecked<RunCritique>(project, COLLECTION, {
        id: data.critiqueId, revision: 0, runId: run.runId,
        ...(data.stepId ? { stepId: data.stepId } : {}), ...(data.itemIndex !== undefined ? { itemIndex: data.itemIndex } : {}),
        verdict: data.verdict, ...(data.score !== undefined ? { score: data.score } : {}), summary: data.summary,
        findings, recommendations: data.recommendations, reviewer: data.reviewer, source: data.source,
        ...(data.model ? { model: data.model } : {}), status: "open", handledBy: actor.id, createdAt: now, updatedAt: now,
      }, 0, () => { this.authorize(identity); });
      return { critique, nextAction: "get_run_critique" as const };
    } catch (error) {
      if ((error as Error).message === "DOCUMENT_CONFLICT") throw new HttpError(409, "质检意见ID已存在；读取原ID对账，不重复提交", "RUN_CRITIQUE_ALREADY_EXISTS", { critiqueId: data.critiqueId });
      throw error;
    }
  }
  async listCritiques(identity: Identity, input: unknown) {
    const query = parse(runCritiqueQuery, input, "INVALID_RUN_QUALITY_REQUEST");
    const { project, run } = await this.run(identity, query.runId);
    const all = this.critiques(project, run.runId).filter(item => (!query.verdict || item.verdict === query.verdict) && (!query.status || item.status === query.status));
    const summaries = all.map(({ summary: _summary, findings: _findings, recommendations: _recommendations, ...item }) => ({ ...item, summaryOmitted: true as const, findingsOmitted: true as const, recommendationsOmitted: true as const }));
    return { ...accessPagination(summaries, query, "run-critiques:" + run.runId + ":" + (query.verdict ?? "") + ":" + (query.status ?? "")), nextAction: "get_run_critique" as const };
  }
  async getCritique(identity: Identity, input: unknown) {
    const data = parse(runCritiqueKey, input, "INVALID_RUN_QUALITY_REQUEST");
    this.authorize(identity);
    const project = (await this.loadSettings()).projectDirectory;
    this.authorize(identity);
    const critique = this.access.store.getDocument<RunCritique>(project, COLLECTION, data.critiqueId);
    if (!critique) throw new HttpError(404, "质检意见不存在", "RUN_CRITIQUE_NOT_FOUND", { critiqueId: data.critiqueId });
    return { critique, nextAction: critique.status === "open" ? "update_run_critique" as const : critique.status === "accepted" ? "preview_rerun" as const : "get_run_audit" as const };
  }
  async updateCritique(identity: Identity, input: unknown) {
    const data = parse(updateRunCritique, input, "INVALID_RUN_QUALITY_REQUEST");
    const { critique } = await this.getCritique(identity, { critiqueId: data.critiqueId });
    if (data.revision !== critique.revision) throw new HttpError(409, "质检意见版本冲突；读取原ID和当前revision后再决定", "RUN_CRITIQUE_REVISION_CONFLICT", { critiqueId: data.critiqueId, currentRevision: critique.revision });
    const allowed: Record<RunCritique["status"], RunCritique["status"][]> = { open: ["accepted", "dismissed"], accepted: ["fixed", "dismissed"], dismissed: ["open"], fixed: ["open"] };
    if (!allowed[critique.status].includes(data.status)) throw new HttpError(409, `质检意见不能从 ${critique.status} 直接变更为 ${data.status}`, "RUN_CRITIQUE_STATE_CONFLICT", { critiqueId: data.critiqueId, status: critique.status });
    const project = (await this.loadSettings()).projectDirectory;
    const actor = this.authorize(identity);
    try {
      const updated = this.access.store.putDocumentChecked<RunCritique>(project, COLLECTION, {
        ...critique, status: data.status, ...(data.note ? { statusNote: data.note } : {}), handledBy: actor.id, updatedAt: new Date().toISOString(),
      }, data.revision, () => { this.authorize(identity); });
      return { critique: updated, nextAction: data.status === "accepted" ? "preview_rerun" as const : data.status === "open" ? "update_run_critique" as const : "get_run_audit" as const };
    } catch (error) {
      if ((error as Error).message === "DOCUMENT_CONFLICT") throw new HttpError(409, "质检意见版本冲突；读取原ID和当前revision后再决定", "RUN_CRITIQUE_REVISION_CONFLICT", { critiqueId: data.critiqueId });
      throw error;
    }
  }
  /** 直连 Hermes 的第三方质检：唯一可能计费的质检操作，一次请求不自动重试。 */
  async hermesAudit(identity: Identity, input: unknown, signal?: AbortSignal) {
    const data = parse(runHermesAudit, input, "INVALID_RUN_QUALITY_REQUEST");
    const { project, run } = await this.run(identity, data.runId);
    this.authorize(identity);
    const existing = this.access.store.getDocument<RunCritique>(project, COLLECTION, data.critiqueId);
    if (existing) throw new HttpError(409, "该质检意见ID已存在；读取同一ID对账，不重复评审或换ID重投", "RUN_CRITIQUE_ALREADY_EXISTS", { critiqueId: data.critiqueId, status: existing.status });
    const settings = await this.loadSettings();
    this.authorize(identity);
    const profile = data.profile ?? settings.enabledHermesProfiles[0];
    if (!profile) throw new HttpError(400, "工作台没有启用任何 Hermes Profile；请先在连接设置里启用，或显式指定 profile", "RUN_AUDIT_PROFILE_UNAVAILABLE");
    if (data.profile && !(await listHermesProfiles()).some(item => item.id === data.profile)) throw new HttpError(404, "本机不存在此 Hermes Profile", "RUN_AUDIT_PROFILE_NOT_FOUND", { profile: data.profile });
    const known = new Set(run.workflow.steps.map(step => step.id));
    if (data.stepId && !known.has(data.stepId)) throw new HttpError(404, "没有找到此步骤", "RUN_AUDIT_STEP_NOT_FOUND", { runId: run.runId, stepId: data.stepId });
    const packet = buildRunAudit(run, { runId: run.runId, stepId: data.stepId, promptLimit: 4000, itemSample: 2 }, this.critiques(project, run.runId).slice(0, 5), { promptBytesBudget: HERMES_AUDIT_PROMPT_BYTES_BUDGET });
    const target: HermesAuditTarget = { profile, ...(data.provider ? { provider: data.provider } : {}), ...(data.model ? { model: data.model } : {}) };
    const started = Date.now();
    let result: HermesAuditResult;
    try {
      result = await this.runner({ target, packet, ...(data.focus ? { focus: data.focus } : {}), ...(data.stepId ? { stepId: data.stepId } : {}), timeoutMs: workflowTimeoutMs(settings.workflowTimeoutMinutes), signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof HermesAuditOutputError) throw new HttpError(502, "Hermes 质检回复不符合质检输出契约：" + error.message, "RUN_AUDIT_INVALID_OUTPUT", { critiqueId: data.critiqueId, profile, rawReply: error.raw.slice(0, DIAGNOSTIC_RAW_LIMIT), rawReplyTruncated: error.raw.length > DIAGNOSTIC_RAW_LIMIT });
      if (error instanceof Error && error.name === "AbortError") throw new HttpError(504, "Hermes 质检超时；用同一 critiqueId 读取质检记录对账后再决定是否重跑（会再次计费）", "RUN_AUDIT_TIMEOUT", { critiqueId: data.critiqueId, profile });
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("质检证据包过大")) throw new HttpError(400, message, "INVALID_RUN_QUALITY_REQUEST", { critiqueId: data.critiqueId });
      throw new HttpError(502, "Hermes 质检调用失败：" + message, "RUN_AUDIT_HERMES_FAILED", { critiqueId: data.critiqueId, profile });
    }
    const verdict = runCritiqueVerdict.safeParse(result.value.verdict);
    const score = typeof result.value.score === "number" ? result.value.score : typeof result.value.score === "string" && /^\d+$/.test(result.value.score.trim()) ? Number(result.value.score.trim()) : undefined;
    const summary = typeof result.value.summary === "string" ? result.value.summary.trim() : "";
    const rawFindings = Array.isArray(result.value.findings) ? result.value.findings : undefined;
    const rawRecommendations = Array.isArray(result.value.recommendations) ? result.value.recommendations : undefined;
    const invalid = (reason: string) => new HttpError(502, "Hermes 质检回复不符合质检输出契约：" + reason, "RUN_AUDIT_INVALID_OUTPUT", { critiqueId: data.critiqueId, profile, rawReply: result.raw.slice(0, DIAGNOSTIC_RAW_LIMIT), rawReplyTruncated: result.raw.length > DIAGNOSTIC_RAW_LIMIT, allowedStepIds: [...known] });
    if (!verdict.success) throw invalid("verdict 必须是 pass、warn 或 fail");
    if (score !== undefined && (!Number.isSafeInteger(score) || score < 0 || score > 100)) throw invalid("score 必须是 0–100 的整数");
    if (!summary) throw invalid("summary 不能为空");
    if (summary.length > 4000) throw invalid("summary 超过 4000 字");
    if (!rawFindings) throw invalid("findings 必须是数组");
    if (rawFindings.length > 50) throw invalid("findings 超过 50 条");
    if (!rawRecommendations) throw invalid("recommendations 必须是数组");
    if (rawRecommendations.length > 20) throw invalid("recommendations 超过 20 条");
    const findings: RunCritique["findings"] = [];
    for (const [index, entry] of rawFindings.entries()) {
      const item = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined;
      if (!item) throw invalid(`findings[${index}] 不是对象`);
      const severity = runCritiqueSeverity.safeParse(item.severity);
      const message = typeof item.message === "string" ? item.message.trim() : "";
      if (!severity.success) throw invalid(`findings[${index}].severity 必须是 info、minor、major 或 critical`);
      if (!message) throw invalid(`findings[${index}].message 不能为空`);
      const stepId = typeof item.stepId === "string" && item.stepId.trim() ? item.stepId.trim() : undefined;
      if (stepId && !known.has(stepId)) throw invalid(`findings[${index}].stepId 引用了不存在的步骤：${stepId}`);
      const itemIndex = Number.isSafeInteger(item.itemIndex) && Number(item.itemIndex) >= 0 ? Number(item.itemIndex) : undefined;
      findings.push({
        id: "f" + (index + 1), severity: severity.data, message: message.slice(0, 2000),
        ...(typeof item.category === "string" && item.category.trim() ? { category: item.category.trim().slice(0, 60) } : {}),
        ...(typeof item.evidence === "string" && item.evidence.trim() ? { evidence: item.evidence.trim().slice(0, 2000) } : {}),
        ...(stepId ? { stepId } : {}), ...(itemIndex !== undefined ? { itemIndex } : {}),
      });
    }
    const recommendations: string[] = [];
    for (const [index, entry] of rawRecommendations.entries()) {
      if (typeof entry !== "string" || !entry.trim()) throw invalid(`recommendations[${index}] 必须是非空字符串`);
      recommendations.push(entry.trim().slice(0, 1000));
    }
    const now = new Date().toISOString();
    const actor = this.authorize(identity);
    let critique: RunCritique;
    try {
      critique = this.access.store.putDocumentChecked<RunCritique>(project, COLLECTION, {
        id: data.critiqueId, revision: 0, runId: run.runId, ...(data.stepId ? { stepId: data.stepId } : {}),
        verdict: verdict.data, ...(score !== undefined ? { score } : {}), summary: summary.slice(0, 4000), findings, recommendations,
        reviewer: "Hermes 质检（" + profile + (data.model ? " / " + data.model : "") + "）", source: "hermes", model: target,
        status: "open", handledBy: actor.id, createdAt: now, updatedAt: now,
      }, 0, () => { this.authorize(identity); });
    } catch (error) {
      if ((error as Error).message === "DOCUMENT_CONFLICT") throw new HttpError(409, "该质检意见ID已存在；读取同一ID对账，不重复评审或换ID重投", "RUN_CRITIQUE_ALREADY_EXISTS", { critiqueId: data.critiqueId });
      throw error;
    }
    return { critique, target, acceptedFields: Object.keys(result.value), repaired: result.repaired, promptBytes: result.promptBytes, durationMs: Date.now() - started, nextAction: "get_run_critique" as const };
  }
}
