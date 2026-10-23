import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { mediaContentTypeExtension } from "../artifacts/runArtifacts.js";
import { resolveComfyInputBindingTarget } from "../comfyuiBindingTarget.js";
import { comfyNodeInputSchema } from "../comfyuiInputSchema.js";
import { specializeComfyStaticSwitches } from "../comfyuiStaticSwitches.js";
import type { ComfyPromptTransform } from "../capabilities/package.js";
import { defaultWorkflowTimeoutMinutes, workflowTimeoutLabel, workflowTimeoutMs } from "../config.js";
import type { JsonValue, RunComfyBinding, RunInputField, RunStep } from "../domain/types.js";
import { asRecord, externalizeRuntimeValue, normalizeMediaList, toJsonValue } from "../domain/workflowValues.js";
import { cancellationError, delayWithAbort, throwIfAborted } from "./cancellation.js";
import { convertComfyUIWorkflow, comfyAutogrowImageInputNames, fetchComfyUIJson } from "./comfyWorkflow.js";
import { readComfyAudioSource } from "./comfyAudioSource.js";
import { resolveComfyInputBindings } from "./comfyBindings.js";
import { bindComfyAudioPaths, groupComfyMediaBindings } from "./comfyMediaBindings.js";
import { fetchMediaResponse, mimeTypeForMediaPath } from "./hermesStep.js";
import { log } from "../observability/logger.js";
import { mediaKindFromWorkflowType, createRuntimeMediaValue } from "../runtimeValue.js";
import type { StepExecutionContext } from "./workflowExecutor.js";

