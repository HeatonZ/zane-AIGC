import assert from "node:assert/strict";
import test from "node:test";
import { applyCapabilityToStep, capabilityForStep, capabilityConfigErrors, readCapabilityConfig, writeCapabilityConfig, parseCapabilityDraft } from "./capabilities";
import { builtinCapabilities } from "../../server/capabilities/definitions.js";
import type { CapabilityDefinition } from "./capabilities";
import type { WorkflowStepDefinition } from "../types";
const step: WorkflowStepDefinition = { id: "s", name: "步骤", kind: "hermes", inputs: [{ key: "text", label: "文本", sourceRef: "input.text" }], outputs: [{ key: "text", label: "文本", type: "text" }], promptTemplate: "old" };
const custom: CapabilityDefinition = { id: "custom.demo", version: "2", label: "新能力", description: "无需核心 UI 改动", category: "数据", legacy: { kind: "capability" }, inputs: [{ key: "text", label: "文本", type: "text" }], outputs: [{ key: "result", label: "结果", type: "json" }], config: [{ key: "count", label: "数量", type: "number", defaultValue: 3 }], editor: { inputs: "ports", outputs: "ports" }, result: { renderer: "json" } };
test("声明驱动新能力的输入输出、默认配置与版本，不修改原步骤", () => {
  const next = applyCapabilityToStep(step, custom);
  assert.equal(next.kind, "capability"); assert.equal(next.capabilityVersion, "2"); assert.equal(next.capabilityConfig?.count, 3);
  assert.equal(next.inputs[0].sourceRef, "input.text"); assert.equal(next.outputs[0].type, "json"); assert.equal(step.promptTemplate, "old");
  assert.equal(capabilityForStep(next, [custom])?.id, custom.id);
});
test("旧能力映射与嵌套配置修改保留其他字段", () => {
  const h3 = builtinCapabilities.find((item) => item.id === "comfyui.h3_long_video")!;
  const old: WorkflowStepDefinition = { ...step, kind: "comfyui", comfyui: { adapter: "h3_long_video", workflowFile: "h3.json", bindings: [], h3LongVideo: { planRef: "input.plan", promptRowsRef: "input.prompts", referenceImagesRef: "input.images" } } };
  assert.equal(capabilityForStep(old, builtinCapabilities)?.id, h3.id);
  const next = writeCapabilityConfig(old, h3.config[0], "input.new_plan");
  assert.equal(readCapabilityConfig(next, h3.config[0]), "input.new_plan"); assert.equal(next.comfyui?.h3LongVideo?.promptRowsRef, "input.prompts");
  assert.equal(old.comfyui?.h3LongVideo?.planRef, "input.plan");
  assert.ok(capabilityConfigErrors({ capabilityConfig: { count: "bad" } }, custom).length);
});


test("原始配置草稿的 JSON 和数字错误不能偷偷保留旧值继续执行", () => {
  const number = { key: "count", label: "数量", type: "number" as const };
  assert.equal(parseCapabilityDraft(number, ""), undefined);
  assert.equal(parseCapabilityDraft(number, "0"), 0);
  assert.throws(() => parseCapabilityDraft(number, "bad"), /有效数字/);
  assert.throws(() => parseCapabilityDraft({ ...number, required: true }, ""), /不能为空/);
  const json = { key: "data", label: "数据", type: "json" as const };
  assert.deepEqual(parseCapabilityDraft(json, '{"value":1}'), { value: 1 });
  assert.throws(() => parseCapabilityDraft(json, "{"), /有效的 JSON/);
  assert.throws(() => parseCapabilityDraft(json, "3"), /对象或数组/);
});


test("旧后台缺少usage时只补全精确版本内置声明，不猜未知扩展或覆盖服务声明", async () => {
  const { withBuiltinCapabilityUsage } = await import("./capabilities");
  const legacy = structuredClone(builtinCapabilities); for (const item of legacy) delete item.usage;
  const known = withBuiltinCapabilityUsage(legacy); assert.match(known.find((item) => item.id === "core.comfyui")?.usage?.whenToUse ?? "", /图片|视频|音频/); assert.equal(legacy[0].usage, undefined);
  const declared = { ...legacy[0], usage: { whenToUse: "服务已明确" } }; assert.equal(withBuiltinCapabilityUsage([declared])[0], declared);
  const future = { ...legacy[0], version: "future" }; assert.equal(withBuiltinCapabilityUsage([future])[0].usage, undefined);
});
