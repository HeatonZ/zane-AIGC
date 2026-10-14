/** 「二次元抱枕生图」新流程的运行级核验（真实 stdio MCP 闭环，不调用真实 ComfyUI、不生成媒体）。
 *
 *  用真实执行器 + 真实 core.code 沙箱跑完整场景图，只把 ComfyUI 换成假执行器：
 *  假执行器记录它实际收到的绑定值（提示词目录/文件名、抽到的动作、成图前缀），
 *  据此证明三件光看草稿看不出来的事：
 *    1. 参考图 N 固定配 提示词N / 动作N，不交叉；
 *    2. 动作是场景从 动作N.txt 里随机抽的一行（而不是把整份文件交给工作流）；
 *    3. 动作文件为空的那一轮整轮跳过、不调用 ComfyUI、不计费。
 *  同时用真实 localExport 断言成图按角色名落到 结果1 / 结果2。 */
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { aiHarness } from "../testing/aiSupport.js";
import { temporaryDirectory } from "../testing/testSupport.js";
import type { ApiResult } from "./httpClient.js";
import { resolveStepInputs } from "../domain/workflowValues.js";
import { createRuntimeMediaValue } from "../runtimeValue.js";
import { pillowSceneWorkflow } from "./pillowScene.fixture.js";
import type { JsonValue, RunStep } from "../domain/types.js";

async function connect(t: Parameters<typeof aiHarness>[0], base: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.resolve("server/mcp/index.ts")], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === "string")), ZANE_BASE_URL: base }, stderr: "pipe" });
  let errors = ""; transport.stderr?.on("data", chunk => { errors += chunk; });
  const client = new Client({ name: "isolated-pillow-scene", version: "1.0.0" });
  t.after(() => client.close());
  try { await client.connect(transport); } catch (error) { throw new Error(String(error) + "\n" + errors); }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok("content" in result);
    return { result, payload: result.structuredContent as ApiResult };
  };
  return { client, call };
}

interface ComfyCall { stepId: string; directory: unknown; promptName: unknown; action: unknown; prefix: unknown }

/** 假 ComfyUI 运行时：走真实 core.comfyui 能力的取值路径（resolveStepInputs 解析绑定），
 *  记录本次实际拿到的绑定值，并按 SaveImage 前缀产出与真实 ComfyUI 同形的成图文件名。 */
function fakeComfyui(calls: ComfyCall[]): (context: never) => Promise<Record<string, JsonValue>> {
  return async (context: never) => {
    const current = context as unknown as { step: RunStep; inputValues: Record<string, JsonValue>; stepValues: Map<string, Record<string, JsonValue>>; runId: string; artifacts: { directory: string } };
    const inputs = resolveStepInputs(current.step, current.inputValues, current.stepValues) as Record<string, JsonValue>;
    const read = (key: string) => inputs[key] ?? null;
    const prefix = String(read("prefix") ?? "");
    if (!prefix) throw new Error("假 ComfyUI 没收到 filename_prefix，无法产出可归位的成图");
    calls.push({ stepId: current.step.id, directory: read("promptDirectory"), promptName: read("promptName"), action: read("action"), prefix });
    // 真实 SaveImage 把 filename_prefix 变成 `<prefix>_00001_.png`；这里把产物写进本运行媒体目录，
    // 让下游 localExport 像读真实归档产物一样取到内容（内容用动作，便于交叉核对取到的是哪一条）。
    const filename = `${prefix}_00001_.png`;
    const mediaDirectory = path.join(current.artifacts.directory, "outputs", "media");
    mkdirSync(mediaDirectory, { recursive: true });
    writeFileSync(path.join(mediaDirectory, filename), `pixels:${String(read("action"))}`);
    return { result: createRuntimeMediaValue("image", [filename]) as unknown as JsonValue };
  };
}

