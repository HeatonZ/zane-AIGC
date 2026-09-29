import express from "express";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual, promisify } from "node:util";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface SavedSettings {
  enabledHermesProfiles: string[];
  comfyuiBaseUrl: string;
  projectDirectory: string;
  workflowTimeoutMinutes: number;
}

interface HermesProfile {
  id: string;
  isDefault: boolean;
}

interface HermesApiConnection {
  baseUrl: string;
  apiKey: string;
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
  type: "text" | "number" | "boolean" | "image" | "image_list" | "video" | "json";
  options?: string[];
  required?: boolean;
}

interface ComfyUINodeInfo {
  type: string;
  inputs: ComfyUIPropertyInfo[];
  outputs: ComfyUIPropertyInfo[];
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const defaultWorkflowTimeoutMinutes = 10;
const minimumWorkflowTimeoutMinutes = 1;
const maximumWorkflowTimeoutMinutes = 24 * 60;

function parseWorkflowTimeoutMinutes(value: unknown) {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(numeric) && numeric >= minimumWorkflowTimeoutMinutes && numeric <= maximumWorkflowTimeoutMinutes
    ? numeric
    : undefined;
}

function normalizeWorkflowTimeoutMinutes(value: unknown, fallback = defaultWorkflowTimeoutMinutes) {
  return parseWorkflowTimeoutMinutes(value) ?? fallback;
}

function workflowTimeoutMs(minutes: number) {
  return minutes * 60 * 1000;
}

function workflowTimeoutLabel(minutes: number) {
  return `${minutes} 分钟`;
}

interface RunInputField {
  key: string;
  type: string;
  required?: boolean;
  options?: string[];
}

interface RunStepOutput {
  key: string;
  label?: string;
  description?: string;
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
  valueSource?: "literal" | "reference";
  literalValue?: string;
}

interface RunStepInput {
  key: string;
  label?: string;
  sourceRef?: string;
  valueSource?: "literal" | "reference";
  literalValue?: string;
  literalType?: string;
}

interface RunStep {
  id: string;
  name: string;
  kind: string;
  hermesProfile?: string;
  inputs?: RunStepInput[];
  outputs?: RunStepOutput[];
  promptTemplate?: string;
  execution?: {
    mode?: "once" | "for_each";
    sourceRef?: string;
    onError?: "continue" | "stop";
  };
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
  execution?: {
    mode?: "once" | "for_each";
    sourceRef?: string;
    onError?: "continue" | "stop";
  };
}

interface RunStepRecord {
  stepId: string;
  name: string;
  status: "running" | "completed" | "skipped" | "failed" | "cancelled";
  message?: string;
  inputs?: Record<string, JsonValue>;
  inputLabels?: Record<string, string>;
  outputs?: Record<string, JsonValue>;
  outputLabels?: Record<string, string>;
  outputTypes?: Record<string, string>;
  items?: RunStepItemRecord[];
}

interface RunStepItemRecord {
  index: number;
  value: JsonValue;
  status: "running" | "completed" | "skipped" | "failed" | "cancelled";
  inputs?: Record<string, JsonValue>;
  outputs?: Record<string, JsonValue>;
  error?: string;
}

interface RunItemResult {
  index: number;
  value: JsonValue;
  status: "completed" | "failed" | "cancelled";
  steps: RunStepRecord[];
  outputs: Array<{ key: string; label: string; type: string; value: JsonValue }>;
  error?: string;
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
const activeWorkflowRunCancellations = new Map<string, (reason: string) => void>();
const activeWorkflowRunResumes = new Set<string>();
const port = Number(process.env.API_PORT ?? (isProduction ? 8799 : 8798));
const host = nonEmpty(process.env.API_HOST) ?? (isProduction ? "0.0.0.0" : "127.0.0.1");
const localDirectory = path.resolve(nonEmpty(process.env.APP_DATA_DIR) ?? (isProduction ? path.join("data", "production") : ".local"));
const settingsFile = path.join(localDirectory, "connections.json");
const workspaceFile = path.join(localDirectory, "workspace.json");
const distDirectory = path.resolve(nonEmpty(process.env.DIST_DIR) ?? "dist");
const hermesHome = path.resolve(nonEmpty(process.env.HERMES_HOME) ?? nonEmpty(process.env.HERMES_INSTALL_ROOT) ?? path.join(os.homedir(), ".hermes"));
const configuredComfyuiBaseUrl = nonEmpty(process.env.COMFYUI_BASE_URL)?.replace(/\/+$/, "");
const configuredWorkflowTimeoutMinutes = normalizeWorkflowTimeoutMinutes(process.env.ZANE_WORKFLOW_TIMEOUT_MINUTES);
const ffmpegBinary = nonEmpty(process.env.FFMPEG_BIN) ?? "ffmpeg";
const ffprobeBinary = nonEmpty(process.env.FFPROBE_BIN) ?? "ffprobe";
const execFileAsync = promisify(execFile);
const defaults: SavedSettings = {
  enabledHermesProfiles: ["default"],
  comfyuiBaseUrl: configuredComfyuiBaseUrl ?? "http://127.0.0.1:8188",
  projectDirectory: nonEmpty(process.env.ZANE_PROJECT_DIR) ? path.resolve(process.env.ZANE_PROJECT_DIR as string) : "",
  workflowTimeoutMinutes: configuredWorkflowTimeoutMinutes,
};

app.use(express.json({ limit: "16mb" }));

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
      workflowTimeoutMinutes: normalizeWorkflowTimeoutMinutes(parsed.workflowTimeoutMinutes, defaults.workflowTimeoutMinutes),
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
    workflowTimeoutMinutes: settings.workflowTimeoutMinutes,
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

async function prepareRunArtifacts(settings: SavedSettings, runId: string, workflow: RunWorkflowDefinition, inputValues: Record<string, JsonValue>, startedAt: string, runTitle?: string) {
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
      ...(runTitle ? { runTitle } : {}),
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
      ...(runTitle ? { runTitle } : {}),
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
  const [runtime, inputs, output, workflowFile] = await Promise.all([
    readJsonFile(paths.runtime),
    readJsonFile(paths.inputs),
    readJsonFile(paths.output),
    readJsonFile(paths.workflow),
  ]);
  if (!runtime || !inputs) return undefined;
  const sceneId = typeof runtime.sceneId === "string" ? runtime.sceneId : typeof inputs.sceneId === "string" ? inputs.sceneId : "comic";
  const workflowName = typeof runtime.workflowName === "string" ? runtime.workflowName : typeof inputs.workflowName === "string" ? inputs.workflowName : "未命名工作流";
  const rawRunTitle = runtime.runTitle ?? inputs.runTitle;
  const runTitle = typeof rawRunTitle === "string" && rawRunTitle.trim() ? rawRunTitle.trim() : undefined;
  const workflow = asRecord(workflowFile?.workflow);
  const workflowSteps = Array.isArray(workflow?.steps) ? workflow.steps.map(asRecord).filter((step): step is Record<string, unknown> => Boolean(step)) : [];
  const savedSteps = Array.isArray(output?.steps) ? output.steps : Array.isArray(runtime.steps) ? runtime.steps : [];
  const inputValues = asRecord(inputs.values) as Record<string, JsonValue> | undefined ?? {};
  const stepValues = new Map<string, Record<string, JsonValue>>();
  const steps = savedSteps.map((savedStep) => {
    const recorded = asRecord(savedStep);
    if (!recorded || typeof recorded.stepId !== "string") return savedStep;
    const definition = workflowSteps.find((step) => step.id === recorded.stepId);
    const configuredInputs = Array.isArray(definition?.inputs) ? definition.inputs : [];
    const resolvedInputs = asRecord(recorded.inputs) ?? Object.fromEntries(configuredInputs.flatMap((item) => {
      const field = asRecord(item);
      if (typeof field?.key !== "string") return [];
      try {
        return [[field.key, resolveWorkflowValue(field as unknown as RunStepInput, inputValues, stepValues) ?? null]];
      } catch {
        return [[field.key, null]];
      }
    }));
    const configuredOutputs = Array.isArray(definition?.outputs) ? definition.outputs : [];
    const inputLabels = asRecord(recorded.inputLabels) ?? Object.fromEntries(configuredInputs.flatMap((item) => {
      const field = asRecord(item);
      return typeof field?.key === "string" ? [[field.key, typeof field.label === "string" ? field.label : field.key]] : [];
    }));
    const outputLabels = asRecord(recorded.outputLabels) ?? Object.fromEntries(configuredOutputs.flatMap((item) => {
      const field = asRecord(item);
      return typeof field?.key === "string" ? [[field.key, typeof field.label === "string" ? field.label : field.key]] : [];
    }));
    const outputTypes = asRecord(recorded.outputTypes) ?? Object.fromEntries(configuredOutputs.flatMap((item) => {
      const field = asRecord(item);
      return typeof field?.key === "string" && typeof field.type === "string" ? [[field.key, field.type]] : [];
    }));
    const recordedOutputs = asRecord(recorded.outputs) as Record<string, JsonValue> | undefined;
    if (recordedOutputs) stepValues.set(recorded.stepId, recordedOutputs);
    return { ...recorded, inputs: resolvedInputs, inputLabels, outputLabels, outputTypes };
  });
  const outputs = Array.isArray(output?.outputs) ? output.outputs : [];
  const items = Array.isArray(output?.items) ? output.items : Array.isArray(runtime.items) ? runtime.items : undefined;
  return {
    runId,
    sceneId,
    workflowName,
    ...(runTitle ? { runTitle } : {}),
    status: runStatus(output?.status ?? runtime.status),
    startedAt: typeof runtime.startedAt === "string" ? runtime.startedAt : typeof inputs.createdAt === "string" ? inputs.createdAt : "",
    ...(typeof (output?.finishedAt ?? runtime.finishedAt) === "string" ? { finishedAt: output?.finishedAt ?? runtime.finishedAt } : {}),
    ...(typeof (output?.durationMs ?? runtime.durationMs) === "number" ? { durationMs: output?.durationMs ?? runtime.durationMs } : {}),
    steps,
    outputs,
    ...(items ? { items } : {}),
    ...(typeof output?.error === "string" ? { error: output.error } : {}),
    ...(typeof (output?.cancellationReason ?? runtime.cancellationReason) === "string" ? { cancellationReason: output?.cancellationReason ?? runtime.cancellationReason } : {}),
    ...(Array.isArray(output?.archiveWarnings) ? { archiveWarnings: output.archiveWarnings } : Array.isArray(runtime.archiveWarnings) ? { archiveWarnings: runtime.archiveWarnings } : {}),
    ...(typeof (output?.resumedFromRunId ?? runtime.resumedFromRunId) === "string" ? { resumedFromRunId: output?.resumedFromRunId ?? runtime.resumedFromRunId } : {}),
    inputValues,
    ...(workflow ? { workflow } : {}),
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

async function readHermesProfileEnvironment(profile: string) {
  const profileDirectory = profile === "default" ? hermesHome : path.join(hermesHome, "profiles", profile);
  try {
    return parseEnvFile(await readFile(path.join(profileDirectory, ".env"), "utf8"));
  } catch {
    return {};
  }
}

let workspaceMutation: Promise<void> = Promise.resolve();

function withWorkspaceLock<T>(operation: () => Promise<T>) {
  const result = workspaceMutation.then(operation, operation);
  workspaceMutation = result.then(() => undefined, () => undefined);
  return result;
}

async function readWorkspaceFile(): Promise<Record<string, unknown> | undefined> {
  let contents: string;
  try {
    contents = await readFile(workspaceFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("服务端工作区文件无法解析，已停止初始化以保护现有数据");
  }
  return normalizeWorkspacePayload(parsed);
}

function normalizeWorkspacePayload(value: unknown) {
  const body = asRecord(value);
  const workflows = body ? asRecord(body.workflows) : undefined;
  const sceneVersions = body && body.sceneVersions !== undefined ? asRecord(body.sceneVersions) : undefined;
  if (body?.format !== undefined && body.format !== "zane-studio.workspace/v1") {
    throw new Error("服务端工作区版本不兼容，已停止初始化以保护现有数据");
  }
  if (!body || !Array.isArray(body.scenes) || !workflows || !Array.isArray(body.optionPresets) || !Array.isArray(body.drafts)
    || (body.sceneVersions !== undefined && !sceneVersions)) {
    throw new Error("工作区数据格式无效");
  }
  if (body.scenes.length > 500 || Object.keys(workflows).length > 500 || body.optionPresets.length > 500 || body.drafts.length > 5000
    || (sceneVersions && Object.keys(sceneVersions).length > 500)) {
    throw new Error("工作区数据规模超出限制");
  }
  if (sceneVersions && Object.values(sceneVersions).some((record) => {
    const candidate = asRecord(record);
    return candidate && Array.isArray(candidate.versions) && candidate.versions.length > 10;
  })) throw new Error("每个场景最多保存 10 个已发布版本");
  return {
    format: "zane-studio.workspace/v1",
    scenes: body.scenes,
    workflows,
    optionPresets: body.optionPresets,
    drafts: body.drafts,
    ...(sceneVersions ? { sceneVersions } : {}),
  };
}

function identifiedRecords(values: unknown[], key: string) {
  const records = new Map<string, unknown>();
  for (const value of values) {
    const record = asRecord(value);
    if (typeof record?.[key] === "string") records.set(record[key] as string, value);
  }
  return records;
}

function mergeIdentifiedCollection(base: unknown[], desired: unknown[], current: unknown[], key: string) {
  const baseById = identifiedRecords(base, key);
  const desiredById = identifiedRecords(desired, key);
  const mergedById = identifiedRecords(current, key);
  const changedIds = new Set([...baseById.keys(), ...desiredById.keys()]);

  for (const id of changedIds) {
    const wasPresent = baseById.has(id);
    const isPresent = desiredById.has(id);
    if (wasPresent === isPresent && (!isPresent || isDeepStrictEqual(baseById.get(id), desiredById.get(id)))) continue;
    if (isPresent) mergedById.set(id, desiredById.get(id));
    else mergedById.delete(id);
  }

  const result: unknown[] = [];
  const emitted = new Set<string>();
  for (const value of current) {
    const record = asRecord(value);
    const id = typeof record?.[key] === "string" ? record[key] as string : undefined;
    if (!id) result.push(value);
    else if (mergedById.has(id) && !emitted.has(id)) {
      result.push(mergedById.get(id));
      emitted.add(id);
    }
  }
  for (const [id] of desiredById) {
    if (mergedById.has(id) && !emitted.has(id)) result.push(mergedById.get(id));
  }
  return result;
}

function mergeRecordByKey(base: Record<string, unknown>, desired: Record<string, unknown>, current: Record<string, unknown>) {
  const merged = { ...current };
  const changedIds = new Set([...Object.keys(base), ...Object.keys(desired)]);
  for (const id of changedIds) {
    const wasPresent = Object.prototype.hasOwnProperty.call(base, id);
    const isPresent = Object.prototype.hasOwnProperty.call(desired, id);
    if (wasPresent === isPresent && (!isPresent || isDeepStrictEqual(base[id], desired[id]))) continue;
    if (isPresent) merged[id] = desired[id];
    else delete merged[id];
  }
  return merged;
}

function mergeWorkspacePayload(base: ReturnType<typeof normalizeWorkspacePayload>, desired: ReturnType<typeof normalizeWorkspacePayload>, current: ReturnType<typeof normalizeWorkspacePayload>) {
  const baseWorkflows = base.workflows;
  const desiredWorkflows = desired.workflows;
  const workflows = { ...current.workflows };
  const workflowIds = new Set([...Object.keys(baseWorkflows), ...Object.keys(desiredWorkflows)]);
  for (const id of workflowIds) {
    const wasPresent = Object.prototype.hasOwnProperty.call(baseWorkflows, id);
    const isPresent = Object.prototype.hasOwnProperty.call(desiredWorkflows, id);
    if (wasPresent === isPresent && (!isPresent || isDeepStrictEqual(baseWorkflows[id], desiredWorkflows[id]))) continue;
    if (isPresent) workflows[id] = desiredWorkflows[id];
    else delete workflows[id];
  }
  const drafts = mergeIdentifiedCollection(base.drafts, desired.drafts, current.drafts, "id")
    .sort((left, right) => {
      const leftCreatedAt = asRecord(left)?.createdAt;
      const rightCreatedAt = asRecord(right)?.createdAt;
      return String(rightCreatedAt ?? "").localeCompare(String(leftCreatedAt ?? ""));
    });
  const sceneVersions = mergeRecordByKey(base.sceneVersions ?? {}, desired.sceneVersions ?? {}, current.sceneVersions ?? {});
  return {
    format: "zane-studio.workspace/v1",
    scenes: mergeIdentifiedCollection(base.scenes, desired.scenes, current.scenes, "id"),
    workflows,
    optionPresets: mergeIdentifiedCollection(base.optionPresets, desired.optionPresets, current.optionPresets, "id"),
    drafts,
    sceneVersions,
  };
}

async function readHermesApiConnection(profile: string): Promise<HermesApiConnection> {
  const [rootEnvironment, profileEnvironment] = await Promise.all([
    readHermesProfileEnvironment("default"),
    profile === "default" ? Promise.resolve(undefined) : readHermesProfileEnvironment(profile),
  ]);
  const effectiveProfileEnvironment = profileEnvironment ?? rootEnvironment;
  const apiKey = nonEmpty(process.env.HERMES_API_KEY) ?? nonEmpty(effectiveProfileEnvironment.API_SERVER_KEY);
  if (!apiKey) {
    throw new Error(`Hermes Profile「${profile}」未配置 API_SERVER_KEY；请在对应 Profile 的 .env 中启用 API Server 并设置密钥`);
  }

  const configuredBaseUrl = nonEmpty(process.env.HERMES_API_BASE_URL);
  let baseUrl = configuredBaseUrl;
  if (!baseUrl) {
    const rawHost = nonEmpty(process.env.API_SERVER_HOST) ?? nonEmpty(rootEnvironment.API_SERVER_HOST) ?? "127.0.0.1";
    const host = rawHost === "0.0.0.0" || rawHost === "::" ? "127.0.0.1" : rawHost;
    const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    const rawPort = Number(nonEmpty(process.env.API_SERVER_PORT) ?? nonEmpty(rootEnvironment.API_SERVER_PORT) ?? 8642);
    if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
      throw new Error("Hermes API_SERVER_PORT 配置无效");
    }
    baseUrl = `http://${urlHost}:${rawPort}`;
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error("HERMES_API_BASE_URL 必须是有效的 HTTP 或 HTTPS 地址");
  }
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new Error("HERMES_API_BASE_URL 必须使用 HTTP 或 HTTPS");
  }
  return { baseUrl: parsedBaseUrl.toString().replace(/\/+$/, ""), apiKey };
}

function hermesApiEndpoint(baseUrl: string, profile: string, resource: string) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const profilePath = profile === "default" ? "" : `/p/${encodeURIComponent(profile)}`;
  url.pathname = `${basePath}${profilePath}/v1/${resource.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function probeHermesApiProfile(profile: string, connection: HermesApiConnection) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(hermesApiEndpoint(connection.baseUrl, profile, "models"), {
      headers: { Authorization: `Bearer ${connection.apiKey}` },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) throw new Error(`Hermes Profile「${profile}」API 密钥认证失败`);
    if (!response.ok) throw new Error(`Hermes API Server 返回 ${response.status}`);
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`无法访问 Hermes API Server（${connection.baseUrl}），请确认 Gateway 正在运行且 API Server 已启用`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkHermesProfiles(enabledIds: string[]) {
  if (enabledIds.length === 0) {
    return { id: "hermes" as const, name: "Hermes Agent", status: "not_configured" as const, message: "尚未启用 Profile" };
  }

  const available = await listHermesProfiles();
  if (available.length === 0) {
    return { id: "hermes" as const, name: "Hermes Agent", status: "disconnected" as const, message: "未找到本机 Hermes Profile" };
  }

  const known = new Set(available.map((profile) => profile.id));
  const valid = uniqueStrings(enabledIds).filter((id) => known.has(id));
  if (valid.length === 0) {
    return { id: "hermes" as const, name: "Hermes Agent", status: "disconnected" as const, message: "所选 Profile 已不存在" };
  }

  const results = await Promise.all(valid.map(async (profile) => {
    try {
      const connection = await readHermesApiConnection(profile);
      await probeHermesApiProfile(profile, connection);
      return { profile, connected: true as const };
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError"
        ? "连接 Hermes API Server 超时"
        : error instanceof Error
          ? error.message
          : "无法访问 Hermes API Server";
      return { profile, connected: false as const, message };
    }
  }));
  const connectedCount = results.filter((result) => result.connected).length;
  const failure = results.find((result) => !result.connected);
  return {
    id: "hermes" as const,
    name: "Hermes Agent",
    status: connectedCount === valid.length ? "connected" as const : "disconnected" as const,
    message: failure?.connected === false
      ? failure.message
      : `${connectedCount}/${valid.length} 个已启用 Profile 的 Hermes API Server 正常`,
  };
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

function comfyAutogrowImageInputNames(rawSchema: unknown) {
  if (!Array.isArray(rawSchema) || rawSchema[0] !== "COMFY_AUTOGROW_V3") return [];
  const details = asRecord(rawSchema[1]);
  const template = asRecord(details?.template);
  const templateInputs = asRecord(template?.input);
  const hasImageTemplate = ["required", "optional"].some((section) => {
    const entries = asRecord(templateInputs?.[section]);
    return Object.values(entries ?? {}).some((entry) => {
      const schema = Array.isArray(entry) ? entry : [entry];
      return comfyPropertyType(schema[0]) === "image";
    });
  });
  if (!hasImageTemplate) return [];
  if (Array.isArray(template?.names)) {
    return template.names.filter((name): name is string => typeof name === "string" && Boolean(name));
  }
  if (typeof template?.prefix === "string" && typeof template.max === "number" && Number.isInteger(template.max)) {
    return Array.from({ length: Math.max(0, template.max) }, (_value, index) => `${template.prefix}${index}`);
  }
  return [];
}

function comfyNodeInputSchema(payload: unknown, nodeType: string, property: string) {
  const root = asRecord(payload);
  const definition = asRecord(root?.[nodeType]) ?? root;
  const inputSchema = asRecord(definition?.input);
  for (const section of ["required", "optional"]) {
    const entries = asRecord(inputSchema?.[section]);
    if (entries && property in entries) return entries[property];
  }
  return undefined;
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
      const type = comfyAutogrowImageInputNames(rawSchema).length ? "image_list" : comfyPropertyType(typeToken);
      return [{ name, type, required: section === "required", ...(options.length ? { options } : {}) }];
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

async function fetchJson(url: string, init: RequestInit = {}, parentSignal?: AbortSignal, timeoutMs = workflowTimeoutMs(defaultWorkflowTimeoutMinutes), timeoutLabelMinutes = timeoutMs / 60 / 1000): Promise<unknown> {
  const controller = new AbortController();
  const initSignal = init.signal;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
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
  } catch (error) {
    if (timedOut && !parentSignal?.aborted && !initSignal?.aborted) {
      throw new Error(`ComfyUI 请求超时（单步上限 ${workflowTimeoutLabel(timeoutLabelMinutes)}）`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
    initSignal?.removeEventListener("abort", abortFromParent);
  }
}

function splitWorkflowReference(reference: string) {
  const match = /^(iteration\.item|input\.[a-zA-Z0-9_]+|step\.[a-zA-Z0-9_-]+\.outputs\.[a-zA-Z0-9_]+)([\s\S]*)$/.exec(reference);
  if (!match) return undefined;
  const suffix = match[2];
  return {
    root: match[1],
    path: suffix.startsWith(".") && suffix.length > 1 ? suffix.slice(1) : suffix,
  };
}

function parseWorkflowJsonPath(path: string): Array<string | number> {
  let cursor = 0;
  if (path[cursor] === "$" && (path.length === 1 || path[cursor + 1] === "." || path[cursor + 1] === "[")) {
    cursor += 1;
    if (path[cursor] === ".") cursor += 1;
  }

  const segments: Array<string | number> = [];
  while (cursor < path.length) {
    if (path[cursor] === ".") {
      cursor += 1;
      const start = cursor;
      while (cursor < path.length && path[cursor] !== "." && path[cursor] !== "[") cursor += 1;
      const key = path.slice(start, cursor);
      if (!key) throw new Error("字段名为空");
      segments.push(key);
      continue;
    }

    if (path[cursor] === "[") {
      cursor += 1;
      if (path[cursor] === '"') {
        const start = cursor;
        cursor += 1;
        let escaped = false;
        while (cursor < path.length) {
          const character = path[cursor];
          cursor += 1;
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') break;
        }
        if (path[cursor] !== "]") throw new Error("括号路径格式无效");
        let key: unknown;
        try {
          key = JSON.parse(path.slice(start, cursor));
        } catch {
          throw new Error("带引号的字段名格式无效");
        }
        if (typeof key !== "string") throw new Error("字段名格式无效");
        segments.push(key);
        cursor += 1;
        continue;
      }

      const end = path.indexOf("]", cursor);
      if (end < 0) throw new Error("缺少右方括号");
      const index = path.slice(cursor, end);
      if (!/^\d+$/.test(index) || !Number.isSafeInteger(Number(index))) throw new Error("数组下标必须是非负整数");
      segments.push(Number(index));
      cursor = end + 1;
      continue;
    }

    if (segments.length) throw new Error("字段之间需要用点号或方括号分隔");
    const start = cursor;
    while (cursor < path.length && path[cursor] !== "." && path[cursor] !== "[") cursor += 1;
    const key = path.slice(start, cursor);
    if (!key) throw new Error("字段名为空");
    segments.push(key);
  }
  return segments;
}

function workflowReferenceRoot(reference: string) {
  return splitWorkflowReference(reference)?.root ?? reference;
}

function resolveWorkflowReference(reference: string, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>) {
  const parsed = splitWorkflowReference(reference);
  if (!parsed) throw new Error(`不支持的数据引用：${reference || "（空）"}`);
  const inputMatch = /^input\.([a-zA-Z0-9_]+)$/.exec(parsed.root);
  const outputMatch = /^step\.([a-zA-Z0-9_-]+)\.outputs\.([a-zA-Z0-9_]+)$/.exec(parsed.root);
  let value: JsonValue | undefined;
  if (parsed.root === "iteration.item") value = inputs["iteration.item"];
  else if (inputMatch) value = inputs[inputMatch[1]];
  else if (outputMatch) value = stepValues.get(outputMatch[1])?.[outputMatch[2]];
  else throw new Error(`不支持的数据引用：${reference || "（空）"}`);

  if (!parsed.path) return value;
  let segments: Array<string | number>;
  try {
    segments = parseWorkflowJsonPath(parsed.path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "路径格式无效";
    throw new Error(`JSON 字段路径无效：${reference}（${detail}）`);
  }
  for (const segment of segments) {
    if (Array.isArray(value) && typeof segment === "number") value = value[segment];
    else if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof segment === "string" && Object.prototype.hasOwnProperty.call(value, segment)) value = value[segment];
    else value = undefined;
    if (value === undefined) throw new Error(`JSON 字段路径不存在：${reference}`);
  }
  return value;
}

function parseWorkflowLiteral(value: unknown, type: string | undefined, label: string): JsonValue {
  const raw = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value) ?? String(value);
  const normalizedType = type === "textarea" || type === "select" || !type ? "text" : type;
  if (normalizedType === "number") {
    const number = raw.trim() ? Number(raw) : NaN;
    if (!Number.isFinite(number)) throw new Error(`${label} 的固定值需要有效数字`);
    return number;
  }
  if (normalizedType === "boolean") {
    if (!/^(true|false)$/i.test(raw.trim())) throw new Error(`${label} 的固定值需要布尔值`);
    return raw.trim().toLowerCase() === "true";
  }
  if (normalizedType === "json" || normalizedType === "image_list") {
    if (!raw.trim()) throw new Error(`${label} 的固定值需要有效 JSON`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${label} 的固定值 JSON 格式无效`);
    }
    if (normalizedType === "image_list" && !Array.isArray(parsed)) throw new Error(`${label} 的固定值需要 JSON 数组`);
    return toJsonValue(parsed);
  }
  return raw;
}

