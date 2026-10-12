import { createComfyUIBypassResolver } from "../comfyuiBypass.js";
import { resolveComfyUIReroutes } from "../comfyuiReroutes.js";
import { comfyNamedAutogrowSchemas } from "../comfyuiInputSchema.js";
import { comfyAutogrowInputNames } from "./comfyMediaBindings.js";
import type { ComfyUIWorkflowNode, ComfyUIPropertyInfo, ComfyUINodeInfo } from "../domain/types.js";
import { asRecord, uniqueStrings } from "../domain/workflowValues.js";

function comfyPropertyType(value: unknown): ComfyUIPropertyInfo["type"] {
  switch (typeof value === "string" ? value.toUpperCase() : "") {
    case "INT":
    case "FLOAT":
    case "NUMBER": return "number";
    case "BOOLEAN": return "boolean";
    case "IMAGE":
    case "MASK": return "image_list";
    case "VIDEO": return "video_list";
    case "AUDIO": return "audio_list";
    case "STRING":
    case "COMBO": return "text";
    default: return "json";
  }
}

export function comfyAutogrowImageInputNames(rawSchema: unknown) {
  return comfyAutogrowInputNames(rawSchema, "image");
}

export function summarizeComfyUINodeInfo(payload: unknown, nodeType: string): ComfyUINodeInfo {
  const root = asRecord(payload);
  const definition = asRecord(root?.[nodeType]) ?? root;
  const inputSchema = asRecord(definition?.input);
  const inputs = ["required", "optional"].flatMap((section) => {
    const entries = asRecord(inputSchema?.[section]);
    return Object.entries(entries ?? {}).flatMap(([name, rawSchema]) => {
      const schema = Array.isArray(rawSchema) ? rawSchema : [rawSchema];
      const rawType = schema[0];
      const options = Array.isArray(rawType)
        ? uniqueStrings(rawType.map((option) => typeof option === "string" ? option : typeof option === "number" ? String(option) : ""))
        : [];
      const typeToken = options.length ? "COMBO" : rawType;
      const type = comfyAutogrowImageInputNames(rawSchema).length ? "image_list"
        : comfyAutogrowInputNames(rawSchema, "audio").length ? "audio_list" : comfyPropertyType(typeToken);
      const namedInputs = Object.entries(comfyNamedAutogrowSchemas(rawSchema, name)).map(([childName, childSchema]) => ({ name: childName, type: comfyPropertyType(Array.isArray(childSchema) ? childSchema[0] : childSchema), required: false }));
      return [{ name, type, required: section === "required", ...(options.length ? { options } : {}) }, ...namedInputs];
    });
  });
  const outputTypes = Array.isArray(definition?.output) ? definition.output : [];
  const outputNames = Array.isArray(definition?.output_name) ? definition.output_name : [];
  const outputs = outputTypes.flatMap((rawType, index) => {
    const name = typeof outputNames[index] === "string" ? outputNames[index] : `output_${index + 1}`;
    return [{ name, type: comfyPropertyType(rawType) }];
  });
  return { type: nodeType, inputs, outputs };
}

interface ComfyWorkflowConversion {
  format: "ui" | "api" | "unknown";
  converted: boolean;
  graph: Record<string, Record<string, unknown>>;
  outputProperties: Record<string, string[]>;
}

function comfyNodeId(value: unknown) {
  return typeof value === "number" || typeof value === "string" ? String(value) : undefined;
}

function comfyWidgetName(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  const widget = asRecord(value);
  if (typeof widget?.name === "string" && widget.name.trim()) return widget.name.trim();
  return undefined;
}

function comfyWidgetNames(node: Record<string, unknown>) {
  const inputNames = Array.isArray(node.inputs) ? node.inputs.flatMap((value) => {
    const input = asRecord(value);
    const name = comfyWidgetName(input?.widget);
    return name ? [name] : [];
  }) : [];
  const widgetNames = Array.isArray(node.widgets) ? node.widgets.flatMap((value) => {
    const widget = asRecord(value);
    return typeof widget?.name === "string" && widget.name.trim() ? [widget.name.trim()] : [];
  }) : [];
  return uniqueStrings([...inputNames, ...widgetNames]);
}

