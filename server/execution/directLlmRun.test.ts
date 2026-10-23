import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadCapabilityPackages } from "../capabilities/loadPackages.js";
import { runHermesStep } from "./hermesStep.js";
import { DirectLlmService } from "../services/directLlmService.js";
import { harness, id, workflow } from "../testing/testSupport.js";
import type { RunWorkflowDefinition } from "../domain/types.js";

const plaintextKey = "sk-live-RUN-PLAINTEXT-SENTINEL-1a2b3c4d5e6f";

/** 端到端：真实执行器 + 真实能力包 + 真实 SQLite 注册表，只把外部 HTTP 换成假 fetch。
 *  证明「步骤里的 direct:true + providerId」确实从注册表解析该提供商，并按它的协议直连。 */
test("运行级闭环：core.llm 的 direct 步骤从提供商注册表取协议/地址/模型，直连该提供商端点", async t => {
  let direct: DirectLlmService;
  const executors = await loadCapabilityPackages({
    hermes: (context, options) => runHermesStep(context.step, context.inputValues, context.stepValues, context.types, context.settings, context.signal, context.feedback, context.captureAgentPrompt, context.captureAgentResponse, options),
    async condition() { return { result: true }; },
    async comfyui() { throw new Error("本测试不调用 ComfyUI"); },
    directLlm: selection => direct.target(selection.providerId, selection.model),
  });
  const h = await harness(t, { executors });
  // 真实 SQLite 注册表：直连配置就是运行时读到的唯一权威来源。
  direct = new DirectLlmService(h.store, {});
  const definition: RunWorkflowDefinition = {
    sceneId: "direct-llm-scene", name: "直连闭环",
    inputs: [],
    steps: [{
      id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1",
      promptTemplate: "改写这条指令",
      capabilityConfig: { systemPrompt: "你是提示词增强器。", outputMode: "text", direct: true, providerId: "claude-proxy", model: "claude-sonnet-4" },
      inputs: [], outputs: [{ key: "text", type: "text" }],
    }],
    outputs: [{ key: "result", type: "text", sourceRef: "step.enhance.outputs.text" }],
  };

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "  最终提示词正文  " }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    // 提供商还不存在：运行必须失败并说明缺什么，且不发出任何请求。
    const unconfigured = id("direct-llm-unconfigured");
    await h.service.start();
    await h.service.submit({ runId: unconfigured, workflow: structuredClone(definition), inputValues: {} });
    const failedRun = await h.service.wait(h.settings.projectDirectory, unconfigured);
    assert.equal(failedRun.status, "failed");
    assert.match(String(failedRun.steps.find(step => step.stepId === "enhance")?.message), /直连模型提供商未启用/);
    assert.equal(requests.length, 0, "未配置时不得发出付费请求");

    // 保存一个 Anthropic 协议的提供商（密钥直接在页面上填明文）后重跑同一流程：这次必须按该协议直连。
    const created = direct.create({ providerId: "claude-proxy", name: "公司 Anthropic 代理", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1/", apiKey: plaintextKey, models: ["claude-sonnet-4"], enabled: true }, () => undefined);
    assert.equal(created.baseUrl, "https://api.anthropic.com/v1", "末尾斜杠必须被去掉");
    assert.equal(created.revision, 1);
    // 读回不回显明文：只有布尔与掩码。
    assert.equal(created.hasApiKey, true);
    assert.equal(created.credential.source, "provider-apiKey");
    assert.equal(created.credential.configured, true);
    assert.equal(created.credential.plaintextAtRest, true);
    assert.equal(created.credential.lastFour, plaintextKey.slice(-4));
    assert.doesNotMatch(JSON.stringify(created), new RegExp(plaintextKey), "读接口绝不能回显密钥明文");
    const runId = id("direct-llm-configured");
    await h.service.submit({ runId, workflow: structuredClone(definition), inputValues: {} });
    const completed = await h.service.wait(h.settings.projectDirectory, runId);
    assert.equal(completed.status, "completed", JSON.stringify(completed.steps.map(step => [step.stepId, step.status, step.message])));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, "https://api.anthropic.com/v1/messages", "必须打到该提供商的协议端点，而不是 Hermes");
    assert.equal(requests[0]!.headers["x-api-key"], plaintextKey, "直连请求确实使用页面上保存的明文密钥");
    assert.equal(requests[0]!.body.model, "claude-sonnet-4", "模型从步骤配置解析");
    assert.equal(requests[0]!.body.system, "你是提示词增强器。");
    // text 模式原样返回正文（不裁剪），证明直连路径复用了同一输出契约。
    assert.equal(completed.outputs.find(output => output.key === "result")?.value, "  最终提示词正文  ");
    // 运行记录、运行输入、步骤结果里绝不能有密钥明文或鉴权头。
    const stored = await h.service.getRun(h.settings.projectDirectory, runId);
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(plaintextKey), "运行记录绝不能含密钥明文");
    const agentPrompt = stored!.steps.find(step => step.stepId === "enhance")?.agentPrompt;
    assert.match(String(agentPrompt), /改写这条指令/);
    assert.doesNotMatch(String(agentPrompt), new RegExp(plaintextKey));
    // 运行输入归档（inputs/input.json）与运行时快照（runtime.json）同样不得含密钥：
    // 提供商的密钥只存在于 @zane-system 的 settings 文档里，运行产物里一条都没有。
    const runDirectory = path.join(h.settings.projectDirectory, "runs", runId);
    for (const file of ["inputs/input.json", "runtime.json", "workflow.json"]) {
      const text = await readFile(path.join(runDirectory, file), "utf8").catch(() => "");
      if (text) assert.doesNotMatch(text, new RegExp(plaintextKey), file + " 绝不能含密钥明文");
    }

    // 步骤不写 model 时用提供商的第一个模型（不猜默认模型，也不用 Hermes）。
    const noModel = structuredClone(definition);
    delete (noModel.steps[0]!.capabilityConfig as Record<string, unknown>).model;
    const defaultRunId = id("direct-llm-provider-default-model");
    await h.service.submit({ runId: defaultRunId, workflow: noModel, inputValues: {} });
    const defaultRun = await h.service.wait(h.settings.projectDirectory, defaultRunId);
    assert.equal(defaultRun.status, "completed", JSON.stringify(defaultRun.steps.map(step => step.message)));
    assert.equal(requests[1]!.body.model, "claude-sonnet-4", "省略 model 时用提供商 models 的第一个");

    // 同一流程关掉 direct 就会回到 Hermes：这里没有 Hermes 环境，因此必须因 Profile 失败，
    // 而不是悄悄用了直连提供商。
    const hermesRunId = id("direct-llm-disabled-falls-back");
    const hermesDefinition = structuredClone(definition);
    (hermesDefinition.steps[0]!.capabilityConfig as Record<string, unknown>).direct = false;
    await h.service.submit({ runId: hermesRunId, workflow: hermesDefinition, inputValues: {} });
    const hermesRun = await h.service.wait(h.settings.projectDirectory, hermesRunId);
    assert.equal(hermesRun.status, "failed");
    assert.match(String(hermesRun.steps.find(step => step.stepId === "enhance")?.message), /Hermes Profile/);
    assert.equal(requests.length, 2, "关掉 direct 后不得再请求提供商端点");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("运行级回归：direct 缺省（未写入配置）时 core.llm 仍走 Hermes 路径，行为逐字节不变", async t => {
  const calls: Array<unknown> = [];
  let directLlmReads = 0;
  const executors = await loadCapabilityPackages({
    hermes: (context, options) => { calls.push({ stepId: context.step.id, options }); return Promise.resolve({ text: "来自 Hermes" }); },
    async condition() { return { result: true }; },
    async comfyui() { throw new Error("本测试不调用 ComfyUI"); },
    // 未开启 direct 时这个 runtime 钩子一次都不应被调用。
    directLlm: () => { directLlmReads++; throw new Error("未开启 direct 时不得读取直连注册表"); },
  });
  const h = await harness(t, { executors });
  const runId = id("direct-llm-default-hermes");
  await h.service.start();
  await h.service.submit({
    runId,
    workflow: { sceneId: "s", name: "默认路径", inputs: [], steps: [{ id: "enhance", name: "增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1", promptTemplate: "改写", inputs: [], outputs: [{ key: "text", type: "text" }] }], outputs: [{ key: "result", type: "text", sourceRef: "step.enhance.outputs.text" }] } as RunWorkflowDefinition,
    inputValues: {},
  });
  const run = await h.service.wait(h.settings.projectDirectory, runId);
  assert.equal(run.status, "completed", JSON.stringify(run.steps.map(step => step.message)));
  assert.deepEqual(calls, [{ stepId: "enhance", options: { systemPrompt: undefined, outputMode: "json" } }], "未开启 direct 时必须保持历史调用形态");
  assert.equal(directLlmReads, 0, "未开启 direct 时不得接触直连注册表");
  assert.equal(run.outputs.find(output => output.key === "result")?.value, "来自 Hermes");
  assert.ok(workflow);
});
