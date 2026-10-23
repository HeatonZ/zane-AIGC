import * as z from "zod/v4";

/** 直连模型提供商注册表：core.llm 的第二条执行路径，**完全不经过 Hermes 网关**。
 *
 *  API 密钥有两种来源，优先级明确：提供商保存的明文 apiKey 非空则用它，否则回退 apiKeyEnv
 *  （值在工作台服务进程环境里读）。明文密钥是用户明确选择的存储方式：它会以明文写进本机
 *  SQLite，因此读接口**永不回显明文**（只给掩码与末 4 位），并且不得进入日志、运行记录、
 *  运行输入归档、发布快照或任何导出清单。 */

/** 每个提供商是 settings 集合里的一条独立文档：providerId 稳定，revision 各自保护，
 *  因此编辑 A 提供商不会让 B 提供商的写入变冲突。 */
export const DIRECT_LLM_PROVIDER_COLLECTION = "settings";
export const DIRECT_LLM_PROVIDER_ID_PREFIX = "direct-llm-provider:";
/** 1.5.39 单例的文档 ID。它只作为「默认提供商」被读取，并在此提供商第一次被显式保存时迁移掉。 */
export const DIRECT_LLM_LEGACY_SINGLETON_ID = "direct-llm";
export const DIRECT_LLM_PROVIDER_FORMAT = "zane-studio.direct-llm-provider/v1";
export const DIRECT_LLM_PROVIDER_LIST_FORMAT = "zane-studio.direct-llm-provider-list/v1";
export const DIRECT_LLM_MODEL_QUERY_FORMAT = "zane-studio.direct-llm-models/v1";
/** 1.5.39 单例（以及任何未声明 providerId 的已发布 direct 步骤）解析到的保留提供商 ID。 */
export const legacyDirectLlmProviderId = "direct-llm-default";
/** 与 core.http_request 的 apiKeyEnv 完全一致：只允许大写下划线环境变量名。 */
export const DIRECT_LLM_API_KEY_ENV_PATTERN = "^[A-Z][A-Z0-9_]{0,127}$";
export const DIRECT_LLM_PROVIDER_ID_PATTERN = "^[a-zA-Z0-9][a-zA-Z0-9_.-]*$";
/** 明文密钥的长度上限：足够容纳常见的长 token，又不至于让配置文档无限膨胀。 */
export const directLlmApiKeyMaxLength = 512;
export const directLlmApiKeySchema = z.string().max(directLlmApiKeyMaxLength);
export const directLlmApiKeyEnvSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
export const directLlmProviderIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
export const directLlmProtocolSchema = z.enum(["openai-chat", "anthropic"]);
export type DirectLlmProtocol = z.infer<typeof directLlmProtocolSchema>;
export const directLlmProtocols: DirectLlmProtocol[] = ["openai-chat", "anthropic"];

export const directLlmProtocolLabels: Record<DirectLlmProtocol, string> = {
  "openai-chat": "OpenAI Chat 兼容",
  anthropic: "Anthropic Messages",
};

/** Anthropic Messages 要求显式 max_tokens；本工作台不暴露该字段，用固定预算。
 *  需要更长输出时用 core.code 拆成多个步骤，而不是把预算做成隐藏的第二步配置。
 *  两个常量定义在 ./directLlmProtocol.js（无导入的独立模块），这样浏览器可达的散文模块可以
 *  插值引用它们而不把整个注册表带进客户端包；这里原样再导出，保持既有导入方不变。 */
export { directLlmAnthropicMaxTokens, directLlmAnthropicVersion } from "./directLlmProtocol.js";
import { directLlmAnthropicMaxTokens, directLlmAnthropicVersion } from "./directLlmProtocol.js";

export const directLlmEndpointSuffix: Record<DirectLlmProtocol, string> = {
  "openai-chat": "/chat/completions",
  anthropic: "/messages",
};
/** 两种协议都按 <baseUrl>/models 列模型；上游不支持时明确失败，不伪装成空列表。 */
export const directLlmModelsSuffix = "/models";

