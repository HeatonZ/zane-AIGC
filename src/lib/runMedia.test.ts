import assert from "node:assert/strict";
import test from "node:test";
import { isRunMediaRecord, runMediaUrl, runOutputMediaItems } from "./runMedia";
test("手动替换的本地归档媒体通过运行媒体路由预览，外部路径不会误作 URL", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  const route = "/api/v1/runs/" + id + "/media/replacement-demo.mp4";
  assert.equal(runMediaUrl("C:\\project\\.zane\\runs\\" + id + "\\outputs\\media\\replacement-demo.mp4"), route);
  assert.equal(runMediaUrl("/project/.zane/runs/" + id + "/outputs/media/replacement-demo.mp4"), route);
  assert.equal(runMediaUrl("/api/workflows/runs/" + id + "/media/replacement-demo.mp4"), route);
  assert.equal(runMediaUrl("C:\\other\\clip.mp4"), undefined);
  assert.equal(runMediaUrl("https://example.invalid/image.png"), "https://example.invalid/image.png");
  assert.equal(runMediaUrl(route), route);
});

test("收藏使用服务端扁平媒体索引，不随不可预览项过滤而错位", () => {
  const values = [null, "", ["F:/external/no-preview.png", "https://example.invalid/a.png"], { url: "https://example.invalid/b.png", filename: "b.png" }];
  const media = runOutputMediaItems(values, "image_list");
  assert.deepEqual(media.map(item => item.mediaIndex), [1, 2]);
  assert.deepEqual(media.map(item => item.url), ["https://example.invalid/a.png", "https://example.invalid/b.png"]);
});
test("固定版本资产对象和归档路径可以作为输出媒体预览，普通JSON不误渲染", () => {
  const asset = { assetId: "asset", assetVersion: 2, assetName: "主角", path: "F:/project/.zane/assets/blobs/a.png", previewUrl: "/api/v1/assets/asset/versions/2/media" };
  assert.deepEqual(runOutputMediaItems([asset], "image_list"), [{url: asset.previewUrl, filename: "主角", isVideo: false, isAudio: false, mediaIndex: 0}]);
  assert.equal(runOutputMediaItems({ url: "https://example.invalid/story", filename: "story" }, "json").length, 0);
  assert.equal(runOutputMediaItems({ url: "https://example.invalid/a.wav", filename: "a.wav" })[0].isAudio, true);
});

test("路径已脱敏且预览地址无扩展名时仍从固定素材名称识别媒体类型", () => {
  const assets = [
    { assetId: "image", assetVersion: 1, assetName: "E.jpg", path: "[内部路径已省略]", previewUrl: "/api/v1/assets/image/versions/1/media" },
    { assetId: "video", assetVersion: 2, assetName: "clip.mp4", path: "[内部路径已省略]", previewUrl: "/api/v1/assets/video/versions/2/media" },
    { assetId: "audio", assetVersion: 3, assetName: "voice.wav", path: "[内部路径已省略]", previewUrl: "/api/v1/assets/audio/versions/3/media" },
  ];
  assert.deepEqual(runOutputMediaItems(assets, "json").map(item => [item.filename, item.isVideo, item.isAudio]), [
    ["E.jpg", false, false], ["clip.mp4", true, false], ["voice.wav", false, true],
  ]);
});

test("已记录的非标准本地媒体通过来源路由预览并保留收藏索引", () => {
  const source = { runId: "12345678-1234-4234-8234-123456789abc", stepId: "video", itemIndex: 2, outputKey: "clips" };
  const items = runOutputMediaItems([{note: "不是媒体"}, "F:/external/video.mp4"], "video_list", source);
  assert.equal(items.length, 1);
  assert.equal(items[0].mediaIndex, 1);
  const url = new URL(items[0].url, "http://localhost");
  assert.equal(url.pathname, "/api/v1/runs/" + source.runId + "/output-media");
  assert.deepEqual(Object.fromEntries(url.searchParams), {outputKey: "clips", mediaIndex: "1", stepId: "video", itemIndex: "2"});
  assert.equal(items[0].isVideo, true);
});

test("通用JSON容器内任意层级的媒体通过运行授权地址直接展示，旧Comfy预览不抢优先级", () => {
  const runId = "12345678-1234-4234-8234-123456789abc";
  const source = { runId, stepId: "references", itemIndex: 3, outputKey: "bundle" };
  const image = {
    assetId: "asset-id", assetVersion: 1, assetName: "E.jpg", filename: "E.jpg",
    file: "outputs/media/E-abcd1234.jpg", path: "F:/project/.zane/assets/blobs/e.jpg",
    previewUrl: "http://127.0.0.1:8188/view?filename=E.jpg", url: `/api/workflows/runs/${runId}/media/E-abcd1234.jpg`,
  };
  const bundle = { images: [image], selected: { product_images: [image] }, audios: [], videos: [] };
  assert.equal(isRunMediaRecord(image), true);
  const media = runOutputMediaItems(bundle, "json", source);
  assert.equal(media.length, 2);
  assert.equal(media[0].url, `/api/v1/runs/${runId}/media/E-abcd1234.jpg`);
  assert.equal(media[1].url, `/api/v1/runs/${runId}/media/E-abcd1234.jpg`);
  assert.deepEqual(media.map(item => item.filename), ["E.jpg", "E.jpg"]);
  assert.ok(media.every(item => !item.isVideo && !item.isAudio));
});

test("通用JSON按媒体扩展名和MIME识别图片/视频/音频，不把普通字段误判为媒体", () => {
  const media = runOutputMediaItems({
    images: [{ filename: "cover.webp", url: "https://example.invalid/cover.webp" }],
    clips: [{ filename: "clip.mp4", previewUrl: "https://example.invalid/clip" }],
    sounds: [{ filename: "sound.bin", mimeType: "audio/wav", url: "https://example.invalid/sound" }],
    title: { filename: "draft" },
  });
  assert.deepEqual(media.map(item => [item.filename, item.isVideo, item.isAudio]), [
    ["cover.webp", false, false], ["clip.mp4", true, false], ["sound.bin", false, true],
  ]);
});
