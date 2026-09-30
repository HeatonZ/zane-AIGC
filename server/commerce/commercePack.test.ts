import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import path from "node:path";
import { commerceProfiles, selectCommerceProfiles, validateCommerceShots } from "./profiles.js";
import { composeCommerceImage, escapeMarkup } from "./compose.js";
import { runCommercePackStep } from "./adapter.js";
import { commerceZip, crc32 } from "./zip.js";
import { temporaryDirectory, harness, id, submission } from "../testing/testSupport.js";
import { createRuntimeMediaValue } from "../runtimeValue.js";
import { resolveWorkflowReference, asRecord } from "../domain/workflowValues.js";
import type { JsonValue, RunWorkflowDefinition } from "../domain/types.js";
import { commerceRunRows } from "../api/commercePackRoutes.js";

const pkg = JSON.parse(await readFile(new URL("../../examples/scenes/commerce-pack.json", import.meta.url), "utf8"));
async function sourceImage() { return sharp({ create: { width: 400, height: 700, channels: 3, background: "#dd9966" } }).png().toBuffer(); }
async function inputs(shots = ["hero", "selling_point", "detail"], preset = "自定义平台") {
  return { project_name: "测试套图", product_name: "通勤保温杯 & 茶杯", selling_points: "便携设计\n防滑底部", reference_images: ["data:image/png;base64," + (await sourceImage()).toString("base64")], product_specs: "容量500mL", package_contents: "杯体 × 1", audience: "通勤", generation_mode: "原图保真排版", platform_preset: preset, platform_profiles: [{ id: "taobao", width: 600, height: 600 }, { id: "xiaohongshu", width: 600, height: 800 }], shot_types: shots, visual_style: "简洁高级", brand_notes: "不要改商品结构", add_text: true };
}

test("平台选择/尺寸覆盖有限且Amazon主图保护不能取消", () => {
  assert.equal(selectCommerceProfiles("国内三平台（淘宝/京东/抖音）", null).length, 3);
  const profiles = selectCommerceProfiles("Amazon", [{ id: "amazon", width: 1600, height: 2000, whiteHero: false }]);
  assert.equal(profiles[0].whiteHero, true); assert.equal(profiles[0].width, 1600);
  for (const custom of [[{ id: "../escape", width: 800, height: 800 }], [{ id: "taobao", width: 1 }], [{ id: "taobao", safeMargin: 800 }], [{ id: "taobao", showText: "yes" }], [{ id: "taobao" }, { id: "taobao" }]]) assert.throws(() => selectCommerceProfiles("淘宝 / 天猫", custom));
  assert.throws(() => selectCommerceProfiles("自定义平台", []));
  assert.throws(() => validateCommerceShots(["hero", "hero"]));
  assert.throws(() => validateCommerceShots(["unknown"]));
});

test("后置文字转义、完整排版、尺寸校验；Amazon hero永不叠字", async () => {
  assert.equal(escapeMarkup('<b>茶&杯</b>'), "&lt;b&gt;茶&amp;杯&lt;/b&gt;");
  const copy = { productName: "真实商品 & <b>并非标签</b>", sellingPoints: "准确文案", productSpecs: "500mL", packageContents: "杯体", visualStyle: "暖调家居", addText: true };
  const profile = { ...commerceProfiles[0], width: 600, height: 600, safeMargin: 30 };
  const rendered = await composeCommerceImage(await sourceImage(), profile, "hero", copy);
  assert.equal(rendered.hasText, true); assert.equal((await sharp(rendered.bytes).metadata()).width, 600);
  const amazon = await composeCommerceImage(await sourceImage(), { ...profile, id: "amazon", whiteHero: true }, "hero", copy);
  assert.equal(amazon.hasText, false); assert.equal(amazon.qa.textSource, "none");
  const pixel = await sharp(amazon.bytes).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  assert.ok([...pixel].every((value) => value >= 252));
  await assert.rejects(composeCommerceImage(await sourceImage(), profile, "selling_point", { ...copy, sellingPoints: "太长".repeat(1000) }), /文案过长/);
});

test("原图保真场景走现有引擎：跳过Hermes/Comfy，输出六张多比例成图", async (t) => {
  const h = await harness(t, { executor: { kind: "control", async execute() { return { result: false }; } } });
  h.executors.register({ kind: "hermes", async execute() { throw new Error("Strict mode must not call Hermes"); } });
  h.executors.register({ kind: "comfyui", execute: (context) => runCommercePackStep(context, async () => { throw new Error("Strict mode must not generate"); }) });
  await h.service.start();
  const runId = id("commerce-strict");
  await h.service.submit(submission(runId, pkg.workflow as RunWorkflowDefinition, await inputs()));
  const run = await h.service.wait(h.settings.projectDirectory, runId);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.steps[1].status, "skipped"); assert.equal(run.steps[2].status, "skipped");
  const rows = commerceRunRows(run); assert.equal(rows.length, 6);
  const images = run.outputs.find((output) => output.key === "images")!.value as string[];
  assert.equal(images.length, 6); assert.match(images[0], /^\/api\/workflows\/runs\//);
  for (const row of rows) {
    const file = path.join(run.artifacts.directory, String(row.outputFile));
    const meta = await sharp(await readFile(file)).metadata();
    assert.equal(meta.width, 600); assert.equal(meta.height, row.platformId === "xiaohongshu" ? 800 : 600);
    assert.equal(row.generationMode, "原图保真排版");
  }
  assert.equal(run.archiveWarnings, undefined);
});

