import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { asRecord } from "./domain/workflowValues.js";
import { throwIfAborted } from "./execution/cancellation.js";

const maxReferenceBytes = 32 * 1024 * 1024;
const imageTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".bmp": "image/bmp", ".gif": "image/gif",
};
const extensions: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/bmp": ".bmp", "image/gif": ".gif",
};

async function download(url: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]) });
  if (!response.ok) throw new Error("读取 H3 参考图失败（HTTP " + response.status + "）");
  if (Number(response.headers.get("content-length")) > maxReferenceBytes) {
    await response.body?.cancel();
    throw new Error("H3 单张参考图不能超过 32 MiB");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  if (!response.body) throw new Error("H3 参考图内容为空");
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxReferenceBytes) {
        await reader.cancel();
        throw new Error("H3 单张参考图不能超过 32 MiB");
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { reader.releaseLock(); }
  return { bytes: Buffer.concat(chunks), contentType: (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() };
}

/** Accept the same ordered media values as scene inputs and Hermes attachments. */
export async function readH3ReferenceImage(value: unknown, baseUrl: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const item = asRecord(value);
  let filename = typeof item?.filename === "string" ? path.basename(item.filename) : "reference.png";
  let bytes: Buffer;
  let contentType = "";
  if (typeof item?.filename === "string" && (item.type === "input" || item.type === "output")) {
    const subfolder = typeof item.subfolder === "string" ? item.subfolder : "";
    if (!item.filename || /[\\/]/.test(item.filename) || item.filename === "." || item.filename === ".." || subfolder.startsWith("/") || subfolder.startsWith("\\") || subfolder.split(/[\\/]/).some((part) => part === "." || part === "..")) {
      throw new Error("H3 参考图附件路径无效");
    }
    const query = new URLSearchParams({ filename: item.filename, subfolder, type: item.type });
    ({ bytes, contentType } = await download(baseUrl + "/view?" + query, signal));
  } else {
    const source = typeof value === "string" ? value.trim() : typeof item?.path === "string" ? item.path.trim() : typeof item?.url === "string" ? item.url.trim() : "";
    if (!source) throw new Error("H3 参考图缺少路径、URL 或 ComfyUI 附件");
    if (/^data:/i.test(source)) {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(source);
      if (!match || match[2].length > Math.ceil(maxReferenceBytes / 3) * 4 + 1024) throw new Error("H3 参考图 data URL 无效或超过 32 MiB");
      contentType = match[1].toLowerCase();
      bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
      filename = "reference" + (extensions[contentType] ?? ".png");
    } else if (/^https?:\/\//i.test(source)) {
      ({ bytes, contentType } = await download(source, signal));
      filename = path.basename(decodeURIComponent(new URL(source).pathname)) || "reference" + (extensions[contentType] ?? ".png");
      if (!imageTypes[path.extname(filename).toLowerCase()] && extensions[contentType]) filename += extensions[contentType];
    } else {
      const resolved = path.resolve(source);
      const info = await stat(resolved).catch(() => undefined);
      if (!info?.isFile()) throw new Error("无法读取 H3 参考图文件：" + source);
      if (info.size > maxReferenceBytes) throw new Error("H3 单张参考图不能超过 32 MiB");
      bytes = await readFile(resolved, { signal });
      filename = path.basename(resolved);
    }
  }
  const declaredType = imageTypes[path.extname(filename).toLowerCase()];
  if (!declaredType) throw new Error("H3 参考图只支持 PNG、JPG、WEBP、BMP 或 GIF");
  if (!bytes.length || bytes.length > maxReferenceBytes) throw new Error("H3 参考图内容为空或超过 32 MiB");
  return { bytes, filename, contentType: declaredType };
}
