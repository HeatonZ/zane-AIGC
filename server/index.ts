import express from "express";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface SavedSettings {
  enabledHermesProfiles: string[];
  comfyuiBaseUrl: string;
}

interface HermesProfile {
  id: string;
  isDefault: boolean;
}

interface ComfyUIWorkflowSummary {
  filename: string;
  size?: number;
  modified?: number;
}

interface ComfyUIWorkflowNode {
  id: string;
  type: string;
  inputProperties: string[];
  outputProperties: string[];
}

interface ComfyUIPropertyInfo {
  name: string;
  type: "text" | "number" | "boolean" | "image" | "video" | "json";
  options?: string[];
  required?: boolean;
}

interface ComfyUINodeInfo {
  type: string;
  inputs: ComfyUIPropertyInfo[];
  outputs: ComfyUIPropertyInfo[];
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface RunInputField {
  key: string;
  type: string;
  required?: boolean;
  options?: string[];
}

interface RunStepOutput {
  key: string;
  label?: string;
  type: string;
}

interface RunComfyBinding {
  key: string;
  label?: string;
  direction: "input" | "output";
  nodeId: string;
  property: string;
  type: string;
  options?: string[];
  required?: boolean;
  sourceRef?: string;
}

interface RunStep {
  id: string;
  name: string;
  kind: string;
  hermesProfile?: string;
  inputs?: Array<{ key: string; sourceRef: string }>;
  outputs?: RunStepOutput[];
  promptTemplate?: string;
  comfyui?: {
    workflowFile: string;
    bindings?: RunComfyBinding[];
  };
  control?: {
    type: "condition";
    match: "all" | "any";
    rules: Array<{
      id: string;
      leftRef: string;
      operator: string;
      valueSource: "literal" | "reference";
      rightValue: string;
      rightRef: string;
    }>;
  };
  runCondition?: { conditionStepId: string; expectedResult: boolean };
}

interface RunWorkflowDefinition {
  inputs: RunInputField[];
  steps: RunStep[];
  outputs: Array<{ key: string; label?: string; type: string; sourceRef: string }>;
}

function parseEnvFile(text: string) {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function loadEnvironmentFiles(environment: string) {
  const values: Record<string, string> = {};
  const filenames = [
    ".env",
    ".env.local",
    `.env.${environment}`,
    `.env.${environment}.local`,
  ];
  for (const filename of filenames) {
    try {
      Object.assign(values, parseEnvFile(readFileSync(path.resolve(process.cwd(), filename), "utf8")));
    } catch {
      // Environment files are optional; deployment variables still work.
    }
  }
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function nonEmpty(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const productionFlag = process.argv.includes("--production");
const runtimeEnvironment = productionFlag ? "production" : (process.env.NODE_ENV ?? "development");
if (productionFlag) process.env.NODE_ENV = "production";
loadEnvironmentFiles(runtimeEnvironment);

const isProduction = runtimeEnvironment === "production";
const app = express();
const port = Number(process.env.API_PORT ?? 8799);
const host = nonEmpty(process.env.API_HOST) ?? (isProduction ? "0.0.0.0" : "127.0.0.1");
const localDirectory = path.resolve(nonEmpty(process.env.APP_DATA_DIR) ?? (isProduction ? path.join("data", "production") : ".local"));
const settingsFile = path.join(localDirectory, "connections.json");
const distDirectory = path.resolve(nonEmpty(process.env.DIST_DIR) ?? "dist");
const hermesHome = path.resolve(nonEmpty(process.env.HERMES_HOME) ?? nonEmpty(process.env.HERMES_INSTALL_ROOT) ?? path.join(os.homedir(), ".hermes"));
const hermesBinary = nonEmpty(process.env.HERMES_BIN) ?? "hermes";
const configuredComfyuiBaseUrl = nonEmpty(process.env.COMFYUI_BASE_URL)?.replace(/\/+$/, "");
const execFileAsync = promisify(execFile);
const defaults: SavedSettings = {
  enabledHermesProfiles: ["default"],
  comfyuiBaseUrl: configuredComfyuiBaseUrl ?? "http://127.0.0.1:8188",
};

app.use(express.json({ limit: "4mb" }));

async function readSettings(): Promise<SavedSettings> {
  try {
    const text = await readFile(settingsFile, "utf8");
    return { ...defaults, ...(JSON.parse(text) as Partial<SavedSettings>) };
  } catch {
    return defaults;
  }
}

function publicSettings(settings: SavedSettings) {
  return {
    enabledHermesProfiles: settings.enabledHermesProfiles,
    comfyuiBaseUrl: settings.comfyuiBaseUrl,
  };
}

function normalizeBaseUrl(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().replace(/\/+$/, "");
}

async function probe(
  id: "comfyui",
  name: string,
  url: string,
  headers?: HeadersInit,
) {
  if (!url) {
    return { id, name, status: "not_configured" as const, message: "尚未配置" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      return {
        id,
        name,
        status: "disconnected" as const,
        message: `服务返回 ${response.status}`,
      };
    }
    return { id, name, status: "connected" as const, message: "连接正常" };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "连接超时" : "无法访问服务";
    return { id, name, status: "disconnected" as const, message };
  } finally {
    clearTimeout(timeout);
  }
}

async function listHermesProfiles(): Promise<HermesProfile[]> {
  const profiles: HermesProfile[] = [];
  try {
    await access(path.join(hermesHome, "config.yaml"));
    profiles.push({ id: "default", isDefault: true });
  } catch {
    // The default profile is absent from this Hermes home.
  }

  try {
    const entries = await readdir(path.join(hermesHome, "profiles"), { withFileTypes: true });
    const discovered = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entry.name))
      .map(async (entry) => {
        try {
          await access(path.join(hermesHome, "profiles", entry.name, "config.yaml"));
          return { id: entry.name, isDefault: false };
        } catch {
          return undefined;
        }
      }));
    profiles.push(...discovered.filter((profile): profile is HermesProfile => Boolean(profile)));
  } catch {
    // Hermes may use a single-profile home without a profiles directory.
  }

  return profiles.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id));
}

