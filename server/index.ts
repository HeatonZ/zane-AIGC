import express from "express";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { access, copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface SavedSettings {
  enabledHermesProfiles: string[];
  comfyuiBaseUrl: string;
  projectDirectory: string;
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
  sceneId?: string;
  name?: string;
  inputs: RunInputField[];
  steps: RunStep[];
  outputs: Array<{ key: string; label?: string; type: string; sourceRef: string }>;
}

interface RunArtifactPaths {
  directory: string;
  inputs: string;
  workflow: string;
  runtime: string;
  output: string;
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
  projectDirectory: nonEmpty(process.env.ZANE_PROJECT_DIR) ? path.resolve(process.env.ZANE_PROJECT_DIR as string) : "",
};

app.use(express.json({ limit: "4mb" }));

function cancellationError() {
  const error = new Error("运行已取消");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw cancellationError();
}

function waitForAbortable<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancellationError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(cancellationError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function delayWithAbort(ms: number, signal?: AbortSignal) {
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(cancellationError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(cancellationError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>, signal?: AbortSignal) {
    const previous = this.tail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tail = previous.then(() => current);

    return (async () => {
      try {
        await waitForAbortable(previous, signal);
        throwIfAborted(signal);
        return await task();
      } finally {
        release();
      }
    })();
  }
}

// Hermes steps run directly and may execute in parallel. Every ComfyUI step
// goes through this queue so a single ComfyUI instance is never overrun.
const comfyuiQueue = new SerialTaskQueue();

async function readSettings(): Promise<SavedSettings> {
  try {
    const text = await readFile(settingsFile, "utf8");
    const parsed = JSON.parse(text) as Partial<SavedSettings>;
    return {
      ...defaults,
      ...parsed,
      projectDirectory: normalizeProjectDirectory(parsed.projectDirectory, defaults.projectDirectory),
    };
  } catch {
    return defaults;
  }
}

function publicSettings(settings: SavedSettings) {
  return {
    enabledHermesProfiles: settings.enabledHermesProfiles,
    comfyuiBaseUrl: settings.comfyuiBaseUrl,
    projectDirectory: settings.projectDirectory,
  };
}

function normalizeBaseUrl(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().replace(/\/+$/, "");
}

function normalizeProjectDirectory(value: unknown, fallback: string) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) return "";
  return path.resolve(value.trim());
}

function runArtifactPaths(projectDirectory: string, runId: string): RunArtifactPaths {
  const directory = path.join(projectDirectory, ".zane", "runs", runId);
  return {
    directory,
    inputs: path.join(directory, "inputs", "input.json"),
    workflow: path.join(directory, "workflow.json"),
    runtime: path.join(directory, "runtime.json"),
    output: path.join(directory, "outputs", "result.json"),
  };
}

async function writeJsonFile(filename: string, value: unknown) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function validateProjectDirectory(directory: string) {
  if (!directory) return "";
  await mkdir(directory, { recursive: true });
  if (!(await stat(directory)).isDirectory()) throw new Error("项目目录必须是文件夹");
  const dataDirectory = path.join(directory, ".zane");
  await mkdir(dataDirectory, { recursive: true });
  const marker = path.join(dataDirectory, `.write-check-${randomUUID()}`);
  await writeFile(marker, "ok", { flag: "wx" });
  await unlink(marker);
  return directory;
}

function artifactPublicPaths(paths: RunArtifactPaths) {
  return {
    directory: paths.directory,
    inputs: paths.inputs,
    workflow: paths.workflow,
    runtime: paths.runtime,
    output: paths.output,
  };
}

async function prepareRunArtifacts(settings: SavedSettings, runId: string, workflow: RunWorkflowDefinition, inputValues: Record<string, JsonValue>, startedAt: string) {
  if (!settings.projectDirectory) throw new Error("请先在集成连接中配置项目目录");
  const paths = runArtifactPaths(settings.projectDirectory, runId);
  await mkdir(paths.directory, { recursive: true });
  const inputFiles: Array<{ key: string; path: string; originalPath: string }> = [];
  for (const field of workflow.inputs) {
    const value = inputValues[field.key];
    if ((field.type !== "image" && field.type !== "video") || typeof value !== "string" || !value.trim() || /^(https?:|data:)/i.test(value)) continue;
    const originalPath = path.resolve(value.trim());
    try {
      if (!(await stat(originalPath)).isFile()) continue;
      const extension = path.extname(originalPath).replace(/[^.A-Za-z0-9]/g, "").slice(0, 12);
      const filename = `${field.key.replace(/[^A-Za-z0-9_-]/g, "_") || "input"}${extension}`;
      const relativePath = path.posix.join("inputs", "files", filename);
      const destination = path.join(paths.directory, ...relativePath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(originalPath, destination);
      inputFiles.push({ key: field.key, path: relativePath, originalPath });
    } catch {
      // The input remains in the JSON snapshot if it is not an accessible local file.
    }
  }
  await Promise.all([
    writeJsonFile(paths.inputs, {
      format: "zane-studio.input/v1",
      runId,
      createdAt: startedAt,
      sceneId: workflow.sceneId ?? null,
      workflowName: workflow.name ?? "未命名工作流",
      values: inputValues,
      files: inputFiles,
    }),
    writeJsonFile(paths.workflow, {
      format: "zane-studio.workflow/v1",
      runId,
      createdAt: startedAt,
      workflow,
    }),
    writeJsonFile(paths.runtime, {
      format: "zane-studio.runtime/v1",
      runId,
      status: "running",
      startedAt,
      sceneId: workflow.sceneId ?? null,
      workflowName: workflow.name ?? "未命名工作流",
      artifacts: artifactPublicPaths(paths),
      steps: [],
    }),
  ]);
  return paths;
}

function mediaContentTypeExtension(contentType: string | null) {
  const type = contentType?.split(";")[0].trim().toLowerCase();
  return ({
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  } as Record<string, string>)[type ?? ""] ?? ".bin";
}

async function archiveOutputMedia(value: JsonValue, runId: string, paths: RunArtifactPaths, comfyuiBaseUrl: string, cache: Map<string, JsonValue>, warnings: string[]): Promise<JsonValue> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => archiveOutputMedia(item, runId, paths, comfyuiBaseUrl, cache, warnings)));
  if (!value || typeof value !== "object") return value;
  const media = value as Record<string, JsonValue>;
  if (typeof media.filename === "string" && (typeof media.url === "string" || typeof media.type === "string")) {
    const subfolder = typeof media.subfolder === "string" ? media.subfolder : "";
    const type = typeof media.type === "string" ? media.type : "output";
    const cacheKey = `${media.filename}\n${subfolder}\n${type}`;
    const existing = cache.get(cacheKey);
    if (existing) return existing;
    const query = new URLSearchParams({ filename: media.filename, subfolder, type });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${comfyuiBaseUrl}/view?${query}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`ComfyUI 媒体返回 ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const extension = path.extname(path.basename(media.filename)).replace(/[^.A-Za-z0-9]/g, "").slice(0, 12) || mediaContentTypeExtension(response.headers.get("content-type"));
      const base = path.basename(media.filename, path.extname(media.filename)).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "output";
      const suffix = createHash("sha1").update(cacheKey).digest("hex").slice(0, 8);
      const filename = `${base}-${suffix}${extension}`;
      const mediaDirectory = path.join(paths.directory, "outputs", "media");
      await mkdir(mediaDirectory, { recursive: true });
      await writeFile(path.join(mediaDirectory, filename), bytes);
      const archived: JsonValue = {
        ...media,
        file: `outputs/media/${filename}`,
        url: `/api/workflows/runs/${runId}/media/${encodeURIComponent(filename)}`,
      };
      cache.set(cacheKey, archived);
      return archived;
    } catch (error) {
      warnings.push(`${media.filename}: ${error instanceof Error ? error.message : "归档媒体失败"}`);
      return value;
    } finally {
      clearTimeout(timeout);
    }
  }
  const entries = await Promise.all(Object.entries(media).map(async ([key, item]) => [key, await archiveOutputMedia(item, runId, paths, comfyuiBaseUrl, cache, warnings)] as const));
  return Object.fromEntries(entries);
}

function isRunId(value: string) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

function runStatus(value: unknown): "running" | "completed" | "failed" | "cancelled" {
  return value === "running" || value === "completed" || value === "cancelled" ? value : "failed";
}

async function readJsonFile(filename: string) {
  try {
    return asRecord(JSON.parse(await readFile(filename, "utf8")));
  } catch {
    return undefined;
  }
}

async function readRunRecord(projectDirectory: string, runId: string) {
  const paths = runArtifactPaths(projectDirectory, runId);
  const [runtime, inputs, output] = await Promise.all([
    readJsonFile(paths.runtime),
    readJsonFile(paths.inputs),
    readJsonFile(paths.output),
  ]);
  if (!runtime || !inputs) return undefined;
  const sceneId = typeof runtime.sceneId === "string" ? runtime.sceneId : typeof inputs.sceneId === "string" ? inputs.sceneId : "comic";
  const workflowName = typeof runtime.workflowName === "string" ? runtime.workflowName : typeof inputs.workflowName === "string" ? inputs.workflowName : "未命名工作流";
  const steps = Array.isArray(output?.steps) ? output.steps : Array.isArray(runtime.steps) ? runtime.steps : [];
  const outputs = Array.isArray(output?.outputs) ? output.outputs : [];
  return {
    runId,
    sceneId,
    workflowName,
    status: runStatus(output?.status ?? runtime.status),
    startedAt: typeof runtime.startedAt === "string" ? runtime.startedAt : typeof inputs.createdAt === "string" ? inputs.createdAt : "",
    ...(typeof (output?.finishedAt ?? runtime.finishedAt) === "string" ? { finishedAt: output?.finishedAt ?? runtime.finishedAt } : {}),
    ...(typeof (output?.durationMs ?? runtime.durationMs) === "number" ? { durationMs: output?.durationMs ?? runtime.durationMs } : {}),
    steps,
    outputs,
    ...(typeof output?.error === "string" ? { error: output.error } : {}),
    ...(Array.isArray(output?.archiveWarnings) ? { archiveWarnings: output.archiveWarnings } : Array.isArray(runtime.archiveWarnings) ? { archiveWarnings: runtime.archiveWarnings } : {}),
    inputValues: asRecord(inputs.values) ?? {},
    artifacts: artifactPublicPaths(paths),
  };
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

async function convertComfyUIWorkflow(payload: unknown, baseUrl?: string, signal?: AbortSignal): Promise<ComfyWorkflowConversion> {
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
    const request = fetchComfyUIJson(`${baseUrl}/object_info/${encodeURIComponent(nodeType)}`, 4500, signal).catch((error) => {
      if (signal?.aborted) throw error;
      return undefined;
    });
    objectInfoCache.set(nodeType, request);
    return request;
  }

  const objectInfoTypes = uniqueStrings(uiNodes.flatMap(({ node }) => {
    const values = comfyWidgetValues(node);
    return Object.keys(values.named).length || values.values.length
      ? [typeof node.type === "string" ? node.type : ""]
      : [];
  }));
  await Promise.all(objectInfoTypes.map((nodeType) => loadObjectInfo(nodeType)));

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

async function summarizeComfyUIWorkflow(payload: unknown, filename: string, baseUrl?: string, signal?: AbortSignal) {
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

async function fetchComfyUIJson(url: string, timeoutMs = 10000, parentSignal?: AbortSignal) {
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

async function fetchJson(url: string, init: RequestInit = {}, parentSignal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  const initSignal = init.signal;
  const abortFromParent = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  if (initSignal) {
    if (initSignal.aborted) controller.abort();
    else initSignal.addEventListener("abort", abortFromParent, { once: true });
  }
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
    parentSignal?.removeEventListener("abort", abortFromParent);
    initSignal?.removeEventListener("abort", abortFromParent);
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

async function interruptComfyUI(baseUrl: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(`${baseUrl}/interrupt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
  } catch {
    // Cancellation should still finish locally when ComfyUI is unreachable.
  } finally {
    clearTimeout(timeout);
  }
}

