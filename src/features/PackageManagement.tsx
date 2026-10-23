import { useEffect, useRef, useState } from "react";
import { accessApi, jsonBody } from "../lib/accessApi";
import type { SceneModule } from "../types";
import type { SceneVersionRecord } from "../types";
import type { PackagePresentation } from "../../server/domain/packageContracts.js";
import { describeCodePackageStatus, inputContractRows, inputOverridePayload, mergePackageCatalog } from "../lib/packageCatalog";

interface PackagePricingDraft { version: 1; base: number; items: Record<string, { unit: "per_call" | "per_item"; credits: number }> }

interface CodePackageConfigDraft {
  revision: number;
  enabled: boolean;
  executor?: { sceneId: string; versionId: string } | null;
  executors?: Array<{ key: string; sceneId: string; versionId: string }>;
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
  manifest?: { title: string; version: string; entry: string; inputs: Array<Record<string, unknown>>; executor?: { sceneId: string; versionId: string }; executors?: Array<{ key: string; sceneId: string; versionId: string }> };
  executor?: { sceneId: string; versionId: string };
  config?: CodePackageConfigDraft;
}


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
 * 管理端场景包：磁盘代码子工程是唯一来源。
 * 这里只显示加载状态并做定制化配置，不提供代码编辑器；配置型包已下线。
 */
export default function PackageManagement({ scenes, sceneVersions, onOpenRuns }: { scenes: SceneModule[]; sceneVersions: Record<string, SceneVersionRecord>; onOpenRuns?: (sceneId: string) => void }) {
  const [codePackages, setCodePackages] = useState<CodePackageEntry[]>([]);
  const [selectedCodeId, setSelectedCodeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** 正在提交运行的包（null = 未打开运行面板）。 */
  const [runPackageId, setRunPackageId] = useState<string | null>(null);
  const [runInputs, setRunInputs] = useState<Record<string, string>>({});
  const [runRecord, setRunRecord] = useState<CodePackageRunDetail>();
  /** 递增序号：换一次提交或换包时让旧的轮询循环自行退出，避免写回过期结果。 */
  const runTicket = useRef(0);

  async function attempt(action: () => Promise<void>) { setError(""); try { await action(); } catch (e) { setError((e as Error).message); } }
  async function load() {
    const data = await accessApi<{ codePackages?: CodePackageEntry[] }>("/api/v1/packages");
    setCodePackages(data.codePackages ?? []);
  }
  useEffect(() => { void attempt(load); }, []);

  const selectedCode = codePackages.find(item => item.packageId === selectedCodeId) ?? null;
  const catalog = mergePackageCatalog(
    [],
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
    const enabled = config?.enabled ?? selectedCode.enabled;
    // 场景清单：界面上的行就是提交内容。全空行视为「没配」，不能存成一条空场景。
    const rows = codeExecutors.filter(entry => entry.key.trim() && entry.sceneId && entry.versionId);
    if (enabled && !rows.length) { setError("请至少配一个执行场景和已发布版本"); return; }
    const duplicate = rows.map(entry => entry.key.trim()).find((key, index, all) => all.indexOf(key) !== index);
    if (duplicate) { setError("场景键重复：" + duplicate + "；每个场景键必须唯一"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await accessApi<{ package: CodePackageEntry }>("/api/v1/code-packages/" + encodeURIComponent(selectedCode.packageId), {
        method: "PATCH",
        body: JSON.stringify({
          revision: config?.revision ?? selectedCode.revision ?? 0,
          enabled,
          // 单场景包仍写 executor（旧形态兼容），多场景写清单；两者都由服务端按清单优先解析。
          executor: rows.length === 1 ? { sceneId: rows[0].sceneId, versionId: rows[0].versionId } : null,
          executors: rows.map(entry => ({ key: entry.key.trim(), sceneId: entry.sceneId, versionId: entry.versionId })),
          // 送覆盖差异而不是全量：管理员没动过的字段留给 package.json，磁盘改标签/必填才继续生效。
          inputs: inputOverridePayload(codeInputs, selectedCode.manifest?.inputs ?? []),
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
  // 场景清单：管理端配置优先，其次 package.json 的 executors；都没有就退回单 executor（键名 default）。
  // 界面永远至少给一行，避免「多场景包没有唯一执行场景」时出现空面板无法配置。
  const codeExecutors: Array<{ key: string; sceneId: string; versionId: string }> = (() => {
    const declared = selectedCode?.config?.executors ?? selectedCode?.manifest?.executors;
    if (declared?.length) return declared.map(entry => ({ key: entry.key, sceneId: entry.sceneId, versionId: entry.versionId }));
    if (codeExecutor) return [{ key: "default", sceneId: codeExecutor.sceneId, versionId: codeExecutor.versionId }];
    return [{ key: "default", sceneId: "", versionId: "" }];
  })();

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
    <header className="access-heading"><div><h1>场景包</h1><p>场景包来自磁盘上的代码子工程：工作台启动时加载，代码由用户或 agent 维护。这一页只做配置，不写代码。</p></div><button className="button button-outline" onClick={() => void attempt(load)}>刷新</button></header>
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
      <h3>执行场景</h3>
      <p className="access-hint">一个包只用一条流水线时配单个场景；要用多个场景（如短剧的四视图→场景图→分镜→出片）就加多行，代码用 <code>framework.scenes.run({"{ scene: \"键\" }"})</code> 按「场景键」选。所有场景都归这个包的工作台台账。</p>
      {codeExecutors.map((entry, index) => <div className="package-binding" key={"exec-" + index}>
        <input className="text-input" value={entry.key} placeholder="场景键（如 four_view）" onChange={e => patchCode({ executors: codeExecutors.map((candidate, position) => position === index ? { ...candidate, key: e.target.value } : candidate) })} />
        <select className="text-input" value={entry.sceneId} onChange={e => {
          const sceneId = e.target.value;
          patchCode({ executors: codeExecutors.map((candidate, position) => position === index ? { ...candidate, sceneId, versionId: sceneId ? publishedVersionOf(sceneId) : "" } : candidate) });
        }}>
          <option value="">请选择场景</option>
          {scenes.map(scene => <option key={scene.id} value={scene.id}>{scene.title}</option>)}
        </select>
        <select className="text-input" value={entry.versionId} onChange={e => {
          const versionId = e.target.value;
          patchCode({ executors: codeExecutors.map((candidate, position) => position === index ? { ...candidate, versionId } : candidate) });
        }}>
          <option value="">请选择发布版本</option>
          {(entry.sceneId ? sceneVersions[entry.sceneId]?.versions ?? [] : []).map(version => <option key={version.id} value={version.id}>{version.version} · {version.publishedAt.slice(0, 10)}</option>)}
        </select>
        <button className="button button-outline" disabled={busy || codeExecutors.length <= 1} onClick={() => patchCode({ executors: codeExecutors.filter((_, position) => position !== index) })}>移除</button>
      </div>)}
      <div className="access-inline">
        <button className="button button-outline" disabled={busy || codeExecutors.length >= 32} onClick={() => patchCode({ executors: [...codeExecutors, { key: "scene_" + (codeExecutors.length + 1), sceneId: "", versionId: "" }] })}>加一个场景</button>
        <small className="access-muted">发布版本固定，不会跟着场景后续改版漂移。</small>
      </div>
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

  </div>;
}
