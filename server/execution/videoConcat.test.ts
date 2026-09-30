import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizationArgs, probeVideoClip, runVideoConcatStep } from "./videoConcat.js";
import { execFileAsync, ffmpegBinary, ffprobeBinary } from "../config.js";
import { runArtifactPaths } from "../artifacts/runArtifacts.js";
import type { StepExecutionContext } from "./workflowExecutor.js";
import type { JsonValue } from "../domain/types.js";

const available = [ffmpegBinary, ffprobeBinary].every((binary) => spawnSync(binary, ["-version"], { windowsHide: true, stdio: "ignore" }).status === 0);
function context(directory: string, clips: JsonValue[], shots: JsonValue[]): StepExecutionContext {
  const runId = randomUUID();
  const inputValues = { clips, shots };
  return { runId, inputValues, runInputValues: inputValues, stepValues: new Map(), types: new Map(), artifacts: runArtifactPaths(directory, runId), settings: { projectDirectory: directory, comfyuiBaseUrl: "", enabledHermesProfiles: [], workflowTimeoutMinutes: 1 }, inputFields: [], signal: new AbortController().signal, step: { id: "assemble", name: "顺序拼接", kind: "comfyui", inputs: [{ key: "clips", sourceRef: "input.clips" }, { key: "shots", sourceRef: "input.shots" }], comfyui: { adapter: "video_concat", workflowFile: "builtin:video_concat", bindings: [] } } };
}

test("normalizes frame rate and audio without introducing background music or TTS", () => {
  const args = normalizationArgs("source.mp4", "final.mp4", { width: 160, height: 90, duration: 5, audio: true }, 160, 90);
  assert.ok(args.includes("0:a:0"));
  assert.ok(args.some((arg) => arg.includes("fps=24")));
  assert.ok(args.includes("aresample=48000:async=1:first_pts=0,apad"));
  assert.equal(args.includes("anullsrc=r=48000:cl=stereo"), false);
  assert.ok(normalizationArgs("silent.mp4", "final.mp4", { width: 160, height: 90, duration: 5, audio: false }, 160, 90).includes("anullsrc=r=48000:cl=stereo"));
});

test("rejects incomplete/misordered clip lists before file or process operations", async () => {
  await assert.rejects(runVideoConcatStep(context("not-used", ["first.mp4"], [{ index: 1 }, { index: 2 }])), /数量\/顺序/);
  await assert.rejects(runVideoConcatStep(context("not-used", ["first.mp4"], [{ index: 2 }])), /数量\/顺序/);
  await assert.rejects(runVideoConcatStep(context("not-used", [], [])), /需要1到360/);
});

test("real FFmpeg joins mixed formats in order and keeps each clip's own audio", { skip: !available }, async () => {
  const parent = path.resolve(os.tmpdir());
  const directory = path.resolve(await mkdtemp(path.join(parent, "zane-long-text-video-test-")));
  const first = path.join(directory, "first.mp4"), second = path.join(directory, "second.mp4");
  try {
    for (const [file, color, rate, frequency, size] of [[first, "red", "24", "400", "160x90"], [second, "blue", "30", "800", "120x120"]]) {
      await execFileAsync(ffmpegBinary, ["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=${rate}:d=0.5`, "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=0.5`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file], { windowsHide: true, timeout: 30000 });
    }
    const current = context(directory, [first, second], [{ index: 1 }, { index: 2 }]);
    await mkdir(current.artifacts.directory, { recursive: true });
    const result = await runVideoConcatStep(current);
    const url = String(result.download);
    assert.match(url, /^\/api\/v1\/runs\/[^/]+\/media\/.+\.mp4$/);
    const output = path.join(current.artifacts.directory, "outputs", "media", path.basename(url));
    assert.ok((await readFile(output)).length > 0);
    const info = await probeVideoClip(output);
    assert.equal(info.audio, true);
    assert.equal(info.width, 160); assert.equal(info.height, 90);
    assert.ok(info.duration >= 0.95 && info.duration <= 1.2);
    const manifest = result.manifest as Record<string, JsonValue>;
    assert.equal(manifest.music_added, false); assert.equal(manifest.count, 2);
    for (const [time, channel] of [["0.1", 0], ["0.8", 2]] as const) {
      const { stdout } = await execFileAsync(ffmpegBinary, ["-v", "error", "-ss", time, "-i", output, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", windowsHide: true, timeout: 30000 });
      assert.ok(stdout[channel] > stdout[channel === 0 ? 2 : 0] + 80, "red then blue video order");
    }
    for (const [time, wanted, unwanted] of [["0.1", 400, 800], ["0.7", 800, 400]] as const) {
      const { stdout } = await execFileAsync(ffmpegBinary, ["-v", "error", "-ss", time, "-i", output, "-t", "0.1", "-vn", "-ar", "8000", "-ac", "1", "-f", "s16le", "pipe:1"], { encoding: "buffer", windowsHide: true, timeout: 30000 });
      const samples = Array.from({ length: stdout.length / 2 }, (_, i) => stdout.readInt16LE(i * 2));
      const energy = (frequency: number) => Math.hypot(samples.reduce((sum, sample, i) => sum + sample * Math.cos(2 * Math.PI * frequency * i / 8000), 0), samples.reduce((sum, sample, i) => sum + sample * Math.sin(2 * Math.PI * frequency * i / 8000), 0));
      assert.ok(energy(wanted) > energy(unwanted) * 5, "native clip audio is preserved in order");
    }
  } finally {
    if (path.dirname(directory) === parent) await rm(directory, { recursive: true, force: true });
  }
});
