import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readHermesImageSource, type HermesImageSourceOptions } from "./hermesImageSource.js";

const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xv1EAAAAASUVORK5CYII=", "base64");
const asset = { assetId: "fixed-reference", assetVersion: 1, previewUrl: "/api/v1/assets/fixed-reference/versions/1/media" };
const options: HermesImageSourceOptions = {
  sourceLimitBytes: 100_000_000,
  readComfy: async () => { throw new Error("Must not read ComfyUI or previewUrl for a private asset copy"); },
};
async function fixture(t: TestContext) {
  const root = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(root, "zane-hermes-image-source-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), root, "cleanup remains inside the temporary root");
    assert.ok(path.basename(directory).startsWith("zane-hermes-image-source-"));
    await rm(directory, { recursive: true, force: true });
  });
  const filename = path.join(directory, "reference.png");
  await writeFile(filename, bytes);
  return { directory, filename };
}

test("Hermes reads a resolved fixed asset and a plain path as the same bounded bytes", async t => {
  const { filename } = await fixture(t);
  const plain = await readHermesImageSource(filename, options);
  const fixed = await readHermesImageSource({ ...asset, path: filename }, options);
  assert.deepEqual(fixed, plain);
  assert.deepEqual(fixed, { kind: "bytes", filename, bytes });
});

test("Hermes private asset path takes precedence over filename, URL and preview metadata", async t => {
  const { filename } = await fixture(t);
  const result = await readHermesImageSource({ ...asset, path: ` ${filename} `, filename: "wrong-comfy.png", url: "https://display.invalid/wrong.png", type: "output" }, options);
  assert.deepEqual(result, { kind: "bytes", filename, bytes });
});

test("An unreadable private path fails instead of falling back to a display URL or ComfyUI", async t => {
  const { directory } = await fixture(t);
  for (const filename of [path.join(directory, "missing.png"), directory]) {
    await assert.rejects(readHermesImageSource({ ...asset, path: filename, filename: "wrong-comfy.png", url: "https://display.invalid/wrong.png" }, options), /无法读取图片文件/);
  }
});

test("Unresolved fixed references never use authenticated previewUrl as an execution source", async () => {
  for (const value of [asset, { ...asset, path: " " }, { ...asset, path: null }, { previewUrl: "https://display.invalid/preview.png" }]) {
    await assert.rejects(readHermesImageSource(value, options), /图片输入缺少可读取的文件或 URL/);
  }
});

test("Hermes rejects empty, unsupported and malformed image input shapes", async () => {
  for (const value of ["", "  "]) await assert.rejects(readHermesImageSource(value, options), /图片输入为空/);
  for (const value of [null, undefined, 3, false, []]) await assert.rejects(readHermesImageSource(value, options), /图片输入格式无效/);
  for (const value of [{}, { path: 5 }, { url: "file:///reference.png" }]) await assert.rejects(readHermesImageSource(value, options), /图片输入缺少可读取的文件或 URL/);
});

test("Plain and fixed asset paths share the file size boundary", async t => {
  const { filename } = await fixture(t);
  for (const value of [filename, { ...asset, path: filename }]) {
    const result = await readHermesImageSource(value, { ...options, sourceLimitBytes: bytes.length });
    assert.equal(result.kind, "bytes");
    await assert.rejects(readHermesImageSource(value, { ...options, sourceLimitBytes: bytes.length - 1 }), /图片原文件超过/);
  }
});

test("Hermes keeps base64 data image support with content type and size checks", async () => {
  const encoded = `data:image/png;base64,${bytes.toString("base64")}`;
  assert.deepEqual(await readHermesImageSource(` ${encoded} `, options), { kind: "bytes", bytes, filename: "input.png", contentType: "image/png" });
  assert.deepEqual(await readHermesImageSource(encoded.replace("base64,", "base64,\n"), options), { kind: "bytes", bytes, filename: "input.png", contentType: "image/png" });
  await assert.rejects(readHermesImageSource(encoded, { ...options, sourceLimitBytes: bytes.length - 1 }), /图片原文件超过/);
  const legacy = "data:image/png,legacy-non-base64";
  assert.deepEqual(await readHermesImageSource(legacy, options), { kind: "url", url: legacy });
});

test("Hermes keeps external URL behavior without reading it or forwarding credentials", async () => {
  const url = "https://external.invalid/reference.png";
  assert.deepEqual(await readHermesImageSource(` ${url} `, options), { kind: "url", url });
  assert.deepEqual(await readHermesImageSource({ url }, options), { kind: "url", url });
});

test("Existing ComfyUI attachment shapes still use the bounded attachment reader", async () => {
  const attachment = { filename: "output.png", subfolder: "images", type: "output", url: "https://display.invalid/not-used.png" };
  let calls = 0;
  const readComfy: HermesImageSourceOptions["readComfy"] = async media => {
    calls += 1;
    assert.equal(media, attachment);
    return { bytes, contentType: "image/png" };
  };
  assert.deepEqual(await readHermesImageSource(attachment, { ...options, readComfy }), { kind: "bytes", filename: "output.png", bytes, contentType: "image/png" });
  assert.equal(calls, 1);
  await assert.rejects(readHermesImageSource(attachment, { ...options, readComfy, sourceLimitBytes: bytes.length - 1 }), /图片原文件超过/);
});

test("Cancelled image preparation does not read local, URL, data or ComfyUI sources", async t => {
  const { filename } = await fixture(t);
  const controller = new AbortController();
  const reason = new Error("cancelled before image preparation");
  controller.abort(reason);
  for (const value of [filename, { ...asset, path: filename }, "https://external.invalid/image.png", `data:image/png;base64,${bytes.toString("base64")}`, { filename: "output.png" }]) {
    await assert.rejects(readHermesImageSource(value, { ...options, signal: controller.signal }), error => error === reason);
  }
});

test("Cancellation during private-file stat prevents subsequent file reading", async t => {
  const { filename } = await fixture(t);
  const controller = new AbortController();
  const reason = new Error("cancelled during stat");
  const reading = readHermesImageSource({ ...asset, path: filename }, { ...options, signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(reading, error => error === reason);
});

test("Cancellation while the legacy attachment reader returns is preserved", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled during attachment read");
  await assert.rejects(readHermesImageSource({ filename: "output.png" }, {
    ...options,
    signal: controller.signal,
    readComfy: async () => { controller.abort(reason); return { bytes }; },
  }), error => error === reason);
});
