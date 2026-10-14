import { existsSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import vm from "node:vm";
import { HttpError } from "../errors.js";
import type { JsonValue, RunStep } from "../domain/types.js";
import { asRecord, resolveStepInputs } from "../domain/workflowValues.js";
import { parseLocalExportConfig, parseLocalFileAccessConfig, pickExportPlanSource, type LocalFileAccessConfig, type LocalExportConfig } from "../domain/localExport.js";
import { executeLocalExport } from "./localExport.js";
import { listLocalDirectory, readLocalText, statLocalPath } from "./localFileAccess.js";
import { createRuntimeMediaValue, isRuntimeMediaValue, type RuntimeMediaItem } from "../runtimeValue.js";
import type { StepExecutionContext } from "./workflowExecutor.js";
import type { CodeSandboxAttach, CodeSandboxJob, CodeSandboxReply } from "./codeSandboxWorker.js";

/** Machine contract for the core.code step; mirrored into the AI OpenAPI as x-code-step. */
export const CODE_STEP_CONTRACT = {
  version: "1",
  capabilityId: "core.code",
  language: "javascript",
  entry: "async function body evaluated once; return an object keyed by the declared output ports",
  sandbox: {
    isolation: "worker_thread + node:vm over a contextified null-prototype global; one single-use worker per execution; string code generation disabled inside the context",
    sharedGlobals: "none; only ECMAScript built-ins and a console defined inside the sandbox realm",
    nodeBuiltins: false, network: false, filesystem: false, process: false, environment: false, timers: false, webAssembly: "engine-level only; bounded by timeout and memory", mediatedFileAccess: "filesystem:false stays literal: the sandbox holds no fs capability. Optional read-only directory listing and metadata are host-mediated data requests (see fileAccess), and optional local export is a host-side write of a plan; neither hands a host object to user code",
  },
  code: { maximumBytes: 65536, inputAccess: "inputs keyed by the declared input port keys; media inputs enter as a read-only [{filename}] projection with no path, URL or bytes", inputMaximumBytes: 4194304, output: "must return an object containing every declared output port with the declared type; extra keys are rejected", mediaOutputs: { ports: "image_list/video_list/audio_list", value: "ordered array of file names (strings) or {filename} objects; duplicates are allowed and order is preserved", scope: "only media already present on this step's declared input ports, resolved to the same archived items of the current run; the sandbox never creates, moves, renames or exposes media bytes, paths or URLs", mismatch: "an unknown file name or a media kind that does not match the declared port is INVALID_CODE_OUTPUT" } },
  limits: { timeoutMs: { default: 5000, minimum: 200, maximum: 60000 }, memoryMb: 128, outputMaximumBytes: 1048576, logs: { maximumLines: 200, maximumBytes: 32768 } },
  determinism: "pure data transformation expected; Date/Math.random are available but recorded results stay the authority",
  localExport: {
    enable: "capabilityConfig.localExport = { enabled: true, planKey?: string, onConflict?: overwrite|skip|fail }",
    mediated: "the sandbox still has no filesystem access: user code returns a { items: [{ source, target }] } plan, and the host performs every write after the step",
    root: "only inside the admin-configured local-export setting root; unset root makes the step fail with LOCAL_EXPORT_DISABLED",
    containment: "each target is resolved and must stay inside the root, otherwise LOCAL_EXPORT_OUTSIDE_ROOT; .. escapes are rejected, not normalized away",
    target: "absolute path or path relative to the root; must end with a supported media extension",
    source: "a media file name that exists on this step's declared input ports; bytes come from this run's or an authorized source run's archive, and for media generated earlier in the same run that is not archived yet (archiving happens at the end of the workflow) the host fetches it from the configured comfyuiBaseUrl. Arbitrary external URLs and other unarchived media still fail",
    onConflict: "overwrite (default, atomic temp file + rename), skip (keep existing bytes) or fail",
    output: "when the step declares a local_export output port, the written/skipped items are recorded there",
  },
  fileAccess: {
    enable: "capabilityConfig.fileAccess = { enabled: true }",
    mediated: "the sandbox still has no filesystem access of its own: it gets a read-only zane.fs facade whose list/stat/readText calls are answered by the host outside the sandbox; no host function object ever enters the sandbox realm",
    root: "the same admin-configured local-export setting root; unset root makes a file call fail with FILE_ACCESS_DISABLED",
    containment: "each requested path is resolved and must stay inside the root, otherwise FILE_OUTSIDE_ROOT; .. escapes are rejected, not normalized away",
    symlinks: "an existing path whose real path leaves the root is rejected, so symlinks cannot read outside the authorized directory",
    api: "globalThis.zane.fs.list(path) -> [{ name, path, isFile, isDir, isSymbolicLink, size }] sorted by name; zane.fs.stat(path) -> { path, exists, isFile, isDir, isSymbolicLink, size } with exists:false instead of throwing when missing; zane.fs.readText(path) -> the file's UTF-8 text (for picking one line out of an action/prompt list), FILE_NOT_FOUND when missing and FILE_TOO_LARGE above the byte cap",
    returnedPaths: "paths returned by list/stat are absolute paths inside the root, so existing files there can be handed to downstream steps (for example a ComfyUI upload); they never expose anything outside the root",
    readOnly: "no write, create, delete or rename; directory listings, metadata, and explicitly requested text via readText (never executed or parsed, never written back)",
    limits: "at most 500 directory entries per list call, otherwise FILE_LIST_TOO_LARGE; at most 1 MB per readText call, otherwise FILE_TOO_LARGE; paths at most 1024 characters",
  },
  errors: ["INVALID_CODE_CONFIG", "INVALID_CODE_INPUT", "INVALID_CODE_OUTPUT", "CODE_SYNTAX_ERROR", "CODE_TIMEOUT", "CODE_OUTPUT_NOT_SERIALIZABLE", "CODE_OUTPUT_TOO_LARGE", "CODE_EXECUTION_FAILED", "LOCAL_EXPORT_DISABLED", "LOCAL_EXPORT_OUTSIDE_ROOT", "LOCAL_EXPORT_TOO_LARGE", "FILE_ACCESS_DISABLED", "FILE_OUTSIDE_ROOT", "FILE_NOT_FOUND", "FILE_LIST_TOO_LARGE", "FILE_TOO_LARGE", "FILE_ACCESS_FAILED"],
  sideEffects: { prepare: "none", publish: "none", execute: "local CPU and memory only; no external service, no provider cost; with localExport enabled the host also copies declared input media into the admin-authorized root directory, and with fileAccess enabled it reads directory listings, metadata and explicitly requested text inside that same root", automaticRetries: false, cancellable: true },
} as const;

const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 200;
const MAX_TIMEOUT_MS = 60000;
const MAX_CODE_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MEMORY_LIMIT_MB = 128;
const YOUNG_MEMORY_LIMIT_MB = 32;
const WORKER_SLACK_MS = 2000;
const MAX_LOG_LINES = 200;
const MAX_LOG_BYTES = 32 * 1024;
const PORT_TYPES = ["text", "number", "boolean", "json", "image_list", "video_list", "audio_list"];
/** Media output ports select and order media the step already received; code never produces media bytes. */
const MEDIA_PORT_KINDS = { image_list: "image", video_list: "video", audio_list: "audio" } as const;
const MEDIA_KIND_LABELS = { image: "图片", video: "视频", audio: "音频" } as const;
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const invalidConfig = (message: string): never => { throw new HttpError(400, message, "INVALID_CODE_CONFIG"); };

/** Wrap user code once so a top-level `return` is valid and inputs cross the realm boundary as a JSON literal. */
function wrapCode(code: string, inputsLiteral: string) {
  return "(async function () {\n  const inputs = Object.assign(Object.create(null), JSON.parse(" + JSON.stringify(inputsLiteral) + "));\n" + code + "\n})()";
}

export function codeTimeoutMs(step: RunStep): number {
  const value = asRecord(step.capabilityConfig)?.timeoutMs;
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS) return value;
  return invalidConfig("执行超时必须是 " + MIN_TIMEOUT_MS + "–" + MAX_TIMEOUT_MS + " 毫秒的整数");
}

