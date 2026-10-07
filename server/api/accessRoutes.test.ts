import { mkdir, writeFile } from "node:fs/promises";
import { createRunMediaExportRouter } from "./runMediaExportRoutes.js";
import { RunMediaExportService } from "../services/runMediaExportService.js";
import { SystemFeedbackService } from "../services/systemFeedbackService.js";
import { systemFeedbackEnvelope, systemFeedbackPage } from "../domain/systemFeedbackContracts.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { aiHarness } from "../testing/aiSupport.js";
import { AccessService } from "../services/accessService.js";
import { UserPortalService } from "../services/userPortalService.js";
import { createAccessRouter, createAuthRouter } from "./accessRoutes.js";
import { createAiRouter } from "./aiRoutes.js";
import { createRunRouter } from "./runRoutes.js";
import { createAssetRouter } from "./assetRoutes.js";
import { createMediaRouter } from "./mediaRoutes.js";
import { HttpError } from "../errors.js";
import { deferred, until } from "../testing/testSupport.js";
import { accessPage, userCreate } from "../ai/accessSchemas.js";
const password = "isolation-password-2026";
async function harness(t:TestContext,review=false) {
  const h=await aiHarness(t,{review});const access=new AccessService(h.store,h.workspace,"");const portal=new UserPortalService(access,h.scenes,h.service);
  const resolveSubmitter=(userId:string)=>{const user=access.find(userId);return user ? {userId:user.id,username:user.username,displayName:user.displayName} : undefined;};
  const app=express();app.use(express.json());app.use(createAuthRouter(access));app.use(access.middleware(async()=>h.settings.projectDirectory));app.use(createAccessRouter(access,portal));app.use(createAiRouter(h.scenes,h.service,async()=>h.settings,resolveSubmitter));app.use(createRunRouter(h.service,async()=>h.settings,resolveSubmitter));app.use(createRunMediaExportRouter(new RunMediaExportService(async()=>h.settings,(project,id)=>h.service.getRun(project,id))));app.use(createAssetRouter(h.assets));app.use(createMediaRouter(async()=>h.settings));
  app.get("/api/workspace",async(_req,res)=>res.json({workspace:await h.workspace.get()}));
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error instanceof HttpError ? error.status : 500).json({error:(error as Error).message,code:error instanceof HttpError ? error.code : "INTERNAL_ERROR"}));
  const server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));t.after(()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();}));
  const base="http://127.0.0.1:"+(server.address() as {port:number}).port;
  async function api(route:string,token="",body?:unknown,method=body===undefined ? "GET" : "POST") {const response=await fetch(base+route,{method,headers:{...(token ? {Authorization:"Bearer "+token} : {}),...(body===undefined ? {} : {"Content-Type":"application/json"})},body:body===undefined ? undefined : JSON.stringify(body)});const data=await response.json() as Record<string,any>;return {response,data};}
  const create = async (name:string,role:"admin"|"user"="user") => {const user=(await access.create({userId:randomUUID(),username:name,displayName:name,password,role})).user;const session=await access.login(name,password);return {user,token:session.token,identity:access.authenticate(session.token)};};
  return {...h,access,portal,base,api,create};
}
test("身份：匿名不能读取业务；本机显式初始化首管理员，无默认账户且密码摘要不返回",async t=>{
  const h=await harness(t);assert.equal((await h.api("/api/workspace")).response.status,401);assert.equal((await h.api("/api/auth/status")).data.initialized,false);
  const setup={userId:randomUUID(),username:"firstadmin",displayName:"管理员",password,role:"admin"};const result=await h.api("/api/auth/setup","",setup);assert.equal(result.response.status,201);assert.ok(result.response.headers.get("set-cookie")?.includes("HttpOnly"));assert.doesNotMatch(JSON.stringify(result.data),/passwordHash|authVersion|token/);
  assert.equal((await h.api("/api/auth/setup","",{...setup,userId:randomUUID()})).response.status,409);
  const login=await h.access.login("firstadmin",password);assert.equal(h.access.authenticate(login.token).role,"admin");assert.equal((await h.api("/api/v1/users",login.token)).data.items.length,1);
  assert.equal((await h.api("/api/auth/login","",{username:"firstadmin",password:"bad"})).response.status,401);
  assert.equal((await h.api("/api/v1/users/"+setup.userId,login.token,{revision:1,enabled:false},"PATCH")).data.code,"LAST_ADMIN_REQUIRED");
});
test("权限：用户默认空授权，旧管理API/SSE/任意流程不能绕过，身份不可伪造",async t=>{
  const h=await harness(t);const a=await h.create("alpha");assert.deepEqual((await h.api("/api/v1/self/scenes",a.token)).data.items,[]);
  for(const route of ["/api/workspace","/api/v1/scenes","/api/v1/scenes/demo/draft/diff","/api/v1/scenes/demo/draft/diff/value","/api/v1/capabilities","/api/settings","/api/v1/users","/api/v1/runs","/api/workflows/runs/"+randomUUID()+"/events","/api/comfyui/view?filename=test"])assert.equal((await h.api(route,a.token)).response.status,403,route);
  assert.equal((await h.api("/api/v1/runs",a.token,{runId:randomUUID(),workflow:{},ownerUserId:"someone"})).response.status,403);
  const spoof=await fetch(h.base+"/api/v1/self/account",{headers:{Authorization:"Bearer "+a.token,"X-Zane-Actor":"someone"}});assert.equal(spoof.status,409);
  const workbench=(await h.api("/api/v1/ai",a.token)).data;assert.equal(workbench.mode,"user");assert.ok(!workbench.operations.some((operation:any)=>operation.name==="get_workspace"));assert.ok(!("projectDirectory" in workbench));
});
test("场景授权：只读发布标题与表单，未发布不可用，授权/目录变更使跨页游标失效",async t=>{
  const h=await harness(t);const a=await h.create("alpha");await h.access.setScenes({userId:a.user.id,revision:1,sceneIds:["demo","unpublished"]});
  const draft=await h.scenes.drafts.get("demo");await h.scenes.drafts.update("demo",{revision:draft.revision,scene:{id:"demo",title:"只在管理端的草稿"}});
  const visible=(await h.api("/api/v1/self/scenes",a.token)).data;assert.deepEqual(visible.items.map((scene:any)=>scene.title),["测试场景"]);
  const detail=(await h.api("/api/v1/self/scenes/demo",a.token)).data;assert.equal(detail.versionId,"version-a");assert.ok(!("workflow" in detail));assert.equal(detail.fields.find((field:any)=>field.key==="style").options[0],"已发布值");
  const base=await h.workspace.get();const extra=structuredClone(base!);(extra.scenes as any[]).push({id:"second",title:"第二场景"});(extra.sceneVersions as any).second={publishedVersionId:"second-version",versions:[{...(extra.sceneVersions as any).demo.versions[0],id:"second-version",scene:{id:"second",title:"第二场景"},workflow:{...(extra.sceneVersions as any).demo.versions[0].workflow,sceneId:"second"}}]};await h.workspace.merge(base,extra);
  const current=h.access.get(a.user.id);await h.access.setScenes({userId:a.user.id,revision:current.revision,sceneIds:["demo","second"]});
  const first=(await h.api("/api/v1/self/scenes?limit=1",a.token)).data;assert.equal(first.hasMore,true);assert.equal((await h.api("/api/v1/self/scenes?limit=1&cursor="+first.nextCursor,a.token)).data.items[0].sceneId,"second");
  await h.access.setScenes({userId:a.user.id,revision:h.access.get(a.user.id).revision,sceneIds:["demo"]});assert.equal((await h.api("/api/v1/self/scenes?limit=1&cursor="+first.nextCursor,a.token)).data.code,"ACCESS_PAGE_CHANGED");
  assert.equal((await h.api("/api/v1/self/scenes/second",a.token)).data.code,"SCENE_ACCESS_DENIED");assert.equal(accessPage.safeParse({limit:0}).success,false);
});
test("用户管理：并发旧revision只有一次成功、登录名唯一、分页revision变更与无效参数",async t=>{
  const h=await harness(t);const admin=await h.create("admin","admin");const a=await h.create("alpha");const b=await h.create("beta");
  const responses=await Promise.all([h.api("/api/v1/users/"+a.user.id,admin.token,{revision:1,displayName:"A1"},"PATCH"),h.api("/api/v1/users/"+a.user.id,admin.token,{revision:1,displayName:"A2"},"PATCH")]);assert.deepEqual(responses.map(value=>value.response.status).sort(),[200,409]);
  const page=(await h.api("/api/v1/users?limit=1",admin.token)).data;h.access.update({userId:b.user.id,revision:1,displayName:"new"});assert.equal((await h.api("/api/v1/users?limit=1&cursor="+page.nextCursor,admin.token)).data.code,"ACCESS_PAGE_CHANGED");
  assert.equal((await h.api("/api/v1/users",admin.token,{userId:randomUUID(),username:"alpha",displayName:"重复",password,role:"user"})).data.code,"USER_ALREADY_EXISTS");assert.equal(userCreate.safeParse({userId:"a",username:"bad space",displayName:"bad",password}).success,false);
  assert.equal((await h.api("/api/v1/users/"+a.user.id+"/scene-access",admin.token,{revision:h.access.get(a.user.id).revision,sceneIds:["not-found"]})).response.status,400);
  const competing=await Promise.all(["first","second"].map(name=>h.access.create({userId:randomUUID(),username:"same-name",displayName:name,password,role:"user"}).then(()=>201,()=>409)));assert.deepEqual(competing.sort(),[201,409]);
});
test("本人草稿：同ID对账、revision保护、分页明确省略输入、不串用户或全局历史",async t=>{
  const h=await harness(t);const a=await h.create("alpha");const b=await h.create("beta");await h.access.setScenes({userId:a.user.id,revision:1,sceneIds:["demo"]});const draftId=randomUUID();const body={draftId,revision:0,sceneId:"demo",versionId:"version-a",title:"我的草稿",inputValues:{flag:true}};
  assert.equal((await h.api("/api/v1/self/drafts",a.token,body)).response.status,200);const read=(await h.api("/api/v1/self/drafts/"+draftId,a.token)).data;assert.equal(read.draft.revision,1);assert.deepEqual(read.draft.inputValues,{flag:true});
  assert.equal((await h.api("/api/v1/self/drafts",a.token,body)).data.code,"DRAFT_REVISION_CONFLICT");assert.equal((await h.api("/api/v1/self/drafts/"+draftId,b.token)).response.status,404);assert.deepEqual((await h.api("/api/v1/self/drafts",b.token)).data.items,[]);
  const page=(await h.api("/api/v1/self/drafts",a.token)).data;assert.equal(page.items[0].inputValuesOmitted,true);assert.ok(!("inputValues" in page.items[0]));
  assert.equal((await h.api("/api/v1/self/drafts",a.token,{...body,draftId:randomUUID(),userId:b.user.id})).response.status,400);
});
test("本人执行：归属与发布快照在SQLite保存，响应丢失查原ID，任务/输出/媒体不串读",async t=>{
  const h=await harness(t);const a=await h.create("alpha");const b=await h.create("beta");const admin=await h.create("admin","admin");await h.access.setScenes({userId:a.user.id,revision:1,sceneIds:["demo"]});const runId=randomUUID();const body={versionId:"version-a",runId,inputValues:{flag:true}};
  assert.equal((await h.api("/api/v1/self/scenes/demo/runs",a.token,{...body,workflow:{steps:[]}})).response.status,400);
  // Deliberately ignore the accepted response, then reconcile by the previously saved runId.
  await h.api("/api/v1/self/scenes/demo/runs",a.token,body);await until(()=>h.store.getRun(h.settings.projectDirectory,runId)?.status==="completed");
  const record=h.store.getRun(h.settings.projectDirectory,runId)!;assert.equal(record.ownerUserId,a.user.id);assert.deepEqual(record.submitter,{userId:a.user.id,username:"alpha",displayName:"alpha"});assert.equal(record.workflow.publishedScene?.versionId,"version-a");
  const adminList=(await h.api("/api/v1/runs?limit=50",admin.token)).data;assert.deepEqual(adminList.runs.find((item:any)=>item.runId===runId).submitter,record.submitter);
  const adminDetail=(await h.api("/api/v1/runs/"+runId,admin.token)).data;assert.deepEqual(adminDetail.submitter,record.submitter);
  const read=(await h.api("/api/v1/self/runs/"+runId,a.token)).data;assert.equal(read.status,"completed");assert.ok(!("workflow" in read));assert.ok(!("artifacts" in read));
  assert.equal((await h.api("/api/v1/self/scenes/demo/runs",a.token,body)).data.code,"RUN_ALREADY_EXISTS");
  assert.equal((await h.api("/api/v1/self/runs/"+runId,b.token)).response.status,404);assert.deepEqual((await h.api("/api/v1/self/runs",b.token)).data.items,[]);
  assert.equal((await h.api("/api/v1/self/runs/"+runId+"/outputs",a.token)).data.outputs[0].value,"ok");assert.equal((await h.api("/api/v1/self/runs/"+runId+"/outputs",b.token)).response.status,404);
  const media=await fetch(h.base+"/api/v1/runs/"+runId+"/media/missing.png",{method:"HEAD",headers:{Authorization:"Bearer "+b.token}});assert.equal(media.status,404);
  const legacy=await h.service.submit({runId:randomUUID(),workflow:record.workflow,inputValues:{flag:true}});assert.equal((await h.api("/api/v1/self/runs/"+legacy.runId,a.token)).response.status,404);
  await h.access.setScenes({userId:a.user.id,revision:h.access.get(a.user.id).revision,sceneIds:[]});assert.equal((await h.api("/api/v1/self/runs/"+runId,a.token)).response.status,200);assert.equal((await h.api("/api/v1/self/scenes/demo/runs",a.token,{...body,runId:randomUUID()})).response.status,403);
});
test("业务审核：waiting不能用续跑绕过；撤销授权拒绝继续；用户不能修改输出或流程",async t=>{
  const h=await harness(t,true);const a=await h.create("alpha");await h.access.setScenes({userId:a.user.id,revision:1,sceneIds:["demo"]});const runId=randomUUID();await h.api("/api/v1/self/scenes/demo/runs",a.token,{versionId:"version-a",runId,inputValues:{flag:true}});await until(()=>h.store.getRun(h.settings.projectDirectory,runId)?.status==="waiting");
  const reviewId=h.store.getRun(h.settings.projectDirectory,runId)!.pendingReview!.id;
  assert.equal((await h.api("/api/v1/self/runs/"+runId+"/resume",a.token,{newRunId:randomUUID()})).response.status,409);
  assert.equal((await h.api("/api/v1/self/runs/"+runId+"/review",a.token,{reviewId,action:"approve",outputs:{value:"fake"}})).response.status,400);
  await h.access.setScenes({userId:a.user.id,revision:2,sceneIds:[]});assert.equal((await h.api("/api/v1/self/runs/"+runId+"/review",a.token,{reviewId,action:"approve"})).response.status,403);
  await h.access.setScenes({userId:a.user.id,revision:3,sceneIds:["demo"]});assert.equal((await h.api("/api/v1/self/runs/"+runId+"/review",a.token,{reviewId,action:"approve"})).response.status,202);await until(()=>h.store.getRun(h.settings.projectDirectory,runId)?.status==="completed");assert.equal((await h.api("/api/v1/self/runs/"+runId+"/review",a.token,{reviewId,action:"approve"})).response.status,409);
});
test("账户与AI凭证：权限实时读取；停用、角色/密码变化使旧会话与凭证失效；凭证明文不可回读",async t=>{
  const h=await harness(t);const a=await h.create("alpha");const tokenId=randomUUID();const created=(await h.api("/api/v1/self/tokens",a.token,{tokenId,name:"test AI"})).data;assert.ok(created.token);
  assert.equal((await h.api("/api/v1/self/tokens",a.token,{tokenId,name:"duplicate"})).data.code,"TOKEN_ALREADY_EXISTS");assert.doesNotMatch(JSON.stringify((await h.api("/api/v1/self/tokens",a.token)).data),/"hash"|"token"/);
  await h.access.setScenes({userId:a.user.id,revision:1,sceneIds:["demo"]});assert.equal((await h.api("/api/v1/self/scenes",created.token)).data.items.length,1);
  h.access.update({userId:a.user.id,revision:2,enabled:false});assert.equal((await h.api("/api/v1/self/account",a.token)).response.status,401);assert.equal((await h.api("/api/v1/self/account",created.token)).response.status,401);h.access.update({userId:a.user.id,revision:3,enabled:true});assert.equal((await h.api("/api/v1/self/account",a.token)).response.status,401);
  const fresh=await h.access.login("alpha",password);await h.access.resetPassword({userId:a.user.id,revision:4,password:password+"new"});assert.equal((await h.api("/api/v1/self/account",fresh.token)).response.status,401);await assert.rejects(h.access.login("alpha",password));
});
test("本人上传：预存assetId、重复拒绝和按ID对账；他人元数据/HEAD/Range不可读，路径输入拒绝",async t=>{
  const h=await harness(t);const a=await h.create("alpha");const b=await h.create("beta");const assetId=randomUUID();const route="/api/v1/self/assets/upload?"+new URLSearchParams({assetId,name:"test.png",kind:"image"});
  const upload=await fetch(h.base+route,{method:"POST",headers:{Authorization:"Bearer "+a.token,"Content-Type":"application/octet-stream","X-File-Name":"test.png"},body:Buffer.from([137,80,78,71,13,10,26,10])});assert.equal(upload.status,201);
  const value=(await h.api("/api/v1/self/assets/"+assetId,a.token)).data;assert.equal(value.reference.assetId,assetId);assert.equal(h.assets.get(h.settings.projectDirectory,assetId)!.ownerUserId,a.user.id);
  assert.equal((await h.api("/api/v1/self/assets/"+assetId,b.token)).response.status,404);for(const method of ["GET","HEAD"]) {const response=await fetch(h.base+value.reference.previewUrl,{method,headers:{Authorization:"Bearer "+b.token,Range:"bytes=0-3"}});assert.equal(response.status,404);}
  assert.equal((await fetch(h.base+value.reference.previewUrl,{headers:{Authorization:"Bearer "+a.token,Range:"bytes=0-3"}})).status,206);
  await assert.rejects(h.portal.upload(a.identity,assetId,"again","image",Buffer.from("x"),"x.png"),(error:unknown)=>error instanceof HttpError && error.status===409);
  await h.access.setScenes({userId:a.user.id,revision:1,sceneIds:["demo"]});
  const snapshot=await h.workspace.get();const updated=structuredClone(snapshot!) as any;updated.sceneVersions.demo.versions[0].workflow.inputs.push({key:"picture",type:"image"},{key:"parameters",type:"json",defaultValue:{workflow:"业务字段名，不能静默删除"}});await h.workspace.merge(snapshot,updated);
  const detail=(await h.api("/api/v1/self/scenes/demo",a.token)).data;assert.ok(detail.inputSchema.properties.parameters);assert.equal(detail.inputDefaults.parameters.workflow,"业务字段名，不能静默删除");assert.equal(detail.inputSchema.properties.picture.anyOf[0].required[0],"assetId");
  assert.equal((await h.api("/api/v1/self/scenes/demo/prepare",a.token,{versionId:"version-a",inputValues:{flag:true,picture:value.reference}})).data.valid,true);
  assert.equal((await h.api("/api/v1/self/scenes/demo/prepare",a.token,{versionId:"version-a",inputValues:{flag:true,picture:"C:\\Users\\secret.png"}})).data.code,"INVALID_USER_MEDIA");
  assert.equal((await h.api("/api/v1/self/scenes/demo/prepare",a.token,{versionId:"version-a",inputValues:{flag:true,parameters:{path:"C:\\secret.txt"}}})).data.code,"INVALID_USER_MEDIA");
});
test("提交前再次核验：prepare后撤销授权，拒绝入队并保留原ID语义；旧发布版本明确冲突",async t=>{
  const h=await harness(t);const a=await h.create("alpha");await h.access.setScenes({userId:a.user.id,revision:1,sceneIds:["demo"]});const old=h.scenes.prepare.bind(h.scenes);const gate=deferred<void>();const started=deferred<void>();h.scenes.prepare=async(...args)=>{const result=await old(...args);started.resolve();await gate.promise;return result;};const runId=randomUUID();const submitting=h.api("/api/v1/self/scenes/demo/runs",a.token,{versionId:"version-a",runId,inputValues:{flag:true}});await started.promise;await h.access.setScenes({userId:a.user.id,revision:2,sceneIds:[]});gate.resolve();assert.equal((await submitting).response.status,403);assert.equal(h.store.getRun(h.settings.projectDirectory,runId),undefined);
  await h.access.setScenes({userId:a.user.id,revision:3,sceneIds:["demo"]});const draft=await h.scenes.drafts.get("demo");const fixed=await h.scenes.drafts.update("demo",{revision:draft.revision,workflow:{...(draft.workflow as any),inputs:((draft.workflow as any).inputs as any[]).map(field=>field.key === "style" ? {...field,defaultValue:"草稿值"} : field)}});await h.scenes.drafts.publish("demo",fixed.revision,randomUUID());assert.equal((await h.api("/api/v1/self/scenes/demo/prepare",a.token,{versionId:"version-a",inputValues:{flag:true}})).data.code,"SCENE_VERSION_CHANGED");
});
async function mcp(t:TestContext,base:string,token:string) {
  const transport=new StdioClientTransport({command:process.execPath,args:["--import","tsx",path.resolve("server/mcp/index.ts")],cwd:process.cwd(),env:{...process.env,ZANE_BASE_URL:base,ZANE_API_TOKEN:token},stderr:"pipe"});const client=new Client({name:"user-access-test",version:"1"});await client.connect(transport);t.after(()=>client.close());
  return {client,call:async(name:string,args:Record<string,unknown>={})=>{const result=await client.callTool({name,arguments:args});return result.structuredContent as {ok:boolean;data:any;error?:{code:string}};}};
}
test("真实stdio MCP隔离闭环：管理员创建/授权→本人凭证→用户发现/草稿/预检/提交/结果；管理员工具不能提权",async t=>{
  const h=await harness(t);const admin=await h.create("admin","admin");const management=await mcp(t,h.base,admin.token);const userId=randomUUID();const created=await management.call("create_user",{userId,username:"mcpuser",displayName:"MCP用户",password});assert.equal(created.ok,true);assert.equal((await management.call("set_user_scene_access",{userId,revision:1,sceneIds:["demo"]})).ok,true);
  const login=await h.access.login("mcpuser",password);const issued=h.access.createCredential(h.access.authenticate(login.token),{tokenId:randomUUID(),name:"user MCP"});const user=await mcp(t,h.base,issued.token);
  assert.equal((await user.call("get_current_user")).data.user.id,userId);assert.deepEqual((await user.call("list_available_scenes")).data.items.map((scene:any)=>scene.sceneId),["demo"]);assert.equal((await user.call("get_workspace")).error?.code,"ADMIN_REQUIRED");
  const scene=(await user.call("get_available_scene",{sceneId:"demo"})).data;assert.ok(!("workflow" in scene));const draftId=randomUUID();assert.equal((await user.call("save_own_draft",{draftId,revision:0,title:"MCP草稿",sceneId:"demo",versionId:scene.versionId,inputValues:{flag:true}})).ok,true);assert.equal((await user.call("get_own_draft",{draftId})).data.draft.revision,1);
  assert.equal((await user.call("prepare_own_scene",{sceneId:"demo",versionId:scene.versionId,inputValues:{flag:true}})).data.valid,true);const runId=randomUUID();assert.equal((await user.call("submit_own_scene",{sceneId:"demo",versionId:scene.versionId,inputValues:{flag:true},runId})).ok,true);await until(()=>h.store.getRun(h.settings.projectDirectory,runId)?.status==="completed");const ownRun=(await user.call("get_own_run",{runId})).data;assert.equal(ownRun.status,"completed");assert.equal((await user.call("get_own_outputs",{runId})).data.outputs[0].value,"ok");
  assert.ok(!("submitter" in ownRun));assert.ok(!("ownerUserId" in ownRun));
  const adminRun=(await management.call("get_run",{runId})).data;assert.deepEqual(adminRun.submitter,{userId,username:"mcpuser",displayName:"MCP\u7528\u6237"});
  const adminRunPage=(await management.call("list_runs",{limit:50})).data;assert.deepEqual(adminRunPage.runs.find((item:any)=>item.runId===runId).submitter,adminRun.submitter);
  const observation=(await management.call("wait_run",{runId,timeoutSeconds:0})).data;assert.deepEqual(observation.submitter,adminRun.submitter);
  assert.equal((await user.call("get_run",{runId})).error?.code,"ADMIN_REQUIRED");
  const resource=await user.client.readResource({uri:"zane://scenes"});assert.equal(JSON.parse((resource.contents[0] as {text:string}).text).data.items[0].sceneId,"demo");
  const changed=h.access.get(userId);await management.call("set_user_scene_access",{userId,revision:changed.revision,sceneIds:[]});assert.equal((await user.call("prepare_own_scene",{sceneId:"demo",versionId:scene.versionId,inputValues:{flag:true}})).error?.code,"SCENE_ACCESS_DENIED");
});

