import { currentActorId } from "./accessApi";
export interface PendingAssetWrite { format: "zane-asset-outbox/v1"; actorId: string; operation: "upload" | "save" | "update"; assetId: string; createId?: string; baseRevision?: number; requestedAt: string }
const key = (actorId: string) => "zane-asset-outbox/v1:" + encodeURIComponent(actorId);
export function pendingAssetWrites(actorId = currentActorId): PendingAssetWrite[] {
  const raw = localStorage.getItem(key(actorId));
  if (!raw) return [];
  let items: unknown;
  try { items = JSON.parse(raw); } catch { throw new Error("素材防丢记录不是有效JSON，已保留原文；不会自动恢复、重放或清除。"); }
  if (!Array.isArray(items) || items.some(item => !item || item.format !== "zane-asset-outbox/v1" || item.actorId !== actorId || !["upload", "save", "update"].includes(item.operation) || typeof item.assetId !== "string" || typeof item.requestedAt !== "string" || (item.baseRevision !== undefined && (!Number.isSafeInteger(item.baseRevision) || item.baseRevision < 1)))) throw new Error("素材防丢记录无效，已保留原文；请先检查，不会自动重放或覆盖。");
  return items;
}
export function beginAssetWrite(operation: PendingAssetWrite["operation"], assetId: string, createId?: string, baseRevision?: number): PendingAssetWrite {
  if (baseRevision !== undefined && (!Number.isSafeInteger(baseRevision) || baseRevision < 1)) throw new Error("素材revision无效，未发送写入。");
  if (!currentActorId) throw new Error("登录身份未确认，未发送素材写入。");
  if (pendingAssetWrites().length) throw new Error("有素材写入回执尚未确认。请到素材库按原ID对账，不要重复上传/收藏。");
  const item: PendingAssetWrite = { format: "zane-asset-outbox/v1", actorId: currentActorId, operation, assetId, ...(createId ? { createId } : {}), ...(baseRevision !== undefined ? { baseRevision } : {}), requestedAt: new Date().toISOString() };
  localStorage.setItem(key(item.actorId), JSON.stringify([item]));
  window.dispatchEvent(new Event("zane-asset-outbox-changed"));
  return item;
}
export function clearAssetWrite(item: PendingAssetWrite) {
  const pending = pendingAssetWrites(item.actorId);
  const current = pending.find(value => value.assetId === item.assetId);
  if (current && (current.requestedAt !== item.requestedAt || current.operation !== item.operation)) throw new Error("素材对账记录已变化，未清除新的写入提示。");
  localStorage.setItem(key(item.actorId), JSON.stringify(pending.filter(value => value.assetId !== item.assetId)));
  window.dispatchEvent(new Event("zane-asset-outbox-changed"));
}
