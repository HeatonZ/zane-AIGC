import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { thirdPartyMediaConfig, thirdPartyMultipart, thirdPartyResponseImages, THIRD_PARTY_MEDIA_LIMITS } from "./thirdPartyMedia.js";
import { HttpError } from "../errors.js";
import type { JsonValue, RunStep } from "../domain/types.js";
import { resolveStepInputs } from "../domain/workflowValues.js";
import { isRuntimeMediaValue } from "../runtimeValue.js";
import { delayWithAbort } from "./cancellation.js";
import type { StepExecutionContext } from "./workflowExecutor.js";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const blockedHeaders = /^(?:host|content-length|transfer-encoding|connection|proxy-authorization|cookie|set-cookie|authorization|x-api-key|api-key|content-type)$/i;
const sensitiveQueryKey = /(?:key|token|secret|password|auth|signature|credential)/i;
const allowedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
/** Retries are an explicit trade-off: a resend can repeat third-party billing or state changes. */
const MAX_THIRD_PARTY_RETRIES = 5;
const MAX_THIRD_PARTY_RETRY_DELAY_SECONDS = 30;
const MAX_THIRD_PARTY_RETRY_DELAY_MS = 60_000;
/** Only failures an identical resend can plausibly fix; deterministic business errors never retry. */
const retryableThirdPartyStatuses = new Set([408, 429, 500, 502, 503, 504]);

export const THIRD_PARTY_JSON_REQUEST_CONTRACT = {
  version: "2",
  capabilityId: "core.http_request",
  request: {
    url: { type: "string", required: true, protocol: "http|https", port: "any", addressPolicy: "public addresses only; loopback, private, link-local and reserved literals or DNS results are rejected", redirects: "rejected", queryCredentials: "rejected", plaintextHttp: "allowed but sends credentials unencrypted; prefer HTTPS when available" },
    method: { type: "string", required: false, default: "POST", enum: allowedMethods },
    headers: { type: "object", required: false, default: {}, values: "non-sensitive strings", maximumEntries: 32 },
    apiKeyEnv: { type: "string", required: false, format: "^[A-Z][A-Z0-9_]{0,127}$", secretValueSource: "workbench_process_environment" },
    apiKeyHeader: { type: "string", required: false, default: "Authorization" },
    apiKeyPrefix: { type: "string", required: false, default: "Bearer " },
    bodyFormat: { type: "string", default: "json", enum: ["json", "multipart"] },
    multipartImages: { type: "array", default: [], items: { inputKey: "declared image input", fieldName: "multipart file field; repeated in source order" }, localFiles: "authorized current-run private copies only; no URL/preview fallback", limits: THIRD_PARTY_MEDIA_LIMITS },
    responseImages: { type: "object", required: false, fields: { path: "JSON path to array; default data", base64Field: "default b64_json", expectedCount: "optional integer 1..16" }, output: "images:image_list; validated local PNG/JPEG/WebP; base64 replaced with explicit omission marker", responseMaximumBytes: THIRD_PARTY_MEDIA_LIMITS.responseBytes },
    bodyTemplate: { type: "object|array", required: false, placeholder: "{{declaredInputKey}}", maximumBytes: MAX_REQUEST_BYTES, getBody: "rejected" },
    timeoutSeconds: { type: "integer", required: false, default: 120, minimum: 1, maximum: 600 },
    retries: { type: "integer", required: false, default: 0, minimum: 0, maximum: MAX_THIRD_PARTY_RETRIES, description: "additional attempts after the first failure; omitted or 0 keeps exactly one request" },
    retryDelaySeconds: { type: "integer", required: false, default: 2, minimum: 0, maximum: MAX_THIRD_PARTY_RETRY_DELAY_SECONDS, description: "base delay before each retry; exponential backoff doubling per retry and capped at 60 seconds" },
  },
  response: { status: "2xx required", outputs: { response: "optional declared output; JSON value, or UTF-8 text for non-JSON; null for empty; mapped base64 explicitly omitted", status: "optional declared output; HTTP status number", images: "optional image_list when responseImages configured; declare it alone for image-only scenes" }, maximumBytes: MAX_RESPONSE_BYTES },
  errors: ["INVALID_HTTP_REQUEST_CONFIG", "INVALID_HTTP_REQUEST_INPUT", "HTTP_REQUEST_MEDIA_UNSUPPORTED", "HTTP_REQUEST_BODY_TOO_LARGE", "THIRD_PARTY_HOST_NOT_PUBLIC", "THIRD_PARTY_CREDENTIAL_MISSING", "THIRD_PARTY_CREDENTIAL_INVALID", "THIRD_PARTY_REQUEST_TIMEOUT", "THIRD_PARTY_HTTP_ERROR", "THIRD_PARTY_REQUEST_FAILED", "THIRD_PARTY_RESPONSE_TOO_LARGE", "INVALID_THIRD_PARTY_JSON", "INVALID_THIRD_PARTY_IMAGE"],
  sideEffects: { prepare: "none", publish: "none", execute: "one request per attempt; may incur third-party cost or mutate third-party state", automaticRetries: "opt-in through retries; resends the identical request only after network failures, timeouts or HTTP 408/429/500/502/503/504, so a lost acknowledgement can repeat third-party billing or state changes" },
} as const;

