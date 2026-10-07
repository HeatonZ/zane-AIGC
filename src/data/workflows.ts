import commerceAiPackage from "../../examples/scenes/commerce-ai.json";
import basicImageLayoutPackage from "../../examples/scenes/basic-image-layout.json";
import commercePackPackage from "../../examples/scenes/commerce-pack.json";
import type { SceneId, SceneModule, WorkflowDefinition } from "../types";
import imageToImagePackage from "../../examples/scenes/image-to-image-qwen21.json";

export const defaultWorkflows: Record<string, WorkflowDefinition> = {
  commerce_ai: commerceAiPackage.workflow as WorkflowDefinition,
  basic_image_layout: basicImageLayoutPackage.workflow as WorkflowDefinition,
  commerce_pack: commercePackPackage.workflow as WorkflowDefinition,
  comic: {
    sceneId: "comic",
    name: "漫剧制作流程",
    inputs: [
      { key: "project_name", label: "项目名称", type: "text", required: true, placeholder: "例如：雾港来信" },
      { key: "story_seed", label: "故事种子", type: "textarea", required: true, placeholder: "主角、困境与故事转折" },
      { key: "genre", label: "故事类型", type: "select", required: true, options: ["悬疑", "都市", "奇幻", "爱情", "科幻", "其他"] },
      { key: "format", label: "内容规格", type: "select", required: true, options: ["竖屏短篇", "系列章节", "单集故事"] },
    ],
    steps: [
      {
        id: "script",
        name: "剧本策划",
        kind: "hermes",
        hermesProfile: "default",
        inputs: [
          { key: "project_name", label: "项目名称", sourceRef: "input.project_name" },
          { key: "story_seed", label: "故事种子", sourceRef: "input.story_seed" },
          { key: "genre", label: "故事类型", sourceRef: "input.genre" },
          { key: "format", label: "内容规格", sourceRef: "input.format" },
        ],
        outputs: [
          { key: "screenplay", label: "剧本", type: "text" },
          { key: "character_bible", label: "角色设定", type: "json" },
        ],
        promptTemplate: "为{{input.project_name}}创作{{input.format}}故事。类型：{{input.genre}}。故事种子：{{input.story_seed}}",
      },
      {
        id: "storyboard",
        name: "分镜设计",
        kind: "hermes",
        hermesProfile: "writer",
        inputs: [
          { key: "screenplay", label: "剧本", sourceRef: "step.script.outputs.screenplay" },
          { key: "character_bible", label: "角色设定", sourceRef: "step.script.outputs.character_bible" },
        ],
        outputs: [{ key: "storyboard", label: "分镜脚本", type: "json" }],
        promptTemplate: "基于以下剧本与角色设定，按镜头输出分镜。\n剧本：{{step.script.outputs.screenplay}}\n角色：{{step.script.outputs.character_bible}}",
      },
      {
        id: "keyframes",
        name: "关键帧生成",
        kind: "comfyui",
        comfyui: { workflowFile: "", bindings: [] },
        inputs: [{ key: "storyboard", label: "分镜脚本", sourceRef: "step.storyboard.outputs.storyboard" }],
        outputs: [{ key: "keyframes", label: "关键帧", type: "image" }],
        promptTemplate: "",
      },
      {
        id: "video",
        name: "动态画面",
        kind: "comfyui",
        comfyui: { workflowFile: "", bindings: [] },
        inputs: [{ key: "keyframes", label: "关键帧", sourceRef: "step.keyframes.outputs.keyframes" }],
        outputs: [{ key: "video", label: "漫剧片段", type: "video" }],
        promptTemplate: "",
      },
    ],
    outputs: [
      { key: "screenplay", label: "剧本", type: "text", sourceRef: "step.script.outputs.screenplay" },
      { key: "storyboard", label: "分镜脚本", type: "json", sourceRef: "step.storyboard.outputs.storyboard" },
      { key: "video", label: "漫剧片段", type: "video", sourceRef: "step.video.outputs.video" },
    ],
  },
  commerce: {
    sceneId: "commerce",
    name: "商品展示流程",
    inputs: [
      { key: "project_name", label: "项目名称", type: "text", required: true, placeholder: "例如：春日轻跑鞋首发" },
      { key: "product_name", label: "商品名称", type: "text", required: true, placeholder: "品牌与商品型号" },
      { key: "selling_points", label: "核心卖点", type: "textarea", required: true, placeholder: "最希望用户记住的 1–3 个特点" },
      { key: "audience", label: "目标人群", type: "text", required: false, placeholder: "例如：城市通勤人群" },
      { key: "visual_style", label: "视觉方向", type: "select", required: true, options: ["自然质感", "明快活力", "简洁高级", "生活方式", "强对比广告"] },
    ],
    steps: [
      {
        id: "product_brief",
        name: "商品理解",
        kind: "hermes",
        hermesProfile: "default",
        inputs: [
          { key: "product_name", label: "商品名称", sourceRef: "input.product_name" },
          { key: "selling_points", label: "核心卖点", sourceRef: "input.selling_points" },
          { key: "audience", label: "目标人群", sourceRef: "input.audience" },
        ],
        outputs: [{ key: "product_brief", label: "商品企划", type: "json" }],
        promptTemplate: "为商品{{input.product_name}}梳理展示企划。卖点：{{input.selling_points}}。目标人群：{{input.audience}}。",
      },
      {
        id: "shotlist",
        name: "镜头脚本",
        kind: "hermes",
        hermesProfile: "writer",
        inputs: [
          { key: "product_brief", label: "商品企划", sourceRef: "step.product_brief.outputs.product_brief" },
          { key: "visual_style", label: "视觉方向", sourceRef: "input.visual_style" },
        ],
        outputs: [{ key: "shotlist", label: "展示镜头", type: "json" }],
        promptTemplate: "根据商品企划输出可执行的展示镜头。视觉方向：{{input.visual_style}}。企划：{{step.product_brief.outputs.product_brief}}",
      },
      {
        id: "product_images",
        name: "商品画面",
        kind: "comfyui",
        comfyui: { workflowFile: "", bindings: [] },
        inputs: [{ key: "shotlist", label: "展示镜头", sourceRef: "step.shotlist.outputs.shotlist" }],
        outputs: [{ key: "images", label: "商品画面", type: "image" }],
        promptTemplate: "",
      },
      {
        id: "product_video",
        name: "展示视频",
        kind: "comfyui",
        comfyui: { workflowFile: "", bindings: [] },
        inputs: [{ key: "images", label: "商品画面", sourceRef: "step.product_images.outputs.images" }],
        outputs: [{ key: "video", label: "商品展示视频", type: "video" }],
        promptTemplate: "",
      },
    ],
    outputs: [
      { key: "product_brief", label: "商品企划", type: "json", sourceRef: "step.product_brief.outputs.product_brief" },
      { key: "shotlist", label: "展示镜头", type: "json", sourceRef: "step.shotlist.outputs.shotlist" },
      { key: "video", label: "商品展示视频", type: "video", sourceRef: "step.product_video.outputs.video" },
    ],
  },
  text_to_image: {
    sceneId: "text_to_image",
    name: "基础文生图流程",
    inputs: [
      { key: "prompt", label: "任务说明 / 正向提示词", type: "textarea", required: false, placeholder: "不上传参考图时填写生图描述；上传参考图时可留空" },
      { key: "reference_images", label: "参考图片", type: "image_list", required: false, placeholder: "仅用于反推提示词，不传入生图模型；描述可留空" },
      { key: "negative_prompt", label: "反向提示词", type: "textarea", required: false, placeholder: "不希望出现的内容" },
      { key: "width", label: "文生图宽度", type: "number", required: true, placeholder: "1024" },
      { key: "height", label: "文生图高度", type: "number", required: true, placeholder: "1024" },
      { key: "seed", label: "随机种子", type: "number", required: false, placeholder: "留空使用工作流默认值" },
    ],
    steps: [
      {
        id: "has_reference_images",
        name: "判断是否有参考图",
        kind: "control",
        inputs: [],
        outputs: [{ key: "result", label: "有参考图", type: "boolean" }],
        promptTemplate: "",
        control: {
          type: "condition",
          match: "all",
          rules: [{ id: "reference_images_present", leftRef: "input.reference_images", operator: "is_not_empty", valueSource: "literal", rightValue: "", rightRef: "" }],
        },
      },
      {
        id: "reverse_prompt",
        name: "参考图提示词反推",
        kind: "hermes",
        hermesProfile: "aixg",
        runCondition: { conditionStepId: "has_reference_images", expectedResult: true },
        inputs: [{ key: "reference_images", label: "参考图片", sourceRef: "input.reference_images" }],
        outputs: [{ key: "prompt", label: "反推后的正向提示词", type: "text" }],
        promptTemplate: "请读取附带的参考图片，反推出一条详细、独立的纯文生图提示词。生成模型不会看到任何参考图片，提示词必须只靠文字完整说明画面。按全景构图→前景/中景/背景→由左到右的顺序描述：主体的准确数量、可辨识外观、大小、位置、朝向和相互关系，以及场景、物品层级、背景、摄影视角、画面裁切、风格、材质、光线和色彩。多张图片时以第一张为主要画面，其他图片只补充同一主体的可见细节，不拼贴互相矛盾的场景。不臆测不可见细节或无法辨认的文字，不新增、删减或美化主体。输出必须是具体画面描述，不写“参考原图”“保持原图”“按图编辑”等依赖图片的指令。仅返回提示词文本，不附加解释，不调用工具，不搜索，不生成或编辑图片。",
      },
      {
        id: "prompt_prepare",
        name: "整理纯文生图提示词",
        kind: "hermes",
        hermesProfile: "aixg",
        inputs: [
          { key: "reverse_prompt", label: "参考图反推文本", sourceRef: "step.reverse_prompt.outputs.prompt" },
          { key: "prompt", label: "任务说明", sourceRef: "input.prompt" },
        ],
        outputs: [{ key: "prompt", label: "生图提示词", type: "text" }],
        promptTemplate: "整理为一条详细、独立的纯文生图正向提示词，生成模型只会收到文字，不会收到参考图片。有反推结果时，以反推文本为基础，保留其中明确的主体数量、空间位置、前后关系、构图、背景、风格和光线，不重新联想扩写；用户有补充要求时只修改其明确要求的内容，补充要求为空时不要增删元素。没有反推结果时根据用户任务编写提示词。最终输出必须是自足的具体画面描述，不包含“第一张参考图”“保持原图”“根据图片编辑”等图生图指令。只整理提示词文本，不调用工具、不搜索、不执行图像生成或编辑。不要附加解释，只返回提示词。\n参考图反推文本：{{step.reverse_prompt.outputs.prompt}}\n用户任务：{{input.prompt}}",
      },
      {
        id: "text_to_image",
        name: "ComfyUI 纯文生图",
        kind: "comfyui",
        inputs: [
          { key: "prompt", label: "正向提示词", sourceRef: "step.prompt_prepare.outputs.prompt" },
          { key: "negative_prompt", label: "反向提示词", sourceRef: "input.negative_prompt" },
          { key: "width", label: "宽度", sourceRef: "input.width" },
          { key: "height", label: "高度", sourceRef: "input.height" },
          { key: "seed", label: "随机种子", sourceRef: "input.seed" },
        ],
        outputs: [{ key: "image", label: "生成图像", type: "image_list" }],
        promptTemplate: "",
        comfyui: { workflowFile: "", bindings: [] },
      },
    ],
    outputs: [{ key: "image", label: "生成图像", type: "image_list", sourceRef: "step.text_to_image.outputs.image" }],
  },
  image_to_image: imageToImagePackage.workflow as WorkflowDefinition,
};

export function cloneDefaultWorkflows() {
  return structuredClone(defaultWorkflows);
}

export function createSceneWorkflow(scene: SceneModule): WorkflowDefinition {
  return {
    sceneId: scene.id as SceneId,
    name: `${scene.title}流程`,
    inputs: [
      { key: "prompt", label: "提示词", type: "textarea", required: true, placeholder: "描述希望生成的内容" },
    ],
    steps: [
      {
        id: "generate",
        name: "内容生成",
        kind: "comfyui",
        comfyui: { workflowFile: "", bindings: [] },
        inputs: [{ key: "prompt", label: "提示词", sourceRef: "input.prompt" }],
        outputs: [{ key: "result", label: "生成结果", type: "image" }],
        promptTemplate: "",
      },
    ],
    outputs: [{ key: "result", label: "生成结果", type: "image", sourceRef: "step.generate.outputs.result" }],
  };
}
