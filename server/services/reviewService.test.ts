import test from "node:test";
import assert from "node:assert/strict";
import { productionHarness } from "../testing/productionSupport.js";
import { id, submission, workflow, until } from "../testing/testSupport.js";
import { externalizeRuntimeValue, resolveStepInputs } from "../domain/workflowValues.js";
import { HttpError } from "../errors.js";
const conflict = (error:unknown) => error instanceof HttpError && error.status===409;

test("确认关卡拦住下游且释放worker；修改文本后继续不重复前序生成",async t=>{
  const calls:string[]=[];const h=await productionHarness(t,{kind:"fake",async execute({step,inputValues,stepValues}){calls.push(step.id);return {value:step.id==="script"?"原脚本":step.id==="video"?resolveStepInputs(step,inputValues,stepValues).script as string:"ok"};}});await h.service.start();
  const definition=workflow([{id:"script",name:"剧本",kind:"fake",review:{enabled:true,instruction:"核对白话"},outputs:[{key:"value",type:"text"}]},{id:"video",name:"生成视频",kind:"fake",inputs:[{key:"script",sourceRef:"step.script.outputs.value"}],outputs:[{key:"value",type:"text"}]}]);
  const run=await h.service.submit(submission(id("review-edit"),definition));const waiting=await h.service.wait(h.settings.projectDirectory,run.runId);assert.equal(waiting.status,"waiting");assert.equal(waiting.finishedAt,undefined);assert.deepEqual(calls,["script"]);await until(()=>h.service.metrics().active===0);
  const other=await h.service.submit(submission(id("review-independent")));assert.equal((await h.service.wait(h.settings.projectDirectory,other.runId)).status,"completed");
  await assert.rejects(h.service.submit({...submission(id("review-bypass"),definition),resumeFromRunId:run.runId}),conflict);
  await assert.rejects(h.service.previewRerun(h.settings.projectDirectory,run.runId,{rerunSteps:[{stepId:"script"}]}),conflict);
  await h.service.review(h.settings.projectDirectory,run.runId,{reviewId:waiting.pendingReview!.id,action:"approve",outputs:{value:"确认后的脚本"}});const result=await h.service.wait(h.settings.projectDirectory,run.runId);assert.equal(result.status,"completed");assert.equal(result.outputs[0].value,"确认后的脚本");assert.equal(calls.filter(name=>name==="script").length,1);assert.equal(result.reviewHistory?.[0].originalOutputs?.value,"原脚本");assert.equal(result.reviewHistory?.[0].editedOutputs?.value,"确认后的脚本");assert.ok(h.store.events(h.settings.projectDirectory,run.runId).some(event=>event.type==="review.approve"));
});

test("退回仅重做待确认步骤；提示词修改快照持久化，旧确认令牌失效",async t=>{
  const calls:string[]=[];const h=await productionHarness(t,{kind:"fake",async execute({step}){calls.push(step.id);return {value:step.promptTemplate??step.id};}});await h.service.start();
  const definition=workflow([{id:"prefix",name:"前序",kind:"fake",outputs:[{key:"value",type:"text"}]},{id:"review",name:"待确认",kind:"fake",promptTemplate:"初始",review:{enabled:true},outputs:[{key:"value",type:"text"}]},{id:"tail",name:"下游",kind:"fake",outputs:[{key:"value",type:"text"}]}]);const run=await h.service.submit(submission(id("review-redo"),definition));const first=await h.service.wait(h.settings.projectDirectory,run.runId);
  await h.service.review(h.settings.projectDirectory,run.runId,{reviewId:first.pendingReview!.id,action:"redo",stepChanges:{promptTemplate:"修订"}});const second=await h.service.wait(h.settings.projectDirectory,run.runId);assert.equal(second.status,"waiting");assert.notEqual(second.pendingReview!.id,first.pendingReview!.id);assert.equal(second.steps[1].outputs?.value,"修订");assert.deepEqual(calls,["prefix","review","review"]);assert.equal(second.workflow.steps[1].promptTemplate,"修订");
  await assert.rejects(h.service.review(h.settings.projectDirectory,run.runId,{reviewId:first.pendingReview!.id,action:"approve"}),conflict);
  await h.service.review(h.settings.projectDirectory,run.runId,{reviewId:second.pendingReview!.id,action:"approve"});assert.equal((await h.service.wait(h.settings.projectDirectory,run.runId)).status,"completed");assert.deepEqual(calls,["prefix","review","review","tail"]);
});

test("待确认重启保持原状态；批准后的排队快照也能恢复，双重确认不重复下游",async t=>{
  let calls=0;const h=await productionHarness(t,{kind:"fake",async execute(){calls++;return {value:"ok"};}});await h.service.start();const definition=workflow([{id:"review",name:"确认",kind:"fake",review:{enabled:true},outputs:[{key:"value",type:"text"}]},{id:"tail",name:"后续",kind:"fake",outputs:[{key:"value",type:"text"}]}]);const run=await h.service.submit(submission(id("review-restart"),definition));const waiting=await h.service.wait(h.settings.projectDirectory,run.runId);await h.restart(false);
  assert.equal(h.store.getRun(h.settings.projectDirectory,run.runId)?.status,"waiting");assert.equal(h.store.getRun(h.settings.projectDirectory,run.runId)?.pendingReview?.id,waiting.pendingReview?.id);assert.equal(calls,1);
  const results=await Promise.allSettled([h.service.review(h.settings.projectDirectory,run.runId,{reviewId:waiting.pendingReview!.id,action:"approve"}),h.service.review(h.settings.projectDirectory,run.runId,{reviewId:waiting.pendingReview!.id,action:"approve"})]);assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
  await h.restart();const result=await h.service.wait(h.settings.projectDirectory,run.runId);assert.equal(result.status,"completed");assert.equal(calls,2);assert.equal(result.reviewHistory?.length,1);
});

