import path from "node:path";
import * as z from "zod/v4";
import { HttpError } from "../errors.js";

/** 本地媒体导出：core.code 计算「哪个媒体写到哪个路径」，宿主在受控根目录内落盘。
 *
 *  沙箱本身始终不能访问文件系统（见 codeSandboxWorker 的逃逸防护）：用户代码只返回一个
 *  计划，真正的写入由服务端在配置好的根目录白名单内完成，并对每个目标做包含性与符号链接校验。
 *  这样「代码决定目录与文件名」的诉求成立，同时授权边界由管理员配置、不随用户代码放宽。 */

export const MAX_LOCAL_EXPORT_FILES = 144;
export const MAX_LOCAL_EXPORT_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_LOCAL_EXPORT_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_LOCAL_EXPORT_TARGET_LENGTH = 1024;
export const LOCAL_EXPORT_CONFLICT_POLICIES = ["overwrite", "skip", "fail"] as const;
export type LocalExportConflictPolicy = (typeof LOCAL_EXPORT_CONFLICT_POLICIES)[number];

/** Machine contract for the local export feature; mirrored into the AI OpenAPI as x-local-export. */
export const LOCAL_EXPORT_CONTRACT = {
  version: "1",
  scope: "core.code 步骤的可选本地导出",
  config: {
    enabled: "boolean; 省略或 false 时不写任何文件",
    planKey: "本步骤已声明的 json/text 输出端口名，其值即导出计划",
    onConflict: "overwrite|skip|fail；目标已存在时的行为，默认 overwrite（重跑同一场景得到最新结果）",
  },
  plan: {
    format: "zane-local-export-plan/v1（可选，仅作标记，不参与校验）",
    items: "数组，最多 " + MAX_LOCAL_EXPORT_FILES + " 项；每项 {source, target}",
    source: "本步骤声明输入端口里的媒体文件名（不含路径分隔符）；沙箱只能看到 filename，看不到路径/URL/字节",
    target: "目标文件路径；绝对路径或以根目录为基准的相对路径，必须落在配置根目录之内",
  },
  root: {
    setting: "系统单例设置 local-export（管理员经 HTTP/MCP 配置）；未配置时整个特性不生效",
    containment: "对根目录与目标都取真实路径后比较，越界即 LOCAL_EXPORT_OUTSIDE_ROOT，不接受 .. 逃逸",
    symlinks: "目标路径上已存在的任何一段是符号链接即拒绝，避免写到根目录之外",
  },
  limits: {
    files: MAX_LOCAL_EXPORT_FILES,
    fileBytes: MAX_LOCAL_EXPORT_FILE_BYTES,
    totalBytes: MAX_LOCAL_EXPORT_TOTAL_BYTES,
    extensionPattern: "^\\.[a-z0-9]{1,8}$",
  },
  sideEffects: {
    prepare: "none",
    publish: "none",
    execute: "仅在运行实际执行该步骤时向本机受控目录写入媒体副本；不调用模型、不计费、不改写归档媒体",
    idempotency: "按 onConflict 决定覆盖或跳过；写入使用临时文件加原子改名，失败不会留下半截文件",
  },
  errors: ["INVALID_CODE_CONFIG", "INVALID_CODE_OUTPUT", "LOCAL_EXPORT_DISABLED", "LOCAL_EXPORT_OUTSIDE_ROOT", "LOCAL_EXPORT_FAILED", "LOCAL_EXPORT_TOO_LARGE"],
} as const;

/** 声明为函数声明（而非 const 箭头函数），TypeScript 才会把它当作 never 返回并做控制流收窄。 */
function invalid(message: string, code = "INVALID_CODE_OUTPUT"): never { throw new HttpError(400, message, code); }

/** 根目录为空表示特性关闭；其余必须是绝对路径，且不能是盘符根（避免把整块盘暴露为可写）。 */
export function normalizeLocalExportRoot(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") invalid("导出根目录必须是字符串", "INVALID_LOCAL_EXPORT_REQUEST");
  const text = value.trim();
  if (!text) return "";
  if (text.length > 512) invalid("导出根目录过长", "INVALID_LOCAL_EXPORT_REQUEST");
  if (/[\0\r\n]/.test(text)) invalid("导出根目录不能包含控制字符", "INVALID_LOCAL_EXPORT_REQUEST");
  if (!path.isAbsolute(text)) invalid("导出根目录必须是绝对路径，例如 E:\\AI-outsourcing\\二次元抱枕", "INVALID_LOCAL_EXPORT_REQUEST");
  const parsed = path.parse(path.resolve(text));
  if (path.resolve(text) === parsed.root) invalid("导出根目录不能是盘符根目录，请指定一个具体子目录", "INVALID_LOCAL_EXPORT_REQUEST");
  return path.resolve(text);
}

