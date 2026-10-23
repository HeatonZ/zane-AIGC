import {
  directLlmAnthropicMaxTokens, directLlmAnthropicVersion, directLlmEndpointSuffix, directLlmModelsSuffix, directLlmProtocolLabels,
  type DirectLlmProtocol,
} from "../domain/directLlm.js";
import { asRecord } from "../domain/workflowValues.js";

/** 与 Hermes 消息同形，但刻意不 import Hermes 传输模块的类型：直连路径不依赖 Hermes。 */
export type DirectLlmMessagePart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" } };
export type DirectLlmMessage = { role: "system" | "user"; content: string | DirectLlmMessagePart[] };

/** 一次协议请求的完整构造结果：URL、方法与请求头（密钥已内联，调用方不得记录它们）。 */
export interface DirectLlmProtocolRequest {
  url: string;
  method: "POST" | "GET";
  headers: Record<string, string>;
  body?: string;
}

function endpoint(baseUrl: string, suffix: string) {
  return baseUrl.replace(/\/+$/, "") + suffix;
}

export function directLlmCompletionUrl(protocol: DirectLlmProtocol, baseUrl: string) {
  return endpoint(baseUrl, directLlmEndpointSuffix[protocol]);
}
export function directLlmModelsUrl(baseUrl: string) {
  return endpoint(baseUrl, directLlmModelsSuffix);
}

/** 鉴权头按协议不同：OpenAI 兼容用 Authorization: Bearer，Anthropic 用 x-api-key。
 *  只有这里会接触密钥值，返回值不进入日志、错误消息或运行记录。 */
function authenticationHeaders(protocol: DirectLlmProtocol, apiKey: string): Record<string, string> {
  return protocol === "anthropic"
    ? { "x-api-key": apiKey, "anthropic-version": directLlmAnthropicVersion }
    : { Authorization: `Bearer ${apiKey}` };
}

/** 协议请求头里的鉴权字段名（用于契约自检；不含任何值）。 */
export function directLlmAuthenticationHeader(protocol: DirectLlmProtocol): string {
  return protocol === "anthropic" ? "x-api-key" : "Authorization";
}

