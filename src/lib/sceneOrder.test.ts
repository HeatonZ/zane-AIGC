import assert from "node:assert/strict";
import test from "node:test";
import { moveScene, readScenes, writeScenes } from "./sceneStorage";
import type { SceneModule } from "../types";

const scenes: SceneModule[] = ["one", "two", "three", "four"].map((id) => ({
  id,
  title: id,
  shortTitle: id,
  summary: "场景摘要",
  description: "场景描述",
  cover: "",
  coverPosition: "center",
  accent: "green",
  stages: ["输入", "输出"],
}));
const ids = (values: SceneModule[]) => values.map((scene) => scene.id);

test("场景上移、下移、置顶、置底只调整顺序，不修改场景内容", () => {
  assert.deepEqual(ids(moveScene(scenes, "three", 1)), ["one", "three", "two", "four"]);
  assert.deepEqual(ids(moveScene(scenes, "two", 2)), ["one", "three", "two", "four"]);
  assert.deepEqual(ids(moveScene(scenes, "four", 0)), ["four", "one", "two", "three"]);
  const moved = moveScene(scenes, "one", scenes.length - 1);
  assert.deepEqual(ids(moved), ["two", "three", "four", "one"]);
  assert.deepEqual(ids(scenes), ["one", "two", "three", "four"]);
  for (const scene of scenes) assert.equal(moved.find((item) => item.id === scene.id), scene);
});

test("无效场景、越界索引和原位置不触发排序或丢失场景", () => {
  assert.equal(moveScene(scenes, "missing", 0), scenes);
  for (const index of [-1, scenes.length, 1.5, NaN]) assert.equal(moveScene(scenes, "one", index), scenes);
  assert.equal(moveScene(scenes, "one", 0), scenes);
  const empty: SceneModule[] = [];
  assert.equal(moveScene(empty, "one", 0), empty);
  assert.equal(moveScene([scenes[0]], "one", 0)[0], scenes[0]);
});

test("场景排序写入本地副本后重新读取仍保留顺序", (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const saved = new Map<string, string>([["zane-studio:scenes:image-to-image-v2", "done"]]);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } } },
  });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const moved = moveScene(scenes, "one", scenes.length - 1);
  writeScenes(moved);
  assert.deepEqual(readScenes(), moved);
});