/** 目标必须落在根目录内部；先归一化再比较，因此 .. 逃逸会被拒绝而不是被中和。 */
export function resolveLocalExportTarget(root: string, target: string): string {
  if (!root) invalid("尚未配置本地导出根目录，本地导出不可用", "LOCAL_EXPORT_DISABLED");
  if (typeof target !== "string") invalid("导出计划的 target 必须是字符串");
  const text = target.trim();
  if (!text) invalid("导出计划的 target 不能为空");
  if (text.length > MAX_LOCAL_EXPORT_TARGET_LENGTH) invalid("导出计划的 target 过长");
  if (/[\0\r\n]/.test(text)) invalid("导出计划的 target 不能包含控制字符");
  if (!/^\.[a-z0-9]{1,8}$/.test(path.extname(text).toLowerCase())) invalid("导出目标必须以受支持的媒体扩展名结尾（如 .png/.jpg/.mp4）");
  const resolvedRoot = path.resolve(root);
  const resolved = path.isAbsolute(text) ? path.resolve(text) : path.resolve(resolvedRoot, text);
  const relative = path.relative(resolvedRoot, resolved);
  // relative 为空表示目标就是根目录本身（目录不是文件）；以 .. 开头或仍是绝对路径表示越界。
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    invalid("导出目标必须位于配置的根目录内部：" + text, "LOCAL_EXPORT_OUTSIDE_ROOT");
  }
  return resolved;
}

export interface LocalExportPlanItem { source: string; target: string }
export interface LocalExportPlan { items: LocalExportPlanItem[] }

/** 计划来自用户代码，属于不可信输入：逐项校验数量、形状与重复目标。 */
export function readLocalExportPlan(value: unknown): LocalExportPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("本地导出计划必须是对象，形如 { items: [{ source, target }] }");
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) invalid("本地导出计划必须包含 items 数组");
  if (!items.length) invalid("本地导出计划的 items 不能为空");
  if (items.length > MAX_LOCAL_EXPORT_FILES) invalid("本地导出计划最多 " + MAX_LOCAL_EXPORT_FILES + " 项，实际 " + items.length);
  const seen = new Set<string>();
  const parsed: LocalExportPlanItem[] = [];
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("导出计划第 " + (index + 1) + " 项必须是 { source, target } 对象");
    const record = item as { source?: unknown; target?: unknown };
    const source = typeof record.source === "string" ? record.source.trim() : "";
    if (!source) invalid("导出计划第 " + (index + 1) + " 项缺少 source 文件名");
    if (/[\\/\0]/.test(source) || source === "." || source === "..") invalid("导出计划第 " + (index + 1) + " 项的 source 必须是媒体文件名，不能包含路径分隔符");
    const target = typeof record.target === "string" ? record.target.trim() : "";
    if (!target) invalid("导出计划第 " + (index + 1) + " 项缺少 target 路径");
    const key = process.platform === "win32" ? target.toLowerCase() : target;
    if (seen.has(key)) invalid("导出计划里出现重复目标：" + target);
    seen.add(key);
    parsed.push({ source, target });
  }
  return { items: parsed };
}

export interface LocalExportConfig { enabled: boolean; planKey?: string; onConflict: LocalExportConflictPolicy }
export interface LocalExportConfigInput { enabled?: unknown; planKey?: unknown; onConflict?: unknown }

