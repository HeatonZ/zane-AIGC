import assert from "node:assert/strict";
import test from "node:test";
import { sceneInputContract } from "./inputContract.js";
import { validateWorkflowInputs } from "./inputValidation.js";
import type { RunWorkflowDefinition } from "./types.js";
import { aiHarness } from "../testing/aiSupport.js";
const definition = (inputs: unknown[]): RunWorkflowDefinition => ({ inputs, steps: [], outputs: [] }) as RunWorkflowDefinition;

test("输入契约：false/0默认值满足必填，空值不满足必填，schema拒绝未知字段", () => {
  const flow = definition([{ key: "flag", type: "boolean", required: true, defaultValue: false }, { key: "count", type: "number", required: true, defaultValue: 0 }, { key: "text", type: "text", required: true, defaultValue: "" }, { key: "optional", type: "json" }]);
  const contract = sceneInputContract(flow); assert.deepEqual(contract.inputSchema.required, ["text"]); assert.deepEqual(contract.missingRequiredInputs, ["text"]); assert.equal(contract.inputSchema.additionalProperties, false);
  assert.deepEqual(contract.inputDefaults, { flag: false, count: 0, text: "" });
  assert.equal((contract.inputSchema.properties as Record<string, any>).flag.default, false); assert.equal((contract.inputSchema.properties as Record<string, any>).count.default, 0);
  validateWorkflowInputs(flow, contract.inputExamples[0].inputValues); assert.equal(contract.inputExamples[0].syntacticallyComplete, true);
  assert.deepEqual(sceneInputContract(flow, { text: "已填写" }).missingRequiredInputs, []);
});

test("输入契约：选项、JSON与媒体结构真实，不虚构素材ID", () => {
  const flow = definition([{ key: "style", type: "select", required: true, options: ["写实", "动漫"] }, { key: "json", type: "json", required: true }, { key: "images", type: "image_list", required: true }]);
  const contract = sceneInputContract(flow); const properties = contract.inputSchema.properties as Record<string, any>;
  assert.deepEqual(properties.style.enum, ["写实", "动漫"]); assert.deepEqual(properties.json.type, ["object", "array"]); assert.equal(properties.images.$ref, "#/$defs/NonEmptyMediaInput");
  assert.equal(contract.inputExamples[0].inputValues.style, "写实"); assert.equal(contract.inputExamples[0].syntacticallyComplete, false); assert.deepEqual(contract.inputExamples[0].missingRequiredInputs, ["images"]); assert.ok(!("images" in contract.inputExamples[0].inputValues));
  for (const bad of [{ style: "缺失选项", json: {}, images: ["http://local/image.png"] }, { style: "写实", json: "字符串不是JSON对象", images: ["http://local/image.png"] }, { style: "写实", json: {}, images: [] }]) assert.throws(() => validateWorkflowInputs(flow, bad));
  validateWorkflowInputs(flow, { style: "写实", json: [], images: [null, "", ["http://local/image.png"]] });
});

test("发布场景输入契约固定快照；示例通过实际预检，prepare返回已补齐状态", async t => {
  const h = await aiHarness(t); const selected = await h.scenes.get("demo");
  assert.deepEqual((selected.inputSchema.properties as Record<string, any>).style.anyOf[1].enum, ["已发布值"]); assert.deepEqual(selected.missingRequiredInputs, []);
  const prepared = await h.scenes.prepare("demo", selected.versionId, selected.inputExamples[0].inputValues);
  assert.deepEqual(prepared.missingRequiredInputs, []); assert.equal(prepared.externalServicesChecked, false); assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);
  const bad = await fetch(h.base + "/api/v1/scenes/demo/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ versionId: selected.versionId, inputValues: { flag: "false" } }) });
  assert.equal(bad.status, 400); const error = await bad.json() as Record<string, any>; assert.equal(error.code, "INPUT_TYPE_MISMATCH"); assert.equal(error.details.inputKey, "flag");
});
