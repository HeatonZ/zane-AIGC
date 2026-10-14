import assert from "node:assert/strict";
import test from "node:test";
import { applyExampleValues, contractState, isEmptyInputValue, mediaKindOf, isMultipleMedia, prefillInputValues, rowBlockReason, rowMissingInputs, rowsOfTaskItems } from "./taskInput.js";
import type { WorkflowInputField } from "../types.js";

const field = (value: Partial<WorkflowInputField> & { key: string; type: WorkflowInputField["type"] }): WorkflowInputField => value as WorkflowInputField;

// 取自真实场景「电商套图自研版」的发布版输入契约。
const commerce: WorkflowInputField[] = [
  field({ key: "product_images", type: "image_list", required: true, label: "商品主图" }),
  field({ key: "need", type: "textarea", required: false, label: "描述", defaultValue: "无" }),
  field({ key: "reference", type: "image_list", required: false, label: "风格参考", hidden: true }),
  field({ key: "language", type: "text", required: true, label: "语言", defaultValue: "英文" }),
  field({ key: "width", type: "number", required: true, label: "宽", minimum: 1, maximum: 1600, defaultValue: 1024 }),
  field({ key: "number", type: "select", required: true, label: "数量", options: ["1", "2", "3", "4"], defaultValue: "4" }),
];

test("新行预填发布版默认值，让表里显示的就是服务端实际会用的值", () => {
  assert.deepEqual(prefillInputValues(commerce), { need: "无", language: "英文", width: 1024, number: "4" });
  // 必填媒体没有默认值：保持缺键，不伪造素材引用。
  assert.equal("product_images" in prefillInputValues(commerce), false);
});

test("必填媒体没填时明确说出缺哪个字段，隐藏字段不参与", () => {
  assert.deepEqual(rowMissingInputs(commerce, prefillInputValues(commerce)), ["商品主图"]);
  assert.deepEqual(rowMissingInputs(commerce, prefillInputValues(commerce), { hiddenKeys: ["product_images"] }), []);
  // 补上媒体后不再报缺。
  assert.deepEqual(rowMissingInputs(commerce, { ...prefillInputValues(commerce), product_images: [{ assetId: "a", assetVersion: 1 }] }), []);
});

test("以服务端 needsValue 为准：能发现「有默认值但默认值不合法」这类前端推不出的缺项", () => {
  // width 有默认值 1024，前端自己推会认为已填；服务端说它需要值就必须提示。
  const values = prefillInputValues(commerce);
  assert.deepEqual(rowMissingInputs(commerce, values), ["商品主图"]);
  assert.deepEqual(rowMissingInputs(commerce, values, { needsValueKeys: ["width", "product_images"] }), ["商品主图", "宽"]);
  // 填好之后按实际值消失，不会被服务端列表永久卡住。
  assert.deepEqual(rowMissingInputs(commerce, { ...values, width: 1200 }, { needsValueKeys: ["width"] }), []);
});

test("空值判定与服务端一致：空串、空列表、空对象数组都算没填", () => {
  const media = commerce[0], text = commerce[3], rows = field({ key: "specs", type: "json", required: true, inputMode: "object_array" });
  for (const empty of [undefined, null, "", [], "  "]) assert.equal(isEmptyInputValue(media, empty), true, "媒体 " + JSON.stringify(empty));
  assert.equal(isEmptyInputValue(media, [{ assetId: "a", assetVersion: 1 }]), false);
  assert.equal(isEmptyInputValue(text, "英文"), false);
  assert.equal(isEmptyInputValue(rows, []), true);
  assert.equal(isEmptyInputValue(rows, [{ size: "S" }]), false);
  // number 的 0 是有效值，不能当成没填。
  assert.equal(isEmptyInputValue(commerce[4], 0), false);
});

test("按示例填充只取已声明字段，示例缺失的字段继续沿用发布版默认值", () => {
  const applied = applyExampleValues(commerce, { number: "2", unknown_key: "不该带进来" });
  assert.deepEqual(applied, { number: "2" });
  assert.deepEqual(applyExampleValues(commerce, undefined), {});
});

