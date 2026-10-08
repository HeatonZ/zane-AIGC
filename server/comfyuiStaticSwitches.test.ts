import assert from "node:assert/strict";
import { test } from "node:test";
import { specializeComfyStaticSwitches, COMFY_STATIC_SWITCH_CONTRACT } from "./comfyuiStaticSwitches.js";
const graph = (value: unknown = false) => ({
  flag: { class_type: "PrimitiveBoolean", inputs: { value } },
  switch: { class_type: "ComfySwitchNode", inputs: { switch: ["flag", 0], on_false: ["first", 0], on_true: ["guide", 0] } },
  first: { class_type: "TestSource", inputs: {} }, guide: { class_type: "TestGuide", inputs: { video: ["load", 0] } },
  load: { class_type: "LoadVideo", inputs: { file: "missing-sample.mp4" } },
  output: { class_type: "SaveVideo", inputs: { video: ["switch", 0] } },
});
test("static false keeps IDs/source graph but disconnects guide and missing loader from output", () => {
  const source = graph(), before = structuredClone(source), result = specializeComfyStaticSwitches(source);
  assert.deepEqual(source, before); assert.deepEqual(Object.keys(result), Object.keys(source));
  assert.deepEqual(result.switch.inputs, { switch: ["flag", 0], on_false: ["first", 0] });
  assert.deepEqual(result.load, source.load); assert.deepEqual(result.output, source.output);
});
test("static true preserves previous video/guide, removes only false input", () => {
  const result = specializeComfyStaticSwitches(graph(true));
  assert.deepEqual(result.switch.inputs, { switch: ["flag", 0], on_true: ["guide", 0] });
  assert.equal((result.load.inputs as Record<string, unknown>).file, "missing-sample.mp4");
});
test("strict literal selectors are supported", () => {
  const source = graph(); (source.switch.inputs as Record<string, unknown>).switch = true;
  assert.ok(!Object.hasOwn(specializeComfyStaticSwitches(source).switch.inputs as object, "on_false"));
});
test("unknown boolean sources and strings/numbers/null are never coerced", () => {
  for (const value of ["false", "true", 0, 1, null, undefined]) { const source = graph(); source.flag.inputs.value = value; assert.deepEqual(specializeComfyStaticSwitches(source), source); }
  const source = graph(); source.flag.class_type = "CustomBoolean"; assert.deepEqual(specializeComfyStaticSwitches(source), source);
});
test("cyclic selectors and nonzero output slots stay unchanged", () => {
  const source = graph(); source.flag = { class_type: "ComfyNotNode", inputs: { value: ["flag", 0] } } as typeof source.flag;
  assert.deepEqual(specializeComfyStaticSwitches(source), source);
  const other = graph(); other.switch.inputs.switch = ["flag", 1]; assert.deepEqual(specializeComfyStaticSwitches(other), other);
});
test("Boolean not and selected nested switch output resolve without executing nodes", () => {
  const source: Record<string, Record<string, unknown>> = graph();
  source.not = { class_type: "ComfyNotNode", inputs: { value: ["flag", 0] } };
  source.outer = { class_type: "ComfySwitchNode", inputs: { switch: ["inner", 0], on_true: 3, on_false: 4 } };
  source.inner = { class_type: "ComfySwitchNode", inputs: { switch: ["not", 0], on_true: true, on_false: ["unknown", 0] } };
  const result = specializeComfyStaticSwitches(source);
  assert.deepEqual(result.outer.inputs, { switch: ["inner", 0], on_true: 3 });
});
test("other consumers, output nodes and inactive node objects remain untouched", () => {
  const source: Record<string, Record<string, unknown>> = graph(); source.other = { class_type: "SaveVideo", inputs: { video: ["guide", 0] } };
  const result = specializeComfyStaticSwitches(source); assert.deepEqual(result.other, source.other); assert.deepEqual(result.guide, source.guide);
});
test("dynamic branch evaluation remains provider responsibility, selected invalid branch is never hidden", () => {
  const source = graph(); source.flag.class_type = "RandomBoolean";
  assert.deepEqual(specializeComfyStaticSwitches(source), source);
  const selected = graph(true); delete (selected.load.inputs as Record<string, unknown>).file;
  assert.deepEqual(specializeComfyStaticSwitches(selected).load, selected.load);
});
test("unknown custom switches and unrelated nodes remain unchanged; transformation idempotent", () => {
  const source = graph(); source.switch.class_type = "CustomSwitch"; assert.deepEqual(specializeComfyStaticSwitches(source), source);
  const result = specializeComfyStaticSwitches(graph()); assert.deepEqual(specializeComfyStaticSwitches(result), result);
  assert.equal(COMFY_STATIC_SWITCH_CONTRACT.version, 1);
});
