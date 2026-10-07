import "./smoke-auth.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// Real compiled server + stdio MCP, temporary project/SQLite, loopback fake models only.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "zane-commerce-ai-"));
const project = path.join(temporary, "project"); await mkdir(project);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fixtures = await Promise.all(["#bc3344", "#4455bb", "#44bb66"].map(background => sharp({ create: { width: 32, height: 32, channels: 3, background } }).png().toBuffer()));
const fixtureFiles = [];
for (const [index, bytes] of fixtures.entries()) { const file = path.join(temporary, "reference-" + index + ".png"); await writeFile(file, bytes); fixtureFiles.push(file); }
let child, exited, logs = "", mockError, promptSequence = 0, failedOnce = false;
const client = new Client({ name: "commerce-ai-isolated-smoke", version: "1" });
const hermesRuns = new Map(), outputs = new Map(), uploads = new Map(), generations = new Map();
const hermesRequests = [], comfyRequests = [];
const bounded = async (promise, ms = 30000) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("AI commerce smoke timeout\n" + logs.slice(-4500))), ms); })]); } finally { clearTimeout(timer); } };
const body = async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks); };
const json = (response, value, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
const textOf = content => typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
const makeCards = (count, testcase) => Array.from({ length: count }, (_, index) => ({
  id: "card_" + (index + 1), role: index === 0 ? "hero" : "selling_point", goal: "表达已确认的卖点" + index,
  brief: "完整电商设计稿" + (index + 1) + "，黑绿视觉、非对称构图与图形设计，图中直接生成标题“测试商品”，保持商品外观。" + testcase,}));
const hermes = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, "Bearer commerce-ai-test-only");
    if (request.method === "POST" && /\/v1\/runs$/.test(request.url)) {
      const data = JSON.parse((await body(request)).toString("utf8")); const content = data.input[0].content, text = textOf(content);
      const images = typeof content === "string" ? [] : content.filter(part => part.type === "image_url").map(part => { assert.match(part.image_url.url, /^data:image\/[^;]+;base64,/); return hash(Buffer.from(part.image_url.url.split(",")[1], "base64")); });
      let value, stage;
      if (text.includes("1. product_brief（")) { stage = "brief"; value = { product_brief: "商品为用户提供的测试商品，外观与参考一致；只使用用户确认事实，未知结构不能推测。" }; assert.equal(images.length, text.includes("CASE:no_style") ? 2 : 3); }
      else if (text.includes("1. visual_direction（")) {
        assert.ok(text.includes("AI直接生成的完整电商设计稿"), "Writer designs complete images, not layout instructions");
        stage = "plan"; const count = Number(/图片数量:\s*([1-8])/.exec(text)?.[1]); assert.ok(count);
        const testcase = /CASE:[a-z_-]+/.exec(text)?.[0] ?? "CASE:normal";
        const cards = makeCards(count, testcase);
        if (testcase === "CASE:duplicate") cards[1].id = cards[0].id;
        if (testcase === "CASE:missing") cards.pop();
        if (testcase === "CASE:badrole") cards[0].role = "unknown";
        if (testcase === "CASE:badshape") cards[0].brief = 123;
        value = { visual_direction: "统一柔和光线、浅色背景，不改变商品结构，不增加未经确认配件。", cards }; assert.equal(images.length, text.includes("CASE:no_style") ? 2 : 3);
      } else {
        assert.ok(text.includes("同一次AI生图中完成"), "AIXG must preserve full-image design and model-rendered text");
        stage = "prompt"; const card = JSON.parse(/本张设计方案:\s*(\{[^\n]+\})/.exec(text)?.[1] ?? "null"); assert.ok(card?.id);
        const noStyle = card.brief.includes("CASE:no_style");
        const expectedImages = [hash(fixtures[0]), hash(fixtures[1]), ...(noStyle ? [] : [hash(fixtures[2])])];
        assert.deepEqual(images, expectedImages, "AIXG receives every product/style reference without model-authored selection");
        assert.ok(!text.includes('"__zaneRuntime"'), "typed media must be attachments, not JSON text");
        value = { prompt: "PROMPT:" + card.id + ":" + card.brief + "，使用<image1>保持商品外观；直接生成含标题、图形、背景与完整设计的最终电商成图。" };
      }
      const runId = randomUUID(); hermesRuns.set(runId, JSON.stringify(value)); hermesRequests.push({ stage, images }); return json(response, { run_id: runId, status: "queued" });
    }
    const runId = /\/v1\/runs\/([^/]+)$/.exec(request.url)?.[1];
    if (request.method === "GET" && hermesRuns.has(runId)) return json(response, { run_id: runId, status: "completed", output: hermesRuns.get(runId) });
    return json(response, { error: "unexpected Hermes test endpoint" }, 404);
  } catch (error) { mockError = error; json(response, { error: String(error) }, 500); }
});
const graph = { "471": { class_type: "ImageConsumer", inputs: { images: null, prompt: "" } }, "476": { class_type: "Seed", inputs: { seed: 0 } }, "481": { class_type: "Canvas", inputs: { aspect_ratio: "1:1 (Square)", megapixels: 1 } }, "479": { class_type: "Switch", inputs: { switch: true } }, "461": { class_type: "SaveImage", inputs: { images: ["471", 0] } } };
const comfy = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://mock.invalid");
    if (url.pathname.startsWith("/api/userdata/") || url.pathname.startsWith("/userdata/")) return json(response, graph);
    if (url.pathname.startsWith("/object_info/")) { const type = decodeURIComponent(url.pathname.split("/").at(-1)); return json(response, { [type]: { input: { required: { images: ["IMAGE"], prompt: ["STRING"], seed: ["INT"], aspect_ratio: [["1:1 (Square)"]], megapixels: ["FLOAT"], switch: ["BOOLEAN"] } }, output: ["IMAGE"] } }); }
    if (url.pathname === "/upload/image") {
      const multipart = new Request("http://mock.invalid/upload/image", { method: "POST", headers: request.headers, body: await body(request) }); const form = await multipart.formData(); const image = form.get("image"); assert.ok(image instanceof Blob);
      const bytes = Buffer.from(await image.arrayBuffer()); const name = "upload-" + uploads.size + ".png"; uploads.set("zane-studio/" + name, bytes); return json(response, { name, subfolder: "zane-studio", type: "input" });
    }
    if (url.pathname === "/prompt") {
      const data = JSON.parse((await body(request)).toString("utf8")); const actualGraph = data.prompt;
      const prompt = actualGraph["471"].inputs.prompt; const refs = Object.values(actualGraph).filter(node => node.class_type === "LoadImage").map(node => hash(uploads.get(node.inputs.image)));
      const cardIndex = Number(/PROMPT:card_(\d+)/.exec(prompt)?.[1]) - 1; assert.ok(cardIndex >= 0);
      const expected = [hash(fixtures[0]), hash(fixtures[1]), ...(/CASE:no_style/.test(prompt) ? [] : [hash(fixtures[2])])]; assert.deepEqual(refs, expected, "ComfyUI gets all product/style references selected by the basic media step");
      assert.equal(actualGraph["479"].inputs.switch, true); const id = "test-" + (++promptSequence); const filename = "generated-" + id + ".png";
      const fails = prompt.includes("CASE:fail_once") && cardIndex === 1 && !failedOnce; if (fails) failedOnce = true;
      generations.set(id, { filename, fails, imageCount: prompt.includes("CASE:extra_images") ? 2 : prompt.includes("CASE:no_images") ? 0 : 1 }); outputs.set(filename, fixtures[cardIndex % 2]); comfyRequests.push({ id, cardIndex, prompt, refs, fails }); return json(response, { prompt_id: id });
    }
    if (url.pathname.startsWith("/history/")) { const id = url.pathname.split("/").at(-1), generation = generations.get(id); assert.ok(generation); return json(response, { [id]: { status: { completed: true, status_str: generation.fails ? "error" : "success", messages: generation.fails ? [["execution_error", { exception_message: "isolated explicit failure", node_id: "471", node_type: "ImageConsumer" }]] : [] }, outputs: generation.fails ? {} : { "461": { images: Array.from({ length: generation.imageCount }, () => ({ filename: generation.filename, subfolder: "", type: "output" })) } } } }); }
    if (url.pathname === "/view") { const filename = url.searchParams.get("filename"); const bytes = outputs.get(filename) ?? uploads.get(url.searchParams.get("subfolder") + "/" + filename); assert.ok(bytes, "only test files can be viewed"); response.writeHead(200, { "Content-Type": "image/png" }); return response.end(bytes); }
    return json(response, { error: "unexpected ComfyUI test endpoint: " + url.pathname }, 404);
  } catch (error) { mockError = error; json(response, { error: String(error) }, 500); }
});
try {
  await new Promise(resolve => hermes.listen(0, "127.0.0.1", resolve)); await new Promise(resolve => comfy.listen(0, "127.0.0.1", resolve));
  const hermesBase = "http://127.0.0.1:" + hermes.address().port, comfyBase = "http://127.0.0.1:" + comfy.address().port;
  child = spawn(process.execPath, [path.join(root, "dist-server/index.js"), "--production"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "production", API_HOST: "127.0.0.1", API_PORT: "0", APP_DATA_DIR: path.join(temporary, "data"), ZANE_PROJECT_DIR: project, HERMES_HOME: path.join(temporary, "no-real-hermes"), HERMES_API_BASE_URL: hermesBase, HERMES_API_KEY: "commerce-ai-test-only", HERMES_RETRY_ATTEMPTS: "0", COMFYUI_BASE_URL: comfyBase, ZANE_SHUTDOWN_TIMEOUT_MS: "1000" } });
  exited = new Promise(resolve => child.once("exit", resolve));
  const base = await bounded(new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => reject(new Error("Isolated server exited " + code + "\n" + logs))); child.stderr.on("data", chunk => logs += chunk); child.stdout.on("data", chunk => { logs += chunk; const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs); if (match) resolve(match[1]); }); }));
  for (let index = 0; index < 100; index++) { if ((await fetch(base + "/api/ready")).ok) break; await new Promise(resolve => setTimeout(resolve, 30)); }
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist-server/mcp/index.js")], cwd: root, env: { ...process.env, ZANE_BASE_URL: base }, stderr: "pipe" }); transport.stderr?.on("data", chunk => logs += chunk); await bounded(client.connect(transport));
  const raw = async (name, arguments_ = {}) => { const response = await bounded(client.callTool({ name, arguments: arguments_ })); return response.structuredContent ?? { ok: false, text: response.content }; };
  const call = async (name, arguments_ = {}) => { const result = await raw(name, arguments_); assert.equal(result?.ok, true, name + ": " + JSON.stringify(result)); return result.data; };
  await call("initialize_workspace", { format: "zane-studio.workspace/v1", scenes: [], workflows: {}, optionPresets: [], drafts: [], sceneVersions: {} });
  const definitions = []; let cursor;
  do { const page = await call("list_capabilities", { tier: "basic", limit: 2, ...(cursor ? { cursor } : {}) }); definitions.push(...page.capabilities); cursor = page.nextCursor; } while (cursor);
  assert.equal(definitions.find(item => item.id === "data.zip").usage.tier, "basic"); assert.ok(definitions.find(item => item.id === "media.select_references").outputs.some(item => item.key === "bundle"));
  const assets = [];
  for (const [index, file] of fixtureFiles.entries()) assets.push((await call("upload_asset", { createId: randomUUID(), name: "test reference " + index, kind: "image", filePath: file })).reference);
  const pkg = JSON.parse(await readFile(path.join(root, "examples/scenes/commerce-ai.json"), "utf8"));
  let draft = await call("create_scene", { scene: pkg.scene, workflow: pkg.workflow, optionPresets: [] });
  const originalRevision = draft.revision;
  draft = await call("update_scene_draft", { sceneId: pkg.scene.id, revision: draft.revision, workflow: { ...pkg.workflow, name: "isolated AI suite acceptance" } });
  assert.equal((await raw("update_scene_draft", { sceneId: pkg.scene.id, revision: originalRevision, workflow: pkg.workflow })).error.status, 409);
  await call("validate_scene_draft", { sceneId: pkg.scene.id, revision: draft.revision });
  const versionId = randomUUID(), publish = { sceneId: pkg.scene.id, revision: draft.revision, publicationId: versionId };
  await call("publish_scene", publish); assert.equal((await call("publish_scene", publish)).created, false);
  const published = await call("get_scene", { sceneId: pkg.scene.id, versionId }); assert.ok(published.inputSchema.properties.product_images); assert.ok(!Object.hasOwn(published.inputSchema.properties, "add_text")); assert.ok(!Object.hasOwn(published.inputDefaults, "add_text"));
  const values = (count = "3", testcase = "normal", withStyle = true) => ({ project_name: "isolated AI suite", product_images: assets.slice(0, 2), style_images: withStyle ? assets.slice(2) : [], product_info: "测试商品；只提供真实卖点", request: "CASE:" + testcase, image_count: count, ratio: "1:1 (Square)", seed: 0, mp: 1 });
  const observe = async runId => { for (let index = 0; index < 10; index++) { const state = await call("wait_run", { runId, timeoutSeconds: 10 }); if (["waiting", "completed", "failed", "cancelled"].includes(state.status)) return call("get_run", { runId }); } throw new Error("run did not reach a checkpoint"); };
  const approve = async run => { assert.equal(run.status, "waiting", JSON.stringify(run)); await call("review_run", { runId: run.runId, reviewId: run.pendingReview.id, action: "approve" }); return observe(run.runId); };
  const submit = async inputValues => { const runId = randomUUID(); await call("prepare_scene", { sceneId: pkg.scene.id, versionId, inputValues }); await call("submit_scene", { sceneId: pkg.scene.id, versionId, runId, inputValues }); assert.equal((await call("get_run", { runId })).runId, runId); return observe(runId); };
  const admissions = () => ({ hermes: hermesRequests.length, comfy: comfyRequests.length });
  const pre = admissions(); assert.equal((await raw("prepare_scene", { sceneId: pkg.scene.id, versionId, inputValues: values("9") })).error.status, 400); assert.deepEqual(admissions(), pre);
  let run = await submit(values()); assert.equal(run.status, "waiting", JSON.stringify(run)); assert.equal(run.pendingReview.stepId, "prompt_jobs"); assert.equal(comfyRequests.length, 0); assert.equal(hermesRequests.filter(item => item.stage === "prompt").length, 0);
  assert.equal((await raw("submit_scene", { sceneId: pkg.scene.id, versionId, runId: run.runId, inputValues: values() })).error.code, "RUN_ALREADY_EXISTS");
  assert.equal((await raw("review_run", { runId: run.runId, reviewId: randomUUID(), action: "approve" })).error.code, "REVIEW_CONFLICT");
  run = await approve(run); assert.equal(run.status, "waiting", JSON.stringify(run)); assert.equal(run.pendingReview.stepId, "sample"); assert.equal(comfyRequests.length, 1, "only the sample before approval");
  assert.equal((await raw("get_run_media_export", { runId: run.runId, outputKey: "images", stepId: "sample" })).error.code, "RUN_NOT_TERMINAL");
  run = await approve(run); assert.equal(run.pendingReview.stepId, "final"); assert.equal(comfyRequests.length, 3); run = await approve(run); assert.equal(run.status, "completed");
  assert.equal(run.steps.length, 10); assert.ok(!run.steps.some(step => ["layout", "need_text", "image_jobs"].includes(step.stepId)));
  const finalImages = run.outputs.find(output => output.key === "images").value;
  const modelImages = run.steps.find(step => step.stepId === "sample").outputs.images.concat(run.steps.find(step => step.stepId === "remaining").outputs.images);
  assert.deepEqual(finalImages.map(image => image.url), modelImages.map(image => image.url), "delivery is exactly model image bytes/URLs, without text overlay/layout/resize; API may omit internal archive file metadata");
  assert.ok(comfyRequests.every(request => request.prompt.includes("直接生成含标题、图形、背景与完整设计的最终电商成图") && request.prompt.includes("标题“测试商品”"))); const originalRun = JSON.stringify(run);
  const media = [];
  for (let offset = 0; offset < 3; offset++) { const page = await call("get_run_outputs", { runId: run.runId, outputKey: "images", includeValues: true, valueOffset: offset, valueLimit: 1 }); const output = page.outputs[0]; assert.equal(output.valuePage.total, 3); media.push(...output.mediaReferences); assert.equal(output.valuePage.hasMore, offset < 2); }
  const firstItems = await call("get_step_result", { runId: run.runId, stepId: "references", limit: 1, includeValues: true }); assert.ok(firstItems.hasMore && firstItems.nextCursor);
  const secondItems = await call("get_step_result", { runId: run.runId, stepId: "references", limit: 1, includeValues: true, cursor: firstItems.nextCursor }); assert.equal(secondItems.items[0].index, 1);
  for (const reference of media) { const response = await fetch(new URL(reference.url, base)); assert.equal(response.status, 200); assert.ok((await response.arrayBuffer()).byteLength); }
  const exported = await call("get_run_media_export", { runId: run.runId, outputKey: "images" }); assert.equal(exported.fileCount, 3); assert.equal(exported.incomplete, false); assert.equal((await fetch(base + exported.downloadUrl, { method: "HEAD" })).status, 200);
  const archive = Buffer.from(await (await fetch(base + exported.downloadUrl)).arrayBuffer()); assert.equal(archive.readUInt32LE(0), 0x04034b50); assert.ok(archive.includes(Buffer.from("manifest.json")));
  assert.equal((await fetch(base + exported.downloadUrl.replace(exported.revision, "0".repeat(64)))).status, 409);
  const changes = { rerunSteps: [{ stepId: "remaining", itemIndexes: [0] }] };
  const preview = await call("preview_rerun", { sourceRunId: run.runId, changes }); assert.equal(preview.steps.find(step => step.stepId === "sample").action, "reuse"); assert.deepEqual(preview.steps.find(step => step.stepId === "remaining").runItemIndexes, [0]);
  const beforeRerun = admissions(), rerunId = randomUUID(); await call("rerun", { sourceRunId: run.runId, runId: rerunId, changes }); let revised = await observe(rerunId); if (revised.status === "waiting") revised = await approve(revised); assert.equal(revised.status, "completed"); assert.equal(admissions().comfy, beforeRerun.comfy + 1); assert.equal(admissions().hermes, beforeRerun.hermes); assert.equal(JSON.stringify(await call("get_run", { runId: run.runId })), originalRun);
  assert.equal((await call("get_run_media_export", { runId: rerunId, outputKey: "images" })).fileCount, 3, "reused ancestor media remains exportable");
  for (const testcase of ["duplicate", "missing", "badrole", "badshape"]) { const before = admissions(); const bad = await submit(values("3", testcase)); assert.equal(bad.status, "failed", testcase); assert.equal(admissions().comfy, before.comfy); assert.equal(hermesRequests.length, before.hermes + 2, "no AIXG or render after invalid plan"); }
  for (const testcase of ["extra_images", "no_images"]) { const before = admissions(); let bad = await submit(values("3", testcase)); bad = await approve(bad); assert.equal(bad.status, "failed", JSON.stringify(bad)); assert.equal(admissions().comfy, before.comfy + 1, "sample output cardinality fails before rest"); assert.ok(testcase === "no_images" || JSON.stringify(bad).includes("要求1项媒体"), JSON.stringify(bad)); }
  const beforeSingle = admissions(); let single = await submit(values("1", "single")); single = await approve(single); single = await approve(single); single = await approve(single); assert.equal(single.status, "completed"); assert.equal(admissions().comfy, beforeSingle.comfy + 1); assert.equal(single.steps.find(step => step.stepId === "remaining").items.length, 0); assert.deepEqual(single.outputs.find(output => output.key === "images").value.map(image => image.url), single.steps.find(step => step.stepId === "sample").outputs.images.map(image => image.url), "single-item delivery preserves the original model image"); assert.equal((await call("get_run_media_export", { runId: single.runId, outputKey: "images" })).fileCount, 1);
    let noStyle = await submit(values("1", "no_style", false)); noStyle = await approve(noStyle); noStyle = await approve(noStyle); noStyle = await approve(noStyle); assert.equal(noStyle.status, "completed"); assert.equal(comfyRequests.at(-1).refs.length, 2, "empty optional style group is valid while all product images remain attached"); assert.deepEqual(comfyRequests.at(-1).refs, [hash(fixtures[0]), hash(fixtures[1])]);
  let failed = await submit(values("3", "fail_once")); failed = await approve(failed); failed = await approve(failed); assert.equal(failed.status, "failed");
  const partial = await call("get_run_media_export", { runId: failed.runId, stepId: "sample", outputKey: "images" }); assert.equal(partial.incomplete, true); assert.equal(partial.fileCount, 1);
  const beforeResume = admissions(), resumedId = randomUUID(); await call("resume_run", { sourceRunId: failed.runId, runId: resumedId }); let resumed = await observe(resumedId); if (resumed.status === "waiting") resumed = await approve(resumed); assert.equal(resumed.status, "completed"); assert.equal(admissions().hermes, beforeResume.hermes); assert.equal(admissions().comfy, beforeResume.comfy + 1, "only failed item generates on explicit resume");
  assert.equal(mockError, undefined, String(mockError));
  console.log("AI commerce smoke passed: real stdio MCP, basic-only workflow, draft conflict/publication reconciliation, all product/style references without model-authored selection (including an empty style group), plan/sample/final reviews, 3 and 1-image direct model-output paths without layout or overlays, invalid-plan no-generation, pagination, selective rerun/ancestor export, explicit failure/resume, revision ZIP/HEAD. No real models or production data.");
} finally {
  await client.close().catch(() => {});
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await bounded(exited, 12000).catch(() => { if (child.exitCode === null) child.kill("SIGKILL"); }); }
  await Promise.all([comfy, hermes].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  const target = path.resolve(temporary), boundary = path.resolve(os.tmpdir()) + path.sep;
  if (!target.startsWith(boundary) || !path.basename(target).startsWith("zane-commerce-ai-")) throw new Error("Unsafe temporary cleanup target");
  await rm(target, { recursive: true, force: true });
}
