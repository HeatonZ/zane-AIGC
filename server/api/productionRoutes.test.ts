import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { productionHarness } from "../testing/productionSupport.js";
import { createAssetRouter } from "./assetRoutes.js";
import { createClipSelectionRouter } from "./clipSelectionRoutes.js";
import { createRunRouter } from "./runRoutes.js";
import { HttpError } from "../errors.js";
import { id, submission, workflow } from "../testing/testSupport.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssetRecord } from "../domain/productionContracts.js";

test("生产API：素材上传、筛选、版本流式Range与确认路由",async t=>{
  const h=await productionHarness(t);await h.service.start();const app=express();app.use(express.json());app.use(createAssetRouter(h.assets));app.use(createClipSelectionRouter(h.clips));app.use(createRunRouter(h.service,async()=>h.settings));app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error instanceof HttpError?error.status:500).json({error:(error as Error).message}));const server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));t.after(()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();}));const base="http://127.0.0.1:"+(server.address()as{port:number}).port;
  const upload=await fetch(base+"/api/v1/assets/upload?createId="+id("hero-http-upload")+"&kind=image&category=character&name=Hero",{method:"POST",headers:{"Content-Type":"application/octet-stream","X-File-Name":"hero.png"},body:"0123456789"});assert.equal(upload.status,201);const {asset}=await upload.json()as{asset:AssetRecord};
  const list=await fetch(base+"/api/v1/assets?kind=image&q=Hero");assert.equal(((await list.json())as{assets:AssetRecord[]}).assets[0].id,asset.id);
  const media=base+"/api/v1/assets/"+asset.id+"/versions/1/media";const range=await fetch(media,{headers:{Range:"bytes=2-5"}});assert.equal(range.status,206);assert.equal(await range.text(),"2345");const head=await fetch(media,{method:"HEAD"});assert.equal(head.headers.get("content-length"),"10");
  const metadata=await fetch(base+"/api/v1/assets/"+asset.id,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision:asset.revision,archived:true})});assert.equal(metadata.status,200);assert.equal(((await(await fetch(base+"/api/v1/assets")).json())as{assets:AssetRecord[]}).assets.length,0);assert.equal((await fetch(media)).status,200);
  const definition=workflow([{id:"review",name:"确认",kind:"fake",review:{enabled:true},outputs:[{key:"value",type:"text"}]}]);const run=await h.service.submit(submission(id("review-http"),definition));const waiting=await h.service.wait(h.settings.projectDirectory,run.runId);const waitingList=await fetch(base+"/api/v1/runs?status=waiting");assert.equal(waitingList.status,200);assert.deepEqual(((await waitingList.json())as{runs:Array<{runId:string}>}).runs.map(item=>item.runId),[run.runId]);const review=await fetch(base+"/api/v1/runs/"+run.runId+"/review",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({reviewId:waiting.pendingReview!.id,action:"approve",outputs:{value:"已确认"}})});assert.equal(review.status,202);assert.equal((await h.service.wait(h.settings.projectDirectory,run.runId)).status,"completed");assert.equal((await fetch(base+"/api/v1/runs/"+run.runId+"/review",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({reviewId:waiting.pendingReview!.id,action:"approve"})})).status,409);
});

test("运行output-media读取本地/祖先归档、HEAD与Range，外部地址不会触发下载", async t => {
  const bytes = "isolated archived image";
  const h = await productionHarness(t, { kind: "fake", async execute(context) {
    const directory = path.join(context.settings.projectDirectory, ".zane", "runs", context.runId, "outputs", "media");
    await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "cover.jpg"), bytes);
    return { image: ["/api/workflows/runs/" + context.runId + "/media/cover.jpg"] };
  } });
  await h.service.start();
  const definition = workflow([{ id: "image", name: "归档图", kind: "fake", outputs: [{ key: "image", type: "image_list" }] }]);
  definition.outputs = [{ key: "image", type: "image_list", sourceRef: "step.image.outputs.image" }];
  const submitted = await h.service.submit(submission(id("output-media"), definition));
  const original = await h.service.wait(h.settings.projectDirectory, submitted.runId); assert.equal(original.status, "completed");
  const descendantId = id("output-media-descendant"); h.store.importRun(h.settings.projectDirectory, { ...original, runId: descendantId, rerunFromRunId: original.runId });
  const app = express(); app.use(createAssetRouter(h.assets));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  for (const runId of [original.runId, descendantId]) {
    for (const suffix of ["", "&stepId=image"]) {
      const url = base + "/api/v1/runs/" + runId + "/output-media?outputKey=image&mediaIndex=0" + suffix;
      const response = await fetch(url); assert.equal(response.status, 200); assert.equal(await response.text(), bytes);
      const head = await fetch(url, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), String(bytes.length));
      const range = await fetch(url, { headers: { Range: "bytes=0-7" } }); assert.equal(range.status, 206); assert.equal(await range.text(), bytes.slice(0, 8));
    }
  }
  const externalId = id("output-media-external");
  h.store.importRun(h.settings.projectDirectory, { ...original, runId: externalId, outputs: [{ key: "image", label: "外部地址", type: "image_list", value: ["https://example.invalid/cover.jpg"] }] });
  assert.equal((await fetch(base + "/api/v1/runs/" + externalId + "/output-media?outputKey=image")).status, 400);
  assert.throws(() => h.assets.localMediaFile(h.settings.projectDirectory, "/api/comfyui/view?filename=cover.jpg"), HttpError);
});