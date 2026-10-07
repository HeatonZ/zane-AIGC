import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { RequestHandler, Response } from "express";
import type { SqliteStore } from "../storage/sqliteStore.js";
import { atomicJson, repositoryRoot } from "./mcpReload.js";

export interface ProductionLease { schemaVersion: 1; pid: number; instanceId: string; key: string; port: number; root: string; entry: string; socket: string; startedAt: string }
export interface LifecycleOptions {
  dataDirectory: string; port: number; store: SqliteStore;
  metrics(): { queued: number; active: number; preparing: number; ready: boolean };
  shutdown(): Promise<void>; entry?: string; releaseId?: string; upgradeOperationId?: string;
}
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Local named pipe/socket, not an HTTP/MCP shutdown proxy. The live process
 * verifies its own instance, fences requests, checks durable reviews and backs up SQLite. */
export class ProductionLifecycle {
  private gate = false;
  private bootFenced: boolean;
  private requests = new Map<Response, boolean>();
  private get activeRequests() { return [...this.requests].filter(([response, sse]) => !sse || !response.headersSent).length; }
  private server?: net.Server;
  private sockets = new Set<net.Socket>();
  private accepted = new Map<string, Promise<Record<string, unknown>>>();
  private receipt?: Record<string, unknown>;
  readonly lease: ProductionLease;
  readonly leaseFile: string;
  constructor(private readonly options: LifecycleOptions) {
    this.bootFenced = Boolean(options.upgradeOperationId);
    const instanceId = randomUUID();
    this.leaseFile = path.join(options.dataDirectory, "production-runtime.json");
    this.lease = { schemaVersion: 1, pid: process.pid, instanceId, key: randomUUID(), port: options.port, root: repositoryRoot,
      entry: path.resolve(options.entry ?? process.argv[1]), startedAt: new Date().toISOString(),
      socket: os.platform() === "win32" ? `\\\\.\\pipe\\zane-workbench-${instanceId}` : path.join(os.tmpdir(), `zane-${instanceId}.sock`) };
  }
  middleware: RequestHandler = (request, response, next) => {
    if (this.gate || (this.bootFenced && !["/api/health", "/api/ready"].includes(request.path))) { response.status(503).json({ code: "WORKBENCH_UPGRADING", error: "工作台正在备份并正常切换，暂不接受新请求。写入回执未确认时先按原 ID 对账。" }); return; }
    // SSE is a durable read stream, not an unfinished mutation. Ordinary reads
    // may import legacy snapshots, so they too must drain before the backup.
    this.requests.set(response, request.method === "GET" && request.path.endsWith("/events"));
    const settle = () => this.requests.delete(response);
    response.once("finish", settle); response.once("close", settle);
    next();
  };
  async start() {
    this.server = net.createServer(socket => {
      this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); socket.setTimeout(120000, () => socket.destroy());
      let data = "", handled = false;
      socket.on("data", chunk => {
        if (handled) return;
        data += chunk.toString("utf8");
        if (Buffer.byteLength(data) > 16384) { handled = true; socket.end(JSON.stringify({ok:false,code:"INVALID_CONTROL_REQUEST"})+"\n"); return; }
        const newline = data.indexOf("\n"); if (newline < 0) return;
        handled = true;
        void (async () => {
          let input: Record<string, unknown>;
          try { input = JSON.parse(data.slice(0, newline)); } catch { socket.end(JSON.stringify({ok:false,code:"INVALID_CONTROL_REQUEST"})+"\n"); return; }
          const result = await this.request(input);
          socket.end(JSON.stringify(result)+"\n");
          // A lost reply does not cancel an accepted shutdown. Its receipt is durable.
          if (result.ok === true && input.action === "shutdown") setImmediate(() => { void this.options.shutdown(); });
        })().catch(error => { socket.end(JSON.stringify({ok:false,code:"UPGRADE_FAILED",message:String(error)})+"\n"); });
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.lease.socket, resolve); });
    await atomicJson(this.leaseFile, this.lease);
  }
  async request(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (input.instanceId !== this.lease.instanceId || input.key !== this.lease.key || input.pid !== this.lease.pid) return {ok:false,code:"PROCESS_IDENTITY_CHANGED"};
    if (input.action === "inspect") return { ok: true, pid: process.pid, instanceId: this.lease.instanceId, root: this.lease.root, entry: this.lease.entry, port: this.lease.port, metrics: this.options.metrics(), unfinished: this.options.store.unfinishedRunCounts(), releaseId: this.options.releaseId ?? "unversioned", upgradeOperationId: this.options.upgradeOperationId, serving: !this.gate && !this.bootFenced };
    if (input.action === "activate") {
      if (!uuid(input.operationId) || input.operationId !== this.options.upgradeOperationId) return {ok:false,code:"INVALID_ACTIVATION"};
      if (this.gate || this.busy().blocked) return {ok:false,code:"WORKBENCH_BUSY"};
      this.bootFenced = false;
      return {ok:true,pid:process.pid,instanceId:this.lease.instanceId,releaseId:this.options.releaseId ?? "unversioned",serving:true};
    }
    if (input.action !== "shutdown" || !uuid(input.operationId)) return {ok:false,code:"INVALID_CONTROL_REQUEST"};
    const id = input.operationId;
    let operation = this.accepted.get(id);
    if (!operation) { operation = this.prepare(id); this.accepted.set(id, operation); }
    const result = await operation;
    if ((result.code === "WORKBENCH_BUSY" || result.code === "BACKUP_FAILED") && this.accepted.get(id) === operation) this.accepted.delete(id);
    return result;
  }
  private busy() {
    const metrics = this.options.metrics(); const unfinished = this.options.store.unfinishedRunCounts();
    return { metrics, unfinished, blocked: !metrics.ready || metrics.preparing > 0 || metrics.queued > 0 || metrics.active > 0 || Object.values(unfinished).some(count => count > 0) };
  }
  private async prepare(operationId: string): Promise<Record<string, unknown>> {
    if (this.gate) return {ok:false,code:"UPGRADE_ALREADY_PENDING"};
    this.gate = true;
    try {
      let activity = this.busy();
      if (activity.blocked) { this.gate = false; return {ok:false,code:"WORKBENCH_BUSY",metrics:activity.metrics,unfinished:activity.unfinished}; }
      const deadline = Date.now() + 10000;
      while (this.activeRequests > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      activity = this.busy();
      if (activity.blocked || this.activeRequests > 0) { this.gate = false; return {ok:false,code:"WORKBENCH_BUSY",activeRequests:this.activeRequests,metrics:activity.metrics,unfinished:activity.unfinished}; }
      const directory = path.join(this.options.dataDirectory, "backups", "restart-" + operationId);
      await mkdir(directory, { recursive: true });
      await this.options.store.backupTo(path.join(directory, "zane.db"));
      const files = ["zane.db"];
      for (const filename of ["connections.json", "workspace.json"]) {
        try { await copyFile(path.join(this.options.dataDirectory, filename), path.join(directory, filename)); files.push(filename); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const receipt = { ok: true, operationId, pid: this.lease.pid, instanceId: this.lease.instanceId, backupDirectory: directory, files, createdAt: new Date().toISOString(), nextAction: "wait_for_original_process_to_close" };
      await atomicJson(path.join(directory, "receipt.json"), receipt);
      this.receipt = receipt;
      return receipt;
    } catch (error) { this.gate = false; return {ok:false,code:"BACKUP_FAILED",message:String(error)}; }
  }
  async markClosed() {
    if (this.receipt) await atomicJson(path.join(String(this.receipt.backupDirectory), "receipt.json"), { ...this.receipt, closedAt: new Date().toISOString(), nextAction: "start_new_instance" });
  }
  async close() {
    this.gate = true;
    if (!this.server) return;
    const server = this.server; this.server = undefined;
    await new Promise<void>(resolve => { server.close(() => resolve()); for (const socket of this.sockets) socket.end(); });
  }
}
