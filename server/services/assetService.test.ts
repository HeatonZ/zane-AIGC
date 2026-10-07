import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, unlink, readdir } from "node:fs/promises";
import path from "node:path";
import { productionHarness } from "../testing/productionSupport.js";
import { id, submission, workflow } from "../testing/testSupport.js";
import { externalizeRuntimeValue, normalizeWorkflowMediaInputs } from "../domain/workflowValues.js";
import { HttpError } from "../errors.js";
import type { JsonValue, RunRecord } from "../domain/types.js";
import { artifactPublicPaths, runArtifactPaths } from "../artifacts/runArtifacts.js";

test("素材导入：内容哈希去重，版本固定，归档后旧引用仍能执行", async t => {
  const h = await productionHarness(t); const first = await h.assets.save({name:"主角",kind:"image",category:"character"},{bytes:Buffer.from("first image"),filename:"hero.png"});
  const duplicate = await h.assets.save({name:"同内容",kind:"image",category:"material"},{bytes:Buffer.from("first image"),filename:"other.png"});
  assert.equal(first.asset.versions[0].filename,duplicate.asset.versions[0].filename);
  const second = await h.assets.save({assetId:first.asset.id,revision:first.asset.revision,name:"主角",kind:"image",category:"character"},{bytes:Buffer.from("second image"),filename:"hero.png"});
  assert.equal(second.asset.currentVersion,2); assert.equal(second.asset.versions.length,2);
  assert.equal((await readFile(h.assets.file(h.settings.projectDirectory,first.asset.id,1))).toString(),"first image");
  const definition = workflow(); definition.inputs=[{key:"image",type:"image_list",required:true}];
  const resolved = await h.assets.resolveInputs(h.settings.projectDirectory,definition,{image:[first.reference] as never});
  const roundTrip = externalizeRuntimeValue(normalizeWorkflowMediaInputs(definition,resolved)) as {image:Array<Record<string,unknown>>};
  assert.equal(roundTrip.image[0].assetId,first.asset.id); assert.equal(roundTrip.image[0].assetVersion,1); assert.ok(roundTrip.image[0].path); assert.equal(roundTrip.image[0].filename,undefined); assert.match(String(roundTrip.image[0].previewUrl),/versions\/1\/media/);
  await h.assets.update(first.asset.id,{revision:second.asset.revision,archived:true});
  assert.ok(await h.assets.resolveInputs(h.settings.projectDirectory,definition,{image:[first.reference] as never}));
  await h.service.start(); const run=await h.service.submit(submission(id("asset-pinned"),definition,{image:[first.reference] as never})); const result=await h.service.wait(h.settings.projectDirectory,run.runId);
  assert.equal(result.status,"completed"); assert.equal((result.inputValues.image as Array<{assetVersion:number}>)[0].assetVersion,1);
  assert.equal((await readdir(path.join(h.settings.projectDirectory,".zane","assets","blobs"))).filter(name=>!name.startsWith(".")).length,2);
});

test("素材引用错误在排队前拒绝；元信息乐观锁不覆盖新内容", async t => {
  const h=await productionHarness(t);const asset=await h.assets.save({name:"声音",kind:"audio",category:"voice"},{bytes:Buffer.from("audio"),filename:"voice.wav"});
  await assert.rejects(h.assets.resolveValue(h.settings.projectDirectory,"image",asset.reference),/类型不匹配/);
  await assert.rejects(h.assets.resolveValue(h.settings.projectDirectory,"audio",{assetId:asset.asset.id}),/未指定有效版本/);
  const changed=await h.assets.update(asset.asset.id,{revision:asset.asset.revision,name:"声音2",group:"第一集",tags:["主角"]});
  await assert.rejects(h.assets.update(asset.asset.id,{revision:asset.asset.revision,name:"过期修改"}),error=>error instanceof HttpError&&error.status===409);
  assert.equal(h.assets.get(h.settings.projectDirectory,asset.asset.id)?.name,changed.name);
  await unlink(h.assets.file(h.settings.projectDirectory,asset.asset.id,1));
  const definition=workflow();definition.inputs=[{key:"voice",type:"audio_list",required:true}];
  await assert.rejects(h.service.submit(submission(id("missing-asset"),definition,{voice:[asset.reference] as never})),/文件已丢失/);assert.equal(h.store.getRun(h.settings.projectDirectory,id("missing-asset")),undefined);
});

