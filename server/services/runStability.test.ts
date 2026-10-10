import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, unlink, stat, readdir } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { harness, workflow, submission, until, deferred, id } from "../testing/testSupport.js";
import { runArtifactPaths } from "../artifacts/runArtifacts.js";
import { externalizeRuntimeValue } from "../domain/workflowValues.js";
import type { ExecutionContext, PreparedRun } from "../execution/workflowExecutor.js";
import { RunService } from "./runService.js";
import { HttpError } from "../errors.js";
import { productionHarness } from "../testing/productionSupport.js";
import { businessRunInputs } from "./runDetailService.js";
import { runInputQuery } from "../ai/accessSchemas.js";

test("取消收尾中的任务不能被迟到的完成结果覆盖", async t => {
  const gate = deferred<void>(); let entered = false;
  const h = await harness(t, { async execute(prepared) {
    entered = true; await gate.promise;
    return { runId: prepared.runId, status: "completed", startedAt: prepared.createdAt,
      finishedAt: new Date().toISOString(), steps: [], outputs: [], artifacts: prepared.artifacts };
  } });
  await h.service.start(); await h.service.submit(submission(id("cancel-finalization")));
  await until(() => entered);
  await h.service.cancel(h.settings.projectDirectory, id("cancel-finalization"));
  gate.resolve();
  const result = await h.service.wait(h.settings.projectDirectory, id("cancel-finalization"));
  assert.equal(result.status, "cancelled");
  assert.match(result.cancellationReason!, /取消/);
  assert.equal(h.store.events(h.settings.projectDirectory, result.runId).some(event => event.type === "run.completed"), false);
  assert.equal(JSON.parse(await readFile(result.artifacts.runtime, "utf8")).status, "cancelled");
});

test("任务结束后迟到的进度回调不能把状态倒退为 running", async t => {
  let checkpoint: ExecutionContext["checkpoint"] | undefined;
  const h = await harness(t, { async execute(prepared, context) {
    checkpoint = context.checkpoint;
    return { runId: prepared.runId, status: "completed", startedAt: prepared.createdAt,
      finishedAt: new Date().toISOString(), steps: [], outputs: [], artifacts: prepared.artifacts };
  } });
  await h.service.start(); await h.service.submit(submission(id("late-checkpoint")));
  const result = await h.service.wait(h.settings.projectDirectory, id("late-checkpoint"));
  await until(() => h.service.metrics().active === 0);
  const sequence = h.store.latestSequence(h.settings.projectDirectory, result.runId);
  await checkpoint!({ steps: [{ stepId: "first", name: "迟到进度", status: "running" }] });
  assert.equal(h.store.getRun(h.settings.projectDirectory, result.runId)?.status, "completed");
  assert.equal(h.store.latestSequence(h.settings.projectDirectory, result.runId), sequence);
});

test("排队任务执行归档输入，不依赖已删除或改写的原素材", async t => {
  const h = await harness(t, { executor: { kind: "fake", async execute({ inputValues }) {
    const [filename] = externalizeRuntimeValue(inputValues.picture) as string[];
    return { value: await readFile(filename, "utf8") };
  } } });
  const original = path.join(h.root, "reference.png"); await writeFile(original, "original image");
  const definition = workflow(); definition.inputs = [{ key: "picture", type: "image_list", required: true }];
  const queued = await h.service.submit(submission(id("durable-input"), definition, { picture: original }));
  assert.notEqual((queued.inputValues.picture as string[])[0], original);
  await unlink(original); await h.service.start();
  const result = await h.service.wait(h.settings.projectDirectory, queued.runId);
  assert.equal(result.status, "completed"); assert.equal(result.outputs[0].value, "original image");
});

test("服务重开后排队任务仍使用已保存的输入素材", async t => {
  const h = await harness(t, { executor: { kind: "fake", async execute({ inputValues }) {
    const [filename] = externalizeRuntimeValue(inputValues.picture) as string[];
    return { value: await readFile(filename, "utf8") };
  } } });
  const original = path.join(h.root, "reference.png"); await writeFile(original, "saved image");
  const definition = workflow(); definition.inputs = [{ key: "picture", type: "image_list", required: true }];
  const queued = await h.service.submit(submission(id("recovered-input"), definition, { picture: original }));
  await h.service.shutdown(0); await unlink(original);
  const recovered = new RunService({ store: h.store, executors: h.executors, loadSettings: async () => h.settings });
  h.service.shutdown = timeout => recovered.shutdown(timeout); await recovered.start();
  const result = await recovered.wait(h.settings.projectDirectory, queued.runId);
  assert.equal(result.status, "completed"); assert.equal(result.outputs[0].value, "saved image");
});