type Address = { address: string; family: number };
export interface ThirdPartyHttpResponse { status: number; contentType: string; body: Uint8Array }
export interface ThirdPartyHttpTransport {
  resolve(hostname: string): Promise<Address[]>;
  send(request: { url: URL; method: string; headers: Record<string, string>; body?: Buffer; addresses: Address[]; signal: AbortSignal; maxResponseBytes?: number }): Promise<ThirdPartyHttpResponse>;
}

const invalidConfig = (message: string): never => { throw new HttpError(400, message, "INVALID_HTTP_REQUEST_CONFIG"); };
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

function ipv4Number(value: string) {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!) >>> 0;
}
function inIpv4Range(address: number, network: string, prefix: number) {
  const start = ipv4Number(network)!;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (start & mask);
}
function isPublicAddress(value: string, family: number) {
  if (family === 4 || isIP(value) === 4) {
    const address = ipv4Number(value);
    if (address === undefined) return false;
    const nonPublic: Array<[string, number]> = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["168.63.129.16", 32], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
      ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !nonPublic.some(([network, prefix]) => inIpv4Range(address, network, prefix));
  }
  if (family !== 6 || isIP(value) !== 6) return false;
  const normalized = value.toLowerCase().split("%", 1)[0]!;
  // Global unicast is 2000::/3. This excludes unspecified, loopback, mapped,
  // link-local, unique-local, multicast, transition and documentation ranges.
  const compressed = normalized.split("::");
  const left = compressed[0] ? compressed[0]!.split(":") : [];
  const right = compressed.length > 1 && compressed[1] ? compressed[1]!.split(":") : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right].map(group => Number.parseInt(group, 16));
  if (groups.length !== 8 || (groups[0]! & 0xe000) !== 0x2000) return false;
  if ((groups[0] === 0x2001 && (groups[1]! <= 0x01ff || groups[1] === 0x0db8)) || groups[0] === 0x2002 || (groups[0] === 0x3fff && (groups[1]! & 0xf000) === 0)) return false;
  return true;
}

/** Fixed endpoint policy: any public HTTP/HTTPS address and port is accepted, but the target must
 * never be loopback, private, link-local or otherwise reserved. Literal addresses are checked
 * here; hostnames are re-checked against every resolved address before sending, so a name that
 * resolves into an internal network is rejected instead of requested. */
export function validateThirdPartyEndpoint(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) invalidConfig("第三方地址必须是有效的HTTP/HTTPS URL");
  let url: URL;
  try { url = new URL(value as string); } catch { return invalidConfig("第三方地址必须是有效的HTTP/HTTPS URL"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "https:" && url.protocol !== "http:") invalidConfig("第三方地址仅支持HTTP/HTTPS协议");
  if (url.port && Number(url.port) < 1) invalidConfig("第三方地址端口无效");
  if (url.username || url.password || url.hash) invalidConfig("第三方地址不能包含凭据或片段");
  const literal = isIP(hostname);
  if (literal ? !isPublicAddress(hostname, literal) : !hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(hostname)) invalidConfig(literal ? "第三方IP不能指向本机、内网或保留地址" : "第三方地址必须使用公网域名或公网IP，不能使用本机/内网域名");
  for (const key of url.searchParams.keys()) if (sensitiveQueryKey.test(key) || /(?:api[-_]?key|access[-_]?token|password|secret|credential)/i.test(key)) invalidConfig("鉴权信息不能放在URL查询参数中");
  return url;
}

