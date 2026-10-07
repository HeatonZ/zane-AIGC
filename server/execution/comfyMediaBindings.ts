import { isRuntimeMediaValue, mediaKindFromWorkflowType } from "../runtimeValue.js";
import type { RunComfyBinding } from "../domain/types.js";

type Graph = Record<string, Record<string, unknown>>;
export type ComfyMediaKind = "image" | "audio" | "video";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Autogrow ports are described by their template, not by a concrete socket in the saved graph. */
export function comfyAutogrowInputNames(rawSchema: unknown, mediaKind: "image" | "audio"): string[] {
  if (!Array.isArray(rawSchema) || rawSchema[0] !== "COMFY_AUTOGROW_V3") return [];
  const template = record(record(rawSchema[1])?.template);
  const inputs = record(template?.input);
  const supported = ["required", "optional"].some((section) => Object.values(record(inputs?.[section]) ?? {}).some((entry) => {
    const type = Array.isArray(entry) ? entry[0] : entry;
    return mediaKind === "audio" ? type === "AUDIO" : type === "IMAGE" || type === "MASK";
  }));
  if (!supported) return [];
  if (Array.isArray(template?.names)) return [...new Set(template.names.filter((name): name is string => typeof name === "string" && Boolean(name)))];
  if (typeof template?.prefix !== "string" || !Number.isSafeInteger(template.max) || (template.max as number) < 1 || (template.max as number) > 256) return [];
  return Array.from({ length: template.max as number }, (_, index) => `${template.prefix}${index}`);
}

/** JSON-path references can contain typed media even when their root is JSON. */
export function comfyBindingMediaKind(value: unknown, sourceType: string, bindingType: string): ComfyMediaKind | undefined {
  const sourceKind = isRuntimeMediaValue(value) ? value.mediaKind : mediaKindFromWorkflowType(sourceType);
  const bindingKind = mediaKindFromWorkflowType(bindingType);
  if (sourceKind && bindingKind && sourceKind !== bindingKind) throw new Error("ComfyUI媒体来源与目标列表类型不一致");
  return sourceKind ?? bindingKind;
}

export interface ResolvedComfyBinding {
  binding: RunComfyBinding;
  mediaKind?: ComfyMediaKind;
}

/** Multiple asset categories targeting the same media port are appended in binding order, never overwritten. */
export function groupComfyMediaBindings<T extends ResolvedComfyBinding>(bindings: T[]): T[][] {
  const result: T[][] = [];
  const groups = new Map<string, T[]>();
  for (const item of bindings) {
    if (item.mediaKind !== "image" && item.mediaKind !== "audio") {
      result.push([item]);
      continue;
    }
    const key = `${item.binding.nodeId}\0${item.binding.property}\0${item.mediaKind}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      result.push(group);
    }
    group.push(item);
  }
  return result;
}

function addLoadAudio(graph: Graph, audioPath: string): [string, number] {
  const ids = Object.keys(graph).map(Number).filter((id) => Number.isSafeInteger(id) && id >= 0);
  let id = (ids.length ? Math.max(...ids) : 0) + 1;
  while (String(id) in graph) id += 1;
  graph[String(id)] = { class_type: "LoadAudio", inputs: { audio: audioPath } };
  return [String(id), 0];
}

/** Connect voice references as AUDIO tensors; a file path cannot be assigned directly to an AUDIO socket. */
export function bindComfyAudioPaths(
  graph: Graph,
  nodeInputs: Record<string, unknown>,
  nodeType: string,
  property: string,
  rawSchema: unknown,
  paths: string[],
  stepName: string,
) {
  if (nodeType === "LoadAudio" && property === "audio") {
    if (!(property in nodeInputs)) throw new Error(`${stepName} 找不到 LoadAudio.audio 输入`);
    if (paths.length > 1) throw new Error(`${stepName} 的 LoadAudio.audio 需要一个音频，请选择单项`);
    if (paths[0]) nodeInputs[property] = paths[0];
    return;
  }
  const slots = comfyAutogrowInputNames(rawSchema, "audio");
  if (slots.length) {
    if (paths.length > slots.length) throw new Error(`${stepName} 的 ${nodeType}.${property} 最多支持 ${slots.length} 个参考音频，当前有 ${paths.length} 个`);
    for (const slot of slots) delete nodeInputs[`${property}.${slot}`];
    paths.forEach((audioPath, index) => { nodeInputs[`${property}.${slots[index]}`] = addLoadAudio(graph, audioPath); });
    return;
  }
  const type = Array.isArray(rawSchema) ? rawSchema[0] : rawSchema;
  if (type === "AUDIO") {
    if (paths.length > 1) throw new Error(`${stepName} 的 ${nodeType}.${property} 需要一个音频，请选择单项`);
    if (paths[0]) nodeInputs[property] = addLoadAudio(graph, paths[0]);
    else delete nodeInputs[property];
    return;
  }
  throw new Error(`${stepName} 的 ${nodeType}.${property} 不支持音频；请绑定 LoadAudio.audio、AUDIO 输入或动态音频组`);
}
