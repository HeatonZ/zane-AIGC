import { createRuntimeMediaValue, isRuntimeMediaValue, mediaKindFromWorkflowType, runtimeMediaExternalValue, selectRuntimeMedia } from "../runtimeValue.js";
import type { JsonValue, RunStep, RunStepInput, RunWorkflowDefinition } from "./types.js";

// Media values have one runtime shape inside the workflow engine: a flat list.
// The declared workflow type still describes the item kind, while adapters at
// the boundary decide whether an external API receives one item or the list.
/** Nested typed media remains an attachment even when its reference root is JSON. */
export function workflowMediaValueKind(value: unknown, type: unknown) {
  const declared = mediaKindFromWorkflowType(type);
  if (isRuntimeMediaValue(value)) {
    if (declared && declared !== value.mediaKind) throw new Error("媒体来源与声明类型不一致");
    return value.mediaKind;
  }
  return declared;
}

export function isMediaWorkflowType(type: unknown): boolean {
  return mediaKindFromWorkflowType(type) !== undefined;
}

export function canonicalWorkflowType(type: unknown) {
  if (type === "image" || type === "image_list") return "image_list";
  if (type === "video" || type === "video_list") return "video_list";
  if (type === "audio" || type === "audio_list") return "audio_list";
  return typeof type === "string" ? type : "text";
}

export function normalizeRunWorkflow(workflow: RunWorkflowDefinition): RunWorkflowDefinition {
  return {
    ...workflow,
    inputs: workflow.inputs.map((field) => ({ ...field, type: canonicalWorkflowType(field.type) })),
    steps: workflow.steps.map((step) => ({
      ...step,
      inputs: step.inputs?.map((input) => ({
        ...input,
        ...(input.literalType ? { literalType: canonicalWorkflowType(input.literalType) } : {}),
      })),
      outputs: step.outputs?.map((output) => ({ ...output, type: canonicalWorkflowType(output.type) })),
      comfyui: step.comfyui ? {
        ...step.comfyui,
        bindings: step.comfyui.bindings?.map((binding) => ({ ...binding, type: canonicalWorkflowType(binding.type) })),
      } : step.comfyui,
    })),
    outputs: workflow.outputs.map((output) => ({ ...output, type: canonicalWorkflowType(output.type) })),
  };
}

export function normalizeMediaList(value: unknown): JsonValue[] {
  const items: unknown[] = [];
  const visit = (candidate: unknown) => {
    if (isRuntimeMediaValue(candidate)) {
      visit(runtimeMediaExternalValue(candidate));
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (candidate !== undefined && candidate !== null && candidate !== "") items.push(candidate);
  };
  visit(value);
  return items.map(toJsonValue);
}

export function normalizeWorkflowMediaInputs(workflow: RunWorkflowDefinition, values: Record<string, JsonValue>) {
  const normalized = { ...values };
  for (const field of workflow.inputs) {
    const mediaKind = mediaKindFromWorkflowType(field.type);
    if (!mediaKind || !isMediaWorkflowType(field.type)) continue;
    const value = normalized[field.key];
    if (value === undefined || value === null || value === "") continue;
    normalized[field.key] = createRuntimeMediaValue(mediaKind, value);
  }
  return normalized;
}

export function externalizeRuntimeValue(value: unknown): JsonValue {
  return runtimeMediaExternalValue(value) as JsonValue;
}

export function isReadableMediaItem(value: unknown) {
  if (typeof value === "string") return Boolean(value.trim());
  const record = asRecord(value);
  return Boolean(
    (typeof record?.filename === "string" && record.filename.trim())
    || (typeof record?.path === "string" && record.path.trim())
    || (typeof record?.url === "string" && /^(?:https?:\/\/|data:)/i.test(record.url)),
  );
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function uniqueStrings(values: unknown[]) {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim()))];
}