function resolveWorkflowValue(input: RunStepInput, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>) {
  if (input.valueSource === "literal") return parseWorkflowLiteral(input.literalValue, input.literalType, input.label ?? input.key);
  return resolveWorkflowReference(input.sourceRef ?? "", inputs, stepValues);
}

function resolveStepInputs(step: RunStep, inputValues: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>) {
  return Object.fromEntries((step.inputs ?? []).map((input) => {
    try {
      return [input.key, resolveWorkflowValue(input, inputValues, stepValues) ?? null];
    } catch {
      return [input.key, null];
    }
  }));
}

function resolvePromptTemplate(template: string, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, types?: Map<string, string>) {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_match, reference: string) => {
    const sourceRef = reference.trim();
    const type = types?.get(workflowReferenceRoot(sourceRef));
    if (type === "image" || type === "image_list") return "[图片已作为附件提供]";
    if (type === "video") return "[视频代表帧已作为图片附件提供]";
    const value = resolveWorkflowReference(sourceRef, inputs, stepValues);
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
  const leftType = types.get(workflowReferenceRoot(rule.leftRef)) ?? "text";
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

function comfyOutputMedia(value: unknown) {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).flatMap((item) => {
    const media = asRecord(item);
    return media && typeof media.filename === "string" ? [{
      filename: media.filename,
      subfolder: typeof media.subfolder === "string" ? media.subfolder : "",
      type: typeof media.type === "string" ? media.type : "output",
      url: `/api/comfyui/view?${new URLSearchParams({
        filename: media.filename,
        subfolder: typeof media.subfolder === "string" ? media.subfolder : "",
        type: typeof media.type === "string" ? media.type : "output",
      })}`,
    }] : [];
  });
}