test("登录来源与凭证撤销：旧捕获身份不能继续服务写入或等待中的提交", async t => {
  const h = await harness(t);
  const user = await h.create("revokeduser");
  const wrongOrigin = await fetch(h.base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://other.invalid" }, body: JSON.stringify({ username: "revokeduser", password }) });
  assert.equal(wrongOrigin.status, 403);
  await h.access.setScenes({ userId: user.user.id, revision: 1, sceneIds: ["demo"] });
  const original = h.scenes.prepare.bind(h.scenes), started = deferred<void>(), gate = deferred<void>();
  h.scenes.prepare = async (...args) => { const result = await original(...args); started.resolve(); await gate.promise; return result; };
  const runId = randomUUID();
  const pending = h.api("/api/v1/self/scenes/demo/runs", user.token, { versionId: "version-a", runId, inputValues: { flag: true } });
  await started.promise;
  h.access.logout(user.identity);
  assert.throws(() => h.access.refresh(user.identity), (error: unknown) => error instanceof HttpError && error.status === 401);
  assert.throws(() => h.access.createCredential(user.identity, { tokenId: randomUUID(), name: "stale" }), (error: unknown) => error instanceof HttpError && error.status === 401);
  gate.resolve();
  assert.equal((await pending).response.status, 401);
  assert.equal(h.store.getRun(h.settings.projectDirectory, runId), undefined);
});
test("异步账户创建在落库前重新核验管理员会话；撤销后的请求不写入", async t => {
  const h = await harness(t), admin = await h.create("asyncadmin", "admin"), userId = randomUUID();
  const pending = h.access.create({ userId, username: "mustnotexist", displayName: "临时用户", password, role: "user" }, false, () => { h.access.refresh(admin.identity); });
  h.access.logout(admin.identity);
  await assert.rejects(pending, (error: unknown) => error instanceof HttpError && error.status === 401);
  assert.throws(() => h.access.get(userId), (error: unknown) => error instanceof HttpError && error.status === 404);
});

test("运行详情HTTP：真实开始/步骤进度，原始输入标签不随场景变动，未来步骤与审核状态一致",async t=>{
  const h=await harness(t,true),a=await h.create("detailuser");await h.access.setScenes({userId:a.user.id,revision:1,sceneIds:["demo"]});
  const runId=randomUUID();await h.portal.submit(a.identity,{sceneId:"demo",versionId:"version-a",runId,inputValues:{flag:true}});
  await h.service.wait(h.settings.projectDirectory,runId);
  const detail=await h.api("/api/v1/self/runs/"+runId,a.token);assert.equal(detail.data.status,"waiting");assert.equal(detail.data.progress.total,2);assert.equal(detail.data.progress.pending,1);assert.equal(detail.data.steps[1].status,"pending");assert.equal(detail.data.steps[0].reviewStatus,"pending");assert.equal(detail.data.startedAt,h.store.firstEventAt(h.settings.projectDirectory,runId,"run.started"));assert.equal(typeof detail.data.revision,"string");
  const first=(await h.api("/api/v1/self/runs/"+runId+"/inputs?limit=1",a.token)).data;assert.equal(first.inputs[0].key,"flag");assert.equal(first.inputs[0].value,true);assert.ok(first.nextCursor);
  const second=(await h.api("/api/v1/self/runs/"+runId+"/inputs?limit=1&cursor="+encodeURIComponent(first.nextCursor),a.token)).data;assert.equal(second.inputs[0].key,"style");assert.equal(second.inputs[0].value,"已发布值");
  const meta=(await h.api("/api/v1/self/runs/"+runId+"/inputs?includeValues=false",a.token)).data;assert.equal(meta.inputs[0].valueOmitted,true);assert.ok(!("value" in meta.inputs[0]));
  const current=await h.workspace.get();await h.workspace.merge(current!,{...current!,scenes:[]});
  assert.equal((await h.api("/api/v1/self/runs/"+runId+"/inputs?inputKey=style",a.token)).data.inputs[0].value,"已发布值");
  await h.access.setScenes({userId:a.user.id,revision:2,sceneIds:[]});assert.equal((await h.api("/api/v1/self/runs/"+runId+"/activity",a.token)).response.status,200);
  const other=await h.create("otherdetail");for(const part of ["","/inputs","/activity"])assert.equal((await h.api("/api/v1/self/runs/"+runId+part,other.token)).response.status,404);
  for(const query of ["includeValues=bad","limit=0","valueLimit=8193","valueOffset=-1","inputKey=flag&inputKey=style"])assert.equal((await h.api("/api/v1/self/runs/"+runId+"/inputs?"+query,a.token)).response.status,400,query);
  assert.equal((await h.api("/api/v1/self/runs/"+runId+"/inputs?inputKey=missing",a.token)).response.status,404);
});
test("业务动态在SQL分页前过滤checkpoint，sequence增量无重复，保留第0项且剥离错误payload",async t=>{
  const h=await harness(t),a=await h.create("activityuser");await h.access.setScenes({userId:a.user.id,revision:1,sceneIds:["demo"]});
  const runId=randomUUID();await h.portal.submit(a.identity,{sceneId:"demo",versionId:"version-a",runId,inputValues:{flag:false}});const run=await h.service.wait(h.settings.projectDirectory,runId);const start=h.store.latestSequence(h.settings.projectDirectory,runId);
  h.store.saveRun(h.settings.projectDirectory,run,[{type:"run.checkpoint",payload:{private:"PRIVATE_CHECKPOINT"}},{type:"step.item.failed",stepId:"first",payload:{index:0,error:"F:/private/key.txt",promptTemplate:"PRIVATE_PROMPT"}},{type:"run.checkpoint"},{type:"review.redo",stepId:"first",payload:{reviewId:"private-review",feedbackId:"secret"}}]);
  const first=(await h.api("/api/v1/self/runs/"+runId+"/activity?limit=1&afterSequence="+start,a.token)).data;assert.equal(first.events.length,1);assert.equal(first.events[0].itemIndex,0);assert.equal(first.events[0].type,"step.item.failed");assert.equal(first.hasMore,true);assert.doesNotMatch(JSON.stringify(first),/PRIVATE|key.txt|private-review|secret|payload/);
  const second=(await h.api("/api/v1/self/runs/"+runId+"/activity?limit=1&afterSequence="+first.nextSequence,a.token)).data;assert.equal(second.events[0].type,"review.redo");assert.equal(second.hasMore,false);assert.ok(second.nextSequence>first.nextSequence);
  const last=(await h.api("/api/v1/self/runs/"+runId+"/activity?afterSequence="+second.nextSequence,a.token)).data;assert.deepEqual(last.events,[]);assert.equal(last.nextSequence,second.nextSequence);
  assert.equal((await h.api("/api/v1/self/runs/"+runId+"/activity?afterSequence=-1",a.token)).response.status,400);assert.equal((await h.api("/api/v1/self/runs/"+runId+"/activity?limit=101",a.token)).response.status,400);
});
test("新增详情经真实stdio MCP到同一业务服务：输入/动态分页和长文本/逐项新字段；未知回执读取不重建",async t=>{
  const h=await harness(t),a=await h.create("mcpdetail");await h.access.setScenes({userId:a.user.id,revision:1,sceneIds:["demo"]});const runId=randomUUID();
  // Simulate a lost submit receipt: keep the saved ID, discard accepted payload,
  // then reconcile by read rather than submitting a new task.
  await h.api("/api/v1/self/scenes/demo/runs",a.token,{versionId:"version-a",runId,inputValues:{flag:true}});const done=await h.service.wait(h.settings.projectDirectory,runId);
  done.outputs=[{key:"text",label:"成稿",type:"text",value:"😀甲乙丙丁"}];done.steps[0].outputs={value:"😀甲乙丙丁"};done.steps[0].items=[{index:0,value:null,status:"completed",outputs:{value:"😀甲乙丙丁"}}];
  h.store.saveRun(h.settings.projectDirectory,done,[]);
  const transport=new StdioClientTransport({command:process.execPath,args:["--import","tsx",path.resolve("server/mcp/index.ts")],cwd:process.cwd(),env:{...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==="string")),ZANE_BASE_URL:h.base,ZANE_API_TOKEN:a.token},stderr:"pipe"});const client=new Client({name:"run-detail-isolation",version:"1"});t.after(()=>client.close());await client.connect(transport);
  const call=async(name:string,args:Record<string,unknown>)=>(await client.callTool({name,arguments:args})).structuredContent as Record<string,any>;
  const detail=await call("get_own_run",{runId});assert.equal(detail.ok,true);assert.equal(detail.data.runId,runId);assert.equal(detail.data.progress.completed,2);assert.equal(detail.data.steps[0].itemProgress.completed,1);
  const first=await call("get_own_run_inputs",{runId,limit:1});assert.equal(first.ok,true);assert.equal(first.data.inputs[0].value,true);const second=await call("get_own_run_inputs",{runId,limit:1,cursor:first.data.nextCursor});assert.equal(second.data.inputs[0].value,"已发布值");
  const meta=await call("get_own_run_inputs",{runId,includeValues:false});assert.equal(meta.data.inputs[0].omissionReason,"metadata_only");
  const activity=await call("get_own_run_activity",{runId,limit:1});assert.equal(activity.ok,true);assert.equal(activity.data.events.length,1);const later=await call("get_own_run_activity",{runId,limit:1,afterSequence:activity.data.nextSequence});assert.ok(later.data.nextSequence>activity.data.nextSequence);
  const text=await call("get_own_outputs",{runId,outputKey:"text",textLimit:2,textOffset:2});assert.equal(text.data.outputs[0].value,"乙丙");assert.equal(text.data.outputs[0].valuePage.kind,"string");
  const item=await call("get_own_step_result",{runId,stepId:"first",itemIndex:0,outputKey:"value",textLimit:2,textOffset:2});assert.equal(item.data.items[0].outputs[0].value,"乙丙");
  const before=h.store.listRuns(h.settings.projectDirectory).runs.length;await call("get_own_run_inputs",{runId,limit:1});assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length,before);
  const invalid=await client.callTool({name:"get_own_run_activity",arguments:{runId,afterSequence:-1}});assert.equal(invalid.isError,true);
  done.outputs[0].value="请访问 F:/private/key.txt 获取结果";done.steps[0].outputs={value:"请访问 F:/private/key.txt 获取结果"};h.store.saveRun(h.settings.projectDirectory,done,[]);
  const redacted=await call("get_own_outputs",{runId,outputKey:"text",textLimit:2,textOffset:4});assert.doesNotMatch(JSON.stringify(redacted),/private|key.txt|F:/);
});

