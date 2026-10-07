import "./smoke-auth.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ProductionUpdater, portOpen } from "../server/runtime/productionUpdater.ts";
import { controlRequest, verifyProcess, root } from "./production-runtime.mjs";

const temporary=await mkdtemp(path.join(os.tmpdir(),"zane-safe-upgrade-smoke-"));
const fixture=path.join(temporary,"fixture"),dataDirectory=path.join(temporary,"data"),project=path.join(temporary,"project"),marker=path.join(temporary,"mcp-generation.json");
await mkdir(fixture);await mkdir(project);await writeFile(path.join(fixture,"package.json"),JSON.stringify({type:"module"}));
for(const directory of ["dist-server","dist"]) await cp(path.join(root,directory),path.join(fixture,directory),{recursive:true});
await symlink(path.join(root,"node_modules"),path.join(fixture,"node_modules"),process.platform==="win32"?"junction":"dir");
const env={...process.env,APP_DATA_DIR:dataDirectory,ZANE_PROJECT_DIR:project,API_HOST:"127.0.0.1",API_PORT:"0",ZANE_MCP_RELOAD_FILE:marker,HERMES_HOME:path.join(temporary,"no-hermes"),COMFYUI_BASE_URL:"http://127.0.0.1:1",ZANE_RELEASE_ID:"old-smoke-release"};
let logs="",mcpLogs="",base,supervisorPid,transport,updater,applying;
const client=new Client({name:"safe-upgrade-proof",version:"1.0"});
const bounded=async(promise,ms=90000)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("upgrade smoke timeout\n"+logs.slice(-2000)+mcpLogs.slice(-1000))),ms);})]);}finally{clearTimeout(timer);}};
const eventually=async predicate=>{const until=Date.now()+60000;while(Date.now()<until){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error("upgrade smoke state timeout\n"+logs.slice(-1500)+mcpLogs.slice(-1000));};
const child=spawn(process.execPath,[path.join(fixture,"dist-server/index.js"),"--production"],{cwd:fixture,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
const exited=new Promise(resolve=>child.once("exit",resolve));
try {
  base=await bounded(new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>reject(new Error("old fixture exited "+code+"\n"+logs)));const observe=chunk=>{logs+=chunk;const match=/server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);if(match)resolve(match[1]);};child.stdout.on("data",observe);child.stderr.on("data",observe);}));
  await eventually(()=>logs.includes('"event":"server.mcp_reload_published"'));
  const port=Number(new URL(base).port),leaseFile=path.join(dataDirectory,"production-runtime.json");
  transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,"dist-server/mcp/index.js")],cwd:root,env:{...env,ZANE_BASE_URL:base},stderr:"pipe"});transport.stderr?.on("data",chunk=>mcpLogs+=chunk);
  await bounded(client.connect(transport));supervisorPid=transport.pid;
  const call=async(name,args={})=>{const response=await client.callTool({name,arguments:args});assert.ok(!response.isError && response.structuredContent?.ok,name+": "+JSON.stringify(response));return response.structuredContent.data;};
  assert.equal((await call("get_runtime_release")).releaseId,"old-smoke-release");
  assert.equal((await call("get_workbench_upgrade")).operation,null);
  await call("initialize_workspace",{format:"zane-studio.workspace/v1",scenes:[],workflows:{},optionPresets:[],drafts:[],sceneVersions:{}});
  const sceneId="safe-upgrade-local-proof";
  const workflow={inputs:[{key:"flag",type:"boolean",required:true,defaultValue:true}],steps:[{id:"condition",name:"隔离审核条件",kind:"control",review:{enabled:true},outputs:[{key:"result",type:"boolean"}],control:{type:"condition",match:"all",rules:[{id:"rule",leftRef:"input.flag",operator:"equals",valueSource:"literal",rightValue:"true",rightRef:""}]}}],outputs:[{key:"result",type:"boolean",sourceRef:"step.condition.outputs.result"}]};
  const draft=await call("create_scene",{scene:{id:sceneId,title:"安全升级隔离验收"},workflow});
  const publication=await call("publish_scene",{sceneId,revision:draft.revision,publicationId:randomUUID()});
  const runId=randomUUID();await call("submit_scene",{sceneId,versionId:publication.versionId,runId,inputValues:{}});
  const waiting=await call("wait_run",{runId,timeoutSeconds:2});assert.equal(waiting.status,"waiting");
  let bootFenceObserved=false;
  const control=async(lease,action,operationId)=>{
    if(action==="activate") {
      const response=await fetch(base+"/api/v1/self/runtime-release");assert.equal(response.status,503,"candidate business API must be fenced before activation");
      await response.body?.cancel();bootFenceObserved=true;
    }
    return controlRequest(lease,action,operationId);
  };
  const settings={root:fixture,dataDirectory,port,probeHost:"127.0.0.1",leaseFile,environment:{...env,API_PORT:String(port)}};
  updater=new ProductionUpdater(settings,{verifyProcess,control,runCheck:async(snapshot)=>{
    // The outer npm check already compiled/tested this snapshot. No CLI skip-check switch exists.
    for(const directory of ["dist-server","dist"]) await cp(path.join(root,directory),path.join(snapshot,directory),{recursive:true});
    assert.equal((await call("get_run",{runId})).status,"waiting","preparation must not stop the original server");
  }});
  const operationId=randomUUID();assert.equal((await updater.prepare(operationId)).state,"ready");
  applying=updater.apply(operationId,{pollMs:100});
  await eventually(async()=>{const status=await updater.status(operationId);return status.state==="waiting" && status.blocked?.unfinished?.waiting===1;});
  const recorded=await call("get_workbench_upgrade",{operationId});assert.equal(recorded.operation.state,"waiting");assert.equal((await call("get_run",{runId})).status,"waiting");
  assert.equal((await call("get_workbench")).worker.ready,true);
  await call("review_run",{runId,reviewId:waiting.pendingReview.id,action:"approve"});
  await call("wait_run",{runId,timeoutSeconds:5});
  const completed=await bounded(applying);assert.equal(completed.state,"completed");assert.equal(bootFenceObserved,true);assert.equal(await bounded(exited),0);
  assert.notEqual(completed.oldInstanceId,completed.newInstanceId);assert.equal(completed.oldPid,child.pid);
  const receipt=JSON.parse(await readFile(path.join(dataDirectory,"backups","restart-"+operationId,"receipt.json"),"utf8"));assert.ok(receipt.closedAt);
  await eventually(async()=>{try{return (await call("get_runtime_release")).releaseId===operationId;}catch{return false;}});
  assert.equal(transport.pid,supervisorPid,"same stdio MCP supervisor remains connected");
  assert.equal((await call("get_workbench_upgrade",{operationId})).operation.state,"completed");
  assert.equal((await call("get_run",{runId})).status,"completed");assert.equal((await call("get_run_outputs",{runId})).outputs[0].value,true);
  assert.equal((await call("list_runs",{limit:10})).runs.length,1,"upgrade must not enqueue another business run");
  console.log(JSON.stringify({status:"passed",temporary,isolated:true,formalServiceSwitched:false,externalGeneration:false,hermesGatewayRestarted:false,comfyUiRestarted:false,checks:["isolated-preparation-old-service-alive","waiting-review-not-auto-approved","same-ID-HTTP-and-stdio-MCP-status","fresh-process-and-backup-closed-receipt","candidate-business-fence-before-activation","healthy-new-version","same-stdio-supervisor-after-switch","original-run-and-output-preserved-no-replay"]},null,2));
} catch(error) { console.error(logs.slice(-2500)+"\n"+mcpLogs.slice(-2000));throw error; }
finally {
  await client.close().catch(()=>{});await transport?.close().catch(()=>{});
  try {
    if(base && await portOpen(Number(new URL(base).port),"127.0.0.1")) {
      const lease=JSON.parse(await readFile(path.join(dataDirectory,"production-runtime.json"),"utf8"));
      assert.equal(path.resolve(lease.root),path.resolve(fixture));
      await controlRequest(lease,"shutdown",randomUUID());
      await eventually(()=>portOpen(lease.port,"127.0.0.1").then(open=>!open));
    }
  } catch(error) { console.error("isolated fixture cleanup requires attention: "+String(error)); }
}
