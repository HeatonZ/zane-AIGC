import assert from "node:assert/strict";
import test from "node:test";
import { elapsedRun, mergeResultSlice, progressPercent, runDuration, previousValueOffset, runHistorySummary } from "./runDetails";
import { resultPath, type ResultPage } from "./userPortal";
test("真实历时和计数：未知/排队/历史缺失不伪造执行时间，进度只取已结束步骤",()=>{
  assert.equal(runDuration(undefined),"未记录");assert.equal(runDuration(65000),"1 分 5 秒");assert.equal(runDuration(0),"不足 1 秒");
  const createdAt="2026-10-04T00:00:00Z";const now=Date.parse(createdAt)+5000;
  assert.equal(elapsedRun({createdAt,status:"queued"},now),5000);assert.equal(elapsedRun({createdAt,status:"completed"},now),undefined);
  assert.equal(progressPercent({total:4,completed:1,skipped:1,failed:0,cancelled:0,running:1,pending:1,settled:2}),50);
});
test("输出分段只更新指定字段/第0项，保留其他产物和目录游标；revision冲突不拼接",()=>{
  const out=(key:string,value:string)=>({key,label:key,type:"text",value,valuePage:{hasMore:false}});
  const previous:ResultPage={revision:"rev",outputs:[out("a","first"),out("b","unchanged")],items:[{index:0,status:"completed",outputs:[out("a","item-first")]},{index:1,status:"completed",outputs:[out("a","other-item")]}],hasMore:true,nextCursor:"cursor"};
  let next=mergeResultSlice(previous,{revision:"rev",outputs:[out("a","next")],hasMore:false},{outputKey:"a"});assert.equal(next.outputs?.[0].value,"next");assert.equal(next.outputs?.[1].value,"unchanged");assert.equal(next.nextCursor,"cursor");
  next=mergeResultSlice(previous,{revision:"rev",items:[{index:0,status:"completed",outputs:[out("a","item-next")]}],hasMore:false},{stepId:"foreach",itemIndex:0,outputKey:"a"});assert.equal(next.items?.[0].outputs[0].value,"item-next");assert.equal(next.items?.[1].outputs[0].value,"other-item");assert.equal(next.outputs?.[0].value,"first");
  assert.throws(()=>mergeResultSlice(previous,{revision:"new",outputs:[],hasMore:false},{outputKey:"a"}),/结果已变化/);
  const query=new URL(resultPath("run",{stepId:"foreach",itemIndex:0,outputKey:"a",textOffset:8000}),"http://localhost").searchParams;
  assert.equal(query.get("textOffset"),"8000");assert.equal(query.get("textLimit"),"8000");assert.equal(query.get("itemIndex"),"0");
});

test("最后一个不足整页的片段返回上一页仍按请求pageSize，不能用count造成重叠偏移",()=>{
  assert.equal(previousValueOffset({offset:2000,pageSize:2000},2000),0);
  assert.equal(previousValueOffset({offset:8000,pageSize:8000},8000),0);
  assert.equal(previousValueOffset({offset:16000,pageSize:8000},8000),8000);
  assert.equal(previousValueOffset({offset:100,pageSize:1},2000),99);
});

test("管理员详情更新保留服务端归属和创建时间，历史未归属不伪造用户", () => {
  const run = {
    runId: "run-owned", sceneId: "scene", workflowName: "流程", runTitle: "业务任务",
    ownerUserId: "verified-user", createdAt: "2026-10-04T00:00:00Z", status: "completed" as const,
    startedAt: "2026-10-04T00:00:05Z", finishedAt: "2026-10-04T00:00:10Z",
    steps: [], outputs: [], inputValues: {},
  };
  const summary = runHistorySummary(run);
  assert.equal(summary.ownerUserId, "verified-user");
  assert.equal(summary.createdAt, run.createdAt);
  assert.equal(summary.startedAt, run.startedAt);
  assert.equal(summary.runTitle, run.runTitle);
  assert.equal(runHistorySummary({...run, ownerUserId: undefined}).ownerUserId, undefined);
});