test("收藏HTTP：管理员历史草稿、本人草稿身份隔离，revision/参数/分页/内容保存兼容", async t => {
  const h = await harness(t); const admin = await h.create("favoriteadmin", "admin"), a = await h.create("favoriteuser"), b = await h.create("favoriteother");
  await h.workspace.mutateScoped(current => ({ workspace: { ...current, drafts: [
    { id: "legacy-old", sceneId: "demo", title: "常用草稿", createdAt: "2026-09-01", status: "draft", inputValues: { flag: true } },
    { id: "legacy-new", sceneId: "demo", title: "最近草稿", createdAt: "2026-10-05", status: "draft" },
  ] }, result: undefined }));
  const legacy = (await h.api("/api/v1/task-drafts/legacy-old", admin.token)).data;
  assert.equal(legacy.draft.isFavorite, false);
  assert.equal((await h.api("/api/v1/task-drafts", a.token)).response.status, 403);
  assert.equal((await h.api("/api/v1/task-drafts/legacy-old", a.token)).response.status, 403);
  assert.equal((await h.api("/api/v1/task-drafts/legacy-old/favorite", a.token, { revision: legacy.revision, isFavorite: true }, "PATCH")).response.status, 403);
  assert.equal((await h.api("/api/v1/task-drafts/legacy-old/favorite", "", { revision: legacy.revision, isFavorite: true }, "PATCH")).response.status, 401);
  const favorite = await h.api("/api/v1/task-drafts/legacy-old/favorite", admin.token, { revision: legacy.revision, isFavorite: true }, "PATCH");
  assert.equal(favorite.response.status, 200); assert.equal(favorite.data.draft.isFavorite, true);
  assert.deepEqual((await h.api("/api/v1/task-drafts", admin.token)).data.items.map((item:any) => item.id), ["legacy-old", "legacy-new"]);
  assert.equal((await h.api("/api/v1/task-drafts/legacy-old/favorite", admin.token, { revision: legacy.revision, isFavorite: false }, "PATCH")).data.code, "DRAFT_REVISION_CONFLICT");
  for (const input of [{ revision: favorite.data.revision, isFavorite: "true" }, { revision: favorite.data.revision }, { revision: favorite.data.revision, isFavorite: true, ownerUserId: a.user.id }]) assert.equal((await h.api("/api/v1/task-drafts/legacy-old/favorite", admin.token, input, "PATCH")).response.status, 400);
  assert.equal((await h.api("/api/v1/task-drafts?limit=201", admin.token)).response.status, 400);
  await h.access.setScenes({ userId: a.user.id, revision: 1, sceneIds: ["demo"] });
  const body = { sceneId: "demo", versionId: "version-a", inputValues: { flag: true } };
  // Seed legacy dates in the existing user-drafts collection; no extra workspace/database.
  for (const [id, updatedAt] of [["own-old", "2026-09-01"], ["own-new", "2026-10-05"]]) h.store.putDocument(h.settings.projectDirectory, "user-drafts", { id, userId: a.user.id, revision: 0, ...body, title: id, updatedAt }, 0);
  const old = (await h.api("/api/v1/self/drafts/own-old", a.token)).data.draft; assert.equal(old.isFavorite, false);
  const first = (await h.api("/api/v1/self/drafts?limit=1", a.token)).data; assert.equal(first.items[0].id, "own-new");
  assert.equal((await h.api("/api/v1/self/drafts/own-old/favorite", b.token, { revision: old.revision, isFavorite: true }, "PATCH")).response.status, 404);
  for (const input of [{ revision: old.revision, isFavorite: "true" }, { revision: old.revision, isFavorite: true, userId: b.user.id }, { isFavorite: true }]) assert.equal((await h.api("/api/v1/self/drafts/own-old/favorite", a.token, input, "PATCH")).response.status, 400);
  // Ignore the accepted response to simulate receipt loss, then reconcile the same ID.
  await h.api("/api/v1/self/drafts/own-old/favorite", a.token, { revision: old.revision, isFavorite: true }, "PATCH");
  const reconciled = (await h.api("/api/v1/self/drafts/own-old", a.token)).data.draft;
  assert.equal(reconciled.isFavorite, true); assert.equal(reconciled.updatedAt, old.updatedAt); assert.deepEqual(reconciled.inputValues, old.inputValues); assert.equal(reconciled.revision, 2);
  assert.equal((await h.api("/api/v1/self/drafts?cursor=" + encodeURIComponent(first.nextCursor), a.token)).data.code, "ACCESS_PAGE_CHANGED");
  assert.equal((await h.api("/api/v1/self/drafts", a.token)).data.items[0].id, "own-old");
  const saved = await h.api("/api/v1/self/drafts", a.token, { ...body, draftId: "own-old", revision: reconciled.revision, title: "继续编辑", inputValues: { flag: false } });
  assert.equal(saved.response.status, 200); assert.equal(saved.data.draft.isFavorite, true); assert.equal(saved.data.draft.inputValues.flag, false);
  const current = saved.data.draft;
  const concurrent = await Promise.all([true, false].map(isFavorite => h.api("/api/v1/self/drafts/own-old/favorite", a.token, { revision: current.revision, isFavorite }, "PATCH")));
  assert.deepEqual(concurrent.map(item => item.response.status).sort(), [200, 409]);
  const latest = (await h.api("/api/v1/self/drafts/own-old", a.token)).data.draft;
  const cancelled = await h.api("/api/v1/self/drafts/own-old/favorite", a.token, { revision: latest.revision, isFavorite: false }, "PATCH"); assert.equal(cancelled.data.draft.isFavorite, false);
  assert.deepEqual((await h.api("/api/v1/self/drafts", b.token)).data.items, []);
});