/** Authoring-time validation; runs on draft validation, publish and run preparation. */
export function validateCodeStep(step: RunStep) {
  const code = typeof asRecord(step.capabilityConfig)?.code === "string" && String(asRecord(step.capabilityConfig)?.code).trim()
    ? String(asRecord(step.capabilityConfig)?.code)
    : invalidConfig("自定义代码不能为空");
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) invalidConfig("自定义代码不能超过 " + MAX_CODE_BYTES / 1024 + " KB");
  codeTimeoutMs(step);
  const inputKeys = new Set<string>();
  for (const input of step.inputs ?? []) {
    if (!identifier.test(input.key)) invalidConfig("输入端口名必须是合法标识符：" + (input.key || "（空）"));
    if (inputKeys.has(input.key)) invalidConfig("输入端口重复：" + input.key);
    inputKeys.add(input.key);
  }
  const outputs = step.outputs ?? [];
  if (!outputs.length) invalidConfig("自定义代码至少需要一个输出端口");
  const outputKeys = new Set<string>();
  for (const output of outputs) {
    if (!identifier.test(output.key)) invalidConfig("输出端口名必须是合法标识符：" + (output.key || "（空）"));
    if (outputKeys.has(output.key)) invalidConfig("输出端口重复：" + output.key);
    outputKeys.add(output.key);
    if (!PORT_TYPES.includes(output.type)) invalidConfig("输出端口 " + output.key + " 的类型 " + output.type + " 不受支持；只支持 text/number/boolean/json 与 image_list/video_list/audio_list（媒体端口按 filename 选择本步骤输入中的媒体）");
  }
  try { new vm.Script(wrapCode(code, "{}"), { filename: "core.code" }); }
  catch (error) { invalidConfig("代码语法错误：" + (error instanceof Error ? error.message : String(error))); }
  // 本地导出配置在授权/发布前就校验完，避免运行到一半才发现端口或策略写错。
  const exportConfig = parseLocalExportConfig(step.capabilityConfig);
  if (exportConfig.enabled) {
    pickExportPlanSource(step, exportConfig.planKey);
    const output = (step.outputs ?? []).find((item) => item.key === "local_export");
    if (output && output.type !== "json") invalidConfig("local_export 输出端口必须是 json 类型");
  }
  // 本地文件读取同样在预检阶段校验配置形状；根目录是否配置属于运行期授权，提交执行时才判定。
  parseLocalFileAccessConfig(step.capabilityConfig);
}

