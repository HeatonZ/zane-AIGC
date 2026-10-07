import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { RunRecord } from "../domain/types.js";
import { businessRun, businessRunInputs } from "./runDetailService.js";
import { runInputQuery } from "../ai/accessSchemas.js";
function fixture(): RunRecord {
  return { runId: randomUUID(), sceneId: "business", workflowName: "业务流程", status: "waiting", createdAt: "2026-10-04T01:00:00.000Z", startedAt: "2026-10-04T01:00:00.000Z",
    workflow: { publishedScene: {versionId:"fixed",version:"v1",publishedAt:"2026-10-01T00:00:00Z"}, inputs: [{ key:"text",type:"text",required:true },{key:"list",type:"json"},{key:"object",type:"json"},{key:"missing",type:"text"}],
      steps:[{id:"first",name:"第一步",kind:"fake",promptTemplate:"PRIVATE_PROMPT",outputs:[{key:"result",type:"text"}]},{id:"later",name:"后续步骤",kind:"fake"}],outputs:[{key:"final",type:"text",sourceRef:"step.later.outputs.result"}] },
    inputValues: {text:"😀甲乙丙丁",list:[0,1,2,3],object:{workflow:"业务键",parameters:{setting:1}}},
    steps:[{stepId:"first",name:"第一步",status:"completed",outputs:{result:"middle"},review:{id:"confirm",status:"pending"},items:[{index:0,value:null,status:"completed"},{index:1,value:null,status:"failed",error:"F:/internal/private.txt"}]}],
    pendingReview:{id:"confirm",stepId:"first",name:"确认第一步",createdAt:"2026-10-04T01:00:02Z"},outputs:[],artifacts:{directory:"F:/private",inputs:"",workflow:"",runtime:"",output:""} };
}
test("业务详情包含未来步骤和逐项计数，不把待审核当完成；revision稳定且不夹带输入/提示词/内部错误",()=>{
  const record=fixture();const view=businessRun(record,"2026-10-04T01:00:01.000Z");
  assert.equal(view.steps.length,2);assert.equal(view.steps[1].status,"pending");assert.equal(view.progress.total,2);assert.equal(view.progress.settled,1);
  assert.equal(view.steps[0].reviewStatus,"pending");assert.equal(view.steps[0].itemProgress?.failed,1);assert.equal(view.queueDurationMs,1000);assert.equal(view.outputCount,0);
  assert.equal(view.revision,businessRun(record,"2026-10-04T01:00:01.000Z").revision);assert.doesNotMatch(JSON.stringify(view),/PRIVATE_PROMPT|private.txt|业务键|F:\/|middle/);
  record.steps[0].status="failed";assert.notEqual(view.revision,businessRun(record).revision);
});
test("排队占位startedAt不冒充实际开始；无事件的历史时间明确缺失，总历时含等待",()=>{
  const record=fixture();record.status="queued";let view=businessRun(record);assert.ok(!("startedAt" in view));assert.ok(!("queueDurationMs" in view));
  record.status="cancelled";record.finishedAt="2026-10-04T01:01:05.000Z";view=businessRun(record);assert.ok(!("startedAt" in view));assert.equal(view.totalDurationMs,65000);
});
test("原始输入按Unicode码点/数组项/对象键分段；missing与null不混淆，业务键不被删除",()=>{
  const record=fixture();let page=businessRunInputs(record,runInputQuery.parse({inputKey:"text",valueLimit:2}));assert.equal(page.inputs[0].value,"😀甲");assert.equal(page.inputs[0].valuePage.total,5);assert.equal(page.inputs[0].valuePage.nextValueOffset,2);assert.equal(page.inputs[0].valuePage.complete,false);
  page=businessRunInputs(record,runInputQuery.parse({inputKey:"text",valueOffset:2,valueLimit:3}));assert.equal(page.inputs[0].value,"乙丙丁");assert.equal(page.inputs[0].valuePage.hasMore,false);assert.equal(page.inputs[0].valuePage.pageSize,3);
  page=businessRunInputs(record,runInputQuery.parse({inputKey:"list",valueOffset:1,valueLimit:2}));assert.deepEqual(page.inputs[0].value,[1,2]);
  page=businessRunInputs(record,runInputQuery.parse({inputKey:"object",valueLimit:1}));assert.deepEqual(page.inputs[0].value,{workflow:"业务键"});
  page=businessRunInputs(record,runInputQuery.parse({inputKey:"missing"}));assert.equal(page.inputs[0].present,false);assert.equal(page.inputs[0].valuePage.total,0);assert.ok(!("value" in page.inputs[0]));
  record.inputValues.missing=null;assert.equal(businessRunInputs(record,runInputQuery.parse({inputKey:"missing"})).inputs[0].value,null);
  assert.throws(()=>businessRunInputs(record,runInputQuery.parse({inputKey:"unknown"})),(error:any)=>error.code==="INPUT_NOT_AVAILABLE");
});
test("输入目录游标绑定运行/查询/revision，页面结束和超出值边界明确，旧快照不拼接",()=>{
  const record=fixture();const query=runInputQuery.parse({limit:1});const first=businessRunInputs(record,query);assert.equal(first.hasMore,true);
  const second=businessRunInputs(record,{...query,cursor:first.nextCursor});assert.equal(second.inputs[0].key,"list");
  assert.throws(()=>businessRunInputs({...record,runId:randomUUID()},{...query,cursor:first.nextCursor}),(error:any)=>error.code==="INVALID_CURSOR");
  assert.throws(()=>businessRunInputs(record,{...query,cursor:first.nextCursor,valueLimit:1}),(error:any)=>error.code==="INVALID_CURSOR");
  record.inputValues.text="changed";assert.throws(()=>businessRunInputs(record,{...query,cursor:first.nextCursor}),(error:any)=>error.code==="RESULT_PAGE_CHANGED");
  const past=businessRunInputs(record,runInputQuery.parse({inputKey:"list",valueOffset:100}));assert.deepEqual(past.inputs[0].value,[]);assert.equal(past.inputs[0].valuePage.count,0);assert.equal(past.inputs[0].valuePage.hasMore,false);
});
test("输入单页共享字节预算和metadata_only明确省略；媒体引用不暴露preview/locator/path",()=>{
  const record=fixture();record.workflow.inputs=[{key:"a",type:"text"},{key:"b",type:"text"},{key:"image",type:"image"}];record.inputValues={a:"x".repeat(700),b:"y".repeat(700),image:{assetId:"owned",assetVersion:2,assetName:"参考图",previewUrl:"https://internal/secret",path:"F:/internal/private.png"}};
  const page=businessRunInputs(record,runInputQuery.parse({maxValueBytes:1024}));assert.equal(page.inputs[1].valueOmitted,true);assert.equal(page.inputs[1].omissionReason,"value_byte_limit");assert.doesNotMatch(JSON.stringify(page),/internal|secret|private.png|previewUrl/);
  const meta=businessRunInputs(record,runInputQuery.parse({includeValues:false}));assert.equal(meta.inputs[0].omissionReason,"metadata_only");assert.ok(!("value" in meta.inputs[0]));
  assert.ok(page.inputs.reduce((n,item)=>n+(item.valueOmitted?0:item.valueBytes),0)<=1024);
});

test("业务摘要只暴露警告数量，不将建议当成失败或泄漏警告正文", () => {
  const record = fixture();
  assert.ok(!("warningCount" in businessRun(record).steps[0]));
  record.steps[0].warnings = ["PRIVATE_WARNING_BODY"];
  record.steps[0].items![0].warnings = ["PRIVATE_ITEM_WARNING", "第二条建议"];
  const view = businessRun(record);
  assert.equal(view.steps[0].warningCount, 3);
  assert.equal(view.steps[0].status, "completed");
  assert.equal(view.status, "waiting");
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_WARNING_BODY|PRIVATE_ITEM_WARNING|第二条建议/);
  assert.ok(!("warningCount" in view.steps[1]));
  record.steps[0].items![0].warnings!.push("新的建议");
  assert.notEqual(businessRun(record).revision, view.revision);
});
