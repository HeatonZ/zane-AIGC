import type { ReactNode } from "react";
import type { AssetSource } from "../../server/domain/productionContracts";
import type { JsonValue } from "../types";
import { isRunMediaRecord, runOutputMediaItems } from "../lib/runMedia";
import { isProtectedMediaUrl, ProtectedMediaPreview, type UserMediaKind } from "./UserMediaInput";

const keyLabels: Record<string, string> = {
  assetId: "素材 ID", assetVersion: "素材版本", assetName: "素材名称", filename: "文件名", file: "文件",
  name: "名称", title: "标题", description: "说明", status: "状态", url: "地址", source: "来源",
  prompt: "提示词", text: "文本", content: "内容", value: "值", type: "类型", id: "ID",
  index: "序号", duration: "时长", durationMs: "时长（毫秒）", width: "宽度", height: "高度",
  createdAt: "创建时间", updatedAt: "更新时间", error: "错误", warnings: "提示", items: "项目",
  runId: "运行 ID", sourceRunId: "来源运行 ID", sceneId: "场景 ID", versionId: "发布版本 ID", stepId: "步骤 ID",
  outputKey: "输出字段", reviewId: "确认 ID", message: "消息", action: "操作", at: "时间", feedback: "反馈",
  outputs: "输出", originalOutputs: "原始输出", editedOutputs: "修改后输出",
};

function labelForKey(key: string) {
  return keyLabels[key] ?? key.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll(/[_.-]+/g, " ");
}

function parseJsonString(value: unknown, type?: string): unknown {
  if (type !== "json" || typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function isMediaType(type?: string) {
  return /^(image|video|audio)(_list)?$/.test(type ?? "");
}

function MediaValue({ value, type, source, mediaUserId }: { value: unknown; type?: string; source?: Omit<AssetSource, "mediaIndex">; mediaUserId?: string }): ReactNode {
  const media = runOutputMediaItems(value as JsonValue, isMediaType(type) ? type : undefined, source);
  if (!media.length) return isMediaType(type) ? <span className="run-value-empty">暂无可预览媒体</span> : null;
  return <div className="run-value-media">{media.map((item, index) => <figure key={`${item.url}:${item.mediaIndex}:${index}`}>
    {isProtectedMediaUrl(item.url) ? <ProtectedMediaPreview url={item.url} kind={(item.isVideo ? "video" : item.isAudio ? "audio" : "image") as UserMediaKind} userId={mediaUserId} label={item.filename || `${item.isVideo ? "视频" : item.isAudio ? "音频" : "图片"} ${index + 1}`} />
      : item.isVideo ? <video src={item.url} controls preload="metadata" aria-label={item.filename || `视频 ${index + 1}`} /> : item.isAudio ? <audio src={item.url} controls preload="metadata" aria-label={item.filename || `音频 ${index + 1}`} /> : <a href={item.url} target="_blank" rel="noreferrer"><img src={item.url} alt={item.filename || `图片 ${index + 1}`} loading="lazy" /></a>}
    {item.filename && <figcaption>{item.filename}</figcaption>}
  </figure>)}</div>;
}

function scalar(value: unknown): ReactNode {
  if (value === undefined) return "未提供";
  if (value === null) return "空值";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string") return <span className="run-value-text">{value}</span>;
  if (typeof value === "number") return String(value);
  return String(value);
}

function ValueNode({ value, depth = 0, source, mediaUserId }: { value: unknown; depth?: number; source?: Omit<AssetSource, "mediaIndex">; mediaUserId?: string }): ReactNode {
  if (isRunMediaRecord(value as JsonValue) || (typeof value === "string" && runOutputMediaItems(value, undefined, source).length > 0)) {
    return <MediaValue value={value as JsonValue} source={source} mediaUserId={mediaUserId} />;
  }
  if (Array.isArray(value)) {
    if (!value.length) return <span className="run-value-empty">暂无项目</span>;
    return <div className="run-value-array">
      <small className="run-value-count">共 {value.length} 项</small>
      <ol>{value.map((item, index) => <li key={index}><ValueNode value={item} depth={depth + 1} source={source} mediaUserId={mediaUserId} /></li>)}</ol>
    </div>;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return <span className="run-value-empty">暂无字段</span>;
    return <dl className={`run-value-object${depth ? " nested" : ""}`}>
      {entries.map(([key, item]) => <div key={key}><dt>{labelForKey(key)}</dt><dd><ValueNode value={item} depth={depth + 1} source={source} mediaUserId={mediaUserId} /></dd></div>)}
    </dl>;
  }
  return scalar(value);
}

/** Render structured run data as labeled fields and lists instead of a JSON dump. */
export default function RunValueView({ value, type, source, mediaUserId, className = "" }: { value: unknown; type?: string; source?: Omit<AssetSource, "mediaIndex">; mediaUserId?: string; className?: string }) {
  const parsed = parseJsonString(value, type);
  if (isMediaType(type)) return <div className={`run-value-view${className ? ` ${className}` : ""}`}><MediaValue value={parsed as JsonValue} type={type} source={source} mediaUserId={mediaUserId} /></div>;
  return <div className={`run-value-view${className ? ` ${className}` : ""}`}><ValueNode value={parsed} source={source} mediaUserId={mediaUserId} /></div>;
}