/** Media lists enter the sandbox as a read-only JSON projection: only count, order and
 * file name are visible. No path, URL, preview or bytes are ever exposed. */
function mediaProjectionItem(item: RuntimeMediaItem): JsonValue {
  return { filename: typeof item.filename === "string" && item.filename ? item.filename : "" };
}
/** Iterative deep transform so deeply nested or large inputs cannot overflow the stack. */
function projectRuntimeMedia(value: JsonValue): JsonValue {
  const root: { value: JsonValue } = { value };
  const pending: Array<{ parent: Record<string, unknown> | unknown[]; key: string | number; source: unknown }> = [{ parent: root, key: "value", source: value }];
  while (pending.length) {
    const frame = pending.pop()!;
    const source = frame.source;
    if (isRuntimeMediaValue(source)) { (frame.parent as Record<string | number, unknown>)[frame.key] = source.items.map(mediaProjectionItem); continue; }
    if (Array.isArray(source)) {
      const next: unknown[] = [...source];
      (frame.parent as Record<string | number, unknown>)[frame.key] = next;
      for (let index = 0; index < next.length; index += 1) pending.push({ parent: next, key: index, source: next[index] });
      continue;
    }
    const record = asRecord(source);
    if (!record) continue;
    const next: Record<string, unknown> = { ...record };
    (frame.parent as Record<string | number, unknown>)[frame.key] = next;
    for (const [key, item] of Object.entries(record)) pending.push({ parent: next, key, source: item });
  }
  return root.value;
}

