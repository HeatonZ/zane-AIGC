import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { controlRequest, verifyProcess } from "./production-runtime.mjs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const temporary=await mkdtemp(path.join(os.tmpdir(),"zane-public-user-smoke-")); const project=path.join(temporary,"project"); await mkdir(project);
let logs="",privateBase,publicBase;
const child=spawn(process.execPath,[path.join(root,"dist-server/index.js"),"--production"],{cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,NODE_ENV:"production",API_HOST:"127.0.0.1",API_PORT:"0",ZANE_PUBLIC_USER_HOST:"127.0.0.1",ZANE_PUBLIC_USER_PORT:"0",APP_DATA_DIR:path.join(temporary,"data"),DIST_DIR:path.join(root,"dist"),ZANE_PROJECT_DIR:project,HERMES_HOME:path.join(temporary,"unused-hermes"),COMFYUI_BASE_URL:"http://127.0.0.1:1",ZANE_ADMIN_TOKEN:"",ZANE_API_TOKEN:"",ZANE_UPGRADE_OPERATION_ID:"",ZANE_MCP_RELOAD_FILE:path.join(temporary,"generation.json"),ZANE_LOGIN_WINDOW_SECONDS:"3",ZANE_LOGIN_ACCOUNT_ATTEMPTS:"2",ZANE_LOGIN_SOURCE_ATTEMPTS:"30",ZANE_LOGIN_MAX_CONCURRENT:"4",ZANE_SHUTDOWN_TIMEOUT_MS:"1000"}});
const exited=new Promise(resolve=>child.once("exit",resolve));
const bounded=async(promise,ms=15000)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Public user smoke timed out\n"+logs.slice(-2500))),ms);})]);}finally{clearTimeout(timer);}};
const observe=chunk=>{logs+=chunk;const privateMatch=/server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);if(privateMatch)privateBase=privateMatch[1];const publicMatch=/"event":"server.public_user_listening","host":"127.0.0.1","port":(\d+)/.exec(logs);if(publicMatch)publicBase="http://127.0.0.1:"+publicMatch[1];};child.stdout.on("data",observe);child.stderr.on("data",observe);
async function api(base,route,token="",body,extra={}) {const response=await fetch(base+route,{method:body===undefined?"GET":"POST",redirect:"manual",headers:{...(token?{Authorization:"Bearer "+token}:{}),...(body===undefined?{}:{"Content-Type":"application/json"}),...extra},body:body===undefined?undefined:JSON.stringify(body)});return {response,data:await response.json().catch(()=>undefined)};}
try {
  await bounded((async()=>{while(!privateBase || !publicBase || !logs.includes('"event":"server.mcp_reload_published"')) {if(child.exitCode!==null)throw new Error("Fixture exited "+child.exitCode+"\n"+logs);await new Promise(resolve=>setTimeout(resolve,25));}})());
  assert.equal((await api(privateBase,"/api/ready")).response.status,200); const status=await api(publicBase,"/api/auth/status");assert.equal(status.data.entryMode,"user-only");assert.equal(status.data.nextAction,"contact_admin");assert.equal(status.data.setupAllowed,false);
  const password="isolated-public-smoke-2026";const setup={userId:randomUUID(),username:"smokeadmin",displayName:"admin",password};assert.equal((await api(publicBase,"/api/auth/setup","",setup,{"X-Forwarded-For":"127.0.0.1"})).response.status,404);
  const created=await api(privateBase,"/api/auth/setup","",setup);assert.equal(created.response.status,201);const admin=/zane_session=([^;]+)/.exec(created.response.headers.get("set-cookie"))[1];
  for(const route of ["/admin","/api/settings","/api/workspace","/api/v1/users","/api/health","/api/comfyui/view"])assert.equal((await api(publicBase,route,admin)).response.status,404,route);
  assert.equal((await api(privateBase,"/api/v1/users",admin)).response.status,200);assert.equal((await api(publicBase,"/api/v1/self/account",admin)).data.code,"PUBLIC_USER_ONLY");
  const adminDenied=await api(publicBase,"/api/auth/login","",{username:setup.username,password});assert.equal(adminDenied.data.code,"PUBLIC_USER_ONLY");assert.equal(adminDenied.response.headers.get("set-cookie"),null);
  const userId=randomUUID();assert.equal((await api(privateBase,"/api/v1/users",admin,{userId,username:"smokeuser",displayName:"user",password})).response.status,201);
  for(let i=0;i<2;i++)assert.equal((await api(publicBase,"/api/auth/login","",{username:"SMOKEUSER",password:"wrong"},{"X-Forwarded-For":"203.0.113."+(i+1)})).response.status,401);
  const limited=await api(publicBase,"/api/auth/login","",{username:"smokeuser",password});assert.equal(limited.response.status,429);assert.equal(limited.data.code,"LOGIN_RATE_LIMITED");assert.equal(limited.data.requestId,limited.response.headers.get("x-request-id"));const retry=Number(limited.response.headers.get("retry-after"));assert.ok(retry>=1 && retry<=3);assert.equal(limited.data.details.retryAfterSeconds,retry);
  await new Promise(resolve=>setTimeout(resolve,retry*1000+50));const login=await api(publicBase,"/api/auth/login","",{username:"smokeuser",password},{Origin:publicBase});assert.equal(login.response.status,200);const user=/zane_session=([^;]+)/.exec(login.response.headers.get("set-cookie"))[1];assert.equal((await api(publicBase,"/api/v1/self/account",user)).data.user.id,userId);
  const discovery=await api(publicBase,"/api/v1/ai",user);assert.equal(discovery.data.security.entryMode,"user-only");assert.equal(discovery.data.security.loginRateLimit.windowSeconds,3);
  const doc=await api(publicBase,"/api/v1/ai/openapi.json",user);assert.equal(doc.data["x-entry-mode"],"user-only");assert.ok(doc.data.paths["/api/v1/self/account"]);assert.ok(!doc.data.paths["/api/v1/users"]);
  const malformed=await fetch(publicBase+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:'{"password":"DO_NOT_LEAK",BAD'});assert.equal(malformed.status,400);const error=await malformed.json();assert.equal(error.code,"INVALID_JSON");assert.ok(error.requestId);assert.doesNotMatch(JSON.stringify(error),/DO_NOT_LEAK|Unexpected|SyntaxError/);
  assert.equal((await fetch(publicBase+"/app")).status,200);assert.equal((await api(publicBase,"/")).response.headers.get("location"),"/app");
  const lease=JSON.parse(await readFile(path.join(temporary,"data","production-runtime.json"),"utf8")); assert.equal(lease.pid,child.pid); assert.equal(path.resolve(lease.root),root);
  await verifyProcess(lease); const inspected=await controlRequest(lease,"inspect"); assert.equal(inspected.ok,true); assert.equal(inspected.metrics.active,0); assert.equal(inspected.metrics.queued,0);
  const stopped=await controlRequest(lease,"shutdown",randomUUID()); assert.equal(stopped.ok,true); assert.equal(await bounded(exited,6000),0); assert.match(logs,/server.shutdown_completed/);
  for(const base of [privateBase,publicBase])await assert.rejects(fetch(base+"/api/auth/status"));
  console.log("Public user smoke passed: compiled shared backend, private management + user-only listener, setup/admin blocking, login throttling/recovery, redacted errors and both listeners shutdown; no external generation");
} finally {
  if(child.exitCode===null){child.kill("SIGTERM");try{await bounded(exited,6000);}catch{child.kill("SIGKILL");await bounded(exited,3000);}}
  const resolved=path.resolve(temporary);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+"zane-public-user-smoke-"));await rm(resolved,{recursive:true,force:true});
}
