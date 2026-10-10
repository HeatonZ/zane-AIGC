import assert from "node:assert/strict";
import test from "node:test";
import { applyCommercePackImageNumbering, applyReferenceVideoImageNumbering, COMMERCE_PLAN_NUMBERING, COMMERCE_PROMPT_NUMBERING, REFERENCE_VIDEO_GENERATE_CONSTRAINT, REFERENCE_VIDEO_PROMPT_CONSTRAINT, SCENE_REFERENCE_IMAGE_PATCHES, scenePatchesFor } from "./sceneReferenceImageNumbering.js";
import type { RunWorkflowDefinition } from "./types.js";

/** Verbatim from the live 电商套图 · 商品原图直接排版 draft at run e2fbafc0. */
const commercePlanPrompt = `你是电商套图规划师。下面是本次任务的固定参数；商品图片以附件形式提供，标签为“商品主图”。

套图数量：{{input.number}}
提示词语言：中文
图中目标产品语言：{{input.language}}
套图风格：{{step.step_style_result_code.outputs.value}}
客户需求：{{input.need}}

附件说明：标签为“商品主图”的附件共有 1 张或多张，是同一商品的不同角度或细节，不是多个商品。

事实约束：
1. 只有“客户需求”明确写出的规格、容量、包装内容、功能、卖点和文案，才可以作为商品事实。
2. 附件图片只能支持可见的外观、颜色、轮廓、结构、纹理、材质表现和清晰可读的标识。
3. 不得从图片猜测容量、尺寸、重量、性能、功效、认证、包装数量、材质等级或不可见结构。
4. 客户需求为“无”或为空时，不得写具体数值、性能承诺、套装内容或未经确认的产品描述。

规划要求：
- 第 1 张为主图或首张 hero 图；若客户需求涉及平台主图，使用干净背景，只展示实际售卖内容，且不放未经确认的文字。
- 后续图片分别承担卖点展示、可见细节、使用场景或品牌氛围。
- 每张图只表达一个主要目的，信息密度不要过高。
- 图中文字只能使用客户需求中确认的文案；没有确认文案时可以不留文字。
- 无法确认的内容只写成视觉方向，不要写成商品事实。

必须输出恰好 {{input.number}} 张，id 唯一，index 从 1 连续递增。`;

const commercePromptStep = `你是 Qwen Image 2.1 图生图提示词编辑器，只转写，不新增事实。

目标语言：{{iteration.item.targetLanguage}}
图像类型：{{iteration.item.type}}
本轮设计：{{iteration.item.design}}
允许使用的文字：{{iteration.item.copy}}
客户需求：{{input.need}}

附件说明：标签为“商品主图”的附件是同一商品的原始商品图，1 张或多张，按编号顺序排列，是商品外观的唯一事实来源。

要求：
1. 保留附件中可见的商品外观、颜色、轮廓、结构、纹理、标识和配件关系。
2. 多张附件属于同一商品，只用于补充不同角度和细节，不得组合成多个商品。`;

const commerceWorkflow = (planPrompt = commercePlanPrompt) => ({
  sceneId: "scene_657398fc-87bf-418e-ac18-295cfae9d904",
  name: "电商套图 · 商品原图直接排版",
  inputs: [{ key: "product_images", label: "商品图", type: "image_list", required: true }],
  steps: [
    { id: "plan", name: "套图方案", kind: "hermes", hermesProfile: "ecom-design", inputs: [{ key: "input_1", label: "新输入", sourceRef: "input.product_images", selection: { mode: "all" } }], outputs: [{ key: "cards", type: "json" }], promptTemplate: planPrompt },
    { id: "step_muz67l21_2", name: "转提示词", kind: "hermes", hermesProfile: "aixg", inputs: [{ key: "input_1", label: "新输入", sourceRef: "input.product_images", selection: { mode: "all" } }], outputs: [{ key: "result", type: "text" }], promptTemplate: commercePromptStep },
    { id: "step_muz6cbw4_3", name: "生图", kind: "comfyui", inputs: [{ key: "input_1", label: "新输入变量", sourceRef: "input.product_images", valueSource: "reference" }], outputs: [{ key: "result", type: "image_list" }], promptTemplate: "", comfyui: { workflowFile: "Zane/i2i_UI.json", bindings: [] } },
  ],
  outputs: [],
} as unknown as RunWorkflowDefinition);

