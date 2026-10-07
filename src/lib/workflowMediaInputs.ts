import type { ComfyUIBinding, WorkflowInputField } from "../types";
import { canonicalWorkflowMediaType } from "./workflowMigration";

const categorizedInputs: WorkflowInputField[] = [
  { key: "character_assets", label: "人物资产", type: "image_list", mediaRole: "character", required: false },
  { key: "scene_assets", label: "场景资产", type: "image_list", mediaRole: "scene", required: false },
  { key: "prop_assets", label: "道具资产", type: "image_list", mediaRole: "prop", required: false },
  { key: "voice_reference_audio", label: "参考音色", type: "audio_list", mediaRole: "voice_reference", required: false },
];

/** Explicit draft editing only: preserve all existing values, and never guess model node IDs. */
export function addCategorizedMediaInputs(inputs: WorkflowInputField[], bindings: ComfyUIBinding[]) {
  const nextInputs = [...inputs], nextBindings = [...bindings];
  for (const template of categorizedInputs) {
    const existing = nextInputs.find(field => field.key === template.key);
    const binding = nextBindings.find(item => item.direction === "input" && item.key === template.key);
    if (existing && (canonicalWorkflowMediaType(existing.type) !== template.type || (existing.mediaRole && existing.mediaRole !== template.mediaRole))) throw new Error(template.key + " 已有不兼容的输入配置，请先核对；未覆盖原配置");
    if (binding && (canonicalWorkflowMediaType(binding.type) !== template.type || (binding.mediaRole && binding.mediaRole !== template.mediaRole))) throw new Error(template.key + " 已有不兼容的节点绑定，请先核对；未覆盖原配置");
    if (!existing) nextInputs.push({ ...template });
    else nextInputs[nextInputs.indexOf(existing)] = { ...existing, mediaRole: template.mediaRole };
    if (!binding) nextBindings.push({ key: template.key, label: template.label, type: template.type as ComfyUIBinding["type"], mediaRole: template.mediaRole, direction: "input", sourceRef: "input." + template.key, valueSource: "reference", nodeId: "", property: "" });
    else nextBindings[nextBindings.indexOf(binding)] = { ...binding, mediaRole: template.mediaRole };
  }
  return { inputs: nextInputs, bindings: nextBindings };
}
