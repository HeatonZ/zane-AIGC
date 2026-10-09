/** Isolated sandbox worker for the core.code step. Apart from Node built-ins it
 * imports nothing, so tsx (dev) and the compiled backend can both spawn it
 * directly. It is single-use: the main thread terminates it after one reply. */
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";

export interface CodeSandboxJob {
  /** Async function body entered once; `inputs` is inlined as a JSON literal. */
  source: string;
  timeoutMs: number;
  maxLogLines: number;
  maxLogBytes: number;
  maxOutputBytes: number;
}
export interface CodeSandboxReply {
  ok: boolean;
  value?: unknown;
  error?: string;
  code?: string;
  logs: string[];
}

const job = workerData as CodeSandboxJob;
const logs: string[] = [];
let loggedBytes = 0;
let clipped = false;

function record(text: string) {
  if (clipped) return;
  if (logs.length >= job.maxLogLines || loggedBytes + text.length + 1 > job.maxLogBytes) { clipped = true; logs.push("…代码日志已截断"); return; }
  logs.push(text);
  loggedBytes += text.length + 1;
}
function display(value: unknown) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}
const channel = (...values: unknown[]) => record(values.map(display).join(" ").slice(0, 2000));
const sandbox = { console: { log: channel, info: channel, warn: channel, error: channel, debug: channel } };

/** Sandbox errors come from another realm: instanceof fails, so read message/code defensively. */
function describe(error: unknown) {
  const message = (error as { message?: unknown } | undefined)?.message;
  if (typeof message === "string" && message) return message;
  return String(error);
}
function timedOut(error: unknown) {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || /timed out/i.test(describe(error));
}
function finish(reply: CodeSandboxReply) {
  parentPort?.postMessage(reply);
  // The single-use worker exits naturally once the reply is flushed; the main
  // thread still terminates it so stray microtask loops cannot linger.
  parentPort?.unref();
}

// Unhandled rejections stay debug context in the log; the explicit return or
// throw of the entry function decides the execution result.
process.on("unhandledRejection", (error) => record("未处理的 Promise 拒绝：" + describe(error)));

(async () => {
  let script: vm.Script;
  try { script = new vm.Script(job.source, { filename: "core.code" }); }
  catch (error) { finish({ ok: false, code: "CODE_SYNTAX_ERROR", error: "代码语法错误：" + describe(error), logs }); return; }
  let result: unknown;
  try { result = await script.runInNewContext(sandbox, { timeout: job.timeoutMs }); }
  catch (error) {
    finish(timedOut(error) ? { ok: false, code: "CODE_TIMEOUT", error: "代码执行超时（" + job.timeoutMs + " 毫秒）", logs } : { ok: false, code: "CODE_EXECUTION_FAILED", error: describe(error), logs });
    return;
  }
  let serialized: string | undefined;
  try { serialized = JSON.stringify(result); }
  catch { finish({ ok: false, code: "CODE_OUTPUT_NOT_SERIALIZABLE", error: "代码返回值不是可序列化的 JSON（undefined、函数、BigInt 或循环引用）", logs }); return; }
  if (serialized === undefined) { finish({ ok: false, code: "CODE_OUTPUT_NOT_SERIALIZABLE", error: "代码必须返回结果对象，不能返回 undefined", logs }); return; }
  if (serialized.length > job.maxOutputBytes) { finish({ ok: false, code: "CODE_OUTPUT_TOO_LARGE", error: "代码返回值超过 " + Math.floor(job.maxOutputBytes / 1024) + " KB", logs }); return; }
  finish({ ok: true, value: JSON.parse(serialized) as unknown, logs });
})();