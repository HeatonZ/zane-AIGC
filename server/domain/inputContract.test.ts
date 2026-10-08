import assert from "node:assert/strict";
import test from "node:test";
import { sceneInputContract } from "./inputContract.js";
import { validateWorkflowInputs } from "./inputValidation.js";
import type { JsonValue, RunWorkflowDefinition } from "./types.js";
import { aiHarness } from "../testing/aiSupport.js";
const definition = (inputs: unknown[]): RunWorkflowDefinition => ({ inputs, steps: [], outputs: [] }) as RunWorkflowDefinition;

test("输入契约：false/0默认值满足必填，空值不满足必填，schema允许额外字段", () => {
  const flow = definition([{ key: "flag", type: "boolean", required: true, defaultValue: false }, { key: "count", type: "number", required: true, defaultValue: 0 }, { key: "text", type: "text", required: true, defaultValue: "" }, { key: "optional", type: "json" }]);
  const contract = sceneInputContract(flow); assert.deepEqual(contract.inputSchema.required, ["text"]); assert.deepEqual(contract.missingRequiredInputs, ["text"]); assert.equal(contract.inputSchema.additionalProperties, true);
  assert.deepEqual(contract.inputDefaults, { flag: false, count: 0, text: "" });
  assert.equal((contract.inputSchema.properties as Record<string, any>).flag.default, false); assert.equal((contract.inputSchema.properties as Record<string, any>).count.default, 0);
  validateWorkflowInputs(flow, contract.inputExamples[0].inputValues); assert.equal(contract.inputExamples[0].syntacticallyComplete, true);
  assert.deepEqual(sceneInputContract(flow, { text: "已填写" }).missingRequiredInputs, []);
});

test("数字场景输入范围是闭区间且字段可选；JSON Schema和对象数组行字段同步约束", async t => {
  const h = await aiHarness(t);
  const draft = await h.scenes.drafts.get("demo");
  const workflow = structuredClone(draft.workflow as unknown as RunWorkflowDefinition);
  workflow.inputs.find(field => field.key === "style")!.defaultValue = "草稿值";
  workflow.inputs.push(
    { key: "quantity", type: "number", required: false, minimum: 2, maximum: 8 },
    { key: "rows", type: "json", required: false, inputMode: "object_array", itemFields: [{ key: "count", label: "数量", type: "number", required: false, minimum: 0, maximum: 3 }] },
  );
  const inverted = structuredClone(workflow);
  inverted.inputs.find(field => field.key === "quantity")!.minimum = 9;
  await assert.rejects(h.scenes.drafts.update("demo", { revision: draft.revision, workflow: inverted as never }), /最小值不能大于最大值/);
  const saved = await h.scenes.drafts.update("demo", { revision: draft.revision, workflow: workflow as never });
  assert.equal((await h.scenes.drafts.validate("demo", saved.revision)).valid, true);
  const publicationId = "number-input-bounds-version";
  await h.scenes.drafts.publish("demo", saved.revision, publicationId);
  const selected = await h.scenes.get("demo", publicationId);
  const properties = selected.inputSchema.properties as Record<string, any>;
  assert.equal(properties.quantity.anyOf[1].minimum, 2);
  assert.equal(properties.quantity.anyOf[1].maximum, 8);
  assert.equal(properties.rows.anyOf[1].items.properties.count.minimum, 0);
  assert.equal(properties.rows.anyOf[1].items.properties.count.maximum, 3);
  assert.deepEqual(selected.inputSchema.required, []);
  const requirement = selected.inputRequirements.find(field => field.key === "quantity");
  assert.equal(requirement?.minimum, 2); assert.equal(requirement?.maximum, 8); assert.equal(requirement?.required, false);
  await h.scenes.prepare("demo", publicationId, {});
  await h.scenes.prepare("demo", publicationId, { quantity: 2, rows: [{ count: 0 }] });
  await h.scenes.prepare("demo", publicationId, { quantity: 8, rows: [{ count: 3 }] });
  await assert.rejects(h.scenes.prepare("demo", publicationId, { quantity: 1 }), /不能小于 2/);
  await assert.rejects(h.scenes.prepare("demo", publicationId, { quantity: 9 }), /不能大于 8/);
  await assert.rejects(h.scenes.prepare("demo", publicationId, { rows: [{ count: 4 }] }), /不能大于 3/);
});

test("隐藏输入：契约保留字段并标记网页隐藏，默认值仍满足必填", () => {
  const flow = definition([{ key: "internal_mode", type: "text", required: true, hidden: true, defaultValue: "safe" }]);
  const contract = sceneInputContract(flow);
  const property = (contract.inputSchema.properties as Record<string, any>).internal_mode;
  assert.equal(property["x-hidden"], true);
  assert.deepEqual(contract.inputSchema.required, []);
  assert.equal(contract.inputRequirements[0].hidden, true);
  assert.deepEqual(contract.inputExamples[0].inputValues, { internal_mode: "safe" });
  validateWorkflowInputs(flow, { internal_mode: "safe" });
  validateWorkflowInputs(flow, { internal_mode: "explicit override" });
});

