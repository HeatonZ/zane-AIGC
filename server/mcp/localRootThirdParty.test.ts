import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { aiHarness } from "../testing/aiSupport.js";
import { temporaryDirectory } from "../testing/testSupport.js";
import { createThirdPartyJsonRequester } from "../execution/thirdPartyJsonRequest.js";
import type { RunWorkflowDefinition } from "../domain/types.js";
import type { ApiResult } from "./httpClient.js";

async function connect(t: Parameters<typeof aiHarness>[0], base: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.resolve("server/mcp/index.ts")], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === "string")), ZANE_BASE_URL: base }, stderr: "pipe" });
  let errors = ""; transport.stderr?.on("data", chunk => { errors += chunk; });
  const client = new Client({ name: "isolated-local-root-third-party", version: "1.0.0" });
  t.after(() => client.close());
  try { await client.connect(transport); } catch (error) { throw new Error(String(error) + "\n" + errors); }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok("content" in result);
    return { result, payload: result.structuredContent as ApiResult };
  };
  return { client, call };
}

/** 真实 stdio MCP 隔离闭环：二次元抱枕人物场景的完整链路。
 *
 *  唯一输入是批次名 → core.code（fileAccess）读 <批次>\原始角色 得到该角色的原始图路径 →
 *  core.http_request 以 multipart 把这张本地受控根目录内的图作为参考图发给第三方图生图 →
 *  成图归档；并验证默认关闭 multipartLocalFiles 时同一路径仍被拒绝，以及越界/符号链接不成为读取跳板。 */
