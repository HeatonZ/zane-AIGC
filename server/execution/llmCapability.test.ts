import assert from "node:assert/strict";
import test from "node:test";
import { loadCapabilityPackages } from "../capabilities/loadPackages.js";
import type { StepExecutionContext } from "./workflowExecutor.js";
import { createRuntimeMediaValue } from "../runtimeValue.js";

/** Capture what core.llm forwards to the shared model runtime. */
async function loadLlmRegistry(record: Array<{ options: unknown; step: unknown }>, directLlm?: (selection: { providerId?: string; model?: string }) => unknown) {
  return loadCapabilityPackages({
    async hermes(context, options) {
      record.push({ options, step: context.step });
      return { text: "改写后的提示词" };
    },
    async condition() { return { result: true }; },
    async comfyui() { throw new Error("本测试不应调用 ComfyUI"); },
    ...(directLlm ? { directLlm: directLlm as never } : {}),
  });
}

function context(step: Record<string, unknown>, inputValues: Record<string, unknown> = {}, stepValues: Map<string, Record<string, unknown>> = new Map()): StepExecutionContext {
  return {
    runInputValues: {}, runId: "run-llm", artifacts: { directory: "", inputs: "", outputs: "" },
    step, inputValues, stepValues, types: new Map(), settings: {}, inputFields: [],
    signal: new AbortController().signal,
  } as unknown as StepExecutionContext;
}

test("core.llm 在能力目录里注册为新能力，并暴露 systemPrompt/outputMode/direct 配置", async () => {
  const registry = await loadLlmRegistry([]);
  const definition = registry.definitions().find((item) => item.id === "core.llm");
  assert.ok(definition, "core.llm 必须出现在能力目录里");
  assert.equal(definition.legacy.kind, "capability");
  assert.equal(definition.usage?.compatibilityOnly, undefined, "core.llm 是新能力，不能标记为仅兼容");
  assert.ok(definition.usage?.whenToUse.trim(), "必须声明适用范围");
  assert.ok(definition.config.some((field) => field.key === "systemPrompt"), "必须暴露系统指令配置");
  assert.ok(definition.config.some((field) => field.key === "outputMode"), "必须暴露输出模式配置");
  assert.equal(definition.config.find((field) => field.key === "outputMode")?.defaultValue, "json");
  const direct = definition.config.find((field) => field.key === "direct");
  assert.ok(direct, "必须暴露直连开关");
  assert.equal(direct?.type, "boolean");
  assert.equal(direct?.defaultValue, false, "直连默认关闭，保证历史行为不变");
});

test("core.llm 把 systemPrompt 与 outputMode 转交给模型运行时", async () => {
  const record: Array<{ options: unknown; step: unknown }> = [];
  const registry = await loadLlmRegistry(record);
  const result = await registry.execute(context({
    id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1",
    capabilityConfig: { systemPrompt: "你是提示词增强器。", outputMode: "text" },
    outputs: [{ key: "text", type: "text" }],
  }));
  assert.deepEqual(result, { text: "改写后的提示词" });
  assert.equal(record.length, 1);
  assert.deepEqual(record[0]!.options, { systemPrompt: "你是提示词增强器。", outputMode: "text" });
});

test("core.llm 的默认输出模式是 json，空白系统指令按未配置处理", async () => {
  const record: Array<{ options: unknown; step: unknown }> = [];
  const registry = await loadLlmRegistry(record);
  await registry.execute(context({
    id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1",
    capabilityConfig: { systemPrompt: "   " },
    outputs: [{ key: "text", type: "text" }],
  }));
  assert.deepEqual(record[0]!.options, { systemPrompt: undefined, outputMode: "json" });
});

test("core.llm 与 core.hermes 是不同能力，互不覆盖", async () => {
  const registry = await loadLlmRegistry([]);
  const ids = registry.definitions().map((item) => item.id);
  assert.ok(ids.includes("core.llm"));
  assert.ok(ids.includes("core.hermes"));
});

