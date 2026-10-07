import { HttpError } from "../errors.js";
import type { RunWorkflowDefinition } from "./types.js";
import { validateWorkflowShape } from "./workflowValidation.js";

export const QWEN_IMAGE_21_PROMPT_STEP_ID = "qwen_image_prompt";
export const QWEN_IMAGE_21_PROMPT_REF = `step.${QWEN_IMAGE_21_PROMPT_STEP_ID}.outputs.prompt`;

/** Model dialect is configuration of the basic Hermes step, not a new executor. */
export function qwenImage21PromptStep() {
  return {
    id: QWEN_IMAGE_21_PROMPT_STEP_ID,
    name: "AIXG → Qwen Image 2.1 编辑提示词",
    kind: "hermes" as const,
    hermesProfile: "aixg",
    inputs: [
      { key: "reference_images", label: "有序参考图片", sourceRef: "input.reference_images" },
      { key: "prompt", label: "用户编辑要求", sourceRef: "input.prompt" },
      { key: "negative_prompt", label: "原始反向约束", sourceRef: "input.negative_prompt" },
    ],
    outputs: [{
      key: "prompt", label: "Qwen Image 2.1 图像编辑提示词", type: "text" as const,
      description: "非空的中文自然语言图像编辑指令；多图按实际附件顺序引用 <image1>、<image2> 等。只包含最终编辑提示词，不含解释、Markdown、路径、URL 或生成参数。",
    }],
    promptTemplate: [
      "你负责把用户编辑要求转换为 Qwen Image 2.1 图像编辑方言提示词。只编写提示词，不调用工具、不搜索、不执行图像生成或编辑。",
      "先识别用户要做的局部修改、增删、替换、文字编辑、风格转换或多图融合，再写成具体、连贯的中文自然语言指令；不要输出标签堆砌、权重语法或空泛的画质口号。用户明确要求优先，不擅自改变任务。",
      "参考图片以实际附件顺序为准，编号从 1 开始，用 <image1>、<image2> 等标记准确指代。没有对应附件的编号不得出现；不要把图片文件名、路径、URL 或整份媒体 JSON 写进提示词。默认 <image1> 是待编辑的主画布，其他图片仅按用户指定的主体、服装、背景、材质或风格角色提供参考；用户明确指定其他主画布时服从用户。",
      "先说清楚改什么、从哪张图取什么，再说明位置、相对尺寸、遮挡、透视、光照和融合关系。多图不等于拼贴，不把每张参考图的所有元素自动加入结果；没有明确要求时不要复制主体或增加无关人物、物品、文字、水印。",
      "明确写出应该保持的主体身份、数量、形状、颜色、材质、构图、背景及未编辑区域，只保留与任务相容的约束；用户要求改变的属性不能同时要求保持。不要猜测图中看不见的细节，也不要把局部编辑改写成脱离参考图的纯文生图描述。",
      "文字编辑时用引号逐字保留用户指定的新文字，说明对应文字区域与需要延续的排版；不要自行翻译、改写品牌、Logo 或未要求修改的原有文字。风格转换也要保留用户未要求改变的内容和结构。",
      "反向约束会由后续 ComfyUI 的原始负向端口单独传递；正向指令不能与之矛盾，不生成新的负向字段。不编造比例、分辨率、像素、随机种子、步数或 CFG，这些参数保持现有独立绑定。",
      "按步骤输出契约返回 JSON 对象，其中 prompt 字段仅放最终非空编辑提示词，不附加推理、解释或其他字段。",
      "用户编辑要求：{{input.prompt}}",
      "原始反向约束（可为空）：{{input.negative_prompt}}",
    ].join("\n"),
  };
}

export const QWEN_IMAGE_21_WRITER_STEP_ID = "image_edit_writer";
export const QWEN_IMAGE_21_WRITER_REF = `step.${QWEN_IMAGE_21_WRITER_STEP_ID}.outputs.edit_brief`;

