import * as z from "zod/v4";

/**
 * 运行事件通知 Webhook：管理员配置一个目标地址，工作台把选中的运行事件聚合后转发过去。
 *
 * 这不是运行状态机的一部分：投递在内存里异步进行，失败只影响通知本身，绝不阻塞或改变
 * 运行、审核、结算与归档。地址通常带 token（Discord/Slack/飞书等），因此读接口只回掩码，
 * 明文只在保存与投递时使用，不进入日志、运行记录或发布快照。
 */

export const NOTIFICATION_WEBHOOK_ID = "notification-webhook";
export const NOTIFICATION_WEBHOOK_FORMAT = "zane-studio.notification-webhook/v1";
export const NOTIFICATION_WEBHOOK_FORMATS = ["discord", "slack", "feishu", "generic"] as const;
export type NotificationWebhookFormat = (typeof NOTIFICATION_WEBHOOK_FORMATS)[number];

/** 入站转发（relay）：外部系统把一条文本 POST 给工作台，工作台按已配置的平台适配器转发出去。
 *  它复用同一份目标地址与平台格式，但不是运行事件：不做聚合、不参与运行状态机。
 *
 *  调用方是任意系统，**不能要求它们按我们的 schema 说话**：纯文本、任意 JSON、表单、
 *  Slack/Discord/飞书的原生载荷都要能接住，只有「什么都提取不出」才算错误。 */
export const RELAY_TEXT_MAX_CHARS = 20_000;
export const RELAY_TITLE_MAX_CHARS = 200;
export const RELAY_SOURCE_MAX_CHARS = 80;
export const RELAY_TOKEN_MIN_LENGTH = 24;
export const RELAY_TOKEN_MAX_LENGTH = 200;
export const relayTokenPattern = /^[A-Za-z0-9_-]{24,200}$/;

/** 宽松输入：text 只需非空字符串；长度超限由调用方截断而不是拒绝。 */
export const relayMessage = z.object({
  text: z.string().min(1).describe("要转发的正文；超长按平台上限截断并明确标记"),
  source: z.string().max(RELAY_SOURCE_MAX_CHARS).optional().describe("调用方标识（如 github、jenkins），只用于日志与回执，不参与路由"),
  title: z.string().max(RELAY_TITLE_MAX_CHARS).optional().describe("可选标题；会作为正文首行加粗显示"),
}).strict();

export interface RelayInput { text: string; title?: string; source?: string }

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function fieldOf(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const found = textOf(record[key]);
    if (found) return found;
  }
  return undefined;
}

const textKeys = ["text", "content", "message", "msg", "body", "payload", "summary", "description", "detail", "alert", "notification", "event"] as const;
const titleKeys = ["title", "subject", "header", "heading", "name"] as const;
const sourceKeys = ["source", "from", "service", "app", "repo", "repository", "project"] as const;

/** 从任意形状里尽力取出「一段可读文本」。取不到时把整个对象序列化，绝不因为结构陌生而拒收。 */
function extract(record: Record<string, unknown>, depth = 0): { text: string; title?: string; source?: string } {
  // 飞书/Lark：{msg_type, content:{text}}
  const content = record.content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const nested = extract(content as Record<string, unknown>, depth + 1);
    if (nested.text) return { text: nested.text, ...(nested.title ? { title: nested.title } : {}), ...(fieldOf(record, sourceKeys) ? { source: fieldOf(record, sourceKeys)! } : {}) };
  }
  // 嵌套载荷：{data:{...}} / {payload:{...}} 再挖一层。
  if (depth < 2) {
    for (const key of ["data", "payload", "notification", "alert"] as const) {
      const nested = record[key];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        const inner = extract(nested as Record<string, unknown>, depth + 1);
        if (inner.text) return { text: inner.text, ...(inner.title ? { title: inner.title } : {}), ...(fieldOf(record, sourceKeys) ? { source: fieldOf(record, sourceKeys)! } : {}) };
      }
    }
  }
  const text = fieldOf(record, textKeys);
  const title = fieldOf(record, titleKeys);
  const source = fieldOf(record, sourceKeys);
  if (text) return { text, ...(title ? { title } : {}), ...(source ? { source } : {}) };
  // 显式给了正文字段但内容为空（如 {"text":""}）：这是调用方本意就是空消息，明确拒绝，
  // 而不是把它序列化成 {"text":""} 转发出去。
  if (textKeys.some(key => typeof record[key] === "string")) throw new Error("正文字段为空");
  // 兜底：结构不认识就把整个对象当正文，至少不丢信息。
  const serialized = JSON.stringify(record, null, 2);
  return { text: serialized, ...(title ? { title } : {}), ...(source ? { source } : {}) };
}

