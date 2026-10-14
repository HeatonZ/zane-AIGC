import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { HttpError } from "../errors.js";
import { log } from "../observability/logger.js";
import { isRunId, runArtifactPaths } from "../artifacts/runArtifacts.js";
import {
  MAX_LOCAL_EXPORT_FILE_BYTES, MAX_LOCAL_EXPORT_TOTAL_BYTES,
  readLocalExportPlan, resolveLocalExportTarget,
  type LocalExportConflictPolicy,
} from "../domain/localExport.js";
import type { RuntimeMediaItem } from "../runtimeValue.js";

/** 本地导出的宿主侧执行器。
 *
 *  授权模型：沙箱用户代码只能给出 {source, target} 计划，既看不到真实路径也拿不到写权限；
 *  实际写入发生在这里，并且只允许写入管理员配置的根目录内部。
 *  安全不变量（每条都有对应失败）：
 *   1) 未配置根目录 → LOCAL_EXPORT_DISABLED，不写任何文件；
 *   2) target 归一化后必须位于根目录内 → 否则 LOCAL_EXPORT_OUTSIDE_ROOT（.. 逃逸被拒绝而非中和）；
 *   3) source 必须是本步骤输入里真实存在的媒体文件名 → 否则 INVALID_CODE_OUTPUT；
 *   4) 目标路径上任何已存在的父级都不能是符号链接，写入后再次用真实路径确认包含性；
 *   5) 大小受限（单文件/总量）且写入走临时文件 + 原子改名，失败不留半截文件。 */

export interface LocalExportRequest {
  /** 已解析的导出计划值（来自用户代码返回的输出端口）。 */
  plan: unknown;
  /** 本步骤输入里可见的媒体，键为沙箱可见的 filename。 */
  media: Map<string, RuntimeMediaItem>;
  /** 管理员配置的根目录；空串表示特性关闭。 */
  root: string;
  onConflict: LocalExportConflictPolicy;
  projectDirectory: string;
  runId: string;
  /** 本运行及其授权祖先运行（含自身）；复用/续跑步骤的归档媒体在这些运行里。 */
  allowedRunIds?: readonly string[];
  /** ComfyUI 地址：仅用于「下游步骤消费的、尚未归档的 ComfyUI 输出」这一种情况。 */
  comfyuiBaseUrl?: string;
  signal?: AbortSignal;
}
export interface LocalExportItemResult {
  source: string;
  target: string;
  bytes: number;
  sha256: string;
  status: "written" | "skipped";
}
export interface LocalExportResult {
  format: "zane-local-export-result/v1";
  root: string;
  written: number;
  skipped: number;
  items: LocalExportItemResult[];
}

function fail(message: string, code = "LOCAL_EXPORT_FAILED"): never { throw new HttpError(400, message, code); }

/** 目标路径上已存在的最近祖先目录：用于符号链接校验，不能直接 realpath 目标本身（可能尚不存在）。 */
async function assertNoSymlinkAncestor(root: string, target: string) {
  const relative = path.relative(root, path.dirname(target));
  let current = root;
  const parts = relative ? relative.split(path.sep) : [];
  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try { info = await stat(current); } catch { continue; } // 尚不存在的层级由 mkdir 创建
    if (!info.isDirectory()) fail("导出目标的上级路径不是目录：" + current);
    let real;
    try { real = await realpath(current); } catch { continue; }
    // 已存在的目录若解析到根目录之外，说明中间有符号链接/联接点被用来逃逸。
    const fromRoot = path.relative(root, real);
    if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) fail("导出目标的上级目录经符号链接指向根目录之外：" + current, "LOCAL_EXPORT_OUTSIDE_ROOT");
  }
}

