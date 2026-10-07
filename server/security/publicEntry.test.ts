import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { runArtifactPaths } from "../artifacts/runArtifacts.js";
import express from "express";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { aiHarness } from "../testing/aiSupport.js";
import { AccessService } from "../services/accessService.js";
import { UserPortalService } from "../services/userPortalService.js";
import { createAuthRouter, createAccessRouter } from "../api/accessRoutes.js";
import { createAiRouter } from "../api/aiRoutes.js";
import { createAssetRouter } from "../api/assetRoutes.js";
import { createMediaRouter } from "../api/mediaRoutes.js";
import { createRunRouter } from "../api/runRoutes.js";
import { createRunMediaExportRouter } from "../api/runMediaExportRoutes.js";
import { RunMediaExportService } from "../services/runMediaExportService.js";
import { LoginLimiter, type LoginLimitOptions } from "./loginLimiter.js";
import { createPublicUserApp, publicEntryGuard, publicRequestAllowed, validatePublicListener } from "./publicEntry.js";
import { createErrorHandler } from "./errorHandler.js";
import { aiOperations } from "../ai/operations.js";
import { createAiOpenApi } from "../ai/openapi.js";
import { HttpError } from "../errors.js";
const password = "public-isolation-password-2026";
async function harness(t: TestContext, options: LoginLimitOptions = {}) {
  const h = await aiHarness(t); const access = new AccessService(h.store, h.workspace, "mock-operator-credential-".repeat(2), new LoginLimiter(options)); const portal = new UserPortalService(access, h.scenes, h.service);
  const app = express(); app.use((_req,res,next) => { res.set("X-Request-ID",randomUUID()); next(); }); app.use(publicEntryGuard); app.use(express.json()); app.use(createAuthRouter(access)); app.use(access.middleware(async () => h.settings.projectDirectory));
  let fault: unknown; app.use((req,_res,next) => next(req.path === "/api/v1/self/account" && fault ? fault : undefined));
  app.use(createAccessRouter(access,portal)); app.use(createAiRouter(h.scenes,h.service,async()=>h.settings)); app.use(createRunRouter(h.service,async()=>h.settings)); app.use(createRunMediaExportRouter(new RunMediaExportService(async()=>h.settings,(project,id)=>h.service.getRun(project,id)))); app.use(createAssetRouter(h.assets)); app.use(createMediaRouter(async()=>h.settings));
  app.get("/api/settings",(_req,res)=>res.json({ private: true })); app.get(["/app","/admin","/assets/test.js"],(_req,res)=>res.send("fixture-ui")); app.use(createErrorHandler(false));
  const listen = async (app: express.Express) => { const server=app.listen(0,"127.0.0.1"); await new Promise<void>(resolve=>server.once("listening",resolve)); t.after(()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();})); return { server, base:"http://127.0.0.1:"+(server.address() as {port:number}).port }; };
  const privateIngress=await listen(app), publicIngress=await listen(createPublicUserApp(app));
  async function api(route: string, token="", body?: unknown, method=body===undefined ? "GET" : "POST", publicEntry=true, extra:Record<string,string>={}) { const response=await fetch((publicEntry ? publicIngress.base : privateIngress.base)+route,{ method, redirect:"manual",headers:{...(token ? {Authorization:"Bearer "+token}:{}),...(body===undefined ? {}:{"Content-Type":"application/json"}),...extra},body:body===undefined ? undefined : JSON.stringify(body) }); const data=await response.json().catch(()=>undefined) as any; return {response,data}; }
  async function create(name:string, role:"admin"|"user"="user") { const user=(await access.create({userId:randomUUID(),username:name,displayName:name,password,role})).user; const login=await access.login(name,password); return {user,token:login.token,identity:access.authenticate(login.token)}; }
  return {...h,access,portal,api,create,privateBase:privateIngress.base,publicBase:publicIngress.base,setFault:(value:unknown)=>{fault=value;}};
}
async function mcp(t:TestContext,base:string,token:string,root:string) {
  const transport=new StdioClientTransport({command:process.execPath,args:["--import","tsx",path.resolve("server/mcp/index.ts")],cwd:process.cwd(),env:{...process.env,ZANE_BASE_URL:base,ZANE_API_TOKEN:token,ZANE_MCP_RELOAD_FILE:path.join(root,"mock-generation.json")},stderr:"pipe"}); const client=new Client({name:"public-security-test",version:"1"}); await client.connect(transport); t.after(()=>client.close());
  return {client,call:async(name:string,args:Record<string,unknown>={})=>(await client.callTool({name,arguments:args})).structuredContent as {ok:boolean;data:any;error?:{code:string;status:number;retryAfterSeconds?:number;outcome?:string;message?:string};requestId?:string}};
}