test("core.llm 未开启直连时不下发 direct，开启时把注册表解析出的提供商目标交给模型运行时", async () => {
  const record: Array<{ options: unknown; step: unknown }> = [];
  const target = { enabled: true, providerId: "claude-proxy", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "plaintext-key", apiKeyEnv: "", model: "claude-sonnet-4" };
  const selections: Array<{ providerId?: string; model?: string }> = [];
  const registry = await loadLlmRegistry(record, (selection) => { selections.push(selection); return target; });
  // 默认（未勾选 direct）不携带 direct 字段：调用方据此完全走历史 Hermes 路径。
  await registry.execute(context({
    id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1",
    capabilityConfig: { outputMode: "text" },
    outputs: [{ key: "text", type: "text" }],
  }));
  assert.deepEqual(record[0]!.options, { systemPrompt: undefined, outputMode: "text" });
  assert.equal("direct" in (record[0]!.options as object), false, "未开启时不得夹带 direct");
  assert.deepEqual(selections, [], "未开启时不得读取直连注册表");
  // 显式 direct:true 时才下发，并且把步骤里的 providerId/model 交给注册表解析。
  await registry.execute(context({
    id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1",
    capabilityConfig: { outputMode: "text", direct: true, providerId: "claude-proxy", model: "claude-sonnet-4" },
    outputs: [{ key: "text", type: "text" }],
  }));
  assert.deepEqual(selections, [{ providerId: "claude-proxy", model: "claude-sonnet-4" }], "必须把步骤选择交给注册表解析，而不是自己读配置");
  assert.deepEqual(record[1]!.options, { systemPrompt: undefined, outputMode: "text", direct: target });
  // 省略 providerId/model：仍然交给注册表（由它决定保留默认提供商与第一个模型）。
  await registry.execute(context({
    id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1",
    capabilityConfig: { outputMode: "text", direct: true },
    outputs: [{ key: "text", type: "text" }],
  }));
  assert.deepEqual(selections[1], { providerId: undefined, model: undefined });
});

test("core.llm 开启直连但运行时未注入注册表时，下发未启用状态而不是静默回退 Hermes", async () => {
  const record: Array<{ options: unknown; step: unknown }> = [];
  const registry = await loadLlmRegistry(record);
  await registry.execute(context({
    id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1",
    capabilityConfig: { outputMode: "text", direct: true },
    outputs: [{ key: "text", type: "text" }],
  }));
  assert.deepEqual(record[0]!.options, { systemPrompt: undefined, outputMode: "text", direct: { enabled: false, providerId: "", protocol: "openai-chat", baseUrl: "", apiKey: "", apiKeyEnv: "", model: "" } });
});

test("direct 配置字段经 prepareStep 物化默认值，direct=false 与缺失等价", async () => {
  const registry = await loadLlmRegistry([]);
  const prepared = registry.prepareStep({
    id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1",
    outputs: [{ key: "text", type: "text" }],
  });
  assert.equal(prepared.capabilityConfig?.direct, false);
  assert.equal(prepared.capabilityConfig?.outputMode, "json");
  assert.throws(() => registry.prepareStep({
    id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1",
    capabilityConfig: { direct: "yes" },
    outputs: [{ key: "text", type: "text" }],
  }), /数据类型/);
});

test("core.llm 暴露技能文本引用配置，并声明它是可选字段", async () => {
  const registry = await loadLlmRegistry([]);
  const definition = registry.definitions().find((item) => item.id === "core.llm")!;
  const skill = definition.config.find((field) => field.key === "skillRef");
  assert.ok(skill, "必须暴露技能文本引用配置");
  assert.equal(skill?.type, "reference");
  assert.notEqual(skill?.required, true, "技能文本是可选配置，不能改变历史快照的必填口径");
  assert.match(String(skill?.description), /SKILL\.md/);
});

