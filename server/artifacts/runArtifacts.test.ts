import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFile, readdir, stat, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { archiveOutputMedia, prepareRunArtifacts, runArtifactPaths } from "./runArtifacts.js";
import { harness, id, workflow, until } from "../testing/testSupport.js";
import { externalizeRuntimeValue } from "../domain/workflowValues.js";
import type { JsonValue } from "../domain/types.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const media = { filename: "clip.mp4", subfolder: "", type: "output", url: "/api/comfyui/view?filename=clip.mp4" };

test("输出归档流式写入，不调用 arrayBuffer 整文件缓冲", async t => {
  const h = await harness(t); const runId = id("streaming-archive");
  globalThis.fetch = (async () => {
    const response = new Response("video bytes", { headers: { "Content-Type": "video/mp4" } });
    response.arrayBuffer = async () => { throw new Error("整文件缓冲被禁用"); };
    return response;
  }) as typeof fetch;
  const paths = runArtifactPaths(h.settings.projectDirectory, runId); const warnings: string[] = [];
  const result = await archiveOutputMedia(media, runId, paths, "http://upstream", new Map(), warnings) as Record<string, JsonValue>;
  assert.deepEqual(warnings, []); assert.ok(result.file);
  assert.equal(await readFile(path.join(paths.directory, String(result.file)), "utf8"), "video bytes");
});

test("同一媒体并发归档只下载一次，多个输出共享完整文件", async t => {
  const h = await harness(t); const runId = id("coalesced-archive"); let downloads = 0;
  globalThis.fetch = (async () => {
    ++downloads; await new Promise(resolve => setTimeout(resolve, 20)); return new Response("one complete video");
  }) as typeof fetch;
  const paths = runArtifactPaths(h.settings.projectDirectory, runId); const warnings: string[] = [];
  const result = await archiveOutputMedia([media, media, media], runId, paths, "http://upstream", new Map(), warnings) as Array<Record<string, JsonValue>>;
  assert.equal(downloads, 1); assert.deepEqual(result[0], result[1]); assert.deepEqual(warnings, []);
  assert.equal(await readFile(path.join(paths.directory, String(result[0].file)), "utf8"), "one complete video");
});

test("复用祖先归档输出不重新读取上游同名文件", async t => {
  const h = await harness(t); const runId = id("preserve-ancestor"); let downloads = 0;
  const existing = { ...media, file: "outputs/media/old.mp4", url: "/api/workflows/runs/" + id("ancestor") + "/media/old.mp4" };
  globalThis.fetch = (async () => { ++downloads; return new Response("wrong newly generated video"); }) as typeof fetch;
  const result = await archiveOutputMedia(existing, runId, runArtifactPaths(h.settings.projectDirectory, runId), "http://upstream", new Map(), []);
  assert.deepEqual(result, existing); assert.equal(downloads, 0);
});

test("批量媒体归档限制并发，不同时打开全部下载", async t => {
  const h = await harness(t); const runId = id("bounded-archive"); let active = 0, maximum = 0;
  globalThis.fetch = (async () => {
    ++active; maximum = Math.max(maximum, active);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      setTimeout(() => { controller.enqueue(new TextEncoder().encode("video")); controller.close(); --active; }, 25);
    } }));
  }) as typeof fetch;
  const clips = Array.from({ length: 8 }, (_, index) => ({ ...media, filename: "clip-" + index + ".mp4" }));
  const warnings: string[] = [];
  await archiveOutputMedia(clips, runId, runArtifactPaths(h.settings.projectDirectory, runId), "http://upstream", new Map(), warnings);
  assert.ok(maximum <= 2, "下载并发峰值：" + maximum); assert.deepEqual(warnings, []);
});

test("归档中途失败不发布半文件，也不污染缓存，后续可重试", async t => {
  const h = await harness(t); const runId = id("interrupted-archive"); let fail = true;
  globalThis.fetch = (async () => fail ? new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode("partial")); controller.error(new Error("upstream disconnected"));
  } })) : new Response("complete video")) as typeof fetch;
  const paths = runArtifactPaths(h.settings.projectDirectory, runId); const cache = new Map<string, JsonValue>(); const warnings: string[] = [];
  assert.deepEqual(await archiveOutputMedia(media, runId, paths, "http://upstream", cache, warnings), media);
  assert.equal(cache.size, 0); assert.equal(warnings.length, 1);
  assert.deepEqual(await readdir(path.join(paths.directory, "outputs", "media")).catch(() => []), []);
  fail = false;
  const result = await archiveOutputMedia(media, runId, paths, "http://upstream", cache, warnings) as Record<string, JsonValue>;
  assert.equal(await readFile(path.join(paths.directory, String(result.file)), "utf8"), "complete video");
  assert.equal(cache.size, 1);
});

test("取消归档释放活动流并移除等待下载，不留半文件或取消警告", async t => {
  const h = await harness(t); const runId = id("cancel-archive"); let downloads = 0, released = 0;
  globalThis.fetch = (async () => {
    ++downloads;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("partial")); },
      cancel() { ++released; },
    }));
  }) as typeof fetch;
  const controller = new AbortController(); const paths = runArtifactPaths(h.settings.projectDirectory, runId);
  const cache = new Map<string, JsonValue>(), warnings: string[] = [];
  const clips = Array.from({ length: 5 }, (_, index) => ({ ...media, filename: "cancel-" + index + ".mp4" }));
  const saving = archiveOutputMedia(clips, runId, paths, "http://upstream", cache, warnings, controller.signal);
  await until(() => downloads === 2); controller.abort("user cancelled");
  assert.deepEqual(await saving, clips); assert.equal(downloads, 2); assert.equal(released, 2);
  assert.deepEqual(warnings, []); assert.equal(cache.size, 0);
  assert.deepEqual(await readdir(path.join(paths.directory, "outputs", "media")).catch(() => []), []);
});

