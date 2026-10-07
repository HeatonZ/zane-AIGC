import assert from "node:assert/strict";
import test from "node:test";
import { buildSceneDiff, diffValue } from "./sceneDiff.js";
const step = (id: string) => ({ id, name: id, promptTemplate: "保持\n原提示词\n末尾", inputs: [], outputs: [], comfyui: { workflowFile: "old.json", bindings: [{ direction: "input", key: "prompt", nodeId: "1", property: "text", sourceRef: "input.prompt" }, { direction: "output", key: "prompt", nodeId: "2", property: "text" }] } });
const content = () => ({ scene: { id: "demo", title: "场景", extensions: { safe: true } }, workflow: { name: "流程", inputs: [{ key: "prompt", label: "想法", type: "text", defaultValue: "旧值" }], steps: [step("a"), step("b")], outputs: [{ key: "result", type: "text", sourceRef: "step.b.outputs.prompt" }] }, optionPresets: [{ id: "style", name: "风格", options: ["旧选项"] }] });

test("字段diff：同值/键序不变、提示词/ComfyUI节点/未知扩展/预设都展示；不修改参数", () => {
  const before = content(), after = structuredClone(before);
  after.workflow.steps[0].promptTemplate = "保持\n新提示词\n末尾";
  after.workflow.steps[0].comfyui.workflowFile = "new.json";
  after.workflow.steps[0].comfyui.bindings[0].nodeId = "201";
  after.scene.extensions.safe = false;
  after.optionPresets[0].options = ["新选项"];
  const snapshot = structuredClone({ before, after });
  const changes = buildSceneDiff(before, after);
  assert.equal(changes.length, 5);
  assert.deepEqual(changes.map(item => item.path).sort(), ["/scene/extensions/safe", "/workflow/steps/a/promptTemplate", "/workflow/steps/a/comfyui/workflowFile", "/workflow/steps/a/comfyui/bindings/input:prompt/nodeId", "/optionPresets/style/options"].sort());
  assert.equal(changes.find(item => item.path.endsWith("/nodeId"))?.objectLabel, "a");
  assert.equal(changes.find(item => item.path.endsWith("/options"))?.section, "optionPresets");
  assert.deepEqual({ before, after }, snapshot);
  assert.deepEqual(buildSceneDiff(before, JSON.parse(JSON.stringify(before))), []);
  assert.equal(buildSceneDiff({ value: 0, scene: { title: "x", id: "a" } }, { scene: { id: "a", title: "x" } }).length, 0);
});

test("稳定ID/key对齐：插入/删除不虚报其余步骤，真实换序单列；绑定输入输出同key不混淆", () => {
  const before = content(), after = structuredClone(before);
  after.workflow.steps.unshift(step("new"));
  let changes = buildSceneDiff(before, after);
  assert.equal(changes.length, 1); assert.equal(changes[0].kind, "added"); assert.equal(changes[0].objectId, "new");
  after.workflow.steps = [step("b"), step("a")];
  changes = buildSceneDiff(before, after);
  assert.deepEqual(changes.map(item => [item.path, item.kind]), [["/workflow/steps/@order", "reordered"]]);
  after.workflow.steps = [step("a")];
  changes = buildSceneDiff(before, after);
  assert.equal(changes.length, 1); assert.equal(changes[0].kind, "removed"); assert.equal(changes[0].objectId, "b");
  after.workflow.steps = structuredClone(before.workflow.steps);
  after.workflow.steps[0].comfyui.bindings.reverse();
  changes = buildSceneDiff(before, after);
  assert.deepEqual(changes[0].before, ["input:prompt", "output:prompt"]); assert.equal(changes[0].kind, "reordered");
});

test("首次发布空基线、不存在/null/空字符串区分；大值按码点分段不损坏emoji", () => {
  const changes = buildSceneDiff(null, content());
  assert.ok(changes.length); assert.ok(changes.every(item => item.kind === "added"));
  assert.ok(changes.some(item => item.path === "/workflow/steps/a"));
  const nulls = buildSceneDiff({ scene: { a: null, b: "" } }, { scene: { a: "", b: null, c: null } });
  assert.equal(nulls.length, 3);
  assert.deepEqual(diffValue(null, true, 0, 100), { present: true, format: "json", text: "null", totalChars: 4, offset: 0, nextOffset: null, complete: true });
  assert.equal(diffValue(undefined, false, 0, 100).present, false);
  assert.equal(diffValue("", true, 0, 100).present, true);
  const first = diffValue("A😀中B", true, 0, 2);
  assert.equal(first.text, "A😀"); assert.equal(first.nextOffset, 2); assert.equal(first.totalChars, 4); assert.equal(first.complete, false);
  assert.equal(diffValue("A😀中B", true, 2, 2).text, "中B");
  assert.equal(buildSceneDiff({ scene: { title: "a" } }, { scene: { title: "b" } })[0].changeId, buildSceneDiff({ scene: { title: "c" } }, { scene: { title: "d" } })[0].changeId);
});