function insideOrEqual(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** 归档媒体的真实落点：输出媒体在 outputs/media，输入素材在 inputs/files。
 *  取多个候选名是因为归档后的显示名与原文件名可能不同（归档会重命名）。
 *  复用/续跑步骤的媒体来自祖先运行，媒体 URL 里自带来源 runId；
 *  该来源必须在本运行的授权血缘链上，否则绝不按 URL 里的任意 runId 读盘。 */
const ARCHIVED_MEDIA_URL = /^\/api\/(?:v1|workflows)\/runs\/([a-f0-9-]{36})\/media\/([^/?]+)$/i;

function archivedMediaCandidates(item: RuntimeMediaItem, projectDirectory: string, runId: string, allowedRunIds: readonly string[]) {
  const locator = item.locator;
  // 复用/续跑步骤会把归档引用降级成 path 定位符，但 value 仍是本工作台媒体 URL；
  // 因此两种定位符都要尝试解析 URL，而不是只看 locator.type。
  const direct = locator.type === "path" || locator.type === "url" ? locator.value : undefined;
  const candidates: string[] = [];
  // 只有真正的文件系统路径才按原值读取；URL 形式一律交给归档目录推导。
  if (locator.type === "path" && direct && !ARCHIVED_MEDIA_URL.test(direct.trim())) candidates.push(path.resolve(direct));
  const names = [typeof item.filename === "string" ? item.filename : "", direct ? path.basename(direct) : "", locator.type === "comfy" ? locator.filename : ""]
    .map((name) => (name ?? "").trim())
    .filter((name) => name && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\"));
  const match = direct ? ARCHIVED_MEDIA_URL.exec(direct.trim()) : null;
  // URL 命中且来源在血缘链上时，先找来源运行归档，再退回本运行（归档可能在任一侧）；
  // 来源不在血缘链上时只读本运行，绝不按 URL 里的 runId 去读别的运行。
  const owners = match && allowedRunIds.includes(match[1])
    ? (match[1] === runId ? [runId] : [match[1], runId])
    : [runId];
  for (const owner of owners) {
    const directory = runArtifactPaths(projectDirectory, owner).directory;
    for (const name of names) candidates.push(path.join(directory, "outputs", "media", name), path.join(directory, "inputs", "files", name));
  }
  return candidates;
}

/** 只允许读取「本运行或其授权祖先运行」归档目录内的常规文件；越界候选跳过而不是报错，避免把探测细节当结果。 */
async function locateArchivedMedia(item: RuntimeMediaItem, projectDirectory: string, runId: string, allowedRunIds: readonly string[]) {
  const roots = (allowedRunIds.length ? allowedRunIds : [runId]).map((owner) => path.resolve(runArtifactPaths(projectDirectory, owner).directory));
  const normalize = (name: string) => (process.platform === "win32" ? name.toLowerCase() : name);
  for (const candidate of archivedMediaCandidates(item, projectDirectory, runId, allowedRunIds)) {
    const resolved = path.resolve(candidate);
    if (!roots.some((root) => insideOrEqual(root, resolved))) continue;
    const info = await stat(resolved).catch(() => undefined);
    if (!info?.isFile() || !info.size) continue;
    // 归档文件不得是符号链接，且真实路径必须仍等于该文件本身（防止经链接读到归档之外）。
    const real = await realpath(resolved).catch(() => "");
    if (!real || normalize(real) !== normalize(resolved)) continue;
    return resolved;
  }
  return undefined;
}

/** 从运行归档里读出媒体字节：只接受本运行或授权祖先运行归档目录内的文件。 */
async function readArchivedBytes(item: RuntimeMediaItem, projectDirectory: string, runId: string, allowedRunIds: readonly string[], signal?: AbortSignal) {
  const resolved = await locateArchivedMedia(item, projectDirectory, runId, allowedRunIds);
  const label = typeof item.filename === "string" && item.filename ? item.filename : item.id;
  if (!resolved) fail("媒体 " + label + " 在本运行及其来源运行的归档里没有可读取的本地文件（远程 URL 或未归档的 ComfyUI 输出不能导出），或归档媒体已丢失", "INVALID_CODE_OUTPUT");
  const info = await stat(resolved);
  if (info.size > MAX_LOCAL_EXPORT_FILE_BYTES) fail("媒体文件超过 " + MAX_LOCAL_EXPORT_FILE_BYTES / 1024 / 1024 + " MB 上限：" + label, "LOCAL_EXPORT_TOO_LARGE");
  return readFile(resolved, { signal });
}

/** 未归档的 ComfyUI 输出：下游步骤在当前运行内拿到的是 {filename,subfolder,type} 原始形状，
 *  归档（改名 + 落盘）要到整个流程执行完才发生，因此这些文件此刻不在归档目录里。
 *  这是 ComfyUI 自己刚生成的产物，取回它的唯一来源就是本机 ComfyUI 的 /view 接口，
 *  所以这里按配置的 comfyuiBaseUrl 拉取一次；除该地址外不接受任何 URL。
 *  文件名/子目录必须是普通段（拒绝 .. 与路径分隔符），避免把请求指向 ComfyUI 目录之外。 */
function comfyTargetParts(item: RuntimeMediaItem) {
  const locator = item.locator;
  if (locator.type === "comfy") {
    const filename = locator.filename.trim();
    const subfolder = locator.subfolder.trim();
    const location = locator.location;
    if (!filename || /[\\/\0]/.test(filename) || filename === "." || filename === "..") return undefined;
    if (subfolder && (/[\\/\0]/.test(subfolder) || subfolder.split(/[\\/]/).some((part) => part === ".."))) return undefined;
    return { filename, subfolder, type: location };
  }
  // 兼容 URL 形状：只认本工作台的 ComfyUI 预览地址，不接受外部 URL。
  const direct = locator.type === "url" || locator.type === "path" ? locator.value : "";
  const match = /^\/api\/comfyui\/view\?(.+)$/i.exec(direct.trim());
  if (!match) return undefined;
  const query = new URLSearchParams(match[1]);
  const filename = (query.get("filename") ?? "").trim();
  if (!filename || /[\\/\0]/.test(filename) || filename === "." || filename === "..") return undefined;
  const subfolder = (query.get("subfolder") ?? "").trim();
  if (subfolder && (/[\\/\0]/.test(subfolder) || subfolder.split(/[\\/]/).some((part) => part === ".."))) return undefined;
  const type = query.get("type") === "input" ? "input" : "output";
  return { filename, subfolder, type };
}

async function readUnarchivedComfyBytes(item: RuntimeMediaItem, comfyuiBaseUrl: string, signal?: AbortSignal) {
  const parts = comfyTargetParts(item);
  const label = typeof item.filename === "string" && item.filename ? item.filename : item.id;
  if (!parts) fail("媒体 " + label + " 不是可读取的 ComfyUI 输出（缺少合法的 filename/subfolder/type）", "INVALID_CODE_OUTPUT");
  const base = comfyuiBaseUrl.replace(/\/+$/, "");
  if (!base) fail("未配置 ComfyUI 地址，无法读取尚未归档的 ComfyUI 输出：" + label, "INVALID_CODE_OUTPUT");
  const query = new URLSearchParams({ filename: parts.filename, subfolder: parts.subfolder, type: parts.type });
  let response: Response;
  try {
    response = await fetch(base + "/view?" + query, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
  } catch (error) {
    fail("读取未归档的 ComfyUI 输出失败：" + label + "（" + (error instanceof Error ? error.message : String(error)) + "）", "INVALID_CODE_OUTPUT");
  }
  if (!response.ok) fail("读取未归档的 ComfyUI 输出失败：" + label + "（ComfyUI 返回 " + response.status + "）", "INVALID_CODE_OUTPUT");
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_LOCAL_EXPORT_FILE_BYTES) fail("媒体文件超过 " + MAX_LOCAL_EXPORT_FILE_BYTES / 1024 / 1024 + " MB 上限：" + label, "LOCAL_EXPORT_TOO_LARGE");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) fail("读取未归档的 ComfyUI 输出失败：" + label + "（内容为空）", "INVALID_CODE_OUTPUT");
  if (bytes.length > MAX_LOCAL_EXPORT_FILE_BYTES) fail("媒体文件超过 " + MAX_LOCAL_EXPORT_FILE_BYTES / 1024 / 1024 + " MB 上限：" + label, "LOCAL_EXPORT_TOO_LARGE");
  return bytes;
}

/** 媒体字节来源：优先本运行/祖先运行的归档；归档里没有时退回本机 ComfyUI 的未归档输出。
 *  只有确实是指向本机 ComfyUI 的产物才走回退，其它媒体保留原本的错误信息。 */
async function readMediaBytes(item: RuntimeMediaItem, request: LocalExportRequest, allowedRunIds: readonly string[]) {
  try {
    return await readArchivedBytes(item, request.projectDirectory, request.runId, allowedRunIds, request.signal);
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== "INVALID_CODE_OUTPUT") throw error;
    if (!request.comfyuiBaseUrl || !comfyTargetParts(item)) throw error;
    return readUnarchivedComfyBytes(item, request.comfyuiBaseUrl, request.signal);
  }
}

