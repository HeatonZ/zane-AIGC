import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StepCapabilityPicker from "./StepCapabilityPicker";
import { builtinCapabilities } from "../../server/capabilities/definitions.js";
import { capabilityChoices } from "../lib/capabilities";
import type { WorkflowStepDefinition } from "../types";
const step: WorkflowStepDefinition = { id: "s", name: "生成", kind: "comfyui", comfyui: { workflowFile: "workflow.json", bindings: [] }, inputs: [], outputs: [], promptTemplate: "" };

test("新步骤默认只提供基础能力，展开仍不推荐旧版电商兼容包", () => {
  const markup = renderToStaticMarkup(createElement(StepCapabilityPicker, { step, capabilities: builtinCapabilities, onChange() { throw new Error("展示不能修改流程"); } }));
  assert.match(markup, /基础步骤（优先复用）/); assert.match(markup, /查看专用步骤/); assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /value="comfyui.h3_long_video"|value="comfyui.commerce_pack"|value="comfyui.long_text_video"/);
  const expanded = capabilityChoices(builtinCapabilities, "core.comfyui", true);
  assert.ok(expanded.specialized.some((item) => item.id === "comfyui.h3_long_video")); assert.ok(!expanded.specialized.some((item) => item.id === "comfyui.commerce_pack"));
});

test("已有专用/兼容步骤在折叠目录中仍显示，不能因隐藏自动切换或丢配置", () => {
  for (const adapter of ["h3_long_video", "commerce_pack"]) {
    const current: WorkflowStepDefinition = { ...step, comfyui: { ...step.comfyui!, adapter, h3LongVideo: { planRef: "input.plan", promptRowsRef: "input.prompts", referenceImagesRef: "input.images" } } };
    const before = structuredClone(current);
    const markup = renderToStaticMarkup(createElement(StepCapabilityPicker, { step: current, capabilities: builtinCapabilities, onChange() { throw new Error("自动迁移"); } }));
    assert.match(markup, new RegExp('value="comfyui.' + adapter + '" selected')); assert.match(markup, /基础替代/); assert.deepEqual(current, before);
    const choices = capabilityChoices(builtinCapabilities, "comfyui." + adapter);
    assert.deepEqual(choices.specialized.map((item) => item.id), ["comfyui." + adapter]);
  }
  const missing = renderToStaticMarkup(createElement(StepCapabilityPicker, { step: { ...step, capabilityId: "missing.step" }, capabilities: builtinCapabilities, onChange() {} }));
  assert.match(missing, /未安装的能力：missing.step/); assert.match(missing, /disabled/);
});
