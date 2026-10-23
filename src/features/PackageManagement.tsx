import { useEffect, useRef, useState } from "react";
import { accessApi, jsonBody } from "../lib/accessApi";
import type { SceneModule } from "../types";
import type { SceneVersionRecord } from "../types";
import PackagePageEditor, { defaultServicePage } from "./PackagePageEditor";
import type { PackagePresentation } from "../../server/domain/packageContracts.js";
import { describeCodePackageStatus, executorSelectionError, inputContractRows, inputOverridePayload, mergePackageCatalog } from "../lib/packageCatalog";

interface PackageItemDraft { id: string; name: string; sceneId: string; versionId: string; inputs: Array<{ key: string; valueSource: "input" | "literal" | "previous"; sourceRef?: string; literalValue?: string }>; confirmAfter?: boolean }
interface PackagePricingDraft { version: 1; base: number; items: Record<string, { unit: "per_call" | "per_item"; credits: number }> }
interface PackageDraft { id: string; revision: number; title: string; summary?: string; inputs: Array<Record<string, unknown>>; items: PackageItemDraft[]; pricing?: PackagePricingDraft; presentation?: PackagePresentation }

interface CodePackageConfigDraft {
  revision: number;
  enabled: boolean;
  executor?: { sceneId: string; versionId: string } | null;
  inputs?: Array<{ key: string; label?: string; required?: boolean; defaultValue?: unknown }>;
  presentation?: PackagePresentation;
  pricing?: PackagePricingDraft;
}
interface CodePackageEntry {
  packageId: string;
  status: "ok" | "error" | "disabled";
  directory: string;
  error?: string;
  entryPath?: string;
  loadedAt?: string;
  enabled: boolean;
  revision?: number;
  manifest?: { title: string; version: string; entry: string; inputs: Array<Record<string, unknown>>; executor?: { sceneId: string; versionId: string } };
  executor?: { sceneId: string; versionId: string };
  config?: CodePackageConfigDraft;
}

const emptyItem = (): PackageItemDraft => ({ id: "item-" + Math.random().toString(36).slice(2, 8), name: "新组件", sceneId: "", versionId: "", inputs: [] });

/** 一条场景包运行记录（服务端 `codeScenePackageRuns`）。 */
interface CodePackageRunDetail {
  id: string;
  packageId: string;
  packageTitle: string;
  packageRunId: string;
  executorSceneId: string;
  executorVersionId: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
  finishedAt?: string;
  runIds: string[];
  error?: string;
  errorCode?: string;
  result?: unknown;
  runs: Array<{ runId: string; sceneId: string; status: string; runTitle?: string; packageRunId?: string }>;
}

/**
 * 管理端场景包：两个来源共用这一页。
 * - 代码子工程（source: code）：磁盘上的代码包，这里只显示加载状态并做定制化配置，不提供代码编辑器。
 * - 配置型包（source: config）：有序组件 + 输入绑定 + 发布，沿用原有流程。
 */