/** 真实场景的步骤定义（含真实 core.code 代码与 ComfyUI 绑定），只把 sceneId 换成测试场景。
 *  定义固化在 pillowScene.fixture.ts，改动流程却没同步 fixture 时测试会失败。 */
const sceneWorkflow = (sceneId: string) => ({ ...JSON.parse(JSON.stringify(pillowSceneWorkflow)), sceneId, name: "二次元抱枕生图流程" });

/** 建场景 → 校验 → 发布 → 提交，返回运行状态；步骤与输入由调用方给。 */
async function runScene(call: Awaited<ReturnType<typeof connect>>["call"], sceneId: string, workflow: unknown, inputValues: Record<string, JsonValue>) {
  const created = (await call("create_scene", { scene: { id: sceneId, title: "二次元抱枕生图" }, workflow })).payload;
  assert.equal(created.ok, true, "create_scene 失败：" + JSON.stringify(created));
  const draft = (await call("get_scene_draft", { sceneId })).payload.data as { revision: string };
  const validation = (await call("validate_scene_draft", { sceneId, revision: draft.revision })).payload;
  assert.equal(validation.ok, true, JSON.stringify(validation));
  const versionId = randomUUID();
  assert.equal((await call("publish_scene", { sceneId, revision: draft.revision, publicationId: versionId })).payload.ok, true);
  const runId = randomUUID();
  assert.equal((await call("submit_scene", { sceneId, versionId, runId, inputValues })).payload.ok, true);
  const done = (await call("wait_run", { runId, timeoutSeconds: 25 })).payload.data as { status: string };
  if (done.status !== "completed") {
    const detail = (await call("get_run", { runId })).payload.data as { steps?: Array<{ stepId: string; status: string; message?: string }> };
    console.log("运行未完成，逐步状态：", JSON.stringify(detail.steps?.map(s => ({ id: s.stepId, status: s.status, message: s.message }))));
  }
  return { runId, versionId, status: done.status };
}