/** 解析 core.code 的 localExport 配置块。默认关闭；开启时校验字段与取值，不猜。 */
export function parseLocalExportConfig(config: unknown): LocalExportConfig {
  const record = config && typeof config === "object" && !Array.isArray(config) ? config as Record<string, unknown> : undefined;
  const raw = record?.localExport;
  if (raw === undefined) return { enabled: false, onConflict: "overwrite" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("localExport 必须是一个对象，形如 { enabled: true, planKey: \"export_plan\" }", "INVALID_CODE_CONFIG");
  const value = raw as LocalExportConfigInput;
  const extra = Object.keys(raw).filter((key) => !["enabled", "planKey", "onConflict"].includes(key));
  if (extra.length) invalid("localExport 不支持的字段：" + extra.join("、"), "INVALID_CODE_CONFIG");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") invalid("localExport.enabled 必须是布尔值", "INVALID_CODE_CONFIG");
  if (value.enabled !== true) return { enabled: false, onConflict: "overwrite" };
  if (value.planKey !== undefined && (typeof value.planKey !== "string" || !value.planKey.trim())) invalid("localExport.planKey 必须是非空输出端口名", "INVALID_CODE_CONFIG");
  const onConflict = value.onConflict === undefined ? "overwrite" : value.onConflict;
  if (typeof onConflict !== "string" || !(LOCAL_EXPORT_CONFLICT_POLICIES as readonly string[]).includes(onConflict)) {
    invalid("localExport.onConflict 只能是 " + LOCAL_EXPORT_CONFLICT_POLICIES.join("/"), "INVALID_CODE_CONFIG");
  }
  return { enabled: true, planKey: typeof value.planKey === "string" ? value.planKey.trim() : undefined, onConflict: onConflict as LocalExportConflictPolicy };
}

/** 导出计划可以放在任何已声明的 json/text 输出端口上；找出唯一候选，歧义时报错而不是猜。 */
export function pickExportPlanSource(step: { outputs?: Array<{ key: string; type: string }> }, planKey: unknown): string {
  const outputs = step.outputs ?? [];
  if (planKey !== undefined) {
    if (typeof planKey !== "string" || !planKey.trim()) invalid("localExport.planKey 必须是输出端口名", "INVALID_CODE_CONFIG");
    const key = planKey.trim();
    const output = outputs.find((item) => item.key === key);
    if (!output) invalid("localExport.planKey 指向的输出端口不存在：" + key, "INVALID_CODE_CONFIG");
    if (output.type !== "json" && output.type !== "text") invalid("localExport.planKey 只能指向 json 或 text 输出端口：" + key, "INVALID_CODE_CONFIG");
    return key;
  }
  const candidates = outputs.filter((output) => output.type === "json");
  if (candidates.length !== 1) invalid("启用本地导出时必须用 localExport.planKey 指定承载导出计划的 json 输出端口（当前有 " + candidates.length + " 个候选）", "INVALID_CODE_CONFIG");
  return candidates[0]!.key;
}

export const localExportConflictPolicy = z.enum(LOCAL_EXPORT_CONFLICT_POLICIES);export const localExportQuery = z.object({}).strict();
export const updateLocalExportRoot = z.object({
  revision: z.int().nonnegative().describe("读取配置的当前 revision，未保存时为 0；409 或响应丢失后先重新读取，不自动重放"),
  root: z.string().max(512).describe("允许本地导出写入的根目录绝对路径；空串表示关闭本地导出。不能是盘符根目录"),
}).strict();
export const localExportSettingsSchema = z.object({
  format: z.literal("zane-studio.local-export/v1"),
  id: z.literal("local-export"),
  revision: z.int().nonnegative(),
  root: z.string(),
  source: z.enum(["environment", "saved", "unset"]),
  configured: z.boolean(),
  enabled: z.boolean(),
  scope: z.literal("system"),
  appliesTo: z.literal("core.code.localExport"),
  conflictPolicies: z.array(localExportConflictPolicy),
  limits: z.object({
    files: z.int().positive(),
    fileBytes: z.int().positive(),
    totalBytes: z.int().positive(),
  }).strict(),
  nextAction: z.literal("update_with_revision"),
}).strict();
export type LocalExportSettings = z.infer<typeof localExportSettingsSchema>;

/** 本地文件读取：与本地导出共用同一个管理员配置的根目录，但由每个步骤单独开关。
 *
 *  为什么复用同一个根目录：授权边界只应有一处、由管理员显式配置。再引入一个独立根目录会让
 *  「能读哪个目录」和「能写哪个目录」出现两份真相；这里保持一个根、两个步骤级开关
 *  （localExport 写、fileAccess 读），任一未开启时该方向完全不生效。 */
export const MAX_LOCAL_FILE_LIST_ENTRIES = 500;
/** 单次文本读取上限：编排只需要读动作/提示词这类小文本，不把大文件读进内存。 */
export const MAX_LOCAL_FILE_READ_BYTES = 1024 * 1024;

/** Machine contract for the core.code file read feature; mirrored into the AI OpenAPI as x-local-file-access. */
export const LOCAL_FILE_ACCESS_CONTRACT = {
  version: "1",
  scope: "core.code 步骤的可选受控本地文件读取",
  enable: "capabilityConfig.fileAccess = { enabled: true }；省略或 false 时沙箱里没有 zane.fs，任何文件请求都不存在",
  root: {
    setting: "与本地导出共用系统单例设置 local-export（管理员经 HTTP/MCP 配置）；未配置时整步失败 FILE_ACCESS_DISABLED",
    containment: "每次请求都对根目录与目标取真实路径后比较，越界即 FILE_OUTSIDE_ROOT；.. 逃逸被拒绝而不是被中和",
    symlinks: "目标真实路径经符号链接/联接点指向根目录之外时拒绝（不读取根外内容）",
    shared: "读与写共用同一个根目录，读写各自需要步骤级开关；开启读取不会获得任何写权限，反之亦然",
  },
  api: {
    surface: "沙箱内只在开启时注入 globalThis.zane.fs，且只有三个只读方法，都是数据请求、不是宿主函数引用",
    list: "zane.fs.list(path) → [{ name, path, isFile, isDir, isSymbolicLink, size }]，按名称排序；目录项自身是符号链接时只标记不跟随",
    stat: "zane.fs.stat(path) → { path, exists, isFile, isDir, isSymbolicLink, size }；目标不存在返回 exists:false 而不是抛错",
    readText: "zane.fs.readText(path) → string，按 UTF-8 读取文件文本（用于从动作/提示词等多行文本里挑一行）；目标不存在报 FILE_NOT_FOUND，超过 " + Math.floor(MAX_LOCAL_FILE_READ_BYTES / 1024) + " KB 报 FILE_TOO_LARGE；只返回文本内容，不执行、不解析，也不写回",
    path: "返回的 path 是受控根目录内的绝对路径，便于把根内既有文件交给下游步骤（例如 ComfyUI 上传）；越界请求仍然失败",
    sync: "三个方法都是同步返回值（也可 await）；沙箱内没有定时器，宿主在沙箱之外串行应答每个请求",
  },
  limits: { listEntries: MAX_LOCAL_FILE_LIST_ENTRIES, pathLength: MAX_LOCAL_EXPORT_TARGET_LENGTH, readBytes: MAX_LOCAL_FILE_READ_BYTES },
  errors: ["INVALID_CODE_CONFIG", "FILE_ACCESS_DISABLED", "FILE_OUTSIDE_ROOT", "FILE_NOT_FOUND", "FILE_LIST_TOO_LARGE", "FILE_TOO_LARGE", "FILE_ACCESS_FAILED"],
  sideEffects: {
    prepare: "none",
    publish: "none",
    execute: "只读取受控根目录内既有文件的元数据（名称/类型/大小）与显式请求的文本内容，不写文件、不改内容、不调用模型、不计费",
  },
} as const;

export interface LocalFileAccessConfig { enabled: boolean }

/** 解析 core.code 的 fileAccess 配置块。默认关闭；开启时校验字段，不猜。 */
export function parseLocalFileAccessConfig(config: unknown): LocalFileAccessConfig {
  const record = config && typeof config === "object" && !Array.isArray(config) ? config as Record<string, unknown> : undefined;
  const raw = record?.fileAccess;
  if (raw === undefined) return { enabled: false };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("fileAccess 必须是一个对象，形如 { enabled: true }", "INVALID_CODE_CONFIG");
  const extra = Object.keys(raw).filter((key) => key !== "enabled");
  if (extra.length) invalid("fileAccess 不支持的字段：" + extra.join("、"), "INVALID_CODE_CONFIG");
  const enabled = (raw as { enabled?: unknown }).enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") invalid("fileAccess.enabled 必须是布尔值", "INVALID_CODE_CONFIG");
  return { enabled: enabled === true };
}

/** 读取目标必须落在根目录内部（目录本身也允许，用于列目录）。
 *  与导出目标的差别：不要求媒体扩展名，因为要能读目录与文本/二进制元数据。 */
export function resolveLocalReadTarget(root: string, target: unknown): string {
  if (!root) invalid("尚未配置本地文件根目录，自定义代码的文件访问不可用；请管理员先配置 local-export 设置", "FILE_ACCESS_DISABLED");
  if (typeof target !== "string") invalid("文件访问路径必须是字符串");
  const text = target.trim();
  if (!text) invalid("文件访问路径不能为空");
  if (text.length > MAX_LOCAL_EXPORT_TARGET_LENGTH) invalid("文件访问路径过长");
  if (/[\0\r\n]/.test(text)) invalid("文件访问路径不能包含控制字符");
  const resolvedRoot = path.resolve(root);
  const resolved = path.isAbsolute(text) ? path.resolve(text) : path.resolve(resolvedRoot, text);
  const relative = path.relative(resolvedRoot, resolved);
  // relative 为空表示目标就是根目录本身（允许，用于列根目录）；以 .. 开头或仍是绝对路径表示越界。
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    invalid("文件访问路径必须位于受控根目录内部：" + text, "FILE_OUTSIDE_ROOT");
  }
  return resolved;
}
