import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRuntimeMediaValue, mediaKindFromWorkflowType, runtimeMediaItems } from "../runtimeValue.js";
import { asRecord, externalizeRuntimeValue, isMediaWorkflowType, resolveWorkflowValue } from "../domain/workflowValues.js";
import type { JsonValue, RunArtifactPaths, RunStepInput, RunWorkflowDefinition, SavedSettings, RunStatus } from "../domain/types.js";
import { readJsonFile, writeJsonFile } from "../storage/jsonFileStore.js";

export function runArtifactPaths(projectDirectory: string, runId: string): RunArtifactPaths {
  const directory = path.join(projectDirectory, ".zane", "runs", runId);
  return {
    directory,
    inputs: path.join(directory, "inputs", "input.json"),
    workflow: path.join(directory, "workflow.json"),
    runtime: path.join(directory, "runtime.json"),
    output: path.join(directory, "outputs", "result.json"),
  };
}

export async function validateProjectDirectory(directory: string) {
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

export function artifactPublicPaths(paths: RunArtifactPaths) {
  return {
    directory: paths.directory,
    inputs: paths.inputs,
    workflow: paths.workflow,
    runtime: paths.runtime,
    output: paths.output,
  };
}

export async function prepareRunArtifacts(settings: SavedSettings, runId: string, workflow: RunWorkflowDefinition, inputValues: Record<string, JsonValue>, startedAt: string, runTitle?: string) {
  if (!settings.projectDirectory) throw new Error("请先在集成连接中配置项目目录");
  const paths = runArtifactPaths(settings.projectDirectory, runId);
  await mkdir(paths.directory, { recursive: true });
  const inputFiles: Array<{ key: string; path: string; originalPath: string; index?: number }> = [];
  for (const field of workflow.inputs) {
    const value = inputValues[field.key];
    if (!isMediaWorkflowType(field.type)) continue;
    const mediaItems = runtimeMediaItems(value, mediaKindFromWorkflowType(field.type) ?? "image");
    for (let index = 0; index < mediaItems.length; index += 1) {
      const locator = mediaItems[index].locator;
      if (locator.type !== "path" || !locator.value.trim()) continue;
      const originalPath = path.resolve(locator.value.trim());
      try {
        if (!(await stat(originalPath)).isFile()) continue;
        const extension = path.extname(originalPath).replace(/[^.A-Za-z0-9]/g, "").slice(0, 12);
        const suffix = mediaItems.length > 1 ? `-${index + 1}` : "";
        const filename = `${field.key.replace(/[^A-Za-z0-9_-]/g, "_") || "input"}${suffix}${extension}`;
        const relativePath = path.posix.join("inputs", "files", filename);
        const destination = path.join(paths.directory, ...relativePath.split("/"));
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(originalPath, destination);
        inputFiles.push({ key: field.key, path: relativePath, originalPath, ...(mediaItems.length > 1 ? { index } : {}) });
      } catch {
        // The input remains in the JSON snapshot if it is not an accessible local file.
      }
    }
  }
  const persistedInputValues = Object.fromEntries(Object.entries(inputValues).map(([key, value]) => [key, externalizeRuntimeValue(value)]));
  await Promise.all([
    writeJsonFile(paths.inputs, {
      format: "zane-studio.input/v1",
      runId,
      createdAt: startedAt,
      sceneId: workflow.sceneId ?? null,
      workflowName: workflow.name ?? "未命名工作流",
      ...(runTitle ? { runTitle } : {}),
      values: persistedInputValues,
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
      status: "queued",
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

export function mediaContentTypeExtension(contentType: string | null) {
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

export async function archiveOutputMedia(value: JsonValue, runId: string, paths: RunArtifactPaths, comfyuiBaseUrl: string, cache: Map<string, JsonValue>, warnings: string[]): Promise<JsonValue> {
  if (isRuntimeMediaValue(value)) return archiveOutputMedia(externalizeRuntimeValue(value), runId, paths, comfyuiBaseUrl, cache, warnings);
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

export function isRunId(value: string) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

export function runStatus(value: unknown): RunStatus {
  return ["queued", "running", "cancelling", "completed", "cancelled", "stale"].includes(String(value)) ? value as RunStatus : "failed";
}


export async function readRunRecord(projectDirectory: string, runId: string) {
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

