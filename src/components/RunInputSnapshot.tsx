import { ChevronLeft, ChevronRight } from "lucide-react";
import { previousValueOffset } from "../lib/runDetails";
import RunValueView from "./RunValueView";

/** 服务端运行输入快照的一页：单次运行与服务运行共用同一形状与口径。 */
export interface RunInputPageShape {
  revision?: string;
  inputs: RunInputFieldShape[];
  nextCursor?: string;
  hasMore?: boolean;
  total?: number;
}
export interface RunInputFieldShape {
  key: string; label: string; type: string; required: boolean; present: boolean;
  minimum?: number; maximum?: number;
  value?: unknown; valueOmitted?: boolean; omissionReason?: string;
  valueBytes?: number;
  valuePage: { kind: string; total: number; offset: number; count: number; pageSize: number; complete?: boolean; hasMore: boolean; nextValueOffset?: number };
}

/**
 * 原始输入卡片：标签/类型/范围来自运行快照，媒体只显示固定素材引用。
 * 分页与「缩小片段」按钮的行为与运行详情一致，避免同一份数据在两处口径不同。
 */
export default function RunInputSnapshot({ inputs, userId, loading, onSlice, onMore }: {
  inputs: RunInputFieldShape[];
  userId: string;
  loading: boolean;
  onSlice: (input: RunInputFieldShape, offset: number, narrow?: boolean) => void;
  onMore?: () => void;
}) {
  return <>
    {inputs.map(input => {
      const page = input.valuePage;
      return <article key={input.key} className="business-input">
        <header>
          <div>
            <h4>{input.label}</h4>
            <small>{input.key} · {input.type}{input.required ? " · 必填" : ""}{input.present ? "" : " · 未填写"}</small>
          </div>
          <span className="run-input-tag">原始输入</span>
        </header>
        {input.valueOmitted
          ? <div className="run-omitted"><p>片段超过响应预算，值未返回。</p><button className="button button-outline" disabled={loading} onClick={() => onSlice(input, page.offset, true)}>缩小片段读取</button></div>
          : <RunValueView value={input.present ? input.value : undefined} type={input.type} mediaUserId={userId} className="business-value" />}
        {(page.hasMore || page.offset > 0) && <footer className="run-value-pager">
          <span>{page.kind === "string" ? "字符" : page.kind === "object" ? "键" : "项"} {page.offset + 1}–{page.offset + page.count} / {page.total}</span>
          <button className="run-icon-button" disabled={loading || !page.offset} onClick={() => onSlice(input, previousValueOffset(page, 2000))}><ChevronLeft size={14} />上一段</button>
          <button className="run-icon-button" disabled={loading || !page.hasMore || input.valueOmitted} onClick={() => onSlice(input, page.nextValueOffset ?? 0)}>下一段<ChevronRight size={14} /></button>
        </footer>}
      </article>;
    })}
    {onMore && <button className="button button-outline" disabled={loading} onClick={onMore}>加载更多输入字段</button>}
  </>;
}
