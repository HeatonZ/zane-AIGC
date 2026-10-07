import { workbenchFetch } from "./workbench-auth.mjs";
/** Read-only live audit. Never submits jobs, changes settings, or restarts a server. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

export function publishedSnapshot(workspace, sceneId) {
  const versions = workspace.sceneVersions?.[sceneId];
  return versions?.versions?.find((item) => item.id === versions.publishedVersionId);
}

/** Metadata includes unconnected/autogrow ports absent from the saved API graph. */
export function bindingAvailability(binding, nodes, schemas = new Map()) {
  const node = nodes.find((item) => String(item.id) === String(binding.nodeId));
  const properties = (item) => new Set([
    ...(binding.direction === "input" ? item.inputProperties ?? [] : item.outputProperties ?? []),
    ...(binding.direction === "input" ? schemas.get(item.type)?.inputs ?? [] : schemas.get(item.type)?.outputs ?? []).map((property) => property.name),
  ]);
  if (node && properties(node).has(binding.property)) return { status: "pass" };
  const candidates = nodes.filter((item) => properties(item).has(binding.property));
  if (candidates.length === 1) return { status: "warn", message: `${binding.nodeId}.${binding.property} 不在原节点上；可能依赖运行时回退到 ${candidates[0].id}，需实跑确认` };
  // Comfy output UI keys are not always identical to OUTPUT_TYPES socket names.
  if (node && binding.direction === "output") return { status: "warn", message: `${binding.nodeId}.${binding.property} 未在输出元数据中声明，需检查运行时 UI 输出` };
  return { status: "fail", message: `${binding.nodeId}.${binding.property} 无有效绑定目标（${candidates.length} 个候选）` };
}

/** Only same-origin API media are probed; no third-party URL is fetched. */
export function mediaReferences(outputs, baseUrl) {
  const found = new Map();
  const visit = (value, type) => {
    if (typeof value === "string") {
      try {
        const url = new URL(value, baseUrl);
        if (url.origin === new URL(baseUrl).origin && /^\/api\/(?:v1\/runs\/[^/]+\/media\/|workflows\/runs\/[^/]+\/media\/|comfyui\/view)/.test(url.pathname)) found.set(url.href, type);
      } catch { /* Plain text is not a URL. */ }
    } else if (Array.isArray(value)) value.forEach((item) => visit(item, type));
    else if (value && typeof value === "object") {
      if (typeof value.url === "string") visit(value.url, type);
      for (const [key, item] of Object.entries(value)) if (key !== "url") visit(item, type);
    }
  };
  for (const output of outputs ?? []) if (/image|video|audio/.test(output.type ?? "")) visit(output.value, output.type);
  return [...found].map(([url, type]) => ({ url, type }));
}

