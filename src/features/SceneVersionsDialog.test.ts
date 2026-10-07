import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SceneVersionsDialog from "./SceneVersionsDialog";
import { parseScenePackage } from "../lib/sceneTransfer";
import { createSceneVersion } from "../lib/sceneVersions";

test("发布版本标题取各自场景快照，不用流程名或最新草稿标题冒充历史名称", async () => {
  const pkg = parseScenePackage(JSON.parse(await readFile("examples/scenes/reference-to-video-repaired.json", "utf8")));
  const oldVersion = createSceneVersion({ ...pkg.scene, title: "历史参考场景" }, pkg.workflow, []);
  const currentVersion = createSceneVersion(pkg.scene, pkg.workflow, []);
  const record = { publishedVersionId: currentVersion.id, versions: [oldVersion, currentVersion] };
  const before = structuredClone(record);
  const html = renderToStaticMarkup(createElement(SceneVersionsDialog, {
    sceneTitle: "尚未发布的新草稿标题", record, onClose() {},
    onApply() { throw new Error("version rendering must not apply or publish"); },
  }));
  assert.match(html, /尚未发布的新草稿标题 · 发布版本/);
  assert.match(html, new RegExp(`<strong>v${oldVersion.version} · 历史参考场景<\\/strong>`));
  assert.match(html, new RegExp(`<strong>v${currentVersion.version} · AI参考生视频<\\/strong>`));
  assert.doesNotMatch(html, /AI文生视频流程/);
  assert.deepEqual(record, before, "读取版本列表不能重写固定快照");
});