function mediaPortKind(type: string) {
  return MEDIA_PORT_KINDS[type as keyof typeof MEDIA_PORT_KINDS];
}
/** File name the sandbox can see for a media reference returned by user code: a string or {filename}. */
function referencedMediaFilename(item: unknown): string | undefined {
  if (typeof item === "string") return item.trim() || undefined;
  const filename = asRecord(item)?.filename;
  return typeof filename === "string" && filename.trim() ? filename.trim() : undefined;
}
/** Every media item reachable from the resolved step inputs, keyed by the file name visible in the sandbox. */
function collectInputMedia(value: JsonValue, into: Map<string, RuntimeMediaItem>) {
  const pending: unknown[] = [value];
  while (pending.length) {
    const source = pending.pop();
    if (isRuntimeMediaValue(source)) {
      for (const item of source.items) if (typeof item.filename === "string" && item.filename && !into.has(item.filename)) into.set(item.filename, item);
      continue;
    }
    if (Array.isArray(source)) { pending.push(...source); continue; }
    const record = asRecord(source);
    if (record) pending.push(...Object.values(record));
  }
}
/** A media output port can only pick and order media the step already received; no paths, URLs or new files. */
function mediaOutputError(type: string, value: unknown, media: Map<string, RuntimeMediaItem>): string | undefined {
  const kind = mediaPortKind(type);
  if (!kind) return "不是受支持的媒体输出端口";
  if (!Array.isArray(value)) return "必须是媒体文件名数组（字符串或 {filename} 对象）";
  for (const item of value) {
    const filename = referencedMediaFilename(item);
    if (!filename) return "的每一项都必须是媒体文件名（字符串或 {filename} 对象），不接受空值、路径或 URL";
    const found = media.get(filename);
    if (!found) return "引用了本步骤输入中不存在的媒体 " + filename + "；只能按 filename 选择声明输入端口里的媒体";
    if (found.kind !== kind) return "引用的 " + filename + " 是" + MEDIA_KIND_LABELS[found.kind] + "，与声明的 " + type + "（" + MEDIA_KIND_LABELS[kind] + "）不一致";
  }
  return undefined;
}
function portTypeError(type: string, value: unknown) {
  if (type === "text") return typeof value === "string" ? undefined : "必须是文本";
  if (type === "number") return typeof value === "number" && Number.isFinite(value) ? undefined : "必须是有限数字";
  if (type === "boolean") return typeof value === "boolean" ? undefined : "必须是布尔值";
  return undefined;
}

/** 宿主写入的输出端口：本地导出报告由宿主在沙箱之外填写，因此用户代码不必（也不应）返回它。 */
const LOCAL_EXPORT_REPORT_KEY = "local_export";

function validateCodeOutputs(step: RunStep, value: unknown, media: Map<string, RuntimeMediaItem>, hostFilled: ReadonlySet<string> = new Set()): Record<string, JsonValue> {
  const record = asRecord(value);
  if (!record) throw new HttpError(400, "自定义代码必须返回包含各输出端口的对象", "INVALID_CODE_OUTPUT");
  const outputs = step.outputs ?? [];
  const extra = Object.keys(record).filter((key) => !outputs.some((output) => output.key === key));
  if (extra.length) throw new HttpError(400, "自定义代码返回了未声明的输出：" + extra.join("、") + "；只返回已声明的输出端口", "INVALID_CODE_OUTPUT");
  const result: Record<string, JsonValue> = {};
  for (const output of outputs) {
    // 宿主负责填写的端口由调用方补齐；用户代码省略它不算缺输出。
    if (hostFilled.has(output.key)) continue;
    if (!Object.prototype.hasOwnProperty.call(record, output.key)) throw new HttpError(400, "自定义代码缺少输出：" + output.key, "INVALID_CODE_OUTPUT");
    const kind = mediaPortKind(output.type);
    if (kind) {
      const mediaError = mediaOutputError(output.type, record[output.key], media);
      if (mediaError) throw new HttpError(400, "输出 " + output.key + mediaError + "（声明为 " + output.type + "）", "INVALID_CODE_OUTPUT");
      const items = (record[output.key] as unknown[]).map((item) => media.get(referencedMediaFilename(item)!)!);
      result[output.key] = createRuntimeMediaValue(kind, items);
      continue;
    }
    const error = portTypeError(output.type, record[output.key]);
    if (error) throw new HttpError(400, "输出 " + output.key + error + "（声明为 " + output.type + "）", "INVALID_CODE_OUTPUT");
    result[output.key] = record[output.key] as JsonValue;
  }
  return result;
}

let cachedWorkerUrl: URL | undefined;
/** Dev runs .ts sources under tsx; the compiled backend loads the built .js worker. */
function resolveWorkerUrl() {
  if (!cachedWorkerUrl) {
    const candidates = [new URL("./codeSandboxWorker.js", import.meta.url), new URL("./codeSandboxWorker.ts", import.meta.url)];
    cachedWorkerUrl = candidates.find((candidate) => existsSync(fileURLToPath(candidate))) ?? candidates[0]!;
  }
  return cachedWorkerUrl;
}

