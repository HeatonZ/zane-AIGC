import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("新客户端不开放素材库：媒体输入只有上传，没有素材库入口或选择器", async () => {
  const [mediaInput, portal, accessApi] = await Promise.all([
    "src/components/UserMediaInput.tsx", "src/features/UserPortal.tsx", "src/lib/accessApi.ts",
  ].map(path => readFile(path, "utf8")));
  for (const text of [mediaInput, portal]) {
    assert.doesNotMatch(text, /我的素材库/);
    assert.doesNotMatch(text, /从(自己的)?素材库选择/);
  }
  // 选择器组件与它的数据源一并移除，避免留下死代码或半开的入口。
  assert.doesNotMatch(mediaInput, /OwnAssetPicker|listOwnAssets|user-asset-picker/);
  assert.doesNotMatch(portal, /onSelect=\{reference/);
  assert.doesNotMatch(accessApi, /listOwnAssets/);
  // 上传仍然保留：媒体输入的唯一入口。
  assert.match(mediaInput, /type="file" accept=\{acceptByKind\[kind\]\} multiple=\{multiple\}/);
  assert.match(mediaInput, /上传文件/);
});