test("收藏异步落库前重新验证身份；旧捕获用户凭证失效不能写入", async t => {
  const h = await harness(t), user = await h.create("favoriteexpired");
  await h.access.setScenes({ userId: user.user.id, revision: 1, sceneIds: ["demo"] });
  const saved = await h.portal.saveDraft(user.identity, { draftId: "revoked-favorite", revision: 0, sceneId: "demo", versionId: "version-a", title: "身份校验", inputValues: { flag: true } });
  const original = h.portal.getDraft.bind(h.portal), started = deferred<void>(), gate = deferred<void>();
  h.portal.getDraft = async (...args) => { const result = await original(...args); started.resolve(); await gate.promise; return result; };
  const pending = h.portal.setDraftFavorite(user.identity, "revoked-favorite", { revision: saved.draft.revision, isFavorite: true });
  const rejected = assert.rejects(pending, error => error instanceof HttpError && error.status === 401);
  await started.promise;
  h.access.update({ userId: user.user.id, revision: 2, enabled: false }); gate.resolve(); await rejected;
  const stored = h.store.getDocument<{ isFavorite: boolean; revision: number }>(h.settings.projectDirectory, "user-drafts", "revoked-favorite")!;
  assert.equal(stored.isFavorite, false); assert.equal(stored.revision, saved.draft.revision);
});

