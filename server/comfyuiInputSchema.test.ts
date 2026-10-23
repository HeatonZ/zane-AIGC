import assert from "node:assert/strict";
import { test } from "node:test";
import { comfyDynamicComboOptions, comfyDynamicComboSchemas, comfyNamedAutogrowSchemas, comfyNodeInputSchema } from "./comfyuiInputSchema.js";
const schema = ["COMFY_AUTOGROW_V3", { template: { input: { required: { value: ["FLOAT,INT,BOOLEAN", {}] } }, names: ["a", "b"], min: 1 } }];
const info = { Math: { input: { required: { expression: ["STRING", {}], values: schema }, optional: { optional: ["BOOLEAN", {}] } } } };
const dynamic = ["COMFY_DYNAMICCOMBO_V3", { options: [
  { key: "width x height (megapixels)", inputs: { required: { aspect_ratio: ["COMBO", { options: ["1:1 (Square)", "16:9 (Widescreen)"] }], megapixels: ["FLOAT", { min: 0.1, max: 16 }] } } },
  { key: "480 x 832 (9:16)", inputs: { required: { resize_method: ["COMBO", { options: ["stretch", "pad"] }] } } },
] }];
const dynamicInfo = { Editor: { input: { required: { resolution: dynamic, track_data: ["TRACK_DATA", {}] } } } };
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
test("V3 dynamic combo exposes children of the selected option only", () => {
  // The editor only materializes resolution.aspect_ratio/megapixels while that option is selected;
  // binding them against any other selection would target inputs that do not exist at runtime.
  assert.deepEqual(comfyDynamicComboSchemas(dynamic, "resolution", "width x height (megapixels)"), {
    "resolution.aspect_ratio": ["COMBO", { options: ["1:1 (Square)", "16:9 (Widescreen)"] }],
    "resolution.megapixels": ["FLOAT", { min: 0.1, max: 16 }],
  });
  assert.deepEqual(Object.keys(comfyDynamicComboSchemas(dynamic, "resolution", "480 x 832 (9:16)")), ["resolution.resize_method"]);
  // An unknown or absent selection expands nothing: the children are not real inputs.
  for (const selected of [undefined, null, "", "Custom", 42]) assert.deepEqual(comfyDynamicComboSchemas(dynamic, "resolution", selected), {});
  const childSchema = comfyNodeInputSchema(dynamicInfo, "Editor", "resolution.aspect_ratio", "width x height (megapixels)") as unknown[] | undefined;
  assert.equal(childSchema?.[0], "COMBO");
  assert.equal(comfyNodeInputSchema(dynamicInfo, "Editor", "resolution.aspect_ratio", "480 x 832 (9:16)"), undefined);
  // The parent combo and its siblings stay addressable regardless of the selection.
  assert.deepEqual(comfyNodeInputSchema(dynamicInfo, "Editor", "resolution"), dynamic);
  assert.deepEqual(comfyNodeInputSchema(dynamicInfo, "Editor", "track_data"), ["TRACK_DATA", {}]);
});
test("V3 dynamic combo options reject malformed payloads", () => {
  for (const bad of [["COMFY_DYNAMICCOMBO_V3"], ["COMFY_DYNAMICCOMBO_V3", {}], ["COMFY_DYNAMICCOMBO_V3", { options: [] }], ["COMBO", { options: [{ key: "a", inputs: {} }] }]]) assert.deepEqual(comfyDynamicComboOptions(bad), []);
  assert.deepEqual(comfyDynamicComboOptions(["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "a", inputs: { required: { x: ["INT", {}] } } }, { key: 1, inputs: {} }] }]), [{ key: "a", inputs: { required: { x: ["INT", {}] } } }]);
});