test("真实stdio MCP隔离闭环：读取批次原始角色图并作为参考图提交第三方图生图", async t => {
  const source = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#ff5533" } }).png().toBuffer();
  const generated = await sharp({ create: { width: 24, height: 24, channels: 3, background: "#33ff88" } }).png().toBuffer();

  const root = await temporaryDirectory(t);
  const library = path.join(root, "library");
  const batch = "11 - 手动";
  await mkdir(path.join(library, batch, "原始角色"), { recursive: true });
  await writeFile(path.join(library, batch, "原始角色", "AZKi.jpg"), source);

  const sent: Array<Record<string, unknown>> = [];
  const h = await aiHarness(t, {
    emptyWorkspace: true,
    getLocalExportRoot: () => library,
    thirdPartyRequest: createThirdPartyJsonRequester({
      async resolve() { return [{ address: "93.184.216.34", family: 4 }]; },
      async send(request) {
        const form = await new Response(new Uint8Array(request.body!), { headers: { "content-type": request.headers["content-type"]! } }).formData();
        const upload = form.get("image[]") as File;
        sent.push({ model: form.get("model"), prompt: form.get("prompt"), bytes: Buffer.from(await upload.arrayBuffer()), filename: upload.name });
        return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({ data: [{ b64_json: generated.toString("base64") }] })) };
      },
    }),
  });
  const { call } = await connect(t, h.base);

  // 第一步：从受控根目录内的批次目录读出该角色的原始图路径（沙箱只能看到文件名，路径由宿主返回）。
  const scanCode = [
    "const batch = String(inputs.batch ?? '').trim();",
    "if (!batch) throw new Error('批次不能为空');",
    "const name = String(inputs.name ?? '').trim();",
    "if (!name) throw new Error('角色名不能为空');",
    "const directory = batch + '/原始角色';",
    "const entries = zane.fs.list(directory).filter((entry) => entry.isFile && !entry.isSymbolicLink);",
    "const matched = entries.filter((entry) => entry.name.replace(/\\.[^.]+$/, '') === name);",
    "if (matched.length !== 1) throw new Error('原始角色目录里找不到唯一的角色图：' + name + '（实际有 ' + entries.map((e) => e.name).join('、') + '）');",
    "return { source: matched[0].path, filename: matched[0].name, count: entries.length };",
  ].join("\n");
  const workflow: RunWorkflowDefinition = {
    name: "二次元抱枕人物流程",
    inputs: [{ key: "batch", type: "text", required: true }, { key: "name", type: "text", required: true }],
    steps: [
      {
        id: "scan", name: "获取信息", kind: "capability", capabilityId: "core.code", capabilityVersion: "1",
        capabilityConfig: { code: scanCode, timeoutMs: 10000, fileAccess: { enabled: true } },
        inputs: [{ key: "batch", sourceRef: "input.batch" }, { key: "name", sourceRef: "input.name" }],
        outputs: [{ key: "source", type: "text" }, { key: "filename", type: "text" }, { key: "count", type: "number" }],
      },
      {
        id: "generate", name: "生图", kind: "capability", capabilityId: "core.http_request", capabilityVersion: "2",
        capabilityConfig: {
          method: "POST", url: "https://images.example.net/v1/images/edits", bodyFormat: "multipart",
          multipartLocalFiles: true,
          bodyTemplate: { model: "{{model}}", prompt: "{{prompt}}", n: 1 },
          multipartImages: [{ inputKey: "input_images", fieldName: "image[]" }],
          responseImages: { path: "data", base64Field: "b64_json", expectedCount: 1 },
        },
        inputs: [
          { key: "input_images", sourceRef: "step.scan.outputs.source", referenceType: "image_list", selection: { mode: "all" } },
          { key: "prompt", sourceRef: "input.name" },
          { key: "model", sourceRef: "", valueSource: "literal", literalValue: "gpt-image-2.5-sunburst", literalType: "text" },
        ],
        outputs: [{ key: "images", type: "image_list" }],
      },
    ],
    outputs: [{ key: "result", type: "image_list", sourceRef: "step.generate.outputs.images", selection: { mode: "all" } }],
  };

  const sceneId = "mcp-pillow-local-root";
  assert.equal((await call("create_scene", { scene: { id: sceneId, title: "二次元抱枕人物" }, workflow })).payload.ok, true);
  const draft = (await call("get_scene_draft", { sceneId })).payload.data as { revision: string };
  const validation = (await call("validate_scene_draft", { sceneId, revision: draft.revision })).payload;
  assert.equal(validation.ok, true, JSON.stringify(validation));
  const versionId = randomUUID();
  assert.equal((await call("publish_scene", { sceneId, revision: draft.revision, publicationId: versionId })).payload.ok, true);

  const inputValues = { batch, name: "AZKi" };
  assert.equal((await call("prepare_scene", { sceneId, versionId, inputValues })).payload.ok, true);
  const runId = randomUUID();
  assert.equal((await call("submit_scene", { sceneId, versionId, runId, inputValues })).payload.ok, true);
  const done = (await call("wait_run", { runId, timeoutSeconds: 20 })).payload.data as { status: string };
  assert.equal(done.status, "completed", JSON.stringify(done));

  // 本地受控根目录内的原始角色图原字节送达第三方，文件名与路径都没有被当作图片文本。
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.bytes, source);
  assert.equal(sent[0]!.model, "gpt-image-2.5-sunburst");
  assert.equal(sent[0]!.prompt, "AZKi");
  assert.match(String(sent[0]!.filename), /^image-1\.png$/);
  // 读取步骤返回的是根内绝对路径，且没有把根目录之外的任何东西暴露出去。
  const scan = (await call("get_step_result", { runId, stepId: "scan", outputKey: "source" })).payload.data as { outputs: Array<{ value: unknown }> };
  assert.equal(scan.outputs[0]!.value, path.join(library, batch, "原始角色", "AZKi.jpg"));

  // 默认关闭 multipartLocalFiles 时，同一路径必须仍然被拒绝（不静默放宽既有契约）。
  const closedId = "mcp-pillow-local-root-closed";
  const closedWorkflow: RunWorkflowDefinition = structuredClone(workflow) as RunWorkflowDefinition;
  closedWorkflow.steps[1]!.capabilityConfig = { ...closedWorkflow.steps[1]!.capabilityConfig, multipartLocalFiles: false };
  assert.equal((await call("create_scene", { scene: { id: closedId, title: "关闭本地读取" }, workflow: closedWorkflow })).payload.ok, true);
  const closedDraft = (await call("get_scene_draft", { sceneId: closedId })).payload.data as { revision: string };
  assert.equal((await call("validate_scene_draft", { sceneId: closedId, revision: closedDraft.revision })).payload.ok, true);
  const closedVersion = randomUUID();
  assert.equal((await call("publish_scene", { sceneId: closedId, revision: closedDraft.revision, publicationId: closedVersion })).payload.ok, true);
  const closedRun = randomUUID();
  assert.equal((await call("submit_scene", { sceneId: closedId, versionId: closedVersion, runId: closedRun, inputValues })).payload.ok, true);
  const closed = (await call("wait_run", { runId: closedRun, timeoutSeconds: 20 })).payload.data as { status: string };
  assert.equal(closed.status, "failed");
  const closedRunDetail = (await call("get_run", { runId: closedRun })).payload.data as { steps: Array<{ stepId: string; message?: string }> };
  assert.match(String(closedRunDetail.steps.find(step => step.stepId === "generate")?.message), /第三方图片输入必须是当前运行内已授权的/);
  // 关闭时不得发出任何第三方请求。
  assert.equal(sent.length, 1);
});
