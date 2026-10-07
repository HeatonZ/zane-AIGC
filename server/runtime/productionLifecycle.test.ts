import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunRecord } from "../domain/types.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import { ProductionLifecycle } from "./productionLifecycle.js";

async function harness(t: test.TestContext) {
  const directory=await mkdtemp(path.join(os.tmpdir(),"zane-production-lifecycle-"));
  const store=new SqliteStore(path.join(directory,"zane.db"));t.after(()=>store.close());
  const metrics={queued:0,active:0,preparing:0,ready:true};let shutdowns=0;
  const lifecycle=new ProductionLifecycle({dataDirectory:directory,port:61234,store,metrics:()=>metrics,shutdown:async()=>{shutdowns++;}});
  const identity={pid:lifecycle.lease.pid,instanceId:lifecycle.lease.instanceId,key:lifecycle.lease.key};
  const run: RunRecord={runId:randomUUID(),sceneId:"fixture",workflowName:"local",status:"waiting",createdAt:new Date().toISOString(),startedAt:new Date().toISOString(),artifacts:{directory:path.join(directory,"runs"),inputs:"input.json",workflow:"workflow.json",runtime:"runtime.json",output:"result.json"},workflow:{inputs:[],steps:[],outputs:[]},inputValues:{},steps:[],outputs:[]};
  return {directory,store,metrics,lifecycle,identity,run,shutdowns:()=>shutdowns};
}

test("正常切换核对新鲜实例、参数和持久化 waiting；忙碌拒绝不关闭或备份",async t=>{
  const h=await harness(t);
  assert.equal((await h.lifecycle.request({...h.identity,pid:h.identity.pid+1,action:"inspect"})).code,"PROCESS_IDENTITY_CHANGED");
  assert.equal((await h.lifecycle.request({...h.identity,instanceId:randomUUID(),action:"shutdown",operationId:randomUUID()})).code,"PROCESS_IDENTITY_CHANGED");
  assert.equal((await h.lifecycle.request({...h.identity,action:"shutdown",operationId:"../unsafe"})).code,"INVALID_CONTROL_REQUEST");
  h.store.createRun(h.directory,h.run,{});
  const rejected=await h.lifecycle.request({...h.identity,action:"shutdown",operationId:randomUUID()});assert.equal(rejected.code,"WORKBENCH_BUSY");assert.deepEqual(rejected.unfinished,{waiting:1});assert.equal(h.shutdowns(),0);
  h.run.status="completed";h.store.saveRun(h.directory,h.run,[]);h.metrics.preparing=1;
  assert.equal((await h.lifecycle.request({...h.identity,action:"shutdown",operationId:randomUUID()})).code,"WORKBENCH_BUSY");
});

test("空闲升级先备份 SQLite 和配置，重复 operationId/丢回执按原 ID 读取，不再做一份备份",async t=>{
  const h=await harness(t);h.run.status="completed";h.store.createRun(h.directory,h.run,{});
  await writeFile(path.join(h.directory,"connections.json"),JSON.stringify({projectDirectory:h.directory}));
  await writeFile(path.join(h.directory,"workspace.json"),JSON.stringify({revision:3}));
  const operationId=randomUUID(),args={...h.identity,action:"shutdown",operationId};
  const [first,duplicate]=await Promise.all([h.lifecycle.request(args),h.lifecycle.request(args)]);
  assert.equal(first.ok,true);assert.deepEqual(duplicate,first);
  const backupDirectory=String(first.backupDirectory);
  const receipt=JSON.parse(await readFile(path.join(backupDirectory,"receipt.json"),"utf8"));assert.equal(receipt.operationId,operationId);assert.equal(receipt.instanceId,h.identity.instanceId);assert.ok(!("key" in receipt));
  const backup=new DatabaseSync(path.join(backupDirectory,"zane.db"),{readOnly:true});try{assert.equal((backup.prepare("SELECT status FROM runs WHERE run_id=?").get(h.run.runId) as {status:string}).status,"completed");}finally{backup.close();}
  assert.equal(JSON.parse(await readFile(path.join(backupDirectory,"workspace.json"),"utf8")).revision,3);
  assert.equal((await h.lifecycle.request({...args,operationId:randomUUID()})).code,"UPGRADE_ALREADY_PENDING");
});

test("备份失败不触发关闭，并恢复接收请求；生命周期标记不是第二份业务数据库",async t=>{
  const h=await harness(t);h.store.backupTo=async()=>{throw new Error("isolated-disk-failure");};
  const result=await h.lifecycle.request({...h.identity,action:"shutdown",operationId:randomUUID()});assert.equal(result.code,"BACKUP_FAILED");assert.equal(h.shutdowns(),0);
  let next=false;
  const response={once:()=>undefined};h.lifecycle.middleware({method:"GET",path:"/api/health"} as never,response as never,()=>{next=true;});assert.equal(next,true);
});

test("忙碌不是接受停机；原operationId在任务完成后可再次申请，启动隔离只允许健康读取并显式激活", async t => {
  const h=await harness(t);
  const operationId=randomUUID();
  h.metrics.active=1;
  assert.equal((await h.lifecycle.request({...h.identity,action:"shutdown",operationId})).code,"WORKBENCH_BUSY");
  h.metrics.active=0;
  assert.equal((await h.lifecycle.request({...h.identity,action:"shutdown",operationId})).ok,true);
  const bootId=randomUUID();
  const candidate=new ProductionLifecycle({dataDirectory:h.directory,port:61235,store:h.store,metrics:()=>h.metrics,shutdown:async()=>{},releaseId:"new-release",upgradeOperationId:bootId});
  const identity={pid:candidate.lease.pid,instanceId:candidate.lease.instanceId,key:candidate.lease.key};
  let code=0,nexts=0;
  const response={status(value:number){code=value;return this;},json(){return this;},once(){return this;}};
  candidate.middleware({path:"/api/v1/runs",method:"POST"} as never,response as never,()=>nexts++);
  assert.equal(code,503);assert.equal(nexts,0);
  candidate.middleware({path:"/api/ready",method:"GET"} as never,response as never,()=>nexts++);assert.equal(nexts,1);
  assert.equal((await candidate.request({...identity,action:"inspect"})).serving,false);
  assert.equal((await candidate.request({...identity,action:"activate",operationId:randomUUID()})).code,"INVALID_ACTIVATION");
  assert.equal((await candidate.request({...identity,action:"activate",operationId:bootId})).serving,true);
  assert.equal((await candidate.request({...identity,action:"activate",operationId:bootId})).serving,true);
  candidate.middleware({path:"/api/v1/runs",method:"POST"} as never,response as never,()=>nexts++);assert.equal(nexts,2);
});
