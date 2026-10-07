import "./smoke-auth.mjs";
import assert from "node:assert/strict";

// Read real completed runs and the submitted ComfyUI graphs; do not generate another image.
const [imageRunId, textRunId, url = "http://127.0.0.1:8799"] = process.argv.slice(2);
if (![imageRunId, textRunId].every(id => /^[a-f0-9-]{36}$/i.test(id ?? ""))) {
  throw new Error("用法：node scripts/smoke-reference-reconstruction.mjs <有图运行ID> <无图运行ID> [服务URL]");
}
const base = url.replace(/\/+$/, "");
async function json(fullUrl) {
  const response = await fetch(fullUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(fullUrl + ": " + response.status);
  return response.json();
}
const settings = await json(base + "/api/settings");
const history = await json(settings.comfyuiBaseUrl.replace(/\/+$/, "") + "/history?max_items=50");
const evidence = [];
for (const [runId, hasImages] of [[imageRunId, true], [textRunId, false]]) {
  const run = await json(base + "/api/v1/runs/" + runId);
  assert.equal(run.status, "completed", run.error ?? "运行尚未完成：" + runId);
  const condition = run.workflow.steps.find(s => s.kind === "control" && s.control?.rules.some(r => r.leftRef === "input.reference_images"));
  assert.ok(condition, "缺少普通参考图条件步骤");
  assert.equal(run.steps.find(s => s.stepId === condition.id)?.outputs?.result, hasImages);
  const reverse = run.workflow.steps.find(s => s.kind === "hermes" && s.hermesProfile === "aixg" && s.runCondition?.conditionStepId === condition.id && s.runCondition.expectedResult === true);
  assert.ok(reverse, "缺少 Hermes AIXG 条件反推步骤");
  const reversedRecord = run.steps.find(s => s.stepId === reverse.id);
  assert.equal(reversedRecord?.status, hasImages ? "completed" : "skipped");
  if (hasImages) {
    assert.equal(run.inputValues.thought ?? run.inputValues.prompt, "", "有图测试应留空文字描述");
    const text = Object.values(reversedRecord.outputs ?? {}).find(v => typeof v === "string");
    assert.ok(text?.length > 100, "反推必须得到有实际内容的画面描述");
  }
  const generators = run.workflow.steps.filter(s => s.kind === "comfyui");
  assert.equal(generators.length, 1, "只能存在一个纯文生图生成步骤");
  const generator = generators[0];
  assert.equal(generator.runCondition, undefined, "有图和无图必须走同一生成步骤");
  assert.equal(run.steps.find(s => s.stepId === generator.id)?.status, "completed");
  assert.ok((generator.inputs ?? []).every(i => i.sourceRef !== "input.reference_images"), "生成步骤不得绑定参考图");
  const bindings = generator.comfyui.bindings.filter(b => b.direction === "input");
  assert.ok(bindings.every(b => !["image", "image_list"].includes(b.type) && b.sourceRef !== "input.reference_images"), "不得向生成模型传图");
  const promptBinding = bindings.find(b => b.property === "prompt" || b.property === "text");
  assert.ok(promptBinding, "缺少正向文本绑定");
  const promptRef = /^step\.([a-zA-Z0-9_-]+)\.outputs\.([a-zA-Z0-9_]+)$/.exec(promptBinding.sourceRef);
  assert.ok(promptRef, "正向提示词必须来自前序文本步骤");
  const prepare = run.workflow.steps.find(s => s.id === promptRef[1]);
  assert.ok((prepare.inputs ?? []).every(i => i.sourceRef !== "input.reference_images"), "提示词整理只消费文本");
  const finalPrompt = run.steps.find(s => s.stepId === prepare.id)?.outputs?.[promptRef[2]];
  assert.ok(typeof finalPrompt === "string" && finalPrompt.trim(), "正向提示词为空");
  assert.ok(!/(保持原图|第一张参考图|根据图片编辑|图生图)/.test(finalPrompt), "最终提示词仍依赖原图，而非独立文生图描述");
  const output = run.workflow.outputs.find(o => o.type === "image_list" || o.type === "image");
  assert.ok(output?.sourceRef.startsWith("step." + generator.id + ".outputs."), "图片结果必须直接来自 T2I");
  const images = run.outputs.find(o => o.key === output.key)?.value;
  assert.ok(Array.isArray(images) && images.length, "最终图片输出为空");
  const match = Object.entries(history).find(([, h]) => Object.values(h.outputs ?? {}).some(o => o.images?.some(file => images.some(image => image.filename === file.filename && (image.subfolder ?? "") === (file.subfolder ?? "")))));
  assert.ok(match, "近期 ComfyUI 历史中未找到对应生成结果，请保存实际采样历史再验证");
  const [promptId, entry] = match;
  const graph = entry.prompt[2];
  const nodes = Object.values(graph);
  assert.ok(!nodes.some(n => /^(LoadImage|VAEEncode)/.test(n.class_type)), "采样图仍包含原图加载或 VAE 编码");
  for (const node of nodes.filter(n => /TextEncode|CLIPTextEncode/.test(n.class_type))) {
    assert.ok(!Object.entries(node.inputs).some(([key, value]) => /^(images([._]|$)|reference(_images|_latents)?$)/.test(key) && value != null), "文本编码器仍携带图像条件");
  }
  const samplers = nodes.filter(n => n.class_type === "KSampler");
  assert.ok(samplers.length, "没有实际采样节点");
  for (const sampler of samplers) {
    const latent = graph[sampler.inputs.latent_image[0]];
    assert.ok(/^Empty.*Latent/.test(latent?.class_type), "必须从空 latent 纯文生图，而非原图 latent");
    assert.equal(sampler.inputs.denoise, 1, "不应残留低强度重绘参数");
  }
  assert.equal(graph[promptBinding.nodeId]?.inputs?.[promptBinding.property], finalPrompt, "ComfyUI 实际采样图未使用反推整理后的提示词");
  for (const image of images) {
    const response = await fetch(new URL(image.url, base), { method: "HEAD", signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, "归档图片不能在页面打开");
  }
  evidence.push({ runId, hasImages, generatorStepId: generator.id, workflowFile: generator.comfyui.workflowFile, durationMs: run.durationMs, promptId, imageCount: images.length, latentType: graph[samplers[0].inputs.latent_image[0]].class_type, denoise: samplers[0].inputs.denoise, promptCharacters: finalPrompt.length, referencePassedToGenerator: false });
}
assert.equal(evidence[0].generatorStepId, evidence[1].generatorStepId, "两次运行不是同一生成步骤");
assert.equal(evidence[0].workflowFile, evidence[1].workflowFile, "两次运行不是同一纯文生图工作流");
console.log(JSON.stringify({ status: "passed", evidence, note: "反推文本→纯文生图链路及实际采样图验证通过；视觉相似程度须另行看图，不承诺像素级一致。" }, null, 2));