const dataUrlPattern = /^data:([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*);base64,([a-z0-9+/=\s]+)$/i;

/** 把既有的 base64 data URL 拆成 Anthropic 的 image source 结构。
 *  这里只做拆分，不重新编码：编码、压缩与 10MB 预算全部复用 core.hermes 的既有构造。
 *  非 data URL 的 http(s) 图片交给 Anthropic 的 url source。 */
export function directLlmAnthropicImageSource(url: string): Record<string, unknown> {
  const match = dataUrlPattern.exec(url.trim());
  if (match) return { type: "base64", media_type: match[1]!.toLowerCase(), data: match[2]!.replace(/\s/g, "") };
  if (/^https?:\/\//i.test(url.trim())) return { type: "url", url: url.trim() };
  throw new Error("直连模型提供商（Anthropic）的图片附件必须是 base64 data URL 或 http(s) 地址");
}

/** 把中性的 system/user 消息映射成某个协议的请求体。
 *  Anthropic 把 system 提到顶层字段而不是 messages 条目，其余消息只能是 user/assistant。 */
function requestBody(protocol: DirectLlmProtocol, model: string, messages: readonly DirectLlmMessage[]): Record<string, unknown> {
  if (protocol === "openai-chat") {
    return {
      model,
      messages: messages.map((message) => ({
        role: message.role,
        content: typeof message.content === "string"
          ? message.content
          : message.content.map((part) => part.type === "text"
            ? { type: "text", text: part.text }
            : { type: "image_url", image_url: { url: part.image_url.url, detail: part.image_url.detail } }),
      })),
      stream: false,
    };
  }
  const system = messages.filter((message) => message.role === "system")
    .map((message) => typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"))
    .filter(Boolean).join("\n\n");
  const conversation = messages.filter((message) => message.role !== "system").map((message) => ({
    role: "user" as const,
    content: typeof message.content === "string"
      ? message.content
      : message.content.map((part) => part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image", source: directLlmAnthropicImageSource(part.image_url.url) }),
  }));
  return {
    model,
    max_tokens: directLlmAnthropicMaxTokens,
    ...(system ? { system } : {}),
    messages: conversation,
  };
}

export function buildDirectLlmCompletionRequest(protocol: DirectLlmProtocol, baseUrl: string, apiKey: string, model: string, messages: readonly DirectLlmMessage[]): DirectLlmProtocolRequest {
  return {
    url: directLlmCompletionUrl(protocol, baseUrl),
    method: "POST",
    headers: { "Content-Type": "application/json", ...authenticationHeaders(protocol, apiKey) },
    body: JSON.stringify(requestBody(protocol, model, messages)),
  };
}

export function buildDirectLlmModelsRequest(protocol: DirectLlmProtocol, baseUrl: string, apiKey: string): DirectLlmProtocolRequest {
  return { url: directLlmModelsUrl(baseUrl), method: "GET", headers: { Accept: "application/json", ...authenticationHeaders(protocol, apiKey) } };
}

/** OpenAI 兼容：choices[0].message.content。Anthropic：拼接全部 text 内容块。 */
export function directLlmCompletionText(protocol: DirectLlmProtocol, payload: unknown): string | undefined {
  const envelope = asRecord(payload);
  if (!envelope) return undefined;
  if (protocol === "openai-chat") {
    const choices = Array.isArray(envelope.choices) ? envelope.choices : [];
    const message = asRecord(asRecord(choices[0])?.message);
    return typeof message?.content === "string" ? message.content : undefined;
  }
  const blocks = Array.isArray(envelope.content) ? envelope.content : [];
  const texts = blocks.map((block) => {
    const record = asRecord(block);
    return record?.type === "text" && typeof record.text === "string" ? record.text : "";
  }).filter(Boolean);
  return texts.length ? texts.join("") : undefined;
}

/** 上游错误信封里的可读摘要（仍是不可信文本，调用方必须先脱敏再并入错误）。 */
export function directLlmUpstreamMessage(payload: unknown): string {
  const envelope = asRecord(payload);
  const apiError = asRecord(envelope?.error);
  for (const candidate of [apiError?.message, envelope?.message, envelope?.error]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

export class DirectLlmModelsUnsupportedError extends Error {
  constructor(public readonly protocol: DirectLlmProtocol, public readonly status?: number) {
    super(status
      ? `${directLlmProtocolLabels[protocol]} 该协议不支持列模型（上游返回 HTTP ${status}）`
      : `${directLlmProtocolLabels[protocol]} 该协议不支持列模型（上游响应里没有可识别的 data[].id 列表）`);
    this.name = "DirectLlmModelsUnsupportedError";
  }
}

/** 解析 /models 响应：两种协议都读 data[].id。
 *  上游明确没有该端点（404/405/501）或信封不可识别时必须失败，
 *  **不得**伪装成空列表 —— 那会让人以为「这个提供商真的没有模型」。
 *  真正返回 data: [] 是上游的明确回答，按空结果处理（缓存合并时不会丢掉手填项）。 */
export function parseDirectLlmModels(protocol: DirectLlmProtocol, status: number, payload: unknown): string[] {
  const envelope = asRecord(payload);
  const entries = Array.isArray(envelope?.data) ? envelope.data : undefined;
  if (status === 404 || status === 405 || status === 501) throw new DirectLlmModelsUnsupportedError(protocol, status);
  // 非 2xx 由调用方先处理；这里只兜住「2xx 但信封不可识别」。
  if (!entries) throw new DirectLlmModelsUnsupportedError(protocol);
  const models: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const record = asRecord(entry);
    const id = typeof entry === "string" ? entry : typeof record?.id === "string" ? record.id : typeof record?.name === "string" ? record.name : undefined;
    const trimmed = id?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    models.push(trimmed);
  }
  return models;
}