function comfyWidgetValues(node: Record<string, unknown>) {
  const named = asRecord(node.widgets_values_named) ?? asRecord(node.widgets_values);
  const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  const valueEntries = values.flatMap((value) => {
    const entry = asRecord(value);
    if (typeof entry?.name !== "string" || !("value" in entry)) return [];
    return [{ name: entry.name, value: entry.value }];
  });
  const namedValues = Object.fromEntries([
    ...Object.entries(named ?? {}),
    ...valueEntries.map((entry) => [entry.name, entry.value] as const),
  ]);
  return { named: namedValues, values: valueEntries.length ? [] : values };
}

function comfyObjectInfoDefinition(payload: unknown) {
  const root = asRecord(payload);
  if (!root) return undefined;
  const firstKey = Object.keys(root)[0];
  return asRecord((firstKey && asRecord(root[firstKey])?.input) ? root[firstKey] : root);
}

function comfyObjectInfoInputNames(payload: unknown) {
  const definition = comfyObjectInfoDefinition(payload);
  const input = asRecord(definition?.input);
  const inputOrder = asRecord(definition?.input_order);
  const ordered = ["required", "optional"].flatMap((section) => {
    const names = inputOrder?.[section];
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
  });
  const schemaNames = ["required", "optional"].flatMap((section) => {
    const entries = asRecord(input?.[section]);
    return Object.keys(entries ?? {});
  });
  return uniqueStrings([...ordered, ...schemaNames]);
}

function comfyLink(value: unknown) {
  if (Array.isArray(value)) {
    const originId = comfyNodeId(value[0]);
    const originSlot = typeof value[1] === "number" ? value[1] : Number(value[1]);
    return originId && Number.isInteger(originSlot) ? [originId, originSlot] as const : undefined;
  }
  const link = asRecord(value);
  const originId = comfyNodeId(link?.origin_id ?? link?.originId);
  const originSlot = typeof (link?.origin_slot ?? link?.originSlot) === "number"
    ? (link?.origin_slot ?? link?.originSlot) as number
    : Number(link?.origin_slot ?? link?.originSlot);
  return originId && Number.isInteger(originSlot) ? [originId, originSlot] as const : undefined;
}

interface ComfyUIWorkflowNodeEntry {
  id: string;
  node: Record<string, unknown>;
}

interface ComfyUIWorkflowLink {
  id: string;
  originId: string;
  originSlot: number;
  targetId: string;
  targetSlot: number;
  type?: string | number;
}

type ComfyLinkSource =
  | { kind: "link"; value: readonly [string, number] }
  | { kind: "literal"; value: unknown };

interface ComfyUIWorkflowExpansion {
  nodes: ComfyUIWorkflowNodeEntry[];
  sources: Map<string, ComfyLinkSource>;
  linkTypes: Map<string, string | number>;
}

function comfyNodeEntries(payload: unknown): ComfyUIWorkflowNodeEntry[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((value) => {
    const node = asRecord(value);
    const id = comfyNodeId(node?.id);
    return id && node ? [{ id, node }] : [];
  });
}

function comfyLinkRecords(payload: unknown): ComfyUIWorkflowLink[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((value) => {
    if (Array.isArray(value)) {
      const id = comfyNodeId(value[0]);
      const originId = comfyNodeId(value[1]);
      const originSlot = typeof value[2] === "number" ? value[2] : Number(value[2]);
      const targetId = comfyNodeId(value[3]);
      const targetSlot = typeof value[4] === "number" ? value[4] : Number(value[4]);
      const type = typeof value[5] === "string" || typeof value[5] === "number" ? value[5] : undefined;
      return id && originId && targetId && Number.isInteger(originSlot) && Number.isInteger(targetSlot)
        ? [{ id, originId, originSlot, targetId, targetSlot, ...(type === undefined ? {} : { type }) }]
        : [];
    }
    const link = asRecord(value);
    const id = comfyNodeId(link?.id);
    const originId = comfyNodeId(link?.origin_id ?? link?.originId);
    const originSlot = typeof (link?.origin_slot ?? link?.originSlot) === "number"
      ? (link?.origin_slot ?? link?.originSlot) as number
      : Number(link?.origin_slot ?? link?.originSlot);
    const targetId = comfyNodeId(link?.target_id ?? link?.targetId);
    const targetSlot = typeof (link?.target_slot ?? link?.targetSlot) === "number"
      ? (link?.target_slot ?? link?.targetSlot) as number
      : Number(link?.target_slot ?? link?.targetSlot);
    const type = typeof link?.type === "string" || typeof link?.type === "number" ? link.type : undefined;
    return id && originId && targetId && Number.isInteger(originSlot) && Number.isInteger(targetSlot)
      ? [{ id, originId, originSlot, targetId, targetSlot, ...(type === undefined ? {} : { type }) }]
      : [];
  });
}

