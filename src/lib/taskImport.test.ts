import assert from "node:assert/strict";
import test from "node:test";
import { cleanTaskItemInputs, parseTaskItemsPaste, PasteImportError } from "./taskImport.js";

const options = { defaultSceneId: "demo", defaultVersionId: "version-a", knownSceneIds: ["demo", "demo2"] };

test("粘贴导入：无表头时按位置理解列，缺省场景与发布版来自左侧选择", () => {
  const items = parseTaskItemsPaste("第 1 张\n第 2 张", options);
  assert.deepEqual(items, [
    { label: "第 1 张", sceneId: "demo", versionId: "version-a", inputValues: {} },
    { label: "第 2 张", sceneId: "demo", versionId: "version-a", inputValues: {} },
  ]);
});

test("粘贴导入：Tab 分列 + 中文表头 + JSON 输入", () => {
  const text = ["名称\t场景\t发布版本\t输入", "第 1 张\tdemo\tversion-a\t{\"flag\":true}", "第 2 张\tdemo2\tversion-b\t{\"flag\":false}"].join("\n");
  const items = parseTaskItemsPaste(text, options);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { label: "第 1 张", sceneId: "demo", versionId: "version-a", inputValues: { flag: true } });
  assert.deepEqual(items[1], { label: "第 2 张", sceneId: "demo2", versionId: "version-b", inputValues: { flag: false } });
});

test("粘贴导入：英文表头与纯文本输入回退到 text 键", () => {
  const text = ["label\tsceneId\tinputs", "第一张\tdemo\t一只猫在窗台"].join("\n");
  const items = parseTaskItemsPaste(text, options);
  assert.deepEqual(items[0].inputValues, { text: "一只猫在窗台" });
});

test("粘贴导入：注释与空行被跳过", () => {
  const items = parseTaskItemsPaste("# 本次批量\n\n第 1 张\n\n# 分隔\n第 2 张\n", options);
  assert.equal(items.length, 2);
});

test("粘贴导入：非法输入明确报错并指出行号，不静默丢弃", () => {
  assert.throws(() => parseTaskItemsPaste("", options), (error: Error) => error instanceof PasteImportError && /没有可导入/.test(error.message));
  assert.throws(() => parseTaskItemsPaste("名称\t输入\n第 1 张\t{不是JSON}", options), (error: PasteImportError) => /第 2 行/.test(error.message) && /合法 JSON/.test(error.message));
  assert.throws(() => parseTaskItemsPaste("名称\t场景\n第 1 张\t不存在的场景", options), (error: PasteImportError) => /第 2 行/.test(error.message) && /不在当前已发布场景/.test(error.message));
  // 只有表头没有数据行也必须拒绝，否则会静默创建空任务。
  assert.throws(() => parseTaskItemsPaste("名称\t场景", options), (error: PasteImportError) => /只有表头/.test(error.message));
  // 没有默认场景且行内也没给场景时拒绝。
  assert.throws(() => parseTaskItemsPaste("第 1 张", { defaultSceneId: "", defaultVersionId: "", knownSceneIds: [] }), (error: PasteImportError) => /没有场景/.test(error.message));
  assert.throws(() => parseTaskItemsPaste("第 1 张", { defaultSceneId: "demo", defaultVersionId: "", knownSceneIds: [] }), (error: PasteImportError) => /没有发布版本/.test(error.message));
});

test("粘贴导入：每行场景可以不同，一个任务跨场景", () => {
  const text = ["第 1 张\tdemo\tversion-a", "第 2 张\tdemo2\tversion-b"].join("\n");
  const items = parseTaskItemsPaste(text, options);
  assert.deepEqual(items.map(item => item.sceneId), ["demo", "demo2"]);
  assert.deepEqual(items.map(item => item.versionId), ["version-a", "version-b"]);
});

test("提交前清理：未填写的字段表达为缺键，不覆盖发布版默认值", () => {
  const cleaned = cleanTaskItemInputs([
    // 空串、undefined 都是「没填」；false 和 0 是真实值，必须保留。
    { label: "  第 1 张  ", sceneId: "demo", versionId: "version-a", inputValues: { flag: false, count: 0, style: "", note: undefined } },
    { label: "", sceneId: "demo", versionId: "version-a", inputValues: {} },
  ]);
  assert.deepEqual(cleaned[0].inputValues, { flag: false, count: 0 });
  assert.equal(cleaned[0].label, "第 1 张");
  // 空标签交给服务端按序号自动命名，而不是提交空字符串。
  assert.equal("label" in cleaned[1], false);
  assert.deepEqual(cleaned[1].inputValues, {});
});