export function createCodeSandboxWorker(job: CodeSandboxJob) {
  const options: WorkerOptions = {
    workerData: job,
    name: "zane-code-step",
    resourceLimits: { maxOldGenerationSizeMb: MEMORY_LIMIT_MB, maxYoungGenerationSizeMb: YOUNG_MEMORY_LIMIT_MB },
  };
  return new Worker(resolveWorkerUrl(), options);
}

/** 进程级并发预算：每 worker 约 128MB 堆，for_each×多任务时不能无上限 spawn。
 *  不池化 worker：job 经 workerData 一次性注入、执行后退出，这是隔离保证的一部分
 *  （每次执行都是全新 isolate 与堆）；冷启动毫秒级，相对模型调用可忽略。 */
const SANDBOX_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.ZANE_CODE_SANDBOX_CONCURRENCY) || Math.max(1, (os.availableParallelism?.() ?? 4) - 1)));
let sandboxActive = 0;
const sandboxWaiters: Array<() => void> = [];
async function acquireSandboxSlot(signal: AbortSignal) {
  if (sandboxActive >= SANDBOX_CONCURRENCY) {
    await new Promise<void>((resolve, reject) => {
      const waiter = () => { signal.removeEventListener("abort", abort); resolve(); };
      const abort = () => { const index = sandboxWaiters.indexOf(waiter); if (index >= 0) sandboxWaiters.splice(index, 1); reject(signal.reason ?? new Error("已取消")); };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      sandboxWaiters.push(waiter);
    });
  }
  sandboxActive += 1;
  return () => {
    sandboxActive -= 1;
    sandboxWaiters.shift()?.();
  };
}

export async function executeCodeStep(context: StepExecutionContext): Promise<Record<string, JsonValue>> {
  const step = context.step;
  validateCodeStep(step);
  const exportConfig = parseLocalExportConfig(step.capabilityConfig);
  const fileConfig = parseLocalFileAccessConfig(step.capabilityConfig);
  const timeoutMs = codeTimeoutMs(step);
  const resolved = resolveStepInputs(step, context.inputValues, context.stepValues) as Record<string, JsonValue>;
  const inputMedia = new Map<string, RuntimeMediaItem>();
  collectInputMedia(Object.values(resolved), inputMedia);
  const inputs = Object.fromEntries(Object.entries(resolved).map(([key, value]) => [key, projectRuntimeMedia(value)]));
  const inputsLiteral = JSON.stringify(inputs);
  if (Buffer.byteLength(inputsLiteral, "utf8") > MAX_INPUT_BYTES) throw new HttpError(400, "代码输入序列化后超过 " + MAX_INPUT_BYTES / 1024 / 1024 + " MB，请先用基础步骤裁剪数据", "INVALID_CODE_INPUT");
  if (context.signal.aborted) throw context.signal.reason ?? new Error("已取消");
  const releaseSlot = await acquireSandboxSlot(context.signal);
  // local_export 由宿主填写：用户代码只负责返回计划，不需要（也不能）伪造导出报告。
  const hostFilled = new Set(exportConfig.enabled && (step.outputs ?? []).some((output) => output.key === LOCAL_EXPORT_REPORT_KEY) ? [LOCAL_EXPORT_REPORT_KEY] : []);
  let outputs: Record<string, JsonValue>;
  try {
    outputs = await runCodeStepInSandbox(context, step, inputsLiteral, inputMedia, timeoutMs, hostFilled, fileConfig);
  } finally {
    releaseSlot();
  }
  // 本地导出在沙箱之外由宿主完成：用户代码只提交 {source,target} 计划，拿不到写权限。
  // 计划无效或目标越界都会让整个步骤失败，绝不静默跳过。
  if (exportConfig.enabled) await runLocalExport(context, step, exportConfig, outputs, inputMedia);
  return outputs;
}

/** 宿主侧落盘：计划来自用户代码但写入在这里完成，且只写入管理员配置的根目录内部。
 *  导出结果写入输出端口 `local_export`（若已声明）供运行记录核对；不改变用户声明的媒体输出。 */
