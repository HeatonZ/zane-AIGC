import { MCP_RESTARTING, MCP_RESPONSE_UNCONFIRMED } from "../ai/mcpRuntimeContract.js";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { mcpReloadFile, readMcpGeneration, type McpGeneration } from "../runtime/mcpReload.js";

type Message = Parameters<NonNullable<StdioServerTransport["onmessage"]>>[0];
type Request = Extract<Message, { id: string | number; method: string }>;
const record = (message: Message) => message as unknown as Record<string, unknown>;
const key = (id: unknown) => JSON.stringify(id);
const isRequest = (message: Message): message is Request => "method" in message && "id" in message;
interface Worker {
  process: ChildProcess; transport: StdioServerTransport; muted: boolean; expectedClose: boolean;
  internal: Map<string, { resolve(value: Message): void; reject(reason: Error): void }>;
  replayIds: Set<string>; ready: Promise<string>;
}
export interface McpSupervisorOptions { workerEntry: string; baseUrl: string; markerFile?: string; pollMs?: number; execArgv?: string[] }

/** A stable stdio connection. Only its owned HTTP adapter child is replaced.
 * Never replays a tools/call, including when its response was lost. */
export class McpSupervisor {
  private current?: Worker;
  private opening?: Request;
  private initialized = false;
  private pending = new Map<string, Request>();
  private serverPending = new Set<string>();
  private subscriptions = new Map<string, Request>();
  private generation?: string;
  private wanted?: McpGeneration;
  private failedGeneration?: string;
  private switching = false;
  private closed = false;
  private poll?: ReturnType<typeof setInterval>;
  private checking = false;
  private workers = new Set<Worker>();
  readonly front = new StdioServerTransport();
  constructor(private readonly options: McpSupervisorOptions) {}
  private log(event: string, data: Record<string, unknown> = {}) { console.error(JSON.stringify({ component: "zane-mcp-supervisor", event, ...data })); }
  async start() {
    this.generation = (await readMcpGeneration(this.options.markerFile ?? mcpReloadFile(this.options.baseUrl), this.options.baseUrl))?.generation;
    this.current = this.launch(false);
    await this.current.ready;
    this.front.onmessage = message => { void this.receive(message).catch(error => this.log("protocol_error", { message: String(error) })); };
    this.front.onclose = () => { void this.close(); };
    this.front.onerror = error => this.log("transport_error", { message: error.message });
    await this.front.start();
    this.poll = setInterval(() => { void this.check(); }, this.options.pollMs ?? 500);
    this.poll.unref();
    this.log("started", { pid: process.pid, workerPid: this.current.process.pid });
  }
  private launch(muted: boolean): Worker {
    const child = spawn(process.execPath, [...(this.options.execArgv ?? process.execArgv), this.options.workerEntry], { stdio: ["pipe", "pipe", "inherit", "ipc"], env: process.env, windowsHide: true });
    const transport = new StdioServerTransport(child.stdout!, child.stdin!);
    let readyResolve!: (version: string) => void, readyReject!: (error: Error) => void;
    const ready = new Promise<string>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const worker: Worker = { process: child, transport, muted, expectedClose: false, internal: new Map(), replayIds: new Set(), ready };
    this.workers.add(worker);
    const timeout = setTimeout(() => readyReject(new Error("MCP 子进程未在 15 秒内就绪")), 15000); timeout.unref();
    child.on("message", message => {
      const value = message as { type?: string; contractVersion?: string };
      if (value?.type === "zane-mcp-ready" && typeof value.contractVersion === "string") { clearTimeout(timeout); readyResolve(value.contractVersion); }
    });
    child.once("error", error => { clearTimeout(timeout); readyReject(error); });
    child.once("exit", () => { clearTimeout(timeout); readyReject(new Error("MCP 子进程退出")); this.workers.delete(worker); this.workerClosed(worker); });
    transport.onmessage = message => {
      const id = key(record(message).id);
      const internal = worker.internal.get(id);
      if (internal && !isRequest(message)) { worker.internal.delete(id); internal.resolve(message); return; }
      if (worker.replayIds.has(id) && !isRequest(message)) { worker.replayIds.delete(id); return; }
      if (worker.muted || this.closed) return;
      if (isRequest(message)) this.serverPending.add(id);
      else if (!("method" in message)) this.pending.delete(id);
      void this.front.send(message).then(() => this.maybeReload()).catch(error => this.log("response_failed", { message: String(error) }));
    };
    transport.onerror = error => this.log("worker_transport_error", { message: error.message });
    transport.onclose = () => this.workerClosed(worker);
    void transport.start().catch(readyReject);
    return worker;
  }
  private workerClosed(worker: Worker) {
    for (const waiter of worker.internal.values()) waiter.reject(new Error("MCP 子进程连接已关闭"));
    worker.internal.clear();
    if (worker.expectedClose || worker !== this.current || this.closed) return;
    this.current = undefined;
    this.log("worker_lost", { workerPid: worker.process.pid });
    for (const request of this.pending.values()) {
      void this.front.send({ jsonrpc: "2.0", id: request.id, error: { code: MCP_RESPONSE_UNCONFIRMED.jsonRpcCode, message: "MCP 响应未确认；先按原 ID 对账，不要重放或换 ID。", data: { code: MCP_RESPONSE_UNCONFIRMED.code, outcome: request.method === "tools/call" ? "unknown" : "read_failed", recovery: MCP_RESPONSE_UNCONFIRMED.recovery } } });
    }
    this.pending.clear(); this.serverPending.clear();
    if (!this.switching) void this.replace().catch(error => this.log("restart_failed", { message: String(error) }));
  }
  private async receive(message: Message) {
    if (this.closed) return;
    if (isRequest(message)) {
      if (!this.opening && (message.method === "initialize" || message.method === "server/discover" || message.params?._meta)) this.opening = message;
      if (this.switching || !this.current) {
        await this.front.send({ jsonrpc: "2.0", id: message.id, error: { code: MCP_RESTARTING.jsonRpcCode, message: "工作台 MCP 正在切换，当前请求没有转发。稍后重读状态；写入仅按原 ID 对账。", data: { code: MCP_RESTARTING.code, outcome: MCP_RESTARTING.outcome, recovery: MCP_RESTARTING.recovery } } }); return;
      }
      if (message.method === "subscriptions/listen") this.subscriptions.set(key(message.id), message);
      else this.pending.set(key(message.id), message);
    } else if ("method" in message) {
      if (message.method === "notifications/initialized") this.initialized = true;
      if (message.method === "notifications/cancelled") this.subscriptions.delete(key((record(message).params as Record<string, unknown> | undefined)?.requestId));
    } else this.serverPending.delete(key(record(message).id));
    if (this.current) {
      try { await this.current.transport.send(message); }
      catch { this.workerClosed(this.current); }
    }
    this.maybeReload();
  }
  private async check() {
    if (this.closed || this.checking) return;
    this.checking = true;
    try {
      const value = await readMcpGeneration(this.options.markerFile ?? mcpReloadFile(this.options.baseUrl), this.options.baseUrl);
      if (value && value.generation !== this.generation && value.generation !== this.failedGeneration) { this.wanted = value; this.maybeReload(); }
    } finally { this.checking = false; }
  }
  private maybeReload() {
    if (this.closed || this.switching || !this.wanted || this.pending.size || this.serverPending.size || !this.opening || (this.opening.method === "initialize" && !this.initialized)) return;
    void this.replace().catch(error => this.log("restart_failed", { message: String(error) }));
  }
  private async internal(worker: Worker, request: Request): Promise<Message> {
    const id = "zane-reload-" + randomUUID();
    let timer: ReturnType<typeof setTimeout>;
    const response = new Promise<Message>((resolve, reject) => {
      timer = setTimeout(() => { worker.internal.delete(key(id)); reject(new Error("MCP 重建握手超时")); }, 15000);
      worker.internal.set(key(id), { resolve, reject });
    });
    try { await worker.transport.send({ ...request, id }); const result = await response; if ("error" in result) throw new Error("MCP 重建握手被拒绝"); return result; }
    finally { clearTimeout(timer!); worker.internal.delete(key(id)); }
  }
  private async replace() {
    if (this.closed || this.switching || this.pending.size || this.serverPending.size) return;
    this.switching = true;
    const target = this.wanted;
    const old = this.current;
    this.log("restarting", { generation: target?.generation, previousWorkerPid: old?.process.pid });
    let candidate: Worker | undefined;
    try {
      candidate = this.launch(true);
      const version = await candidate.ready;
      if (this.closed) { await this.dispose(candidate); return; }
      if (target && version !== target.contractVersion) throw new Error("新 MCP 与后台契约版本不一致；保留原连接，请核对构建");
      if (this.opening) {
        const opening: Request = this.opening.method === "initialize" ? this.opening : { ...this.opening, method: "server/discover", params: { ...(this.opening.params?._meta ? { _meta: this.opening.params._meta } : {}) } };
        await this.internal(candidate, opening);
        if (this.opening.method === "initialize" && this.initialized) await candidate.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      }
      for (const subscription of this.subscriptions.values()) {
        candidate.replayIds.add(key(subscription.id));
        await candidate.transport.send(subscription); // Only a catalog subscription, never a tool invocation.
      }
      if (this.closed) { await this.dispose(candidate); return; }
      if (old) await this.dispose(old);
      if (this.closed) { await this.dispose(candidate); return; }
      candidate.muted = false; this.current = candidate;
      if (target) { this.generation = target.generation; if (this.wanted?.generation === target.generation) this.wanted = undefined; }
      this.failedGeneration = undefined;
      this.switching = false;
      try { if (candidate.process.connected) candidate.process.send?.({ type: "zane-mcp-catalog-changed" }, error => { if (error) this.log("catalog_notification_failed", { message: error.message }); }); }
      catch (error) { this.log("catalog_notification_failed", { message: String(error) }); }
      this.log("restarted", { workerPid: candidate.process.pid, previousWorkerPid: old?.process.pid, generation: this.generation, contractVersion: version });
    } catch (error) {
      if (candidate) await this.dispose(candidate);
      if (target) { this.failedGeneration = target.generation; if (this.wanted?.generation === target.generation) this.wanted = undefined; }
      throw error;
    } finally { this.switching = false; this.maybeReload(); }
  }
  private async dispose(worker: Worker) {
    worker.expectedClose = true; worker.muted = true;
    worker.process.stdin?.end();
    if (worker.process.exitCode !== null || worker.process.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { try { worker.process.kill("SIGTERM"); } catch {} resolve(); }, 3000);
      worker.process.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true; if (this.poll) clearInterval(this.poll);
    await this.front.close();
    await Promise.all([...this.workers].map(worker => this.dispose(worker)));
  }
}