function comfyApiErrorMessage(body: unknown, fallback: string) {
  const root = asRecord(body);
  const error = asRecord(root?.error);
  const parts = [
    typeof root?.error === "string" ? root.error : undefined,
    typeof error?.message === "string" ? error.message : undefined,
    typeof error?.details === "string" ? error.details : undefined,
    typeof error?.type === "string" ? error.type : undefined,
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
  const nodeErrors = asRecord(root?.node_errors);
  if (nodeErrors && Object.keys(nodeErrors).length) {
    const detail = Object.entries(nodeErrors).map(([nodeId, value]) => {
      const node = asRecord(value);
      const messages = [
        typeof node?.errors === "string" ? node.errors : undefined,
        typeof node?.message === "string" ? node.message : undefined,
        typeof node?.details === "string" ? node.details : undefined,
      ].filter((item): item is string => Boolean(item));
      return `${nodeId}: ${messages.join("；") || JSON.stringify(value)}`;
    }).join("；");
    if (detail) parts.push(`节点错误：${detail}`);
  }
  return parts.length ? parts.join("；") : fallback;
}

async function fetchJson(url: string, init: RequestInit = {}, parentSignal?: AbortSignal, timeoutMs = workflowTimeoutMs(defaultWorkflowTimeoutMinutes), timeoutLabelMinutes = timeoutMs / 60 / 1000): Promise<unknown> {
  const controller = new AbortController();
  const initSignal = init.signal;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromParent = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  if (initSignal) {
    if (initSignal.aborted) controller.abort();
    else initSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      throw new Error(comfyApiErrorMessage(body, `服务返回 ${response.status}`));
    }
    return body;
  } catch (error) {
    if (timedOut && !parentSignal?.aborted && !initSignal?.aborted) {
      throw new Error(`ComfyUI 请求超时（单步上限 ${workflowTimeoutLabel(timeoutLabelMinutes)}）`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
    initSignal?.removeEventListener("abort", abortFromParent);
  }
}

function workflowApiPath(filename: string) {
  if (!filename || filename.includes("..") || filename.startsWith("/") || filename.includes("\\")) throw new Error("ComfyUI 工作流文件名无效");
  return `workflows/${filename}`.split("/").map((segment) => encodeURIComponent(segment)).join("%252F");
}

async function interruptComfyUI(baseUrl: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(`${baseUrl}/interrupt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
  } catch {
    // Cancellation should still finish locally when ComfyUI is unreachable.
  } finally {
    clearTimeout(timeout);
  }
}

async function readWorkflowApiGraph(payload: unknown, baseUrl?: string, signal?: AbortSignal) {
  const conversion = await convertComfyUIWorkflow(payload, baseUrl, signal);
  const graph = conversion.graph;
  if (!Object.keys(graph).length) {
    if (conversion.format === "ui") throw new Error("ComfyUI 画布工作流中没有可转换的节点");
    throw new Error("ComfyUI 工作流内容格式无效，未找到可执行节点");
  }
  return graph;
}

function comfyOutputMedia(value: unknown) {
  const items: unknown[] = [];
  const collect = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(collect);
      return;
    }
    if (candidate !== undefined && candidate !== null) items.push(candidate);
  };
  collect(value);
  return items.flatMap((item) => {
    const media = asRecord(item);
    return media && typeof media.filename === "string" ? [{
      filename: media.filename,
      subfolder: typeof media.subfolder === "string" ? media.subfolder : "",
      type: typeof media.type === "string" ? media.type : "output",
      url: `/api/comfyui/view?${new URLSearchParams({
        filename: media.filename,
        subfolder: typeof media.subfolder === "string" ? media.subfolder : "",
        type: typeof media.type === "string" ? media.type : "output",
      })}`,
    }] : [];
  });
}

function isComfyVideoMedia(media: { filename: string }) {
  return [".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"].includes(path.extname(media.filename).toLowerCase());
}

function isComfyAudioMedia(media: { filename: string }) {
  return [".aac", ".aif", ".aiff", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"].includes(path.extname(media.filename).toLowerCase());
}

function isComfyImageMedia(media: { filename: string }) {
  return !isComfyVideoMedia(media) && !isComfyAudioMedia(media);
}

function readComfyOutputValue(history: unknown, promptId: string, nodeId: string, property: string, type: string): JsonValue {
  const prompt = asRecord(history)?.[promptId];
  const outputs = asRecord(asRecord(prompt)?.outputs);
  const nodeOutput = asRecord(outputs?.[nodeId]);
  const uiOutput = asRecord(nodeOutput?.ui);
  let resolvedNodeId = nodeOutput ? nodeId : undefined;
  const directOutputProperty = nodeOutput && Object.prototype.hasOwnProperty.call(nodeOutput, property)
    ? property
    : Object.keys(nodeOutput ?? {}).find((name) => name.toLowerCase() === property.toLowerCase());
  const uiOutputProperty = uiOutput && Object.prototype.hasOwnProperty.call(uiOutput, property)
    ? property
    : Object.keys(uiOutput ?? {}).find((name) => name.toLowerCase() === property.toLowerCase());
  let outputProperty = directOutputProperty ?? uiOutputProperty;
  let outputRecord = directOutputProperty ? nodeOutput : uiOutput;
  let propertyValue = outputProperty ? outputRecord?.[outputProperty] : undefined;
  let media = comfyOutputMedia(propertyValue);
  const mediaKind = mediaKindFromWorkflowType(type);
  const isExpectedMedia = mediaKind === "video" ? isComfyVideoMedia : mediaKind === "audio" ? isComfyAudioMedia : isComfyImageMedia;
  if (mediaKind && !media.some(isExpectedMedia) && nodeOutput) {
    const videoCandidates = Object.entries(nodeOutput).flatMap(([name, value]) => {
      const candidateMedia = comfyOutputMedia(value).filter(isExpectedMedia);
      return candidateMedia.length ? [{ name, value, media: candidateMedia }] : [];
    });
    if (videoCandidates.length === 1) {
      outputProperty = videoCandidates[0].name;
      propertyValue = videoCandidates[0].value;
      media = videoCandidates[0].media;
    } else if (videoCandidates.length > 1) {
      throw new Error(`ComfyUI 节点 ${nodeId} 找到多个${mediaKind === "audio" ? "音频" : mediaKind === "video" ? "视频" : "图像"}输出属性：${videoCandidates.map((candidate) => candidate.name).join("、")}`);
    }
  }
  if (mediaKind && !media.some(isExpectedMedia) && outputs) {
    const videoCandidates = Object.entries(outputs).flatMap(([candidateNodeId, rawOutput]) => {
      if (candidateNodeId === nodeId) return [];
      return Object.entries(asRecord(rawOutput) ?? {}).flatMap(([name, value]) => {
        const candidateMedia = comfyOutputMedia(value).filter(isExpectedMedia);
        return candidateMedia.length ? [{ nodeId: candidateNodeId, name, value, media: candidateMedia }] : [];
      });
    });
    if (videoCandidates.length === 1) {
      resolvedNodeId = videoCandidates[0].nodeId;
      outputProperty = videoCandidates[0].name;
      propertyValue = videoCandidates[0].value;
      media = videoCandidates[0].media;
    } else if (videoCandidates.length > 1) {
      const candidates = videoCandidates.map((candidate) => `${candidate.nodeId}.${candidate.name}`);
      throw new Error(`ComfyUI 节点 ${nodeId}.${property} 没有输出记录，执行结果中找到多个${mediaKind === "audio" ? "音频" : mediaKind === "video" ? "视频" : "图像"}：${candidates.join("、")}`);
    }
  }
  if (!resolvedNodeId || !outputProperty) {
    const available = Object.keys(nodeOutput ?? {});
    const mediaOutputs = Object.entries(outputs ?? {}).flatMap(([candidateNodeId, rawOutput]) =>
      Object.entries(asRecord(rawOutput) ?? {}).flatMap(([name, value]) => comfyOutputMedia(value).filter(mediaKind ? isExpectedMedia : isComfyVideoMedia).length ? [`${candidateNodeId}.${name}`] : []),
    );
    throw new Error(`ComfyUI 节点 ${nodeId} 没有输出属性 ${property}${available.length ? `（可用属性：${available.join("、")}）` : "（节点没有返回输出字段）"}${mediaOutputs.length ? `；检测到媒体：${mediaOutputs.join("、")}` : ""}`);
  }
  if (mediaKind) {
    const previewMedia = media.filter(isExpectedMedia);
    if (!previewMedia.length) throw new Error(`ComfyUI 属性 ${resolvedNodeId}.${outputProperty} 中没有可预览${mediaKind === "audio" ? "音频" : mediaKind === "video" ? "视频" : "图像"}`);
    return createRuntimeMediaValue(mediaKind, previewMedia);
  }
  let value = propertyValue;
  if (value === undefined) return null;
  if (!mediaKind && Array.isArray(value) && value.length === 1) value = value[0];
  if (type === "json" && typeof value === "string") {
    try {
      return toJsonValue(JSON.parse(value) as unknown);
    } catch {
      throw new Error("ComfyUI 节点 " + nodeId + "." + outputProperty + " 声明为结构化数据，但返回内容不是有效 JSON");
    }
  }
  return toJsonValue(value);
}

function coerceComfyInputValue(value: JsonValue | undefined, binding: RunComfyBinding, stepName: string, required = binding.required): JsonValue | undefined {
  if (value === undefined) throw new Error(`${stepName} 的输入引用没有值`);
  // Optional scene inputs are represented as null by the Studio. Leaving the
  // ComfyUI widget untouched lets it keep its own default (for example, a
  // random seed) instead of trying to convert null into a number.
  if ((value === null || value === "") && !required) return undefined;
  if (binding.options?.length) {
    if ((value === null || value === "") && !required) return undefined;
    const optionValue = typeof value === "string" ? value : String(value);
    if (!binding.options.includes(optionValue)) {
      throw new Error(`${stepName} 的 ${binding.property} 需要从可用选项中选择：${binding.options.join("、")}`);
    }
    return optionValue;
  }
  if (binding.type === "number") {
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(number)) throw new Error(`${stepName} 的 ${binding.property} 需要有效数字`);
    return number;
  }
  if (binding.type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
    throw new Error(`${stepName} 的 ${binding.property} 需要布尔值`);
  }
  if (binding.type === "text") {
    const external = externalizeRuntimeValue(value);
    return typeof external === "string" ? external : JSON.stringify(external) ?? String(external);
  }
  const mediaKind = mediaKindFromWorkflowType(binding.type);
  if (mediaKind) {
    const media = normalizeMediaList(externalizeRuntimeValue(value));
    if (media.length !== 1) throw new Error(`${stepName} 的 ${binding.property} 需要一个${mediaKind === "audio" ? "音频" : mediaKind === "video" ? "视频" : "图像"}，请在引用中选择单项或启用逐项执行`);
    return media[0];
  }
  return toJsonValue(externalizeRuntimeValue(value));
}

function comfyInputBaseType(rawSchema: unknown) {
  const schema = Array.isArray(rawSchema) ? rawSchema : [rawSchema];
  return typeof schema[0] === "string" ? schema[0].toUpperCase() : "";
}

function comfyInputImagePath(value: unknown, stepName: string, imageIndex: number) {
  const attachment = asRecord(value);
  const filename = attachment?.filename;
  const subfolder = attachment?.subfolder;
  if (attachment?.type !== "input" || typeof filename !== "string" || !filename || /[\\/]/.test(filename) || filename === "." || filename === "..") {
    throw new Error(`${stepName} 的第 ${imageIndex + 1} 张图片不是有效的 ComfyUI 上传附件`);
  }
  if (typeof subfolder !== "string" || subfolder.startsWith("/") || subfolder.startsWith("\\") || subfolder.split(/[\\/]/).some((part) => part === "." || part === "..")) {
    throw new Error(`${stepName} 的第 ${imageIndex + 1} 张图片目录无效`);
  }
  return [subfolder.replace(/[\\/]+$/, "").replace(/[\\/]/g, "/"), filename].filter(Boolean).join("/");
}

function isComfyInputImageAttachment(value: unknown) {
  const attachment = asRecord(value);
  return typeof attachment?.filename === "string"
    && typeof attachment.subfolder === "string"
    && attachment.type === "input"
    && typeof attachment.url === "string";
}

async function uploadComfyImageSource(value: unknown, baseUrl: string, stepName: string, signal?: AbortSignal) {
  if (isComfyInputImageAttachment(value)) return value;
  let filename = "input.png";
  let contentType = "image/png";
  let bytes: Buffer;
  const candidate = asRecord(value);
  const source = typeof value === "string" ? value.trim()
    : typeof candidate?.path === "string" ? candidate.path.trim()
      : typeof candidate?.url === "string" ? candidate.url.trim() : "";
  if (candidate?.filename && typeof candidate.filename === "string") filename = candidate.filename;
  if (typeof value === "string") filename = path.basename(value) || filename;
  if (candidate?.url && typeof candidate.url === "string") filename = path.basename(new URL(candidate.url, "http://localhost").pathname) || filename;
  if (candidate?.filename && typeof candidate.filename === "string") {
    filename = candidate.filename;
    const mediaType = candidate.type === "input" || candidate.type === "output" ? candidate.type : "output";
    const query = new URLSearchParams({
      filename,
      subfolder: typeof candidate.subfolder === "string" ? candidate.subfolder : "",
      type: mediaType,
    });
    const fetched = await fetchMediaResponse(`${baseUrl}/view?${query}`, signal, 100_000_000, `${stepName} 的图片超过 100 MB 限制`);
    bytes = fetched.bytes;
    contentType = fetched.contentType || mimeTypeForMediaPath(filename, contentType);
  } else if (/^data:image\//i.test(source)) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(source);
    if (!match) throw new Error(`${stepName} 的图片 data URL 格式无效`);
    bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    contentType = match[1];
    filename = `input${mediaContentTypeExtension(contentType)}`;
  } else if (/^https?:\/\//i.test(source)) {
    const fetched = await fetchMediaResponse(source, signal, 100_000_000, `${stepName} 的图片超过 100 MB 限制`);
    bytes = fetched.bytes;
    contentType = fetched.contentType || mimeTypeForMediaPath(filename, contentType);
  } else if (source) {
    const localPath = path.resolve(source);
    const info = await stat(localPath).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`${stepName} 无法读取图片文件：${source}`);
    if (info.size > 100_000_000) throw new Error(`${stepName} 的图片超过 100 MB 限制`);
    bytes = await readFile(localPath, { signal });
    filename = path.basename(localPath) || filename;
    contentType = mimeTypeForMediaPath(filename, contentType);
  } else {
    throw new Error(`${stepName} 的图片输入缺少可读取的路径、URL 或 ComfyUI 附件`);
  }
  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(bytes)], { type: contentType }), filename);
  form.set("type", "input");
  form.set("subfolder", "zane-studio");
  form.set("overwrite", "false");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const response = await fetch(`${baseUrl}/upload/image`, { method: "POST", body: form, signal: controller.signal });
    const payload = await response.json().catch(() => null) as unknown;
    const uploaded = asRecord(payload);
    if (!response.ok || typeof uploaded?.name !== "string") {
      const detail = typeof uploaded?.error === "string" ? uploaded.error : `ComfyUI 返回 ${response.status}`;
      throw new Error(`上传到 ComfyUI 失败：${detail}`);
    }
    const subfolder = typeof uploaded.subfolder === "string" ? uploaded.subfolder : "";
    return {
      id: randomUUID(),
      filename: uploaded.name,
      subfolder,
      type: "input",
      url: `/api/comfyui/view?${new URLSearchParams({ filename: uploaded.name, subfolder, type: "input" })}`,
    };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw cancellationError();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

function isComfyInputVideoAttachment(value: unknown) {
  const attachment = asRecord(value);
  return typeof attachment?.filename === "string"
    && typeof attachment.subfolder === "string"
    && attachment.type === "input"
    && typeof attachment.url === "string";
}

function comfyInputVideoPath(value: unknown, stepName: string, required: boolean): string | undefined {
  if ((value === null || value === "") && !required) return undefined;
  const attachment = asRecord(value);
  const filename = attachment?.filename;
  const subfolder = attachment?.subfolder;
  if (!isComfyInputVideoAttachment(value) || typeof filename !== "string" || !filename || /[\\/]/.test(filename) || filename === "." || filename === "..") {
    throw new Error(`${stepName} 的视频输入不是有效的 ComfyUI 上传附件`);
  }
  if (typeof subfolder !== "string" || subfolder.startsWith("/") || subfolder.startsWith("\\") || subfolder.split(/[\\/]/).some((part) => part === "." || part === "..")) {
    throw new Error(`${stepName} 的视频文件目录无效`);
  }
  return [subfolder.replace(/[\\/]+$/, "").replace(/[\\/]/g, "/"), filename].filter(Boolean).join("/");
}

async function uploadComfyVideoSource(value: unknown, baseUrl: string, stepName: string, signal?: AbortSignal) {
  if (isComfyInputVideoAttachment(value)) return value;
  const maxBytes = 500_000_000;
  const candidate = asRecord(value);
  let filename = "input.mp4";
  let contentType = "video/mp4";
  let bytes: Buffer;
  const candidateType = candidate?.type === "input" || candidate?.type === "output" ? candidate.type : undefined;
  const source = typeof value === "string" ? value.trim()
    : typeof candidate?.path === "string" ? candidate.path.trim()
      : typeof candidate?.url === "string" ? candidate.url.trim() : "";

  if (typeof candidate?.filename === "string" && candidate.filename.trim()) {
    filename = path.basename(candidate.filename) || filename;
  } else if (typeof value === "string") {
    filename = path.basename(value) || filename;
  } else if (typeof candidate?.url === "string") {
    filename = path.basename(new URL(candidate.url, "http://localhost").pathname) || filename;
  }

  if (candidate?.filename && candidateType) {
    const query = new URLSearchParams({
      filename: String(candidate.filename),
      subfolder: typeof candidate.subfolder === "string" ? candidate.subfolder : "",
      type: candidateType,
    });
    const fetched = await fetchMediaResponse(`${baseUrl}/view?${query}`, signal, maxBytes, `${stepName} 的视频超过 500 MB 限制`);
    bytes = fetched.bytes;
    contentType = fetched.contentType || mimeTypeForMediaPath(filename, contentType);
  } else if (/^data:video\//i.test(source)) {
    const match = /^data:(video\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(source);
    if (!match) throw new Error(`${stepName} 的视频 data URL 格式无效`);
    bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    contentType = match[1];
    filename = `input${mediaContentTypeExtension(contentType)}`;
  } else if (/^https?:\/\//i.test(source)) {
    const fetched = await fetchMediaResponse(source, signal, maxBytes, `${stepName} 的视频超过 500 MB 限制`);
    bytes = fetched.bytes;
    contentType = fetched.contentType || mimeTypeForMediaPath(filename, contentType);
  } else if (source) {
    const localPath = path.resolve(source);
    const info = await stat(localPath).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`${stepName} 无法读取视频文件：${source}`);
    if (info.size > maxBytes) throw new Error(`${stepName} 的视频超过 500 MB 限制`);
    bytes = await readFile(localPath, { signal });
    filename = path.basename(localPath) || filename;
    contentType = mimeTypeForMediaPath(filename, contentType);
  } else {
    throw new Error(`${stepName} 的视频输入缺少可读取的路径、URL 或 ComfyUI 附件`);
  }

  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(bytes)], { type: contentType }), filename);
  form.set("type", "input");
  form.set("subfolder", "zane-studio");
  form.set("overwrite", "false");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const response = await fetch(`${baseUrl}/upload/image`, { method: "POST", body: form, signal: controller.signal });
    const payload = await response.json().catch(() => null) as unknown;
    const uploaded = asRecord(payload);
    if (!response.ok || typeof uploaded?.name !== "string") {
      const detail = typeof uploaded?.error === "string" ? uploaded.error : `ComfyUI 返回 ${response.status}`;
      throw new Error(`上传视频到 ComfyUI 失败：${detail}`);
    }
    const subfolder = typeof uploaded.subfolder === "string" ? uploaded.subfolder : "";
    return {
      id: randomUUID(),
      filename: uploaded.name,
      subfolder,
      type: "input",
      url: `/api/comfyui/view?${new URLSearchParams({ filename: uploaded.name, subfolder, type: "input" })}`,
    };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw cancellationError();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

function isComfyInputAudioAttachment(value: unknown) {
  const attachment = asRecord(value);
  return typeof attachment?.id === "string"
    && typeof attachment.filename === "string"
    && typeof attachment.subfolder === "string"
    && attachment.type === "input"
    && typeof attachment.url === "string";
}

function comfyInputAudioPath(value: unknown, stepName: string, required: boolean): string | undefined {
  if ((value === undefined || value === null || value === "") && !required) return undefined;
  const attachment = asRecord(value);
  const filename = attachment?.filename;
  const subfolder = attachment?.subfolder;
  if (!isComfyInputAudioAttachment(value) || typeof filename !== "string" || !filename || /[\\/]/.test(filename) || filename === "." || filename === "..") {
    throw new Error(stepName + " 的音频输入不是有效的 ComfyUI 上传附件");
  }
  if (typeof subfolder !== "string" || subfolder.startsWith("/") || subfolder.startsWith("\\") || subfolder.split(/[\\/]/).some((part) => part === "." || part === "..")) {
    throw new Error(stepName + " 的音频文件目录无效");
  }
  return [subfolder.replace(/[\\/]+$/, "").replace(/[\\/]/g, "/"), filename].filter(Boolean).join("/");
}

async function uploadComfyAudioSource(value: unknown, baseUrl: string, stepName: string, signal?: AbortSignal) {
  const maxBytes = 100_000_000;
  const source = await readComfyAudioSource(value, {
    stepName, limitBytes: maxBytes, signal, mimeTypeForPath: mimeTypeForMediaPath,
    readRemote: url => fetchMediaResponse(url, signal, maxBytes, `${stepName} 的音频超过 100 MB 限制`),
    readComfy: media => fetchMediaResponse(`${baseUrl}/view?${new URLSearchParams({
      filename: String(media.filename), subfolder: typeof media.subfolder === "string" ? media.subfolder : "",
      type: media.type === "input" ? "input" : "output",
    })}`, signal, maxBytes, `${stepName} 的音频超过 100 MB 限制`),
  });
  if (source.kind === "attachment") return source.value;
  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(source.bytes)], { type: source.contentType }), source.filename);
  form.set("type", "input"); form.set("subfolder", "zane-studio"); form.set("overwrite", "false");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const abortFromParent = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abortFromParent, { once: true });
  try {
    const response = await fetch(`${baseUrl}/upload/image`, { method: "POST", body: form, signal: controller.signal });
    const uploaded = asRecord(await response.json().catch(() => null));
    if (!response.ok || typeof uploaded?.name !== "string") {
      throw new Error(`上传音频到 ComfyUI 失败：${typeof uploaded?.error === "string" ? uploaded.error : `ComfyUI 返回 ${response.status}`}`);
    }
    const subfolder = typeof uploaded.subfolder === "string" ? uploaded.subfolder : "";
    return { id: randomUUID(), filename: uploaded.name, subfolder, type: "input",
      url: `/api/comfyui/view?${new URLSearchParams({ filename: uploaded.name, subfolder, type: "input" })}` };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw cancellationError();
    throw error;
  } finally {
    clearTimeout(timeout); signal?.removeEventListener("abort", abortFromParent);
  }
}

function nextComfyGraphNodeId(graph: Record<string, Record<string, unknown>>) {
  const numericIds = Object.keys(graph).map(Number).filter((id) => Number.isSafeInteger(id) && id >= 0);
  let nextId = (numericIds.length ? Math.max(...numericIds) : 0) + 1;
  while (String(nextId) in graph) nextId += 1;
  return String(nextId);
}

function addComfyLoadImage(graph: Record<string, Record<string, unknown>>, imagePath: string): [string, number] {
  const nodeId = nextComfyGraphNodeId(graph);
  graph[nodeId] = { class_type: "LoadImage", inputs: { image: imagePath, upload: "image" } };
  return [nodeId, 0];
}

function addComfyImageBatch(graph: Record<string, Record<string, unknown>>, images: Array<[string, number]>) {
  let combined = images[0];
  for (const image of images.slice(1)) {
    const nodeId = nextComfyGraphNodeId(graph);
    graph[nodeId] = { class_type: "ImageBatch", inputs: { image1: combined, image2: image } };
    combined = [nodeId, 0];
  }
  return combined;
}

async function bindComfyImageList(graph: Record<string, Record<string, unknown>>, nodeInputs: Record<string, unknown>, nodeType: string, property: string, rawSchema: unknown, value: JsonValue | undefined, stepName: string, required: boolean, baseUrl: string, signal?: AbortSignal) {
  const external = externalizeRuntimeValue(value);
  const values = Array.isArray(external) ? external : external === undefined || external === null ? [] : [external];
  if (!values.length && required) throw new Error(`${stepName} 的图片列表至少需要一张图片`);
  const attachments = await Promise.all(values.map((item) => uploadComfyImageSource(item, baseUrl, stepName, signal)));
  const imagePaths = attachments.map((item, index) => comfyInputImagePath(item, stepName, index));
  // LoadImage.image is a filename selector, not an IMAGE socket: an uploaded
  // input path is assigned to the existing widget instead of inserting a new
  // loader. Mirrors the LoadAudio.audio branch, so a scene can bind the image
  // entry node directly.
  if (nodeType === "LoadImage" && property === "image") {
    if (!(property in nodeInputs)) throw new Error(`${stepName} 找不到 LoadImage.image 输入`);
    if (imagePaths.length > 1) throw new Error(`${stepName} 的 LoadImage.image 需要一张图片，请选择单项`);
    if (imagePaths[0]) nodeInputs[property] = imagePaths[0];
    else delete nodeInputs[property];
    return;
  }
  const slotNames = comfyAutogrowImageInputNames(rawSchema);
  if (slotNames.length) {
    if (imagePaths.length > slotNames.length) {
      throw new Error(`${stepName} 的 ${nodeType}.${property} 最多支持 ${slotNames.length} 张有序图片，当前有 ${imagePaths.length} 张`);
    }
    slotNames.forEach((slotName, index) => {
      const inputName = `${property}.${slotName}`;
      delete nodeInputs[inputName];
      if (imagePaths[index]) nodeInputs[inputName] = addComfyLoadImage(graph, imagePaths[index]);
    });
    return;
  }
  if (comfyInputBaseType(rawSchema) === "IMAGE") {
    if (!imagePaths.length) {
      delete nodeInputs[property];
      return;
    }
    const imageNodes = imagePaths.map((imagePath) => addComfyLoadImage(graph, imagePath));
    nodeInputs[property] = addComfyImageBatch(graph, imageNodes);
    return;
  }
  throw new Error(`${stepName} 的 ${nodeType}.${property} 不支持图片列表；请绑定 IMAGE 输入或 ComfyUI 动态图片组`);
}

export async function runComfyUIStep(step: RunStep, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, baseUrl: string, signal?: AbortSignal, inputFields: RunInputField[] = [], variableTypes: Map<string, string> = new Map(), timeoutMs = workflowTimeoutMs(defaultWorkflowTimeoutMinutes), context?: StepExecutionContext, transform?: ComfyPromptTransform) {
  throwIfAborted(signal);
  const workflowFile = step.comfyui?.workflowFile;
  if (!workflowFile) throw new Error(`${step.name} 尚未选择 ComfyUI 工作流`);
  const encodedPath = workflowApiPath(workflowFile);
  let payload: unknown;
  try {
    payload = await fetchJson(`${baseUrl}/api/userdata/${encodedPath}`, {}, signal, timeoutMs);
  } catch {
    throwIfAborted(signal);
    payload = await fetchJson(`${baseUrl}/userdata/${encodedPath}`, {}, signal, timeoutMs);
  }
  let graph: Record<string, Record<string, unknown>>;
  try {
    graph = await readWorkflowApiGraph(payload, baseUrl, signal);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${step.name} 的 ComfyUI 工作流「${workflowFile}」格式无效：${detail}`);
  }
  const bindings = step.comfyui?.bindings ?? [];
  const nodeInfoCache = new Map<string, Promise<unknown>>();
  const resolvedBindings = resolveComfyInputBindings({ bindings, inputs, stepValues, inputFields, variableTypes, stepName: step.name });
  for (const group of groupComfyMediaBindings(resolvedBindings)) {
    const { binding, sourceField, value, mediaKind: sourceMediaKind } = group[0]!;
    const directNode = graph[binding.nodeId];
    const directInputs = asRecord(directNode?.inputs);
    let directPropertyDeclared = false;
    // UI/API graphs omit unconnected IMAGE/autogrow inputs. Check the real
    // schema before migrating; earlier bindings may have inserted LoadImage.image.
    if (directInputs && !Object.prototype.hasOwnProperty.call(directInputs, binding.property) && typeof directNode.class_type === "string") {
      const directType = directNode.class_type;
      let request = nodeInfoCache.get(directType);
      if (!request) {
        request = fetchComfyUIJson(`${baseUrl}/object_info/${encodeURIComponent(directType)}`, 4500, signal);
        nodeInfoCache.set(directType, request);
      }
      // A V3 dynamic combo materializes its children only for the selected option, so the
      // selection recorded on the graph decides whether the dotted property really exists.
      const parent = binding.property.split(".", 1)[0]!;
      const selected = binding.property.includes(".") ? directInputs[parent] : undefined;
      directPropertyDeclared = comfyNodeInputSchema(await request, directType, binding.property, selected) !== undefined;
    }
    const resolvedTarget = resolveComfyInputBindingTarget(graph, binding, directPropertyDeclared);
    const node = resolvedTarget.node;
    const nodeInputs = resolvedTarget.nodeInputs;
    if (resolvedTarget.remapped) {
      log("warn", "comfy.binding_remapped", { step: step.name, workflowFile, bindingKey: binding.key, from: binding.nodeId, to: resolvedTarget.nodeId, property: binding.property });
    }
    if (!node) {
      const availableNodes = Object.entries(graph).map(([id, candidate]) => `${id}${typeof candidate.class_type === "string" ? `（${candidate.class_type}）` : ""}`).join("、");
      if (resolvedTarget.remapBlocked === "connected") {
        throw new Error(`${step.name} 的 ComfyUI 工作流「${workflowFile}」中不存在节点 ${binding.nodeId}（绑定 ${binding.key}），而当前图里唯一带 ${binding.property} 输入的节点已被上游连线占用。为避免覆盖工作流里既有的数据流，不会把它改指过去；请在 ComfyUI 中为该绑定补一个未连线的 ${binding.property} 输入，或把绑定改到正确的节点。`);
      }
      throw new Error(`${step.name} 的 ComfyUI 工作流「${workflowFile}」中不存在节点 ${binding.nodeId}（绑定 ${binding.key}）。可用节点：${availableNodes || "无"}；请重新绑定节点。`);
    }
    if (!nodeInputs) throw new Error(`${step.name} 的 ComfyUI 工作流「${workflowFile}」节点 ${binding.nodeId} 没有可执行输入；请重新导出或选择 API/UI 工作流文件。`);
    if (sourceMediaKind === "image") {
      const nodeType = typeof node.class_type === "string" ? node.class_type : "Unknown";
      let infoRequest = nodeInfoCache.get(nodeType);
      if (!infoRequest) {
        infoRequest = fetchComfyUIJson(`${baseUrl}/object_info/${encodeURIComponent(nodeType)}`, 4500, signal);
        nodeInfoCache.set(nodeType, infoRequest);
      }
      const objectInfo = await infoRequest;
      const inputSchema = comfyNodeInputSchema(objectInfo, nodeType, binding.property);
      const imageValues = group.flatMap((item) => {
        const media = normalizeMediaList(externalizeRuntimeValue(item.value));
        if (!media.length && (item.sourceField?.required ?? item.binding.required ?? false)) {
          throw new Error(`${step.name} 的 ${item.binding.label ?? item.binding.key} 至少需要一张图片`);
        }
        return media;
      });
      await bindComfyImageList(graph, nodeInputs, nodeType, binding.property, inputSchema, imageValues as JsonValue[], step.name, false, baseUrl, signal);
      continue;
    }
    if (sourceMediaKind === "video") {
      const required = sourceField?.required ?? binding.required ?? false;
      const videos = normalizeMediaList(externalizeRuntimeValue(value));
      if (!videos.length) {
        if (required) throw new Error(`${step.name} 的视频输入不能为空`);
        // An explicit empty binding must not inherit the author's sample file.
        delete nodeInputs[binding.property];
        continue;
      }
      if (videos.length !== 1) {
        throw new Error(`${step.name} 的 ${binding.property} 需要一个视频，请在引用中选择单项或启用逐项执行`);
      }
      const video = videos[0];
      // Existing ComfyUI input choices can be passed through directly. New
      // paths, URLs, data URLs, and previous-step outputs are uploaded so
      // every downstream video loader receives an input-folder path.
      if (typeof video === "string" && binding.options?.includes(video)) {
        nodeInputs[binding.property] = video;
      } else {
        const attachment = await uploadComfyVideoSource(video, baseUrl, step.name, signal);
        const videoPath = comfyInputVideoPath(attachment, step.name, required);
        if (videoPath !== undefined) nodeInputs[binding.property] = videoPath;
      }
      continue;
    }
    if (sourceMediaKind === "audio") {
      const nodeType = typeof node.class_type === "string" ? node.class_type : "Unknown";
      const audios = group.flatMap((item) => {
        const media = normalizeMediaList(externalizeRuntimeValue(item.value));
        if (!media.length && (item.sourceField?.required ?? item.binding.required ?? false)) {
          throw new Error(`${step.name} 的 ${item.binding.label ?? item.binding.key} 至少需要一个参考音频`);
        }
        return media;
      });
      let inputSchema: unknown;
      if (nodeType !== "LoadAudio" || binding.property !== "audio") {
        let infoRequest = nodeInfoCache.get(nodeType);
        if (!infoRequest) {
          infoRequest = fetchComfyUIJson(`${baseUrl}/object_info/${encodeURIComponent(nodeType)}`, 4500, signal);
          nodeInfoCache.set(nodeType, infoRequest);
        }
        inputSchema = comfyNodeInputSchema(await infoRequest, nodeType, binding.property);
      }
      // Keep reference order; selected/zip JSON may still contain fixed asset private paths.
      const attachments = [];
      for (const audio of audios) attachments.push(await uploadComfyAudioSource(audio, baseUrl, step.name, signal));
      const paths = attachments.map((audio) => comfyInputAudioPath(audio, step.name, true)!);
      bindComfyAudioPaths(graph, nodeInputs, nodeType, binding.property, inputSchema, paths, step.name);
      continue;
    }
    if (!(binding.property in nodeInputs) && !directPropertyDeclared) {
      const nodeType = typeof node.class_type === "string" ? `（${node.class_type}）` : "";
      const availableProperties = Object.keys(nodeInputs);
      throw new Error(`${step.name} 的 ComfyUI 工作流「${workflowFile}」节点 ${binding.nodeId}${nodeType} 没有输入属性 ${binding.property}（可用属性：${availableProperties.join("、") || "无"}）。工作流可能已更换，请重新绑定节点和属性。`);
    }
    const converted = coerceComfyInputValue(value, binding, step.name, sourceField?.required ?? binding.required);
    if (converted !== undefined) nodeInputs[binding.property] = converted;
  }
  if (transform) {
    if (!context) throw new Error("能力包缺少执行上下文");
    const transformed = await transform({ graph, workflow: payload, context, baseUrl, timeoutMs, request: (route, init, requestSignal) => fetchJson(baseUrl + route, init, requestSignal, Math.min(timeoutMs, 120000), timeoutMs / 60 / 1000) });
    if (transformed.outputs) return transformed.outputs;
    if (transformed.graph) graph = transformed.graph;
  }
  // Runtime bindings (including carry.hasPrevious) are authoritative, not saved widget defaults.
  graph = specializeComfyStaticSwitches(graph);
  let promptId: string | undefined;
  let promptSubmitted = false;
  let interruptPromise: Promise<void> | undefined;
  const requestInterrupt = () => {
    if (!promptSubmitted || interruptPromise) return interruptPromise;
    interruptPromise = interruptComfyUI(baseUrl);
    return interruptPromise;
  };
  const onAbort = () => { void requestInterrupt(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfAborted(signal);
    promptSubmitted = true;
    const queued = asRecord(await fetchJson(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: "zane-aigc-studio" }),
    }, signal, timeoutMs));
    promptId = typeof queued?.prompt_id === "string" ? queued.prompt_id : undefined;
    if (!promptId) {
      throw new Error(comfyApiErrorMessage(queued, "ComfyUI 未返回任务 ID"));
    }
    throwIfAborted(signal);
    const deadline = Date.now() + timeoutMs;
    let history: unknown;
    // 长任务（如小时级视频）退避到 5 秒；固定 1 秒轮询在单步数千次请求时纯属放大。
    let pollDelayMs = 1_000;
    while (Date.now() < deadline) {
      await delayWithAbort(pollDelayMs, signal);
      pollDelayMs = Math.min(pollDelayMs * 1.5, 5_000);
      const remainingMs = Math.max(1, deadline - Date.now());
      const found = asRecord(await fetchJson(`${baseUrl}/history/${encodeURIComponent(promptId)}`, {}, signal, Math.min(timeoutMs, remainingMs), timeoutMs / 60 / 1000));
      if (found && found[promptId]) {
        history = found;
        break;
      }
    }
    if (!history) throw new Error(`等待 ComfyUI 任务完成超时（单步上限 ${workflowTimeoutLabel(timeoutMs / 60 / 1000)}）`);
    const historyEntry = asRecord(asRecord(history)?.[promptId]);
    const status = asRecord(historyEntry?.status);
    if (status?.status_str === "error") {
      const messages = Array.isArray(status.messages) ? status.messages : [];
      const executionError = messages.find((item) => Array.isArray(item) && item[0] === "execution_error");
      const detail = Array.isArray(executionError) ? asRecord(executionError[1]) : undefined;
      const errorMessage = typeof detail?.exception_message === "string" ? detail.exception_message : "ComfyUI 节点执行失败";
      const nodeType = typeof detail?.node_type === "string" ? `（${detail.node_type}）` : "";
      throw new Error(`ComfyUI 执行失败${nodeType}：${errorMessage}`);
    }
    const outputValues: Record<string, JsonValue> = {};
    for (const binding of bindings.filter((item) => item.direction === "output")) {
      const declared = step.outputs?.find((output) => output.key === binding.key);
      const type = declared?.type ?? binding.type;
      outputValues[binding.key] = readComfyOutputValue(history, promptId, binding.nodeId, binding.property, type);
    }
    return outputValues;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) await requestInterrupt();
  }
}