test("本地输入媒体缺失在排队前拒绝，不遗留伪 queued 目录", async t => {
  const h = await harness(t); const definition = workflow();
  definition.inputs = [{ key: "picture", type: "image_list", required: true }];
  const runId = id("missing-local-input");
  await assert.rejects(h.service.submit(submission(runId, definition, { picture: path.join(h.root, "missing.png") })),
    error => error instanceof HttpError && error.status === 400 && error.code === "INPUT_MEDIA_UNAVAILABLE");
  assert.equal(h.store.getRun(h.settings.projectDirectory, runId), undefined);
  assert.equal(await stat(runArtifactPaths(h.settings.projectDirectory, runId).directory).catch(() => undefined), undefined);
});

test("数据库提交失败会撤销本次准备目录，同一运行 ID 可以安全重试", async t => {
  const h = await harness(t); const runId = id("retry-uncommitted-preparation");
  const create = h.store.createRun.bind(h.store); let fail = true;
  h.store.createRun = (...args) => { if (fail) throw new Error("database temporarily unavailable"); return create(...args); };
  await assert.rejects(h.service.submit(submission(runId)), /database temporarily unavailable/);
  assert.equal(h.store.getRun(h.settings.projectDirectory, runId), undefined);
  assert.equal(await stat(runArtifactPaths(h.settings.projectDirectory, runId).directory).catch(() => undefined), undefined);
  assert.equal((await h.service.listRuns(h.settings.projectDirectory)).runs.length, 0);
  fail = false; await h.service.start(); await h.service.submit(submission(runId));
  assert.equal((await h.service.wait(h.settings.projectDirectory, runId)).status, "completed");
});

test("真实 HTTP 归档流中取消任务会断开上游，不等待下载超时或重复生成", async t => {
  let reading = false, disconnected = false, generated = 0;
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "video/mp4" }); response.write("partial video"); reading = true;
    const interval = setInterval(() => response.write("more video"), 20);
    response.once("close", () => { disconnected = true; clearInterval(interval); });
  }).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => upstream.once("listening", resolve));
  t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  const h = await harness(t, { executor: { kind: "fake", async execute() {
    ++generated; return { value: [{ filename: "slow.mp4", subfolder: "", type: "output", url: "/api/comfyui/view?filename=slow.mp4" }] };
  } } });
  h.settings.comfyuiBaseUrl = "http://127.0.0.1:" + (upstream.address() as { port: number }).port;
  const definition = workflow(); definition.steps[0].outputs![0].type = "video_list"; definition.outputs[0].type = "video_list";
  await h.service.start(); const run = await h.service.submit(submission(id("http-archive-cancellation"), definition));
  await until(() => reading); const cancelledAt = Date.now(); await h.service.cancel(h.settings.projectDirectory, run.runId);
  const result = await h.service.wait(h.settings.projectDirectory, run.runId);
  assert.equal(result.status, "cancelled"); assert.ok(Date.now() - cancelledAt < 5000);
  await until(() => disconnected); assert.equal(generated, 1);
  assert.deepEqual(await readdir(path.join(run.artifacts.directory, "outputs", "media")).catch(() => []), []);
});

test("旧版排队快照仍引用原文件时，重启优先恢复已归档的本地输入", async t => {
  const h = await harness(t, { executor: { kind: "fake", async execute({ inputValues }) {
    const [filename] = externalizeRuntimeValue(inputValues.picture) as string[];
    return { value: await readFile(filename, "utf8") };
  } } });
  const original = path.join(h.root, "legacy.png"); await writeFile(original, "legacy archived image");
  const definition = workflow(); definition.inputs = [{ key: "picture", type: "image_list", required: true }];
  const run = await h.service.submit(submission(id("legacy-queued-input"), definition, { picture: original }));
  const prepared = h.store.getSubmission(h.settings.projectDirectory, run.runId) as PreparedRun;
  prepared.inputValues.picture = [original];
  h.store.saveRunSubmission(h.settings.projectDirectory, run, prepared, []);
  await h.service.shutdown(0); await unlink(original);
  const recovered = new RunService({ store: h.store, executors: h.executors, loadSettings: async () => h.settings });
  h.service.shutdown = timeout => recovered.shutdown(timeout); await recovered.start();
  const result = await recovered.wait(h.settings.projectDirectory, run.runId);
  assert.equal(result.status, "completed"); assert.equal(result.outputs[0].value, "legacy archived image");
});

