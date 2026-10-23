import { readdir } from "node:fs/promises";
import path from "node:path";
import type { RequestHandler } from "express";
import { appendVary, chooseEncoding } from "./compression.js";

/** 已构建静态文件的预压缩变体；`br`/`gz` 为绝对路径。 */
export interface StaticAssetEntry {
  br?: string;
  gzip?: string;
}

export type StaticAssetIndex = ReadonlyMap<string, StaticAssetEntry>;

const variantSuffixes = [".br", ".gz"] as const;

/**
 * Index precompressed siblings (`app.js.br`, `app.js.gz`) by their original
 * relative path.
 *
 * Only files that actually have a variant are indexed, so a request that cannot
 * be served precompressed falls through to `express.static` with no extra
 * filesystem probe. The index is built once from the release directory: `dist`
 * is replaced wholesale by an upgrade, which also restarts this process, so a
 * stale index cannot outlive the files it points at.
 */
export async function buildStaticAssetIndex(directory: string): Promise<StaticAssetIndex> {
  const index = new Map<string, StaticAssetEntry>();
  const walk = async (current: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      // A missing release directory is a valid state in development.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(path.join(current, entry.name), relative); continue; }
      if (!entry.isFile()) continue;
      const suffix = variantSuffixes.find(candidate => entry.name.endsWith(candidate));
      if (!suffix) continue;
      const original = relative.slice(0, -suffix.length);
      const record = index.get(original) ?? {};
      if (suffix === ".br") record.br = path.join(current, entry.name);
      else record.gzip = path.join(current, entry.name);
      index.set(original, record);
    }
  };
  await walk(directory, "");
  return index;
}

/** Hashed Vite output lives under `assets/`; those names change with their content. */
export function isImmutableAsset(relative: string): boolean {
  return relative.replaceAll("\\", "/").startsWith("assets/");
}

/**
 * Serve a precompressed variant when the client accepts one.
 *
 * This runs before `express.static`, which would otherwise always send the
 * identity body: the global compression middleware deliberately passes bodies
 * that already carry a `Content-Length` straight through (it must not buffer a
 * media file), and every static file does. Precompressing at build time keeps
 * that rule intact while still cutting the wire size of the app bundle.
 *
 * The response keeps its original `Content-Type`; `Content-Encoding` describes
 * the transfer representation. `Vary: Accept-Encoding` is set so a shared cache
 * cannot hand a brotli body to a client that only accepts gzip. Conditional
 * requests work unchanged because `sendFile` derives the ETag from the variant
 * that is actually sent.
 */
export function createStaticAssetMiddleware(index: StaticAssetIndex): RequestHandler {
  return (request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") { next(); return; }
    // A ranged request must address the identity bytes, not a compressed stream.
    if (request.headers.range !== undefined) { next(); return; }
    const accept = request.headers["accept-encoding"];
    if (typeof accept !== "string") { next(); return; }
    const encoding = chooseEncoding(accept);
    if (!encoding) { next(); return; }

    let pathname: string;
    try { pathname = decodeURIComponent(request.path); }
    catch { next(); return; }
    if (pathname.includes("\0")) { next(); return; }
    // Normalise before lookup; the index itself is the containment boundary, so
    // a traversal attempt can only miss, never resolve outside the release.
    const key = path.posix.normalize(pathname).replace(/^\/+/, "");
    if (!key || key === "." || key.startsWith("../") || key === "..") { next(); return; }
    const entry = index.get(key);
    if (!entry) { next(); return; }
    const file = encoding === "br" ? entry.br : entry.gzip;
    if (!file) { next(); return; }

    response.setHeader("Content-Encoding", encoding);
    response.setHeader("Vary", appendVary(response.getHeader("Vary"), "Accept-Encoding"));
    // `sendFile` derives Content-Type from the variant's `.br`/`.gz` suffix, so
    // the original name has to set it first. Only the extension may be passed:
    // `res.type()` treats any string containing "/" as a complete MIME type.
    response.type(path.extname(key));
    // This path bypasses `express.static`, so it has to reproduce its caching
    // decision: hashed bundle names are immutable, everything else keeps
    // revalidating (Express's default) instead of falling into heuristic caching.
    if (isImmutableAsset(key)) response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    else if (!response.getHeader("Cache-Control")) response.setHeader("Cache-Control", "public, max-age=0");
    response.sendFile(file, { cacheControl: false, dotfiles: "allow" }, error => { if (error) next(error); });
  };
}
