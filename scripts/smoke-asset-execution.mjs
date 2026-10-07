/** Authenticated compiled backend + real stdio MCP + loopback mock AIXG and ComfyUI.
 * Optional --fixture reads an explicitly supplied local image only; all writes
 * remain isolated. Never calls a real model, Gateway or real ComfyUI. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "zane-asset-execution-smoke-"));
const project = path.join(temporary, "project"); await mkdir(project);
const option = name => { const index = process.argv.indexOf(name); if (index < 0) return undefined; const value = process.argv[index + 1]; if (!value || value.startsWith("--")) throw new Error("Missing " + name); return value; };
const fixture = option("--fixture"), fixtureAssetId = option("--asset-id"), expectedFixtureHash = option("--fixture-sha256");
if (fixture && !path.isAbsolute(fixture)) throw new Error("Fixture must be an explicit absolute local path");
const proof = path.join(root, ".local", fixture ? "hermes-asset-proof" : "asset-media-proof"); await mkdir(proof, { recursive: true });
const first = fixture ? await readFile(fixture) : Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xv1EAAAAASUVORK5CYII=", "base64");
const fixtureHash = createHash("sha256").update(first).digest("hex");
if (expectedFixtureHash) assert.equal(fixtureHash, expectedFixtureHash, "requested fixed-version fixture hash");
const second = Buffer.concat([first, Buffer.from("version-two-test-fixture")]);
const fileOne = path.join(temporary, "reference-one.png"); await writeFile(fileOne, first);
const fileTwo = path.join(temporary, "reference-two.png"); await writeFile(fileTwo, second);
const uploads = [], prompts = [], upstreamCredentials = [], clients = [], hermesInputs = [], hermesCredentials = [];
const hermesRuns = new Map();
let child, exited, logs = "", promptSequence = 0, mockError;
const bounded = async (promise, ms = 25000) => {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Asset execution smoke timeout\n" + logs.slice(-3000))), ms); })]); }
  finally { clearTimeout(timer); }
};
const graph = { "1": { class_type: "ImageConsumer", inputs: { images: null, prompt: "old", negative_prompt: "old" } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } } };
const comfy = createServer(async (req, res) => {
  upstreamCredentials.push({ authorization: req.headers.authorization, cookie: req.headers.cookie });
  const url = new URL(req.url, "http://mock.invalid");
  const json = (data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
  try {
    if (url.pathname.startsWith("/api/userdata/") || url.pathname.startsWith("/userdata/")) return json(graph);
    if (url.pathname.startsWith("/object_info/")) {
      const type = decodeURIComponent(url.pathname.split("/").at(-1));
      return json({ [type]: { input: { required: { images: ["IMAGE"], prompt: ["STRING"], negative_prompt: ["STRING"] } }, output: ["IMAGE"] } });
    }
    if (url.pathname === "/upload/image") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = new Request("http://mock.invalid/upload/image", { method: "POST", headers: req.headers, body: Buffer.concat(chunks) });
      const form = await request.formData(); const image = form.get("image");
      assert.ok(image instanceof Blob); const bytes = Buffer.from(await image.arrayBuffer());
      const name = "uploaded-" + uploads.length + ".png"; uploads.push({ name, bytes });
      return json({ name, subfolder: "zane-studio", type: "input" });
    }
    if (url.pathname === "/prompt") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8")); prompts.push(data.prompt);
      return json({ prompt_id: "mock-" + (++promptSequence) });
    }
    if (url.pathname.startsWith("/history/")) {
      const id = url.pathname.split("/").at(-1);
      return json({ [id]: { status: { completed: true, status_str: "success" }, outputs: { "2": { images: [{ filename: "fixture-one.png", subfolder: "", type: "output" }, { filename: "fixture-two.png", subfolder: "", type: "output" }] } } } });
    }
    if (url.pathname === "/view") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(first); }
    return json({ error: "unexpected mock route: " + url.pathname }, 404);
  } catch (error) { mockError = error; json({ error: String(error) }, 500); }
});
await new Promise(resolve => comfy.listen(0, "127.0.0.1", resolve));
const comfyBase = "http://127.0.0.1:" + comfy.address().port;
const hermes = createServer(async (req, res) => {
  hermesCredentials.push({ authorization: req.headers.authorization, cookie: req.headers.cookie });
  res.setHeader("Content-Type", "application/json");
  try {
    assert.equal(req.headers.authorization, "Bearer isolated-hermes-only");
    assert.equal(req.headers.cookie, undefined);
    if (req.method === "POST" && req.url === "/p/aixg/v1/runs") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const content = data.input[0].content;
      assert.ok(Array.isArray(content), "AIXG receives structured multimodal content");
      for (const image of content.filter(part => part.type === "image_url")) assert.match(image.image_url.url, /^data:image\/[^;]+;base64,/);
      hermesInputs.push(content);
      const runId = randomUUID(); hermesRuns.set(runId, JSON.stringify({ prompt: "isolated-edit-prompt" }));
      return res.end(JSON.stringify({ run_id: runId, status: "queued" }));
    }
    const runId = /^\/p\/aixg\/v1\/runs\/([^/]+)$/.exec(req.url)?.[1];
    if (req.method === "GET" && hermesRuns.has(runId)) return res.end(JSON.stringify({ run_id: runId, status: "completed", output: hermesRuns.get(runId) }));
    res.statusCode = 404; res.end(JSON.stringify({ error: "unexpected mock Hermes route" }));
  } catch (error) { mockError = error; res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }
});
await new Promise(resolve => hermes.listen(0, "127.0.0.1", resolve));
const hermesBase = "http://127.0.0.1:" + hermes.address().port;
try {
  child = spawn(process.execPath, [path.join(root, "dist-server/index.js"), "--production"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZANE_PUBLIC_USER_PORT: "", ZANE_ADMIN_TOKEN: "", ZANE_API_TOKEN: "", API_HOST: "127.0.0.1", API_PORT: "0", APP_DATA_DIR: path.join(temporary, "data"), ZANE_PROJECT_DIR: project, HERMES_HOME: path.join(temporary, "no-hermes"), COMFYUI_BASE_URL: comfyBase, HERMES_API_BASE_URL: hermesBase, HERMES_API_KEY: "isolated-hermes-only", HERMES_RETRY_ATTEMPTS: "0", ZANE_SHUTDOWN_TIMEOUT_MS: "1000" } });
  exited = new Promise(resolve => child.once("exit", resolve));
  const base = await bounded(new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", code => reject(new Error("Backend exited " + code + "\n" + logs)));
    child.stderr.on("data", chunk => logs += chunk); child.stdout.on("data", chunk => { logs += chunk; const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs); if (match) resolve(match[1]); });
  }));
  const http = async (route, token = "", body) => fetch(base + route, { method: body === undefined ? "GET" : "POST", headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const password = "isolated-asset-execution-password";
  const setup = await http("/api/auth/setup", "", { userId: randomUUID(), username: "assetadmin", displayName: "素材执行测试", password, role: "admin" }); assert.equal(setup.status, 201);
  const adminToken = /zane_session=([^;]+)/.exec(setup.headers.get("set-cookie"))[1];
  async function connect(token) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist-server/mcp/index.js")], cwd: root, env: { ...process.env, ZANE_BASE_URL: base, ZANE_API_TOKEN: token }, stderr: "pipe" });
    transport.stderr?.on("data", chunk => logs += chunk);
    const client = new Client({ name: "asset-execution-smoke", version: "1" }); clients.push(client); await bounded(client.connect(transport));
    const raw = async (name, args = {}) => (await bounded(client.callTool({ name, arguments: args }))).structuredContent;
    return { client, raw, call: async (name, args = {}) => { const result = await raw(name, args); assert.ok(result?.ok, name + ": " + JSON.stringify(result)); return result.data; } };
  }
  const admin = await connect(adminToken);
  await admin.call("initialize_workspace", { format: "zane-studio.workspace/v1", scenes: [], workflows: {}, optionPresets: [], drafts: [], sceneVersions: {} });
  const assetId = fixtureAssetId ?? randomUUID();
  // Deliberately discard the mutation receipt; reconcile the same pre-saved ID.
  await admin.client.callTool({ name: "upload_asset", arguments: { createId: assetId, name: "参考素材", kind: "image", filePath: fileOne } });
  const original = await admin.call("get_asset", { assetId }); assert.equal(original.reference.assetVersion, 1);
  const changed = await admin.call("upload_asset", { assetId, revision: original.asset.revision, name: "参考素材新版", kind: "image", filePath: fileTwo }); assert.equal(changed.reference.assetVersion, 2);
  assert.equal((await admin.raw("update_asset", { assetId, revision: original.asset.revision, name: "旧revision" })).error.code, "ASSET_CONFLICT");
  const versions = await admin.call("list_asset_versions", { assetId, limit: 1 }); assert.equal(versions.versions[0].version, 2); assert.equal(versions.hasMore, true);
  const last = await admin.call("list_asset_versions", { assetId, limit: 1, cursor: versions.nextCursor }); assert.equal(last.versions[0].version, 1); assert.equal(last.hasMore, false);
  const media = base + original.reference.previewUrl;
  for (const method of ["GET", "HEAD"]) assert.equal((await fetch(media, { method, headers: { Range: "bytes=0-3" } })).status, 401, "media auth must not be disabled");
  assert.equal((await fetch(media, { headers: { Authorization: "Bearer " + adminToken, Range: "bytes=0-3" } })).status, 206);
  const scene = { id: "asset-execution", title: "受保护素材内部执行", summary: "仅loopback mock，不调用模型" };
  const workflow = { sceneId: scene.id, name: scene.title, inputs: [{ key: "images", label: "参考图", type: "image_list", required: true }], steps: [{ id: "comfy", name: "ComfyUI参考图", kind: "comfyui", inputs: [{ key: "images", sourceRef: "input.images" }], outputs: [{ key: "images", type: "image_list" }], comfyui: { workflowFile: "isolated.json", bindings: [{ key: "images", direction: "input", nodeId: "1", property: "images", type: "image_list", sourceRef: "input.images", required: true }, { key: "images", direction: "output", nodeId: "2", property: "images", type: "image_list" }] } }], outputs: [{ key: "images", type: "image_list", sourceRef: "step.comfy.outputs.images" }] };
  workflow.inputs.push({ key: "edit_instruction", type: "text", required: true, defaultValue: "根据同一张参考图生成编辑提示词" }, { key: "negative_prompt", type: "text", defaultValue: "保留参考图主体" });
  workflow.steps.unshift({ id: "aixg", name: "AIXG参考图提示词", kind: "hermes", hermesProfile: "aixg", promptTemplate: "读取有序参考图，并按照编辑要求返回prompt。", inputs: [{ key: "images", label: "参考图片", sourceRef: "input.images" }, { key: "edit_instruction", sourceRef: "input.edit_instruction" }], outputs: [{ key: "prompt", type: "text" }] });
  workflow.steps[1].inputs.push({ key: "prompt", sourceRef: "step.aixg.outputs.prompt" }, { key: "negative_prompt", sourceRef: "input.negative_prompt" });
  workflow.steps[1].comfyui.bindings.push({ key: "prompt", direction: "input", nodeId: "1", property: "prompt", type: "text", sourceRef: "step.aixg.outputs.prompt", required: true }, { key: "negative_prompt", direction: "input", nodeId: "1", property: "negative_prompt", type: "text", sourceRef: "input.negative_prompt" });
  const created = await admin.call("create_scene", { scene, workflow }); const publicationId = randomUUID(); await admin.call("publish_scene", { sceneId: scene.id, revision: created.revision, publicationId });
  const selected = await admin.call("get_scene", { sceneId: scene.id, versionId: publicationId });
  const mediaExecution = selected.inputRequirements[0].mediaExecution;
  assert.equal(mediaExecution.forwardsWorkbenchCredentials, false);
  assert.deepEqual(mediaExecution.imageConsumers, {
    source: "same_authorized_fixed_version_private_run_copy",
    hermes: "private_image_bytes_to_inline_data_url",
    comfyui: "private_image_bytes_to_upload_in_reference_order",
    hermesSizePolicy: "existing_inline_budget_may_resize_without_reselecting_asset_version",
  });
  const openapiResponse = await http("/api/v1/ai/openapi.json", adminToken); assert.equal(openapiResponse.status, 200);
  const openapi = await openapiResponse.json();
  assert.deepEqual(openapi["x-asset-media-execution"], mediaExecution, "HTTP and real MCP share the image consumer contract");
  assert.deepEqual(openapi.components.schemas.MediaExecutionAccess.const, mediaExecution);
  const images = [original.reference, changed.reference, { url: media.replace("127.0.0.1", "localhost"), filename: "not-a-comfy-file.png", type: "output", path: "spoof" }, original.reference.previewUrl];
  const prepared = await admin.call("prepare_scene", { sceneId: scene.id, versionId: publicationId, inputValues: { images } }); assert.equal(prepared.valid, true); assert.deepEqual(prepared.inputRequirements[0].mediaExecution, mediaExecution); assert.equal(prepared.externalServicesChecked, false); assert.equal(uploads.length, 0); assert.equal(prompts.length, 0); assert.equal(hermesInputs.length, 0);
  const bad = await admin.raw("prepare_scene", { sceneId: scene.id, versionId: publicationId, inputValues: { images: [media.replace("/versions/1/", "/versions/99/")] } }); assert.equal(bad.error.code, "INVALID_ASSET_REFERENCE");
  assert.equal((await admin.call("list_runs")).runs.length, 0);
  const runId = randomUUID();
  await admin.client.callTool({ name: "submit_scene", arguments: { sceneId: scene.id, versionId: publicationId, inputValues: { images }, runId } });
  const waited = await admin.call("wait_run", { runId, timeoutSeconds: 10 }); assert.equal(waited.status, "completed", JSON.stringify(waited));
  const run = await admin.call("get_run", { runId }); assert.deepEqual(run.inputValues.images.map(item => item.assetVersion), [1, 2, 1, 1]);
  assert.equal((await admin.raw("submit_scene", { sceneId: scene.id, versionId: publicationId, inputValues: { images }, runId })).error.code, "RUN_ALREADY_EXISTS");
  assert.equal((await admin.call("list_runs")).runs.length, 1);
  // Uploads are concurrent; verify the binding order in the final graph, not HTTP arrival order.
  const boundImages = Object.values(prompts[0]).filter(node => node.class_type === "LoadImage").map(node => uploads.find(item => item.name === node.inputs.image.split("/").at(-1)).bytes);
  assert.deepEqual(boundImages.map(bytes => createHash("sha256").update(bytes).digest("hex")), [first, second, first, first].map(bytes => createHash("sha256").update(bytes).digest("hex")));
  const aixgImages = hermesInputs[0].filter(part => part.type === "image_url").map(part => Buffer.from(part.image_url.url.split(",")[1], "base64"));
  assert.deepEqual(aixgImages.map(bytes => createHash("sha256").update(bytes).digest("hex")), boundImages.map(bytes => createHash("sha256").update(bytes).digest("hex")), "AIXG and ComfyUI receive the same ordered fixed-version reference bytes");
  assert.equal(hermesInputs.length, 1); assert.deepEqual(run.steps.map(step => step.status), ["completed", "completed"]);
  assert.equal(prompts[0]["1"].inputs.prompt, "isolated-edit-prompt"); assert.equal(prompts[0]["1"].inputs.negative_prompt, "保留参考图主体");
  assert.equal(prompts.length, 1); assert.equal(Object.values(prompts[0]).filter(node => node.class_type === "LoadImage").length, 4);
  const outputs = await admin.call("get_run_outputs", { runId, outputKey: "images", valueOffset: 0, valueLimit: 1 }); assert.equal(outputs.outputs[0].value.length, 1);
  const outputsNext = await admin.call("get_run_outputs", { runId, outputKey: "images", valueOffset: 1, valueLimit: 1 }); assert.equal(outputsNext.outputs[0].value.length, 1);
  const userId = randomUUID(); await admin.call("create_user", { userId, username: "assetuser", displayName: "素材用户", password }); await admin.call("set_user_scene_access", { userId, revision: 1, sceneIds: [scene.id] });
  const login = await http("/api/auth/login", "", { username: "assetuser", password }); const userToken = /zane_session=([^;]+)/.exec(login.headers.get("set-cookie"))[1];
  const user = await connect(userToken); const ownId = randomUUID(); const own = await user.call("upload_own_asset", { assetId: ownId, name: "本人附件", kind: "image", filePath: fileOne });
  const ownRecord = await user.call("get_own_asset", { assetId: ownId }); assert.equal(ownRecord.reference.assetId, ownId);
  assert.equal((await fetch(media, { headers: { Authorization: "Bearer " + userToken } })).status, 404);
  assert.equal((await user.raw("prepare_own_scene", { sceneId: scene.id, versionId: publicationId, inputValues: { images: [media] } })).error.code, "INVALID_USER_MEDIA");
  assert.equal((await user.raw("prepare_own_scene", { sceneId: scene.id, versionId: publicationId, inputValues: { images: [original.reference] } })).error.code, "OBJECT_NOT_FOUND");
  const ownRunId = randomUUID(); await user.call("submit_own_scene", { sceneId: scene.id, versionId: publicationId, inputValues: { images: [ownRecord.reference] }, runId: ownRunId });
  assert.equal((await user.call("wait_own_run", { runId: ownRunId, timeoutSeconds: 10 })).status, "completed");
  assert.equal(uploads.length, 5); assert.equal(prompts.length, 2); assert.equal(hermesInputs.length, 2); assert.ok(hermesCredentials.every(headers => headers.authorization !== "Bearer " + adminToken && headers.authorization !== "Bearer " + userToken)); assert.ok(upstreamCredentials.every(headers => headers.authorization === undefined && headers.cookie === undefined)); assert.equal(mockError, undefined);
  const acceptance = { status: "passed", contractVersion: openapi.info.version, imageConsumers: mediaExecution.imageConsumers, isolated: true, compiledBackend: true, realStdioMcp: true, mockComfyui: true, mockAixg: true, actualEphemeralPort: true, sourceFixture: { suppliedReadOnly: Boolean(fixture), assetId, assetVersion: 1, bytes: first.length, sha256: fixtureHash }, aixgReferenceHashes: aixgImages.map(bytes => createHash("sha256").update(bytes).digest("hex")), comfyReferenceHashes: boundImages.map(bytes => createHash("sha256").update(bytes).digest("hex")), productionRunExecuted: false, externalGeneration: false, formalServiceSwitched: false, hermesGatewayRestarted: false, comfyUiRestarted: false, runId, assetId, publicationId, temporary, checks: ["HTTP-and-real-MCP-share-image-consumer-contract", "fixed-asset-to-AIXG-multimodal-to-ComfyUI", "identical-ordered-reference-byte-hashes", "writer-prompt-reaches-comfy-negative-unchanged", "401-media-remains-protected", "same-service-fixed-version-URL-and-reference-resolution", "ordered-upload-bytes", "no-workbench-credential-forwarding", "preflight-no-upstream-or-enqueue", "invalid-version-rejected", "stale-asset-revision-rejected", "version-and-output-pagination", "lost-receipt-same-run-and-asset-ID-reconciliation", "user-owned-attachment-execution", "cross-user-and-raw-URL-rejected"] };
  await writeFile(path.join(proof, "acceptance.json"), JSON.stringify(acceptance, null, 2) + "\n"); console.log(JSON.stringify(acceptance, null, 2));
} finally {
  for (const client of clients) await client.close().catch(() => {});
  // This handle was spawned by this test with an isolated data directory; no production PID lookup.
  if (child && child.exitCode === null) { child.kill("SIGTERM"); try { await bounded(exited, 6000); } catch { child.kill("SIGKILL"); await bounded(exited, 3000); } }
  comfy.closeAllConnections(); await new Promise(resolve => comfy.close(resolve));
  hermes.closeAllConnections(); await new Promise(resolve => hermes.close(resolve));
  await writeFile(path.join(proof, "backend.log"), logs);
}
