import { Check, KeyRound, LoaderCircle, Plug, Plus, RefreshCw, Save, ShieldAlert, Trash2, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { createDirectLlmProvider, deleteDirectLlmProvider, loadDirectLlmProviders, queryDirectLlmModels, updateDirectLlmProvider } from "../lib/api";
import type { DirectLlmProvider } from "../types";

/** 与后端 normalizeDirectLlmBaseUrl 同一口径；允许本机/内网地址（直连通常就是本机代理）。 */
export function directLlmBaseUrlError(value: string): string {
  const text = value.trim();
  if (!text) return "";
  if (text.length > 512) return "地址过长，最多 512 个字符。";
  if (/[\0\r\n\t]/.test(text)) return "地址不能包含控制字符。";
  let parsed: URL;
  try { parsed = new URL(text); } catch { return "请填写完整的 http(s) 地址，例如 https://api.example.com/v1 或 http://127.0.0.1:11434/v1。"; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "只支持 http 或 https 地址。";
  if (parsed.username || parsed.password) return "地址不能内嵌用户名或密码；密钥请在下面单独填写。";
  if (parsed.search || parsed.hash) return "地址不能带查询串或片段（#）。";
  return "";
}

/** 明文密钥的长度校验；**从不回显、不比较内容**。留空表示「保持已保存的密钥不变」。 */
export function directLlmApiKeyError(value: string): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length > 512) return "API 密钥过长，最多 512 个字符。";
  if (/[\r\n\0]/.test(trimmed)) return "API 密钥不能包含换行或空字符。";
  return "";
}

/** 兼容回退的环境变量名：只校验变量名格式。 */
export function directLlmApiKeyEnvError(value: string): string {
  const text = value.trim();
  if (!text) return "";
  return /^[A-Z][A-Z0-9_]{0,127}$/.test(text) ? "" : "只填写环境变量名：大写字母、数字与下划线，且以字母开头（例如 OPENAI_API_KEY）。不要把密钥本身填在这里。";
}

export function directLlmProviderIdError(value: string): string {
  const text = value.trim();
  if (!text) return "需要填写提供商 ID。";
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(text) ? "" : "ID 只能使用字母、数字和 _ . -，且以字母或数字开头。";
}

export const directLlmProtocolOptions: Array<{ value: DirectLlmProvider["protocol"]; label: string; hint: string }> = [
  { value: "openai-chat", label: "OpenAI Chat 兼容", hint: "POST <地址>/chat/completions，Authorization: Bearer <密钥>" },
  { value: "anthropic", label: "Anthropic Messages", hint: "POST <地址>/messages，x-api-key + anthropic-version 2023-06-01" },
];

interface Draft {
  providerId: string;
  name: string;
  protocol: DirectLlmProvider["protocol"];
  baseUrl: string;
  /** 页面上填写的明文密钥草稿；空串表示「保持已保存的密钥」（编辑已有提供商时）。 */
  apiKey: string;
  apiKeyEnv: string;
  models: string;
  enabled: boolean;
}

const emptyDraft = (): Draft => ({ providerId: "", name: "", protocol: "openai-chat", baseUrl: "", apiKey: "", apiKeyEnv: "", models: "", enabled: false });

/** 编辑已有提供商时密钥框**始终留空**：明文不会回填到页面，留空即保持原值。 */
function draftOf(provider: DirectLlmProvider): Draft {
  return {
    providerId: provider.providerId, name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl,
    apiKey: "", apiKeyEnv: provider.apiKeyEnv, models: provider.models.join("\n"), enabled: provider.enabled,
  };
}

/** 手填与查询结果按同一口径拆分：换行分隔、去空白、去重、保持顺序。 */
export function directLlmModelLines(value: string): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const line of value.split("\n")) {
    const model = line.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

/** 稳定 ID：新提供商默认用浏览器 UUID，用户也可以改成可读的 slug。 */
function newProviderId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "provider-" + Date.now().toString(36);
}