test("电商套图方案补上图N编号，并要求每个方案写明外观依据", () => {
  const { workflow, changes } = applyCommercePackImageNumbering(commerceWorkflow());
  const plan = workflow.steps!.find(step => step.id === "plan")!;
  assert.ok(plan.promptTemplate!.endsWith(COMMERCE_PLAN_NUMBERING));
  assert.match(plan.promptTemplate!, /图1、图2……（附件前的“第 N 张”即 图N）/);
  assert.match(plan.promptTemplate!, /每个方案都必须写明产品外观依据哪几张 图N（至少 1 张）/);
  assert.match(plan.promptTemplate!, /必须输出恰好 \{\{input\.number\}\} 张/);
  assert.equal(plan.inputs?.[0].label, "商品主图");
  assert.ok(changes.some(change => change.includes("第 1 张 → 第 1 个方案")), changes.join("\n"));
  assert.ok(changes.some(change => change.includes("后续图片 → 后续方案")));
  assert.ok(changes.some(change => change.includes("每张图 → 每个方案")));
  assert.ok(!changes.some(change => change.includes("第 1 张为主图")));
  assert.ok(changes.some(change => change.includes("图片输入标签 新输入 → 商品主图")));
});

test("转提示词步骤同样补上图N编号，外观引用必须落到具体附件", () => {
  const { workflow, changes } = applyCommercePackImageNumbering(commerceWorkflow());
  const step = workflow.steps!.find(item => item.id === "step_muz67l21_2")!;
  assert.ok(step.promptTemplate!.endsWith(COMMERCE_PROMPT_NUMBERING));
  assert.match(step.promptTemplate!, /提示词中引用商品外观时必须写明依据 图N/);
  assert.equal(step.inputs?.[0].label, "商品主图");
  assert.equal(changes.filter(change => change.startsWith("转提示词")).length, 2);
});

test("第三方版同样修好，且不动生图等无关步骤", () => {
  const thirdPartyPlan = commercePlanPrompt + "\n\n功能与品类锚点（每张都遵守）：\n- 只展示客户提供的这一个商品。";
  const workflow = commerceWorkflow(thirdPartyPlan);
  workflow.steps![2].id = "step_muz9npd0_9";
  const { workflow: patched, changes } = applyCommercePackImageNumbering(workflow);
  assert.match(patched.steps!.find(step => step.id === "plan")!.promptTemplate!, /图1、图2……/);
  assert.ok(patched.steps!.find(step => step.id === "plan")!.promptTemplate!.includes("功能与品类锚点"));
  assert.deepEqual(patched.steps![2], workflow.steps![2]);
  assert.ok(changes.every(change => !change.includes("生图")));
});

test("幂等：已打补丁的电商草稿不再改动", () => {
  const first = applyCommercePackImageNumbering(commerceWorkflow());
  const second = applyCommercePackImageNumbering(first.workflow);
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.workflow, first.workflow);
});

test("参考生视频补丁保持原行为并已入库注册", () => {
  const workflow = {
    sceneId: "scene_3a95a9cb-ed5e-468f-aac9-59b670b1f979",
    name: "AI文生视频流程",
    inputs: [],
    steps: [
      { id: "generate", name: "内容生成", kind: "hermes", inputs: [{ key: "input_1", label: "新输入", sourceRef: "input.references" }], outputs: [], promptTemplate: "基于参考图、用户想法来联想并设计扩写成详细的制作级分镜视频脚本\n画面参数： {{input.ratio}}，{{input.time}}秒\n用户输入：{{input.thought}}" },
      { id: "step_mul07sy6_2", name: "提示词", kind: "hermes", inputs: [], outputs: [], promptTemplate: "基于文案转换为提示词，模型：Minimax H3，r2v，视频脚本：{{step.generate.outputs.result}}" },
    ],
    outputs: [],
  } as unknown as RunWorkflowDefinition;
  const { workflow: patched, changes } = applyReferenceVideoImageNumbering(workflow);
  assert.ok(patched.steps![0].promptTemplate!.endsWith(REFERENCE_VIDEO_GENERATE_CONSTRAINT));
  assert.ok(patched.steps![1].promptTemplate!.endsWith(REFERENCE_VIDEO_PROMPT_CONSTRAINT));
  assert.equal(patched.steps![0].inputs?.[0].label, "有序参考图");
  assert.equal(changes.length, 3);
  const ids = SCENE_REFERENCE_IMAGE_PATCHES.map(patch => patch.sceneId);
  assert.deepEqual(ids, ["scene_3a95a9cb-ed5e-468f-aac9-59b670b1f979", "scene_657398fc-87bf-418e-ac18-295cfae9d904", "scene_48e63890-1801-429f-8dd6-0214f0a0cf0a"]);
  assert.equal(scenePatchesFor("all").length, 3);
  assert.equal(scenePatchesFor("scene_48e63890-1801-429f-8dd6-0214f0a0cf0a")[0].title, "电商套图第三方版");
  assert.throws(() => scenePatchesFor("scene_missing"), /未知场景/);
});