test("媒体字段按类型选择控件：kind 与是否多选", () => {
  assert.equal(mediaKindOf(commerce[0]), "image");
  assert.equal(isMultipleMedia(commerce[0]), true);
  assert.equal(mediaKindOf(field({ key: "voice", type: "audio", required: true })), "audio");
  assert.equal(isMultipleMedia(field({ key: "voice", type: "audio", required: true })), false);
  assert.equal(isMultipleMedia(field({ key: "clips", type: "video_list", required: true })), true);
  assert.equal(mediaKindOf(field({ key: "cover", type: "image", required: true })), "image");
});

test("单行提交拦截：没选场景先拦，缺必填列出字段名，齐了才放行", () => {
  const ok = { sceneId: "demo", versionId: "version-a" };
  // 没有场景/发布版时优先提示选场景，而不是报一堆缺字段。
  assert.match(rowBlockReason({ sceneId: "", versionId: "" }, ["商品主图"])!, /请先选择场景/);
  assert.match(rowBlockReason(ok, ["商品主图", "描述"])!, /还缺必填：商品主图、描述/);
  assert.equal(rowBlockReason(ok, []), null);
  // versionId 缺失同样按「没固定发布版」拦下：任务项必须固定已发布快照。
  assert.match(rowBlockReason({ sceneId: "demo", versionId: "" }, [])!, /请先选择场景/);
});

const emptyContract = { fields: [] as const, error: undefined as string | undefined };

test("契约阶段：没有输入字段的发布版是「无需填写」，不能永远停在读取中", () => {
  // 已发布工作流可以合法地没有输入字段。只看 fields.length 会把它显示成
  // 「正在读取该发布版的输入契约…」，页面看起来就卡住了，创建按钮也点不了。
  assert.deepEqual(contractState({ hasScene: true, contract: emptyContract }).phase, "empty");
  assert.deepEqual(contractState({ hasScene: true, contract: { fields: [{ key: "a" }] } }).phase, "ready");
});

test("契约阶段：读取失败要报错，不能退化成无限读取", () => {
  const failed = contractState({ hasScene: true, contract: { fields: [], error: "场景发布版不存在" } });
  assert.equal(failed.phase, "failed");
  // 失败原因必须能显示出来，否则用户只知道「卡住」而不知道该重试还是改配置。
  assert.equal(failed.phase === "failed" ? failed.error : "", "场景发布版不存在");
});

test("契约阶段：未选场景与真正在读取互相区分", () => {
  assert.equal(contractState({ hasScene: false }).phase, "no_scene");
  // 已选场景但契约还没回来：这才是真正的「读取中」。
  assert.equal(contractState({ hasScene: true }).phase, "loading");
});

test("任务项回填：打开草稿与创建回执都用服务端已保存的输入，不重置成默认值", () => {
  const rows = rowsOfTaskItems([
    { label: "第 1 张", sceneId: "demo", versionId: "version-a", inputValues: { flag: true, count: 3, style: "写实" } },
    { label: "第 2 张", sceneId: "demo2", versionId: "version-b", inputValues: {} },
  ]);
  // 用户手填的内容必须原样回到表格里：创建后重置成一行默认值会让人以为输入丢了。
  assert.deepEqual(rows[0], { label: "第 1 张", sceneId: "demo", versionId: "version-a", inputValues: { flag: true, count: 3, style: "写实" } });
  assert.equal(rows[1].label, "第 2 张");
  assert.deepEqual(rows[1].inputValues, {});
  // 没有 label 的项按空串处理，交给输入框占位符显示序号。
  assert.equal(rowsOfTaskItems([{ sceneId: "demo", versionId: "version-a" }])[0].label, "");
});

test("任务项回填：深拷贝输入，改表格不会改到已选任务的快照", () => {
  const items = [{ sceneId: "demo", versionId: "version-a", inputValues: { nested: { deep: [1, 2] } } }];
  const rows = rowsOfTaskItems(items);
  (rows[0].inputValues.nested as { deep: number[] }).deep.push(3);
  // 共享引用会让「改了没保存」悄悄污染 selected 快照，确认提交时用的是被改过的数据。
  assert.deepEqual(items[0].inputValues, { nested: { deep: [1, 2] } });
});
