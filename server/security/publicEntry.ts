import express, { type Express, type RequestHandler } from "express";
import { aiOperations } from "../ai/operations.js";
import { HttpError } from "../errors.js";

export { PUBLIC_ENTRY_CONTRACT } from "./contracts.js";

const pathPattern = (template: string) => new RegExp("^" + template.split("/").map(segment => /^\{[^}]+\}$/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/") + "/?$");
const userOperations = aiOperations.filter(operation => operation.access === "authenticated").map(operation => ({ method: operation.method, pattern: pathPattern(operation.path) }));
const read = (method: string) => method === "GET" || method === "HEAD";

/** Explicit allowlist, not a /self prefix bypass. Authentication and ownership remain downstream. */
export function publicRequestAllowed(method: string, rawPath: string): boolean {
  let decoded: string;
  try { decoded = decodeURIComponent(rawPath); } catch { return false; }
  if (decoded.includes("\\") || decoded.includes("%") || decoded.split("/").some(segment => segment === "." || segment === "..") || /%2f/i.test(rawPath)) return false;
  if (read(method) && ["/", "/app", "/app/", "/index.html"].includes(rawPath)) return true;
  if (read(method) && (/^\/assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css|svg|png|jpe?g|webp|gif|ico|woff2?|ttf)$/.test(rawPath) || /^\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:svg|png|jpe?g|webp|ico)$/.test(rawPath))) return true;
  if (read(method) && ["/api/auth/status", "/api/v1/ai", "/api/v1/ai/guide", "/api/v1/ai/openapi.json"].includes(rawPath)) return true;
  if (method === "POST" && ["/api/auth/login", "/api/v1/self/logout"].includes(rawPath)) return true;
  if (userOperations.some(operation => (operation.method === method || (operation.method === "GET" && method === "HEAD")) && operation.pattern.test(rawPath))) return true;
  if (!read(method)) return false;
  return /^\/api\/v1\/runs\/[^/]+\/(?:output-media|media\/[A-Za-z0-9_-][A-Za-z0-9._-]*|media\.zip)\/?$/.test(rawPath)
    || /^\/api\/v1\/assets\/[^/]+\/versions\/[1-9][0-9]*\/media\/?$/.test(rawPath);
}
export const publicEntryGuard: RequestHandler = (req, res, next) => {
  if (!res.locals.publicUserOnly) { next(); return; }
  res.set("Cache-Control", "no-store");
  if (!publicRequestAllowed(req.method, req.path)) { next(new HttpError(404, "此入口不提供该功能", "PUBLIC_ENDPOINT_UNAVAILABLE")); return; }
  if (req.path === "/" && (req.method === "GET" || req.method === "HEAD")) { res.redirect(302, "/app"); return; }
  next();
};
export function createPublicUserApp(sharedApp: Express) {
  const publicApp = express();
  publicApp.disable("x-powered-by");
  publicApp.use((_req, res, next) => { res.locals.publicUserOnly = true; next(); });
  publicApp.use(sharedApp);
  return publicApp;
}
export function validatePublicListener(privateHost: string, privatePort: number, publicPort: number | undefined) {
  if (publicPort === undefined) return;
  if (!["127.0.0.1", "::1", "localhost"].includes(privateHost)) throw new Error("用户专用入口开启时，API_HOST 必须为回环地址；只能公开用户入口，不能同时公开管理端口");
  if (!Number.isInteger(publicPort) || publicPort < 0 || publicPort > 65535 || (publicPort !== 0 && publicPort === privatePort)) throw new Error("ZANE_PUBLIC_USER_PORT 必须为不同于 API_PORT 的有效端口（测试可用0）");
}