/**
 * 把任意入站请求体归一成 {text, title?, source?}：
 *  - Buffer/string：JSON 就解析后继续提取；不是 JSON 就当纯文本（保留换行）。
 *  - application/x-www-form-urlencoded：按表单取值。
 *  - 对象/数组：按常见字段名提取，取不到就序列化整个对象。
 * 只有空内容才抛错——外部系统不该为了「格式不对」被拒。
 */
export function readRelayPayload(body: unknown, contentType = ""): RelayInput {
  let value = body;
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value === "string") {
    const raw = value.replace(/^\uFEFF/, "");
    const trimmed = raw.trim();
    if (!trimmed) throw new Error("转发内容为空");
    if (/urlencoded/i.test(contentType)) {
      const params = new URLSearchParams(trimmed);
      const text = params.get("text") ?? params.get("content") ?? params.get("message") ?? "";
      if (text.trim()) return {
        text,
        ...(params.get("title")?.trim() ? { title: params.get("title")!.trim().slice(0, RELAY_TITLE_MAX_CHARS) } : {}),
        ...(params.get("source")?.trim() ? { source: params.get("source")!.trim().slice(0, RELAY_SOURCE_MAX_CHARS) } : {}),
      };
    }
    if (/json/i.test(contentType) || trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed !== null && typeof parsed === "object") return normalizeRelayRecord(parsed);
      } catch { /* 声明是 JSON 但解析失败：按纯文本转发，不拒收 */ }
    }
    // 纯文本：原样保留换行与空白（只去掉首尾），这是最常见的「不规则调用」。
    return { text: raw.trim() };
  }
  if (value !== null && typeof value === "object") return normalizeRelayRecord(value);
  throw new Error("转发内容为空");
}

function normalizeRelayRecord(value: object): RelayInput {
  if (Array.isArray(value)) {
    const text = JSON.stringify(value, null, 2);
    if (!text.trim() || text === "[]") throw new Error("转发内容为空");
    return { text };
  }
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).length) throw new Error("转发内容为空");
  const extracted = extract(record);
  const text = extracted.text.trim();
  if (!text) throw new Error("转发内容为空");
  return {
    text,
    ...(extracted.title?.trim() ? { title: extracted.title.trim().slice(0, RELAY_TITLE_MAX_CHARS) } : {}),
    ...(extracted.source?.trim() ? { source: extracted.source.trim().slice(0, RELAY_SOURCE_MAX_CHARS) } : {}),
  };
}

export const relayReceiptSchema = z.object({
  format: z.literal("zane-studio.notification-relay/v1"),
  relayed: z.boolean().describe("目标平台是否接受了这次转发（HTTP 2xx）"),
  status: z.int().nonnegative().describe("目标返回的 HTTP 状态；0 表示网络失败或超时"),
  target: z.string().describe("目标地址掩码"),
  webhookFormat: z.enum(NOTIFICATION_WEBHOOK_FORMATS),
  chars: z.int().nonnegative().describe("实际转发正文长度（截断后）"),
  truncated: z.boolean().describe("正文是否因平台上限被截断"),
  attemptedAt: z.string(),
  error: z.string().optional().describe("失败原因摘要（已脱敏）；成功时省略"),
}).strict();
export type RelayReceipt = z.infer<typeof relayReceiptSchema>;

/** 可转发的事件白名单：只放业务上值得打扰人的节点，内部 checkpoint 与逐项 started 不在此列。 */
export const NOTIFICATION_EVENT_TYPES = [
  "run.queued",
  "run.started",
  "run.waiting",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.stale",
  "step.failed",
  "step.completed_with_errors",
  "review.approve",
  "review.redo",
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];
export const DEFAULT_NOTIFICATION_EVENTS: NotificationEventType[] = ["run.waiting", "run.completed", "run.failed", "run.cancelled", "run.stale"];

