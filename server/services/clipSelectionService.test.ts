import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { productionHarness } from "../testing/productionSupport.js";
import { id, submission } from "../testing/testSupport.js";
import { HttpError } from "../errors.js";
import type { RunWorkflowDefinition } from "../domain/types.js";
function definition(): RunWorkflowDefinition { return {sceneId:"test-scene",name:"两镜视频",inputs:[{key:"shots",type:"json",required:true}],steps:[{id:"generate",name:"逐镜生成",kind:"fake",promptTemplate:"v1",execution:{mode:"for_each",sourceRef:"input.shots"},outputs:[{key:"clips",type:"video_list"}]}],outputs:[{key:"clips",type:"video_list",sourceRef:"step.generate.outputs.clips"}]}; }
const shots=[{index:1,action:"第一镜"},{index:2,action:"第二镜"}];

test("镜头候选只匹配同修订链且内容一致；新候选不自动覆盖选版",async t=>{
  let file="";let calls=0;const h=await productionHarness(t,{kind:"fake",async execute(){calls++;return {clips:[file]};}});file=path.join(h.root,"clip.mp4");await writeFile(file,"fixture video");await h.service.start();const first=await h.service.submit(submission(id("clips-base"),definition(),{shots}));await h.service.wait(h.settings.projectDirectory,first.runId);
  let selection=await h.clips.create({sourceRunId:first.runId,stepId:"generate",outputKey:"clips",name:"第一集"});const initial=structuredClone(selection);assert.ok(selection.shots.every(shot=>shot.choice?.assetId));
  const revised=await h.service.submit({...submission(id("clips-revised"),definition()),rerunFromRunId:first.runId,rerunRequest:{stepOverrides:[{stepId:"generate",itemIndex:1,promptTemplate:"v2"}]}});await h.service.wait(h.settings.projectDirectory,revised.runId);
  const unrelated=await h.service.submit(submission(id("clips-unrelated"),definition(),{shots}));await h.service.wait(h.settings.projectDirectory,unrelated.runId);
  const changed=await h.service.submit({...submission(id("clips-changed-story"),definition()),rerunFromRunId:first.runId,rerunRequest:{inputOverrides:{shots:[{index:1,action:"另一个第一镜"},shots[1]]}}});await h.service.wait(h.settings.projectDirectory,changed.runId);
  const candidates=await h.clips.candidates(h.settings.projectDirectory,selection);assert.ok(candidates[1].candidates.some(item=>item.source.runId===revised.runId));assert.ok(!candidates[0].candidates.some(item=>[unrelated.runId,changed.runId].includes(item.source.runId)));
  assert.deepEqual(h.clips.get(h.settings.projectDirectory,selection.id).shots,initial.shots);
  const wrong=candidates[1].candidates.find(item=>item.source.runId===revised.runId)!;await assert.rejects(h.clips.update(selection.id,{revision:selection.revision,shotId:selection.shots[0].shotId,source:wrong.source}),/不属于当前分镜/);
  const source=candidates[1].candidates.find(item=>item.source.runId===revised.runId)!.source;selection=await h.clips.update(selection.id,{revision:selection.revision,shotId:selection.shots[1].shotId,source});assert.deepEqual(selection.shots[0].choice,initial.shots[0].choice);assert.equal(selection.shots[1].choice?.source.runId,revised.runId);
  await assert.rejects(h.clips.update(selection.id,{revision:initial.revision,shotId:selection.shots[0].shotId,source:candidates[0].candidates[0].source}),error=>error instanceof HttpError&&error.status===409);
  await assert.rejects(h.clips.update(selection.id,{revision:selection.revision,shotOrder:[selection.shots[0].shotId,selection.shots[0].shotId]}),/不能重复/);
  const order=[selection.shots[1].shotId,selection.shots[0].shotId];selection=await h.clips.update(selection.id,{revision:selection.revision,shotOrder:order});assert.deepEqual(selection.shots.map(shot=>shot.shotId),order);
  await unlink(file);for(const shot of selection.shots)assert.equal((await readFile(h.assets.file(h.settings.projectDirectory,shot.choice!.assetId!,shot.choice!.assetVersion!))).toString(),"fixture video");await h.restart();assert.deepEqual(h.clips.get(h.settings.projectDirectory,selection.id).shots,selection.shots);assert.ok(calls>=3);
});