test("任务草稿收藏新增字段真实stdio MCP隔离闭环：管理与本人工具到SQLite、旧revision/回执/排序/权限", async t => {
  const h = await harness(t), admin = await h.create("mcpfavoriteadmin", "admin"), a = await h.create("mcpfavoriteuser"), b = await h.create("mcpfavoriteother");
  await h.access.setScenes({ userId: a.user.id, revision: 1, sceneIds: ["demo"] });
  await h.workspace.mutateScoped(current => ({ workspace: { ...current, drafts: [
    { id: "mcp-legacy-old", title: "复用", sceneId: "demo", status: "draft", createdAt: "2026-09-01", inputValues: { flag: true } },
    { id: "mcp-legacy-new", title: "最近", sceneId: "demo", status: "draft", createdAt: "2026-10-05" },
  ] }, result: undefined }));
  const management = await mcp(t, h.base, admin.token), user = await mcp(t, h.base, a.token), other = await mcp(t, h.base, b.token);
  const before = (await management.call("get_task_draft", { draftId: "mcp-legacy-old" })).data;
  const favorite = await management.call("set_task_draft_favorite", { draftId: "mcp-legacy-old", revision: before.revision, isFavorite: true }); assert.equal(favorite.ok, true);
  assert.equal((await management.call("list_task_drafts", { limit: 1 })).data.items[0].id, "mcp-legacy-old");
  assert.equal((await h.api("/api/v1/task-drafts/mcp-legacy-old", admin.token)).data.draft.isFavorite, true);
  assert.equal((await management.call("set_task_draft_favorite", { draftId: "mcp-legacy-old", revision: before.revision, isFavorite: false })).error?.code, "DRAFT_REVISION_CONFLICT");
  assert.equal((await user.call("list_task_drafts")).error?.code, "ADMIN_REQUIRED");
  const draftId = "mcp-own-favorite";
  const created = await user.call("save_own_draft", { draftId, revision: 0, title: "常用草稿", sceneId: "demo", versionId: "version-a", inputValues: { flag: true } }); assert.equal(created.data.draft.isFavorite, false);
  // Intentionally discard the successful payload; use the same ID rather than replaying the tool.
  await user.call("set_own_draft_favorite", { draftId, revision: created.data.draft.revision, isFavorite: true });
  const reconciled = (await user.call("get_own_draft", { draftId })).data.draft; assert.equal(reconciled.isFavorite, true); assert.equal(reconciled.revision, 2); assert.equal(reconciled.updatedAt, created.data.draft.updatedAt);
  assert.equal((await user.call("list_own_drafts", { limit: 1 })).data.items[0].isFavorite, true);
  assert.equal((await other.call("set_own_draft_favorite", { draftId, revision: reconciled.revision, isFavorite: false })).error?.code, "OBJECT_NOT_FOUND");
  const edited = await user.call("save_own_draft", { draftId, revision: reconciled.revision, title: "复用编辑", sceneId: "demo", versionId: "version-a", inputValues: { flag: false } }); assert.equal(edited.data.draft.isFavorite, true);
  const cancelled = await user.call("set_own_draft_favorite", { draftId, revision: edited.data.draft.revision, isFavorite: false }); assert.equal(cancelled.data.draft.isFavorite, false);
  assert.equal(h.store.getDocument<{isFavorite:boolean}>(h.settings.projectDirectory, "user-drafts", draftId)!.isFavorite, false);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0, "收藏和编辑不执行模型或创建运行");
});