async function readWorkflowApiGraph(payload: unknown, baseUrl?: string, signal?: AbortSignal) {
  const conversion = await convertComfyUIWorkflow(payload, baseUrl, signal);
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

function coerceComfyInputValue(value: JsonValue | undefined, binding: RunComfyBinding, stepName: string, required = binding.required): JsonValue | undefined {
  if (value === undefined) throw new Error(`${stepName} 的输入引用没有值`);
  // Optional scene inputs are represented as null by the Studio. Leaving the
  // ComfyUI widget untouched lets it keep its own default (for example, a
  // random seed) instead of trying to convert null into a number.
  if ((value === null || value === "") && !required) return undefined;
  if (binding.options?.length) {
    if ((value === null || value === "") && !required) return undefined;
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

async function runComfyUIStep(step: RunStep, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, baseUrl: string, signal?: AbortSignal, inputFields: RunInputField[] = []) {
  throwIfAborted(signal);
  const workflowFile = step.comfyui?.workflowFile;
  if (!workflowFile) throw new Error(`${step.name} 尚未选择 ComfyUI 工作流`);
  const encodedPath = workflowApiPath(workflowFile);
  let payload: unknown;
  try {
    payload = await fetchJson(`${baseUrl}/api/userdata/${encodedPath}`, {}, signal);
  } catch {
    throwIfAborted(signal);
    payload = await fetchJson(`${baseUrl}/userdata/${encodedPath}`, {}, signal);
  }
  const graph = await readWorkflowApiGraph(payload, baseUrl, signal);
  const bindings = step.comfyui?.bindings ?? [];
  for (const binding of bindings.filter((item) => item.direction === "input")) {
    const node = graph[binding.nodeId];
    const nodeInputs = asRecord(node?.inputs);
    if (!nodeInputs || !(binding.property in nodeInputs)) throw new Error(`${step.name} 找不到输入绑定 ${binding.nodeId}.${binding.property}`);
    const value = resolveWorkflowReference(binding.sourceRef ?? "", inputs, stepValues);
    const inputKey = /^input\.([a-zA-Z0-9_]+)$/.exec(binding.sourceRef ?? "")?.[1];
    const sourceField = inputKey ? inputFields.find((field) => field.key === inputKey) : undefined;
    const converted = coerceComfyInputValue(value, binding, step.name, sourceField?.required ?? binding.required);
    if (converted !== undefined) nodeInputs[binding.property] = converted;
  }
  let promptId: string | undefined;
  let promptSubmitted = false;
  let interruptPromise: Promise<void> | undefined;
  const requestInterrupt = () => {
    if (!promptSubmitted || interruptPromise) return interruptPromise;
    interruptPromise = interruptComfyUI(baseUrl);
    return interruptPromise;
  };
  const onAbort = () => { void requestInterrupt(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfAborted(signal);
    promptSubmitted = true;
    const queued = asRecord(await fetchJson(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: "zane-aigc-studio" }),
    }, signal));
    promptId = typeof queued?.prompt_id === "string" ? queued.prompt_id : undefined;
    if (!promptId) {
      const details = Array.isArray(queued?.node_errors) ? JSON.stringify(queued.node_errors) : "ComfyUI 未返回任务 ID";
      throw new Error(details);
    }
    throwIfAborted(signal);
    const deadline = Date.now() + 10 * 60 * 1000;
    let history: unknown;
    while (Date.now() < deadline) {
      await delayWithAbort(1000, signal);
      const found = asRecord(await fetchJson(`${baseUrl}/history/${encodeURIComponent(promptId)}`, {}, signal));
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
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) await requestInterrupt();
  }
}

async function runHermesStep(step: RunStep, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, signal?: AbortSignal) {
  throwIfAborted(signal);
  const profile = step.hermesProfile;
  if (!profile || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) throw new Error(`${step.name} 的 Hermes Profile 无效`);
  const outputs = step.outputs ?? [];
  if (!outputs.length) throw new Error(`${step.name} 至少需要定义一个步骤输出`);
  const outputKeys = outputs.map((item) => item.key.trim());
  if (outputKeys.some((key) => !/^[a-zA-Z0-9_]+$/.test(key))) throw new Error(`${step.name} 的输出 key 无效`);
  if (new Set(outputKeys).size !== outputKeys.length) throw new Error(`${step.name} 的输出 key 不能重复`);
  const prompt = resolvePromptTemplate(step.promptTemplate ?? "", inputs, stepValues);
  if (!prompt.trim()) throw new Error(`${step.name} 的提示词为空`);
  const outputInstructions = outputs.map((item, index) => `${index + 1}. ${item.key}（${item.label ?? item.key}，类型：${item.type}）`).join("\n");
  const executionPrompt = `${prompt}\n\n输出要求：\n只输出一个 JSON 对象，不要使用 Markdown 代码围栏，不要附加说明。\n对象必须包含以下字段，字段名必须完全一致：\n${outputInstructions}\n不得输出未声明的字段。`;
  const { stdout } = await execFileAsync(hermesBinary, ["-p", profile, "-z", executionPrompt], {
    timeout: 10 * 60 * 1000,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    signal,
  });
  const output = stdout.trim();
  const result = asRecord(parseHermesJson(output));
  if (!result) throw new Error("Hermes 输出必须是 JSON 对象");
  const declaredKeys = new Set(outputKeys);
  const extraKeys = Object.keys(result).filter((key) => !declaredKeys.has(key));
  if (extraKeys.length) throw new Error(`Hermes 输出包含未声明字段：${extraKeys.join("、")}`);
  return Object.fromEntries(outputs.map((item) => {
    const value = result[item.key];
    if (value === undefined) throw new Error(`Hermes 输出缺少字段：${item.key}`);
    return [item.key, coerceHermesOutput(value, item.type)];
  }));
}

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.post("/api/files/pick", async (request, response) => {
  const type = request.body?.type;
  if (type !== "image" && type !== "video") {
    response.status(400).json({ error: "只支持选择图像或视频文件" });
    return;
  }
  if (process.platform !== "win32") {
    response.status(501).json({ error: "本机路径选择器目前仅支持 Windows，请手动输入资源 URL 或文件路径" });
    return;
  }

  const title = type === "image" ? "选择图像文件" : "选择视频文件";
  const filter = type === "image"
    ? "图像文件|*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif;*.tif;*.tiff|所有文件|*.*"
    : "视频文件|*.mp4;*.mov;*.webm;*.mkv;*.avi;*.m4v|所有文件|*.*";
  const script = [
    "$utf8 = New-Object System.Text.UTF8Encoding($false)",
    "[Console]::OutputEncoding = $utf8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
    `$dialog.Title = '${title}'`,
    `$dialog.Filter = '${filter}'`,
    "$dialog.Multiselect = $false",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.FileName) }",
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
      windowsHide: true,
      timeout: 10 * 60 * 1000,
    });
    response.json({ path: stdout.trim() || null });
  } catch {
    response.status(500).json({ error: "无法打开本机文件选择器" });
  }
});

