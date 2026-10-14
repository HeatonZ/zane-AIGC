import { createGzip, createBrotliCompress, constants as zlibConstants } from "node:zlib";
import type { Request, RequestHandler, Response } from "express";

/** Below this, framing overhead and CPU cost outweigh the transfer saving. */
const DEFAULT_THRESHOLD_BYTES = 1024;

/**
 * Compressible content types. Deliberately an allowlist of the text shapes this
 * service serves: an allowlist cannot accidentally compress a media type added
 * later, whereas a "not in the skip list" rule silently would. Binary media
 * (image/*, video/*, audio/*, application/octet-stream, fonts) is therefore
 * never touched.
 */
const COMPRESSIBLE_TYPE = /^(?:application\/(?:json|manifest\+json|xml)|text\/|image\/svg\+xml|application\/javascript)/i;

/** Replies that must never be compressed, whatever the content type says. */
function mustNotCompress(request: Request, response: Response): boolean {
  // SSE streams unbuffered; compressing would delay events and defeat flushing.
  if (String(response.getHeader("Content-Type") ?? "").startsWith("text/event-stream")) return true;
  // An explicit no-transform instruction from the route or an upstream.
  if (/\bno-transform\b/i.test(String(response.getHeader("Cache-Control") ?? ""))) return true;
  // A partial body: compressing it would misreport the byte offsets.
  if (response.getHeader("Content-Range") !== undefined) return true;
  if (request.method === "HEAD") return true;
  if (response.getHeader("Content-Encoding") !== undefined) return true;
  return false;
}

/** Pick an encoding from Accept-Encoding, preferring brotli when the client accepts it. */
export function chooseEncoding(header: string): "br" | "gzip" | null {
  const accepted = new Map<string, number>();
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let quality = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key?.trim().toLowerCase() === "q") { const parsed = Number(value); quality = Number.isFinite(parsed) ? parsed : 0; }
    }
    accepted.set(name, quality);
  }
  const qualityOf = (name: string) => accepted.has(name) ? accepted.get(name) as number : accepted.get("*") ?? 0;
  if (qualityOf("br") > 0) return "br";
  if (qualityOf("gzip") > 0) return "gzip";
  return null;
}

