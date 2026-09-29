import type { SceneId, SceneModule, WorkflowDefinition } from "../types";

export const defaultWorkflows: Record<string, WorkflowDefinition> = {
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
      { key: "prompt", label: "正向提示词", type: "textarea", required: true, placeholder: "描述主体、环境、风格和画面细节" },
      { key: "negative_prompt", label: "反向提示词", type: "textarea", required: false, placeholder: "不希望出现的内容" },
      { key: "width", label: "宽度", type: "number", required: true, placeholder: "1024" },
      { key: "height", label: "高度", type: "number", required: true, placeholder: "1024" },
      { key: "seed", label: "随机种子", type: "number", required: false, placeholder: "留空使用随机种子" },
    ],
    steps: [
      {
        id: "text_to_image",
        name: "ComfyUI 文生图",
        kind: "comfyui",
        inputs: [],
        outputs: [{ key: "image", label: "生成图像", type: "image" }],
        promptTemplate: "",
        comfyui: { workflowFile: "", bindings: [] },
      },
    ],
    outputs: [{ key: "image", label: "生成图像", type: "image", sourceRef: "step.text_to_image.outputs.image" }],
  },
  image_to_image: {
    sceneId: "image_to_image",
    name: "基础图生图流程",
    inputs: [
      { key: "reference_images", label: "参考图片", type: "image_list", required: true, placeholder: "按使用顺序逐张添加参考图" },
      { key: "prompt", label: "正向提示词", type: "textarea", required: true, placeholder: "描述希望如何改动参考图片" },
      { key: "negative_prompt", label: "反向提示词", type: "textarea", required: false, placeholder: "可留空" },
      { key: "resolution", label: "参考图缩放基准", type: "number", required: false, placeholder: "留空保留第一张图尺寸" },
      { key: "seed", label: "随机种子", type: "number", required: false, placeholder: "留空使用工作流默认值" },
      { key: "steps", label: "生成步数", type: "number", required: false, placeholder: "留空使用工作流默认值" },
      { key: "cfg", label: "CFG", type: "number", required: false, placeholder: "留空使用工作流默认值" },
    ],
    steps: [
      {
        id: "image_to_image",
        name: "ComfyUI 图生图",
        kind: "comfyui",
        execution: { mode: "for_each", sourceRef: "input.reference_images", onError: "continue" },
        inputs: [
          { key: "reference_images", label: "参考图片", sourceRef: "input.reference_images" },
          { key: "prompt", label: "正向提示词", sourceRef: "input.prompt" },
          { key: "negative_prompt", label: "反向提示词", sourceRef: "input.negative_prompt" },
          { key: "resolution", label: "参考图缩放基准", sourceRef: "input.resolution" },
          { key: "seed", label: "随机种子", sourceRef: "input.seed" },
          { key: "steps", label: "生成步数", sourceRef: "input.steps" },
          { key: "cfg", label: "CFG", sourceRef: "input.cfg" },
        ],
        outputs: [{ key: "images", label: "生成图像", type: "image" }],
        promptTemplate: "",
        comfyui: {
          workflowFile: "Zane/i2i_UI.json",
          bindings: [
            { key: "reference_images", label: "参考图片", direction: "input", nodeId: "471", property: "images", type: "image_list", sourceRef: "input.reference_images", required: true },
            { key: "prompt", label: "正向提示词", direction: "input", nodeId: "471", property: "prompt", type: "text", sourceRef: "input.prompt", required: true },
            { key: "negative_prompt", label: "反向提示词", direction: "input", nodeId: "471", property: "negative_prompt", type: "text", sourceRef: "input.negative_prompt", required: false },
            { key: "resolution", label: "参考图缩放基准", direction: "input", nodeId: "471", property: "resolution", type: "number", sourceRef: "input.resolution", required: false },
            { key: "seed", label: "随机种子", direction: "input", nodeId: "476", property: "seed", type: "number", sourceRef: "input.seed", required: false },
            { key: "steps", label: "生成步数", direction: "input", nodeId: "476", property: "steps", type: "number", sourceRef: "input.steps", required: false },
            { key: "cfg", label: "CFG", direction: "input", nodeId: "476", property: "cfg", type: "number", sourceRef: "input.cfg", required: false },
            { key: "images", label: "生成图像", direction: "output", nodeId: "461", property: "images", type: "image" },
          ],
        },
      },
    ],
    outputs: [{ key: "images", label: "生成图像", type: "image", sourceRef: "step.image_to_image.outputs.images" }],
  },
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