test("系统反馈HTTP：本人提交/管理员处理、归属与分页隔离、无Agent副作用、响应丢失及revision保护", async t => {
  const h = await harness(t), a = await h.create("feedbackuser"), b = await h.create("feedbackother"), admin = await h.create("feedbackadmin", "admin");
  const route = "/api/v1/self/system-feedback", feedbackId = randomUUID();
  const body = { feedbackId, title: "提交遇到问题", category: "bug", description: "重现步骤\n请管理员检查" };
  assert.equal((await h.api(route, "", body)).response.status, 401);
  assert.equal((await h.api(route, a.token, { ...body, userId: b.user.id })).response.status, 400);
  for (const patch of [{ title: " " }, { description: " " }, { description: "x".repeat(8001) }, { category: "agent" }, { feedbackId: "-".repeat(36) }]) {
    assert.equal((await h.api(route, a.token, { ...body, ...patch })).response.status, 400);
  }
  assert.equal((await h.api(route, a.token, { ...body, runId: randomUUID() })).response.status, 404);
  const before = JSON.stringify(await h.workspace.get());
  // Simulate a lost response: discard the success and reconcile with the original ID.
  assert.equal((await h.api(route, a.token, body)).response.status, 201);
  const saved = (await h.api(route + "/" + feedbackId, a.token)).data.feedback;
  assert.equal(saved.revision, 1); assert.equal(saved.status, "pending"); assert.equal(saved.userId, a.user.id); assert.equal(saved.description, body.description);
  assert.equal((await h.api(route, a.token, { ...body, description: "不能覆盖" })).data.code, "SYSTEM_FEEDBACK_ALREADY_EXISTS");
  assert.equal((await h.api(route + "/" + feedbackId, a.token)).data.feedback.description, body.description);
  assert.equal((await h.api(route + "/" + feedbackId, b.token)).response.status, 404);
  assert.deepEqual((await h.api(route, b.token)).data.items, []);
  assert.equal((await h.api("/api/v1/system-feedback", a.token)).response.status, 403);
  const handlePath = "/api/v1/system-feedback/" + feedbackId + "/handle";
  assert.equal((await h.api(handlePath, a.token, { revision: 1, status: "resolved", reply: "伪造处理" })).response.status, 403);
  assert.equal((await h.api(handlePath, admin.token, { revision: 1, status: "resolved", reply: " " })).response.status, 400);
  assert.equal((await h.api(handlePath, admin.token, { revision: 1, status: "pending", reply: "不能回退" })).data.code, "SYSTEM_FEEDBACK_STATE_CONFLICT");
  assert.equal((await h.api(handlePath, admin.token, { revision: 2, status: "resolved", reply: "错误未来版本" })).data.code, "SYSTEM_FEEDBACK_REVISION_CONFLICT");
  const concurrent = await Promise.all(["答复甲", "答复乙"].map(reply => h.api(handlePath, admin.token, { revision: 1, status: "processing", reply })));
  assert.deepEqual(concurrent.map(item => item.response.status).sort(), [200, 409]);
  assert.equal(concurrent.find(item => item.response.status === 409)!.data.code, "SYSTEM_FEEDBACK_REVISION_CONFLICT");
  const inProgress = (await h.api(route + "/" + feedbackId, a.token)).data.feedback;
  assert.equal(inProgress.revision, 2); assert.equal(inProgress.handledBy, admin.user.id);
  // Lost processing receipt also reconciles against the same ID, not by replaying a decision.
  await h.api(handlePath, admin.token, { revision: 2, status: "resolved", reply: "已修复，请重试" });
  const resolved = (await h.api(route + "/" + feedbackId, a.token)).data.feedback;
  assert.equal(resolved.status, "resolved"); assert.equal(resolved.revision, 3); assert.equal(resolved.reply, "已修复，请重试");
  assert.equal((await h.api(handlePath, admin.token, { revision: 2, status: "resolved", reply: "不重放" })).data.code, "SYSTEM_FEEDBACK_REVISION_CONFLICT");
  assert.equal((await h.api(handlePath, admin.token, { revision: 3, status: "rejected", reply: "终态不能直接切换" })).data.code, "SYSTEM_FEEDBACK_STATE_CONFLICT");
  assert.equal((await h.api(handlePath, admin.token, { revision: 3, status: "processing", reply: "明确重开" })).response.status, 200);
  await h.api(route, a.token, { ...body, feedbackId: randomUUID(), category: "suggestion" });
  await h.api(route, b.token, { ...body, feedbackId: randomUUID(), category: "other" });
  const page = (await h.api(route + "?limit=1", a.token)).data;
  assert.equal(page.total, 2); assert.equal(page.items.length, 1); assert.equal(page.hasMore, true);
  assert.equal(page.items[0].descriptionOmitted, true); assert.equal(page.items[0].replyOmitted, true);
  assert.ok(!("description" in page.items[0])); assert.ok(!("reply" in page.items[0]));
  const next = "?limit=1&cursor=" + encodeURIComponent(page.nextCursor);
  assert.equal((await h.api(route + next, a.token)).data.items.length, 1);
  assert.equal((await h.api(route + next, a.token)).data.hasMore, false);
  assert.equal((await h.api(route + next, b.token)).data.code, "INVALID_ACCESS_CURSOR");
  assert.equal((await h.api("/api/v1/system-feedback" + next, admin.token)).data.code, "INVALID_ACCESS_CURSOR");
  assert.equal((await h.api(route + next + "&status=processing", a.token)).data.code, "ACCESS_PAGE_CHANGED");
  assert.equal((await h.api(route + "?limit=0", a.token)).response.status, 400);
  assert.equal((await h.api(route + "?cursor=bad", a.token)).response.status, 400);
  assert.equal((await h.api("/api/v1/system-feedback", admin.token)).data.total, 3);
  await h.api(handlePath, admin.token, { revision: 4, status: "rejected", reply: "已说明原因" });
  assert.equal((await h.api(route + next, a.token)).data.code, "ACCESS_PAGE_CHANGED");
  assert.equal(JSON.stringify(await h.workspace.get()), before);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0, "反馈不创建运行、不执行Agent");
});

