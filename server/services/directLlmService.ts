import {
  DIRECT_LLM_API_KEY_ENV_PATTERN, DIRECT_LLM_CONTRACT, DIRECT_LLM_LEGACY_SINGLETON_ID, DIRECT_LLM_PROVIDER_COLLECTION,
  DIRECT_LLM_PROVIDER_FORMAT, DIRECT_LLM_PROVIDER_ID_PATTERN, DIRECT_LLM_PROVIDER_LIST_FORMAT, DIRECT_LLM_MODEL_QUERY_FORMAT,
  createDirectLlmProvider, deleteDirectLlmProvider, directLlmEndpointSuffix, directLlmModelsSuffix,
  directLlmCredentialView, directLlmCredentialViewSchema, directLlmApiKeyMaxLength, directLlmAnthropicVersion,
  directLlmProviderDocumentId, directLlmProviderIdSchema, directLlmProviderListSchema, directLlmProviderQuery, directLlmProviderSchema,
  directLlmProtocolLabels, directLlmProtocols, legacyDirectLlmProviderId, mergeDirectLlmModels, normalizeDirectLlmApiKey,
  normalizeDirectLlmApiKeyEnv, normalizeDirectLlmBaseUrl, normalizeDirectLlmModel, normalizeDirectLlmModels, normalizeDirectLlmProviderId,
  normalizeDirectLlmProviderName, updateDirectLlmProvider,
  type DirectLlmModelQuery, type DirectLlmProvider, type DirectLlmProviderList, type DirectLlmProtocol, type DirectLlmTarget,
} from "../domain/directLlm.js";
import { HttpError } from "../errors.js";
import { contentRevision } from "../domain/sceneContent.js";
import { workflowTimeoutMs, defaultWorkflowTimeoutMinutes } from "../config.js";
import type { SqliteStore } from "../storage/sqliteStore.js";
import { requestDirectLlmModels } from "../execution/directLlmRequest.js";
import { log } from "../observability/logger.js";

const SYSTEM = "@zane-system";
const COLLECTION = DIRECT_LLM_PROVIDER_COLLECTION;

/** 明文密钥的存储风险说明：契约、读接口与文档都用同一句话，不在任何地方淡化它。 */
export const DIRECT_LLM_SECRET_STORAGE_NOTICE = "API 密钥以明文保存在本机 SQLite（production_documents.settings.direct-llm-provider:<providerId>）中，这是产品明确选择的存储方式；请自行保护数据目录、数据库副本与备份——能读到该文件的人就能读到密钥。密钥永不回显到界面、日志、运行记录、运行输入、发布快照或导出清单。";

/** 落库形态：providerId/name/protocol/baseUrl/apiKey（明文）/apiKeyEnv/models/modelsFetchedAt/enabled。
 *  apiKey 是这里唯一的秘密字段，读接口绝不把它投影出去。 */
interface SavedProvider {
  id: string;
  revision: number;
  providerId: string;
  name: string;
  protocol: DirectLlmProtocol;
  baseUrl: string;
  /** 明文密钥；空串表示未配置（此时回退 apiKeyEnv）。 */
  apiKey: string;
  apiKeyEnv: string;
  models: string[];
  modelsFetchedAt: string | null;
  enabled: boolean;
}

/** 1.5.39 单例的落库形态（只读，用于迁移与历史步骤的默认提供商）。它没有明文密钥字段。 */
interface LegacySingleton { id: string; revision: number; enabled: boolean; baseUrl: string; apiKeyEnv: string; model: string }

interface ResolvedProvider {
  providerId: string;
  name: string;
  protocol: DirectLlmProtocol;
  baseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
  models: string[];
  modelsFetchedAt: string | null;
  enabled: boolean;
  revision: number;
  origin: "saved" | "legacy-singleton" | "environment";
}

function tolerant<T>(resolve: (value: string) => T, value: string, fallback: T): T {
  try { return resolve(value); } catch { return fallback; }
}

