import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import vm from "node:vm";
import { HttpError } from "../errors.js";
import type { JsonValue, RunStep } from "../domain/types.js";
import { asRecord, resolveStepInputs } from "../domain/workflowValues.js";
import { isRuntimeMediaValue, type RuntimeMediaItem } from "../runtimeValue.js";
import type { StepExecutionContext } from "./workflowExecutor.js";
import type { CodeSandboxJob, CodeSandboxReply } from "./codeSandboxWorker.js";

/** Machine contract for the core.code step; mirrored into the AI OpenAPI as x-code-step. */
export const CODE_STEP_CONTRACT = {
  version: "1",
  capabilityId: "core.code",
  language: "javascript",
  entry: "async function body evaluated once; return an object keyed by the declared output ports",
  sandbox: {
    isolation: "worker_thread + node:vm; one single-use worker per execution",
    sharedGlobals: "none; only ECMAScript built-ins and console",
    nodeBuiltins: false, network: false, filesystem: false, process: false, environment: false, timers: false, webAssembly: "engine-level only; bounded by timeout and memory",
  },
  code: { maximumBytes: 65536, inputAccess: "inputs keyed by the declared input port keys; media inputs enter as a read-only [{filename}] projection with no path, URL or bytes", inputMaximumBytes: 4194304, output: "must return an object containing every declared output port with the declared type; extra keys are rejected" },
  limits: { timeoutMs: { default: 5000, minimum: 200, maximum: 60000 }, memoryMb: 128, outputMaximumBytes: 1048576, logs: { maximumLines: 200, maximumBytes: 32768 } },
  determinism: "pure data transformation expected; Date/Math.random are available but recorded results stay the authority",
  errors: ["INVALID_CODE_CONFIG", "INVALID_CODE_INPUT", "INVALID_CODE_OUTPUT", "CODE_SYNTAX_ERROR", "CODE_TIMEOUT", "CODE_OUTPUT_NOT_SERIALIZABLE", "CODE_OUTPUT_TOO_LARGE", "CODE_EXECUTION_FAILED"],
  sideEffects: { prepare: "none", publish: "none", execute: "local CPU and memory only; no external service, no provider cost", automaticRetries: false, cancellable: true },
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
const PORT_TYPES = ["text", "number", "boolean", "json"];
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
    if (!PORT_TYPES.includes(output.type)) invalidConfig("输出端口 " + output.key + " 的类型 " + output.type + " 不受支持；只支持 text/number/boolean/json，媒体请改用媒体选择或 ComfyUI 步骤");
  }
  try { new vm.Script(wrapCode(code, "{}"), { filename: "core.code" }); }
  catch (error) { invalidConfig("代码语法错误：" + (error instanceof Error ? error.message : String(error))); }
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

function portTypeError(type: string, value: unknown) {
  if (type === "text") return typeof value === "string" ? undefined : "必须是文本";
  if (type === "number") return typeof value === "number" && Number.isFinite(value) ? undefined : "必须是有限数字";
  if (type === "boolean") return typeof value === "boolean" ? undefined : "必须是布尔值";
  return undefined;
}

