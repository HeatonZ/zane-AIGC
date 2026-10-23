import { directLlmModelsSuffix, type DirectLlmProtocol } from "../domain/directLlm.js";
import { asRecord } from "../domain/workflowValues.js";
import { redactErrorText } from "../security/errorHandler.js";
import { workflowTimeoutLabel } from "../config.js";
import { cancellationError, throwIfAborted } from "./cancellation.js";
import { describeHermesError } from "../hermesTransport.js";
import { log } from "../observability/logger.js";
import {
  buildDirectLlmModelsRequest, buildDirectLlmCompletionRequest, directLlmCompletionText,
  directLlmUpstreamMessage, parseDirectLlmModels, DirectLlmModelsUnsupportedError, type DirectLlmMessage,
} from "./directLlmProtocol.js";

export type { DirectLlmMessage, DirectLlmMessagePart } from "./directLlmProtocol.js";

/** 直连所需的最小配置。apiKey 是运行时已解析出的**明文密钥**（提供商保存的明文，或回退自
 *  apiKeyEnv 指向的环境变量）；它只在本模块内用于构造鉴权头，绝不进入日志、错误消息、
 *  运行记录、运行输入归档或接口响应。 */
export interface DirectLlmRequestOptions {
  providerId: string;
  protocol: DirectLlmProtocol;
  baseUrl: string;
  /** 明文密钥；空串表示还没解析到密钥（由 resolveApiKey 按 apiKeyEnv 回退或明确失败）。 */
  apiKey: string;
  apiKeyEnv: string;
  model: string;
}

/** 响应体上限：提供商返回异常大内容时明确失败，而不是把 worker 的内存交给上游。 */
const directLlmResponseLimit = 32 * 1024 * 1024;
const environmentSecretLimit = 8192;

const settingsHint = "请在「集成连接 → 直连模型提供商」维护该提供商";

/**
 * 解析本次请求要用的密钥：优先用提供商保存的明文 apiKey；否则回退读取 apiKeyEnv 指向的
 * 工作台服务进程环境变量。返回值只在请求构造与上游错误脱敏时使用，绝不进入日志或响应。
 */
function resolveApiKey(options: Pick<DirectLlmRequestOptions, "apiKey" | "apiKeyEnv" | "providerId">) {
  if (options.apiKey) return options.apiKey;
  const apiKeyEnv = options.apiKeyEnv;
  if (!apiKeyEnv) throw new Error(`直连模型提供商「${options.providerId}」未配置 API 密钥；${settingsHint}直接填写 API 密钥，或填写环境变量名并在工作台服务进程环境中提供它的值`);
  const secret = process.env[apiKeyEnv];
  if (!secret) throw new Error(`直连模型提供商「${options.providerId}」未配置 API 密钥：既未保存明文密钥，工作台服务进程环境也不存在环境变量 ${apiKeyEnv}。请在页面上直接填写密钥，或在该进程中设置该环境变量并重启工作台`);
  if (secret.length > environmentSecretLimit || /[\r\n]/.test(secret)) throw new Error("直连模型提供商环境变量 " + apiKeyEnv + " 的值格式无效");
  return secret;
}

/** 密钥来源的中文说明（只描述来源，不含任何密钥内容）。 */
function credentialLabel(options: Pick<DirectLlmRequestOptions, "apiKey" | "apiKeyEnv">) {
  if (options.apiKey) return "页面上保存的明文密钥";
  return options.apiKeyEnv ? `环境变量 ${options.apiKeyEnv}` : "未配置的密钥";
}

