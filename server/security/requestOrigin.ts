import { HttpError } from "../errors.js";
import { publicOrigins, trustProxySetting } from "../config.js";

/**
 * Behind a TLS-terminating reverse proxy (Cloudflare Tunnel, nginx) the browser sends
 * `Origin: https://public.example` while the app sees the loopback回源 address over plain
 * HTTP. Trusting only explicitly configured origins keeps that case working without
 * weakening the same-origin fallback or accepting arbitrary forwarded headers.
 */

/** Only the two properties origin checking needs; avoids Express's overloaded `get` signatures. */
export interface OriginCheckableRequest { protocol: string; get(name: string): string | undefined }

/** Normalize a public origin to `scheme://host[:port]`, dropping path, trailing slash and case. */
export function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return "";
    return parsed.protocol + "//" + parsed.host.toLowerCase();
  } catch {
    return "";
  }
}

export const configuredPublicOrigins: readonly string[] = publicOrigins;

/**
 * A request without Origin (server-to-server, AI/CLI clients) keeps the existing behavior.
 * A configured public origin is accepted verbatim; anything else must match the
 * reconstructed protocol+Host same-origin pair, so this never becomes a blanket bypass.
 */
export function requestOriginAllowed(req: OriginCheckableRequest, allowed: readonly string[] = configuredPublicOrigins): boolean {
  const origin = req.get("Origin");
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (normalized && allowed.includes(normalized)) return true;
  return origin === req.protocol + "://" + req.get("Host");
}

export function assertRequestOrigin(req: OriginCheckableRequest, allowed?: readonly string[]) {
  if (requestOriginAllowed(req, allowed)) return;
  throw new HttpError(403, "请求来源无效", "INVALID_REQUEST_ORIGIN");
}

/** Express trust-proxy setting, or undefined to keep proxy headers untrusted. */
export { trustProxySetting };