function validateTemplate(value: unknown, inputKeys: Set<string>, depth = 0): void {
  if (depth > 32) invalidConfig("JSON请求正文嵌套过深");
  if (typeof value === "string") {
    const matches = [...value.matchAll(/\{\{([^{}]+)\}\}/g)];
    const remainder = value.replace(/\{\{[^{}]+\}\}/g, "");
    if (remainder.includes("{{") || remainder.includes("}}")) invalidConfig("JSON请求正文占位符格式无效");
    for (const match of matches) {
      const key = match[1]!.trim();
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) || !inputKeys.has(key)) invalidConfig("JSON请求正文只能引用已声明的步骤输入");
    }
    return;
  }
  if (Array.isArray(value)) { for (const item of value) validateTemplate(item, inputKeys, depth + 1); return; }
  const object = record(value);
  if (object) for (const item of Object.values(object)) validateTemplate(item, inputKeys, depth + 1);
  else if (value !== null && typeof value !== "number" && typeof value !== "boolean") invalidConfig("JSON请求正文包含不支持的值");
}

export function validateThirdPartyRequestStep(step: RunStep) {
  thirdPartyMediaConfig(step);
  const config = step.capabilityConfig ?? {};
  validateThirdPartyEndpoint(config.url);
  if (!allowedMethods.includes((config.method ?? "POST") as typeof allowedMethods[number])) invalidConfig("请求方法无效");
  const inputKeys = new Set((step.inputs ?? []).map(input => input.key));
  const headers = record(config.headers);
  if (config.headers !== undefined && !headers) invalidConfig("附加请求头必须是JSON对象");
  const safeHeaders = headers ?? {};
  if (Object.entries(safeHeaders).length > 32) invalidConfig("附加请求头最多32项");
  for (const [name, value] of Object.entries(safeHeaders)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || blockedHeaders.test(name) || /(?:token|secret|password|credential|auth|api[-_]?key)/i.test(name)) invalidConfig("附加请求头不能包含鉴权、Cookie或传输控制字段");
    if (typeof value !== "string" || value.length > 4096 || /[\r\n]/.test(value)) invalidConfig("附加请求头值必须是短文本且不能包含换行");
  }
  if (config.apiKeyEnv !== undefined && config.apiKeyEnv !== "" && (typeof config.apiKeyEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(config.apiKeyEnv))) invalidConfig("API密钥环境变量名无效");
  if (config.apiKeyHeader !== undefined && (typeof config.apiKeyHeader !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(config.apiKeyHeader) || /[\r\n]/.test(config.apiKeyHeader) || /^(?:host|content-length|transfer-encoding|connection|proxy-authorization|cookie|set-cookie|content-type)$/i.test(config.apiKeyHeader))) invalidConfig("API密钥请求头名称无效");
  if (config.apiKeyPrefix !== undefined && (typeof config.apiKeyPrefix !== "string" || config.apiKeyPrefix.length > 128 || /[\r\n]/.test(config.apiKeyPrefix))) invalidConfig("API密钥前缀无效");
  if (config.apiKeyEnv && Object.keys(safeHeaders).some(name => name.toLowerCase() === String(config.apiKeyHeader ?? "Authorization").toLowerCase())) invalidConfig("密钥请求头不能重复配置在附加请求头中");
  const timeoutSeconds = config.timeoutSeconds ?? 120;
  if (typeof timeoutSeconds !== "number" || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) invalidConfig("请求超时必须是1到600秒的整数");
  thirdPartyRetryPlan(config);
  if (config.bodyTemplate !== undefined && config.bodyTemplate !== null) {
    if (!record(config.bodyTemplate) && !Array.isArray(config.bodyTemplate)) invalidConfig("JSON请求正文必须是对象或数组");
    if ((config.method ?? "POST") === "GET") invalidConfig("GET请求不能配置JSON正文");
    let serialized: string;
    try { serialized = JSON.stringify(config.bodyTemplate); } catch { return invalidConfig("JSON请求正文无效"); }
    if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) invalidConfig("JSON请求正文模板最多256KB");
    validateTemplate(config.bodyTemplate, inputKeys);
  }
}

function isSafeJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32 || isRuntimeMediaValue(value)) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isSafeJsonValue(item, depth + 1));
  const object = record(value);
  return Boolean(object && Object.values(object).every(item => isSafeJsonValue(item, depth + 1)));
}

function renderTemplate(value: JsonValue, inputs: Record<string, JsonValue>): JsonValue {
  if (typeof value === "string") {
    const exact = /^\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}$/.exec(value);
    if (exact) {
      const result = inputs[exact[1]!];
      if (result === undefined) throw new HttpError(400, "第三方请求缺少模板输入：" + exact[1], "INVALID_HTTP_REQUEST_INPUT");
      if (!isSafeJsonValue(result)) throw new HttpError(400, "第三方请求不能直接发送本地媒体引用", "HTTP_REQUEST_MEDIA_UNSUPPORTED");
      return structuredClone(result);
    }
    return value.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_match, key: string) => {
      const result = inputs[key];
      if (result === undefined) throw new HttpError(400, "第三方请求缺少模板输入：" + key, "INVALID_HTTP_REQUEST_INPUT");
      if (result === null || typeof result === "object") throw new HttpError(400, "嵌入文本的模板输入必须是文本、数字或布尔值", "INVALID_HTTP_REQUEST_INPUT");
      return String(result);
    });
  }
  if (Array.isArray(value)) return value.map(item => renderTemplate(item, inputs));
  const object = record(value);
  if (object) return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, renderTemplate(item as JsonValue, inputs)])) as Record<string, JsonValue>;
  return value;
}

/** Request options follow the validated URL so plain HTTP endpoints and explicit ports work. */
export function thirdPartyRequestOptions(url: URL, method: string, headers: Record<string, string>, lookup: NonNullable<RequestOptions["lookup"]>, signal: AbortSignal): RequestOptions {
  return { hostname: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), path: url.pathname + url.search, method, headers, lookup, signal };
}

export const nodeTransport: ThirdPartyHttpTransport = {
  async resolve(hostname) {
    return await dnsLookup(hostname, { all: true, verbatim: true });
  },
  async send({ url, method, headers, body, addresses, signal, maxResponseBytes = MAX_RESPONSE_BYTES }) {
    const pinnedLookup = ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
      const requestOptions = record(options);
      const selected = addresses.find(address => !requestOptions?.family || requestOptions.family === address.family);
      if (!selected) { callback(Object.assign(new Error("DNS resolution failed"), { code: "ENOTFOUND" })); return; }
      if (requestOptions?.all) callback(null, addresses);
      else callback(null, selected.address, selected.family);
    }) as unknown as NonNullable<RequestOptions["lookup"]>;
    return await new Promise<ThirdPartyHttpResponse>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
      const onResponse = (response: IncomingMessage) => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > maxResponseBytes) { response.destroy(new HttpError(502, "第三方响应超过配置模式的大小限制", "THIRD_PARTY_RESPONSE_TOO_LARGE")); return; }
          chunks.push(bytes);
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({ status: response.statusCode ?? 0, contentType: String(response.headers["content-type"] ?? ""), body: Buffer.concat(chunks) });
        });
        response.on("error", fail);
      };
      const requestOptions = thirdPartyRequestOptions(url, method, headers, pinnedLookup, signal);
      const request = url.protocol === "https:" ? httpsRequest(requestOptions, onResponse) : httpRequest(requestOptions, onResponse);
      request.on("error", fail);
      if (body) request.write(body);
      request.end();
    });
  },
};

function isPrivateDnsResult(addresses: Address[]) { return !addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address, family)); }

