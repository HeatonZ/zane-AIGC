import * as z from "zod/v4";
import { collectLocalMediaPaths, isLocalMediaPath, MAX_LOCAL_MEDIA_VALUE_LENGTH } from "./localMediaPaths.js";

export { collectLocalMediaPaths, isLocalMediaPath, MAX_LOCAL_MEDIA_VALUE_LENGTH };

/** 本地媒体查看通道（仅管理员）：把运行记录里已经存在的本机媒体路径变成可预览地址。
 *
 *  为什么需要它：core.code 的 fileAccess 会把受控根目录内的真实文件路径写进 text/json 输出
 *  （例如角色图路径、本轮参考图）。这些文件不在运行归档里，既不会被 output-media 解析
 *  （它只认媒体类型输出），也没有任何受控读取通道，于是界面看不了图。
 *
 *  安全边界与既有 localExport/fileAccess 完全一致，且只有一条：
 *   1) 只有管理员能调用（普通用户入口永不暴露，不进入 publicRequestAllowed 白名单）；
 *   2) 目标不是由客户端指定的路径，而是服务端从运行记录里重新解析出来的值，客户端只给坐标；
 *   3) 解析出的路径必须落在管理员配置的 local-export 根目录内部，越界与符号链接逃逸都拒绝。
 *  因此这不是「任意文件读取代理」：可读范围就是管理员显式授权的那一个根目录。 */

/** Machine contract for the local media view channel; mirrored into the AI OpenAPI as x-local-media. */
export const LOCAL_MEDIA_CONTRACT = {
  version: "1",
  scope: "查看运行结果里已记录的本机媒体文件（core.code fileAccess 产出的路径）",
  access: {
    role: "admin",
    userEntry: "不出现在用户专用入口；普通用户的运行结果不通过此通道读取本机文件",
    note: "这不是任意文件读取代理：客户端不能指定路径，只能指定输出坐标，路径由服务端从运行记录重新解析",
  },
  route: {
    method: "GET",
    path: "/api/v1/runs/{runId}/local-media",
    parameters: {
      stepId: "定位步骤；省略时读取最终输出",
      itemIndex: "for_each 的逐项序号；省略时读取整步输出",
      outputKey: "输出字段名（必填）",
      mediaIndex: "该输出内第几个本地媒体路径（按 collectLocalMediaPaths 的首次出现顺序，0 基，默认 0）",
      w: "可选显示宽度（16–2048）：图片返回 WebP 派生图，非图片或缩放失败回退原字节；省略为原文件",
    },
    resolution: "服务端按 (stepId,itemIndex,outputKey) 取出运行记录中的值，再用 collectLocalMediaPaths 取第 mediaIndex 项",
  },
  root: {
    setting: "管理员配置的本地导出根目录（系统单例 local-export，与 core.code localExport/fileAccess 共用）",
    containment: "路径归一化后必须位于根目录内部，越界即 FILE_OUTSIDE_ROOT；.. 逃逸被拒绝而不是被中和",
    symlinks: "目标真实路径经符号链接/联接点指向根目录之外时拒绝（不读取根外内容）",
    disabled: "未配置根目录（root 为空）时报 FILE_ACCESS_DISABLED，不做任何文件系统读取",
  },
  errors: ["INVALID_LOCAL_MEDIA_REQUEST", "ADMIN_REQUIRED", "OBJECT_NOT_FOUND", "LOCAL_MEDIA_NOT_FOUND", "FILE_ACCESS_DISABLED", "FILE_OUTSIDE_ROOT", "FILE_NOT_FOUND", "INVALID_PREVIEW_WIDTH"],
  sideEffects: { read: "只读取根目录内既有文件；不写文件、不生成媒体、不调用模型、不计费（可选缩放派生图写入项目预览缓存）" },
} as const;

/** 本地媒体读取坐标：只接受坐标，不接受路径。 */
export const localMediaQuery = z.object({
  stepId: z.string().min(1).max(200).optional(),
  itemIndex: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  outputKey: z.string().min(1).max(200),
  mediaIndex: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  w: z.coerce.number().int().min(16).max(2048).optional(),
}).strict();
export type LocalMediaQuery = z.infer<typeof localMediaQuery>;