export const MIN_NOTIFICATION_AGGREGATE_SECONDS = 5;
export const MAX_NOTIFICATION_AGGREGATE_SECONDS = 300;
export const MAX_NOTIFICATION_PENDING_EVENTS = 200;
export const NOTIFICATION_EVENTS_PER_MESSAGE = 10;
export const NOTIFICATION_MESSAGE_CHARS = 1900;
export const MAX_NOTIFICATION_URL_LENGTH = 2048;

const eventTypeSchema = z.enum(NOTIFICATION_EVENT_TYPES);

export const notificationWebhookQuery = z.object({}).strict();

/** 更新是部分更新：url 三态（省略=保持、空串=清除、非空=替换），events 给出即完整替换。 */
export const updateNotificationWebhook = z.object({
  revision: z.int().nonnegative().describe("读取配置的当前 revision，未保存时为 0；409 或响应丢失后先重新读取，不自动重放"),
  enabled: z.boolean().optional().describe("是否启用转发；启用要求已有地址且至少选择 1 个事件"),
  url: z.string().max(MAX_NOTIFICATION_URL_LENGTH).optional().describe("Webhook 地址（通常含 token）。省略=保持已保存地址，空串=清除，非空=替换。明文存本机 SQLite，读接口只回掩码与末4位"),
  webhookFormat: z.enum(NOTIFICATION_WEBHOOK_FORMATS).optional().describe("discord=发送 {content, allowed_mentions} 消息；generic=发送 {source,text,events[]} JSON"),
  events: z.array(eventTypeSchema).max(NOTIFICATION_EVENT_TYPES.length).optional().describe("要转发的事件类型，给出即完整替换；按固定白名单顺序去重保存"),
  aggregateSeconds: z.int().min(MIN_NOTIFICATION_AGGREGATE_SECONDS).max(MAX_NOTIFICATION_AGGREGATE_SECONDS).optional().describe("聚合窗口秒数：窗口内的事件合并成一条消息，避免刷屏与触发平台限流"),
  relayEnabled: z.boolean().optional().describe("是否开放入站转发（外部系统调用 POST /api/v1/hooks/relay）；开启时目标地址必须已配置"),
  relayToken: z.string().max(RELAY_TOKEN_MAX_LENGTH).optional().describe("入站转发凭证（24–200 位字母数字_-）。省略=保持、空串=清除并关闭入站转发、非空=替换。明文存本机 SQLite，读接口只回掩码"),
}).strict();

export const notificationWebhookSettingsSchema = z.object({
  format: z.literal(NOTIFICATION_WEBHOOK_FORMAT),
  id: z.literal(NOTIFICATION_WEBHOOK_ID),
  revision: z.int().nonnegative(),
  enabled: z.boolean(),
  configured: z.boolean().describe("是否已保存地址；false 时启用会明确失败"),
  hasUrl: z.boolean(),
  urlMasked: z.string().describe("掩码后的地址：保留协议与主机，路径最后一段与查询值只留末4位；永不返回明文"),
  webhookFormat: z.enum(NOTIFICATION_WEBHOOK_FORMATS),
  events: z.array(eventTypeSchema),
  supportedEvents: z.array(eventTypeSchema),
  relay: z.object({
    enabled: z.boolean(),
    configured: z.boolean().describe("是否已保存入站转发凭证"),
    tokenMasked: z.string().describe("凭证掩码（末4位）；永不返回明文"),
    endpoint: z.string().describe("入站转发路径；需配合 Authorization: Bearer <relayToken>"),
    maxChars: z.int().positive(),
  }).strict(),
  formats: z.array(z.object({
    id: z.enum(NOTIFICATION_WEBHOOK_FORMATS),
    label: z.string(),
    maxChars: z.int().positive(),
  }).strict()).describe("可用目标平台适配器；每个平台的载荷结构与单条正文上限不同"),
  aggregateSeconds: z.int().min(MIN_NOTIFICATION_AGGREGATE_SECONDS).max(MAX_NOTIFICATION_AGGREGATE_SECONDS),
  scope: z.literal("system"),
  limits: z.object({
    eventsPerMessage: z.int().positive(),
    minAggregateSeconds: z.int().positive(),
    maxAggregateSeconds: z.int().positive(),
    maxPendingEvents: z.int().positive(),
    messageChars: z.int().positive(),
  }).strict(),
  delivery: z.object({
    pendingEvents: z.int().nonnegative(),
    deliveredMessages: z.int().nonnegative(),
    deliveredEvents: z.int().nonnegative(),
    failedMessages: z.int().nonnegative(),
    droppedEvents: z.int().nonnegative(),
    relayedMessages: z.int().nonnegative().describe("入站转发成功次数（本进程）"),
    relayedFailed: z.int().nonnegative().describe("入站转发失败次数（本进程）"),
    lastAttemptAt: z.string().optional(),
    lastSuccessAt: z.string().optional(),
    lastRelayAt: z.string().optional(),
    lastError: z.string().optional(),
  }).strict(),
  storageNotice: z.string(),
  nextAction: z.enum(["update_with_revision", "test_notification_webhook"]),
}).strict();
export type NotificationWebhookSettings = z.infer<typeof notificationWebhookSettingsSchema>;

