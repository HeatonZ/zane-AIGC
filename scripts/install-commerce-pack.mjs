import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseScenePackage } from "../src/lib/sceneTransfer.ts";
import { createSceneVersion } from "../src/lib/sceneVersions.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = (process.argv[2] ?? "http://127.0.0.1:8799").replace(/\/+$/, "");
const pkg = parseScenePackage(JSON.parse(await readFile(path.join(root, "examples", "scenes", "commerce-pack.json"), "utf8")));
async function json(route, options = {}) {
  const response = await fetch(baseUrl + route, { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}
const original = (await json("/api/workspace")).workspace;
if (!original) throw new Error("请先初始化工作区；安装脚本不会覆盖或初始化已有设备配置");
if (original.scenes.some((scene) => scene.id === pkg.scene.id)) {
  console.log("电商套图已存在，未覆盖场景、工作流或发布版本。\n如需升级，请使用现有场景导入/版本管理。");
} else {
  const adapterCheck = await fetch(baseUrl + "/api/v1/runs/adapter-check/commerce-pack.zip", { signal: AbortSignal.timeout(10000) });
  if (adapterCheck.status !== 400) throw new Error("当前服务尚未加载电商套图适配器。请先构建并重启服务，再安装场景；现有工作区未修改。");
  const settings = await json("/api/settings");
  const enabled = settings.enabledHermesProfiles ?? [];
  const profile = enabled.includes("writer") ? "writer" : enabled[0] ?? "writer";
  pkg.workflow.steps.forEach((step) => { if (step.kind === "hermes") step.hermesProfile = profile; });
  const published = createSceneVersion(pkg.scene, pkg.workflow, pkg.optionPresets);
  const desired = { ...original, scenes: [...original.scenes, pkg.scene], workflows: { ...original.workflows, [pkg.scene.id]: pkg.workflow }, sceneVersions: { ...original.sceneVersions, [pkg.scene.id]: { publishedVersionId: published.id, versions: [published] } } };
  const backupDirectory = process.env.ZANE_COMMERCE_BACKUP_DIRECTORY ? path.resolve(process.env.ZANE_COMMERCE_BACKUP_DIRECTORY) : path.join(root, "backups", "commerce-pack");
  await mkdir(backupDirectory, { recursive: true });
  const backup = path.join(backupDirectory, `workspace-before-${Date.now()}.json`);
  await writeFile(backup, JSON.stringify(original, null, 2));
  const result = await json("/api/workspace/merge", { method: "POST", body: JSON.stringify({ base: original, workspace: desired }) });
  const workspace = result.workspace;
  if (!workspace.scenes.some((scene) => scene.id === pkg.scene.id)) throw new Error("服务未确认新场景，原工作区备份已保留");
  console.log(`已添加并发布独立场景「${pkg.scene.title}」(${published.version})。\nHermes Profile: ${profile}\n原有${original.scenes.length}个场景、草稿和工作流保持不变。\n备份：${backup}\n刷新工作台后即可使用。`);
}