function parseHermesProfileStates(output: string) {
  const states = new Map<string, boolean>();
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  for (const line of plain.split(/\r?\n/)) {
    const columns = line.trim().split(/\s{2,}/);
    const profileId = columns[0]?.replace(/^[◆*+\s]+/, "");
    const gateway = columns[2]?.trim().toLowerCase();
    if (/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profileId ?? "") && gateway) {
      states.set(profileId, gateway === "running");
    }
  }
  return states;
}

async function checkHermesProfiles(enabledIds: string[]) {
  if (enabledIds.length === 0) {
    return { id: "hermes" as const, name: "Hermes Agent", status: "not_configured" as const, message: "尚未启用 Profile" };
  }

  const available = await listHermesProfiles();
  if (available.length === 0) {
    return { id: "hermes" as const, name: "Hermes Agent", status: "disconnected" as const, message: "未找到本机 Hermes Profile" };
  }

  try {
    const { stdout } = await execFileAsync(hermesBinary, ["profile", "list"], {
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const gatewayStates = parseHermesProfileStates(stdout);
    const known = new Set(available.map((profile) => profile.id));
    const valid = enabledIds.filter((id) => known.has(id));
    const runningCount = valid.filter((id) => gatewayStates.get(id) === true).length;
    if (valid.length === 0) {
      return { id: "hermes" as const, name: "Hermes Agent", status: "disconnected" as const, message: "所选 Profile 已不存在" };
    }
    const status = runningCount === valid.length ? "connected" as const : "disconnected" as const;
    return {
      id: "hermes" as const,
      name: "Hermes Agent",
      status,
      message: `${runningCount}/${valid.length} 个已启用 Profile 的 Gateway 正常`,
    };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    const message = code === "ENOENT"
      ? "找不到 Hermes CLI，请检查 PATH 或设置 HERMES_BIN"
      : "读取 Hermes Profile Gateway 状态失败";
    return { id: "hermes" as const, name: "Hermes Agent", status: "disconnected" as const, message };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function uniqueStrings(values: unknown[]) {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim()))];
}

function comfyPropertyType(value: unknown): ComfyUIPropertyInfo["type"] {
  switch (typeof value === "string" ? value.toUpperCase() : "") {
    case "INT":
    case "FLOAT":
    case "NUMBER": return "number";
    case "BOOLEAN": return "boolean";
    case "IMAGE":
    case "MASK": return "image";
    case "VIDEO": return "video";
    case "STRING":
    case "COMBO": return "text";
    default: return "json";
  }
}

function summarizeComfyUINodeInfo(payload: unknown, nodeType: string): ComfyUINodeInfo {
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
      return [{ name, type: comfyPropertyType(typeToken), required: section === "required", ...(options.length ? { options } : {}) }];
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
}

type ComfyLinkSource =
  | { kind: "link"; value: readonly [string, number] }
  | { kind: "literal"; value: unknown };

interface ComfyUIWorkflowExpansion {
  nodes: ComfyUIWorkflowNodeEntry[];
  sources: Map<string, ComfyLinkSource>;
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
      return id && originId && targetId && Number.isInteger(originSlot) && Number.isInteger(targetSlot)
        ? [{ id, originId, originSlot, targetId, targetSlot }]
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
    return id && originId && targetId && Number.isInteger(originSlot) && Number.isInteger(targetSlot)
      ? [{ id, originId, originSlot, targetId, targetSlot }]
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
  for (const link of links) {
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
  return { nodes: expandedNodes, sources };
}

async function convertComfyUIWorkflow(payload: unknown, baseUrl?: string): Promise<ComfyWorkflowConversion> {
  const root = asRecord(payload);
  if (!root) return { format: "unknown", converted: false, graph: {}, outputProperties: {} };

  const apiRoot = asRecord(root.prompt) ?? root;
  const apiGraph = Object.entries(apiRoot).flatMap(([id, value]) => {
    const node = asRecord(value);
    if (!node || typeof node.class_type !== "string" || !asRecord(node.inputs)) return [];
    return [[id, structuredClone(node)] as const];
  });
  if (!Array.isArray(root.nodes)) {
    return apiGraph.length
      ? { format: "api", converted: false, graph: Object.fromEntries(apiGraph), outputProperties: {} }
      : { format: "unknown", converted: false, graph: {}, outputProperties: {} };
  }

  const expansion = expandComfyUIWorkflow(root.nodes, root.links, comfySubgraphDefinitions(root));
  const uiNodes = expansion.nodes;
  const objectInfoCache = new Map<string, Promise<unknown>>();
  async function loadObjectInfo(nodeType: string) {
    if (!baseUrl) return undefined;
    const cached = objectInfoCache.get(nodeType);
    if (cached) return cached;
    const request = fetchComfyUIJson(`${baseUrl}/object_info/${encodeURIComponent(nodeType)}`, 4500).catch(() => undefined);
    objectInfoCache.set(nodeType, request);
    return request;
  }

  const graph: Record<string, Record<string, unknown>> = {};
  const outputProperties: Record<string, string[]> = {};
  for (const { id, node } of uiNodes) {
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
      const source = comfySourceFromLink(input.link, expansion.sources);
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
  const converted = Object.keys(graph).length > 0;
  return {
    format: converted ? "ui" : "unknown",
    converted,
    graph,
    outputProperties,
  };
}

async function summarizeComfyUIWorkflow(payload: unknown, filename: string, baseUrl?: string) {
  const conversion = await convertComfyUIWorkflow(payload, baseUrl);
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

async function fetchComfyUIJson(url: string, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`ComfyUI 返回 ${response.status}`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const message = asRecord(body)?.error;
      throw new Error(typeof message === "string" ? message : `服务返回 ${response.status}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveWorkflowReference(reference: string, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>) {
  const inputMatch = /^input\.([a-zA-Z0-9_]+)$/.exec(reference);
  if (inputMatch) return inputs[inputMatch[1]];
  const outputMatch = /^step\.([a-zA-Z0-9_-]+)\.outputs\.([a-zA-Z0-9_]+)$/.exec(reference);
  if (outputMatch) return stepValues.get(outputMatch[1])?.[outputMatch[2]];
  throw new Error(`不支持的数据引用：${reference || "（空）"}`);
}

function resolvePromptTemplate(template: string, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>) {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_match, reference: string) => {
    const value = resolveWorkflowReference(reference.trim(), inputs, stepValues);
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]));
  return String(value);
}

function parseHermesJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse((fenced?.[1] ?? trimmed).trim()) as unknown;
}

function coerceHermesOutput(value: unknown, type: string): JsonValue {
  if (type === "text") return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  if (type === "number") {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) throw new Error("Hermes 输出不是有效数字");
    return parsed;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
    throw new Error("Hermes 输出不是有效布尔值");
  }
  if (type === "json") return toJsonValue(typeof value === "string" ? parseHermesJson(value) : value);
  if (type === "image" || type === "video") {
    if (typeof value === "string") return value;
    return toJsonValue(value);
  }
  return toJsonValue(value);
}

function evaluateCondition(rule: NonNullable<RunStep["control"]>["rules"][number], inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, types: Map<string, string>) {
  const left = resolveWorkflowReference(rule.leftRef, inputs, stepValues);
  const leftType = types.get(rule.leftRef) ?? "text";
  const right = rule.valueSource === "reference"
    ? resolveWorkflowReference(rule.rightRef, inputs, stepValues)
    : leftType === "number" && rule.rightValue.trim() !== ""
      ? Number(rule.rightValue)
      : leftType === "boolean"
        ? rule.rightValue === "true"
        : leftType === "json" && rule.rightValue.trim() !== ""
          ? JSON.parse(rule.rightValue) as JsonValue
          : rule.rightValue;
  switch (rule.operator) {
    case "equals": return JSON.stringify(left) === JSON.stringify(right);
    case "not_equals": return JSON.stringify(left) !== JSON.stringify(right);
    case "greater_than": return Number(left) > Number(right);
    case "greater_or_equal": return Number(left) >= Number(right);
    case "less_than": return Number(left) < Number(right);
    case "less_or_equal": return Number(left) <= Number(right);
    case "contains": return Array.isArray(left) ? left.some((item) => JSON.stringify(item) === JSON.stringify(right)) : typeof left === "string" ? left.includes(String(right ?? "")) : typeof left === "object" && left !== null ? String(right) in left : false;
    case "not_contains": return Array.isArray(left) ? !left.some((item) => JSON.stringify(item) === JSON.stringify(right)) : typeof left === "string" ? !left.includes(String(right ?? "")) : typeof left === "object" && left !== null ? !(String(right) in left) : true;
    case "is_empty": return left === undefined || left === null || left === "" || (Array.isArray(left) && left.length === 0) || (typeof left === "object" && left !== null && Object.keys(left).length === 0);
    case "is_not_empty": return !(left === undefined || left === null || left === "" || (Array.isArray(left) && left.length === 0) || (typeof left === "object" && left !== null && Object.keys(left).length === 0));
    default: throw new Error(`不支持的条件运算符：${rule.operator}`);
  }
}

function workflowApiPath(filename: string) {
  if (!filename || filename.includes("..") || filename.startsWith("/") || filename.includes("\\")) throw new Error("ComfyUI 工作流文件名无效");
  return `workflows/${filename}`.split("/").map((segment) => encodeURIComponent(segment)).join("%252F");
}

async function readWorkflowApiGraph(payload: unknown, baseUrl?: string) {
  const conversion = await convertComfyUIWorkflow(payload, baseUrl);
  const graph = conversion.graph;
  if (!Object.keys(graph).length) {
    if (conversion.format === "ui") throw new Error("ComfyUI 画布工作流中没有可转换的节点");
    throw new Error("ComfyUI 工作流内容格式无效，未找到可执行节点");
  }
  return graph;
}

function readComfyOutputValue(history: unknown, promptId: string, nodeId: string, property: string, type: string): JsonValue {
  const prompt = asRecord(history)?.[promptId];
  const outputs = asRecord(asRecord(prompt)?.outputs);
  const nodeOutput = asRecord(outputs?.[nodeId]);
  const propertyValue = nodeOutput?.[property];
  const media = (Array.isArray(propertyValue) ? propertyValue : propertyValue === undefined ? [] : [propertyValue]).flatMap((value) => {
    const item = asRecord(value);
    return item && typeof item.filename === "string" ? [{
      filename: item.filename,
      subfolder: typeof item.subfolder === "string" ? item.subfolder : "",
      type: typeof item.type === "string" ? item.type : "output",
      url: `/api/comfyui/view?${new URLSearchParams({
        filename: item.filename,
        subfolder: typeof item.subfolder === "string" ? item.subfolder : "",
        type: typeof item.type === "string" ? item.type : "output",
      })}`,
    }] : [];
  });
  if (!nodeOutput || !(property in nodeOutput)) throw new Error(`ComfyUI 节点 ${nodeId} 没有输出属性 ${property}`);
  if (type === "image" || type === "video") {
    if (!media.length) throw new Error(`ComfyUI 属性 ${nodeId}.${property} 中没有可预览媒体`);
    return media.length === 1 ? media[0] : media;
  }
  const value = propertyValue;
  if (value === undefined) return null;
  return toJsonValue(value);
}

function coerceComfyInputValue(value: JsonValue | undefined, binding: RunComfyBinding, stepName: string): JsonValue | undefined {
  if (value === undefined) throw new Error(`${stepName} 的输入引用没有值`);
  if (binding.options?.length) {
    if ((value === null || value === "") && !binding.required) return undefined;
    const optionValue = typeof value === "string" ? value : String(value);
    if (!binding.options.includes(optionValue)) {
      throw new Error(`${stepName} 的 ${binding.property} 需要从可用选项中选择：${binding.options.join("、")}`);
    }
    return optionValue;
  }
  if (binding.type === "number") {
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(number)) throw new Error(`${stepName} 的 ${binding.property} 需要有效数字`);
    return number;
  }
  if (binding.type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
    throw new Error(`${stepName} 的 ${binding.property} 需要布尔值`);
  }
  if (binding.type === "text") return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return toJsonValue(value);
}

async function runComfyUIStep(step: RunStep, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, baseUrl: string) {
  const workflowFile = step.comfyui?.workflowFile;
  if (!workflowFile) throw new Error(`${step.name} 尚未选择 ComfyUI 工作流`);
  const encodedPath = workflowApiPath(workflowFile);
  let payload: unknown;
  try {
    payload = await fetchJson(`${baseUrl}/api/userdata/${encodedPath}`);
  } catch {
    payload = await fetchJson(`${baseUrl}/userdata/${encodedPath}`);
  }
  const graph = await readWorkflowApiGraph(payload, baseUrl);
  const bindings = step.comfyui?.bindings ?? [];
  for (const binding of bindings.filter((item) => item.direction === "input")) {
    const node = graph[binding.nodeId];
    const nodeInputs = asRecord(node?.inputs);
    if (!nodeInputs || !(binding.property in nodeInputs)) throw new Error(`${step.name} 找不到输入绑定 ${binding.nodeId}.${binding.property}`);
    const value = resolveWorkflowReference(binding.sourceRef ?? "", inputs, stepValues);
    const converted = coerceComfyInputValue(value, binding, step.name);
    if (converted !== undefined) nodeInputs[binding.property] = converted;
  }
  const queued = asRecord(await fetchJson(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: "zane-aigc-studio" }),
  }));
  const promptId = queued?.prompt_id;
  if (typeof promptId !== "string") {
    const details = Array.isArray(queued?.node_errors) ? JSON.stringify(queued.node_errors) : "ComfyUI 未返回任务 ID";
    throw new Error(details);
  }
  const deadline = Date.now() + 10 * 60 * 1000;
  let history: unknown;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const found = asRecord(await fetchJson(`${baseUrl}/history/${encodeURIComponent(promptId)}`));
    if (found && found[promptId]) {
      history = found;
      break;
    }
  }
  if (!history) throw new Error("等待 ComfyUI 任务完成超时");
  const historyEntry = asRecord(asRecord(history)?.[promptId]);
  const status = asRecord(historyEntry?.status);
  if (status?.status_str === "error") {
    const messages = Array.isArray(status.messages) ? status.messages : [];
    const executionError = messages.find((item) => Array.isArray(item) && item[0] === "execution_error");
    const detail = Array.isArray(executionError) ? asRecord(executionError[1]) : undefined;
    const errorMessage = typeof detail?.exception_message === "string" ? detail.exception_message : "ComfyUI 节点执行失败";
    const nodeType = typeof detail?.node_type === "string" ? `（${detail.node_type}）` : "";
    throw new Error(`ComfyUI 执行失败${nodeType}：${errorMessage}`);
  }
  const outputValues: Record<string, JsonValue> = {};
  for (const binding of bindings.filter((item) => item.direction === "output")) {
    const declared = step.outputs?.find((output) => output.key === binding.key);
    const type = declared?.type ?? binding.type;
    outputValues[binding.key] = readComfyOutputValue(history, promptId, binding.nodeId, binding.property, type);
  }
  return outputValues;
}

async function runHermesStep(step: RunStep, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>) {
  const profile = step.hermesProfile;
  if (!profile || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) throw new Error(`${step.name} 的 Hermes Profile 无效`);
  const outputs = step.outputs ?? [];
  const prompt = resolvePromptTemplate(step.promptTemplate ?? "", inputs, stepValues);
  if (!prompt.trim()) throw new Error(`${step.name} 的提示词为空`);
  const executionPrompt = outputs.length > 1
    ? `${prompt}\n\n请将最终结果输出为 JSON 对象，字段名为：${outputs.map((item) => item.key).join("、")}。只输出 JSON，不要附加说明。`
    : prompt;
  const { stdout } = await execFileAsync(hermesBinary, ["-p", profile, "-z", executionPrompt], {
    timeout: 10 * 60 * 1000,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = stdout.trim();
  const result = outputs.length > 1 ? asRecord(parseHermesJson(output)) : undefined;
  if (outputs.length > 1 && !result) throw new Error("Hermes 多字段输出需要是 JSON 对象");
  return Object.fromEntries(outputs.map((item) => {
    const value = outputs.length > 1 ? result?.[item.key] : output;
    if (value === undefined) throw new Error(`Hermes 输出缺少字段：${item.key}`);
    return [item.key, coerceHermesOutput(value, item.type)];
  }));
}

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/api/settings", async (_request, response) => {
  response.json(publicSettings(await readSettings()));
});

app.get("/api/hermes/profiles", async (_request, response) => {
  response.json(await listHermesProfiles());
});

app.get("/api/comfyui/workflows", async (_request, response) => {
  const settings = await readSettings();
  if (!settings.comfyuiBaseUrl) {
    response.status(400).json({ error: "尚未配置 ComfyUI 地址" });
    return;
  }

  try {
    const payload = await fetchComfyUIJson(`${settings.comfyuiBaseUrl}/api/userdata?dir=workflows&recurse=true&full_info=true`);
    const workflows: ComfyUIWorkflowSummary[] = Array.isArray(payload)
      ? payload.flatMap((entry) => {
        if (typeof entry === "string") return [{ filename: entry }];
        const item = asRecord(entry);
        return typeof item?.path === "string" ? [{
          filename: item.path,
          size: typeof item.size === "number" ? item.size : undefined,
          modified: typeof item.modified === "number" ? item.modified : undefined,
        }] : [];
      }).filter((workflow) => workflow.filename.toLowerCase().endsWith(".json") && !workflow.filename.includes(".bak-"))
      : [];
    response.json(workflows.sort((a, b) => a.filename.localeCompare(b.filename, "zh-CN")));
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "读取 ComfyUI 工作流超时" : "读取 ComfyUI 工作流失败";
    response.status(502).json({ error: message });
  }
});

app.get("/api/comfyui/workflow", async (request, response) => {
  const settings = await readSettings();
  const filename = typeof request.query.filename === "string" ? request.query.filename : "";
  if (!settings.comfyuiBaseUrl || !filename) {
    response.status(400).json({ error: "缺少 ComfyUI 地址或工作流文件名" });
    return;
  }

  // Aiohttp decodes the path parameter once before ComfyUI unquotes it again.
  // Encode each filename segment once and keep separators double encoded.
  const encodedFilename = `workflows/${filename}`.split("/").map((segment) => encodeURIComponent(segment)).join("%252F");
  try {
    let payload: unknown;
    try {
      payload = await fetchComfyUIJson(`${settings.comfyuiBaseUrl}/api/userdata/${encodedFilename}`);
    } catch {
      payload = await fetchComfyUIJson(`${settings.comfyuiBaseUrl}/userdata/${encodedFilename}`);
    }
    response.json(await summarizeComfyUIWorkflow(payload, filename, settings.comfyuiBaseUrl));
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "读取 ComfyUI 工作流超时" : "读取 ComfyUI 工作流内容失败";
    response.status(502).json({ error: message });
  }
});

app.get("/api/comfyui/node-info", async (request, response) => {
  const settings = await readSettings();
  const nodeType = typeof request.query.type === "string" ? request.query.type.trim() : "";
  if (!settings.comfyuiBaseUrl || !nodeType || nodeType.length > 200) {
    response.status(400).json({ error: "缺少 ComfyUI 地址或节点类型" });
    return;
  }

  try {
    const payload = await fetchComfyUIJson(`${settings.comfyuiBaseUrl}/object_info/${encodeURIComponent(nodeType)}`);
    const info = summarizeComfyUINodeInfo(payload, nodeType);
    if (!info.inputs.length && !info.outputs.length) {
      response.status(404).json({ error: `ComfyUI 中没有找到节点类型：${nodeType}` });
      return;
    }
    response.json(info);
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "读取 ComfyUI 节点属性超时" : "读取 ComfyUI 节点属性失败";
    response.status(502).json({ error: message });
  }
});

app.get("/api/comfyui/view", async (request, response) => {
  const settings = await readSettings();
  const filename = typeof request.query.filename === "string" ? request.query.filename : "";
  const subfolder = typeof request.query.subfolder === "string" ? request.query.subfolder : "";
  const type = typeof request.query.type === "string" ? request.query.type : "output";
  if (!settings.comfyuiBaseUrl || !filename || filename.includes("..") || subfolder.includes("..")) {
    response.status(400).json({ error: "ComfyUI 媒体参数无效" });
    return;
  }
  const query = new URLSearchParams({ filename, subfolder, type });
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const upstream = await fetch(`${settings.comfyuiBaseUrl}/view?${query}`, { signal: controller.signal });
      if (!upstream.ok) {
        response.status(upstream.status).json({ error: "无法读取 ComfyUI 输出媒体" });
        return;
      }
      response.type(upstream.headers.get("content-type") ?? "application/octet-stream");
      response.send(Buffer.from(await upstream.arrayBuffer()));
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    response.status(502).json({ error: "读取 ComfyUI 输出媒体失败" });
  }
});

app.post("/api/workflows/run", async (request, response) => {
  const body = asRecord(request.body);
  const workflow = asRecord(body?.workflow) as unknown as RunWorkflowDefinition | undefined;
  const rawInputs = asRecord(body?.inputValues);
  if (!workflow || !Array.isArray(workflow.inputs) || !Array.isArray(workflow.steps) || !Array.isArray(workflow.outputs) || !rawInputs) {
    response.status(400).json({ error: "工作流定义或场景输入格式无效" });
    return;
  }
  if (workflow.steps.length > 100 || workflow.inputs.length > 200) {
    response.status(400).json({ error: "工作流规模超出限制" });
    return;
  }
  const inputValues = rawInputs as Record<string, JsonValue>;
  for (const field of workflow.inputs) {
    const value = inputValues[field.key];
    const empty = value === undefined || value === null || value === "";
    if (field.required && empty) {
      response.status(400).json({ error: `请填写必填字段：${field.key}` });
      return;
    }
    if (empty) continue;
    const correctType = field.type === "number" ? typeof value === "number" && Number.isFinite(value)
      : field.type === "boolean" ? typeof value === "boolean"
        : field.type === "json" ? typeof value === "object"
          : typeof value === "string";
    if (!correctType) {
      response.status(400).json({ error: `字段 ${field.key} 的数据类型不匹配` });
      return;
    }
    if (field.type === "select" && Array.isArray(field.options) && !field.options.includes(String(value))) {
      response.status(400).json({ error: `字段 ${field.key} 的选项无效` });
      return;
    }
  }

  const settings = await readSettings();
  const values = new Map<string, Record<string, JsonValue>>();
  const types = new Map<string, string>();
  for (const field of workflow.inputs) types.set(`input.${field.key}`, field.type === "textarea" || field.type === "select" ? "text" : field.type);
  const steps: Array<{ stepId: string; name: string; status: "completed" | "skipped" | "failed"; message?: string; outputs?: Record<string, JsonValue> }> = [];
  let failure = "";

  for (let index = 0; index < workflow.steps.length; index += 1) {
    const step = workflow.steps[index];
    if (!step || typeof step.id !== "string" || typeof step.name !== "string") {
      failure = `第 ${index + 1} 步配置无效`;
      break;
    }
    if (step.runCondition) {
      const condition = values.get(step.runCondition.conditionStepId)?.result;
      if (typeof condition !== "boolean") {
        failure = `${step.name} 引用的条件节点没有布尔结果`;
        steps.push({ stepId: step.id, name: step.name, status: "failed", message: failure });
        break;
      }
      if (condition !== step.runCondition.expectedResult) {
        steps.push({ stepId: step.id, name: step.name, status: "skipped", message: "执行条件未满足" });
        continue;
      }
    }

    try {
      let outputs: Record<string, JsonValue> = {};
      if (step.kind === "control") {
        const control = step.control;
        if (!control || control.type !== "condition" || !control.rules.length) throw new Error("条件节点至少需要一条规则");
        const results = control.rules.map((rule) => evaluateCondition(rule, inputValues, values, types));
        outputs = { result: control.match === "all" ? results.every(Boolean) : results.some(Boolean) };
      } else if (step.kind === "hermes") {
        outputs = await runHermesStep(step, inputValues, values);
      } else if (step.kind === "comfyui") {
        outputs = await runComfyUIStep(step, inputValues, values, settings.comfyuiBaseUrl);
      } else {
        throw new Error(`暂不支持执行方式：${step.kind}`);
      }
      values.set(step.id, outputs);
      for (const output of step.outputs ?? []) types.set(`step.${step.id}.outputs.${output.key}`, output.type);
      steps.push({ stepId: step.id, name: step.name, status: "completed", outputs });
    } catch (error) {
      failure = error instanceof Error ? error.message : `${step.name} 执行失败`;
      steps.push({ stepId: step.id, name: step.name, status: "failed", message: failure });
      break;
    }
  }

  const finalOutputs = workflow.outputs.map((output) => {
    try {
      return {
        key: output.key,
        label: output.label ?? output.key,
        type: output.type,
        value: resolveWorkflowReference(output.sourceRef, inputValues, values) ?? null,
      };
    } catch {
      return { key: output.key, label: output.label ?? output.key, type: output.type, value: null };
    }
  });
  response.json({
    runId: randomUUID(),
    status: failure ? "failed" : "completed",
    steps,
    outputs: finalOutputs,
    ...(failure ? { error: failure } : {}),
  });
});

app.put("/api/settings", async (request, response) => {
  const current = await readSettings();
  const profiles = await listHermesProfiles();
  const available = new Set(profiles.map((profile) => profile.id));
  const requestedProfiles: string[] = Array.isArray(request.body?.enabledHermesProfiles)
    ? (request.body.enabledHermesProfiles as unknown[]).filter((id): id is string => typeof id === "string" && available.has(id))
    : current.enabledHermesProfiles;
  const next: SavedSettings = {
    enabledHermesProfiles: [...new Set(requestedProfiles)],
    comfyuiBaseUrl: normalizeBaseUrl(request.body?.comfyuiBaseUrl, defaults.comfyuiBaseUrl),
  };

  await mkdir(localDirectory, { recursive: true });
  await writeFile(settingsFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  response.json(publicSettings(next));
});

app.post("/api/integrations/check", async (_request, response) => {
  const settings = await readSettings();
  const requestedProfiles = Array.isArray(_request.body?.enabledHermesProfiles)
    ? _request.body.enabledHermesProfiles.filter((id: unknown): id is string => typeof id === "string")
    : settings.enabledHermesProfiles;
  const [hermes, comfyui] = await Promise.all([
    checkHermesProfiles(requestedProfiles),
    probe(
      "comfyui",
      "ComfyUI",
      settings.comfyuiBaseUrl ? `${settings.comfyuiBaseUrl}/system_stats` : "",
    ),
  ]);
  response.json([hermes, comfyui]);
});

if (isProduction) {
  app.use(express.static(distDirectory, { index: false }));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path === "/api" || request.path.startsWith("/api/") || path.extname(request.path)) {
      next();
      return;
    }
    response.sendFile(path.join(distDirectory, "index.html"), (error) => {
      if (error) next(error);
    });
  });
}

app.listen(port, host, () => {
  console.log(`${isProduction ? "Production" : "Development"} server listening on http://${host}:${port}`);
  if (isProduction) console.log(`Serving web assets from ${distDirectory}`);
});
