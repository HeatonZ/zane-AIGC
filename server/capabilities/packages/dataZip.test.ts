import test from "node:test";
import assert from "node:assert/strict";
import { prepareDataZip, zipDataLists } from "../../services/dataZipService.js";
import { createRuntimeMediaValue, runtimeMediaItems } from "../../runtimeValue.js";
import { resolvePromptTemplate, resolveWorkflowValue, workflowMediaValueKind } from "../../domain/workflowValues.js";
import { selectMediaReferences } from "../../services/mediaReferenceService.js";
import mediaFactory from "./mediaReferences.js";
import type { CapabilityRuntime } from "../package.js";
import type { StepExecutionContext } from "../../execution/workflowExecutor.js";
const config = { itemKey: "card", identityField: "id", minItems: 1, maxItems: 8, itemSchema: { type: "object", properties: { id: { type: "string", minLength: 1 }, role: { type: "string" } }, required: ["id", "role"], additionalProperties: false } };
const cards = [{ id: "a", role: "selling_point" }, { id: "b", role: "selling_point" }];
test("列表对齐保留顺序、重复角色与媒体，拆分首项/rest且不改输入", () => {
  const inputs = { items: cards, expected_count: "2", prompt: ["first", "second"], references: [{ images: createRuntimeMediaValue("image", ["a.png"]) }, { images: createRuntimeMediaValue("image", ["b.png"]) }] };
  const before = structuredClone(inputs); const result = zipDataLists(config, inputs);
  assert.deepEqual(result.rows, cards.map((card, index) => ({ card, prompt: inputs.prompt[index], references: inputs.references[index] })));
  assert.deepEqual(result.first, result.rows[0]); assert.deepEqual(result.rest, result.rows.slice(1)); assert.deepEqual(inputs, before);
  assert.deepEqual(zipDataLists(config, { items: [cards[0]], expected_count: 1 }).rest, []);
  assert.deepEqual(zipDataLists(config, { items: cards, image: createRuntimeMediaValue("image", ["a.png", "b.png"]) }).rows.map(row => (row as Record<string, unknown>).image), ["a.png", "b.png"]);
});
test("列表对齐拒绝漏项、数量不符、重复ID/空ID、失败空位、非法结构和列名", () => {
  for (const [inputs, pattern] of [
    [{ items: [] }, /项数范围/], [{ items: cards, expected_count: 1 }, /expected_count/], [{ items: cards, expected_count: "02" }, /expected_count/],
    [{ items: cards, prompt: ["one"] }, /项数不一致/], [{ items: cards, prompt: ["one", null] }, /不能错位关联/],
    [{ items: [cards[0], cards[0]] }, /唯一字符串/], [{ items: [{ id: " ", role: "hero" }] }, /唯一字符串/],
    [{ items: [{ id: "a", role: 2 }] }, /itemSchema/], [{ items: [{ ...cards[0], invented: true }] }, /itemSchema/],
    [{ items: cards, card: [1, 2] }, /保留字段/], [{ items: [null] }, /项为空/],
  ] as Array<[Record<string, unknown>, RegExp]>) assert.throws(() => zipDataLists(config, inputs), pattern);
  assert.throws(() => prepareDataZip({ itemSchema: { type: "object", $ref: "https://example.invalid/schema" } }), /配置无效/);
  assert.throws(() => prepareDataZip({ itemSchema: { type: "string", pattern: "(a+)+$" } }), /配置无效/);
  assert.throws(() => prepareDataZip({ minItems: 8, maxItems: 1 }), /最小项数/);
  let nested: unknown = { type: "string" }; for (let index = 0; index < 30; index++) nested = { type: "array", items: nested };
  assert.throws(() => prepareDataZip({ itemSchema: nested }), /嵌套过深/);
});
test("媒体all保留组序、空组与编号，旧输出不新增bundle，新声明保存逐项边界", async () => {
  const groups = [{ key: "products", kind: "image", tag: "Product" }, { key: "styles", kind: "image", tag: "Style" }];
  const sources = { products: ["one.png", "two.png"], styles: ["style.png"] };
  const selected = selectMediaReferences(groups, sources, { products: "all", styles: "all" });
  assert.deepEqual(selected.indices, { products: [1, 2], styles: [1] }); assert.equal(runtimeMediaItems(selected.images).length, 3);
  assert.deepEqual(selectMediaReferences(groups, { products: [], styles: [] }, { products: "all", styles: "all" }).indices, { products: [], styles: [] });
  assert.throws(() => selectMediaReferences(groups, sources, { products: "all" }), /不能省略/);
  const pkg = await mediaFactory({} as CapabilityRuntime); assert.ok(!Array.isArray(pkg));
  const context = { step: { id: "refs", name: "refs", kind: "capability", capabilityConfig: { groups }, inputs: Object.keys({ ...sources, selection: 1 }).map(key => ({ key, sourceRef: "input." + key })), outputs: [{ key: "selected", type: "json" }] }, inputValues: { ...sources, selection: { products: [2], styles: [1] } }, stepValues: new Map() } as unknown as StepExecutionContext;
  assert.equal((await pkg.execute(context)).bundle, undefined);
  context.step.outputs!.push({ key: "bundle", type: "json" }); const result = await pkg.execute(context);
  const bundle = result.bundle as Record<string, unknown>; assert.equal(runtimeMediaItems(bundle.images).length, 2); assert.deepEqual(bundle.indices, { products: [2], styles: [1] });
});
test("Hermes嵌套JSON媒体仍识别为实际附件，模板不泄露媒体JSON或路径", () => {
  const images = createRuntimeMediaValue("image", ["C:/private/product.png"]);
  assert.equal(workflowMediaValueKind(images, "json"), "image"); assert.equal(workflowMediaValueKind({}, "json"), undefined);
  assert.throws(() => workflowMediaValueKind(images, "audio_list"), /不一致/);
  assert.equal(resolvePromptTemplate("refs={{input.job.images}}", { job: { images } }, new Map(), new Map([["input.job", "json"]])), "refs=[图片已作为附件提供]");
});


