import { defaultScenes } from "../data/scenes";
import type { SceneDetails, SceneModule } from "../types";

const storageKey = "zane-studio:scenes:v1";

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
    if (saved === null) return structuredClone(defaultScenes);
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return structuredClone(defaultScenes);
    const seen = new Set<string>();
    return parsed.map(normalizeScene).filter((scene): scene is SceneModule => {
      if (!scene || seen.has(scene.id)) return false;
      seen.add(scene.id);
      return true;
    });
  } catch {
    return structuredClone(defaultScenes);
  }
}

export function writeScenes(scenes: SceneModule[]) {
  window.localStorage.setItem(storageKey, JSON.stringify(scenes));
}

export function createScene(details: SceneDetails): SceneModule {
  return { ...details, id: `scene_${crypto.randomUUID()}` };
}
