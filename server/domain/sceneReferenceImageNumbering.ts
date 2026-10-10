/** Reference-image numbering for scene prompts that hand raw attachments to a model.
 *
 * Attachments arrive with a runtime caption such as 商品主图（第 1 张）. Unless the scene prompt
 * declares how an attachment is identified, the model can only gesture at "参考图" and quietly
 * asserts things it cannot verify. Two scenes already shipped that defect:
 *
 * - AI参考生视频: run ad7764fa wrote "与参考图一致" with two product photos and no 图N anywhere.
 * - 电商套图 (自研版/第三方版): run e2fbafc0 produced 10 cards where only card 01/02 (and the
 *   closing card) cited an image; cards 03-09 had no appearance source at all, because the prompt
 *   never numbered the attachments and its only "第 1 张"/"后续图片" wording reads like attachment
 *   positions instead of output cards.
 *
 * The fix is prompt-side, never a runtime re-labeling: each patch declares 图1、图2 … in upload
 * order and requires every produced unit to name the 图N its visible facts come from.
 */
import type { RunStep, RunWorkflowDefinition } from "./types.js";

export interface SceneImageNumberingPatch {
  sceneId: string;
  title: string;
  apply(workflow: RunWorkflowDefinition): { workflow: RunWorkflowDefinition; changes: string[] };
}

export const REFERENCE_VIDEO_SCENE_ID = "scene_3a95a9cb-ed5e-468f-aac9-59b670b1f979";
export const REFERENCE_VIDEO_SCENE_TITLE = "AI参考生视频";
export const REFERENCE_VIDEO_GENERATE_STEP_ID = "generate";
export const REFERENCE_VIDEO_PROMPT_STEP_ID = "step_mul07sy6_2";
export const REFERENCE_VIDEO_IMAGE_INPUT_SOURCE = "input.references";
export const REFERENCE_VIDEO_IMAGE_INPUT_LABEL = "有序参考图";
const REFERENCE_CONSTRAINT_MARKER = "[Zane 参考图约束]";

export const REFERENCE_VIDEO_GENERATE_CONSTRAINT = [
  REFERENCE_CONSTRAINT_MARKER,
  "参考图以附件按上传顺序提供，编号从 1 开始：图1、图2……依次对应第 1、2…… 张上传图；没有对应附件的编号不得出现，也不要把文件名、路径或 URL 写进脚本。",
  "脚本中凡涉及主体外观、结构、颜色、材质、logo 位置等画面事实，必须写明依据 图N；只能描述图上可见内容，不得据此猜测尺寸、容量、重量、性能、功效、认证、包装数量或不可见结构；无法从任何一张图确认的内容只写成待确认项，不作为产品事实。",
  "这些参考图之后会按原顺序直接传入 H3 模型（第1张对应 <Picture 1>），脚本里的编号必须与上传顺序一致，不得改写、颠倒或虚构参考图，也不得擅自新增主体、对白或音乐。",
].join("\n");

export const REFERENCE_VIDEO_PROMPT_CONSTRAINT = [
  REFERENCE_CONSTRAINT_MARKER,
  "输入参考图将按原顺序直接传入 H3 模型；第1张对应 <Picture 1>，后续依次对应 <Picture 2> 等。严格保留参考图的主体外观、结构、颜色及用户指定构图；不虚构未上传的参考图，不擅自新增主体、对白或音乐。",
  "提示词里的 Picture 编号必须与脚本引用的 图N 一一对应，只引用真实存在的附件；不得改写、颠倒或新增参考图顺序。",
].join("\n");

export const COMMERCE_PACK_SCENE_ID = "scene_657398fc-87bf-418e-ac18-295cfae9d904";
export const COMMERCE_PACK_THIRD_PARTY_SCENE_ID = "scene_48e63890-1801-429f-8dd6-0214f0a0cf0a";
export const COMMERCE_PLAN_STEP_ID = "plan";
export const COMMERCE_PROMPT_STEP_ID = "step_muz67l21_2";
export const COMMERCE_PRODUCT_IMAGE_INPUT_LABEL = "商品主图";
const COMMERCE_MARKER = "[Zane 参考图编号]";

