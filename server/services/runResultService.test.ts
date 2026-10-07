import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { runOutputs, stepResult } from "./runResultService.js";
import { outputQuery, stepResultQuery } from "../ai/sceneSchemas.js";
import type { RunRecord } from "../domain/types.js";
import { aiHarness } from "../testing/aiSupport.js";
function run(): RunRecord {
  return { runId: randomUUID(), sceneId: "demo", status: "completed", workflowName: "large workflow", createdAt: "2026-10-02T00:00:00.000Z", startedAt: "2026-10-02T00:00:00.000Z", artifacts: { directory: "", inputs: "", workflow: "", runtime: "", output: "" }, inputValues: { prompt: "不应夹带的输入" }, workflow: { inputs: [], steps: [{ id: "render", name: "生成步骤", kind: "fake", promptTemplate: "不应夹带的提示词", outputs: [{ key: "image", type: "image_list" }] }], outputs: [] }, outputs: [{ key: "video", label: "视频", type: "video_list", value: ["/tmp/one.mp4", "/tmp/two.mp4", "/tmp/three.mp4"] }, { key: "text", label: "文本", type: "text", value: "成稿" }], steps: [{ stepId: "render", name: "生成步骤", status: "completed", inputs: { prompt: "不应夹带的步骤输入" }, outputs: { image: ["/tmp/one.png", "/tmp/two.png"] }, items: [{ index: 0, value: { text: "不应夹带的迭代输入" }, status: "completed", outputs: { image: ["/tmp/a.png"] } }, { index: 1, value: "镜头二", status: "failed", error: "错误信息" }, { index: 2, value: "镜头三", status: "completed", outputs: { image: ["/tmp/c.png"] } }] }] };
}

test("轻量最终输出：目录分页、数组分段、精确媒体source/HTTP地址", () => {
  const record = run(); const query = outputQuery.parse({ limit: 1, valueLimit: 1 });
  const first = runOutputs(record, query); assert.equal(first.outputs.length, 1); assert.equal(first.hasMore, true); assert.deepEqual(first.outputs[0].value, ["/tmp/one.mp4"]); assert.equal(first.outputs[0].valuePage.nextValueOffset, 1); assert.equal(first.outputs[0].valuePage.complete, false);
  assert.equal(first.outputs[0].mediaReferences?.[0].source.mediaIndex, 0); assert.match(first.outputs[0].mediaReferences![0].url, /output-media\?outputKey=video&mediaIndex=0$/);
  const second = runOutputs(record, { ...query, cursor: first.nextCursor }); assert.equal(second.outputs[0].key, "text"); assert.equal(second.hasMore, false);
  const segment = runOutputs(record, outputQuery.parse({ outputKey: "video", valueOffset: 2, valueLimit: 1 })); assert.deepEqual(segment.outputs[0].value, ["/tmp/three.mp4"]); assert.equal(segment.outputs[0].mediaReferences?.[0].source.mediaIndex, 2);
});

test("轻量单步：foreach分页/按itemIndex定位，不夹带输入/提示词/全流程", () => {
  const record = run(); const query = stepResultQuery.parse({ limit: 1 });
  const first = stepResult(record, "render", query); assert.equal(first.items[0].index, 0); assert.equal(first.itemCount, 3); assert.equal(first.hasMore, true);
  assert.ok(!JSON.stringify(first).includes("不应夹带")); assert.ok(!("workflow" in first)); assert.ok(!("inputValues" in first));
  const next = stepResult(record, "render", { ...query, cursor: first.nextCursor }); assert.equal(next.items[0].index, 1); assert.equal(next.items[0].status, "failed"); assert.equal(next.items[0].error, "错误信息");
  const selected = stepResult(record, "render", stepResultQuery.parse({ itemIndex: 2, outputKey: "image" })); assert.equal(selected.items[0].index, 2); assert.equal(selected.items[0].outputs[0].mediaReferences?.[0].source.itemIndex, 2); assert.ok(!("outputs" in selected));
});

test("结果分页：跨运行/选择器cursor拒绝，更新中的结果返回可恢复冲突", () => {
  const record = run(); const query = outputQuery.parse({ limit: 1 }); const first = runOutputs(record, query);
  assert.throws(() => runOutputs({ ...record, runId: randomUUID() }, { ...query, cursor: first.nextCursor }), /游标无效/);
  assert.throws(() => runOutputs(record, { ...query, cursor: first.nextCursor, outputKey: "text" }), /游标无效/);
  record.outputs[0].value = ["new"];
  assert.throws(() => runOutputs(record, { ...query, cursor: first.nextCursor }), (error: any) => error.code === "RESULT_PAGE_CHANGED" && error.details.nextAction === "read_first_page");
});

test("大输出明确省略/可只读元数据，不静默截断或嵌入大媒体", () => {
  const record = run(); record.outputs.push({ key: "large", label: "大文本", type: "text", value: "x".repeat(5000) });
  const result = runOutputs(record, outputQuery.parse({ outputKey: "large", maxValueBytes: 1024 })); assert.equal(result.outputs[0].valueOmitted, true); assert.ok(!("value" in result.outputs[0])); assert.equal(result.outputs[0].omissionReason, "value_byte_limit"); assert.equal(result.outputs[0].valuePage.complete, false);
  const metadata = runOutputs(record, outputQuery.parse({ includeValues: false })); assert.equal(metadata.outputs[0].omissionReason, "metadata_only"); assert.ok(!metadata.outputs[0].mediaReferences);
  const full = runOutputs(record, outputQuery.parse({ outputKey: "large", maxValueBytes: 8192 })); assert.equal(String(full.outputs[0].value).length, 5000); assert.equal(full.outputs[0].valuePage.complete, true);
});

