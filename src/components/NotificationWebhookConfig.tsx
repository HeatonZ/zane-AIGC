import { Bell, Check, LoaderCircle, RefreshCw, Save, Send, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { loadNotificationWebhook, relayNotification, saveNotificationWebhook, testNotificationWebhook } from "../lib/api";
import type { NotificationRelayReceipt, NotificationWebhookSettings, NotificationWebhookTestResult } from "../types";

/** 事件的中文名与「什么时候会收到」——勾选列表直接用人话解释，避免只看到内部事件名。 */
export const notificationEventLabels: Record<string, string> = {
  "run.queued": "任务进入队列",
  "run.started": "任务开始执行",
  "run.waiting": "等待人工确认",
  "run.completed": "任务完成",
  "run.failed": "任务失败",
  "run.cancelled": "任务取消",
  "run.stale": "任务中断（需续跑）",
  "step.failed": "步骤失败",
  "step.completed_with_errors": "步骤部分失败",
  "review.approve": "审核通过",
  "review.redo": "审核退回",
};

/** 与后端 normalizeNotificationWebhookUrl 同一口径：只校验形状，不做网络探测。 */
export function notificationWebhookUrlError(value: string): string {
  const text = value.trim();
  if (!text) return "";
  if (text.length > 2048) return "地址过长，最多 2048 个字符。";
  if (/[\0\r\n\t]/.test(text)) return "地址不能包含控制字符。";
  let parsed: URL;
  try { parsed = new URL(text); } catch { return "请填写完整的 http(s) 地址，例如 https://discord.com/api/webhooks/…。"; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "只支持 http 或 https 地址。";
  if (parsed.username || parsed.password) return "地址不能内嵌用户名或密码。";
  if (parsed.hash) return "地址不能带片段（#）。";
  return "";
}

export function validAggregateSeconds(value: string) {
  const numeric = value.trim() ? Number(value) : NaN;
  return Number.isInteger(numeric) && numeric >= 5 && numeric <= 300;
}

export default function NotificationWebhookConfig() {
  const [snapshot, setSnapshot] = useState<NotificationWebhookSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [webhookFormat, setWebhookFormat] = useState<NotificationWebhookSettings["webhookFormat"]>("discord");
  const [events, setEvents] = useState<string[]>([]);
  const [aggregateSeconds, setAggregateSeconds] = useState("30");
  const [clearUrl, setClearUrl] = useState(false);
  const [relayEnabled, setRelayEnabled] = useState(false);
  const [relayToken, setRelayToken] = useState("");
  const [clearRelayToken, setClearRelayToken] = useState(false);
  const [relayText, setRelayText] = useState("");
  const [relaying, setRelaying] = useState(false);
  const [relayResult, setRelayResult] = useState<NotificationRelayReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testResult, setTestResult] = useState<NotificationWebhookTestResult | null>(null);

  function adopt(current: NotificationWebhookSettings) {
    setSnapshot(current);
    setEnabled(current.enabled);
    setUrl("");
    setWebhookFormat(current.webhookFormat);
    setEvents(current.events);
    setAggregateSeconds(String(current.aggregateSeconds));
    setClearUrl(false);
    setRelayEnabled(current.relay.enabled);
    setRelayToken("");
    setClearRelayToken(false);
    setRelayResult(null);
    setNeedsReconcile(false);
  }

  async function read() {
    setLoading(true);
    setError("");
    setNotice("");
    try { adopt(await loadNotificationWebhook()); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取通知 Webhook 配置");
      setNeedsReconcile(true);
    } finally { setLoading(false); }
  }
  useEffect(() => { void read(); }, []);

  function toggleEvent(type: string) {
    setEvents(current => current.includes(type) ? current.filter(item => item !== type) : [...current, type]);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!snapshot || needsReconcile || urlError || !validAggregateSeconds(aggregateSeconds)) return;
    setSaving(true);
    setError("");
    setNotice("");
    setTestResult(null);
    try {
      const current = await saveNotificationWebhook({
        revision: snapshot.revision,
        enabled,
        // 三态：清除 / 替换 / 省略保持。留空且未勾选清除 = 保持已保存地址。
        ...(clearUrl ? { url: "" } : url.trim() ? { url: url.trim() } : {}),
        webhookFormat,
        events,
        aggregateSeconds: Number(aggregateSeconds),
        relayEnabled,
        // relayToken 同样三态；留空且未勾选清除 = 保持已保存凭证。
        ...(clearRelayToken ? { relayToken: "" } : relayToken.trim() ? { relayToken: relayToken.trim() } : {}),
      });
      adopt(current);
      setNotice(current.enabled
        ? "通知已保存：之后匹配的运行事件会按聚合窗口合并后发送。"
        : current.configured ? "通知已保存但未启用；勾选「启用转发」后才会发送。" : "通知已保存；填写 Webhook 地址并启用后才会发送。");
    } catch (reason) {
      // 服务端可能已经提交：禁用写入，先重新读取核对，不重复提交旧请求。
      setNeedsReconcile(true);
      setError((reason instanceof Error ? reason.message : "保存回执未知") + "。请先重新读取配置核对，不要重复提交旧请求。");
    } finally { setSaving(false); }
  }

  /** 管理员自测转发：走同一套投递，不需要 relay token。 */
  async function relay() {
    if (!relayText.trim()) return;
    setRelaying(true);
    setError("");
    setNotice("");
    setRelayResult(null);
    try {
      const result = await relayNotification({ text: relayText.trim(), source: "admin-console" });
      setRelayResult(result);
      if (result.relayed) setNotice("已转发（HTTP " + result.status + "，共 " + result.chars + " 字" + (result.truncated ? "，已按平台上限截断" : "") + "）。");
      else setError("转发失败（HTTP " + result.status + "）：" + (result.error ?? "目标未接受"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "转发失败");
    } finally { setRelaying(false); }
  }

  async function test() {
    setTesting(true);
    setError("");
    setNotice("");
    setTestResult(null);
    try {
      const result = await testNotificationWebhook();
      setTestResult(result);
      if (result.sent) setNotice("测试消息已发送（HTTP " + result.status + "）。");
      else setError("测试发送失败（HTTP " + result.status + "）：" + (result.error ?? "目标未接受消息") + "。请核对地址与目标端设置；不会自动重试。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "测试发送失败");
    } finally { setTesting(false); }
  }

  const busy = loading || saving || testing || relaying;
  const urlError = notificationWebhookUrlError(url);
  const hasStoredUrl = Boolean(snapshot?.hasUrl);
  const willHaveUrl = clearUrl ? false : Boolean(url.trim()) || hasStoredUrl;
  const incomplete = enabled && (!willHaveUrl || events.length === 0);
  const delivery = snapshot?.delivery;

  return (
    <form className="connection-settings" onSubmit={save}>
      <div className="connection-section-heading"><div><span className="section-index">07</span><div><h2>运行事件通知</h2><p>把任务完成、失败、等待审核等事件聚合后转发到 Discord 或自建 Webhook，管理员配置</p></div></div><button type="button" className="button button-outline" onClick={() => void read()} disabled={busy}><RefreshCw size={14} />重新读取配置</button></div>
      <div className="connection-fields">
        <div className="field-group">
          <label className="field-label" htmlFor="notification-webhook-url">Webhook 地址</label>
          <input
            id="notification-webhook-url"
            className="text-input mono-input"
            type="password"
            value={url}
            placeholder={hasStoredUrl ? `已保存（${snapshot?.urlMasked}）；留空表示不修改` : "https://discord.com/api/webhooks/…"}
            onChange={event => setUrl(event.target.value)}
            disabled={busy || needsReconcile || clearUrl}
            aria-invalid={Boolean(urlError)}
            autoComplete="new-password"
            spellCheck={false}
          />
          <small className="field-help">地址通常含平台 token，明文保存在本机 SQLite；读接口只显示掩码（末 4 位）。留空即保持原值，只改事件或聚合窗口不会清空它。</small>
          {hasStoredUrl && !clearUrl && <small className="field-help"><Bell size={13} />已保存：{snapshot?.urlMasked}。<button type="button" className="text-button danger-text" onClick={() => setClearUrl(true)} disabled={busy}>清除已保存地址</button></small>}
          {clearUrl && <small className="field-help">保存后将清除地址并同时关闭转发。<button type="button" className="text-button" onClick={() => setClearUrl(false)} disabled={busy}>取消清除</button></small>}
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="notification-webhook-format">目标平台</label>
          <select id="notification-webhook-format" className="text-input" value={webhookFormat} onChange={event => setWebhookFormat(event.target.value as NotificationWebhookSettings["webhookFormat"])} disabled={busy || needsReconcile}>
            {(snapshot?.formats ?? [{ id: "discord" as const, label: "Discord", maxChars: 1900 }, { id: "generic" as const, label: "通用 JSON", maxChars: 1900 }]).map(format => (
              <option key={format.id} value={format.id}>{format.label}（单条最多 {format.maxChars} 字）</option>
            ))}
          </select>
          <small className="field-help">每个平台由适配器拼装各自载荷：Discord 用 content 并禁用提及，Slack 用 text 且不预览链接，飞书用 msg_type=text，通用 JSON 保留结构化事件数组。换平台只改这里，事件与聚合窗口不变。</small>
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="notification-webhook-aggregate">聚合窗口（秒）</label>
          <input id="notification-webhook-aggregate" className="text-input" type="number" min={5} max={300} step={1} value={aggregateSeconds} onChange={event => setAggregateSeconds(event.target.value)} disabled={busy || needsReconcile} aria-invalid={!validAggregateSeconds(aggregateSeconds)} />
          <small className="field-help">范围 5–300，默认 30。窗口内的事件合并成一条消息，避免刷屏与触发平台限流；每条消息最多 {snapshot?.limits.eventsPerMessage ?? 10} 个事件。</small>
        </div>
      </div>

      <div className="field-group">
        <span className="field-label">转发哪些事件</span>
        <div className="profile-grid">
          {(snapshot?.supportedEvents ?? Object.keys(notificationEventLabels)).map(type => {
            const selected = events.includes(type);
            return <label className={`profile-choice ${selected ? "selected" : ""}`} key={type}>
              <input type="checkbox" checked={selected} onChange={() => toggleEvent(type)} disabled={busy || needsReconcile} />
              <span className="profile-check"><Check size={12} /></span>
              <span className="profile-choice-name">{notificationEventLabels[type] ?? type}<small className="field-help"><code>{type}</code></small></span>
            </label>;
          })}
        </div>
        <small className="field-help">只转发勾选的事件；逐项开始、内部 checkpoint 等高频事件永不转发。默认勾选等待审核、完成、失败、取消与中断。</small>
      </div>

      <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={busy || needsReconcile} />启用转发（需要已保存地址且至少选择 1 个事件）</label>
      {incomplete && <div className="notice"><Bell size={15} />启用前请先保存 Webhook 地址，并至少勾选 1 个事件。</div>}

      <div className="comfy-heading" style={{ marginTop: 16 }} />
      <div className="field-group">
        <span className="field-label">入站转发（别的系统 → 工作台 → 目标）</span>
        <small className="field-help">开启后，外部系统可以用下面的凭证把文本 POST 到 <code>{snapshot?.relay.endpoint ?? "/api/v1/hooks/relay"}</code>，由工作台转发到上面配置的目标。目标地址与平台格式只来自本页，调用方无法指定。</small>
        <label className="field-label" htmlFor="notification-relay-token" style={{ marginTop: 8 }}>转发凭证</label>
        <input
          id="notification-relay-token"
          className="text-input mono-input"
          type="password"
          value={relayToken}
          placeholder={snapshot?.relay.configured ? `已保存（${snapshot.relay.tokenMasked}）；留空表示不修改` : "24–200 位字母、数字、_ 或 -"}
          onChange={event => setRelayToken(event.target.value)}
          disabled={busy || needsReconcile || clearRelayToken}
          autoComplete="new-password"
          spellCheck={false}
        />
        {snapshot?.relay.configured && !clearRelayToken && <small className="field-help">已保存凭证前 4 位以外的部分不可回读（{snapshot.relay.tokenMasked}）。<button type="button" className="text-button danger-text" onClick={() => setClearRelayToken(true)} disabled={busy}>清除凭证并关闭入站转发</button></small>}
        {clearRelayToken && <small className="field-help">保存后将清除凭证并关闭入站转发。<button type="button" className="text-button" onClick={() => setClearRelayToken(false)} disabled={busy}>取消清除</button></small>}
        <label className="checkbox-row" style={{ marginTop: 8 }}><input type="checkbox" checked={relayEnabled} onChange={event => setRelayEnabled(event.target.checked)} disabled={busy || needsReconcile || !willHaveUrl} />允许外部系统调用入站转发</label>
        <small className="field-help">入站转发接受两种凭证：上面设置的 relay token，或本机运维凭证 <code>ZANE_ADMIN_TOKEN</code>（两者都可以，任一匹配即可）。不想单独维护一把钥匙时，relay token 留空也能用管理员 token 调用；但 relay token 权限更小（只能发到这个固定目标，不能管理任何业务），建议外部系统用它。</small>
        {snapshot && <small className="field-help">调用示例：<code>curl -X POST {window.location.origin}{snapshot.relay.endpoint} -H "Authorization: Bearer &lt;凭证&gt;" -H "Content-Type: application/json" -d '{`{"text":"构建完成","title":"CI"}`}'</code>。单条正文最长 {snapshot.relay.maxChars} 字，超出直接拒绝；按平台上限自动截断。</small>}
      </div>

      <div className="field-group">
        <label className="field-label" htmlFor="notification-relay-text">转发一条测试内容（管理员，不需要凭证）</label>
        <textarea id="notification-relay-text" className="text-input" rows={3} value={relayText} onChange={event => setRelayText(event.target.value)} disabled={busy || needsReconcile || !hasStoredUrl} placeholder="例如：流水线 #128 构建完成" />
        <div className="footer-actions" style={{ marginTop: 8 }}>
          <button className="button button-outline" type="button" onClick={() => void relay()} disabled={busy || needsReconcile || !hasStoredUrl || !relayText.trim()}>{relaying ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}{relaying ? "转发中…" : "转发这条内容"}</button>
        </div>
        {relayResult && <small className="field-help">转发回执：{relayResult.relayed ? "已送达" : "未送达"} · HTTP {relayResult.status} · {relayResult.chars} 字{relayResult.truncated ? "（已截断）" : ""} · {relayResult.attemptedAt}{relayResult.error ? ` · ${relayResult.error}` : ""}。</small>}
      </div>

      {delivery && <small className="field-help">投递统计（本进程）：待发送 {delivery.pendingEvents} · 已送达 {delivery.deliveredMessages} 条/{delivery.deliveredEvents} 个事件 · 失败 {delivery.failedMessages} 条 · 丢弃 {delivery.droppedEvents} 个 · 入站转发 {delivery.relayedMessages} 成功/{delivery.relayedFailed} 失败{delivery.lastSuccessAt ? ` · 最近成功 ${delivery.lastSuccessAt}` : ""}{delivery.lastError ? ` · 最近错误 ${delivery.lastError}` : ""}。通知失败不影响任务执行；进程重启后未发送事件不补发。</small>}

      {notice && <div className="notice success-notice"><Check size={15} />{notice}</div>}
      {urlError && <div className="notice error-notice"><X size={15} />{urlError}</div>}
      {!validAggregateSeconds(aggregateSeconds) && <div className="notice error-notice"><X size={15} />聚合窗口必须是 5–300 的整数秒。</div>}
      {error && <div className="notice error-notice"><X size={15} />{error}</div>}
      {testResult && <small className="field-help">测试回执：{testResult.sent ? "已送达" : "未送达"} · HTTP {testResult.status} · {testResult.attemptedAt} · 目标 {testResult.urlMasked}。</small>}

      <div className="connection-form-footer">
        <span>保存与启用不会发送消息；「发送测试消息」会立即真实访问目标一次，不自动重试。</span>
        <div className="footer-actions">
          <button className="button button-outline" type="button" onClick={() => void test()} disabled={busy || needsReconcile || !hasStoredUrl || clearUrl}>{testing ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}{testing ? "发送中…" : "发送测试消息"}</button>
          <button className="button button-dark" type="submit" disabled={busy || !snapshot || needsReconcile || Boolean(urlError) || !validAggregateSeconds(aggregateSeconds)}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{saving ? "保存中…" : "保存通知配置"}</button>
        </div>
      </div>
    </form>
  );
}
