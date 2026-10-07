import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { productionHarness } from "../testing/productionSupport.js";
import { id, submission } from "../testing/testSupport.js";
import { execFileAsync, ffmpegBinary, ffprobeBinary } from "../config.js";
import { probeVideoClip } from "../execution/videoConcat.js";
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

const available=[ffmpegBinary,ffprobeBinary].every(binary=>spawnSync(binary,["-version"],{windowsHide:true,stdio:"ignore"}).status===0);
test("真实FFmpeg跨版本选片合成：顺序固定，原文件移除仍可合成且不调用生成节点",{skip:!available},async t=>{
  let original="",revisedFile="",calls=0;const h=await productionHarness(t,{kind:"fake",async execute({step}){calls++;return {clips:[step.promptTemplate==="v2"?revisedFile:original]};}});original=path.join(h.root,"original.mp4");revisedFile=path.join(h.root,"revised.mp4");
  for(const [file,color,frequency]of[[original,"red","400"],[revisedFile,"blue","800"]])await execFileAsync(ffmpegBinary,["-v","error","-f","lavfi","-i","color=c="+color+":s=160x90:r=24:d=0.5","-f","lavfi","-i","sine=frequency="+frequency+":sample_rate=48000:duration=0.5","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-shortest",file],{windowsHide:true,timeout:30000});
  await h.service.start();const base=await h.service.submit(submission(id("real-selection-base"),definition(),{shots}));await h.service.wait(h.settings.projectDirectory,base.runId);let selection=await h.clips.create({sourceRunId:base.runId,stepId:"generate",outputKey:"clips",name:"真实选片"});
  const revised=await h.service.submit({...submission(id("real-selection-revised"),definition()),rerunFromRunId:base.runId,rerunRequest:{stepOverrides:[{stepId:"generate",itemIndex:1,promptTemplate:"v2"}]}});await h.service.wait(h.settings.projectDirectory,revised.runId);const candidates=await h.clips.candidates(h.settings.projectDirectory,selection);selection=await h.clips.update(selection.id,{revision:selection.revision,shotId:selection.shots[1].shotId,source:candidates[1].candidates.find(item=>item.source.runId===revised.runId)!.source});await unlink(original);await unlink(revisedFile);
  const before=calls;const composed=await h.clips.compose(selection.id,{revision:selection.revision});const result=await h.service.wait(h.settings.projectDirectory,composed.runId);assert.equal(result.status,"completed",result.error);assert.equal(calls,before);assert.equal(result.workflow.steps.length,1);assert.equal(result.workflow.steps[0].capabilityId,"media.video_concat");assert.equal((result.inputValues.selection as unknown as {revision:number}).revision,selection.revision);
  const media=(result.outputs[0].value as Array<string|{url:string}>)[0];const url=typeof media==="string"?media:media.url;const final=path.join(result.artifacts.directory,"outputs","media",path.basename(url));const info=await probeVideoClip(final);assert.equal(info.audio,true);assert.ok(info.duration>=0.95&&info.duration<1.3);
  for(const [time,channel]of[["0.1",0],["0.8",2]]as const){const {stdout}=await execFileAsync(ffmpegBinary,["-v","error","-ss",time,"-i",final,"-frames:v","1","-vf","scale=1:1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"],{encoding:"buffer",windowsHide:true,timeout:30000});assert.ok(stdout[channel]>stdout[channel===0?2:0]+80,"应为旧版红色第一镜、新版蓝色第二镜");}
});
