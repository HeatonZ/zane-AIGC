import commerceAiPackage from "../../examples/scenes/commerce-ai.json";
import basicImageLayoutPackage from "../../examples/scenes/basic-image-layout.json";
import commercePackPackage from "../../examples/scenes/commerce-pack.json";
import type { SceneModule } from "../types";

export const defaultScenes: SceneModule[] = [
  basicImageLayoutPackage.scene as SceneModule,
  commerceAiPackage.scene as SceneModule,
  {
    id: "text_to_image",
    title: "基础文生图",
    shortTitle: "文生图",
    summary: "用 ComfyUI 工作流生成图像",
    description: "选择本地工作流，绑定节点输入与输出",
    cover:
      "https://images.unsplash.com/photo-1547891654-e66ed7ebb968?auto=format&fit=crop&w=1200&q=85",
    coverPosition: "center 48%",
    accent: "green",
    stages: ["提示词", "节点绑定", "参数设置", "图像生成"],
  },
  {
    id: "image_to_image",
    title: "基础图生图",
    shortTitle: "图生图",
    summary: "Writer 整理想法 → AIXG 转提示词 → ComfyUI 图生图",
    description: "上传有序参考图片和想法，Writer 先整理编辑说明，AIXG 再转换 Qwen Image 2.1 提示词；只需设置随机种子、画幅和像素。",
    cover: "https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5?auto=format&fit=crop&w=1200&q=85",
    coverPosition: "center 42%",
    accent: "coral",
    stages: ["图片与想法","Writer 整理","AIXG 转提示词","ComfyUI 图生图","生成结果"],
  },
  {
    id: "comic",
    title: "漫剧制作",
    shortTitle: "漫剧",
    summary: "从故事构想到动态分镜",
    description: "脚本构思、角色设定与关键帧制作",
    cover:
      "https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=1200&q=85",
    coverPosition: "center 44%",
    accent: "green",
    stages: ["故事构思", "剧本拆解", "分镜设计", "画面生成"],
  },
  {
    id: "commerce",
    title: "商品展示",
    shortTitle: "商品",
    summary: "把商品卖点变成视觉内容",
    description: "商品理解、展示脚本与商品镜头",
    cover:
      "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=1200&q=85",
    coverPosition: "center 55%",
    accent: "coral",
    stages: ["商品理解", "卖点提炼", "镜头脚本", "画面生成"],
  },
  // Retain the old package for explicit compatibility, not as the default first solution.
  { ...commercePackPackage.scene, title: "电商套图（旧版兼容）", summary: "仅保留旧图包协议；新方案优先使用基础图片生成与排版", description: "已有图包流程保留；新场景用通用逐项执行 + 基础ComfyUI + 图片画布与排版，不为每个商品场景定制执行器。" } as SceneModule,
];

export function getScene(sceneId: string | undefined, availableScenes: SceneModule[]): SceneModule {
  return availableScenes.find((scene) => scene.id === sceneId) ?? {
    id: sceneId ?? "unknown",
    title: "已删除场景",
    shortTitle: "已删除场景",
    summary: "",
    description: "",
    cover: "",
    accent: "green",
    stages: [],
  };
}