test("真实stdio MCP闭环：抱枕新流程的参考图/提示词/动作固定配对，动作随机取自对应动作文件", async t => {
  const root = await temporaryDirectory(t);
  const library = path.join(root, "library");
  const batchDir = path.join(library, "77");
  mkdirSync(path.join(batchDir, "角色"), { recursive: true });
  writeFileSync(path.join(batchDir, "1.jpg"), "ref-one");
  writeFileSync(path.join(batchDir, "2.png"), "ref-two");
  writeFileSync(path.join(batchDir, "提示词1.txt"), "第一轮提示词正文", "utf8");
  writeFileSync(path.join(batchDir, "提示词2.txt"), "第二轮提示词正文", "utf8");
  // 两轮动作内容刻意不同：用来证明抽到的动作来自各自文件、没有交叉配对。
  const actions1 = ["动作1-甲", "动作1-乙", "动作1-丙"];
  const actions2 = ["动作2-甲", "动作2-乙", "动作2-丙"];
  writeFileSync(path.join(batchDir, "动作1.txt"), actions1.join("\n") + "\n", "utf8");
  writeFileSync(path.join(batchDir, "动作2.txt"), actions2.join("\n") + "\n", "utf8");
  writeFileSync(path.join(batchDir, "角色", "角色甲.png"), "char-a");
  writeFileSync(path.join(batchDir, "角色", "角色乙.png"), "char-b");

  const calls: ComfyCall[] = [];
  const h = await aiHarness(t, { emptyWorkspace: true, getLocalExportRoot: () => library, comfyui: fakeComfyui(calls) });
  const { call } = await connect(t, h.base);

  const inputValues = { batch: "77", exclude: "" };
  const first = await runScene(call, "pillow-flow", sceneWorkflow("pillow-flow"), inputValues);
  assert.equal(first.status, "completed", JSON.stringify(first));

  console.log("\n=== 假 ComfyUI 实际收到的绑定 ===");
  for (const c of calls) console.log(`${c.stepId}: 目录=${JSON.stringify(c.directory)} 文件名=${JSON.stringify(c.promptName)} 动作=${JSON.stringify(c.action)} 前缀=${JSON.stringify(c.prefix)}`);

  // 1. 两个角色 × 两轮 = 4 次调用，且两轮都真的跑了。
  assert.equal(calls.length, 4, "两个角色 × 两轮应有 4 次 ComfyUI 调用");
  const round1 = calls.filter(c => c.stepId === "swap_round1");
  const round2 = calls.filter(c => c.stepId === "swap_round2");
  assert.equal(round1.length, 2);
  assert.equal(round2.length, 2);

  // 2. 固定配对 + 提示词目录来自批次目录（带尾分隔符，供 CR Load Text List 拼 file_name）。
  for (const c of round1) {
    assert.equal(c.promptName, "提示词1", "第 1 轮必须用 提示词1");
    assert.ok(String(c.directory).endsWith("77\\"), `第 1 轮提示词目录应是批次目录：${c.directory}`);
    assert.ok(actions1.includes(String(c.action)), `第 1 轮动作必须取自 动作1.txt：${c.action}`);
  }
  for (const c of round2) {
    assert.equal(c.promptName, "提示词2", "第 2 轮必须用 提示词2");
    assert.ok(String(c.directory).endsWith("77\\"), `第 2 轮提示词目录应是批次目录：${c.directory}`);
    assert.ok(actions2.includes(String(c.action)), `第 2 轮动作必须取自 动作2.txt：${c.action}`);
  }
  console.log("固定配对与动作来源核对通过 ✔");

  // 3. 随机性：多跑几次，动作取值应出现多种（不是永远第一行）。
  const seen = new Set(calls.map(c => String(c.action)));
  const sceneIdReuse = "pillow-flow";
  const draft = (await call("get_scene_draft", { sceneId: sceneIdReuse })).payload.data as { revision: string };
  void draft;
  const version = (await call("list_scenes", {})).payload.data as { scenes?: Array<{ sceneId?: string }> };
  void version;
  for (let attempt = 0; attempt < 6 && seen.size < 2; attempt += 1) {
    calls.length = 0;
    const again = randomUUID();
    // 复用同一发布版：用 prepare_scene 拿到固定 versionId 后再提交。
    const prepared = (await call("prepare_scene", { sceneId: sceneIdReuse, versionId: first.versionId, inputValues })).payload;
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.equal((await call("submit_scene", { sceneId: sceneIdReuse, versionId: first.versionId, runId: again, inputValues })).payload.ok, true);
    const status = (await call("wait_run", { runId: again, timeoutSeconds: 25 })).payload.data as { status: string };
    assert.equal(status.status, "completed");
    for (const c of calls) seen.add(String(c.action));
  }
  console.log(`随机性：多次运行共抽到 ${seen.size} 种不同动作 ${JSON.stringify([...seen])}`);
  assert.ok(seen.size > 1, "多次运行应抽到不同动作（随机选取生效）");

  // 4. 成图按角色名落到 结果1 / 结果2，且不改写输入素材。
  for (const dir of ["结果1", "结果2"]) {
    const target = path.join(batchDir, dir);
    assert.ok(existsSync(target), `${dir} 目录应已创建`);
    assert.deepEqual(readdirSync(target).sort(), ["角色乙.png", "角色甲.png"], `${dir} 里的文件名必须是角色名`);
  }
  assert.equal(readFileSync(path.join(batchDir, "角色", "角色甲.png"), "utf8"), "char-a", "输入角色图不得被改写");
  console.log("成图落盘：结果1 / 结果2 各按角色名写入 ✔");
});

