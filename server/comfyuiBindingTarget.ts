import { asRecord } from "./domain/workflowValues.js";
import type { RunComfyBinding } from "./domain/types.js";

/**
 * A port already fed by an upstream node is wired by the workflow author. Migrating
 * a stale binding onto it would silently replace that dataflow instead of filling a
 * vacant input, so it is never a valid migration target.
 */
function isConnectedPort(nodeInputs: Record<string, unknown>, property: string) {
  return Array.isArray(nodeInputs[property]);
}

/**
 * An unconnected API input can still be declared by the node's object_info.
 *
 * `remapBlocked` reports why a stale binding could not be migrated: `"connected"`
 * means the only node exposing that property is already wired upstream. The caller
 * turns this into an actionable error instead of rewriting someone else's graph.
 */
export function resolveComfyInputBindingTarget(
  graph: Record<string, Record<string, unknown>>,
  binding: Pick<RunComfyBinding, "nodeId" | "property">,
  directPropertyDeclared = false,
) {
  const directNode = graph[binding.nodeId];
  const directInputs = asRecord(directNode?.inputs);
  if (directNode && directInputs && (directPropertyDeclared || Object.prototype.hasOwnProperty.call(directInputs, binding.property))) {
    return { nodeId: binding.nodeId, node: directNode, nodeInputs: directInputs, remapped: false, remapBlocked: undefined };
  }
  // Preserve legacy migration for a genuinely stale node/property binding.
  const matches = Object.entries(graph).flatMap(([nodeId, node]) => {
    const nodeInputs = asRecord(node.inputs);
    return nodeInputs && Object.prototype.hasOwnProperty.call(nodeInputs, binding.property)
      ? [{ nodeId, node, nodeInputs }]
      : [];
  });
  const candidates = matches.filter((candidate) => !isConnectedPort(candidate.nodeInputs, binding.property));
  if (candidates.length === 1) {
    return { ...candidates[0]!, remapped: candidates[0]!.nodeId !== binding.nodeId, remapBlocked: undefined };
  }
  return {
    nodeId: binding.nodeId,
    node: directNode,
    nodeInputs: directInputs,
    remapped: false,
    remapBlocked: !candidates.length && matches.length ? "connected" as const : undefined,
  };
}