test("AI重绘复用底图；白底hero独立生成，缺失脚本/输出不伪装成功", async (t) => {
  const h = await harness(t, { executor: { kind: "control", async execute() { return { result: true }; } } });
  h.executors.register({ kind: "hermes", async execute({ step }): Promise<Record<string, JsonValue>> { return step.id === "product_brief" ? { product_brief: { facts: "仅用户事实" } } : { shot_plan: [{ id: "hero", prompt: "准确商品摄影" }] }; } });
  const prompts: string[] = [];
  h.executors.register({ kind: "comfyui", execute: (context) => runCommercePackStep(context, async (patched) => {
    assert.equal(patched.step.comfyui!.adapter, undefined);
    prompts.push(String(resolveWorkflowReference("iteration.item.prompt", patched.inputValues, patched.stepValues)));
    return { images: createRuntimeMediaValue("image", "data:image/png;base64," + (await sourceImage()).toString("base64")) };
  }) });
  await h.service.start();
  const runId = id("commerce-ai"); const values = await inputs(["hero"], "全部六平台（含Amazon）"); values.generation_mode = "AI场景重绘";
  await h.service.submit(submission(runId, pkg.workflow, values));
  const run = await h.service.wait(h.settings.projectDirectory, runId);
  assert.equal(run.status, "completed", run.error); assert.equal(prompts.length, 2);
  assert.ok(prompts.some((prompt) => prompt.includes("纯白背景")));
  assert.equal(commerceRunRows(run).length, 6);
  assert.equal(commerceRunRows(run).find((row) => row.platformId === "amazon")!.hasText, false);
});

test("逐项失败与续跑只重做失败卡片，并保留前次成图来源", async (t) => {
  const h = await harness(t, { executor: { kind: "control", async execute() { return { result: true }; } } });
  h.executors.register({ kind: "hermes", async execute({ step }): Promise<Record<string, JsonValue>> { return step.id === "product_brief" ? { product_brief: {} } : { shot_plan: [{ id: "hero", prompt: "主图" }, { id: "detail", prompt: "细节" }] }; } });
  const calls = new Map<string, number>();
  h.executors.register({ kind: "comfyui", execute: (context) => runCommercePackStep(context, async (patched) => {
    const shot = String(asRecord(patched.inputValues["iteration.item"])?.id); const count = (calls.get(shot) ?? 0) + 1; calls.set(shot, count);
    if (shot === "detail" && count === 1) throw new Error("模拟细节卡片失败");
    return { images: createRuntimeMediaValue("image", "data:image/png;base64," + (await sourceImage()).toString("base64")) };
  }) });
  const values = await inputs(["hero", "detail"], "淘宝 / 天猫"); values.generation_mode = "AI场景重绘";
  await h.service.start();
  const firstId = id("commerce-failed"); await h.service.submit(submission(firstId, pkg.workflow, values));
  const first = await h.service.wait(h.settings.projectDirectory, firstId); assert.equal(first.status, "failed"); assert.equal(commerceRunRows(first).length, 1);
  const secondId = id("commerce-resumed"); await h.service.submit({ ...submission(secondId, pkg.workflow, values), resumeFromRunId: firstId });
  const second = await h.service.wait(h.settings.projectDirectory, secondId); assert.equal(second.status, "completed", second.error);
  assert.equal(calls.get("hero"), 1); assert.equal(calls.get("detail"), 2);
  const rows = commerceRunRows(second); assert.equal(rows.length, 2); assert.ok(rows.some((row) => row.sourceRunId === firstId)); assert.ok(rows.some((row) => row.sourceRunId === secondId));
});

test("非法脚本不能静默漏图，取消不会再写成图", async (t) => {
  const root = await temporaryDirectory(t);
  const values = { ...await inputs(["hero"], "淘宝 / 天猫"), generation_mode: "AI场景重绘", "iteration.item": "hero" };
  const controller = new AbortController();
  const context = { runId: id("commerce-invalid"), artifacts: { directory: root, inputs: "", workflow: "", runtime: "", output: "" }, step: pkg.workflow.steps.at(-1), runInputValues: values, inputValues: values, stepValues: new Map([["shot_plan", { shot_plan: [] }]]), types: new Map<string, string>(), inputFields: pkg.workflow.inputs, settings: { projectDirectory: root, comfyuiBaseUrl: "", workflowTimeoutMinutes: 1, enabledHermesProfiles: [] }, signal: controller.signal };
  await assert.rejects(runCommercePackStep(context, async () => { throw new Error("Must not run"); }), /脚本/);
  context.stepValues.set("shot_plan", { shot_plan: [{ id: "hero", prompt: "照片" }] } as never);
  await assert.rejects(runCommercePackStep(context, async () => {
    controller.abort("测试取消");
    return { images: createRuntimeMediaValue("image", "data:image/png;base64," + (await sourceImage()).toString("base64")) };
  }));
});

test("ZIP STORE头、UTF8文件名、CRC和中央目录正确，拒绝路径穿越", async () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const chunks = []; for await (const chunk of commerceZip([{ name: "taobao/01-hero.jpg", data: Buffer.from("jpeg") }, { name: "manifest.json", data: Buffer.from("中文说明") }])) chunks.push(chunk);
  const zip = Buffer.concat(chunks); assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const nameLength = zip.readUInt16LE(26); assert.equal(zip.subarray(30, 30 + nameLength).toString(), "taobao/01-hero.jpg");
  assert.equal(zip.readUInt32LE(14), crc32(Buffer.from("jpeg")));
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50); assert.equal(zip.readUInt16LE(zip.length - 12), 2);
  const centralOffset = zip.readUInt32LE(zip.length - 6); assert.equal(zip.readUInt32LE(centralOffset), 0x02014b50);
  await assert.rejects(async () => { for await (const _ of commerceZip([{ name: "../escape", data: Buffer.from("bad") }])) void _; }, /文件名/);
});

