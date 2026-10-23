/** 「二次元抱枕生图（单角色·大模型版）」的运行级核验（真实 stdio MCP 闭环，不调用真实模型、不生成媒体）。
 *
 *  用真实执行器 + 真实 core.code 沙箱跑完整场景图，把 Hermes 与 ComfyUI 换成假运行时：
 *  假 Hermes 记录 core.llm 实际收到的系统指令/输出模式/动作/提示词正文/图片附件数，
 *  假 ComfyUI 记录最终写进采样器 prompt 端口的文本。据此证明光看草稿看不出来的事：
 *    1. PE 的系统提示词确实作为独立 system 指令传给了大模型（不是塞进 user 消息）；
 *    2. 两张参考图都作为图片附件发送（大模型真的能看图）；
 *    3. 采样器拿到的是大模型产出的正文，不含任何 JSON 壳；
 *    4. 参考图 N 固定配 提示词N / 动作N，两轮各抽一次动作；
 *    5. 动作文件为空的那一轮整轮跳过，连大模型都不调用（不计费）。
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
import { createRuntimeMediaValue, isRuntimeMediaValue } from "../runtimeValue.js";
import { llmSceneWorkflow } from "./llmScene.fixture.js";
import type { JsonValue, RunStep } from "../domain/types.js";

async function connect(t: Parameters<typeof aiHarness>[0], base: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.resolve("server/mcp/index.ts")], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === "string")), ZANE_BASE_URL: base }, stderr: "pipe" });
  let errors = ""; transport.stderr?.on("data", chunk => { errors += chunk; });
  const client = new Client({ name: "isolated-llm-scene", version: "1.0.0" });
  t.after(() => client.close());
  try { await client.connect(transport); } catch (error) { throw new Error(String(error) + "\n" + errors); }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok("content" in result);
    return { result, payload: result.structuredContent as ApiResult };
  };
  return { client, call };
}

/** 媒体附件数量：参考图以运行时媒体值传递，不是普通数组。 */
function mediaCount(value: unknown) {
  if (isRuntimeMediaValue(value)) return value.items.length;
  return Array.isArray(value) ? value.length : 0;
}

interface LlmCall { stepId: string; systemPrompt: unknown; outputMode: unknown; action: unknown; promptText: unknown; imageCount: number; profile: unknown; promptTemplate: unknown }

/** 假大模型运行时：走真实 core.llm 能力的取值路径（resolveStepInputs 解析绑定），
 *  记录实际拿到的系统指令、动作、提示词正文与图片附件数量，并按 text 模式返回正文。 */
function fakeLlm(calls: LlmCall[], wrapperFor?: (stepId: string, body: string) => string): (context: never, options?: { systemPrompt?: string; outputMode?: string }) => Promise<Record<string, JsonValue>> {
  return async (context: never, options) => {
    const current = context as unknown as { step: RunStep; inputValues: Record<string, JsonValue>; stepValues: Map<string, Record<string, JsonValue>> };
    const inputs = resolveStepInputs(current.step, current.inputValues, current.stepValues) as Record<string, JsonValue>;
    calls.push({
      stepId: current.step.id,
      systemPrompt: options?.systemPrompt ?? null,
      outputMode: options?.outputMode ?? null,
      action: inputs.action ?? null,
      promptText: inputs.prompt ?? null,
      imageCount: mediaCount(inputs.reference1) + mediaCount(inputs.reference2),
      profile: current.step.hermesProfile ?? null,
      promptTemplate: current.step.promptTemplate ?? null,
    });
    // 默认返回纯正文；测试可用 wrapperFor 指定让模型「自作主张」包一层 JSON。
    const body = "【终稿】" + String(inputs.prompt ?? "") + " || 动作：" + String(inputs.action ?? "");
    const wrapped = wrapperFor?.(current.step.id, body);
    return { prompt: wrapped ?? body };
  };
}

interface ComfyCall { stepId: string; prompt: unknown; prefix: unknown }

