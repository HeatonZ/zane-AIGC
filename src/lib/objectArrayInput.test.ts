import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowInputField } from "../types";
import { parseObjectArrayFormValue } from "./objectArrayInput";

const field: WorkflowInputField = {
  key: "specs", label: "规格数组", type: "json", required: true, inputMode: "object_array",
  itemFields: [
    { key: "size", label: "尺寸", type: "select", required: true, options: ["S", "M"] },
    { key: "type", label: "类型", type: "text", required: true },
    { key: "stock", label: "库存", type: "number", required: false },
    { key: "available", label: "在售", type: "boolean", required: false },
  ],
};

test("object-array form serializes row fields as typed objects", () => {
  assert.deepEqual(parseObjectArrayFormValue(field, [
    { size: "S", type: "圆领", stock: "12", available: false },
    { size: "M", type: "V领" },
  ]), [
    { size: "S", type: "圆领", stock: 12, available: false },
    { size: "M", type: "V领" },
  ]);
});

test("object-array form rejects invalid rows, required cells, options, and excessive rows", () => {
  for (const value of [
    [], [{ size: "XL", type: "圆领" }], [{ size: "S" }], [{ size: "S", type: "圆领", extra: "x" }],
    [{ size: "S", type: "圆领", stock: "many" }], ["row"],
  ]) assert.throws(() => parseObjectArrayFormValue(field, value));
  assert.throws(() => parseObjectArrayFormValue(field, Array.from({ length: 101 }, () => ({ size: "S", type: "圆领" }))));
});