export const DIRECT_LLM_CONTRACT = {
  version: "2",
  capabilityId: "core.llm",
  mode: {
    field: "capabilityConfig.direct", type: "boolean", default: false,
    enabled: "worker sends the selected registry provider directly and never reads a Hermes Profile, a Hermes gateway URL or a Hermes API key",
    disabled: "unchanged pre-1.5.39 behavior: the same Hermes Profile fields, the same hermesProvider/hermesModel overrides, /v1/runs with the /v1/chat/completions fallback, the same messages",
  },
  migration: {
    from: "1.5.39 x-direct-llm v1 system singleton (GET/PATCH /api/v1/settings/direct-llm, MCP get_direct_llm/update_direct_llm, fixed document id direct-llm, fields enabled/baseUrl/apiKeyEnv/model)",
    to: "per-provider records in the @zane-system settings collection, document id <" + DIRECT_LLM_PROVIDER_ID_PREFIX + "><providerId>, each revision-protected; list/get/create/update/delete plus a model query operation",
    singletonRemoved: "the v1 singleton operations no longer exist. No published snapshot is rewritten and no historical run is changed.",
    legacyResolution: "a step with capabilityConfig.direct=true and no capabilityConfig.providerId keeps working: it resolves the reserved provider id " + legacyDirectLlmProviderId + ", whose value is, in order, the new-style stored default provider, the still-present 1.5.39 singleton document (projected onto protocol openai-chat with models:[model]), then the environment defaults ZANE_DIRECT_LLM_BASE_URL/ZANE_DIRECT_LLM_API_KEY_ENV/ZANE_DIRECT_LLM_MODEL",
    legacyRevision: "the legacy singleton and the environment defaults have no new-style revision yet, so they read as revision 0; the first successful save of that provider writes a new-style document and returns revision 1, and the legacy singleton document is removed in the same write",
    migrateBySelection: "select a provider in the step (capabilityConfig.providerId) to leave the reserved default behind; nothing is migrated automatically",
  },
  providers: {
    storage: "authoritative SQLite production_documents, one revision-protected document per provider; never browser storage and never a scenario definition",
    documentId: DIRECT_LLM_PROVIDER_ID_PREFIX + "<providerId>",
    reservedProviderId: legacyDirectLlmProviderId,
    fields: {
      providerId: { type: "string", format: DIRECT_LLM_PROVIDER_ID_PATTERN, description: "stable client-chosen UUID or slug; part of the document id and never rewritten" },
      name: { type: "string", maximumLength: 160, required: true, description: "display name only; it is not an identity" },
      protocol: { type: "string", enum: directLlmProtocols, default: "openai-chat" },
      baseUrl: { type: "string", maximumLength: 512, required: true, protocol: "http|https", addressPolicy: "loopback and private addresses are allowed on purpose: the provider is usually a local gateway or proxy; this is a deliberate exception to the core.http_request public-address-only rule", credentialsInUrl: "rejected", queryOrFragment: "rejected" },
      apiKey: { type: "string", maximumLength: directLlmApiKeyMaxLength, optional: true, storage: "plaintext in the local SQLite direct-llm-provider record", note: "user explicitly chose plaintext-at-rest. It is never returned by any read operation (only apiKeyMasked/lastFour), never logged, never written to a run record, run input archive, published snapshot or export manifest, and never included in an error message", writeSemantics: { omitted: "keep the stored key unchanged (editing only the name or address never clears it)", emptyString: "clear the stored key", nonEmpty: "replace the stored key" } },
      apiKeyEnv: { type: "string", format: DIRECT_LLM_API_KEY_ENV_PATTERN, optional: true, note: "compatibility fallback only: used when apiKey is empty. Only the variable name is stored and returned; the value is read from the workbench process environment", precedence: "apiKey (plaintext, saved) wins; otherwise apiKeyEnv is read from process.env at request time" },
      credential: { type: "object", fields: ["configured", "source", "apiKeyMasked", "lastFour", "plaintextAtRest", "notes"], description: "read-only projection that tells the caller whether a key is usable and where it comes from, without ever exposing the plaintext" },
      models: { type: "string[]", maximumItems: 500, default: [], description: "cached upstream list merged with hand-typed entries; order preserved, deduplicated, hand-typed entries never dropped" },
      modelsFetchedAt: { type: ["string", "null"], default: null, description: "last successful upstream model query; null means never queried" },
      enabled: { type: "boolean", default: false },
      revision: { type: "integer", minimum: 0, description: "0 for a provider that only exists as the legacy singleton or as environment defaults" },
    },
    enabledRequires: ["name", "baseUrl", "one of apiKey|apiKeyEnv"],
    plaintextAtRest: {
      fact: "the API key is stored in plaintext in this machine's SQLite database (production_documents, collection settings, document direct-llm-provider:<providerId>)",
      rationale: "the user explicitly chose plaintext-at-rest after being shown the alternatives (separate file, master-key encryption, plaintext)",
      operatorDuty: "protect the data directory, its backups, database copies and any file-level snapshot; anyone who can read that file can read the key",
      guards: [
        "no read operation returns the plaintext; only apiKeyMasked (last four) and credential.configured",
        "logs and the structured log buffer redact apiKey/secret fields (observability/logRedaction) and direct-llm log entries carry no key material",
        "run records, run inputs (inputs/input.json), runtime.json, step results, agent prompts and error messages never contain the key",
        "published scene snapshots store only the step capabilityConfig (providerId/model), so the key never enters a snapshot",
        "the key is not part of any export manifest or media archive produced by this workbench",
      ],
    },
    modelResolution: "capabilityConfig.model wins; otherwise the provider's first models entry; a provider with no models and no step model fails before any request with 直连模型提供商未配置模型名",
    conflicts: {
      createDuplicate: 409, createDuplicateCode: "PROVIDER_ALREADY_EXISTS",
      updateDeleteOrStaleQuery: 409, updateDeleteCode: "RESOURCE_REVISION_CONFLICT",
      listCursor: 409, listCursorCode: "DIRECT_LLM_PROVIDER_PAGE_CHANGED",
      unknownProvider: 404, unknownProviderCode: "DIRECT_LLM_PROVIDER_NOT_FOUND",
    },
  },
  protocols: {
    "openai-chat": {
      request: "POST <baseUrl with trailing slashes removed>" + directLlmEndpointSuffix["openai-chat"],
      authentication: "Authorization: Bearer <key>",
      headers: { "Content-Type": "application/json" },
      body: { model: "<resolved model>", messages: "array of {role: system|user, content: string|parts[]}", stream: false },
      response: "choices[0].message.content as text",
      images: "{type:'image_url', image_url:{url:'data:<media_type>;base64,<data>', detail:'high'}}",
      modelsEndpoint: "GET <baseUrl>/models",
      modelsParsing: "data[].id",
    },
    anthropic: {
      request: "POST <baseUrl with trailing slashes removed>" + directLlmEndpointSuffix.anthropic,
      authentication: "x-api-key: <key> 与 anthropic-version: " + directLlmAnthropicVersion,
      headers: { "Content-Type": "application/json" },
      body: { model: "<resolved model>", max_tokens: directLlmAnthropicMaxTokens, system: "every system message concatenated with a blank line, sent as a top-level field and never as a messages entry", messages: "array of {role: user, content: string|parts[]}" },
      response: "concatenation of every content[] block with type:'text'",
      images: "{type:'image', source:{type:'base64', media_type:'<media_type>', data:'<base64>'}}; an http(s) image URL becomes {type:'url', url:<url>}",
      modelsEndpoint: "GET <baseUrl>/models",
      modelsParsing: "data[].id (the same envelope the Anthropic models endpoint returns)",
      modelsUnsupported: "HTTP 404/405 or an envelope without a recognizable data[].id list fails with 该协议不支持列模型; it is never reported as an empty list",
    },
  },
  modelCatalog: {
    endpoint: "GET <baseUrl with trailing slashes removed>" + directLlmModelsSuffix,
    authentication: "the same protocol headers as the completion request, so the same key resolution applies (stored plaintext apiKey first, apiKeyEnv fallback otherwise)",
    caching: "a successful query merges the upstream list with the existing models array (upstream order first, deduplicated) and writes modelsFetchedAt to the same revision-protected provider document; hand-typed entries are never dropped",
    failure: "any failure (unsupported endpoint, non-2xx, unrecognized envelope, bad credentials, network error) is reported with the upstream status and a redacted message summary; a failure never writes an empty list, never clears modelsFetchedAt and is never retried automatically",
    sideEffect: "one upstream GET request and, only on success, one revision-protected cache write; no model is called and no generation cost is incurred",
  },
  request: {
    timeout: "settings.workflowTimeoutMinutes, the same per-step budget as core.hermes; the model query uses it too",
    cancellation: "the run AbortSignal aborts the completion; the model query is admin-triggered and has no run signal",
    retries: "none: one request per call, because a chat completion is not idempotent and a resend could be billed twice",
    credentialResolution: "provider.apiKey (stored plaintext) when non-empty, otherwise process.env[provider.apiKeyEnv]; the resolved value only ever reaches the authentication header and the upstream-echo scrubber, never a log, error message, run record or response",
  },
  multimodal: "declared image_list/video_list inputs reuse the exact core.hermes attachment path (frame extraction, compression, base64 data URL, 10 MB inline budget, compression cache); only the per-protocol image mapping differs, and an already-encoded data URL is re-split instead of re-encoded",
  failureMessages: ["直连模型提供商未启用", "直连模型提供商未配置服务地址", "直连模型提供商未配置 API 密钥", "直连模型提供商未配置模型名", "直连模型提供商环境变量的值格式无效", "直连模型提供商认证失败", "直连模型提供商请求失败", "直连模型提供商请求超时", "直连模型提供商网络连接失败", "直连模型提供商没有返回文本内容", "该协议不支持列模型", "直连模型提供商不存在"],
  sideEffects: {
    configure: "none",
    queryModels: "one upstream GET /models request and, on success only, one revision-protected cache write; no model call, no generation, no cost",
    publish: "none",
    execute: "one provider request per step; may incur provider cost, never retried automatically; no Hermes gateway, Hermes Profile or Hermes credential is read",
  },
} as const;