test("失败批次可收藏成功镜头，但缺失镜头不能提交合成",async t=>{
  let file="";const h=await productionHarness(t,{kind:"fake",async execute({inputValues}){if((inputValues["iteration.item"] as {index:number}).index===2)throw new Error("第二镜失败");return {clips:[file]};}});file=path.join(h.root,"partial.mp4");await writeFile(file,"partial");await h.service.start();const run=await h.service.submit(submission(id("clips-partial"),definition(),{shots}));const result=await h.service.wait(h.settings.projectDirectory,run.runId);assert.equal(result.status,"failed");
  const selection=await h.clips.create({sourceRunId:run.runId,stepId:"generate",outputKey:"clips",name:"失败选片"});assert.equal(selection.shots[0].choice?.source.itemIndex,0);assert.equal(selection.shots[1].choice,undefined);await assert.rejects(h.clips.compose(selection.id,{revision:selection.revision}),/每个镜头都需要/);
});

test("选片合成按清单顺序产出固定素材版本，原文件移除仍可整理且不调用生成节点",async t=>{
  let file="";let calls=0;const h=await productionHarness(t,{kind:"fake",async execute(){calls++;return {clips:[file]};}});file=path.join(h.root,"clip.mp4");await writeFile(file,"fixture video");await h.service.start();
  const base=await h.service.submit(submission(id("composition-base"),definition(),{shots}));await h.service.wait(h.settings.projectDirectory,base.runId);
  let selection=await h.clips.create({sourceRunId:base.runId,stepId:"generate",outputKey:"clips",name:"选片合成"});
  const revised=await h.service.submit({...submission(id("composition-revised"),definition()),rerunFromRunId:base.runId,rerunRequest:{stepOverrides:[{stepId:"generate",itemIndex:1,promptTemplate:"v2"}]}});await h.service.wait(h.settings.projectDirectory,revised.runId);
  const candidates=await h.clips.candidates(h.settings.projectDirectory,selection);selection=await h.clips.update(selection.id,{revision:selection.revision,shotId:selection.shots[1].shotId,source:candidates[1].candidates.find(item=>item.source.runId===revised.runId)!.source});
  await unlink(file);const before=calls;const composed=await h.clips.compose(selection.id,{revision:selection.revision});const result=await h.service.wait(h.settings.projectDirectory,composed.runId);
  assert.equal(result.status,"completed",result.error);assert.equal(calls,before);assert.equal(result.workflow.steps.length,1);assert.equal(result.workflow.steps[0].capabilityId,"core.code");
  assert.equal((result.inputValues.selection as unknown as {revision:number}).revision,selection.revision);
  const video=result.outputs.find(output=>output.key==="video")!.value as Array<{url?:string;assetId?:string}>;
  assert.equal(video.length,2);assert.ok(video.every(item=>item.url||item.assetId));
  const manifest=result.outputs.find(output=>output.key==="manifest")!.value as {count:number;shots:Array<{index:number;assetId:string;assetVersion:number;filename:string}>};
  assert.equal(manifest.count,2);assert.deepEqual(manifest.shots.map(row=>row.index),[1,2]);
  assert.deepEqual(manifest.shots.map(row=>[row.assetId,row.assetVersion]),selection.shots.map(shot=>[shot.choice!.assetId,shot.choice!.assetVersion]));
  for(const shot of selection.shots)assert.equal((await readFile(h.assets.file(h.settings.projectDirectory,shot.choice!.assetId!,shot.choice!.assetVersion!))).toString(),"fixture video");
});