export function splitWorkflowReference(reference: string) {
  const match = /^(iteration\.(?:item|previous|hasPrevious|index)|input\.[a-zA-Z0-9_]+|step\.[a-zA-Z0-9_-]+\.outputs\.[a-zA-Z0-9_]+)([\s\S]*)$/.exec(reference);
  if (!match) return undefined;
  const suffix = match[2];
  return {
    root: match[1],
    path: suffix.startsWith(".") && suffix.length > 1 ? suffix.slice(1) : suffix,
  };
}

export function parseWorkflowJsonPath(path: string): Array<string | number> {
  let cursor = 0;
  if (path[cursor] === "$" && (path.length === 1 || path[cursor + 1] === "." || path[cursor + 1] === "[")) {
    cursor += 1;
    if (path[cursor] === ".") cursor += 1;
  }

  const segments: Array<string | number> = [];
  while (cursor < path.length) {
    if (path[cursor] === ".") {
      cursor += 1;
      const start = cursor;
      while (cursor < path.length && path[cursor] !== "." && path[cursor] !== "[") cursor += 1;
      const key = path.slice(start, cursor);
      if (!key) throw new Error("字段名为空");
      segments.push(key);
      continue;
    }

    if (path[cursor] === "[") {
      cursor += 1;
      if (path[cursor] === '"') {
        const start = cursor;
        cursor += 1;
        let escaped = false;
        while (cursor < path.length) {
          const character = path[cursor];
          cursor += 1;
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') break;
        }
        if (path[cursor] !== "]") throw new Error("括号路径格式无效");
        let key: unknown;
        try {
          key = JSON.parse(path.slice(start, cursor));
        } catch {
          throw new Error("带引号的字段名格式无效");
        }
        if (typeof key !== "string") throw new Error("字段名格式无效");
        segments.push(key);
        cursor += 1;
        continue;
      }

      const end = path.indexOf("]", cursor);
      if (end < 0) throw new Error("缺少右方括号");
      const index = path.slice(cursor, end);
      if (!/^\d+$/.test(index) || !Number.isSafeInteger(Number(index))) throw new Error("数组下标必须是非负整数");
      segments.push(Number(index));
      cursor = end + 1;
      continue;
    }

    if (segments.length) throw new Error("字段之间需要用点号或方括号分隔");
    const start = cursor;
    while (cursor < path.length && path[cursor] !== "." && path[cursor] !== "[") cursor += 1;
    const key = path.slice(start, cursor);
    if (!key) throw new Error("字段名为空");
    segments.push(key);
  }
  return segments;
}

export function workflowReferenceRoot(reference: string) {
  return splitWorkflowReference(reference)?.root ?? reference;
}