/** 假 ComfyUI 运行时：记录写进采样器的 prompt 与 filename_prefix，并产出与真实 SaveImage 同形的成图文件名。 */
function fakeComfyui(calls: ComfyCall[]): (context: never) => Promise<Record<string, JsonValue>> {
  return async (context: never) => {
    const current = context as unknown as { step: RunStep; inputValues: Record<string, JsonValue>; stepValues: Map<string, Record<string, JsonValue>>; artifacts: { directory: string } };
    const inputs = resolveStepInputs(current.step, current.inputValues, current.stepValues) as Record<string, JsonValue>;
    const prefix = String(inputs.prefix ?? "");
    if (!prefix) throw new Error("假 ComfyUI 没收到 filename_prefix，无法产出可归位的成图");
    calls.push({ stepId: current.step.id, prompt: inputs.prompt ?? null, prefix });
    const filename = prefix + "_00001_.png";
    const mediaDirectory = path.join(current.artifacts.directory, "outputs", "media");
    mkdirSync(mediaDirectory, { recursive: true });
    writeFileSync(path.join(mediaDirectory, filename), "pixels:" + String(inputs.prompt ?? ""));
    return { result: createRuntimeMediaValue("image", [filename]) as unknown as JsonValue };
  };
}

/** 搭一个批次目录：固定两张参考图 + 角色子目录 + 两套提示词/动作文件。 */
function seedBatch(batch: string, options: { action1?: string; action2?: string } = {}) {
  mkdirSync(path.join(batch, "角色"), { recursive: true });
  writeFileSync(path.join(batch, "1.jpg"), "ref-one");
  writeFileSync(path.join(batch, "2.png"), "ref-two");
  writeFileSync(path.join(batch, "角色", "角色甲.png"), "char-a");
  writeFileSync(path.join(batch, "角色", "角色乙.png"), "char-b");
  writeFileSync(path.join(batch, "提示词1.txt"), "第一轮提示词正文", "utf8");
  writeFileSync(path.join(batch, "提示词2.txt"), "第二轮提示词正文", "utf8");
  if (options.action1 !== undefined) writeFileSync(path.join(batch, "动作1.txt"), options.action1, "utf8");
  if (options.action2 !== undefined) writeFileSync(path.join(batch, "动作2.txt"), options.action2, "utf8");
}

