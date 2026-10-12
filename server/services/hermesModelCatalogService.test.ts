import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { HermesModelCatalogService } from "./hermesModelCatalogService.js";
import { HttpError } from "../errors.js";
import { temporaryDirectory } from "../testing/testSupport.js";

const gatewayPayload = {
  providers: [
    { slug: "my-chat", name: "my-chat", is_current: true, is_user_defined: true, authenticated: true, total_models: 27, api_url: "https://secret.example.com/v1", key_env: "HERMES_CUSTOM_MY_API_KEY", models: ["gpt-6-luna", "workbuddy/deepseek-v4.1-flash-sg"] },
    { slug: "nous", name: "Nous Portal", is_current: false, is_user_defined: false, authenticated: true, total_models: 84, api_url: "https://inference-api.nousresearch.com/v1", models: ["anthropic/claude-opus-5"] },
    { slug: "openrouter", name: "OpenRouter", is_current: false, is_user_defined: false, authenticated: false, total_models: 0, models: [] },
  ],
  model: "my-chat",
  provider: "custom:my-chat",
};

/** Point Hermes discovery at a temporary home with one profile, then stub the gateway fetch.
 *  The home is injected rather than set via environment: config.ts resolves hermesHome at import
 *  time, so an environment-based fixture would silently depend on the developer's real Hermes
 *  install and fail in an isolated check. */
async function harness(t: Parameters<typeof temporaryDirectory>[0], body: unknown = gatewayPayload, status = 200) {
  const root = await temporaryDirectory(t);
  await writeFile(path.join(root, ".env"), "API_SERVER_KEY=test-key\nAPI_SERVER_PORT=8642\n");
  await mkdir(path.join(root, "profiles", "comfyui-dev"), { recursive: true });
  await writeFile(path.join(root, "profiles", "comfyui-dev", "config.yaml"), "model:\n  default: my-chat\n");
  // A named profile resolves credentials from its own .env; the root file is not a fallback.
  await writeFile(path.join(root, "profiles", "comfyui-dev", ".env"), "API_SERVER_KEY=test-key\n");
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  return { root, urls, service: new HermesModelCatalogService(() => Date.now(), root) };
}

test("模型目录按Profile作用域读取，且不泄露凭证、密钥环境变量或上游地址", async (t) => {
  const h = await harness(t);
  const page = await h.service.list({ profile: "comfyui-dev" });
  assert.equal(page.profile, "comfyui-dev");
  assert.equal(page.currentProvider, "custom:my-chat");
  assert.equal(page.currentModel, "my-chat");
  assert.ok(h.urls[0].includes("/p/comfyui-dev/api/model/options"), h.urls[0]);
  const serialized = JSON.stringify(page);
  assert.ok(!serialized.includes("secret.example.com"));
  assert.ok(!serialized.includes("HERMES_CUSTOM_MY_API_KEY"));
  assert.ok(!serialized.includes("key_env"));
  assert.ok(!serialized.includes("api_url"));
  assert.ok(!serialized.includes("test-key"));
  // Uncredentialed providers are hidden unless explicitly requested.
  assert.deepEqual(page.providers.map((provider) => provider.slug), ["my-chat", "nous"]);
  const withUnconfigured = await h.service.list({ profile: "comfyui-dev", includeUnconfigured: true });
  assert.deepEqual(withUnconfigured.providers.map((provider) => provider.slug), ["my-chat", "nous", "openrouter"]);
});

test("目录分页绑定profile与revision，关键词过滤，目录变化返回409", async (t) => {
  const h = await harness(t);
  const first = await h.service.list({ profile: "comfyui-dev", limit: 1 });
  assert.equal(first.providers.length, 1);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = await h.service.list({ profile: "comfyui-dev", limit: 1, cursor: first.nextCursor });
  assert.equal(second.providers[0].slug, "nous");
  assert.equal(second.hasMore, false);
  assert.equal(second.revision, first.revision);
  await assert.rejects(() => h.service.list({ profile: "comfyui-dev", limit: 1, cursor: "not-a-cursor" }), (error) => error instanceof HttpError && error.status === 400);
  // A cursor from another profile must not be replayed against this one.
  await assert.rejects(() => h.service.list({ profile: "default", cursor: first.nextCursor }), (error) => error instanceof HttpError && (error.status === 400 || error.status === 404));
  const filtered = await h.service.list({ profile: "comfyui-dev", q: "claude" });
  assert.deepEqual(filtered.providers.map((provider) => provider.slug), ["nous"]);
  const bySlug = await h.service.list({ profile: "comfyui-dev", q: "opencode" });
  assert.deepEqual(bySlug.providers, []);
});

test("未知Profile返回404，网关不可达返回502且可继续手工填写", async (t) => {
  const h = await harness(t);
  await assert.rejects(() => h.service.list({ profile: "missing-profile" }), (error) => error instanceof HttpError && error.status === 404 && error.code === "HERMES_PROFILE_NOT_FOUND");
  await assert.rejects(() => h.service.list({ profile: "" }), (error) => error instanceof HttpError && error.status === 400);
  await assert.rejects(() => h.service.list({ profile: "comfyui-dev", limit: 1000 }), (error) => error instanceof HttpError && error.status === 400);
  await assert.rejects(() => h.service.list({ profile: "bad profile" }), (error) => error instanceof HttpError && error.status === 400);
  const failing = await harness(t, { error: { message: "gateway down" } }, 500);
  await assert.rejects(() => failing.service.list({ profile: "comfyui-dev" }), (error) => error instanceof HttpError && error.status === 502 && error.code === "HERMES_MODELS_UNAVAILABLE");
});

test("目录按Profile缓存，refresh显式重读", async (t) => {
  const h = await harness(t);
  await h.service.list({ profile: "comfyui-dev" });
  await h.service.list({ profile: "comfyui-dev" });
  assert.equal(h.urls.length, 1);
  await h.service.list({ profile: "comfyui-dev", refresh: true });
  assert.equal(h.urls.length, 2);
});
