import type { AssetRecord, AssetReference, AssetKind, AssetCategory } from "../../server/domain/productionContracts";
export const categoryLabels: Record<AssetCategory, string> = { character: "角色", scene: "场景", prop: "道具", voice: "音色", material: "普通素材" };
export const kindLabels: Record<AssetKind, string> = { image: "图片", video: "视频", audio: "音频" };
export const assetPreview = (id: string, version: number) => "/api/v1/assets/" + id + "/versions/" + version + "/media";
export const assetReference = (asset: Pick<AssetRecord, "id" | "name" | "currentVersion">, version = asset.currentVersion): AssetReference => ({ assetId: asset.id, assetVersion: version, assetName: asset.name, previewUrl: assetPreview(asset.id, version) });
