import { workbenchFetch } from "./workbench-auth.mjs";
/** Opted-in real generation E2E. One published-workflow sample per scene, serial, no retries or publishing. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { publishedSnapshot, mediaReferences } from "./audit-production.mjs";
const execute = promisify(execFile);
const active = new Set(["queued", "running", "cancelling"]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function realCases(fixtureDirectory) {
  const cup = path.join(fixtureDirectory, "synthetic-cup.png");
  const actor = path.join(fixtureDirectory, "synthetic-actor.png");
  const voice = path.join(fixtureDirectory, "synthetic-speech.wav");
  const scene = path.join(fixtureDirectory, "synthetic-scene.png");
  const video = { thought: "端到端测试：浅灰色桌面上的一只无文字白色陶瓷杯，静态近景，柔和自然光，固定机位，一束光缓慢移过杯身。只有一个连续镜头，不要人物、字幕、转场或音乐。", time: 5, mp: 0.4, ratio: "1:1 (Square)" };
  return [
    { slug: "01-text-to-image", sceneId: "scene_bc9235eb-c72e-4a6f-acf3-0a6da7dfcefe", label: "AI文生图", expected: "image", inputs: { thought: "端到端测试素材：一只无文字的白色陶瓷杯放在浅灰色桌面上，窗边柔和自然光，居中静物摄影，背景干净。只需一张图，不要人物、文字或水印。", reference_images: [], ratio: "1:1 (Square)", mp: 0.4, denoise: 0.2, seed: 20261001 } },
    { slug: "02-image-to-image", sceneId: "image_to_image", label: "AI图生图", expected: "image", inputs: { reference_images: [cup], prompt: "保持参考图中白色陶瓷杯的形状、数量和居中构图，只把背景调整为柔和浅蓝色，真实静物摄影。不要增加文字、人物、其他物品。只生成一张图片。", ratio: "1:1 (Square)", seed: 20261001, steps: 12, mp: 0.4, empty: false } },
    { slug: "03-text-to-video", sceneId: "scene_8ea4173e-d278-4703-9bec-418498ace6ee", label: "AI文生视频", expected: "video", inputs: video },
    { slug: "04-yanyu", sceneId: "scene_4b7b159a-b66c-4a5c-8e44-38ab76a8e6b3", label: "颜域", expected: "video", inputs: { reference_images: [actor], ratio: "1:1 (Square)", mp: 0.4 } },
    { slug: "05-reference-video", sceneId: "scene_3a95a9cb-ed5e-468f-aac9-59b670b1f979", label: "AI参考生视频", expected: "video", inputs: { ...video, thought: "严格沿用参考图：画面只出现参考图中的白色陶瓷杯，保持杯身、把手和灰色背景。固定机位，一个5秒镜头，光线轻微移动，不增加其他物品、文字或人物。", references: [cup] } },
    { slug: "06-comfy-test", sceneId: "scene_f439f612-add5-4c8e-a22c-2e2f670ce417", label: "测试comfy", expected: "video", inputs: { content: "用于最小端到端测试的一段5秒剧情，必须只有一个镜头、一个分镜：无文字的白色陶瓷杯静静放在灰色桌面上，窗边阳光缓慢移过杯身。固定机位，无人物、无对白、无音乐、不切镜头。不扩写额外剧情，只输出一个5秒片段。", ratio: "1:1 (Square)", mp: 0.4, images: [cup] } },
    { slug: "07-video-no-design", sceneId: "scene_e3ef7b38-2c2c-4f0a-9ab4-ddc729ba67af", label: "AI文生视频无设计版", expected: "video", inputs: video },
    { slug: "08-h3-digital-human", sceneId: "scene_h3_long_video", label: "H3 数字人长视频", expected: "video", inputs: { audio: [voice], reference_images: [actor], aspect_ratio: "1:1 (Square)", megapixels: 0.4, mode: "speaking", material_note: "图1是原创合成卡通人物，不是真实人物。保持短黑发、青绿色上衣和服装造型，正面半身，背景简洁。音频是 Windows SAPI 生成的测试语音。", creative_guidance: "只做一个短测试片段。角色面向镜头自然说出原音频，固定机位，不要切镜、字幕、音乐或新增人物。" } },
    { slug: "09-long-text-video", sceneId: "scene_long_text_to_video", label: "长文出视频", expected: "video", inputs: { content: "原创卡通人物站在简洁浅灰背景前，对镜头微笑并说：\"测试开始。\"然后轻轻点头。到此结束。", character_assets: [actor], scene_assets: [scene], prop_assets: [], voice_reference_audio: [], asset_notes: "角色图片第1张为原创合成卡通人物，青绿色上衣、短黑发，不是真实人物；全片只有这一个人物。场景图片第1张是原创合成的简洁灰绿背景。没有道具/音色参考。", production_notes: "最小真实端到端测试，必须只生成一个分镜，index=1，seconds=5，characters=[1]，scenes=[1]，props=[]，voices=[]。固定机位正面半身，一个连续镜头，只说‘测试开始。’。不要新增剧情或镜头、不要音乐或字幕。", target_seconds: 5, ratio: "1:1 (Square)", mp: 0.4 } },
    { slug: "10-commerce-ai", sceneId: "commerce_pack", label: "电商套图", expected: "image", inputs: { project_name: "E2E-真实生成-电商单图", product_name: "白色陶瓷测试杯（合成素材）", reference_images: [cup], selling_points: "白色简洁外观；仅供测试，不用于商品发布", product_specs: "合成参考图768×768像素；无真实容量或功能声明", package_contents: "仅一只合成测试杯", audience: "端到端测试", generation_mode: "AI场景重绘", platform_preset: "淘宝 / 天猫", shot_types: ["hero"], visual_style: "简洁高级", brand_notes: "严格保留杯身与把手结构，不添加Logo、文字、配件，不声称真实规格。仅一个主图，禁止额外生成。", add_text: false } },
  ];
}

/** Mirrors the real frontend upload protocol; special H3 audio requires its attachment metadata. */
export async function prepareFrontendMedia(inputValues, fields, upload) {
  const result = structuredClone(inputValues);
  for (const field of fields) {
    if (!/^(image|audio)_list$/.test(field.type) || !Array.isArray(result[field.key])) continue;
    result[field.key] = await Promise.all(result[field.key].map(async value => {
      if (typeof value !== "string" || !path.isAbsolute(value)) return value;
      return upload(field.type.startsWith("audio") ? "audio" : "image", value);
    }));
  }
  return result;
}

