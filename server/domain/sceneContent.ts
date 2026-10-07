import { createHash } from "node:crypto";
import { asRecord } from "./workflowValues.js";

export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort((item as Record<string, unknown>)[key])])) : item;
  return JSON.stringify(sort(value));
}
export function contentRevision(value: unknown) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
export function referencedPresetIds(workflow: Record<string, unknown> | null) {
  const ids = new Set<string>();
  for (const raw of Array.isArray(workflow?.inputs) ? workflow.inputs : []) { const input = asRecord(raw); if (typeof input?.optionPresetId === "string") ids.add(input.optionPresetId); }
  for (const raw of Array.isArray(workflow?.steps) ? workflow.steps : []) {
    const config = asRecord(asRecord(raw)?.comfyui);
    for (const rawBinding of Array.isArray(config?.bindings) ? config.bindings : []) { const format = asRecord(asRecord(rawBinding)?.sourceInputFormat); if (typeof format?.optionPresetId === "string") ids.add(format.optionPresetId); }
  }
  return ids;
}
export function sceneContent(scene: Record<string, unknown>, workflow: Record<string, unknown> | null, presets: unknown[]) {
  const ids = referencedPresetIds(workflow);
  return { scene, workflow: workflow ? { ...workflow, sceneId: scene.id } as Record<string, unknown> : null, optionPresets: presets.map(asRecord).filter((preset): preset is Record<string, unknown> => Boolean(preset && ids.has(String(preset.id)))).sort((a, b) => String(a.id).localeCompare(String(b.id))) };
}
/** Compatible with the UI's eight-character canonical MD5 scene version. */
export function sceneContentHash(content: unknown) { return createHash("md5").update(canonicalJson(content)).digest("hex").slice(0, 8); }
