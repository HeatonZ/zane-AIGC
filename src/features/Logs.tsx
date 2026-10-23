import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, ChevronDown, Copy, FileText, Info, LoaderCircle, RefreshCw, Search, XCircle } from "lucide-react";
import { loadOpsLog, loadSystemLogs, loadWorkflowRun } from "../lib/api";
import {
  correlateRequestIdentities, describeEvent, entryFacts, formatFieldValue,
  fullTime, levelLabels, logTime, narrativeFor, neighborEntries, normalizedEvent, orderedFieldEntries, parseOpsLine,
  requestRecords, resolveRunId, runContextRows, runStepRows, statusTone, summarizeLogEntries,
} from "../lib/logPresentation";
import type { EntryFacts, LogGroup, RequestIdentity } from "../lib/logPresentation";
import type { LogOpsFile, OpsLogPage, SystemLogEntry, SystemLogPage, WorkflowRunRecord } from "../types";

const levelIcons = { info: Info, warn: AlertTriangle, error: XCircle } as const;
/** Exported so the allowed list stays in one place and is directly assertable in tests. */
export const opsFileOptions: Array<{ id: LogOpsFile; label: string }> = [
  { id: "watchdog.log", label: "看门狗动作" },
  { id: "watchdog-server.log", label: "看门狗启动的后台" },
  { id: "server.stdout.log", label: "后台标准输出" },
  { id: "server.stderr.log", label: "后台标准错误" },
  { id: "zane-server.stdout.log", label: "旧后台标准输出" },
  { id: "zane-server.stderr.log", label: "旧后台标准错误" },
];
const runIdPattern = /^[a-f0-9-]{36}$/i;
/** 常用事件前缀：点一下写进「事件名前缀」，服务端仍按前缀过滤，不是页面内假筛选。 */
const quickPrefixes = [
  { prefix: "run.", label: "运行" },
  { prefix: "http.", label: "接口" },
  { prefix: "hermes.", label: "Hermes" },
  { prefix: "comfy.", label: "ComfyUI" },
  { prefix: "package.", label: "场景包" },
  { prefix: "access.", label: "权限" },
];

function useCopy() {
  const [copiedKey, setCopiedKey] = useState("");
  const [copyError, setCopyError] = useState("");
  const copy = useCallback(async (value: string, key: string) => {
    try { await navigator.clipboard.writeText(value); setCopiedKey(key); setCopyError(""); }
    catch { setCopyError("无法自动复制，请选中文本手动复制。"); }
  }, []);
  return { copiedKey, copyError, copy };
}

/** 字段逐条列出，而不是把整块 JSON 丢给读者；对象/数组保留为格式化 JSON。 */
function FieldList({ fields, scope, copiedKey, onCopy }: {
  fields: Record<string, unknown>; scope: string; copiedKey: string;
  onCopy: (value: string, key: string) => void;
}) {
  const entries = orderedFieldEntries(fields);
  if (!entries.length) return <p className="logs-detail-empty">这条日志没有附加字段。</p>;
  return <dl className="logs-field-list">
    {entries.map(([key, value]) => {
      const formatted = formatFieldValue(value);
      const keyId = scope + ":" + key;
      const isError = key === "error" || key === "errorMessage" || key === "causeMessage";
      return <div className="logs-field" key={key}>
        <dt>{key}</dt>
        <dd>{formatted.kind === "json"
          ? <pre className="logs-field-json">{formatted.text}</pre>
          : <span className={isError ? "logs-field-error" : undefined}>{formatted.text}</span>}</dd>
        <button type="button" className="logs-field-copy" onClick={() => onCopy(formatted.text, keyId)}
          aria-label={`复制字段 ${key}`}>{copiedKey === keyId ? "已复制" : <Copy size={11} />}</button>
      </div>;
    })}
  </dl>;
}