test("超限或空输出不发布成有效归档", async t => {
  const h = await harness(t); const runId = id("invalid-archive-body"); const paths = runArtifactPaths(h.settings.projectDirectory, runId);
  for (const response of [new Response("too big", { headers: { "Content-Length": "2000000001" } }), new Response("")]) {
    globalThis.fetch = (async () => response) as typeof fetch;
    const warnings: string[] = [];
    assert.deepEqual(await archiveOutputMedia(media, runId, paths, "http://upstream", new Map(), warnings), media);
    assert.equal(warnings.length, 1);
    assert.deepEqual(await readdir(path.join(paths.directory, "outputs", "media")).catch(() => []), []);
  }
});

test("失败的重复归档不截断已经发布的完整文件", async t => {
  const h = await harness(t); const runId = id("preserve-complete-file"); const paths = runArtifactPaths(h.settings.projectDirectory, runId);
  globalThis.fetch = (async () => new Response("complete original")) as typeof fetch;
  const saved = await archiveOutputMedia(media, runId, paths, "http://upstream", new Map(), []) as Record<string, JsonValue>;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode("partial overwrite"));
    setTimeout(() => controller.error(new Error("download failed")), 10);
  } }))) as typeof fetch;
  const warnings: string[] = [];
  assert.deepEqual(await archiveOutputMedia(media, runId, paths, "http://upstream", new Map(), warnings), media);
  assert.equal(await readFile(path.join(paths.directory, String(saved.file)), "utf8"), "complete original");
  assert.equal(warnings.length, 1);
  assert.equal((await readdir(path.join(paths.directory, "outputs", "media"))).length, 1);
});

test("输入字段文件名清洗后重名也不会覆盖彼此的素材", async t => {
  const h = await harness(t); const definition = workflow();
  definition.inputs = [{ key: "a.b", type: "image_list" }, { key: "a_b", type: "image_list" }];
  const first = path.join(h.root, "first.png"), second = path.join(h.root, "second.png");
  await writeFile(first, "first image"); await writeFile(second, "second image");
  const values: Record<string, JsonValue> = { "a.b": first, a_b: second };
  const paths = await prepareRunArtifacts(h.settings, id("input-name-collision"), definition, values, new Date().toISOString());
  const saved = externalizeRuntimeValue(values) as Record<string, string[]>;
  assert.notEqual(saved["a.b"][0], saved.a_b[0]);
  assert.equal(await readFile(saved["a.b"][0], "utf8"), "first image");
  assert.equal(await readFile(saved.a_b[0], "utf8"), "second image");
  assert.equal((JSON.parse(await readFile(paths.inputs, "utf8")).files as unknown[]).length, 2);
});

test("准备相同运行 ID 时不覆盖或清理已有归档", async t => {
  const h = await harness(t); const runId = id("preserve-owned-archive");
  const paths = await prepareRunArtifacts(h.settings, runId, workflow(), {}, new Date().toISOString());
  const before = await readFile(paths.runtime, "utf8");
  await assert.rejects(prepareRunArtifacts(h.settings, runId, workflow(), {}, new Date().toISOString()), error => error instanceof Error && /已存在/.test(error.message));
  assert.equal(await readFile(paths.runtime, "utf8"), before); assert.ok((await stat(paths.directory)).isDirectory());
});

test("文件系统拒绝归档时释放未消费的上游，修复目录后仍可重试", async t => {
  const h = await harness(t); const runId = id("archive-filesystem-failure");
  const paths = runArtifactPaths(h.settings.projectDirectory, runId); const directory = path.join(paths.directory, "outputs", "media");
  await mkdir(path.dirname(directory), { recursive: true }); await writeFile(directory, "not a directory");
  let released = false;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("waiting video")); },
    cancel() { released = true; },
  }))) as typeof fetch;
  const cache = new Map<string, JsonValue>(), warnings: string[] = [];
  assert.deepEqual(await archiveOutputMedia(media, runId, paths, "http://upstream", cache, warnings), media);
  assert.equal(released, true); assert.equal(cache.size, 0); assert.equal(warnings.length, 1);
  await unlink(directory); globalThis.fetch = (async () => new Response("recovered video")) as typeof fetch;
  const result = await archiveOutputMedia(media, runId, paths, "http://upstream", cache, warnings) as Record<string, JsonValue>;
  assert.equal(await readFile(path.join(paths.directory, String(result.file)), "utf8"), "recovered video");
});

test("压缩传输的长度不误判为解压后媒体损坏", async t => {
  const h = await harness(t); const runId = id("encoded-media"); const paths = runArtifactPaths(h.settings.projectDirectory, runId);
  globalThis.fetch = (async () => new Response("decompressed media bytes", { headers: { "Content-Encoding": "gzip", "Content-Length": "10" } })) as typeof fetch;
  const warnings: string[] = [];
  const result = await archiveOutputMedia(media, runId, paths, "http://upstream", new Map(), warnings) as Record<string, JsonValue>;
  assert.deepEqual(warnings, []); assert.equal(await readFile(path.join(paths.directory, String(result.file)), "utf8"), "decompressed media bytes");
});