export async function auditProduction({ baseUrl, outputDirectory }) {
  const base = new URL(baseUrl);
  assert.ok(["http:", "https:"].includes(base.protocol), "Only HTTP(S) URLs are supported");
  assert.ok(!base.username && !base.password, "Credentials must not be embedded in the URL");
  baseUrl = base.origin;
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), baseUrl, readOnly: true, checks: [], scenes: [], limitations: ["未新建生成任务；历史产物可访问不等于本次生成成功", "未重启、发布、修改正式工作区或连接配置", "GPU/外部模型生成、内容质量和生成账单需要另行授权与验收"] };
  const record = (name, status, details, sceneId) => report.checks.push({ name, status, ...(sceneId ? { sceneId } : {}), ...(details ? { details } : {}) });
  const check = async (name, action, sceneId) => {
    try { const details = await action(); record(name, "pass", details, sceneId); return details; }
    catch (error) { record(name, "fail", error.message, sceneId); return undefined; }
  };
  const jsonCache = new Map();
  const request = async (route, options = {}) => {
    const url = new URL(route, baseUrl);
    assert.equal(url.origin, baseUrl, "Cross-origin requests are prohibited");
    const method = options.method ?? "GET";
    assert.ok(method === "GET" || method === "HEAD" || (method === "POST" && url.pathname === "/api/integrations/check"), "This audit cannot mutate production");
    return workbenchFetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  };
  const json = async (route) => {
    if (!jsonCache.has(route)) jsonCache.set(route, (async () => {
      const response = await request(route);
      assert.equal(response.status, 200, `${route} HTTP ${response.status}`);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      assert.ok(response.headers.get("x-request-id"), "Missing request correlation ID");
      return response.json();
    })());
    return jsonCache.get(route);
  };
  await check("正式静态前端", async () => { const response = await request("/"); assert.equal(response.status, 200); assert.match(await response.text(), /<div id="root">/); });
  const health = await check("健康检查与 SQLite", async () => { const value = await json("/api/health"); assert.equal(value.status, "ok"); assert.equal(value.storage, "sqlite"); return value; });
  await check("就绪状态", async () => { const value = await json("/api/ready"); assert.equal(value.status, "ready"); assert.equal(value.worker.accepting, true); });
  const settings = await check("正式连接配置", () => json("/api/settings"));
  const catalog = await check("能力目录", () => json("/api/v1/capabilities"));
  await check("Hermes/ComfyUI 可达性（不生成）", async () => { const response = await request("/api/integrations/check", { method: "POST" }); assert.equal(response.status, 200); const result = await response.json(); assert.ok(result.every((item) => item.status === "connected"), JSON.stringify(result)); return result; });
  await check("素材库 API", async () => { const value = await json("/api/v1/assets"); assert.ok(Array.isArray(value.assets)); });
  await check("选片清单 API", async () => { const value = await json("/api/v1/clip-selections"); assert.ok(Array.isArray(value.selections)); });
  const workspace = await check("正式共享工作区", async () => { const value = (await json("/api/workspace")).workspace; assert.ok(value && Array.isArray(value.scenes)); assert.ok(value.workflows); return value; });
  if (!workspace || !settings || !catalog) throw new Error("Critical audit prerequisites are unavailable");
  report.workspaceRevision = workspace.revision;
  report.workerBefore = health?.worker;
  const runs = [];
  const seen = new Set();
  const cursors = new Set();
  await check("运行历史分页（不遗漏、不重复）", async () => {
    let cursor;
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      const page = await json("/api/v1/runs?limit=200" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
      assert.ok(Array.isArray(page.runs));
      for (const run of page.runs) { assert.ok(!seen.has(run.runId), "Duplicate paginated run"); seen.add(run.runId); runs.push(run); }
      if (!page.nextCursor) return { count: runs.length, pages: pageIndex + 1 };
      assert.ok(!cursors.has(page.nextCursor), "Repeated pagination cursor"); cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    throw new Error("History exceeded the explicit 100-page audit bound");
  });
  const graphCache = new Map(), schemas = new Map();
  for (const scene of workspace.scenes) {
    const published = publishedSnapshot(workspace, scene.id);
    const sceneRuns = runs.filter((run) => run.sceneId === scene.id);
    const completed = sceneRuns.find((run) => run.status === "completed");
    const summary = { id: scene.id, title: scene.title, publishedVersionId: published?.id, historicalStatuses: sceneRuns.reduce((counts, run) => { counts[run.status] = (counts[run.status] ?? 0) + 1; return counts; }, {}), latest: sceneRuns[0] ? { runId: sceneRuns[0].runId, status: sceneRuns[0].status, error: sceneRuns[0].error } : null, historicalMediaCount: 0, freshGeneration: "not_run" };
    report.scenes.push(summary);
    if (!published?.workflow) { record("已发布流程快照", "fail", "没有可执行的已发布版本", scene.id); continue; }
    const workflow = published.workflow;
    record("已发布流程快照", "pass", { versionId: published.id, stepCount: workflow.steps.length }, scene.id);
    if (!isDeepStrictEqual(workspace.workflows[scene.id], workflow)) record("工作副本与发布版本", "warn", "存在暂存修改；本次检查的是实际发布版本，不替换正式配置", scene.id);
    await check("步骤 ID 与最终输出来源", async () => {
      const ids = workflow.steps.map((step) => step.id); assert.equal(new Set(ids).size, ids.length); assert.ok(workflow.outputs.length);
      for (const output of workflow.outputs) { const match = /^step\.([^.]+)\.outputs\.([^.\[|]+)/.exec(output.sourceRef); if (match) { const step = workflow.steps.find((item) => item.id === match[1]); assert.ok(step, `Unknown output step ${match[1]}`); assert.ok(step.outputs.some((item) => item.key === match[2]), `Unknown output key ${output.sourceRef}`); } }
    }, scene.id);
    for (const step of workflow.steps) {
      if (step.kind === "hermes") await check(`${step.name}: Hermes Profile`, async () => assert.ok(settings.enabledHermesProfiles.includes(step.hermesProfile ?? "default"), `Profile ${step.hermesProfile} 未启用`), scene.id);
      if (step.capabilityId) await check(`${step.name}: 能力注册`, async () => assert.ok(catalog.capabilities.some((capability) => capability.id === step.capabilityId)), scene.id);
      const comfy = step.comfyui;
      if (step.kind !== "comfyui" || !comfy) continue;
      if (comfy.adapter) await check(`${step.name}: 执行适配器`, async () => assert.ok(health?.adapters.includes(comfy.adapter), `Adapter ${comfy.adapter} unavailable`), scene.id);
      if (comfy.workflowFile === "builtin:video_concat") continue;
      const graph = await check(`${step.name}: ComfyUI 文件读取与转换`, async () => {
        if (!graphCache.has(comfy.workflowFile)) graphCache.set(comfy.workflowFile, json("/api/comfyui/workflow?filename=" + encodeURIComponent(comfy.workflowFile)));
        const result = await graphCache.get(comfy.workflowFile); assert.ok(result.nodes?.length); return result;
      }, scene.id);
      // Keep the report small: graph metadata is cached, but not copied into the result.
      const lastCheck = report.checks.at(-1); if (lastCheck.status === "pass") lastCheck.details = { file: comfy.workflowFile, nodeCount: graph.nodes.length, converted: graph.converted };
      if (!graph) continue;
      for (const binding of comfy.bindings ?? []) {
        const node = graph.nodes.find((item) => String(item.id) === String(binding.nodeId));
        if (node && !schemas.has(node.type)) {
          try { schemas.set(node.type, await json("/api/comfyui/node-info?type=" + encodeURIComponent(node.type))); }
          catch { /* Saved node properties can still prove a valid binding. */ }
        }
        const result = bindingAvailability(binding, graph.nodes, schemas);
        record(`${step.name}: ${binding.direction} ${binding.nodeId}.${binding.property}`, result.status, result.message, scene.id);
      }
      if (scene.title.includes("参考生视频")) {
        const mediaBindings = (comfy.bindings ?? []).filter((binding) => binding.direction === "input" && /image/.test(binding.type));
        if (!mediaBindings.length) record("参考图片接入视频生成节点", "fail", "输入图片仅传入 Hermes；ComfyUI 视频节点没有图片绑定，不能保证参考生视频语义", scene.id);
      }
    }
    if (!completed) { record("历史成功产物", "pending", "没有已完成运行；需新增真实生成测试（不把无历史当成通过）", scene.id); continue; }
    const run = await check("历史成功运行详情", () => json("/api/v1/runs/" + completed.runId), scene.id);
    if (!run) continue;
    const references = mediaReferences(run.outputs, baseUrl).slice(0, 40);
    summary.historicalSuccessRunId = run.runId;
    summary.historicalMediaCount = references.length;
    if (!references.length) record("历史成功产物", "warn", "已完成记录无可访问的同源媒体 URL", scene.id);
    for (const media of references) {
      const label = new URL(media.url).pathname;
      await check("历史媒体 HEAD " + label, async () => {
        const response = await request(media.url, { method: "HEAD" }); assert.equal(response.status, 200); assert.ok(Number(response.headers.get("content-length")) > 0); assert.match(response.headers.get("content-type") ?? "", /^(image|video|audio)\//); return { bytes: Number(response.headers.get("content-length")), contentType: response.headers.get("content-type") };
      }, scene.id);
      await check("历史媒体 Range " + label, async () => {
        const response = await request(media.url, { headers: { Range: "bytes=0-31" } });
        try { assert.equal(response.status, 206); assert.match(response.headers.get("content-range") ?? "", /^bytes 0-\d+\/\d+$/); const bytes = new Uint8Array(await response.arrayBuffer()); assert.ok(bytes.length > 0 && bytes.length <= 32); }
        finally { if (!response.bodyUsed) await response.body?.cancel(); }
      }, scene.id);
    }
    await check("历史事件与 SSE 终态", async () => {
      const history = await json(`/api/v1/runs/${run.runId}/events/history`); assert.ok(Array.isArray(history.events)); if (!history.events.length) record("历史事件完整性", "warn", "旧版迁移记录没有历史事件；仍单独验证 SSE 终态快照", scene.id);
      const response = await request(`/api/v1/runs/${run.runId}/events`); assert.equal(response.status, 200); assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/); assert.match(await response.text(), /"status":"completed"/);
    }, scene.id);
  }
  const afterResponse = await request("/api/health");
  const after = afterResponse.ok ? await afterResponse.json() : undefined;
  report.workerAfter = after?.worker;
  const endWorkspace = await (await request("/api/workspace")).json();
  await check("正式工作区未被测试改写", async () => assert.equal(endWorkspace.workspace?.revision, workspace.revision, "Revision changed during audit (may be concurrent user activity)"));
  report.finishedAt = new Date().toISOString();
  report.summary = report.checks.reduce((counts, item) => { counts[item.status] = (counts[item.status] ?? 0) + 1; return counts; }, {});
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "audit.json"), JSON.stringify(report, null, 2));
  const table = ["| 场景 | 检查 | 历史成功媒体 | 新生成 |", "| --- | --- | ---: | --- |", ...report.scenes.map((scene) => {
    const checks = report.checks.filter((item) => item.sceneId === scene.id), failed = checks.filter((item) => item.status === "fail").length;
    return `| ${scene.title} | ${failed ? `${failed} 项失败` : checks.some((item) => item.status === "pending") ? "待新增生成验收" : "只读检查通过"} | ${scene.historicalMediaCount} | 未执行 |`;
  })];
  const markdown = ["# 正式环境只读 E2E 审计", "", `- 环境：${baseUrl}`, `- 开始：${report.startedAt}`, `- 检查统计：${JSON.stringify(report.summary)}`, `- 工作区 revision：${workspace.revision}`, "", ...table, "", "## 问题与待验收", "", ...report.checks.filter((item) => item.status !== "pass").map((item) => `- **${item.status.toUpperCase()}** ${report.scenes.find((scene) => scene.id === item.sceneId)?.title ?? "全局"} / ${item.name}: ${typeof item.details === "string" ? item.details : JSON.stringify(item.details)}`), "", "## 验收边界", "", ...report.limitations.map((item) => "- " + item), ""].join("\n");
  await writeFile(path.join(outputDirectory, "audit.md"), markdown);
  console.log(JSON.stringify({ baseUrl, scenes: report.scenes.length, summary: report.summary, outputDirectory }, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { "base-url": { type: "string", default: "http://127.0.0.1:8799" }, "output-dir": { type: "string", default: ".local/production-e2e-audit" } } });
  const report = await auditProduction({ baseUrl: values["base-url"], outputDirectory: path.resolve(values["output-dir"]) });
  if (report.summary.fail) process.exitCode = 1;
}