/** 同一件事重复多次时只显示一行，展开后能看到每一条的序号与时间。 */
function FailureGroupRow({ group, entries, open, onToggle, copiedKey, onCopy, onFilter, identities }: {
  group: LogGroup; entries: SystemLogEntry[]; open: boolean; onToggle: () => void; copiedKey: string;
  onCopy: (value: string, key: string) => void;
  onFilter: (kind: "run" | "scene", value: string) => void;
  identities: Map<string, RequestIdentity>;
}) {
  const repeated = group.count > 1;
  if (!repeated) {
    const index = entries.findIndex(entry => group.sequences.includes(entry.sequence));
    const single = index >= 0 ? entries[index] : undefined;
    return single ? <ProcessEntry entry={single} open={open} onToggle={onToggle} copiedKey={copiedKey}
      onCopy={onCopy} onFilter={onFilter} identities={identities} allEntries={entries} position={index} /> : null;
  }
  const last = group.lastTime;
  const raw = group.sequences.join("\n");
  // 失败组也先说人话：原因在前，路径与方法收进技术信息。
  const route = group.route ?? group.detail;
  return <li className={`logs-entry logs-warn logs-failed logs-group`}>
    <div className="logs-entry-head">
      <button type="button" className="logs-entry-main" aria-expanded={open} onClick={onToggle}>
        <AlertTriangle size={14} />
        <time className="logs-time" dateTime={last} title={fullTime(last)}>{logTime(last)}</time>
        <span className="logs-level logs-level-warn">重复</span>
        <span className="logs-title">
          <span className="logs-narrative" title={group.detail}>{group.reason ? `${group.reason}${group.status ? `（HTTP ${group.status}）` : ""}` : group.detail}</span>
        </span>
        <span className="logs-count" title={`${fullTime(group.firstTime)} 起共 ${group.count} 次`}>×{group.count}</span>
        <ChevronDown className={open ? "logs-chevron open" : "logs-chevron"} size={13} />
      </button>
      <button type="button" className="logs-copy" onClick={() => onCopy(raw, "g" + group.key)}>{copiedKey === "g" + group.key ? "已复制序号" : <Copy size={12} />}</button>
    </div>
    <div className="logs-entry-body">
      <span className="logs-facts">
        <span className="logs-fact">共 {group.count} 次</span>
        <span className="logs-fact">{logTime(group.firstTime)} 至 {logTime(group.lastTime)}</span>
      </span>
    </div>
    {open && <div className="logs-detail">
      <details className="logs-technical" open>
        <summary>技术信息（{route} · 序号 #{group.firstSequence}–#{group.lastSequence}）</summary>
        <ul className="logs-group-items">
          {entries.filter(entry => group.sequences.includes(entry.sequence)).map(entry => <li key={entry.sequence}>
            <span className="logs-seq">#{entry.sequence}</span>
            <time className="logs-time">{fullTime(entry.time)}</time>
            <FieldList fields={entry.fields} scope={"p" + entry.sequence} copiedKey={copiedKey} onCopy={onCopy} />
          </li>)}
        </ul>
      </details>
    </div>}
  </li>;
}

/** 轮询请求的汇总行：默认不展开，避免心跳把窗口填满。 */
function NoiseGroupRow({ group, open, onToggle }: { group: LogGroup; open: boolean; onToggle: () => void }) {
  return <li className="logs-entry logs-plain logs-group logs-noise">
    <div className="logs-entry-head">
      <button type="button" className="logs-entry-main" aria-expanded={open} onClick={onToggle}>
        <RefreshCw size={13} />
        <span className="logs-title">
          <span className="logs-narrative">页面状态轮询 {group.count} 次（正常）</span>
        </span>
        <span className="logs-count">×{group.count}</span>
        <ChevronDown className={open ? "logs-chevron open" : "logs-chevron"} size={13} />
      </button>
    </div>
    {open && <div className="logs-detail">
      <p className="logs-detail-hint">{logTime(group.firstTime)} → {logTime(group.lastTime)}，共 {group.count} 次成功请求（序号 #{group.firstSequence}–#{group.lastSequence}）。这些是页面的周期状态轮询，失败时会单独出现在上方。</p>
    </div>}
  </li>;
}

/** 同一次请求的全部记录：request 行给状态与耗时，error 行给原因，缺一条都不完整。 */
function RequestRecords({ records }: { records: SystemLogEntry[] }) {
  if (records.length <= 1) return null;
  return <section className="logs-detail-section">
    <h4>这次请求的全部记录（{records.length} 条）</h4>
    <ul className="logs-record-list">
      {records.map(record => <li key={record.sequence}>
        <span className={`logs-level logs-level-${record.level}`}>{levelLabels[record.level]}</span>
        <code className="logs-record-event">{record.event}</code>
        <span className="logs-record-summary">{describeEvent(record.event, record.fields)}</span>
        <time className="logs-seq">{logTime(record.time)}</time>
      </li>)}
    </ul>
  </section>;
}