export default function DirectLlmConfig() {
  const [providers, setProviders] = useState<DirectLlmProvider[]>([]);
  const [revision, setRevision] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [clearingKey, setClearingKey] = useState(false);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const [error, setError] = useState("");
  const [modelNotice, setModelNotice] = useState("");

  const selected = providers.find((provider) => provider.providerId === selectedId);

  function adopt(list: DirectLlmProvider[], listRevision: string, more: boolean, cursor: string | undefined, keepId?: string) {
    setProviders(list);
    setRevision(listRevision);
    setHasMore(more);
    setNextCursor(cursor);
    const wanted = keepId && list.some((provider) => provider.providerId === keepId) ? keepId : list[0]?.providerId ?? "";
    setSelectedId(wanted);
    const found = list.find((provider) => provider.providerId === wanted);
    setDraft(found ? draftOf(found) : emptyDraft());
  }

  async function read(keepId?: string) {
    setLoading(true);
    setError("");
    setNotice("");
    setModelNotice("");
    try {
      const page = await loadDirectLlmProviders();
      adopt(page.providers, page.revision, page.hasMore, page.nextCursor, keepId);
      setNeedsReconcile(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取直连模型提供商目录");
      setNeedsReconcile(true);
    } finally { setLoading(false); }
  }
  useEffect(() => { void read(); }, []);

  async function loadMore() {
    if (!nextCursor) return;
    setLoading(true);
    setError("");
    try {
      const page = await loadDirectLlmProviders({ cursor: nextCursor });
      // 分页只在同一 revision 内追加；服务端在目录变化时返回 409，交给下面的错误分支。
      setProviders((current) => [...current, ...page.providers.filter((provider) => !current.some((item) => item.providerId === provider.providerId))]);
      setRevision(page.revision);
      setHasMore(page.hasMore);
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setError((reason instanceof Error ? reason.message : "无法继续读取提供商目录") + "。请重新读取第一页，不要拼接两个目录快照。");
      setNeedsReconcile(true);
    } finally { setLoading(false); }
  }

  function select(provider: DirectLlmProvider) {
    setSelectedId(provider.providerId);
    setDraft(draftOf(provider));
    setError("");
    setNotice("");
    setModelNotice("");
    setClearingKey(false);
  }

  function startCreate() {
    setSelectedId("");
    setDraft({ ...emptyDraft(), providerId: newProviderId() });
    setError("");
    setNotice("");
    setModelNotice("");
    setClearingKey(false);
  }

  const baseUrlError = directLlmBaseUrlError(draft.baseUrl);
  const apiKeyError = directLlmApiKeyError(draft.apiKey);
  const apiKeyEnvError = directLlmApiKeyEnvError(draft.apiKeyEnv);
  const providerIdError = directLlmProviderIdError(draft.providerId);
  // 「有没有密钥」既看正在填的草稿，也看已保存的那一份：只改名称不会让配置变不完整。
  const keyUsable = Boolean(draft.apiKey.trim()) || Boolean(selected?.hasApiKey) || Boolean(draft.apiKeyEnv.trim());
  const incomplete = draft.enabled && (!draft.name.trim() || !draft.baseUrl.trim() || !keyUsable);
  const invalid = Boolean(baseUrlError || apiKeyError || apiKeyEnvError || providerIdError) || incomplete;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (needsReconcile || invalid || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    setModelNotice("");
    const models = directLlmModelLines(draft.models);
    const typedKey = draft.apiKey.trim();
    try {
      const saved = selected
        ? await updateDirectLlmProvider(selected.providerId, {
          revision: selected.revision, name: draft.name.trim(), protocol: draft.protocol,
          baseUrl: draft.baseUrl.trim(), models, enabled: draft.enabled,
          // 密钥框留空 → 不传该字段 → 服务端保持已保存的密钥不变（只改名称不会清空它）。
          ...(typedKey ? { apiKey: typedKey } : {}),
          apiKeyEnv: draft.apiKeyEnv.trim(),
        })
        : await createDirectLlmProvider({
          providerId: draft.providerId.trim(), name: draft.name.trim(), protocol: draft.protocol,
          baseUrl: draft.baseUrl.trim(), models, enabled: draft.enabled,
          ...(typedKey ? { apiKey: typedKey } : {}),
          ...(draft.apiKeyEnv.trim() ? { apiKeyEnv: draft.apiKeyEnv.trim() } : {}),
        });
      await read(saved.providerId);
      setNotice(saved.enabled
        ? `提供商「${saved.name}」已保存并启用；core.llm 勾选「直连模型提供商」并选择它后会直接请求 ${saved.baseUrl}${saved.request.endpointSuffix}，不再经过 Hermes。`
        : `提供商「${saved.name}」已保存为关闭；core.llm 步骤选择它时会明确失败，不会静默回退 Hermes。`);
    } catch (reason) {
      // The server may already have committed. Disable writes until the operator explicitly reconciles.
      setNeedsReconcile(true);
      setError((reason instanceof Error ? reason.message : "保存回执未知") + "。请先重新读取目录核对，不要重复提交旧请求。");
    } finally { setSaving(false); }
  }

  /** 显式清除密钥：提交空串（三态里的「清除」），与「留空=保持」区分开。 */
  async function clearKey() {
    if (!selected || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    setModelNotice("");
    try {
      const saved = await updateDirectLlmProvider(selected.providerId, {
        revision: selected.revision, name: selected.name, protocol: selected.protocol, baseUrl: selected.baseUrl,
        models: selected.models, enabled: selected.enabled, apiKey: "", apiKeyEnv: selected.apiKeyEnv,
      });
      await read(saved.providerId);
      setNotice(`提供商「${saved.name}」已保存的明文密钥已清除。`);
    } catch (reason) {
      setNeedsReconcile(true);
      setError((reason instanceof Error ? reason.message : "清除回执未知") + "。请先重新读取目录核对，不要重复提交。");
    } finally { setSaving(false); setClearingKey(false); }
  }

  async function remove() {
    if (!selected || selected.reservedDefault || deleting) return;
    setDeleting(true);
    setError("");
    setNotice("");
    setModelNotice("");
    try {
      await deleteDirectLlmProvider(selected.providerId, selected.revision);
      await read();
      setNotice(`提供商「${selected.name}」已删除。历史运行与已发布快照不受影响；引用它的新执行会明确失败。`);
    } catch (reason) {
      setNeedsReconcile(true);
      setError((reason instanceof Error ? reason.message : "删除回执未知") + "。请先重新读取目录核对，不要重复提交删除。");
    } finally { setDeleting(false); }
  }

  async function queryModels() {
    if (!selected || querying) return;
    setQuerying(true);
    setError("");
    setModelNotice("");
    try {
      const result = await queryDirectLlmModels(selected.providerId);
      setDraft((current) => ({ ...current, models: result.models.join("\n") }));
      await read(selected.providerId);
      setModelNotice(result.added.length
        ? `已从上游读取 ${result.fetched.length} 个模型；保留 ${result.added.length} 个上游没有返回的手填模型（${result.added.join("、")}）。`
        : `已从上游读取 ${result.fetched.length} 个模型并缓存。`);
    } catch (reason) {
      // 查询失败不写缓存：草稿保持原样，明确告诉用户失败原因，不用空列表冒充结果。
      setError(reason instanceof Error ? reason.message : "查询可用模型失败");
    } finally { setQuerying(false); }
  }

  const busy = loading || saving || deleting;
  const protocol = directLlmProtocolOptions.find((option) => option.value === draft.protocol)!;
  return (
    <form className="connection-settings" onSubmit={save}>
      <div className="connection-section-heading"><div><span className="section-index">06</span><div><h2>直连模型提供商</h2><p>让大模型调用步骤脱离 Hermes，直接请求你配置的兼容端点；管理员配置，可配置多个提供商</p></div></div><button type="button" className="button button-outline" onClick={() => void read(selectedId)} disabled={busy}><RefreshCw size={14} />重新读取目录</button></div>
      <div className="connection-fields">
        <div className="field-group">
          <label className="field-label" htmlFor="direct-llm-provider-select">提供商（{providers.length}{hasMore ? "+" : ""}）</label>
          <div className="select-wrap">
            <select id="direct-llm-provider-select" value={selectedId} onChange={(event) => { const found = providers.find((provider) => provider.providerId === event.target.value); if (found) select(found); }} disabled={busy}>
              <option value="">＋ 新建提供商</option>
              {providers.map((provider) => <option key={provider.providerId} value={provider.providerId}>{provider.name || provider.providerId} · {provider.protocol}{provider.enabled ? " · 已启用" : " · 已关闭"}{provider.reservedDefault ? " · 保留默认" : ""}</option>)}
            </select>
          </div>
          <div className="direct-llm-provider-actions">
            <button type="button" className="text-button" onClick={startCreate} disabled={busy}><Plus size={13} />新建提供商</button>
            {hasMore && <button type="button" className="text-button" onClick={() => void loadMore()} disabled={busy}>读取更多</button>}
            {selected && !selected.reservedDefault && <button type="button" className="text-button danger-text" onClick={() => void remove()} disabled={busy}>{deleting ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}删除此提供商</button>}
          </div>
          <small className="field-help">列表 revision {revision.slice(0, 8) || "—"}；每个提供商是独立记录、各自 revision 保护，编辑一个不会让另一个的写入冲突。目录变化时游标会失效，需重读第一页。</small>
          {selected?.reservedDefault && <small className="field-help"><Plug size={13} />这是保留的默认提供商（{selected.origin === "legacy-singleton" ? "来自 1.5.39 单例" : "来自环境默认值"}），承载未指定提供商的旧步骤；可以保存覆盖它，但不能删除。第一次保存后它会成为普通记录（revision 从 1 起）。</small>}
        </div>

        <div className="field-group">
          <label className="field-label" htmlFor="direct-llm-name">显示名</label>
          <input id="direct-llm-name" className="text-input" value={draft.name} placeholder="例如 本机 Ollama / 公司 Anthropic 代理" onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} disabled={busy || needsReconcile} />
        </div>

        <div className="field-group">
          <label className="field-label" htmlFor="direct-llm-protocol">协议</label>
          <div className="select-wrap">
            <select id="direct-llm-protocol" value={draft.protocol} onChange={(event) => setDraft((current) => ({ ...current, protocol: event.target.value as DirectLlmProvider["protocol"] }))} disabled={busy || needsReconcile}>
              {directLlmProtocolOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <small className="field-help">实际请求：<code>{protocol.hint}</code>。查询可用模型对两种协议都是 <code>GET &lt;地址&gt;/models</code>。</small>
        </div>

        <div className="field-group">
          <label className="field-label" htmlFor="direct-llm-base-url">服务地址</label>
          <input id="direct-llm-base-url" className="text-input mono-input" value={draft.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))} disabled={busy || needsReconcile} aria-invalid={Boolean(baseUrlError)} />
          <small className="field-help">末尾斜杠会被去掉。允许本机与内网地址（例如 <code>http://127.0.0.1:11434/v1</code>）；不接受地址内嵌用户名密码、查询串或片段。</small>
          <small className="field-help"><Plug size={13} /> 这是对「第三方请求仅公网地址」的有意例外：直连的常见形态就是本机代理或自建网关。</small>
        </div>

        <div className="field-group">
          <label className="field-label" htmlFor="direct-llm-api-key">API 密钥</label>
          <input id="direct-llm-api-key" className="text-input mono-input" type="password" value={draft.apiKey} placeholder={selected?.hasApiKey ? `已保存（${selected.credential.apiKeyMasked}）；留空表示不修改` : "直接填写 API 密钥"} onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))} disabled={busy || needsReconcile} aria-invalid={Boolean(apiKeyError)} autoComplete="new-password" spellCheck={false} />
          <small className="field-help">
            {selected?.hasApiKey
              ? <>已保存密钥（{selected.credential.apiKeyMasked}）。<b>留空即保持原值</b>：只改名称或地址不会清空它。要清除请用下面的「清除已保存密钥」。</>
              : <>直接填写该提供商的 API 密钥。密钥以<b>明文保存在本机 SQLite</b>，请自行保护数据目录、数据库副本与备份。</>}
          </small>
          <div className="direct-llm-provider-actions">
            {selected?.hasApiKey && (clearingKey
              ? <><span className="field-help">确认清除已保存的密钥？清除后该提供商在填新密钥前不可用。</span><button type="button" className="text-button danger-text" onClick={() => void clearKey()} disabled={busy}>确认清除</button><button type="button" className="text-button" onClick={() => setClearingKey(false)} disabled={busy}>取消</button></>
              : <button type="button" className="text-button danger-text" onClick={() => setClearingKey(true)} disabled={busy}>清除已保存密钥</button>)}
          </div>
          {selected && <small className="field-help"><KeyRound size={13} />当前密钥来源：{selected.credential.source === "provider-apiKey" ? `页面上保存的明文密钥（末 4 位 ${selected.credential.lastFour || "—"}）` : selected.credential.source === "environment" ? "环境变量回退" : "未配置"} · {selected.credential.configured ? "可用" : "不可用"}。</small>}
        </div>

        <div className="field-group">
          <label className="field-label" htmlFor="direct-llm-api-key-env">环境变量回退（可选）</label>
          <input id="direct-llm-api-key-env" className="text-input mono-input" value={draft.apiKeyEnv} placeholder="OPENAI_API_KEY" onChange={(event) => setDraft((current) => ({ ...current, apiKeyEnv: event.target.value }))} disabled={busy || needsReconcile} aria-invalid={Boolean(apiKeyEnvError)} autoComplete="off" spellCheck={false} />
          <small className="field-help">只在上面没有填明文密钥时使用：这里只填<b>变量名</b>，值由工作台服务进程环境提供。留空表示不使用回退。</small>
        </div>

        <div className="field-group">
          <label className="field-label" htmlFor="direct-llm-provider-id">提供商 ID</label>
          <input id="direct-llm-provider-id" className="text-input mono-input" value={draft.providerId} onChange={(event) => setDraft((current) => ({ ...current, providerId: event.target.value }))} disabled={Boolean(selected) || busy || needsReconcile} aria-invalid={Boolean(providerIdError)} spellCheck={false} />
          <small className="field-help">稳定 ID（默认预生成 UUID，也可改成可读 slug）；它同时是记录的主键，新建后不可改。保存响应丢失时用同一 ID 读取对账，不要换 ID 重建。</small>
          {providerIdError && <small className="field-help" role="alert">{providerIdError}</small>}
        </div>

        <div className="field-group">
          <label className="field-label" htmlFor="direct-llm-models">模型（每行一个）</label>
          <textarea id="direct-llm-models" className="text-input mono-input direct-llm-models" value={draft.models} placeholder={"gpt-4o-mini\nqwen2.5-7b-instruct"} onChange={(event) => setDraft((current) => ({ ...current, models: event.target.value }))} disabled={busy || needsReconcile} rows={5} spellCheck={false} />
          <div className="direct-llm-provider-actions">
            <button type="button" className="text-button" onClick={() => void queryModels()} disabled={!selected || querying || busy || needsReconcile}>{querying ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{querying ? "查询中…" : "查询可用模型"}</button>
          </div>
          <small className="field-help">可以手填上游 <code>/models</code> 没有返回的名字。查询会真实访问该提供商一次（GET <code>/models</code>，不调用模型、不计生成费用），成功后在保留手填项的前提下合并缓存；失败会明确报错，不会清空列表或伪装成空结果。</small>
          {selected?.modelsFetchedAt && <small className="field-help">上次查询成功：{new Date(selected.modelsFetchedAt).toLocaleString()} · 当前缓存 {selected.models.length} 个模型。</small>}
        </div>

        <div className="field-group">
          <label className="field-label" htmlFor="direct-llm-enabled"><input id="direct-llm-enabled" type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} disabled={busy || needsReconcile} /> 启用此提供商</label>
          <small className="field-help">关闭（默认）时它不能被 direct 步骤使用，执行会明确失败而不是静默回退 Hermes；只有 core.llm 里显式勾选 <code>direct</code> 并选中此提供商的调用才会走这里。</small>
        </div>
      </div>

      <div className="notice"><ShieldAlert size={15} /><span>API 密钥以明文保存在本机 SQLite 中（产品明确选择的存储方式）。它能被读到的范围就是数据目录、数据库副本与备份：请自行保护它们。密钥不会回显到本页、日志、运行记录、运行输入、发布快照或任何导出清单。</span></div>
      {!draft.enabled && (draft.name || draft.baseUrl || draft.apiKeyEnv || draft.apiKey) && <div className="notice"><Plug size={15} />当前保存为关闭状态；地址、模型与密钥会被保留，重新勾选「启用此提供商」即可再次生效。</div>}
      {selected && <small className="field-help">服务端快照：revision {selected.revision} · 来源 {selected.origin === "saved" ? "已保存到系统数据库" : selected.origin === "legacy-singleton" ? "1.5.39 单例（保存后迁移为普通记录）" : "环境默认值"} · {selected.configured ? "已启用且字段完整" : selected.enabled ? "已启用但密钥或地址不完整" : "已关闭"} · 请求 POST {selected.request.endpointSuffix} · 超时跟随单步超时。</small>}
      {baseUrlError && <div className="notice error-notice"><X size={15} />{baseUrlError}</div>}
      {apiKeyError && <div className="notice error-notice"><X size={15} />{apiKeyError}</div>}
      {apiKeyEnvError && <div className="notice error-notice"><X size={15} />{apiKeyEnvError}</div>}
      {incomplete && !baseUrlError && !apiKeyError && !apiKeyEnvError && <div className="notice error-notice"><X size={15} />启用提供商需要同时填写显示名、服务地址，以及 API 密钥（或环境变量回退名）；缺少任意一项都不会保存。</div>}
      {modelNotice && <div className="notice success-notice"><Check size={15} />{modelNotice}</div>}
      {notice && <div className="notice success-notice"><Check size={15} />{notice}</div>}
      {error && <div className="notice error-notice"><X size={15} />{error}</div>}
      <div className="connection-form-footer"><span>跨重启保存；配置、校验与查询模型都不调用模型，只有提交执行才发出补全请求并可能计费。</span><button className="button button-dark" type="submit" disabled={busy || needsReconcile || invalid}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{saving ? "保存中…" : selected ? "保存此提供商" : "新建提供商"}</button></div>
    </form>
  );
}
