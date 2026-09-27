import type { SceneModule } from "../types";

export const scenes: SceneModule[] = [
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

export function getScene(sceneId: string | undefined): SceneModule {
  return scenes.find((scene) => scene.id === sceneId) ?? scenes[0];
}