/** 运行上下文：日志里只有 runId 时，补上这次运行的真实状态、步骤与错误。 */
function RunContext({ runId, copiedKey, onCopy }: {
  runId: string; copiedKey: string;
  onCopy: (value: string, key: string) => void;
}) {
  const [run, setRun] = useState<WorkflowRunRecord>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false;
    setLoading(true); setError("");
    loadWorkflowRun(runId)
      .then(value => { if (!disposed) setRun(value); })
      .catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : "读取运行失败"); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [runId]);
  return <section className="logs-detail-section">
    <h4>这次运行</h4>
    {loading && <p className="logs-detail-hint"><LoaderCircle className="spin" size={12} /> 正在读取运行详情…</p>}
    {error && <p className="logs-detail-hint logs-detail-bad">{error}（运行可能已被删除，或日志来自更早的进程）</p>}
    {run && <>
      <dl className="logs-run-summary">
        {runContextRows(run).map(row => <div key={row.label}>
          <dt>{row.label}</dt>
          <dd className={row.label === "状态" ? `logs-run-status status-${run.status}` : undefined} title={row.value}>{row.value}</dd>
        </div>)}
      </dl>
      {run.error && <p className="logs-run-error"><AlertTriangle size={12} />{run.error}</p>}
      {run.steps.length > 0 && <table className="logs-run-steps">
        <thead><tr><th>步骤</th><th>能力</th><th>状态</th><th>用时</th></tr></thead>
        <tbody>{runStepRows(run.steps).map((step, index) => <tr key={run.steps[index]!.stepId} className={step.failed ? "row-failed" : undefined}>
          <td title={run.steps[index]!.stepId}>{step.name}</td>
          <td><code>{step.capability}</code></td>
          <td>{step.status}</td>
          <td>{step.duration}</td>
        </tr>)}</tbody>
      </table>}
      <div className="logs-detail-bar">
        <button type="button" className="logs-copy" onClick={() => onCopy(run.runId, "run:" + runId)}>{copiedKey === "run:" + runId ? "已复制运行ID" : "复制运行ID"}</button>
        {run.error && <button type="button" className="logs-copy" onClick={() => onCopy(run.error!, "runerr:" + runId)}>{copiedKey === "runerr:" + runId ? "已复制错误" : "复制错误"}</button>}
      </div>
    </>}
  </section>;
}

/** 相邻日志：一条日志很少单独成立，前后几条才说明「当时正在发生什么」。 */
function NeighborEntries({ before, after }: { before: SystemLogEntry[]; after: SystemLogEntry[] }) {
  if (!before.length && !after.length) return null;
  const row = (entry: SystemLogEntry) => <li key={entry.sequence} className={entry.level === "error" || entry.fields.error ? "logs-neighbor-bad" : undefined}>
    <span className="logs-seq">#{entry.sequence}</span>
    <time className="logs-time">{logTime(entry.time)}</time>
    <span className={`logs-level logs-level-${entry.level}`}>{levelLabels[entry.level]}</span>
    <code className="logs-record-event">{entry.event}</code>
    <span className="logs-record-summary">{describeEvent(entry.event, entry.fields)}</span>
  </li>;
  return <section className="logs-detail-section">
    <h4>前后日志</h4>
    <ul className="logs-record-list">
      {before.map(row)}
      {after.map(row)}
    </ul>
  </section>;
}

/** 折叠行内的事实标签：请求路径、状态码、运行/场景/步骤、耗时。不用展开就能定位。 */
function Facts({ facts, onFilter }: {
  facts: EntryFacts; onFilter: (kind: "run" | "scene", value: string) => void;
}) {
  const route = facts.request ? [facts.request.method, facts.request.path].filter(Boolean).join(" ") : "";
  const tone = facts.status === undefined ? "" : statusTone(facts.status);
  const chips: ReactNode[] = [];
  if (route) chips.push(<code key="route" className="logs-fact logs-fact-route" title={route}>{route}</code>);
  if (facts.status !== undefined) chips.push(<span key="status" className={`logs-fact logs-fact-status${tone ? " tone-" + tone : ""}`}>{facts.status}</span>);
  if (facts.code) chips.push(<code key="code" className="logs-fact" title={"错误码：" + facts.code}>{facts.code}</code>);
  if (facts.stepName) chips.push(<span key="step" className="logs-fact">步骤 {facts.stepName}{facts.itemIndex === undefined ? "" : ` · 第 ${facts.itemIndex + 1} 项`}</span>);
  if (facts.runId) chips.push(<button key="run" type="button" className="logs-fact logs-fact-link" onClick={() => onFilter("run", facts.runId!)} title="只看这次运行">运行 {facts.runId}</button>);
  if (facts.sceneId) chips.push(<button key="scene" type="button" className="logs-fact logs-fact-link" onClick={() => onFilter("scene", facts.sceneId!)} title="只看这个场景">场景 {facts.sceneId}</button>);
  if (facts.durationMs !== undefined) chips.push(<span key="duration" className="logs-fact logs-fact-muted">{facts.durationMs}ms</span>);
  if (!chips.length) return null;
  return <span className="logs-facts">{chips}</span>;
}

