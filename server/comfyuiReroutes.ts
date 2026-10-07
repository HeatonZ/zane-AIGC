import { asRecord } from "./domain/workflowValues.js";
import { HttpError } from "./errors.js";

export const COMFY_UI_ROUTING_CONTRACT = {
  version: 1, format: "zane.comfy-ui-routing/v1", appliesTo: "ui_workflow",
  frontendNodeType: "Reroute", outputSlot: 0,
  behavior: "Resolve routing chains and fan-out to the original source before submitting the API graph; omit frontend-only Reroute nodes.",
  errorCode: "INVALID_COMFY_REROUTE", errorStatus: 400,
  invalid: ["cycle", "missing_source", "multiple_sources", "invalid_output_slot"],
  sideEffects: "No workflow-file, scene, publication or model mutation. API-format graphs are unchanged.",
} as const;

type Graph = Record<string, Record<string, unknown>>;
type Link = [string, number];
function link(value: unknown): Link | undefined {
  if (!Array.isArray(value) || value.length !== 2 || !["string", "number"].includes(typeof value[0]) || !Number.isSafeInteger(value[1]) || value[1] < 0) return undefined;
  return [String(value[0]), value[1]];
}
/** Frontend-only routing is resolved after subgraph expansion, shared by inspection and execution. */
export function resolveComfyUIReroutes(source: Graph): Graph {
  const reroutes = new Set(Object.keys(source).filter(id => source[id].class_type === "Reroute"));
  const resolved = new Map<string, Link>();
  const invalid = (id: string, reason: string): never => { throw new HttpError(400, "ComfyUI Reroute 连线无效：" + reason, "INVALID_COMFY_REROUTE", { nodeId: id, reason }); };
  const resolve = (start: Link): Link => {
    let current = start;
    const path = new Set<string>();
    while (reroutes.has(current[0])) {
      const [id, slot] = current;
      if (slot !== 0) invalid(id, "invalid_output_slot");
      const cached = resolved.get(id); if (cached) { current = cached; break; }
      if (path.has(id)) invalid(id, "cycle");
      path.add(id);
      const inputs = asRecord(source[id].inputs);
      const values = Object.values(inputs ?? {});
      if (values.length > 1) invalid(id, "multiple_sources");
      const origin = values.length === 1 ? link(values[0]) : undefined;
      if (!origin || !Object.hasOwn(source, origin[0])) invalid(id, "missing_source");
      current = origin!;
    }
    for (const id of path) resolved.set(id, current);
    return current;
  };
  for (const id of reroutes) resolve([id, 0]);
  const graph: Graph = {};
  for (const [id, node] of Object.entries(source)) {
    if (reroutes.has(id)) continue;
    const copy = structuredClone(node);
    const inputs = asRecord(copy.inputs);
    if (inputs) for (const [key, value] of Object.entries(inputs)) {
      const origin = link(value); if (origin && reroutes.has(origin[0])) inputs[key] = resolve(origin);
    }
    graph[id] = copy;
  }
  return graph;
}