export const COMMERCE_PLAN_NUMBERING = [
  COMMERCE_MARKER,
  "商品图附件按上传顺序编号为 图1、图2……（附件前的“第 N 张”即 图N），是同一商品的不同角度或细节，不是多个商品；没有对应附件的编号不得出现。",
  "每个方案都必须写明产品外观依据哪几张 图N（至少 1 张）；外观只能写这些图上可见的内容，不依赖外观的方案也不得新增外观特征。",
].join("\n");

export const COMMERCE_PROMPT_NUMBERING = [
  COMMERCE_MARKER,
  "商品图附件按上传顺序编号为 图1、图2……（附件前的“第 N 张”即 图N）；提示词中引用商品外观时必须写明依据 图N，外观描述只能取自这些图可见的内容。",
].join("\n");

/** 第 1 张/后续图片 read like attachment positions, which is what pushed cards 03-09 off the images. */
const COMMERCE_PLAN_REWRITES: Array<[RegExp, string, string]> = [
  [/- 第 1 张为主图或首张 hero 图；/, "- 第 1 个方案为主图或首张 hero 图；", "第 1 张 → 第 1 个方案"],
  [/- 后续图片分别承担/, "- 后续方案分别承担", "后续图片 → 后续方案"],
  [/- 每张图只表达一个主要目的/, "- 每个方案只表达一个主要目的", "每张图 → 每个方案"],
];

function hasMarker(prompt: string, marker: string): boolean {
  return prompt.includes(marker);
}