test("非法编辑不改变等待状态；取消等待不会再执行下游",async t=>{
  let calls=0;const h=await productionHarness(t,{kind:"fake",async execute(){calls++;return {value:"ok"};}});await h.service.start();const definition=workflow([{id:"review",name:"确认",kind:"fake",review:{enabled:true},outputs:[{key:"value",type:"text"}]},{id:"tail",name:"后续",kind:"fake",outputs:[{key:"value",type:"text"}]}]);const run=await h.service.submit(submission(id("review-invalid"),definition));const waiting=await h.service.wait(h.settings.projectDirectory,run.runId);
  await assert.rejects(h.service.review(h.settings.projectDirectory,run.runId,{reviewId:waiting.pendingReview!.id,action:"approve",outputs:{value:{bad:"type"}}}),/类型不匹配/);
  await assert.rejects(h.service.review(h.settings.projectDirectory,run.runId,{reviewId:waiting.pendingReview!.id,action:"redo",stepChanges:{promptTemplate:{bad:"type"}}}),/提示词/);
  assert.equal(h.store.getRun(h.settings.projectDirectory,run.runId)?.status,"waiting");await h.service.cancel(h.settings.projectDirectory,run.runId);assert.equal(h.store.getRun(h.settings.projectDirectory,run.runId)?.pendingReview,undefined);assert.equal(calls,1);await assert.rejects(h.service.review(h.settings.projectDirectory,run.runId,{reviewId:waiting.pendingReview!.id,action:"approve"}),conflict);
});

test("逐项关卡整批完成后等待；批准后继续下一个关卡，批准结果不再次暂停",async t=>{
  const calls:string[]=[];const h=await productionHarness(t,{kind:"fake",async execute({step,inputValues}){calls.push(step.id);return {value:String(externalizeRuntimeValue(inputValues["iteration.item"])??step.id)};}});await h.service.start();const definition=workflow([{id:"batch",name:"整批",kind:"fake",execution:{mode:"for_each",sourceRef:"input.items",maxConcurrency:2},review:{enabled:true},outputs:[{key:"value",type:"text"}]},{id:"tail",name:"尾步",kind:"fake",review:{enabled:true},outputs:[{key:"value",type:"text"}]}]);definition.inputs=[{key:"items",type:"json",required:true}];const run=await h.service.submit(submission(id("review-batch"),definition,{items:["a","b"]}));const first=await h.service.wait(h.settings.projectDirectory,run.runId);assert.equal(first.pendingReview!.stepId,"batch");assert.equal(first.steps[0].items?.length,2);
  await assert.rejects(h.service.review(h.settings.projectDirectory,run.runId,{reviewId:first.pendingReview!.id,action:"approve",outputs:{value:["override"]}}),/逐项步骤/);
  await h.service.review(h.settings.projectDirectory,run.runId,{reviewId:first.pendingReview!.id,action:"approve"});const second=await h.service.wait(h.settings.projectDirectory,run.runId);assert.equal(second.pendingReview!.stepId,"tail");await h.service.review(h.settings.projectDirectory,run.runId,{reviewId:second.pendingReview!.id,action:"approve"});assert.equal((await h.service.wait(h.settings.projectDirectory,run.runId)).status,"completed");assert.deepEqual(calls,["batch","batch","tail"]);
});

test("取消待确认后断点续跑仍需确认，不能借续跑绕过关卡",async t=>{
  const calls:string[]=[];const h=await productionHarness(t,{kind:"fake",async execute({step}){calls.push(step.id);return {value:"ok"};}});await h.service.start();const definition=workflow([{id:"review",name:"确认",kind:"fake",review:{enabled:true},outputs:[{key:"value",type:"text"}]},{id:"tail",name:"后续",kind:"fake",outputs:[{key:"value",type:"text"}]}]);const first=await h.service.submit(submission(id("review-cancel-resume"),definition));await h.service.wait(h.settings.projectDirectory,first.runId);await h.service.cancel(h.settings.projectDirectory,first.runId);
  const resumed=await h.service.submit({...submission(id("review-cancel-resumed"),definition),resumeFromRunId:first.runId});const waiting=await h.service.wait(h.settings.projectDirectory,resumed.runId);assert.equal(waiting.status,"waiting");assert.equal(waiting.pendingReview?.stepId,"review");assert.deepEqual(calls,["review"]);
  await h.service.review(h.settings.projectDirectory,resumed.runId,{reviewId:waiting.pendingReview!.id,action:"approve"});assert.equal((await h.service.wait(h.settings.projectDirectory,resumed.runId)).status,"completed");assert.deepEqual(calls,["review","tail"]);
});
