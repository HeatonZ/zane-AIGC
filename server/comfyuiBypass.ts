import { asRecord } from "./domain/workflowValues.js";
import { HttpError } from "./errors.js";

/** The mode values persisted by ComfyUI's LiteGraph workflow format. */
export const COMFY_UI_NODE_MODE = {
  NEVER: 2,
  BYPASS: 4,
} as const;

export type ComfyUIBypassLink = readonly [string, number];

export type ComfyUIBypassSource =
  | { kind: "link"; value: ComfyUIBypassLink }
  | { kind: "literal"; value: unknown };

export interface ComfyUIBypassNodeEntry {
  id: string;
  node: Record<string, unknown>;
}

function nodeMode(node: Record<string, unknown>) {
  if (typeof node.mode === "number" && Number.isSafeInteger(node.mode)) return node.mode;
  if (typeof node.mode === "string" && /^-?\d+$/.test(node.mode.trim())) return Number(node.mode);
  return undefined;
}

export function isComfyUIInactiveNode(node: Record<string, unknown>) {
  const mode = nodeMode(node);
  return mode === COMFY_UI_NODE_MODE.NEVER || mode === COMFY_UI_NODE_MODE.BYPASS;
}

function link(value: unknown): ComfyUIBypassLink | undefined {
  if (Array.isArray(value)) {
    const originId = typeof value[0] === "string" || typeof value[0] === "number" ? String(value[0]) : undefined;
    const originSlot = typeof value[1] === "number" ? value[1] : Number(value[1]);
    return originId && Number.isSafeInteger(originSlot) ? [originId, originSlot] : undefined;
  }
  const record = asRecord(value);
  const originId = typeof record?.origin_id === "string" || typeof record?.origin_id === "number"
    ? String(record.origin_id)
    : typeof record?.originId === "string" || typeof record?.originId === "number"
      ? String(record.originId)
      : undefined;
  const rawSlot = record?.origin_slot ?? record?.originSlot;
  const originSlot = typeof rawSlot === "number" ? rawSlot : Number(rawSlot);
  return originId && Number.isSafeInteger(originSlot) ? [originId, originSlot] : undefined;
}

function sourceFromValue(value: unknown, sources: Map<string, ComfyUIBypassSource>): ComfyUIBypassSource | undefined {
  if (value !== null && value !== undefined) {
    const source = sources.get(String(value));
    if (source) return source;
  }
  const directLink = link(value);
  return directLink ? { kind: "link", value: directLink } : undefined;
}

function slotList(node: Record<string, unknown>, key: "inputs" | "outputs") {
  return Array.isArray(node[key]) ? node[key].flatMap((value) => {
    const slot = asRecord(value);
    return slot ? [slot] : [];
  }) : [];
}

function slotType(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

/** Mirrors LiteGraph.isValidConnection, including wildcard and comma types. */
function isValidConnection(left: unknown, right: unknown): boolean {
  const wildcard = (value: unknown) => value === undefined || value === null || value === 0 || value === "" || value === "*";
  if (wildcard(left) || wildcard(right) || left === right || (left === -1 && right === -1)) return true;
  const leftText = String(left).toLowerCase();
  const rightText = String(right).toLowerCase();
  if (!leftText.includes(",") && !rightText.includes(",")) return leftText === rightText;
  return leftText.split(",").some((leftPart) => rightText.split(",").some((rightPart) => isValidConnection(leftPart, rightPart)));
}

function bypassInputIndex(
  nodeId: string,
  node: Record<string, unknown>,
  outputSlot: number,
  targetType: unknown,
  linkTypes: Map<string, string | number>,
) {
  const inputs = slotList(node, "inputs");
  const outputs = slotList(node, "outputs");
  const output = outputs[outputSlot];
  if (!output) {
    throw new HttpError(400, "ComfyUI Bypass 连线无效：invalid_output_slot", "INVALID_COMFY_BYPASS", { nodeId, outputSlot, reason: "invalid_output_slot" });
  }

  const outputType = slotType(output.type) ?? slotType(output.name);
  const inputType = (input: Record<string, unknown> | undefined) => {
    if (!input) return undefined;
    return slotType(input.type) ?? (input.link === null || input.link === undefined ? undefined : linkTypes.get(String(input.link)));
  };
  // This is the same slot-index fallback used by LiteGraph for a generic target.
  if (targetType === "*" || targetType === "") return inputs.length > outputSlot ? outputSlot : 0;

  const oppositeInput = inputs[outputSlot];
  const oppositeType = inputType(oppositeInput);
  if (oppositeInput && isValidConnection(oppositeType, outputType) && isValidConnection(oppositeType, targetType)) {
    return outputSlot;
  }

  const exactIndex = inputs.findIndex((input) => inputType(input) === targetType);
  if (exactIndex !== -1) return exactIndex;

  return inputs.findIndex((input) => {
    const type = inputType(input);
    return isValidConnection(type, outputType) && isValidConnection(type, targetType);
  });
}

/**
 * Resolves UI-format links through muted and bypassed nodes before API conversion.
 * The resolution is performed per consumer input because one bypass output can fan
 * out to consumers with different target types.
 */
export function createComfyUIBypassResolver(
  entries: ComfyUIBypassNodeEntry[],
  sources: Map<string, ComfyUIBypassSource>,
  linkTypes: Map<string, string | number> = new Map(),
) {
  const nodes = new Map(entries.map((entry) => [entry.id, entry.node] as const));

  const invalid = (nodeId: string, reason: string, details: Record<string, unknown> = {}): never => {
    throw new HttpError(400, `ComfyUI Bypass 连线无效：${reason}`, "INVALID_COMFY_BYPASS", { nodeId, reason, ...details });
  };

  const resolveSource = (
    source: ComfyUIBypassSource | undefined,
    targetType: unknown,
    visiting: Set<string>,
  ): ComfyUIBypassSource | undefined => {
    if (!source || source.kind === "literal") return source;
    const [originId, originSlot] = source.value;
    const origin = nodes.get(originId);
    if (!origin) return source;

    const mode = nodeMode(origin);
    if (mode === COMFY_UI_NODE_MODE.NEVER) return undefined;
    if (mode !== COMFY_UI_NODE_MODE.BYPASS) return source;

    const visitKey = `${originId}:${originSlot}`;
    if (visiting.has(visitKey)) invalid(originId, "cycle", { outputSlot: originSlot });
    const nextVisiting = new Set(visiting).add(visitKey);
    const inputIndex = bypassInputIndex(originId, origin, originSlot, targetType, linkTypes);
    if (inputIndex < 0) invalid(originId, "no_matching_input", { outputSlot: originSlot });

    const input = slotList(origin, "inputs")[inputIndex];
    if (!input || input.link === null || input.link === undefined) {
      invalid(originId, "missing_source", { outputSlot: originSlot, inputSlot: inputIndex });
    }
    const upstream = sourceFromValue(input.link, sources);
    if (!upstream) invalid(originId, "missing_source", { outputSlot: originSlot, inputSlot: inputIndex });
    return resolveSource(upstream, slotType(input.type) ?? linkTypes.get(String(input.link)), nextVisiting);
  };

  return {
    isInactive: (node: Record<string, unknown>) => isComfyUIInactiveNode(node),
    resolve(value: unknown, targetType?: unknown) {
      return resolveSource(sourceFromValue(value, sources), targetType, new Set<string>());
    },
  };
}
