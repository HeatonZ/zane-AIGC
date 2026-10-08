import assert from "node:assert/strict";
import { test } from "node:test";
import { comfyNamedAutogrowSchemas, comfyNodeInputSchema } from "./comfyuiInputSchema.js";
const schema = ["COMFY_AUTOGROW_V3", { template: { input: { required: { value: ["FLOAT,INT,BOOLEAN", {}] } }, names: ["a", "b"], min: 1 } }];
const info = { Math: { input: { required: { expression: ["STRING", {}], values: schema }, optional: { optional: ["BOOLEAN", {}] } } } };
test("direct required and optional ports unchanged", () => {
  assert.deepEqual(comfyNodeInputSchema(info, "Math", "expression"), ["STRING", {}]);
  assert.deepEqual(comfyNodeInputSchema(info, "Math", "optional"), ["BOOLEAN", {}]);
});
test("named V3 autogrow resolves only enumerated children in required or optional section", () => {
  assert.deepEqual(comfyNodeInputSchema(info, "Math", "values.b"), ["FLOAT,INT,BOOLEAN", {}]);
  assert.deepEqual(comfyNodeInputSchema({ input: { optional: { values: schema } } }, "Math", "values.a"), ["FLOAT,INT,BOOLEAN", {}]);
  assert.deepEqual(Object.keys(comfyNamedAutogrowSchemas(schema, "values")), ["values.a", "values.b"]);
});
test("unknown, extra dotted and prototype ports rejected", () => {
  for (const name of ["values.c", "values.b.x", "fake.b", "values.__proto__", "toString"]) assert.equal(comfyNodeInputSchema(info, "Math", name), undefined);
});
test("arbitrary prefix and malformed/ambiguous schemas not treated as named ports", () => {
  for (const bad of [["COMFY_AUTOGROW_V3", { template: { prefix: "value", input: {} } }], ["COMFY_AUTOGROW_V3", { template: { names: ["a"], input: { required: { a: ["INT"], b: ["INT"] } } } }], ["STRING", { template: { names: ["a"] } }]]) assert.deepEqual(comfyNamedAutogrowSchemas(bad, "values"), {});
});
