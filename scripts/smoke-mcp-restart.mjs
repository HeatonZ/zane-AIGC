import "./smoke-auth.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { root, controlRequest } from "./production-runtime.mjs";

const temporary=await mkdtemp(path.join(os.tmpdir(),"zane-mcp-restart-smoke-"));
const project=path.join(temporary,"project"),dataDirectory=path.join(temporary,"data"),marker=path.join(temporary,"mcp-generation.json");await mkdir(project);
let backend,backendExit,base,logs="",mcpLogs="",changes=0;const started=[];
const env={...process.env,API_HOST:"127.0.0.1",APP_DATA_DIR:dataDirectory,ZANE_PROJECT_DIR:project,ZANE_MCP_RELOAD_FILE:marker,HERMES_HOME:path.join(temporary,"no-hermes"),COMFYUI_BASE_URL:"http://127.0.0.1:1"};
const bounded=async(promise,ms=60000)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("restart smoke timeout\n"+logs.slice(-1500)+mcpLogs.slice(-1500))),ms);})]);}finally{clearTimeout(timer);}};
const eventually=async predicate=>{const until=Date.now()+20000;while(Date.now()<until){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error("restart smoke state timeout\n"+mcpLogs.slice(-2000));};
async function start(port="0"){
  let currentLogs="";
  backend=spawn(process.execPath,[path.join(root,"dist-server/index.js"),"--production"],{cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...env,API_PORT:port}});
  const active=backend;started.push(active);backendExit=new Promise(resolve=>active.once("exit",resolve));
  base=await bounded(new Promise((resolve,reject)=>{active.once("error",reject);active.once("exit",code=>reject(new Error("backend exited "+code+"\n"+currentLogs)));const observe=chunk=>{currentLogs+=chunk;logs+=chunk;const match=/server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(currentLogs);if(match)resolve(match[1]);};active.stdout.on("data",observe);active.stderr.on("data",observe);}));
  await eventually(()=>currentLogs.includes('"event":"server.mcp_reload_published"'));
  return JSON.parse(await readFile(marker,"utf8"));
}
async function stopScript(){
  const child=spawn(process.execPath,[path.join(root,"scripts/stop-production-server.mjs")],{cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...env,API_PORT:new URL(base).port}});
  let output="";child.stdout.on("data",chunk=>output+=chunk);child.stderr.on("data",chunk=>output+=chunk);
  return {code:await bounded(new Promise(resolve=>child.once("exit",resolve))),output};
}
const client=new Client({name:"mcp-production-restart-smoke",version:"1"});
client.setNotificationHandler("notifications/tools/list_changed",()=>{changes++;});
let transport;
try{
  const initial=await start();
  transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,"dist-server/mcp/index.js")],cwd:root,env:{...env,ZANE_BASE_URL:base},stderr:"pipe"});transport.stderr?.on("data",chunk=>mcpLogs+=chunk);
  await bounded(client.connect(transport));const supervisorPid=transport.pid;
  const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args});assert.ok(!result.isError && result.structuredContent?.ok,name+": "+JSON.stringify(result));return result.structuredContent.data;};
  await call("initialize_workspace",{format:"zane-studio.workspace/v1",scenes:[],workflows:{},optionPresets:[],drafts:[],sceneVersions:{}});
  const sceneId="mcp-restart-local-proof";
  const condition={id:"local-check",name:"本地核验",kind:"control",review:{enabled:true,instruction:"仅隔离本地条件节点"},outputs:[{key:"result",type:"boolean"}],control:{type:"condition",match:"all",rules:[{id:"rule",leftRef:"input.flag",operator:"equals",valueSource:"literal",rightValue:"true",rightRef:""}]}};
  const workflow={inputs:[{key:"flag",type:"boolean",required:true,defaultValue:true}],steps:[condition],outputs:[{key:"result",type:"boolean",sourceRef:"step.local-check.outputs.result"}]};
  const draft=await call("create_scene",{scene:{id:sceneId,title:"MCP 重启隔离验收"},workflow});
  const publication=await call("publish_scene",{sceneId,revision:draft.revision,publicationId:randomUUID()});
  const runId=randomUUID();await call("submit_scene",{sceneId,versionId:publication.versionId,runId,inputValues:{}});
  const waiting=await call("wait_run",{runId,timeoutSeconds:2});assert.equal(waiting.status,"waiting");
  const busy=await stopScript();assert.equal(busy.code,1,busy.output);assert.match(busy.output,/WORKBENCH_BUSY/);assert.match(busy.output,/waiting/);assert.equal((await call("get_workbench")).worker.ready,true);
  await call("review_run",{runId,reviewId:waiting.pendingReview.id,action:"approve"});assert.equal((await call("wait_run",{runId,timeoutSeconds:2})).status,"completed");
  const stopped=await stopScript();assert.equal(stopped.code,0,stopped.output);assert.equal(await bounded(backendExit),0);
  const offline=await client.callTool({name:"get_workbench",arguments:{}});assert.equal(offline.isError,true);assert.equal(offline.structuredContent.error.outcome,"read_failed");
  const second=await start(new URL(base).port);assert.notEqual(second.generation,initial.generation);
  await eventually(()=>mcpLogs.includes('"event":"restarted"') && mcpLogs.includes(second.generation));
  await eventually(()=>changes>0);
  assert.equal(transport.pid,supervisorPid,"client transport stays alive");
  assert.equal((await call("get_workbench")).worker.ready,true);
  assert.equal((await call("get_run",{runId})).status,"completed");assert.equal((await call("list_runs")).runs.length,1,"restart never replays the run");
  const resources=await client.listResources();assert.ok(resources.resources.some(resource=>resource.uri==="zane://guide"));await client.readResource({uri:"zane://guide"});await client.listTools();await client.listPrompts();
  // Drop an accepted control reply deliberately; the original durable receipt
  // and closed marker, not a repeated shutdown, confirm the final idle stop.
  const lease=JSON.parse(await readFile(path.join(dataDirectory,"production-runtime.json"),"utf8"));
  const operationId=randomUUID();await controlRequest(lease,"shutdown",operationId);assert.equal(await bounded(backendExit),0);
  const receipt=JSON.parse(await readFile(path.join(dataDirectory,"backups","restart-"+operationId,"receipt.json"),"utf8"));assert.ok(receipt.closedAt);assert.equal(receipt.operationId,operationId);
  const proof={status:"passed",temporary,base,supervisorPid,runId,compiledBackend:true,realStdioMcp:true,isolated:true,externalGeneration:false,hermesGatewayRestarted:false,comfyUiRestarted:false,checks:["fresh-process-identity","waiting-busy-rejection","SQLite-and-config-backup-before-shutdown","durable-closed-receipt","same-stdio-transport-after-production-restart","catalog-change-notification","HTTP-failure-no-replay","single-original-run-reconciled-after-restart","resources-and-prompts-after-restart"]};
  const proofDirectory=path.join(root,".local","mcp-restart-proof");await mkdir(proofDirectory,{recursive:true});await writeFile(path.join(proofDirectory,"acceptance.json"),JSON.stringify(proof,null,2)+"\n");console.log(JSON.stringify(proof,null,2));
}catch(error){console.error(logs.slice(-2500)+"\n"+mcpLogs.slice(-2500));throw error;}
finally{
  await client.close().catch(()=>undefined);
  for(const child of started){if(child.exitCode===null && child.signalCode===null)child.kill("SIGTERM");}
}
