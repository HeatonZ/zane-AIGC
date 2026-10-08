import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readComfyAudioSource, type ComfyAudioSourceOptions } from "./comfyAudioSource.js";

const options = (overrides: Partial<ComfyAudioSourceOptions> = {}): ComfyAudioSourceOptions => ({
  stepName: "隔离音频绑定", limitBytes: 100,
  mimeTypeForPath: (filename, fallback) => filename.endsWith(".wav") ? "audio/wav" : fallback,
  readRemote: async () => { throw new Error("unexpected external request"); },
  readComfy: async () => { throw new Error("unexpected ComfyUI read"); }, ...overrides,
});
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zane-audio-source-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "voice.wav"), bytes = Buffer.from("isolated-fixed-voice");
  await writeFile(file, bytes); return { dir, file, bytes };
}

test("ComfyUI音频使用固定素材私有路径，不读取preview或附件元数据", async t => {
  const { file, bytes } = await fixture(t);
  for (const value of [file, { assetId: "voice", assetVersion: 2, path: file, filename: "spoof.wav", type: "input", id: "spoof", subfolder: "", url: "https://external.invalid/voice.wav", previewUrl: "/api/v1/assets/voice/versions/2/media" }]) {
    const result = await readComfyAudioSource(value, options());
    assert.equal(result.kind, "bytes");
    if (result.kind === "bytes") { assert.deepEqual(result.bytes, bytes); assert.equal(result.filename, "voice.wav"); assert.equal(result.contentType, "audio/wav"); }
  }
});
test("音频私有路径不可读时失败，不退回显示URL或ComfyUI", async t => {
  const { dir } = await fixture(t);
  await assert.rejects(readComfyAudioSource({ path: path.join(dir, "absent.wav"), url: "https://external.invalid/voice.wav", filename: "voice.wav", type: "output" }, options()), /无法读取音频文件/);
  await assert.rejects(readComfyAudioSource(dir, options()), /无法读取音频文件/);
});
test("已有ComfyUI输入音频附件保持兼容不重新上传", async () => {
  const attachment = { id: "v", filename: "voice.wav", type: "input", subfolder: "references", url: "/api/comfyui/view?filename=voice.wav" };
  const result = await readComfyAudioSource(attachment, options());
  assert.deepEqual(result, { kind: "attachment", value: attachment });
});
test("ComfyUI输出音频先读取原始字节供后续上传", async () => {
  const output = { filename: "voice.wav", type: "output", subfolder: "results" }, bytes = Buffer.from("output-voice");
  const result = await readComfyAudioSource(output, options({ readComfy: async media => { assert.deepEqual(media, output); return { bytes }; } }));
  assert.deepEqual(result, { kind: "bytes", filename: "voice.wav", contentType: "audio/wav", bytes });
});
test("音频URL与data URL转换保留字节，非法data和只含preview的值拒绝", async () => {
  const bytes = Buffer.from("data-voice");
  const result = await readComfyAudioSource("data:audio/wav;base64," + bytes.toString("base64"), options());
  assert.deepEqual(result, { kind: "bytes", bytes, filename: "input.wav", contentType: "audio/wav" });
  const remote = await readComfyAudioSource({ url: "https://external.invalid/voice.wav" }, options({ readRemote: async url => { assert.equal(url, "https://external.invalid/voice.wav"); return { bytes }; } }));
  assert.deepEqual(remote, { kind: "bytes", bytes, filename: "voice.wav", contentType: "audio/wav" });
  await assert.rejects(readComfyAudioSource("data:audio/wav;base64,%%%", options()), /格式无效/);
  for (const value of [null, 9, {}, { previewUrl: "/api/v1/assets/voice/versions/1/media" }]) await assert.rejects(readComfyAudioSource(value, options()), /缺少可读取/);
});
test("音频来源大小限制覆盖文件、data URL、外部URL和ComfyUI输出", async t => {
  const { file, bytes } = await fixture(t), limited = options({ limitBytes: 1, readRemote: async () => ({ bytes }), readComfy: async () => ({ bytes }) });
  for (const value of [file, "data:audio/wav;base64," + bytes.toString("base64"), "https://external.invalid/voice.wav", { filename: "voice.wav", type: "output" }]) await assert.rejects(readComfyAudioSource(value, limited), /超过大小限制/);
});
test("音频取消在读取前及外部读取完成后检查", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readComfyAudioSource("https://external.invalid/voice.wav", options({ signal: controller.signal })), { name: "AbortError" });
  const later = new AbortController();
  await assert.rejects(readComfyAudioSource("https://external.invalid/voice.wav", options({ signal: later.signal, readRemote: async () => { later.abort(); return { bytes: Buffer.from("v") }; } })), { name: "AbortError" });
});
