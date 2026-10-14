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
  /** 开启受控本地文件读取：沙箱内注入只读的 zane.fs，真实的文件系统调用由宿主在沙箱之外完成。 */
  fileAccess?: boolean;
}
/** 沙箱建立文件通道后先发出的一条控制消息：两个 SharedArrayBuffer 都由沙箱 realm 创建，
 *  宿主只拿到引用；宿主不向沙箱传递任何函数对象，因此逃逸不变量不变。 */
export interface CodeSandboxAttach {
  kind: "attach";
  control: SharedArrayBuffer;
  data: SharedArrayBuffer;
}
export interface CodeSandboxReply {
  kind: "done";
  ok: boolean;
  value?: unknown;
  error?: string;
  code?: string;
  logs: string[];
}

const job = workerData as CodeSandboxJob;

/** 沙箱全局必须是无原型对象，且 console 必须在沙箱 realm 内定义。
 *
 *  两者缺一都会造成进程级逃逸：用户代码可以拿到宿主 process，进而用
 *  `process.binding("spawn_sync")` 执行任意宿主命令、用 `process.binding("fs")`
 *  读写任意文件（已在生产 worker 上实测复现，所以这里是安全边界而不是风格问题）。
 *   - 传入带 Object.prototype 的宿主对象时，`this.constructor.constructor`
 *     就是宿主 realm 的 Function，`Function("return process")()` 即得宿主 process。
 *   - 把宿主函数当 console 交给用户代码时，`console.log.constructor` 同样是宿主
 *     Function，逃逸路径完全一样；因此宿主不向沙箱传递任何函数对象。
 *
 *  日志先写进沙箱内数组，宿主只保留该数组引用、执行结束后统一收敛，
 *  这样连收集日志也不需要向沙箱暴露宿主回调。 */
function createSandbox(maxLogLines: number, maxLogBytes: number) {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  const store = vm.runInContext(
    "(() => {\n" +
      "  const store = [];\n" +
      "  let bytes = 0;\n" +
      "  let clipped = false;\n" +
      "  const display = (value) => {\n" +
      "    if (typeof value === \"string\") return value;\n" +
      "    try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }\n" +
      "  };\n" +
      "  const write = (values) => {\n" +
      "    if (clipped) return;\n" +
      "    const text = values.map(display).join(\" \").slice(0, 2000);\n" +
      "    if (store.length >= " + maxLogLines + " || bytes + text.length + 1 > " + maxLogBytes + ") { clipped = true; store.push(\"…代码日志已截断\"); return; }\n" +
      "    store.push(text);\n" +
      "    bytes += text.length + 1;\n" +
      "  };\n" +
      "  globalThis.console = Object.freeze({ log: (...values) => write(values), info: (...values) => write(values), warn: (...values) => write(values), error: (...values) => write(values), debug: (...values) => write(values) });\n" +
      "  return store;\n" +
      "})()",
    context,
  ) as string[];
  return { context, store };
}

/** 受控本地文件读取通道：全部对象都在沙箱 realm 内创建，宿主只拿到两个 SharedArrayBuffer 的引用。
 *
 *  为什么用 SharedArrayBuffer + Atomics 而不是把宿主函数交给沙箱：宿主一旦把函数对象（哪怕只是
 *  `(path) => ...` 这样的包装）传进 realm，用户代码就能沿 `fn.constructor` 拿到宿主 realm 的
 *  Function，再 `Function("return process")()` 得到宿主 process，进而用 `process.binding("fs")`
 *  绕开全部授权检查。这里反过来：沙箱线程用 `Atomics.wait` 阻塞自己并等待，宿主持有 SAB 引用、
 *  在自己的线程上应答，两侧只交换 JSON 文本，跨边界的永远是数据而不是能力。
 *
 *  同步阻塞不会挂死宿主：宿主侧有整体超时并会 terminate 这个一次性 worker；每次调用的等待也
 *  有分片上限，宿主异常退出时用户代码得到明确失败而不是永久阻塞。 */