/** 运行期解析出的执行目标：这里会给出实际生效的协议、地址、模型与**密钥值**。
 *  密钥优先级：提供商保存的明文 apiKey 非空则用它；否则回退 apiKeyEnv（在工作台进程环境里读值）。
 *  目标只在 worker 内部流转，绝不进入运行记录、日志、错误消息或接口响应。 */
export interface DirectLlmTarget {
  enabled: boolean;
  /** 注册表里的提供商 ID；未声明 providerId 的历史步骤解析为 legacyDirectLlmProviderId。 */
  providerId: string;
  protocol: DirectLlmProtocol;
  baseUrl: string;
  /** 只用于错误文案与诊断：告诉用户「哪个提供商的哪一项没配好」。 */
  apiKeyEnv: string;
  /** 明文密钥；空串表示未配置或不使用明文密钥。 */
  apiKey: string;
  /** 实际生效的协议请求体模型名。 */
  model: string;
}

/** 密钥来源，用于契约与自检的明确说明（不泄露值）。 */
export type DirectLlmCredentialSource = "provider-apiKey" | "environment" | "unset";

export function emptyDirectLlmTarget(): DirectLlmTarget {
  return { enabled: false, providerId: "", protocol: "openai-chat", baseUrl: "", apiKeyEnv: "", apiKey: "", model: "" };
}

