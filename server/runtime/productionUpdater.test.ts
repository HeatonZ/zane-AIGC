import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProductionUpdater, databaseFingerprint, type UpgradeDependencies, type UpgradeSettings } from "./productionUpdater.js";
import { atomicJson } from "./mcpReload.js";
import { temporaryDirectory, deferred } from "../testing/testSupport.js";
import { readUpgradeStatus } from "../services/workbenchUpdateService.js";
import { upgradeStatusSchema } from "../domain/workbenchUpdateContracts.js";

async function fixture(t: test.TestContext) {
  const root=await temporaryDirectory(t), dataDirectory=path.join(root,"data"), leaseFile=path.join(dataDirectory,"production-runtime.json");
  await mkdir(dataDirectory);
  await writeFile(path.join(root,"package.json"),JSON.stringify({type:"module"}));
  for (const directory of ["dist","dist-server"]) await mkdir(path.join(root,directory));
  await writeFile(path.join(root,"dist/index.html"),"old-web"); await writeFile(path.join(root,"dist-server/index.js"),"old-server");
  await symlink(path.resolve("node_modules"),path.join(root,"node_modules"),process.platform === "win32" ? "junction" : "dir");
  const database=path.join(dataDirectory,"zane.db");
  const db=new DatabaseSync(database);db.exec("CREATE TABLE fixture (id TEXT PRIMARY KEY,value TEXT); INSERT INTO fixture VALUES ('preserved','original');");db.close();
  const metrics={ready:true,queued:0,active:0,preparing:0}, unfinished:Record<string,number>={};
  let current={schemaVersion:1 as const,pid:process.pid,instanceId:randomUUID(),key:randomUUID(),port:65432,root,entry:path.join(root,"dist-server/index.js"),socket:"test-socket",startedAt:new Date().toISOString()};
  let serving=true,releaseId="old-release",bootId:string|undefined;
  await atomicJson(leaseFile,current);
  const calls:{action:string;operationId?:string}[]=[], starts:{operationId:string;releaseId:string}[]=[];
  const settings:UpgradeSettings={root,dataDirectory,port:65432,probeHost:"127.0.0.1",leaseFile};
  let lostShutdown=false,lostActivation=false,busyRace=false,health=true,changedDatabase=false;
  const dependencies:UpgradeDependencies={
    verifyProcess:async lease=>{assert.equal(lease.instanceId,current.instanceId);},
    control:async(lease,action,operationId)=>{
      assert.equal(lease.instanceId,current.instanceId);calls.push({action,operationId});
      if (action === "inspect") return {ok:true,...current,metrics:{...metrics},unfinished:{...unfinished},serving,releaseId,upgradeOperationId:bootId};
      if (action === "shutdown") {
        if (busyRace) {busyRace=false;return {ok:false,code:"WORKBENCH_BUSY"};}
        const directory=path.join(dataDirectory,"backups","restart-"+operationId);await mkdir(directory,{recursive:true});
        const source=new DatabaseSync(database,{readOnly:true});try{await backup(source,path.join(directory,"zane.db"));}finally{source.close();}
        const receipt={ok:true,pid:current.pid,instanceId:current.instanceId,operationId,backupDirectory:directory,closedAt:new Date().toISOString()};
        await atomicJson(path.join(directory,"receipt.json"),receipt);
        if (lostShutdown) {lostShutdown=false;throw new Error("shutdown reply lost");}
        return receipt;
      }
      if (action === "activate") {
        assert.equal(operationId,bootId);serving=true;
        if (lostActivation) {lostActivation=false;throw new Error("activation reply lost");}
        return {ok:true,instanceId:current.instanceId,serving};
      }
      throw new Error("unknown action");
    },
    runCheck:async(snapshot,_log,id)=>{
      assert.equal(calls.filter(call=>call.action === "shutdown").length,0);
      assert.equal(await readFile(path.join(root,"dist-server/index.js"),"utf8"),"old-server");
      assert.ok(!await import("node:fs/promises").then(fs=>fs.stat(path.join(snapshot,"data")).catch(()=>false)));
      for (const directory of ["dist","dist-server"]) await mkdir(path.join(snapshot,directory));
      await writeFile(path.join(snapshot,"dist/index.html"),"new-web-"+id); await writeFile(path.join(snapshot,"dist-server/index.js"),"new-server-"+id);
    },
    start:async(_settings,operationId,nextRelease)=>{
      starts.push({operationId,releaseId:nextRelease}); releaseId=nextRelease;bootId=operationId;serving=false;
      current={...current,instanceId:randomUUID(),key:randomUUID()};await atomicJson(leaseFile,current);
      if (changedDatabase && nextRelease !== "old-release") {const db=new DatabaseSync(database);db.exec("INSERT INTO fixture VALUES ('migration','changed')");db.close();}
      return process.pid;
    },
    health:async()=>health || releaseId === "old-release",
    sleep:async()=>{delete unfinished.waiting;metrics.active=0;},
  };
  return {root,dataDirectory,settings,dependencies,calls,starts,metrics,unfinished,database,updater:()=>new ProductionUpdater(settings,dependencies),
    setLostShutdown:()=>{lostShutdown=true;},setLostActivation:()=>{lostActivation=true;},setBusyRace:()=>{busyRace=true;},failHealth:(change=false)=>{health=false;changedDatabase=change;},replaceInstance:async()=>{current={...current,instanceId:randomUUID()};await atomicJson(leaseFile,current);}};
}

