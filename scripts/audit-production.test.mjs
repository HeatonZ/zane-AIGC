import assert from "node:assert/strict";
import test from "node:test";
import { bindingAvailability, mediaReferences, publishedSnapshot } from "./audit-production.mjs";

test("uses the explicitly published version, not the last draft", () => {
  const workspace = { sceneVersions: { a: { publishedVersionId: "v1", versions: [{ id: "v1", workflow: { name: "published" } }, { id: "v2", workflow: { name: "draft" } }] } } };
  assert.equal(publishedSnapshot(workspace, "a").workflow.name, "published");
  assert.equal(publishedSnapshot(workspace, "missing"), undefined);
});
test("unconnected autogrow image/audio ports are valid via node schema", () => {
  const nodes = [{ id: "192", type: "MiniMaxH3ReferenceToVideo", inputProperties: ["prompt"] }];
  const schemas = new Map([["MiniMaxH3ReferenceToVideo", { inputs: [{ name: "ref_images" }, { name: "ref_audios" }] }]]);
  for (const property of ["ref_images", "ref_audios"]) assert.equal(bindingAvailability({ direction: "input", nodeId: "192", property }, nodes, schemas).status, "pass");
});
test("missing media output node is a fallback warning, not proof of failure", () => {
  assert.equal(bindingAvailability({ direction: "output", nodeId: "1092", property: "video" }, [{ id: "92", outputProperties: ["video"] }]).status, "warn");
});
test("unresolvable or ambiguous input targets fail", () => {
  assert.equal(bindingAvailability({ direction: "input", nodeId: "1", property: "bad" }, [{ id: "1", inputProperties: [] }]).status, "fail");
  const nodes = [{ id: "2", inputProperties: ["prompt"] }, { id: "3", inputProperties: ["prompt"] }];
  assert.equal(bindingAvailability({ direction: "input", nodeId: "1", property: "prompt" }, nodes).status, "fail");
});
test("media probes exclude remote URLs, non-media outputs, and unrelated APIs", () => {
  const base = "http://127.0.0.1:8799";
  const url = "/api/v1/runs/abc/media/clip.mp4";
  const outputs = [{ type: "video_list", value: [{ url }, { url }, { url: "https://example.com/video.mp4" }, { url: "/api/settings" }] }, { type: "text", value: "/api/v1/runs/other/media/private.png" }];
  assert.deepEqual(mediaReferences(outputs, base), [{ url: base + url, type: "video_list" }]);
});
