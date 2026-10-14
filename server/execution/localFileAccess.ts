import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../errors.js";
import {
  MAX_LOCAL_FILE_LIST_ENTRIES,
  MAX_LOCAL_FILE_READ_BYTES,
  resolveLocalReadTarget,
} from "../domain/localExport.js";

/** 受控本地文件读取的宿主侧执行器（只读，不写文件）。
 *
 *  与本地导出同一套授权模型：用户代码只能提交「我要看哪个路径」这样的数据请求，真正的
 *  readdir/stat 发生在这里，并且只允许访问管理员配置的根目录内部。
 *  安全不变量（每条都有对应失败）：
 *   1) 未配置根目录 → FILE_ACCESS_DISABLED，不做任何文件系统调用；
 *   2) 路径归一化后必须位于根目录内 → 否则 FILE_OUTSIDE_ROOT（.. 逃逸被拒绝而非中和）；
 *   3) 已存在的路径其真实路径也必须位于根内 → 符号链接/联接点不能把读取带到根外；
 *   4) 列目录项数受限（MAX_LOCAL_FILE_LIST_ENTRIES），越限明确失败而不是静默截断；
 *   5) 只读：不创建、不删除、不修改任何文件，也不把字节读进内存（只返回元数据）。 */

export interface LocalFileEntry {
  name: string;
  /** 受控根目录内的绝对路径；下游步骤（如 ComfyUI 上传）可直接消费。 */
  path: string;
  isFile: boolean;
  isDir: boolean;
  isSymbolicLink: boolean;
  size: number;
}
export interface LocalFileStat {
  path: string;
  exists: boolean;
  isFile: boolean;
  isDir: boolean;
  isSymbolicLink: boolean;
  size: number;
}

function fail(message: string, code = "FILE_ACCESS_FAILED"): never { throw new HttpError(400, message, code); }

/** 真实路径必须落在根目录内（根目录自身允许）。 */
function insideOrEqual(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** 根目录自身的真实路径：作为后续所有包含性比较的锚点。
 *  根目录可能是符号链接（例如用户配置的软链目录），因此先解析一次再比较。 */
async function realRoot(root: string) {
  return (await realpath(root).catch(() => undefined)) ?? path.resolve(root);
}

/** 已存在路径的真实路径必须在根内；不存在时由调用方处理。返回真实路径。 */
async function assertContained(root: string, resolved: string) {
  const real = await realpath(resolved).catch(() => undefined);
  if (real === undefined) return undefined;
  if (!insideOrEqual(root, real)) fail("文件访问路径经符号链接指向受控根目录之外：" + resolved, "FILE_OUTSIDE_ROOT");
  return real;
}

/** 只读列目录：按名称排序，返回元数据。符号链接只标记不跟随（size 取链接自身）。 */
export async function listLocalDirectory(root: string, target: unknown): Promise<LocalFileEntry[]> {
  const resolved = resolveLocalReadTarget(root, target);
  const anchor = await realRoot(root);
  const real = await assertContained(anchor, resolved);
  if (real === undefined) fail("目录不存在：" + resolved, "FILE_NOT_FOUND");
  const info = await stat(real).catch(() => undefined);
  if (!info) fail("目录不存在：" + resolved, "FILE_NOT_FOUND");
  if (!info.isDirectory()) fail("路径不是目录：" + resolved, "FILE_ACCESS_FAILED");
  const dirents = await readdir(real, { withFileTypes: true });
  if (dirents.length > MAX_LOCAL_FILE_LIST_ENTRIES) {
    fail("目录项超过 " + MAX_LOCAL_FILE_LIST_ENTRIES + " 个上限，" + resolved + "；请缩小到更具体的子目录", "FILE_LIST_TOO_LARGE");
  }
  const entries: LocalFileEntry[] = [];
  for (const dirent of dirents) {
    const entryPath = path.join(real, dirent.name);
    // lstat：不跟随链接，因此链接既不算文件也不算目录，只被标记。
    const entryInfo = await lstat(entryPath).catch(() => undefined);
    if (!entryInfo) continue;
    const isSymbolicLink = entryInfo.isSymbolicLink();
    entries.push({
      name: dirent.name,
      path: entryPath,
      isFile: entryInfo.isFile(),
      isDir: entryInfo.isDirectory(),
      isSymbolicLink,
      size: entryInfo.size,
    });
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return entries;
}

/** 受控文本读取：返回文件内容的 UTF-8 文本，用于「从动作/提示词文本里挑一行」这类编排。
 *
 *  与 list/stat 共用同一套边界：只允许根目录内的真实路径，符号链接逃逸被拒绝。
 *  额外的安全不变量：
 *   6) 只读文本，且先按 size 预检上限再读，避免把超大文件读进内存（超限报 FILE_TOO_LARGE）；
 *   7) 只做 UTF-8 解码，不执行内容、不解析为代码；读到的文本只作为数据返回。
 *  为什么需要它：动作集合这类「多行文本随机取一行」的编排，仅靠文件名/大小无法完成；
 *  让宿主读文本比让用户代码自行想办法读文件更可控，边界仍然只有管理员配置的那一个根目录。 */
export async function readLocalText(root: string, target: unknown): Promise<string> {
  const resolved = resolveLocalReadTarget(root, target);
  const anchor = await realRoot(root);
  const real = await assertContained(anchor, resolved);
  if (real === undefined) fail("文件不存在：" + resolved, "FILE_NOT_FOUND");
  const info = await stat(real).catch(() => undefined);
  if (!info) fail("文件不存在：" + resolved, "FILE_NOT_FOUND");
  if (!info.isFile()) fail("路径不是文件：" + resolved, "FILE_ACCESS_FAILED");
  if (info.size > MAX_LOCAL_FILE_READ_BYTES) {
    fail("文件超过 " + Math.floor(MAX_LOCAL_FILE_READ_BYTES / 1024) + " KB 读取上限：" + resolved, "FILE_TOO_LARGE");
  }
  return readFile(real, "utf8");
}

/** 只读元数据查询：目标不存在返回 exists:false（便于用户代码探测批次目录），越界仍然失败。 */
export async function statLocalPath(root: string, target: unknown): Promise<LocalFileStat> {
  const resolved = resolveLocalReadTarget(root, target);
  const anchor = await realRoot(root);
  const real = await assertContained(anchor, resolved);
  if (real === undefined) return { path: resolved, exists: false, isFile: false, isDir: false, isSymbolicLink: false, size: 0 };
  const info = await lstat(real).catch(() => undefined);
  if (!info) return { path: resolved, exists: false, isFile: false, isDir: false, isSymbolicLink: false, size: 0 };
  return {
    path: real,
    exists: true,
    isFile: info.isFile(),
    isDir: info.isDirectory(),
    isSymbolicLink: info.isSymbolicLink(),
    size: info.size,
  };
}
