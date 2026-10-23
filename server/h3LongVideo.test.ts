import assert from "node:assert/strict";
import test from "node:test";
import { h3WorkflowWiring } from "./h3LongVideo.js";

function graph(overrides: { vhs?: Record<string, unknown>; reference?: Record<string, unknown> } = {}) {
  return {
    "266": { class_type: "H3LVUnified", inputs: { audio: ["232", 0], mode: "speaking", project_id: "" } },
    "136": {
      class_type: "MiniMaxH3ReferenceToVideo",
      inputs: { length: ["266", 2] as unknown, prompt: ["266", 11] as unknown, ...overrides.reference },
    },
    "278": {
      class_type: "VHS_VideoCombine",
      inputs: {
        images: ["122", 0],
        audio: ["266", 0],
        filename_prefix: ["266", 3],
        save_output: true,
        ...overrides.vhs,
      },
    },
  } as Record<string, Record<string, unknown>>;
}

test("新版 ComfyUI 重新保存后丢失 frame_rate 槽位时自动补回 fps 连接", () => {
  // 事故 f9cd452d：工作流 2026-10-07 被新版前端重存，VHS 的 frame_rate 输入槽与控件值一起消失，
  // 运行在 78 毫秒内以「连接不完整」失败，而音频分析已经花了 16 分钟。
  const target = graph();
  assert.equal(Object.prototype.hasOwnProperty.call(target["278"]!.inputs as object, "frame_rate"), false);
  const wiring = h3WorkflowWiring(target);
  assert.deepEqual((wiring.videoInputs as Record<string, unknown>).frame_rate, ["266", 12]);
  assert.equal(wiring.videoId, "278");
});

test("槽位保留但未连线、只剩控件默认值时也补回 fps 连接", () => {
  // 事故 bf126b9d：18:08 再次重存后槽位回来了，但 link 为空、只剩控件值 8（H3 实际是 24fps）。
  // 只判断「键缺失」会把这种形态当成已连接，于是仍然报错。
  const target = graph({ vhs: { frame_rate: 8 } });
  const wiring = h3WorkflowWiring(target);
  assert.deepEqual((wiring.videoInputs as Record<string, unknown>).frame_rate, ["266", 12]);
});

test("frame_rate 已存在但接错仍报错，并指出具体是哪一条连接", () => {
  const target = graph({ vhs: { frame_rate: ["999", 0] } });
  assert.throws(
    () => h3WorkflowWiring(target),
    (error: Error) => error.message.includes("VHS_VideoCombine.frame_rate") && !error.message.includes("audio 未接"),
  );
});

test("save_output 关闭时不会被静默修好", () => {
  assert.throws(() => h3WorkflowWiring(graph({ vhs: { save_output: false } })), /save_output 未开启/);
});

test("缺少参考图长度连接时明确指出 generation_frames", () => {
  assert.throws(() => h3WorkflowWiring(graph({ reference: { length: null } })), /generation_frames/);
});
