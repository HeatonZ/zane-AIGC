import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createMediaRouter } from "./mediaRoutes.js";
import { harness, id, until } from "../testing/testSupport.js";
import { runArtifactPaths } from "../artifacts/runArtifacts.js";

test("归档视频流支持 HEAD 与 Range；上游 Range 透传", async (t) => {
  const { settings } = await harness(t);
  const directory = path.join(runArtifactPaths(settings.projectDirectory, id("video")).directory, "outputs", "media");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "clip.mp4"), "0123456789");
  let range = "";
  const upstream = http.createServer((request, response) => {
    range = request.headers.range ?? "";
    response.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": "bytes 2-4/10", "Content-Length": "3", "Accept-Ranges": "bytes" });
    response.end("234");
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => upstream.once("listening", resolve));
  t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  const app = express();
  app.use(createMediaRouter(async () => ({ ...settings, comfyuiBaseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` })));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const response = await fetch(`${base}/api/v1/runs/${id("video")}/media/clip.mp4`, { headers: { Range: "bytes=2-4" } });
  assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), "bytes 2-4/10"); assert.equal(await response.text(), "234");
  const head = await fetch(`${base}/api/v1/runs/${id("video")}/media/clip.mp4`, { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), "10"); assert.equal(await head.text(), "");
  const proxy = await fetch(`${base}/api/comfyui/view?filename=clip.mp4`, { headers: { Range: "bytes=2-4" } });
  assert.equal(proxy.status, 206); assert.equal(await proxy.text(), "234"); assert.equal(range, "bytes=2-4");
});

test("媒体客户端断开会释放上游流，但不涉及工作流任务", async (t) => {
  const { settings } = await harness(t);
  let disconnected = false;
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "video/mp4" }); response.write("start");
    const interval = setInterval(() => response.write("frame"), 20);
    response.once("close", () => { disconnected = true; clearInterval(interval); });
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => upstream.once("listening", resolve));
  t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  const app = express();
  app.use(createMediaRouter(async () => ({ ...settings, comfyuiBaseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` })));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/comfyui/view?filename=clip.mp4`, { signal: controller.signal });
  const reader = response.body!.getReader(); await reader.read(); controller.abort(); await reader.cancel().catch(() => undefined);
  await until(() => disconnected);
});
