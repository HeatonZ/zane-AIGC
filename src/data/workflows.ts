import type { SceneId, WorkflowDefinition } from "../types";

export const defaultWorkflows: Record<SceneId, WorkflowDefinition> = {
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
        kind: "comfyui_image",
        inputs: [{ key: "storyboard", label: "分镜脚本", sourceRef: "step.storyboard.outputs.storyboard" }],
        outputs: [{ key: "keyframes", label: "关键帧", type: "image" }],
        promptTemplate: "",
      },
      {
        id: "video",
        name: "动态画面",
        kind: "comfyui_video",
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
        kind: "comfyui_image",
        inputs: [{ key: "shotlist", label: "展示镜头", sourceRef: "step.shotlist.outputs.shotlist" }],
        outputs: [{ key: "images", label: "商品画面", type: "image" }],
        promptTemplate: "",
      },
      {
        id: "product_video",
        name: "展示视频",
        kind: "comfyui_video",
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
};

export function cloneDefaultWorkflows() {
  return structuredClone(defaultWorkflows);
}
