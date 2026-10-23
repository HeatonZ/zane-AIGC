import { useState, type ReactNode } from "react";
import { formatPoints } from "../../server/domain/creditUnits.js";
import type { ServicePresentation } from "./ServicePage";

/**
 * 工具型服务页（layout=workspace）：左边控制栏、右边结果画布。
 *
 * 为什么需要第二个骨架：营销页（主视觉 + 卖点 + 表单）适合「第一次了解这个服务」，
 * 但出图、改图这类高频工具每次都要滚过一大段介绍才到输入框，出完图还要往下滚才看得到结果。
 * 工作台把「调参数」和「看结果」放在同一屏，结果常驻不滚走。
 */
export function ServiceWorkspace({ presentation, title, summary, form, result, history, resultActions, credits, cost, busy, submitLabel, onSubmit, onBack }: {
  presentation?: ServicePresentation;
  title: string;
  summary?: string;
  /** 左侧控制栏：提示词、参考图、风格预设等字段（不含提交按钮）。 */
  form: ReactNode;
  /** 右侧结果区：当前/最近一次产出。 */
  result: ReactNode;
  /** 底部最近几次产出（可省略）。 */
  history?: ReactNode;
  /** 结果区右上角操作：例如「用这组参数」。 */
  resultActions?: ReactNode;
  credits?: number;
  cost?: number | null;
  busy?: boolean;
  submitLabel?: string;
  /** 提交入口由外层提供：费用确认与对账都在外层，工作台只负责摆放按钮。 */
  onSubmit: () => void;
  onBack?: () => void;
}) {
  const workspace = presentation?.workspace ?? {};
  const [historyOpen, setHistoryOpen] = useState(true);
  const historyVisible = workspace.history !== false && historyOpen && Boolean(history);
  return <div className="sws">
    <header className="sws-head">
      {onBack && <button type="button" className="sws-back" onClick={onBack} aria-label="返回全部服务">← 全部服务</button>}
      <div className="sws-head-copy">
        <h1>{workspace.title ?? title}</h1>
        <p>{workspace.subtitle ?? summary ?? ""}</p>
      </div>
      <div className="sws-head-meta">
        {credits !== undefined && <span className="sws-credit">可用 {formatPoints(credits)} 积分</span>}
        {history && workspace.history !== false && <button type="button" className="sws-toggle" onClick={() => setHistoryOpen(value => !value)} aria-pressed={historyOpen}>
          {historyOpen ? "隐藏历史" : "显示历史"}
        </button>}
      </div>
    </header>

    <div className="sws-body">
      <section className="sws-controls" aria-label="参数">
        <div className="sws-fields">{form}</div>
        <div className="sws-submit">
          <div className="sws-price">
            {/* 预检未完成/失败时不冒充价格：显示「按量计费」比一个省略号更诚实。 */}
            {cost === null || cost === undefined
              ? <strong className="sws-price-pending">按量计费</strong>
              : <><strong>{formatPoints(cost)}</strong><span>积分 / 次</span></>}
          </div>
          <button type="button" className="sws-submit-button" disabled={busy} onClick={onSubmit}>{busy ? "生成中…" : submitLabel ?? presentation?.resultLabels?.cta ?? "开始生成"}</button>
        </div>
        <p className="sws-hint">按上限预扣，按成功项结算并退还差额；未生成的部分自动退回。</p>
      </section>

      <section className="sws-canvas" aria-label={workspace.resultTitle ?? "结果"}>
        <div className="sws-canvas-head">
          <h2>{workspace.resultTitle ?? presentation?.resultLabels?.sectionTitle ?? "结果"}</h2>
          {resultActions && <div className="sws-canvas-actions">{resultActions}</div>}
        </div>
        <div className="sws-result">{result}</div>
      </section>
    </div>

    {historyVisible && <section className="sws-history" aria-label="最近产出">
      <h2>最近产出</h2>
      {history}
    </section>}
  </div>;
}
