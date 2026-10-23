import { Router, type Response } from "express";
import { directLlmProviderKey, directLlmProviderQuery } from "../domain/directLlm.js";
import { HttpError } from "../errors.js";
import type { DirectLlmService } from "../services/directLlmService.js";

function authorize(res: Response) {
  // Fail closed if mounted without the shared identity middleware.
  if (typeof res.locals.authorizeAdmin !== "function") throw new HttpError(403, "需要管理员权限", "ADMIN_REQUIRED");
  res.locals.authorizeAdmin();
}
function parseQuery(input: unknown) {
  const parsed = directLlmProviderQuery.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "直连模型提供商列表查询参数无效：limit 1–100，cursor 与 q 为可选", "INVALID_DIRECT_LLM_REQUEST");
  return parsed.data;
}
function providerId(value: string | string[] | undefined) {
  const parsed = directLlmProviderKey.safeParse({ providerId: Array.isArray(value) ? value[0] : value });
  if (!parsed.success) throw new HttpError(400, "直连模型提供商 ID 无效：只能使用字母、数字和 _ . -，且以字母或数字开头", "INVALID_DIRECT_LLM_REQUEST");
  return parsed.data.providerId;
}
function noQuery(req: { query: Record<string, unknown> }) {
  if (Object.keys(req.query).length) throw new HttpError(400, "此操作不接受查询参数", "INVALID_DIRECT_LLM_REQUEST");
}

/** 直连模型提供商注册表：只有管理员能读写，普通用户永远看不到也改不了。
 *  所有响应只含环境变量名，绝不回显密钥值。查询可用模型会真实访问该提供商，
 *  但只发一次 GET /models：不调用模型、不计生成费用、失败不写空列表。 */
export function createDirectLlmRouter(service: DirectLlmService) {
  const router = Router();
  router.get("/api/v1/settings/direct-llm/providers", (req, res) => {
    authorize(res);
    const query = parseQuery(req.query);
    res.set("Cache-Control", "no-store").json(service.read(query));
  });
  router.post("/api/v1/settings/direct-llm/providers", (req, res) => {
    authorize(res);
    noQuery(req);
    res.set("Cache-Control", "no-store").status(201).json(service.create(req.body, () => authorize(res)));
  });
  router.get("/api/v1/settings/direct-llm/providers/:providerId", (req, res) => {
    authorize(res);
    noQuery(req);
    res.set("Cache-Control", "no-store").json(service.get(providerId(req.params.providerId)));
  });
  router.patch("/api/v1/settings/direct-llm/providers/:providerId", (req, res) => {
    authorize(res);
    noQuery(req);
    res.set("Cache-Control", "no-store").json(service.update(providerId(req.params.providerId), req.body, () => authorize(res)));
  });
  router.delete("/api/v1/settings/direct-llm/providers/:providerId", (req, res) => {
    authorize(res);
    noQuery(req);
    res.set("Cache-Control", "no-store").json(service.remove(providerId(req.params.providerId), req.body, () => authorize(res)));
  });
  router.post("/api/v1/settings/direct-llm/providers/:providerId/models", async (req, res) => {
    authorize(res);
    noQuery(req);
    res.set("Cache-Control", "no-store").json(await service.queryModels(providerId(req.params.providerId), () => authorize(res)));
  });
  return router;
}
