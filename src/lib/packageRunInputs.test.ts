import assert from "node:assert/strict";
import test from "node:test";
import { reusableInputs, isReusableMediaReference } from "./packageRunInputs";
import type { RunInputFieldShape } from "../components/RunInputSnapshot";

const field = (key: string, type: string, extra: Partial<RunInputFieldShape> = {}): RunInputFieldShape => ({
  key, label: key, type, required: false, present: true,
  valuePage: { kind: "scalar", total: 1, offset: 0, count: 1, pageSize: 1, complete: true, hasMore: false },
  ...extra,
});
const packageField = (key: string, type: string, extra: Record<string, unknown> = {}) => ({ key, label: key, type, required: false, hidden: false, ...extra });

test("复用参数只带当前发布版仍声明且合法的字段，其余丢弃并说明", () => {
  const inputs = [
    field("prompt", "textarea", { value: "一只猫" }),
    field("removed", "text", { value: "旧字段" }),
    field("count", "number", { value: 9 }),
    field("style", "select", { value: "已下线选项" }),
    field("keep", "text", { value: "保留" }),
  ];
  const fields = [packageField("prompt", "textarea"), packageField("count", "number", { maximum: 4 }), packageField("style", "select", { options: ["新选项"] }), packageField("keep", "text")];
  const result = reusableInputs(inputs, fields);
  assert.deepEqual(result.values, { prompt: "一只猫", keep: "保留" });
  assert.deepEqual(result.dropped, ["removed", "count", "style"]);
  assert.match(result.notice, /2 个字段/);
  assert.match(result.notice, /removed/);
});

test("复用参数不把省略值或未填写当成有效值", () => {
  const omitted = field("prompt", "textarea", { valueOmitted: true, omissionReason: "value_byte_limit" });
  const absent = field("count", "number", { present: false, value: undefined });
  const result = reusableInputs([omitted, absent], [packageField("prompt", "textarea"), packageField("count", "number")]);
  assert.deepEqual(result.values, {});
  assert.deepEqual(result.dropped, ["prompt"], "被省略的已填写字段要说明未带入，未填写的字段不算丢弃");
});

test("媒体只复用固定素材引用，单值/列表按当前字段类型收窄", () => {
  const ref = { assetId: "asset-1", assetVersion: 2, assetName: "参考图" };
  assert.equal(isReusableMediaReference(ref), true);
  assert.equal(isReusableMediaReference({ assetId: "asset-1" }), false, "没有固定版本不能复用");
  assert.equal(isReusableMediaReference({ locatorOmitted: true }), false);
  const inputs = [field("images", "image_list", { value: [ref] }), field("single", "image", { value: [ref, { assetId: "asset-2", assetVersion: 1 }] })];
  const fields = [packageField("images", "image_list"), packageField("single", "image")];
  const result = reusableInputs(inputs, fields);
  assert.deepEqual(result.values.images, [{ assetId: "asset-1", assetVersion: 2 }], "只保留 assetId+assetVersion，不把展示名或路径带进表单");
  assert.deepEqual(result.values.single, { assetId: "asset-1", assetVersion: 2 }, "单值字段取第一项");
});

test("没有输入字段时给出明确文案，不显示伪造的复用数量", () => {
  assert.equal(reusableInputs([], []).notice, "这个服务没有可复用的输入字段。");
});