function appendBlock(prompt: string, block: string): string {
  const trimmed = prompt.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

function changed(workflow: RunWorkflowDefinition, steps: RunStep[], original: readonly RunStep[]): RunWorkflowDefinition {
  return steps.every((step, index) => step === original[index]) ? workflow : { ...workflow, steps };
}

/** Attachments must carry a meaningful label instead of the generic 新输入. */
function labelImageInputs(step: RunStep, label: string, source: string, changes: string[]): RunStep {
  const original = step.inputs ?? [];
  const inputs = original.map((input) => {
    const bound = (input.sourceRef ?? "").startsWith(source);
    if (!bound || (input.label ?? "") === label) return input;
    changes.push(`${step.name}：图片输入标签 ${input.label ?? input.key} → ${label}`);
    return { ...input, label };
  });
  return inputs.some((input, index) => input !== original[index]) ? { ...step, inputs } : step;
}

function patchReferenceGenerateStep(step: RunStep, changes: string[]): RunStep {
  const prompt = step.promptTemplate ?? "";
  if (hasMarker(prompt, REFERENCE_CONSTRAINT_MARKER) && !/图\s*1/.test(prompt)) changes.push(`${step.name}：已有参考图约束但未写 图N 编号，请人工核对`);
  const next = hasMarker(prompt, REFERENCE_CONSTRAINT_MARKER) ? step : { ...step, promptTemplate: appendBlock(prompt, REFERENCE_VIDEO_GENERATE_CONSTRAINT) };
  if (next !== step) changes.push(`${step.name}：系统提示词补充参考图编号（图1、图2……按上传顺序）与可见事实约束`);
  return labelImageInputs(next, REFERENCE_VIDEO_IMAGE_INPUT_LABEL, REFERENCE_VIDEO_IMAGE_INPUT_SOURCE, changes);
}

function patchReferencePromptStep(step: RunStep, changes: string[]): RunStep {
  const prompt = step.promptTemplate ?? "";
  if (hasMarker(prompt, REFERENCE_CONSTRAINT_MARKER)) return step;
  changes.push(`${step.name}：系统提示词恢复 <Picture N> 参考图契约并与 图N 对齐`);
  return { ...step, promptTemplate: appendBlock(prompt, REFERENCE_VIDEO_PROMPT_CONSTRAINT) };
}

/** Idempotent: an already patched draft yields no changes; unrelated steps stay untouched. */
export function applyReferenceVideoImageNumbering(workflow: RunWorkflowDefinition): { workflow: RunWorkflowDefinition; changes: string[] } {
  const changes: string[] = [];
  const original = workflow.steps ?? [];
  const steps = original.map((step) => {
    if (step.id === REFERENCE_VIDEO_GENERATE_STEP_ID) return patchReferenceGenerateStep(step, changes);
    if (step.id === REFERENCE_VIDEO_PROMPT_STEP_ID) return patchReferencePromptStep(step, changes);
    return step;
  });
  return { workflow: changed(workflow, steps, original), changes };
}

function patchCommercePlanStep(step: RunStep, changes: string[]): RunStep {
  let prompt = step.promptTemplate ?? "";
  for (const [pattern, replacement, note] of COMMERCE_PLAN_REWRITES) {
    if (!pattern.test(prompt)) continue;
    prompt = prompt.replace(pattern, replacement);
    changes.push(`${step.name}：措辞消歧（${note}，指输出方案而非附件）`);
  }
  let next = step;
  if (prompt !== (step.promptTemplate ?? "")) next = { ...next, promptTemplate: prompt };
  if (!hasMarker(prompt, COMMERCE_MARKER)) {
    next = { ...next, promptTemplate: appendBlock(prompt, COMMERCE_PLAN_NUMBERING) };
    changes.push(`${step.name}：系统提示词补充参考图编号（图1、图2……按上传顺序），并要求每个方案写明外观依据 图N`);
  }
  return labelImageInputs(next, COMMERCE_PRODUCT_IMAGE_INPUT_LABEL, "input.", changes);
}

function patchCommercePromptStep(step: RunStep, changes: string[]): RunStep {
  const prompt = step.promptTemplate ?? "";
  let next = step;
  if (!hasMarker(prompt, COMMERCE_MARKER)) {
    next = { ...next, promptTemplate: appendBlock(prompt, COMMERCE_PROMPT_NUMBERING) };
    changes.push(`${step.name}：系统提示词补充参考图编号（图1、图2……按上传顺序），提示词引用外观必须写明 图N`);
  }
  return labelImageInputs(next, COMMERCE_PRODUCT_IMAGE_INPUT_LABEL, "input.", changes);
}

/** Idempotent, and safe for both commerce scenes: only the two Hermes steps and their labels change. */
export function applyCommercePackImageNumbering(workflow: RunWorkflowDefinition): { workflow: RunWorkflowDefinition; changes: string[] } {
  const changes: string[] = [];
  const original = workflow.steps ?? [];
  const steps = original.map((step) => {
    if (step.id === COMMERCE_PLAN_STEP_ID) return patchCommercePlanStep(step, changes);
    if (step.id === COMMERCE_PROMPT_STEP_ID) return patchCommercePromptStep(step, changes);
    return step;
  });
  return { workflow: changed(workflow, steps, original), changes };
}

export const SCENE_REFERENCE_IMAGE_PATCHES: readonly SceneImageNumberingPatch[] = [
  { sceneId: REFERENCE_VIDEO_SCENE_ID, title: REFERENCE_VIDEO_SCENE_TITLE, apply: applyReferenceVideoImageNumbering },
  { sceneId: COMMERCE_PACK_SCENE_ID, title: "电商套图自研版", apply: applyCommercePackImageNumbering },
  { sceneId: COMMERCE_PACK_THIRD_PARTY_SCENE_ID, title: "电商套图第三方版", apply: applyCommercePackImageNumbering },
];

export function scenePatchesFor(scene: string): readonly SceneImageNumberingPatch[] {
  if (scene === "all") return SCENE_REFERENCE_IMAGE_PATCHES;
  const selected = SCENE_REFERENCE_IMAGE_PATCHES.filter(patch => patch.sceneId === scene || patch.title === scene);
  if (!selected.length) throw new Error(`未知场景：${scene}；可用 all 或 ${SCENE_REFERENCE_IMAGE_PATCHES.map(patch => patch.sceneId).join(" / ")}`);
  return selected;
}
