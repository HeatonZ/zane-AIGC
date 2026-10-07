import type { AssetSummary, AssetPage, AssetEnvelope, AssetVersionPage, AssetVersionEnvelope } from "../../server/domain/assetLibraryContracts";
export class InvalidAssetResponse extends Error { constructor() { super("后台素材库契约不兼容或回执不完整，请正常升级工作台；写入可能已完成，应先按原ID对账。"); } }
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
function summary(value: AssetSummary | undefined) {
  return value && typeof value.id === "string" && positive(value.revision) && positive(value.currentVersion) && positive(value.versionCount) && value.versionsOmitted === true && typeof value.description === "string" && typeof value.name === "string" && ["image", "video", "audio"].includes(value.kind) && typeof value.group === "string" && Array.isArray(value.tags);
}
function pagination(value: { total: number; hasMore: boolean; nextCursor?: string }, count: number) {
  return Number.isSafeInteger(value.total) && value.total >= count && typeof value.hasMore === "boolean" && (!value.hasMore || typeof value.nextCursor === "string" && value.nextCursor.length > 0);
}
export function readAssetPage(value: AssetPage) {
  if (!value || value.schemaVersion !== 1 || typeof value.catalogRevision !== "string" || !Array.isArray(value.assets) || !value.assets.every(summary) || !pagination(value, value.assets.length)) throw new InvalidAssetResponse();
  return value;
}
export function readAssetMutation<T extends { asset: AssetSummary }>(value: T) { if (!value || !summary(value.asset)) throw new InvalidAssetResponse(); return value; }
export function readAssetEnvelope(value: AssetEnvelope) { readAssetMutation(value); if (!value.reference || value.reference.assetId !== value.asset.id || value.reference.assetVersion !== value.asset.currentVersion) throw new InvalidAssetResponse(); return value; }
export function readAssetVersionPage(value: AssetVersionPage) {
  if (!value || value.schemaVersion !== 1 || !positive(value.revision) || !Array.isArray(value.versions) || !pagination(value, value.versions.length) || value.versions.some(version => !positive(version.version) || !version.reference || version.reference.assetId !== value.assetId || version.reference.assetVersion !== version.version)) throw new InvalidAssetResponse();
  return value;
}
export function readAssetVersion(value: AssetVersionEnvelope) {
  if (!value || !positive(value.revision) || !value.version || !positive(value.version.version) || !value.version.reference || value.version.reference.assetId !== value.assetId || value.version.reference.assetVersion !== value.version.version) throw new InvalidAssetResponse();
  const part = value.parameters;
  if (part && (part.encoding !== "json" || typeof part.text !== "string" || !Number.isSafeInteger(part.offset) || part.offset < 0 || !Number.isSafeInteger(part.totalChars) || part.totalChars < part.offset + part.text.length || typeof part.hasMore !== "boolean" || (part.hasMore ? part.nextOffset !== part.offset + part.text.length || part.nextOffset >= part.totalChars : part.offset + part.text.length !== part.totalChars))) throw new InvalidAssetResponse();
  return value;
}