/** 写入单个目标：目录按需创建，先写临时文件再原子改名，避免半截文件被当成成品。 */
async function writeTarget(target: string, bytes: Buffer) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = target + "." + createHash("sha256").update(String(process.hrtime.bigint())).digest("hex").slice(0, 12) + ".tmp";
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function executeLocalExport(request: LocalExportRequest): Promise<LocalExportResult> {
  const { root, media, onConflict, runId, signal } = request;
  if (!root) fail("尚未配置本地导出根目录，本地导出不可用；请管理员先配置 local-export 设置", "LOCAL_EXPORT_DISABLED");
  if (!isRunId(runId)) fail("运行 ID 无效，无法定位归档媒体");
  // 血缘链由宿主计算后传入，用户代码无法扩大可读范围；缺省时退化为只读本运行。
  const allowedRunIds = (request.allowedRunIds ?? [runId]).filter((candidate) => isRunId(candidate));
  if (!allowedRunIds.includes(runId)) allowedRunIds.push(runId);
  const plan = readLocalExportPlan(request.plan);
  // 先解析全部目标并完成校验，再开始写盘：一项非法就整步失败，不产生"写了一半"的结果。
  const resolved = plan.items.map((item) => {
    const found = media.get(item.source);
    if (!found) fail("导出计划引用了本步骤输入中不存在的媒体 " + item.source + "；只能导出声明输入端口里的媒体", "INVALID_CODE_OUTPUT");
    return { item, media: found, target: resolveLocalExportTarget(root, item.target) };
  });
  const resolvedRoot = await realpath(root).catch(() => path.resolve(root));
  const items: LocalExportItemResult[] = [];
  let total = 0;
  for (const { item, media: found, target } of resolved) {
    if (signal?.aborted) throw signal.reason ?? new Error("已取消");
    // 目标已存在时按策略处理：默认覆盖（重跑得到最新结果），skip 保留既有文件，fail 直接报错。
    if (onConflict !== "overwrite") {
      const existing = await stat(target).catch(() => undefined);
      if (existing?.isFile()) {
        if (onConflict === "fail") fail("导出目标已存在：" + target + "（onConflict=fail）");
        items.push({ source: item.source, target, bytes: existing.size, sha256: "", status: "skipped" });
        continue;
      }
    }
    const bytes = await readMediaBytes(found, request, allowedRunIds);
    total += bytes.length;
    if (total > MAX_LOCAL_EXPORT_TOTAL_BYTES) fail("本次导出总量超过 " + MAX_LOCAL_EXPORT_TOTAL_BYTES / 1024 / 1024 + " MB 上限", "LOCAL_EXPORT_TOO_LARGE");
    await assertNoSymlinkAncestor(resolvedRoot, target);
    await writeTarget(target, bytes);
    items.push({ source: item.source, target, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), status: "written" });
  }
  const written = items.filter((item) => item.status === "written").length;
  log("info", "local.export", { runId, written, skipped: items.length - written });
  return { format: "zane-local-export-result/v1", root: resolvedRoot, written, skipped: items.length - written, items };
}