export const notificationWebhookTestResultSchema = z.object({
  format: z.literal(NOTIFICATION_WEBHOOK_FORMAT),
  id: z.literal(NOTIFICATION_WEBHOOK_ID),
  attempted: z.boolean(),
  sent: z.boolean(),
  status: z.int().nonnegative().describe("目标返回的 HTTP 状态；0 表示网络失败或超时"),
  urlMasked: z.string(),
  attemptedAt: z.string(),
  error: z.string().optional().describe("失败原因摘要（已脱敏、已截断）；成功时省略"),
  nextAction: z.enum(["update_with_revision", "get_notification_webhook"]),
}).strict();
export type NotificationWebhookTestResult = z.infer<typeof notificationWebhookTestResultSchema>;

export interface NotificationEvent {
  type: string;
  at: string;
  runId: string;
  sceneId: string;
  status: string;
  runTitle?: string;
  workflowName?: string;
  stepId?: string;
  stepName?: string;
  itemIndex?: number;
  error?: string;
}

/** 地址是秘密：只校验形状，不做网络探测；允许 http（本机/内网接收端）与查询串（部分平台把 token 放这里）。 */
export function normalizeNotificationWebhookUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Webhook 地址必须是字符串");
  const text = value.trim();
  if (!text) return "";
  if (text.length > MAX_NOTIFICATION_URL_LENGTH) throw new Error(`Webhook 地址过长，最多 ${MAX_NOTIFICATION_URL_LENGTH} 个字符`);
  if (/[\0\r\n\t]/.test(text)) throw new Error("Webhook 地址不能包含控制字符");
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new Error("Webhook 地址必须是完整的 http(s) 地址"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Webhook 地址只支持 http 或 https");
  if (parsed.username || parsed.password) throw new Error("Webhook 地址不能内嵌用户名或密码；请把 token 放在路径或查询串里");
  if (parsed.hash) throw new Error("Webhook 地址不能带片段（#）");
  return text;
}

function tail(value: string) {
  return value.length <= 4 ? value : value.slice(-4);
}

/** 读接口唯一可见的地址形态：主机与结构用于核对「配的是哪个目标」，token 段只留末4位。
 *  短段（≤4 字符）不截断也不加省略号——它本身没有秘密，加了反而让人误以为地址被改写。 */
export function maskNotificationWebhookUrl(value: string): string {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length) {
      const last = segments[segments.length - 1]!;
      segments[segments.length - 1] = last.length <= 4 ? last : "…" + tail(last);
    }
    const query = [...parsed.searchParams.keys()].map(key => key + "=…").join("&");
    return parsed.origin + (segments.length ? "/" + segments.join("/") : "") + (query ? "?" + query : "");
  } catch {
    return "…";
  }
}

/** 白名单内的去重与固定顺序：客户端顺序不影响保存结果，也不会把未知事件写进去。 */
export function normalizeNotificationEvents(value: readonly string[]): NotificationEventType[] {
  const selected = new Set(value);
  return NOTIFICATION_EVENT_TYPES.filter(type => selected.has(type));
}