function validateCodeOutputs(step: RunStep, value: unknown): Record<string, JsonValue> {
  const record = asRecord(value);
  if (!record) throw new HttpError(400, "自定义代码必须返回包含各输出端口的对象", "INVALID_CODE_OUTPUT");
  const outputs = step.outputs ?? [];
  const extra = Object.keys(record).filter((key) => !outputs.some((output) => output.key === key));
  if (extra.length) throw new HttpError(400, "自定义代码返回了未声明的输出：" + extra.join("、") + "；只返回已声明的输出端口", "INVALID_CODE_OUTPUT");
  const result: Record<string, JsonValue> = {};
  for (const output of outputs) {
    if (!Object.prototype.hasOwnProperty.call(record, output.key)) throw new HttpError(400, "自定义代码缺少输出：" + output.key, "INVALID_CODE_OUTPUT");
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

export async function executeCodeStep(context: StepExecutionContext): Promise<Record<string, JsonValue>> {
  const step = context.step;
  validateCodeStep(step);
  const timeoutMs = codeTimeoutMs(step);
  const resolved = resolveStepInputs(step, context.inputValues, context.stepValues) as Record<string, JsonValue>;
  const inputs = Object.fromEntries(Object.entries(resolved).map(([key, value]) => [key, projectRuntimeMedia(value)]));
  const inputsLiteral = JSON.stringify(inputs);
  if (Buffer.byteLength(inputsLiteral, "utf8") > MAX_INPUT_BYTES) throw new HttpError(400, "代码输入序列化后超过 " + MAX_INPUT_BYTES / 1024 / 1024 + " MB，请先用基础步骤裁剪数据", "INVALID_CODE_INPUT");
  if (context.signal.aborted) throw context.signal.reason ?? new Error("已取消");
  let worker: Worker;
  try {
    worker = createCodeSandboxWorker({ source: wrapCode(String(asRecord(step.capabilityConfig)?.code ?? ""), inputsLiteral), timeoutMs, maxLogLines: MAX_LOG_LINES, maxLogBytes: MAX_LOG_BYTES, maxOutputBytes: MAX_OUTPUT_BYTES });
  } catch (error) {
    throw new HttpError(500, "代码沙箱启动失败：" + (error instanceof Error ? error.message : String(error)), "CODE_EXECUTION_FAILED");
  }
  let settled = false;
  let failure: unknown;
  let timer: NodeJS.Timeout | undefined;
  let settleFailure: (error: unknown) => void = () => {};
  const onAbort = () => settleFailure(context.signal.reason ?? new Error("运行已取消"));
  context.signal.addEventListener("abort", onAbort, { once: true });
  const reply = await new Promise<CodeSandboxReply>((resolve) => {
    settleFailure = (error: unknown) => { if (settled) return; settled = true; failure = error; resolve({ ok: false, error: "", code: "", logs: [] }); };
    timer = setTimeout(() => settleFailure(new HttpError(504, "代码执行超过 " + timeoutMs + " 毫秒已被强制终止", "CODE_TIMEOUT")), timeoutMs + WORKER_SLACK_MS);
    worker.once("message", (message) => { if (settled) return; settled = true; resolve(message as CodeSandboxReply); });
    worker.once("error", (error) => settleFailure(new HttpError(500, "代码沙箱进程异常：" + (error instanceof Error ? error.message : String(error)), "CODE_EXECUTION_FAILED")));
    worker.once("exit", (exitCode) => settleFailure(new HttpError(500, exitCode === 0 ? "自定义代码没有返回结果：代码在等待一个永远不会完成的 Promise；沙箱内没有定时器和外部事件可以唤醒它" : "代码沙箱异常退出（退出码 " + String(exitCode) + "），可能超出 " + MEMORY_LIMIT_MB + "MB 内存限制", "CODE_EXECUTION_FAILED")));
  }).finally(() => {
    if (timer) clearTimeout(timer);
    context.signal.removeEventListener("abort", onAbort);
  });
  await worker.terminate().catch(() => undefined);
  if (failure) throw failure;
  if (reply.ok) return validateCodeOutputs(step, reply.value);
  const trail = reply.logs?.length ? "；代码日志尾部：" + reply.logs.slice(-5).join(" | ") : "";
  if (reply.code === "CODE_TIMEOUT") throw new HttpError(504, reply.error + trail, "CODE_TIMEOUT");
  if (reply.code === "CODE_OUTPUT_NOT_SERIALIZABLE" || reply.code === "CODE_OUTPUT_TOO_LARGE") throw new HttpError(400, reply.error + trail, "INVALID_CODE_OUTPUT");
  throw new HttpError(500, "自定义代码执行失败：" + reply.error + trail, "CODE_EXECUTION_FAILED");
}