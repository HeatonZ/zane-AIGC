import assert from "node:assert/strict";
import test from "node:test";
import { mediaPreviewUrl } from "./mediaPreview";

const run = "0ddc0fdf-92e5-4d6f-add3-524e7ee22d02";
const asset = "5dbea32a-7caf-47a3-a2fb-c15b58088790";

test("预览地址映射：素材、归档运行与 output-media 换成缩放派生地址", () => {
  assert.equal(mediaPreviewUrl(`/api/v1/assets/${asset}/versions/3/media`, "image"), `/api/v1/assets/${asset}/versions/3/preview?w=512`);
  assert.equal(mediaPreviewUrl(`/api/v1/assets/${asset}/versions/3/media`, "image", 256), `/api/v1/assets/${asset}/versions/3/preview?w=256`);
  assert.equal(mediaPreviewUrl(`/api/v1/runs/${run}/media/shot.png`, "image"), `/api/v1/runs/${run}/media/shot.png/preview?w=512`);
  assert.equal(mediaPreviewUrl(`/api/workflows/runs/${run}/media/shot.png`, "image"), `/api/workflows/runs/${run}/media/shot.png/preview?w=512`);
  assert.equal(mediaPreviewUrl(`/api/v1/runs/${run}/output-media?outputKey=images&mediaIndex=2`, "image"), `/api/v1/runs/${run}/output-media?outputKey=images&mediaIndex=2&w=512`);
  assert.equal(mediaPreviewUrl(`/api/v1/runs/${run}/output-media?mediaIndex=2&outputKey=images`, "image", 64), `/api/v1/runs/${run}/output-media?mediaIndex=2&outputKey=images&w=64`);
});

test("预览地址映射：视频、音频与非工作台地址保持原样", () => {
  for (const kind of ["video", "audio"] as const) {
    assert.equal(mediaPreviewUrl(`/api/v1/runs/${run}/media/clip.mp4`, kind), `/api/v1/runs/${run}/media/clip.mp4`);
    assert.equal(mediaPreviewUrl(`/api/v1/assets/${asset}/versions/1/media`, kind), `/api/v1/assets/${asset}/versions/1/media`);
    assert.equal(mediaPreviewUrl(`/api/v1/runs/${run}/output-media?outputKey=video`, kind), `/api/v1/runs/${run}/output-media?outputKey=video`);
  }
  for (const url of ["https://example.com/hero.png", "data:image/png;base64,AAAA", "blob:https://studio.local/1", "/api/comfyui/view?filename=a.png"]) assert.equal(mediaPreviewUrl(url, "image"), url);
});