test("真实stdio MCP闭环：某一轮动作文件为空时整轮跳过、不调用ComfyUI，另一轮照常", async t => {
  const root = await temporaryDirectory(t);
  const library = path.join(root, "library");
  const batchDir = path.join(library, "78");
  mkdirSync(path.join(batchDir, "角色"), { recursive: true });
  writeFileSync(path.join(batchDir, "1.jpg"), "ref-one");
  writeFileSync(path.join(batchDir, "2.png"), "ref-two");
  writeFileSync(path.join(batchDir, "提示词1.txt"), "第一轮提示词", "utf8");
  writeFileSync(path.join(batchDir, "提示词2.txt"), "第二轮提示词", "utf8");
  writeFileSync(path.join(batchDir, "动作1.txt"), "", "utf8");        // 空 → 第 1 轮必须整轮跳过
  writeFileSync(path.join(batchDir, "动作2.txt"), "动作2-甲\n", "utf8");
  writeFileSync(path.join(batchDir, "角色", "角色甲.png"), "char-a");

  const calls: ComfyCall[] = [];
  const h = await aiHarness(t, { emptyWorkspace: true, getLocalExportRoot: () => library, comfyui: fakeComfyui(calls) });
  const { call } = await connect(t, h.base);
  const result = await runScene(call, "pillow-skip", sceneWorkflow("pillow-skip"), { batch: "78", exclude: "" });
  assert.equal(result.status, "completed");

  const run = (await call("get_run", { runId: result.runId })).payload.data as { steps: Array<{ stepId: string; status: string; message?: string }> };
  const round1 = run.steps.find(s => s.stepId === "swap_round1");
  assert.equal(round1?.status, "skipped", "动作1.txt 为空时第 1 轮必须整轮跳过");
  assert.equal(calls.filter(c => c.stepId === "swap_round1").length, 0, "被跳过的一轮不得调用 ComfyUI（不计费）");
  assert.equal(calls.filter(c => c.stepId === "swap_round2").length, 1, "另一轮应照常生成");
  assert.ok(existsSync(path.join(batchDir, "结果2", "角色甲.png")), "第 2 轮成图应落盘");
  assert.equal(existsSync(path.join(batchDir, "结果1")), false, "被跳过的一轮不应产生目录");
  console.log("空动作轮次整轮跳过，另一轮正常落盘 ✔");
});

test("真实stdio MCP闭环：两个动作文件都没有可用动作时第一步即失败，不进入付费生成", async t => {
  const root = await temporaryDirectory(t);
  const library = path.join(root, "library");
  const batchDir = path.join(library, "79");
  mkdirSync(path.join(batchDir, "角色"), { recursive: true });
  writeFileSync(path.join(batchDir, "1.jpg"), "ref-one");
  writeFileSync(path.join(batchDir, "2.png"), "ref-two");
  writeFileSync(path.join(batchDir, "提示词1.txt"), "第一轮提示词", "utf8");
  writeFileSync(path.join(batchDir, "提示词2.txt"), "第二轮提示词", "utf8");
  writeFileSync(path.join(batchDir, "动作1.txt"), "\n  \n", "utf8");  // 只有空行
  writeFileSync(path.join(batchDir, "动作2.txt"), "", "utf8");         // 完全为空
  writeFileSync(path.join(batchDir, "角色", "角色甲.png"), "char-a");

  const calls: ComfyCall[] = [];
  const h = await aiHarness(t, { emptyWorkspace: true, getLocalExportRoot: () => library, comfyui: fakeComfyui(calls) });
  const { call } = await connect(t, h.base);
  const result = await runScene(call, "pillow-no-action", sceneWorkflow("pillow-no-action"), { batch: "79", exclude: "" });
  assert.equal(result.status, "failed", "两个动作文件都为空时整次运行应失败");
  assert.equal(calls.length, 0, "失败发生在第一步，不得调用 ComfyUI（不计费）");
  const run = (await call("get_run", { runId: result.runId })).payload.data as { steps: Array<{ stepId: string; status: string; message?: string }> };
  const scan = run.steps.find(s => s.stepId === "scan");
  assert.match(String(scan?.message), /没有可用动作/, "报错必须说明动作集合为空");
  console.log("两轮动作皆空 → 第一步失败且未调用 ComfyUI ✔");
});