function comfySubgraphDefinitions(root: Record<string, unknown>) {
  const definitions = asRecord(root.definitions);
  const subgraphs = Array.isArray(definitions?.subgraphs) ? definitions.subgraphs : [];
  const result = new Map<string, Record<string, unknown>>();
  for (const value of subgraphs) {
    const definition = asRecord(value);
    const id = typeof definition?.id === "string" ? definition.id : undefined;
    if (id && definition) result.set(id, definition);
  }
  return result;
}

function comfySourceFromLink(value: unknown, sources: Map<string, ComfyLinkSource>): ComfyLinkSource | undefined {
  if (value !== null && value !== undefined) {
    const source = sources.get(String(value));
    if (source) return source;
  }
  const link = comfyLink(value);
  return link ? { kind: "link", value: link } : undefined;
}

function comfySubgraphInputValue(
  instance: Record<string, unknown>,
  definition: Record<string, unknown>,
  inputSlot: number,
  parentSources: Map<string, ComfyLinkSource>,
) {
  const subgraphInputs = Array.isArray(definition.inputs) ? definition.inputs : [];
  const subgraphInput = asRecord(subgraphInputs[inputSlot]);
  const name = typeof subgraphInput?.name === "string" ? subgraphInput.name : undefined;
  if (!name) return undefined;
  const instanceInputs = Array.isArray(instance.inputs) ? instance.inputs : [];
  const instanceInput = instanceInputs.map(asRecord).find((input) => input?.name === name);
  if (instanceInput && instanceInput.link !== null && instanceInput.link !== undefined) {
    return comfySourceFromLink(instanceInput.link, parentSources);
  }
  const widget = comfyWidgetValues(instance);
  if (Object.prototype.hasOwnProperty.call(widget.named, name)) {
    return { kind: "literal" as const, value: widget.named[name] };
  }
  const widgetNames = comfyWidgetNames(instance);
  const valueIndex = widgetNames.indexOf(name);
  if (valueIndex >= 0 && valueIndex < widget.values.length) {
    return { kind: "literal" as const, value: widget.values[valueIndex] };
  }
  return undefined;
}

