import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isRunId, runArtifactPaths } from "../artifacts/runArtifacts.js";
import type { ZipEntry } from "../artifacts/zip.js";
import { contentRevision } from "../domain/sceneContent.js";
import { asRecord, normalizeMediaList } from "../domain/workflowValues.js";
import { mediaKindFromWorkflowType } from "../runtimeValue.js";
import type { RunRecord, SavedSettings } from "../domain/types.js";
import type { RunMediaExportQuery, RunMediaExport } from "../domain/runMediaExportContracts.js";
import { HttpError } from "../errors.js";

/** Read-only export of already archived media. Never materializes remote media or invokes a model. */
export class RunMediaExportService {
  constructor(private readonly settings: () => Promise<SavedSettings>, private readonly getRun: (project: string, id: string) => Promise<RunRecord | undefined>) {}
  async prepare(runId: string, query: RunMediaExportQuery, authorize: (run: RunRecord) => void = () => {}, self = false) {
    if (!isRunId(runId)) throw new HttpError(400, "运行编号无效", "INVALID_MEDIA_EXPORT");
    const settings = await this.settings();
    const run = await this.getRun(settings.projectDirectory, runId);
    if (!run) throw new HttpError(404, "运行不存在", "OBJECT_NOT_FOUND");
    authorize(run);
    const authorizationRecords = [run];
    if (!["completed", "failed", "cancelled", "stale"].includes(run.status)) throw new HttpError(409, "仅可导出终态运行；待审核不代表已完成", "RUN_NOT_TERMINAL");
    let value: unknown, type: string | undefined;
    if (query.stepId) {
      const step = run.steps.find(item => item.stepId === query.stepId);
      if (!step) throw new HttpError(404, "步骤不存在", "OUTPUT_NOT_AVAILABLE");
      type = step.outputTypes?.[query.outputKey] ?? run.workflow.steps.find(item => item.id === query.stepId)?.outputs?.find(item => item.key === query.outputKey)?.type;
      if (query.itemIndex !== undefined) {
        const item = step.items?.find(item => item.index === query.itemIndex && item.status === "completed");
        value = item?.outputs?.[query.outputKey];
      } else if (step.items) value = step.items.filter(item => item.status === "completed").flatMap(item => normalizeMediaList(item.outputs?.[query.outputKey]));
      else if (step.status === "completed") value = step.outputs?.[query.outputKey];
    } else {
      if (query.itemIndex !== undefined) throw new HttpError(400, "逐项序号需要stepId", "INVALID_MEDIA_EXPORT");
      const output = run.outputs.find(item => item.key === query.outputKey); value = output?.value; type = output?.type;
    }
    if (!mediaKindFromWorkflowType(type)) throw new HttpError(400, "只能导出媒体输出", "INVALID_MEDIA_EXPORT");
    const media = normalizeMediaList(value);
    if (!media.length) throw new HttpError(404, "此输出没有已完成的归档媒体", "OUTPUT_NOT_AVAILABLE");
    if (media.length > 144) throw new HttpError(413, "一次最多导出144项媒体", "MEDIA_EXPORT_TOO_LARGE");
    const allowed = new Set([runId]); let ancestor = run.resumedFromRunId ?? run.rerunFromRunId;
    for (let index = 0; ancestor && index < 50; index++) {
      if (!isRunId(ancestor) || allowed.has(ancestor)) throw new HttpError(400, "运行来源链无效", "INVALID_MEDIA_EXPORT_SOURCE");
      const source = await this.getRun(settings.projectDirectory, ancestor);
      if (!source) throw new HttpError(404, "来源运行不存在", "OBJECT_NOT_FOUND");
      authorize(source); authorizationRecords.push(source); allowed.add(ancestor); ancestor = source.resumedFromRunId ?? source.rerunFromRunId;
    }
    if (ancestor) throw new HttpError(400, "运行来源链超过50层", "INVALID_MEDIA_EXPORT_SOURCE");
    const entries: ZipEntry[] = []; const manifest: Array<Record<string, unknown>> = []; let totalBytes = 0;
    for (const [index, item] of media.entries()) {
      const record = asRecord(item); const url = typeof item === "string" ? item : record?.url;
      const match = typeof url === "string" ? /^\/api\/(?:v1|workflows)\/runs\/([a-f0-9-]{36})\/media\/([^/?]+)$/i.exec(url) : undefined;
      if (!match || !allowed.has(match[1])) throw new HttpError(400, "仅导出本运行或其已授权祖先的归档媒体，不读取路径或远程URL", "INVALID_MEDIA_EXPORT_SOURCE");
      let filename: string; try { filename = decodeURIComponent(match[2]); } catch { throw new HttpError(400, "媒体文件名无效", "INVALID_MEDIA_EXPORT_SOURCE"); }
      if (!filename || filename === "." || filename === ".." || /[\\/\x00]/.test(filename) || path.basename(filename) !== filename) throw new HttpError(400, "媒体文件名无效", "INVALID_MEDIA_EXPORT_SOURCE");
      const file = path.join(runArtifactPaths(settings.projectDirectory, match[1]).directory, "outputs", "media", filename);
      const info = await lstat(file).catch(() => undefined); const resolved = await realpath(file).catch(() => "");
      const normalize = (name: string) => process.platform === "win32" ? name.toLowerCase() : name;
      if (!info?.isFile() || info.isSymbolicLink() || normalize(resolved) !== normalize(path.resolve(file))) throw new HttpError(404, "归档文件不存在或不安全", "MEDIA_EXPORT_FILE_UNAVAILABLE");
      totalBytes += info.size;
      if (info.size > 32 * 1024 * 1024 || totalBytes > 512 * 1024 * 1024) throw new HttpError(413, "归档媒体超过导出大小限制", "MEDIA_EXPORT_TOO_LARGE");
      const extension = path.extname(filename).toLowerCase();
      if (!/^\.[a-z0-9]{1,8}$/.test(extension)) throw new HttpError(400, "媒体扩展名无效", "INVALID_MEDIA_EXPORT_SOURCE");
      const name = String(index + 1).padStart(3, "0") + "-" + query.outputKey + extension;
      entries.push({ name, file }); manifest.push({ mediaIndex: index, name, bytes: info.size, sourceRunId: match[1], url, modifiedAt: info.mtimeMs });
    }
    const revision = contentRevision({ runId, query, status: run.status, media: manifest });
    const params = new URLSearchParams({ outputKey: query.outputKey, revision, ...(query.stepId ? { stepId: query.stepId } : {}), ...(query.itemIndex !== undefined ? { itemIndex: String(query.itemIndex) } : {}) });
    const data: RunMediaExport = { schemaVersion: 1, runId, ...query, revision, incomplete: run.status !== "completed", fileCount: media.length, totalBytes, downloadUrl: "/api/v1/" + (self ? "self/" : "") + "runs/" + runId + "/media.zip?" + params, nextAction: "download_archive" };
    entries.push({ name: "manifest.json", data: Buffer.from(JSON.stringify({ format: "zane-run-media-export/v1", ...data, files: manifest }, null, 2)) });
    for (const record of authorizationRecords) authorize(record);
    return { data, entries };
  }
}
