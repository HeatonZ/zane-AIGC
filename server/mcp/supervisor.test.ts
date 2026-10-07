import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { atomicJson } from "../runtime/mcpReload.js";

async function eventually(predicate: () => Promise<boolean> | boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("isolated MCP restart timeout");
}
async function harness(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zane-mcp-restart-"));
  const versionFile = path.join(directory, "version.txt"), callsFile = path.join(directory, "calls.ndjson"), marker = path.join(directory, "runtime.json");
  await writeFile(versionFile, "test-v1"); await writeFile(callsFile, "");
  const base = "http://127.0.0.1:61987";
  const worker = path.join(directory, "worker.mjs");
  await writeFile(worker, `import {createInterface} from 'node:readline';
import {readFileSync, appendFileSync} from 'node:fs';
const version=readFileSync(${JSON.stringify(versionFile)},'utf8');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const reply=(id,result)=>send({jsonrpc:'2.0',id,result});
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line); if(!('id' in message))return;
 if(message.method==='initialize'){const ready=()=>reply(message.id,{protocolVersion:message.params.protocolVersion,serverInfo:{name:'fixture',version},capabilities:{tools:{listChanged:true},resources:{listChanged:true},prompts:{listChanged:true}}});if(version==='test-v2')setTimeout(ready,150);else ready();}
 else if(message.method==='tools/list')reply(message.id,{tools:[{name:'read_state',inputSchema:{type:'object'}},...(version==='test-v2'?[{name:'new_fixture_tool',inputSchema:{type:'object'}}]:[])]});
 else if(message.method==='tools/call'){
  const args=message.params.arguments??{};
  if(message.params.name==='write_probe')appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({runId:args.runId,pid:process.pid})+'\\n');
  if(args.crash){process.exit(2);return;}
  const finish=()=>reply(message.id,{content:[{type:'text',text:version}],structuredContent:{pid:process.pid,version}});
  if(args.delay)setTimeout(finish,args.delay);else finish();
 }else reply(message.id,{});
});
process.on('message',message=>{if(message.type==='zane-mcp-catalog-changed')for(const kind of ['tools','resources','prompts'])send({jsonrpc:'2.0',method:'notifications/'+kind+'/list_changed'});});
process.stdin.on('end',()=>process.exit(0));
process.send?.({type:'zane-mcp-ready',contractVersion:version});`);
  const runner = path.join(directory, "runner.mjs");
  await writeFile(runner, `import {McpSupervisor} from ${JSON.stringify(pathToFileURL(path.resolve("server/mcp/supervisor.ts")).href)};
const supervisor=new McpSupervisor({workerEntry:${JSON.stringify(worker)},baseUrl:${JSON.stringify(base)},markerFile:${JSON.stringify(marker)},pollMs:25,execArgv:[]});
await supervisor.start(); process.once('SIGTERM',()=>{void supervisor.close();});`);
  const transport = new StdioClientTransport({command:process.execPath,args:["--import","tsx",runner],cwd:process.cwd(),stderr:"pipe"});
  let logs = "", nextId = 0; const notifications: string[] = [];
  transport.stderr?.on("data", chunk => { logs += chunk.toString(); });
  const pending = new Map<string, {resolve(value: Record<string, unknown>): void; reject(error: Error): void}>();
  transport.onmessage = message => {
    if ("method" in message) { notifications.push(message.method); return; }
    const id=String(message.id); const waiter=pending.get(id);if(waiter){pending.delete(id);waiter.resolve(message as unknown as Record<string,unknown>);}
  };
  transport.onerror = error => { for(const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  await transport.start();
  t.after(async () => { await transport.close(); });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id=++nextId;
    const result=new Promise<Record<string,unknown>>((resolve,reject)=>pending.set(String(id),{resolve,reject}));
    await transport.send({jsonrpc:"2.0",id,method,params});
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([result,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("stdio request timed out\n"+logs)),15000);})]); }
    finally {clearTimeout(timer!);pending.delete(String(id));}
  };
  const initialized=await request("initialize",{protocolVersion:"2024-11-05",clientInfo:{name:"isolated-test",version:"1"},capabilities:{}});
  assert.ok(initialized.result); await transport.send({jsonrpc:"2.0",method:"notifications/initialized"});
  const state=async()=>((await request("tools/call",{name:"read_state",arguments:{}})).result as {structuredContent:{pid:number;version:string}}).structuredContent;
  const restart = async (version: string, origin=base) => {
    await writeFile(versionFile,version);
    const generation=randomUUID(); await atomicJson(marker,{schemaVersion:1,generation,baseUrl:origin,contractVersion:version,pid:123,startedAt:new Date().toISOString()}); return generation;
  };
  return {request,state,restart,notifications,logs:()=>logs,calls:async()=> (await readFile(callsFile,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)), versionFile, marker, base};
}