export function resolveWorkflowReference(reference: string, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>) {
  const parsed = splitWorkflowReference(reference);
  if (!parsed) throw new Error(`不支持的数据引用：${reference || "（空）"}`);
  const inputMatch = /^input\.([a-zA-Z0-9_]+)$/.exec(parsed.root);
  const outputMatch = /^step\.([a-zA-Z0-9_-]+)\.outputs\.([a-zA-Z0-9_]+)$/.exec(parsed.root);
  let value: JsonValue | undefined;
  if (parsed.root.startsWith("iteration.")) value = inputs[parsed.root];
  else if (inputMatch) value = inputs[inputMatch[1]];
  else if (outputMatch) value = stepValues.get(outputMatch[1])?.[outputMatch[2]];
  else throw new Error(`不支持的数据引用：${reference || "（空）"}`);

  if (!parsed.path) return value;
  if (isRuntimeMediaValue(value)) {
    let mediaPath: Array<string | number>;
    try {
      mediaPath = parseWorkflowJsonPath(parsed.path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "路径格式无效";
      throw new Error(`媒体引用路径无效：${detail}`);
    }
    if (mediaPath.length === 1 && typeof mediaPath[0] === "number") {
      return selectRuntimeMedia(value, { mode: "item", index: mediaPath[0] });
    }
    throw new Error("媒体引用只支持选择单项序号，例如 [0]");
  }
  let segments: Array<string | number>;
  try {
    segments = parseWorkflowJsonPath(parsed.path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "路径格式无效";
    throw new Error(`JSON 字段路径无效：${reference}（${detail}）`);
  }
  for (const segment of segments) {
    if (Array.isArray(value) && typeof segment === "number") value = value[segment];
    else if (value !== null && typeof value === "object" && !Array.isArray(value) && !isRuntimeMediaValue(value) && typeof segment === "string" && Object.prototype.hasOwnProperty.call(value, segment)) value = value[segment];
    else value = undefined;
    if (value === undefined) throw new Error(`JSON 字段路径不存在：${reference}`);
  }
  return value;
}

export function parseWorkflowLiteral(value: unknown, type: string | undefined, label: string): JsonValue {
  const raw = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value) ?? String(value);
  const normalizedType = type === "textarea" || type === "select" || !type ? "text" : type;
  if (normalizedType === "number") {
    const number = raw.trim() ? Number(raw) : NaN;
    if (!Number.isFinite(number)) throw new Error(`${label} 的固定值需要有效数字`);
    return number;
  }
  if (normalizedType === "boolean") {
    if (!/^(true|false)$/i.test(raw.trim())) throw new Error(`${label} 的固定值需要布尔值`);
    return raw.trim().toLowerCase() === "true";
  }
  if (mediaKindFromWorkflowType(normalizedType)) {
    if (!raw.trim()) throw new Error(`${label} 的固定值需要有效 JSON`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${label} 的固定值 JSON 格式无效`);
    }
    if (!Array.isArray(parsed)) throw new Error(`${label} 的固定值需要 JSON 数组`);
    return toJsonValue(parsed);
  }
  if (normalizedType === "json") {
    if (!raw.trim()) throw new Error(`${label} 的固定值需要有效 JSON`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${label} 的固定值 JSON 格式无效`);
    }
    return toJsonValue(parsed);
  }
  return raw;
}

export function resolveWorkflowValue(input: RunStepInput, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>) {
  const sourceType = input.valueSource === "literal" ? input.literalType : input.referenceType;
  const rawValue = input.valueSource === "literal"
    ? parseWorkflowLiteral(input.literalValue, input.literalType, input.label ?? input.key)
    : resolveWorkflowReference(input.sourceRef ?? "", inputs, stepValues);
  const mediaKind = workflowMediaValueKind(rawValue, sourceType);
  const normalized = mediaKind && !isRuntimeMediaValue(rawValue) ? createRuntimeMediaValue(mediaKind, rawValue) : rawValue;
  return input.selection ? selectRuntimeMedia(normalized, input.selection) : normalized;
}

export function resolveStepInputs(step: RunStep, inputValues: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>) {
  return Object.fromEntries((step.inputs ?? []).map((input) => {
    try {
      return [input.key, resolveWorkflowValue(input, inputValues, stepValues) ?? null];
    } catch {
      return [input.key, null];
    }
  }));
}

export function resolvePromptTemplate(template: string, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, types?: Map<string, string>) {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_match, reference: string) => {
    const sourceRef = reference.trim();
    const type = types?.get(sourceRef) ?? types?.get(workflowReferenceRoot(sourceRef));
    if (mediaKindFromWorkflowType(type) === "image") return "[图片已作为附件提供]";
    if (mediaKindFromWorkflowType(type) === "video") return "[视频代表帧已作为图片附件提供]";
    const value = resolveWorkflowReference(sourceRef, inputs, stepValues);
    if (value === undefined || value === null) return "";
    if (workflowMediaValueKind(value, type) === "image") return "[图片已作为附件提供]";
    if (workflowMediaValueKind(value, type) === "video") return "[视频代表帧已作为图片附件提供]";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

export function toJsonValue(value: unknown): JsonValue {
  if (isRuntimeMediaValue(value)) return value;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]));
  return String(value);
}