test("core.llm 把技能文本引用解析成系统指令，与固定 systemPrompt 合成同一条 system 消息", async () => {
  const record: Array<{ options: unknown; step: unknown }> = [];
  const registry = await loadLlmRegistry(record);
  const stepValues = new Map([["load_skill", { text: "---\nname: enhancer\n---\n\n技能正文" }]]);
  await registry.execute(context({
    id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1",
    capabilityConfig: { systemPrompt: "固定系统指令", skillRef: "step.load_skill.outputs.text", outputMode: "text" },
    outputs: [{ key: "text", type: "text" }],
  }, {}, stepValues));
  assert.deepEqual(record[0]!.options, { systemPrompt: "固定系统指令\n\n---\nname: enhancer\n---\n\n技能正文", outputMode: "text" }, "技能正文必须原样保留（含 frontmatter），固定文本在前");
});

test("core.llm 只有技能文本时也发送 system 消息，多个引用按顺序用空行拼接", async () => {
  const record: Array<{ options: unknown; step: unknown }> = [];
  const registry = await loadLlmRegistry(record);
  const stepValues = new Map([["load_skill", { text: "第一段" }]]);
  await registry.execute(context({
    id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1",
    capabilityConfig: { skillRef: "input.skill\nstep.load_skill.outputs.text", outputMode: "text" },
    outputs: [{ key: "text", type: "text" }],
  }, { skill: "第二段" }, stepValues));
  assert.deepEqual(record[0]!.options, { systemPrompt: "第二段\n\n第一段", outputMode: "text" });
});

test("core.llm 的技能文本引用非法、指向媒体或没有值时在调用模型之前失败", async () => {
  const record: Array<{ options: unknown; step: unknown }> = [];
  const registry = await loadLlmRegistry(record);
  const base = {
    id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1",
    outputs: [{ key: "text", type: "text" }],
  };
  await assert.rejects(() => registry.execute(context({ ...base, capabilityConfig: { skillRef: "not-a-reference" } })),
    /技能文本引用无效/, "不是 input./step. 形式的引用必须在发出请求前失败");
  await assert.rejects(() => registry.execute(context({ ...base, capabilityConfig: { skillRef: "step.missing.outputs.text" } })),
    /没有值/, "引用目标不存在时不能静默发送空系统指令");
  const media = createRuntimeMediaValue("image", ["a.png"]);
  await assert.rejects(() => registry.execute(context({ ...base, capabilityConfig: { skillRef: "input.skill" } }, { skill: media })),
    /指向媒体/, "媒体值不能当作系统指令");
  assert.equal(record.length, 0, "任何失败都不得调用模型");
});

test("core.llm 的技能文本解析为空时继续执行但记录步骤警告", async () => {
  const record: Array<{ options: unknown; step: unknown }> = [];
  const registry = await loadLlmRegistry(record);
  const warnings: string[] = [];
  const base = {
    id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1",
    capabilityConfig: { skillRef: "input.skill", outputMode: "text" },
    outputs: [{ key: "text", type: "text" }],
  };
  const ctx = { ...context(base, { skill: "   " }), warn: async (message: string) => { warnings.push(message); } } as StepExecutionContext;
  await registry.execute(ctx);
  assert.deepEqual(record[0]!.options, { systemPrompt: undefined, outputMode: "text" }, "空白技能文本等同于未配置");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /技能文本引用解析结果为空/);
});

test("core.llm 的 skillRef 写法在 prepareStep（草稿校验/发布预检）阶段就被拒绝", async () => {
  const registry = await loadLlmRegistry([]);
  assert.doesNotThrow(() => registry.prepareStep({
    id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1",
    capabilityConfig: { skillRef: "step.load_skill.outputs.text" },
    outputs: [{ key: "text", type: "text" }],
  }));
  assert.throws(() => registry.prepareStep({
    id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1",
    capabilityConfig: { skillRef: "load_skill" },
    outputs: [{ key: "text", type: "text" }],
  }), /技能文本引用无效/);
});
