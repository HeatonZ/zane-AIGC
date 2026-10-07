import test from "node:test";
import assert from "node:assert/strict";
import { resolveComfyUIReroutes, COMFY_UI_ROUTING_CONTRACT } from "./comfyuiReroutes.js";
import { HttpError } from "./errors.js";
import { createAiOpenApi } from "./ai/openapi.js";
const node = (class_type: string, inputs: Record<string, unknown> = {}) => ({ class_type, inputs });
test("UI reroute chains preserve source slots and fan-out without mutating the input", () => {
 const graph = { a: node("Producer"), r1: node("Reroute", { "": ["a", 2] }), r2: node("Reroute", { "": ["r1", 0] }), b: node("Consumer", { x: ["r2", 0], flag: false }), c: node("Consumer", { y: ["r1", 0], literal: [1, 2, 3] }) };
 const before = structuredClone(graph); const out = resolveComfyUIReroutes(graph);
 assert.deepEqual(Object.keys(out), ["a", "b", "c"]); assert.deepEqual(out.b.inputs, { x: ["a", 2], flag: false }); assert.deepEqual(out.c.inputs, { y: ["a", 2], literal: [1, 2, 3] }); assert.deepEqual(graph, before);
});
test("native backend nodes and ordinary literal arrays are unchanged", () => { const graph = { a: node("NativeRouting", { input: ["external", 0], size: [64, 64] }) }; assert.deepEqual(resolveComfyUIReroutes(graph), graph); });
const invalidFixtures: Record<string, Record<string, Record<string, unknown>>> = { cycle: { r: node("Reroute", { "": ["s", 0] }), s: node("Reroute", { "": ["r", 0] }) }, missing_source: { r: node("Reroute", { "": ["absent", 0] }) }, multiple_sources: { a: node("Producer"), r: node("Reroute", { x: ["a", 0], y: ["a", 0] }) }, invalid_output_slot: { a: node("Producer"), r: node("Reroute", { "": ["a", 0] }), b: node("Consumer", { x: ["r", 1] }) } };
for (const [reason, graph] of Object.entries(invalidFixtures)) {
 test("invalid UI reroute rejects " + reason, () => assert.throws(() => resolveComfyUIReroutes(graph), error => error instanceof HttpError && error.status === 400 && error.code === "INVALID_COMFY_REROUTE" && error.details?.reason === reason));
}
test("unconnected frontend reroute rejects before external submission", () => assert.throws(() => resolveComfyUIReroutes({ r: node("Reroute") }), /missing_source/));
test("AI machine contract describes routing and deterministic rejection", () => { assert.deepEqual(createAiOpenApi()["x-comfy-ui-routing"], COMFY_UI_ROUTING_CONTRACT); });
