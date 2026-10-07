import type { ComfyUIBinding, ComfyUINodeInfo, ComfyUIWorkflowDetail, ComfyUIWorkflowNode } from "../types";

/**
 * A workflow's graph only contains configured inputs. ComfyUI's object_info
 * schema is authoritative for unconfigured/dynamic inputs such as autogrow
 * groups. If that schema could not be read, preserve the user's binding.
 */
export function clearConfirmedStaleComfyBindings(
  bindings: ComfyUIBinding[],
  nodes: ComfyUIWorkflowNode[],
  nodeInfos: Record<string, ComfyUINodeInfo>,
  format: ComfyUIWorkflowDetail["format"],
) {
  if (format === "unknown") return bindings;

  let changed = false;
  const next = bindings.map((binding) => {
    const nodeId = binding.nodeId.trim();
    const property = binding.property.trim();
    // Incomplete bindings are an intentional edit state, not stale bindings.
    if (!nodeId || !property) return binding;

    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      changed = true;
      return clearBindingTarget(binding);
    }

    const summaryProperties = binding.direction === "input" ? node.inputProperties : node.outputProperties;
    if (summaryProperties.includes(property)) return binding;
    // API summaries cannot enumerate runtime output fields such as Filenames.
    // Preserve the existing conservative behavior when no output list exists.
    if (binding.direction === "output") {
      if (!summaryProperties.length) return binding;
      changed = true;
      return clearBindingTarget(binding);
    }

    const nodeInfo = nodeInfos[node.type];
    if (!nodeInfo) return binding;
    if (nodeInfo.inputs.some((candidate) => candidate.name === property)) return binding;

    changed = true;
    return clearBindingTarget(binding);
  });
  return changed ? next : bindings;
}

function clearBindingTarget(binding: ComfyUIBinding): ComfyUIBinding {
  return {
    ...binding,
    nodeId: "",
    property: "",
    options: undefined,
    required: undefined,
    sourceInputFormat: undefined,
    sourceOutputFormat: undefined,
  };
}
