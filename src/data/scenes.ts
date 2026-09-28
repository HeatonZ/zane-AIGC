import type { SceneModule } from "../types";

export const defaultScenes: SceneModule[] = [
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
];

export function getScene(sceneId: string | undefined, availableScenes: SceneModule[] = defaultScenes): SceneModule {
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
