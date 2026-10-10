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

test("relative workbench media URLs keep a usable file name", () => {
  // Third-party response images are published as canonical relative archive
  // paths. `new URL` rejects a relative reference without a base, so the file
  // name must still be derived: the sandbox projects media by file name only,
  // and downstream selection cannot work without it.
  const archived = "/api/v1/runs/72fa80cb-9724-4755-9f07-e03f72b061a4/media/7985392f-89d8-41d7-9033-6c8fbbe3d0aa.png";
  const fromUrl = createRuntimeMediaValue("image", [{ url: archived }]);
  assert.equal(fromUrl.items[0].filename, "7985392f-89d8-41d7-9033-6c8fbbe3d0aa.png");
  assert.equal(fromUrl.items[0].locator.type, "url");
  // The string form already resolved relative paths and must not change.
  assert.equal(createRuntimeMediaValue("image", archived).items[0].filename, "7985392f-89d8-41d7-9033-6c8fbbe3d0aa.png");
  // A query string is not part of the file name.
  assert.equal(createRuntimeMediaValue("image", [{ url: archived + "?v=1" }]).items[0].filename, "7985392f-89d8-41d7-9033-6c8fbbe3d0aa.png");
  assert.equal(createRuntimeMediaValue("image", [{ url: "/api/workflows/runs/r/media/clip.mp4" }]).items[0].filename, "clip.mp4");
  // An endpoint path has no file name and must not invent one.
  assert.equal(createRuntimeMediaValue("image", [{ url: "/api/v1/runs/r/output-media?outputKey=images" }]).items[0].filename, undefined);
  // Absolute URLs keep their existing behaviour.
  assert.equal(createRuntimeMediaValue("image", [{ url: "https://example.test/a%20b.png" }]).items[0].filename, "a b.png");
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