function isComfyVideoMedia(media: { filename: string }) {
  return [".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"].includes(path.extname(media.filename).toLowerCase());
}

function readComfyOutputValue(history: unknown, promptId: string, nodeId: string, property: string, type: string): JsonValue {
  const prompt = asRecord(history)?.[promptId];
  const outputs = asRecord(asRecord(prompt)?.outputs);
  const nodeOutput = asRecord(outputs?.[nodeId]);
  const uiOutput = asRecord(nodeOutput?.ui);
  let resolvedNodeId = nodeOutput ? nodeId : undefined;
  const directOutputProperty = nodeOutput && Object.prototype.hasOwnProperty.call(nodeOutput, property)
    ? property
    : Object.keys(nodeOutput ?? {}).find((name) => name.toLowerCase() === property.toLowerCase());
  const uiOutputProperty = uiOutput && Object.prototype.hasOwnProperty.call(uiOutput, property)
    ? property
    : Object.keys(uiOutput ?? {}).find((name) => name.toLowerCase() === property.toLowerCase());
  let outputProperty = directOutputProperty ?? uiOutputProperty;
  let outputRecord = directOutputProperty ? nodeOutput : uiOutput;
  let propertyValue = outputProperty ? outputRecord?.[outputProperty] : undefined;
  let media = comfyOutputMedia(propertyValue);
  if (type === "video" && !media.some(isComfyVideoMedia) && nodeOutput) {
    const videoCandidates = Object.entries(nodeOutput).flatMap(([name, value]) => {
      const candidateMedia = comfyOutputMedia(value).filter(isComfyVideoMedia);
      return candidateMedia.length ? [{ name, value, media: candidateMedia }] : [];
    });
    if (videoCandidates.length === 1) {
      outputProperty = videoCandidates[0].name;
      propertyValue = videoCandidates[0].value;
      media = videoCandidates[0].media;
    } else if (videoCandidates.length > 1) {
      throw new Error(`ComfyUI 节点 ${nodeId} 找到多个视频输出属性：${videoCandidates.map((candidate) => candidate.name).join("、")}`);
    }
  }
  if (type === "video" && !media.some(isComfyVideoMedia) && outputs) {
    const videoCandidates = Object.entries(outputs).flatMap(([candidateNodeId, rawOutput]) => {
      if (candidateNodeId === nodeId) return [];
      return Object.entries(asRecord(rawOutput) ?? {}).flatMap(([name, value]) => {
        const candidateMedia = comfyOutputMedia(value).filter(isComfyVideoMedia);
        return candidateMedia.length ? [{ nodeId: candidateNodeId, name, value, media: candidateMedia }] : [];
      });
    });
    if (videoCandidates.length === 1) {
      resolvedNodeId = videoCandidates[0].nodeId;
      outputProperty = videoCandidates[0].name;
      propertyValue = videoCandidates[0].value;
      media = videoCandidates[0].media;
    } else if (videoCandidates.length > 1) {
      const candidates = videoCandidates.map((candidate) => `${candidate.nodeId}.${candidate.name}`);
      throw new Error(`ComfyUI 节点 ${nodeId}.${property} 没有输出记录，执行结果中找到多个视频：${candidates.join("、")}`);
    }
  }
  if (!resolvedNodeId || !outputProperty) {
    const available = Object.keys(nodeOutput ?? {});
    const videoOutputs = Object.entries(outputs ?? {}).flatMap(([candidateNodeId, rawOutput]) =>
      Object.entries(asRecord(rawOutput) ?? {}).flatMap(([name, value]) => comfyOutputMedia(value).filter(isComfyVideoMedia).length ? [`${candidateNodeId}.${name}`] : []),
    );
    throw new Error(`ComfyUI 节点 ${nodeId} 没有输出属性 ${property}${available.length ? `（可用属性：${available.join("、")}）` : "（节点没有返回输出字段）"}${type === "video" && videoOutputs.length ? `；检测到视频：${videoOutputs.join("、")}` : ""}`);
  }
  if (type === "image" || type === "video") {
    const previewMedia = type === "video" ? media.filter(isComfyVideoMedia) : media;
    if (!previewMedia.length) throw new Error(`ComfyUI 属性 ${resolvedNodeId}.${outputProperty} 中没有可预览${type === "video" ? "视频" : "媒体"}`);
    return previewMedia.length === 1 ? previewMedia[0] : previewMedia;
  }
  let value = propertyValue;
  if (value === undefined) return null;
  if (type !== "image_list" && Array.isArray(value) && value.length === 1) value = value[0];
  if (type === "json" && typeof value === "string") {
    try {
      return toJsonValue(JSON.parse(value) as unknown);
    } catch {
      throw new Error("ComfyUI 节点 " + nodeId + "." + outputProperty + " 声明为结构化数据，但返回内容不是有效 JSON");
    }
  }
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

function comfyInputBaseType(rawSchema: unknown) {
  const schema = Array.isArray(rawSchema) ? rawSchema : [rawSchema];
  return typeof schema[0] === "string" ? schema[0].toUpperCase() : "";
}

function comfyInputImagePath(value: unknown, stepName: string, imageIndex: number) {
  const attachment = asRecord(value);
  const filename = attachment?.filename;
  const subfolder = attachment?.subfolder;
  if (attachment?.type !== "input" || typeof filename !== "string" || !filename || /[\\/]/.test(filename) || filename === "." || filename === "..") {
    throw new Error(`${stepName} 的第 ${imageIndex + 1} 张图片不是有效的 ComfyUI 上传附件`);
  }
  if (typeof subfolder !== "string" || subfolder.startsWith("/") || subfolder.startsWith("\\") || subfolder.split(/[\\/]/).some((part) => part === "." || part === "..")) {
    throw new Error(`${stepName} 的第 ${imageIndex + 1} 张图片目录无效`);
  }
  return [subfolder.replace(/[\\/]+$/, "").replace(/[\\/]/g, "/"), filename].filter(Boolean).join("/");
}

function isComfyInputAudioAttachment(value: unknown) {
  const attachment = asRecord(value);
  return typeof attachment?.id === "string"
    && typeof attachment.filename === "string"
    && typeof attachment.subfolder === "string"
    && attachment.type === "input"
    && typeof attachment.url === "string";
}

function comfyInputAudioPath(value: unknown, stepName: string, required: boolean): string | undefined {
  if ((value === null || value === "") && !required) return undefined;
  const attachment = asRecord(value);
  const filename = attachment?.filename;
  const subfolder = attachment?.subfolder;
  if (!isComfyInputAudioAttachment(value) || typeof filename !== "string" || !filename || /[\\/]/.test(filename) || filename === "." || filename === "..") {
    throw new Error(stepName + " 的音频输入不是有效的 ComfyUI 上传附件");
  }
  if (typeof subfolder !== "string" || subfolder.startsWith("/") || subfolder.startsWith("\\") || subfolder.split(/[\\/]/).some((part) => part === "." || part === "..")) {
    throw new Error(stepName + " 的音频文件目录无效");
  }
  return [subfolder.replace(/[\\/]+$/, "").replace(/[\\/]/g, "/"), filename].filter(Boolean).join("/");
}

function nextComfyGraphNodeId(graph: Record<string, Record<string, unknown>>) {
  const numericIds = Object.keys(graph).map(Number).filter((id) => Number.isSafeInteger(id) && id >= 0);
  let nextId = (numericIds.length ? Math.max(...numericIds) : 0) + 1;
  while (String(nextId) in graph) nextId += 1;
  return String(nextId);
}

function addComfyLoadImage(graph: Record<string, Record<string, unknown>>, imagePath: string): [string, number] {
  const nodeId = nextComfyGraphNodeId(graph);
  graph[nodeId] = { class_type: "LoadImage", inputs: { image: imagePath, upload: "image" } };
  return [nodeId, 0];
}

function addComfyImageBatch(graph: Record<string, Record<string, unknown>>, images: Array<[string, number]>) {
  let combined = images[0];
  for (const image of images.slice(1)) {
    const nodeId = nextComfyGraphNodeId(graph);
    graph[nodeId] = { class_type: "ImageBatch", inputs: { image1: combined, image2: image } };
    combined = [nodeId, 0];
  }
  return combined;
}

function bindComfyImageList(graph: Record<string, Record<string, unknown>>, nodeInputs: Record<string, unknown>, nodeType: string, property: string, rawSchema: unknown, value: JsonValue | undefined, stepName: string, required: boolean) {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  if (!values.length && required) throw new Error(`${stepName} 的图片列表至少需要一张图片`);
  const imagePaths = values.map((item, index) => comfyInputImagePath(item, stepName, index));
  const slotNames = comfyAutogrowImageInputNames(rawSchema);
  if (slotNames.length) {
    if (imagePaths.length > slotNames.length) {
      throw new Error(`${stepName} 的 ${nodeType}.${property} 最多支持 ${slotNames.length} 张有序图片，当前有 ${imagePaths.length} 张`);
    }
    slotNames.forEach((slotName, index) => {
      const inputName = `${property}.${slotName}`;
      delete nodeInputs[inputName];
      if (imagePaths[index]) nodeInputs[inputName] = addComfyLoadImage(graph, imagePaths[index]);
    });
    return;
  }
  if (comfyInputBaseType(rawSchema) === "IMAGE") {
    if (!imagePaths.length) {
      delete nodeInputs[property];
      return;
    }
    const imageNodes = imagePaths.map((imagePath) => addComfyLoadImage(graph, imagePath));
    nodeInputs[property] = addComfyImageBatch(graph, imageNodes);
    return;
  }
  throw new Error(`${stepName} 的 ${nodeType}.${property} 不支持图片列表；请绑定 IMAGE 输入或 ComfyUI 动态图片组`);
}

async function runComfyUIStep(step: RunStep, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, baseUrl: string, signal?: AbortSignal, inputFields: RunInputField[] = [], variableTypes: Map<string, string> = new Map(), timeoutMs = workflowTimeoutMs(defaultWorkflowTimeoutMinutes)) {
  throwIfAborted(signal);
  const workflowFile = step.comfyui?.workflowFile;
  if (!workflowFile) throw new Error(`${step.name} 尚未选择 ComfyUI 工作流`);
  const encodedPath = workflowApiPath(workflowFile);
  let payload: unknown;
  try {
    payload = await fetchJson(`${baseUrl}/api/userdata/${encodedPath}`, {}, signal, timeoutMs);
  } catch {
    throwIfAborted(signal);
    payload = await fetchJson(`${baseUrl}/userdata/${encodedPath}`, {}, signal, timeoutMs);
  }
  const graph = await readWorkflowApiGraph(payload, baseUrl, signal);
  const bindings = step.comfyui?.bindings ?? [];
  const nodeInfoCache = new Map<string, Promise<unknown>>();
  for (const binding of bindings.filter((item) => item.direction === "input")) {
    const node = graph[binding.nodeId];
    const nodeInputs = asRecord(node?.inputs);
    if (!nodeInputs) throw new Error(`${step.name} 找不到输入绑定 ${binding.nodeId}.${binding.property}`);
    const value = binding.valueSource === "literal"
      ? parseWorkflowLiteral(binding.literalValue, binding.type, binding.label ?? binding.key)
      : resolveWorkflowReference(binding.sourceRef ?? "", inputs, stepValues);
    const inputKey = binding.valueSource === "literal" ? undefined : /^input\.([a-zA-Z0-9_]+)$/.exec(workflowReferenceRoot(binding.sourceRef ?? ""))?.[1];
    const sourceField = inputKey ? inputFields.find((field) => field.key === inputKey) : undefined;
    const sourceType = binding.valueSource === "literal" ? binding.type : variableTypes.get(workflowReferenceRoot(binding.sourceRef ?? "")) ?? sourceField?.type ?? binding.type;
    if (sourceType === "image_list") {
      const nodeType = typeof node.class_type === "string" ? node.class_type : "Unknown";
      let infoRequest = nodeInfoCache.get(nodeType);
      if (!infoRequest) {
        infoRequest = fetchComfyUIJson(`${baseUrl}/object_info/${encodeURIComponent(nodeType)}`, 4500, signal);
        nodeInfoCache.set(nodeType, infoRequest);
      }
      const objectInfo = await infoRequest;
      const inputSchema = comfyNodeInputSchema(objectInfo, nodeType, binding.property);
      bindComfyImageList(graph, nodeInputs, nodeType, binding.property, inputSchema, value, step.name, sourceField?.required ?? binding.required ?? false);
      continue;
    }
    if (sourceType === "audio") {
      const nodeType = typeof node.class_type === "string" ? node.class_type : "";
      if (nodeType !== "LoadAudio" || binding.property !== "audio") {
        throw new Error(step.name + " 的音频场景输入需要绑定到 LoadAudio.audio");
      }
      if (!(binding.property in nodeInputs)) throw new Error(step.name + " 找不到输入绑定 " + binding.nodeId + "." + binding.property);
      const audioPath = comfyInputAudioPath(value, step.name, sourceField?.required ?? binding.required ?? false);
      if (audioPath !== undefined) nodeInputs[binding.property] = audioPath;
      continue;
    }
    if (!(binding.property in nodeInputs)) throw new Error(`${step.name} 找不到输入绑定 ${binding.nodeId}.${binding.property}`);
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
    }, signal, timeoutMs));
    promptId = typeof queued?.prompt_id === "string" ? queued.prompt_id : undefined;
    if (!promptId) {
      const details = Array.isArray(queued?.node_errors) ? JSON.stringify(queued.node_errors) : "ComfyUI 未返回任务 ID";
      throw new Error(details);
    }
    throwIfAborted(signal);
    const deadline = Date.now() + timeoutMs;
    let history: unknown;
    while (Date.now() < deadline) {
      await delayWithAbort(1000, signal);
      const remainingMs = Math.max(1, deadline - Date.now());
      const found = asRecord(await fetchJson(`${baseUrl}/history/${encodeURIComponent(promptId)}`, {}, signal, Math.min(timeoutMs, remainingMs), timeoutMs / 60 / 1000));
      if (found && found[promptId]) {
        history = found;
        break;
      }
    }
    if (!history) throw new Error(`等待 ComfyUI 任务完成超时（单步上限 ${workflowTimeoutLabel(timeoutMs / 60 / 1000)}）`);
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

