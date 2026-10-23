import { NOTIFICATION_MESSAGE_CHARS, type NotificationEvent, type NotificationWebhookFormat } from "./notificationWebhook.js";

/**
 * 通知中间层的「目标平台适配器」：聚合层只产出统一文本与事件数组，各平台差异
 * （载荷结构、提及策略、正文上限）集中在这里，新增平台不需要改投递与聚合逻辑。
 */
export interface NotificationPayload { contentType: string; body: unknown }
export interface NotificationFormatAdapter {
  id: NotificationWebhookFormat;
  label: string;
  /** 平台单条正文上限（字符）；聚合层取它与全局上限的较小值。 */
  maxChars: number;
  build(text: string, events: NotificationEvent[]): NotificationPayload;
}

const json: Pick<NotificationPayload, "contentType"> = { contentType: "application/json" };

export const NOTIFICATION_FORMAT_ADAPTERS: Record<NotificationWebhookFormat, NotificationFormatAdapter> = {
  // Discord：content 最多 2000 字符；显式禁用提及解析，标题里的 @everyone 不会触发。
  discord: {
    id: "discord", label: "Discord", maxChars: 1900,
    build: text => ({ ...json, body: { content: text, allowed_mentions: { parse: [] } } }),
  },
  // Slack Incoming Webhook：只发 text，关闭链接/媒体预览避免刷屏。
  slack: {
    id: "slack", label: "Slack", maxChars: 2900,
    build: text => ({ ...json, body: { text, unfurl_links: false, unfurl_media: false } }),
  },
  // 飞书/Lark 自定义机器人：msg_type=text + content.text。
  feishu: {
    id: "feishu", label: "飞书自定义机器人", maxChars: 3500,
    build: text => ({ ...json, body: { msg_type: "text", content: { text } } }),
  },
  // 通用 JSON：给自建接收端，保留结构化事件数组。
  generic: {
    id: "generic", label: "通用 JSON", maxChars: NOTIFICATION_MESSAGE_CHARS,
    build: (text, events) => ({ ...json, body: { source: "zane-workbench", text, events } }),
  },
};

export function notificationFormatAdapter(format: NotificationWebhookFormat): NotificationFormatAdapter {
  return NOTIFICATION_FORMAT_ADAPTERS[format];
}

/** 聚合层实际使用的正文上限：平台上限与全局上限取小。 */
export function notificationMessageLimit(format: NotificationWebhookFormat): number {
  return Math.min(NOTIFICATION_MESSAGE_CHARS, notificationFormatAdapter(format).maxChars);
}
