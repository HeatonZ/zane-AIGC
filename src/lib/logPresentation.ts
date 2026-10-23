import type { LogLevelName, SystemLogEntry, SystemLogOpsLine } from "../types";
import { runDuration } from "./runDetails";

/**
 * Presentation helpers for the admin log viewer.
 *
 * The log surface itself is deliberately generic (`event` + free-form `fields`), which is
 * what makes it complete and what made it unreadable: an operator saw a bare event name and
 * a raw JSON blob. Everything here only *derives display text* from data the server already
 * returns — no new fields, no filtering, no execution — so the contract stays unchanged.
 */

export type LogFields = Record<string, unknown>;

export const levelLabels: Record<LogLevelName, string> = { info: "信息", warn: "警告", error: "错误" };

export interface LogCategory {
  id: string;
  label: string;
}

const categoryTable: Array<[prefix: string, category: LogCategory]> = [
  ["http.", { id: "http", label: "接口" }],
  ["run.", { id: "run", label: "运行" }],
  ["step.", { id: "step", label: "步骤" }],
  ["review.", { id: "review", label: "审核" }],
  ["hermes.", { id: "hermes", label: "Hermes" }],
  ["comfy.", { id: "comfy", label: "ComfyUI" }],
  ["direct_llm.", { id: "direct", label: "直连模型" }],
  ["package.", { id: "package", label: "场景包" }],
  ["scene_package.", { id: "package", label: "场景包" }],
  ["notification.", { id: "notification", label: "通知" }],
  ["access.", { id: "access", label: "权限" }],
  ["credit.", { id: "credit", label: "积分" }],
  ["cdk.", { id: "credit", label: "卡密" }],
  ["workspace.", { id: "workspace", label: "工作区" }],
  ["local.", { id: "local", label: "本地导出" }],
  ["mcp.", { id: "mcp", label: "MCP" }],
  ["server.", { id: "server", label: "服务" }],
  ["worker.", { id: "worker", label: "工作进程" }],
  ["backend_", { id: "watchdog", label: "看门狗" }],
  ["orphan_", { id: "watchdog", label: "看门狗" }],
  ["upgrade_", { id: "watchdog", label: "看门狗" }],
  ["watchdog_", { id: "watchdog", label: "看门狗" }],
];
const otherCategory: LogCategory = { id: "other", label: "其他" };

export function eventCategory(event: string): LogCategory {
  for (const [prefix, category] of categoryTable) if (event.startsWith(prefix)) return category;
  return otherCategory;
}

/** 已知事件的中文名。未登记的事件原样显示事件名，绝不猜一个可能错的名字。 */
export const eventLabels: Record<string, string> = {
  "http.request": "接口请求",
  "http.error": "接口错误",
  "server.mcp_reload_published": "MCP 已重载",
  "server.public_user_listening": "用户入口已监听",
  "server.public_user_failed": "用户入口启动失败",
  "server.shutdown_started": "服务开始关闭",
  "server.shutdown_completed": "服务已关闭",
  "worker.start_failed": "工作进程启动失败",

  "run.queued": "运行已排队",
  "run.recovered_queued": "排队运行已恢复",
  "run.queued_recovery_failed": "排队恢复失败",
  "run.started": "运行开始",
  "run.completed": "运行完成",
  "run.failed": "运行失败",
  "run.cancelled": "运行已取消",
  "run.cancelling": "运行取消中",
  "run.stale": "运行中断，等待恢复",
  "run.waiting": "运行等待确认",
  "run.legacy_indexed": "旧运行已索引",
  "run.legacy_import_failed": "旧运行导入失败",
  "run.preparation_cleanup_failed": "运行准备清理失败",
  "run.execution_failed": "运行执行失败",
  "run.persistence_failed": "运行结果保存失败",
  "run.archive_snapshot_failed": "运行快照归档失败",
  "run.event_observer_failed": "运行事件观察失败",
  "run.listener_failed": "运行监听失败",

  "step.started": "步骤开始",
  "step.completed": "步骤完成",
  "step.completed_with_errors": "步骤部分成功",
  "step.failed": "步骤失败",
  "step.skipped": "步骤已跳过",
  "step.cancelled": "步骤已取消",
  "step.item.started": "逐项开始",
  "step.item.completed": "逐项完成",
  "step.item.failed": "逐项失败",
  "step.item.skipped": "逐项跳过",
  "step.item.cancelled": "逐项取消",

  "review.approve": "审核已批准",
  "review.redo": "审核已退回",

  "hermes.request_failed": "Hermes 请求失败",
  "hermes.runs_endpoint_unavailable": "Hermes runs 接口不可用",
  "hermes.output_json_repaired": "Hermes 输出已修复",
  "hermes.response_capture_failed": "Hermes 原文保存失败",

  "comfy.binding_remapped": "ComfyUI 绑定已重映射",

  "direct_llm.request_failed": "直连模型请求失败",
  "direct_llm.models_failed": "直连模型列表失败",
  "direct_llm.provider_saved": "直连提供商已保存",
  "direct_llm.provider_deleted": "直连提供商已删除",
  "direct_llm.models_queried": "直连模型已查询",

  "package.item_submit_failed": "场景包项提交失败",
  "package.await_failed": "场景包等待失败",
  "package.settle_failed": "场景包结算失败",

  "scene_package.loaded": "场景包已加载",
  "scene_package.load_failed": "场景包加载失败",
  "scene_package.disabled": "场景包已禁用",
  "scene_package.log": "场景包运行日志",
  "scene_package.run_failed": "场景包运行失败",

  "notification.webhook_failed": "通知投递失败",

  "access.audit_failed": "权限审计写入失败",
  "access.credential_sweep_failed": "凭证清理失败",
  "credit.settle_failed": "积分结算失败",
  "cdk.grant_failed": "卡密授权失败",

  "workspace.migrated_from_json": "工作区已从 JSON 迁移",
  "workspace.json_export_failed": "工作区 JSON 导出失败",
  "local.export": "本地导出完成",

  "mcp.started": "MCP 已启动",
  "mcp.transport_error": "MCP 传输错误",
  "mcp.protocol_error": "MCP 协议错误",
  "mcp.response_failed": "MCP 响应失败",
  "mcp.worker_lost": "MCP 工作进程丢失",
  "mcp.worker_transport_error": "MCP 工作进程传输错误",
  "mcp.restart_failed": "MCP 重启失败",
  "mcp.restarting": "MCP 重启中",
  "mcp.restarted": "MCP 已重启",
  "mcp.catalog_notification_failed": "MCP 目录通知失败",

  "backend_started": "后端已启动",
  "backend_ready": "后端已就绪",
  "backend_degraded": "后端健康检查失败",
  "backend_start_unconfirmed": "后端启动未确认",
  "orphan_process_detected": "发现残留进程",
  "upgrade_in_progress_skip": "升级中，跳过自动启动",
  "watchdog_error": "看门狗错误",
};