function createFileBridge(context: vm.Context, timeoutMs: number) {
  const bootstrap =
    "(() => {\n" +
    "  const CONTROL_BYTES = 64;\n" +
    "  const DATA_BYTES = 1048576;\n" +
    "  const WAIT_SLICE_MS = 250;\n" +
    "  const MAX_SLICES = Math.max(1, Math.ceil(" + timeoutMs + " / WAIT_SLICE_MS));\n" +
    "  const control = new SharedArrayBuffer(CONTROL_BYTES);\n" +
    "  const data = new SharedArrayBuffer(DATA_BYTES);\n" +
    "  const ctrl = new Int32Array(control);\n" +
    "  const bytes = new Uint8Array(data);\n" +
    "  const utf8Encode = (text) => {\n" +
    "    const out = [];\n" +
    "    for (let index = 0; index < text.length; index += 1) {\n" +
    "      let code = text.charCodeAt(index);\n" +
    "      if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {\n" +
    "        const low = text.charCodeAt(index + 1);\n" +
    "        if (low >= 0xdc00 && low <= 0xdfff) { code = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000; index += 1; }\n" +
    "      }\n" +
    "      if (code < 0x80) out.push(code);\n" +
    "      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));\n" +
    "      else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));\n" +
    "      else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));\n" +
    "    }\n" +
    "    return Uint8Array.from(out);\n" +
    "  };\n" +
    "  const utf8Decode = (input) => {\n" +
    "    let text = \"\";\n" +
    "    for (let index = 0; index < input.length;) {\n" +
    "      const first = input[index];\n" +
    "      let code; let size;\n" +
    "      if (first < 0x80) { code = first; size = 1; }\n" +
    "      else if ((first & 0xe0) === 0xc0) { code = first & 31; size = 2; }\n" +
    "      else if ((first & 0xf0) === 0xe0) { code = first & 15; size = 3; }\n" +
    "      else { code = first & 7; size = 4; }\n" +
    "      if (index + size > input.length) break;\n" +
    "      for (let offset = 1; offset < size; offset += 1) code = (code << 6) | (input[index + offset] & 63);\n" +
    "      index += size;\n" +
    "      if (code > 0xffff) { code -= 0x10000; text += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 1023)); }\n" +
    "      else text += String.fromCharCode(code);\n" +
    "    }\n" +
    "    return text;\n" +
    "  };\n" +
    "  const call = (op, path) => {\n" +
    "    if (typeof path !== \"string\" || !path) throw new TypeError(\"zane.fs.\" + op + \" 需要一个非空路径字符串\");\n" +
    "    const request = utf8Encode(JSON.stringify({ op: op, path: path }));\n" +
    "    if (request.length > DATA_BYTES) throw new RangeError(\"文件访问请求过大\");\n" +
    "    bytes.set(request, 0);\n" +
    "    Atomics.store(ctrl, 1, request.length);\n" +
    "    Atomics.store(ctrl, 2, 0);\n" +
    "    Atomics.store(ctrl, 0, 1);\n" +
    "    Atomics.notify(ctrl, 0);\n" +
    "    let slices = 0;\n" +
    "    while (Atomics.load(ctrl, 0) === 1) {\n" +
    "      if (slices >= MAX_SLICES) { const stalled = new Error(\"等待宿主应答本地文件访问超时\"); stalled.code = \"FILE_ACCESS_FAILED\"; throw stalled; }\n" +
    "      slices += 1;\n" +
    "      Atomics.wait(ctrl, 0, 1, WAIT_SLICE_MS);\n" +
    "    }\n" +
    "    const state = Atomics.load(ctrl, 0);\n" +
    "    const length = Atomics.load(ctrl, 2);\n" +
    "    let reply;\n" +
    "    try { reply = JSON.parse(utf8Decode(bytes.subarray(0, length))); } catch { reply = undefined; }\n" +
    "    if (state !== 2 || !reply || reply.ok !== true) {\n" +
    "      const failure = new Error((reply && reply.error) || \"本地文件访问失败\");\n" +
    "      failure.code = (reply && reply.code) || \"FILE_ACCESS_FAILED\";\n" +
    "      throw failure;\n" +
    "    }\n" +
    "    return reply.value;\n" +
    "  };\n" +
    "  globalThis.zane = Object.freeze({ fs: Object.freeze({ list: (path) => call(\"list\", path), stat: (path) => call(\"stat\", path), readText: (path) => call(\"readText\", path) }) });\n" +
    "  return [control, data];\n" +
    "})()";
  const handles = vm.runInContext(bootstrap, context) as [SharedArrayBuffer, SharedArrayBuffer];
  return { control: handles[0], data: handles[1] };
}