test("先隔离验收，不覆盖旧产物或数据；等人工审核归零再切换，原ID停机/激活丢回执只对账", async t=>{
  const h=await fixture(t), updater=h.updater(), id=randomUUID(), before=databaseFingerprint(h.database);
  const ready=await updater.prepare(id);assert.equal(ready.state,"ready");assert.equal(ready.checkPassed,true);
  assert.equal(await readFile(path.join(h.root,"dist-server/index.js"),"utf8"),"old-server");assert.equal(databaseFingerprint(h.database),before);
  h.unfinished.waiting=1;h.setLostShutdown();h.setLostActivation();
  const done=await updater.apply(id,{pollMs:1});assert.equal(done.state,"completed");assert.equal(done.servingConfirmed,true);
  assert.equal(h.calls.filter(call=>call.action==="shutdown").length,1);assert.equal(h.calls.filter(call=>call.action==="activate").length,1);assert.equal(h.starts.length,1);
  assert.equal(databaseFingerprint(h.database),before);assert.equal(done.oldReleaseId,"old-release");
  assert.equal(upgradeStatusSchema.parse(await readUpgradeStatus(h.dataDirectory,id)).operation?.state,"completed");
  assert.deepEqual((await updater.apply(id)).state,"completed");assert.equal(h.starts.length,1);
});

test("已确认busy竞争可用同一ID等待；产物修改、非法ID、旧revision与实例变化拒绝，不停止其他服务",async t=>{
  const h=await fixture(t), updater=h.updater(), id=randomUUID();await updater.prepare(id);h.setBusyRace();
  assert.equal((await updater.apply(id,{pollMs:1})).state,"completed");
  assert.deepEqual(h.calls.filter(call=>call.action==="shutdown").map(call=>call.operationId),[id,id]);
  const other=await fixture(t), next=other.updater(), nextId=randomUUID();const ready=await next.prepare(nextId);
  await assert.rejects(next.cancel(nextId,ready.revision-1),/revision/);
  await assert.rejects(next.prepare("../unsafe"));
  await writeFile(path.join(other.root,".local/upgrades",nextId,"next/dist-server/index.js"),"tampered");
  await assert.rejects(next.apply(nextId),/产物被修改/);assert.equal(other.calls.filter(call=>call.action==="shutdown").length,0);
});

test("取消仅关停前有效；读取不重放，验收失败和并发升级均不影响旧工作台",async t=>{
  const h=await fixture(t), updater=h.updater(), id=randomUUID();const ready=await updater.prepare(id);await updater.cancel(id,ready.revision);
  assert.equal((await updater.apply(id)).state,"cancelled");assert.equal(h.calls.length,0);
  await assert.rejects(updater.cancel(id,(await updater.status(id)).revision),/不允许取消/);
  const other=await fixture(t), gate=deferred<void>();
  other.dependencies.runCheck=async()=>{await gate.promise;throw new Error("isolated check failure");};
  const first=other.updater(), firstId=randomUUID(), preparing=first.prepare(firstId);
  await new Promise(resolve=>setTimeout(resolve,20));
  await assert.rejects(other.updater().prepare(randomUUID()),/升级持有锁/);gate.resolve();await assert.rejects(preparing,/check failure/);
  assert.equal((await first.status(firstId)).state,"failed");assert.equal(other.calls.length,0);assert.equal(await readFile(path.join(other.root,"dist/index.html"),"utf8"),"old-web");
});