/** 经 MCP 建场景 → 校验 → 发布 → 提交 → 等到终态。 */
async function runScene(batchName: string, character: string, call: Awaited<ReturnType<typeof connect>>["call"], sceneId: string) {
  const created = (await call("create_scene", { scene: { id: sceneId, title: "大模型版" }, workflow: { ...llmSceneWorkflow, sceneId } })).payload;
  assert.equal(created.ok, true, "create_scene 失败：" + JSON.stringify(created));
  const draft = (await call("get_scene_draft", { sceneId })).payload.data as { revision: string };
  const validated = (await call("validate_scene_draft", { sceneId, revision: draft.revision })).payload;
  assert.equal(validated.ok, true, "validate 失败：" + JSON.stringify(validated));
  const publicationId = randomUUID();
  const published = (await call("publish_scene", { sceneId, revision: draft.revision, publicationId })).payload;
  assert.equal(published.ok, true, "publish 失败：" + JSON.stringify(published));
  const runId = randomUUID();
  const submitted = (await call("submit_scene", { sceneId, versionId: publicationId, runId, inputValues: { batch: batchName, character } })).payload;
  assert.equal(submitted.ok, true, "submit 失败：" + JSON.stringify(submitted));
  for (let i = 0; i < 120; i += 1) {
    const run = (await call("get_run", { runId })).payload.data as { status: string };
    if (["completed", "failed", "cancelled", "waiting"].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const run = (await call("get_run", { runId })).payload.data as { status: string; steps: Array<{ stepId: string; status: string; message?: string }> };
  return { runId, run };
}

test("真实stdio MCP隔离闭环：大模型版单角色场景把系统指令与两张图交给 core.llm，终稿直接写进采样器", async t => {
  const root = await temporaryDirectory(t);
  const library = path.join(root, "library");
  seedBatch(path.join(library, "77"), { action1: "动作1-甲\n动作1-乙\n", action2: "动作2-甲\n动作2-乙\n" });

  const llmCalls: LlmCall[] = [];
  const comfyCalls: ComfyCall[] = [];
  const h = await aiHarness(t, {
    emptyWorkspace: true,
    getLocalExportRoot: () => library,
    hermes: fakeLlm(llmCalls) as never,
    comfyui: fakeComfyui(comfyCalls) as never,
  });
  const { call } = await connect(t, h.base);

  const { run } = await runScene("77", "角色甲", call, "mcp-llm-scene");
  assert.equal(run.status, "completed", "运行未完成：" + JSON.stringify(run.steps));

  // 1) core.llm 收到独立 system 指令与 text 输出模式，且两张参考图都作为附件
  assert.equal(llmCalls.length, 2, "两轮各应有一次大模型调用");
  for (const record of llmCalls) {
    assert.match(String(record.systemPrompt), /Edit Prompt Enhancer/, "系统指令必须来自场景配置的 PE 提示词");
    assert.equal(record.outputMode, "text", "必须使用纯文本输出模式");
    assert.equal(record.profile, "default");
    assert.equal(record.imageCount, 2, "两张参考图都必须作为图片附件发送");
    // 画风原先由工作流的 #581 追加；新工作流已删掉该节点，必须由场景模板承载，
    // 否则画风会静默丢失（运行仍会成功，肉眼才看得出变化）。
    assert.match(String(record.promptTemplate), /日系二次元动漫美少女画风/, "提示词模板必须保留画风要求");
  }

  // 2) 参考图 N 固定配 提示词N / 动作N，不交叉
  const round1 = llmCalls.find(record => record.stepId === "enhance1");
  const round2 = llmCalls.find(record => record.stepId === "enhance2");
  assert.equal(round1?.promptText, "第一轮提示词正文");
  assert.equal(round2?.promptText, "第二轮提示词正文");
  assert.match(String(round1?.action), /^动作1-/);
  assert.match(String(round2?.action), /^动作2-/);

  // 3) 终稿直接进采样器，且不带任何 JSON 壳（原 PE 节点的问题）
  assert.equal(comfyCalls.length, 2);
  for (const record of comfyCalls) {
    const text = String(record.prompt);
    assert.match(text, /^【终稿】/, "采样器必须收到大模型产出的正文");
    assert.doesNotMatch(text, /"rewritten_prompt"|"wh_ratio"|"ratio_follow"|^\s*\{/, "不得把 JSON 壳喂给采样器");
  }
  assert.equal(comfyCalls.find(record => record.stepId === "swap_round1")?.prompt, "【终稿】第一轮提示词正文 || 动作：" + String(round1?.action));
  assert.equal(comfyCalls.find(record => record.stepId === "swap_round2")?.prompt, "【终稿】第二轮提示词正文 || 动作：" + String(round2?.action));

  // 4) 按角色名落盘，且只落这一次运行的角色
  assert.match(readFileSync(path.join(library, "77", "结果1", "角色甲.png"), "utf8"), /^pixels:【终稿】第一轮提示词正文/);
  assert.match(readFileSync(path.join(library, "77", "结果2", "角色甲.png"), "utf8"), /^pixels:【终稿】第二轮提示词正文/);
  assert.deepEqual(readdirSync(path.join(library, "77", "结果1")), ["角色甲.png"]);
  assert.deepEqual(readdirSync(path.join(library, "77", "结果2")), ["角色甲.png"]);
  // 输入素材不得被改写
  assert.equal(readFileSync(path.join(library, "77", "角色", "角色甲.png"), "utf8"), "char-a");
  assert.equal(readFileSync(path.join(library, "77", "1.jpg"), "utf8"), "ref-one");
});

test("真实stdio MCP隔离闭环：动作文件为空的那一轮整轮跳过，连大模型都不调用", async t => {
  const root = await temporaryDirectory(t);
  const library = path.join(root, "library");
  // 第一轮有动作，第二轮动作文件为空。
  seedBatch(path.join(library, "88"), { action1: "唯一的动作\n", action2: "" });

  const llmCalls: LlmCall[] = [];
  const comfyCalls: ComfyCall[] = [];
  const h = await aiHarness(t, {
    emptyWorkspace: true,
    getLocalExportRoot: () => library,
    hermes: fakeLlm(llmCalls) as never,
    comfyui: fakeComfyui(comfyCalls) as never,
  });
  const { call } = await connect(t, h.base);

  const { run } = await runScene("88", "角色乙", call, "mcp-llm-skip");
  assert.equal(run.status, "completed", "运行未完成：" + JSON.stringify(run.steps));

  // 只有第一轮发生了大模型调用与生成；第二轮被开始条件跳过。
  assert.deepEqual(llmCalls.map(record => record.stepId), ["enhance1"], "第二轮动作文件为空，不应调用大模型");
  assert.deepEqual(comfyCalls.map(record => record.stepId), ["swap_round1"], "第二轮不应调用 ComfyUI");
  const skipped = run.steps.filter(step => step.status === "skipped").map(step => step.stepId).sort();
  assert.deepEqual(skipped, ["enhance2", "swap_round2"], "第二轮两步都应记为跳过：" + JSON.stringify(run.steps));

  // 只有第一轮的结果落盘；第二轮没有可导出内容也不报错。
  assert.deepEqual(readdirSync(path.join(library, "88", "结果1")), ["角色乙.png"]);
  // 第二轮没有任何产出，因此不会创建 结果2 目录，也不会留下空文件。
  assert.equal(existsSync(path.join(library, "88", "结果2")), false, "第二轮被跳过时不应创建结果目录");
});


test("真实stdio MCP隔离闭环：模型自作主张包 JSON 时，净化守卫剥壳后才进采样器", async t => {
  const root = await temporaryDirectory(t);
  const library = path.join(root, "library");
  seedBatch(path.join(library, "99"), { action1: "动作甲\n", action2: "动作乙\n" });

  const llmCalls: LlmCall[] = [];
  const comfyCalls: ComfyCall[] = [];
  // 复现线上真实观测到的两种「包壳」：键名不固定的 JSON，以及模型报错回执。
  const wrappers: Record<string, (body: string) => string> = {
    enhance1: body => JSON.stringify({ rewritten_prompt: body, wh_ratio: 0.33, ratio_follow: true }),
    enhance2: body => JSON.stringify({ answer: body }),
  };
  const h = await aiHarness(t, {
    emptyWorkspace: true,
    getLocalExportRoot: () => library,
    hermes: fakeLlm(llmCalls, (stepId, body) => wrappers[stepId]?.(body)) as never,
    comfyui: fakeComfyui(comfyCalls) as never,
  });
  const { call } = await connect(t, h.base);

  const { run } = await runScene("99", "角色甲", call, "mcp-llm-unwrap");
  assert.equal(run.status, "completed", "运行未完成：" + JSON.stringify(run.steps));

  // 大模型确实返回了 JSON 壳……
  assert.equal(llmCalls.length, 2);
  // ……但采样器拿到的必须是剥壳后的纯正文，不能有 JSON 键名或花括号。
  assert.equal(comfyCalls.length, 2, "两轮都应照常生成");
  for (const record of comfyCalls) {
    const text = String(record.prompt);
    assert.doesNotMatch(text, /"rewritten_prompt"|"answer"|"wh_ratio"|"ratio_follow"|^s*{/, "采样器不得收到 JSON 壳：" + text.slice(0, 80));
    assert.match(text, /^【终稿】/, "采样器应收到剥壳后的正文");
  }
  assert.equal(comfyCalls.find(record => record.stepId === "swap_round1")?.prompt, "【终稿】第一轮提示词正文 || 动作：动作甲");
  assert.equal(comfyCalls.find(record => record.stepId === "swap_round2")?.prompt, "【终稿】第二轮提示词正文 || 动作：动作乙");
  // 落盘的也是干净正文
  assert.match(readFileSync(path.join(library, "99", "结果1", "角色甲.png"), "utf8"), /^pixels:【终稿】第一轮提示词正文/);
});

test("真实stdio MCP隔离闭环：模型返回错误回执时整轮失败，绝不把错误信息当提示词生成", async t => {
  const root = await temporaryDirectory(t);
  const library = path.join(root, "library");
  seedBatch(path.join(library, "100"), { action1: "动作甲\n", action2: "动作乙\n" });

  const llmCalls: LlmCall[] = [];
  const comfyCalls: ComfyCall[] = [];
  const h = await aiHarness(t, {
    emptyWorkspace: true,
    getLocalExportRoot: () => library,
    hermes: fakeLlm(llmCalls, (stepId, body) => (stepId === "enhance1"
      ? JSON.stringify({ error: "", error_description: "The request contains sexually explicit content", error_code: "400" })
      : body)) as never,
    comfyui: fakeComfyui(comfyCalls) as never,
  });
  const { call } = await connect(t, h.base);

  const { run } = await runScene("100", "角色甲", call, "mcp-llm-error-receipt");
  // 净化步骤明确失败，运行随之失败；关键是不能把错误信息送去生成。
  assert.equal(run.status, "failed", "错误回执应让运行失败，实际：" + JSON.stringify(run.steps.map(s => [s.stepId, s.status])));
  const normalize = run.steps.find(step => step.stepId === "normalize");
  assert.equal(normalize?.status, "failed");
  assert.match(String(normalize?.message), /模型返回了错误/, "失败原因要能看懂：" + String(normalize?.message));
  assert.equal(comfyCalls.length, 0, "错误回执不得触发任何 ComfyUI 生成");
});
