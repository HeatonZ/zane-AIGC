import { Router, type Response } from "express";
import type { Request } from "express";
import type { JsonValue, RunRecord, SavedSettings } from "../domain/types.js";
import { collectLocalMediaPaths, localMediaQuery } from "../domain/localMedia.js";
import { HttpError } from "../errors.js";
import { resolveContainedLocalFile } from "../execution/localFileAccess.js";
import { previewWidth } from "../services/mediaPreview.js";
import { sendPrivateMedia } from "./mediaPreviewResponse.js";
import { enablePrivateMediaRevalidation } from "./privateMediaCache.js";
import type { LocalExportService } from "../services/localExportSettings.js";

/** 本地媒体查看（仅管理员）：把运行记录里已存在的本机媒体路径变成可预览地址。
 *
 *  设计要点：
 *   - 客户端只提交 (stepId,itemIndex,outputKey,mediaIndex) 坐标，不提交路径；路径由服务端
 *     从运行记录重新解析，因此不存在「伪造路径读任意文件」的入口。
 *   - 解析出的路径必须落在管理员配置的 local-export 根目录内部；越界与符号链接逃逸都拒绝。
 *     可读范围因此与 core.code 的 fileAccess 完全相同，只是把只读能力开放给管理员界面。
 *   - 只服务真实存在的普通文件；缺失明确 404，不静默回退到别处。
 *  这是本地导出根目录唯一的读出口，不新增第二个根目录，也不放宽沙箱隔离。 */

function authorizeAdmin(res: Response) {
  // Fail closed if mounted without the shared identity middleware.
  if (typeof res.locals.authorizeAdmin !== "function") throw new HttpError(403, "需要管理员权限", "ADMIN_REQUIRED");
  res.locals.authorizeAdmin();
}

/** 按坐标取出运行记录中的值：与 output-media 的定位方式保持一致（最终输出或步骤/逐项输出）。 */
export function localMediaSourceValue(run: RunRecord, query: { stepId?: string; itemIndex?: number; outputKey: string }): JsonValue | undefined {
  if (query.stepId === undefined) {
    if (query.itemIndex !== undefined) throw new HttpError(400, "最终输出不能指定逐项序号", "INVALID_LOCAL_MEDIA_REQUEST");
    return run.outputs.find(item => item.key === query.outputKey)?.value;
  }
  const step = run.steps.find(item => item.stepId === query.stepId);
  if (!step) throw new HttpError(404, "步骤尚未执行或不存在", "LOCAL_MEDIA_NOT_FOUND");
  if (query.itemIndex === undefined) return step.outputs?.[query.outputKey];
  const item = step.items?.find(entry => entry.index === query.itemIndex);
  if (!item) throw new HttpError(404, "没有找到此逐项结果", "LOCAL_MEDIA_NOT_FOUND");
  return item.outputs?.[query.outputKey];
}

export function createLocalMediaRouter(deps: {
  loadSettings: () => Promise<SavedSettings>;
  getRun: (project: string, runId: string) => Promise<RunRecord | undefined> | RunRecord | undefined;
  localExport: LocalExportService;
}) {
  const router = Router();
  router.get("/api/v1/runs/:runId/local-media", async (request: Request, response: Response, next) => {
    try {
      authorizeAdmin(response);
      const parsed = localMediaQuery.safeParse(request.query);
      if (!parsed.success) throw new HttpError(400, "本地媒体参数无效：需要 outputKey，可选 stepId/itemIndex/mediaIndex/w", "INVALID_LOCAL_MEDIA_REQUEST");
      const query = parsed.data;
      const { projectDirectory } = await deps.loadSettings();
      const runId = String(request.params.runId);
      const run = await deps.getRun(projectDirectory, runId);
      if (!run) throw new HttpError(404, "运行不存在", "OBJECT_NOT_FOUND");

      // 路径只来自运行记录，客户端无法指定。
      const value = localMediaSourceValue(run, query);
      const paths = collectLocalMediaPaths(value);
      const selected = paths[query.mediaIndex];
      if (selected === undefined) throw new HttpError(404, "此输出里没有第 " + query.mediaIndex + " 个本地媒体文件", "LOCAL_MEDIA_NOT_FOUND");

      // 未配置根目录时整个特性关闭：不做任何文件系统读取。
      const root = deps.localExport.root();
      let file: string;
      try {
        file = await resolveContainedLocalFile(root, selected);
      } catch (error) {
        // 读取器用 FILE_NOT_FOUND 表达「文件不在磁盘上」（对 core.code 的 fileAccess 是 400）。
        // 对一个媒体读取端点来说，文件缺失本来就该是 404，与归档媒体/output-media 的语义一致。
        if (error instanceof HttpError && error.code === "FILE_NOT_FOUND") {
          throw new HttpError(404, "没有找到本地媒体文件；文件可能已被移动或删除", "LOCAL_MEDIA_NOT_FOUND");
        }
        throw error;
      }

      const width = query.w === undefined ? undefined : previewWidth(query.w);
      if (width === undefined) {
        enablePrivateMediaRevalidation(response);
        // 与归档媒体、素材媒体保持一致：私有媒体一律带 nosniff 与沙箱 CSP，
        // 不给浏览器按内容嗅探类型的机会。
        response.sendFile(file, {
          dotfiles: "allow", cacheControl: false, etag: true, lastModified: true,
          headers: { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" },
        }, error => { if (error) next(error); });
        return;
      }
      await sendPrivateMedia(response, file, width, projectDirectory, next);
    } catch (error) { next(error); }
  });
  return router;
}
