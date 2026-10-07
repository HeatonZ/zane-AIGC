import test from "node:test";
import assert from "node:assert/strict";
import { assetReference, assetPreview } from "./production";
import { appendMediaInputValue, mediaInputLabel, mediaInputPreviewUrl, mediaListValues } from "./mediaInput";
import { createRuntimeMediaValue, runtimeMediaExternalValue } from "../../server/runtimeValue.js";
import type { AssetRecord } from "../../server/domain/productionContracts";
test("素材选择固定版本，混合上传/本地路径时保留顺序与预览名称",()=>{
  const asset={id:"asset",name:"角色",currentVersion:3} as AssetRecord;const ref=assetReference(asset,1);const value=appendMediaInputValue(JSON.stringify(["F:/existing.png"]),ref as unknown as Record<string,unknown>);const items=mediaListValues(value);assert.equal(items.length,2);assert.equal((items[1]as{assetVersion:number}).assetVersion,1);assert.equal(mediaInputLabel(items[1]),"角色");assert.equal(mediaInputPreviewUrl(items[1]),assetPreview("asset",1));assert.equal(asset.currentVersion,3);
});
test("素材引用穿过运行媒体契约仍保存身份、版本和本地读取路径",()=>{
  const ref={assetId:"asset",assetVersion:2,assetName:"场景",path:"F:/project/.zane/assets/blobs/scene.png",previewUrl:assetPreview("asset",2)};const runtime=createRuntimeMediaValue("image",[ref]);assert.equal(runtime.items[0].locator.type,"path");assert.equal(runtime.items[0].assetVersion,2);const external=runtimeMediaExternalValue(runtime) as Array<Record<string,unknown>>;assert.deepEqual(external,[ref]);assert.equal(Object.hasOwn(external[0],"filename"),false);
});
