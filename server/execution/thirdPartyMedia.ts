import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { asRecord, parseWorkflowJsonPath } from "../domain/workflowValues.js";
import type { JsonValue, RunStep } from "../domain/types.js";
import { createRuntimeMediaValue, isRuntimeMediaValue } from "../runtimeValue.js";
import type { StepExecutionContext } from "./workflowExecutor.js";
import { THIRD_PARTY_MEDIA_LIMITS } from "./thirdPartyMediaContract.js";

const fieldName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.\[\]-]{0,127}$/);
const uploadSchema = z.array(z.object({ inputKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), fieldName }).strict()).max(16);
const responseSchema = z.object({ path: z.string().min(1).max(512).default("data"), base64Field: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).default("b64_json"), expectedCount: z.int().min(1).max(16).optional() }).strict();
export { multipartImagesValueSchema, responseImagesValueSchema, THIRD_PARTY_MEDIA_LIMITS } from "./thirdPartyMediaContract.js";
const invalid = (message: string): never => { throw new HttpError(400, message, "INVALID_HTTP_REQUEST_CONFIG"); };
const invalidImage = (): never => { throw new HttpError(400, "第三方图片输入必须是当前运行内已授权归档的PNG/JPEG/WebP图片，不读取任意路径或远程预览地址", "HTTP_REQUEST_MEDIA_UNSUPPORTED"); };
const invalidResponse = (): never => { throw new HttpError(502, "第三方图片响应的列表、数量、base64或图片格式无效", "INVALID_THIRD_PARTY_IMAGE"); };

export function thirdPartyMediaConfig(step: RunStep) {
  const config = step.capabilityConfig ?? {};
  const bodyFormat = config.bodyFormat ?? "json";
  if (bodyFormat !== "json" && bodyFormat !== "multipart") invalid("正文格式必须为json或multipart");
  const upload = uploadSchema.safeParse(config.multipartImages ?? []);
  if (!upload.success) return invalid("图片上传映射格式无效");
  const keys = new Set((step.inputs ?? []).map(input => input.key));
  if (upload.data.some(binding => !keys.has(binding.inputKey))) invalid("图片上传映射只能引用已声明的步骤输入");
  if (upload.data.length && bodyFormat !== "multipart") invalid("图片上传映射仅支持multipart正文");
  if (bodyFormat === "multipart" && (config.method ?? "POST") === "GET") invalid("GET不能使用multipart正文");
  if (bodyFormat === "multipart" && config.bodyTemplate != null) {
    const fields = asRecord(config.bodyTemplate);
    if (!fields || Object.entries(fields).some(([key, value]) => !fieldName.safeParse(key).success || value === null || typeof value === "object")) invalid("multipart正文模板只能包含标量表单字段");
    if (upload.data.some(binding => Object.hasOwn(fields!, binding.fieldName))) invalid("图片上传字段不能与普通表单字段重名");
  }
  const response = config.responseImages === undefined ? undefined : responseSchema.safeParse(config.responseImages);
  if (response && !response.success) invalid("图片响应映射格式无效");
  const responseImages = response?.success ? response.data : undefined;
  if (responseImages) {
    try { if (parseWorkflowJsonPath(responseImages.path).some(key => ["__proto__", "prototype", "constructor"].includes(String(key)))) invalid("图片响应路径包含保留字段"); } catch { invalid("图片响应列表路径无效"); }
    if (!step.outputs?.some(output => output.key === "images" && output.type === "image_list")) invalid("启用图片响应必须声明images图片列表输出");
  }
  return { bodyFormat, uploads: upload.data, responseImages };
}