test("用户入口：所有用户原子操作及HEAD允许，所有管理操作和异常路径拒绝；配置fail closed", () => {
  for(const operation of aiOperations) { const route=operation.path.replace(/\{[^}]+\}/g,"1"); assert.equal(publicRequestAllowed(operation.method,route),operation.access === "authenticated",operation.name); if(operation.access === "authenticated" && operation.method === "GET") assert.equal(publicRequestAllowed("HEAD",route),true); }
  for(const route of ["/admin","/api/auth/setup","/api/settings","/api/health","/api/ready","/api/workspace","/api/comfyui/view","/api/v1/self/unknown","/API/v1/self/account","/assets/../private.js","/assets/test.js.map","/api/v1/self/drafts/bad%2fid","/api/v1/self/drafts/%252f","/api/v1/self/drafts/bad%5cfile"]) assert.equal(publicRequestAllowed("GET",route),false,route);
  assert.equal(publicRequestAllowed("POST","/api/v1/runs/id/output-media"),false); assert.equal(publicRequestAllowed("HEAD","/api/v1/assets/id/versions/1/media"),true);
  assert.throws(()=>validatePublicListener("0.0.0.0",8799,8800)); for(const port of [NaN,-1,65536,8799]) assert.throws(()=>validatePublicListener("127.0.0.1",8799,port)); validatePublicListener("127.0.0.1",8799,8800); validatePublicListener("0.0.0.0",8799,undefined);
  const doc=createAiOpenApi({userOnly:true}); assert.equal(doc["x-entry-mode"],"user-only"); assert.ok(doc.paths["/api/v1/self/scenes"]); assert.ok(!doc.paths["/api/auth/setup"]); assert.ok(!doc.paths["/api/v1/users"]); assert.ok(!doc.paths["/api/v1/settings/task-concurrency"]);
});
test("用户入口：未初始化只联系管理员；代理头不能启用setup，管理员登录不签发会话",async t=>{
  const h=await harness(t); const status=await h.api("/api/auth/status"); assert.equal(status.data.nextAction,"contact_admin"); assert.equal(status.data.setupAllowed,false); assert.equal(status.data.security.entryMode,"user-only");
  assert.equal((await h.api("/api/auth/setup","",{userId:randomUUID(),username:"hijack",password,displayName:"hijack"},"POST",true,{"X-Forwarded-For":"127.0.0.1","X-Zane-Public-User-Only":"false"})).response.status,404); assert.equal(h.access.initialized(),false);
  const setup=await h.api("/api/auth/setup","",{userId:randomUUID(),username:"privateadmin",password,displayName:"admin"},"POST",false); assert.equal(setup.response.status,201);
  const before=h.store.listDocuments("@zane-system","credentials").length; const denied=await h.api("/api/auth/login","",{username:"privateadmin",password}); assert.equal(denied.response.status,403); assert.equal(denied.data.code,"PUBLIC_USER_ONLY"); assert.equal(denied.response.headers.get("set-cookie"),null); assert.equal(h.store.listDocuments("@zane-system","credentials").length,before);
  assert.equal((await h.api("/api/auth/status")).data.nextAction,"login"); const root=await h.api("/"); assert.equal(root.response.status,302); assert.equal(root.response.headers.get("location"),"/app");
});
test("用户入口：管理路径、管理员/应急Bearer和Cookie均拒绝，私有管理入口保留",async t=>{
  const h=await harness(t),admin=await h.create("admingate","admin"); assert.equal((await h.api("/api/settings",admin.token,undefined,"GET",false)).response.status,200);
  for(const route of ["/admin","/api/settings","/api/workspace","/api/v1/users","/api/workflows/runs","/api/comfyui/view"]) { const result=await h.api(route,admin.token); assert.equal(result.response.status,404,route); assert.equal(result.data.code,"PUBLIC_ENDPOINT_UNAVAILABLE"); assert.ok(result.data.requestId); }
  for(const token of [admin.token,"mock-operator-credential-".repeat(2)]) assert.equal((await h.api("/api/v1/self/account",token)).data.code,"PUBLIC_USER_ONLY");
  assert.equal((await h.api("/api/v1/self/account","",undefined,"GET",true,{Cookie:"zane_session="+admin.token})).data.code,"PUBLIC_USER_ONLY"); assert.equal((await h.api("/api/v1/self/account")).response.status,401);
});
test("登录HTTP：账号窗口/来源限流不信任转发头，429携带Retry-After；公私入口分开",async t=>{
  let now=1000;const h=await harness(t,{now:()=>now,windowMs:2000,accountAttempts:2,sourceAttempts:2}); const admin=await h.create("limitadmin","admin"); await h.create("loginuser");
  for(const username of ["missingone","missingtwo"]) assert.equal((await h.api("/api/auth/login","",{username,password:"wrong"},"POST",true,{"X-Forwarded-For":randomUUID()})).response.status,401);
  const denied=await h.api("/api/auth/login","",{username:"loginuser",password},"POST",true,{"X-Forwarded-For":"203.0.113.8"}); assert.equal(denied.response.status,429); assert.equal(denied.data.code,"LOGIN_RATE_LIMITED"); assert.equal(denied.response.headers.get("retry-after"),"2"); assert.equal(denied.data.details.retryAfterSeconds,2); assert.ok(denied.data.requestId);
  assert.equal((await h.api("/api/auth/login","",{username:admin.user.username,password},"POST",false)).response.status,200);
  now=3000;const success=await h.api("/api/auth/login","",{username:"loginuser",password}); assert.equal(success.response.status,200); assert.ok(success.response.headers.get("set-cookie")?.includes("HttpOnly"));
  // Account bucket applies across trusted sources and shares case normalization.
  assert.equal((await h.access.login("LOGINUSER",password,{userOnly:true,clientAddress:"different-source"})).user.username,"loginuser");
  await assert.rejects(h.access.login("LoginUser",password,{userOnly:true,clientAddress:"another-source"}),e=>e instanceof HttpError && e.status===429);
});
test("用户入口：公开错误脱敏、解析错误不回显；冲突字段保留且请求ID可对账",async t=>{
  const h=await harness(t),user=await h.create("errorsuser"); h.setFault(new Error("SECRET token=PRIVATE_KEY E:\\private\\file.sqlite http://127.0.0.1:8188/view"));
  const result=await h.api("/api/v1/self/account",user.token); assert.equal(result.response.status,500); assert.equal(result.data.requestId,result.response.headers.get("x-request-id")); assert.doesNotMatch(JSON.stringify(result.data),/SECRET|PRIVATE_KEY|sqlite|8188/);
  h.setFault(new HttpError(409,"版本冲突 token=SECRET","DRAFT_REVISION_CONFLICT",{currentRevision:4,path:"E:\\secret\\key",password:"SECRET"})); const conflict=await h.api("/api/v1/self/account",user.token); assert.equal(conflict.data.code,"DRAFT_REVISION_CONFLICT"); assert.equal(conflict.data.details.currentRevision,4); assert.doesNotMatch(JSON.stringify(conflict.data),/SECRET|secret\\/);
  const malformed=await fetch(h.publicBase+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:'{"password":"SECRET",INVALID'}); assert.equal(malformed.status,400); assert.doesNotMatch(await malformed.text(),/SECRET|INVALID\}/);
});
test("用户入口真实stdio MCP：私有建号授权→公网发现/草稿分页/旧revision/丢回执对账/上传媒体隔离",async t=>{
  const h=await harness(t,{accountAttempts:3,sourceAttempts:17,windowMs:4000,maxConcurrent:2}),admin=await h.create("mcppublicadmin","admin"),management=await mcp(t,h.privateBase,admin.token,h.root); const userId=randomUUID();
  assert.equal((await management.call("create_user",{userId,username:"publicmcpuser",displayName:"public",password})).ok,true); assert.equal((await management.call("set_user_scene_access",{userId,revision:1,sceneIds:["demo"]})).ok,true);
  const login=await h.api("/api/auth/login","",{username:"publicmcpuser",password}); const token=/zane_session=([^;]+)/.exec(login.response.headers.get("set-cookie")!)![1]; const user=await mcp(t,h.publicBase,token,h.root);
  const discovery=await user.call("get_workbench"); assert.equal(discovery.data.security.entryMode,"user-only"); assert.equal(discovery.data.security.loginRateLimit.accountAttempts,3); assert.equal(discovery.data.security.loginRateLimit.windowSeconds,4); assert.equal(discovery.data.security.loginRateLimit.sourceAttempts,17); assert.equal(discovery.data.security.loginRateLimit.maxConcurrent,2); assert.equal(discovery.data.security.administratorCredentials,"rejected");
  assert.equal((await user.call("get_workspace")).error?.code,"PUBLIC_ENDPOINT_UNAVAILABLE"); assert.equal((await user.call("get_current_user")).data.user.id,userId);
  for(const title of ["one","two"]) { const draftId=randomUUID(); await user.call("save_own_draft",{draftId,revision:0,title,sceneId:"demo",versionId:"version-a",inputValues:{flag:true}}); const read=await user.call("get_own_draft",{draftId}); assert.equal(read.data.draft.revision,1); const conflict=await user.call("save_own_draft",{draftId,revision:0,title,sceneId:"demo",versionId:"version-a",inputValues:{flag:false}}); assert.equal(conflict.error?.code,"DRAFT_REVISION_CONFLICT"); assert.ok(conflict.requestId); }
  const first=await user.call("list_own_drafts",{limit:1}); assert.equal(first.data.items.length,1); assert.equal(first.data.hasMore,true); const next=await user.call("list_own_drafts",{limit:1,cursor:first.data.nextCursor}); assert.equal(next.data.items.length,1); assert.equal(next.data.hasMore,false); assert.notEqual(first.data.items[0].id,next.data.items[0].id);
  assert.equal((await h.api("/api/v1/self/drafts?limit=0",token)).data.code,"INVALID_ACCESS_REQUEST");
  const file=path.join(h.root,"mock.png"); await writeFile(file,Buffer.from([137,80,78,71,13,10,26,10])); const assetId=randomUUID(); assert.equal((await user.call("upload_own_asset",{assetId,filePath:file,name:"mock",kind:"image"})).ok,true); const asset=await user.call("get_own_asset",{assetId}); const other=await h.create("otherpublic");
  const media=await fetch(h.publicBase+asset.data.reference.previewUrl,{headers:{Authorization:"Bearer "+token,Range:"bytes=0-3"}}); assert.equal(media.status,206); assert.equal((await media.arrayBuffer()).byteLength,4); assert.equal((await fetch(h.publicBase+asset.data.reference.previewUrl,{method:"HEAD",headers:{Authorization:"Bearer "+other.token}})).status,404);
  const runId=randomUUID(); assert.equal((await user.call("prepare_own_scene",{sceneId:"demo",versionId:"version-a",inputValues:{flag:true}})).ok,true);
  await user.call("submit_own_scene",{runId,sceneId:"demo",versionId:"version-a",inputValues:{flag:true}}); await h.service.wait(h.settings.projectDirectory,runId);
  const run=await user.call("get_own_run",{runId}); assert.equal(run.data.status,"completed"); assert.equal((await user.call("submit_own_scene",{runId,sceneId:"demo",versionId:"version-a",inputValues:{flag:true}})).error?.code,"RUN_ALREADY_EXISTS");
  const mediaDirectory=path.join(runArtifactPaths(h.settings.projectDirectory,runId).directory,"outputs","media"); await mkdir(mediaDirectory,{recursive:true}); await writeFile(path.join(mediaDirectory,"fixed.png"),Buffer.from([137,80,78,71,13,10,26,10]));
  const archived="/api/v1/runs/"+runId+"/media/fixed.png"; assert.equal((await fetch(h.publicBase+archived,{headers:{Authorization:"Bearer "+token,Range:"bytes=0-3"}})).status,206);
  assert.equal((await fetch(h.publicBase+archived,{method:"HEAD",headers:{Authorization:"Bearer "+other.token}})).status,404);
  await h.access.setScenes({userId,revision:h.access.get(userId).revision,sceneIds:[]});
  assert.equal((await fetch(h.publicBase+archived,{method:"HEAD",headers:{Authorization:"Bearer "+token}})).status,403); assert.equal((await h.api(archived,token)).response.status,403); assert.equal((await user.call("get_own_run",{runId})).ok,true);
  const spec=await h.api("/api/v1/ai/openapi.json",token); assert.ok(spec.data.paths["/api/v1/self/scenes"]); assert.ok(!spec.data.paths["/api/v1/users"]);
  const resourceSpec=await user.client.readResource({uri:"zane://openapi"}); const publicDoc=JSON.parse((resourceSpec.contents[0] as {text:string}).text); assert.equal(publicDoc["x-entry-mode"],"user-only"); assert.ok(!publicDoc.paths["/api/v1/users"]);
  const guide=await user.client.readResource({uri:"zane://guide"}); assert.match((guide.contents[0] as {text:string}).text,/用户入口操作手册/);
  const publicAdmin=await mcp(t,h.publicBase,admin.token,h.root); assert.equal((await publicAdmin.call("get_workbench")).error?.code,"PUBLIC_USER_ONLY"); assert.equal((await publicAdmin.call("create_user",{userId:randomUUID(),username:"blockednew",displayName:"bad",password})).error?.code,"PUBLIC_ENDPOINT_UNAVAILABLE");
  h.setFault(new Error("MCP_SECRET E:\\private\\token")); const failure=await user.call("get_current_user"); assert.equal(failure.error?.code,"INTERNAL_ERROR"); assert.ok(failure.requestId); assert.doesNotMatch(JSON.stringify(failure),/MCP_SECRET|private/);
});
