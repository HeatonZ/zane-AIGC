import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import express from "express";
import { randomUUID } from "node:crypto";

import { HttpError } from "../errors.js";

// The production config is read at import time, so the proxy/public-origin settings must
// exist before server/config.js (and therefore requestOrigin.js) is loaded.
process.env.ZANE_TRUST_PROXY = "loopback";
process.env.ZANE_PUBLIC_ORIGIN = "https://aigc.zsfzsf.dpdns.org";

const { normalizeOrigin, requestOriginAllowed, configuredPublicOrigins } = await import("./requestOrigin.js");
const { aiHarness } = await import("../testing/aiSupport.js");
const { AccessService } = await import("../services/accessService.js");
const { createAuthRouter } = await import("../api/accessRoutes.js");

const publicOrigin = "https://aigc.zsfzsf.dpdns.org";
const password = "proxy-origin-isolation-2026";

const request = (headers: Record<string, string>, protocol = "http") => ({
  protocol,
  get: (name: string): string | undefined => headers[name.toLowerCase()] ?? headers[name],
});

test("配置解析：公开来源被规范化为精确来源，且与可信代理同时生效", () => {
  assert.deepEqual([...configuredPublicOrigins], [publicOrigin]);
});

test("来源规范化：只接受无路径的 http/https 来源，拒绝伪装形态", () => {
  assert.equal(normalizeOrigin(publicOrigin + "/"), publicOrigin);
  assert.equal(normalizeOrigin("HTTPS://AIGC.ZSFZSF.DPDNS.ORG"), publicOrigin);
  assert.equal(normalizeOrigin("https://aigc.zsfzsf.dpdns.org:8443"), "https://aigc.zsfzsf.dpdns.org:8443");
  assert.equal(normalizeOrigin("javascript:alert(1)"), "");
  assert.equal(normalizeOrigin("https://user@aigc.zsfzsf.dpdns.org"), "");
  assert.equal(normalizeOrigin("https://aigc.zsfzsf.dpdns.org/app"), "");
  assert.equal(normalizeOrigin(""), "");
  assert.equal(normalizeOrigin("not a url"), "");
  // 后缀拼接是合法但不同的来源：规范化保留它，靠白名单精确匹配拒绝，而不是靠字符串黑名单。
  assert.equal(normalizeOrigin("https://aigc.zsfzsf.dpdns.org.evil.example"), "https://aigc.zsfzsf.dpdns.org.evil.example");
  assert.notEqual(normalizeOrigin("https://aigc.zsfzsf.dpdns.org.evil.example"), normalizeOrigin(publicOrigin));
  // 前缀/端口变体同样不能冒充配置的来源。
  assert.notEqual(normalizeOrigin("http://aigc.zsfzsf.dpdns.org"), publicOrigin);
  assert.notEqual(normalizeOrigin("https://aigc.zsfzsf.dpdns.org:8443"), publicOrigin);
  // https 默认端口被规范化为同一来源，这是正确且不降低安全性的行为。
  assert.equal(normalizeOrigin("https://aigc.zsfzsf.dpdns.org:443"), publicOrigin);
});

test("来源校验：配置白名单命中放行，未知来源仍然拒绝，缺省 Origin 保持放行", () => {
  const allowed = [publicOrigin];
  // 代理回源看到的 Host/协议与浏览器 Origin 不同，命中配置白名单。
  assert.equal(requestOriginAllowed(request({ origin: publicOrigin, host: "127.0.0.1:8800" }), allowed), true);
  // 无 Origin 的服务端/AI 客户端保持原有放行行为。
  assert.equal(requestOriginAllowed(request({ host: "127.0.0.1:8800" }), allowed), true);
  // 未配置来源仍然拒绝，不能因为加了白名单就变成任意放行。
  assert.equal(requestOriginAllowed(request({ origin: "https://evil.example", host: "127.0.0.1:8800" }), allowed), false);
  // 同源回退：直连私有入口时 protocol+Host 匹配依然有效。
  assert.equal(requestOriginAllowed(request({ origin: "http://127.0.0.1:8800", host: "127.0.0.1:8800" }), allowed), true);
  // 伪造 X-Forwarded-Proto 不能在没有真实匹配的情况下骗过校验。
  assert.equal(requestOriginAllowed(request({ origin: "https://evil.example", host: "aigc.zsfzsf.dpdns.org", "x-forwarded-proto": "https" }), allowed), false);
});

test("登录：Cloudflare Tunnel 式回源（https Origin + loopback Host + X-Forwarded-Proto）可登录且下发 Secure Cookie", async (t: TestContext) => {
  const h = await aiHarness(t);
  const access = new AccessService(h.store, h.workspace, "");
  await access.create({ userId: randomUUID(), username: "tunneluser", displayName: "隧道用户", password, role: "user" }, false);

  const app = express();
  app.set("trust proxy", "loopback"); // 与 ZANE_TRUST_PROXY=loopback 一致
  app.use(express.json());
  app.use(createAuthRouter(access));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR" }));

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;

  const login = async (origin: string | undefined) => {
    const response = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: publicOrigin,
        Origin: origin ?? "",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-For": "203.0.113.10",
      },
      body: JSON.stringify({ username: "tunneluser", password }),
    });
    return { response, data: await response.json() as Record<string, unknown> };
  };

  const allowed = await login(publicOrigin);
  assert.equal(allowed.response.status, 200, "配置公网 Origin 后经代理登录必须成功");
  const cookie = allowed.response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /zane_session=/);
  assert.match(cookie, /Secure/, "HTTPS 入口下发 Secure Cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  // 未在白名单内的来源仍然必须被拒绝，不能因信任代理而放开。
  const rejected = await login("https://evil.example");
  assert.equal(rejected.response.status, 403);
  assert.equal(rejected.data.code, "INVALID_REQUEST_ORIGIN");
});