test("单个排队任务的输入归档损坏不阻止服务启动或其他任务恢复", async t => {
  const h = await harness(t); const broken = await h.service.submit(submission(id("broken-input-snapshot")));
  const good = await h.service.submit(submission(id("healthy-queued-after-broken")));
  await writeFile(broken.artifacts.inputs, "{broken JSON"); await h.service.shutdown(0);
  const recovered = new RunService({ store: h.store, executors: h.executors, loadSettings: async () => h.settings });
  h.service.shutdown = timeout => recovered.shutdown(timeout); await recovered.start();
  const damaged = await recovered.getRun(h.settings.projectDirectory, broken.runId);
  assert.equal(damaged?.status, "stale"); assert.match(damaged?.error ?? "", /输入归档/);
  assert.equal((await recovered.wait(h.settings.projectDirectory, good.runId)).status, "completed");
});

test("局部重做与断点续跑保留输入快照里的固定素材引用", async t => {
  const h = await productionHarness(t);
  const asset = await h.assets.save({ name: "主角", kind: "image", category: "character" }, { bytes: Buffer.from("hero image"), filename: "hero.png" });
  const definition = workflow([{ id: "first", name: "第一步", kind: "fake", inputs: [], outputs: [{ key: "value", type: "text" }] }]);
  definition.inputs = [{ key: "prompt", type: "text", required: true }, { key: "images", type: "image_list", required: true }];
  await h.service.start();
  const local = path.join(h.root, "reference.png"); await writeFile(local, "local image");
  // A mixed list keeps the pinned asset reference and the plain local path side by side.
  const source = await h.service.submit(submission(id("revision-input-source"), definition, { prompt: "原始提示词", images: [asset.reference, local] } as never));
  const original = await h.service.wait(h.settings.projectDirectory, source.runId);
  const pinned = (original.inputValues.images as Array<Record<string, unknown>>)[0];
  assert.equal(pinned.assetId, asset.asset.id); assert.equal(pinned.assetVersion, 1);
  const revisedId = id("revision-input-revised");
  await h.service.submit({ workflow: original.workflow, inputValues: original.inputValues, runId: revisedId, rerunFromRunId: original.runId, rerunRequest: { rerunSteps: [{ stepId: "first" }] } });
  const revised = await h.service.wait(h.settings.projectDirectory, revisedId);
  const revisedPin = (revised.inputValues.images as Array<Record<string, unknown>>)[0];
  assert.equal(revisedPin.assetId, pinned.assetId); assert.equal(revisedPin.assetVersion, pinned.assetVersion);
  assert.equal(revisedPin.assetName, pinned.assetName);
  assert.equal((revised.inputValues.images as unknown[])[1], String((original.inputValues.images as unknown[])[1]).replace(original.artifacts.directory, revised.artifacts.directory));
  // The revision re-archives its own copy instead of trusting the ancestor file or the original source.
  assert.notEqual(revisedPin.path, pinned.path);
  assert.ok(String(revisedPin.path).startsWith(revised.artifacts.directory));
  assert.equal(await readFile(String(revisedPin.path), "utf8"), "hero image");
  h.store.saveRun(h.settings.projectDirectory, { ...revised, status: "failed", finishedAt: new Date().toISOString(), error: "模拟失败", outputs: [], steps: [] }, []);
  const resumedId = id("revision-input-resumed");
  await h.service.submit({ workflow: revised.workflow, inputValues: revised.inputValues, runId: resumedId, resumeFromRunId: revised.runId });
  const resumed = await h.service.wait(h.settings.projectDirectory, resumedId);
  assert.equal((resumed.inputValues.images as Array<Record<string, unknown>>)[0].assetId, pinned.assetId);
  assert.equal((resumed.inputValues.images as unknown[])[1], String((revised.inputValues.images as unknown[])[1]).replace(revised.artifacts.directory, resumed.artifacts.directory));
  // The user-facing input snapshot keeps the pinned reference; internal paths stay omitted.
  const projection = businessRunInputs(resumed, runInputQuery.parse({}));
  const images = projection.inputs.find(field => field.key === "images")!;
  assert.deepEqual(images.value, [{ assetId: pinned.assetId, assetVersion: 1, assetName: "主角" }, { locatorOmitted: true }]);
  assert.equal(images.present, true);
  assert.equal(projection.inputs.find(field => field.key === "prompt")!.value, "原始提示词");
});