async function runLocalExport(context: StepExecutionContext, step: RunStep, config: LocalExportConfig, outputs: Record<string, JsonValue>, inputMedia: Map<string, RuntimeMediaItem>) {
  const planKey = pickExportPlanSource(step, config.planKey);
  const result = await executeLocalExport({
    plan: outputs[planKey], media: inputMedia, root: context.localExportRoot ?? "", onConflict: config.onConflict,
    projectDirectory: context.settings.projectDirectory, runId: context.runId,
    allowedRunIds: context.localExportRunIds, comfyuiBaseUrl: context.settings.comfyuiBaseUrl, signal: context.signal,
  });
  if ((step.outputs ?? []).some((output) => output.key === "local_export")) outputs.local_export = result as unknown as JsonValue;
  await context.warn?.("本地导出已写入 " + result.written + " 个文件（跳过 " + result.skipped + " 个）到受控根目录");
}

/** Atomics.waitAsync 是 ES2024 才进 lib 的 API，而本项目 lib 仍是 ES2022（Node 运行时早已支持）。
 *  这里只按实际用法窄化声明，避免为了一个调用把整个工程的 lib 目标抬高。 */
interface AtomicsWaitAsync {
  waitAsync(typedArray: Int32Array, index: number, value: number, timeout?: number): { async: boolean; value: Promise<string> };
}
const atomics = Atomics as unknown as AtomicsWaitAsync;

/** 宿主侧文件通道：应答沙箱发出的 list/stat 数据请求，真正的文件系统调用只发生在宿主。
 *
 *  沙箱用 Atomics.wait 阻塞等待，这里用 Atomics.waitAsync 在自己的线程上应答；两侧只交换 JSON
 *  文本，因此没有任何宿主函数对象跨进沙箱 realm（见 codeSandboxWorker 的逃逸不变量）。
 *  停止服务不会挂死沙箱：等待有分片上限，且 worker 在步骤结束/取消时会被 terminate。 */
function serveFileBridge(control: SharedArrayBuffer, data: SharedArrayBuffer, root: string, signal: AbortSignal) {
  const ctrl = new Int32Array(control);
  const bytes = new Uint8Array(data);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let stopped = false;
  const stop = () => { stopped = true; };
  signal.addEventListener("abort", stop, { once: true });
  void (async () => {
    while (!stopped) {
      let current = Atomics.load(ctrl, 0);
      while (current !== 1 && !stopped) {
        const outcome = atomics.waitAsync(ctrl, 0, current, 200);
        if (outcome.async) await outcome.value;
        current = Atomics.load(ctrl, 0);
      }
      if (stopped) break;
      const length = Atomics.load(ctrl, 1);
      let payload: string;
      let state: number;
      try {
        const request = JSON.parse(decoder.decode(bytes.subarray(0, Math.max(0, Math.min(length, bytes.length))))) as { op?: unknown; path?: unknown };
        const op = request?.op;
        if (op !== "list" && op !== "stat" && op !== "readText") throw new HttpError(400, "不支持的文件访问操作：" + String(op), "FILE_ACCESS_FAILED");
        const value = op === "list" ? await listLocalDirectory(root, request.path)
          : op === "stat" ? await statLocalPath(root, request.path)
            : await readLocalText(root, request.path);
        payload = JSON.stringify({ ok: true, value });
        state = 2;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof HttpError ? error.code : "FILE_ACCESS_FAILED";
        payload = JSON.stringify({ ok: false, error: message, code });
        state = 3;
      }
      const encoded = encoder.encode(payload);
      if (encoded.length > bytes.length) {
        const fallback = encoder.encode(JSON.stringify({ ok: false, error: "文件访问结果超过单次 " + Math.floor(bytes.length / 1024) + " KB 上限，请缩小到更具体的子目录", code: "FILE_ACCESS_FAILED" }));
        bytes.set(fallback, 0);
        Atomics.store(ctrl, 2, fallback.length);
        Atomics.store(ctrl, 0, 3);
      } else {
        bytes.set(encoded, 0);
        Atomics.store(ctrl, 2, encoded.length);
        Atomics.store(ctrl, 0, state);
      }
      Atomics.notify(ctrl, 0);
    }
  })().catch(() => undefined);
  return () => signal.removeEventListener("abort", stop);
}