function ProcessEntry({ entry, open, onToggle, copiedKey, onCopy, onFilter, identities, allEntries, position }: {
  entry: SystemLogEntry; open: boolean; onToggle: () => void; copiedKey: string;
  onCopy: (value: string, key: string) => void;
  onFilter: (kind: "run" | "scene", value: string) => void;
  identities: Map<string, RequestIdentity>;
  allEntries: SystemLogEntry[];
  position: number;
}) {
  const Icon = levelIcons[entry.level];
  const facts = entryFacts(entry.fields, identities);
  const detailKey = "p" + entry.sequence;
  const raw = JSON.stringify({ time: entry.time, level: entry.level, event: entry.event, ...entry.fields }, null, 2);
  // 正文：一句中文说明发生了什么。技术坐标（路径、requestId、事件名）不进这一行。
  const narrative = narrativeFor(entry.event, entry.fields);
  const failed = Boolean(facts.error) || entry.level === "error";
  return <li className={`logs-entry logs-${entry.level}${failed ? " logs-failed" : ""}`}>
    <div className="logs-entry-head">
      <button type="button" className="logs-entry-main" aria-expanded={open} onClick={onToggle}>
        <Icon size={14} />
        <time className="logs-time" dateTime={entry.time} title={fullTime(entry.time)}>{logTime(entry.time)}</time>
        <span className={`logs-level logs-level-${entry.level}`}>{levelLabels[entry.level]}</span>
        <span className="logs-title">
          <span className="logs-narrative" title={narrative}>{narrative}</span>
        </span>
        {facts.runId && <button type="button" className="logs-fact logs-fact-link" onClick={() => onFilter("run", facts.runId!)} title="只看这次运行">运行 {facts.runId}</button>}
        <ChevronDown className={open ? "logs-chevron open" : "logs-chevron"} size={13} />
      </button>
      <button type="button" className="logs-copy" onClick={() => onCopy(raw, detailKey + ":all")}
        aria-label="复制这条日志的完整 JSON">{copiedKey === detailKey + ":all" ? "已复制" : <Copy size={12} />}</button>
    </div>
    <div className="logs-entry-body">
      <Facts facts={facts} onFilter={onFilter} />
      {failed && facts.error && <p className="logs-error-line" title={facts.error}><AlertTriangle size={12} />{facts.error}</p>}
    </div>
    {open && <div className="logs-detail">
      <div className="logs-detail-bar">
        <span className="logs-detail-hint">{fullTime(entry.time)} · 第 {position + 1} 条（本页共 {allEntries.length} 条）</span>
        {facts.runId && <button type="button" className="logs-copy" onClick={() => onFilter("run", facts.runId!)}>只看这次运行</button>}
        {facts.sceneId && <button type="button" className="logs-copy" onClick={() => onFilter("scene", facts.sceneId!)}>只看这个场景</button>}
      </div>
      {facts.runId && <RunContext runId={resolveRunId(entry.fields) ?? facts.runId} copiedKey={copiedKey} onCopy={onCopy} />}
      <RequestRecords records={requestRecords(allEntries, String(entry.fields.requestId ?? ""))} />
      {/* 技术信息默认收起：接口路径、事件名、字段名是排障用的，不是每次都要读的内容。 */}
      <details className="logs-technical">
        <summary>技术信息（事件 {entry.event} · 序号 #{entry.sequence}{facts.request ? ` · ${[facts.request.method, facts.request.path].filter(Boolean).join(" ")}` : ""}）</summary>
        <FieldList fields={entry.fields} scope={detailKey} copiedKey={copiedKey} onCopy={onCopy} />
        <div className="logs-detail-bar">
          <button type="button" className="logs-copy" onClick={() => onCopy(entry.event, detailKey + ":event")}>{copiedKey === detailKey + ":event" ? "已复制事件名" : "复制事件名"}</button>
        </div>
      </details>
      <NeighborEntries {...neighborEntries(allEntries, entry.sequence)} />
    </div>}
  </li>;
}

