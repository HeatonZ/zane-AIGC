import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkflowRunPanel from "./WorkflowRunPanel";
import ReviewPanel from "./ReviewPanel";
import type { WorkflowRunRecord } from "../types";

function run(): WorkflowRunRecord {
  return { runId: "source", sceneId: "demo", workflowName: "反馈测试", status: "completed", inputValues: {}, outputs: [], workflow: { sceneId: "demo", name: "测试", inputs: [], outputs: [], steps: [{ id: "writer", name: "编剧", kind: "hermes", hermesProfile: "default", promptTemplate: "原任务", inputs: [], outputs: [{ key: "text", label: "故事", type: "text" }] }] }, steps: [{ stepId: "writer", name: "编剧", status: "completed", outputs: { text: "原故事" }, outputTypes: { text: "text" } }] };
}

test("运行记录和创作结果都有反馈入口，反馈历史展示原因与来源版本", () => {
  const source = run();
  source.feedbackHistory = [{ id: "feedback-1", stepId: "writer", sourceRunId: "original-run", createdAt: "2026-10-02T01:00:00Z", message: "开头缺少冲突", originalOutputs: { text: "原故事" } }];
  const records = renderToStaticMarkup(createElement(WorkflowRunPanel, { result: source, onRerunStep: () => {} }));
  assert.match(records, /反馈并重做/); assert.match(records, /Hermes 反馈历史/); assert.match(records, /开头缺少冲突/); assert.match(records, /来源版本 original/);
  const studioResult = { ...source, workflow: undefined };
  const studio = renderToStaticMarkup(createElement(WorkflowRunPanel, { result: studioResult, workflow: source.workflow, onFeedbackStep: () => {} }));
  assert.match(studio, /反馈并重做/);
  const batch = run(); batch.steps[0].items = [{ index: 0, value: "甲", status: "completed", outputs: { text: "甲" } }, { index: 1, value: "乙", status: "failed" }];
  const items = renderToStaticMarkup(createElement(WorkflowRunPanel, { result: batch, onRerunStep: () => {} }));
  assert.match(items, /反馈并重做第 1 项/); assert.doesNotMatch(items, /反馈并重做第 2 项/);
});

test("运行中或待确认时不能从结果面板绕过关卡反馈重做，非Hermes不显示入口", () => {
  const source = run();
  for (const status of ["running", "queued", "cancelling", "waiting"] as const) {
    const html = renderToStaticMarkup(createElement(WorkflowRunPanel, { result: { ...source, status }, onFeedbackStep: () => {} }));
    assert.doesNotMatch(html, /反馈并重做/);
  }
  source.workflow!.steps[0].kind = "manual";
  assert.doesNotMatch(renderToStaticMarkup(createElement(WorkflowRunPanel, { result: source, onRerunStep: () => {} })), /反馈并重做/);
});

test("Hermes 人工确认关卡有退回反馈输入框，非Hermes关卡不展示", () => {
  const source = run(); source.status = "waiting"; source.pendingReview = { id: "review", stepId: "writer", name: "编剧", createdAt: "now" };
  assert.match(renderToStaticMarkup(createElement(ReviewPanel, { run: source, onSubmitted: () => {} })), /退回重做的反馈意见/);
  source.workflow!.steps[0].kind = "manual";
  assert.doesNotMatch(renderToStaticMarkup(createElement(ReviewPanel, { run: source, onSubmitted: () => {} })), /退回重做的反馈意见/);
});

