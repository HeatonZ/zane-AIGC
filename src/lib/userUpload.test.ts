import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { mediaKindByType, mediaKindLabel, uploadFailureMessage, uploadedBatchNotice, uploadedInput } from "./userPortal";

test("字段类型决定素材类型，批量提示不吞掉单个文件", () => {
  assert.equal(mediaKindByType("image"), "image");
  assert.equal(mediaKindByType("image_list"), "image");
  assert.equal(mediaKindByType("images"), "image");
  assert.equal(mediaKindByType("video"), "video");
  assert.equal(mediaKindByType("voice_reference_audio"), "audio");
  assert.equal(mediaKindLabel(mediaKindByType("images")), "图片");
  assert.equal(mediaKindLabel(mediaKindByType("videos")), "视频");
  assert.equal(mediaKindLabel(mediaKindByType("audios")), "音频");
  assert.equal(uploadedBatchNotice(1, "图片"), "媒体已上传并添加到任务输入");
  assert.equal(uploadedBatchNotice(4, "图片"), "已上传 4 个图片并添加到任务输入");
  assert.equal(uploadFailureMessage([], "图片"), "");
  assert.equal(uploadFailureMessage(["上传被拒绝 素材ID：a"], "图片"), "上传被拒绝 素材ID：a");
  assert.equal(uploadFailureMessage(["第一张失败 素材ID：a", "第二张失败 素材ID：b"], "图片"), "有 2 个图片上传失败：第一张失败 素材ID：a；第二张失败 素材ID：b");
});

test("一次多选后逐个上传，按选择顺序合并引用且不覆盖列表字段", () => {
  const first = { assetId: "first", assetVersion: 1 }, second = { assetId: "second", assetVersion: 2 };
  const batch = [first, second].reduce<unknown>((current, reference) => uploadedInput(current, "images", reference), undefined);
  assert.deepEqual(batch, [first, second]);
  assert.deepEqual(uploadedInput(batch, "images", second), [first, second, second]);
  assert.deepEqual(uploadedInput("", "image", first), first);
});

test("客户端上传入口支持一次多选，批次进度与回执对账不丢文件", async () => {
  const [mediaInput, portal, studio] = await Promise.all([
    "src/components/UserMediaInput.tsx", "src/features/UserPortal.tsx", "src/features/Studio.tsx",
  ].map(path => readFile(path, "utf8")));
  assert.match(mediaInput, /type="file" accept=\{acceptByKind\[kind\]\} multiple=\{multiple\}/);
  assert.match(mediaInput, /const files = Array\.from\(event\.target\.files \?\? \[\]\)/);
  assert.match(mediaInput, /onUpload: \(files: File\[\]\)/);
  assert.match(mediaInput, /uploadProgress\?: \{ completed: number; total: number \}/);
  assert.match(mediaInput, /Math\.min\(uploadProgress\.completed \+ 1, uploadProgress\.total\)/);
  assert.match(portal, /async function upload\(key: string, type: string, files: File\[\]\)/);
  assert.match(portal, /onUpload=\{files => void upload\(field\.key, field\.type, files\)\}/);
  assert.match(portal, /pending\.push\(\{ id, key, type, sceneId: scene\.sceneId \}\)/);
  assert.match(portal, /setUploadUnknown\(current => \[\.\.\.current, \.\.\.pending\]\)/);
  assert.match(portal, /setUploadUnknown\(remaining\)/);
  assert.match(studio, /type="file" accept="image\/\*" multiple/);
  assert.match(studio, /for \(const file of files\)/);
  assert.match(studio, /onPickImage=\{\(files\) => void addImage\(field\.key, files\)\}/);
});