test("MCP 常驻 stdio：新后台代次替换子进程、刷新目录，保留客户端连接和发现操作", {timeout:30000}, async t => {
  const h=await harness(t); const before=await h.state();
  assert.equal(before.version,"test-v1"); const generation=await h.restart("test-v2");
  await eventually(()=>h.logs().includes('"event":"restarted"') && h.logs().includes(generation));
  const after=await h.state(); assert.notEqual(after.pid,before.pid);assert.equal(after.version,"test-v2");
  await eventually(()=>h.notifications.includes("notifications/tools/list_changed"));
  assert.ok(h.notifications.includes("notifications/resources/list_changed"));assert.ok(h.notifications.includes("notifications/prompts/list_changed"));
  const catalog=(await h.request("tools/list")).result as {tools:Array<{name:string}>};assert.ok(catalog.tools.some(tool=>tool.name==="new_fixture_tool"));
});

test("MCP 切换等在途写入回执，不重放已发送的工具调用", {timeout:30000}, async t => {
  const h=await harness(t);const before=await h.state();const runId=randomUUID();
  const pending=h.request("tools/call",{name:"write_probe",arguments:{runId,delay:500}});
  await eventually(async()=> (await h.calls()).length===1);
  await h.restart("test-v2"); await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(!h.logs().includes('"event":"restarted"'));
  const response=await pending;assert.equal((response.result as {structuredContent:{pid:number}}).structuredContent.pid,before.pid);
  await eventually(()=>h.logs().includes('"event":"restarted"'));
  assert.equal((await h.state()).version,"test-v2");assert.deepEqual((await h.calls()).map(call=>call.runId),[runId]);
});

test("MCP 子进程丢失写入回执时明确 unknown，自动重建仅恢复连接，不再次提交", {timeout:30000}, async t => {
  const h=await harness(t);const before=await h.state();const runId=randomUUID();
  const lost=await h.request("tools/call",{name:"write_probe",arguments:{runId,crash:true}});
  const error=lost.error as {data:{code:string;outcome:string}};assert.equal(error.data.code,"MCP_RESPONSE_UNCONFIRMED");assert.equal(error.data.outcome,"unknown");
  await eventually(()=>h.logs().includes('"event":"restarted"'));
  assert.notEqual((await h.state()).pid,before.pid);assert.deepEqual((await h.calls()).map(call=>call.runId),[runId]);
});

test("MCP 忽略其他后台/损坏标记；新适配器契约不匹配保留原进程，下次有效代次可恢复", {timeout:30000}, async t => {
  const h=await harness(t);const before=await h.state();
  await h.restart("test-v1","http://127.0.0.1:61988");await new Promise(resolve=>setTimeout(resolve,100));assert.equal((await h.state()).pid,before.pid);
  await writeFile(h.marker,"{invalid");await new Promise(resolve=>setTimeout(resolve,80));assert.equal((await h.state()).pid,before.pid);
  await atomicJson(h.marker,{schemaVersion:1,generation:randomUUID(),baseUrl:h.base,contractVersion:"non-matching"});
  await eventually(()=>h.logs().includes('"event":"restart_failed"'));assert.equal((await h.state()).pid,before.pid);
  await h.restart("test-v2");await eventually(()=>h.logs().includes('"event":"restarted"'));assert.equal((await h.state()).version,"test-v2");
});

test("切换期间新写入明确拒绝，快速新代次最终追上最新标记，不重复重建或执行", {timeout:30000}, async t=>{
  const h=await harness(t);const first=await h.restart("test-v2");
  await eventually(()=>h.logs().includes('"event":"restarting"') && h.logs().includes(first));
  const latest=await h.restart("test-v2");
  const rejected=await h.request("tools/call",{name:"write_probe",arguments:{runId:randomUUID()}});
  assert.equal((rejected.error as {data:{code:string;outcome:string}}).data.code,"MCP_RESTARTING");
  assert.equal((rejected.error as {data:{outcome:string}}).data.outcome,"rejected");
  await eventually(()=>h.logs().split("\n").some(line=>line.includes('"event":"restarted"') && line.includes(latest)));
  assert.equal((await h.state()).version,"test-v2");assert.equal((await h.calls()).length,0);
});
