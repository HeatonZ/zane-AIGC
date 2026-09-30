import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeMediaValue,
  isRuntimeMediaValue,
  mediaKindFromWorkflowType,
  runtimeMediaExternalValue,
  selectRuntimeMedia,
} from "./runtimeValue";

test("media workflow types and legacy aliases map to the same item kind", () => {
  for (const kind of ["image", "video", "audio"] as const) {
    assert.equal(mediaKindFromWorkflowType(kind), kind);
    assert.equal(mediaKindFromWorkflowType(kind + "_list"), kind);
  }
  assert.equal(mediaKindFromWorkflowType("json"), undefined);
});

test("single paths, URLs, data URLs and ComfyUI attachments become lists", () => {
  const cases = [
    { source: "F:/clips/demo.mp4", type: "path" },
    { source: "https://example.test/demo.mp4", type: "url" },
    { source: "data:video/mp4;base64,AAAA", type: "url" },
    { source: { id: "upload", filename: "demo.mp4", subfolder: "", type: "input", url: "/api/comfyui/view?filename=demo.mp4" }, type: "comfy" },
  ];
  for (const { source, type } of cases) {
    const result = createRuntimeMediaValue("video", source);
    assert.equal(isRuntimeMediaValue(result), true);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].kind, "video");
    assert.equal(result.items[0].locator.type, type);
  }
});

test("external nested arrays preserve order in a flat media collection", () => {
  const result = createRuntimeMediaValue("image", ["first.png", ["second.png", ["third.png"]]]);
  assert.deepEqual(runtimeMediaExternalValue(result), ["first.png", "second.png", "third.png"]);
});

test("for_each aggregation retains media from every iteration", () => {
  for (const kind of ["image", "video", "audio"] as const) {
    let aggregate = createRuntimeMediaValue(kind, []);
    const iterations = [["first", "second"], ["third"]];
    for (const items of iterations) {
      aggregate = createRuntimeMediaValue(kind, [aggregate, createRuntimeMediaValue(kind, items)]);
    }
    assert.equal(aggregate.items.length, 3, kind);
    assert.deepEqual(runtimeMediaExternalValue(aggregate), iterations.flat());
  }
});

test("normalizing a runtime collection is idempotent and retains item IDs", () => {
  const value = createRuntimeMediaValue("audio", ["first.wav", "second.wav"]);
  assert.deepEqual(createRuntimeMediaValue("audio", value), value);
});

test("selecting one item retains the media list contract without changing the source", () => {
  const source = createRuntimeMediaValue("video", ["first.mp4", "second.mp4"]);
  const selected = selectRuntimeMedia(source, { mode: "item", index: 1 });
  assert.equal(isRuntimeMediaValue(selected), true);
  assert.deepEqual(runtimeMediaExternalValue(selected), ["second.mp4"]);
  assert.equal(source.items.length, 2);
  assert.equal(selectRuntimeMedia(source, { mode: "all" }), source);
  assert.equal(selectRuntimeMedia(source, { mode: "for_each" }), source);
  assert.throws(() => selectRuntimeMedia(source, { mode: "item", index: 2 }), /不存在/);
});

test("external values convert runtime media collections recursively", () => {
  const video = createRuntimeMediaValue("video", "demo.mp4");
  assert.deepEqual(runtimeMediaExternalValue({ output: video, nested: [video] }), { output: ["demo.mp4"], nested: [["demo.mp4"]] });
});

test("missing iteration outputs keep previously collected media", () => {
  const collected = createRuntimeMediaValue("video", "first.mp4");
  const result = createRuntimeMediaValue("video", [collected, null, createRuntimeMediaValue("video", [])]);
  assert.deepEqual(runtimeMediaExternalValue(result), ["first.mp4"]);
});
