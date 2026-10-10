import { workbenchFetch } from "./workbench-auth.mjs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseScenePackage } from "../src/lib/sceneTransfer.ts";
import { createSceneVersion } from "../src/lib/sceneVersions.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = (process.argv[2] ?? "http://127.0.0.1:8799").replace(/\/+$/, "");
const pkg = parseScenePackage(JSON.parse(await readFile(path.join(root, "examples", "scenes", "long-text-to-video.json"), "utf8")));
async function json(route, options = {}) {
  const response = await workbenchFetch(baseUrl + route, { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}
const original = (await json("/api/workspace")).workspace;
if (!original) throw new Error("请先初始化工作区；本脚本不会覆盖或初始化已有设备配置");
if (original.scenes.some((scene) => scene.id === pkg.scene.id)) {
  console.log("长文出视频已存在，未覆盖场景、工作流或发布版本。\n如需升级，请使用现有场景导入和版本管理。");
} else {
  if (original.scenes.some((scene) => scene.title === pkg.scene.title)) throw new Error("工作区已有同名场景，请通过版本管理更新；没有覆盖已有内容");
  const health = await json("/api/health");
  if (!["long_text_video"].every((adapter) => health.adapters?.includes(adapter))) throw new Error("当前服务尚未加载长文出视频适配器，请先构建并重启服务；工作区未修改");
  const settings = await json("/api/settings");
  if (!["writer", "aixg"].every(profile => (settings.enabledHermesProfiles ?? []).includes(profile))) throw new Error("请先启用并配置 Writer 和 AIXG Profile；本场景不静默改用其他 Profile");
  const published = createSceneVersion(pkg.scene, pkg.workflow, pkg.optionPresets);
  const desired = { ...original, scenes: [...original.scenes, pkg.scene], workflows: { ...original.workflows, [pkg.scene.id]: pkg.workflow }, sceneVersions: { ...original.sceneVersions, [pkg.scene.id]: { publishedVersionId: published.id, versions: [published] } } };
  const backupDirectory = process.env.ZANE_LONG_VIDEO_BACKUP_DIRECTORY ? path.resolve(process.env.ZANE_LONG_VIDEO_BACKUP_DIRECTORY) : path.join(root, "backups", "long-text-video");
  await mkdir(backupDirectory, { recursive: true });
  const backup = path.join(backupDirectory, `workspace-before-${Date.now()}.json`);
  await writeFile(backup, JSON.stringify(original, null, 2));
  const result = await json("/api/workspace/merge", { method: "POST", body: JSON.stringify({ base: original, workspace: desired }) });
  const workspace = result.workspace;
  if (workspace.sceneVersions?.[pkg.scene.id]?.publishedVersionId !== published.id || !workspace.workflows?.[pkg.scene.id]) throw new Error("服务未确认新场景发布，原工作区备份已保留");
  console.log(`已添加并发布独立场景「${pkg.scene.title}」(${published.version})。\n原有${original.scenes.length}个场景、草稿和工作流保持不变。\n备份：${backup}\n刷新工作台后即可使用。`);
}