/** Append a token to Vary without duplicating it. */
export function appendVary(current: unknown, token: string): string {
  const existing = String(current ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (!existing.some((part) => part.toLowerCase() === token.toLowerCase())) existing.push(token);
  return existing.join(", ");
}

export interface CompressionOptions { thresholdBytes?: number }

/**
 * Compress eligible response bodies with gzip or brotli.
 *
 * Eligibility is decided at the first `write`/`end`, before any body is buffered:
 *
 *   - Not an eligible text type (media, fonts, SSE, ranged partial content,
 *     `no-transform`) -> pass straight through. A large media file is therefore
 *     never buffered, and SSE keeps flushing as it always did.
 *   - Eligible -> buffer only until the threshold is crossed, then stream through
 *     a compressor. A body that ends before the threshold is sent untouched, so a
 *     tiny JSON reply never grows.
 *
 * `Vary: Accept-Encoding` is set on every eligible response, including ones this
 * client received uncompressed, so a shared cache cannot hand a compressed body
 * to a client that did not ask for it.
 *
 * The existing `ETag` is kept deliberately: Express emits a weak validator, and a
 * compressed body is semantically equivalent to its identity form, so conditional
 * revalidation (304) keeps working. Only `Content-Length` is rewritten, because it
 * describes the identity body.
 */
export function createCompressionMiddleware(options: CompressionOptions = {}): RequestHandler {
  const threshold = options.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
  return (request, response, next) => {
    const accept = request.headers["accept-encoding"];
    const encoding = typeof accept === "string" ? chooseEncoding(accept) : null;

    const originalWrite = response.write.bind(response);
    const originalEnd = response.end.bind(response);

    type Sink = ReturnType<typeof createGzip> | ReturnType<typeof createBrotliCompress>;
    let state: "undecided" | "passthrough" | "buffering" | "compressing" = "undecided";
    let sink: Sink | undefined;
    let pending: Buffer[] = [];
    let pendingLength = 0;
    let endCallback: (() => void) | undefined;

    const asBuffer = (chunk: unknown, chunkEncoding: unknown): Buffer => {
      if (Buffer.isBuffer(chunk)) return chunk;
      if (chunk === undefined || chunk === null) return Buffer.alloc(0);
      return Buffer.from(chunk as string, typeof chunkEncoding === "string" ? chunkEncoding as BufferEncoding : "utf8");
    };

    /** Is this response eligible at all (independent of this client's encoding)? */
    const eligible = (): boolean => {
      const status = response.statusCode;
      if (!(status >= 200 && status < 300)) return false;
      if (!COMPRESSIBLE_TYPE.test(String(response.getHeader("Content-Type") ?? ""))) return false;
      return !mustNotCompress(request, response);
    };

    const beginCompression = (): void => {
      response.setHeader("Content-Encoding", encoding as string);
      // Describes the identity body; the compressed length is unknown until it ends.
      response.removeHeader("Content-Length");
      sink = encoding === "br"
        ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
        : createGzip({ level: 6 });
      sink.on("data", (part: Buffer) => originalWrite(part));
      sink.on("end", () => originalEnd(endCallback as never));
      sink.on("error", () => { if (!response.headersSent) { response.removeHeader("Content-Encoding"); originalEnd(Buffer.concat(pending), endCallback as never); } });
      // If the client goes away, stop compressing.
      response.on("close", () => sink?.destroy());
      state = "compressing";
      if (pendingLength) { sink.write(Buffer.concat(pending)); pending = []; pendingLength = 0; }
    };

    /** Decide once, at the first body byte. */
    const decide = (streaming: boolean): void => {
      if (state !== "undecided") return;
      // Headers already flushed means we can no longer choose an encoding.
      if (response.headersSent || !eligible()) { state = "passthrough"; return; }
      // `res.sendFile` / static write the file in chunks with Content-Length
      // already set. Buffering that would hold a whole media file in memory, and
      // for a large text file it never completes, so pass it straight through.
      // A generated body (res.json/res.send) arrives as a single `end` instead,
      // and a hand-written chunked body has no Content-Length yet.
      if (streaming && response.getHeader("Content-Length") !== undefined) { state = "passthrough"; return; }
      // The body now depends on Accept-Encoding for every client.
      response.setHeader("Vary", appendVary(response.getHeader("Vary"), "Accept-Encoding"));
      if (!encoding) { state = "passthrough"; return; }
      state = "buffering";
    };

    response.write = ((chunk: unknown, chunkEncoding?: unknown, callback?: unknown): boolean => {
      decide(true);
      if (state === "passthrough") return (originalWrite as (...a: unknown[]) => boolean)(chunk, chunkEncoding, callback);
      if (state === "compressing") return (sink as Sink).write(asBuffer(chunk, chunkEncoding), callback as never);
      pending.push(asBuffer(chunk, chunkEncoding));
      pendingLength += pending.at(-1)!.length;
      if (pendingLength >= threshold) beginCompression();
      if (typeof callback === "function") (callback as () => void)();
      return true;
    }) as Response["write"];

    response.end = ((chunk?: unknown, chunkEncoding?: unknown, callback?: unknown): Response => {
      if (typeof chunk === "function") { callback = chunk; chunk = undefined; }
      else if (typeof chunkEncoding === "function") { callback = chunkEncoding; chunkEncoding = undefined; }
      endCallback = typeof callback === "function" ? callback as () => void : undefined;
      decide(false);
      if (state === "passthrough") return (originalEnd as (...a: unknown[]) => Response)(chunk, chunkEncoding, callback);

      if (chunk !== undefined && chunk !== null) {
        const buffer = asBuffer(chunk, chunkEncoding);
        if (state === "compressing") { (sink as Sink).end(buffer, endCallback as never); return response; }
        pending.push(buffer);
        pendingLength += buffer.length;
        // A single-shot body (`res.json` -> `res.send` -> `res.end`) must still be
        // compressed once it crosses the threshold. Without this check the largest
        // payloads -- the whole point of this middleware -- would be the only ones
        // never compressed.
        if (pendingLength >= threshold) beginCompression();
      }
      if (state === "compressing") { (sink as Sink).end(endCallback as never); return response; }
      // Never crossed the threshold: send the identity body untouched.
      if (!pendingLength) return (originalEnd as (...a: unknown[]) => Response)(endCallback as never);
      const body = Buffer.concat(pending, pendingLength);
      pending = []; pendingLength = 0;
      state = "passthrough";
      return (originalEnd as (...a: unknown[]) => Response)(body, endCallback as never);
    }) as Response["end"];

    next();
  };
}
