import { Router, type RequestHandler, type Response } from "express";
import { notificationWebhookQuery } from "../domain/notificationWebhook.js";
import { HttpError } from "../errors.js";
import type { NotificationWebhookService } from "../services/notificationWebhookService.js";

function authorize(res: Response) {
  // Fail closed if mounted without the shared identity middleware.
  if (typeof res.locals.authorizeAdmin !== "function") throw new HttpError(403, "需要管理员权限", "ADMIN_REQUIRED");
  res.locals.authorizeAdmin();
}

/**
 * 入站转发：别的系统调用它，工作台再把内容转发到已配置的目标 webhook。
 *
 * 这个路由**刻意不挂在管理员鉴权中间件之后**：调用方是外部系统，只持有 relay token。
 * 安全性来自三点，而不是来自管理员身份：
 *   1. 必须持有管理员在页面上设置的 relay token（常量时间比较）；
 *   2. 目标地址与平台格式只来自服务端配置，请求体无法指定任何目标；
 *   3. 未启用时返回 404，不暴露该路径是否存在。
 *
 * 调用方形状不可控（纯文本、任意 JSON、表单、Slack/Discord/飞书原生载荷），因此这里
 * 用自定义中间件把请求体**始终按原始文本**读出来，而不是依赖全局 express.json：
 * 全局解析器只认 JSON，纯文本会被判 400，声明 JSON 但语法坏掉也会在进入路由前就 400。
 * 先读原始文本、再在领域层决定怎么解释，才能做到「不规则调用也接住」。
 */
const rawTextBody: RequestHandler = (req, res, next) => {
  if (req.body !== undefined) { next(); return; }  // 已被更早的解析器处理过
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    // 与全局 JSON 限制一致的 16MB 上限；超限立即停止读取，避免无界内存增长。
    if (size > 16 * 1024 * 1024) { res.status(413).json({ error: "请求内容过大", code: "REQUEST_TOO_LARGE" }); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on("end", () => { req.body = Buffer.concat(chunks).toString("utf8"); next(); });
  req.on("error", next);
};

export function createNotificationRelayRouter(service: NotificationWebhookService) {
  const router = Router();
  router.post("/api/v1/hooks/relay", rawTextBody, async (req, res) => {
    if (Object.keys(req.query).length) throw new HttpError(400, "入站转发不接受查询参数", "INVALID_RELAY_REQUEST");
    const header = req.get("Authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    res.set("Cache-Control", "no-store").json(await service.relay(req.body, bearer, req.get("Content-Type") ?? ""));
  });
  return router;
}

/** 运行事件聚合 Webhook 是系统单例设置：只有管理员能读写，普通用户入口不挂载。
 *  读接口只回掩码地址；测试会真实访问目标，但只发一条固定内容。 */
export function createNotificationWebhookRouter(service: NotificationWebhookService) {
  const router = Router();
  router.get("/api/v1/settings/notification-webhook", (req, res) => {
    authorize(res);
    if (!notificationWebhookQuery.safeParse(req.query).success) throw new HttpError(400, "此配置是系统单例，不接受查询参数", "INVALID_NOTIFICATION_WEBHOOK_REQUEST");
    res.set("Cache-Control", "no-store").json(service.read());
  });
  router.patch("/api/v1/settings/notification-webhook", (req, res) => {
    authorize(res);
    if (!notificationWebhookQuery.safeParse(req.query).success) throw new HttpError(400, "不接受查询参数", "INVALID_NOTIFICATION_WEBHOOK_REQUEST");
    res.set("Cache-Control", "no-store").json(service.update(req.body, () => authorize(res)));
  });
  router.post("/api/v1/settings/notification-webhook/test", async (req, res) => {
    authorize(res);
    if (!notificationWebhookQuery.safeParse(req.query).success) throw new HttpError(400, "不接受查询参数", "INVALID_NOTIFICATION_WEBHOOK_REQUEST");
    res.set("Cache-Control", "no-store").json(await service.test(() => authorize(res)));
  });
  // 管理员转发一条自定义内容：与入站转发共用同一投递逻辑，但用管理员身份而不是 relay token。
  // 这里也读原始文本：全局 express.json 已经解析过 JSON，纯文本则在这里接住。
  router.post("/api/v1/settings/notification-webhook/relay", rawTextBody, async (req, res) => {
    authorize(res);
    if (!notificationWebhookQuery.safeParse(req.query).success) throw new HttpError(400, "不接受查询参数", "INVALID_NOTIFICATION_WEBHOOK_REQUEST");
    res.set("Cache-Control", "no-store").json(await service.relayAsAdmin(req.body, () => authorize(res), req.get("Content-Type") ?? ""));
  });
  return router;
}
