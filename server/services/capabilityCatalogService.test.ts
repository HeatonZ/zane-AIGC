import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { CapabilityCatalogService } from "./capabilityCatalogService.js";
import { loadCapabilityPackages } from "../capabilities/loadPackages.js";
import { createCapabilityRouter } from "../api/capabilityRoutes.js";
import { HttpError } from "../errors.js";
import type { CapabilityPackage, CapabilityRuntime } from "../capabilities/package.js";
import { capabilityDefinitionSchema } from "../ai/capabilitySchemas.js";
const runtime: CapabilityRuntime = { async hermes() { throw new Error("禁止模型调用"); }, async comfyui() { throw new Error("禁止媒体生成"); }, async condition() { throw new Error("目录只读"); } };
const demo = (id: string): CapabilityPackage => ({ definition: { id, version: "1", label: id, description: "隔离目录", category: "数据", usage: { tier: "basic", whenToUse: "仅测试" }, legacy: { kind: "capability" }, inputs: [], outputs: [], config: [], editor: { inputs: "ports", outputs: "ports" }, result: { renderer: "auto" } }, async execute() { throw new Error("只读"); } });
const failure = (code: string, status = 400) => (error: unknown) => error instanceof HttpError && error.code === code && error.status === status;

test("基础优先目录声明完整值schema，旧版兼容与H3节点适配边界清楚", async () => {
  const registry = await loadCapabilityPackages(runtime); const catalog = new CapabilityCatalogService(registry);
  const before = registry.definitions(); const page = catalog.list();
  assert.equal(page.selectionPolicy.defaultTier, "basic"); assert.equal(page.selectionPolicy.sceneDifferences, "configuration-first");
  assert.match(page.revision, /^[a-f0-9]{64}$/); assert.equal(page.hasMore, false);
  for (const item of page.capabilities) assert.equal(capabilityDefinitionSchema.safeParse(item).success, true, item.id);
  const basic = catalog.list({ tier: "basic" }).capabilities;
  assert.ok(["core.hermes", "core.comfyui", "media.image_layout", "media.select_references", "media.video_concat"].every((id) => basic.some((item) => item.id === id)));
  assert.ok(basic.every((item) => item.usage?.tier === "basic"));
  const specialized = catalog.list({ tier: "specialized" }).capabilities;
  assert.ok(specialized.find((item) => item.id === "comfyui.commerce_pack")?.usage?.compatibilityOnly);
  assert.match(specialized.find((item) => item.id === "comfyui.long_text_video")!.label, /H3/);
  assert.ok(page.capabilities.slice(0, basic.length).every((item) => item.usage?.tier === "basic"));
  assert.deepEqual(registry.definitions(), before);
  const layout = basic.find((item) => item.id === "media.image_layout")!; assert.ok(layout.inputs.find((input) => input.key === "layout")?.valueSchema?.properties);
});

test("目录分页与响应丢失可重读；无丢项重复、跨tier/旧revision游标拒绝", async () => {
  const registry = await loadCapabilityPackages(runtime); const catalog = new CapabilityCatalogService(registry);
  for (let i = 0; i < 103; i++) registry.registerCapability(demo("test.page_" + i));
  const first = catalog.list({ tier: "basic", limit: 1 }); assert.ok(first.hasMore && first.nextCursor);
  const second = catalog.list({ tier: "basic", limit: 2, cursor: first.nextCursor });
  assert.deepEqual(catalog.list({ tier: "basic", limit: 2, cursor: first.nextCursor }), second, "丢失读响应原cursor重读无副作用");
  const ids: string[] = []; let cursor: string | undefined;
  do { const page = catalog.list({ tier: "basic", limit: 17, ...(cursor ? { cursor } : {}) }); assert.equal(page.revision, first.revision); ids.push(...page.capabilities.map((item) => item.id)); cursor = page.nextCursor; assert.equal(Boolean(cursor), page.hasMore); } while (cursor);
  assert.deepEqual(ids, catalog.list({ tier: "basic", limit: 100 }).capabilities.map((item) => item.id).concat(catalog.list({ tier: "basic", limit: 100, cursor: catalog.list({ tier: "basic", limit: 100 }).nextCursor }).capabilities.map((item) => item.id)));
  assert.equal(ids.length, new Set(ids).size);
  assert.throws(() => catalog.list({ tier: "specialized", cursor: first.nextCursor }), failure("INVALID_CAPABILITY_CURSOR"));
  registry.registerCapability(demo("test.changed"));
  assert.throws(() => catalog.list({ tier: "basic", cursor: first.nextCursor }), failure("CAPABILITY_PAGE_CHANGED", 409));
  assert.ok(catalog.list({ tier: "basic" }).revision !== first.revision);
});

test("目录无效参数、未声明旧扩展与无效usage，不执行或默认为基础", async () => {
  const registry = await loadCapabilityPackages(runtime); const catalog = new CapabilityCatalogService(registry);
  for (const input of [{ tier: "unknown" }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "1" }, { arbitrary: true }, { cursor: "" }]) assert.throws(() => catalog.list(input), failure("INVALID_CAPABILITY_QUERY"));
  assert.throws(() => catalog.list({ cursor: "invalid" }), failure("INVALID_CAPABILITY_CURSOR"));
  const old = demo("test.undeclared"); delete old.definition.usage; registry.registerCapability(old);
  assert.equal(old.definition.usage, undefined); assert.ok(catalog.list({ tier: "specialized" }).capabilities.some((item) => item.id === old.definition.id));
  const invalid = demo("test.invalid"); invalid.definition.usage!.whenToUse = " "; assert.throws(() => registry.registerCapability(invalid), /适用范围声明无效/);
});

test("HTTP目录复用权威服务，查询类型/分页错误明确返回而不是完整目录", async t => {
  const registry = await loadCapabilityPackages(runtime); const app = express(); app.use(createCapabilityRouter(registry));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => { const failure = error as HttpError; response.status(failure.status ?? 500).json({ code: failure.code }); });
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve)); t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const response = await fetch(base + "/api/v1/capabilities?tier=basic&limit=1"); assert.equal(response.status, 200); const page = await response.json() as ReturnType<CapabilityCatalogService["list"]>;
  assert.deepEqual(page, new CapabilityCatalogService(registry).list({ tier: "basic", limit: 1 }));
  for (const query of ["tier=bad", "limit=0", "limit=no", "limit=1&limit=2", "tier=all&unknown=1"]) assert.equal((await fetch(base + "/api/v1/capabilities?" + query)).status, 400);
  assert.equal((await fetch(base + "/api/v1/capabilities?tier=specialized&cursor=" + encodeURIComponent(page.nextCursor!))).status, 400);
});


test("基础包预检无效值返回400而非服务500，不执行或生成", async () => {
  const registry = await loadCapabilityPackages(runtime);
  const invalid = { id: "layout", name: "排版", kind: "capability", capabilityId: "media.image_layout", inputs: [{ key: "image", sourceRef: "input.image" }, { key: "layout", valueSource: "literal" as const, literalType: "json", literalValue: JSON.stringify({ width: 1, height: 400 }) }], outputs: [{ key: "images", type: "image_list" }, { key: "layout_manifest", type: "json" }] };
  assert.throws(() => registry.prepareStep(invalid), failure("INVALID_CAPABILITY_CONFIG"));
});
