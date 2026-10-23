import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceJsonField, isObjectArrayField, type ServiceJsonFieldShape } from "./ServiceJsonField";
import { ServiceWorkspace } from "./ServiceWorkspace";
import { validatePresentation } from "../../server/domain/packageContracts.js";

/**
 * 用户端服务页的 `json` 字段曾经一律渲染成文本域，短剧包的「分镜稿」只能整段手写 JSON。
 * 这组测试锁住三件事：声明了行表单契约就渲染行表单；没声明仍是文本域（老包不变）；
 * 行字段结构原样来自服务端投影，前端不自己编。
 */
const shotsField: ServiceJsonFieldShape = {
  key: "shots", label: "这一段的分镜稿", type: "json", required: false, hidden: false,
  inputMode: "object_array",
  itemFields: [
    { key: "index", label: "镜号", type: "number", required: true, minimum: 1, maximum: 999 },
    { key: "seconds", label: "这一镜秒数", type: "number", required: true, minimum: 1.3, maximum: 15 },
    { key: "prompt", label: "H3 提示词", type: "text", required: true },
    { key: "characters", label: "人物", type: "text", required: false },
    { key: "scenes", label: "场景编号", type: "text", required: false },
    { key: "props", label: "道具编号", type: "text", required: false },
    { key: "continuity", label: "续接上一镜", type: "select", required: false, options: ["", "context"] },
  ],
};

test("声明 inputMode=object_array 且行字段非空时渲染行表单，不是文本域", () => {
  const html = renderToStaticMarkup(createElement(ServiceJsonField, {
    field: shotsField, value: [{ index: "1", seconds: "3", prompt: "拆快递", characters: "1,2" }], onChange: () => {},
  }));
  assert.match(html, /object-array-input/, "必须渲染可增删行的表格");
  assert.doesNotMatch(html, /zclient-textarea/, "不能同时渲染 JSON 文本域");
  // 行字段来自契约：7 个格子都在，必填标记也要在。
  for (const label of ["镜号", "这一镜秒数", "H3 提示词", "人物", "场景编号", "道具编号", "续接上一镜"]) assert.match(html, new RegExp(label));
  assert.match(html, /type="number"/);
  assert.match(html, /context/);
});

test("未声明行表单的 json/textarea 字段保持原文本域，老包渲染不变", () => {
  for (const field of [
    { key: "payload", label: "原始 JSON", type: "json", required: false, hidden: false },
    { key: "payload", label: "只有 inputMode 没有行字段", type: "json", required: false, hidden: false, inputMode: "object_array" as const, itemFields: [] },
    { key: "note", label: "说明", type: "textarea", required: false, hidden: false },
  ]) {
    const html = renderToStaticMarkup(createElement(ServiceJsonField, { field, value: { a: 1 }, onChange: () => {} }));
    assert.match(html, /zclient-textarea/, field.label + " 应保持文本域");
    assert.doesNotMatch(html, /object-array-input/, field.label + " 不应渲染行表单");
  }
  assert.equal(isObjectArrayField({ type: "json", inputMode: "object_array", itemFields: [] }), false);
  assert.equal(isObjectArrayField({ type: "textarea", inputMode: "object_array", itemFields: shotsField.itemFields }), false);
});

test("工作台把工程账摘要放在结果区标题与结果之间；没账时整块不出现", () => {
  const presentation = validatePresentation({
    layout: "workspace",
    workspace: { title: "短剧出片", resultTitle: "这一段", stateSummary: { title: "这一集已出的段", format: "list" } },
  });
  // 有账：摘要夹在结果区标题与结果之间。
  const withState = renderToStaticMarkup(createElement(ServiceWorkspace, {
    presentation, title: "短剧出片", form: createElement("div", null, "FIELDS"),
    result: createElement("div", null, "RESULT-AREA"),
    stateSummary: createElement("div", { className: "sws-state-body" }, "已出 s01、s02"),
    onSubmit: () => {},
  }));
  assert.match(withState, /sws-state/);
  const head = withState.indexOf("sws-canvas-head");
  const state = withState.indexOf("sws-state");
  const result = withState.indexOf("RESULT-AREA");
  assert.ok(head >= 0 && state > head && result > state, "摘要必须在结果区标题之后、结果之前：" + JSON.stringify([head, state, result]));
  // 没账：连外壳 div 都不渲染，不留空标题。
  const withoutState = renderToStaticMarkup(createElement(ServiceWorkspace, {
    presentation, title: "短剧出片", form: createElement("div", null, "FIELDS"),
    result: createElement("div", null, "RESULT-AREA"), onSubmit: () => {},
  }));
  assert.doesNotMatch(withoutState, /sws-state/);
});
