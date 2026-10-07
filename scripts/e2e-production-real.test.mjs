import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { caseLimits, realCases, prepareFrontendMedia } from "./e2e-production-real.mjs";
const fixtureRoot = path.resolve("F:/code/zane-drama/.local/production-real-e2e-20261001/fixtures");

test("exactly one bounded fixture definition for each of ten distinct production scenes", () => {
  const cases = realCases(fixtureRoot);
  assert.equal(cases.length, 10);
  assert.equal(new Set(cases.map(item => item.sceneId)).size, 10);
  assert.equal(new Set(cases.map(item => item.slug)).size, 10);
  assert.ok(cases.every(item => ["image", "video"].includes(item.expected)));
});
test("real commerce and long video stay within a one-shot minimum", () => {
  const cases = realCases(fixtureRoot);
  assert.deepEqual(cases.find(item => item.sceneId === "commerce_pack").inputs.shot_types, ["hero"]);
  assert.equal(cases.find(item => item.sceneId === "scene_long_text_to_video").inputs.target_seconds, 5);
  assert.ok(cases.filter(item => item.inputs.time).every(item => item.inputs.time === 5));
});
test("references are original local test fixtures, not user media or remote URLs", () => {
  for (const item of realCases(fixtureRoot)) {
    for (const key of ["reference_images", "references", "images", "character_assets", "audio"]) {
      for (const file of item.inputs[key] ?? []) {
        assert.ok(path.isAbsolute(file));
        assert.ok(file.startsWith(fixtureRoot + path.sep));
        assert.match(path.basename(file), /^synthetic-/);
      }
    }
  }
});
test("a changed published schema fails before a paid submission", () => {
  const definition = realCases(fixtureRoot)[0];
  assert.throws(() => caseLimits(definition, { inputs: [{ key: "new_required", required: true }], steps: [] }), /Missing required input/);
  assert.doesNotThrow(() => caseLimits(definition, { inputs: [{ key: "thought", required: true }], steps: [] }));
});
test("approval gates are not automatically approved by the generator harness", () => {
  assert.throws(() => caseLimits(realCases(fixtureRoot)[0], { inputs: [], steps: [{ review: { enabled: true } }] }), /manual testing/);
});

test("special native workflows include a scene fixture and frontend-uploaded audio metadata", async () => {
  const cases = realCases(fixtureRoot);
  const long = cases.find(item => item.sceneId === "scene_long_text_to_video");
  assert.equal(long.inputs.scene_assets.length, 1);
  assert.match(long.inputs.production_notes, /scenes=\[1\]/);
  const h3 = cases.find(item => item.sceneId === "scene_h3_long_video");
  const calls = [];
  const input = await prepareFrontendMedia(h3.inputs, [{ key: "audio", type: "audio_list" }, { key: "reference_images", type: "image_list" }], async (kind, file) => {
    calls.push({ kind, file });
    return { kind, filename: path.basename(file), subfolder: "e2e", type: "input" };
  });
  assert.deepEqual(calls.map(item => item.kind), ["audio", "image"]);
  assert.equal(input.audio[0].type, "input");
  assert.equal(input.audio[0].kind, "audio");
  assert.equal(typeof h3.inputs.audio[0], "string", "original fixture definition remains immutable");
});

test("already uploaded attachments and non-media arrays are not uploaded again", async () => {
  const attachment = { filename: "synthetic.png", subfolder: "e2e", type: "input" };
  const inputs = { reference_images: [attachment], shot_types: ["hero"] };
  const prepared = await prepareFrontendMedia(inputs, [{ key: "reference_images", type: "image_list" }, { key: "shot_types", type: "json" }], async () => { throw Error("unexpected duplicate upload"); });
  assert.deepEqual(prepared, inputs);
});
