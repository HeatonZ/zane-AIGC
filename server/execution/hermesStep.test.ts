import assert from "node:assert/strict";
import test from "node:test";
import { fetchMediaResponse, mimeTypeForMediaPath } from "./hermesStep.js";

test("媒体 MIME 推断：图像/视频扩展名与未知回退（Hermes 不接受音频）", () => {
  assert.equal(mimeTypeForMediaPath("a.png"), "image/png");
  assert.equal(mimeTypeForMediaPath("a.JPG"), "image/jpeg");
  assert.equal(mimeTypeForMediaPath("dir/b.webp"), "image/webp");
  assert.equal(mimeTypeForMediaPath("c.avif"), "image/avif");
  assert.equal(mimeTypeForMediaPath("clip.mp4"), "video/mp4");
  assert.equal(mimeTypeForMediaPath("clip.webm"), "video/webm");
  assert.equal(mimeTypeForMediaPath("noext"), "application/octet-stream");
  assert.equal(mimeTypeForMediaPath("x.unknown"), "application/octet-stream");
  assert.equal(mimeTypeForMediaPath("voice.wav"), "application/octet-stream", "音频扩展名不在 Hermes 附件映射内");
  assert.equal(mimeTypeForMediaPath("x.bin", "image/png"), "image/png", "调用方回退优先于未知扩展名");
});

test("媒体下载按声明上限拒绝，并在响应正常时返回字节与类型", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = (async () => new Response(Buffer.alloc(64), { status: 200, headers: { "content-type": "video/mp4" } })) as typeof fetch;
  const ok = await fetchMediaResponse("http://127.0.0.1/media.mp4", undefined, 1024);
  assert.equal(ok.bytes.length, 64);
  assert.equal(ok.contentType, "video/mp4");

  // 超出上限：content-length 声明即拒绝。
  globalThis.fetch = (async () => new Response(Buffer.alloc(4), { status: 200, headers: { "content-length": String(2048) } })) as typeof fetch;
  await assert.rejects(fetchMediaResponse("http://127.0.0.1/big.mp4", undefined, 1024), /超过/);

  // 无 content-length 但实际超限：读取后仍拒绝。
  globalThis.fetch = (async () => new Response(Buffer.alloc(2048), { status: 200 })) as typeof fetch;
  await assert.rejects(fetchMediaResponse("http://127.0.0.1/big2.mp4", undefined, 1024), /超过/);

  // 非 2xx 明确失败，不静默返回空媒体。
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  await assert.rejects(fetchMediaResponse("http://127.0.0.1/broken.mp4", undefined, 1024), /500/);
});
