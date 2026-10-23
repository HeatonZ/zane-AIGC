import {
  DEFAULT_NOTIFICATION_EVENTS, MAX_NOTIFICATION_PENDING_EVENTS, NOTIFICATION_EVENTS_PER_MESSAGE, NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_MESSAGE_CHARS, NOTIFICATION_WEBHOOK_FORMAT, NOTIFICATION_WEBHOOK_ID, NOTIFICATION_WEBHOOK_STORAGE_NOTICE, NOTIFICATION_WEBHOOK_FORMATS,
  RELAY_TEXT_MAX_CHARS, readRelayPayload, relayTokenPattern,
  isNotificationEventType, maskNotificationWebhookUrl, normalizeNotificationEvents, normalizeNotificationWebhookUrl,
  notificationWebhookSettingsSchema, updateNotificationWebhook,
  type NotificationEvent, type NotificationWebhookFormat, type NotificationWebhookSettings, type NotificationWebhookTestResult, type RelayInput, type RelayReceipt,
} from "../domain/notificationWebhook.js";
import { HttpError } from "../errors.js";
import { timingSafeEqual } from "node:crypto";
import { notificationFormatAdapter, notificationMessageLimit } from "../domain/notificationFormats.js";
import { log } from "../observability/logger.js";
import { redactErrorText } from "../security/errorHandler.js";
import type { SqliteStore } from "../storage/sqliteStore.js";

const SYSTEM = "@zane-system";
const COLLECTION = "settings";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_000;
/** 平台限流退避的上限：通知不值得让窗口等太久，超出就直接放弃这一次。 */
const MAX_RETRY_DELAY_MS = 5_000;

interface SavedWebhook {
  id: string;
  revision: number;
  enabled: boolean;
  url: string;
  webhookFormat: NotificationWebhookFormat;
  events: string[];
  aggregateSeconds: number;
  relayEnabled: boolean;
  relayToken: string;
}

interface DeliveryStats {
  pendingEvents: number;
  deliveredMessages: number;
  deliveredEvents: number;
  failedMessages: number;
  droppedEvents: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  relayedMessages: number;
  relayedFailed: number;
  lastRelayAt?: string;
}

const defaults = {
  enabled: false,
  url: "",
  webhookFormat: "discord" as NotificationWebhookFormat,
  events: [...DEFAULT_NOTIFICATION_EVENTS] as string[],
  aggregateSeconds: 30,
  relayEnabled: false,
  relayToken: "",
};

function invalid(message: string): never {
  throw new HttpError(400, message, "INVALID_NOTIFICATION_WEBHOOK_REQUEST");
}

function conflict(): never {
  throw new HttpError(409, "通知 Webhook 配置已变化，请重新读取并核对后保存；不要重放旧请求", "RESOURCE_REVISION_CONFLICT");
}