/** Organize the idea before dialect conversion; both remain basic Hermes steps. */
export function qwenImage21WriterStep() {
  return {
    id: QWEN_IMAGE_21_WRITER_STEP_ID,
    name: "Writer 整理想法",
    kind: "hermes" as const,
    hermesProfile: "writer",
    inputs: [
      { key: "reference_images", label: "有序参考图片", sourceRef: "input.reference_images" },
      { key: "idea", label: "用户想法", sourceRef: "input.prompt" },
    ],
    outputs: [{
      key: "edit_brief", label: "整理后的编辑说明", type: "text" as const,
      description: "非空的编辑说明：用户目标、主图与其他参考图的角色、具体修改及未修改区域的保持约束。保留原意与指定文字，不含生成参数或最终模型方言提示词。",
    }],
    promptTemplate: [
      "你是图像编辑需求整理 Writer。结合真实图片附件，把用户的想法整理为清楚、可执行的编辑说明，供下一步 AIXG 转换成 Qwen Image 2.1 提示词。只整理需求，不调用工具、不搜索、不生成或编辑图片。",
      "忠实保留用户原意、主体数量、明确修改及引号中的指定文字。把零散想法整理为编辑目标、参考图角色、修改区域与动作、位置和融合关系、需要保持的未修改属性；不要扩写成故事、广告文案或自由联想的文生图画面。",
      "图片以真实附件顺序编号，默认第一张是待编辑主图，其他图片只承担用户指定的主体、服装、背景、材质或风格参考。用户指定其他主图时服从用户；不得虚构图片编号、不可见细节、人物、物品、文字或水印。多图不等于拼贴。",
      "区分修改要求与保持约束，不要求保持用户要改变的属性。含糊之处采用最少改动的保守表述，不自行增加改动。不要把文件名、路径、URL 或媒体 JSON 写入说明。",
      "不编写模型方言、标签堆砌或权重语法，不生成负向提示词、随机种子、画幅、像素、步数、CFG 等参数；这些不是本步骤的输出。",
      "按步骤契约只返回 JSON 对象，edit_brief 字段为非空的整理后编辑说明，不附加推理、解释或其他字段。",
      "用户想法：{{input.prompt}}",
    ].join("\n"),
  };
}

/** The converter consumes the Writer result, never a parallel raw-idea prompt. */
export function qwenImage21WriterPromptStep() {
  const step = qwenImage21PromptStep();
  step.inputs = [
    { key: "reference_images", label: "有序参考图片", sourceRef: "input.reference_images" },
    { key: "prompt", label: "Writer 整理后的编辑说明", sourceRef: QWEN_IMAGE_21_WRITER_REF },
  ];
  step.promptTemplate = step.promptTemplate
    .replace("你负责把用户编辑要求转换为", "你负责把 Writer 整理后的编辑说明转换为")
    .replace(/^反向约束会.*$/m, "不生成新的负向字段，不编造比例、分辨率、像素、随机种子、步数或 CFG；生成参数由后续独立绑定或工作流固定配置提供。")
    .replace("用户编辑要求：{{input.prompt}}", `Writer 整理后的编辑说明：{{${QWEN_IMAGE_21_WRITER_REF}}}`)
    .replace("\n原始反向约束（可为空）：{{input.negative_prompt}}", "");
  return step;
}

