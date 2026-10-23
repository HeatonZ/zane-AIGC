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
    const timeout = AbortSignal.timeout(Math.max(this.timeoutMs, operation.name.startsWith("wait_") ? (Number(args.timeoutSeconds ?? 20) + 5) * 1000 : 0));
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
    const directLlmProvider = typeof input.providerId === "string" ? input.providerId : undefined;
    const recovery = operation.name === "update_task_concurrency" && (outcome === "unknown" || status === 409) ? "先用get_task_concurrency读取固定ID task-concurrency，核对revision和maxActiveRuns后由操作者决定；禁止自动重放旧配置写入。" : operation.name === "update_local_export" && (outcome === "unknown" || status === 409) ? "先用get_local_export读取固定ID local-export，核对revision和root后由操作者决定；禁止自动重放旧配置写入。" : operation.name.startsWith("create_direct_llm_provider") && (outcome === "unknown" || status === 409) ? "先用get_direct_llm_provider读取同一providerId=" + String(directLlmProvider ?? "") + "对账；PROVIDER_ALREADY_EXISTS不是幂等成功，不换ID重建。apiKey是明文密钥、只写入本机SQLite，响应只回掩码与末4位，不要把它写进笔记或日志。" : (operation.name === "update_direct_llm_provider" || operation.name === "delete_direct_llm_provider" || operation.name === "query_direct_llm_models") && (outcome === "unknown" || status === 409) ? "先用get_direct_llm_provider读取同一providerId=" + String(directLlmProvider ?? "") + "，核对revision与name/protocol/baseUrl/apiKeyEnv/enabled/models后由操作者决定；禁止自动重放旧配置写入或删除。apiKey三态：省略=保持原密钥（只改名称不会清空）、空串=清除、非空=替换；读接口只回掩码与末4位，从不回显明文，也不要把明文写进日志或笔记。" : code === "LOG_PAGE_CHANGED" ? "更早的日志已被容量挤出，续页游标作废：重新调用get_system_logs读取第一页（不传cursor），不要用旧cursor拼接两个快照。" : code === "INVALID_LOG_CURSOR" ? "日志游标无效或不属于当前筛选条件：去掉cursor重读get_system_logs第一页；不要把一个筛选的游标用到另一个筛选上。" : code === "OPS_LOG_READ_FAILED" ? "运维日志读取失败：确认数据目录可读，或改用get_system_logs读取进程内日志；不要反复重试同一文件。" : code === "DIRECT_LLM_PROVIDER_PAGE_CHANGED" ? "提供商目录在分页期间变化：去掉cursor重读list_direct_llm_providers第一页，不要拼接两个目录快照。" : code === "DIRECT_LLM_PROVIDER_NOT_FOUND" ? "该providerId不存在：先用list_direct_llm_providers读取当前目录，再决定创建还是改用别的ID；不要凭空猜测ID。" : code === "PROVIDER_ALREADY_EXISTS" ? "该providerId已存在：用get_direct_llm_provider读同一ID对账并改用update_direct_llm_provider；不换ID重建。" : code === "RUN_PREPARING" ? "遵守Retry-After，稍后查询同一runId。" : code === "RUN_ALREADY_EXISTS" ? "读取同一runId并核对来源；409不是请求内容幂等重放成功。不要换ID再提交。" : outcome === "unknown" ? newRunId ? "写入结果未知：先查询runId=" + newRunId + "，遇RUN_PREPARING继续等；404也不能立即认定未提交。禁止自动换ID或重放。" : publication ? "发布结果未知：先用get_scene查询sceneId=" + String(input.sceneId) + "、versionId=" + publication + "，并读取草稿发布目录对账；不换ID盲目重发。" : assetId ? "素材写入结果未知：先get_asset查询assetId=" + assetId + "，核对revision/currentVersion；不要换createId或重复上传/收藏。404也不排除请求仍在落库。" : directLlmProvider ? "提供商写入结果未知：先get_direct_llm_provider读取providerId=" + directLlmProvider + "，核对revision与字段后再决定；不要自动重放或换ID。" : "写入结果未知：重新读取对象、revision/reviewId/lastRunId并核对，再决定下一步；禁止盲重放。" : status === 409 ? "状态/版本冲突：重读场景或对象，重新预览/合并后决策；不要重放旧revision或reviewId。" : "修正参数或检查后台版本/连接；查询可重试，执行需重新确认。";
    return { ok: false, error: { code, message, ...(status !== undefined ? { status } : {}), outcome, recovery, ...(newRunId ? { runId: newRunId } : {}), ...(assetId ? { assetId } : {}) }, ...(requestId ? { requestId } : {}) };
  }
}