/** 读接口用的密钥投影：**永不回显明文**，只说明「配了没有」「用哪一种」与末尾 4 位提示。
 *  末 4 位是用户核对「我填的是哪一个」的最小信息，不构成可用凭证。 */
export interface DirectLlmCredentialView {
  configured: boolean;
  source: DirectLlmCredentialSource;
  apiKeyMasked: string;
  lastFour: string;
  plaintextAtRest: boolean;
  notes: string;
}

/** plaintextApiKey 是已保存的明文密钥本身；本函数只读取它的长度与末 4 位，绝不返回它。 */
export function directLlmCredentialView(plaintextApiKey: string, apiKeyEnv: string, environmentUsable: boolean): DirectLlmCredentialView {
  const masked = plaintextApiKey ? "•".repeat(Math.min(8, Math.max(4, plaintextApiKey.length - 4))) + plaintextApiKey.slice(-4) : "";
  return {
    configured: Boolean(plaintextApiKey) || environmentUsable,
    source: plaintextApiKey ? "provider-apiKey" : apiKeyEnv ? "environment" : "unset",
    apiKeyMasked: masked,
    lastFour: plaintextApiKey ? plaintextApiKey.slice(-4) : "",
    plaintextAtRest: Boolean(plaintextApiKey),
    notes: plaintextApiKey
      ? "API 密钥以明文保存在本机 SQLite 的 direct-llm-provider 记录中（用户明确选择的存储方式）。请自行保护数据目录与备份；它不会回显到界面、日志、运行记录、发布快照或导出。"
      : apiKeyEnv
        ? `未填明文密钥，改为在工作台服务进程环境变量 ${apiKeyEnv} 中读取它的值；接口只保存变量名。`
        : "尚未配置密钥：直接在页面填写 API 密钥，或填写环境变量名并在工作台服务进程环境中提供它的值。",
  };
}

