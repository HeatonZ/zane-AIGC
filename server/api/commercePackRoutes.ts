import { Router } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../errors.js";
import type { RunRecord, SavedSettings } from "../domain/types.js";
import { asRecord } from "../domain/workflowValues.js";
import { isActiveRunStatus } from "../domain/types.js";
import { isRunId, runArtifactPaths } from "../artifacts/runArtifacts.js";
import { commerceZip, type ZipEntry } from "../commerce/zip.js";

function manifestRows(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 8) throw new HttpError(400, "成图清单嵌套过深");
  if (Array.isArray(value)) return value.flatMap((item) => manifestRows(item, depth + 1));
  const row = asRecord(value);
  return row?.format === "zane-commerce-pack/item-v1" ? [row] : [];
}

export function commerceRunRows(run: RunRecord) {
  const output = run.outputs.find((item) => item.key === "commerce_manifest");
  return output ? manifestRows(output.value) : run.steps.flatMap((step) => step.items?.flatMap((item) => item.status === "completed" ? manifestRows(item.outputs?.commerce_manifest) : []) ?? []);
}

export function createCommercePackRouter(loadSettings: () => Promise<SavedSettings>, getRun: (project: string, id: string) => Promise<RunRecord | undefined>) {
  const router = Router();
  router.get("/api/v1/runs/:runId/commerce-pack.zip", async (request, response) => {
    const runId = request.params.runId;
    if (typeof runId !== "string" || !isRunId(runId)) throw new HttpError(400, "运行编号无效");
    const settings = await loadSettings();
    if (!settings.projectDirectory) throw new HttpError(404, "项目目录未配置");
    const run = await getRun(settings.projectDirectory, runId);
    if (!run) throw new HttpError(404, "没有找到运行记录");
    if (isActiveRunStatus(run.status)) throw new HttpError(409, "请等待本次运行结束后导出");
    const rows = commerceRunRows(run);
    if (!rows.length) throw new HttpError(404, "这条记录没有电商套图成图");
    if (rows.length > 144) throw new HttpError(400, "成图数量超过限制");
    const sourceRuns = new Set([runId]);
    let ancestor = run.resumedFromRunId ?? run.rerunFromRunId;
    for (let index = 0; ancestor && index < 50; index++) {
      if (!isRunId(ancestor) || sourceRuns.has(ancestor)) break;
      sourceRuns.add(ancestor);
      const source = await getRun(settings.projectDirectory, ancestor);
      ancestor = source?.resumedFromRunId ?? source?.rerunFromRunId;
    }
    const entries: ZipEntry[] = [];
    const names = new Set<string>();
    let totalSize = 0;
    for (const row of [...rows].sort((a, b) => String(a.exportName).localeCompare(String(b.exportName)))) {
      if (typeof row.sourceRunId !== "string" || !sourceRuns.has(row.sourceRunId) || typeof row.outputFile !== "string" || !/^outputs\/media\/commerce-[a-z][a-z0-9_-]*\.jpg$/.test(row.outputFile) || typeof row.exportName !== "string" || !/^[a-z][a-z0-9_-]{0,31}\/0[1-6]-(hero|selling_point|detail|lifestyle|specs|package)\.jpg$/.test(row.exportName) || names.has(row.exportName)) throw new HttpError(400, "成图清单含不安全路径、未知来源或重复文件名");
      const file = path.resolve(runArtifactPaths(settings.projectDirectory, row.sourceRunId).directory, ...row.outputFile.split("/"));
      const info = await lstat(file).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink()) throw new HttpError(404, "归档成图文件不存在或不安全");
      if (info.size > 32 * 1024 * 1024) throw new HttpError(413, "单张成图超过32MiB");
      totalSize += info.size;
      if (totalSize > 512 * 1024 * 1024) throw new HttpError(413, "打包内容超过512MiB");
      names.add(row.exportName);
      entries.push({ name: row.exportName, file });
    }
    const failures = run.steps.flatMap((step) => step.items?.filter((item) => item.status !== "completed").map((item) => ({ step: step.name, shot: item.value, status: item.status, error: item.error ?? "" })) ?? []);
    entries.push({ name: "manifest.json", data: Buffer.from(JSON.stringify({ format: "zane-commerce-pack/v1", runId, runTitle: run.runTitle ?? run.workflowName, status: run.status, incomplete: run.status !== "completed", totalImages: rows.length, images: rows, failures, reviewRequired: true }, null, 2)) });
    entries.push({ name: "REVIEW.txt", data: Buffer.from("本包为设计素材，不代表平台审核通过。\n发布前人工核对：商品结构、颜色、Logo与包装文字；规格/功效/配件事实；具体平台类目和刊登位置的图片规则。\nAmazon主图关闭后置文字并使用白底画布，但原图背景与商品占比仍需复核。\nAI模式只有提示约束，严格保真请使用原图保真排版；后者不自动抠图。\n失败/取消记录可以导出已完成卡片；manifest.json标明incomplete和失败项。\n", "utf8") });
    const controller = new AbortController();
    const disconnected = () => { if (!response.writableFinished) controller.abort(); };
    response.once("close", disconnected);
    response.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="commerce-pack-${runId.slice(0, 8)}.zip"`, "Cache-Control": "no-store" });
    try { await pipeline(Readable.from(commerceZip(entries, controller.signal)), response, { signal: controller.signal }); }
    finally { response.off("close", disconnected); }
  });
  return router;
}