function conflict(message = "直连模型提供商已变化，请重新读取并核对后保存；不要重放旧请求") {
  return new HttpError(409, message, "RESOURCE_REVISION_CONFLICT");
}

function invalid(message: string) {
  return new HttpError(400, message, "INVALID_DIRECT_LLM_REQUEST");
}

/**
 * 直连模型提供商注册表：core.llm 的 direct 模式使用的唯一权威来源。
 * UI、HTTP 与 MCP 读写同一份 SQLite 文档集合。
 *
 * 每个提供商一条文档（id = direct-llm-provider:<providerId>），各自 revision 保护：
 * 编辑 A 提供商不会让 B 提供商的写入变冲突。
 *
 * 密钥：**明文保存在该文档里**（用户明确选择的存储方式），读出时只投影掩码与末 4 位。
 * 明文只在本服务与 worker 内部流转，不进入日志、运行记录、运行输入、发布快照或导出。
 */
export class DirectLlmService {
  private readonly legacyBaseUrl: string;
  private readonly legacyApiKeyEnv: string;
  private readonly legacyModel: string;

  constructor(
    private readonly store: SqliteStore,
    /** 1.5.39 的环境默认值：仍然生效，但只作为保留默认提供商（未声明 providerId 的步骤）的最后一级兜底。 */
    environment: { baseUrl?: string; apiKeyEnv?: string; model?: string } = {},
  ) {
    this.legacyBaseUrl = tolerant(normalizeDirectLlmBaseUrl, environment.baseUrl ?? "", "");
    this.legacyApiKeyEnv = tolerant(normalizeDirectLlmApiKeyEnv, environment.apiKeyEnv ?? "", "");
    this.legacyModel = tolerant(normalizeDirectLlmModel, environment.model ?? "", "");
  }

  // ---------------------------------------------------------------- 读取

  private savedProviders(): SavedProvider[] {
    return this.store.listDocuments<SavedProvider>(SYSTEM, COLLECTION)
      .filter((document) => typeof document?.id === "string" && document.id.startsWith(directLlmProviderDocumentId("")))
      .sort((left, right) => left.providerId.localeCompare(right.providerId));
  }

  private saved(providerId: string): SavedProvider | undefined {
    return this.store.getDocument<SavedProvider>(SYSTEM, COLLECTION, directLlmProviderDocumentId(providerId));
  }

  /** 1.5.39 单例：仍然可读，并且只在没有新式文档时作为保留默认提供商生效。 */
  private legacySingleton(): LegacySingleton | undefined {
    return this.store.getDocument<LegacySingleton>(SYSTEM, COLLECTION, DIRECT_LLM_LEGACY_SINGLETON_ID);
  }

  private legacyDefault(): ResolvedProvider | undefined {
    const singleton = this.legacySingleton();
    if (singleton) {
      const model = tolerant(normalizeDirectLlmModel, singleton.model ?? "", "");
      return {
        providerId: legacyDirectLlmProviderId, name: "默认直连提供商（1.5.39 单例）",
        protocol: "openai-chat",
        baseUrl: tolerant(normalizeDirectLlmBaseUrl, singleton.baseUrl ?? "", ""),
        // 1.5.39 只存环境变量名，从不存明文；这里也保持 apiKey 为空。
        apiKey: "",
        apiKeyEnv: tolerant(normalizeDirectLlmApiKeyEnv, singleton.apiKeyEnv ?? "", ""),
        models: model ? [model] : [],
        modelsFetchedAt: null,
        enabled: singleton.enabled === true,
        revision: 0,
        origin: "legacy-singleton",
      };
    }
    if (this.legacyBaseUrl || this.legacyApiKeyEnv || this.legacyModel) {
      return {
        providerId: legacyDirectLlmProviderId, name: "默认直连提供商（环境变量）",
        protocol: "openai-chat", baseUrl: this.legacyBaseUrl, apiKey: "", apiKeyEnv: this.legacyApiKeyEnv,
        models: this.legacyModel ? [this.legacyModel] : [], modelsFetchedAt: null,
        enabled: false, revision: 0, origin: "environment",
      };
    }
    return undefined;
  }