/** 读取响应体并解析 JSON；超过上限时明确失败。 */
async function readPayload(response: Response) {
  const text = await response.text();
  if (text.length > directLlmResponseLimit) throw new Error("直连模型提供商响应超过 32 MB 上限，已拒绝解析");
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

/** 上游消息属于不可信文本：先脱敏再并入错误，避免它夹带凭证或 URL。
 *  另外显式抹掉本次实际使用的密钥：上游经常把收到的 key 原样回显，
 *  而那时它前面没有 apiKey/Bearer 之类的标签，通用规则认不出来。 */
function upstreamSummary(status: number, payload: unknown, apiKey: string) {
  const upstream = directLlmUpstreamMessage(payload);
  const base = upstream ? redactErrorText(upstream) : "HTTP " + status;
  const scrubbed = apiKey.length >= 8 ? base.split(apiKey).join("[REDACTED]") : base;
  return scrubbed.slice(0, 600);
}

/**
 * 直连模型的单次补全：一次 POST，无重试。
 * 聊天补全不是幂等操作，重发可能让上游重复计费，所以这里与 Hermes 网关的
 * /v1/runs 准入不同：失败即失败，由调用方对账后显式重做。
 *
 * 协议不同只改变 URL、鉴权头与请求/响应形状（见 directLlmProtocol.ts）；
 * 超时、取消、脱敏、错误文案与「不重试」在这里统一处理。
 */
export async function requestDirectLlmCompletion(options: DirectLlmRequestOptions, messages: DirectLlmMessage[], timeoutMs: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  if (!options.baseUrl) throw new Error(`直连模型提供商「${options.providerId}」未配置服务地址；${settingsHint}`);
  if (!options.model) throw new Error(`直连模型提供商「${options.providerId}」未配置模型名；${settingsHint}填写模型，或在步骤里选择模型`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }
  let apiKey = "";
  try {
    apiKey = resolveApiKey(options);
    const request = buildDirectLlmCompletionRequest(options.protocol, options.baseUrl, apiKey, options.model, messages);
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal: controller.signal });
    const payload = await readPayload(response);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error(`直连模型提供商「${options.providerId}」认证失败（使用的是${credentialLabel(options)}）：请核对这份密钥是否有效`);
      throw new Error(`直连模型提供商「${options.providerId}」请求失败：${upstreamSummary(response.status, payload, apiKey)}`);
    }
    const content = directLlmCompletionText(options.protocol, payload);
    if (typeof content !== "string") throw new Error(`直连模型提供商「${options.providerId}」没有返回文本内容`);
    return content;
  } catch (error) {
    if (signal?.aborted) throw cancellationError();
    if (error instanceof Error && error.name === "AbortError") throw new Error(`直连模型提供商请求超时（单步上限 ${workflowTimeoutLabel(timeoutMs / 60 / 1000)}）`);
    if (error instanceof TypeError) {
      const details = describeHermesError(error);
      // 记录里只放地址与协议，不放任何请求头（鉴权头在其中），也不放密钥。
      log("error", "direct_llm.request_failed", { providerId: options.providerId, protocol: options.protocol, baseUrl: options.baseUrl, errorName: details.name, errorMessage: scrubSecret(details.message, apiKey), ...(details.code ? { code: details.code } : {}) });
      const detail = [details.code, details.causeMessage, details.message].filter((item, index, items): item is string => Boolean(item) && items.indexOf(item) === index).join(" / ");
      throw new Error(`直连模型提供商网络连接失败（${options.baseUrl}）：${scrubSecret(detail, apiKey) || "未知网络错误"}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

/** 网络错误文本里可能夹带完整请求 URL；密钥一旦被上游回显也必须抹掉。 */
function scrubSecret(text: string, apiKey: string) {
  return apiKey.length >= 8 ? text.split(apiKey).join("[REDACTED]") : text;
}

/** 查询可用模型的结果：上游返回的模型 ID 列表。失败一律抛错（含上游状态码与脱敏摘要），
 *  **不返回空数组**冒充成功。 */
export interface DirectLlmModelQueryResult { fetched: string[] }

/**
 * 直连模型提供商的 GET /models：一次请求、不重试。
 * 上游明确没有该端点时按「该协议不支持列模型」失败，而不是把 404 当成空列表。
 */
export async function requestDirectLlmModels(options: Omit<DirectLlmRequestOptions, "model">, timeoutMs: number, signal?: AbortSignal): Promise<DirectLlmModelQueryResult> {
  throwIfAborted(signal);
  if (!options.baseUrl) throw new Error(`直连模型提供商「${options.providerId}」未配置服务地址；${settingsHint}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }
  let apiKey = "";
  try {
    apiKey = resolveApiKey(options);
    const request = buildDirectLlmModelsRequest(options.protocol, options.baseUrl, apiKey);
    const response = await fetch(request.url, { method: request.method, headers: request.headers, signal: controller.signal });
    const payload = await readPayload(response);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(`直连模型提供商「${options.providerId}」认证失败（使用的是${credentialLabel(options)}）：请核对这份密钥是否有效`);
      }
      // 404/405/501 是「上游没有这个端点」的明确回答：报「该协议不支持列模型」。
      // 其它非 2xx 一律带状态码与脱敏摘要失败，不能因为信封看着像模型列表就当成成功。
      if (response.status === 404 || response.status === 405 || response.status === 501) {
        throw new DirectLlmModelsUnsupportedError(options.protocol, response.status);
      }
      throw new Error(`直连模型提供商「${options.providerId}」查询模型失败：${upstreamSummary(response.status, payload, apiKey)}`);
    }
    return { fetched: parseDirectLlmModels(options.protocol, response.status, payload) };
  } catch (error) {
    if (signal?.aborted) throw cancellationError();
    if (error instanceof Error && error.name === "AbortError") throw new Error(`直连模型提供商查询模型超时（单步上限 ${workflowTimeoutLabel(timeoutMs / 60 / 1000)}）`);
    if (error instanceof TypeError) {
      const details = describeHermesError(error);
      log("error", "direct_llm.models_failed", { providerId: options.providerId, protocol: options.protocol, baseUrl: options.baseUrl, endpoint: directLlmModelsSuffix, errorName: details.name, errorMessage: scrubSecret(details.message, apiKey), ...(details.code ? { code: details.code } : {}) });
      const detail = [details.code, details.causeMessage, details.message].filter((item, index, items): item is string => Boolean(item) && items.indexOf(item) === index).join(" / ");
      throw new Error(`直连模型提供商查询模型失败：网络连接失败（${options.baseUrl}）：${scrubSecret(detail, apiKey) || "未知网络错误"}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

/** 从非 2xx 响应里取脱敏摘要（供服务层在写错误消息时复用）。 */
export { upstreamSummary as directLlmUpstreamSummary, asRecord as directLlmAsRecord };
