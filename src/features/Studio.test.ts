import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Studio, { draftInputValues } from "./Studio";
import { createScenePackage, parseScenePackage } from "../lib/sceneTransfer";
import type { WorkflowDraft } from "../types";

async function basicPackage() { return parseScenePackage(JSON.parse(await readFile("examples/scenes/basic-image-layout.json", "utf8"))); }

test("基础图片场景JSON默认值导入/导出保留完整对象数组，创作表单不变成object字符串", async () => {
  const pkg = await basicPackage();
  const selection = pkg.workflow.inputs.find(field => field.key === "selection")!.defaultValue;
  const layouts = pkg.workflow.inputs.find(field => field.key === "layouts")!.defaultValue;
  assert.deepEqual(selection, { images: [1] }); assert.equal(Array.isArray(layouts), true);
  const values = draftInputValues(pkg.workflow); assert.deepEqual(JSON.parse(values.selection), selection); assert.deepEqual(JSON.parse(values.layouts), layouts);
  const roundtrip = parseScenePackage(createScenePackage(pkg.scene, pkg.workflow, [])); assert.deepEqual(roundtrip.workflow.inputs, pkg.workflow.inputs);
  const html = renderToStaticMarkup(createElement(Studio, { sceneId: pkg.scene.id, scene: pkg.scene, workflow: pkg.workflow, onNavigate() {}, onBack() {}, onSaveDraft() {}, async onStartRun() { throw new Error("SSR must not execute"); }, onCancelRun() {}, async onRerunRun() {} }));
  assert.doesNotMatch(html, /\[object Object\]|JSON 格式无效/);
  assert.match(html, /studio-input-selection/); assert.match(html, /studio-input-layouts/);
});

test("创作输入保留已有草稿、显式null和标量默认值；旧JSON字符串默认值继续可用", async () => {
  const pkg = await basicPackage();
  pkg.workflow.inputs.push({ key: "enabled", label: "布尔", type: "boolean", required: false, defaultValue: false }, { key: "count", label: "数值", type: "number", required: false, defaultValue: 0 }, { key: "legacy", label: "旧JSON", type: "json", required: false, defaultValue: '["old"]' });
  assert.equal(draftInputValues(pkg.workflow).enabled, "false"); assert.equal(draftInputValues(pkg.workflow).count, "0"); assert.deepEqual(JSON.parse(draftInputValues(pkg.workflow).legacy), ["old"]);
  const draft = { inputValues: { selection: null, layouts: [{ width: 320, height: 320 }] } } as unknown as WorkflowDraft;
  const values = draftInputValues(pkg.workflow, draft); assert.equal(values.selection, ""); assert.deepEqual(JSON.parse(values.layouts), draft.inputValues!.layouts);
  const invalid = createScenePackage(pkg.scene, pkg.workflow, []); invalid.workflow.inputs[0].defaultValue = { invalid: undefined } as never;
  assert.throws(() => parseScenePackage(invalid), /默认值不是有效 JSON/);
});


test("场景标题与复制来源流程名不一致时，创作页主标题和表单标题都取场景快照", async () => {
  const pkg = parseScenePackage(JSON.parse(await readFile("examples/scenes/reference-to-video-repaired.json", "utf8")));
  assert.equal(pkg.scene.title, "AI参考生视频");
  const before = structuredClone(pkg);
  for (const name of ["AI文生视频流程", "自定义内部流程名", ""]) {
    const html = renderToStaticMarkup(createElement(Studio, {
      sceneId: pkg.scene.id, scene: { ...pkg.scene, cover: "/reference-title-test.svg" }, workflow: { ...pkg.workflow, name },
      publication: { id: "fixed-reference-version", version: "1234abcd" },
      onNavigate() {}, onBack() {}, onSaveDraft() {},
      async onStartRun() { throw new Error("title rendering must not execute"); },
      onCancelRun() {}, async onRerunRun() {},
    }));
    assert.match(html, /<h1>AI参考生视频<\/h1>/);
    assert.match(html, /<h2>AI参考生视频<\/h2>/);
    assert.doesNotMatch(html, /AI文生视频流程|自定义内部流程名/);
    assert.match(html, /当前发布版/);
  }
  assert.deepEqual(pkg, before, "显示修复不改写场景或流程配置");
});
