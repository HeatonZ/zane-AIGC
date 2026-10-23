import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync, gzipSync } from "node:zlib";
import { buildStaticAssetIndex, createStaticAssetMiddleware, isImmutableAsset } from "./staticAssets.js";
import { temporaryDirectory } from "../testing/testSupport.js";

/**
 * Raw HTTP so `Content-Encoding` is observable: `fetch` decompresses
 * transparently and would compare a decoded body against itself.
 */
function rawGet(url: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers, method }, (response) => {
      const parts: Buffer[] = [];
      response.on("data", (part: Buffer) => parts.push(part));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers as Record<string, string>, body: Buffer.concat(parts) }));
    });
    request.on("error", reject);
    request.end();
  });
}

const bundle = `console.log(${JSON.stringify("打包体积用于验证预压缩分发".repeat(80))});`;

/** A release directory shaped like `vite build` output plus its precompressed variants. */
async function release(t: Parameters<typeof temporaryDirectory>[0]) {
  const root = await temporaryDirectory(t);
  const dist = path.join(root, "dist");
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), "<!doctype html><div id=root></div>");
  const asset = path.join(dist, "assets", "app-abc123.js");
  await writeFile(asset, bundle);
  await writeFile(asset + ".br", brotliCompressSync(bundle));
  await writeFile(asset + ".gz", gzipSync(bundle));
  // A plain file with no variant, to prove the middleware falls through.
  await writeFile(path.join(dist, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  const app = express();
  app.use(createStaticAssetMiddleware(await buildStaticAssetIndex(dist)));
  app.use(express.static(dist, {
    index: false,
    setHeaders: (response, filename) => {
      if (isImmutableAsset(path.relative(dist, filename))) response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${port}`, dist };
}

test("预压缩静态资源：按 Accept-Encoding 发送 br/gz 变体，未压缩客户端拿到原始字节", async t => {
  const h = await release(t);
  const identity = await rawGet(h.base + "/assets/app-abc123.js", { "Accept-Encoding": "identity" });
  assert.equal(identity.status, 200);
  assert.equal(identity.headers["content-encoding"], undefined);
  assert.equal(identity.body.toString("utf8"), bundle);
  assert.equal(identity.headers["cache-control"], "public, max-age=31536000, immutable");

  const brotli = await rawGet(h.base + "/assets/app-abc123.js", { "Accept-Encoding": "gzip, br" });
  assert.equal(brotli.headers["content-encoding"], "br");
  assert.equal(brotli.headers["content-type"], "text/javascript; charset=utf-8");
  assert.match(brotli.headers.vary, /Accept-Encoding/);
  assert.ok(brotli.body.length < identity.body.length / 2, `br ${brotli.body.length} 应远小于 ${identity.body.length}`);

  const gzipped = await rawGet(h.base + "/assets/app-abc123.js", { "Accept-Encoding": "gzip" });
  assert.equal(gzipped.headers["content-encoding"], "gzip");
  assert.ok(gzipped.body.length < identity.body.length / 2);
});

test("预压缩静态资源：q=0 拒绝、HEAD 不压缩、Range 回落到原始字节", async t => {
  const h = await release(t);
  const refused = await rawGet(h.base + "/assets/app-abc123.js", { "Accept-Encoding": "br;q=0, gzip;q=0" });
  assert.equal(refused.headers["content-encoding"], undefined);
  assert.equal(refused.body.toString("utf8"), bundle);

  const head = await rawGet(h.base + "/assets/app-abc123.js", { "Accept-Encoding": "br" }, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0, "HEAD 不发送正文");

  const ranged = await rawGet(h.base + "/assets/app-abc123.js", { "Accept-Encoding": "br", Range: "bytes=0-9" });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers["content-encoding"], undefined);
  assert.equal(ranged.body.toString("utf8"), bundle.slice(0, 10));
});

test("预压缩静态资源：条件请求仍可 304，且无变体文件不被接管", async t => {
  const h = await release(t);
  const first = await rawGet(h.base + "/assets/app-abc123.js", { "Accept-Encoding": "br" });
  const etag = first.headers.etag;
  assert.ok(etag);
  const revalidated = await rawGet(h.base + "/assets/app-abc123.js", { "Accept-Encoding": "br", "If-None-Match": etag });
  assert.equal(revalidated.status, 304);

  const plain = await rawGet(h.base + "/favicon.svg", { "Accept-Encoding": "br" });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.headers["cache-control"], "public, max-age=0", "非 assets/ 目录保留默认重验证缓存策略");

  const missing = await rawGet(h.base + "/assets/app-abc123.js.map", { "Accept-Encoding": "br" });
  assert.equal(missing.status, 404);
});

test("预压缩静态资源：编码选择与目录穿越不会越界", async t => {
  const h = await release(t);
  for (const attempt of ["/assets/../assets/app-abc123.js", "/assets/%2e%2e/assets/app-abc123.js", "/../app-abc123.js"]) {
    const response = await rawGet(h.base + attempt, { "Accept-Encoding": "br" });
    assert.ok(response.status === 200 || response.status === 404, `${attempt} -> ${response.status}`);
    if (response.status !== 200) continue;
    // 归一化后命中同一个打包文件是允许的；正文必须仍是它，且从不指向目录外。
    const decoded = response.headers["content-encoding"] === "br" ? brotliDecompressSync(response.body).toString("utf8") : response.body.toString("utf8");
    assert.equal(decoded, bundle, attempt);
  }
  const index = await buildStaticAssetIndex(h.dist);
  assert.equal(index.get("assets/app-abc123.js")?.br !== undefined, true);
  assert.equal(index.get("favicon.svg"), undefined);
});

test("预压缩静态资源：变体路径保留 Express 的默认重验证缓存", async t => {
  const root = await temporaryDirectory(t);
  const dist = path.join(root, "dist");
  await mkdir(dist, { recursive: true });
  const svg = "<svg xmlns='http://www.w3.org/2000/svg'>" + "x".repeat(2048) + "</svg>";
  await writeFile(path.join(dist, "logo.svg"), svg);
  await writeFile(path.join(dist, "logo.svg.br"), brotliCompressSync(svg));
  const app = express();
  app.use(createStaticAssetMiddleware(await buildStaticAssetIndex(dist)));
  app.use(express.static(dist, { index: false }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const response = await rawGet(`http://127.0.0.1:${port}/logo.svg`, { "Accept-Encoding": "br" });
  assert.equal(response.headers["content-encoding"], "br");
  assert.equal(response.headers["content-type"], "image/svg+xml");
  // 走变体路径会绕过 express.static，因此这里必须显式给出与它一致的默认值，
  // 否则浏览器会启用启发式缓存，把旧文件长期钉住。
  assert.equal(response.headers["cache-control"], "public, max-age=0");
});