function parseResponse(response: ThirdPartyHttpResponse, maxResponseBytes = MAX_RESPONSE_BYTES): JsonValue {
  if (response.body.byteLength > maxResponseBytes) throw new HttpError(502, "第三方响应超过配置模式的大小限制", "THIRD_PARTY_RESPONSE_TOO_LARGE");
  const text = Buffer.from(response.body).toString("utf8");
  if (!text) return null;
  if (/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(response.contentType)) {
    try { return JSON.parse(text) as JsonValue; }
    catch { throw new HttpError(502, "第三方接口返回了无效JSON", "INVALID_THIRD_PARTY_JSON"); }
  }
  return text;
}

/** One attempt: resolve, validate, send and parse. Errors are normalized here so the retry decision
 * depends only on stable codes, never on transport internals that could leak a URL or credentials. */
async function sendThirdPartyAttempt(context: StepExecutionContext, transport: ThirdPartyHttpTransport, url: URL, method: string): Promise<Record<string, JsonValue>> {
  const config = context.step.capabilityConfig ?? {};
  const timeoutSignal = AbortSignal.timeout(Number(config.timeoutSeconds ?? 120) * 1000);
  const signal = AbortSignal.any([context.signal, timeoutSignal]);
  try {
    if (context.signal.aborted) throw context.signal.reason ?? new Error("已取消");
    let abortListener: (() => void) | undefined;
    const resolved = await Promise.race([
      transport.resolve(url.hostname),
      new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(signal.reason);
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]).finally(() => { if (abortListener) signal.removeEventListener("abort", abortListener); });
    if (context.signal.aborted) throw context.signal.reason ?? new Error("已取消");
    if (timeoutSignal.aborted) throw new HttpError(504, "第三方请求超时", "THIRD_PARTY_REQUEST_TIMEOUT");
    if (isPrivateDnsResult(resolved)) throw new HttpError(400, "第三方地址解析到非公网IP，已拒绝请求", "THIRD_PARTY_HOST_NOT_PUBLIC");
    const headers: Record<string, string> = { accept: "application/json, text/plain", "content-type": "application/json" };
    const customHeaders = record(config.headers) ?? {};
    for (const [name, value] of Object.entries(customHeaders)) headers[name] = String(value);
    const environmentName = typeof config.apiKeyEnv === "string" ? config.apiKeyEnv : "";
    if (environmentName) {
      const secret = process.env[environmentName];
      if (!secret) throw new HttpError(409, "工作台服务未配置此第三方API密钥环境变量", "THIRD_PARTY_CREDENTIAL_MISSING");
      if (secret.length > 8192 || /[\r\n]/.test(secret)) throw new HttpError(409, "第三方API密钥环境变量格式无效", "THIRD_PARTY_CREDENTIAL_INVALID");
      const header = String(config.apiKeyHeader ?? "Authorization");
      const prefix = String(config.apiKeyPrefix ?? "Bearer ");
      headers[header] = prefix + secret;
    }
    const mediaConfig = thirdPartyMediaConfig(context.step);
    let body: Buffer | undefined;
    if (mediaConfig.bodyFormat === "multipart" || config.bodyTemplate != null) {
      const inputs = resolveStepInputs(context.step, context.inputValues, context.stepValues) as Record<string, JsonValue>;
      const rendered = renderTemplate((config.bodyTemplate ?? {}) as JsonValue, inputs);
      if (Buffer.byteLength(JSON.stringify(rendered), "utf8") > MAX_REQUEST_BYTES) throw new HttpError(400, "渲染后的表单字段/JSON正文超过256KB", "HTTP_REQUEST_BODY_TOO_LARGE");
      if (mediaConfig.bodyFormat === "multipart") {
        const multipart = await thirdPartyMultipart(context, rendered, inputs, signal);
        body = multipart.body; headers["content-type"] = multipart.contentType;
      } else body = Buffer.from(JSON.stringify(rendered), "utf8");
      headers["content-length"] = String(body.byteLength);
    }
    signal.throwIfAborted();
    const maxResponseBytes = mediaConfig.responseImages ? THIRD_PARTY_MEDIA_LIMITS.responseBytes : MAX_RESPONSE_BYTES;
    const response = await transport.send({ url, method, headers, ...(body ? { body } : {}), addresses: resolved, signal, maxResponseBytes });
    if (context.signal.aborted) throw context.signal.reason ?? new Error("已取消");
    if (timeoutSignal.aborted) throw new HttpError(504, "第三方请求超时", "THIRD_PARTY_REQUEST_TIMEOUT");
    if (response.status < 200 || response.status >= 300) throw new HttpError(502, "第三方接口返回HTTP " + response.status, "THIRD_PARTY_HTTP_ERROR", { status: response.status });
    return { ...await thirdPartyResponseImages(context, parseResponse(response, maxResponseBytes), signal), status: response.status };
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason ?? error;
    if (timeoutSignal.aborted) throw new HttpError(504, "第三方请求超时", "THIRD_PARTY_REQUEST_TIMEOUT");
    if (error instanceof HttpError) throw error;
    // Avoid persisting transport errors that may contain a URL or request details.
    throw new HttpError(502, "第三方HTTPS请求失败", "THIRD_PARTY_REQUEST_FAILED");
  }
}