type HermesMessagePart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" } };

const hermesImageLimit = 12;
const hermesVideoFrameCount = 6;
const hermesInlineMediaLimit = 9_500_000;
const hermesImageSourceLimit = 100_000_000;
const hermesImageTargetBytes = 5_500_000;

function mimeTypeForMediaPath(filename: string, fallback = "application/octet-stream") {
  const extension = path.extname(filename).toLowerCase();
  return ({
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".webm": "video/webm",
    ".webp": "image/webp",
  } as Record<string, string>)[extension] ?? fallback;
}

function mediaDataUrl(bytes: Buffer, contentType: string) {
  const normalizedType = contentType.split(";")[0].trim().toLowerCase();
  if (!normalizedType.startsWith("image/")) throw new Error("Hermes 多模态输入只支持图像附件");
  return `data:${normalizedType};base64,${bytes.toString("base64")}`;
}

async function prepareHermesImage(bytes: Buffer, filename: string, contentType: string, signal?: AbortSignal, maxBytes = hermesImageTargetBytes) {
  if (bytes.length <= maxBytes) return { bytes, contentType };
  const directory = await mkdtemp(path.join(os.tmpdir(), "zane-hermes-image-"));
  const extension = path.extname(filename).replace(/[^.A-Za-z0-9]/g, "").slice(0, 12) || ".img";
  const input = path.join(directory, `input${extension}`);
  try {
    await writeFile(input, bytes);
    let probeResult: Record<string, unknown> | undefined;
    try {
      const probe = await execFileAsync(ffprobeBinary, [
        "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,pix_fmt", "-of", "json", input,
      ], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024, signal });
      probeResult = asRecord(JSON.parse(probe.stdout));
    } catch (error) {
      if (signal?.aborted) throw cancellationError();
      if (asRecord(error)?.code === "ENOENT") throw new Error("找不到 ffprobe，无法压缩 Hermes 图片");
      throw new Error("无法识别超限图片，请确认文件有效且为常见图像格式");
    }
    const stream = Array.isArray(probeResult?.streams) ? asRecord(probeResult.streams[0]) : undefined;
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error("无法识别超限图片的尺寸");
    }
    const hasAlpha = typeof stream?.pix_fmt === "string" && /(?:rgba|bgra|argb|abgr|yuva|gbrap|ya\d)/i.test(stream.pix_fmt);
    const maxEdge = Math.max(width, height);
    const edgeTargets = [...new Set([3072, 2560, 2048, 1600, 1280, 1024, 768, 512].map((edge) => Math.min(edge, maxEdge)))];
    for (const edge of edgeTargets) {
      for (const quality of hasAlpha ? [undefined] : [4, 7, 10, 13]) {
        throwIfAborted(signal);
        const output = path.join(directory, hasAlpha ? "resized.png" : "resized.jpg");
        try {
          await execFileAsync(ffmpegBinary, [
            "-hide_banner", "-loglevel", "error", "-y", "-max_pixels", "100000000", "-i", input,
            "-frames:v", "1", "-vf", `scale=${edge}:${edge}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
            ...(hasAlpha ? ["-compression_level", "9", "-pred", "mixed"] : ["-q:v", String(quality)]), output,
          ], { timeout: 60000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, signal });
        } catch (error) {
          if (signal?.aborted) throw cancellationError();
          if (asRecord(error)?.code === "ENOENT") throw new Error("找不到 ffmpeg，无法压缩 Hermes 图片");
          throw new Error("压缩 Hermes 图片失败，请确认文件有效且为常见图像格式");
        }
        const resized = await readFile(output).catch(() => undefined);
        if (resized?.length && resized.length <= maxBytes) {
          return { bytes: resized, contentType: hasAlpha ? "image/png" : "image/jpeg" };
        }
      }
    }
    throw new Error("图片无法压缩到本次请求预算；请减少图片数量或缩小图片");
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function hermesImageDataUrl(bytes: Buffer, filename: string, contentType: string, signal?: AbortSignal, maxBytes = hermesImageTargetBytes) {
  const prepared = await prepareHermesImage(bytes, filename, contentType, signal, maxBytes);
  return mediaDataUrl(prepared.bytes, prepared.contentType || "image/jpeg");
}

async function fetchMediaResponse(url: string, signal?: AbortSignal, maxBytes = 100_000_000, limitMessage = "视频附件超过 100 MB 限制") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`媒体服务返回 ${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error(limitMessage);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(limitMessage);
    return { bytes, contentType: response.headers.get("content-type") ?? "" };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

async function readComfyMediaBytes(media: Record<string, unknown>, settings: SavedSettings, signal?: AbortSignal, maxBytes = 100_000_000, limitMessage?: string) {
  if (!settings.comfyuiBaseUrl || typeof media.filename !== "string") {
    throw new Error("无法读取 ComfyUI 媒体附件，请检查 ComfyUI 连接");
  }
  const query = new URLSearchParams({
    filename: media.filename,
    subfolder: typeof media.subfolder === "string" ? media.subfolder : "",
    type: typeof media.type === "string" ? media.type : "output",
  });
  try {
    return await fetchMediaResponse(`${settings.comfyuiBaseUrl}/view?${query}`, signal, maxBytes, limitMessage);
  } catch (error) {
    if (signal?.aborted) throw cancellationError();
    throw new Error(error instanceof Error ? `无法读取 ComfyUI 媒体附件：${error.message}` : "无法读取 ComfyUI 媒体附件");
  }
}

async function hermesImageUrl(value: unknown, settings: SavedSettings, signal?: AbortSignal, maxBytes = hermesImageTargetBytes): Promise<string> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^data:image\//i.test(trimmed)) {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(trimmed);
      if (!match) return trimmed;
      const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
      if (bytes.length > hermesImageSourceLimit) throw new Error("Hermes 图片原文件超过 100 MB 限制");
      return hermesImageDataUrl(bytes, `input${mediaContentTypeExtension(match[1])}`, match[1], signal, maxBytes);
    }
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (!trimmed) throw new Error("图片输入为空");
    const filename = path.resolve(trimmed);
    const info = await stat(filename).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`无法读取图片文件：${trimmed}`);
    if (info.size > hermesImageSourceLimit) throw new Error("Hermes 图片原文件超过 100 MB 限制");
    const bytes = await readFile(filename, { signal });
    return hermesImageDataUrl(bytes, filename, mimeTypeForMediaPath(filename, "image/jpeg"), signal, maxBytes);
  }

  const media = asRecord(value);
  if (!media) throw new Error("Hermes 图片输入格式无效");
  if (typeof media.filename === "string") {
    const { bytes, contentType } = await readComfyMediaBytes(media, settings, signal, hermesImageSourceLimit, "Hermes 图片原文件超过 100 MB 限制");
    return hermesImageDataUrl(bytes, media.filename, mimeTypeForMediaPath(media.filename, contentType || "image/jpeg"), signal, maxBytes);
  }
  if (typeof media.url === "string" && /^https?:\/\//i.test(media.url)) return media.url;
  throw new Error("Hermes 图片输入缺少可读取的文件或 URL");
}

async function materializeHermesVideo(value: unknown, settings: SavedSettings, directory: string, signal?: AbortSignal) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^data:/i.test(trimmed)) {
      const match = /^data:(video\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(trimmed);
      if (!match) throw new Error("视频 data URL 格式无效");
      const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
      if (!bytes.length || bytes.length > 100_000_000) throw new Error("视频附件超过 100 MB 限制");
      const filename = path.join(directory, `input${mediaContentTypeExtension(match[1])}`);
      await writeFile(filename, bytes);
      return filename;
    }
    const filename = path.resolve(trimmed);
    const info = await stat(filename).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`无法读取视频文件：${trimmed}`);
    return filename;
  }

  const media = asRecord(value);
  if (!media) throw new Error("Hermes 视频输入格式无效");
  if (typeof media.filename === "string") {
    const { bytes } = await readComfyMediaBytes(media, settings, signal);
    const extension = path.extname(media.filename).replace(/[^.A-Za-z0-9]/g, "").slice(0, 12) || ".mp4";
    const filename = path.join(directory, `input${extension}`);
    await writeFile(filename, bytes);
    return filename;
  }
  if (typeof media.url === "string" && /^https?:\/\//i.test(media.url)) return media.url;
  throw new Error("Hermes 视频输入缺少可读取的文件或 URL");
}

function formatVideoTimestamp(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = (seconds - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${remainder}`;
}

async function hermesVideoFrameParts(value: unknown, label: string, settings: SavedSettings, signal?: AbortSignal, maxImageBytes = hermesImageTargetBytes): Promise<HermesMessagePart[]> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zane-hermes-video-"));
  try {
    const source = await materializeHermesVideo(value, settings, directory, signal);
    const inputOptions = /^https?:\/\//i.test(source)
      ? ["-protocol_whitelist", "file,http,https,tcp,tls,crypto", "-rw_timeout", "15000000"]
      : [];
    let probeOutput: string;
    try {
      const probe = await execFileAsync(ffprobeBinary, [
        "-v", "error", ...inputOptions, "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", source,
      ], { timeout: 45000, windowsHide: true, maxBuffer: 1024 * 1024, signal });
      probeOutput = probe.stdout;
    } catch (error) {
      if (signal?.aborted) throw cancellationError();
      if (asRecord(error)?.code === "ENOENT") throw new Error("找不到 ffprobe，请安装 ffmpeg 并设置 FFPROBE_BIN");
      throw new Error("无法读取视频时长，请确认视频有效且可访问");
    }
    const duration = Number(probeOutput.trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("视频时长无效，无法抽取代表帧");
    const frameCount = duration < 1 ? 1 : hermesVideoFrameCount;
    const parts: HermesMessagePart[] = [];
    for (let index = 0; index < frameCount; index += 1) {
      throwIfAborted(signal);
      const timestamp = duration < 1 ? duration / 2 : Math.min(duration - 0.05, duration * (index + 1) / (frameCount + 1));
      const filename = path.join(directory, `frame-${index + 1}.jpg`);
      try {
        await execFileAsync(ffmpegBinary, [
          "-hide_banner", "-loglevel", "error", "-y", "-ss", timestamp.toFixed(3), ...inputOptions,
          "-i", source, "-frames:v", "1", "-vf", "scale=1280:1280:force_original_aspect_ratio=decrease", "-q:v", "4", filename,
        ], { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024, signal });
      } catch (error) {
        if (signal?.aborted) throw cancellationError();
        if (asRecord(error)?.code === "ENOENT") throw new Error("找不到 ffmpeg，请安装 ffmpeg 并设置 FFMPEG_BIN");
        throw new Error(`抽取视频代表帧失败（${formatVideoTimestamp(timestamp)}）`);
      }
      const bytes = await readFile(filename).catch(() => undefined);
      if (!bytes?.length) throw new Error(`无法读取视频代表帧（${formatVideoTimestamp(timestamp)}）`);
      parts.push({ type: "text", text: `${label}，${formatVideoTimestamp(timestamp)} 帧` });
      const imageUrl = await hermesImageDataUrl(bytes, filename, "image/jpeg", signal, maxImageBytes);
      parts.push({ type: "image_url", image_url: { url: imageUrl, detail: "high" } });
    }
    return parts;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function hermesMessageContent(step: RunStep, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, types: Map<string, string>, prompt: string, settings: SavedSettings, signal?: AbortSignal): Promise<string | HermesMessagePart[]> {
  const parts: HermesMessagePart[] = [{ type: "text", text: prompt }];
  const mediaInputs = (step.inputs ?? []).flatMap((input) => {
    const type = input.valueSource === "literal" ? input.literalType ?? "text" : types.get(workflowReferenceRoot(input.sourceRef ?? ""));
    if (type !== "image" && type !== "image_list" && type !== "video") return [];
    const value = resolveWorkflowValue(input, inputs, stepValues);
    return value === undefined || value === null || value === "" ? [] : [{ input, type, value }];
  });
  const expectedImageCount = Math.max(1, mediaInputs.reduce((total, media) => total + (
    media.type === "video" ? hermesVideoFrameCount : Array.isArray(media.value) ? media.value.length : 1
  ), 0));
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const imageBudgetBytes = Math.min(
    hermesImageTargetBytes,
    Math.floor(Math.max(0, hermesInlineMediaLimit - promptBytes - 32_000) * 0.7 / expectedImageCount),
  );
  let imageCount = 0;
  for (const { input, type, value } of mediaInputs) {
    const label = input.label?.trim() || input.key;
    if (type === "video") {
      const frames = await hermesVideoFrameParts(value, label, settings, signal, imageBudgetBytes);
      imageCount += frames.filter((part) => part.type === "image_url").length;
      if (imageCount > hermesImageLimit) throw new Error(`${step.name} 最多支持 ${hermesImageLimit} 张图片或视频帧`);
      parts.push(...frames);
      continue;
    }
    const imageValues = Array.isArray(value) ? value : [value];
    for (let index = 0; index < imageValues.length; index += 1) {
      throwIfAborted(signal);
      if (imageCount >= hermesImageLimit) throw new Error(`${step.name} 最多支持 ${hermesImageLimit} 张图片或视频帧`);
      const imageUrl = await hermesImageUrl(imageValues[index], settings, signal, imageBudgetBytes);
      imageCount += 1;
      parts.push({ type: "text", text: imageValues.length > 1 ? `${label}（第 ${index + 1} 张）` : label });
      parts.push({ type: "image_url", image_url: { url: imageUrl, detail: "high" } });
    }
  }
  const serializedLength = Buffer.byteLength(JSON.stringify(parts), "utf8");
  if (serializedLength > hermesInlineMediaLimit) {
    throw new Error("Hermes API Server 单次请求上限为 10 MB；附件已按数量压缩后仍超限，请减少附件数量或缩短提示词");
  }
  return parts.some((part) => part.type === "image_url") ? parts : prompt;
}

async function requestHermesCompletion(profile: string, connection: HermesApiConnection, content: string | HermesMessagePart[], timeoutMs = workflowTimeoutMs(defaultWorkflowTimeoutMinutes), signal?: AbortSignal) {
  throwIfAborted(signal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const response = await fetch(hermesApiEndpoint(connection.baseUrl, profile, "chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "hermes-agent",
        messages: [{ role: "user", content }],
        stream: false,
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as unknown;
    const envelope = asRecord(payload);
    if (!response.ok) {
      const apiError = asRecord(envelope?.error);
      const message = typeof apiError?.message === "string" ? apiError.message : typeof envelope?.message === "string" ? envelope.message : `HTTP ${response.status}`;
      if (response.status === 401 || response.status === 403) throw new Error(`Hermes Profile「${profile}」API 密钥认证失败`);
      throw new Error(`Hermes API 请求失败：${message}`);
    }
    const choices = Array.isArray(envelope?.choices) ? envelope.choices : [];
    const choice = asRecord(choices[0]);
    const message = asRecord(choice?.message);
    if (typeof message?.content !== "string") throw new Error("Hermes API 没有返回文本内容");
    return message.content;
  } catch (error) {
    if (signal?.aborted) throw cancellationError();
    if (error instanceof Error && error.name === "AbortError") throw new Error(`Hermes API 请求超时（单步上限 ${workflowTimeoutLabel(timeoutMs / 60 / 1000)}）`);
    if (error instanceof TypeError) throw new Error(`无法连接 Hermes API Server（${connection.baseUrl}），请确认 Gateway 正在运行`);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

async function runHermesStep(step: RunStep, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, types: Map<string, string>, settings: SavedSettings, signal?: AbortSignal) {
  throwIfAborted(signal);
  const profile = step.hermesProfile;
  if (!profile || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) throw new Error(`${step.name} 的 Hermes Profile 无效`);
  const outputs = step.outputs ?? [];
  if (!outputs.length) throw new Error(`${step.name} 至少需要定义一个步骤输出`);
  const outputKeys = outputs.map((item) => item.key.trim());
  if (outputKeys.some((key) => !/^[a-zA-Z0-9_]+$/.test(key))) throw new Error(`${step.name} 的输出 key 无效`);
  if (new Set(outputKeys).size !== outputKeys.length) throw new Error(`${step.name} 的输出 key 不能重复`);
  const connection = await readHermesApiConnection(profile);
  const templatePrompt = resolvePromptTemplate(step.promptTemplate ?? "", inputs, stepValues, types);
  const stepInputLines = (step.inputs ?? []).flatMap((input) => {
    const type = input.valueSource === "literal" ? input.literalType ?? "text" : types.get(workflowReferenceRoot(input.sourceRef ?? ""));
    if (type === "image" || type === "image_list" || type === "video") return [];
    const value = input.valueSource === "literal"
      ? parseWorkflowLiteral(input.literalValue, type, input.label ?? input.key)
      : resolveWorkflowValue(input, inputs, stepValues);
    if (value === undefined) return [];
    const formatted = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
    return [`${input.label?.trim() || input.key}: ${formatted}`];
  });
  const prompt = stepInputLines.length
    ? `${templatePrompt}\n\n步骤输入：\n${stepInputLines.join("\n")}`
    : templatePrompt;
  if (!prompt.trim()) throw new Error(`${step.name} 的提示词为空`);
  const outputInstructions = outputs.map((item, index) => {
    const description = typeof item.description === "string" ? item.description.trim() : "";
    return `${index + 1}. ${item.key}（${item.label ?? item.key}，类型：${item.type}）${description ? `；说明：${description}` : ""}`;
  }).join("\n");
  const executionPrompt = `${prompt}\n\n输出要求：\n只输出一个 JSON 对象，不要使用 Markdown 代码围栏，不要附加说明。\n对象必须包含以下字段，字段名必须完全一致：\n${outputInstructions}\n不得输出未声明的字段。`;
  const content = await hermesMessageContent(step, inputs, stepValues, types, executionPrompt, settings, signal);
  const output = (await requestHermesCompletion(profile, connection, content, workflowTimeoutMs(settings.workflowTimeoutMinutes), signal)).trim();
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

app.get("/api/workspace", async (_request, response) => {
  response.set("Cache-Control", "no-store");
  response.json({ workspace: await readWorkspaceFile() ?? null });
});

app.post("/api/workspace/initialize", async (request, response) => {
  try {
    const candidate = normalizeWorkspacePayload(request.body);
    const result = await withWorkspaceLock(async () => {
      const existing = await readWorkspaceFile();
      if (existing) return { created: false, workspace: existing };
      await writeJsonFile(workspaceFile, candidate);
      return { created: true, workspace: candidate };
    });
    response.set("Cache-Control", "no-store");
    response.json(result);
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "无法初始化本机工作区" });
  }
});

app.post("/api/workspace/merge", async (request, response) => {
  try {
    const body = asRecord(request.body);
    const base = normalizeWorkspacePayload(body?.base);
    const desired = normalizeWorkspacePayload(body?.workspace);
    const workspace = await withWorkspaceLock(async () => {
      const saved = await readWorkspaceFile();
      if (!saved) throw new Error("本机工作区尚未初始化，请先完成初始化");
      const current = normalizeWorkspacePayload(saved);
      const merged = mergeWorkspacePayload(base, desired, current);
      await writeJsonFile(workspaceFile, merged);
      return merged;
    });
    response.set("Cache-Control", "no-store");
    response.json({ workspace });
  } catch (error) {
    response.status(error instanceof Error && error.message.includes("尚未初始化") ? 409 : 400)
      .json({ error: error instanceof Error ? error.message : "无法保存本机工作区" });
  }
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
      ...(run.runTitle ? { runTitle: run.runTitle } : {}),
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

app.post("/api/workflows/runs/:runId/cancel", (request, response) => {
  const { runId } = request.params;
  if (!isRunId(runId)) {
    response.status(400).json({ error: "运行记录编号无效" });
    return;
  }
  const cancel = activeWorkflowRunCancellations.get(runId);
  if (!cancel) {
    response.status(409).json({ error: "这条运行记录已结束，或当前服务无法停止它" });
    return;
  }
  cancel("用户主动点击了取消运行");
  response.json({ runId, status: "cancelling" });
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

app.post("/api/comfyui/upload-image", express.raw({ type: "application/octet-stream", limit: "100mb" }), async (request, response) => {
  const settings = await readSettings();
  const encodedFilename = request.get("x-file-name") ?? "";
  const contentType = request.get("x-file-type") ?? "";
  const imageBytes = request.body as Buffer;
  let filename = "";
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    response.status(400).json({ error: "图片文件名无效" });
    return;
  }
  const acceptedImageTypes: Record<string, string[]> = {
    ".bmp": ["image/bmp", "image/x-ms-bmp"],
    ".gif": ["image/gif"],
    ".jpeg": ["image/jpeg"],
    ".jpg": ["image/jpeg"],
    ".png": ["image/png"],
    ".tif": ["image/tiff"],
    ".tiff": ["image/tiff"],
    ".webp": ["image/webp"],
  };
  const extension = path.extname(filename).toLowerCase();
  if (!settings.comfyuiBaseUrl || !filename || filename !== path.basename(filename) || filename.includes("\0") || !acceptedImageTypes[extension]?.includes(contentType.toLowerCase()) || !Buffer.isBuffer(imageBytes) || imageBytes.length === 0) {
    response.status(400).json({ error: "缺少有效的图片文件或 ComfyUI 地址" });
    return;
  }

  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(imageBytes)], { type: contentType }), filename);
  form.set("type", "input");
  form.set("subfolder", "zane-studio");
  form.set("overwrite", "false");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const upstream = await fetch(`${settings.comfyuiBaseUrl}/upload/image`, { method: "POST", body: form, signal: controller.signal });
    const payload = await upstream.json().catch(() => null) as unknown;
    const uploaded = asRecord(payload);
    if (!upstream.ok || typeof uploaded?.name !== "string") {
      const detail = typeof uploaded?.error === "string" ? uploaded.error : `ComfyUI 返回 ${upstream.status}`;
      response.status(502).json({ error: `上传到 ComfyUI 失败：${detail}` });
      return;
    }
    const subfolder = typeof uploaded.subfolder === "string" ? uploaded.subfolder : "";
    response.json({
      id: randomUUID(),
      filename: uploaded.name,
      subfolder,
      type: "input",
      url: `/api/comfyui/view?${new URLSearchParams({ filename: uploaded.name, subfolder, type: "input" })}`,
    });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "上传图片到 ComfyUI 超时" : "无法连接 ComfyUI 上传图片";
    response.status(502).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
});

app.post("/api/comfyui/upload-audio", express.raw({ type: "application/octet-stream", limit: "100mb" }), async (request, response) => {
  const settings = await readSettings();
  const encodedFilename = request.get("x-file-name") ?? "";
  const contentType = request.get("x-file-type") ?? "";
  const audioBytes = request.body as Buffer;
  let filename = "";
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    response.status(400).json({ error: "音频文件名无效" });
    return;
  }
  const extension = path.extname(filename).toLowerCase();
  const acceptedExtensions = new Set([".aac", ".aif", ".aiff", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"]);
  if (!settings.comfyuiBaseUrl || !filename || filename !== path.basename(filename) || /[\\/]/.test(filename) || filename.includes("\0")
    || !acceptedExtensions.has(extension) || !Buffer.isBuffer(audioBytes) || audioBytes.length === 0) {
    response.status(400).json({ error: "请选择有效的音频文件，并确认已配置 ComfyUI 地址" });
    return;
  }

  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(audioBytes)], { type: contentType || "application/octet-stream" }), filename);
  form.set("type", "input");
  form.set("subfolder", "");
  form.set("overwrite", "false");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const upstream = await fetch(settings.comfyuiBaseUrl + "/upload/image", { method: "POST", body: form, signal: controller.signal });
    const payload = await upstream.json().catch(() => null) as unknown;
    const uploaded = asRecord(payload);
    if (!upstream.ok || typeof uploaded?.name !== "string") {
      const detail = typeof uploaded?.error === "string" ? uploaded.error : "ComfyUI 返回 " + upstream.status;
      response.status(502).json({ error: "上传到 ComfyUI 失败：" + detail });
      return;
    }
    const subfolder = typeof uploaded.subfolder === "string" ? uploaded.subfolder : "";
    response.json({
      id: randomUUID(),
      filename: uploaded.name,
      subfolder,
      type: "input",
      url: "/api/comfyui/view?" + new URLSearchParams({ filename: uploaded.name, subfolder, type: "input" }),
    });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "上传音频到 ComfyUI 超时" : "无法连接 ComfyUI 上传音频";
    response.status(502).json({ error: message });
  } finally {
    clearTimeout(timeout);
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
  let executionWorkflow = workflow;
  const requestedRunId = body?.runId;
  if (requestedRunId !== undefined && (typeof requestedRunId !== "string" || !isRunId(requestedRunId))) {
    response.status(400).json({ error: "运行记录编号无效" });
    return;
  }
  const requestedResumeFromRunId = body?.resumeFromRunId;
  if (requestedResumeFromRunId !== undefined && (typeof requestedResumeFromRunId !== "string" || !isRunId(requestedResumeFromRunId))) {
    response.status(400).json({ error: "断点来源运行记录编号无效" });
    return;
  }
  const requestedRunTitle = body?.runTitle;
  if (requestedRunTitle !== undefined && (typeof requestedRunTitle !== "string" || requestedRunTitle.length > 120)) {
    response.status(400).json({ error: "运行标题无效，最多可填写 120 个字符" });
    return;
  }
  let runTitle = typeof requestedRunTitle === "string" ? requestedRunTitle.trim() : "";
  const runId = typeof requestedRunId === "string" ? requestedRunId : randomUUID();
  const runController = new AbortController();
  let cancellationReason: string | undefined;
  const abortRun = (reason: string) => {
    if (!response.writableEnded && !runController.signal.aborted) {
      cancellationReason = reason;
      runController.abort(reason);
    }
  };
  request.once("aborted", () => abortRun("运行请求连接中断，无法确认具体原因"));
  response.once("close", () => abortRun("运行响应连接中断，无法确认具体原因"));
  let inputValues = rawInputs as Record<string, JsonValue>;
  for (const field of workflow.inputs) {
    const value = inputValues[field.key];
    const empty = value === undefined || value === null || value === "" || (field.type === "image_list" && Array.isArray(value) && value.length === 0);
    if (field.required && empty) {
      response.status(400).json({ error: `请填写必填字段：${field.key}` });
      return;
    }
    if (empty) continue;
    const correctType = field.type === "image_list" ? Array.isArray(value) && value.every((item) => {
      const attachment = asRecord(item);
      return typeof attachment?.id === "string"
        && typeof attachment.filename === "string"
        && typeof attachment.subfolder === "string"
        && attachment.type === "input"
        && typeof attachment.url === "string";
    })
      : field.type === "audio" ? isComfyInputAudioAttachment(value)
      : field.type === "number" ? typeof value === "number" && Number.isFinite(value)
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
  let resumeSource: Awaited<ReturnType<typeof readRunRecord>> | undefined;
  if (typeof requestedResumeFromRunId === "string") {
    if (!settings.projectDirectory) {
      response.status(400).json({ error: "请先在集成连接中配置项目目录" });
      return;
    }
    if (requestedResumeFromRunId === runId) {
      response.status(400).json({ error: "断点来源不能是新的运行记录本身" });
      return;
    }
    if (activeWorkflowRunCancellations.has(requestedResumeFromRunId) || activeWorkflowRunResumes.has(requestedResumeFromRunId)) {
      response.status(409).json({ error: "这条运行记录仍在执行，请先取消或等待它结束" });
      return;
    }
    resumeSource = await readRunRecord(settings.projectDirectory, requestedResumeFromRunId);
    if (!resumeSource) {
      response.status(404).json({ error: "没有找到断点来源运行记录" });
      return;
    }
    if (resumeSource.status === "completed") {
      response.status(409).json({ error: "已完成的运行记录不需要断点续跑" });
      return;
    }
    const sourceWorkflow = resumeSource.workflow as Record<string, unknown> | undefined;
    if (!sourceWorkflow || !Array.isArray(sourceWorkflow.inputs) || !Array.isArray(sourceWorkflow.steps) || !Array.isArray(sourceWorkflow.outputs) || resumeSource.sceneId !== workflow.sceneId) {
      response.status(409).json({ error: "断点来源与当前工作流不匹配" });
      return;
    }
    if (activeWorkflowRunCancellations.has(requestedResumeFromRunId) || activeWorkflowRunResumes.has(requestedResumeFromRunId)) {
      response.status(409).json({ error: "这条运行记录仍在执行，请先取消或等待它结束" });
      return;
    }
    activeWorkflowRunResumes.add(requestedResumeFromRunId);
    const releaseResume = () => activeWorkflowRunResumes.delete(requestedResumeFromRunId);
    response.once("finish", releaseResume);
    response.once("close", releaseResume);
    executionWorkflow = sourceWorkflow as unknown as RunWorkflowDefinition;
    inputValues = resumeSource.inputValues;
    runTitle ||= resumeSource.runTitle ?? "";
    const sourcePaths = runArtifactPaths(settings.projectDirectory, requestedResumeFromRunId);
    const sourceInput = await readJsonFile(sourcePaths.inputs);
    const sourceFiles = Array.isArray(sourceInput?.files) ? sourceInput.files : [];
    for (const value of sourceFiles) {
      const file = asRecord(value);
      if (typeof file?.key !== "string" || typeof file.path !== "string" || !file.path.startsWith("inputs/files/")) continue;
      const filename = path.resolve(sourcePaths.directory, ...file.path.split(/[\\/]/));
      const sourceDirectory = path.resolve(sourcePaths.directory);
      if (!filename.startsWith(`${sourceDirectory}${path.sep}`)) continue;
      try {
        if ((await stat(filename)).isFile()) inputValues[file.key] = filename;
      } catch {
        // Fall back to the original input value when the archived copy is unavailable.
      }
    }
  }
  if (settings.projectDirectory && typeof requestedRunId === "string") {
    try {
      await stat(runArtifactPaths(settings.projectDirectory, runId).directory);
      response.status(409).json({ error: "运行记录编号已存在" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const legacyExecution = executionWorkflow.execution;
  if (legacyExecution) {
    const { execution: _legacyExecution, ...withoutWorkflowExecution } = executionWorkflow;
    if (legacyExecution.mode === "for_each" && !executionWorkflow.steps.some((step) => step.execution?.mode === "for_each")) {
      const targetIndex = executionWorkflow.steps.findIndex((step) => step.kind !== "control");
      executionWorkflow = targetIndex < 0
        ? withoutWorkflowExecution
        : { ...withoutWorkflowExecution, steps: executionWorkflow.steps.map((step, index) => index === targetIndex ? { ...step, execution: legacyExecution } : step) };
    } else {
      executionWorkflow = withoutWorkflowExecution;
    }
  }
  const stepIterationConfigs = executionWorkflow.steps.filter((step) => step.execution?.mode === "for_each");
  if (typeof requestedResumeFromRunId === "string" && stepIterationConfigs.length) {
    response.status(409).json({ error: "包含逐项执行步骤的流程暂不支持从断点续跑，请重新运行整个流程" });
    return;
  }
  for (const step of stepIterationConfigs) {
    if (!step.execution?.sourceRef?.trim()) {
      response.status(400).json({ error: `${step.name} 的逐项执行必须选择列表或数组来源` });
      return;
    }
  }
  const startedAt = new Date().toISOString();
  let artifacts: RunArtifactPaths | undefined;
  try {
    artifacts = await prepareRunArtifacts(settings, runId, executionWorkflow, inputValues, startedAt, runTitle || undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法创建项目运行目录";
    response.status(400).json({ error: message });
    return;
  }
  const steps: RunStepRecord[] = [];
  const mediaCache = new Map<string, JsonValue>();
  const archiveWarnings: string[] = [];
  let failure = "";

  activeWorkflowRunCancellations.set(runId, (reason) => abortRun(reason));
  response.once("finish", () => activeWorkflowRunCancellations.delete(runId));

  function syncSteps(activeSteps: RunStepRecord[] = []) {
    steps.splice(0, steps.length, ...activeSteps);
  }

  async function persistRuntime(status: "running" | "completed" | "failed" | "cancelled", finishedAt?: string, cancellationReason?: string) {
    if (!artifacts) return;
    await writeJsonFile(artifacts.runtime, {
      format: "zane-studio.runtime/v1",
      runId,
      status,
      startedAt,
      sceneId: executionWorkflow.sceneId ?? null,
      workflowName: executionWorkflow.name ?? "未命名工作流",
      ...(runTitle ? { runTitle } : {}),
      artifacts: artifactPublicPaths(artifacts),
      ...(finishedAt ? { finishedAt, durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime() } : {}),
      ...(typeof requestedResumeFromRunId === "string" ? { resumedFromRunId: requestedResumeFromRunId } : {}),
      ...(archiveWarnings.length ? { archiveWarnings } : {}),
      ...(cancellationReason ? { cancellationReason } : {}),
      steps,
    });
  }

  async function archiveStepRecords(records: RunStepRecord[]) {
    return Promise.all(records.map(async (step) => {
      const outputs = step.outputs
        ? Object.fromEntries(await Promise.all(Object.entries(step.outputs).map(async ([key, value]) => [
          key,
          await archiveOutputMedia(value, runId, artifacts!, settings.comfyuiBaseUrl, mediaCache, archiveWarnings),
        ] as const)))
        : undefined;
      const items = step.items
        ? await Promise.all(step.items.map(async (item) => item.outputs ? {
          ...item,
          outputs: Object.fromEntries(await Promise.all(Object.entries(item.outputs).map(async ([key, value]) => [
            key,
            await archiveOutputMedia(value, runId, artifacts!, settings.comfyuiBaseUrl, mediaCache, archiveWarnings),
          ] as const))),
        } : item))
        : undefined;
      return {
        ...step,
        ...(outputs ? { outputs } : {}),
        ...(items ? { items } : {}),
      };
    }));
  }

  function iterationSourceInfo(sourceRef: string) {
    const parsed = splitWorkflowReference(sourceRef);
    if (!parsed) return undefined;
    const path = parsed.path ? parseWorkflowJsonPath(parsed.path) : [];
    const inputMatch = /^input\.([a-zA-Z0-9_]+)$/.exec(parsed.root);
    if (inputMatch) {
      const field = executionWorkflow.inputs.find((candidate) => candidate.key === inputMatch[1]);
      return { kind: "input" as const, key: inputMatch[1], type: field?.type, path };
    }
    const outputMatch = /^step\.([a-zA-Z0-9_-]+)\.outputs\.([a-zA-Z0-9_]+)$/.exec(parsed.root);
    if (outputMatch) {
      const step = executionWorkflow.steps.find((candidate) => candidate.id === outputMatch[1]);
      const output = step?.outputs?.find((candidate) => candidate.key === outputMatch[2]);
      return { kind: "step" as const, stepId: outputMatch[1], key: outputMatch[2], type: output?.type, path };
    }
    return undefined;
  }

  function replaceIterationPath(value: JsonValue, segments: Array<string | number>, item: JsonValue): JsonValue {
    if (!segments.length) return item;
    const [segment, ...remaining] = segments;
    if (typeof segment === "number" && Array.isArray(value) && segment < value.length) {
      const next = [...value];
      next[segment] = replaceIterationPath(next[segment], remaining, item);
      return next;
    }
    if (typeof segment === "string" && value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.prototype.hasOwnProperty.call(value, segment)) {
      return { ...value, [segment]: replaceIterationPath(value[segment], remaining, item) };
    }
    throw new Error(`逐项执行来源路径不存在：${segments.join(".")}`);
  }

  function iterationContext(sourceRef: string, itemValue: JsonValue, baseInputs: Record<string, JsonValue>, baseValues: Map<string, Record<string, JsonValue>>, sourceType?: string) {
    const info = iterationSourceInfo(sourceRef);
    if (!info) throw new Error(`逐项执行来源无效：${sourceRef || "（空）"}`);
    const sourceItem = info.path.length
      ? itemValue
      : info.type === "image_list" || sourceType === "image_list" ? [itemValue] as JsonValue : itemValue;
    if (info.kind === "input") {
      return {
        inputs: {
          ...baseInputs,
          [info.key]: info.path.length ? replaceIterationPath(baseInputs[info.key], info.path, sourceItem) : sourceItem,
          "iteration.item": itemValue,
        },
        values: baseValues,
      };
    }
    const sourceOutputs = baseValues.get(info.stepId);
    if (!sourceOutputs || !Object.prototype.hasOwnProperty.call(sourceOutputs, info.key)) {
      throw new Error(`逐项执行来源 ${sourceRef} 没有可用数组`);
    }
    const values = new Map(baseValues);
    values.set(info.stepId, {
      ...sourceOutputs,
      [info.key]: info.path.length ? replaceIterationPath(sourceOutputs[info.key], info.path, sourceItem) : sourceItem,
    });
    return { inputs: { ...baseInputs, "iteration.item": itemValue }, values };
  }

  async function executeStep(step: RunStep, stepInputValues: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, types: Map<string, string>) {
    if (step.kind === "control") {
      const control = step.control;
      if (!control || control.type !== "condition" || !control.rules.length) throw new Error("条件节点至少需要一条规则");
      const results = control.rules.map((rule) => evaluateCondition(rule, stepInputValues, stepValues, types));
      return { result: control.match === "all" ? results.every(Boolean) : results.some(Boolean) } as Record<string, JsonValue>;
    }
    if (step.kind === "hermes") return runHermesStep(step, stepInputValues, stepValues, types, settings, runController.signal);
    if (step.kind === "comfyui") {
      return comfyuiQueue.run(
        () => runComfyUIStep(step, stepInputValues, stepValues, settings.comfyuiBaseUrl, runController.signal, executionWorkflow.inputs, types, workflowTimeoutMs(settings.workflowTimeoutMinutes)),
        runController.signal,
      );
    }
    throw new Error(`暂不支持执行方式：${step.kind}`);
  }

  async function executeWorkflowItem(itemIndex: number, itemInputValues: Record<string, JsonValue>, resumeState?: { steps: RunStepRecord[]; values: Map<string, Record<string, JsonValue>>; types: Map<string, string>; startIndex: number }): Promise<RunItemResult> {
    const values = resumeState?.values ?? new Map<string, Record<string, JsonValue>>();
    const types = resumeState?.types ?? new Map<string, string>();
    if (!resumeState) {
      for (const field of executionWorkflow.inputs) types.set(`input.${field.key}`, field.type === "textarea" || field.type === "select" ? "text" : field.type);
    }
    const itemSteps: RunStepRecord[] = resumeState?.steps ? [...resumeState.steps] : [];
    let itemFailure = "";
    let itemCancelled = false;
    const startIndex = resumeState?.startIndex ?? 0;

    for (let index = startIndex; index < executionWorkflow.steps.length; index += 1) {
      if (runController.signal.aborted) {
        itemCancelled = true;
        break;
      }
      const step = executionWorkflow.steps[index];
      if (!step || typeof step.id !== "string" || typeof step.name !== "string") {
        itemFailure = `第 ${index + 1} 步配置无效`;
        break;
      }
      const stepInputs = resolveStepInputs(step, itemInputValues, values);
      const inputLabels = Object.fromEntries((step.inputs ?? []).map((input) => [input.key, input.label ?? input.key]));
      const outputLabels = Object.fromEntries((step.outputs ?? []).map((output) => [output.key, output.label ?? output.key]));
      const outputTypes = Object.fromEntries((step.outputs ?? []).map((output) => [output.key, output.type]));
      if (step.runCondition) {
        const condition = values.get(step.runCondition.conditionStepId)?.result;
        if (typeof condition !== "boolean") {
          itemFailure = `${step.name} 引用的条件节点没有布尔结果`;
          itemSteps.push({ stepId: step.id, name: step.name, status: "failed", message: itemFailure, inputs: stepInputs, inputLabels, outputLabels, outputTypes });
          break;
        }
        if (condition !== step.runCondition.expectedResult) {
          itemSteps.push({ stepId: step.id, name: step.name, status: "skipped", message: "执行条件未满足", inputs: stepInputs, inputLabels, outputLabels, outputTypes });
          syncSteps(itemSteps);
          await persistRuntime("running");
          continue;
        }
      }

      if (step.execution?.mode === "for_each") {
        const sourceRef = step.execution.sourceRef?.trim() ?? "";
        let sourceItems: JsonValue[] = [];
        let sourceType: string | undefined;
        const parent: RunStepRecord = { stepId: step.id, name: step.name, status: "running", inputs: stepInputs, inputLabels, outputLabels, outputTypes, items: [] };
        itemSteps.push(parent);
        syncSteps(itemSteps);
        await persistRuntime("running");
        try {
          const info = iterationSourceInfo(sourceRef);
          if (!info) throw new Error(`逐项执行来源无效：${sourceRef || "（空）"}`);
          sourceType = info.type;
          const sourceValue = resolveWorkflowReference(sourceRef, itemInputValues, values);
          if (!Array.isArray(sourceValue)) throw new Error(`逐项执行来源 ${sourceRef} 必须是数组`);
          sourceItems = sourceValue;
        } catch (error) {
          itemFailure = error instanceof Error ? error.message : `${step.name} 的逐项来源无效`;
          parent.status = "failed";
          parent.message = itemFailure;
          syncSteps(itemSteps);
          await persistRuntime("running");
          break;
        }

        const aggregatedOutputs: Record<string, JsonValue> = Object.fromEntries((step.outputs ?? []).map((output) => [output.key, [] as JsonValue[]]));
        let iterationFailed = false;
        for (let itemIndex = 0; itemIndex < sourceItems.length; itemIndex += 1) {
          if (runController.signal.aborted) {
            itemCancelled = true;
            break;
          }
          const sourceItem = sourceItems[itemIndex];
          let currentInputs: Record<string, JsonValue>;
          let currentValues: Map<string, Record<string, JsonValue>>;
          try {
            const context = iterationContext(sourceRef, sourceItem, itemInputValues, values, sourceType);
            currentInputs = context.inputs;
            currentValues = context.values;
          } catch (error) {
            const message = error instanceof Error ? error.message : `${step.name} 的第 ${itemIndex + 1} 项输入无效`;
            parent.items?.push({ index: itemIndex, value: sourceItem, status: "failed", error: message });
            for (const output of step.outputs ?? []) (aggregatedOutputs[output.key] as JsonValue[]).push(null);
            itemFailure = message;
            iterationFailed = true;
            if (step.execution.onError === "stop") break;
            continue;
          }
          const currentStepInputs = resolveStepInputs(step, currentInputs, currentValues);
          const currentTypes = new Map(types);
          const iterationInfo = iterationSourceInfo(sourceRef);
          const iterationItemType = iterationInfo?.path.length
            ? "json"
            : iterationInfo?.type === "image_list" ? "image" : iterationInfo?.type ?? "json";
          currentTypes.set("iteration.item", iterationItemType);
          const itemRecord: RunStepItemRecord = { index: itemIndex, value: sourceItem, status: "running", inputs: currentStepInputs };
          parent.items?.push(itemRecord);
          syncSteps(itemSteps);
          await persistRuntime("running");
          try {
            const outputs = await executeStep(step, currentInputs, currentValues, currentTypes);
            itemRecord.status = "completed";
            itemRecord.outputs = outputs;
            for (const output of step.outputs ?? []) {
              const collected = aggregatedOutputs[output.key];
              if (Array.isArray(collected)) collected.push(outputs[output.key] ?? null);
            }
          } catch (error) {
            if (runController.signal.aborted) {
              itemCancelled = true;
              itemRecord.status = "cancelled";
              itemRecord.error = cancellationReason ?? "运行已取消";
              break;
            }
            const message = error instanceof Error ? error.message : `${step.name} 的第 ${itemIndex + 1} 项执行失败`;
            itemRecord.status = "failed";
            itemRecord.error = message;
            for (const output of step.outputs ?? []) (aggregatedOutputs[output.key] as JsonValue[]).push(null);
            itemFailure = message;
            iterationFailed = true;
            if (step.execution.onError === "stop") break;
          }
          syncSteps(itemSteps);
          await persistRuntime("running");
        }
        if (itemCancelled) {
          parent.status = "cancelled";
          parent.message = cancellationReason ?? "运行已取消";
          syncSteps(itemSteps);
          await persistRuntime("running");
          break;
        }
        parent.outputs = aggregatedOutputs;
        values.set(step.id, aggregatedOutputs);
        for (const output of step.outputs ?? []) types.set(`step.${step.id}.outputs.${output.key}`, output.type === "image" ? "image_list" : output.type);
        if (iterationFailed) {
          parent.status = "failed";
          parent.message = itemFailure || `${step.name} 有逐项执行失败`;
          syncSteps(itemSteps);
          await persistRuntime("running");
          break;
        }
        parent.status = "completed";
        syncSteps(itemSteps);
        await persistRuntime("running");
        continue;
      }

      try {
        itemSteps.push({ stepId: step.id, name: step.name, status: "running", inputs: stepInputs, inputLabels, outputLabels, outputTypes });
        syncSteps(itemSteps);
        await persistRuntime("running");
        const outputs = await executeStep(step, itemInputValues, values, types);
        values.set(step.id, outputs);
        for (const output of step.outputs ?? []) types.set(`step.${step.id}.outputs.${output.key}`, output.type);
        itemSteps[itemSteps.length - 1] = { stepId: step.id, name: step.name, status: "completed", inputs: stepInputs, inputLabels, outputs, outputLabels, outputTypes };
        syncSteps(itemSteps);
        await persistRuntime("running");
      } catch (error) {
        if (runController.signal.aborted) {
          itemCancelled = true;
          const activeStep = itemSteps[itemSteps.length - 1];
          if (activeStep?.status === "running") {
            activeStep.status = "cancelled";
            activeStep.message = cancellationReason ?? "运行已取消";
          }
          syncSteps(itemSteps);
          await persistRuntime("running");
          break;
        }
        itemFailure = error instanceof Error ? error.message : `${step.name} 执行失败`;
        itemSteps[itemSteps.length - 1] = { stepId: step.id, name: step.name, status: "failed", message: itemFailure, inputs: stepInputs, inputLabels, outputLabels, outputTypes };
        syncSteps(itemSteps);
        await persistRuntime("running");
        break;
      }
    }

    const itemOutputs = executionWorkflow.outputs.map((output) => {
      try {
        return { key: output.key, label: output.label ?? output.key, type: output.type, value: resolveWorkflowReference(output.sourceRef, itemInputValues, values) ?? null };
      } catch {
        return { key: output.key, label: output.label ?? output.key, type: output.type, value: null };
      }
    });
    const archivedOutputs = await Promise.all(itemOutputs.map(async (output) => ({
      ...output,
      value: await archiveOutputMedia(output.value, runId, artifacts!, settings.comfyuiBaseUrl, mediaCache, archiveWarnings),
    })));
    const archivedSteps = await archiveStepRecords(itemSteps);
    itemSteps.splice(0, itemSteps.length, ...archivedSteps);
    const status = itemCancelled ? "cancelled" as const : itemFailure ? "failed" as const : "completed" as const;
    return {
      index: itemIndex,
      value: null,
      status,
      steps: itemSteps,
      outputs: archivedOutputs,
      ...(itemFailure ? { error: itemFailure } : {}),
    };
  }

  let resumeState: { steps: RunStepRecord[]; values: Map<string, Record<string, JsonValue>>; types: Map<string, string>; startIndex: number } | undefined;
  if (resumeSource) {
    const values = new Map<string, Record<string, JsonValue>>();
    const types = new Map<string, string>();
    for (const field of executionWorkflow.inputs) types.set(`input.${field.key}`, field.type === "textarea" || field.type === "select" ? "text" : field.type);
    const sourceSteps = new Map(resumeSource.steps.flatMap((savedStep) => {
      const recorded = asRecord(savedStep);
      return typeof recorded?.stepId === "string" ? [[recorded.stepId, recorded] as const] : [];
    }));
    const savedSteps: RunStepRecord[] = [];
    let startIndex = 0;
    for (let index = 0; index < executionWorkflow.steps.length; index += 1) {
      const step = executionWorkflow.steps[index];
      const recorded = sourceSteps.get(step.id);
      const status = recorded?.status;
      if (!recorded || (status !== "completed" && status !== "skipped")) break;
      savedSteps.push(recorded as unknown as RunStepRecord);
      const recordedOutputs = asRecord(recorded.outputs) as Record<string, JsonValue> | undefined;
      if (status === "completed" && recordedOutputs) values.set(step.id, recordedOutputs);
      for (const output of step.outputs ?? []) types.set(`step.${step.id}.outputs.${output.key}`, output.type);
      startIndex = index + 1;
    }
    resumeState = { steps: savedSteps, values, types, startIndex };
    syncSteps(savedSteps);
  }

  await persistRuntime("running");
  const singleItemResult = await executeWorkflowItem(0, inputValues, resumeState);
  steps.splice(0, steps.length, ...singleItemResult.steps);
  if (singleItemResult.status === "failed") failure = singleItemResult.error ?? "流程执行失败";

  if (runController.signal.aborted) {
    const finishedAt = new Date().toISOString();
    const reason = cancellationReason ?? "运行已中断，无法确认具体原因";
    const activeStep = steps[steps.length - 1];
    if (activeStep?.status === "running") {
      activeStep.status = "cancelled";
      activeStep.message = reason;
    }
    await persistRuntime("cancelled", finishedAt, reason);
    if (artifacts) {
      await writeJsonFile(artifacts.output, {
        format: "zane-studio.output/v1",
        runId,
        status: "cancelled",
        ...(typeof requestedResumeFromRunId === "string" ? { resumedFromRunId: requestedResumeFromRunId } : {}),
        startedAt,
        finishedAt,
        durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
        steps,
        outputs: [],
        error: reason,
        cancellationReason: reason,
      });
    }
    if (!response.writableEnded && !response.destroyed) {
      response.status(499).json({ runId, status: "cancelled", steps, outputs: [], error: reason, cancellationReason: reason, ...(typeof requestedResumeFromRunId === "string" ? { resumedFromRunId: requestedResumeFromRunId } : {}), artifacts: artifactPublicPaths(artifacts) });
    }
    activeWorkflowRunCancellations.delete(runId);
    return;
  }

  const finalOutputs = singleItemResult.outputs;
  const archivedOutputs = await Promise.all(finalOutputs.map(async (output) => ({
    ...output,
    value: await archiveOutputMedia(output.value, runId, artifacts!, settings.comfyuiBaseUrl, mediaCache, archiveWarnings),
  })));

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
    ...(typeof requestedResumeFromRunId === "string" ? { resumedFromRunId: requestedResumeFromRunId } : {}),
    ...(archiveWarnings.length ? { archiveWarnings } : {}),
    artifacts: artifactPublicPaths(artifacts),
  };
  await writeJsonFile(artifacts.output, {
    format: "zane-studio.output/v1",
    ...result,
  });
  await persistRuntime(status, finishedAt);
  activeWorkflowRunCancellations.delete(runId);
  response.json(result);
});

app.put("/api/settings", async (request, response) => {
  const current = await readSettings();
  const profiles = await listHermesProfiles();
  const available = new Set(profiles.map((profile) => profile.id));
  const requestedProfiles: string[] = Array.isArray(request.body?.enabledHermesProfiles)
    ? (request.body.enabledHermesProfiles as unknown[]).filter((id): id is string => typeof id === "string" && available.has(id))
    : current.enabledHermesProfiles;
  const requestedWorkflowTimeoutMinutes = request.body?.workflowTimeoutMinutes;
  if (requestedWorkflowTimeoutMinutes !== undefined && parseWorkflowTimeoutMinutes(requestedWorkflowTimeoutMinutes) === undefined) {
    response.status(400).json({ error: `单步运行超时必须是 ${minimumWorkflowTimeoutMinutes} 到 ${maximumWorkflowTimeoutMinutes} 分钟的整数` });
    return;
  }
  const next: SavedSettings = {
    enabledHermesProfiles: [...new Set(requestedProfiles)],
    comfyuiBaseUrl: normalizeBaseUrl(request.body?.comfyuiBaseUrl, defaults.comfyuiBaseUrl),
    projectDirectory: normalizeProjectDirectory(request.body?.projectDirectory, current.projectDirectory),
    workflowTimeoutMinutes: normalizeWorkflowTimeoutMinutes(requestedWorkflowTimeoutMinutes, current.workflowTimeoutMinutes),
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