test("输入契约：选项、JSON与媒体结构真实，不虚构素材ID", () => {
  const flow = definition([{ key: "style", type: "select", required: true, options: ["写实", "动漫"] }, { key: "json", type: "json", required: true }, { key: "images", type: "image_list", required: true }]);
  const contract = sceneInputContract(flow); const properties = contract.inputSchema.properties as Record<string, any>;
  assert.deepEqual(properties.style.enum, ["写实", "动漫"]); assert.deepEqual(properties.json.type, ["object", "array"]); assert.equal(properties.images.$ref, "#/$defs/NonEmptyMediaInput");
  assert.equal(contract.inputExamples[0].inputValues.style, "写实"); assert.equal(contract.inputExamples[0].syntacticallyComplete, false); assert.deepEqual(contract.inputExamples[0].missingRequiredInputs, ["images"]); assert.ok(!("images" in contract.inputExamples[0].inputValues));
  for (const bad of [{ style: "缺失选项", json: {}, images: ["http://local/image.png"] }, { style: "写实", json: "字符串不是JSON对象", images: ["http://local/image.png"] }, { style: "写实", json: {}, images: [] }]) assert.throws(() => validateWorkflowInputs(flow, bad));
  validateWorkflowInputs(flow, { style: "写实", json: [], images: [null, "", ["http://local/image.png"]] });
});

test("对象数组表单：发布契约描述规格行，预检校验每行类型、必填和下拉选项", async t => {
  const h = await aiHarness(t);
  const draft = await h.scenes.drafts.get("demo");
  const workflow = structuredClone(draft.workflow as unknown as RunWorkflowDefinition);
  workflow.inputs.find(field => field.key === "style")!.defaultValue = "草稿值";
  workflow.inputs.push({
    key: "specs", type: "json", required: true, inputMode: "object_array",
    itemFields: [
      { key: "size", label: "尺寸", type: "select", required: true, options: ["S", "M", "L"] },
      { key: "type", label: "类型", type: "select", required: true, options: ["圆领", "V领"] },
      { key: "stock", label: "库存", type: "number", required: false },
    ],
  });
  const saved = await h.scenes.drafts.update("demo", { revision: draft.revision, workflow: workflow as never });
  const duplicateKeys = structuredClone(workflow);
  duplicateKeys.inputs.at(-1)!.itemFields![1]!.key = "size";
  await assert.rejects(h.scenes.drafts.update("demo", { revision: saved.revision, workflow: duplicateKeys as never }), /对象数组子字段重复键/);
  assert.equal((await h.scenes.drafts.validate("demo", saved.revision)).valid, true);
  const publicationId = "object-array-form-version";
  await h.scenes.drafts.publish("demo", saved.revision, publicationId);
  const selected = await h.scenes.get("demo", publicationId);
  const schema = (selected.inputSchema.properties as Record<string, any>).specs;
  assert.equal(schema["x-input-mode"], "object_array");
  assert.deepEqual(schema["x-item-fields"].map((field: any) => field.key), ["size", "type", "stock"]);
  assert.deepEqual(schema.items.required, ["size", "type"]);
  assert.deepEqual(schema.items.properties.size.enum, ["S", "M", "L"]);
  const specs: JsonValue[] = [{ size: "S", type: "圆领", stock: 12 }, { size: "M", type: "V领" }];
  assert.deepEqual((await h.scenes.prepare("demo", publicationId, { specs })).inputValues.specs, specs);
  for (const invalid of [
    [{ size: "S" }],
    [{ size: "XL", type: "圆领" }],
    [{ size: 38, type: "圆领" }],
    [{ size: "S", type: "圆领", unexpected: true }],
    ["not an object"],
    [],
  ]) await assert.rejects(h.scenes.prepare("demo", publicationId, { specs: invalid as never }), /specs|规格数组|输入/);
});

test("发布场景输入契约固定快照；示例通过实际预检，prepare返回已补齐状态", async t => {
  const h = await aiHarness(t); const selected = await h.scenes.get("demo");
  assert.deepEqual((selected.inputSchema.properties as Record<string, any>).style.anyOf[1].enum, ["已发布值"]); assert.deepEqual(selected.missingRequiredInputs, []);
  const prepared = await h.scenes.prepare("demo", selected.versionId, selected.inputExamples[0].inputValues);
  assert.deepEqual(prepared.missingRequiredInputs, []); assert.equal(prepared.externalServicesChecked, false); assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);
  const bad = await fetch(h.base + "/api/v1/scenes/demo/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ versionId: selected.versionId, inputValues: { flag: "false" } }) });
  assert.equal(bad.status, 400); const error = await bad.json() as Record<string, any>; assert.equal(error.code, "INPUT_TYPE_MISMATCH"); assert.equal(error.details.inputKey, "flag");
});