/** 步骤配置里的直连选择：direct=true 时生效，与 Hermes 字段完全无关。 */
export interface DirectLlmStepSelection { providerId?: string; model?: string }

export const directLlmProviderFields = {
  name: z.string().max(160).describe("显示名，例如「本机 Ollama」「公司 Anthropic 代理」；只用于展示与检索，不构成身份"),
  protocol: directLlmProtocolSchema.describe("兼容端点协议：openai-chat = POST <地址>/chat/completions，Authorization: Bearer；anthropic = POST <地址>/messages，x-api-key + anthropic-version " + directLlmAnthropicVersion + "。两种协议都用 GET <地址>/models 列模型"),
  baseUrl: z.string().max(512).describe("提供商基础地址，例如 https://api.example.com/v1 或本机代理 http://127.0.0.1:11434/v1；末尾斜杠会被去掉。允许本机/内网地址（这是对第三方请求「仅公网」限制的有意例外）；不接受 URL 内嵌用户名密码、查询串或片段"),
  apiKey: z.string().max(directLlmApiKeyMaxLength).optional().describe("API 密钥明文，直接在页面上填写；保存后以明文存放在本机 SQLite（请自行保护数据目录与备份）。读出时永不回显：接口只返回 apiKeyMasked（末尾 4 位）与 credential.configured。**省略该字段表示保持已保存的密钥不变**（只改名称/地址不会清空密钥）；显式传空串 \"\" 表示清除密钥；传非空字符串表示替换它（不会与旧值拼接）。密钥不进场景发布快照、运行输入归档、导出清单、日志、步骤结果或错误消息"),
  apiKeyEnv: z.string().max(128).optional().describe("可选：只在 apiKey 为空（未填或已被清除）时使用的**环境变量名**（^[A-Z][A-Z0-9_]{0,127}$），值在执行时从工作台服务进程环境读取。它是 apiKey 的兼容回退，页面以直接填 apiKey 为主。传空串表示清除该回退"),
  models: z.array(z.string().max(200)).max(500).optional().describe("模型名列表（完整替换）；省略表示保持现有列表。可手填上游 /models 没有返回的名字；查询可用模型时与上游结果合并去重，不丢弃手填项"),
  enabled: z.boolean().optional().describe("true 时该提供商可被 direct 步骤使用；默认 false。启用需要 name/baseUrl 以及 apiKey 或 apiKeyEnv 之一，否则 400 —— 不允许保存「看起来开启、实际不可用」的配置"),
} as const;

