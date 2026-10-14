import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { aiHarness } from "../testing/aiSupport.js";
import { temporaryDirectory } from "../testing/testSupport.js";
import { createRuntimeMediaValue } from "../runtimeValue.js";
import type { ApiResult } from "./httpClient.js";

async function connect(t: Parameters<typeof aiHarness>[0], base: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.resolve("server/mcp/index.ts")], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === "string")), ZANE_BASE_URL: base }, stderr: "pipe" });
  let errors = ""; transport.stderr?.on("data", chunk => { errors += chunk; });
  const client = new Client({ name: "isolated-local-file-access", version: "1.0.0" });
  t.after(() => client.close());
  try { await client.connect(transport); } catch (error) { throw new Error(String(error) + "\n" + errors); }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok("content" in result);
    return { result, payload: result.structuredContent as ApiResult };
  };
  return { client, call };
}

/** 真实 stdio MCP 隔离闭环：core.code 的 fileAccess 与 localExport 经 MCP 提交后真实读写。
 *  覆盖业务关键链路：唯一输入是批次号 → 代码读 <批次>\角色 得到角色名与参考图 → 生图 →
 *  按角色名把结果写回固定目录；并验证越界读取经 MCP 仍然失败。 */
test("真实stdio MCP隔离闭环：core.code按文件名读批次目录并按角色名写回固定目录", async t => {
  const root = await temporaryDirectory(t);
  const library = path.join(root, "library");
  // 批次目录：固定两张参考图 + 角色子目录；角色名只来自文件名，不由场景输入提供。
  const batch = path.join(library, "11");
  await mkdir(path.join(batch, "角色"), { recursive: true });
  await writeFile(path.join(batch, "1.jpg"), "ref-one");
  await writeFile(path.join(batch, "2.png"), "ref-two");
  await writeFile(path.join(batch, "角色", "AZKi.png"), "char-azki");
  await writeFile(path.join(batch, "角色", "ちびムーン.png"), "char-moon");
  // 动作集合：多行文本，含空行与 \r\n，模拟真实手写的动作清单。
  await writeFile(path.join(batch, "动作.txt"), "第一条动作\n\n第二条动作\r\n第三条动作\n", "utf8");

  // 假生图执行器：把归档媒体写进本运行归档目录（等价于 ComfyUI 产出后归档的形状）。
  const produced = ["generated-1.png", "generated-2.png"];
  const h = await aiHarness(t, {
    emptyWorkspace: true,
    getLocalExportRoot: () => library,
    executor: {
      kind: "image-producer",
      async execute(context) {
        const directory = path.join(context.artifacts.directory, "outputs", "media");
        await mkdir(directory, { recursive: true });
        for (const filename of produced) await writeFile(path.join(directory, filename), "bytes-" + filename);
        return { images: createRuntimeMediaValue("image", produced.map(filename => ({ url: "/api/v1/runs/" + context.runId + "/media/" + filename }))) as unknown as never };
      },
    },
  });
  const { call } = await connect(t, h.base);

  const sceneId = "mcp-local-file-access";
  // 第一步：唯一输入是批次号。代码读 <批次>\角色 推导角色名，读批次目录得到参考图，并按序号配对生成计划。
  const scanCode = [
    "const batch = String(inputs.batch ?? '').trim();",
    "if (!batch) throw new Error('批次不能为空');",
    "const characters = zane.fs.list(batch + '/角色').filter((entry) => entry.isFile).map((entry) => entry.name);",
    "const references = zane.fs.list(batch).filter((entry) => entry.isFile && /\\.(png|jpe?g|webp)$/i.test(entry.name)).map((entry) => entry.name).sort();",
    "const missing = zane.fs.stat(batch + '/角色/不存在.png');",
    // 动作集合按文本读取：取第 2 行非空动作，验证 readText 也能经 MCP 到业务服务。
    "const actions = zane.fs.readText(batch + '/动作.txt').split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);",
    "return { characters, references, missing, actions };",
  ].join("\n");
  const exportCode = [
    "const images = inputs.images ?? [];",
    "const names = inputs.characters ?? [];",
    "if (images.length !== names.length) throw new Error('生图数量与角色数量不一致');",
    "return { plan: { items: images.map(function (item, index) { return { source: item.filename, target: '11/结果/' + names[index] }; }) } };",
  ].join("\n");
  const workflow = {
    name: "按批次读取并写回",
    inputs: [{ key: "batch", label: "批次", type: "text", required: true }],
    steps: [
      { id: "scan", name: "读取批次", kind: "capability", capabilityId: "core.code", capabilityVersion: "1",
        capabilityConfig: { code: scanCode, timeoutMs: 10000, fileAccess: { enabled: true } },
        inputs: [{ key: "batch", sourceRef: "input.batch" }],
        outputs: [{ key: "characters", type: "json" }, { key: "references", type: "json" }, { key: "missing", type: "json" }, { key: "actions", type: "json" }] },
      { id: "generate", name: "生图", kind: "image-producer", inputs: [], outputs: [{ key: "images", type: "image_list" }] },
      { id: "export", name: "按角色名写回", kind: "capability", capabilityId: "core.code", capabilityVersion: "1",
        capabilityConfig: { code: exportCode, timeoutMs: 10000, localExport: { enabled: true, planKey: "plan" } },
        inputs: [{ key: "images", sourceRef: "step.generate.outputs.images", referenceType: "image_list" }, { key: "characters", sourceRef: "step.scan.outputs.characters" }],
        outputs: [{ key: "plan", type: "json" }, { key: "local_export", type: "json", required: false }] },
    ],
    outputs: [{ key: "characters", type: "json", sourceRef: "step.scan.outputs.characters" }, { key: "references", type: "json", sourceRef: "step.scan.outputs.references" }],
  };
  assert.equal((await call("create_scene", { scene: { id: sceneId, title: "按批次读取并写回" }, workflow })).payload.ok, true);
  const draft = (await call("get_scene_draft", { sceneId })).payload.data as { revision: string };
  const validation = (await call("validate_scene_draft", { sceneId, revision: draft.revision })).payload;
  assert.equal(validation.ok, true, JSON.stringify(validation));
  const versionId = randomUUID();
  assert.equal((await call("publish_scene", { sceneId, revision: draft.revision, publicationId: versionId })).payload.ok, true);

  const inputValues = { batch: "11" };
  assert.equal((await call("prepare_scene", { sceneId, versionId, inputValues })).payload.ok, true);
  const runId = randomUUID();
  assert.equal((await call("submit_scene", { sceneId, versionId, runId, inputValues })).payload.ok, true);
  const done = (await call("wait_run", { runId, timeoutSeconds: 20 })).payload.data as { status: string };
  assert.equal(done.status, "completed", JSON.stringify(done));

  // 角色名只可能来自目录读取：文件名字节原样保留（大小写与中文）。
  const outputs = (await call("get_run_outputs", { runId, includeValues: true })).payload.data as { outputs: Array<{ key: string; value: unknown }> };
  assert.deepEqual(outputs.outputs.find(item => item.key === "characters")?.value, ["AZKi.png", "ちびムーン.png"]);
  assert.deepEqual(outputs.outputs.find(item => item.key === "references")?.value, ["1.jpg", "2.png"]);
  // stat 对不存在的路径返回 exists:false，而不是抛错。
  const scan = (await call("get_step_result", { runId, stepId: "scan", outputKey: "missing" })).payload.data as { outputs: Array<{ value: unknown }> };
  assert.equal((scan.outputs[0]?.value as { exists: boolean }).exists, false);
  // readText 经 MCP 读到动作文本：空行与 \r\n 都被正确处理（这就是「随机挑一行」的取数来源）。
  const actions = (await call("get_step_result", { runId, stepId: "scan", outputKey: "actions" })).payload.data as { outputs: Array<{ value: unknown }> };
  assert.deepEqual(actions.outputs[0]?.value, ["第一条动作", "第二条动作", "第三条动作"]);

  // 真实写盘：文件名是角色名，落在固定目录。
  assert.equal((await readFile(path.join(batch, "结果", "AZKi.png"))).toString(), "bytes-generated-1.png");
  assert.equal((await readFile(path.join(batch, "结果", "ちびムーン.png"))).toString(), "bytes-generated-2.png");
  // 读取步骤不得改写输入素材。
  assert.equal((await readFile(path.join(batch, "角色", "AZKi.png"))).toString(), "char-azki");

  // 越界读取：经 MCP 提交同样失败，沙箱拿不到根目录之外的任何东西。
  const outsideId = "mcp-local-file-outside";
  assert.equal((await call("create_scene", { scene: { id: outsideId, title: "越界读取" }, workflow: {
    name: "越界读取", inputs: [], steps: [
      { id: "scan", name: "越界读取", kind: "capability", capabilityId: "core.code", capabilityVersion: "1",
        capabilityConfig: { code: "zane.fs.list('../outside');\nreturn { value: 'never' };", fileAccess: { enabled: true } },
        inputs: [], outputs: [{ key: "value", type: "text" }] },
    ], outputs: [{ key: "value", type: "text", sourceRef: "step.scan.outputs.value" }],
  } })).payload.ok, true);
  const outsideDraft = (await call("get_scene_draft", { sceneId: outsideId })).payload.data as { revision: string };
  assert.equal((await call("validate_scene_draft", { sceneId: outsideId, revision: outsideDraft.revision })).payload.ok, true);
  const outsideVersion = randomUUID();
  assert.equal((await call("publish_scene", { sceneId: outsideId, revision: outsideDraft.revision, publicationId: outsideVersion })).payload.ok, true);
  const outsideRun = randomUUID();
  assert.equal((await call("submit_scene", { sceneId: outsideId, versionId: outsideVersion, runId: outsideRun, inputValues: {} })).payload.ok, true);
  const failed = (await call("wait_run", { runId: outsideRun, timeoutSeconds: 20 })).payload.data as { status: string };
  assert.equal(failed.status, "failed");
  const failedRun = (await call("get_run", { runId: outsideRun })).payload.data as { steps: Array<{ stepId: string; message?: string }> };
  assert.match(String(failedRun.steps.find(step => step.stepId === "scan")?.message), /FILE_OUTSIDE_ROOT|受控根目录/);
});
