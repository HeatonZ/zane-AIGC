import assert from "node:assert/strict";
import test from "node:test";
import { runMediaUrl, runOutputMediaItems } from "./runMedia";
test("手动替换的本地归档媒体通过运行媒体路由预览，外部路径不会误作 URL", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  const route = "/api/v1/runs/" + id + "/media/replacement-demo.mp4";
  assert.equal(runMediaUrl("C:\\project\\.zane\\runs\\" + id + "\\outputs\\media\\replacement-demo.mp4"), route);
  assert.equal(runMediaUrl("/project/.zane/runs/" + id + "/outputs/media/replacement-demo.mp4"), route);
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