function expandComfyUIWorkflow(
  nodePayload: unknown,
  linkPayload: unknown,
  definitions: Map<string, Record<string, unknown>>,
  initialSources = new Map<string, ComfyLinkSource>(),
  stack = new Set<string>(),
): ComfyUIWorkflowExpansion {
  const nodes = comfyNodeEntries(nodePayload);
  const links = comfyLinkRecords(linkPayload);
  const sources = new Map(initialSources);
  const linkTypes = new Map<string, string | number>();
  for (const link of links) {
    if (link.type !== undefined) linkTypes.set(link.id, link.type);
    if (!sources.has(link.id) && link.originId !== "-10" && link.originId !== "-20") {
      sources.set(link.id, { kind: "link", value: [link.originId, link.originSlot] });
    }
  }

  const expandedNodes: ComfyUIWorkflowNodeEntry[] = [];
  for (const entry of nodes) {
    const nodeType = typeof entry.node.type === "string" ? entry.node.type : "";
    const definition = definitions.get(nodeType);
    if (!definition || stack.has(nodeType)) {
      expandedNodes.push(entry);
      continue;
    }

    const childSources = new Map<string, ComfyLinkSource>();
    const childLinks = comfyLinkRecords(definition.links);
    for (const link of childLinks) {
      if (link.originId === "-10") {
        const value = comfySubgraphInputValue(entry.node, definition, link.originSlot, sources);
        if (value) childSources.set(link.id, value);
      } else if (link.originId !== "-20") {
        childSources.set(link.id, { kind: "link", value: [link.originId, link.originSlot] });
      }
    }
    const child = expandComfyUIWorkflow(
      definition.nodes,
      definition.links,
      definitions,
      childSources,
      new Set([...stack, nodeType]),
    );
    expandedNodes.push(...child.nodes);
    for (const [linkId, source] of child.sources) sources.set(linkId, source);
    for (const [linkId, type] of child.linkTypes) linkTypes.set(linkId, type);

    const outputSources = new Map<number, ComfyLinkSource>();
    for (const link of childLinks) {
      if (link.targetId !== "-20") continue;
      const source = child.sources.get(link.id);
      if (source) outputSources.set(link.targetSlot, source);
    }
    for (const link of links) {
      if (link.originId !== entry.id) continue;
      const source = outputSources.get(link.originSlot);
      if (source) sources.set(link.id, source);
    }
  }
  return { nodes: expandedNodes, sources, linkTypes };
}