test("多文件媒体输入在局部重做与断点续跑中都指向本运行的归档副本", async t => {
  const h = await productionHarness(t);
  const definition = workflow([{ id: "first", name: "第一步", kind: "fake", inputs: [], outputs: [{ key: "value", type: "text" }] }]);
  definition.inputs = [{ key: "prompt", type: "text", required: true }, { key: "images", type: "image_list", required: true }];
  await h.service.start();
  const first = path.join(h.root, "first.png"); await writeFile(first, "first image");
  const second = path.join(h.root, "second.png"); await writeFile(second, "second image");
  const source = await h.service.submit(submission(id("multi-file-input-source"), definition, { prompt: "原始提示词", images: [first, second] } as never));
  const original = await h.service.wait(h.settings.projectDirectory, source.runId);
  // Older records kept the caller's plain locators in the snapshot while the copies already
  // sat in inputs/files; a stale locator must not leave a position unrestored.
  h.store.saveRun(h.settings.projectDirectory, { ...original, inputValues: { ...original.inputValues, images: [first, second] } as never }, []);
  const submissionSnapshot = h.store.getSubmission(h.settings.projectDirectory, source.runId) as PreparedRun;
  submissionSnapshot.inputValues.images = [first, second] as never;
  h.store.saveRunSubmission(h.settings.projectDirectory, h.store.getRun(h.settings.projectDirectory, source.runId)!, submissionSnapshot, []);
  await unlink(first); await unlink(second);
  const revisedId = id("multi-file-input-revised");
  await h.service.submit({ workflow: h.store.getRun(h.settings.projectDirectory, source.runId)!.workflow, inputValues: h.store.getRun(h.settings.projectDirectory, source.runId)!.inputValues, runId: revisedId, rerunFromRunId: source.runId, rerunRequest: { rerunSteps: [{ stepId: "first" }] } } as never);
  const revised = await h.service.wait(h.settings.projectDirectory, revisedId);
  assert.equal(revised.status, "completed", revised.error);
  assert.equal(revised.inputValues.prompt, "原始提示词");
  const revisedImages = revised.inputValues.images as string[];
  assert.equal(revisedImages.length, 2);
  for (const [index, contents] of ["first image", "second image"].entries()) {
    assert.equal(await readFile(revisedImages[index], "utf8"), contents);
    assert.ok(revisedImages[index].startsWith(revised.artifacts.directory));
  }
  // A resume of the revision keeps both positions and re-archives them under its own directory.
  h.store.saveRun(h.settings.projectDirectory, { ...revised, status: "failed", finishedAt: new Date().toISOString(), error: "模拟失败", outputs: [], steps: [] }, []);
  const resumedId = id("multi-file-input-resumed");
  await h.service.submit({ workflow: revised.workflow, inputValues: revised.inputValues, runId: resumedId, resumeFromRunId: revised.runId });
  const resumed = await h.service.wait(h.settings.projectDirectory, resumedId);
  assert.equal(resumed.status, "completed", resumed.error);
  const resumedImages = resumed.inputValues.images as string[];
  assert.equal(await readFile(resumedImages[0], "utf8"), "first image");
  assert.equal(await readFile(resumedImages[1], "utf8"), "second image");
  assert.ok(resumedImages.every(filename => filename.startsWith(resumed.artifacts.directory)));
  // An explicit override still wins over the restored archive.
  const replacement = path.join(h.root, "replacement.png"); await writeFile(replacement, "replacement image");
  const overriddenId = id("multi-file-input-overridden");
  await h.service.submit({ workflow: revised.workflow, inputValues: revised.inputValues, runId: overriddenId, rerunFromRunId: revised.runId, rerunRequest: { inputOverrides: { images: [replacement] }, rerunSteps: [{ stepId: "first" }] } } as never);
  const overridden = await h.service.wait(h.settings.projectDirectory, overriddenId);
  assert.equal(overridden.status, "completed", overridden.error);
  assert.equal(await readFile((overridden.inputValues.images as string[])[0], "utf8"), "replacement image");
});