/** Additional attempts after the first failure; bounded so a run slot cannot be retried forever. */
function thirdPartyRetries(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_THIRD_PARTY_RETRIES) return value;
  return invalidConfig(`重试次数必须是0到${MAX_THIRD_PARTY_RETRIES}的整数`);
}

/** Base wait before the first retry; thirdPartyRetryDelayMs doubles and caps later waits. */
function thirdPartyRetryDelaySeconds(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_THIRD_PARTY_RETRY_DELAY_SECONDS) return value;
  return invalidConfig(`重试间隔必须是0到${MAX_THIRD_PARTY_RETRY_DELAY_SECONDS}秒的整数`);
}

/** Retries stay opt-in so a published snapshot without them keeps exactly one request. */
export function thirdPartyRetryPlan(config: Record<string, unknown>) {
  return { retries: thirdPartyRetries(config.retries ?? 0), delayMs: thirdPartyRetryDelaySeconds(config.retryDelaySeconds ?? 2) * 1000 };
}

/** Exponential backoff for the 1-based retry number; every wait stays bounded and abortable. */
export function thirdPartyRetryDelayMs(retry: number, delayMs: number) {
  return Math.min(MAX_THIRD_PARTY_RETRY_DELAY_MS, Math.max(0, delayMs) * (2 ** Math.max(0, retry - 1)));
}

/** Network failures, timeouts and transient statuses are retried; anything else fails as-is. */
export function isRetryableThirdPartyFailure(error: unknown) {
  if (!(error instanceof HttpError)) return false;
  if (error.code === "THIRD_PARTY_REQUEST_FAILED" || error.code === "THIRD_PARTY_REQUEST_TIMEOUT") return true;
  const status = error.details?.status;
  return typeof status === "number" && retryableThirdPartyStatuses.has(status);
}

export function createThirdPartyJsonRequester(transport: ThirdPartyHttpTransport = nodeTransport) {
  return async function requestThirdPartyJson(context: StepExecutionContext): Promise<Record<string, JsonValue>> {
    validateThirdPartyRequestStep(context.step);
    const config = context.step.capabilityConfig ?? {};
    const url = validateThirdPartyEndpoint(config.url);
    const method = String(config.method ?? "POST");
    const { retries, delayMs } = thirdPartyRetryPlan(config);
    for (let attempt = 0; ; attempt += 1) {
      try {
        if (context.signal.aborted) throw context.signal.reason ?? new Error("已取消");
        if (attempt > 0) await delayWithAbort(thirdPartyRetryDelayMs(attempt, delayMs), context.signal);
        return await sendThirdPartyAttempt(context, transport, url, method);
      } catch (error) {
        // A cancelled user run never retries, and the final failure is reported unchanged.
        if (context.signal.aborted) throw context.signal.reason ?? error;
        const retrying = attempt < retries && isRetryableThirdPartyFailure(error);
        if (retrying) {
          const waitSeconds = Math.round(thirdPartyRetryDelayMs(attempt + 1, delayMs) / 1000);
          const reason = error instanceof HttpError ? error.message : "第三方请求失败";
          await context.warn?.(`第三方接口第${attempt + 1}次请求失败：${reason}；${waitSeconds}秒后重试第${attempt + 2}次请求`);
        }
        if (!retrying) throw error;
      }
    }
  };
}

export const executeThirdPartyJsonRequest = createThirdPartyJsonRequester();
