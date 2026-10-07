import { createId } from "./ids";
import type { SceneDetails, SceneId, SceneModule } from "../types";

// Pure draft transformations. Scene persistence belongs exclusively to WorkspaceService.
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