export async function convertComfyUIWorkflow(payload: unknown, baseUrl?: string, signal?: AbortSignal): Promise<ComfyWorkflowConversion> {
  const root = asRecord(payload);
  if (!root) return { format: "unknown", converted: false, graph: {}, outputProperties: {} };

  const apiRoot = asRecord(root.prompt) ?? root;
  const apiGraph = Object.entries(apiRoot).flatMap(([id, value]) => {
    const node = asRecord(value);
    if (!node || typeof node.class_type !== "string" || !asRecord(node.inputs)) return [];
    return [[id, structuredClone(node)] as const];
  });
  if (!Array.isArray(root.nodes) || (!root.nodes.length && apiGraph.length)) {
    return apiGraph.length
      ? { format: "api", converted: false, graph: Object.fromEntries(apiGraph), outputProperties: {} }
      : { format: "unknown", converted: false, graph: {}, outputProperties: {} };
  }

  const expansion = expandComfyUIWorkflow(root.nodes, root.links, comfySubgraphDefinitions(root));
  const uiNodes = expansion.nodes;
  if (!uiNodes.length && apiGraph.length) {
    return { format: "api", converted: false, graph: Object.fromEntries(apiGraph), outputProperties: {} };
  }
  const bypassResolver = createComfyUIBypassResolver(uiNodes, expansion.sources, expansion.linkTypes);
  const activeUiNodes = uiNodes.filter(({ node }) => !bypassResolver.isInactive(node));
  const objectInfoCache = new Map<string, Promise<unknown>>();
  async function loadObjectInfo(nodeType: string) {
    if (!baseUrl) return undefined;
    const cached = objectInfoCache.get(nodeType);
    if (cached) return cached;
    const request = fetchComfyUIJson(`${baseUrl}/object_info/${encodeURIComponent(nodeType)}`, 4500, signal).catch((error) => {
      if (signal?.aborted) throw error;
      return undefined;
    });
    objectInfoCache.set(nodeType, request);
    return request;
  }

  const objectInfoTypes = uniqueStrings(activeUiNodes.flatMap(({ node }) => {
    const values = comfyWidgetValues(node);
    return Object.keys(values.named).length || values.values.length
      ? [typeof node.type === "string" ? node.type : ""]
      : [];
  }));
  await Promise.all(objectInfoTypes.map((nodeType) => loadObjectInfo(nodeType)));

  const graph: Record<string, Record<string, unknown>> = {};
  const outputProperties: Record<string, string[]> = {};
  for (const { id, node } of activeUiNodes) {
    const nodeType = typeof node.type === "string" && node.type.trim() ? node.type : "Unknown";
    if (nodeType === "MarkdownNote" || nodeType === "Note") continue;
    const nodeInputs = Array.isArray(node.inputs) ? node.inputs.flatMap((value) => {
      const input = asRecord(value);
      return input && typeof input.name === "string" ? [{ input, name: input.name }] : [];
    }) : [];
    const inputs: Record<string, unknown> = {};
    const linkedNames = new Set<string>();
    for (const { input, name } of nodeInputs) {
      if (input.link === null || input.link === undefined) continue;
      linkedNames.add(name);
      // Resolve Bypass/Muted nodes before API serialization. The target input
      // type is part of ComfyUI's bypass slot selection, so this is done for
      // each consumer rather than by globally rewriting a shared link ID.
      const source = bypassResolver.resolve(input.link, input.type ?? expansion.linkTypes.get(String(input.link)));
      if (source?.kind === "link") inputs[name] = [...source.value];
      if (source?.kind === "literal") inputs[name] = source.value;
    }

    const widget = comfyWidgetValues(node);
    const definition = Object.keys(widget.named).length || widget.values.length ? await loadObjectInfo(nodeType) : undefined;
    const apiInputNames = comfyObjectInfoInputNames(definition);
    const isApiInput = (name: string) => {
      if (!apiInputNames.length) return true;
      const parentName = name.split(".", 1)[0];
      return apiInputNames.includes(name) || apiInputNames.includes(parentName);
    };
    for (const [name, value] of Object.entries(widget.named)) {
      if (!linkedNames.has(name) && isApiInput(name)) inputs[name] = value;
    }
    if (widget.values.length && !Object.keys(widget.named).length) {
      let names = comfyWidgetNames(node).filter((name) => !linkedNames.has(name));
      if (widget.values.length > names.length) {
        names = uniqueStrings([
          ...names,
          ...apiInputNames.filter((name) => !linkedNames.has(name)),
        ]);
      }
      if (widget.values.length > names.length) {
        names = uniqueStrings([
          ...names,
          ...nodeInputs.map(({ name }) => name).filter((name) => !linkedNames.has(name)),
        ]);
      }
      widget.values.forEach((value, index) => {
        const name = names[index];
        if (name && !linkedNames.has(name) && isApiInput(name) && !(name in inputs)) inputs[name] = value;
      });
    }

    const outputs = Array.isArray(node.outputs) ? node.outputs.flatMap((value) => {
      const output = asRecord(value);
      return typeof output?.name === "string" ? [output.name] : [];
    }) : [];
    outputProperties[id] = uniqueStrings(outputs);
    const properties = asRecord(node.properties);
    const title = typeof properties?.["Node name for S&R"] === "string"
      ? properties["Node name for S&R"]
      : typeof node.title === "string" ? node.title : undefined;
    graph[id] = {
      class_type: nodeType,
      inputs,
      ...(title ? { _meta: { title } } : {}),
    };
  }
  const routedGraph = resolveComfyUIReroutes(graph);
  const converted = Object.keys(routedGraph).length > 0;
  return {
    format: converted ? "ui" : "unknown",
    converted,
    graph: routedGraph,
    outputProperties: Object.fromEntries(Object.entries(outputProperties).filter(([id]) => Object.hasOwn(routedGraph, id))),
  };
}

export async function summarizeComfyUIWorkflow(payload: unknown, filename: string, baseUrl?: string, signal?: AbortSignal) {
  const conversion = await convertComfyUIWorkflow(payload, baseUrl, signal);
  const nodes: ComfyUIWorkflowNode[] = Object.entries(conversion.graph).map(([id, node]) => ({
    id,
    type: typeof node.class_type === "string" ? node.class_type : "Unknown",
    inputProperties: Object.keys(asRecord(node.inputs) ?? {}),
    outputProperties: conversion.outputProperties[id] ?? [],
  }));
  return {
    filename,
    format: conversion.format === "ui" ? "api" as const : conversion.format,
    converted: conversion.converted,
    nodes,
  };
}

export async function fetchComfyUIJson(url: string, timeoutMs = 10000, parentSignal?: AbortSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`ComfyUI 返回 ${response.status}`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}