const { context, store } = createSandbox(job.maxLogLines, job.maxLogBytes);

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
/** 受控文件访问的失败必须保留原始错误码（越界、未配置根目录、目录项过多），
 *  否则调用方只能看到笼统的执行失败，无法区分「越权」与「代码写错」。
 *  只放行白名单里的码，其它沙箱内异常仍是 CODE_EXECUTION_FAILED。 */
const FILE_ERROR_CODES = new Set(["FILE_ACCESS_DISABLED", "FILE_OUTSIDE_ROOT", "FILE_NOT_FOUND", "FILE_LIST_TOO_LARGE", "FILE_TOO_LARGE", "FILE_ACCESS_FAILED"]);
function fileErrorCode(error: unknown) {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && FILE_ERROR_CODES.has(code) ? code : undefined;
}
function finish(reply: Omit<CodeSandboxReply, "logs" | "kind">) {
  // 成功、失败与超时都要带上已产生的日志，所以统一在结束时收敛一次。
  parentPort?.postMessage({ kind: "done", ...reply, logs: store.slice() } as CodeSandboxReply);
  // The single-use worker exits naturally once the reply is flushed; the main
  // thread still terminates it so stray microtask loops cannot linger.
  parentPort?.unref();
}

// Unhandled rejections stay debug context in the log; the explicit return or
// throw of the entry function decides the execution result.
process.on("unhandledRejection", (error) => {
  if (store.length < job.maxLogLines) store.push("未处理的 Promise 拒绝：" + describe(error));
});

(async () => {
  if (job.fileAccess) {
    try {
      const bridge = createFileBridge(context, job.timeoutMs);
      parentPort?.postMessage({ kind: "attach", control: bridge.control, data: bridge.data } as CodeSandboxAttach);
    } catch (error) {
      finish({ ok: false, code: "CODE_EXECUTION_FAILED", error: "初始化本地文件读取通道失败：" + describe(error) });
      return;
    }
  }
  let script: vm.Script;
  try { script = new vm.Script(job.source, { filename: "core.code" }); }
  catch (error) { finish({ ok: false, code: "CODE_SYNTAX_ERROR", error: "代码语法错误：" + describe(error) }); return; }
  let result: unknown;
  try { result = await script.runInContext(context, { timeout: job.timeoutMs }); }
  catch (error) {
    if (timedOut(error)) { finish({ ok: false, code: "CODE_TIMEOUT", error: "代码执行超时（" + job.timeoutMs + " 毫秒）" }); return; }
    const fileCode = fileErrorCode(error);
    finish(fileCode ? { ok: false, code: fileCode, error: describe(error) } : { ok: false, code: "CODE_EXECUTION_FAILED", error: describe(error) });
    return;
  }
  let serialized: string | undefined;
  try { serialized = JSON.stringify(result); }
  catch { finish({ ok: false, code: "CODE_OUTPUT_NOT_SERIALIZABLE", error: "代码返回值不是可序列化的 JSON（undefined、函数、BigInt 或循环引用）" }); return; }
  if (serialized === undefined) { finish({ ok: false, code: "CODE_OUTPUT_NOT_SERIALIZABLE", error: "代码必须返回结果对象，不能返回 undefined" }); return; }
  if (serialized.length > job.maxOutputBytes) { finish({ ok: false, code: "CODE_OUTPUT_TOO_LARGE", error: "代码返回值超过 " + Math.floor(job.maxOutputBytes / 1024) + " KB" }); return; }
  finish({ ok: true, value: JSON.parse(serialized) as unknown });
})();