test("只读结果HTTP：有效参数选择、非法布尔值/重复查询拒绝，不创建额外运行", async t => {
  const h = await aiHarness(t); const prepared = await h.scenes.prepare("demo", "version-a", {});
  const record = await h.service.submit({ runId: randomUUID(), workflow: prepared.workflow, inputValues: prepared.inputValues }); const done = await h.service.wait(h.settings.projectDirectory, record.runId);
  let response = await fetch(h.base + "/api/v1/runs/" + record.runId + "/outputs?includeValues=false"); assert.equal(response.status, 200); const metadata = await response.json() as Record<string, any>; assert.equal(metadata.outputs[0].valueOmitted, true);
  response = await fetch(h.base + "/api/v1/runs/" + record.runId + "/outputs?outputKey=" + done.outputs[0].key); assert.equal(response.status, 200);
  response = await fetch(h.base + "/api/v1/runs/" + record.runId + "/steps/first/result?outputKey=value"); assert.equal(response.status, 200); assert.equal((await response.json() as Record<string, any>).outputs[0].value, "ok");
  assert.equal((await fetch(h.base + "/api/v1/runs/" + record.runId + "/outputs?includeValues=bad")).status, 400);
  assert.equal((await fetch(h.base + "/api/v1/runs/" + record.runId + "/outputs?limit=1&limit=2")).status, 400);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 1);
});


test("响应值预算在多输出间共享，不是每个输出单独扩张", () => {
  const record = run(); record.outputs = ["a", "b", "c"].map(key => ({ key, label: key, type: "text", value: "x".repeat(600) }));
  const result = runOutputs(record, outputQuery.parse({ maxValueBytes: 1024 }));
  const includedBytes = result.outputs.reduce((total, item) => total + (item.valueOmitted ? 0 : Buffer.byteLength(JSON.stringify(item.value))), 0);
  assert.ok(includedBytes <= 1024); assert.ok(!result.outputs[0].valueOmitted); assert.equal(result.outputs[1].valueOmitted, true); assert.equal(result.outputs[2].valueOmitted, true);
});

test("显式长文本分段兼容旧scalar行为；Unicode不切碎，最终/逐项共享同一服务与预算",()=>{
  const record=run();record.outputs=[{key:"text",label:"成稿",type:"text",value:"😀甲乙丙丁"}];
  const full=runOutputs(record,outputQuery.parse({}));assert.equal(full.outputs[0].value,"😀甲乙丙丁");assert.equal(full.outputs[0].valuePage.kind,"scalar");
  const first=runOutputs(record,outputQuery.parse({textLimit:2}));assert.equal(first.outputs[0].value,"😀甲");assert.equal(first.outputs[0].valuePage.kind,"string");assert.equal(first.outputs[0].valuePage.nextValueOffset,2);assert.equal(first.outputs[0].valuePage.total,5);
  const last=runOutputs(record,outputQuery.parse({textLimit:2,textOffset:4}));assert.equal(last.outputs[0].value,"丁");assert.equal(last.outputs[0].valuePage.hasMore,false);assert.equal(last.outputs[0].valuePage.count,1);assert.equal(last.outputs[0].valuePage.pageSize,2);
  const past=runOutputs(record,outputQuery.parse({textLimit:2,textOffset:99}));assert.equal(past.outputs[0].value,"");assert.equal(past.outputs[0].valuePage.count,0);
  record.steps[0].items![0].outputs={text:"😀甲乙丙丁"};const item=stepResult(record,"render",stepResultQuery.parse({itemIndex:0,outputKey:"text",textLimit:2,textOffset:2}));assert.equal(item.items[0].outputs[0].value,"乙丙");
  assert.equal(outputQuery.safeParse({textLimit:0}).success,false);assert.equal(outputQuery.safeParse({textLimit:32769}).success,false);assert.equal(outputQuery.safeParse({textOffset:-1}).success,false);
});

test("非阻断警告在元数据读取与逐项分页中保留；变化后的旧游标拒绝拼接", () => {
  const record = run();
  record.steps[0].warnings = ["步骤级建议，不影响执行"];
  record.steps[0].items![0].warnings = ["镜头一缺少段落标题"];
  record.steps[0].items![2].warnings = ["镜头三标题顺序建议"];
  const query = stepResultQuery.parse({ limit: 1, includeValues: false });
  const first = stepResult(record, "render", query);
  assert.deepEqual(first.warnings, record.steps[0].warnings);
  assert.deepEqual(first.items[0].warnings, record.steps[0].items![0].warnings);
  assert.equal(first.items[0].status, "completed");
  assert.ok(first.items[0].outputs.every(output => output.valueOmitted && !("value" in output)));
  const second = stepResult(record, "render", { ...query, cursor: first.nextCursor });
  const third = stepResult(record, "render", { ...query, cursor: second.nextCursor });
  assert.equal(third.items[0].index, 2);
  assert.deepEqual(third.items[0].warnings, record.steps[0].items![2].warnings);
  assert.equal(third.hasMore, false);
  const selected = stepResult(record, "render", stepResultQuery.parse({ itemIndex: 2, includeValues: false }));
  assert.deepEqual(selected.items[0].warnings, third.items[0].warnings);
  record.steps[0].items![2].warnings!.push("更新后的建议");
  assert.notEqual(stepResult(record, "render", query).revision, first.revision);
  assert.throws(() => stepResult(record, "render", { ...query, cursor: first.nextCursor }),
    (error: any) => error.code === "RESULT_PAGE_CHANGED" && error.details.nextAction === "read_first_page");
  const before = stepResult(record, "render", query).revision;
  record.steps[0].warnings!.push("新的步骤级建议");
  assert.notEqual(stepResult(record, "render", query).revision, before);
});