/** 事件文本里的人名/标题/错误都来自运行记录；出站前仍做一次脱敏与长度裁剪。 */
function excerpt(value: unknown, limit = 300) {
  if (typeof value !== "string" || !value.trim()) return "";
  const text = redactErrorText(value.trim()).replace(/\s+/g, " ");
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

/** 文案按事件类型取：步骤失败发生在运行仍 running 时，用运行状态会误导读者。 */
const eventLabels: Record<string, string> = {
  "run.queued": "已排队",
  "run.started": "开始执行",
  "run.waiting": "等待人工确认",
  "run.completed": "已完成",
  "run.failed": "失败",
  "run.cancelled": "已取消",
  "run.stale": "已中断",
  "step.failed": "步骤失败",
  "step.completed_with_errors": "步骤部分失败",
  "review.approve": "审核已批准",
  "review.redo": "审核已退回",
};

function describeEvent(event: NotificationEvent) {
  const title = event.runTitle || event.workflowName || event.sceneId;
  const parts = [`【${eventLabels[event.type] ?? event.type}】${title}`];
  if (event.type.startsWith("step.") || event.type.startsWith("review.")) {
    const step = event.stepName || event.stepId || "未知步骤";
    parts.push(`步骤：${step}${event.itemIndex === undefined ? "" : `（第 ${event.itemIndex + 1} 项）`}`);
  }
  parts.push(`运行：${event.runId.slice(0, 8)}`);
  if (event.sceneId) parts.push(`场景：${event.sceneId}`);
  if (event.error) parts.push(`原因：${excerpt(event.error)}`);
  return parts.join("\n");
}

function formatMessage(events: NotificationEvent[], limit = NOTIFICATION_MESSAGE_CHARS) {
  const lines = events.map(describeEvent);
  let text = lines.join("\n\n");
  if (text.length > limit) text = text.slice(0, limit) + "\n…（已截断）";
  return text;
}

function delay(ms: number) {
  return new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
}

/** 定长比较：凭证校验不因提前返回的字符差异泄露长度或前缀。 */
function safeEqual(left: string, right: string) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 平台限流给出的退避提示：Retry-After 头（秒）或 Discord 惯用的 JSON retry_after（秒，可为小数）。
 *  上限 5 秒——通知不值得让窗口阻塞太久；缺失或不可解析时退回固定退避。 */
function retryDelayMs(header: string | null, body: string): number {
  const fromHeader = header ? Number(header) : NaN;
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return Math.min(fromHeader * 1000, MAX_RETRY_DELAY_MS);
  try {
    const parsed = JSON.parse(body) as { retry_after?: unknown };
    const seconds = typeof parsed.retry_after === "number" ? parsed.retry_after : NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  } catch { /* 非 JSON 响应体：直接用固定退避 */ }
  return RETRY_DELAY_MS;
}

/**
 * 运行事件聚合 Webhook：管理员配置一个目标地址，运行事件在内存队列里按窗口合并后投递。
 *
 * 它不是运行状态机的一部分，也不建旁路数据库：投递失败只记录统计与错误摘要，
 * 不影响运行、审核、结算与归档。地址含 token，因此任何日志与响应都只出现掩码。
 */
export class NotificationWebhookService {
  private readonly pending: NotificationEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private closed = false;
  private readonly stats: DeliveryStats = { pendingEvents: 0, deliveredMessages: 0, deliveredEvents: 0, failedMessages: 0, droppedEvents: 0, relayedMessages: 0, relayedFailed: 0 };

  constructor(private readonly store: SqliteStore, private readonly operatorToken = "") {}

  private saved() { return this.store.getDocument<SavedWebhook>(SYSTEM, COLLECTION, NOTIFICATION_WEBHOOK_ID); }

  private current() {
    const saved = this.saved();
    return {
      revision: saved?.revision ?? 0,
      enabled: saved?.enabled ?? defaults.enabled,
      url: saved?.url ?? defaults.url,
      webhookFormat: saved?.webhookFormat ?? defaults.webhookFormat,
      events: saved?.events ?? defaults.events,
      aggregateSeconds: saved?.aggregateSeconds ?? defaults.aggregateSeconds,
      relayEnabled: saved?.relayEnabled ?? defaults.relayEnabled,
      relayToken: saved?.relayToken ?? defaults.relayToken,
    };
  }

  read(): NotificationWebhookSettings {
    const current = this.current();
    this.stats.pendingEvents = this.pending.length;
    return notificationWebhookSettingsSchema.parse({
      format: NOTIFICATION_WEBHOOK_FORMAT,
      id: NOTIFICATION_WEBHOOK_ID,
      revision: current.revision,
      enabled: current.enabled,
      configured: Boolean(current.url),
      hasUrl: Boolean(current.url),
      urlMasked: maskNotificationWebhookUrl(current.url),
      webhookFormat: current.webhookFormat,
      events: normalizeNotificationEvents(current.events),
      supportedEvents: [...NOTIFICATION_EVENT_TYPES],
      relay: {
        enabled: current.relayEnabled,
        configured: Boolean(current.relayToken),
        tokenMasked: current.relayToken ? "…" + current.relayToken.slice(-4) : "",
        endpoint: "/api/v1/hooks/relay",
        maxChars: RELAY_TEXT_MAX_CHARS,
      },
      formats: NOTIFICATION_WEBHOOK_FORMATS.map(id => ({
        id, label: notificationFormatAdapter(id).label, maxChars: notificationFormatAdapter(id).maxChars,
      })),
      aggregateSeconds: current.aggregateSeconds,
      scope: "system",
      limits: {
        eventsPerMessage: NOTIFICATION_EVENTS_PER_MESSAGE,
        minAggregateSeconds: 5,
        maxAggregateSeconds: 300,
        maxPendingEvents: MAX_NOTIFICATION_PENDING_EVENTS,
        messageChars: NOTIFICATION_MESSAGE_CHARS,
      },
      delivery: { ...this.stats },
      storageNotice: NOTIFICATION_WEBHOOK_STORAGE_NOTICE,
      nextAction: "update_with_revision",
    });
  }

  update(input: unknown, authorize: () => void): NotificationWebhookSettings {
    const parsed = updateNotificationWebhook.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      invalid("通知 Webhook 参数无效" + (issue ? "：" + issue.path.join(".") + " " + issue.message : ""));
    }
    const data = parsed.data;
    const current = this.current();
    let url = current.url;
    if (data.url !== undefined) {
      try { url = normalizeNotificationWebhookUrl(data.url); }
      catch (error) { invalid(error instanceof Error ? error.message : "Webhook 地址无效"); }
    }
    const events = data.events === undefined ? normalizeNotificationEvents(current.events) : normalizeNotificationEvents(data.events);
    // 显式请求启用时必须已经具备地址与事件：宁可 400 也不保存一个「看起来开启、实际不会发送」的配置。
    if (data.enabled === true) {
      if (!url) invalid("启用转发前必须填写 Webhook 地址");
      if (!events.length) invalid("启用转发前至少选择 1 个事件");
    }
    // 清空地址会同时关闭转发（这是清除动作的自然结果，不需要额外参数）。
    const finalEnabled = url ? (data.enabled ?? current.enabled) : false;
    // 入站转发凭证三态：省略=保持、空串=清除并关闭、非空=替换。
    let relayToken = current.relayToken;
    if (data.relayToken !== undefined) {
      const text = data.relayToken.trim();
      if (text && !relayTokenPattern.test(text)) invalid("入站转发凭证必须是 24–200 位字母、数字、_ 或 -");
      relayToken = text;
    }
    const relayEnabled = relayToken ? (data.relayEnabled ?? current.relayEnabled) : false;
    if (relayEnabled && !url) invalid("启用入站转发前必须先配置目标 Webhook 地址");
    const next: SavedWebhook = {
      id: NOTIFICATION_WEBHOOK_ID,
      revision: data.revision,
      enabled: finalEnabled,
      url,
      webhookFormat: data.webhookFormat ?? current.webhookFormat,
      events,
      aggregateSeconds: data.aggregateSeconds ?? current.aggregateSeconds,
      relayEnabled,
      relayToken,
    };
    try {
      this.store.putDocumentChecked(SYSTEM, COLLECTION, next, data.revision, authorize);
    } catch (error) {
      if (error instanceof Error && error.message === "DOCUMENT_CONFLICT") conflict();
      throw error;
    }
    return this.read();
  }

  /**
   * 入站转发：外部系统把一条文本交给工作台，工作台按已配置的平台适配器转发到目标 webhook。
   * 与运行事件不同，它不聚合、不排队——调用方需要同步知道这次转发成功与否，所以直接返回回执。
   * 目标地址与平台格式都只来自服务端配置，调用方不能指定任何目标。
   *
   * 两种凭证都可以：
   *  - relayToken（管理员在页面上设置，只用于这个转发入口，权限最小）；
   *  - ZANE_ADMIN_TOKEN（本机运维凭证，管理员已经有它，不必再维护第二把钥匙）。
   * 两者都必须精确匹配；未启用时一律 404，不暴露该路径是否存在。
   */
  async relay(input: unknown, bearer: string | undefined, contentType = "", operatorToken = this.operatorToken): Promise<RelayReceipt> {
    const current = this.current();
    if (!current.relayEnabled) throw new HttpError(404, "入站转发未启用", "RELAY_NOT_ENABLED");
    // 常量时间比较，避免按响应时间逐字符猜凭证。
    const matchesRelay = Boolean(current.relayToken) && Boolean(bearer) && safeEqual(bearer!, current.relayToken);
    const matchesOperator = Boolean(operatorToken) && Boolean(bearer) && safeEqual(bearer!, operatorToken);
    if (!matchesRelay && !matchesOperator) {
      throw new HttpError(401, "入站转发凭证无效：请使用 relay token 或 ZANE_ADMIN_TOKEN", "RELAY_TOKEN_INVALID");
    }
    return this.deliverRelay(input, current, contentType);
  }

  /** 管理员（网页/HTTP/MCP）用同一套转发逻辑：不需要 relay token，但同样只能发往已配置目标。 */
  async relayAsAdmin(input: unknown, authorize: () => void, contentType = ""): Promise<RelayReceipt> {
    authorize();
    const current = this.current();
    if (!current.url) throw new HttpError(409, "尚未配置目标 Webhook 地址", "NOTIFICATION_WEBHOOK_NOT_CONFIGURED");
    return this.deliverRelay(input, current, contentType);
  }

  private async deliverRelay(input: unknown, current: ReturnType<NotificationWebhookService["current"]>, contentType = ""): Promise<RelayReceipt> {
    // 外部调用方的形状不可控：纯文本、任意 JSON、表单、别家 webhook 载荷都归一成一段文本。
    // 只有「什么都提取不出」才拒绝，并且明确说明是空内容而不是格式不符。
    let normalized: RelayInput;
    try {
      normalized = readRelayPayload(input, contentType);
    } catch (error) {
      throw new HttpError(400, "转发内容为空：" + (error instanceof Error ? error.message : "无法从请求体提取文本"), "INVALID_RELAY_MESSAGE");
    }
    if (!current.url) throw new HttpError(409, "尚未配置目标 Webhook 地址", "NOTIFICATION_WEBHOOK_NOT_CONFIGURED");
    const attemptedAt = new Date().toISOString();
    const raw = normalized.title ? "**" + normalized.title + "**\n" + normalized.text : normalized.text;
    const limit = notificationMessageLimit(current.webhookFormat);
    const text = raw.length > limit ? raw.slice(0, limit) + "\n…（已截断）" : raw;
    const truncated = text.length !== raw.length;
    const event: NotificationEvent = {
      type: "relay.message", at: attemptedAt, runId: "00000000-0000-0000-0000-000000000000",
      sceneId: normalized.source ?? "relay", status: "completed",
    };
    const outcome = await this.sendWithText(current, text, [event]);
    this.stats.lastRelayAt = attemptedAt;
    if (outcome.ok) this.stats.relayedMessages += 1;
    else {
      this.stats.relayedFailed += 1;
      this.stats.lastError = outcome.error;
      log("warn", "notification.relay_failed", { target: maskNotificationWebhookUrl(current.url), status: outcome.status, error: outcome.error, source: normalized.source ?? "relay" });
    }
    return {
      format: "zane-studio.notification-relay/v1",
      relayed: outcome.ok,
      status: outcome.status,
      target: maskNotificationWebhookUrl(current.url),
      webhookFormat: current.webhookFormat,
      chars: text.length,
      truncated,
      attemptedAt,
      ...(outcome.ok ? {} : { error: outcome.error }),
    };
  }

  /** 手动测试走真实网络，但只发一条固定内容；失败返回结果而不是抛错，便于界面展示。 */
  async test(authorize: () => void): Promise<NotificationWebhookTestResult> {
    authorize();
    const current = this.current();
    if (!current.url) throw new HttpError(400, "尚未配置 Webhook 地址", "NOTIFICATION_WEBHOOK_NOT_CONFIGURED");
    const attemptedAt = new Date().toISOString();
    const event: NotificationEvent = {
      type: "notification.test", at: attemptedAt, runId: "00000000-0000-0000-0000-000000000000",
      sceneId: "test", status: "completed", runTitle: "工作台通知测试",
    };
    const outcome = await this.send(current, [event]);
    this.stats.lastAttemptAt = attemptedAt;
    if (outcome.ok) this.stats.lastSuccessAt = attemptedAt;
    else this.stats.lastError = outcome.error;
    return {
      format: NOTIFICATION_WEBHOOK_FORMAT,
      id: NOTIFICATION_WEBHOOK_ID,
      attempted: true,
      sent: outcome.ok,
      status: outcome.status,
      urlMasked: maskNotificationWebhookUrl(current.url),
      attemptedAt,
      ...(outcome.ok ? {} : { error: outcome.error }),
      nextAction: outcome.ok ? "get_notification_webhook" : "update_with_revision",
    };
  }

  /** RunService 的事件旁路：只做白名单过滤与入队，不做任何 I/O，绝不阻塞执行。 */
  observe(run: { runId: string; sceneId: string; status: string; runTitle?: string; workflowName?: string; error?: string; steps?: Array<{ stepId: string; name: string }> }, events: ReadonlyArray<{ type: string; at: string; stepId?: string; payload?: Record<string, unknown> }>) {
    if (this.closed) return;
    const current = this.current();
    if (!current.enabled || !current.url) return;
    const allowed = new Set(normalizeNotificationEvents(current.events));
    for (const event of events) {
      if (!isNotificationEventType(event.type) || !allowed.has(event.type)) continue;
      const step = event.stepId ? run.steps?.find(item => item.stepId === event.stepId) : undefined;
      const itemIndex = typeof event.payload?.index === "number" ? event.payload.index : undefined;
      this.pending.push({
        type: event.type,
        at: event.at,
        runId: run.runId,
        sceneId: run.sceneId,
        status: run.status,
        ...(run.runTitle ? { runTitle: run.runTitle } : {}),
        ...(run.workflowName ? { workflowName: run.workflowName } : {}),
        ...(event.stepId ? { stepId: event.stepId } : {}),
        ...(step?.name ? { stepName: step.name } : {}),
        ...(itemIndex === undefined ? {} : { itemIndex }),
        ...(run.error ? { error: run.error } : {}),
      });
    }
    while (this.pending.length > MAX_NOTIFICATION_PENDING_EVENTS) {
      this.pending.shift();
      this.stats.droppedEvents += 1;
    }
    this.stats.pendingEvents = this.pending.length;
    if (!this.timer && this.pending.length) this.schedule(current.aggregateSeconds);
  }

  private schedule(seconds: number) {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, Math.max(1, seconds) * 1000);
    this.timer.unref?.();
  }

  /** 窗口到期：一次取一批、按每消息上限切分顺序发送。
   *  某批失败即停止本轮，并明确计入 droppedEvents——目标持续失败时不会无限重试，
   *  也不会让内存队列无界增长；新事件会开启新的窗口。 */
  private async flush() {
    if (this.closed || this.flushing) return;
    this.flushing = this.deliver().finally(() => { this.flushing = undefined; });
    await this.flushing;
  }

  private async deliver() {
    const current = this.current();
    if (!current.enabled || !current.url) { this.stats.droppedEvents += this.pending.length; this.pending.length = 0; this.stats.pendingEvents = 0; return; }
    while (this.pending.length) {
      const batch = this.pending.splice(0, NOTIFICATION_EVENTS_PER_MESSAGE);
      this.stats.pendingEvents = this.pending.length;
      const outcome = await this.send(current, batch);
      this.stats.lastAttemptAt = new Date().toISOString();
      if (outcome.ok) {
        this.stats.deliveredMessages += 1;
        this.stats.deliveredEvents += batch.length;
        this.stats.lastSuccessAt = this.stats.lastAttemptAt;
        continue;
      }
      this.stats.failedMessages += 1;
      this.stats.droppedEvents += batch.length + this.pending.length;
      this.stats.lastError = outcome.error;
      log("warn", "notification.webhook_failed", { url: maskNotificationWebhookUrl(current.url), status: outcome.status, error: outcome.error, events: batch.length + this.pending.length });
      this.pending.length = 0;
      this.stats.pendingEvents = 0;
      break;
    }
  }

  private async send(config: { url: string; webhookFormat: NotificationWebhookFormat }, events: NotificationEvent[]): Promise<{ ok: boolean; status: number; error?: string }> {
    const text = formatMessage(events, notificationMessageLimit(config.webhookFormat));
    return this.sendWithText(config, text, events);
  }

  /** 平台无关的投递核心：正文已由调用方拼好，这里只负责按适配器出站、限流退避与错误归类。 */
  private async sendWithText(config: { url: string; webhookFormat: NotificationWebhookFormat }, text: string, events: NotificationEvent[]): Promise<{ ok: boolean; status: number; error?: string }> {
    const adapter = notificationFormatAdapter(config.webhookFormat);
    const payload = adapter.build(text, events);
    let lastStatus = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(config.url, {
          method: "POST",
          headers: { "Content-Type": payload.contentType },
          body: JSON.stringify(payload.body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        // 响应体必须消费，避免 keep-alive 连接停在不确定状态；限流响应体里通常带 retry_after。
        const raw = await response.text().catch(() => "");
        lastStatus = response.status;
        if (response.ok) return { ok: true, status: response.status };
        // 429 与 5xx 是平台侧可恢复的（限流/抖动）：按 Retry-After（秒或 JSON retry_after）退避后重试一次。
        // 其它 4xx 是确定性失败（地址失效、载荷被拒），重发只会更糟。
        const retryable = response.status >= 500 || response.status === 429;
        if (!retryable || attempt === MAX_ATTEMPTS) {
          const detail = response.status === 429 ? "（目标限流）" : "";
          return { ok: false, status: response.status, error: "目标返回 HTTP " + response.status + detail };
        }
        await delay(retryDelayMs(response.headers.get("retry-after"), raw));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === MAX_ATTEMPTS) return { ok: false, status: lastStatus, error: excerpt(message) };
        await delay(RETRY_DELAY_MS);
      }
    }
    return { ok: false, status: lastStatus, error: "投递失败" };
  }

  /** 关闭时做一次短促的尽力投递；不等待过久，也不让通知影响停机。 */
  async shutdown() {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.pending.length) return;
    const current = this.current();
    if (!current.enabled || !current.url) return;
    await Promise.race([
      this.deliver().catch(() => undefined),
      new Promise<void>(resolve => { const timer = setTimeout(resolve, 3_000); timer.unref?.(); }),
    ]);
  }

  /** 只读自检：当前白名单与格式，供 AI 首次使用前确认。 */
  supported() {
    return { events: [...DEFAULT_NOTIFICATION_EVENTS], formats: [...NOTIFICATION_WEBHOOK_FORMATS] };
  }
}
