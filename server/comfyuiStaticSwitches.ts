import { asRecord } from "./domain/workflowValues.js";

export const COMFY_STATIC_SWITCH_CONTRACT = {
  version: 1, format: "zane.comfy-static-switch/v1", appliesTo: "bound_runtime_graph",
  nodeType: "ComfySwitchNode", selector: "switch",
  knownBooleanSources: ["boolean literal", "PrimitiveBoolean.value", "ComfyNotNode", "selected ComfySwitchNode output"],
  behavior: "After runtime bindings, remove only the unselected optional input of a proven-static built-in lazy switch. Retain every node, selected input, output ID and other consumer. Unknown or cyclic selectors stay unchanged.",
  emptyOptionalVideo: "An explicitly bound empty optional video clears the file input; never silently falls back to the workflow's sample video. A reachable required loader still fails provider validation.",
  sideEffects: "No node execution, model call, workflow-file mutation, draft write or publication. Applies to both UI-converted and API-format execution graphs; inspection remains the original graph.",
} as const;

type Graph = Record<string, Record<string, unknown>>;
/** Resolve only built-in, side-effect-free Boolean semantics; never coerce strings/numbers or evaluate expressions. */
function knownBoolean(value: unknown, graph: Graph, visiting = new Set<string>()): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (!Array.isArray(value) || value.length !== 2 || value[1] !== 0 || !["string", "number"].includes(typeof value[0])) return undefined;
  const id = String(value[0]);
  if (visiting.has(id)) return undefined;
  const node = graph[id], inputs = asRecord(node?.inputs);
  if (!inputs) return undefined;
  const next = new Set(visiting).add(id);
  if (node.class_type === "PrimitiveBoolean") return typeof inputs.value === "boolean" ? inputs.value : undefined;
  if (node.class_type === "ComfyNotNode") {
    const source = knownBoolean(inputs.value, graph, next);
    return source === undefined ? undefined : !source;
  }
  if (node.class_type === "ComfySwitchNode") {
    const selector = knownBoolean(inputs.switch, graph, next);
    return selector === undefined ? undefined : knownBoolean(inputs[selector ? "on_true" : "on_false"], graph, next);
  }
  return undefined;
}

/** ComfyUI validates both lazy links before execution. Disconnecting only a statically inactive input avoids requiring its files. */
export function specializeComfyStaticSwitches(source: Graph): Graph {
  const graph = structuredClone(source);
  for (const node of Object.values(graph)) {
    if (node.class_type !== "ComfySwitchNode") continue;
    const inputs = asRecord(node.inputs);
    if (!inputs) continue;
    const selector = knownBoolean(inputs.switch, source);
    if (selector !== undefined) delete inputs[selector ? "on_false" : "on_true"];
  }
  return graph;
}