/** Explicit draft edit only. Keep all user settings and historical snapshots untouched. */
export function addQwenImage21PromptStep<T extends RunWorkflowDefinition>(workflow: T, generationStepId = "image_to_image"): T {
  const invalid = (message: string): never => { throw new HttpError(400, message, "QWEN_IMAGE_PROMPT_CONFIGURATION_CONFLICT"); };
  validateWorkflowShape(workflow as unknown as Record<string, unknown>);
  const next = structuredClone(workflow);
  const candidates = next.steps.filter(step => step.id === generationStepId);
  if (candidates.length !== 1) invalid("必须明确选择一个已有图生图步骤，不覆盖自定义流程");
  const generate = candidates[0]!;
  if (generate.kind !== "comfyui" || generate.comfyui?.workflowFile !== "Zane/i2i_UI.json" || generate.comfyui.adapter) invalid("仅配置已核对的 Qwen Image 2.1 基础图生图工作流");
  if (generate.execution?.mode === "for_each") invalid("逐图执行与多图编号语义不同，必须先显式核对逐项提示词，不能自动替换");
  const promptBindings = generate.comfyui!.bindings?.filter(binding => binding.direction === "input" && binding.key === "prompt") ?? [];
  const promptInputs = generate.inputs?.filter(input => input.key === "prompt") ?? [];
  const imageBindings = generate.comfyui!.bindings?.filter(binding => binding.direction === "input" && binding.key === "reference_images") ?? [];
  if (promptBindings.length !== 1 || promptInputs.length !== 1 || imageBindings.length !== 1) invalid("正向提示词和参考图绑定必须唯一且完整");
  const promptBinding = promptBindings[0]!;
  const promptInput = promptInputs[0]!;
  const imageBinding = imageBindings[0]!;
  if (promptBinding.type !== "text" || promptBinding.property !== "prompt" || promptBinding.valueSource === "literal" || promptInput.valueSource === "literal") invalid("不能覆盖自定义提示词或非文本端口");
  if (imageBinding.type !== "image_list" || imageBinding.property !== "images" || imageBinding.sourceRef !== "input.reference_images" || imageBinding.valueSource === "literal" || (imageBinding.selection && imageBinding.selection.mode !== "all")) invalid("必须把完整有序参考图交给同一次图生图");
  const images = next.inputs.find(input => input.key === "reference_images");
  const prompt = next.inputs.find(input => input.key === "prompt");
  if (images?.type !== "image_list" || !prompt || !["text", "textarea"].includes(prompt.type)) invalid("缺少有序参考图或用户编辑要求输入");
  const template = qwenImage21PromptStep();
  if (!next.inputs.some(field => field.key === "negative_prompt")) {
    // Preserve workflows without a negative input; do not invent a new business field.
    template.inputs = template.inputs.filter(input => input.key !== "negative_prompt");
    template.promptTemplate = template.promptTemplate.replace("{{input.negative_prompt}}", "（未配置）");
  }
  const existing = next.steps.find(step => step.id === template.id);
  if (existing) {
    const sameInputs = existing.inputs?.length === template.inputs.length && template.inputs.every((expected, index) => {
      const actual = existing.inputs![index]!;
      return actual.key === expected.key && actual.sourceRef === expected.sourceRef && actual.valueSource !== "literal" && (!actual.selection || actual.selection.mode === "all");
    });
    if (existing.kind !== "hermes" || existing.hermesProfile !== "aixg" || existing.promptTemplate !== template.promptTemplate ||
      !sameInputs || existing.execution?.mode === "for_each" || existing.runCondition || (existing.capabilityId && existing.capabilityId !== "core.hermes") || existing.outputs?.length !== 1 || existing.outputs[0]?.key !== "prompt" || existing.outputs[0]?.type !== "text" ||
      next.steps.indexOf(existing) >= next.steps.indexOf(generate) || promptInput.sourceRef !== QWEN_IMAGE_21_PROMPT_REF || promptBinding.sourceRef !== QWEN_IMAGE_21_PROMPT_REF) invalid("已有同名步骤或提示词链路被编辑，请读取草稿核对，不自动覆盖");
    return next;
  }
  if (promptInput.sourceRef !== "input.prompt" || promptBinding.sourceRef !== "input.prompt") invalid("已有自定义提示词来源，不能自动替换");
  next.steps.splice(next.steps.indexOf(generate), 0, template);
  promptInput.sourceRef = QWEN_IMAGE_21_PROMPT_REF;
  promptBinding.sourceRef = QWEN_IMAGE_21_PROMPT_REF;
  validateWorkflowShape(next as unknown as Record<string, unknown>);
  return next;
}