export function caseLimits(definition, workflow) {
  if (definition.sceneId === "commerce_pack") assert.deepEqual(definition.inputs.shot_types, ["hero"]);
  if (definition.sceneId === "scene_long_text_to_video") assert.equal(definition.inputs.target_seconds, 5);
  for (const field of workflow.inputs.filter(field => field.required)) assert.notEqual(definition.inputs[field.key], undefined, `Missing required input ${field.key}`);
  assert.ok(workflow.steps.every(step => !step.review?.enabled), "A newly published approval gate requires manual testing, not auto-approval");
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    "base-url": { type: "string", default: "http://127.0.0.1:8799" },
    "output-dir": { type: "string", default: ".local/production-real-e2e-20261001" },
    "allow-generation": { type: "boolean", default: false },
    "scene": { type: "string", default: "all" },
    "max-wait-minutes": { type: "string", default: "20" },
  } });
  const base = new URL(values["base-url"]);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) && !base.username && !base.password, "Only local production is allowed");
  const root = path.resolve(values["output-dir"]); await mkdir(root, { recursive: true });
  const definitions = realCases(path.join(root, "fixtures"));
  const selected = values.scene === "all" ? definitions : definitions.filter(item => values.scene.split(",").some(selector => item.slug === selector || item.sceneId === selector));
  assert.ok(selected.length, "Unknown scene selector");
  const maxWait = Number(values["max-wait-minutes"]) * 60000;
  assert.ok(Number.isFinite(maxWait) && maxWait >= 60000 && maxWait <= 3600000, "Wait limit must be 1–60 minutes");
  const request = async (route, options = {}) => {
    const url = new URL(route, base); assert.equal(url.origin, base.origin, "Cross-origin production requests prohibited");
    return workbenchFetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(60000) });
  };
  const json = async (route, options) => { const response = await request(route, options); if (!response.ok) throw Error(`${route}: HTTP ${response.status} ${(await response.text()).slice(0,1000)}`); return response.json(); };
  const settings = await json("/api/settings");
  const comfyBase = new URL(settings.comfyuiBaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(comfyBase.hostname) && !comfyBase.username && !comfyBase.password, "Comfy queue inspection must be local");
  const report = { schemaVersion: 1, baseUrl: base.origin, startedAt: new Date().toISOString(), realGeneration: true, oneSamplePerScene: true, cases: [], limitations: ["采用当次读取的正式发布版本；不发布或修改配置", "使用原创合成图片和Windows SAPI测试音频", "每场景一次、串行、不自动重试失败模型调用", "不全局中断Comfy、不取消其他运行", "最小短样本不证明生产长时长负载或内容质量稳定性"] };
  const save = async () => {
    report.updatedAt = new Date().toISOString();
    await writeFile(path.join(root, "real-e2e-report.json"), JSON.stringify(report, null, 2));
    const rows = report.cases.map(item => `| ${item.title} | ${item.backendStatus ?? item.status} | ${item.e2eStatus ?? "进行中"} | ${item.runId ?? "未提交"} | ${item.error ?? item.semanticFailure ?? ""} |`);
    await writeFile(path.join(root, "real-e2e-report.md"), `# 正式环境真实生成 E2E\n\n- ${report.startedAt}\n- ${base.origin}\n- 每场景一个最小样本；实际发布工作流；不自动发布或重试\n\n| 场景 | 正式后端 | 验收 | runId | 问题 |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\n${report.limitations.map(x => `- ${x}`).join("\n")}\n`);
  };
  let stopped = false;
  for (const definition of selected) {
    const file = path.join(root, definition.slug + ".json");
    const folder = path.join(root, definition.slug); await mkdir(folder, { recursive: true });
    let entry;
    try { entry = JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    entry ??= { sceneId: definition.sceneId, title: definition.label, status: "not-submitted", checks: [], media: [] };
    assert.equal(entry.sceneId, definition.sceneId, "Existing report belongs to another scene");
    entry.checks ??= []; entry.media ??= [];
    report.cases.push(entry);
    const persist = async () => { await writeFile(file, JSON.stringify(entry, null, 2)); await save(); };
    const check = async (name, action) => { try { const details = await action(); entry.checks.push({ name, status: "pass", details }); } catch (error) { entry.checks.push({ name, status: "fail", error: error.message }); } };
    try {
      if (!entry.runId) {
        assert.ok(values["allow-generation"], "New AI jobs require --allow-generation after human authorization");
        for (const field of Object.values(definition.inputs)) if (Array.isArray(field)) for (const value of field) if (typeof value === "string" && path.isAbsolute(value)) await access(value);
        const gateStart = Date.now(); let lastGateLog = 0;
        while (true) {
          const health = await json("/api/health");
          const response = await fetch(new URL("/queue", comfyBase), { signal: AbortSignal.timeout(15000) }); assert.equal(response.status, 200);
          const queue = await response.json();
          if (!health.worker.active && !health.worker.queued && !health.worker.preparing && !queue.queue_running?.length && !queue.queue_pending?.length) break;
          if (Date.now() - gateStart > maxWait) throw Error("Other production work remains active; no new test job was submitted");
          if (Date.now() - lastGateLog > 60000) { console.log(`${definition.label}: waiting for production / GPU queue to be idle`); lastGateLog = Date.now(); }
          await sleep(5000);
        }
        const workspace = (await json("/api/workspace")).workspace;
        const published = publishedSnapshot(workspace, definition.sceneId); assert.ok(published?.workflow, "No published workflow");
        caseLimits(definition, published.workflow);
        entry.publishedVersionId = published.id; entry.workspaceRevisionAtSubmission = workspace.revision;
        entry.workflowSha256 = sha256(JSON.stringify(published.workflow)); entry.inputsBeforeUpload = definition.inputs;
        entry.inputValues = await prepareFrontendMedia(definition.inputs, published.workflow.inputs, async (kind, fixture) => {
          const fixtureRoot = path.resolve(root, "fixtures") + path.sep; assert.ok(path.resolve(fixture).startsWith(fixtureRoot), "Only original test fixtures can be uploaded");
          const bytes = await readFile(fixture); const mimeType = kind === "audio" ? "audio/wav" : "image/png";
          const response = await request("/api/comfyui/upload-" + kind, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(path.basename(fixture)), "X-File-Type": mimeType }, body: bytes });
          assert.equal(response.status, 200, "Frontend-compatible upload failed"); const attachment = await response.json(); assert.ok(attachment.filename);
          return attachment;
        });
        entry.attachmentPreparation = "Production frontend upload API";
        entry.runId = randomUUID(); entry.runTitle = `E2E-真实生成-20261001-${definition.slug}-${definition.label}`;
        entry.submittedAt = new Date().toISOString(); entry.status = "submitting"; await persist();
        await writeFile(path.join(folder, "submitted-workflow.json"), JSON.stringify(published.workflow, null, 2));
        const response = await request("/api/v1/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: entry.runId, runTitle: entry.runTitle, workflow: published.workflow, inputValues: entry.inputValues }) });
        entry.submitHttpStatus = response.status; entry.submitResult = await response.json();
        if (!response.ok) { entry.status = "rejected"; entry.e2eStatus = "failed"; entry.error = entry.submitResult.error ?? JSON.stringify(entry.submitResult); await persist(); continue; }
        assert.equal(response.status, 202); entry.status = "accepted"; await persist();
        console.log(`${definition.label}: submitted ${entry.runId} published=${published.id}`);
      }
      if (entry.status === "rejected") { await persist(); continue; }
      const waitStart = Date.now(); let stateKey = ""; let lastLog = 0; let run;
      while (true) {
        run = await json(`/api/v1/runs/${entry.runId}`);
        assert.equal(run.sceneId, definition.sceneId); assert.ok(run.runTitle?.startsWith("E2E-真实生成-20261001"), "Only our test-owned runs may be observed");
        entry.backendStatus = run.status;
        entry.steps = run.steps.map(step => ({ id: step.stepId, name: step.name, status: step.status, error: step.error, progress: step.progress, items: step.items?.map(item => ({ index: item.index, status: item.status, error: item.error, progress: item.progress })) }));
        const key = JSON.stringify(entry.steps.map(step => [step.id, step.status, step.items?.map(item => item.status)]));
        if (key !== stateKey || Date.now() - lastLog > 60000) { console.log(`${definition.label}: ${run.status}; ${entry.steps.map(step => `${step.name}=${step.status}`).join(", ")}`); stateKey = key; lastLog = Date.now(); }
        await writeFile(path.join(folder, "run.json"), JSON.stringify(run, null, 2)); await persist();
        if (!active.has(run.status)) break;
        if (Date.now() - waitStart > maxWait) { entry.e2eStatus = "pending"; entry.error = "Timed out observing; test-owned run left intact. Batch stopped, no additional jobs submitted."; stopped = true; break; }
        await sleep(5000);
      }
      if (stopped) { await persist(); break; }
      entry.finishedAt = run.finishedAt; entry.error = run.error;
      if (run.status === "waiting") { entry.e2eStatus = "pending"; entry.error = "Manual approval is required; no automatic approval attempted"; await persist(); continue; }
      const events = await json(`/api/v1/runs/${entry.runId}/events/history`); await writeFile(path.join(folder, "events.json"), JSON.stringify(events, null, 2));
      await check("持久化事件", async () => { assert.ok(events.events.length > 0); return { count: events.events.length, lastSequence: events.nextSequence }; });
      await check("SSE 终态", async () => { const response = await request(`/api/v1/runs/${entry.runId}/events`); assert.equal(response.status, 200); assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/); const text = await response.text(); await writeFile(path.join(folder, "terminal.sse.txt"), text); assert.ok(text.includes(`\"status\":\"${run.status}\"`)); return { bytes: text.length, status: run.status }; });
      await check("正式输入/工作流/输出归档", async () => { const checked = []; for (const key of ["inputs", "workflow", "output"]) { const filePath = path.resolve(run.artifacts[key]); const projectRoot = path.resolve(settings.projectDirectory) + path.sep; assert.ok(filePath.startsWith(projectRoot), "Artifact escaped project directory"); const info = await stat(filePath); assert.ok(info.size > 0); checked.push({ key, bytes: info.size }); } return checked; });
      if (run.status !== "completed") { entry.e2eStatus = "failed"; await persist(); console.log(`${definition.label}: FAILED ${run.error}`); continue; }
      const finalMedia = mediaReferences(run.outputs, base.origin);
      const stepOutputs = [];
      for (const step of run.steps) {
        const schema = run.workflow.steps.find(item => item.id === step.stepId);
        for (const field of schema?.outputs ?? []) {
          stepOutputs.push({ type: field.type, value: step.outputs?.[field.key] });
          for (const item of step.items ?? []) stepOutputs.push({ type: field.type, value: item.outputs?.[field.key] });
        }
      }
      const allMedia = [...new Map([...finalMedia, ...mediaReferences(stepOutputs, base.origin)].map(item => [item.url, item])).values()];
      entry.finalMediaCount = finalMedia.length;
      await check("场景最终媒体输出契约", async () => { assert.ok(finalMedia.some(item => item.type.includes(definition.expected)), `Final outputs do not expose a declared ${definition.expected} media URL`); return { count: finalMedia.length }; });
      for (const [index, media] of allMedia.entries()) {
        await check(`媒体 ${index + 1} HEAD / Range / 解码`, async () => {
          const head = await request(media.url, { method: "HEAD" }); assert.equal(head.status, 200); const size = Number(head.headers.get("content-length")); assert.ok(size > 0 && size < 256 * 1024 * 1024, "Unexpected sample media size");
          const ranged = await request(media.url, { headers: { Range: "bytes=0-31" } }); assert.equal(ranged.status, 206); assert.match(ranged.headers.get("content-range") ?? "", /^bytes 0-\d+\/\d+$/); const sample = await ranged.arrayBuffer(); assert.ok(sample.byteLength > 0 && sample.byteLength <= 32);
          const response = await request(media.url); assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.length, size);
          const contentType = head.headers.get("content-type") ?? ""; const ext = contentType.includes("video") ? ".mp4" : contentType.includes("png") ? ".png" : contentType.includes("jpeg") ? ".jpg" : contentType.includes("audio") ? ".wav" : ".bin";
          const file = path.join(folder, `media-${index + 1}${ext}`); await writeFile(file, bytes);
          let metadata;
          if (contentType.startsWith("image/")) { const info = await sharp(bytes).metadata(); assert.ok(info.width >= 128 && info.height >= 128); metadata = { format: info.format, width: info.width, height: info.height }; }
          else if (contentType.startsWith("video/")) { const { stdout } = await execute("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,width,height,r_frame_rate,sample_rate", "-of", "json", file]); metadata = JSON.parse(stdout); assert.ok(metadata.streams.some(stream => stream.codec_type === "video")); assert.ok(Number(metadata.format.duration) >= 1); }
          else if (contentType.startsWith("audio/")) { const { stdout } = await execute("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type", "-of", "json", file]); metadata = JSON.parse(stdout); }
          else throw Error(`Unexpected media content type ${contentType}`);
          const row = { url: media.url, type: media.type, contentType, bytes: bytes.length, sha256: sha256(bytes), file, metadata }; entry.media.push(row); return row;
        });
      }
      if (definition.sceneId === "scene_3a95a9cb-ed5e-468f-aac9-59b670b1f979") {
        const videoSteps = run.workflow.steps.filter(step => step.kind === "comfyui");
        const referenceBinding = videoSteps.some(step => step.comfyui?.bindings?.some(binding => binding.direction === "input" && /image/.test(binding.type ?? "") && binding.sourceRef === "input.references"));
        if (!referenceBinding) { entry.semanticFailure = "参考图未绑定到视频生成节点；视频可生成不等于参考生视频通过"; entry.checks.push({ name: "参考图实际送入生成工作流", status: "fail", error: entry.semanticFailure }); }
      }
      if (definition.sceneId === "commerce_pack") await check("AI电商分支及单图ZIP", async () => { assert.equal(run.steps.find(step => step.stepId === "product_brief")?.status, "completed"); assert.equal(run.steps.find(step => step.stepId === "shot_plan")?.status, "completed"); const output = run.outputs.find(item => item.key === "commerce_manifest"); const rows = output?.value?.flat(); assert.equal(rows?.length, 1); assert.equal(rows[0].generationMode, "AI场景重绘"); const response = await request(`/api/v1/runs/${entry.runId}/commerce-pack.zip`); assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer()); await writeFile(path.join(folder, "commerce-pack.zip"), bytes); return { images: rows.length, bytes: bytes.length }; });
      if (["scene_h3_long_video", "scene_long_text_to_video"].includes(definition.sceneId)) await check("成片保留音频", async () => { const video = entry.media.find(item => item.contentType.startsWith("video/")); assert.ok(video?.metadata.streams.some(stream => stream.codec_type === "audio")); return { duration: video.metadata.format.duration, codecs: video.metadata.streams.map(stream => stream.codec_name) }; });
      entry.e2eStatus = entry.checks.some(check => check.status === "fail") ? "failed" : "passed";
      await persist(); console.log(`${definition.label}: E2E ${entry.e2eStatus}, media=${entry.media.length}`);
    } catch (error) {
      entry.error = error.message; entry.e2eStatus = entry.backendStatus && active.has(entry.backendStatus) ? "pending" : "failed";
      await persist(); console.log(`${definition.label}: ${entry.e2eStatus} ${error.message}`);
      if (entry.e2eStatus === "pending" || entry.status === "submitting") { stopped = true; break; }
    }
  }
  report.finishedAt = new Date().toISOString(); report.batchStopped = stopped;
  report.summary = report.cases.reduce((acc, item) => { const status = item.e2eStatus ?? "pending"; acc[status] = (acc[status] ?? 0) + 1; return acc; }, {});
  await save(); console.log(JSON.stringify({ outputDirectory: root, summary: report.summary, batchStopped: stopped }, null, 2));
  if (report.summary.failed || report.summary.pending) process.exitCode = 1;
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
