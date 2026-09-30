import assert from "node:assert/strict";
import test from "node:test";
import { appendMediaInputValue, mediaInputLabel, mediaInputPreviewUrl, mediaListValues, moveMediaInputValue, removeMediaInputValue } from "./mediaInput";

const attachment = { id: "image_upload", filename: "reference.png", subfolder: "", type: "input", url: "/api/comfyui/view?filename=reference.png" };
const imagePath = "F:/images/reference.png";

test("legacy single paths and single attachments load as media lists", () => {
  assert.deepEqual(mediaListValues(imagePath), [imagePath]);
  assert.deepEqual(mediaListValues(JSON.stringify(attachment)), [attachment]);
  assert.deepEqual(mediaListValues(""), []);
  assert.deepEqual(mediaListValues("[]"), []);
});

test("runtime media collections and nested legacy lists preserve item order", () => {
  const item = { id: "video", kind: "video", locator: { type: "path", value: "demo.mp4" } };
  const runtime = { kind: "media", __zaneRuntime: "media", mediaKind: "video", items: [item] };
  assert.deepEqual(mediaListValues(JSON.stringify([imagePath, [attachment], runtime])), [imagePath, attachment, item]);
});

test("adding an upload or a path retains all existing media", () => {
  let value = appendMediaInputValue("", imagePath);
  value = appendMediaInputValue(value, attachment);
  value = appendMediaInputValue(value, "F:/images/second.png");
  assert.deepEqual(mediaListValues(value), [imagePath, attachment, "F:/images/second.png"]);
});

test("removing a path uses its position in the complete mixed list", () => {
  const values = [attachment, imagePath, imagePath];
  assert.deepEqual(removeMediaInputValue(values, 1), [attachment, imagePath]);
  assert.equal(values.length, 3);
});

test("moving uploads and paths keeps their common list order", () => {
  const values = [attachment, imagePath, "F:/images/second.png"];
  assert.deepEqual(moveMediaInputValue(values, 1, -1), [imagePath, attachment, "F:/images/second.png"]);
  assert.deepEqual(moveMediaInputValue(values, 0, 1), [imagePath, attachment, "F:/images/second.png"]);
  assert.deepEqual(moveMediaInputValue(values, 0, -1), values);
  assert.deepEqual(moveMediaInputValue(values, 2, 1), values);
  assert.deepEqual(values, [attachment, imagePath, "F:/images/second.png"]);
});

test("audio paths and URLs survive appending an uploaded audio file", () => {
  const audio = { ...attachment, id: "audio_upload", filename: "clip.wav" };
  const value = appendMediaInputValue(JSON.stringify(["clip.mp3", "https://example.test/clip.mp3"]), audio);
  assert.deepEqual(mediaListValues(value), ["clip.mp3", "https://example.test/clip.mp3", audio]);
});

test("media labels and previews handle uploaded, path, URL and runtime items", () => {
  assert.equal(mediaInputLabel(attachment), "reference.png");
  assert.equal(mediaInputLabel(imagePath), imagePath);
  assert.equal(mediaInputPreviewUrl(attachment), attachment.url);
  assert.equal(mediaInputPreviewUrl(imagePath), undefined);
  assert.equal(mediaInputPreviewUrl("https://example.test/reference.png"), "https://example.test/reference.png");
  const item = { id: "runtime", kind: "image", locator: { type: "path", value: imagePath } };
  assert.equal(mediaInputLabel(item), imagePath);
  assert.equal(mediaInputPreviewUrl(item), undefined);
});
