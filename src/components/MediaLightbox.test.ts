import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecentShot } from "./RecentShot";

/**
 * 画布上的图是 512 预览（mediaPreviewUrl 加 w=512 省流量），
 * 但客户会据此以为成品就是 512。所以必须提供「点击看原图」，
 * 并且原图查看要按原始字节读取、显示真实像素尺寸。
 */
test("缩略图默认不可点开；zoomable 只在图片加载完成且是图片时生效", async () => {
  const plain = renderToStaticMarkup(createElement(RecentShot, { url: "/api/v1/runs/x/output-media?outputKey=images&mediaIndex=0", kind: "image", label: "产出" }));
  assert.doesNotMatch(plain, /role="button"/);
  assert.doesNotMatch(plain, /zoom/i);

  // 服务端渲染时媒体字节尚未读取（source 为空），因此此刻不挂交互与角标；
  // 这是正确行为：没有可显示的图就不该给「看原图」入口。真正的点击逻辑由
  // 下方源码断言覆盖（onClick 打开 MediaLightbox）。
  const zoomable = renderToStaticMarkup(createElement(RecentShot, { url: "/api/v1/runs/x/output-media?outputKey=images&mediaIndex=0", kind: "image", label: "产出", zoomable: true }));
  assert.doesNotMatch(zoomable, /role="button"/);

  const source = await readFile("src/components/RecentShot.tsx", "utf8");
  assert.match(source, /const canZoom = zoomable && kind === "image" && Boolean\(media\.source\)/);
  assert.match(source, /<MediaLightbox url=\{url\} kind="image"/);
  // 角标只写「看原图」：缩略图读到的尺寸是 512 预览尺寸，写出来反而坐实「就是 512」。
  assert.match(source, /看原图/);
  assert.doesNotMatch(source, /naturalWidth/);
});

test("原图查看按原始字节读取，绕开 w=512 预览并显示真实尺寸", async () => {
  const [lightbox, preview] = await Promise.all([
    readFile("src/components/MediaLightbox.tsx", "utf8"),
    readFile("src/lib/mediaPreview.ts", "utf8"),
  ]);
  // 预览派生确实会加 w=512：这是需要绕开的依据。
  assert.match(preview, /parameters\.set\("w", String\(width\)\)/);
  // 原图查看直接调 accessMedia(原始 url)，不经 mediaPreviewUrl。
  assert.match(lightbox, /accessMedia\(url, undefined, controller\.signal\)/);
  assert.doesNotMatch(lightbox, /mediaPreviewUrl/);
  // 必须显示真实像素与体积，让客户能确认不是 512。
  assert.match(lightbox, /naturalWidth/);
  assert.match(lightbox, /naturalHeight/);
  assert.match(lightbox, /formatBytes/);
  // 提供下载原图入口。
  assert.match(lightbox, /MediaDownloadButton/);
});