async function runCodeStepInSandbox(context: StepExecutionContext, step: StepExecutionContext["step"], inputsLiteral: string, inputMedia: Map<string, RuntimeMediaItem>, timeoutMs: number, hostFilled: ReadonlySet<string>, fileConfig: LocalFileAccessConfig): Promise<Record<string, JsonValue>> {
  let worker: Worker;
  try {
    worker = createCodeSandboxWorker({ source: wrapCode(String(asRecord(step.capabilityConfig)?.code ?? ""), inputsLiteral), timeoutMs, maxLogLines: MAX_LOG_LINES, maxLogBytes: MAX_LOG_BYTES, maxOutputBytes: MAX_OUTPUT_BYTES, ...(fileConfig.enabled ? { fileAccess: true } : {}) });
  } catch (error) {
    throw new HttpError(500, "代码沙箱启动失败：" + (error instanceof Error ? error.message : String(error)), "CODE_EXECUTION_FAILED");
  }
  let settled = false;
  let failure: unknown;
  let timer: NodeJS.Timeout | undefined;
  let stopBridge: (() => void) | undefined;
  let settleFailure: (error: unknown) => void = () => {};
  const onAbort = () => settleFailure(context.signal.reason ?? new Error("运行已取消"));
  context.signal.addEventListener("abort", onAbort, { once: true });
  const onMessage = (message: CodeSandboxAttach | CodeSandboxReply) => {
    // 沙箱先建立文件通道（它自己创建 SAB，宿主只拿引用），随后才是执行结果。
    if ((message as CodeSandboxAttach).kind === "attach") {
      const attach = message as CodeSandboxAttach;
      if (!stopBridge) stopBridge = serveFileBridge(attach.control, attach.data, context.localExportRoot ?? "", context.signal);
      return;
    }
    if (settled) return;
    settled = true;
    resolve(message as CodeSandboxReply);
  };
  let resolve: (reply: CodeSandboxReply) => void = () => {};
  const reply = await new Promise<CodeSandboxReply>((settle) => {
    resolve = settle;
    settleFailure = (error: unknown) => { if (settled) return; settled = true; failure = error; settle({ kind: "done", ok: false, error: "", code: "", logs: [] }); };
    timer = setTimeout(() => settleFailure(new HttpError(504, "代码执行超过 " + timeoutMs + " 毫秒已被强制终止", "CODE_TIMEOUT")), timeoutMs + WORKER_SLACK_MS);
    worker.on("message", onMessage as (value: unknown) => void);
    worker.once("error", (error) => settleFailure(new HttpError(500, "代码沙箱进程异常：" + (error instanceof Error ? error.message : String(error)), "CODE_EXECUTION_FAILED")));
    worker.once("exit", (exitCode) => settleFailure(new HttpError(500, exitCode === 0 ? "自定义代码没有返回结果：代码在等待一个永远不会完成的 Promise；沙箱内没有定时器和外部事件可以唤醒它" : "代码沙箱异常退出（退出码 " + String(exitCode) + "），可能超出 " + MEMORY_LIMIT_MB + "MB 内存限制", "CODE_EXECUTION_FAILED")));
  }).finally(() => {
    if (timer) clearTimeout(timer);
    stopBridge?.();
    worker.off("message", onMessage as (value: unknown) => void);
    context.signal.removeEventListener("abort", onAbort);
  });
  await worker.terminate().catch(() => undefined);
  if (failure) throw failure;
  if (reply.ok) return validateCodeOutputs(step, reply.value, inputMedia, hostFilled);
  const trail = reply.logs?.length ? "；代码日志尾部：" + reply.logs.slice(-5).join(" | ") : "";
  if (reply.code === "CODE_TIMEOUT") throw new HttpError(504, reply.error + trail, "CODE_TIMEOUT");
  if (reply.code === "CODE_OUTPUT_NOT_SERIALIZABLE" || reply.code === "CODE_OUTPUT_TOO_LARGE") throw new HttpError(400, reply.error + trail, "INVALID_CODE_OUTPUT");
  if (reply.code === "FILE_ACCESS_DISABLED" || reply.code === "FILE_OUTSIDE_ROOT" || reply.code === "FILE_NOT_FOUND" || reply.code === "FILE_LIST_TOO_LARGE" || reply.code === "FILE_TOO_LARGE") throw new HttpError(400, reply.error + trail, reply.code);
  throw new HttpError(500, "自定义代码执行失败：" + reply.error + trail, "CODE_EXECUTION_FAILED");
}