test("普通用户Agent反馈关闭：HTTP和权威服务均拒绝注入，但保留原状态机审核与无意见退回", async t => {
  const h = await harness(t, true), a = await h.create("nofeedback");
  await h.access.setScenes({ userId: a.user.id, revision: 1, sceneIds: ["demo"] });
  const runId = randomUUID();
  await h.api("/api/v1/self/scenes/demo/runs", a.token, { versionId: "version-a", runId, inputValues: { flag: true } });
  await until(() => h.store.getRun(h.settings.projectDirectory, runId)?.status === "waiting");
  const original = h.store.getRun(h.settings.projectDirectory, runId)!;
  const reviewId = original.pendingReview!.id;
  const input = { reviewId, action: "redo", feedback: "不允许注入Agent" };
  assert.equal((await h.api("/api/v1/self/runs/" + runId + "/review", a.token, input)).response.status, 400);
  await assert.rejects(h.portal.action(a.identity, runId, "review", input), (error: unknown) => error instanceof HttpError && error.status === 400);
  assert.deepEqual(h.store.getRun(h.settings.projectDirectory, runId), original);
  assert.equal((await h.api("/api/v1/runs/" + runId + "/review", a.token, input)).response.status, 403);
  const mine = await h.api("/api/v1/self/system-feedback", a.token, { feedbackId: randomUUID(), title: "任务结果问题", description: "交管理员处理", runId });
  assert.equal(mine.data.feedback.runId, runId);
  const other = await h.create("nofeedbackother");
  assert.equal((await h.api("/api/v1/self/system-feedback", other.token, { feedbackId: randomUUID(), title: "盗用关联", description: "他人任务", runId })).response.status, 404);
  assert.equal((await h.api("/api/v1/self/runs/" + runId + "/review", a.token, { reviewId, action: "redo" })).response.status, 202);
  await until(() => { const run = h.store.getRun(h.settings.projectDirectory, runId); return run?.status === "waiting" && run.pendingReview?.id !== reviewId; });
  const next = h.store.getRun(h.settings.projectDirectory, runId)!;
  assert.equal(next.feedbackHistory?.length ?? 0, 0);
  assert.equal((await h.api("/api/v1/self/runs/" + runId + "/review", a.token, { reviewId: next.pendingReview!.id, action: "approve" })).response.status, 202);
  await until(() => h.store.getRun(h.settings.projectDirectory, runId)?.status === "completed");
});

