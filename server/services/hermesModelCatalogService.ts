import { contentRevision } from "../domain/sceneContent.js";
import { asRecord } from "../domain/workflowValues.js";
import { HttpError } from "../errors.js";
import type { HermesModelCatalogPage, HermesModelProviderSummary } from "../domain/hermesModelContracts.js";
import { hermesApiRoute, listHermesProfiles, readHermesApiConnection } from "./hermesProfiles.js";
import { fetchHermesWithRetry, hermesTransportError } from "../hermesTransport.js";

export type { HermesModelCatalogPage, HermesModelProviderSummary } from "../domain/hermesModelContracts.js";

/** One selectable provider row. Credentials, key environment names and upstream endpoints are
 *  never projected: configuring a step only needs the slug and its model ids. */
export type HermesModelProvider = HermesModelProviderSummary;

export type HermesModelCatalog = HermesModelCatalogPage;

export interface HermesModelQuery {
  profile: string;
  q?: string;
  limit?: number;
  cursor?: string;
  refresh?: boolean;
  includeUnconfigured?: boolean;
}

const defaultProviderLimit = 24;
const maximumProviderLimit = 100;
const modelsPerProvider = 200;
const catalogCacheMs = 60_000;

function profileError(profile: unknown): string | undefined {
  if (typeof profile !== "string" || !profile.trim()) return "请选择要读取模型目录的 Hermes Profile";
  if (profile.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) return "Hermes Profile 名称无效";
  return undefined;
}

function providerRows(payload: unknown): Record<string, unknown>[] {
  const record = asRecord(payload);
  const providers = record?.providers;
  if (!Array.isArray(providers)) return [];
  return providers.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row));
}

function projectProvider(row: Record<string, unknown>): HermesModelProvider {
  const slug = typeof row.slug === "string" ? row.slug : "";
  const rawModels = Array.isArray(row.models) ? row.models : [];
  const models = rawModels.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
  const declaredTotal = typeof row.total_models === "number" && Number.isFinite(row.total_models) ? Math.max(0, Math.floor(row.total_models)) : models.length;
  const limited = models.slice(0, modelsPerProvider);
  return {
    slug,
    name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : slug,
    isCurrent: row.is_current === true,
    authenticated: row.authenticated === true,
    isUserDefined: row.is_user_defined === true,
    models: limited,
    totalModels: Math.max(declaredTotal, models.length),
    modelsTruncated: limited.length < models.length || Math.max(declaredTotal, models.length) > limited.length,
  };
}

function matchesQuery(provider: HermesModelProvider, needle: string) {
  if (!needle) return true;
  const lower = needle.toLowerCase();
  return provider.slug.toLowerCase().includes(lower)
    || provider.name.toLowerCase().includes(lower)
    || provider.models.some((model) => model.toLowerCase().includes(lower));
}

/** Newest rows first for a picker: the profile's current provider, then credentialed rows with
 *  models, then the rest by name — stable so a cursor keeps pointing at the same row. */
function sortProviders(providers: HermesModelProvider[]) {
  const rank = (provider: HermesModelProvider) => provider.isCurrent ? 0 : provider.authenticated && provider.models.length ? 1 : provider.models.length ? 2 : 3;
  return providers.sort((left, right) => rank(left) - rank(right) || left.slug.localeCompare(right.slug));
}

/**
 * Read-only projection of the Hermes gateway's own model picker inventory
 * (``GET /api/model/options``), scoped to one Profile through the ``/p/<profile>/`` mirror.
 * Never writes, never generates and never returns credentials or upstream endpoints.
 */
export class HermesModelCatalogService {
  private readonly cache = new Map<string, { expires: number; payload: unknown }>();

  /** ``home`` is injectable so a caller (or a test) can target a specific Hermes install
   *  without mutating process environment, which is resolved once at config load time. */
  constructor(private readonly now: () => number = () => Date.now(), private readonly home?: string) {}