test("JSON字段媒体注解在审核持久化后恢复附件，拒绝明确类型不符", () => {
  const reference = { key: "refs", sourceRef: "input.job.images", referenceType: "image_list" as const };
  const restored = resolveWorkflowValue(reference, { job: { images: ["product.png", "style.png"] } }, new Map());
  assert.equal(workflowMediaValueKind(restored, "json"), "image"); assert.equal(runtimeMediaItems(restored).length, 2);
  assert.equal(workflowMediaValueKind(resolveWorkflowValue({ ...reference, referenceType: undefined }, { job: { images: ["product.png"] } }, new Map()), "json"), undefined);
  assert.throws(() => resolveWorkflowValue(reference, { job: { images: createRuntimeMediaValue("audio", ["voice.wav"]) } }, new Map()), /不一致/);
  assert.equal(resolvePromptTemplate("refs={{input.job.images}}", { job: { images: ["private/product.png"] } }, new Map(), new Map([["input.job", "json"], ["input.job.images", "image_list"]])), "refs=[图片已作为附件提供]");
  assert.equal(runtimeMediaItems(resolveWorkflowValue({ ...reference, selection: { mode: "item", index: 1 } }, { job: { images: ["a.png", "b.png"] } }, new Map())).length, 1);
});

test("data.zip草稿校验拒绝类型不适用或互相冲突的Schema约束", () => {
  for (const itemSchema of [
    { type: "number", minLength: 1 }, { type: "string", minLength: 5, maxLength: 1 },
    { type: "array", minItems: 8, maxItems: 1 }, { type: "integer", minimum: 5, maximum: 1 },
    { type: "object", additionalProperties: false, required: ["missing"] },
    { type: "object", required: ["id", "id"] }, { type: "number", enum: ["not a number"] },
  ]) assert.throws(() => prepareDataZip({ itemSchema }), /配置无效/);
});
