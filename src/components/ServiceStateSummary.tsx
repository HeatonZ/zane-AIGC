import type { ReactNode } from "react";
import type { PackagePresentation } from "../../server/domain/packageContracts.js";

/** `presentation.workspace.stateSummary` 的形态：包声明「这段工程账怎么展示」。 */
export type StateSummaryConfig = NonNullable<NonNullable<PackagePresentation["workspace"]>["stateSummary"]>;

/**
 * 结果区上方的工程账摘要：把包写在 `framework.store` 里的东西按 `stateSummary` 配置渲染出来。
 * 短剧包用它在页面上回答「这一集已经出了哪几段」。
 *
 * 三条硬约束：
 * - 读不到、或包里根本没这条账时**返回 undefined**：调用方据此整块不渲染，不留一个空标题。
 * - 账不是对象（数组/标量）一律当作「没有」，不猜它想表达什么。
 * - 只读投影：这里不发起请求、不写回，值原样来自 `GET /api/v1/self/packages/:id/state`。
 */
export function stateSummaryNode(config: StateSummaryConfig | undefined, value: unknown): ReactNode | undefined {
  if (!config || value === null || value === undefined) return undefined;
  const record = typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!record) return undefined;

  const label = typeof record.activeEpisodeLabel === "string" ? record.activeEpisodeLabel : undefined;
  const segments = Array.isArray(record.segments) ? record.segments.filter((item): item is string => typeof item === "string") : [];
  const bibleReady = record.bibleReady === true;
  const mergedAt = typeof record.mergedAt === "string" ? record.mergedAt : undefined;

  // list 形态：段号按顺序列出来；没有任何段时说明还没开始，而不是显示一个空列表。
  const body = config.format === "text"
    ? <p className="sws-state-text">{segments.length ? segments.join("、") : "还没有出过段"}</p>
    : segments.length
      ? <ol className="sws-state-list">{segments.map(segment => <li key={segment}><span className="sws-state-dot" aria-hidden="true" />{segment}</li>)}</ol>
      : <p className="sws-state-text">这一集还没有出过段</p>;

  return <div className="sws-state-body">
    <div className="sws-state-head">
      <strong>{config.title ?? "工程状态"}</strong>
      {label && <span className="sws-state-episode">{label}</span>}
    </div>
    {body}
    <div className="sws-state-meta">
      <span>{bibleReady ? "本集全局设定已存" : "还没存全局设定"}</span>
      <span>{segments.length ? `已出 ${segments.length} 段` : ""}</span>
      {mergedAt && <span>整集最近一次重拼：{new Date(mergedAt).toLocaleString("zh-CN")}</span>}
    </div>
  </div>;
}