function OpsLine({ line, open, onToggle, copiedKey, onCopy, identities }: {
  line: ReturnType<typeof parseOpsLine>; open: boolean; onToggle: () => void; copiedKey: string;
  onCopy: (value: string, key: string) => void;
  identities: Map<string, RequestIdentity>;
}) {
  const parsed = line.parsed;
  const detailKey = "o" + line.lineNumber;
  if (!parsed) return <li className="logs-entry logs-plain">
    <div className="logs-entry-head">
      <button type="button" className="logs-entry-main" aria-expanded={open} onClick={onToggle}>
        <FileText size={13} />
        <span className="logs-seq">#{line.lineNumber}</span>
        <span className="logs-title"><span className="logs-summary logs-summary-plain" title={line.raw}>{line.raw || "（空行）"}</span></span>
        {line.truncated && <span className="logs-flag">已裁剪</span>}
        {line.raw && <ChevronDown className={open ? "logs-chevron open" : "logs-chevron"} size={13} />}
      </button>
      {line.raw && <button type="button" className="logs-copy" onClick={() => onCopy(line.raw, detailKey + ":all")}
        aria-label="复制这一行原文">{copiedKey === detailKey + ":all" ? "已复制" : <Copy size={12} />}</button>}
    </div>
    {open && line.raw && <div className="logs-detail"><pre className="logs-field-json">{line.raw}</pre></div>}
  </li>;
  const event = normalizedEvent(parsed.event, parsed.component);
  const Icon = parsed.level ? levelIcons[parsed.level] : FileText;
  const narrative = narrativeFor(event, parsed.fields);
  const facts = entryFacts(parsed.fields, identities);
  const failed = Boolean(facts.error) || parsed.level === "error";
  return <li className={`logs-entry ${parsed.level ? "logs-" + parsed.level : "logs-plain"}${failed ? " logs-failed" : ""}`}>
    <div className="logs-entry-head">
      <button type="button" className="logs-entry-main" aria-expanded={open} onClick={onToggle}>
        <Icon size={13} />
        {parsed.time && <time className="logs-time" dateTime={parsed.time} title={fullTime(parsed.time)}>{logTime(parsed.time)}</time>}
        {parsed.level && <span className={`logs-level logs-level-${parsed.level}`}>{levelLabels[parsed.level]}</span>}
        <span className="logs-title"><span className="logs-narrative" title={narrative}>{narrative}</span></span>
        <ChevronDown className={open ? "logs-chevron open" : "logs-chevron"} size={13} />
      </button>
      <button type="button" className="logs-copy" onClick={() => onCopy(line.raw, detailKey + ":all")}
        aria-label="复制这一行原文">{copiedKey === detailKey + ":all" ? "已复制" : <Copy size={12} />}</button>
    </div>
    {open && <div className="logs-detail">
      <div className="logs-detail-bar">
        <span className="logs-detail-hint">第 {line.lineNumber} 行 · {fullTime(parsed.time)}</span>
        <button type="button" className="logs-copy" onClick={() => onCopy(line.raw, detailKey + ":raw")}>{copiedKey === detailKey + ":raw" ? "已复制原文" : "复制原文"}</button>
      </div>
      <details className="logs-technical">
        <summary>技术信息（事件 {event} · 第 {line.lineNumber} 行）</summary>
        <FieldList fields={parsed.fields} scope={detailKey} copiedKey={copiedKey} onCopy={onCopy} />
        <div className="logs-detail-bar">
          <button type="button" className="logs-copy" onClick={() => onCopy(event, detailKey + ":event")}>{copiedKey === detailKey + ":event" ? "已复制事件名" : "复制事件名"}</button>
        </div>
      </details>
    </div>}
  </li>;
}