test("收藏生成结果保存来源参数，移除原运行文件后素材版本仍可读取", async t => {
  let filename="";const h=await productionHarness(t,{kind:"fake",async execute(){return {image:[filename]};}});filename=path.join(h.root,"generated.png");await writeFile(filename,"generated pixels");await h.service.start();
  const definition=workflow([{id:"image",name:"角色图",kind:"fake",promptTemplate:"角色设定",outputs:[{key:"image",type:"image_list"}]}]);definition.outputs=[{key:"image",type:"image_list",sourceRef:"step.image.outputs.image"}];
  const run=await h.service.submit(submission(id("collect-source"),definition));await h.service.wait(h.settings.projectDirectory,run.runId);
  const saved=await h.assets.save({name:"角色A",category:"character",source:{runId:run.runId,stepId:"image",outputKey:"image",mediaIndex:0}});await unlink(filename);
  assert.equal((await readFile(h.assets.file(h.settings.projectDirectory,saved.asset.id,1))).toString(),"generated pixels");assert.equal(saved.asset.versions[0].source?.runId,run.runId);assert.equal((saved.asset.versions[0].parameters?.step as {promptTemplate:string}).promptTemplate,"角色设定");
  await h.restart();assert.equal(h.assets.get(h.settings.projectDirectory,saved.asset.id)?.name,"角色A");
});

test("收藏修订复用的媒体使用祖先归档地址，而不是错误地查新运行目录",async t=>{
  const h=await productionHarness(t);await h.service.start();const runId=id("ancestor-output");const directory=path.join(h.settings.projectDirectory,".zane","runs",runId,"outputs","media");await mkdir(directory,{recursive:true});await writeFile(path.join(directory,"image.png"),"ancestor image");
  const definition=workflow([{id:"image",name:"图片",kind:"fake",outputs:[{key:"image",type:"image_list"}]}]);definition.outputs=[];
  const source={runId,sceneId:"test-scene",workflowName:"祖先",status:"completed" as const,createdAt:new Date().toISOString(),startedAt:new Date().toISOString(),inputValues:{},workflow:definition,artifacts:{directory,inputs:"",workflow:"",runtime:"",output:""},steps:[{stepId:"image",name:"图片",status:"completed" as const,outputs:{image:[{filename:"image.png",file:"outputs/media/image.png",url:"/api/v1/runs/"+runId+"/media/image.png"}]},outputTypes:{image:"image_list"}}],outputs:[]};h.store.importRun(h.settings.projectDirectory,source);
  h.store.importRun(h.settings.projectDirectory,{...source,runId:id("descendant-output"),rerunFromRunId:runId});
  const saved=await h.assets.save({name:"复用图",source:{runId:id("descendant-output"),stepId:"image",outputKey:"image",mediaIndex:0}});assert.equal((await readFile(h.assets.file(h.settings.projectDirectory,saved.asset.id,1))).toString(),"ancestor image");
});


test("受保护素材URL固定解析为内部引用、归档后交给执行器，不下载401接口或切到最新版", async t => {
  let seen: unknown;
  const base = "http://127.0.0.1:4242";
  const h = await productionHarness(t, { kind: "fake", async execute(context): Promise<Record<string, JsonValue>> { seen = externalizeRuntimeValue(context.inputValues.image); return { value: "ok" }; } }, () => base);
  const first = await h.assets.save({ name: "原素材", kind: "image" }, { bytes: Buffer.from("version-one"), filename: "input.png" });
  const latest = await h.assets.save({ assetId: first.asset.id, revision: first.asset.revision, name: "新版", kind: "image" }, { bytes: Buffer.from("version-two"), filename: "input.png" });
  const flow = workflow(); flow.inputs = [{ key: "image", type: "image_list", required: true }];
  const inputs = { image: [base + first.reference.previewUrl, latest.reference, { url: "http://localhost:4242" + first.reference.previewUrl, filename: "fake.png", type: "output", path: "spoof" }] } as never;
  const resolved = await h.assets.resolveInputs(h.settings.projectDirectory, flow, inputs);
  const records = resolved.image as Array<Record<string, unknown>>;
  assert.deepEqual(records.map(item => item.assetVersion), [1, 2, 1]);
  for (const item of records) { assert.ok(item.path); assert.equal(item.url, undefined); assert.equal(item.filename, undefined); }
  await h.service.start();
  const run = await h.service.submit(submission(id("asset-url-run"), flow, inputs));
  const result = await h.service.wait(h.settings.projectDirectory, run.runId);
  assert.equal(result.status, "completed");
  const used = seen as Array<Record<string, unknown>>;
  assert.deepEqual(used.map(item => item.assetVersion), [1, 2, 1]);
  for (const [index, item] of used.entries()) { assert.ok(String(item.path).startsWith(result.artifacts.directory)); assert.equal((await readFile(String(item.path))).toString(), index === 1 ? "version-two" : "version-one"); }
  assert.equal(h.assets.get(h.settings.projectDirectory, first.asset.id)?.currentVersion, 2);
});

