import { useEffect, useRef, useState } from "react";
import { AccessApiError } from "../lib/accessApi";
import { feedbackPath, listFeedback, readFeedback, writeFeedback, type FeedbackPage } from "../lib/systemFeedbackApi";
import type { SystemFeedback as Feedback } from "../../server/domain/systemFeedbackContracts";
import { runDate } from "../lib/runDetails";

const statuses = { pending: "待处理", processing: "处理中", resolved: "已解决", rejected: "不采纳" } as const;
const categories = { bug: "使用问题", suggestion: "改进建议", other: "其他" } as const;
export default function SystemFeedback({ userId, admin = false }: { userId: string; admin?: boolean }) {
  const pendingKey = "zane-studio:system-feedback-intent:v1:" + userId + (admin ? ":admin" : ":user");
  const [pending, setPending] = useState(() => { try { return localStorage.getItem(pendingKey) ?? ""; } catch { return ""; } });
  const [createId, setCreateId] = useState(() => pending || crypto.randomUUID());
  const [absent, setAbsent] = useState(false);
  const [title, setTitle] = useState(""); const [description, setDescription] = useState("");
  const [category, setCategory] = useState<Feedback["category"]>("bug"); const [runId, setRunId] = useState("");
  const [items, setItems] = useState<FeedbackPage["items"]>([]); const [cursor, setCursor] = useState<string>();
  const [filter, setFilter] = useState(""); const [selected, setSelected] = useState<Feedback>();
  const [status, setStatus] = useState<Feedback["status"]>("processing"); const [reply, setReply] = useState("");
  const [unknownWrite, setUnknownWrite] = useState("");
  const [busy, setBusy] = useState(false); const locked = useRef(false);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  async function load(next?: string) {
    const request = ++sequence.current;
    const data = await listFeedback(userId, admin, filter, next);
    if (request !== sequence.current) return;
    setItems(current => next ? [...current, ...data.items] : data.items); setCursor(data.nextCursor);
  }
  async function perform(task: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : "反馈操作失败"); }
    finally { locked.current = false; setBusy(false); }
  }
  useEffect(() => {
    setItems([]); setCursor(undefined); void load().catch(e => setError((e as Error).message));
    return () => { sequence.current++; };
  }, [filter, userId, admin]);
  function show(feedback: Feedback) { setSelected(feedback); setReply(feedback.reply); setStatus("processing"); }
  function clearIntent() { localStorage.removeItem(pendingKey); setPending(""); setAbsent(false); }
  async function submit() {
    // Persist only an unconfirmed intent ID. Reload reads the server, never restores or replays a business record.
    localStorage.setItem(pendingKey, createId); setPending(createId); setAbsent(false);
    let saved: Feedback;
    try {
      saved = (await writeFeedback(userId, feedbackPath(false), createId, { feedbackId: createId, title, description, category, ...(runId.trim() ? { runId: runId.trim() } : {}) })).feedback;
    } catch (e) {
      if (e instanceof AccessApiError && [400, 401, 403, 404].includes(e.status)) clearIntent();
      throw e;
    }
    clearIntent(); show(saved); setCreateId(crypto.randomUUID()); setTitle(""); setDescription(""); setRunId("");
    setNotice("系统反馈已提交，等待管理员处理；未发送给 Agent。"); await load();
  }
  async function reconcile() {
    try {
      const { feedback } = await readFeedback(userId, false, pending);
      show(feedback); clearIntent(); setCreateId(crypto.randomUUID()); setTitle(""); setDescription(""); setRunId("");
      setNotice("已读取原反馈ID并核验提交成功，没有重复提交。"); await load();
    } catch (e) {
      if (e instanceof AccessApiError && e.status === 404) { setAbsent(true); setNotice("原反馈ID未写入；可显式返回填写，沿用原ID。"); return; }
      throw e;
    }
  }
  async function choose(id: string) {
    const { feedback } = await readFeedback(userId, admin, id); show(feedback);
    if (unknownWrite === id) { setUnknownWrite(""); setNotice("已读取服务端最新状态，请核对回复和revision后再决定。"); }
  }
  async function handle() {
    if (!selected) return;
    const id = selected.id;
    let saved: Feedback;
    try {
      saved = (await writeFeedback(userId, feedbackPath(true, id) + "/handle", id, { revision: selected.revision, status, reply })).feedback;
    } catch (e) { setUnknownWrite(id); throw e; }
    show(saved); setNotice("处理结果已保存 · r" + saved.revision); setCursor(undefined); await load();
  }
  return <div className="access-stack system-feedback">
    {admin && <header className="access-heading"><div><h1>系统反馈</h1><p>集中处理用户问题与建议。回复和状态仅保存到系统反馈，不自动影响 Agent 或工作流。</p></div></header>}
    {error && <p className="access-error" role="alert">{error}</p>}{notice && <p className="access-success" role="status">{notice}</p>}
    {!admin && <section className="access-card"><h2>提交系统反馈</h2><p>由管理员审核处理，不直接作为 Agent 修订意见。</p>
      {pending ? <div role="status"><p>提交回执待核验：{pending}。请先按原ID对账，不重复提交。</p><button className="button button-outline" disabled={busy} onClick={() => void perform(reconcile)}>查询原反馈ID</button>
        {absent && <button className="button button-outline" disabled={busy} onClick={() => { setCreateId(pending); clearIntent(); }}>确认未写入，返回填写并沿用原ID</button>}</div>
        : <form onSubmit={e => { e.preventDefault(); void perform(submit); }}>
          <label>反馈标题<input className="text-input" value={title} maxLength={120} required disabled={busy} onChange={e => setTitle(e.target.value)} /></label>
          <label>反馈类型<select className="text-input" value={category} disabled={busy} onChange={e => setCategory(e.target.value as Feedback["category"])}>{Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label>问题描述 / 改进建议<textarea className="text-input" value={description} maxLength={8000} required disabled={busy} onChange={e => setDescription(e.target.value)} placeholder="请描述遇到的问题、复现步骤或期望改善的内容。" /></label>
          <label>关联任务ID（可选）<input className="text-input" value={runId} disabled={busy} onChange={e => setRunId(e.target.value)} placeholder="只可关联有权限读取的任务" /></label>
          <button className="button button-dark" disabled={busy || !title.trim() || !description.trim()}>提交给管理员</button>
        </form>}
    </section>}
    <section className="access-card"><header className="system-feedback-heading"><h2>{admin ? "反馈列表" : "我的反馈"}</h2><div><select aria-label="反馈状态筛选" className="text-input" value={filter} disabled={busy} onChange={e => { setFilter(e.target.value); setError(""); }}><option value="">全部状态</option>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button className="button button-outline" disabled={busy} onClick={() => void perform(() => load())}>刷新列表</button></div></header>
      {!items.length && <p>暂无反馈</p>}<div className="system-feedback-list">{items.map(item => <button key={item.id} disabled={busy} className={selected?.id === item.id ? "selected" : ""} onClick={() => void perform(() => choose(item.id))}><strong>{item.title}</strong><span>{statuses[item.status]} · {categories[item.category]}{admin ? " · " + item.submitterName : ""}</span><small>{runDate(item.createdAt)}</small></button>)}</div>
      {cursor && <button className="button button-outline" disabled={busy} onClick={() => void perform(() => load(cursor))}>加载更多</button>}
    </section>
    {unknownWrite && <section className="access-card"><p>处理回执待核验：{unknownWrite}。写入已锁定，请先读取原反馈，不自动重放。</p><button className="button button-outline" disabled={busy} onClick={() => void perform(() => choose(unknownWrite))}>核验原反馈</button></section>}
    {selected && <section className="access-card"><h2>{selected.title}</h2><p>{statuses[selected.status]} · {categories[selected.category]} · r{selected.revision}</p><small>反馈ID：{selected.id}{admin ? " · 提交人：" + selected.submitterName + "（" + selected.userId + "）" : ""}</small>{selected.runId && <p>关联任务：{selected.runId}</p>}
      <h3>反馈内容</h3><p className="system-feedback-text">{selected.description}</p><h3>管理员回复</h3><p className="system-feedback-text">{selected.reply || "管理员尚未回复"}</p><small>最后更新：{runDate(selected.updatedAt)}</small>
      <button className="button button-outline" disabled={busy} onClick={() => void perform(() => choose(selected.id))}>读取最新详情</button>
      {admin && <form onSubmit={e => { e.preventDefault(); void perform(handle); }}><label>处理状态<select className="text-input" value={status} disabled={busy || !!unknownWrite} onChange={e => setStatus(e.target.value as Feedback["status"])}><option value="processing">处理中 / 重新处理</option>{!["resolved", "rejected"].includes(selected.status) && <><option value="resolved">已解决</option><option value="rejected">不采纳</option></>}</select></label><label>处理说明 / 回复<textarea className="text-input" maxLength={4000} required value={reply} disabled={busy || !!unknownWrite} onChange={e => setReply(e.target.value)} /></label><button className="button button-dark" disabled={busy || !!unknownWrite || !reply.trim()}>保存处理结果</button><small>基于当前 r{selected.revision} 保存；已结束的反馈须先显式重新处理。</small></form>}
    </section>}
  </div>;
}