export default function Logs() {
  const [source, setSource] = useState<"process" | "ops">("process");
  const [level, setLevel] = useState("");
  const [event, setEvent] = useState("");
  const [keyword, setKeyword] = useState("");
  const [runId, setRunId] = useState("");
  const [sceneId, setSceneId] = useState("");
  const [packageRunId, setPackageRunId] = useState("");
  const [limit, setLimit] = useState(50);
  const [page, setPage] = useState<SystemLogPage>();
  const [opsPage, setOpsPage] = useState<OpsLogPage>();
  const [opsFile, setOpsFile] = useState<LogOpsFile>("watchdog.log");
  const [opsTail, setOpsTail] = useState(200);
  const [opsView, setOpsView] = useState<"structured" | "raw">("structured");
  const [cursor, setCursor] = useState<string>();
  // Appended pages for the process source; the ops source is always a single tail window.
  const [older, setOlder] = useState<SystemLogEntry[]>([]);
  const [expanded, setExpanded] = useState<string>();
  /** 默认折叠成功的轮询心跳；排障时仍可一键展开。 */
  const [showHeartbeats, setShowHeartbeats] = useState(false);
  /** 默认不显示纯接口调用：它们只有路径和状态码，没有业务内容。 */
  const [showRequests, setShowRequests] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [staleCursor, setStaleCursor] = useState(false);
  const sequence = useRef(0);
  const { copiedKey, copyError, copy } = useCopy();

  // Filters are trimmed for the request but the input keeps raw text so typing is never fought.
  // excludeEvent 走服务端：默认把 http.request（纯接口调用）挡在外面，只留业务事件与失败。
  const request = {
    level: level || undefined, event: event.trim() || undefined,
    excludeEvent: showRequests ? undefined : "http.request",
    q: keyword.trim() || undefined, runId: runId.trim() || undefined, sceneId: sceneId.trim() || undefined,
    packageRunId: packageRunId.trim() || undefined,
  };

  const readProcess = useCallback(async (next?: string) => {
    const ticket = ++sequence.current;
    const data = await loadSystemLogs({ ...request, limit, ...(next ? { cursor: next } : {}) });
    if (ticket !== sequence.current) return;
    setPage(data);
    setCursor(data.nextCursor);
    setOlder(next ? (current) => [...current, ...data.entries] : []);
  }, [level, event, keyword, runId, sceneId, packageRunId, limit, showRequests]);

  const readOps = useCallback(async () => {
    const ticket = ++sequence.current;
    const data = await loadOpsLog({ file: opsFile, tailLines: opsTail, level: level || undefined, q: keyword.trim() || undefined });
    if (ticket !== sequence.current) return;
    setOpsPage(data);
  }, [opsFile, opsTail, level, keyword]);

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try {
      if (source === "process") await readProcess(); else await readOps();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "日志读取失败";
      // A cursor is bound to the window it was issued against; a changed window must not be
      // stitched together from two snapshots, so drop the page and ask for the first page.
      if ((reason as { code?: string }).code === "LOG_PAGE_CHANGED") {
        setCursor(undefined); setStaleCursor(true);
        setError("更早的日志已被容量挤出，续页游标作废；请重新读取第一页，不拼接两个快照。");
      } else setError(message);
    } finally { setLoading(false); }
  }, [source, readProcess, readOps]);

  useEffect(() => {
    // Re-read the first page whenever the source or the filter set changes.
    setCursor(undefined); setOlder([]); setStaleCursor(false); setExpanded(undefined);
    void refresh();
    return () => { sequence.current++; };
  }, [refresh]);

  const entries = [...(page?.entries ?? []), ...older];
  const toggle = (key: string) => setExpanded(current => current === key ? undefined : key);
  const opsLines = opsPage?.lines.map(parseOpsLine) ?? [];
  // 旧 http.error 条目只有 requestId：用同窗口的 http.request 把方法/路径关联回来。
  const identities = correlateRequestIdentities([...entries, ...opsLines.flatMap(line => line.parsed ? [{ fields: line.parsed.fields }] : [])]);
  // 重点优先：失败按原因聚合（同一条 403 重复 17 次只是一件事），成功心跳折成计数。
  const digest = summarizeLogEntries(entries, { collapseHeartbeats: !showHeartbeats });
  const failureTotal = digest.failures.reduce((sum, group) => sum + group.count, 0);
  /** 从一条日志跳到「只看这次运行 / 这个场景」：写入同一筛选状态，走服务端过滤。 */
  const filterFromEntry = (kind: "run" | "scene", value: string) => {
    setExpanded(undefined);
    if (kind === "run") { setRunId(value); setSceneId(""); }
    else { setSceneId(value); setRunId(""); }
  };

  return <div className="logs-page">
    <header className="access-heading"><div><h1>运行日志</h1><p>这里用一句话说明每件事：任务做了什么、哪一步失败、为什么失败。接口调用和参数默认隐藏，需要排障时再展开。</p></div></header>

    <section className="connection-settings logs-filters">
      <div className="connection-section-heading"><div><span className="section-index">01</span><div><h2>筛选</h2><p>不填就看全部；接口调用默认不显示，可在上方切换</p></div></div>
        <button type="button" className="button button-outline" onClick={() => void refresh()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={14} />刷新</button></div>
      <div className="connection-fields logs-filter-grid">
        <div className="field-group"><label className="field-label" htmlFor="log-source">日志来源</label>
          <select id="log-source" className="text-input" value={source} disabled={loading} onChange={e => setSource(e.target.value as "process" | "ops")}>
            <option value="process">后台运行日志（重启后清空）</option>
            <option value="ops">运维日志文件</option>
          </select></div>
        <div className="field-group"><label className="field-label" htmlFor="log-level">最低等级</label>
          <select id="log-level" className="text-input" value={level} disabled={loading} onChange={e => setLevel(e.target.value)}>
            <option value="">全部等级</option>{Object.entries(levelLabels).map(([key, label]) => <option key={key} value={key}>{label}及以上</option>)}
          </select></div>
        {source === "process" && <>
          <div className="field-group"><label className="field-label" htmlFor="log-event">事件名前缀</label>
            <input id="log-event" className="text-input mono-input" value={event} disabled={loading} placeholder="例如 run. 或 http.error" onChange={e => setEvent(e.target.value)} />
            <div className="logs-chips">{quickPrefixes.map(item => <button key={item.prefix} type="button" disabled={loading}
              className={"logs-chip" + (event.trim() === item.prefix ? " active" : "")}
              onClick={() => setEvent(current => current.trim() === item.prefix ? "" : item.prefix)}>{item.label}</button>)}</div>
          </div>
          <div className="field-group"><label className="field-label" htmlFor="log-run">运行ID</label>
            <input id="log-run" className={`text-input mono-input ${runId.trim() && !runIdPattern.test(runId.trim()) ? "input-invalid" : ""}`} value={runId} disabled={loading} placeholder="UUID，例如 0b2ddab7-…" onChange={e => setRunId(e.target.value)} />
            {runId.trim() && !runIdPattern.test(runId.trim()) && <small className="field-help field-help-error">请填写完整 UUID，或留空不按运行筛选。</small>}</div>
          <div className="field-group"><label className="field-label" htmlFor="log-scene">场景ID</label>
            <input id="log-scene" className="text-input mono-input" value={sceneId} disabled={loading} placeholder="例如 commerce" onChange={e => setSceneId(e.target.value)} /></div>
          {/* 场景包运行ID：包内 log() 的事件与它提交的子运行都带这个字段，填一次就能把整次包运行拉齐。 */}
          <div className="field-group"><label className="field-label" htmlFor="log-package-run">场景包运行ID</label>
            <input id="log-package-run" className={`text-input mono-input ${packageRunId.trim() && !runIdPattern.test(packageRunId.trim()) ? "input-invalid" : ""}`} value={packageRunId} disabled={loading} placeholder="UUID，场景包详情里复制" onChange={e => setPackageRunId(e.target.value)} />
            {packageRunId.trim() && !runIdPattern.test(packageRunId.trim()) && <small className="field-help field-help-error">请填写完整 UUID，或留空不按场景包筛选。</small>}</div>
        </>}
        {source === "ops" && <>
          <div className="field-group"><label className="field-label" htmlFor="log-ops-file">日志文件</label>
            <select id="log-ops-file" className="text-input" value={opsFile} disabled={loading} onChange={e => setOpsFile(e.target.value as LogOpsFile)}>
              {opsFileOptions.map(file => <option key={file.id} value={file.id}>{file.id} · {file.label}</option>)}
            </select>
            <small className="field-help">只能读取服务端白名单内的文件，不接受任意路径。</small></div>
          <div className="field-group"><label className="field-label" htmlFor="log-ops-tail">读取末尾行数</label>
            <input id="log-ops-tail" className="text-input" type="number" min={1} max={2000} value={opsTail} disabled={loading} onChange={e => setOpsTail(Number(e.target.value) || 200)} />
            <small className="field-help">默认 200，最大 2000。文件超过 4MB 时只扫描末尾窗口，此时 totalLines 只相对该窗口。</small></div>
        </>}
        <div className="field-group"><label className="field-label" htmlFor="log-keyword">关键字</label>
          <input id="log-keyword" className="text-input" value={keyword} disabled={loading} placeholder="匹配事件名与已脱敏字段内容" onChange={e => setKeyword(e.target.value)} /></div>
        {source === "process" && <div className="field-group"><label className="field-label" htmlFor="log-limit">每页条数</label>
          <input id="log-limit" className="text-input" type="number" min={1} max={200} value={limit} disabled={loading} onChange={e => setLimit(Number(e.target.value) || 50)} /></div>}
      </div>
      <div className="connection-form-footer"><span><Search size={14} />凭证、密钥类字段已替换为 [REDACTED]；日志保留本机地址与路径以便排障。</span>
        <button type="button" className="button button-dark" onClick={() => void refresh()} disabled={loading}>{loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{loading ? "读取中…" : "应用筛选"}</button></div>
    </section>

    {error && <div className="notice error-notice"><XCircle size={15} />{error}</div>}
    {copyError && <div className="notice error-notice"><XCircle size={15} />{copyError}</div>}

    {source === "process" && page && <section className="access-card">
      <header className="logs-heading"><h2>进程内日志</h2><span className="logs-meta">缓冲区 {page.buffer.size}/{page.buffer.capacity} 条 · revision {page.revision.slice(0, 8)}</span></header>
      <p className="logs-hint">匹配 {page.total} 条，最近在前{page.buffer.dropped > 0 ? ` · 已有 ${page.buffer.dropped} 条更早日志被容量挤出，不是没有产生` : ""}
        {page.buffer.retainedFromSequence > 0 ? ` · 当前保留自序号 ${page.buffer.retainedFromSequence}` : ""}
        {` · 本进程记录过的等级：${page.levelsAvailable.length ? page.levelsAvailable.map(item => levelLabels[item]).join("、") : "尚无"}（受 ZANE_LOG_LEVEL 下限影响）`}</p>

      {/* 先给结论：出了多少错、有多少噪音、剩下多少真实事件。 */}
      <div className="logs-digest">
        <div className={`logs-digest-card${failureTotal ? " logs-digest-bad" : " logs-digest-ok"}`}>
          <span className="logs-digest-value">{failureTotal}</span>
          <span className="logs-digest-label">{failureTotal ? `条失败 · ${digest.failures.length} 类原因` : "没有失败"}</span>
        </div>
        <div className="logs-digest-card">
          <span className="logs-digest-value">{digest.visibleEntries.length}</span>
          <span className="logs-digest-label">条业务事件</span>
        </div>
        <div className="logs-digest-card">
          <span className="logs-digest-value">{digest.heartbeatCount}</span>
          <span className="logs-digest-label">次状态轮询（已隐藏）</span>
          {digest.heartbeatCount > 0 && <button type="button" className="logs-digest-action" onClick={() => setShowHeartbeats(value => !value)}>{showHeartbeats ? "隐藏轮询" : "显示轮询"}</button>}
        </div>
        <div className="logs-digest-card">
          <span className="logs-digest-value">{showRequests ? "显示" : "隐藏"}</span>
          <span className="logs-digest-label">接口调用明细</span>
          <button type="button" className="logs-digest-action" onClick={() => setShowRequests(value => !value)}>{showRequests ? "隐藏接口调用" : "显示接口调用"}</button>
        </div>
      </div>

      {!entries.length && <p>当前没有可显示的内容。可能是这段时间确实没有业务事件，也可能被等级下限（ZANE_LOG_LEVEL）过滤掉了。</p>}

      {digest.failures.length > 0 && <>
        <h3 className="logs-section-title logs-section-bad"><AlertTriangle size={13} />出了什么问题</h3>
        <ul className="logs-list">
          {digest.failures.map(group => <FailureGroupRow key={group.key} group={group} entries={entries}
            open={expanded === "f" + group.key} onToggle={() => toggle("f" + group.key)}
            copiedKey={copiedKey} onCopy={copy} onFilter={filterFromEntry} identities={identities} />)}
        </ul>
      </>}

      {digest.noise.length > 0 && <>
        <h3 className="logs-section-title logs-section-muted"><RefreshCw size={13} />状态轮询（正常，已隐藏）</h3>
        <ul className="logs-list">
          {digest.noise.map(group => <NoiseGroupRow key={group.key} group={group}
            open={expanded === "n" + group.key} onToggle={() => toggle("n" + group.key)} />)}
        </ul>
      </>}

      {digest.visibleEntries.length > 0 && <>
        <h3 className="logs-section-title">其余事件</h3>
        <ul className="logs-list">
          {digest.visibleEntries.map((entry, position) => <ProcessEntry key={entry.sequence} entry={entry} open={expanded === "p" + entry.sequence}
            onToggle={() => toggle("p" + entry.sequence)} copiedKey={copiedKey} onCopy={copy} onFilter={filterFromEntry} identities={identities}
            allEntries={entries} position={position} />)}
        </ul>
      </>}
      {staleCursor && <p className="logs-hint" role="status">续页游标已作废；以下为重新读取的第一页。</p>}
      <div className="logs-actions">
        {cursor && <button className="button button-outline" disabled={loading} onClick={() => void (async () => {
          setLoading(true); setError("");
          try { await readProcess(cursor); setStaleCursor(false); }
          catch (reason) {
            if ((reason as { code?: string }).code === "LOG_PAGE_CHANGED") { setCursor(undefined); setStaleCursor(true); setError("更早的日志已被容量挤出，续页游标作废；请重新读取第一页。"); }
            else setError(reason instanceof Error ? reason.message : "读取更多日志失败");
          } finally { setLoading(false); }
        })()}>加载更早的日志</button>}
        {!cursor && entries.length > 0 && <span className="logs-hint">已到当前窗口末尾。</span>}
      </div>
    </section>}

    {source === "ops" && opsPage && <section className="access-card">
      <header className="logs-heading"><h2><FileText size={15} /> {opsPage.file}</h2>
        <span className="logs-meta">
          {opsPage.missing ? "文件当前不存在" : `${opsPage.lines.length} 行`}
          {opsPage.scannedWholeFile ? " · 已完整扫描" : ` · 仅扫描末尾 ${Math.round(opsPage.scannedBytes / 1024)}KB 窗口`}
          {opsPage.truncated ? " · 有行被裁剪" : ""}
        </span></header>
      {opsPage.missing && <p>该文件当前不存在，可能因为服务尚未以这种方式启动过。这不是读取失败；可从上方切换到实际存在的文件。</p>}
      {!opsPage.missing && <p className="logs-hint">
        本次扫描 {opsPage.totalLines} 行{opsPage.complete ? "，内容即整份文件" : `，只返回末尾 ${opsPage.tailLines} 行窗口`}。
        {!opsPage.scannedWholeFile && " 文件超过 4MB 字节上限，totalLines 与行号只相对末尾窗口。"}
        {" "}JSON 行按字段展开，非 JSON 行保留原文；顺序与文件一致（最早在上）。
      </p>}
      <p className="logs-hint">数据目录中可读的白名单文件：{opsPage.available.length ? opsPage.available.join("、") : "无"}</p>
      {!opsPage.missing && opsPage.lines.length > 0 && <div className="logs-view-toggle" role="group" aria-label="运维日志显示方式">
        <button type="button" className={opsView === "structured" ? "active" : ""} onClick={() => setOpsView("structured")}>结构化</button>
        <button type="button" className={opsView === "raw" ? "active" : ""} onClick={() => setOpsView("raw")}>原始文本</button>
      </div>}
      {!opsPage.missing && !opsPage.lines.length && <p>当前筛选没有匹配的行。</p>}
      {opsPage.lines.length > 0 && (opsView === "raw"
        ? <pre className="logs-ops-text">{opsPage.lines.map(line => `[${line.lineNumber}] ${line.text}${line.truncated ? " …[已裁剪]" : ""}`).join("\n")}</pre>
        : <ul className="logs-list">{opsLines.map(line => <OpsLine key={line.lineNumber} line={line} open={expanded === "o" + line.lineNumber}
          onToggle={() => toggle("o" + line.lineNumber)} copiedKey={copiedKey} onCopy={copy} identities={identities} />)}</ul>)}
    </section>}

    {!page && !opsPage && !error && <section className="access-card"><p><LoaderCircle className="spin" size={15} /> 正在读取日志…</p></section>}
  </div>;
}
