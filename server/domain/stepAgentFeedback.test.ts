import assert from "node:assert/strict";
import test from "node:test";
import { createStepAgentFeedbackRequest, projectRevisedOutputs, stepAgentFeedbackMessage } from "./stepAgentFeedback.js";
import { feedbackMessageMaxLength } from "./feedbackContracts.js";
import { id } from "../testing/testSupport.js";

test("反馈文本与结构化上下文合并：只出现填写的字段，没填就原样返回", () => {
  assert.equal(stepAgentFeedbackMessage("开头不够抓人"), "开头不够抓人");
  assert.equal(stepAgentFeedbackMessage("开头不够抓人", {}), "开头不够抓人");
  const merged = stepAgentFeedbackMessage("第二镜节奏太慢", { observation: "前 3 秒没有动作", expectation: "第 1 秒进冲突" });
  assert.match(merged, /^第二镜节奏太慢\n\n补充上下文：\n/);
  assert.match(merged, /观察到的问题：前 3 秒没有动作/);
  assert.match(merged, /期望结果：第 1 秒进冲突/);
  assert.ok(!merged.includes("产物："));
  assert.ok(!merged.includes("必须保持不动："));
  const full = stepAgentFeedbackMessage("改一下", { artifact: "storyboard.shots[1]", constraints: "保持三镜结构" });
  assert.match(full, /产物：storyboard\.shots\[1\]/);
  assert.match(full, /必须保持不动：保持三镜结构/);
});

test("修订结果投影：媒体端口只回固定引用与数量，文本端口原样回值", () => {
  const projected = projectRevisedOutputs(
    {
      prompt: "新提示词",
      reference_images: [
        { assetId: "asset-1", assetVersion: 2, assetName: "角色图", path: "F:/runs/x/outputs/media/a.png" },
        "F:/runs/x/outputs/media/b.png",
      ],
    },
    [{ key: "prompt", type: "text" }, { key: "reference_images", type: "image_list" }],
  );
  assert.equal(projected.prompt, "新提示词");
  // 有固定版本引用的只回引用；没有引用的明确标记省略，绝不回本机路径。
  assert.deepEqual(projected.reference_images, {
    mediaCount: 2,
    items: [{ assetId: "asset-1", assetVersion: 2, assetName: "角色图" }, { locatorOmitted: true }],
  });
  assert.ok(!JSON.stringify(projected).includes("F:/runs"), "媒体端口不得带出本机路径");
  // 未声明的端口不套媒体语义，避免把普通 JSON 误判成媒体。
  assert.deepEqual(projectRevisedOutputs({ extra: ["a"] }, []), { extra: ["a"] });
  assert.deepEqual(projectRevisedOutputs({ cover: null }, [{ key: "cover", type: "image" }]), { cover: { mediaCount: 0, items: [] } });
});

test("请求校验：只接受已知字段、非空且不过长的反馈与有界上下文", () => {
  const runId = id("feedback-contract-run");
  const valid = createStepAgentFeedbackRequest({ runId, stepId: "writer", message: "  开头不够抓人  ", context: { artifact: "storyboard" } });
  assert.equal(valid.message, "开头不够抓人");
  assert.equal(valid.context?.artifact, "storyboard");

  const invalid: unknown[] = [
    null,
    { runId, stepId: "writer" },
    { runId, stepId: "writer", message: "   " },
    { runId, stepId: "writer", message: 123 },
    { runId, stepId: "writer", message: "字".repeat(feedbackMessageMaxLength + 1) },
    { runId, stepId: "writer", message: "意见", itemIndex: -1 },
    { runId, stepId: "writer", message: "意见", itemIndex: 0.5 },
    { runId, stepId: "writer", message: "意见", unknownKey: 1 },
    { runId, stepId: "writer", message: "意见", context: { unknownKey: "x" } },
    { runId, stepId: "writer", message: "意见", context: { observation: "字".repeat(4_001) } },
    { runId: "not-a-run-id", stepId: "writer", message: "意见" },
  ];
  for (const raw of invalid) {
    assert.throws(() => createStepAgentFeedbackRequest(raw), /INVALID_STEP_FEEDBACK_REQUEST|步骤反馈参数无效|Invalid|Too/);
  }
  // 逐项反馈允许 0 基编号。
  assert.equal(createStepAgentFeedbackRequest({ runId, stepId: "writer", message: "意见", itemIndex: 0 }).itemIndex, 0);
});
