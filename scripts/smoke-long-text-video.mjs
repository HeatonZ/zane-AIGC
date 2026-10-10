import "./smoke-auth.mjs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";
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
const parent = path.resolve(os.tmpdir());
const temporary = path.resolve(await mkdtemp(path.join(parent, "zane-long-text-smoke-")));
const data = path.join(temporary, "data"), project = path.join(temporary, "project"), hermes = path.join(temporary, "hermes");
let child, exited, logs = "", writerCalls = 0, aixgCalls = 0, failSecond = true, oldClipDeleted = false;
const generated = [];
const client = new Client({ name: "zane-long-video-smoke", version: "1.0.0" });
const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg", ffprobe = process.env.FFPROBE_BIN || "ffprobe";
const pkg = JSON.parse(await readFile(path.join(root, "examples", "scenes", "long-text-to-video.json"), "utf8"));
const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#aaddcc" } }).png().toBuffer();
const prompt = (character, voice, prop) => `subject_definitions:\n<Character ${character}> 位于 <Scene 1>，声音参考 <Voice ${voice}>。${prop ? "手持 <Prop 1>。" : ""}\nsummary:\n人物确认收到信件。\nretention_analysis:\n保留参考人物外观、服装和场景光线。\ndetailed_description:\n0-5秒，中近景，人物看向门口，正常说话：信到了。\noverall_soundscape:\n<Voice ${voice}> 对应人物的音色说：信到了。必要的纸张摩擦声。\nnon_diegetic_music:\nA dramatic score`;
const shots = [{ index: 1, seconds: 5, characters: [2], scenes: [1], props: [1], voices: [2], prompt: prompt(2, 2, true) }, { index: 2, seconds: 5, characters: [1], scenes: [1], props: [], voices: [1], prompt: prompt(1, 1, false) }];
const autogrow = (kind, prefix, max) => ["COMFY_AUTOGROW_V3", { template: { input: { required: { reference: [kind, {}] } }, prefix, min: 0, max } }];
const graph = { "201": { class_type: "String", inputs: { String: "" } }, "196": { class_type: "SelfLiftAvatarH3Sampler", inputs: { transition_step: 4 } }, "197": { class_type: "H3SigmaRefiner", inputs: { extra_steps: 4 } }, "192": { class_type: "MiniMaxH3ReferenceToVideo", inputs: { prompt: "", length: ["154", 0], "ref_images.ref_image_8": ["old-image", 0], "ref_audios.ref_audio_2": ["old-voice", 0] } }, "154": { class_type: "ComfyMathExpression", inputs: { expression: "round(a * 30)" } }, "152": { class_type: "CreateVideo", inputs: { fps: 30 } }, "115": { class_type: "ResolutionSelector", inputs: { aspect_ratio: "9:16 (Portrait Widescreen)", megapixels: 0.7 } }, "92": { class_type: "SaveVideo", inputs: {} } };
// UI-only reroutes must be resolved by the shared importer, never sent as backend nodes.
const routedApi = structuredClone(graph);
routedApi["92"].inputs.video = ["route-b", 0];
routedApi["route-a"] = { class_type: "Reroute", inputs: { "": ["152", 0] } };
routedApi["route-b"] = { class_type: "Reroute", inputs: { "": ["route-a", 0] } };
const uiGraph = { nodes: [], links: [] }; let fixtureLinkId = 1;
for (const [id, apiNode] of Object.entries(routedApi)) {
  const node = { id, type: apiNode.class_type, inputs: [], outputs: [{ name: apiNode.class_type === "SaveVideo" ? "video" : "output", type: "*" }], widgets_values_named: {} };
  for (const [name, value] of Object.entries(apiNode.inputs)) {
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") {
      const link = fixtureLinkId++; uiGraph.links.push([link, value[0], value[1], id, node.inputs.length, "*"]); node.inputs.push({ name, link });
    } else { node.inputs.push({ name, link: null, widget: { name } }); node.widgets_values_named[name] = value; }
  }
  uiGraph.nodes.push(node);
}
async function body(request) { const parts = []; for await (const chunk of request) parts.push(chunk); return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"); }
const fixture = createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  const json = (payload, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(payload)); };
  try {
    if (url.pathname.endsWith("/chat/completions")) {
      const data = await body(request);
      const parts = data.messages[0].content;
      assert.ok(Array.isArray(parts));
      assert.equal(parts.filter((part) => part.type === "image_url").length, 4);
      const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      assert.match(text, /禁止音乐|禁止任何音乐|禁止所有音乐/);
      assert.match(text, /参考音频|音色/);
      assert.equal(parts.some((part) => part.type === "input_audio"), false);
      if (text.includes("你是 AIXG 模型提示词转换师")) {
        aixgCalls += 1;
        const index = Number(/"index"\s*:\s*(\d+)/.exec(text)?.[1]);
        assert.ok(index === 1 || index === 2); assert.match(text, /不重新改编/);
        const canonical = shots[index - 1].prompt;
        const variant = index === 1 ? canonical.replace("detailed_description:", " detailed_description:").replace("subject_definitions:", " SUBJECT_DEFINITIONS:") : canonical.replace("detailed_description:", "镜头动作:").replace("overall_soundscape:", " Overall_Soundscape:");
        return json({ choices: [{ message: { content: JSON.stringify({ prompt: variant }) } }] });
      }
      writerCalls += 1;
      const writerShots = shots.map(({ prompt: _prompt, ...shot }) => ({ ...shot, visual_description: "人物确认收到信件，中近景，0-5秒自然说话" }));
      return json({ choices: [{ message: { content: JSON.stringify({ storyboard: "隔离测试：两镜制作分镜。", shots: writerShots }) } }] });
    }
    if (url.pathname.startsWith("/api/userdata/") || url.pathname.startsWith("/userdata/")) return json(uiGraph);
    if (url.pathname === "/object_info/MiniMaxH3ReferenceToVideo") return json({ MiniMaxH3ReferenceToVideo: { input: { optional: { ref_images: autogrow("IMAGE", "ref_image_", 9), ref_audios: autogrow("AUDIO", "ref_audio_", 3) } } } });
    if (url.pathname === "/prompt") {
      const { prompt: applied } = await body(request);
      assert.ok(!Object.values(applied).some(node => node.class_type === "Reroute")); assert.deepEqual(applied["92"].inputs.video, ["152", 0]);
      assert.equal(applied["196"].class_type, "SelfLiftAvatarH3Sampler"); assert.equal(applied["196"].inputs.String, undefined); assert.equal(applied["197"].class_type, "H3SigmaRefiner");
      const shot = JSON.parse(applied["201"].inputs.String);
      assert.equal(shot.frames, 124); assert.equal(applied["192"].inputs.length, 124); assert.equal(applied["152"].inputs.fps, 24);
      if (shot.index === 1) assert.match(shot.prompt, /^detailed_description:/m); else { assert.match(shot.prompt, /^镜头动作:/m); assert.equal(shot.prompt_warnings.length, 1); } assert.match(shot.prompt, /^overall_soundscape:/m); assert.doesNotMatch(shot.prompt, /^详细描述:/m); assert.match(shot.prompt, /non_diegetic_music:\nN\/A$/); assert.match(shot.prompt, /禁止任何音乐/); assert.match(shot.prompt, /不复制其中的文字/); if (!shot.prompt_warnings?.length) assert.doesNotMatch(shot.prompt, /dramatic score/); else assert.match(shot.prompt, /禁止任何音乐/);
      assert.match(shot.prompt, /<Audio 1>/); assert.match(shot.prompt, /<Picture 1>/);
      const node = applied["192"].inputs;
      const expected = shot.index === 1 ? ["char-2.png", "scene-1.png", "prop-1.png"] : ["char-1.png", "scene-1.png"];
      assert.deepEqual(shot.references.images.map(item => item.filename), expected, "one physical image list, selected then merged in numbering order");
      assert.deepEqual(shot.references.audios.map(item => item.filename), [`voice-${shot.index === 1 ? 2 : 1}.wav`]);
      assert.deepEqual(shot.references.videos, []);
      for (let index = 0; index < expected.length; index += 1) assert.equal(applied[node[`ref_images.ref_image_${index}`][0]].inputs.image, `assets/${expected[index]}`);
      assert.equal(node[`ref_images.ref_image_${expected.length}`], undefined); assert.equal(node["ref_images.ref_image_8"], undefined);
      assert.equal(applied[node["ref_audios.ref_audio_0"][0]].class_type, "LoadAudio");
      assert.equal(applied[node["ref_audios.ref_audio_0"][0]].inputs.audio, `assets/voice-${shot.index === 1 ? 2 : 1}.wav`);
      assert.equal(node["ref_audios.ref_audio_1"], undefined); assert.equal(node["ref_audios.ref_audio_2"], undefined);
      generated.push(shot.index);
      if (shot.index === 2 && failSecond) { failSecond = false; return json({ error: "synthetic failure for resume test" }, 500); }
      return json({ prompt_id: `clip-${shot.index}` });
    }
    if (url.pathname.startsWith("/history/")) {
      const id = url.pathname.split("/").at(-1);
      return json({ [id]: { outputs: { "92": { video: [{ filename: `${id}.mp4`, type: "output", subfolder: "" }] } }, status: { status_str: "success" } } });
    }
    if (url.pathname === "/view") {
      const filename = url.searchParams.get("filename");
      if (filename?.endsWith(".mp4")) {
        if (oldClipDeleted && filename === "clip-1.mp4") return json({ error: "source deleted after archive" }, 404);
        const bytes = await readFile(path.join(temporary, filename)); response.writeHead(200, { "Content-Type": "video/mp4" }); return response.end(bytes);
      }
      response.writeHead(200, { "Content-Type": "image/png" }); return response.end(image);
    }
    return json({ error: `unexpected fixture route ${url.pathname}` }, 404);
  } catch (error) { return json({ error: error.message, stack: error.stack }, 500); }
});
async function bounded(promise, milliseconds = 15000) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Long-text smoke timeout\n${logs.slice(-3000)}`)), milliseconds); })]); } finally { clearTimeout(timer); } }
async function json(base, route, body) {
  const response = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok, `${route}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}