app.get("/api/settings", async (_request, response) => {
  response.json(publicSettings(await readSettings()));
});

app.get("/api/workflows/runs", async (_request, response) => {
  const settings = await readSettings();
  if (!settings.projectDirectory) {
    response.json({ projectDirectory: "", runs: [] });
    return;
  }
  const runsDirectory = path.join(settings.projectDirectory, ".zane", "runs");
  let entries;
  try {
    entries = await readdir(runsDirectory, { withFileTypes: true });
  } catch {
    response.json({ projectDirectory: settings.projectDirectory, runs: [] });
    return;
  }
  const runs = (await Promise.all(entries
    .filter((entry) => entry.isDirectory() && isRunId(entry.name))
    .map((entry) => readRunRecord(settings.projectDirectory, entry.name))))
    .filter((run): run is NonNullable<typeof run> => Boolean(run))
    .map((run) => ({
      runId: run.runId,
      sceneId: run.sceneId,
      workflowName: run.workflowName,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
      stepCount: run.steps.length,
      outputCount: run.outputs.length,
      ...(run.error ? { error: run.error } : {}),
      artifacts: run.artifacts,
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 200);
  response.json({ projectDirectory: settings.projectDirectory, runs });
});

app.get("/api/workflows/runs/:runId", async (request, response) => {
  const settings = await readSettings();
  const { runId } = request.params;
  if (!isRunId(runId)) {
    response.status(400).json({ error: "运行记录编号无效" });
    return;
  }
  if (!settings.projectDirectory) {
    response.status(400).json({ error: "请先在集成连接中配置项目目录" });
    return;
  }
  const run = await readRunRecord(settings.projectDirectory, runId);
  if (!run) {
    response.status(404).json({ error: "没有找到这条运行记录" });
    return;
  }
  response.json(run);
});

app.get("/api/workflows/runs/:runId/media/:filename", async (request, response) => {
  const settings = await readSettings();
  const { runId, filename } = request.params;
  if (!isRunId(runId) || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(filename) || filename.includes("..")) {
    response.status(400).json({ error: "归档媒体路径无效" });
    return;
  }
  if (!settings.projectDirectory) {
    response.status(404).json({ error: "项目目录未配置" });
    return;
  }
  const mediaDirectory = path.resolve(runArtifactPaths(settings.projectDirectory, runId).directory, "outputs", "media");
  const mediaPath = path.resolve(mediaDirectory, filename);
  if (!mediaPath.startsWith(`${mediaDirectory}${path.sep}`)) {
    response.status(400).json({ error: "归档媒体路径无效" });
    return;
  }
  try {
    const bytes = await readFile(mediaPath);
    const extension = path.extname(filename).toLowerCase();
    const contentType = ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm" } as Record<string, string>)[extension] ?? "application/octet-stream";
    response.type(contentType).send(bytes);
  } catch {
    response.status(404).json({ error: "没有找到归档媒体文件" });
  }
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
  const validatedWorkflow = workflow;
  const requestedRunId = body?.runId;
  if (requestedRunId !== undefined && (typeof requestedRunId !== "string" || !isRunId(requestedRunId))) {
    response.status(400).json({ error: "运行记录编号无效" });
    return;
  }
  const runId = typeof requestedRunId === "string" ? requestedRunId : randomUUID();
  const runController = new AbortController();
  const abortRun = () => {
    if (!response.writableEnded) runController.abort();
  };
  request.once("aborted", abortRun);
  response.once("close", abortRun);
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
  if (settings.projectDirectory && typeof requestedRunId === "string") {
    try {
      await stat(runArtifactPaths(settings.projectDirectory, runId).directory);
      response.status(409).json({ error: "运行记录编号已存在" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const startedAt = new Date().toISOString();
  let artifacts: RunArtifactPaths | undefined;
  try {
    artifacts = await prepareRunArtifacts(settings, runId, workflow, inputValues, startedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法创建项目运行目录";
    response.status(400).json({ error: message });
    return;
  }
  const values = new Map<string, Record<string, JsonValue>>();
  const types = new Map<string, string>();
  for (const field of workflow.inputs) types.set(`input.${field.key}`, field.type === "textarea" || field.type === "select" ? "text" : field.type);
  const steps: Array<{ stepId: string; name: string; status: "running" | "completed" | "skipped" | "failed"; message?: string; outputs?: Record<string, JsonValue> }> = [];
  let failure = "";

  async function persistRuntime(status: "running" | "completed" | "failed" | "cancelled", finishedAt?: string, archiveWarnings?: string[]) {
    if (!artifacts) return;
    await writeJsonFile(artifacts.runtime, {
      format: "zane-studio.runtime/v1",
      runId,
      status,
      startedAt,
      sceneId: validatedWorkflow.sceneId ?? null,
      workflowName: validatedWorkflow.name ?? "未命名工作流",
      artifacts: artifactPublicPaths(artifacts),
      ...(finishedAt ? { finishedAt, durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime() } : {}),
      ...(archiveWarnings?.length ? { archiveWarnings } : {}),
      steps,
    });
  }

  for (let index = 0; index < workflow.steps.length; index += 1) {
    if (runController.signal.aborted) {
      failure = "运行已取消";
      break;
    }
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
        await persistRuntime("running");
        continue;
      }
    }

    try {
      steps.push({ stepId: step.id, name: step.name, status: "running" });
      await persistRuntime("running");
      let outputs: Record<string, JsonValue> = {};
      if (step.kind === "control") {
        const control = step.control;
        if (!control || control.type !== "condition" || !control.rules.length) throw new Error("条件节点至少需要一条规则");
        const results = control.rules.map((rule) => evaluateCondition(rule, inputValues, values, types));
        outputs = { result: control.match === "all" ? results.every(Boolean) : results.some(Boolean) };
      } else if (step.kind === "hermes") {
        outputs = await runHermesStep(step, inputValues, values, runController.signal);
      } else if (step.kind === "comfyui") {
        outputs = await comfyuiQueue.run(
          () => runComfyUIStep(step, inputValues, values, settings.comfyuiBaseUrl, runController.signal, workflow.inputs),
          runController.signal,
        );
      } else {
        throw new Error(`暂不支持执行方式：${step.kind}`);
      }
      values.set(step.id, outputs);
      for (const output of step.outputs ?? []) types.set(`step.${step.id}.outputs.${output.key}`, output.type);
      steps[steps.length - 1] = { stepId: step.id, name: step.name, status: "completed", outputs };
      await persistRuntime("running");
    } catch (error) {
      if (runController.signal.aborted) {
        failure = "运行已取消";
        break;
      }
      failure = error instanceof Error ? error.message : `${step.name} 执行失败`;
      steps[steps.length - 1] = { stepId: step.id, name: step.name, status: "failed", message: failure };
      await persistRuntime("running");
      break;
    }
  }

  if (runController.signal.aborted) {
    const finishedAt = new Date().toISOString();
    await persistRuntime("cancelled", finishedAt);
    if (artifacts) {
      await writeJsonFile(artifacts.output, {
        format: "zane-studio.output/v1",
        runId,
        status: "cancelled",
        startedAt,
        finishedAt,
        durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
        steps,
        outputs: [],
        error: "运行已取消",
      });
    }
    if (!response.writableEnded && !response.destroyed) {
      response.status(499).json({ runId, status: "cancelled", steps, outputs: [], error: "运行已取消", artifacts: artifactPublicPaths(artifacts) });
    }
    return;
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
  const mediaCache = new Map<string, JsonValue>();
  const archiveWarnings: string[] = [];
  const archivedOutputs = await Promise.all(finalOutputs.map(async (output) => ({
    ...output,
    value: await archiveOutputMedia(output.value, runId, artifacts!, settings.comfyuiBaseUrl, mediaCache, archiveWarnings),
  })));
  const archivedSteps = await Promise.all(steps.map(async (step) => step.outputs ? {
    ...step,
    outputs: Object.fromEntries(await Promise.all(Object.entries(step.outputs).map(async ([key, value]) => [
      key,
      await archiveOutputMedia(value, runId, artifacts!, settings.comfyuiBaseUrl, mediaCache, archiveWarnings),
    ] as const))),
  } : step));
  steps.splice(0, steps.length, ...archivedSteps);

  const finishedAt = new Date().toISOString();
  const status = failure ? "failed" as const : "completed" as const;
  const result = {
    runId,
    status,
    steps,
    outputs: archivedOutputs,
    startedAt,
    finishedAt,
    durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    ...(failure ? { error: failure } : {}),
    ...(archiveWarnings.length ? { archiveWarnings } : {}),
    artifacts: artifactPublicPaths(artifacts),
  };
  await writeJsonFile(artifacts.output, {
    format: "zane-studio.output/v1",
    ...result,
  });
  await persistRuntime(status, finishedAt, archiveWarnings);
  response.json(result);
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
    projectDirectory: normalizeProjectDirectory(request.body?.projectDirectory, current.projectDirectory),
  };

  try {
    next.projectDirectory = await validateProjectDirectory(next.projectDirectory);
    await mkdir(localDirectory, { recursive: true });
    await writeFile(settingsFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "项目目录不可写" });
    return;
  }
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
