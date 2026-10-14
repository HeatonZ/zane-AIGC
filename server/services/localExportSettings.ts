import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  LOCAL_EXPORT_CONTRACT, MAX_LOCAL_EXPORT_FILES, MAX_LOCAL_EXPORT_FILE_BYTES, MAX_LOCAL_EXPORT_TOTAL_BYTES,
  LOCAL_EXPORT_CONFLICT_POLICIES, localExportSettingsSchema, normalizeLocalExportRoot, updateLocalExportRoot,
  type LocalExportSettings,
} from "../domain/localExport.js";
import { HttpError } from "../errors.js";
import type { SqliteStore } from "../storage/sqliteStore.js";

const SYSTEM = "@zane-system";
const COLLECTION = "settings";
const ID = "local-export";
interface SavedLocalExport { id: string; revision: number; root: string }

/** 本地导出根目录：core.code 步骤可选落盘的唯一白名单来源。
 *  UI、HTTP 与 MCP 都读写这一份 SQLite 系统单例，用户代码永远拿不到写权限、
 *  也看不到真实根路径；运行期只从许可证（本服务）读取，不信任步骤配置。 */
export class LocalExportService {
  constructor(private readonly store: SqliteStore, private readonly environmentRoot = "") {}

  private saved() { return this.store.getDocument<SavedLocalExport>(SYSTEM, COLLECTION, ID); }

  /** 运行期读取：保存值优先，其次环境默认值；空串表示整个特性关闭。 */
  root(): string {
    const saved = this.saved();
    if (saved) return saved.root;
    return this.environmentRoot ? normalizeLocalExportRoot(this.environmentRoot) : "";
  }

  read(): LocalExportSettings {
    const saved = this.saved();
    const root = this.root();
    return {
      format: "zane-studio.local-export/v1", id: ID, revision: saved?.revision ?? 0,
      root, source: saved ? "saved" : root ? "environment" : "unset",
      configured: Boolean(root), enabled: Boolean(root), scope: "system", appliesTo: "core.code.localExport",
      conflictPolicies: [...LOCAL_EXPORT_CONFLICT_POLICIES],
      limits: { files: MAX_LOCAL_EXPORT_FILES, fileBytes: MAX_LOCAL_EXPORT_FILE_BYTES, totalBytes: MAX_LOCAL_EXPORT_TOTAL_BYTES },
      nextAction: "update_with_revision",
    };
  }

  /** 保存前做一次真实写入探测：根目录不可创建或不可写时明确失败，而不是等到运行中途才报错。 */
  private async validateRoot(root: string) {
    if (!root) return "";
    await mkdir(root, { recursive: true });
    if (!(await stat(root)).isDirectory()) throw new HttpError(400, "导出根目录必须是文件夹", "INVALID_LOCAL_EXPORT_REQUEST");
    const marker = path.join(root, ".zane-export-check-" + randomUUID());
    try { await writeFile(marker, "ok", { flag: "wx" }); }
    catch { throw new HttpError(400, "导出根目录不可写：" + root, "INVALID_LOCAL_EXPORT_REQUEST"); }
    finally { await unlink(marker).catch(() => undefined); }
    return root;
  }

  update(input: unknown, authorize: () => void): Promise<LocalExportSettings> {
    return this.apply(input, authorize);
  }

  private async apply(input: unknown, authorize: () => void): Promise<LocalExportSettings> {
    const parsed = updateLocalExportRoot.safeParse(input);
    if (!parsed.success) throw new HttpError(400, "本地导出设置需要当前 revision 与 root 字符串；不接受未知字段", "INVALID_LOCAL_EXPORT_REQUEST");
    const { revision } = parsed.data;
    let root: string;
    try { root = normalizeLocalExportRoot(parsed.data.root); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "导出根目录无效", "INVALID_LOCAL_EXPORT_REQUEST"); }
    root = await this.validateRoot(root);
    try {
      this.store.putDocumentChecked(SYSTEM, COLLECTION, { id: ID, revision, root }, revision, authorize);
    } catch (error) {
      if (error instanceof Error && error.message === "DOCUMENT_CONFLICT") {
        throw new HttpError(409, "本地导出设置已变化，请重新读取并核对后保存；不要重放旧请求", "RESOURCE_REVISION_CONFLICT");
      }
      throw error;
    }
    return this.read();
  }

  /** 只读自检：契约与当前生效根目录，供 AI 首次使用前确认。 */
  contract() {
    return { ...LOCAL_EXPORT_CONTRACT, root: this.root(), settings: localExportSettingsSchema.parse(this.read()) };
  }
}
