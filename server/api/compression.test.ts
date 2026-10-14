import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCompressionMiddleware, chooseEncoding, appendVary } from "./compression.js";

/**
 * GET without any client-side decompression, so the byte count is the real wire
 * size. `fetch` always decodes gzip/br, which would make a compression assertion
 * compare the decompressed length with itself.
 */
function rawGet(url: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const parts: Buffer[] = [];
      response.on("data", (part: Buffer) => parts.push(part));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers as Record<string, string>,
        body: Buffer.concat(parts),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

/** Boot an app with the middleware and return its base URL plus a close fn. */
async function boot(configure: (app: express.Express) => void) {
  const app = express();
  app.use(createCompressionMiddleware({ thresholdBytes: 1024 }));
  configure(app);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("压缩：JSON 大响应按 Accept-Encoding 压缩，并声明 Vary", async () => {
  const big = { rows: Array.from({ length: 400 }, (_, i) => ({ id: i, name: "第 " + i + " 项", note: "重复内容用于可压缩性" })) };
  const h = await boot((app) => { app.get("/big", (_req, res) => res.json(big)); });
  try {
    // `fetch` transparently decompresses, so the wire size must be read from the
    // raw socket rather than from response.arrayBuffer().
    const raw = (headers: Record<string, string>) => rawGet(h.base + "/big", headers);
    const identity = await raw({ "Accept-Encoding": "identity" });
    assert.equal(identity.headers["content-encoding"], undefined);
    assert.equal(identity.headers.vary, "Accept-Encoding");

    const gzipped = await raw({ "Accept-Encoding": "gzip" });
    assert.equal(gzipped.headers["content-encoding"], "gzip");
    assert.equal(gzipped.headers.vary, "Accept-Encoding");
    assert.ok(gzipped.body.length < identity.body.length / 3, `gzip ${gzipped.body.length} 应远小于 ${identity.body.length}`);

    const brotli = await raw({ "Accept-Encoding": "gzip, br" });
    assert.equal(brotli.headers["content-encoding"], "br");
    assert.ok(brotli.body.length < identity.body.length / 3);

    // And the decoded bodies must still be identical to the original.
    const decoded = await fetch(h.base + "/big", { headers: { "Accept-Encoding": "gzip" } });
    assert.deepEqual(await decoded.json(), big);
  } finally { await h.close(); }
});

test("压缩：低于阈值不压缩，但仍声明 Vary", async () => {
  const h = await boot((app) => { app.get("/small", (_req, res) => res.json({ ok: true })); });
  try {
    const response = await fetch(h.base + "/small", { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(response.headers.get("content-encoding"), null, "小响应不应压缩");
    assert.equal(response.headers.get("vary"), "Accept-Encoding");
    assert.deepEqual(await response.json(), { ok: true });
  } finally { await h.close(); }
});

test("压缩：客户端未提供 Accept-Encoding 时不压缩", async () => {
  const big = { rows: Array.from({ length: 400 }, (_, i) => ({ id: i, text: "内容".repeat(4) })) };
  const h = await boot((app) => { app.get("/big", (_req, res) => res.json(big)); });
  try {
    const response = await fetch(h.base + "/big", { headers: { "Accept-Encoding": "" } });
    assert.equal(response.headers.get("content-encoding"), null);
    assert.deepEqual(await response.json(), big);
  } finally { await h.close(); }
});

test("压缩：q=0 明确拒绝时不得压缩", async () => {
  const big = { rows: Array.from({ length: 400 }, (_, i) => ({ id: i, text: "内容".repeat(4) })) };
  const h = await boot((app) => { app.get("/big", (_req, res) => res.json(big)); });
  try {
    const response = await fetch(h.base + "/big", { headers: { "Accept-Encoding": "gzip;q=0, br;q=0" } });
    assert.equal(response.headers.get("content-encoding"), null);
  } finally { await h.close(); }
});

test("压缩：媒体二进制与 SSE 流原样通过，不被缓冲或改写", async () => {
  const payload = Buffer.alloc(200_000, 0x42);
  const h = await boot((app) => {
    app.get("/media", (_req, res) => {
      res.set("Content-Type", "video/mp4");
      res.set("Content-Length", String(payload.length));
      res.end(payload);
    });
    app.get("/sse", (_req, res) => {
      res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" });
      res.flushHeaders();
      res.write("data: one\n\n");
      res.write("data: two\n\n");
      res.end();
    });
  });
  try {
    const media = await fetch(h.base + "/media", { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(media.headers.get("content-encoding"), null, "二进制媒体不得压缩");
    assert.equal(media.headers.get("vary"), null, "非文本类型无需声明 Vary");
    assert.equal(Buffer.from(await media.arrayBuffer()).length, payload.length);

    const sse = await fetch(h.base + "/sse", { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(sse.headers.get("content-encoding"), null, "SSE 不得压缩");
    assert.equal(await sse.text(), "data: one\n\ndata: two\n\n");
  } finally { await h.close(); }
});

test("压缩：Content-Range 部分响应不得压缩", async () => {
  const payload = Buffer.alloc(100_000, 0x43);
  const h = await boot((app) => {
    app.get("/ranged", (_req, res) => {
      res.status(206);
      res.set("Content-Type", "video/mp4");
      res.set("Content-Range", `bytes 0-${payload.length - 1}/${payload.length * 2}`);
      res.set("Accept-Ranges", "bytes");
      res.end(payload);
    });
  });
  try {
    const response = await fetch(h.base + "/ranged", { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(response.headers.get("content-encoding"), null, "部分响应不得压缩");
    assert.equal(response.headers.get("content-range"), `bytes 0-${payload.length - 1}/${payload.length * 2}`);
  } finally { await h.close(); }
});

test("压缩：no-transform 指令被尊重；HEAD 不改写", async () => {
  const big = { rows: Array.from({ length: 400 }, (_, i) => ({ id: i, text: "内容".repeat(4) })) };
  const h = await boot((app) => {
    app.get("/no-transform", (_req, res) => { res.set("Cache-Control", "no-cache, no-transform"); res.json(big); });
    app.get("/head", (_req, res) => { res.set("Content-Type", "application/json"); res.end(JSON.stringify(big)); });
  });
  try {
    const frozen = await fetch(h.base + "/no-transform", { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(frozen.headers.get("content-encoding"), null, "no-transform 必须阻止压缩");

    const head = await fetch(h.base + "/head", { method: "HEAD", headers: { "Accept-Encoding": "gzip" } });
    assert.equal(head.headers.get("content-encoding"), null);
  } finally { await h.close(); }
});

test("压缩：非 2xx 响应不压缩", async () => {
  const h = await boot((app) => {
    app.get("/fail", (_req, res) => { res.status(500).json({ error: "x".repeat(5000) }); });
  });
  try {
    const response = await fetch(h.base + "/fail", { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("content-encoding"), null);
  } finally { await h.close(); }
});

test("压缩：分段 write 的文本响应同样压缩，且内容完整", async () => {
  const chunk = "分段写入的内容，用于验证流式压缩不丢字节。\n";
  const h = await boot((app) => {
    app.get("/chunked", (_req, res) => {
      res.set("Content-Type", "text/plain; charset=utf-8");
      for (let i = 0; i < 200; i++) res.write(chunk);
      res.end();
    });
  });
  try {
    const response = await fetch(h.base + "/chunked", { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(response.headers.get("content-encoding"), "gzip");
    assert.equal(await response.text(), chunk.repeat(200));
  } finally { await h.close(); }
});

test("压缩：sendFile 流式响应不得被缓冲（大文本文件也必须完成）", async () => {
  // Regression: `res.sendFile` writes the file in chunks with Content-Length
  // already set. Buffering it held the whole file and never completed, so a
  // request for a large HTML page hung forever when the client accepted gzip.
  const dir = mkdtempSync(path.join(tmpdir(), "zane-sendfile-"));
  const page = path.join(dir, "page.html");
  const html = "<!doctype html><p>" + "内容".repeat(20_000) + "</p>";
  writeFileSync(page, html);
  const h = await boot((app) => {
    app.get("/page", (_req, res) => res.sendFile(page, { dotfiles: "allow", cacheControl: false, etag: true, lastModified: true }));
  });
  try {
    const response = await fetch(h.base + "/page", { headers: { "Accept-Encoding": "gzip" }, signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), null, "流式文件不应压缩");
    assert.equal(await response.text(), html, "内容必须完整");
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("压缩：协商解析与 Vary 追加是纯函数且大小写不敏感", () => {
  assert.equal(chooseEncoding("gzip"), "gzip");
  assert.equal(chooseEncoding("br"), "br");
  assert.equal(chooseEncoding("gzip, br"), "br");
  assert.equal(chooseEncoding("gzip;q=0.5, br;q=0.9"), "br");
  assert.equal(chooseEncoding("gzip;q=0, br;q=0"), null);
  assert.equal(chooseEncoding("identity"), null);
  assert.equal(chooseEncoding(""), null);
  assert.equal(chooseEncoding("deflate, *;q=0.1"), "br", "通配符允许 br");
  assert.equal(appendVary(undefined, "Accept-Encoding"), "Accept-Encoding");
  assert.equal(appendVary("Origin", "Accept-Encoding"), "Origin, Accept-Encoding");
  assert.equal(appendVary("origin, accept-encoding", "Accept-Encoding"), "origin, accept-encoding");
  assert.equal(appendVary("Accept-Encoding", "Accept-Encoding"), "Accept-Encoding");
});
