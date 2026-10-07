import { workbenchFetch } from "./workbench-auth.mjs";
/** Explicitly opted-in live test of the non-generative commerce branch only. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { publishedSnapshot } from "./audit-production.mjs";

const { values } = parseArgs({ options: { "base-url": { type: "string", default: "http://127.0.0.1:8799" }, "output-dir": { type: "string", default: ".local/production-e2e-commerce" }, "allow-local-write": { type: "boolean", default: false } } });
assert.ok(values["allow-local-write"], "This creates one tagged test run in production. Opt in with --allow-local-write; it NEVER calls AI generation.");
const base = new URL(values["base-url"]);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) && !base.username && !base.password, "Only local, credential-free production URLs are supported");
const output = path.resolve(values["output-dir"]);
const runId = randomUUID();
const dateTag = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replaceAll("-", "");
const title = `E2E-${dateTag}-电商套图-原图保真-无AI`;
const request = (route, body) => workbenchFetch(new URL(route, base), { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
const json = async (route, body) => { const response = await request(route, body); assert.ok(response.ok, `${route}: HTTP ${response.status} ${await response.clone().text()}`); return response.json(); };
const workspace = (await json("/api/workspace")).workspace;
const published = publishedSnapshot(workspace, "commerce_pack");
assert.ok(published?.workflow, "No published commerce scene");
const workflow = published.workflow;
// Fail closed before POST if the live workflow has changed in a way that could call a model.
assert.deepEqual(workflow.steps.map((step) => step.id), ["use_ai", "product_brief", "shot_plan", "render_pack"]);
const condition = workflow.steps[0];
assert.ok(!condition.capabilityId || condition.capabilityId === "core.condition");
assert.equal(condition.kind, "control"); assert.equal(condition.control.type, "condition");
assert.equal(condition.control.rules.length, 1);
assert.deepEqual({ leftRef: condition.control.rules[0].leftRef, operator: condition.control.rules[0].operator, valueSource: condition.control.rules[0].valueSource, rightValue: condition.control.rules[0].rightValue }, { leftRef: "input.generation_mode", operator: "equals", valueSource: "literal", rightValue: "AI场景重绘" });
for (const step of workflow.steps.slice(1, 3)) { assert.ok(!step.capabilityId || step.capabilityId === "core.hermes"); assert.equal(step.kind, "hermes"); assert.deepEqual(step.runCondition, { conditionStepId: "use_ai", expectedResult: true }); }
assert.ok(!workflow.steps[3].capabilityId || workflow.steps[3].capabilityId === "comfyui.commerce_pack");
assert.equal(workflow.steps[3].kind, "comfyui"); assert.equal(workflow.steps[3].comfyui.adapter, "commerce_pack");
assert.ok(workflow.steps.every((step) => !step.review?.enabled), "Unexpected approval gate");
await mkdir(output, { recursive: true });
const reference = path.join(output, "synthetic-product.png");
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="700"><rect width="500" height="700" fill="#fff"/><rect x="175" y="70" width="150" height="65" rx="14" fill="#2d4635"/><rect x="150" y="125" width="200" height="500" rx="48" fill="#839680"/><rect x="175" y="260" width="150" height="160" fill="#f1f1e5"/><text x="250" y="335" text-anchor="middle" font-family="Arial" font-size="24" fill="#2d4635">E2E DEMO</text></svg>';
await sharp(Buffer.from(svg)).png().toFile(reference);
const inputValues = { project_name: title, product_name: "E2E 测试杯（合成素材）", reference_images: [reference], selling_points: "测试素材原样排版\n非真实商品，不用于发布", product_specs: "测试图：500 × 700 像素", package_contents: "仅包含合成测试图", audience: "端到端测试", generation_mode: "原图保真排版", platform_preset: "国内三平台（淘宝/京东/抖音）", shot_types: ["hero", "selling_point", "detail", "lifestyle", "specs", "package"], visual_style: "简洁高级", brand_notes: "只使用本地合成测试素材", add_text: true };
for (const field of workflow.inputs.filter((field) => field.required)) assert.ok(inputValues[field.key] !== undefined, `Missing required test fixture ${field.key}`);
const report = { schemaVersion: 1, baseUrl: base.origin, runId, title, sceneId: "commerce_pack", publishedVersionId: published.id, startedAt: new Date().toISOString(), noAi: true, createdProductionRun: true, checks: [], files: [] };
let submitted = false;
try {
  const response = await request("/api/v1/runs", { runId, runTitle: title, workflow, inputValues });
  assert.equal(response.status, 202); assert.equal((await response.json()).runId, runId); submitted = true;
  report.checks.push("202 异步提交实际发布流程");
  let run; const deadline = Date.now() + 40000;
  while (Date.now() < deadline) { run = await json(`/api/v1/runs/${runId}`); if (!["queued", "running", "cancelling"].includes(run.status)) break; await new Promise((resolve) => setTimeout(resolve, 120)); }
  assert.equal(run.status, "completed", run.error ?? "Run did not complete within 40s");
  assert.equal(run.steps[0].outputs.result, false);
  assert.equal(run.steps[1].status, "skipped"); assert.equal(run.steps[2].status, "skipped");
  report.checks.push("本地原图保真分支完成；2 个 Hermes 步骤均 skipped");
  const images = run.outputs.find((item) => item.key === "images").value;
  const rows = run.outputs.find((item) => item.key === "commerce_manifest").value.flat();
  assert.equal(images.length, 18); assert.equal(rows.length, 18);
  assert.deepEqual([...new Set(rows.map((row) => row.platformId))].sort(), ["douyin", "jd", "taobao"]);
  report.checks.push("6 个卡片 × 3 个平台 = 18 张成图");
  for (const row of rows) {
    assert.equal(row.generationMode, "原图保真排版"); assert.equal(row.referenceIndex, 0);
    const response = await request(row.preview); assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()); const info = await sharp(bytes).metadata();
    const size = row.platformId === "douyin" ? 1200 : 1600;
    assert.equal(info.width, size); assert.equal(info.height, size); assert.equal(info.format, "jpeg"); assert.equal(bytes.length, row.bytes);
    report.files.push({ platform: row.platformId, shot: row.shotId, width: info.width, height: info.height, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), preview: row.preview });
    if (row.platformId === "taobao" && row.shotId === "hero") await writeFile(path.join(output, "hero.jpg"), bytes);
  }
  report.checks.push("全部 18 个 HTTP 预览、JPEG 解码、平台尺寸与字节数通过");
  const zipResponse = await request(`/api/v1/runs/${runId}/commerce-pack.zip`); assert.equal(zipResponse.status, 200); assert.match(zipResponse.headers.get("content-type"), /application\/zip/);
  const zip = Buffer.from(await zipResponse.arrayBuffer()); assert.equal(zip.readUInt16LE(zip.length - 12), 20);
  await writeFile(path.join(output, "commerce-pack.zip"), zip);
  report.checks.push("ZIP 下载成功（18 张图 + manifest + README，共 20 个条目）");
  const events = await json(`/api/v1/runs/${runId}/events/history`); assert.ok(events.events.length >= 4);
  const sse = await request(`/api/v1/runs/${runId}/events`); assert.match(sse.headers.get("content-type"), /text\/event-stream/); assert.match(await sse.text(), /"status":"completed"/);
  report.checks.push("历史事件与 SSE 终态一致");
  const after = (await json("/api/workspace")).workspace;
  assert.equal(after.revision, workspace.revision); assert.equal(after.drafts.length, workspace.drafts.length);
  report.checks.push("正式场景、草稿与工作区 revision 未修改");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = error.message;
  if (submitted) { const ownRun = await json(`/api/v1/runs/${runId}`).catch(() => undefined); if (ownRun && ["queued", "running", "cancelling"].includes(ownRun.status)) await json(`/api/v1/runs/${runId}/cancel`, {}).catch(() => {}); }
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "live-commerce.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, runId, noAi: true, checks: report.checks, error: report.error, outputDirectory: output }, null, 2));
}