export default function PackageManagement({ scenes, sceneVersions, onOpenRuns }: { scenes: SceneModule[]; sceneVersions: Record<string, SceneVersionRecord>; onOpenRuns?: (sceneId: string) => void }) {
  const [packages, setPackages] = useState<PackageDraft[]>([]);
  const [codePackages, setCodePackages] = useState<CodePackageEntry[]>([]);
  const [selected, setSelected] = useState<PackageDraft | null>(null);
  const [selectedCodeId, setSelectedCodeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [packageId] = useState(() => "pkg-" + crypto.randomUUID().slice(0, 8));
  /** 正在提交运行的包（null = 未打开运行面板）。 */
  const [runPackageId, setRunPackageId] = useState<string | null>(null);
  const [runInputs, setRunInputs] = useState<Record<string, string>>({});
  const [runRecord, setRunRecord] = useState<CodePackageRunDetail>();
  /** 递增序号：换一次提交或换包时让旧的轮询循环自行退出，避免写回过期结果。 */
  const runTicket = useRef(0);

  async function attempt(action: () => Promise<void>) { setError(""); try { await action(); } catch (e) { setError((e as Error).message); } }
  async function load() {
    const data = await accessApi<{ packages: Array<PackageDraft & { source?: string }>; codePackages?: CodePackageEntry[] }>("/api/v1/packages");
    setPackages(data.packages.filter(item => item.source !== "code"));
    setCodePackages(data.codePackages ?? []);
  }
  useEffect(() => { void attempt(load); }, []);

  const selectedCode = codePackages.find(item => item.packageId === selectedCodeId) ?? null;
  const catalog = mergePackageCatalog(
    packages.map(item => ({ source: "config" as const, id: item.id, title: item.title, revision: item.revision })),
    codePackages.map(item => ({
      source: "code" as const,
      packageId: item.packageId,
      title: item.manifest?.title ?? item.packageId,
      version: item.manifest?.version ?? "-",
      status: item.status,
      ...(item.error ? { error: item.error } : {}),
      directory: item.directory,
      entryPath: item.entryPath ?? "",
      enabled: item.enabled,
      executor: item.executor ?? null,
    })),
  );

  const publishedVersionOf = (sceneId: string) => {
    const record = sceneVersions[sceneId];
    return record?.publishedVersionId ?? "";
  };

  async function create() {
    setBusy(true); setError(""); setNotice("");
    try {
      const draft = {
        id: packageId, title: "新场景包", summary: "", inputs: [],
        items: [emptyItem()],
        // 新包直接带一个可发布的默认页面：管理员不需要先理解 page 区块就能看到客户端效果。
        presentation: { page: defaultServicePage("新场景包", "开始创作") },
      };
      const result = await accessApi<{ package: PackageDraft }>("/api/v1/packages", jsonBody(draft));
      setSelected(result.package);
      setNotice("已创建草稿，请填写组件与输入绑定，并在下方配置服务页面后发布");
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function save() {
    if (!selected) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await accessApi<{ package: PackageDraft }>("/api/v1/packages/" + encodeURIComponent(selected.id), { method: "PATCH", body: JSON.stringify({ revision: selected.revision, title: selected.title, summary: selected.summary, inputs: selected.inputs, items: selected.items, ...(selected.pricing ? { pricing: selected.pricing } : {}), ...(selected.presentation ? { presentation: selected.presentation } : {}) }) });
      setSelected(result.package);
      setNotice("草稿已保存 · r" + result.package.revision);
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function publish() {
    if (!selected) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await accessApi<{ version: { versionId: string; version: string }; created: boolean }>("/api/v1/packages/" + encodeURIComponent(selected.id) + "/publish", jsonBody({ revision: selected.revision, publicationId: crypto.randomUUID() }));
      setNotice((result.created ? "已发布" : "该版本已存在") + " · " + result.version.version);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function patchItem(index: number, patch: Partial<PackageItemDraft>) {
    if (!selected) return;
    setSelected({ ...selected, items: selected.items.map((item, position) => position === index ? { ...item, ...patch } : item) });
  }

  // ---- 代码子工程：配置写回服务端（revision 保护），保存后点「重新加载此包」生效 ----
  function patchCode(patch: Partial<CodePackageConfigDraft>) {
    if (!selectedCode) return;
    const base: CodePackageConfigDraft = selectedCode.config ?? { revision: selectedCode.revision ?? 0, enabled: selectedCode.enabled, executor: selectedCode.executor ?? null };
    const next = { ...base, ...patch };
    setCodePackages(current => current.map(item => item.packageId === selectedCode.packageId ? { ...item, config: next } : item));
  }
  function replaceCodeEntry(entry: CodePackageEntry) {
    setCodePackages(current => current.map(item => item.packageId === entry.packageId ? entry : item));
  }
  async function saveCode() {
    if (!selectedCode) return;
    const config = selectedCode.config;
    const executor = config?.executor ?? selectedCode.executor ?? null;
    const enabled = config?.enabled ?? selectedCode.enabled;
    if (enabled) {
      const invalid = executorSelectionError(executor?.sceneId ?? "", executor?.versionId ?? "");
      if (invalid) { setError(invalid); return; }
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await accessApi<{ package: CodePackageEntry }>("/api/v1/code-packages/" + encodeURIComponent(selectedCode.packageId), {
        method: "PATCH",
        body: JSON.stringify({
          revision: config?.revision ?? selectedCode.revision ?? 0,
          enabled,
          executor: executor ? { sceneId: executor.sceneId, versionId: executor.versionId } : null,
          // 送覆盖差异而不是全量：管理员没动过的字段留给 package.json，磁盘改标签/必填才继续生效。
          inputs: inputOverridePayload(codeInputs, selectedCode.manifest?.inputs ?? []),
          ...(config?.presentation ? { presentation: config.presentation } : {}),
          ...(config?.pricing ? { pricing: config.pricing } : {}),
        }),
      });
      replaceCodeEntry(result.package);
      setNotice("配置已保存 · r" + (result.package.revision ?? 0) + "；点「重新加载此包」让新的执行场景生效");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function toggleCode(entry: CodePackageEntry) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await accessApi<{ package: CodePackageEntry }>("/api/v1/code-packages/" + encodeURIComponent(entry.packageId), {
        method: "PATCH",
        body: JSON.stringify({ revision: entry.revision ?? entry.config?.revision ?? 0, enabled: !entry.enabled }),
      });
      replaceCodeEntry(result.package);
      setNotice((entry.enabled ? "已禁用：" : "已启用：") + entry.packageId + (entry.enabled ? "（用户面不再出现，历史运行仍可查）" : "（点「重新加载此包」开始加载）"));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function reloadCode(entry: CodePackageEntry) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await accessApi<{ package: CodePackageEntry }>("/api/v1/code-packages/" + encodeURIComponent(entry.packageId) + "/reload", { method: "POST" });
      replaceCodeEntry(result.package);
      setNotice(result.package.status === "ok" ? "已重新加载：" + entry.packageId : "重新加载失败：" + (result.package.error ?? "未知原因"));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  // 输入契约 = package.json 声明 + 管理端覆盖。不能写成 `config.inputs ?? manifest.inputs`：
  // 配置文档里的 inputs 默认是空数组，一旦保存过配置就会把 package.json 声明的字段整片盖掉。
  const codeInputs = inputContractRows(selectedCode?.manifest?.inputs ?? [], selectedCode?.config?.inputs ?? [])
    .map(field => ({
      key: String((field as Record<string, unknown>).key ?? ""),
      label: typeof (field as Record<string, unknown>).label === "string" ? (field as Record<string, unknown>).label as string : undefined,
      required: (field as Record<string, unknown>).required === true,
      defaultValue: (field as Record<string, unknown>).defaultValue,
    }));
  const codeExecutor = selectedCode?.config?.executor ?? selectedCode?.executor ?? null;

  // ---- 运行一个代码包 ----
  // 提交走管理员路由（202 + packageRunId），执行与排队全部由 RunService 负责，本页只轮询记录。
  const runEntry = runPackageId ? codePackages.find(item => item.packageId === runPackageId) : undefined;
  const runFields = inputContractRows(runEntry?.manifest?.inputs ?? [], runEntry?.config?.inputs ?? [])
    .map(field => ({
      key: String((field as Record<string, unknown>).key ?? ""),
      label: typeof (field as Record<string, unknown>).label === "string" ? (field as Record<string, unknown>).label as string : String((field as Record<string, unknown>).key ?? ""),
      required: (field as Record<string, unknown>).required === true,
      defaultValue: (field as Record<string, unknown>).defaultValue,
    }));

  async function submitRun(entry: CodePackageEntry) {
    setBusy(true); setError(""); setNotice(""); setRunRecord(undefined);
    try {
      const inputs = Object.fromEntries(runFields
        .filter(field => field.key && String(runInputs[field.key] ?? "").trim() !== "")
        .map(field => [field.key, runInputs[field.key]]));
      const missing = runFields.filter(field => field.required && String(runInputs[field.key] ?? "").trim() === "");
      if (missing.length) { setError("请先填写必填输入：" + missing.map(field => field.label).join("、")); return; }
      const accepted = await accessApi<{ packageRunId: string; status: string; executorSceneId: string }>(
        "/api/v1/code-packages/" + encodeURIComponent(entry.packageId) + "/runs",
        jsonBody({ inputs }),
      );
      setNotice("已受理 · packageRunId " + accepted.packageRunId + "（场景 " + accepted.executorSceneId + "），正在轮询运行记录");
      // 轮询到终态：包内会 scenes.wait 到子运行结束，通常几十秒；这里不猜结果。
      const ticket = ++runTicket.current;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (ticket !== runTicket.current) return;
        const detail = await accessApi<CodePackageRunDetail>("/api/v1/code-packages/" + encodeURIComponent(entry.packageId) + "/runs/" + encodeURIComponent(accepted.packageRunId));
        setRunRecord(detail);
        if (detail.status !== "running") { setNotice("运行" + (detail.status === "completed" ? "完成" : "失败") + " · packageRunId " + detail.packageRunId); return; }
      }
      setError("轮询超时：运行记录仍是 running，请到运行记录页核对，不要重复提交。");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return <div className="access-stack">
    <header className="access-heading"><div><h1>场景包</h1><p>场景包有两个来源：磁盘上的代码子工程（工作台启动时加载，代码由用户或 agent 维护）与配置型包（把多个已发布场景按顺序串起来）。这一页只做配置，不写代码。</p></div><button className="button button-outline" onClick={() => void attempt(load)}>刷新</button></header>
    {error && <p role="alert" className="access-error">{error}</p>}
    {notice && <p role="status" className="access-success">{notice}</p>}

    <section className="access-card">
      <h2>代码子工程</h2>
      <p className="access-hint">放在项目目录的 <code>scene-packages/</code> 下，一个子目录一个包。这里显示加载状态；改完磁盘上的代码点「重新加载此包」即可生效，不必重启工作台。</p>
      <ul className="access-list">{catalog.filter(row => row.source === "code").map(row => {
        const entry = codePackages.find(item => item.packageId === row.packageId)!;
        const status = describeCodePackageStatus(entry.status, entry.error);
        return <li key={entry.packageId} data-code-package={entry.packageId} data-status={entry.status}>
          <div>
            <strong>{entry.manifest?.title ?? entry.packageId}</strong>
            <small>来源：代码型 · 包 ID {entry.packageId} · 版本 v{entry.manifest?.version ?? "-"} · <span className={"run-status-label " + (status.tone === "ok" ? "completed" : status.tone === "error" ? "failed" : "cancelled")}>{status.label}</span>{status.detail ? " · " + status.detail : ""}</small>
            <small>代码路径：<code>{entry.directory}</code>{entry.entryPath ? " · 入口：" + entry.entryPath.slice(entry.directory.length + 1) : ""}</small>
            <small>执行场景：{entry.executor ? entry.executor.sceneId + " · " + entry.executor.versionId : "未配置（配置后才能运行）"}</small>
          </div>
          <div className="access-inline">
            <button className="button button-outline" onClick={() => setSelectedCodeId(entry.packageId)}>配置</button>
            <button className="button button-outline" disabled={busy} onClick={() => void toggleCode(entry)}>{entry.enabled ? "禁用" : "启用"}</button>
            <button className="button button-outline" disabled={busy || !entry.enabled} onClick={() => void reloadCode(entry)}>重新加载此包</button>
            {/* 用户面入口：真正把一次场景包跑起来（走管理员路由 + RunService 队列）。 */}
            <button className="button button-dark" data-run-package={entry.packageId}
              disabled={busy || entry.status !== "ok" || !entry.executor?.sceneId}
              title={entry.status !== "ok" ? "这个包没有加载成功，先「重新加载此包」" : !entry.executor?.sceneId ? "先配置执行场景" : "提交一次运行"}
              onClick={() => { runTicket.current += 1; setRunPackageId(entry.packageId); setRunRecord(undefined); setRunInputs({}); setError(""); setNotice(""); }}>运行</button>
            <button className="button button-outline" disabled={!entry.executor?.sceneId || !onOpenRuns} onClick={() => entry.executor?.sceneId && onOpenRuns?.(entry.executor.sceneId)}>查看运行记录</button>
          </div>
        </li>;
      })}</ul>
      {!codePackages.length && <p>还没有代码子工程。在项目目录的 <code>scene-packages/&lt;包ID&gt;/</code> 放 <code>package.json</code> 与入口文件，然后刷新本页。</p>}
    </section>

    {selectedCode && <section className="access-card" data-code-config={selectedCode.packageId}>
      <h2>配置 · {selectedCode.manifest?.title ?? selectedCode.packageId}</h2>
      <p className="access-hint">package.json 里的值只是默认值，这里保存的配置优先。代码本身在磁盘上改，本页不提供编辑器。</p>
      <label>执行场景<select className="text-input" value={codeExecutor?.sceneId ?? ""} onChange={e => {
        const sceneId = e.target.value;
        patchCode({ executor: sceneId ? { sceneId, versionId: publishedVersionOf(sceneId) } : null });
      }}>
        <option value="">请选择</option>
        {scenes.map(scene => <option key={scene.id} value={scene.id}>{scene.title}</option>)}
      </select><small>代码里每次调 framework.scenes.run 都用这个场景；包不能自己指定别的场景。</small></label>
      <label>发布版本<select className="text-input" value={codeExecutor?.versionId ?? ""} onChange={e => {
        const versionId = e.target.value;
        patchCode({ executor: codeExecutor ? { sceneId: codeExecutor.sceneId, versionId } : null });
      }}>
        <option value="">请选择</option>
        {(codeExecutor?.sceneId ? sceneVersions[codeExecutor.sceneId]?.versions ?? [] : []).map(version => <option key={version.id} value={version.id}>{version.version} · {version.publishedAt.slice(0, 10)}</option>)}
      </select><small>必填。已发布版本固定，不会跟着场景后续改版漂移。</small></label>
      <label className="package-confirm"><input type="checkbox" checked={selectedCode.config?.enabled ?? selectedCode.enabled} onChange={e => patchCode({ enabled: e.target.checked })} />启用这个包（禁用后不加载、用户面不出现，历史运行仍可查）</label>

      <h3>输入契约</h3>
      <p className="access-hint">字段来自 package.json，这里可改标签、必填与默认值；键不能改，代码按 key 读。</p>
      <div className="package-item-grid">{codeInputs.map((field, index) => <div className="package-binding" key={field.key + "-" + index}>
        <code>{field.key}</code>
        <input className="text-input" value={field.label ?? ""} placeholder="标签" onChange={e => patchCode({ inputs: codeInputs.map((candidate, position) => position === index ? { ...candidate, label: e.target.value } : candidate) })} />
        <label className="package-confirm"><input type="checkbox" checked={field.required === true} onChange={e => patchCode({ inputs: codeInputs.map((candidate, position) => position === index ? { ...candidate, required: e.target.checked } : candidate) })} />必填</label>
        <input className="text-input" value={field.defaultValue === undefined ? "" : String(field.defaultValue)} placeholder="默认值（可选）" onChange={e => patchCode({ inputs: codeInputs.map((candidate, position) => position === index ? { ...candidate, defaultValue: e.target.value } : candidate) })} />
      </div>)}</div>
      {!codeInputs.length && <p className="access-muted">这个包的 package.json 没有声明 inputs。</p>}

      <h3>定价</h3>
      <p className="access-hint">留空表示不收费。</p>
      <label>基础分（每次运行）<input className="text-input" type="number" min="0" step="0.01" value={selectedCode.config?.pricing?.base ?? ""} placeholder="0" onChange={e => {
        const raw = e.target.value.trim();
        const base = Number(raw);
        patchCode({ pricing: raw === "" || !Number.isFinite(base) ? undefined : { version: 1, base, items: selectedCode.config?.pricing?.items ?? {} } });
      }} /></label>

      <div className="access-inline">
        <button className="button button-dark" disabled={busy} onClick={() => void saveCode()}>保存配置</button>
        <button className="button button-outline" disabled={busy || !selectedCode.enabled} onClick={() => void reloadCode(selectedCode)}>重新加载此包</button>
        <button className="button button-outline" onClick={() => setSelectedCodeId(null)}>收起</button>
      </div>
    </section>}

    {selectedCode && <PackagePageEditor presentation={selectedCode.config?.presentation} onChange={presentation => patchCode({ presentation })} />}

    {/* 运行面板：输入契约来自 package.json + 管理端覆盖；提交后轮询同一 packageRunId 的记录。 */}
    {runEntry && <section className="access-card" data-run-panel={runEntry.packageId}>
      <h2>运行 · {runEntry.manifest?.title ?? runEntry.packageId}</h2>
      <p className="access-hint">提交后服务端立即返回 <code>packageRunId</code> 并在 <code>RunService</code> 队列里执行；本页按这个 ID 轮询运行记录，不重复提交。</p>
      <p className="access-muted">执行场景：{runEntry.executor ? runEntry.executor.sceneId + " · " + runEntry.executor.versionId : "未配置"}（包不能自己改场景）</p>
      {runFields.length ? <div className="package-item-grid">{runFields.map(field => <label key={field.key} className="package-binding">
        <code>{field.key}{field.required ? " *" : ""}</code>
        <input className="text-input" value={runInputs[field.key] ?? ""} placeholder={field.label || "输入值"}
          onChange={e => setRunInputs(current => ({ ...current, [field.key]: e.target.value }))} />
      </label>)}</div> : <p className="access-muted">这个包没有声明输入，直接提交即可。</p>}
      <div className="access-inline">
        <button className="button button-dark" disabled={busy} onClick={() => void submitRun(runEntry)}>{busy ? "运行中…" : "提交运行"}</button>
        <button className="button button-outline" disabled={busy} onClick={() => { runTicket.current += 1; setRunPackageId(null); setRunRecord(undefined); }}>收起</button>
      </div>
      {runRecord && <div className="package-run-summary" data-package-run={runRecord.packageRunId}>
        <small>packageRunId <code>{runRecord.packageRunId}</code> · 状态 {runRecord.status} · 场景 {runRecord.executorSceneId} · 子运行 {runRecord.runIds.length} 个</small>
        {runRecord.error && <p role="alert" className="access-error">{runRecord.errorCode ? runRecord.errorCode + " · " : ""}{runRecord.error}</p>}
        {runRecord.runIds.length > 0 && <ul className="access-list">{runRecord.runIds.map(runId => {
          const child = runRecord.runs.find(run => run.runId === runId);
          return <li key={runId}><small>子运行 <code>{runId}</code>{child ? " · 场景 " + child.sceneId + " · " + child.status + (child.packageRunId ? " · 已打标" : " · 未打标") : " · 记录读取中"}</small></li>;
        })}</ul>}
        {runEntry.executor?.sceneId && onOpenRuns && <button className="button button-outline" onClick={() => onOpenRuns(runEntry.executor!.sceneId)}>到运行记录页查看</button>}
      </div>}
    </section>}

    <section className="access-card">
      <h2>配置型场景包</h2>
      <ul className="access-list">{packages.map(item => <li key={item.id}>
        <button className="access-link" onClick={() => setSelected(item)}>{item.title}<small>{item.id} · {item.items.length} 项 · r{item.revision} · 配置型</small></button>
      </li>)}</ul>
      {!packages.length && <p>还没有配置型场景包。可以先用「从场景创建单组件包」的思路，把已发布场景包成一个包。</p>}
      <div className="access-inline">
        <button className="button button-dark" disabled={busy} onClick={() => void create()}>新建空包草稿</button>
        <small>新包ID：{packageId}</small>
      </div>
    </section>

    {selected && <section className="access-card">
      <h2>编辑 · {selected.title}</h2>
      <label>标题<input className="text-input" value={selected.title} onChange={e => setSelected({ ...selected, title: e.target.value })} /></label>
      <label>一句话说明<input className="text-input" value={selected.summary ?? ""} onChange={e => setSelected({ ...selected, summary: e.target.value })} /></label>

      <h3>组件顺序</h3>
      <div className="package-items">{selected.items.map((item, index) => <div className="package-item" key={item.id}>
        <div className="package-item-head">
          <strong>{index + 1}. {item.name}</strong>
          <button className="button button-outline" disabled={index === 0} onClick={() => setSelected({ ...selected, items: selected.items.map((candidate, position) => position === index ? selected.items[index - 1] : position === index - 1 ? item : candidate) })}>上移</button>
          <button className="button button-outline" disabled={index === selected.items.length - 1} onClick={() => setSelected({ ...selected, items: selected.items.map((candidate, position) => position === index ? selected.items[index + 1] : position === index + 1 ? item : candidate) })}>下移</button>
          <button className="button button-outline" disabled={selected.items.length <= 1} onClick={() => setSelected({ ...selected, items: selected.items.filter((_candidate, position) => position !== index) })}>删除</button>
        </div>
        <div className="package-item-grid">
          <label>项ID<input className="text-input" value={item.id} onChange={e => patchItem(index, { id: e.target.value })} /></label>
          <label>名称<input className="text-input" value={item.name} onChange={e => patchItem(index, { name: e.target.value })} /></label>
          <label>组件场景<select className="text-input" value={item.sceneId} onChange={e => patchItem(index, { sceneId: e.target.value, versionId: publishedVersionOf(e.target.value) })}>
            <option value="">请选择</option>
            {scenes.map(scene => <option key={scene.id} value={scene.id}>{scene.title}</option>)}
          </select></label>
          <label>发布版本<input className="text-input" value={item.versionId} onChange={e => patchItem(index, { versionId: e.target.value })} placeholder="选场景后自动填当前发布版" /></label>
          <label className="package-confirm"><input type="checkbox" checked={Boolean(item.confirmAfter)} onChange={e => patchItem(index, { confirmAfter: e.target.checked })} />完成后停下等我确认</label>
        </div>
        <h4>输入绑定</h4>
        <div className="package-bindings">{item.inputs.map((binding, bindingIndex) => <div className="package-binding" key={bindingIndex}>
          <input className="text-input" value={binding.key} onChange={e => patchItem(index, { inputs: item.inputs.map((candidate, position) => position === bindingIndex ? { ...candidate, key: e.target.value } : candidate) })} placeholder="组件输入键" />
          <select className="text-input" value={binding.valueSource} onChange={e => patchItem(index, { inputs: item.inputs.map((candidate, position) => position === bindingIndex ? { ...candidate, valueSource: e.target.value as typeof binding.valueSource } : candidate) })}>
            <option value="input">来自包输入</option>
            <option value="literal">固定值</option>
            <option value="previous">来自前一项产出</option>
          </select>
          <input className="text-input" value={binding.sourceRef ?? ""} onChange={e => patchItem(index, { inputs: item.inputs.map((candidate, position) => position === bindingIndex ? { ...candidate, sourceRef: e.target.value } : candidate) })} placeholder={binding.valueSource === "previous" ? "项ID.输出键" : "input.键"} />
          <input className="text-input" value={binding.literalValue ?? ""} onChange={e => patchItem(index, { inputs: item.inputs.map((candidate, position) => position === bindingIndex ? { ...candidate, literalValue: e.target.value } : candidate) })} placeholder="固定值（可选）" />
          <button className="button button-outline" onClick={() => patchItem(index, { inputs: item.inputs.filter((_candidate, position) => position !== bindingIndex) })}>移除</button>
        </div>)}
          <button className="button button-outline" onClick={() => patchItem(index, { inputs: [...item.inputs, { key: "", valueSource: "input", sourceRef: "" }] })}>添加绑定</button>
        </div>
      </div>)}
      </div>
      <h3>定价</h3>
      <p className="access-hint">价格属于这个服务，替换内部场景不会改价。留空表示不收费；未配置时回退组件场景定价。</p>
      <div className="package-pricing">
        <label>基础分（每次运行）<input className="text-input" type="number" min="0" step="0.01" value={selected.pricing?.base ?? ""} placeholder="0" onChange={e => {
          const raw = e.target.value.trim();
          const base = Number(raw);
          const items = selected.pricing?.items ?? {};
          const next = raw === "" || !Number.isFinite(base) ? items : { ...items };
          setSelected({ ...selected, pricing: Object.keys(next).length || raw !== "" ? { version: 1, base: Number.isFinite(base) ? base : 0, items: next } : undefined });
        }} /></label>
        {selected.items.map(item => <label key={item.id}>{item.name || item.id}
          <input className="text-input" type="number" min="0" step="0.01" placeholder="不收费"
            value={selected.pricing?.items[item.id]?.credits ?? ""}
            onChange={e => {
              const raw = e.target.value.trim();
              const credits = Number(raw);
              const items = { ...(selected.pricing?.items ?? {}) };
              if (raw === "" || !Number.isFinite(credits)) delete items[item.id];
              else items[item.id] = { unit: selected.pricing?.items[item.id]?.unit ?? "per_call", credits };
              setSelected({ ...selected, pricing: { version: 1, base: selected.pricing?.base ?? 0, items } });
            }} />
        </label>)}
      </div>
      <div className="access-inline">
        <button className="button button-outline" onClick={() => setSelected({ ...selected, items: [...selected.items, emptyItem()] })}>添加组件</button>
        <button className="button button-dark" disabled={busy} onClick={() => void save()}>保存草稿</button>
        <button className="button button-dark" disabled={busy} onClick={() => void publish()}>发布</button>
      </div>
    </section>}

    {selected && <PackagePageEditor presentation={selected.presentation} onChange={presentation => setSelected({ ...selected, presentation })} />}
  </div>;
}