const providerIdField = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);

export const directLlmProviderQuery = z.object({
  // HTTP 查询串里的值永远是字符串，所以这里必须 coerce；MCP 侧传数字也同样接受。
  limit: z.coerce.number().int().min(1).max(100).default(24).describe("单页提供商数量；默认24，最大100；hasMore 时用同一列表 revision 的 nextCursor 继续读取"),
  cursor: z.string().min(1).max(2048).optional().describe("上页 nextCursor，绑定列表 revision；409 DIRECT_LLM_PROVIDER_PAGE_CHANGED 时重读第一页，不拼接不同快照"),
  q: z.string().max(200).optional().describe("可选关键词，按 providerId、显示名或模型名过滤；省略返回全部提供商"),
}).strict();

export const directLlmProviderKey = z.object({
  providerId: providerIdField.describe("提供商稳定 ID（客户端预生成的 UUID 或 slug）；不存在返回 404 DIRECT_LLM_PROVIDER_NOT_FOUND"),
}).strict();

/** 至少要有一种密钥来源：明文 apiKey，或（回退用的）apiKeyEnv。
 *  用 refine 而不是改字段定义，是为了让「省略 apiKey=保持」在 update 里仍然合法。 */
const requireKeySource = (value: { apiKey?: string; apiKeyEnv?: string }) => Boolean((value.apiKey ?? "").trim() || (value.apiKeyEnv ?? "").trim());
const keySourceMessage = { message: "必须提供 apiKey（明文密钥）或 apiKeyEnv（环境变量名）之一", path: ["apiKey"] };

export const createDirectLlmProvider = z.object({
  providerId: providerIdField.describe("调用前生成并保存的稳定 ID（UUID 或 slug）；响应丢失用 get_direct_llm_provider 读同一 ID 对账，不换 ID 重建。重复 ID 返回 409 PROVIDER_ALREADY_EXISTS"),
  ...directLlmProviderFields,
}).strict().refine(requireKeySource, keySourceMessage);

export const updateDirectLlmProvider = z.object({
  revision: z.int().nonnegative().describe("读取提供商得到的当前 revision（历史默认提供商为 0）；409 或响应丢失后先重新读取，不自动重放"),
  name: directLlmProviderFields.name,
  protocol: directLlmProviderFields.protocol,
  baseUrl: directLlmProviderFields.baseUrl,
  apiKey: directLlmProviderFields.apiKey,
  apiKeyEnv: directLlmProviderFields.apiKeyEnv,
  models: directLlmProviderFields.models,
  enabled: z.boolean().describe("完整替换；true 需要 name/baseUrl 以及 apiKey 或 apiKeyEnv 之一"),
}).strict();

export const deleteDirectLlmProvider = z.object({
  revision: z.int().nonnegative().describe("读取提供商得到的当前 revision（历史默认提供商为 0）；旧 revision 返回 409 RESOURCE_REVISION_CONFLICT，不自动重放删除"),
}).strict();

/** 查询上游 /models：不带参数。服务端用读取到的当前 revision 合并写回；
 *  期间有并发写入时返回 409，不覆盖别人刚保存的配置。 */
export const queryDirectLlmModels = z.object({}).strict();

/** 提供商记录的来源，决定 revision 语义与迁移路径。 */
export const directLlmProviderOriginSchema = z.enum(["saved", "legacy-singleton", "environment"]);