  private async readGatewayPayload(profile: string, refresh: boolean) {
    const cached = this.cache.get(profile);
    if (!refresh && cached && cached.expires > this.now()) return cached.payload;
    const connection = await readHermesApiConnection(profile, this.home);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetchHermesWithRetry(hermesApiRoute(connection.baseUrl, profile, "api/model/options"), {
        headers: { Authorization: `Bearer ${connection.apiKey}`, "Content-Type": "application/json" },
        signal: controller.signal,
      }, { retryUnknownNetworkErrors: true });
      const body = await response.json().catch(() => null) as unknown;
      if (response.status === 401 || response.status === 403) {
        throw new HttpError(502, `Hermes Profile「${profile}」API 密钥认证失败，无法读取模型目录`, "HERMES_MODELS_UNAVAILABLE");
      }
      if (!response.ok) {
        const envelope = asRecord(body);
        const apiError = asRecord(envelope?.error);
        const message = typeof apiError?.message === "string" ? apiError.message : typeof envelope?.error === "string" ? envelope.error : `HTTP ${response.status}`;
        throw new HttpError(502, `Hermes 模型目录读取失败：${message}`, "HERMES_MODELS_UNAVAILABLE");
      }
      this.cache.set(profile, { expires: this.now() + catalogCacheMs, payload: body });
      return body;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new HttpError(502, `Hermes 模型目录读取超时（Profile「${profile}」）`, "HERMES_MODELS_UNAVAILABLE");
      }
      if (error instanceof TypeError) throw hermesTransportError(profile, connection, "model/options", error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async list(query: HermesModelQuery): Promise<HermesModelCatalog> {
    const invalid = profileError(query.profile);
    if (invalid) throw new HttpError(400, invalid, "INVALID_HERMES_MODEL_QUERY");
    const profile = String(query.profile).trim();
    const limit = query.limit === undefined ? defaultProviderLimit : query.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumProviderLimit) {
      throw new HttpError(400, `单页Provider数量必须是 1 到 ${maximumProviderLimit} 的整数`, "INVALID_HERMES_MODEL_QUERY");
    }
    const known = await listHermesProfiles(this.home);
    if (!known.some((item) => item.id === profile)) {
      throw new HttpError(404, `本机没有找到 Hermes Profile「${profile}」；请先读取可用 Profile 列表`, "HERMES_PROFILE_NOT_FOUND");
    }

    const payload = await this.readGatewayPayload(profile, query.refresh === true);
    const record = asRecord(payload);
    const all = sortProviders(providerRows(payload).map(projectProvider));
    const needle = typeof query.q === "string" ? query.q.trim() : "";
    const filtered = all
      .filter((provider) => query.includeUnconfigured === true || provider.models.length > 0 || provider.isCurrent || provider.authenticated)
      .filter((provider) => matchesQuery(provider, needle));
    const revision = contentRevision({ profile, providers: filtered.map((provider) => ({ slug: provider.slug, models: provider.models, totalModels: provider.totalModels })) });

    let offset = 0;
    if (query.cursor) {
      try {
        const token = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
        if (token.format !== "hermes-model-page/v1" || typeof token.revision !== "string" || token.profile !== profile || !Number.isSafeInteger(token.offset) || (token.offset as number) < 1) throw new Error("shape");
        if (token.revision !== revision) throw new HttpError(409, "Hermes 模型目录在分页期间变化，请重读第一页", "HERMES_MODEL_PAGE_CHANGED", { currentRevision: revision, nextAction: "list_hermes_models_from_start" });
        if ((token.offset as number) >= filtered.length) throw new Error("range");
        offset = token.offset as number;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "模型目录游标无效", "INVALID_HERMES_MODEL_CURSOR");
      }
    }

    const providers = filtered.slice(offset, offset + limit);
    const nextOffset = offset + providers.length;
    const hasMore = nextOffset < filtered.length;
    return {
      profile,
      revision,
      currentProvider: typeof record?.provider === "string" ? record.provider : "",
      currentModel: typeof record?.model === "string" ? record.model : "",
      providers,
      hasMore,
      ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ format: "hermes-model-page/v1", revision, profile, offset: nextOffset })).toString("base64url") } : {}),
      fetchedAt: new Date(this.now()).toISOString(),
      nextAction: "configure_hermes_step_model",
    };
  }
}