export function eventLabel(event: string): string {
  return eventLabels[event] ?? event;
}

/** MCP supervisor 写的是 `{component, event}`，补上命名空间后才能复用同一套分类与文案。 */
export function normalizedEvent(event: string, component?: string): string {
  return component === "zane-mcp-supervisor" ? `mcp.${event}` : event;
}

function join(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(" · ");
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstText(fields: LogFields, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = textValue(fields[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function shortId(value: unknown): string | undefined {
  const text = textValue(value);
  return text ? text.slice(0, 8) : undefined;
}

function errorText(fields: LogFields): string | undefined {
  return firstText(fields, ["error", "errorMessage", "causeMessage", "message"]);
}

/** 错误原因：页面在折叠状态也要显示它，所以单独导出。 */
export function errorMessage(fields: LogFields): string | undefined {
  return errorText(fields);
}

function withCode(fields: LogFields, text: string | undefined): string | undefined {
  const code = textValue(fields.code);
  if (code && text) return `${text}（${code}）`;
  return code ?? text;
}

/**
 * One-line human summary for a log entry. Ordered so the fact an operator needs first is
 * first: error text for failures, ids for run-scoped events, method/path/status for requests.
 */
export function describeEvent(event: string, fields: LogFields): string {
  switch (event) {
    case "http.request": {
      const method = textValue(fields.method);
      const path = textValue(fields.path);
      const status = numberValue(fields.status);
      const duration = numberValue(fields.durationMs);
      // The status belongs to the request line, not to a separate segment: "GET /x → 200".
      const line = join([method && path ? `${method} ${path}` : path ?? method, status === undefined ? undefined : `→ ${status}`]).replace(" · → ", " → ");
      return join([line, duration === undefined ? undefined : `${duration}ms`]);
    }
    case "http.error": {
      // 先给「哪个请求」，再给状态码与原因：只写 HTTP 401 时管理员无法判断是哪个接口失败。
      const method = textValue(fields.method);
      const path = textValue(fields.path);
      const status = numberValue(fields.status);
      const route = method && path ? `${method} ${path}` : path ?? method;
      const statusText = status === undefined ? undefined : `HTTP ${status}`;
      const request = route && statusText ? `${route} → ${statusText}` : route ?? statusText;
      const code = textValue(fields.code);
      const reason = errorText(fields);
      return join([request, reason ? (code && reason !== code ? `${reason}（${code}）` : reason) : code]);
    }
    case "server.public_user_listening": {
      const host = textValue(fields.host);
      const port = numberValue(fields.port);
      return join([host && port !== undefined ? `${host}:${port}` : host, textValue(fields.entryMode)]);
    }
    case "server.public_user_failed":
    case "worker.start_failed":
    case "access.credential_sweep_failed":
    case "workspace.json_export_failed":
      return errorText(fields) ?? "";
    case "server.mcp_reload_published": {
      const version = textValue(fields.contractVersion);
      return version ? `契约版本 ${version}` : "";
    }
    case "hermes.request_failed":
      return join([
        textValue(fields.profile) ?? (fields.directLlm ? "直连模型" : undefined),
        textValue(fields.endpoint) ?? textValue(fields.baseUrl),
        withCode(fields, errorText(fields)),
      ]);
    case "hermes.runs_endpoint_unavailable": {
      const status = numberValue(fields.status);
      return join([textValue(fields.profile), status === undefined ? undefined : `HTTP ${status}`, "已回退 chat/completions"]);
    }
    case "hermes.output_json_repaired": {
      const repair = fields.repair && typeof fields.repair === "object" ? Object.keys(fields.repair as LogFields).join("/") : textValue(fields.kind);
      const step = textValue(fields.stepId);
      return join([step ? `步骤 ${step}` : undefined, repair ? `已修复输出 JSON（${repair}）` : "已修复输出 JSON"]);
    }
    case "hermes.response_capture_failed": {
      const step = textValue(fields.stepId);
      const name = textValue(fields.errorName);
      return join([step ? `步骤 ${step}` : undefined, name ? `保存原文失败：${name}` : "保存原文失败"]);
    }
    case "comfy.binding_remapped": {
      const step = textValue(fields.step);
      const from = textValue(fields.from);
      const to = textValue(fields.to);
      return join([step ? `步骤 ${step}` : undefined, textValue(fields.bindingKey), from && to ? `${from} → ${to}` : undefined]);
    }
    case "direct_llm.request_failed":
    case "direct_llm.models_failed":
      return join([textValue(fields.providerId), textValue(fields.protocol), withCode(fields, errorText(fields))]);
    case "direct_llm.provider_saved":
      return join([
        textValue(fields.providerId),
        textValue(fields.protocol),
        fields.enabled === true ? "已启用" : fields.enabled === false ? "已停用" : undefined,
        textValue(fields.credentialSource),
      ]);
    case "direct_llm.provider_deleted":
      return join([textValue(fields.providerId), "已删除"]);
    case "direct_llm.models_queried": {
      const fetched = numberValue(fields.fetched);
      const kept = numberValue(fields.kept);
      return join([textValue(fields.providerId), fetched === undefined ? undefined : `拉取 ${fetched}`, kept === undefined ? undefined : `新增 ${kept}`]);
    }
    case "notification.webhook_failed": {
      const status = numberValue(fields.status);
      const events = numberValue(fields.events);
      return join([textValue(fields.url), status === undefined ? undefined : `HTTP ${status}`, errorText(fields), events === undefined ? undefined : `${events} 条事件`]);
    }
    case "access.audit_failed":
      return join([textValue(fields.action), textValue(fields.target), errorText(fields)]);
    case "credit.settle_failed": {
      const run = shortId(fields.runId);
      return join([run ? `运行 ${run}` : undefined, textValue(fields.userId) ? `用户 ${textValue(fields.userId)}` : undefined, errorText(fields)]);
    }
    case "local.export": {
      const run = shortId(fields.runId);
      const written = numberValue(fields.written);
      const skipped = numberValue(fields.skipped);
      return join([run ? `运行 ${run}` : undefined, written === undefined ? undefined : `写入 ${written}`, skipped === undefined ? undefined : `跳过 ${skipped}`]);
    }
    case "workspace.migrated_from_json": {
      const revision = numberValue(fields.revision);
      return revision === undefined ? "" : `工作区 revision ${revision}`;
    }
    case "run.legacy_indexed": {
      const discovered = numberValue(fields.discovered);
      return join([textValue(fields.projectDirectory), discovered === undefined ? undefined : `发现 ${discovered} 个运行`]);
    }
    case "package.item_submit_failed":
    case "package.await_failed":
    case "package.settle_failed": {
      const packageRun = shortId(fields.packageRunId);
      return join([packageRun ? `场景包 ${packageRun}` : undefined, textValue(fields.itemId) ? `项 ${textValue(fields.itemId)}` : undefined, errorText(fields)]);
    }
    case "mcp.started":
    case "mcp.restarted":
    case "mcp.restarting":
    case "mcp.worker_lost":
    case "mcp.transport_error":
    case "mcp.protocol_error":
    case "mcp.response_failed":
    case "mcp.worker_transport_error":
    case "mcp.restart_failed":
    case "mcp.catalog_notification_failed": {
      const workerPid = numberValue(fields.workerPid);
      const previousWorkerPid = numberValue(fields.previousWorkerPid);
      const generation = numberValue(fields.generation);
      return join([
        workerPid === undefined ? undefined : `工作进程 ${workerPid}`,
        previousWorkerPid === undefined ? undefined : `原进程 ${previousWorkerPid}`,
        generation === undefined ? undefined : `generation ${generation}`,
        textValue(fields.contractVersion) ? `契约 ${textValue(fields.contractVersion)}` : undefined,
        textValue(fields.message),
      ]);
    }
    case "backend_started":
    case "backend_ready":
    case "backend_start_unconfirmed": {
      const pid = numberValue(fields.pid);
      const port = numberValue(fields.port);
      return join([
        pid === undefined ? undefined : `pid ${pid}`,
        port === undefined ? undefined : `端口 ${port}`,
        event === "backend_start_unconfirmed" ? "未确认就绪" : undefined,
      ]);
    }
    case "backend_degraded": {
      const port = numberValue(fields.port);
      return join([port === undefined ? undefined : `端口 ${port}`, "健康检查失败"]);
    }
    case "orphan_process_detected": {
      const pid = numberValue(fields.pid);
      return join([pid === undefined ? undefined : `进程 ${pid}`, "检测到残留进程"]);
    }
    case "upgrade_in_progress_skip":
      return join([textValue(fields.state) ? `升级状态 ${textValue(fields.state)}` : undefined, "跳过自动启动"]);
    case "watchdog_error":
      return errorText(fields) ?? "";
    default:
      break;
  }
  if (event.startsWith("step.item.")) {
    const step = textValue(fields.stepName) ?? textValue(fields.stepId);
    const index = numberValue(fields.itemIndex);
    const duration = numberValue(fields.durationMs);
    return join([
      step ? `步骤 ${step}` : undefined,
      index === undefined ? undefined : `第 ${index + 1} 项`,
      errorText(fields),
      duration === undefined ? undefined : `${duration}ms`,
    ]);
  }
  if (event.startsWith("step.")) {
    const step = textValue(fields.stepName) ?? textValue(fields.stepId);
    const capability = textValue(fields.capabilityId);
    const duration = numberValue(fields.durationMs);
    const warnings = numberValue(fields.warningCount);
    return join([
      step ? `步骤 ${step}` : undefined,
      capability,
      errorText(fields) ?? textValue(fields.message),
      duration === undefined ? undefined : `${duration}ms`,
      warnings ? `${warnings} 条警告` : undefined,
    ]);
  }
  if (event.startsWith("review.")) {
    const step = textValue(fields.stepName) ?? textValue(fields.stepId);
    return join([step ? `步骤 ${step}` : undefined, textValue(fields.reviewId) ? `审核 ${shortId(fields.reviewId)}` : undefined]);
  }
  if (event.startsWith("run.")) {
    const run = shortId(fields.runId) ?? shortId(fields.sourceRunId) ?? shortId(fields.newRunId);
    const scene = textValue(fields.sceneId);
    const duration = numberValue(fields.durationMs);
    const discovered = numberValue(fields.discovered);
    return join([
      run ? `运行 ${run}` : undefined,
      scene ? `场景 ${scene}` : undefined,
      errorText(fields),
      duration === undefined ? undefined : `${duration}ms`,
      discovered === undefined ? undefined : `发现 ${discovered} 个运行`,
    ]);
  }
  return describeFields(fields);
}

/** 未登记事件的兜底摘要：先取标量字段（信息量最高），再取对象形状，至少让人知道这条日志带了什么。 */
export function describeFields(fields: LogFields, limit = 4): string {
  const entries = orderedFieldEntries(fields);
  const scalars = entries.filter(([, value]) => value === null || typeof value !== "object");
  const composites = entries.filter(([, value]) => value !== null && typeof value === "object");
  const parts: string[] = [];
  for (const [key, value] of [...scalars, ...composites]) {
    if (parts.length >= limit) break;
    const text = inlineValue(value);
    if (text === undefined) continue;
    parts.push(`${key}=${text}`);
  }
  return parts.join(" · ");
}

function inlineValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 120 ? value.slice(0, 120) + "…" : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  if (Array.isArray(value)) return `[${value.length} 项]`;
  if (typeof value === "object") return `{${Object.keys(value as LogFields).length} 个字段}`;
  return undefined;
}

/** 展开区字段顺序：先错误与关键 ID，再请求细节，最后是其余字段。 */
const fieldPriority = [
  "error", "errorMessage", "causeMessage", "message",
  "runId", "sourceRunId", "newRunId", "sceneId", "stepId", "itemIndex",
  "packageRunId", "itemId", "userId", "providerId", "profile",
  "status", "method", "path", "durationMs", "endpoint", "baseUrl", "code",
  "workflowFile", "bindingKey", "from", "to", "property",
  "requestId", "action", "target", "url", "events",
  "written", "skipped", "revision", "contractVersion",
  "host", "port", "pid", "workerPid", "previousWorkerPid", "generation",
  "enabled", "credentialSource", "protocol", "fetched", "kept",
  "state", "health", "discovered", "projectDirectory", "repair", "kind", "errorName",
];

export function orderedFieldEntries(fields: LogFields): Array<[string, unknown]> {
  const rank = new Map(fieldPriority.map((key, index) => [key, index] as const));
  return Object.keys(fields)
    .sort((left, right) => (rank.get(left) ?? fieldPriority.length) - (rank.get(right) ?? fieldPriority.length) || left.localeCompare(right))
    .map((key) => [key, fields[key]] as [string, unknown]);
}

export interface FormattedField {
  kind: "scalar" | "json";
  text: string;
}

export function formatFieldValue(value: unknown): FormattedField {
  if (typeof value === "string") return { kind: "scalar", text: value };
  if (typeof value === "number" || typeof value === "boolean" || value === null) return { kind: "scalar", text: String(value) };
  try {
    return { kind: "json", text: JSON.stringify(value, null, 2) ?? String(value) };
  } catch {
    return { kind: "json", text: "[无法序列化]" };
  }
}

function pad(value: number, width = 2) {
  return String(value).padStart(width, "0");
}

/** 本机时区显示，保留毫秒：同一秒内的多条事件靠它区分先后。 */
export function logTime(value?: string): string {
  if (!value) return "无时间";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}.${pad(parsed.getMilliseconds(), 3)}`;
}

export function fullTime(value?: string): string {
  if (!value) return "无时间";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}.${pad(parsed.getMilliseconds(), 3)}`;
}

export type LogTone = "ok" | "warn" | "error" | "";

export function statusTone(status: number): LogTone {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  if (status >= 200) return "ok";
  return "";
}

export interface RequestIdentity {
  method?: string;
  path?: string;
}

export interface LogGroup {
  /** 去重键：同一类噪声或同一个失败归为一组。 */
  key: string;
  kind: "failure" | "noise";
  label: string;
  detail: string;
  /** 结构化事实：页面正文用原因与状态说人话，路径只进技术信息。 */
  reason?: string;
  status?: number;
  route?: string;
  count: number;
  firstSequence: number;
  lastSequence: number;
  firstTime: string;
  lastTime: string;
  /** 组内每条的序号，展开时按原样列出。 */
  sequences: number[];
}

/**
 * 轮询类请求：它们按秒级周期重复，占满了日志窗口，却不携带排障信息。
 * 这里只识别「成功」的心跳请求；同一路径一旦失败就是异常，必须照常展示。
 */
const heartbeatPaths = [
  /^\/api\/workspace\/status$/,
  /^\/api\/v1\/self\/runtime-release$/,
  /^\/api\/(?:health|ready)$/,
  /^\/api\/v1\/maintenance\/logs(?:\/ops)?$/,
  /^\/api\/v1\/self\/account$/,
];

function isSuccessfulRequest(entry: SystemLogEntry): boolean {
  if (entry.event !== "http.request" || entry.level !== "info") return false;
  const status = numberValue(entry.fields.status);
  const method = textValue(entry.fields.method);
  return method === "GET" && status !== undefined && status >= 200 && status < 400;
}

/**
 * 把窗口内容压缩成「重点」：先按失败原因聚合（同一个 403 重复 17 次只是一件事），
 * 再把成功的心跳轮询折成计数。返回的分组顺序按组内最近一条从新到旧。
 *
 * 一次失败的请求会产生两条条目（`http.request` 带状态码 + `http.error` 带原因），它们共享
 * requestId。这里先按 requestId 把它们合成一件事，再按「请求 + 状态码 + 原因」聚合，
 * 否则同一次失败会显示成两行、其中一行还缺原因。
 */
export function summarizeLogEntries(entries: SystemLogEntry[], options: { collapseHeartbeats?: boolean } = {}): {
  groups: LogGroup[];
  failures: LogGroup[];
  noise: LogGroup[];
  heartbeatCount: number;
  visibleEntries: SystemLogEntry[];
} {
  const groups = new Map<string, LogGroup>();
  const add = (group: LogGroup) => {
    const existing = groups.get(group.key);
    if (!existing) { groups.set(group.key, { ...group, sequences: [...group.sequences] }); return; }
    existing.count += group.count;
    existing.sequences.push(...group.sequences);
    if (group.lastSequence > existing.lastSequence) { existing.lastSequence = group.lastSequence; existing.lastTime = group.lastTime; }
    if (group.firstSequence < existing.firstSequence) { existing.firstSequence = group.firstSequence; existing.firstTime = group.firstTime; }
  };

  // 先按 requestId 汇总一次请求的全部事实：状态码可能来自 http.request，原因来自 http.error。
  const requests = new Map<string, { method?: string; path?: string; status?: number; reason?: string; sequences: number[] }>();
  for (const entry of entries) {
    const requestId = textValue(entry.fields.requestId);
    if (!requestId) continue;
    const current = requests.get(requestId) ?? { sequences: [] };
    current.sequences.push(entry.sequence);
    const method = textValue(entry.fields.method);
    const path = textValue(entry.fields.path);
    const status = numberValue(entry.fields.status);
    const reason = errorText(entry.fields) ?? textValue(entry.fields.code);
    if (method) current.method = method;
    if (path) current.path = path;
    if (status !== undefined) current.status = status;
    if (reason) current.reason = reason;
    requests.set(requestId, current);
  }

  for (const entry of entries) {
    const failed = entry.level === "error" || typeof entry.fields.error === "string" || (numberValue(entry.fields.status) ?? 0) >= 400;
    if (failed) {
      const requestId = textValue(entry.fields.requestId);
      const request = requestId ? requests.get(requestId) : undefined;
      const route = [request?.method ?? textValue(entry.fields.method), request?.path ?? textValue(entry.fields.path)].filter(Boolean).join(" ");
      const status = request?.status ?? numberValue(entry.fields.status);
      const reason = request?.reason ?? errorText(entry.fields) ?? textValue(entry.fields.code) ?? "";
      // 同一次请求的两条条目归到同一组：键里用 requestId 兜底，避免缺 method/path 时被拆开。
      const identity = route || requestId || eventLabel(entry.event);
      const key = `failure:${identity}|${status ?? ""}|${reason}`;
      add({
        // 失败组统一用「失败」：同一次失败的两条条目事件名不同（http.request/http.error），
        // 沿用事件名会把同一件事标成两种标签。
        key, kind: "failure", label: "失败",
        detail: join([route, status === undefined ? undefined : `HTTP ${status}`, reason]),
        ...(reason ? { reason } : {}),
        ...(status === undefined ? {} : { status }),
        ...(route ? { route } : {}),
        count: 1, firstSequence: entry.sequence, lastSequence: entry.sequence,
        firstTime: entry.time, lastTime: entry.time, sequences: [entry.sequence],
      });
      continue;
    }
    if (options.collapseHeartbeats !== false && isSuccessfulRequest(entry)) {
      const path = textValue(entry.fields.path) ?? "";
      if (heartbeatPaths.some(pattern => pattern.test(path))) {
        const key = `noise:${path}`;
        add({
          key, kind: "noise", label: "轮询请求", detail: join(["GET " + path, "成功"]),
          count: 1, firstSequence: entry.sequence, lastSequence: entry.sequence,
          firstTime: entry.time, lastTime: entry.time, sequences: [entry.sequence],
        });
        continue;
      }
    }
  }

  const ordered = [...groups.values()].sort((left, right) => right.lastSequence - left.lastSequence);
  // 同一请求同一状态码若一组带原因、一组缺原因（例如 http.error 的 requestId 已滚出窗口），
  // 合并到有原因的那组：它们本来就是同一件事，拆开只会多一行噪音。
  const mergeKey = (group: LogGroup) => group.key.split("|").slice(0, 2).join("|");
  const merged = new Map<string, LogGroup>();
  for (const group of ordered) {
    const key = mergeKey(group);
    const existing = merged.get(key);
    if (!existing) { merged.set(key, group); continue; }
    if (existing.detail.length < group.detail.length) {
      // 保留信息更全的那条作为显示文本，但计数与序号范围仍然合并。
      const kept = { ...group };
      kept.count += existing.count;
      kept.sequences = [...existing.sequences, ...group.sequences];
      kept.firstSequence = Math.min(existing.firstSequence, group.firstSequence);
      kept.firstTime = existing.firstSequence < group.firstSequence ? existing.firstTime : group.firstTime;
      kept.lastSequence = Math.max(existing.lastSequence, group.lastSequence);
      kept.lastTime = existing.lastSequence > group.lastSequence ? existing.lastTime : group.lastTime;
      merged.set(key, kept);
    } else {
      existing.count += group.count;
      existing.sequences.push(...group.sequences);
      existing.firstSequence = Math.min(existing.firstSequence, group.firstSequence);
      existing.firstTime = group.firstSequence < existing.firstSequence ? group.firstTime : existing.firstTime;
      if (group.lastSequence > existing.lastSequence) { existing.lastSequence = group.lastSequence; existing.lastTime = group.lastTime; }
    }
  }
  const collapsed = [...merged.values()].sort((left, right) => right.lastSequence - left.lastSequence);
  const failures = collapsed.filter(group => group.kind === "failure");
  const noise = collapsed.filter(group => group.kind === "noise");
  // 失败已在失败段单独成组、心跳已在轮询段汇总；两者都不该再出现在「其余事件」里。
  const groupedSequences = new Set([...failures, ...noise].flatMap(group => group.sequences));
  const heartbeatCount = noise.reduce((sum, group) => sum + group.count, 0);
  const visibleEntries = entries.filter(entry => !groupedSequences.has(entry.sequence));
  return { groups: ordered, failures, noise, heartbeatCount, visibleEntries };
}

/**
 * 旧日志里的 `http.error` 只记了 requestId、status 与原因，没有 method/path，因此看不出是哪个
 * 接口失败。同一次请求的 `http.request` 条目带 requestId、method 与 path，可以按 requestId 关联
 * 回来——只补展示，不修改历史条目，也不假设两条一定同时存在于当前窗口。
 */
export function correlateRequestIdentities(entries: Array<{ fields: LogFields }>): Map<string, RequestIdentity> {
  const found = new Map<string, RequestIdentity>();
  for (const entry of entries) {
    const requestId = textValue(entry.fields.requestId);
    if (!requestId) continue;
    const method = textValue(entry.fields.method);
    const path = textValue(entry.fields.path);
    if (method || path) found.set(requestId, { ...(method ? { method } : {}), ...(path ? { path } : {}) });
  }
  return found;
}

/** 血缘条目里 runId 可能指向祖先（sourceRunId/newRunId）；查运行详情要用真正的运行 ID。 */
export function resolveRunId(fields: LogFields): string | undefined {
  return textValue(fields.runId) ?? textValue(fields.newRunId) ?? textValue(fields.sourceRunId);
}

/** 同一次请求的所有记录：http.request 与 http.error 共享 requestId，合起来才是完整一次调用。 */
export function requestRecords(entries: SystemLogEntry[], requestId: string): SystemLogEntry[] {
  return entries.filter(entry => textValue(entry.fields.requestId) === requestId);
}

/** 相邻日志：展开一条时给出上下文，避免只能孤立地看一条。 */
export function neighborEntries(entries: SystemLogEntry[], sequence: number, radius = 3): { before: SystemLogEntry[]; after: SystemLogEntry[] } {
  const index = entries.findIndex(entry => entry.sequence === sequence);
  if (index < 0) return { before: [], after: [] };
  return {
    before: entries.slice(Math.max(0, index - radius), index).reverse(),
    after: entries.slice(index + 1, index + 1 + radius),
  };
}

/** 运行上下文里要显示的一行：把运行记录压成页面直接可渲染的结构，便于测试。 */
export interface RunContextRow {
  label: string;
  value: string;
  tone?: "bad" | "warn" | "ok";
}

export interface RunContextStepRow {
  name: string;
  capability: string;
  status: string;
  duration: string;
  failed: boolean;
}

export function runContextRows(run: {
  status: string; sceneId: string; workflowName: string; runTitle?: string;
  startedAt?: string; finishedAt?: string; durationMs?: number;
  submitter?: { displayName: string; username: string }; ownerUserId?: string;
  resumedFromRunId?: string; rerunFromRunId?: string;
}): RunContextRow[] {
  const rows: RunContextRow[] = [
    { label: "状态", value: run.status, tone: run.status === "failed" ? "bad" : run.status === "completed" ? "ok" : run.status === "waiting" ? "warn" : undefined },
    { label: "场景", value: run.sceneId },
    { label: "流程", value: run.workflowName },
  ];
  if (run.runTitle) rows.push({ label: "标题", value: run.runTitle });
  rows.push({ label: "开始", value: run.startedAt ? fullTime(run.startedAt) : "未开始" });
  rows.push({ label: "结束", value: run.finishedAt ? fullTime(run.finishedAt) : "未结束" });
  rows.push({ label: "用时", value: runDuration(run.durationMs) });
  if (run.submitter) rows.push({ label: "提交人", value: `${run.submitter.displayName}（${run.submitter.username}）` });
  if (run.ownerUserId) rows.push({ label: "归属用户", value: run.ownerUserId });
  if (run.resumedFromRunId) rows.push({ label: "续跑自", value: run.resumedFromRunId });
  if (run.rerunFromRunId) rows.push({ label: "修订自", value: run.rerunFromRunId });
  return rows;
}

export function runStepRows(steps: Array<{ name: string; status: string; capabilityId?: string; durationMs?: number; warnings?: string[] }>): RunContextStepRow[] {
  return steps.map(step => ({
    name: step.name,
    capability: step.capabilityId ?? "—",
    status: step.status + (step.warnings?.length ? ` · ${step.warnings.length} 条警告` : ""),
    duration: runDuration(step.durationMs),
    failed: step.status === "failed",
  }));
}

/**
 * 一句话说明「发生了什么」。
 *
 * 日志页的主要读者要看的是内容，不是接口路径和字段名。这里把每条事件翻译成一句中文：
 * 谁做了什么、结果如何、为什么失败。技术坐标（method/path/requestId/stepId）不进正文，
 * 由调用方放到折叠的技术信息里。未登记的事件才回退到「事件名 + 字段摘要」。
 */
export function narrativeFor(event: string, fields: LogFields): string {
  const scene = textValue(fields.sceneId);
  const step = textValue(fields.stepName) ?? textValue(fields.stepId) ?? textValue(fields.step);
  const reason = errorText(fields);
  const duration = numberValue(fields.durationMs);
  const item = numberValue(fields.itemIndex);
  const status = numberValue(fields.status);

  switch (event) {
    // ---- 接口：只在不影响理解时出现；路径属于技术坐标，交给折叠区 ----
    case "http.request":
      return status !== undefined && status >= 400
        ? `接口调用失败（HTTP ${status}）`
        : "接口调用成功";
    case "http.error": {
      const code = textValue(fields.code);
      return reason ? `接口调用失败：${reason}${code ? `（${code}）` : ""}` : `接口调用失败（HTTP ${status ?? "未知"}）`;
    }

    // ---- 运行 ----
    case "run.queued": return `任务已进入队列${scene ? `（场景 ${scene}）` : ""}`;
    case "run.recovered_queued": return "服务重启后，排队中的任务已恢复";
    case "run.started": return "任务开始执行";
    case "run.completed": return `任务已完成${duration === undefined ? "" : `，用时 ${durationText(duration)}`}`;
    case "run.failed":
    case "run.execution_failed": return `任务执行失败${reason ? `：${reason}` : ""}`;
    case "run.cancelled": return "任务已取消";
    case "run.cancelling": return "正在停止任务";
    case "run.stale": return "服务中断导致任务停在半途，需要恢复";
    case "run.waiting": return "任务暂停，等待人工确认";
    case "run.queued_recovery_failed": return `恢复排队任务失败${reason ? `：${reason}` : ""}`;
    case "run.preparation_cleanup_failed": return `准备阶段清理失败${reason ? `：${reason}` : ""}`;
    case "run.persistence_failed": return `任务结果保存失败${reason ? `：${reason}` : ""}`;
    case "run.archive_snapshot_failed": return `任务快照归档失败${reason ? `：${reason}` : ""}`;
    case "run.event_observer_failed": return `任务事件通知失败${reason ? `：${reason}` : ""}`;
    case "run.listener_failed": return `任务进度推送失败${reason ? `：${reason}` : ""}`;
    case "run.legacy_import_failed": return `旧任务导入失败${reason ? `：${reason}` : ""}`;

    // ---- 步骤 ----
    case "step.started": return `开始执行步骤「${step ?? "未命名"}」`;
    case "step.completed": return `步骤「${step ?? "未命名"}」完成${duration === undefined ? "" : `，用时 ${durationText(duration)}`}`;
    case "step.completed_with_errors": return `步骤「${step ?? "未命名"}」部分成功${reason ? `：${reason}` : ""}`;
    case "step.failed": return `步骤「${step ?? "未命名"}」失败${reason ? `：${reason}` : ""}`;
    case "step.skipped": return `跳过步骤「${step ?? "未命名"}」${reason ? `：${reason}` : ""}`;
    case "step.cancelled": return `步骤「${step ?? "未命名"}」已取消`;
    case "step.item.started": return `开始第 ${item === undefined ? "?" : item + 1} 项${step ? `（${step}）` : ""}`;
    case "step.item.completed": return `第 ${item === undefined ? "?" : item + 1} 项完成${step ? `（${step}）` : ""}${duration === undefined ? "" : `，用时 ${durationText(duration)}`}`;
    case "step.item.failed": return `第 ${item === undefined ? "?" : item + 1} 项失败${step ? `（${step}）` : ""}${reason ? `：${reason}` : ""}`;
    case "step.item.skipped": return `跳过第 ${item === undefined ? "?" : item + 1} 项${step ? `（${step}）` : ""}`;
    case "step.item.cancelled": return `第 ${item === undefined ? "?" : item + 1} 项已取消${step ? `（${step}）` : ""}`;

    // ---- 审核 ----
    case "review.approve": return `人工确认通过${step ? `，继续执行「${step}」` : ""}`;
    case "review.redo": return `人工退回${step ? `，重新执行「${step}」` : ""}`;

    // ---- 外部服务 ----
    case "hermes.request_failed":
      return `调用 Hermes 失败${reason ? `：${reason}` : ""}${textValue(fields.profile) ? `（配置 ${textValue(fields.profile)}）` : ""}`;
    case "hermes.runs_endpoint_unavailable": return "Hermes 新版接口不可用，已自动改用旧接口";
    case "hermes.output_json_repaired": return `模型回复的格式有小问题，已自动修复${step ? `（步骤 ${step}）` : ""}`;
    case "hermes.response_capture_failed": return `模型回复保存失败${reason ? `：${reason}` : ""}`;
    case "comfy.binding_remapped": return `ComfyUI 工作流节点已自动改接${step ? `（步骤 ${step}）` : ""}`;
    case "direct_llm.request_failed": return `调用直连模型失败${reason ? `：${reason}` : ""}`;
    case "direct_llm.models_failed": return `读取直连模型列表失败${reason ? `：${reason}` : ""}`;
    case "direct_llm.provider_saved": return `直连模型提供商已保存${fields.enabled === false ? "（未启用）" : ""}`;
    case "direct_llm.provider_deleted": return "直连模型提供商已删除";
    case "direct_llm.models_queried": {
      const fetched = numberValue(fields.fetched);
      return `已读取直连模型列表${fetched === undefined ? "" : `，共 ${fetched} 个`}`;
    }

    // ---- 场景包 / 积分 / 权限 ----
    case "package.item_submit_failed": return `场景包中的一项提交失败${textValue(fields.itemId) ? `（${textValue(fields.itemId)}）` : ""}${reason ? `：${reason}` : ""}`;
    case "package.await_failed": return `场景包等待结果失败${reason ? `：${reason}` : ""}`;
    case "package.settle_failed": return `场景包结算失败${reason ? `：${reason}` : ""}`;
    // 代码子工程：包内 log() 原样写进 message，事件名带 packageRunId 供按次聚合。
    case "scene_package.log": return textValue(fields.message) ?? "场景包写了一条日志";
    case "scene_package.run_failed": return `场景包运行失败${reason ? `：${reason}` : ""}`;
    case "scene_package.loaded": return `场景包「${textValue(fields.packageId) ?? "?"}」已加载${textValue(fields.version) ? `（v${textValue(fields.version)}）` : ""}`;
    case "scene_package.load_failed": return `场景包「${textValue(fields.packageId) ?? "?"}」加载失败${reason ? `：${reason}` : ""}`;
    case "scene_package.disabled": return `场景包「${textValue(fields.packageId) ?? "?"}」已禁用，不再加载`;
    case "credit.settle_failed": return `积分结算失败${reason ? `：${reason}` : ""}`;
    case "cdk.grant_failed": return `卡密授权失败${reason ? `：${reason}` : ""}`;
    case "access.audit_failed": return `操作审计写入失败${reason ? `：${reason}` : ""}`;
    case "access.credential_sweep_failed": return `凭证清理失败${reason ? `：${reason}` : ""}`;
    case "notification.webhook_failed": return `运行通知发送失败${reason ? `：${reason}` : ""}`;

    // ---- 服务与工作区 ----
    case "server.mcp_reload_published": return "AI 工具目录已重新发布";
    case "server.public_user_listening": return "用户入口已开始监听";
    case "server.public_user_failed": return `用户入口启动失败${reason ? `：${reason}` : ""}`;
    case "server.shutdown_started": return "服务开始关闭";
    case "server.shutdown_completed": return "服务已关闭";
    case "worker.start_failed": return `后台工作进程启动失败${reason ? `：${reason}` : ""}`;
    case "workspace.migrated_from_json": return "工作区配置已从旧格式迁移";
    case "workspace.json_export_failed": return `工作区配置导出失败${reason ? `：${reason}` : ""}`;
    case "local.export": {
      const written = numberValue(fields.written);
      const skipped = numberValue(fields.skipped);
      return `已把结果写入本地目录${written === undefined ? "" : `，${written} 个文件`}${skipped ? `，跳过 ${skipped} 个` : ""}`;
    }

    // ---- MCP ----
    case "mcp.started": return "AI 工具服务已启动";
    case "mcp.restarting": return "AI 工具服务正在重启";
    case "mcp.restarted": return "AI 工具服务已重启";
    case "mcp.worker_lost": return "AI 工具服务的工作进程意外退出";
    case "mcp.restart_failed": return `AI 工具服务重启失败${reason ? `：${reason}` : ""}`;
    case "mcp.transport_error":
    case "mcp.worker_transport_error": return `AI 工具服务通信异常${reason ? `：${reason}` : ""}`;
    case "mcp.protocol_error": return `AI 工具服务协议错误${reason ? `：${reason}` : ""}`;
    case "mcp.response_failed": return `AI 工具调用未返回结果${reason ? `：${reason}` : ""}`;
    case "mcp.catalog_notification_failed": return `AI 工具目录通知失败${reason ? `：${reason}` : ""}`;

    // ---- 看门狗 ----
    case "backend_started": return "看门狗已启动后台服务";
    case "backend_ready": return "后台服务已就绪";
    case "backend_degraded": return "后台服务健康检查失败";
    case "backend_start_unconfirmed": return "看门狗启动了后台，但未能确认就绪";
    case "orphan_process_detected": return "发现残留的后台进程";
    case "upgrade_in_progress_skip": return "正在升级，跳过自动启动";
    case "watchdog_error": return `看门狗出错${reason ? `：${reason}` : ""}`;

    default: break;
  }

  // 未登记事件：给事件名 + 可读字段，至少能读懂发生了什么。
  const detail = describeFields(fields, 3);
  return detail ? `${eventLabel(event)}（${detail}）` : eventLabel(event);
}

/** 时长的口语化表达：日志正文里「46 秒」比「46620ms」好读。 */
export function durationText(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "未记录";
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/** 一句话说明「发生了什么」——页面正文只显示这个，技术字段进折叠层。 */
export function entryNarrative(event: string, fields: LogFields): string {
  return narrativeFor(event, fields);
}

/** 从一条日志里取出可在折叠行内直接展示的关键事实，避免每次都要展开。 */
export interface EntryFacts {
  status?: number;
  request?: RequestIdentity;
  runId?: string;
  sceneId?: string;
  stepName?: string;
  itemIndex?: number;
  durationMs?: number;
  code?: string;
  error?: string;
}

export function entryFacts(fields: LogFields, identities?: Map<string, RequestIdentity>): EntryFacts {
  const status = numberValue(fields.status);
  const requestId = textValue(fields.requestId);
  const ownMethod = textValue(fields.method);
  const ownPath = textValue(fields.path);
  // 自身带 method/path 时优先用自己的；否则按 requestId 关联同一次请求。
  const correlated = requestId ? identities?.get(requestId) : undefined;
  const request: RequestIdentity | undefined = ownMethod || ownPath
    ? { ...(ownMethod ? { method: ownMethod } : {}), ...(ownPath ? { path: ownPath } : {}) }
    : correlated;
  const stepName = textValue(fields.stepName) ?? textValue(fields.stepId);
  return {
    ...(status === undefined ? {} : { status }),
    ...(request ? { request } : {}),
    ...(shortId(fields.runId ?? fields.sourceRunId ?? fields.newRunId) ? { runId: shortId(fields.runId ?? fields.sourceRunId ?? fields.newRunId)! } : {}),
    ...(textValue(fields.sceneId) ? { sceneId: textValue(fields.sceneId)! } : {}),
    ...(stepName ? { stepName } : {}),
    ...(numberValue(fields.itemIndex) === undefined ? {} : { itemIndex: numberValue(fields.itemIndex)! }),
    ...(numberValue(fields.durationMs) === undefined ? {} : { durationMs: numberValue(fields.durationMs)! }),
    ...(textValue(fields.code) ? { code: textValue(fields.code)! } : {}),
    ...(errorText(fields) ? { error: errorText(fields)! } : {}),
  };
}

export interface ParsedOpsLine {
  lineNumber: number;
  raw: string;
  truncated: boolean;
  /** 只有完整、可解析且带 event 的 JSON 行才结构化；其余保持原文，绝不伪装成结构化。 */
  parsed?: {
    time?: string;
    level?: LogLevelName;
    event: string;
    component?: string;
    fields: LogFields;
  };
}

export function parseOpsLine(line: Pick<SystemLogOpsLine, "lineNumber" | "text" | "truncated">): ParsedOpsLine {
  const base: ParsedOpsLine = { lineNumber: line.lineNumber, raw: line.text, truncated: Boolean(line.truncated) };
  const trimmed = line.text.trim();
  // 被长度预算裁剪的行会带 `…[truncated]`，JSON.parse 必然失败；先按原文处理。
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return base;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!value || typeof value !== "object" || Array.isArray(value)) return base;
    const record = value as LogFields;
    const event = typeof record.event === "string" && record.event.trim() ? record.event : undefined;
    if (!event) return base;
    const fields: LogFields = { ...record };
    const time = typeof fields.time === "string" ? fields.time : undefined;
    const level = fields.level === "info" || fields.level === "warn" || fields.level === "error" ? fields.level : undefined;
    const component = typeof fields.component === "string" ? fields.component : undefined;
    delete fields.time;
    delete fields.level;
    delete fields.event;
    delete fields.component;
    return {
      ...base,
      parsed: {
        ...(time ? { time } : {}),
        ...(level ? { level } : {}),
        event,
        ...(component ? { component } : {}),
        fields,
      },
    };
  } catch {
    return base;
  }
}
