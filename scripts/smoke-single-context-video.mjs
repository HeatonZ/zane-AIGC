import "./smoke-auth.mjs";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "examples/scenes/long-text-context-video.json"), "utf8"));
const ui = JSON.parse(await readFile(path.join(root, "scripts/fixtures/context-video-workflow.json"), "utf8"));
const schemas = JSON.parse(await readFile(path.join(root, "scripts/fixtures/context-video-object-info.json"), "utf8"));
const temporary = await mkdtemp(path.join(os.tmpdir(), "zane-single-context-smoke-"));
const data = path.join(temporary, "data"), project = path.join(temporary, "project"), hermes = path.join(temporary, "hermes");
const client = new Client({ name: "single-workflow-context-smoke", version: "1.0.0" });
const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#abbacc" } }).png().toBuffer();
let child, exited, logs = "", failSecond = true, writerCalls = 0, aixgCalls = 0, lastWriterShots, shotCount = 2, malformed = "", expectedVoiceBytes = [];
const captured = [], uploads = new Map(), queued = new Map(), workflowReads = new Set();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = (promise, ms = 30000) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("timeout: " + logs.slice(-3000))), ms); timer.unref(); })]);
async function body(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); }
const attachment = name => ({ filename: name, type: "input", subfolder: "", url: "/api/comfyui/view?filename=" + name + "&type=input" });
function prompt(index) {
  return `subject_definitions:\n<Character 1>在<Scene 1>，参考<Voice 1>音色。\nsummary:\n镜头${index}。\nretention_analysis:\n保留人物、布局和光线。\ndetailed_description:\n${index === 1 ? "1-3" : "1.9166667-3.9166667"}秒，人物抬眼看向门口，说“信到了。”。\noverall_soundscape:\n林舟以<Voice 1>音色自然克制说“信到了。”，仅脚本对白和现场声，禁止任何音乐。\nnon_diegetic_music:\nN/A`;
}
function shots() {
  const rows = Array.from({ length: shotCount }, (_, i) => ({ index: i + 1, seconds: 5, selection: { characters: [1], scenes: [1], props: [], voices: [1, 2] }, purpose: "确认信件", visual_description: "人物抬眼看向门口", continuity_in: "人物右手在桌上", continuity_out: "人物抬眼，手仍在桌上", dialogue: [{ speaker: "林舟", text: "信到了。", delivery: "自然克制", start: 1, end: 3 }] }));
  if (malformed === "schema") delete rows[0].visual_description;
  if (malformed === "writer_prompt") rows[0].prompt = prompt(1);
  if (malformed === "ordinal") rows[0].index = 2;
  if (malformed === "media") rows[0].selection.characters = [2];
  return rows;
}
function ancestors(graph, id, seen = new Set()) {
  if (seen.has(id)) return seen; seen.add(id);
  for (const value of Object.values(graph[id]?.inputs ?? {})) if (Array.isArray(value) && value.length === 2 && graph[value[0]]) ancestors(graph, String(value[0]), seen);
  return seen;
}
const fixture = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture");
    const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.endsWith("/chat/completions")) {
      const request = JSON.parse(await body(req));
      const parts = request.messages[0].content;
      const text = typeof parts === "string" ? parts : parts.filter(part => part.type === "text").map(part => part.text).join("\n");
      assert.match(text, /禁止任何音乐/);
      if (text.includes("本次一次批量转换Writer的全部原始分镜")) {
        aixgCalls++;
        assert.match(text, /不重新改编/); assert.match(text, /0.9166667/);
        const serialized = text.split("原始分镜数组（唯一内容依据，顺序固定）：")[1].split("\n\n")[0];
        assert.deepEqual(JSON.parse(serialized), lastWriterShots, "AIXG consumes the exact original Writer shots");
        const prompts = lastWriterShots.map(shot => prompt(shot.index));
        if (malformed === "prompt_count") prompts.push(prompt(prompts.length + 1));
        if (malformed === "prompt_type") prompts[0] = { prompt: prompt(1) };
        json({ choices: [{ message: { content: JSON.stringify({ prompts }) } }] }); return;
      }
      assert.match(text, /制作级视频分镜脚本/); assert.match(text, /不输出 H3 模型提示词/);
      assert.doesNotMatch(text, /subject_definitions:/); writerCalls++;
      lastWriterShots = shots();
      if (malformed !== "writer_prompt") assert.ok(lastWriterShots.every(shot => !Object.hasOwn(shot, "prompt")));
      json({ choices: [{ message: { content: JSON.stringify({ storyboard: "连续剧情：确认信件，准备出发。", shots: lastWriterShots }) } }] }); return;
    }
    if (/^\/(?:object_info|prompt|history|view|upload|interrupt|userdata|api\/userdata)(?:\/|$)/.test(url.pathname)) {
      assert.equal(req.headers.authorization, undefined, "never forward workbench credentials to ComfyUI");
      assert.equal(req.headers.cookie, undefined);
    }
    if (url.pathname.startsWith("/object_info")) { const type = decodeURIComponent(url.pathname.split("/").pop()); json(type === "object_info" ? schemas : { [type]: schemas[type] }); return; }
    if (url.pathname.includes("/userdata/")) {
      const filename = decodeURIComponent(decodeURIComponent(url.pathname.split("/userdata/")[1])); workflowReads.add(filename);
      assert.ok(filename.endsWith(pkg.workflow.steps.find(step => step.id === "generate").comfyui.workflowFile), JSON.stringify({filename,expected:pkg.workflow.steps.find(step => step.id === "generate").comfyui.workflowFile})); json(ui); return;
    }
    if (url.pathname === "/upload/image") {
      const bytes = await body(req), header = bytes.indexOf(Buffer.from('filename="'));
      const filename = /filename="([^"]+)"/.exec(bytes.toString("latin1"))?.[1] ?? "upload.bin";
      if (malformed === "audio_upload" && filename.endsWith(".wav")) { json({ error: "isolated audio upload rejected" }, 503); return; }
      const start = bytes.indexOf(Buffer.from("\r\n\r\n"), header) + 4, end = bytes.indexOf(Buffer.from("\r\n--"), start);
      const name = "uploaded-" + uploads.size + path.extname(filename); uploads.set(name, bytes.subarray(start, end)); json({ name, subfolder: "", type: "input" }); return;
    }
    if (url.pathname === "/prompt") {
      const graph = JSON.parse(await body(req)).prompt; captured.push(graph);
      assert.ok(!Object.values(graph).some(node => node.class_type === "Reroute"));
      assert.equal(graph["339"].class_type, "SelfLiftAvatarH3Sampler"); assert.ok(graph["339"].inputs.low_res_model); assert.ok(graph["339"].inputs.high_res_model);
      assert.equal(graph["179"].inputs.fps, 24); assert.equal(graph["297"].inputs.fps, 24); assert.equal(graph["179"].inputs.codec, "auto");
      assert.ok(graph["136"].inputs["ref_images.ref_image_0"]); assert.ok(graph["136"].inputs["ref_audios.ref_audio_0"]);
      assert.match(graph["138"].inputs.value, /<Picture 1>/); assert.match(graph["138"].inputs.value, /<Picture 2>/); assert.match(graph["138"].inputs.value, /<Audio 1>/);
      assert.doesNotMatch(graph["138"].inputs.value, /<Character|<Scene|<Voice/);
      for (const [slot, expectedBytes] of expectedVoiceBytes.entries()) {
        const audioNode = graph["136"].inputs[`ref_audios.ref_audio_${slot}`]?.[0];
        assert.equal(graph[audioNode]?.class_type, "LoadAudio");
        const audioPath = graph[audioNode].inputs.audio;
        assert.deepEqual(uploads.get(audioPath) ?? (audioPath === "voice.wav" ? await readFile(path.join(temporary, "voice.wav")) : undefined), expectedBytes, "LoadAudio gets exact fixed-version bytes in original reference order");
      }
      const index = Number(/镜头(\d+)/.exec(graph["138"].inputs.value)[1]), first = index === 1;
      assert.equal(graph["267"].inputs.value, !first); assert.equal(graph["131"].inputs["values.b"], !first);
      assert.equal(graph["131"].inputs.expression, pkg.workflow.steps.find(step => step.id === "generate").comfyui.bindings.find(binding => binding.key === "context_length_expression").literalValue);
      const reachable = ancestors(graph, "298");
      if (first) {
        assert.ok(!Object.hasOwn(graph["266"].inputs, "on_true")); assert.ok(!Object.hasOwn(graph["301"].inputs, "on_true"));
        assert.ok(!reachable.has("256"), "false branch must not validate LoadVideo");
        assert.ok(!Object.hasOwn(graph["256"].inputs, "file"), "no fallback to sample video");
      } else {
        assert.ok(!Object.hasOwn(graph["266"].inputs, "on_false")); assert.ok(!Object.hasOwn(graph["301"].inputs, "on_false"));
        assert.ok(reachable.has("256"));
        const filename = graph["256"].inputs.file; assert.ok(uploads.has(filename));
        assert.deepEqual(uploads.get(filename), await readFile(path.join(temporary, `clip-${index - 1}.mp4`)), "use the immediate predecessor's exact bytes");
      }
      const id = randomUUID(); queued.set(id, { index, fail: !first && failSecond }); json({ prompt_id: id }); return;
    }
    if (url.pathname.startsWith("/history/")) {
      const id = url.pathname.split("/").pop(), item = queued.get(id);
      json({ [id]: item.fail ? { status: { status_str: "error", messages: [["execution_error", { node_type: "SelfLiftAvatarH3Sampler", exception_message: "isolated continuation failure" }]] }, outputs: {} } : { status: { status_str: "success", messages: [] }, outputs: { "298": { video: [{ filename: `clip-${item.index}.mp4`, subfolder: "", type: "output" }] } } } }); return;
    }
    if (url.pathname === "/view") {
      const filename = url.searchParams.get("filename");
      if (uploads.has(filename)) { res.end(uploads.get(filename)); return; }
      if (/^clip-[123]\.mp4$/.test(filename)) { res.writeHead(200, { "Content-Type": "video/mp4" }); res.end(await readFile(path.join(temporary, filename))); return; }
      if (filename.endsWith(".wav")) { res.writeHead(200, { "Content-Type": "audio/wav" }); res.end(await readFile(path.join(temporary, "voice.wav"))); return; }
      res.writeHead(200, { "Content-Type": "image/png" }); res.end(image); return;
    }
    if (url.pathname === "/interrupt") { json({ ok: true }); return; }
    json({ error: "unhandled fixture " + url.pathname }, 404);
  } catch (error) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(error), stack: error.stack })); }
});
async function http(base, route, payload) {
  const response = await fetch(base + route, { ...(payload === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }) });
  const value = await response.json(); assert.ok(response.ok, route + ": " + JSON.stringify(value)); return value;
}
async function finished(base, id) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { const run = await http(base, "/api/v1/runs/" + id); if (["completed", "failed", "cancelled"].includes(run.status)) return run; await pause(100); }
  throw new Error("run timeout");
}
try {
  await mkdir(data); await mkdir(project); for (const profile of ["writer", "aixg"]) {
    await mkdir(path.join(hermes, "profiles", profile), { recursive: true });
    await writeFile(path.join(hermes, "profiles", profile, "config.yaml"), `name: ${profile}\n`);
  }
  for (const [index, color, frequency] of [[1, "red", 440], [2, "blue", 880], [3, "green", 1320]]) await exec(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=24:d=0.5`, "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=0.5`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(temporary, `clip-${index}.mp4`)], { windowsHide: true, timeout: 30000 });
  await exec(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=1", path.join(temporary, "voice.wav")], { windowsHide: true });
  await exec(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=700:sample_rate=48000:duration=1", path.join(temporary, "voice-two.wav")], { windowsHide: true });
  fixture.listen(0, "127.0.0.1"); await new Promise(resolve => fixture.once("listening", resolve));
  const upstream = "http://127.0.0.1:" + fixture.address().port;
  await writeFile(path.join(data, "connections.json"), JSON.stringify({ enabledHermesProfiles: ["writer", "aixg"], comfyuiBaseUrl: upstream, projectDirectory: project, workflowTimeoutMinutes: 1 }));
  child = spawn(process.execPath, [path.join(root, "dist-server/index.js"), "--production"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, API_HOST: "127.0.0.1", API_PORT: "0", APP_DATA_DIR: data, ZANE_PROJECT_DIR: project, HERMES_HOME: hermes, HERMES_API_BASE_URL: upstream, HERMES_API_KEY: "synthetic-not-real", COMFYUI_BASE_URL: upstream, ZANE_SHUTDOWN_TIMEOUT_MS: "1000" } });
  exited = new Promise(resolve => child.once("exit", resolve));
  const base = await bounded(new Promise((resolve, reject) => { child.on("error", reject); child.stderr.on("data", chunk => { logs += chunk; }); child.stdout.on("data", chunk => { logs += chunk; const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs); if (match) resolve(match[1]); }); child.once("exit", code => reject(new Error("server exited " + code + " " + logs))); }));
  const mathInfo = await http(base, "/api/comfyui/node-info?type=ComfyMathExpression"); assert.ok(mathInfo.inputs.some(input => input.name === "values.b"));
  await http(base, "/api/ready"); await http(base, "/api/workspace/initialize", { format: "zane-studio.workspace/v1", scenes: [], workflows: {}, optionPresets: [], drafts: [], sceneVersions: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist-server/mcp/index.js")], cwd: root, env: { ...process.env, ZANE_BASE_URL: base }, stderr: "pipe" });
  transport.stderr?.on("data", chunk => { logs += chunk; }); await bounded(client.connect(transport));
  const raw = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  const call = async (name, args) => { const response = await raw(name, args); assert.equal(response?.ok, true, name + ": " + JSON.stringify(response)); return response.data; };
  const sceneId = "single_context_smoke", scene = { ...pkg.scene, id: sceneId }, workflow = { ...pkg.workflow, sceneId };
  let draft = await call("create_scene", { scene, workflow });
  assert.deepEqual(workflow.steps.map(step => step.id), ["writer", "aixg", "align", "references", "records", "generate", "assemble"]);
  assert.equal(workflow.steps.find(step => step.id === "writer").hermesProfile, "writer");
  assert.equal(workflow.steps.find(step => step.id === "aixg").hermesProfile, "aixg");
  assert.equal(workflow.steps.find(step => step.id === "aixg").execution, undefined); assert.equal((await call("validate_scene_draft", { sceneId, revision: draft.revision })).valid, true);
  const staleRevision = draft.revision; workflow.name += " · isolated";
  await call("update_scene_draft", { sceneId, revision: staleRevision, workflow }); // dropped receipt: reconcile by original scene ID
  draft = await call("get_scene_draft", { sceneId }); assert.notEqual(draft.revision, staleRevision);
  assert.equal(draft.workflow.steps.find(step => step.id === "records").capabilityConfig.ordinalField, "index");
  assert.equal((await raw("update_scene_draft", { sceneId, revision: staleRevision, workflow })).error.code, "RESOURCE_REVISION_CONFLICT");
  const invalid = structuredClone(workflow); invalid.steps.find(step => step.id === "generate").execution.maxConcurrency = 2;
  assert.equal((await raw("update_scene_draft", { sceneId, revision: draft.revision, workflow: invalid })).ok, false);
  const publicationId = randomUUID(); await call("publish_scene", { sceneId, revision: draft.revision, publicationId });
  const published = await call("get_scene", { sceneId, versionId: publicationId }); assert.deepEqual(published.workflow.steps.find(step => step.id === "generate").execution.carry, { outputKey: "result" });
  const voiceId = randomUUID();
  await client.callTool({ name: "upload_asset", arguments: { createId: voiceId, name: "固定男声", kind: "audio", filePath: path.join(temporary, "voice.wav") } }); // dropped receipt
  const originalVoice = await call("get_asset", { assetId: voiceId });
  const voiceV2 = await call("upload_asset", { assetId: voiceId, revision: originalVoice.asset.revision, name: "固定男声新版", kind: "audio", filePath: path.join(temporary, "voice-two.wav") });
  assert.equal((await raw("upload_asset", { assetId: voiceId, revision: originalVoice.asset.revision, name: "旧revision", kind: "audio", filePath: path.join(temporary, "voice.wav") })).error.code, "ASSET_CONFLICT");
  const voicePage = await call("list_asset_versions", { assetId: voiceId, limit: 1 }); assert.equal(voicePage.hasMore, true);
  const voiceLast = await call("list_asset_versions", { assetId: voiceId, limit: 1, cursor: voicePage.nextCursor }); assert.equal(voiceLast.versions[0].version, 1);
  expectedVoiceBytes = [await readFile(path.join(temporary, "voice.wav")), await readFile(path.join(temporary, "voice-two.wav"))];
  const values = { content: "林舟收到信，然后出发。", character_assets: [attachment("char.png")], scene_assets: [attachment("scene.png")], prop_assets: [], voice_reference_audio: [originalVoice.reference, voiceV2.reference], asset_notes: "人物1=林舟，场景1=书房，音色1=林舟", production_notes: "禁止任何音乐，自然对白", target_seconds: 10, ratio: "16:9 (Widescreen)", mp: 0.3 };
  assert.equal((await call("prepare_scene", { sceneId, versionId: publicationId, inputValues: values })).valid, true);
  const executionContract = published.inputRequirements.find(field => field.key === "voice_reference_audio").mediaExecution.audioConsumers;
  assert.equal(executionContract.comfyui, "private_audio_bytes_to_upload_then_LoadAudio_in_reference_order");
  assert.equal(executionContract.uploadLimitBytes, 100_000_000);
  assert.equal((await raw("prepare_scene", { sceneId, versionId: publicationId, inputValues: { ...values, voice_reference_audio: [{assetId:voiceId, assetVersion:99}] } })).error.code, "INVALID_ASSET_REFERENCE");
  assert.equal(uploads.size, 0, "preflight/invalid fixed versions do not upload or generate");
  const runId = randomUUID(); await call("submit_scene", { sceneId, versionId: publicationId, runId, inputValues: values });
  const failed = await finished(base, runId); assert.equal(failed.status, "failed", failed.error); assert.equal(writerCalls, 1, failed.error); assert.equal(aixgCalls, 1, failed.error);
  assert.deepEqual(failed.inputValues.voice_reference_audio.map(voice => voice.assetVersion), [1,2]);
  assert.ok(failed.inputValues.voice_reference_audio.every(voice => voice.path && !voice.filename));
  assert.equal(failed.steps.find(step => step.stepId === "generate").items[0].status, "completed", JSON.stringify(failed.steps.find(step => step.stepId === "generate")));
  failSecond = false; const resumedId = randomUUID(); await call("resume_run", { sourceRunId: runId, runId: resumedId });
  const resumed = await finished(base, resumedId); assert.equal(resumed.status, "completed", resumed.error); assert.equal(writerCalls, 1); assert.equal(aixgCalls, 1); assert.equal(captured.length, 3, JSON.stringify({captured:captured.map(g=>g["138"].inputs.value.match(/镜头(\d+)/)?.[1]),resumed:resumed.steps.find(s=>s.stepId==="generate").items,failed:failed.steps.find(s=>s.stepId==="generate").items}));
  const originalShots = await call("get_step_result", { runId: resumedId, stepId: "writer", includeValues: true });
  const converted = await call("get_step_result", { runId: resumedId, stepId: "aixg", includeValues: true });
  const original = originalShots.outputs.find(output => output.key === "shots").value;
  assert.deepEqual(original, lastWriterShots); assert.ok(original.every(shot => !Object.hasOwn(shot, "prompt")));
  assert.deepEqual(converted.outputs.find(output => output.key === "prompts").value, original.map(shot => prompt(shot.index)));
  const aligned = await call("get_step_result", { runId: resumedId, stepId: "records", includeValues: true });
  assert.deepEqual(aligned.outputs.find(output => output.key === "rows").value.map(row => row.shot), original, "execution preserves Writer timing/dialogue/selection without AIXG rewriting");
  assert.match(captured[0]["138"].inputs.value, /<Picture 1>.*<Picture 2>/);
  assert.match(captured[0]["138"].inputs.value, /<Audio 1>/);
  assert.match(captured[0]["138"].inputs.value, /1-3秒/);
  assert.match(captured[2]["138"].inputs.value, /1\.9166667-3\.9166667秒/);
  assert.doesNotMatch(captured[2]["138"].inputs.value, /<Character|<Scene|<Voice/);
  let cursor; const items = []; do { const page = await call("get_step_result", { runId: resumedId, stepId: "generate", limit: 1, includeValues: false, ...(cursor ? { cursor } : {}) }); items.push(...page.items); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(items.map(item => item.index), [0, 1]); assert.equal((await raw("get_step_result", { runId: resumedId, stepId: "generate", itemIndex: 9 })).ok, false);
  const manifest = resumed.outputs.find(output => output.key === "manifest").value; assert.equal(manifest.count, 2); assert.deepEqual(manifest.shots.map(row => row.index), [1, 2]);
  const media = resumed.outputs.find(output => output.key === "video").value[0]; const response = await fetch(base + (typeof media === "string" ? media : media.url)); assert.ok(response.ok);
  const final = path.join(temporary, "final.mp4"); await writeFile(final, Buffer.from(await response.arrayBuffer()));
  const probe = JSON.parse((await exec(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-show_streams", "-of", "json", final], { windowsHide: true })).stdout);
  assert.equal(probe.streams.find(stream => stream.codec_type === "video").avg_frame_rate, "24/1"); assert.ok(probe.streams.some(stream => stream.codec_type === "audio"));
  shotCount = 3; const tripleId = randomUUID(); await call("submit_scene", { sceneId, versionId: publicationId, runId: tripleId, inputValues: values }); const triple = await finished(base, tripleId);
  assert.equal(triple.status, "completed", triple.error); assert.equal(triple.steps.find(step => step.stepId === "generate").items.length, 3); assert.equal(writerCalls, 2); assert.equal(aixgCalls, 2);
  shotCount = 1; const singleId = randomUUID(); await call("submit_scene", { sceneId, versionId: publicationId, runId: singleId, inputValues: values }); const single = await finished(base, singleId);
  assert.equal(single.status, "completed", single.error); assert.equal(single.outputs.find(output => output.key === "manifest").value.count, 1); assert.equal(writerCalls, 3); assert.equal(aixgCalls, 3);
  for (const mode of ["schema", "media", "ordinal", "writer_prompt", "prompt_count", "prompt_type", "audio_upload"]) {
    malformed = mode; const before = captured.length, id = randomUUID(); await call("submit_scene", { sceneId, versionId: publicationId, runId: id, inputValues: values }); const bad = await finished(base, id);
    assert.equal(bad.status, "failed"); if (mode === "audio_upload") assert.match(bad.error, /上传音频到 ComfyUI 失败/); assert.equal(captured.length, before, "invalid rows/media rejected before any video generation");
  }
  // Legacy uploaded attachments still pass through without a needless reupload.
  malformed = ""; expectedVoiceBytes = [await readFile(path.join(temporary, "voice.wav")), await readFile(path.join(temporary, "voice.wav"))];
  const legacyId = randomUUID(); await call("submit_scene", {sceneId,versionId:publicationId,runId:legacyId,inputValues:{...values,voice_reference_audio:[attachment("voice.wav"),attachment("voice.wav")]}});
  const legacy = await finished(base,legacyId); assert.equal(legacy.status,"completed",legacy.error);
  assert.equal(workflowReads.size, 1, "one physical workflow for every item");
  console.log("PASS: isolated real stdio MCP / 7 basic steps / Writer script then batch AIXG once each / original script preservation / fixed audio assets through selection/zip to exact ordered ComfyUI uploads, no credential forwarding, unchanged legacy attachments / one original UI workflow / static false requires no sample video / true uploads exact immediate predecessor / declared unconnected math Boolean binding / revision conflict and lost-write receipt / invalid carry and model output / paged items / failed suffix resume without model replay / single and triple chain / ordered archived FFmpeg fixture clip with audio; no real model calls");
} finally {
  await client.close().catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); try { await bounded(exited, 15000); } catch { child.kill("SIGKILL"); await exited; } }
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
  const resolved = path.resolve(temporary); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith("zane-single-context-smoke-"));
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
