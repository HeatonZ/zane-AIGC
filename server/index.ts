import express from "express";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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

const app = express();
const port = Number(process.env.API_PORT ?? 8799);
const localDirectory = path.resolve(process.cwd(), ".local");
const settingsFile = path.join(localDirectory, "connections.json");
const hermesHome = path.resolve(process.env.HERMES_HOME ?? process.env.HERMES_INSTALL_ROOT ?? path.join(os.homedir(), ".hermes"));
const execFileAsync = promisify(execFile);
const defaults: SavedSettings = {
  enabledHermesProfiles: ["default"],
  comfyuiBaseUrl: "http://127.0.0.1:8188",
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
    const { stdout } = await execFileAsync(process.env.HERMES_BIN ?? "hermes", ["profile", "list"], {
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

function summarizeComfyUIWorkflow(payload: unknown, filename: string) {
  const root = asRecord(payload);
  const uiNodes = Array.isArray(root?.nodes) ? root.nodes : undefined;
  if (uiNodes) {
    const nodes: ComfyUIWorkflowNode[] = uiNodes.flatMap((value) => {
      const node = asRecord(value);
      if (!node || (typeof node.id !== "number" && typeof node.id !== "string")) return [];
      const inputs = Array.isArray(node.inputs) ? node.inputs.flatMap((inputValue) => {
        const input = asRecord(inputValue);
        return input ? [input.name, asRecord(input.widget)?.name] : [];
      }) : [];
      const widgets = asRecord(node.widgets_values_named);
      const outputs = Array.isArray(node.outputs) ? node.outputs.flatMap((outputValue) => {
        const output = asRecord(outputValue);
        return output ? [output.name] : [];
      }) : [];
      return [{
        id: String(node.id),
        type: typeof node.type === "string" ? node.type : "Unknown",
        inputProperties: uniqueStrings([...inputs, ...Object.keys(widgets ?? {})]),
        outputProperties: uniqueStrings(outputs),
      }];
    });
    return { filename, format: "ui" as const, nodes };
  }

  if (root) {
    const nodes: ComfyUIWorkflowNode[] = Object.entries(root).flatMap(([id, value]) => {
      const node = asRecord(value);
      if (!node || typeof node.class_type !== "string" || !asRecord(node.inputs)) return [];
      return [{
        id,
        type: node.class_type,
        inputProperties: Object.keys(asRecord(node.inputs) ?? {}),
        outputProperties: [],
      }];
    });
    if (nodes.length) return { filename, format: "api" as const, nodes };
  }

  return { filename, format: "unknown" as const, nodes: [] };
}

async function fetchComfyUIJson(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
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

function readWorkflowApiGraph(payload: unknown) {
  const root = asRecord(payload);
  if (!root) throw new Error("ComfyUI 工作流内容格式无效");
  if (Array.isArray(root.nodes)) throw new Error("当前选择的是 ComfyUI 画布工作流，请先导出为 API 格式工作流后再运行");
  const graph = Object.entries(root).flatMap(([id, value]) => {
    const node = asRecord(value);
    if (!node || typeof node.class_type !== "string" || !asRecord(node.inputs)) return [];
    return [[id, node] as const];
  });
  if (!graph.length) throw new Error("ComfyUI 工作流中没有 API 格式节点");
  return Object.fromEntries(graph.map(([id, node]) => [id, structuredClone(node)])) as Record<string, Record<string, unknown>>;
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
  const graph = readWorkflowApiGraph(payload);
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
  const bin = process.env.HERMES_BIN ?? "hermes";
  const { stdout } = await execFileAsync(bin, ["-p", profile, "-z", executionPrompt], {
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
    response.json(summarizeComfyUIWorkflow(payload, filename));
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

app.listen(port, "127.0.0.1", () => {
  console.log(`Local API listening on http://127.0.0.1:${port}`);
});