test("素材URL与runtime媒体包装都通过同一类型/固定版本/文件校验，错误不入队", async t => {
  const base = "http://127.0.0.1:4242";
  const h = await productionHarness(t, undefined, () => base);
  const asset = await h.assets.save({ name: "图片", kind: "image" }, { bytes: Buffer.from("pixels"), filename: "in.png" });
  const url = base + asset.reference.previewUrl;
  const wrapped = normalizeWorkflowMediaInputs(workflowWithImage(), { image: [url] }).image;
  const resolved = await h.assets.resolveValue(h.settings.projectDirectory, "image", wrapped) as Array<Record<string, unknown>>;
  assert.equal(resolved[0].assetId, asset.asset.id); assert.equal(resolved[0].assetVersion, 1);
  await assert.rejects(h.assets.resolveValue(h.settings.projectDirectory, "audio", url), error => error instanceof HttpError && error.code === "INVALID_ASSET_REFERENCE");
  const invalid = url.replace("/versions/1/", "/versions/2/");
  await assert.rejects(h.service.submit(submission(id("bad-asset-url"), workflowWithImage(), { image: [invalid] })), error => error instanceof HttpError && error.code === "INVALID_ASSET_REFERENCE");
  assert.equal(h.store.getRun(h.settings.projectDirectory, id("bad-asset-url")), undefined);
  await unlink(h.assets.file(h.settings.projectDirectory, asset.asset.id, 1));
  await assert.rejects(h.assets.resolveValue(h.settings.projectDirectory, "image", url), error => error instanceof HttpError && error.code === "ASSET_FILE_MISSING");
});
function workflowWithImage() { const flow = workflow(); flow.inputs = [{ key: "image", type: "image_list", required: true }]; return flow; }


test("旧401失败运行保留原URL快照；显式续跑解析固定素材且复用已完成Writer，不重传或重做提示词", async t => {
  const base = "http://127.0.0.1:4242"; let writerCalls = 0, imageCalls = 0;
  const h = await productionHarness(t, { kind: "fake", async execute(context): Promise<Record<string, JsonValue>> {
    if (context.step.id === "writer") { writerCalls++; return { prompt: "不应重做" }; }
    imageCalls++;
    assert.equal(context.stepValues.get("writer")?.prompt, "已完成Writer输出");
    const media = externalizeRuntimeValue(context.inputValues.image) as Array<Record<string, unknown>>;
    assert.equal(media[0].assetVersion, 1);
    assert.equal((await readFile(String(media[0].path))).toString(), "original-pixels");
    return { value: "ok" };
  } }, () => base);
  const asset = await h.assets.save({ name: "旧素材", kind: "image" }, { bytes: Buffer.from("original-pixels"), filename: "original.png" });
  await h.assets.save({ assetId: asset.asset.id, revision: asset.asset.revision, name: "素材新版本", kind: "image" }, { bytes: Buffer.from("latest-pixels"), filename: "original.png" });
  const flow = workflow([{ id: "writer", name: "Writer提示词", kind: "fake", outputs: [{ key: "prompt", type: "text" }] }, { id: "image", name: "Comfy素材读取", kind: "fake", inputs: [{ key: "prompt", sourceRef: "step.writer.outputs.prompt" }], outputs: [{ key: "value", type: "text" }] }]);
  flow.inputs = [{ key: "image", type: "image_list", required: true }];
  const sourceId = id("legacy-media-401"), now = new Date().toISOString();
  const source: RunRecord = { runId: sourceId, sceneId: flow.sceneId ?? "test-scene", workflowName: flow.name ?? "测试流程", workflow: flow, inputValues: { image: [base + asset.reference.previewUrl] }, status: "failed", error: "媒体服务返回 401", createdAt: now, startedAt: now, finishedAt: now, durationMs: 1, outputs: [], artifacts: artifactPublicPaths(runArtifactPaths(h.settings.projectDirectory, sourceId)), steps: [{ stepId: "writer", name: "Writer提示词", status: "completed", outputs: { prompt: "已完成Writer输出" }, outputTypes: { prompt: "text" } }, { stepId: "image", name: "Comfy素材读取", status: "failed", message: "媒体服务返回 401", outputs: {} }] };
  h.store.importRun(h.settings.projectDirectory, source);
  await h.service.start();
  const request = { ...submission(id("legacy-media-resume"), flow), resumeFromRunId: sourceId };
  const accepted = await h.service.submit(request); const completed = await h.service.wait(h.settings.projectDirectory, accepted.runId);
  assert.equal(completed.status, "completed", completed.error); assert.equal(completed.resumedFromRunId, sourceId);
  assert.equal(writerCalls, 0); assert.equal(imageCalls, 1);
  assert.deepEqual(h.store.getRun(h.settings.projectDirectory, sourceId), source);
  await assert.rejects(h.service.submit(request), error => error instanceof HttpError && error.status === 409);
  assert.equal(imageCalls, 1);
});