test("新版本健康失败且数据未变时正常关停隔离候选，自动恢复并启动旧代码；数据库变化禁止盲回退",async t=>{
  const h=await fixture(t), updater=h.updater(), id=randomUUID(), before=databaseFingerprint(h.database);await updater.prepare(id);h.failHealth();
  await assert.rejects(updater.apply(id,{healthTimeoutMs:15}),/健康|隔离/);
  const failed=await updater.status(id);assert.equal(failed.state,"failed");assert.equal(failed.rollback,"code_restored");assert.equal(failed.servingConfirmed,true);
  assert.equal(h.starts.length,2);assert.equal(h.starts[1].releaseId,"old-release");assert.equal(await readFile(path.join(h.root,"dist-server/index.js"),"utf8"),"old-server");assert.equal(databaseFingerprint(h.database),before);
  const other=await fixture(t), update=other.updater(), nextId=randomUUID();await update.prepare(nextId);other.failHealth(true);
  await assert.rejects(update.apply(nextId,{healthTimeoutMs:15}));const attention=await update.status(nextId);
  assert.equal(attention.state,"needs_attention");assert.equal(attention.rollback,"manual_required");assert.equal(other.starts.length,1);
  assert.equal(other.calls.filter(call=>call.action==="shutdown").length,1);assert.notEqual(databaseFingerprint(other.database),before);
});

test("停机回执未知不重复停机、不换ID、不启动；recover不接管仍存在的进程",async t=>{
  const h=await fixture(t), updater=h.updater(), id=randomUUID();await updater.prepare(id);
  const original=h.dependencies.control;
  h.dependencies.control=async(lease,action,operationId)=>{if(action==="shutdown"){h.calls.push({action,operationId});throw new Error("receipt unknown");}return original(lease,action,operationId);};
  await assert.rejects(updater.apply(id),/回执未知/);assert.equal((await updater.status(id)).state,"needs_attention");assert.equal(h.starts.length,0);
  assert.equal(h.calls.filter(call=>call.action==="shutdown").length,1);
  await atomicJson(path.join(h.dataDirectory,"maintenance/upgrades/lock.json"),{operationId:id,pid:process.pid,token:randomUUID()});
  await assert.rejects(updater.recover(id),/进程仍存在/);
});

test("逻辑指纹与页布局无关，覆盖schema/数据变化；未找到和错误回执明确失败",async t=>{
  const h=await fixture(t), before=databaseFingerprint(h.database), clone=path.join(h.dataDirectory,"copy.db");await cp(h.database,clone);
  const db=new DatabaseSync(clone);db.exec("VACUUM");assert.equal(databaseFingerprint(clone),before);db.exec("CREATE TABLE changed (id TEXT)");db.close();assert.notEqual(databaseFingerprint(clone),before);
  assert.equal((await readUpgradeStatus(h.dataDirectory)).operation,null);
  await assert.rejects(readUpgradeStatus(h.dataDirectory,randomUUID()),(error:any)=>error.code==="UPGRADE_NOT_FOUND");
  await assert.rejects(readUpgradeStatus(h.dataDirectory,"../unsafe"),(error:any)=>error.code==="INVALID_AI_REQUEST");
});

test("等待期间实例变化停止升级；忙碌等待超时保留原ID与旧实例",async t=>{
  const h=await fixture(t), updater=h.updater(), id=randomUUID();await updater.prepare(id);h.metrics.active=1;
  h.dependencies.sleep=async()=>{await h.replaceInstance();h.metrics.active=0;};
  // Construct after changing dependencies because sleep is fixed per manager instance.
  await assert.rejects(h.updater().apply(id,{pollMs:1}),/实例变化/);
  assert.equal(h.calls.filter(call=>call.action==="shutdown").length,0);assert.equal(h.starts.length,0);
  const other=await fixture(t), nextId=randomUUID();await other.updater().prepare(nextId);other.metrics.active=1;other.dependencies.sleep=async()=>new Promise(resolve=>setTimeout(resolve,5));
  const pending=await other.updater().apply(nextId,{waitTimeoutMs:10,pollMs:1});assert.equal(pending.state,"waiting");assert.equal(pending.nextAction,"apply_same_operation_id");
  assert.equal(other.calls.filter(call=>call.action==="shutdown").length,0);
});

test("首次启动先离线备份，不停止已存在PID或重放未完成任务",async t=>{
  const h=await fixture(t), updater=h.updater(), id=randomUUID();await updater.prepare(id);
  await assert.rejects(updater.install(id),/旧进程仍存在/);assert.equal(h.starts.length,0);
  const other=await fixture(t), next=other.updater(), nextId=randomUUID();await next.prepare(nextId);
  const lease=JSON.parse(await readFile(other.settings.leaseFile,"utf8"));lease.pid=2147483000;await atomicJson(other.settings.leaseFile,lease);
  const db=new DatabaseSync(other.database);db.exec("CREATE TABLE runs (status TEXT); INSERT INTO runs VALUES ('waiting')");db.close();
  await assert.rejects(next.install(nextId),/未完成任务或审核/);assert.equal(other.starts.length,0);
});
