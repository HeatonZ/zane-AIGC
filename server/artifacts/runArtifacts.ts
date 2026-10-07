import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, stat, unlink, writeFile, rm, rename } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import { ResourceQueues } from "../execution/resourceQueue.js";
import path from "node:path";
import { createRuntimeMediaValue, isRuntimeMediaValue, mediaKindFromWorkflowType, runtimeMediaItems } from "../runtimeValue.js";
import { HttpError } from "../errors.js";
import { log } from "../observability/logger.js";
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

function checkedRunDirectory(projectDirectory: string, runId: string) {
  const root = path.resolve(projectDirectory, ".zane", "runs");
  const directory = path.resolve(runArtifactPaths(projectDirectory, runId).directory);
  if (!isRunId(runId) || path.dirname(directory) !== root) throw new HttpError(400, "运行归档目录无效");
  return { root, directory };
}

/** Call only for a newly prepared run that has not committed to SQLite. */
export async function discardRunArtifacts(projectDirectory: string, runId: string) {
  const { directory } = checkedRunDirectory(projectDirectory, runId);
  await rm(directory, { recursive: true, force: true });
}

export async function prepareRunArtifacts(settings: SavedSettings, runId: string, workflow: RunWorkflowDefinition, inputValues: Record<string, JsonValue>, startedAt: string, runTitle?: string) {
  if (!settings.projectDirectory) throw new Error("请先在集成连接中配置项目目录");
  const paths = runArtifactPaths(settings.projectDirectory, runId);
  const { root } = checkedRunDirectory(settings.projectDirectory, runId);
  const archivedInputs = { ...inputValues };
  const inputFiles: Array<{ key: string; path: string; originalPath: string; index?: number }> = [];
  const copies: Array<{ originalPath: string; destination: string }> = [];
  // Check all local inputs before creating a run directory or starting a paid executor.
  for (const field of workflow.inputs) {
    const kind = mediaKindFromWorkflowType(field.type);
    if (!kind || !isMediaWorkflowType(field.type) || inputValues[field.key] === undefined) continue;
    const mediaItems = runtimeMediaItems(inputValues[field.key], kind);
    const savedItems = [...mediaItems];
    for (const [index, item] of mediaItems.entries()) {
      if (item.locator.type !== "path") continue;
      const originalPath = path.resolve(item.locator.value.trim());
      try { if (!(await stat(originalPath)).isFile()) throw new Error("不是文件"); }
      catch { throw new HttpError(400, "无法读取输入素材，请重新选择文件：" + item.locator.value, "INPUT_MEDIA_UNAVAILABLE"); }
      const extension = path.extname(originalPath).replace(/[^.A-Za-z0-9]/g, "").slice(0, 12);
      const suffix = mediaItems.length > 1 ? "-" + (index + 1) : "";
      const fieldId = createHash("sha256").update(field.key).digest("hex").slice(0, 8);
      const filename = (field.key.replace(/[^A-Za-z0-9_-]/g, "_") || "input") + "-" + fieldId + suffix + extension;
      const relativePath = path.posix.join("inputs", "files", filename);
      const destination = path.join(paths.directory, ...relativePath.split("/"));
      copies.push({ originalPath, destination });
      inputFiles.push({ key: field.key, path: relativePath, originalPath, ...(mediaItems.length > 1 ? { index } : {}) });
      savedItems[index] = { ...item, locator: { type: "path", value: destination } };
    }
    archivedInputs[field.key] = createRuntimeMediaValue(kind, savedItems);
  }
  await mkdir(root, { recursive: true });
  try { await mkdir(paths.directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, "运行记录编号已存在", "RUN_ALREADY_EXISTS");
    throw error;
  }
  // The exclusive mkdir above gives this preparation ownership of this exact directory.
  try {
    for (const copy of copies) {
      await mkdir(path.dirname(copy.destination), { recursive: true });
      await copyFile(copy.originalPath, copy.destination);
    }
    const persistedInputValues = externalizeRuntimeValue(archivedInputs);
    const writes = await Promise.allSettled([
      writeJsonFile(paths.inputs, {
        format: "zane-studio.input/v1", runId, createdAt: startedAt, sceneId: workflow.sceneId ?? null,
        workflowName: workflow.name ?? "未命名工作流", ...(runTitle ? { runTitle } : {}), values: persistedInputValues, files: inputFiles,
      }),
      writeJsonFile(paths.workflow, { format: "zane-studio.workflow/v1", runId, createdAt: startedAt, workflow }),
      writeJsonFile(paths.runtime, {
        format: "zane-studio.runtime/v1", runId, status: "queued", startedAt,
        sceneId: workflow.sceneId ?? null, workflowName: workflow.name ?? "未命名工作流", ...(runTitle ? { runTitle } : {}),
        artifacts: artifactPublicPaths(paths), steps: [],
      }),
    ]);
    const failure = writes.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    // Both the live executor and the persisted queue snapshot read these durable copies.
    Object.assign(inputValues, archivedInputs);
    return paths;
  } catch (error) {
    await discardRunArtifacts(settings.projectDirectory, runId).catch(failure => log("warn", "run.preparation_cleanup_failed", { runId, error: String(failure) }));
    throw error;
  }
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

/** Rehydrate legacy queued snapshots from their already-copied inputs before executing. */
export async function restoreArchivedRunInputs(projectDirectory: string, runId: string, workflow: RunWorkflowDefinition, inputValues: Record<string, JsonValue>) {
  const paths = runArtifactPaths(projectDirectory, runId);
  const archived = await readJsonFile(paths.inputs);
  if (archived && archived.runId !== runId) throw new Error("输入归档与运行记录不匹配");
  const files = Array.isArray(archived?.files) ? archived.files : [];
  const values = { ...inputValues };
  const root = path.resolve(paths.directory, "inputs", "files") + path.sep;
  for (const field of workflow.inputs) {
    const kind = mediaKindFromWorkflowType(field.type);
    if (!kind || values[field.key] === undefined) continue;
    const items = [...runtimeMediaItems(values[field.key], kind)];
    for (const raw of files) {
      const file = asRecord(raw);
      if (file?.key !== field.key) continue;
      const index = file.index === undefined ? 0 : Number(file.index);
      if (!Number.isSafeInteger(index) || index < 0 || !items[index] || typeof file.path !== "string" || !file.path.startsWith("inputs/files/")) throw new Error("输入归档文件索引无效：" + field.key);
      const filename = path.resolve(paths.directory, ...file.path.split("/"));
      if (!filename.startsWith(root)) throw new Error("输入归档文件路径无效：" + field.key);
      items[index] = { ...items[index], locator: { type: "path", value: filename } };
    }
    for (const item of items) if (item.locator.type === "path" && !(await stat(item.locator.value).catch(() => undefined))?.isFile()) {
      throw new Error("输入归档素材已丢失：" + field.key);
    }
    values[field.key] = createRuntimeMediaValue(kind, items);
  }
  return values;
}

const maxArchivedMediaBytes = 2_000_000_000;
const archiveStates = new WeakMap<Map<string, JsonValue>, { pending: Map<string, Promise<JsonValue>>; queue: ResourceQueues }>();
function archiveState(cache: Map<string, JsonValue>) {
  let state = archiveStates.get(cache);
  if (!state) { state = { pending: new Map(), queue: new ResourceQueues() }; archiveStates.set(cache, state); }
  return state;
}

export async function archiveOutputMedia(value: JsonValue, runId: string, paths: RunArtifactPaths, comfyuiBaseUrl: string, cache: Map<string, JsonValue>, warnings: string[], signal?: AbortSignal): Promise<JsonValue> {
  if (isRuntimeMediaValue(value)) return archiveOutputMedia(externalizeRuntimeValue(value), runId, paths, comfyuiBaseUrl, cache, warnings, signal);
  if (Array.isArray(value)) return Promise.all(value.map(item => archiveOutputMedia(item, runId, paths, comfyuiBaseUrl, cache, warnings, signal)));
  if (!value || typeof value !== "object") return value;
  const media = value as Record<string, JsonValue>;
  // A reused result already points at a durable ancestor. The upstream may now reuse its filename.
  if (typeof media.url === "string" && /^\/api\/(?:workflows|v1)\/runs\/[a-f0-9-]{36}\/media\//i.test(media.url)) return value;
  if (typeof media.filename === "string" && (typeof media.url === "string" || typeof media.type === "string")) {
    const subfolder = typeof media.subfolder === "string" ? media.subfolder : "";
    const type = typeof media.type === "string" ? media.type : "output";
    const cacheKey = media.filename + "\n" + subfolder + "\n" + type;
    const existing = cache.get(cacheKey);
    if (existing) return existing;
    if (signal?.aborted) return value;
    const state = archiveState(cache);
    const pending = state.pending.get(cacheKey);
    if (pending) return pending;
    const operation = state.queue.run("output-archive", async () => {
      let temporary: string | undefined;
      let body: WebStream<Uint8Array> | undefined;
      try {
        const timeout = AbortSignal.timeout(120000);
        const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const query = new URLSearchParams({ filename: String(media.filename), subfolder, type });
        const response = await fetch(comfyuiBaseUrl.replace(/\/+$/, "") + "/view?" + query, { signal: downloadSignal });
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("ComfyUI 媒体返回 " + response.status);
        }
        body = response.body as unknown as WebStream<Uint8Array>;
        const encoding = response.headers.get("content-encoding");
        const expectedLength = encoding && encoding !== "identity" ? null : response.headers.get("content-length");
        if (expectedLength !== null && Number(expectedLength) > maxArchivedMediaBytes) {
          await response.body.cancel().catch(() => undefined);
          throw new Error("输出媒体超过 2GB 归档限制");
        }
        const extension = path.extname(path.basename(String(media.filename))).replace(/[^.A-Za-z0-9]/g, "").slice(0, 12) || mediaContentTypeExtension(response.headers.get("content-type"));
        const base = path.basename(String(media.filename), path.extname(String(media.filename))).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "output";
        const suffix = createHash("sha1").update(cacheKey).digest("hex").slice(0, 8);
        const filename = base + "-" + suffix + extension;
        const directory = path.join(paths.directory, "outputs", "media");
        await mkdir(directory, { recursive: true });
        temporary = path.join(directory, "." + filename + "." + randomUUID() + ".tmp");
        let received = 0;
        const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          callback(received > maxArchivedMediaBytes ? new Error("输出媒体超过 2GB 归档限制") : null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body as unknown as WebStream<Uint8Array>), limit, createWriteStream(temporary, { flags: "wx" }), { signal: downloadSignal });
        if (!received) throw new Error("输出媒体为空，未生成有效归档");
        if (expectedLength !== null && Number(expectedLength) !== received) throw new Error("输出媒体下载不完整");
        downloadSignal.throwIfAborted();
        // The public path is published only after a complete stream; a failed retry cannot truncate it.
        await rename(temporary, path.join(directory, filename));
        const archived: JsonValue = { ...media, file: "outputs/media/" + filename, url: "/api/workflows/runs/" + runId + "/media/" + encodeURIComponent(filename) };
        cache.set(cacheKey, archived);
        return archived;
      } finally {
        if (body && !body.locked) await body.cancel().catch(() => undefined);
        if (temporary) await unlink(temporary).catch(() => undefined);
      }
    }, signal, 2).catch(error => {
      if (!signal?.aborted) warnings.push(String(media.filename) + ": " + (error instanceof Error ? error.message : "归档媒体失败"));
      return value;
    });
    state.pending.set(cacheKey, operation);
    try { return await operation; }
    finally { if (state.pending.get(cacheKey) === operation) state.pending.delete(cacheKey); }
  }
  const entries = await Promise.all(Object.entries(media).map(async ([key, item]) => [key, await archiveOutputMedia(item, runId, paths, comfyuiBaseUrl, cache, warnings, signal)] as const));
  return Object.fromEntries(entries);
}

export function isRunId(value: string) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

export function runStatus(value: unknown): RunStatus {
  return ["queued", "running", "cancelling", "completed", "cancelled", "stale", "waiting"].includes(String(value)) ? value as RunStatus : "failed";
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
    ...(typeof (output?.rerunFromRunId ?? runtime.rerunFromRunId) === "string" ? { rerunFromRunId: output?.rerunFromRunId ?? runtime.rerunFromRunId } : {}),
    ...(asRecord(output?.rerunPlan ?? runtime.rerunPlan) ? { rerunPlan: output?.rerunPlan ?? runtime.rerunPlan, rerunRequest: output?.rerunRequest ?? runtime.rerunRequest } : {}),
    inputValues,
    ...(workflow ? { workflow } : {}),
    artifacts: artifactPublicPaths(paths),
  };
}

