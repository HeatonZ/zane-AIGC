import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { operationRequest, type AiOperation } from "../ai/operations.js";

export interface ApiResult extends Record<string, unknown> {
  ok: boolean; data?: unknown;
  error?: { code: string; message: string; status?: number; retryAfterSeconds?: number; outcome: "rejected" | "unknown" | "read_failed"; recovery: string; runId?: string; assetId?: string; details?: Record<string, unknown> };
  requestId?: string;
}
export class WorkbenchHttpClient {
  readonly baseUrl: string;
  constructor(baseUrl: string, readonly timeoutMs = 45000, readonly token = process.env.ZANE_API_TOKEN ?? "") {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash || url.username || url.password || !["", "/"].includes(url.pathname)) throw new Error("ZANE_BASE_URL 必须是工作台 HTTP(S) 根地址，不能带路径、查询或用户名密码");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error("ZANE_MCP_TIMEOUT_MS 必须是1000至300000的整数");
    this.baseUrl = url.origin;
  }
  async call(operation: AiOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<ApiResult> {
    const { path: route, args } = operationRequest(operation, input);
    const url = new URL(route, this.baseUrl);
    const headers: Record<string, string> = { Accept: "application/json", ...(this.token ? { Authorization: "Bearer " + this.token } : {}) };
    let body: BodyInit | undefined;
    let stream: ReturnType<typeof createReadStream> | undefined;
    let sent = false;
    let requestId: string | undefined;
    let status: number | undefined;
    const timeout = AbortSignal.timeout(Math.max(this.timeoutMs, operation.name === "wait_run" ? (Number(args.timeoutSeconds ?? 20) + 5) * 1000 : 0));
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    try {
      if (operation.upload) {
        const file = String(args.filePath); delete args.filePath;
        if (!path.isAbsolute(file)) throw new Error("filePath 必须是 MCP 进程所在机器的绝对路径");
        const info = await stat(file);
        if (!info.isFile() || info.size > 250 * 1024 * 1024 || info.size === 0) throw new Error("上传文件必须非空且不超过250MB");
        headers["Content-Type"] = "application/octet-stream";
        headers["Content-Length"] = String(info.size);
        headers["X-File-Name"] = encodeURIComponent(path.basename(file));
        stream = createReadStream(file); body = stream as unknown as BodyInit;
      } else if (operation.method !== "GET") { headers["Content-Type"] = "application/json"; body = JSON.stringify(args); }
      if (operation.method === "GET" || operation.upload) for (const [key, value] of Object.entries(args)) if (value !== undefined) url.searchParams.set(key, operation.upload && Array.isArray(value) ? JSON.stringify(value) : String(value));
      combined.throwIfAborted();
      sent = true;
      // Never automatically retry a mutation, even when fetch failed before receiving a response.
      const response = await fetch(url, { method: operation.method, headers, body, signal: combined, redirect: "error", ...(stream ? { duplex: "half" } : {}) } as RequestInit);
      status = response.status;
      requestId = response.headers.get("x-request-id") ?? undefined;
      let data: unknown;
      const text = await response.text();
      try { data = JSON.parse(text); } catch { return this.failure(operation, input, "INVALID_API_RESPONSE", "工作台没有返回JSON；请确认后台版本、地址及接口已启用", status, requestId, sent); }
      if (!response.ok) {
        const error = (data !== null && typeof data === "object" ? data : {}) as { code?: string; error?: string; details?: Record<string, unknown> };
        const result = this.failure(operation, input, error.code ?? "HTTP_ERROR", error.error ?? "HTTP " + response.status, status, requestId, sent);
        if (result.error && error.details && typeof error.details === "object" && !Array.isArray(error.details)) result.error.details = error.details;
        const retry = Number(response.headers.get("retry-after"));
        if (result.error && retry > 0 && Number.isFinite(retry)) result.error.retryAfterSeconds = retry;
        return result;
      }
      return { ok: true, data, ...(requestId ? { requestId } : {}) };
    } catch (error) {
      const code = timeout.aborted ? "API_TIMEOUT" : signal?.aborted ? "CALL_ABORTED" : sent ? "API_UNREACHABLE" : "LOCAL_INPUT_ERROR";
      return this.failure(operation, input, code, error instanceof Error ? error.message : String(error), status, requestId, sent);
    } finally { stream?.destroy(); }
  }
  private failure(operation: AiOperation, input: Record<string, unknown>, code: string, message: string, status?: number, requestId?: string, sent = true): ApiResult {
    const mutates = operation.effect !== "read";
    const rejected = !sent || (status !== undefined && status >= 400 && status < 500);
    const outcome = mutates ? rejected ? "rejected" : "unknown" : "read_failed";
    const publication = typeof input.publicationId === "string" ? input.publicationId : undefined;
    const newRunId = typeof input.runId === "string" ? input.runId : undefined;
    const assetId = typeof input.createId === "string" ? input.createId : typeof input.assetId === "string" ? input.assetId : undefined;
    const recovery = operation.name === "update_task_concurrency" && (outcome === "unknown" || status === 409) ? "先用get_task_concurrency读取固定ID task-concurrency，核对revision和maxActiveRuns后由操作者决定；禁止自动重放旧配置写入。" : code === "RUN_PREPARING" ? "遵守Retry-After，稍后查询同一runId。" : code === "RUN_ALREADY_EXISTS" ? "读取同一runId并核对来源；409不是请求内容幂等重放成功。不要换ID再提交。" : outcome === "unknown" ? newRunId ? "写入结果未知：先查询runId=" + newRunId + "，遇RUN_PREPARING继续等；404也不能立即认定未提交。禁止自动换ID或重放。" : publication ? "发布结果未知：先用get_scene查询sceneId=" + String(input.sceneId) + "、versionId=" + publication + "，并读取草稿发布目录对账；不换ID盲目重发。" : assetId ? "素材写入结果未知：先get_asset查询assetId=" + assetId + "，核对revision/currentVersion；不要换createId或重复上传/收藏。404也不排除请求仍在落库。" : "写入结果未知：重新读取对象、revision/reviewId/lastRunId并核对，再决定下一步；禁止盲重放。" : status === 409 ? "状态/版本冲突：重读场景或对象，重新预览/合并后决策；不要重放旧revision或reviewId。" : "修正参数或检查后台版本/连接；查询可重试，执行需重新确认。";
    return { ok: false, error: { code, message, ...(status !== undefined ? { status } : {}), outcome, recovery, ...(newRunId ? { runId: newRunId } : {}), ...(assetId ? { assetId } : {}) }, ...(requestId ? { requestId } : {}) };
  }
}
