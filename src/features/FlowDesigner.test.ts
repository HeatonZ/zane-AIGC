import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import FlowDesigner, { carryReferenceOptions } from "./FlowDesigner";
import { parseScenePackage } from "../lib/sceneTransfer";
import type { WorkflowDefinition } from "../types";

test("designer shows physical type and semantic asset roles separately without editing on render", async () => {
  const pkg = parseScenePackage(JSON.parse(await readFile(new URL("../../examples/scenes/long-text-to-video.json", import.meta.url), "utf8")));
  const original = structuredClone(pkg);
  const noWrite = () => { throw new Error("render must not save, publish or migrate"); };
  const html = renderToStaticMarkup(createElement(FlowDesigner, { sceneId: pkg.scene.id, scene: pkg.scene, scenes: [pkg.scene], workflow: pkg.workflow, optionPresets: [], onSceneChange: noWrite, onSortScenes: noWrite, onChange: noWrite, onOptionPresetsChange: noWrite, onPublish: async () => { throw new Error("render must not publish"); }, onApplyVersion: noWrite, onOpenConnections: noWrite }));
  assert.equal((html.match(/class="select-wrap media-role-select"/g) ?? []).length, 4);
  for (const role of ["character", "scene", "prop", "voice_reference"]) assert.match(html, new RegExp('value="' + role + '" selected=""'));
  for (const label of ["人物资产", "场景资产", "道具资产", "参考音色", "图片列表", "音频列表", "AIXG · 逐镜转换H3提示词"]) assert.ok(html.includes(label));
  assert.deepEqual(pkg, original);
});

test("designer exposes type-aware optional defaults, including zero, false, JSON, and media lists", async () => {
  const pkg = parseScenePackage(JSON.parse(await readFile(new URL("../../examples/scenes/long-text-to-video.json", import.meta.url), "utf8")));
  const inputs: WorkflowDefinition["inputs"] = [
    { key: "text", label: "文本", type: "text", required: false, defaultValue: "预填文本" },
    { key: "count", label: "数量", type: "number", required: false, defaultValue: 0 },
    { key: "enabled", label: "开关", type: "boolean", required: false, defaultValue: false },
    { key: "style", label: "风格", type: "select", required: false, options: ["写实", "动画"], defaultValue: "动画" },
    { key: "data", label: "数据", type: "json", required: false, defaultValue: { mode: "safe" } },
    { key: "images", label: "图片", type: "image_list", required: false, defaultValue: [{ assetId: "asset_1", assetVersion: 1 }] },
  ];
  const workflow = { ...pkg.workflow, inputs, steps: [], outputs: [] };
  const original = structuredClone(workflow);
  const noWrite = () => { throw new Error("render must not save or publish"); };
  const html = renderToStaticMarkup(createElement(FlowDesigner, { sceneId: pkg.scene.id, scene: pkg.scene, scenes: [pkg.scene], workflow, optionPresets: [], onSceneChange: noWrite, onSortScenes: noWrite, onChange: noWrite, onOptionPresetsChange: noWrite, onPublish: async () => { throw new Error("render must not publish"); }, onApplyVersion: noWrite, onOpenConnections: noWrite }));
  for (const label of ["文本默认值", "数量默认值", "开关默认值", "风格默认值", "数据默认值", "图片默认值"]) assert.ok(html.includes(label), label);
  assert.match(html, /value="预填文本"/);
  assert.match(html, /value="0"/);
  assert.match(html, /value="false" selected=""/);
  assert.match(html, /value="动画" selected=""/);
  assert.ok(html.includes("mode") && html.includes("safe"));
  assert.match(html, /asset_1/);
  assert.deepEqual(workflow, original);
});


test("ComfyUI物理媒体列表不再展示业务分类按钮或用途下拉，分类留在上游",async()=>{
 const source=await readFile(new URL("./FlowDesigner.tsx",import.meta.url),"utf8");
 assert.doesNotMatch(source,/添加分类素材/);
 assert.doesNotMatch(source,/MediaRoleSelect type={binding.type}/);
 assert.match(source,/ComfyUI只接收媒体列表/);
});


test("状态链配置导入不丢失；设计器提供previous媒体列表和串行锁定，不修改快照", async () => {
  const raw = JSON.parse(await readFile(new URL("../../examples/scenes/long-text-to-video.json", import.meta.url), "utf8"));
  raw.workflow.steps = [{ ...raw.workflow.steps[0], inputs: [{ key: "previous", label: "上一段", sourceRef: "iteration.previous[0]" }], outputs: [{ key: "video", label: "本段视频", type: "video_list" }],
    execution: { mode: "for_each", sourceRef: "input.character_assets", carry: { outputKey: "video" } } }];
  raw.workflow.outputs = [{ key: "videos", label: "视频", type: "video_list", sourceRef: "step.writer.outputs.video" }];
  const pkg = parseScenePackage(raw); assert.deepEqual(pkg.workflow.steps[0].execution?.carry, { outputKey: "video" });
  const original = structuredClone(pkg); const noWrite = () => { throw new Error("render must not write"); };
  const html = renderToStaticMarkup(createElement(FlowDesigner, { sceneId: pkg.scene.id, scene: pkg.scene, scenes: [pkg.scene], workflow: pkg.workflow, optionPresets: [], onSceneChange: noWrite, onSortScenes: noWrite, onChange: noWrite, onOptionPresetsChange: noWrite, onPublish: async () => { throw new Error("render must not publish"); }, onApplyVersion: noWrite, onOpenConnections: noWrite }));
  assert.ok(html.includes("场景输入"));
  const refs = carryReferenceOptions(pkg.workflow.steps[0]);
  assert.deepEqual(refs.map(ref => ref.value), ["iteration.previous", "iteration.hasPrevious", "iteration.index"]);
  assert.equal(refs[0].type, "video_list"); assert.equal(refs[0].isArray, true); assert.equal(refs[0].isCollection, true);
  const editor = await readFile(new URL("./FlowDesigner.tsx", import.meta.url), "utf8");
  for (const text of ["继承上一项输出（串行）", "初始状态（可选）", 'disabled={Boolean(selectedStep.execution.carry)}']) assert.ok(editor.includes(text), text);
  assert.deepEqual(pkg, original);
  raw.workflow.steps[0].execution.carry.typo = true; assert.throws(() => parseScenePackage(raw), /状态传递配置无效/);
});
