import { ArrowRight, Check, GitCompareArrows, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ModalPortal from "./ModalPortal";
import { useModalFocus } from "../hooks/useModalFocus";
import { ApiError, loadSceneDraftDiff, loadSceneDraftDiffValue } from "../lib/api";
import type { SceneDiffChange, SceneDiffPage, SceneDiffSection, SceneDiffValue } from "../../server/domain/sceneDiffContracts";

const sectionLabels: Record<SceneDiffSection, string> = { scene: "场景信息", workflow: "流程设置", inputs: "场景输入", steps: "处理步骤", outputs: "最终输出", optionPresets: "选项预设" };
const kindLabels = { added: "新增", removed: "删除", changed: "修改", reordered: "顺序调整" };
const sectionOrder: SceneDiffSection[] = ["scene", "workflow", "inputs", "steps", "outputs", "optionPresets"];

/** Highlight differing line ranges; business change detection stays on the server. */
export function changedLineRange(before: string, after: string) {
  const a = before.split("\n"), b = after.split("\n");
  let start = 0, suffix = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
  while (suffix < Math.min(a.length, b.length) - start && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { before: { start, end: a.length - suffix }, after: { start, end: b.length - suffix } };
}
function DiffValue({ sceneId, revision, change, side, onInvalidated }: { sceneId: string; revision: string; change: SceneDiffChange; side: "before" | "after"; onInvalidated(): void }) {
  const initial = change[side];
  const [value, setValue] = useState<SceneDiffValue>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function readMore() {
    if (value.nextOffset === null || busy) return;
    const request = new AbortController(); controller.current = request;
    setBusy(true); setError("");
    try {
      const next = await loadSceneDraftDiffValue(sceneId, { revision, changeId: change.changeId, side, offset: value.nextOffset, limit: 4000 }, request.signal);
      if (!request.signal.aborted) setValue({ ...next.value, offset: 0, text: value.text + next.value.text });
    } catch (cause) {
      if (request.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 409) onInvalidated();
      else setError(cause instanceof Error ? cause.message : "读取失败，已读内容仍保留");
    } finally { if (!request.signal.aborted) setBusy(false); }
  }
  const range = initial.complete && change.before.complete && change.after.complete ? changedLineRange(change.before.text, change.after.text)[side] : null;
  return <div className={`scene-diff-value ${side}`}>
    <small className="scene-diff-value-label">{side === "before" ? "当前发布" : "当前草稿"}</small>
    {!value.present ? <p className="scene-diff-absent">— 不存在</p> : <pre tabIndex={0} aria-label={`${change.objectLabel} ${change.label} ${side === "before" ? "改前" : "改后"}`}>
      {value.text === "" ? <span className="scene-diff-absent">（空字符串）</span> : value.text.split("\n").map((line, index) => <span key={index} className={range && index >= range.start && index < range.end ? "scene-diff-line highlighted" : "scene-diff-line"}>{line || "\u00a0"}</span>)}
    </pre>}
    {!value.complete && <div className="scene-diff-value-more"><span>内容未读完 · {value.nextOffset} / {value.totalChars} 字符</span><button type="button" className="button button-outline" disabled={busy} onClick={() => void readMore()}>{busy ? "读取中…" : "继续读取"}</button></div>}
    {error && <p className="scene-diff-error" role="alert">{error}<button type="button" className="text-action" onClick={() => void readMore()}>重试</button></p>}
  </div>;
}
export function SceneDiffContent({ page, onInvalidated }: { page: SceneDiffPage; onInvalidated(): void }) {
  return <>
    <div className="scene-diff-baseline"><div><small>对比基线</small><strong>{page.baseline ? `当前发布 v${page.baseline.version}` : "尚未发布 · 空基线"}</strong>{page.baseline && <time>{new Date(page.baseline.publishedAt).toLocaleString("zh-CN")}</time>}</div><ArrowRight size={18} /><div><small>修改后</small><strong>当前已保存草稿</strong><code title={page.draftRevision}>revision {page.draftRevision.slice(0, 12)}</code></div></div>
    <div className="scene-diff-summary" aria-label="差异统计">{Object.entries(kindLabels).map(([kind, label]) => <span className={kind} key={kind}>{label}<strong>{page.summary[kind as keyof typeof kindLabels]}</strong></span>)}<small>共 {page.total} 项差异</small></div>
    {page.preparationWarnings.length > 0 && <div className="scene-diff-warning" role="status"><strong>以下步骤尚不能按发布配置规范化；仍显示草稿差异，发布前需要修复并校验。</strong>{page.preparationWarnings.map((warning, index) => <p key={index}>{warning.stepId}：{warning.message}</p>)}</div>}
    {!page.hasChanges && <div className="scene-diff-empty"><Check size={23} /><strong>草稿与当前发布版一致</strong><p>没有待发布的配置差异。</p></div>}
    {sectionOrder.map(section => {
      const changes = page.changes.filter(change => change.section === section);
      if (!changes.length) return null;
      return <section className="scene-diff-group" key={section}><h3>{sectionLabels[section]}<span>{changes.length} 项已加载</span></h3>{changes.map(change => <article className={`scene-diff-change ${change.kind}`} key={change.changeId}>
        <header><div><strong>{change.objectLabel}</strong><span>{change.label}</span><code>{change.path}</code></div><span className={`scene-diff-kind ${change.kind}`}>{kindLabels[change.kind]}</span></header>
        <div className="scene-diff-columns">{(["before", "after"] as const).map(side => <DiffValue key={side} sceneId={page.sceneId} revision={page.revision} change={change} side={side} onInvalidated={onInvalidated} />)}</div>
      </article>)}</section>;
    })}
  </>;
}
export default function SceneDiffDialog({ sceneId, sceneTitle, contentHash, saveStatus, onClose }: { sceneId: string; sceneTitle: string; contentHash: string; saveStatus: "saving" | "saved" | "failed"; onClose(): void }) {
  const modalRef = useModalFocus(onClose);
  const [page, setPage] = useState<SceneDiffPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const request = new AbortController(); controller.current = request;
    setPage(null); setError(""); setLoadingMore(false);
    if (saveStatus !== "saved") { setLoading(false); return () => request.abort(); }
    setLoading(true);
    void loadSceneDraftDiff(sceneId, { contentHash }, request.signal).then(result => {
      if (!request.signal.aborted) setPage(result);
    }).catch(cause => {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : "差异预览加载失败");
    }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [sceneId, contentHash, saveStatus, refresh]);
  function invalidated() {
    setPage(null); setError("草稿或当前发布版已变化，旧差异已停止展示。请重新预览；不会拼接不同版本的内容。");
  }
  async function readMore() {
    if (!page?.nextCursor || loadingMore) return;
    const signal = controller.current?.signal;
    setLoadingMore(true); setError("");
    try {
      const next = await loadSceneDraftDiff(sceneId, { contentHash, revision: page.revision, cursor: page.nextCursor }, signal);
      if (!signal?.aborted) setPage(current => current?.revision === next.revision ? { ...next, changes: [...current.changes, ...next.changes] } : current);
    } catch (cause) {
      if (signal?.aborted) return;
      if (cause instanceof ApiError && cause.status === 409) invalidated();
      else setError(cause instanceof Error ? cause.message : "读取失败，已读差异仍保留");
    } finally { if (!signal?.aborted) setLoadingMore(false); }
  }
  return <ModalPortal><div className="modal-backdrop scene-diff-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={modalRef} className="scene-diff-dialog" role="dialog" aria-modal="true" aria-labelledby="scene-diff-title">
      <header className="scene-diff-heading"><div><h2 id="scene-diff-title"><GitCompareArrows size={19} />{sceneTitle} · 差异预览</h2><p>已保存草稿 ↔ 当前发布快照。仅预览，不保存、不发布、不生成。</p></div><button type="button" className="icon-button" aria-label="关闭差异预览" onClick={onClose}><X size={19} /></button></header>
      <div className="scene-diff-body" aria-busy={loading || loadingMore}>
        {saveStatus !== "saved" && <div className="scene-diff-warning" role="status">{saveStatus === "saving" ? "正在保存配置，等待服务端确认后自动加载差异…" : "保存尚未确认，暂不预览旧服务端草稿。请先对账并确认保存。"}</div>}
        {loading && <div className="scene-diff-empty" role="status"><LoaderCircle size={23} className="scene-diff-spinner" /><p>正在读取权威草稿与发布快照…</p></div>}
        {error && <div className="scene-diff-error" role="alert">{error}</div>}
        {page && saveStatus === "saved" && <SceneDiffContent key={page.revision} page={page} onInvalidated={invalidated} />}
        {page?.hasMore && <div className="scene-diff-pagination"><span>已加载 {page.changes.length} / {page.total} 项</span><button type="button" className="button button-outline" onClick={() => void readMore()} disabled={loadingMore}>{loadingMore ? "读取中…" : "加载更多差异"}</button></div>}
      </div>
      <footer className="scene-diff-footer"><small>发布仍需通过校验并显式确认；预览不会改变现版本。</small><button type="button" className="button button-outline" onClick={() => setRefresh(value => value + 1)} disabled={loading || loadingMore || saveStatus !== "saved"}><RefreshCw size={14} />重新预览</button><button type="button" className="button button-dark" onClick={onClose}>关闭</button></footer>
    </section>
  </div></ModalPortal>;
}