export const directLlmCredentialViewSchema = z.object({
  configured: z.boolean().describe("是否已配置可用密钥：填了明文 apiKey，或填了 apiKeyEnv 且工作台进程环境里确实有它的值"),
  source: z.enum(["provider-apiKey", "environment", "unset"]).describe("provider-apiKey = 用保存的明文密钥；environment = 回退到 apiKeyEnv 指向的环境变量；unset = 都没有"),
  apiKeyMasked: z.string().describe("掩码提示，例如 ••••••••abcd；**永不返回明文**。来自环境变量时为「（来自环境变量）」"),
  lastFour: z.string().describe("明文密钥的末 4 位，仅用于核对「我填的是哪一个」；从环境变量读取时为空串"),
  plaintextAtRest: z.boolean().describe("true 表示该提供商的密钥以明文保存在本机 SQLite 中，请自行保护数据目录与备份"),
  notes: z.string().describe("密钥来源与存储风险的中文说明；只描述规则，不含任何密钥内容"),
}).strict();

export const directLlmProviderSchema = z.object({
  format: z.literal(DIRECT_LLM_PROVIDER_FORMAT),
  providerId: z.string(),
  name: z.string(),
  protocol: directLlmProtocolSchema,
  baseUrl: z.string(),
  apiKeyEnv: z.string().describe("兼容回退的环境变量名；密钥值永不返回"),
  hasApiKey: z.boolean().describe("已保存明文密钥；明文本身永不返回，只用 credential.apiKeyMasked 提示"),
  credential: directLlmCredentialViewSchema,
  models: z.array(z.string()),
  modelsFetchedAt: z.string().nullable(),
  enabled: z.boolean(),
  revision: z.int().nonnegative(),
  origin: directLlmProviderOriginSchema,
  reservedDefault: z.boolean(),
  configured: z.boolean(),
  hasModels: z.boolean(),
  secretStorage: z.literal("local_sqlite_plaintext"),
  apiKeyEnvPattern: z.string(),
  providerIdPattern: z.string(),
  scope: z.literal("system"),
  appliesTo: z.literal("core.llm.direct"),
  request: z.object({
    method: z.literal("POST"),
    endpointSuffix: z.string(),
    modelsEndpointSuffix: z.literal(directLlmModelsSuffix),
    authentication: z.string(),
    retries: z.literal(0),
    timeoutSource: z.literal("workflowTimeoutMinutes"),
  }).strict(),
  nextAction: z.literal("update_with_revision"),
}).strict();
export type DirectLlmProvider = z.infer<typeof directLlmProviderSchema>;

export const directLlmProviderListSchema = z.object({
  format: z.literal(DIRECT_LLM_PROVIDER_LIST_FORMAT),
  revision: z.string(),
  total: z.int().nonnegative(),
  providers: z.array(directLlmProviderSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().optional(),
  protocols: z.array(directLlmProtocolSchema),
  providerIdPattern: z.string(),
  apiKeyEnvPattern: z.string(),
  apiKeyMaxLength: z.int().positive(),
  reservedDefaultProviderId: z.string(),
  secretStorage: z.literal("local_sqlite_plaintext"),
  secretStorageNotice: z.string(),
  nextAction: z.literal("create_or_update_provider_with_revision"),
}).strict();
export type DirectLlmProviderList = z.infer<typeof directLlmProviderListSchema>;

export const directLlmModelQuerySchema = z.object({
  format: z.literal(DIRECT_LLM_MODEL_QUERY_FORMAT),
  providerId: z.string(),
  revision: z.int().nonnegative(),
  fetched: z.array(z.string()).describe("本次上游返回并通过校验的模型 ID（已按上游顺序去重）"),
  added: z.array(z.string()).describe("上游未返回、但本地已有因此被保留的手填模型；它们不会被查询结果丢掉"),
  models: z.array(z.string()),
  modelsFetchedAt: z.string(),
  nextAction: z.literal("use_model_ids_in_step_or_provider"),
}).strict();
export type DirectLlmModelQuery = z.infer<typeof directLlmModelQuerySchema>;

/** 去掉末尾斜杠并解析出可用于请求的基础地址；不一致或危险的形式直接在这里失败，
 *  而不是留给 fetch 产生难以理解的错误。允许本机/内网地址（直连通常就是本机代理）。 */
export function normalizeDirectLlmBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > 512) throw new Error("直连模型提供商地址过长，最多 512 个字符");
  if (/[\0\r\n\t]/.test(trimmed)) throw new Error("直连模型提供商地址不能包含控制字符");
  let parsed: URL;
  try { parsed = new URL(trimmed); }
  catch { throw new Error("直连模型提供商地址必须是完整的 http(s) 地址，例如 https://api.example.com/v1"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("直连模型提供商地址只支持 http 或 https");
  if (parsed.username || parsed.password) throw new Error("直连模型提供商地址不能内嵌用户名或密码；密钥只通过 apiKeyEnv 环境变量提供");
  if (parsed.search || parsed.hash) throw new Error("直连模型提供商地址不能带查询串或片段");
  return trimmed.replace(/\/+$/, "");
}

/** 只校验变量名格式；任何情况下都不读取、不回显、不比较它的值。 */
export function normalizeDirectLlmApiKeyEnv(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(trimmed)) throw new Error("直连模型提供商 API 密钥环境变量名无效：只能使用大写字母、数字和下划线，且以字母开头");
  return trimmed;
}

