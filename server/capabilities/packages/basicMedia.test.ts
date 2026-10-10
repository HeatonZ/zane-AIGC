import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { productionHarness } from "../../testing/productionSupport.js";
import { id } from "../../testing/testSupport.js";
import { parseScenePackage } from "../../../src/lib/sceneTransfer.js";
import { runtimeMediaItems, runtimeMediaItemValue } from "../../runtimeValue.js";
import { composeImageLayout, prepareImageLayout } from "../../services/imageLayoutService.js";
import { validateWorkflowShape } from "../../domain/workflowValidation.js";
import type { RunWorkflowDefinition, JsonValue } from "../../domain/types.js";
import { planRerun } from "../../services/rerunPlanner.js";

test("基础组合隔离执行：素材选择→并发逐项排版→归档，原图/清单不丢且无模型调用", async t => {
  const h = await productionHarness(t); await h.service.start();
  const pkg = parseScenePackage(JSON.parse(await readFile("examples/scenes/basic-image-layout.json", "utf8")));
  validateWorkflowShape(pkg.workflow as unknown as Record<string, unknown>);
  const definitions = h.executors.definitions();
  assert.ok(pkg.workflow.steps.every((step) => definitions.some((item) => item.id === step.capabilityId)));
  // 旧版兼容示例依赖的退役执行方式仍注册、仍可执行，按 compatibilityOnly 只兼容已有发布快照与历史运行。
  for (const id of ["media.select_references", "media.image_layout"]) assert.equal(definitions.find((item) => item.id === id)!.usage?.compatibilityOnly, true, id);
  const source = path.join(h.root, "source.png"); await writeFile(source, await sharp({ create: { width: 100, height: 80, channels: 3, background: "#a5b8cc" } }).png().toBuffer());
  const workflow = pkg.workflow as unknown as RunWorkflowDefinition;
  const inputs = { images: [source], selection: { images: [1] }, layouts: [{ width: 400, height: 500, margin: 20, title: "商品展示" }, { width: 600, height: 400, background: "#ffffff", caption: "封面正文 & <b>原样文字</b>" }] };
  const original = structuredClone(inputs);
  const submitted = await h.service.submit({ runId: id("basic-image-layout"), inputValues: inputs, workflow });
  const run = await h.service.wait(h.settings.projectDirectory, submitted.runId);
  assert.equal(run.status, "completed", run.error); assert.deepEqual(inputs, original);
  const images = runtimeMediaItems(run.steps.find((step) => step.stepId === "layout")!.outputs!.images, "image");
  assert.equal(images.length, 2); assert.notEqual(runtimeMediaItemValue(images[0]), runtimeMediaItemValue(images[1]), "并发逐项不能覆盖同一个归档");
  const manifests = run.steps.find((step) => step.stepId === "layout")!.outputs!.layout_manifest as Array<Record<string, JsonValue>>;
  assert.equal(manifests.length, 2);
  for (let index = 0; index < manifests.length; index++) {
    const row = manifests[index]; assert.equal(row.format, "zane-image-layout/item-v1"); assert.equal(row.sourceRunId, run.runId);
    const bytes = await readFile(path.join(run.artifacts.directory, String(row.outputFile))); const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.width, inputs.layouts[index].width); assert.equal(metadata.height, inputs.layouts[index].height); assert.match(String(row.sha256), /^[a-f0-9]{64}$/);
  }
  const { plan } = planRerun(run, { rerunSteps: [{ stepId: "layout", itemIndexes: [1] }] }, h.executors.definitions());
  assert.equal(plan.steps.find((step) => step.stepId === "references")?.action, "reuse");
  const beforeRun = structuredClone(run);
  const revised = await h.service.submit({ workflow: run.workflow, inputValues: run.inputValues, rerunFromRunId: run.runId, rerunRequest: { rerunSteps: [{ stepId: "layout", itemIndexes: [1] }] } });
  const result = await h.service.wait(h.settings.projectDirectory, revised.runId);
  assert.equal(result.status, "completed", result.error); assert.equal(result.steps.find((step) => step.stepId === "layout")?.items?.[0].reusedFromRunId, run.runId);
  assert.deepEqual(await h.service.getRun(h.settings.projectDirectory, run.runId), beforeRun, "局部重做不覆盖旧运行归档/清单");
});

test("基础排版无效参数/过长文案/取消明确报错，主体不裁切，禁止伪装为平台政策", async () => {
  for (const value of [{ width: 1, height: 100 }, { width: 9000, height: 100 }, { width: 8192, height: 8192 }, { width: 100, height: 100, margin: 26 }, { width: 100, height: 100, title: "标题", titleHeight: 100 }, { width: 100, height: 100, background: "red" }, { width: 100, height: 100, unknown: true }]) assert.throws(() => prepareImageLayout(value));
  const source = await sharp({ create: { width: 100, height: 80, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const result = await composeImageLayout(source, { width: 400, height: 400, title: "标题", caption: "正文" }); assert.equal(result.qa.subjectFit, "contain-no-crop"); assert.equal(result.hasText, true);
  await assert.rejects(composeImageLayout(source, { width: 400, height: 400, title: "超".repeat(3000) }), /文案过长/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(composeImageLayout(source, { width: 400, height: 400 }, controller.signal));
});


test("媒体合并端口显式可选以兼容旧发布快照，但声明时必须匹配物理列表类型",async t=>{
 const h=await productionHarness(t);
 const definition=h.executors.definitions().find(item=>item.id==="media.select_references")!;
 const legacy:RunWorkflowDefinition["steps"][number]={id:"refs",name:"refs",kind:"capability",capabilityId:definition.id,capabilityVersion:definition.version,capabilityConfig:{groups:[{key:"images",kind:"image"}]},inputs:[{key:"selection",valueSource:"literal",literalType:"json",literalValue:'{"images":[]}'},{key:"images",sourceRef:"input.images"}],outputs:definition.outputs.filter(output=>output.required!==false),promptTemplate:""};
 assert.doesNotThrow(()=>h.executors.prepareStep(legacy));
 const declared={...legacy,outputs:definition.outputs};assert.doesNotThrow(()=>h.executors.prepareStep(declared));
 assert.throws(()=>h.executors.prepareStep({...legacy,outputs:[...legacy.outputs!,{key:"audios",type:"image_list"}]}),/输出契约不匹配/);
 assert.throws(()=>h.executors.prepareStep({...legacy,outputs:legacy.outputs!.filter(output=>output.key!=="selected")}),/输出契约不匹配/);
});