export function isNotificationEventType(value: string): value is NotificationEventType {
  return (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value);
}

export const NOTIFICATION_WEBHOOK_STORAGE_NOTICE = "Webhook 地址通常包含平台 token，以明文保存在本机 SQLite（production_documents.settings.notification-webhook）；读接口只返回掩码与末4位，明文不进日志、运行记录、运行输入、发布快照或导出清单。请自行保护数据目录与备份。";

/** Machine contract for the run-event notification webhook; mirrored into the AI OpenAPI as x-notification-webhook. */
export const NOTIFICATION_WEBHOOK_CONTRACT = {
  version: "1",
  scope: "系统单例设置 notification-webhook；仅管理员，普通用户入口不提供",
  events: {
    whitelist: [...NOTIFICATION_EVENT_TYPES],
    default: [...DEFAULT_NOTIFICATION_EVENTS],
    filtering: "只转发已保存 events 里的事件；run.checkpoint、step.started、step.item.* 与内部事件永不转发",
    ordering: "按产生顺序入队；给出 events 时按固定白名单顺序去重保存",
  },
  aggregate: {
    window: "aggregateSeconds 5–300（默认 30）；窗口内事件合并为一条消息",
    eventsPerMessage: NOTIFICATION_EVENTS_PER_MESSAGE,
    messageChars: NOTIFICATION_MESSAGE_CHARS,
    perFormat: "实际上限 = min(全局上限, 平台上限)：discord 1900、slack 2900、feishu 3500、generic 1900",
    truncation: "正文超限时明确追加 …（已截断），不静默丢弃",
    pendingLimit: MAX_NOTIFICATION_PENDING_EVENTS,
    pendingOverflow: "超出上限丢弃最旧事件并计入 delivery.droppedEvents",
  },
  adapters: {
    layer: "聚合层只产出统一文本与事件数组；平台差异（载荷结构、提及策略、正文上限）集中在 domain/notificationFormats.ts",
    discord: "{content, allowed_mentions:{parse:[]}}；@everyone/@here 不会被触发",
    slack: "{text, unfurl_links:false, unfurl_media:false}；Slack Incoming Webhook 形状",
    feishu: "{msg_type:\"text\", content:{text}}；飞书/Lark 自定义机器人形状",
    generic: "{source:\"zane-workbench\", text, events: NotificationEvent[]}；自建接收端可拿结构化事件",
  },
  delivery: {
    mode: "旁路：observe 同步入队且无 I/O，发送异步；不影响运行、审核、结算与归档",
    retries: "单条消息最多 2 次尝试；仅网络失败、超时、429 与 5xx 重试，其它 4xx 不重试",
    rateLimit: "429 时按 Retry-After 头（秒）或响应体 retry_after（秒，可为小数）退避，上限 5 秒",
    failure: "失败批不重排队；本轮剩余事件丢弃并计入 failedMessages/droppedEvents，lastError 记录脱敏摘要",
    durability: "内存队列；进程重启后未发送事件丢失，不落库、不建旁路数据库",
    shutdown: "停机时最多等待 3 秒做一次尽力投递",
  },
  security: {
    urlStorage: "明文存本机 SQLite（产品明确选择）",
    urlRead: "读接口只返回 urlMasked：保留协议与主机，路径末段与查询值只留末4位",
    urlWrite: "三态：省略=保持、空串=清除、非空=替换；启用要求已有地址且至少 1 个事件",
    redaction: "出站正文对运行错误做 redactErrorText；日志里的 url 同为掩码",
    externalReach: "只有 test_notification_webhook 立即出网；保存/启用/读取都不发送",
  },
  sideEffects: {
    read: "none",
    update: "只改配置；不发送、不调用模型、不计费",
    test: "向已保存地址真实发送一条固定测试消息；一次请求，不改变配置",
  },
  errors: ["INVALID_NOTIFICATION_WEBHOOK_REQUEST", "RESOURCE_REVISION_CONFLICT", "NOTIFICATION_WEBHOOK_NOT_CONFIGURED", "ADMIN_REQUIRED"],
} as const;
