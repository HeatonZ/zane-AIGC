import { asRecord } from "./domain/workflowValues.js";
import type { RunComfyBinding } from "./domain/types.js";

/** An unconnected API input can still be declared by the node's object_info. */
export function resolveComfyInputBindingTarget(
  graph: Record<string, Record<string, unknown>>,
  binding: Pick<RunComfyBinding, "nodeId" | "property">,
  directPropertyDeclared = false,
) {
  const directNode = graph[binding.nodeId];
  const directInputs = asRecord(directNode?.inputs);
  if (directNode && directInputs && (directPropertyDeclared || Object.prototype.hasOwnProperty.call(directInputs, binding.property))) {
    return { nodeId: binding.nodeId, node: directNode, nodeInputs: directInputs, remapped: false };
  }
  // Preserve legacy migration for a genuinely stale node/property binding.
  const candidates = Object.entries(graph).flatMap(([nodeId, node]) => {
    const nodeInputs = asRecord(node.inputs);
    return nodeInputs && Object.prototype.hasOwnProperty.call(nodeInputs, binding.property)
      ? [{ nodeId, node, nodeInputs }]
      : [];
  });
  if (candidates.length === 1) return { ...candidates[0]!, remapped: candidates[0]!.nodeId !== binding.nodeId };
  return { nodeId: binding.nodeId, node: directNode, nodeInputs: directInputs, remapped: false };
}
