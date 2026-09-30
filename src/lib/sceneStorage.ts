import { defaultScenes } from "../data/scenes";
import { createId } from "./ids";
import type { SceneDetails, SceneId, SceneModule } from "../types";

const storageKey = "zane-studio:scenes:v1";
const imageToImageSceneMigrationKey = "zane-studio:scenes:image-to-image-v2";

function normalizeScene(value: unknown, index: number): SceneModule | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const scene = value as Partial<SceneModule>;
  if (typeof scene.id !== "string" || !scene.id.trim()) return undefined;
  const title = typeof scene.title === "string" && scene.title.trim() ? scene.title.trim() : `场景 ${index + 1}`;
  return {
    id: scene.id,
    title,
    shortTitle: typeof scene.shortTitle === "string" && scene.shortTitle.trim() ? scene.shortTitle.trim() : title,
    summary: typeof scene.summary === "string" ? scene.summary.trim() : "",
    description: typeof scene.description === "string" ? scene.description.trim() : "",
    cover: typeof scene.cover === "string" ? scene.cover.trim() : "",
    coverPosition: typeof scene.coverPosition === "string" ? scene.coverPosition : "center",
    accent: scene.accent === "coral" ? "coral" : "green",
    stages: Array.isArray(scene.stages) ? scene.stages.filter((stage): stage is string => typeof stage === "string").map((stage) => stage.trim()).filter(Boolean) : [],
  };
}

export function readScenes(): SceneModule[] {
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved === null) {
      window.localStorage.setItem(imageToImageSceneMigrationKey, "done");
      return structuredClone(defaultScenes);
    }
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return structuredClone(defaultScenes);
    const seen = new Set<string>();
    const scenes = parsed.map(normalizeScene).filter((scene): scene is SceneModule => {
      if (!scene || seen.has(scene.id)) return false;
      seen.add(scene.id);
      return true;
    });
    if (window.localStorage.getItem(imageToImageSceneMigrationKey) !== "done") {
      const imageToImageScene = defaultScenes.find((scene) => scene.id === "image_to_image");
      if (imageToImageScene && !seen.has(imageToImageScene.id)) scenes.push(structuredClone(imageToImageScene));
      window.localStorage.setItem(storageKey, JSON.stringify(scenes));
      window.localStorage.setItem(imageToImageSceneMigrationKey, "done");
    }
    return scenes;
  } catch {
    return structuredClone(defaultScenes);
  }
}

export function writeScenes(scenes: SceneModule[]) {
  window.localStorage.setItem(storageKey, JSON.stringify(scenes));
}

export function moveScene(scenes: SceneModule[], sceneId: SceneId, targetIndex: number): SceneModule[] {
  const currentIndex = scenes.findIndex((scene) => scene.id === sceneId);
  if (currentIndex < 0 || !Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= scenes.length || currentIndex === targetIndex) return scenes;
  const nextScenes = [...scenes];
  const [scene] = nextScenes.splice(currentIndex, 1);
  nextScenes.splice(targetIndex, 0, scene);
  return nextScenes;
}

export function createScene(details: SceneDetails): SceneModule {
  return { ...details, id: `scene_${createId()}` };
}