/** 明文密钥只做长度（与首尾空白）校验，**不检查形态、不打印内容**。
 *  这里刻意不 trim 内部内容，只去掉两端空白：密钥里的空格可能是真实字符，
 *  但两端的空白几乎总是粘贴带来的，去掉它能避免「看起来配了却认证失败」。 */
export function normalizeDirectLlmApiKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > directLlmApiKeyMaxLength) throw new Error(`直连模型提供商 API 密钥过长，最多 ${directLlmApiKeyMaxLength} 个字符`);
  if (/[\r\n\0]/.test(trimmed)) throw new Error("直连模型提供商 API 密钥不能包含换行或空字符");
  return trimmed;
}

export function normalizeDirectLlmModel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > 200) throw new Error("直连模型名过长，最多 200 个字符");
  if (/[\0\r\n\t]/.test(trimmed)) throw new Error("直连模型名不能包含控制字符");
  return trimmed;
}

export function normalizeDirectLlmProviderId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("直连模型提供商 ID 不能为空");
  if (trimmed.length > 200) throw new Error("直连模型提供商 ID 过长，最多 200 个字符");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(trimmed)) throw new Error("直连模型提供商 ID 只能使用字母、数字和 _ . -，且以字母或数字开头");
  return trimmed;
}

export function normalizeDirectLlmProviderName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > 160) throw new Error("直连模型提供商名称过长，最多 160 个字符");
  if (/[\0\r\n\t]/.test(trimmed)) throw new Error("直连模型提供商名称不能包含控制字符");
  return trimmed;
}

/** 模型列表：去重（首次出现优先）并按顺序保留，两端空白去掉；空串与重复项被丢弃。 */
export function normalizeDirectLlmModels(value: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const model = normalizeDirectLlmModel(typeof item === "string" ? item : "");
    if (!model || seen.has(model)) continue;
    seen.add(model);
    result.push(model);
  }
  if (result.length > 500) throw new Error("直连模型提供商的模型列表最多 500 个");
  return result;
}

export function directLlmProviderDocumentId(providerId: string): string {
  return DIRECT_LLM_PROVIDER_ID_PREFIX + providerId;
}

/** 合并上游查询结果与本地已有列表：上游顺序优先，本地手填项只保留上游没有的。 */
export function mergeDirectLlmModels(upstream: readonly string[], existing: readonly string[]) {
  const fetched = normalizeDirectLlmModels(upstream);
  const seen = new Set(fetched);
  const added = normalizeDirectLlmModels(existing).filter((model) => !seen.has(model));
  return { fetched, added, models: [...fetched, ...added] };
}