  /** 解析一个提供商：新式文档优先，其次是保留的默认提供商（单例/环境默认值）。 */
  private resolveProvider(providerId: string): ResolvedProvider | undefined {
    const saved = this.saved(providerId);
    if (saved) {
      return {
        providerId: saved.providerId, name: saved.name, protocol: saved.protocol, baseUrl: saved.baseUrl,
        apiKey: typeof saved.apiKey === "string" ? saved.apiKey : "", apiKeyEnv: saved.apiKeyEnv ?? "",
        models: saved.models ?? [], modelsFetchedAt: saved.modelsFetchedAt ?? null,
        enabled: saved.enabled, revision: saved.revision, origin: "saved",
      };
    }
    if (providerId === legacyDirectLlmProviderId) return this.legacyDefault();
    return undefined;
  }

  private modelsFor(provider: ResolvedProvider, stepModel?: string) {
    const explicit = typeof stepModel === "string" ? normalizeDirectLlmModel(stepModel) : "";
    return explicit || provider.models[0] || "";
  }

  /** 运行期读取：步骤只声明 providerId（可省略 providerId 表示保留默认提供商）与可选 model。 */
  target(providerId?: string, stepModel?: string): DirectLlmTarget {
    const requested = typeof providerId === "string" && providerId.trim() ? providerId.trim() : legacyDirectLlmProviderId;
    const provider = this.resolveProvider(requested);
    if (!provider) {
      return { enabled: false, providerId: requested, protocol: "openai-chat", baseUrl: "", apiKey: "", apiKeyEnv: "", model: "" };
    }
    return {
      enabled: provider.enabled, providerId: provider.providerId, protocol: provider.protocol,
      baseUrl: provider.baseUrl, apiKey: provider.apiKey, apiKeyEnv: provider.apiKeyEnv,
      model: this.modelsFor(provider, stepModel),
    };
  }

  private project(provider: ResolvedProvider): DirectLlmProvider {
    const environmentUsable = Boolean(provider.apiKeyEnv && process.env[provider.apiKeyEnv]);
    const configured = provider.enabled && Boolean(provider.baseUrl) && Boolean(provider.apiKey || environmentUsable);
    return {
      format: DIRECT_LLM_PROVIDER_FORMAT,
      providerId: provider.providerId,
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      // 只有变量名会被投影；明文密钥在下面折叠成 hasApiKey/credential 两个布尔与掩码。
      apiKeyEnv: provider.apiKeyEnv,
      hasApiKey: Boolean(provider.apiKey),
      credential: directLlmCredentialViewSchema.parse(directLlmCredentialView(provider.apiKey, provider.apiKeyEnv, environmentUsable)),
      models: [...provider.models],
      modelsFetchedAt: provider.modelsFetchedAt,
      enabled: provider.enabled,
      revision: provider.revision,
      origin: provider.origin,
      reservedDefault: provider.providerId === legacyDirectLlmProviderId,
      configured,
      hasModels: provider.models.length > 0,
      secretStorage: "local_sqlite_plaintext",
      apiKeyEnvPattern: DIRECT_LLM_API_KEY_ENV_PATTERN,
      providerIdPattern: DIRECT_LLM_PROVIDER_ID_PATTERN,
      scope: "system",
      appliesTo: "core.llm.direct",
      request: {
        method: "POST", endpointSuffix: directLlmEndpointSuffix[provider.protocol], modelsEndpointSuffix: directLlmModelsSuffix,
        authentication: provider.protocol === "anthropic" ? "x-api-key 头（含 anthropic-version: " + directLlmAnthropicVersion + "）" : "Authorization: Bearer 头", retries: 0, timeoutSource: "workflowTimeoutMinutes",
      },
      nextAction: "update_with_revision",
    };
  }

