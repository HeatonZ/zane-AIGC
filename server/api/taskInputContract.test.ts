import assert from "node:assert/strict";
import test from "node:test";
import { applyExampleValues, prefillInputValues, rowMissingInputs } from "../../src/lib/taskInput.js";
import type { WorkflowInputField } from "../../src/types.js";
import { taskHarness } from "../testing/taskSupport.js";

/**
 * 任务表格靠发布版输入契约填输入。这里读的是 GET /api/v1/scenes/:sceneId 实际返回的那个对象
 * （路由就是 res.json(await scenes.get(...))），一旦服务端改名
 * （inputRequirements/needsValue/inputExamples/inputDefaults/missingRequiredInputs），
 * 断言会失败，而不是让表单静默变成空白或误报必填。
 */
type ContractEnvelope = {
  workflow: { inputs?: WorkflowInputField[] };
  inputRequirements: Array<{ key: string; required: boolean; needsValue: boolean; hidden: boolean }>;
  inputExamples: Array<{ inputValues: Record<string, never>; missingRequiredInputs: string[]; requiresUserInput: string[]; syntacticallyComplete: boolean }>;
  inputDefaults: Record<string, never>;
  missingRequiredInputs: string[];
};

test("任务表格读取的发布版契约字段与 get_scene 返回一致", async t => {
  const h = await taskHarness(t);
  const envelope = await h.scenes.get("demo", "version-a") as unknown as ContractEnvelope;

  // 这五个字段是任务页填输入的全部依据，缺一个都不能正确预填或提示。
  assert.ok(Array.isArray(envelope.workflow.inputs), "workflow.inputs");
  assert.ok(Array.isArray(envelope.inputRequirements), "inputRequirements");
  assert.ok(Array.isArray(envelope.inputExamples), "inputExamples");
  assert.equal(typeof envelope.inputDefaults, "object", "inputDefaults");
  assert.ok(Array.isArray(envelope.missingRequiredInputs), "missingRequiredInputs");

  // flag 必填但发布版给了 defaultValue:false；style 有发布版默认值。
  const fields = envelope.workflow.inputs!;
  assert.deepEqual(fields.map(field => field.key).sort(), ["flag", "style"]);
  assert.equal(envelope.inputDefaults.style, "已发布值", "默认值取发布快照而不是草稿值");
  assert.equal(envelope.inputDefaults.flag, false);

  // 预填必须与服务端默认值一致：表里看到的 == 实际执行的。
  const prefilled = prefillInputValues(fields);
  assert.deepEqual(prefilled, { flag: false, style: "已发布值" });

  // 两个字段都有默认值，必填已齐，不该在创建前误报缺项。
  assert.deepEqual(envelope.missingRequiredInputs, []);
  assert.deepEqual(rowMissingInputs(fields, prefilled), []);
  assert.ok(envelope.inputRequirements.every(item => item.needsValue === false), "有默认值的必填项不应标记 needsValue");

  // 示例是可直接提交的最小输入，且 flag 有默认值不算需要用户输入。
  const example = applyExampleValues(fields, envelope.inputExamples[0].inputValues);
  assert.equal(envelope.inputExamples[0].syntacticallyComplete, true);
  assert.deepEqual(example, { flag: false, style: "已发布值" });
  assert.deepEqual(envelope.inputExamples[0].requiresUserInput, []);
});

/** 给 demo 发布版加一个必填媒体输入，模拟真实场景（如电商套图的商品主图）。 */
async function addRequiredMediaInput(h: Awaited<ReturnType<typeof taskHarness>>) {
  await h.workspace.mutateScoped(current => {
    const versions = current.sceneVersions as Record<string, { versions: Array<Record<string, unknown>> }>;
    const workflowValue = versions.demo.versions[0].workflow as { inputs: WorkflowInputField[] };
    workflowValue.inputs = [...workflowValue.inputs, { key: "product_images", type: "image_list", required: true, label: "商品主图" } as WorkflowInputField];
    return { workspace: current, result: {}, changed: true };
  });
}

test("必填媒体没有默认值时，needsValue 与 missingRequiredInputs 如实上报，示例不伪造素材", async t => {
  const h = await taskHarness(t);
  await addRequiredMediaInput(h);
  const envelope = await h.scenes.get("demo", "version-a") as unknown as ContractEnvelope;
  const fields = envelope.workflow.inputs!;

  assert.equal(envelope.inputRequirements.find(item => item.key === "product_images")?.needsValue, true);
  assert.deepEqual(envelope.missingRequiredInputs, ["product_images"]);
  assert.deepEqual(envelope.inputExamples[0].missingRequiredInputs, ["product_images"]);
  assert.deepEqual(envelope.inputExamples[0].requiresUserInput, ["product_images"]);
  // 示例不得伪造 assetId，否则会让人以为可以直接提交。
  assert.equal("product_images" in envelope.inputExamples[0].inputValues, false);

  // 任务表格据此提示缺必填项，并在选了真实素材后不再提示。
  assert.deepEqual(rowMissingInputs(fields, prefillInputValues(fields)), ["商品主图"]);
  assert.deepEqual(rowMissingInputs(fields, { ...prefillInputValues(fields), product_images: [{ assetId: "real-asset", assetVersion: 1 }] }), []);
});

test("隐藏字段不参与缺项提示，其默认值仍然生效", async t => {
  const h = await taskHarness(t);
  await h.workspace.mutateScoped(current => {
    const versions = current.sceneVersions as Record<string, { versions: Array<Record<string, unknown>> }>;
    const workflowValue = versions.demo.versions[0].workflow as { inputs: WorkflowInputField[] };
    workflowValue.inputs = [...workflowValue.inputs, { key: "internal_note", type: "text", required: true, hidden: true, defaultValue: "内部固定值" } as WorkflowInputField];
    return { workspace: current, result: {}, changed: true };
  });
  const envelope = await h.scenes.get("demo", "version-a") as unknown as ContractEnvelope;
  const fields = envelope.workflow.inputs!;

  // 有默认值的隐藏必填字段不应被报为缺项，也不该出现在表单里。
  assert.deepEqual(envelope.missingRequiredInputs, []);
  assert.equal(envelope.inputDefaults.internal_note, "内部固定值");
  assert.deepEqual(rowMissingInputs(fields, prefillInputValues(fields)), []);
});