async function imageFormat(bytes: Buffer): Promise<"png" | "jpeg" | "webp" | undefined> {
  try {
    const meta = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
    if (!meta.width || !meta.height || meta.width * meta.height > 40_000_000 || (meta.pages ?? 1) !== 1) return undefined;
    if (meta.format === "png" || meta.format === "jpeg" || meta.format === "webp") {
      // Force decoding too: a valid header alone is not a valid deliverable image.
      await sharp(bytes, { limitInputPixels: 40_000_000 }).stats();
      return meta.format;
    }
  } catch { /* Report a stable error without paths or upstream content. */ }
  return undefined;
}
function isInside(directory: string, filename: string) {
  const relative = path.relative(directory, filename);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

async function authorizedImagePath(context: StepExecutionContext, item: { locator: { type: string; value?: string } }) {
  const runDirectory = await realpath(context.artifacts.directory).catch(() => invalidImage());
  let source: string;
  if (item.locator.type === "path" && typeof item.locator.value === "string") source = item.locator.value;
  else if (item.locator.type === "url" && typeof item.locator.value === "string") {
    const match = new RegExp("^/api/(?:v1|workflows)/runs/" + context.runId.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&") + "/media/([A-Za-z0-9_-][A-Za-z0-9._-]*)$").exec(item.locator.value);
    if (!match) return invalidImage();
    source = path.join(runDirectory, "outputs", "media", match[1]!);
  } else return invalidImage();
  const filename = await realpath(source).catch(() => invalidImage());
  if (!isInside(runDirectory, filename)) invalidImage();
  return filename;
}

export async function thirdPartyMultipart(context: StepExecutionContext, fields: JsonValue, inputs: Record<string, JsonValue>, signal: AbortSignal) {
  const { uploads } = thirdPartyMediaConfig(context.step);
  const object = asRecord(fields);
  if (!object || Object.values(object).some(value => value === null || !["string", "number", "boolean"].includes(typeof value))) invalid("multipart渲染结果必须是标量字段对象");
  const boundary = "zane-" + randomUUID(); const chunks: Buffer[] = []; let size = 0; let count = 0;
  const append = (value: string | Buffer) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); size += bytes.length; if (size > THIRD_PARTY_MEDIA_LIMITS.requestBytes) throw new HttpError(400, "第三方multipart正文超过64MB", "HTTP_REQUEST_BODY_TOO_LARGE"); chunks.push(bytes); };
  for (const [key, value] of Object.entries(object!)) append('--' + boundary + '\r\nContent-Disposition: form-data; name="' + key + '"\r\n\r\n' + String(value) + '\r\n');
  const directory = await realpath(context.artifacts.directory).catch(() => invalidImage());
  for (const binding of uploads) {
    const media = inputs[binding.inputKey];
    if (!isRuntimeMediaValue(media) || media.mediaKind !== "image" || !media.items.length) return invalidImage();
    for (const item of media.items) {
      signal.throwIfAborted();
      if (++count > THIRD_PARTY_MEDIA_LIMITS.images || item.kind !== "image" || (item.locator.type !== "path" && item.locator.type !== "url")) return invalidImage();
      const filename = await authorizedImagePath(context, item);
      if (!isInside(directory, filename)) invalidImage();
      const info = await stat(filename);
      if (!info.isFile() || info.size > THIRD_PARTY_MEDIA_LIMITS.imageBytes) invalidImage();
      const bytes = await readFile(filename, { signal });
      if (bytes.length > THIRD_PARTY_MEDIA_LIMITS.imageBytes) invalidImage();
      const format = await imageFormat(bytes); if (!format) invalidImage();
      append('--' + boundary + '\r\nContent-Disposition: form-data; name="' + binding.fieldName + '"; filename="image-' + count + '.' + format + '"\r\nContent-Type: image/' + format + '\r\n\r\n');
      append(bytes); append('\r\n');
    }
  }
  append('--' + boundary + '--\r\n'); signal.throwIfAborted();
  return { body: Buffer.concat(chunks), contentType: 'multipart/form-data; boundary=' + boundary };
}

export async function thirdPartyResponseImages(context: StepExecutionContext, response: JsonValue, signal: AbortSignal): Promise<Record<string, JsonValue>> {
  const config = thirdPartyMediaConfig(context.step).responseImages;
  if (!config) return { response };
  let selected: unknown = response;
  for (const key of parseWorkflowJsonPath(config.path)) {
    if (!selected || typeof selected !== "object" || !Object.hasOwn(selected, key)) invalidResponse();
    selected = (selected as Record<string | number, unknown>)[key];
  }
  if (!Array.isArray(selected) || !selected.length || selected.length > THIRD_PARTY_MEDIA_LIMITS.images || config.expectedCount !== undefined && selected.length !== config.expectedCount) invalidResponse();
  const decoded: Array<{ bytes: Buffer; format: string; record: Record<string, unknown> }> = [];
  for (const raw of selected as unknown[]) {
    const item = asRecord(raw); const encoded = item?.[config.base64Field];
    if (typeof encoded !== "string" || !encoded.length || encoded.length > Math.ceil(THIRD_PARTY_MEDIA_LIMITS.imageBytes / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalidResponse();
    const bytes = Buffer.from(encoded as string, "base64");
    if (!bytes.length || bytes.length > THIRD_PARTY_MEDIA_LIMITS.imageBytes || bytes.toString("base64") !== encoded) invalidResponse();
    const format = await imageFormat(bytes); if (!format) invalidResponse();
    signal.throwIfAborted(); decoded.push({ bytes, format: format!, record: item! });
  }
  const runDirectory = await realpath(context.artifacts.directory);
  // Write directly to the run's canonical output archive.  Keeping the
  // response under a private side directory would leave an absolute local
  // path in persisted results, which output-media and media-export must
  // intentionally reject.
  const outputRoot = path.join(runDirectory, "outputs", "media");
  const directory = await mkdir(outputRoot, { recursive: true }).then(() => realpath(outputRoot));
  if (!isInside(runDirectory, directory)) invalidResponse();
  const images: string[] = [];
  try {
    for (const [index, item] of decoded.entries()) {
      signal.throwIfAborted(); const filename = path.join(directory, randomUUID() + "." + item.format); const temporary = filename + "." + randomUUID() + ".tmp";
      try { await writeFile(temporary, item.bytes, { flag: "wx", signal }); signal.throwIfAborted(); await rename(temporary, filename); images.push(filename); }
      finally { await rm(temporary, { force: true }); }
      item.record[config.base64Field] = { omitted: true, reason: "decoded_to_images", outputKey: "images", index };
    }
    signal.throwIfAborted();
  } catch (error) {
    // A later image can fail or the run can be cancelled after earlier files
    // were atomically published. Roll those files back so failed steps do not
    // leave unreferenced output media behind.
    await Promise.all(images.map(filename => rm(filename, { force: true })));
    throw error;
  }
  // The runtime media normalizer treats bare strings as filesystem paths unless
  // they use an absolute URL scheme.  Wrap the canonical relative API URLs in
  // the explicit `{ url }` shape so persisted results remain portable and the
  // multipart authorizer can resolve them back to this run's archive.
  return { response, images: createRuntimeMediaValue("image", images.map(filename => ({ url: "/api/v1/runs/" + context.runId + "/media/" + encodeURIComponent(path.basename(filename)) }))) };
}