  /** 列表：保留的默认提供商**只在它确实存在时**出现，不伪造一条空记录。 */
  private allProviders(): ResolvedProvider[] {
    const saved = this.savedProviders().map((document) => this.resolveProvider(document.providerId)!);
    if (saved.some((provider) => provider.providerId === legacyDirectLlmProviderId)) return saved;
    const legacy = this.legacyDefault();
    return legacy ? [legacy, ...saved] : saved;
  }

  // ---------------------------------------------------------------- 操作

  /** 分页读取提供商目录；列表 revision 绑定筛选结果，变化时要求重读第一页。 */
  read(input: unknown = {}): DirectLlmProviderList {
    const parsed = directLlmProviderQuery.safeParse(input);
    if (!parsed.success) throw invalid("直连模型提供商列表查询参数无效：limit 1–100，cursor 与 q 为可选");
    const { limit, cursor, q } = parsed.data;
    const keyword = q?.trim().toLowerCase();
    const providers = this.allProviders().filter((provider) => !keyword
      || provider.providerId.toLowerCase().includes(keyword)
      || provider.name.toLowerCase().includes(keyword)
      || provider.models.some((model) => model.toLowerCase().includes(keyword)));
    const revision = contentRevision(providers.map((provider) => this.project(provider)));
    let offset = 0;
    if (cursor) {
      try {
        const token = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { format?: string; revision?: string; offset?: number };
        if (token.format !== "direct-llm-provider-page/v1" || !Number.isSafeInteger(token.offset) || (token.offset ?? 0) < 1 || typeof token.revision !== "string") throw new Error();
        if (token.revision !== revision) throw new HttpError(409, "直连模型提供商目录在分页期间变化，请重读第一页", "DIRECT_LLM_PROVIDER_PAGE_CHANGED", { currentRevision: revision, nextAction: "read_first_page" });
        if ((token.offset ?? 0) >= providers.length) throw new Error();
        offset = token.offset!;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw invalid("直连模型提供商列表游标无效");
      }
    }
    const page = providers.slice(offset, offset + limit).map((provider) => this.project(provider));
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < providers.length;
    return {
      format: DIRECT_LLM_PROVIDER_LIST_FORMAT, revision, total: providers.length, providers: page, hasMore,
      ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ format: "direct-llm-provider-page/v1", revision, offset: nextOffset })).toString("base64url") } : {}),
      protocols: [...directLlmProtocols], providerIdPattern: DIRECT_LLM_PROVIDER_ID_PATTERN, apiKeyEnvPattern: DIRECT_LLM_API_KEY_ENV_PATTERN,
      apiKeyMaxLength: directLlmApiKeyMaxLength,
      reservedDefaultProviderId: legacyDirectLlmProviderId, secretStorage: "local_sqlite_plaintext",
      secretStorageNotice: DIRECT_LLM_SECRET_STORAGE_NOTICE,
      nextAction: "create_or_update_provider_with_revision",
    };
  }

  get(providerId: string): DirectLlmProvider {
    const id = this.normalizeId(providerId);
    const provider = this.resolveProvider(id);
    if (!provider) throw new HttpError(404, `直连模型提供商不存在：${id}；先用 list_direct_llm_providers 读取当前目录`, "DIRECT_LLM_PROVIDER_NOT_FOUND");
    return this.project(provider);
  }

  private normalizeId(value: string) {
    try { return normalizeDirectLlmProviderId(value); }
    catch (error) { throw invalid(error instanceof Error ? error.message : "直连模型提供商 ID 无效"); }
  }

  /**
   * 密钥字段的三态语义，create 与 update 共用：
   *   undefined（省略）→ 保持已保存的密钥（create 时等价于未配置）；
   *   ""（显式空串）  → 清除密钥；
   *   非空字符串      → 替换密钥。
   * 校验只做长度与换行检查，不打印、不记录、不回显内容。
   */
  private resolveApiKeyInput(provided: string | undefined, existing: string) {
    if (provided === undefined) return existing;
    try { return normalizeDirectLlmApiKey(provided); }
    catch (error) { throw invalid(error instanceof Error ? error.message : "直连模型提供商 API 密钥无效"); }
  }

  private normalizeFields(input: { name: string; protocol: DirectLlmProtocol; baseUrl: string; apiKey?: string; apiKeyEnv?: string; models?: string[]; enabled?: boolean }, existingApiKey = "") {
    try {
      const name = normalizeDirectLlmProviderName(input.name);
      const baseUrl = normalizeDirectLlmBaseUrl(input.baseUrl);
      const apiKeyEnv = input.apiKeyEnv === undefined ? undefined : normalizeDirectLlmApiKeyEnv(input.apiKeyEnv);
      const models = input.models === undefined ? undefined : normalizeDirectLlmModels(input.models);
      const apiKey = this.resolveApiKeyInput(input.apiKey, existingApiKey);
      // 启用时必须有「一份可用密钥」：明文密钥，或（回退用的）环境变量名。
      // 这里不能用「字段有没有填」判断，否则只改名称就会把一条本来可用的配置判为不可用。
      if (input.enabled && !(name && baseUrl && (apiKey || apiKeyEnv))) {
        throw new Error("启用直连模型提供商需要同时填写名称、服务地址，以及 API 密钥（明文）或环境变量名之一");
      }
      return { name, baseUrl, apiKey, apiKeyEnv, models };
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : "直连模型提供商设置无效");
    }
  }

  /** 新建提供商。providerId 由客户端预生成并保存：重复 ID 返回 409，不静默覆盖已有配置。 */
  create(input: unknown, authorize: () => void): DirectLlmProvider {
    const parsed = createDirectLlmProvider.safeParse(input);
    if (!parsed.success) throw invalid("新建直连模型提供商需要 providerId/name/protocol/baseUrl，apiKey 与 apiKeyEnv 至少其一；models 与 enabled 可选；不接受未知字段");
    const providerId = this.normalizeId(parsed.data.providerId);
    const fields = this.normalizeFields(parsed.data, "");
    if (this.store.getDocument(SYSTEM, COLLECTION, directLlmProviderDocumentId(providerId))) {
      throw new HttpError(409, `直连模型提供商 ${providerId} 已存在；响应丢失时用 get_direct_llm_provider 读同一 ID 对账，不换 ID 重建`, "PROVIDER_ALREADY_EXISTS");
    }
    try {
      this.store.putDocumentChecked<SavedProvider>(SYSTEM, COLLECTION, {
        id: directLlmProviderDocumentId(providerId), revision: 0, providerId,
        name: fields.name, protocol: parsed.data.protocol, baseUrl: fields.baseUrl,
        apiKey: fields.apiKey, apiKeyEnv: fields.apiKeyEnv ?? "", models: fields.models ?? [], modelsFetchedAt: null,
        enabled: parsed.data.enabled === true,
      }, 0, authorize);
    } catch (error) {
      if (error instanceof Error && error.message === "DOCUMENT_CONFLICT") {
        throw new HttpError(409, `直连模型提供商 ${providerId} 已存在；响应丢失时用 get_direct_llm_provider 读同一 ID 对账，不换 ID 重建`, "PROVIDER_ALREADY_EXISTS");
      }
      throw error;
    }
    // 只记录「有密钥」与来源，绝不记录密钥内容。
    log("info", "direct_llm.provider_saved", { providerId, protocol: parsed.data.protocol, enabled: parsed.data.enabled === true, credentialSource: fields.apiKey ? "provider-apiKey" : fields.apiKeyEnv ? "environment" : "unset", revision: 1 });
    return this.get(providerId);
  }

  /** 完整替换一个提供商的名称/协议/地址/密钥/启用状态；models 省略表示保持现有列表。 */
  update(providerId: string, input: unknown, authorize: () => void): DirectLlmProvider {
    const id = this.normalizeId(providerId);
    const parsed = updateDirectLlmProvider.safeParse(input);
    if (!parsed.success) throw invalid("更新直连模型提供商需要当前 revision 与 name/protocol/baseUrl/enabled；apiKey 省略表示保持已保存密钥、空串表示清除；models 省略表示保持现有列表；不接受未知字段");
    const existing = this.resolveProvider(id);
    const fields = this.normalizeFields(parsed.data, existing?.apiKey ?? "");
    const models = fields.models ?? existing?.models ?? [];
    // 保留 apiKeyEnv 的三态：省略保持，空串清除。
    const apiKeyEnv = parsed.data.apiKeyEnv === undefined ? existing?.apiKeyEnv ?? "" : fields.apiKeyEnv ?? "";
    if (parsed.data.enabled && !(fields.name && fields.baseUrl && (fields.apiKey || apiKeyEnv))) {
      throw invalid("启用直连模型提供商需要同时填写名称、服务地址，以及 API 密钥（明文）或环境变量名之一");
    }
    try {
      // 写入新式文档：它同时完成 1.5.39 单例的迁移（旧文档在下面被删掉）。
      this.store.putDocumentChecked<SavedProvider>(SYSTEM, COLLECTION, {
        id: directLlmProviderDocumentId(id), revision: parsed.data.revision, providerId: id,
        name: fields.name, protocol: parsed.data.protocol, baseUrl: fields.baseUrl,
        apiKey: fields.apiKey, apiKeyEnv, models, modelsFetchedAt: existing?.modelsFetchedAt ?? null,
        enabled: parsed.data.enabled,
      }, parsed.data.revision, authorize);
    } catch (error) {
      if (error instanceof Error && error.message === "DOCUMENT_CONFLICT") throw conflict();
      throw error;
    }
    // 迁移：保留默认提供商上一次保存后，旧单例不再参与解析，避免同一 ID 有两个真相。
    if (id === legacyDirectLlmProviderId && this.legacySingleton()) {
      this.store.deleteDocument(SYSTEM, COLLECTION, DIRECT_LLM_LEGACY_SINGLETON_ID);
    }
    log("info", "direct_llm.provider_saved", {
      providerId: id, protocol: parsed.data.protocol, enabled: parsed.data.enabled,
      credentialSource: fields.apiKey ? "provider-apiKey" : apiKeyEnv ? "environment" : "unset",
      credentialChanged: parsed.data.apiKey !== undefined, revision: parsed.data.revision + 1,
    });
    return this.get(id);
  }

  /** revision 保护的删除；保留的默认提供商只能被清空（enabled=false），不能被删除。 */
  remove(providerId: string, input: unknown, authorize: () => void): { providerId: string; deleted: boolean; nextAction: string } {
    const id = this.normalizeId(providerId);
    const parsed = deleteDirectLlmProvider.safeParse(input);
    if (!parsed.success) throw invalid("删除直连模型提供商需要当前 revision；不接受未知字段");
    if (id === legacyDirectLlmProviderId) {
      throw invalid("保留的默认提供商不能删除：它承载 1.5.39 单例与环境默认值。请改为 update 清空字段（enabled=false），或让步骤显式选择另一个提供商");
    }
    if (!this.store.getDocument(SYSTEM, COLLECTION, directLlmProviderDocumentId(id))) {
      throw new HttpError(404, `直连模型提供商不存在：${id}；先用 list_direct_llm_providers 读取当前目录`, "DIRECT_LLM_PROVIDER_NOT_FOUND");
    }
    try {
      this.store.deleteDocumentChecked(SYSTEM, COLLECTION, directLlmProviderDocumentId(id), parsed.data.revision, authorize);
    } catch (error) {
      if (error instanceof Error && error.message === "DOCUMENT_CONFLICT") throw conflict("直连模型提供商删除冲突：对象已被改动，请重新读取 revision 后再决定；不要重放删除");
      throw error;
    }
    log("info", "direct_llm.provider_deleted", { providerId: id });
    return { providerId: id, deleted: true, nextAction: "list_direct_llm_providers" };
  }

  /**
   * 查询上游可用模型并缓存到该提供商。
   * 失败一律抛错（含上游状态码与脱敏摘要），不写空列表、不静默清空缓存；
   * 成功时把上游列表与本地手填项合并去重（上游顺序优先），手填项永不丢失。
   */
  async queryModels(providerId: string, authorize: () => void, timeoutMs: number = workflowTimeoutMs(defaultWorkflowTimeoutMinutes)): Promise<DirectLlmModelQuery> {
    const id = this.normalizeId(providerId);
    const provider = this.resolveProvider(id);
    if (!provider) throw new HttpError(404, `直连模型提供商不存在：${id}；先用 list_direct_llm_providers 读取当前目录`, "DIRECT_LLM_PROVIDER_NOT_FOUND");
    if (!provider.baseUrl) throw invalid(`直连模型提供商「${id}」未配置服务地址：请先保存服务地址，再查询可用模型`);
    const { fetched } = await requestDirectLlmModels(
      { providerId: id, protocol: provider.protocol, baseUrl: provider.baseUrl, apiKey: provider.apiKey, apiKeyEnv: provider.apiKeyEnv },
      timeoutMs,
    );
    const { added, models } = mergeDirectLlmModels(fetched, provider.models);
    const modelsFetchedAt = new Date().toISOString();
    // 并发写：查询期间别人改了同一提供商就返回 409，不覆盖对方刚保存的配置，也不静默丢弃本次结果。
    try {
      this.store.putDocumentChecked<SavedProvider>(SYSTEM, COLLECTION, {
        id: directLlmProviderDocumentId(id), revision: provider.revision, providerId: id, name: provider.name,
        protocol: provider.protocol, baseUrl: provider.baseUrl, apiKey: provider.apiKey, apiKeyEnv: provider.apiKeyEnv,
        models, modelsFetchedAt, enabled: provider.enabled,
      }, provider.revision, authorize);
    } catch (error) {
      if (error instanceof Error && error.message === "DOCUMENT_CONFLICT") {
        throw conflict("查询模型期间该提供商已被改动，本次结果未写入缓存；请重新读取后再次查询");
      }
      throw error;
    }
    if (id === legacyDirectLlmProviderId && this.legacySingleton()) {
      this.store.deleteDocument(SYSTEM, COLLECTION, DIRECT_LLM_LEGACY_SINGLETON_ID);
    }
    log("info", "direct_llm.models_queried", { providerId: id, protocol: provider.protocol, fetched: fetched.length, kept: added.length });
    return { format: DIRECT_LLM_MODEL_QUERY_FORMAT, providerId: id, revision: provider.revision + 1, fetched, added, models, modelsFetchedAt, nextAction: "use_model_ids_in_step_or_provider" };
  }

  /** 只读自检：契约与当前提供商目录，供 AI 首次使用前确认。永不返回密钥明文。 */
  contract(input: unknown = {}) {
    const list = this.read(input);
    return {
      ...DIRECT_LLM_CONTRACT,
      protocolLabels: { ...directLlmProtocolLabels },
      secretStorageNotice: DIRECT_LLM_SECRET_STORAGE_NOTICE,
      providers: directLlmProviderListSchema.parse(list),
    };
  }

  /** 契约级的提供商记录校验（供测试与自检断言响应形状）。 */
  static parseProvider(value: unknown) { return directLlmProviderSchema.parse(value); }
  /** 契约级的提供商 ID 校验（供调用方在请求前自检）。 */
  static parseProviderId(value: unknown) { return directLlmProviderIdSchema.parse(value); }
}