test("步骤和逐项提示词警告用⚠展示，不改变已完成状态", () => {
  const source = run();
  source.steps[0].warnings = ["建议六段标题，仅提示，不阻止生成"];
  source.steps[0].items = [{ index: 0, value: "镜头", status: "completed", outputs: { text: "镜头输出" }, warnings: ["详细描述标题缺失"] }];
  const html = renderToStaticMarkup(createElement(WorkflowRunPanel, { result: source }));
  assert.match(html, /⚠/);
  assert.match(html, /建议六段标题，仅提示，不阻止生成/);
  assert.match(html, /详细描述标题缺失/);
  assert.match(html, /role="note"/);
  assert.match(html, /workflow-run-step-status completed">完成/);
  assert.equal(source.status, "completed");
  assert.equal(source.steps[0].items[0].status, "completed");
});

test("最终输出、步骤输出与逐项输出的每个媒体都有单独下载入口", () => {
  // 管理端原来只有底部的「打包下载媒体」，单个视频/图片想单独保存只能右键或先收藏再下载。
  const runId = "12345678-1234-4234-8234-123456789abc";
  const source = run();
  const clip = { filename: "clip.mp4", url: `/api/v1/runs/${runId}/media/clip.mp4` };
  source.outputs = [{ key: "videos", label: "分镜视频", type: "video_list", value: [clip] }];
  source.steps[0].outputs = { images: ["/api/v1/runs/" + runId + "/media/shot.png"] };
  source.steps[0].outputTypes = { images: "image_list" };
  source.steps[0].items = [{ index: 0, value: "镜头", status: "completed", outputs: { images: ["/api/v1/runs/" + runId + "/media/item.png"] } }];
  const html = renderToStaticMarkup(createElement(WorkflowRunPanel, { result: source }));
  // 三个渲染点各一个下载链接，且都指向原文件而不是缩放后的预览。
  for (const file of ["clip.mp4", "shot.png", "item.png"]) assert.match(html, new RegExp(`download="[^"]*${file.replace(".", "\\.")}"`));
  assert.equal(html.split("下载</a>").length - 1, 3);
  assert.doesNotMatch(html, /\/preview\?w=/);
});

test("Hermes运行输入展示实际发送的提示词；逐项执行按项展示提示词", () => {
  const source = run();
  source.steps[0].agentPrompt = "写故事\\n步骤输入：商品设定\\n\\n输出要求：JSON";
  const single = renderToStaticMarkup(createElement(WorkflowRunPanel, { result: source }));
  assert.match(single, /提示词/);
  assert.match(single, /实际发送/);
  assert.match(single, /步骤输入：商品设定/);

  source.steps[0].items = [
    { index: 0, value: "镜头一", status: "completed", agentPrompt: "只写镜头一", outputs: { text: "结果一" } },
    { index: 1, value: "镜头二", status: "failed", agentPrompt: "只写镜头二", error: "模拟失败" },
  ];
  const batch = renderToStaticMarkup(createElement(WorkflowRunPanel, { result: source }));
  assert.match(batch, /只写镜头一/);
  assert.match(batch, /只写镜头二/);
});

test("查看本次输入按发布快照的字段类型渲染固定素材引用，媒体字段不再整块空白", () => {
  // 运行 7eb39d1b-ac66-4d4d-84be-255360b5fb6a 的真实字段与素材：用户面投影只剩
  // assetId/assetVersion/assetName，展示名（「猫主角米酒_四视图_V4」）又没有扩展名，
  // 只有按发布快照声明的字段类型渲染，图片和音色才出得来（修复前这里是整块空白）。
  const source = run();
  const ref = (assetId: string, assetName: string) => ({ assetId, assetVersion: 1, assetName });
  source.workflow!.inputs = [
    { key: "content", label: "长文 / 剧情", type: "textarea", required: true },
    { key: "character_assets", label: "人物资产", type: "image_list", required: true },
    { key: "scene_assets", label: "场景资产", type: "image_list", required: false },
    { key: "prop_assets", label: "道具资产", type: "image_list", required: false },
    { key: "voice_reference_audio", label: "参考音色", type: "audio_list", required: false },
  ];
  source.inputValues = {
    content: "走廊里先有了声音。",
    character_assets: [
      ref("05f0f5b9-3506-4ab0-ae41-bcfd6b20d57c", "猫主角米酒_四视图_V4"),
      ref("1b9a6f40-6072-491d-9ea1-bcdb0eac2e4f", "男主人_四视图_V4"),
      ref("908345a5-66e3-43d3-8aa6-6ed292abc9f6", "女主人_四视图_V1"),
    ],
    scene_assets: [ref("fbfdc0a8-d696-4d9e-8dbb-400b48c87284", "第一集_客厅连门口场景板")],
    prop_assets: [ref("732a8ba6-ec8e-4244-88f0-dd4dc95fa4f2", "第一集_道具统一参考板")],
    voice_reference_audio: [
      ref("903d4795-37a0-40e9-ad84-ecfda0f7be55", "男主人_音色参考"),
      ref("3e4f191a-e4ad-420e-9dfb-d4bcb6c6e22d", "女主人_音色参考"),
    ],
    legacy_note: "旧记录里透传的额外输入",
  };
  const html = renderToStaticMarkup(createElement(WorkflowRunPanel, { result: source, inputValues: source.inputValues }));
  assert.match(html, /查看本次输入（6）/);
  assert.match(html, /人物资产/);
  assert.match(html, /参考音色/);
  assert.match(html, /走廊里先有了声音/);
  assert.match(html, /猫主角米酒_四视图_V4/);
  assert.match(html, /女主人_四视图_V1/);
  assert.match(html, /第一集_客厅连门口场景板/);
  assert.match(html, /legacy_note/);
  assert.match(html, /旧记录里透传的额外输入/);
  // 4 个媒体字段各自渲染出媒体容器，7 个素材各自一个 figure：修复前媒体数组为空，整块不渲染。
  assert.equal(html.split("run-value-media").length - 1, 4);
  assert.equal(html.split("<figure").length - 1, 7);
  assert.doesNotMatch(html, /暂无可预览媒体/);
});
