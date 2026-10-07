import { workbenchFetch } from "./workbench-auth.mjs";
/** Live production workbench E2E using only test-owned media and non-AI capabilities. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

const { values } = parseArgs({ options: { "allow-local-write": { type: "boolean", default: false }, "base-url": { type: "string", default: "http://127.0.0.1:8799" }, "output-dir": { type: "string", default: ".local/production-e2e-workbench" }, "commerce-report": { type: "string" } } });
assert.ok(values["allow-local-write"], "Opt in with --allow-local-write; this creates tagged test runs/assets/selections, never AI jobs.");
assert.ok(values["commerce-report"], "Provide the JSON report for a successful test-owned commerce run.");
const commerce = JSON.parse(await readFile(path.resolve(values["commerce-report"]), "utf8"));
assert.ok(commerce.status === "passed" && commerce.noAi && commerce.title.startsWith("E2E-"));
const base = new URL(values["base-url"]);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) && !base.username && !base.password);
assert.equal(commerce.baseUrl, base.origin);
const output = path.resolve(values["output-dir"]); await mkdir(output, { recursive: true });
const tag = "E2E-生产工作台-" + randomUUID().slice(0, 8);
const ownRuns = [], checks = [];
const request = async (route, body, method = body === undefined ? "GET" : "POST") => {
  const url = new URL(route, base); assert.equal(url.origin, base.origin);
  return workbenchFetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
};
const json = async (route, body, method) => { const r = await request(route, body, method); assert.ok(r.ok, `${route}: ${r.status} ${await r.clone().text()}`); return r.json(); };
const conflict = async (route, body, method) => { const r = await request(route, body, method); assert.equal(r.status, 409, `${route} must reject stale edits`); };
const settled = async (id) => { const deadline = Date.now() + 40000; while (Date.now() < deadline) { const r = await json("/api/v1/runs/" + id); if (!["queued", "running", "cancelling"].includes(r.status)) return r; await new Promise((resolve) => setTimeout(resolve, 100)); } throw Error("Timed out: " + id); };
const submit = async (workflow, inputValues, suffix) => {
  assert.ok(workflow.steps.every((s) => (s.kind === "manual" && !s.capabilityId) || (s.kind === "capability" && ["text.template", "media.video_concat"].includes(s.capabilityId))), "Generative capabilities are prohibited");
  const id = randomUUID(); ownRuns.push(id); await json("/api/v1/runs", { runId: id, runTitle: tag + "-" + suffix, workflow, inputValues }); return id;
};
const report = { schemaVersion: 1, baseUrl: base.origin, startedAt: new Date().toISOString(), noAi: true, tag, ownRuns, checks };
try {
  const source = await json("/api/v1/runs/" + commerce.runId); assert.equal(source.runTitle, commerce.title); assert.equal(source.status, "completed");
  const metadata = { name: tag + "-测试杯", category: "material", tags: ["E2E", "synthetic-test"] };
  const first = await json("/api/v1/assets", { ...metadata, source: { runId: commerce.runId, outputKey: "images", mediaIndex: 0 } });
  report.assetId = first.asset.id; assert.equal(first.asset.currentVersion, 1);
  const media = await request(`/api/v1/assets/${first.asset.id}/versions/1/media`);
  assert.equal(media.status, 200); const originalHash = createHash("sha256").update(Buffer.from(await media.arrayBuffer())).digest("hex");
  const second = await json("/api/v1/assets", { ...metadata, assetId: first.asset.id, revision: first.asset.revision, source: { runId: commerce.runId, outputKey: "images", mediaIndex: 3 } });
  assert.equal(second.asset.currentVersion, 2); assert.equal(second.asset.versions.length, 2);
  const fixed = await request(`/api/v1/assets/${first.asset.id}/versions/1/media`); assert.equal(createHash("sha256").update(Buffer.from(await fixed.arrayBuffer())).digest("hex"), originalHash);
  checks.push("素材归档、v2 新版本、v1 固定引用内容不漂移");
  const range = await workbenchFetch(new URL(`/api/v1/assets/${first.asset.id}/versions/1/media`, base), { headers: { Range: "bytes=0-31" }, signal: AbortSignal.timeout(5000) }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
  await conflict("/api/v1/assets/" + first.asset.id, { revision: first.asset.revision, name: "stale" }, "PATCH");
  checks.push("素材 Range 下载、过期 revision 409（不覆盖新版本）");
  const textWorkflow = {
    sceneId: "e2e_production_workbench", name: tag + "-人工确认", inputs: [{ key: "text", type: "text", required: true }],
    steps: [
      { id: "draft", name: "测试初稿", kind: "capability", capabilityId: "text.template", capabilityConfig: { template: "初稿：{{text}}" }, inputs: [{ key: "text", sourceRef: "input.text" }], outputs: [{ key: "text", type: "text" }], review: { enabled: true, instruction: "E2E 合成内容，请审核后继续" } },
      { id: "publish", name: "测试发布", kind: "capability", capabilityId: "text.template", capabilityConfig: { template: "发布：{{text}}" }, inputs: [{ key: "text", sourceRef: "step.draft.outputs.text" }], outputs: [{ key: "text", type: "text" }] },
    ], outputs: [{ key: "result", type: "text", sourceRef: "step.publish.outputs.text" }],
  };
  const reviewId = await submit(textWorkflow, { text: "合成测试文案" }, "人工确认"); report.reviewRunId = reviewId;
  const waiting = await settled(reviewId); assert.equal(waiting.status, "waiting"); assert.ok(!waiting.steps.some((s) => s.stepId === "publish"));
  checks.push("人工关卡等待，发布下游不提前执行");
  await json(`/api/v1/runs/${reviewId}/review`, { reviewId: waiting.pendingReview.id, action: "redo", stepChanges: { capabilityConfig: { template: "重做：{{text}}" } } });
  const redone = await settled(reviewId); assert.equal(redone.status, "waiting"); assert.notEqual(redone.pendingReview.id, waiting.pendingReview.id); assert.equal(redone.steps[0].outputs.text, "重做：合成测试文案");
  await conflict(`/api/v1/runs/${reviewId}/review`, { reviewId: waiting.pendingReview.id, action: "approve" });
  checks.push("退回本步骤重做，新 reviewId 与旧确认 409");
  await json(`/api/v1/runs/${reviewId}/review`, { reviewId: redone.pendingReview.id, action: "approve", outputs: { text: "人工编辑后确认" } });
  const approved = await settled(reviewId); assert.equal(approved.status, "completed"); assert.equal(approved.outputs[0].value, "发布：人工编辑后确认");
  await conflict(`/api/v1/runs/${reviewId}/review`, { reviewId: redone.pendingReview.id, action: "approve" });
  checks.push("人工编辑后继续、确认历史保留、重复确认 409");
  const files = [];
  for (const [index, color] of ["red", "blue"].entries()) {
    const file = path.join(output, `synthetic-clip-${index + 1}.mp4`);
    await promisify(execFile)("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=320x240:r=24:d=0.6`, "-f", "lavfi", "-i", `sine=frequency=${440 + index * 220}:sample_rate=24000:duration=0.6`, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file], { windowsHide: true, timeout: 15000 }); files.push(file);
  }
  const clipsWorkflow = { sceneId: "e2e_production_workbench", name: tag + "-逐镜测试", inputs: [{ key: "clips", type: "video_list", required: true }], steps: [{ id: "clips", name: "本地合成测试片段", kind: "manual", execution: { mode: "for_each", sourceRef: "input.clips", onError: "stop" }, inputs: [{ key: "videos", sourceRef: "iteration.item" }], outputs: [{ key: "videos", type: "video_list" }] }], outputs: [{ key: "videos", type: "video_list", sourceRef: "step.clips.outputs.videos" }] };
  const clipsId = await submit(clipsWorkflow, { clips: files }, "逐镜片段"); report.clipsRunId = clipsId;
  const clips = await settled(clipsId); assert.equal(clips.status, "completed", clips.error); assert.equal(clips.steps[0].items.length, 2);
  const created = await json("/api/v1/clip-selections", { sourceRunId: clipsId, stepId: "clips", outputKey: "videos", name: tag + "-选片" });
  report.selectionId = created.selection.id; assert.equal(created.selection.shots.length, 2); assert.ok(created.selection.shots.every((shot) => shot.choice?.assetId && shot.choice?.assetVersion));
  checks.push("逐镜媒体运行、选片清单固定 2 个独立素材版本");
  const candidates = await json(`/api/v1/clip-selections/${created.selection.id}/candidates`); assert.equal(candidates.shots.length, 2); assert.ok(candidates.shots.every((shot) => shot.candidates.length === 1));
  const reordered = await json(`/api/v1/clip-selections/${created.selection.id}`, { revision: created.selection.revision, shotOrder: created.selection.shots.map((shot) => shot.shotId).reverse() }, "PATCH");
  await conflict(`/api/v1/clip-selections/${created.selection.id}/compose`, { revision: created.selection.revision });
  checks.push("候选镜头读取、调序保存、过期选片合成 409");
  const composition = await json(`/api/v1/clip-selections/${created.selection.id}/compose`, { revision: reordered.selection.revision }); ownRuns.push(composition.runId); report.composedRunId = composition.runId;
  const composed = await settled(composition.runId); assert.equal(composed.status, "completed", composed.error); assert.equal(composed.workflow.steps.length, 1); assert.equal(composed.workflow.steps[0].capabilityId, "media.video_concat");
  const video = composed.outputs.find((item) => /video/.test(item.type)); assert.ok(video);
  const findUrl = (v) => typeof v === "string" && v.startsWith("/api/") ? v : Array.isArray(v) ? v.map(findUrl).find(Boolean) : v && typeof v === "object" ? v.url ?? Object.values(v).map(findUrl).find(Boolean) : undefined;
  const preview = findUrl(video.value); assert.ok(preview, "Missing archived composition preview");
  const response = await request(preview); assert.equal(response.status, 200); const outputFile = path.join(output, "synthetic-composed.mp4"); await writeFile(outputFile, Buffer.from(await response.arrayBuffer()));
  const { stdout } = await promisify(execFile)("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,r_frame_rate", "-of", "json", outputFile], { windowsHide: true, timeout: 10000 });
  const probe = JSON.parse(stdout); assert.ok(Number(probe.format.duration) >= 1 && Number(probe.format.duration) < 2); assert.ok(probe.streams.some((s) => s.codec_type === "audio")); report.composedMedia = { preview, ...probe };
  checks.push("纯本地 FFmpeg 合成成功，MP4 可下载并保留声音，不调用生成步骤");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = error.message; process.exitCode = 1;
  for (const id of ownRuns) { const own = await json("/api/v1/runs/" + id).catch(() => undefined); if (own && ["queued", "running", "waiting", "cancelling"].includes(own.status)) await json(`/api/v1/runs/${id}/cancel`, {}).catch(() => {}); }
} finally {
  report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, "live-workbench.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
