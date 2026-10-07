import { readFile } from "node:fs/promises";
import { workbenchFetch } from "./workbench-auth.mjs";
const base = (process.argv[2] ?? "http://127.0.0.1:8799").replace(/\/+$/, "");
const pkg = JSON.parse(await readFile(new URL("../examples/scenes/commerce-ai.json", import.meta.url), "utf8"));
const read = route => workbenchFetch(base + route, { signal: AbortSignal.timeout(10000) });
const status = await read("/api/workspace/status");
if (!status.ok) throw new Error("无法读取工作区状态：HTTP " + status.status);
if (!(await status.json()).initialized) throw new Error("请先显式建立空工作区；本脚本不初始化或导入浏览器缓存");
const route = "/api/v1/scenes/" + encodeURIComponent(pkg.scene.id) + "/draft";
const existing = await read(route);
if (existing.ok) { console.log("AI电商套图场景已存在；未覆盖草稿、发布版本或历史运行。请读取当前revision后显式编辑。"); process.exit(0); }
if (existing.status !== 404) throw new Error("无法核对场景：HTTP " + existing.status);
let response;
try { response = await workbenchFetch(base + "/api/v1/scenes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene: pkg.scene, workflow: pkg.workflow, optionPresets: pkg.optionPresets }), signal: AbortSignal.timeout(10000) }); }
catch (error) { throw new Error("创建回执未取得；请按原sceneId=" + pkg.scene.id + "读取草稿对账，不自动重建或发布。" + error.message); }
if (!response.ok) throw new Error("创建失败；请按原sceneId核对，不覆盖已有内容：HTTP " + response.status + " " + await response.text());
const draft = await response.json();
console.log("已创建未发布草稿「" + pkg.scene.title + "」，sceneId=" + pkg.scene.id + " revision=" + draft.revision + "。请核对writer/aixg、ComfyUI工作流/节点，校验后显式发布。没有生成媒体或改写旧发布版。");
