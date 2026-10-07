import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { harness } from "./testSupport.js";
import { WorkspaceService } from "../services/workspaceService.js";
import { AccessService } from "../services/accessService.js";
import { TaskConcurrencyService } from "../services/taskConcurrencyService.js";
import { createTaskConcurrencyRouter } from "../api/taskConcurrencyRoutes.js";
import { HttpError } from "../errors.js";

export async function taskConcurrencyHarness(t: TestContext) {
  let config: TaskConcurrencyService | undefined;
  let executions = 0;
  const h = await harness(t, { getMaxActiveRuns: () => config?.getLimit() ?? 2, executor: { kind: "fake", async execute() { executions++; return { value: "test" }; } } });
  config = new TaskConcurrencyService(h.store, 2, () => h.service.metrics(), () => h.service.refreshConcurrency());
  await h.service.start();
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  t.after(() => workspace.shutdown());
  const access = new AccessService(h.store, workspace, "");
  async function createUser(username: string, role: "admin" | "user") {
    const user = (await access.create({ userId: randomUUID(), username, displayName: username, password: "isolated-concurrency-password", role })).user;
    const session = await access.login(username, "isolated-concurrency-password");
    return { ...session, user };
  }
  const admin = await createUser("admin", "admin");
  const user = await createUser("user", "user");
  const app = express();
  app.use(express.json());
  app.use(access.middleware(async () => h.settings.projectDirectory));
  app.use(createTaskConcurrencyRouter(config));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  async function request(token = admin.token, body?: unknown, suffix = "") {
    return fetch(base + "/api/v1/settings/task-concurrency" + suffix, { method: body === undefined ? "GET" : "PATCH", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  return { ...h, base, config, access, admin, user, request, get executions() { return executions; } };
}
