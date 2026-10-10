import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StepCapabilityPicker from "./StepCapabilityPicker";
import { builtinCapabilities } from "../../server/capabilities/definitions.js";
import { loadCapabilityPackages } from "../../server/capabilities/loadPackages.js";
import { capabilityChoices } from "../lib/capabilities";
import type { WorkflowStepDefinition } from "../types";
const step: WorkflowStepDefinition = { id: "s", name: "生成", kind: "comfyui", comfyui: { workflowFile: "workflow.json", bindings: [] }, inputs: [], outputs: [], promptTemplate: "" };
const catalog = async () => (await loadCapabilityPackages({ async hermes() { throw new Error("禁止模型调用"); }, async comfyui() { throw new Error("禁止媒体生成"); }, async condition() { throw new Error("目录只读"); } })).definitions();

test("新步骤只提供未退役的执行方式；场景差异用提示词、绑定与 core.code 表达", async () => {
  const definitions = await catalog();
  for (const id of ["core.hermes", "core.comfyui", "core.http_request", "core.code"]) {
    assert.ok(capabilityChoices(definitions, "core.code").some((item) => item.id === id), id + " 必须仍可作为新步骤候选");
  }
  const markup = renderToStaticMarkup(createElement(StepCapabilityPicker, { step: { ...step, kind: "capability", capabilityId: "core.code" }, capabilities: definitions, onChange() { throw new Error("展示不能修改流程"); } }));
  assert.match(markup, /value="core.code" selected/);
  assert.doesNotMatch(markup, /基础步骤（优先复用）|专用步骤（必要时使用）|查看专用步骤/);
});

test("已退役的执行方式不再向新步骤提供，已选中的旧版兼容步骤仍可见且标注", async () => {
  const definitions = await catalog();
  const retired = ["core.manual", "core.condition", "data.select", "data.zip", "text.template", "media.select_references", "media.image_layout", "comfyui.commerce_pack", "comfyui.h3_long_video", "comfyui.long_text_video"];
  for (const id of retired) {
    assert.ok(definitions.some((item) => item.id === id), id + " 必须保留注册以兼容已发布快照与历史运行");
    assert.ok(!capabilityChoices(definitions, undefined).some((item) => item.id === id), id + " 不能作为新步骤候选");
    assert.ok(!capabilityChoices(definitions, "core.code").some((item) => item.id === id), id + " 不为其他步骤提供已退役能力");
    assert.ok(capabilityChoices(definitions, id).some((item) => item.id === id), id + " 已选中时必须保留，避免丢配置或自动切换");
  }
  const selected = renderToStaticMarkup(createElement(StepCapabilityPicker, { step: { ...step, kind: "capability", capabilityId: "media.image_layout" }, capabilities: definitions, onChange() { throw new Error("自动迁移"); } }));
  assert.match(selected, /value="media.image_layout" selected/); assert.match(selected, /旧版兼容/);
  const fresh = renderToStaticMarkup(createElement(StepCapabilityPicker, { step: { ...step, kind: "capability", capabilityId: "core.code" }, capabilities: definitions, onChange() {} }));
  assert.doesNotMatch(fresh, /value="media.image_layout"|value="text.template"|value="data.zip"/);
});

test("未安装的能力保留占位，不自动切换或改写步骤", () => {
  const missing = renderToStaticMarkup(createElement(StepCapabilityPicker, { step: { ...step, capabilityId: "missing.step" }, capabilities: builtinCapabilities, onChange() {} }));
  assert.match(missing, /未安装的能力：missing.step/); assert.match(missing, /disabled/);
});
