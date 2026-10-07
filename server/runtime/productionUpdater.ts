import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, rename, stat, symlink, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { atomicJson } from "./mcpReload.js";
import { upgradeId, upgradeRecordSchema, type UpgradeRecord } from "../domain/workbenchUpdateContracts.js";
import type { ProductionLease } from "./productionLifecycle.js";

export interface UpgradeSettings {
  root: string; dataDirectory: string; port: number; probeHost: string; leaseFile: string;
  environment?: NodeJS.ProcessEnv;
}
type Inspection = { lease: ProductionLease; info: Record<string, any> };
export interface UpgradeDependencies {
  verifyProcess(lease: ProductionLease): Promise<void>;
  control(lease: ProductionLease, action: string, operationId?: string): Promise<any>;
  runCheck?(snapshot: string, logFile: string, releaseId: string): Promise<void>;
  start?(settings: UpgradeSettings, operationId: string, releaseId: string, logFile: string): Promise<number>;
  sleep?(milliseconds: number): Promise<void>;
  health?(settings: UpgradeSettings): Promise<boolean>;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const timestamp = () => new Date().toISOString();
const terminal = new Set(["completed", "failed", "cancelled", "needs_attention"]);
const sourceDirectories = ["server", "src", "scripts", "docs", "examples", "public", ".github"];
const sourceFiles = ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.server.json", "vite.config.ts", "index.html", "README.md", "AGENTS.md", ".env.example"];
const assertInside = (directory: string, target: string) => {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("升级路径超出允许目录");
};
async function exists(file: string) { try { await stat(file); return true; } catch (error) { if (absent(error)) return false; throw error; } }
export async function portOpen(port: number, host: string) {
  return new Promise<boolean>(resolve => {
    const socket = net.createConnection({port,host});
    const finish = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.setTimeout(500, () => finish(false));
  });
}
async function regularFiles(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of (await readdir(directory, {withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name), file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("升级快照不接受符号链接：" + relative);
    if (entry.isDirectory()) result.push(...await regularFiles(file, relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error("升级快照不接受特殊文件：" + relative);
  }
  return result;
}
async function hashFiles(directory: string, files: string[]) {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    const location = path.join(directory, file); assertInside(directory, location);
    if (!(await lstat(location)).isFile()) throw new Error("升级文件已变化：" + file);
    const bytes = await readFile(location);
    hash.update(JSON.stringify(file.replaceAll("\\", "/")) + ":" + bytes.length + ":"); hash.update(bytes);
  }
  return hash.digest("hex");
}
async function sourceInventory(root: string) {
  const files: string[] = [];
  for (const directory of sourceDirectories) if (await exists(path.join(root,directory))) files.push(...(await regularFiles(path.join(root,directory))).map(file => path.join(directory,file)));
  for (const file of sourceFiles) if (await exists(path.join(root,file))) files.push(file);
  return files.sort();
}
async function artifactHash(root: string) {
  const files: string[] = [];
  for (const directory of ["dist", "dist-server"]) files.push(...(await regularFiles(path.join(root,directory))).map(file => path.join(directory,file)));
  if (!files.includes(path.join("dist-server","index.js")) || !files.includes(path.join("dist","index.html"))) throw new Error("升级产物不完整");
  return hashFiles(root,files);
}
function isolatedEnvironment(releaseId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Never pass production endpoints, credentials, NODE_OPTIONS or APP_DATA_DIR to acceptance.
  const allowed = new Set(["path","pathext","systemroot","windir","comspec","temp","tmp","userprofile","home","appdata","localappdata","programdata","systemdrive","processor_architecture","number_of_processors"]);
  for (const [key,value] of Object.entries(process.env)) if (allowed.has(key.toLowerCase())) env[key] = value;
  return {...env,ZANE_RELEASE_ID:releaseId,VITE_WORKBENCH_RELEASE:releaseId};
}
export async function defaultCheck(snapshot: string, logFile: string, releaseId: string) {
  const log = await open(logFile,"a");
  try {
    const child = spawn("npm run check", {cwd:snapshot,env:isolatedEnvironment(releaseId),shell:true,windowsHide:true,stdio:["ignore",log.fd,log.fd]});
    const code = await new Promise<number | null>((resolve,reject) => { child.once("error",reject); child.once("exit",resolve); });
    if (code !== 0) throw new Error("新版本 npm run check 未通过；旧工作台未停止。查看 check.log");
  } finally { await log.close(); }
}
async function defaultStart(settings: UpgradeSettings, operationId: string, releaseId: string, logFile: string) {
  const log = await open(logFile,"a");
  try {
    const child = spawn(process.execPath,[path.join(settings.root,"dist-server","index.js"),"--production"],{
      cwd:settings.root,windowsHide:true,detached:true,stdio:["ignore",log.fd,log.fd],
      env:{...(settings.environment ?? process.env),APP_DATA_DIR:settings.dataDirectory,API_PORT:String(settings.port),
        DIST_DIR:path.join(settings.root,"dist"),ZANE_RELEASE_ID:releaseId,ZANE_UPGRADE_OPERATION_ID:operationId},
    });
    await new Promise<void>((resolve,reject) => { child.once("error",reject); child.once("spawn",resolve); });
    if (!child.pid) throw new Error("新后台未返回 PID");
    child.unref(); return child.pid;
  } finally { await log.close(); }
}

/** Read-only logical snapshot; no raw file/WAL hash and never restores/migrates a database. */
export function databaseFingerprint(file: string) {
  const database = new DatabaseSync(file,{readOnly:true});
  const hash = createHash("sha256");
  try {
    database.exec("BEGIN");
    const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    hash.update(JSON.stringify(schema));
    hash.update(JSON.stringify(database.prepare("PRAGMA user_version").get()));
    hash.update(JSON.stringify(database.prepare("PRAGMA application_id").get()));
    for (const table of database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      const quoted = '"' + String(table.name).replaceAll('"','""') + '"';
      const statement = database.prepare("SELECT * FROM " + quoted); statement.setReadBigInts(true);
      // Sort row encodings so WITHOUT ROWID and physical page order have the same semantics.
      const rows = statement.all().map(row => JSON.stringify(row, (_key,value) => typeof value === "bigint" ? {$bigint:String(value)} : value)).sort();
      hash.update(JSON.stringify(table.name)); for (const row of rows) hash.update(row + "\n");
    }
    return hash.digest("hex");
  } finally { database.close(); }
}

export class ProductionUpdater {
  readonly directory: string;
  readonly releaseDirectory: string;
  private record!: UpgradeRecord;
  private readonly wait: (ms:number) => Promise<void>;
  private lockToken?: string;
  constructor(readonly settings: UpgradeSettings, private readonly dependencies: UpgradeDependencies) {
    this.directory = path.join(settings.dataDirectory,"maintenance","upgrades");
    this.releaseDirectory = path.join(settings.root,".local","upgrades");
    this.wait = dependencies.sleep ?? sleep;
    if (!Number.isSafeInteger(settings.port) || settings.port < 1 || settings.port > 65535) throw new Error("升级端口无效");
  }
  private paths(id: string) {
    upgradeId.parse(id);
    const operation = path.join(this.directory,id+".json"), release = path.join(this.releaseDirectory,id);
    assertInside(this.directory,operation); assertInside(this.releaseDirectory,release);
    return {operation,release,snapshot:path.join(release,"snapshot"),previous:path.join(release,"previous"),next:path.join(release,"next")};
  }
  async status(id: string) { return upgradeRecordSchema.parse(JSON.parse(await readFile(this.paths(id).operation,"utf8"))); }
  private async save(patch: Partial<UpgradeRecord>) {
    this.record = upgradeRecordSchema.parse({...this.record,...patch,revision:this.record.revision+1,updatedAt:timestamp()});
    await atomicJson(this.paths(this.record.operationId).operation,this.record);
    await atomicJson(path.join(this.directory,"latest.json"),{operationId:this.record.operationId});
  }
  private async lock(id: string) {
    await mkdir(this.directory,{recursive:true});
    const file = path.join(this.directory,"lock.json"), token = randomUUID();
    try { const handle = await open(file,"wx"); try { await handle.writeFile(JSON.stringify({operationId:id,pid:process.pid,token,createdAt:timestamp()})); } finally { await handle.close(); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("另一个升级持有锁；先 status 按原 operationId 对账，不能盲重投。进程退出遗留锁需显式 recover。"); throw error; }
    this.lockToken = token;
  }
  private async unlock() {
    if (!this.lockToken) return;
    const file = path.join(this.directory,"lock.json");
    const owner = JSON.parse(await readFile(file,"utf8"));
    if (owner.token !== this.lockToken || owner.pid !== process.pid) throw new Error("升级锁身份变化，不删除别人的锁");
    await unlink(file); this.lockToken = undefined;
  }
  async cancel(id: string, revision: number) {
    const record = await this.status(id);
    if (record.revision !== revision) throw new Error("升级 revision 已变化；先按原 ID 读取，不能覆盖");
    if (!["preparing","checking","ready","waiting"].includes(record.state)) throw new Error("停止旧服务后不允许取消；必须完成切换或对账恢复");
    await atomicJson(path.join(this.directory,id+".cancel.json"),{operationId:id,revision,createdAt:timestamp()});
  }
  private async cancellation() {
    const file = path.join(this.directory,this.record.operationId+".cancel.json");
    if (await exists(file)) { await this.save({state:"cancelled",message:"升级已取消；旧工作台未停止",nextAction:"none"}); return true; }
    return false;
  }
  /** Explicit recovery never replays a lost shutdown or launches a second candidate. */
  async recover(id: string) {
    const lockFile = path.join(this.directory,"lock.json");
    if (await exists(lockFile)) {
      const owner = JSON.parse(await readFile(lockFile,"utf8"));
      if (owner.operationId !== id || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("锁不属于此升级");
      try { process.kill(owner.pid,0); throw new Error("升级进程仍存在或 PID 被复用，不能接管"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      await unlink(lockFile);
    }
    await this.lock(id);
    try {
      this.record = await this.status(id);
      if (this.record.state === "completed" || this.record.state === "cancelled" || this.record.state === "failed") return this.record;
      if (["preparing","checking"].includes(this.record.state)) {
        await this.save({state:"failed",message:"准备进程中断，未确认验收；旧工作台未停止",nextAction:"inspect_check_log"}); return this.record;
      }
      if (["ready","waiting"].includes(this.record.state)) return this.record;
      // After stopping has begun, only reconcile exact original identities/receipts.
      const live = await this.inspect().catch(() => undefined);
      if (live && live.info.upgradeOperationId === id && live.lease.pid === this.record.newPid && live.info.releaseId === id && live.info.serving === true) {
        await this.save({state:"completed",servingConfirmed:true,newInstanceId:live.lease.instanceId,message:"按原升级 ID 确认新版本已服务；未重复启动",nextAction:"refresh_when_edits_saved"});
      } else {
        await this.save({state:"needs_attention",rollback:"manual_required",message:"切换中断；保留原 ID、备份与产物，不重放停机、不重复启动、不自动恢复数据库",nextAction:"inspect_original_receipts_and_process"});
      }
      return this.record;
    } finally { await this.unlock(); }
  }
  async prepare(id: string) {
    await this.lock(id);
    try {
      if (await exists(this.paths(id).operation)) throw new Error("升级 ID 已存在；按原 ID 读取，不能重建或覆盖");
      const now=timestamp(); this.record={schemaVersion:1,operationId:id,releaseId:id,revision:1,state:"preparing",createdAt:now,updatedAt:now,message:"建立隔离源码快照",checkPassed:false,nextAction:"wait_for_check"};
      await atomicJson(this.paths(id).operation,this.record); await atomicJson(path.join(this.directory,"latest.json"),{operationId:id});
      const paths=this.paths(id); await mkdir(paths.snapshot,{recursive:true});
      const files=await sourceInventory(this.settings.root), before=await hashFiles(this.settings.root,files);
      for (const file of files) { const target=path.join(paths.snapshot,file); await mkdir(path.dirname(target),{recursive:true}); await cp(path.join(this.settings.root,file),target,{errorOnExist:true,force:false}); }
      if (before !== await hashFiles(paths.snapshot,files) || before !== await hashFiles(this.settings.root,await sourceInventory(this.settings.root))) throw new Error("源码在快照期间变化；没有停止旧工作台");
      await symlink(path.join(this.settings.root,"node_modules"),path.join(paths.snapshot,"node_modules"),process.platform === "win32" ? "junction" : "dir");
      await this.save({state:"checking",message:"隔离快照执行 npm run check；旧工作台继续运行"});
      await (this.dependencies.runCheck ?? defaultCheck)(paths.snapshot,path.join(paths.release,"check.log"),id);
      if (await this.cancellation()) return this.record;
      const hash=await artifactHash(paths.snapshot);
      await mkdir(paths.next,{recursive:true});
      for (const directory of ["dist","dist-server"]) await cp(path.join(paths.snapshot,directory),path.join(paths.next,directory),{recursive:true,errorOnExist:true,force:false});
      if (await artifactHash(paths.next) !== hash) throw new Error("候选产物复制校验失败");
      await this.save({state:"ready",checkPassed:true,checkPassedAt:timestamp(),artifactHash:hash,message:"新版本验收通过；可等待空闲后切换",nextAction:"apply_same_operation_id"});
      return this.record;
    } catch (error) {
      if (this.record?.operationId === id && !terminal.has(this.record.state)) await this.save({state:"failed",message:String(error),nextAction:"inspect_check_log"});
      throw error;
    } finally { await this.unlock(); }
  }
  private async inspect(): Promise<Inspection> {
    const lease = JSON.parse(await readFile(this.settings.leaseFile,"utf8")) as ProductionLease;
    if (lease.schemaVersion !== 1 || !Number.isSafeInteger(lease.pid) || lease.pid < 1 || lease.port !== this.settings.port || path.resolve(lease.root) !== path.resolve(this.settings.root)
      || path.resolve(lease.entry) !== path.join(this.settings.root,"dist-server","index.js") || typeof lease.key !== "string" || typeof lease.instanceId !== "string") throw new Error("当前生产租约不属于此工作台；没有停止进程。首次安装需正常关闭旧版本。");
    await this.dependencies.verifyProcess(lease);
    const info = await this.dependencies.control(lease,"inspect");
    if (!info.ok || info.pid !== lease.pid || info.instanceId !== lease.instanceId || path.resolve(info.root) !== path.resolve(this.settings.root) || path.resolve(info.entry) !== path.resolve(lease.entry) || info.port !== lease.port) throw new Error("当前进程身份已变化；不切换其他实例");
    return {lease,info};
  }
  private busy(info: Record<string,any>) {
    return !info.metrics?.ready || info.metrics.preparing > 0 || info.metrics.queued > 0 || info.metrics.active > 0 || Object.values(info.unfinished ?? {}).some(count => Number(count)>0);
  }
  private async shutdown(live: Inspection, operationId: string) {
    await this.dependencies.verifyProcess(live.lease);
    let result: any;
    try { result = await this.dependencies.control(live.lease,"shutdown",operationId); }
    catch (error) {
      // Unknown response is NOT a busy retry; read exactly the original durable receipt.
      try { result = JSON.parse(await readFile(path.join(this.settings.dataDirectory,"backups","restart-"+operationId,"receipt.json"),"utf8")); }
      catch { throw new Error("停机回执未知，按原 operationId 对账，不重放：" + String(error)); }
    }
    if (result.code === "WORKBENCH_BUSY") return false;
    const backup=path.join(this.settings.dataDirectory,"backups","restart-"+operationId);
    if (!result.ok || result.operationId !== operationId || result.pid !== live.lease.pid || result.instanceId !== live.lease.instanceId || path.resolve(result.backupDirectory) !== path.resolve(backup) || !await exists(path.join(backup,"zane.db"))) throw new Error("备份/关停回执不匹配，停止切换："+String(result.code));
    const deadline=Date.now()+30000;
    while (Date.now()<deadline) {
      const receipt=JSON.parse(await readFile(path.join(backup,"receipt.json"),"utf8"));
      if (receipt.closedAt && receipt.operationId === operationId && receipt.instanceId === live.lease.instanceId && !await portOpen(this.settings.port,this.settings.probeHost)) return true;
      await this.wait(100);
    }
    throw new Error("旧实例没有确认正常关闭；不强杀、不覆盖产物");
  }
  private async switchFiles() {
    const paths=this.paths(this.record.operationId); await mkdir(paths.previous,{recursive:true});
    for (const directory of ["dist-server","dist"]) {
      const active=path.join(this.settings.root,directory), previous=path.join(paths.previous,directory), next=path.join(paths.next,directory);
      assertInside(this.settings.root,active); assertInside(paths.release,previous); assertInside(paths.release,next);
      if (await exists(active)) await rename(active,previous);
      await rename(next,active);
    }
  }
  private async restoreCode() {
    const paths=this.paths(this.record.operationId), rejected=path.join(paths.release,"rejected"); await mkdir(rejected,{recursive:true});
    for (const directory of ["dist-server","dist"]) {
      const active=path.join(this.settings.root,directory), previous=path.join(paths.previous,directory);
      if (!await exists(previous)) continue;
      if (await exists(active)) await rename(active,path.join(rejected,directory));
      await rename(previous,active);
    }
  }
  private async awaitCandidate(pid: number, operationId: string, releaseId: string, deadlineMs: number) {
    const deadline=Date.now()+deadlineMs;
    while (Date.now()<deadline) {
      const live=await this.inspect().catch(()=>undefined);
      if (live && live.lease.pid === pid && live.info.upgradeOperationId === operationId && live.info.releaseId === releaseId && live.info.metrics?.ready && live.info.serving === false) {
        if (this.dependencies.health) { if (await this.dependencies.health(this.settings)) return live; }
        else {
          const response=await fetch(`http://${this.settings.probeHost.includes(":") ? "["+this.settings.probeHost+"]" : this.settings.probeHost}:${this.settings.port}/api/ready`,{signal:AbortSignal.timeout(3000)}).catch(()=>undefined);
          const ready=Boolean(response?.ok); await response?.body?.cancel(); if (ready) return live;
        }
      }
      await this.wait(100);
    }
    throw new Error("新版本未通过身份、就绪与启动隔离检查；尚未开放业务请求");
  }
  private async activate(live: Inspection, operationId: string) {
    let result: any;
    try { result=await this.dependencies.control(live.lease,"activate",operationId); }
    catch { const reconciled=await this.inspect(); if (reconciled.lease.instanceId !== live.lease.instanceId || reconciled.info.serving !== true || reconciled.info.upgradeOperationId !== operationId) throw new Error("激活回执未知；不重放、不回滚已可能开放的实例"); return; }
    if (!result.ok || result.instanceId !== live.lease.instanceId || result.serving !== true) throw new Error("新版本激活失败");
  }
  private async restartRestored(error: unknown) {
    if (!this.record.oldActivationSupported || !this.record.oldReleaseId) {
      await this.save({state:"needs_attention",rollback:"code_restored",message:"旧代码已恢复；旧版本不支持启动隔离，首次回退需正常启动。数据库未恢复："+String(error),nextAction:"start_restored_workbench"}); return;
    }
    if (await portOpen(this.settings.port,this.settings.probeHost)) throw new Error("端口被占用；不启动第二个实例");
    const rollbackId=this.record.rollbackOperationId ?? randomUUID();
    await this.save({rollbackOperationId:rollbackId,rollback:"code_restored",message:"旧代码已恢复；自动启动隔离旧实例并检查就绪"});
    const pid=await (this.dependencies.start ?? defaultStart)(this.settings,rollbackId,this.record.oldReleaseId,path.join(this.paths(this.record.operationId).release,"rollback-server.log"));
    await this.save({rollbackPid:pid});
    const restored=await this.awaitCandidate(pid,rollbackId,this.record.oldReleaseId,30000);
    await this.save({rollbackInstanceId:restored.lease.instanceId});
    await this.activate(restored,rollbackId);
    await this.save({state:"failed",servingConfirmed:true,rollback:"code_restored",message:"升级失败，已自动恢复并启动旧版本；未恢复数据库或重放任务："+String(error),nextAction:"inspect_upgrade_log_old_version_running"});
  }
  /** Explicit offline install only: no saved PID is stopped and no queued/review work is replayed. */
  async install(id: string) {
    await this.lock(id);
    try {
      this.record=await this.status(id);
      if (this.record.state !== "ready" || !this.record.checkPassed || !this.record.artifactHash) throw new Error("首次启动也必须先通过隔离验收");
      const ensureOffline=async()=>{
        if (await portOpen(this.settings.port,this.settings.probeHost)) throw new Error("端口正在服务，必须使用apply安全升级");
        let lease:any;
        try { lease=JSON.parse(await readFile(this.settings.leaseFile,"utf8")); } catch(error) { if(!absent(error)) throw error; }
        if (lease) {
          if (path.resolve(lease.root)!==path.resolve(this.settings.root) || !Number.isSafeInteger(lease.pid) || lease.pid<1) throw new Error("旧租约身份不匹配，不能首次启动");
          try { process.kill(lease.pid,0); throw new Error("旧进程仍存在或PID被复用；等待正常退出，不强杀"); }
          catch(error) { if ((error as NodeJS.ErrnoException).code!=="ESRCH") throw error; }
        }
      };
      await ensureOffline();
      if (await this.cancellation()) return this.record;
      const paths=this.paths(id);
      if (await artifactHash(paths.next)!==this.record.artifactHash) throw new Error("候选产物变化，拒绝首次启动");
      const directory=path.join(this.settings.dataDirectory,"backups","restart-"+id);await mkdir(directory,{recursive:true});
      const database=path.join(this.settings.dataDirectory,"zane.db");
      if (await exists(database)) {
        const source=new DatabaseSync(database,{readOnly:true});
        try {
          if (source.prepare("SELECT name FROM sqlite_master WHERE name='runs' AND type='table'").get()) {
            const unfinished=source.prepare("SELECT status,COUNT(*) AS count FROM runs WHERE status IN ('queued','running','cancelling','waiting') GROUP BY status").all();
            if (unfinished.length) throw new Error("离线库仍有未完成任务或审核；不能通过首次启动绕过升级等待或自动重放");
          }
          await backup(source,path.join(directory,"zane.db"));
        } finally {source.close();}
      }
      for(const file of ["connections.json","workspace.json"]) if (await exists(path.join(this.settings.dataDirectory,file))) await cp(path.join(this.settings.dataDirectory,file),path.join(directory,file),{force:false,errorOnExist:true});
      await ensureOffline();
      await atomicJson(path.join(directory,"receipt.json"),{ok:true,operationId:id,offline:true,closedAt:timestamp(),backupDirectory:directory});
      await this.save({state:"switching",shutdownConfirmed:true,message:"首次启动：已确认端口空闲、旧进程退出与离线备份；不重放未完成任务",nextAction:"complete_switch"});
      await this.switchFiles();
      await this.save({state:"starting",switched:true,message:"首次启动候选工作台，健康检查前保持业务隔离",nextAction:"inspect_candidate"});
      const pid=await (this.dependencies.start ?? defaultStart)(this.settings,id,id,path.join(paths.release,"server.log"));await this.save({newPid:pid});
      const live=await this.awaitCandidate(pid,id,id,30000);await this.save({newInstanceId:live.lease.instanceId});await this.activate(live,id);
      await this.save({state:"completed",servingConfirmed:true,message:"首次启动完成，未审批、续跑或调用模型",nextAction:"refresh_when_edits_saved"});return this.record;
    } catch(error) {
      if (this.record?.operationId===id) await this.save({state:this.record.shutdownConfirmed?"needs_attention":"failed",message:String(error),nextAction:this.record.shutdownConfirmed?"inspect_original_receipts_and_process":"inspect_check_log"});
      throw error;
    } finally {await this.unlock();}
  }
  async apply(id: string, options: { pollMs?: number; waitTimeoutMs?: number; healthTimeoutMs?: number } = {}) {
    await this.lock(id);
    let candidate: Inspection | undefined, candidateStarted=false;
    try {
      this.record=await this.status(id);
      if (this.record.state === "completed") return this.record;
      if (!["ready","waiting"].includes(this.record.state) || !this.record.checkPassed || !this.record.artifactHash) throw new Error("仅已验收的 ready/waiting 升级可应用；切换中断用 recover 对账");
      const paths=this.paths(id);
      if (await artifactHash(paths.next) !== this.record.artifactHash) throw new Error("候选产物被修改；拒绝停止旧服务");
      const deadline=Date.now()+(options.waitTimeoutMs ?? 24*60*60*1000);
      let old: Inspection | undefined;
      while (Date.now()<deadline) {
        if (await this.cancellation()) return this.record;
        const live=await this.inspect();
        if (this.record.oldInstanceId && live.lease.instanceId !== this.record.oldInstanceId) throw new Error("等待期间生产实例变化；停止升级，不接管另一个实例");
        if (!this.record.oldInstanceId) await this.save({oldInstanceId:live.lease.instanceId,oldPid:live.lease.pid,oldReleaseId:live.info.releaseId,oldActivationSupported:typeof live.info.serving === "boolean" && typeof live.info.releaseId === "string"});
        if (this.busy(live.info)) {
          const blocked={metrics:live.info.metrics,unfinished:live.info.unfinished};
          if (this.record.state !== "waiting" || JSON.stringify(blocked)!==JSON.stringify(this.record.blocked)) await this.save({state:"waiting",blocked,message:"等待任务、排队或人工审核处理完毕；不会自动取消、审批或续跑",nextAction:"wait_for_idle_or_cancel"});
          await this.wait(options.pollMs ?? 2000); continue;
        }
        if (await this.cancellation()) return this.record;
        if (await artifactHash(paths.next) !== this.record.artifactHash) throw new Error("等待期间候选产物被修改；拒绝停止旧服务");
        await this.save({state:"stopping",blocked:undefined,message:"重新核验实例，备份权威 SQLite 并正常关闭",nextAction:"reconcile_original_shutdown_receipt"});
        // A fresh idle race returning KNOWN busy is retryable under the SAME id.
        if (!await this.shutdown(live,id)) { await this.save({state:"waiting",message:"空闲检查发生竞争；原实例未停止，继续等待",nextAction:"wait_for_idle_or_cancel"}); await this.wait(options.pollMs ?? 2000); continue; }
        old=live; break;
      }
      if (!old) { await this.save({state:"waiting",message:"等待超时，旧工作台继续运行；可按原 ID 继续等待",nextAction:"apply_same_operation_id"}); return this.record; }
      await this.save({state:"switching",shutdownConfirmed:true,message:"旧实例已正常关闭且备份回执确认；切换已验收产物",nextAction:"complete_switch"});
      await this.switchFiles();
      await this.save({state:"starting",switched:true,message:"启动新实例；健康检查通过前禁止业务请求",nextAction:"inspect_candidate"});
      const pid=await (this.dependencies.start ?? defaultStart)(this.settings,id,id,path.join(paths.release,"server.log")); candidateStarted=true;
      await this.save({newPid:pid});
      candidate=await this.awaitCandidate(pid,id,id,options.healthTimeoutMs ?? 30000);
      await this.save({newInstanceId:candidate.lease.instanceId});
      await this.activate(candidate,id);
      await this.save({state:"completed",servingConfirmed:true,message:"升级完成；Hermes/ComfyUI 未重启，任务未自动续跑",nextAction:"refresh_when_edits_saved"});
      return this.record;
    } catch (error) {
      if (!this.record || this.record.operationId !== id) throw error;
      if (this.record.state === "completed") throw error;
      // Never rollback after activation is known or ambiguous. Exact live ID wins over missing receipt.
      const live=await this.inspect().catch(()=>undefined);
      if (live?.info.upgradeOperationId === id && live.info.releaseId === id && live.info.serving === true && live.lease.pid === this.record.newPid) {
        await this.save({state:"completed",servingConfirmed:true,newInstanceId:live.lease.instanceId,message:"已按原 ID 对账确认新实例服务；不重复启动",nextAction:"refresh_when_edits_saved"}); return this.record;
      }
      try {
      if (this.record.shutdownConfirmed && !candidateStarted) {
        await this.restoreCode();
        await this.restartRestored(error);
      } else if (this.record.shutdownConfirmed && candidateStarted) {
        const backup=path.join(this.settings.dataDirectory,"backups","restart-"+id,"zane.db");
        const unchanged=await exists(backup) && databaseFingerprint(backup) === databaseFingerprint(path.join(this.settings.dataDirectory,"zane.db"));
        const rollbackId=this.record.rollbackOperationId ?? randomUUID();
        if (unchanged && live && live.lease.pid === this.record.newPid && live.info.upgradeOperationId === id && live.info.serving === false && !this.busy(live.info)) {
          await this.save({rollbackOperationId:rollbackId,message:"启动失败且数据库逻辑快照未变化；正常关闭隔离候选并恢复旧代码"});
          if (await this.shutdown(live,rollbackId)) {
            await this.restoreCode();
            await this.restartRestored(error);
          } else await this.save({state:"needs_attention",rollback:"manual_required",message:"候选出现业务活动，停止回退："+String(error),nextAction:"inspect_original_receipts_and_process"});
        } else {
          let exited=false;
          if (this.record.newPid) { try { process.kill(this.record.newPid,0); } catch (pidError) { if ((pidError as NodeJS.ErrnoException).code === "ESRCH") exited=true; } }
          if (unchanged && exited && !await portOpen(this.settings.port,this.settings.probeHost)) { await this.restoreCode(); await this.restartRestored(error); }
          else await this.save({state:"needs_attention",rollback:"manual_required",message:"启动未确认或数据库已变化；保留隔离/原备份，不盲回退、不强杀："+String(error),nextAction:"inspect_original_receipts_and_process"});
        }
      } else {
        const ambiguous=this.record.state === "stopping";
        await this.save({state:ambiguous ? "needs_attention" : "failed",rollback:ambiguous ? "manual_required" : "not_needed",message:String(error),nextAction:ambiguous ? "inspect_original_receipts_and_process" : "inspect_check_log"});
      }
      } catch (rollbackError) {
        await this.save({state:"needs_attention",rollback:"manual_required",message:"升级/回退未确认，保留原ID与数据，不再启动："+String(error)+"；"+String(rollbackError),nextAction:"inspect_original_receipts_and_process"});
      }
      throw error;
    } finally { await this.unlock(); }
  }
}

export async function launchUpgradeWorker(script: string, operationId: string, settings: UpgradeSettings) {
  upgradeId.parse(operationId);
  const directory=path.join(settings.dataDirectory,"maintenance","upgrades"); await mkdir(directory,{recursive:true});
  const dispatch=await open(path.join(directory,operationId+".dispatch.json"),"wx");
  try { await dispatch.writeFile(JSON.stringify({operationId,createdAt:timestamp(),nextAction:"read_same_id_never_redispatch"})); } finally { await dispatch.close(); }
  const log=await open(path.join(directory,operationId+".log"),"a");
  try {
    const child: ChildProcess=spawn(process.execPath,["--import","tsx",script,"run","--id",operationId],{cwd:settings.root,env:settings.environment ?? process.env,windowsHide:true,detached:true,stdio:["ignore",log.fd,log.fd]});
    await new Promise<void>((resolve,reject)=>{child.once("error",reject);child.once("spawn",resolve);}); child.unref();
    return {operationId,supervisorPid:child.pid,nextAction:"read_upgrade_status_same_id"};
  } finally { await log.close(); }
}
