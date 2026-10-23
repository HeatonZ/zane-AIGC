import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { harness } from "./testSupport.js";
import { WorkspaceService } from "../services/workspaceService.js";
import { AccessService } from "../services/accessService.js";
import { DirectLlmService } from "../services/directLlmService.js";
import { createDirectLlmRouter } from "../api/directLlmRoutes.js";
import { HttpError } from "../errors.js";

/** 直连模型提供商注册表的隔离闭环：真实 HTTP 路由 + 真实身份中间件 + 临时 SQLite，
 *  并把外部 HTTP 换成假 fetch（调用方通过 installFetch 安装）。不调用模型。 */
export async function directLlmHarness(t: TestContext, environment: { baseUrl?: string; apiKeyEnv?: string; model?: string } = {}) {
  let executions = 0;
  const h = await harness(t, { executor: { kind: "fake", async execute() { executions++; return { value: "test" }; } } });
  const config = new DirectLlmService(h.store, environment);
  await h.service.start();
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  t.after(() => workspace.shutdown());
  const access = new AccessService(h.store, workspace, "");
  async function createUser(username: string, role: "admin" | "user") {
    const user = (await access.create({ userId: randomUUID(), username, displayName: username, password: "isolated-direct-llm-password", role })).user;
    const session = await access.login(username, "isolated-direct-llm-password");
    return { ...session, user };
  }
  const admin = await createUser("admin", "admin");
  const user = await createUser("user", "user");
  const app = express();
  app.use(express.json());
  app.use(access.middleware(async () => h.settings.projectDirectory));
  app.use(createDirectLlmRouter(config));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const providers = "/api/v1/settings/direct-llm/providers";
  async function request(token = admin.token, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", suffix = "", body?: unknown) {
    return fetch(base + providers + suffix, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function createProvider(providerId: string, overrides: Record<string, unknown> = {}) {
    const response = await request(admin.token, "POST", "", {
      providerId, name: "测试提供商", protocol: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1",
      apiKeyEnv: "ZANE_TEST_DIRECT_LLM_KEY", enabled: true, ...overrides,
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  return { ...h, base, config, access, admin, user, request, createProvider, get executions() { return executions; } };
}

/** 每个测试只记录**一次**真实 fetch：同一测试里重复安装时必须回到最初那一个。
 *  否则 after 钩子按注册顺序恢复，会把「上一个桩」留在全局，污染后续用例。 */
const trueFetch = new WeakMap<TestContext, typeof globalThis.fetch>();

/** 记录所有请求的假 fetch；测试结束后自动恢复全局 fetch，绝不访问真实上游。 */
export function installFetch(t: TestContext, reply: (url: string, init?: RequestInit) => { status?: number; body: string } | Promise<{ status?: number; body: string }>) {
  const original = trueFetch.get(t) ?? globalThis.fetch;
  if (!trueFetch.has(t)) trueFetch.set(t, original);
  const captured: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const record = { url: String(input), method: String(init?.method ?? "GET"), headers: Object.fromEntries(headers.entries()), body: typeof init?.body === "string" ? init.body : "" };
    captured.push(record);
    const answer = await reply(record.url, init);
    return new Response(answer.body, { status: answer.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return captured;
}