test("系统反馈真实stdio MCP隔离闭环：用户提交/按ID对账→管理员回复→本人读取；新字段、权限和旧revision", async t => {
  const h = await harness(t), admin = await h.create("mcpfeedbackadmin", "admin"), a = await h.create("mcpfeedbackuser"), b = await h.create("mcpfeedbackother");
  const management = await mcp(t, h.base, admin.token), user = await mcp(t, h.base, a.token), other = await mcp(t, h.base, b.token);
  const feedbackId = randomUUID();
  const created = await user.call("submit_system_feedback", { feedbackId, title: "界面建议", category: "suggestion", description: "请改善说明" });
  assert.equal(created.ok, true); assert.equal(created.data.feedback.userId, a.user.id); assert.equal(created.data.feedback.category, "suggestion");
  const stored = h.store.getDocument<{ category: string; description: string }>(h.settings.projectDirectory, "system-feedback", feedbackId)!;
  assert.equal(stored.category, "suggestion"); assert.equal(stored.description, "请改善说明");
  assert.equal((await user.call("submit_system_feedback", { feedbackId, title: "重复", description: "不要重放" })).error?.code, "SYSTEM_FEEDBACK_ALREADY_EXISTS");
  assert.equal((await user.call("get_own_system_feedback", { feedbackId })).data.feedback.revision, 1);
  assert.equal((await other.call("get_own_system_feedback", { feedbackId })).error?.code, "OBJECT_NOT_FOUND");
  assert.deepEqual((await other.call("list_own_system_feedback")).data.items, []);
  assert.equal((await user.call("list_system_feedback")).error?.code, "ADMIN_REQUIRED");
  assert.equal((await user.call("handle_system_feedback", { feedbackId, revision: 1, status: "resolved", reply: "越权" })).error?.code, "ADMIN_REQUIRED");
  const detail = await management.call("get_system_feedback", { feedbackId }); assert.equal(detail.data.feedback.description, "请改善说明");
  const page = await management.call("list_system_feedback", { status: "pending", limit: 1 }); assert.equal(page.data.items[0].descriptionOmitted, true);
  await management.call("handle_system_feedback", { feedbackId, revision: 1, status: "resolved", reply: "说明已补充" });
  const reconciled = (await user.call("get_own_system_feedback", { feedbackId })).data.feedback;
  assert.equal(reconciled.status, "resolved"); assert.equal(reconciled.reply, "说明已补充"); assert.equal(reconciled.revision, 2);
  assert.equal((await management.call("handle_system_feedback", { feedbackId, revision: 1, status: "processing", reply: "旧版本" })).error?.code, "SYSTEM_FEEDBACK_REVISION_CONFLICT");
  assert.equal((await user.call("list_own_system_feedback", { status: "resolved" })).data.total, 1);
  const invalid = await user.client.callTool({ name: "review_own_run", arguments: { runId: randomUUID(), reviewId: "review", action: "redo", feedback: "不能注入Agent" } });
  assert.equal(invalid.isError, true);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);
});


test("系统反馈落库前重验身份：等待时撤销用户/管理员凭证不写入；SQLite持久化与机器响应一致", async t => {
  const h = await harness(t), a = await h.create("delayedfeedback"), admin = await h.create("delayedfeedbackadmin", "admin");
  const entered = deferred<void>(), release = deferred<void>(), feedbackId = randomUUID();
  const service = new SystemFeedbackService(h.access, async () => { entered.resolve(); await release.promise; return h.settings.projectDirectory; });
  const write = service.create(a.identity, { feedbackId, title: "待核验", description: "撤销后不能写入" });
  const rejected = assert.rejects(write, (error: unknown) => error instanceof HttpError && error.status === 401);
  await entered.promise; h.access.logout(a.identity); release.resolve(); await rejected;
  assert.equal(h.store.getDocument(h.settings.projectDirectory, "system-feedback", feedbackId), undefined);
  const fresh = await h.access.login(a.user.username, password), identity = h.access.authenticate(fresh.token);
  const normal = new SystemFeedbackService(h.access, async () => h.settings.projectDirectory);
  const created = await normal.create(identity, { feedbackId, title: "持久反馈", description: "x".repeat(8000) });
  assert.equal(systemFeedbackEnvelope.safeParse(created).success, true);
  assert.equal(systemFeedbackPage.safeParse(await normal.list(identity, { limit: 1 })).success, true);
  assert.equal((await normal.get(identity, { feedbackId })).feedback.description.length, 8000);
  const secondEntered = deferred<void>(), secondRelease = deferred<void>(); let reads = 0;
  const management = new SystemFeedbackService(h.access, async () => { if (++reads === 2) { secondEntered.resolve(); await secondRelease.promise; } return h.settings.projectDirectory; });
  const handling = management.handle(admin.identity, { feedbackId, revision: 1, status: "resolved", reply: "不应落库" });
  const notHandled = assert.rejects(handling, (error: unknown) => error instanceof HttpError && error.status === 401);
  await secondEntered.promise; h.access.logout(admin.identity); secondRelease.resolve(); await notHandled;
  assert.equal((await normal.get(identity, { feedbackId })).feedback.revision, 1);
  // Open a new SQLite connection to the same temporary authoritative file, not a parallel inbox database.
  const reopened = new SqliteStore(path.join(h.root, "metadata.db"));
  try { assert.deepEqual(reopened.getDocument(h.settings.projectDirectory, "system-feedback", feedbackId), created.feedback); } finally { reopened.close(); }
});


test("媒体打包：本人/管理员同一服务，他人/未归属历史不可读，撤权后的GET与HEAD同步拒绝", async t => {
  const h = await harness(t); const a = await h.create("archivealpha"); const b = await h.create("archivebeta"); const admin = await h.create("archiveadmin", "admin");
  await h.access.setScenes({ userId: a.user.id, revision: 1, sceneIds: ["demo"] });
  const runId = randomUUID(); await h.api("/api/v1/self/scenes/demo/runs", a.token, { versionId: "version-a", runId, inputValues: { flag: true } });
  await until(() => h.store.getRun(h.settings.projectDirectory, runId)?.status === "completed");
  const run = h.store.getRun(h.settings.projectDirectory, runId)!;
  const dir = path.join(run.artifacts.directory, "outputs", "media"); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, "fixture.png"), Buffer.from("mock PNG"));
  run.outputs = [{ key: "images", label: "images", type: "image_list", value: [{ url: "/api/workflows/runs/" + runId + "/media/fixture.png" }] }]; h.store.saveRun(h.settings.projectDirectory, run, []);
  const own = "/api/v1/self/runs/" + runId + "/media-export?outputKey=images";
  assert.equal((await h.api(own, b.token)).response.status, 404); const info = await h.api(own, a.token); assert.equal(info.response.status, 200);
  assert.equal((await h.api("/api/v1/runs/" + runId + "/media-export?outputKey=images", admin.token)).response.status, 200);
  const download = () => fetch(h.base + info.data.downloadUrl, { method: "HEAD", headers: { Authorization: "Bearer " + a.token } }); assert.equal((await download()).status, 200);
  await h.access.setScenes({ userId: a.user.id, revision: h.access.get(a.user.id).revision, sceneIds: [] }); assert.equal((await h.api(own, a.token)).response.status, 403); assert.equal((await download()).status, 403);
  run.ownerUserId = undefined; h.store.saveRun(h.settings.projectDirectory, run, []); assert.equal((await h.api(own, a.token)).response.status, 404); assert.equal((await h.api(own, admin.token)).response.status, 200);
});