async function finished(base, id) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const run = await json(base, `/api/v1/runs/${id}`); if (["completed", "failed", "cancelled"].includes(run.status)) return run; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`Workflow timeout\n${logs.slice(-3000)}`);
}
try {
  await mkdir(project); await mkdir(data);
  for (const profile of ["writer", "aixg"]) { await mkdir(path.join(hermes, "profiles", profile), { recursive: true }); await writeFile(path.join(hermes, "profiles", profile, "config.yaml"), `name: ${profile}\n`); }
  for (const [index, color, frequency] of [[1, "red", 400], [2, "blue", 800]]) await exec(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=24:d=0.5`, "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=0.5`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(temporary, `clip-${index}.mp4`)], { windowsHide: true, timeout: 30000 });
  fixture.listen(0, "127.0.0.1"); await bounded(new Promise((resolve) => fixture.once("listening", resolve)));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
  await writeFile(path.join(data, "connections.json"), JSON.stringify({ enabledHermesProfiles: ["writer", "aixg"], comfyuiBaseUrl: fixtureUrl, projectDirectory: project, workflowTimeoutMinutes: 1 }));
  child = spawn(process.execPath, [path.join(root, "dist-server", "index.js"), "--production"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, API_HOST: "127.0.0.1", API_PORT: "0", APP_DATA_DIR: data, ZANE_PROJECT_DIR: project, HERMES_HOME: hermes, HERMES_API_BASE_URL: fixtureUrl, HERMES_API_KEY: "synthetic-not-real-key", COMFYUI_BASE_URL: fixtureUrl, ZANE_SHUTDOWN_TIMEOUT_MS: "1000" } });
  exited = new Promise((resolve) => child.once("exit", resolve));
  const base = await bounded(new Promise((resolve, reject) => { child.on("error", reject); child.stderr.on("data", (chunk) => { logs += chunk; }); child.stdout.on("data", (chunk) => { logs += chunk; const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs); if (match) resolve(match[1]); }); child.once("exit", (code) => reject(new Error(`Server exited (${code})\n${logs}`))); }));
  await json(base, "/api/ready");
  const legacyScene = { ...pkg.scene, id: "legacy_long_text", title: "原有场景（隔离测试）" };
  const original = { format: "zane-studio.workspace/v1", scenes: [legacyScene], workflows: { [legacyScene.id]: { ...pkg.workflow, sceneId: legacyScene.id } }, optionPresets: [], drafts: [], sceneVersions: {} };
  await json(base, "/api/workspace/initialize", original);
  const install = () => exec(process.execPath, ["--import", "tsx", path.join(root, "scripts", "install-long-text-video.mjs"), base], { cwd: root, windowsHide: true, timeout: 20000, env: { ...process.env, ZANE_LONG_VIDEO_BACKUP_DIRECTORY: path.join(temporary, "backups") } });
  await install(); const installed = (await json(base, "/api/workspace")).workspace;
  assert.equal(installed.scenes.length, 2); assert.deepEqual(installed.scenes[0], legacyScene); assert.deepEqual(installed.workflows[legacyScene.id], original.workflows[legacyScene.id]); assert.ok(installed.sceneVersions[pkg.scene.id].publishedVersionId);
  assert.match((await install()).stdout, /已存在/); assert.deepEqual((await json(base, "/api/workspace")).workspace, installed);
  const attachment = (filename) => ({ filename, type: "input", subfolder: "assets", url: `/api/comfyui/view?filename=${filename}&type=input` });
  const values = { content: "林舟把信交给苏晴。苏晴确认信到了。", character_assets: [attachment("char-1.png"), attachment("char-2.png")], scene_assets: [attachment("scene-1.png")], prop_assets: [attachment("prop-1.png")], voice_reference_audio: [attachment("voice-1.wav"), attachment("voice-2.wav")], asset_notes: "人物1=林舟，人物2=苏晴；场景1=房间；道具1=信封；音色1=林舟，音色2=苏晴", production_notes: "禁止音乐", target_seconds: 10, ratio: "16:9 (Widescreen)", mp: 0.7 };
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist-server/mcp/index.js")], cwd: root, env: { ...process.env, ZANE_BASE_URL: base }, stderr: "pipe" });
  transport.stderr?.on("data", chunk => { logs += chunk; }); await bounded(client.connect(transport));
  const call = async (name, args) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError && result.structuredContent?.ok, name + ": " + JSON.stringify(result)); return result.structuredContent.data; };
  const published = await call("get_scene", { sceneId: pkg.scene.id });
  assert.deepEqual(published.workflow.steps.find(step => step.id === "generate").comfyui.bindings.filter(binding => ["image_list", "audio_list"].includes(binding.type)).map(binding => [binding.key,binding.sourceRef]), [["reference_images","iteration.item.references.images"],["reference_audio","iteration.item.references.audios"]]);
  assert.deepEqual(published.inputRequirements.filter(field => field.mediaRole).map(field => field.mediaRole), ["character", "scene", "prop", "voice_reference"]);
  assert.equal((await call("prepare_scene", { sceneId: pkg.scene.id, versionId: published.versionId, inputValues: values })).valid, true);
  const first = await call("submit_scene", { sceneId: pkg.scene.id, versionId: published.versionId, runId: randomUUID(), inputValues: values });
  const failed = await finished(base, first.runId); assert.equal(failed.status, "failed"); assert.equal(failed.steps[0].status, "completed"); assert.equal(failed.steps[1].status, "completed"); assert.equal(failed.steps[1].items.length, 2); assert.equal(failed.steps[2].items[0].status, "completed"); assert.equal(failed.steps[2].items[1].status, "failed");
  assert.match(failed.steps[1].outputs.prompt[0], /^ detailed_description:/m);
  assert.match(failed.steps[1].outputs.prompt[1], /^镜头动作:/m);
  const failedWarnings = await call("get_step_result", { runId: first.runId, stepId: "generate", itemIndex: 1, limit: 1, includeValues: false });
  assert.equal(failedWarnings.items[0].warnings.length, 1); assert.match(failedWarnings.items[0].warnings[0], /不阻止生成/);
  const rawAixg = structuredClone(failed.steps[1].outputs);
  oldClipDeleted = true;
  const resumed = await call("resume_run", { sourceRunId: first.runId, runId: randomUUID() });
  const run = await finished(base, resumed.runId);
  assert.equal(run.status, "completed", run.error); assert.equal(writerCalls, 1); assert.equal(aixgCalls, 2); assert.deepEqual(generated, [1, 2, 2]);
  assert.deepEqual(run.steps[1].outputs, rawAixg, "normalization keeps original AIXG text unchanged across resume");
  const warningPage = await call("get_step_result", { runId: resumed.runId, stepId: "generate", itemIndex: 1, includeValues: false });
  assert.equal(warningPage.items[0].status, "completed"); assert.equal(warningPage.items[0].warnings.length, 1);
  assert.equal(run.steps[2].items[1].warnings.length, 1);
  const output = run.outputs.find((item) => item.key === "video").value;
  const ordered = Array.isArray(output) ? output : []; assert.equal(ordered.length, 2, "成片输出应按分镜顺序包含全部片段");
  const response = await fetch(base + (typeof ordered[0] === "string" ? ordered[0] : ordered[0].url)); assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /video\/mp4/);
  const final = path.join(temporary, "final.mp4"); await writeFile(final, Buffer.from(await response.arrayBuffer()));
  const { stdout } = await exec(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", final], { windowsHide: true, timeout: 10000 });
  const info = JSON.parse(stdout); assert.equal(info.streams.find((stream) => stream.codec_type === "video").r_frame_rate, "24/1"); assert.ok(info.streams.some((stream) => stream.codec_type === "audio")); assert.ok(Number(info.format.duration) > 0.4);
  const applied = run.outputs.find((item) => item.key === "shots").value; assert.equal(applied.length, 2); assert.ok(applied.every((row) => row.prompt.includes("禁止任何音乐") && row.frames === 124));
  const manifest = run.outputs.find((item) => item.key === "manifest").value; assert.equal(manifest.count, 2); assert.deepEqual(manifest.shots.map((row) => row.index), [1, 2]);
  console.log("PASS: isolated published scene + real stdio MCP / Writer once / AIXG per shot (no replay on resume) / character-scene-prop and voice selection / LoadAudio links / no-music final prompts / H3 format warnings never block generation, persist before upstream failure, readable via MCP (raw outputs preserved) / H3 native 24fps / failed-item resume / durable archived source / ordered archived MP4 with audio in shot order (no actual model generation)");
} finally {
  await client.close().catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); try { await bounded(exited); } catch { child.kill("SIGKILL"); await exited; } }
  fixture.closeAllConnections(); await new Promise((resolve) => fixture.close(resolve));
  assert.equal(path.dirname(temporary), parent); assert.ok(path.basename(temporary).startsWith("zane-long-text-smoke-"));
  await rm(temporary, { recursive: true, force: true });
}
