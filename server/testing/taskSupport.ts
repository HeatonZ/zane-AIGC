import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { StepExecutor } from "../execution/executorRegistry.js";
import { productionHarness } from "./productionSupport.js";
import { aiWorkspace } from "./aiSupport.js";
import { WorkspaceService } from "../services/workspaceService.js";
import { AccessService } from "../services/accessService.js";
import { AiSceneService } from "../services/aiSceneService.js";
import { TaskService } from "../services/taskService.js";
import { createTaskRouter } from "../api/taskRoutes.js";
import { HttpError } from "../errors.js";

const PASSWORD = "isolated-task-password";

/** 两个已发布场景：demo（version-a）与 demo2（version-b），用于构造“部分项失败、其余继续”的场景。 */
function taskWorkspace(review = false) {
  const base = aiWorkspace(review) as Record<string, unknown>;
  const versions = { ...(base.sceneVersions as Record<string, unknown>) };
  const demo = versions.demo as { versions: Array<Record<string, unknown>> };
  versions.demo2 = { publishedVersionId: "version-b", versions: [{ ...demo.versions[0], id: "version-b", scene: { id: "demo2", title: "测试场景二", summary: "测试" } }] };
  return { ...base, scenes: [...(base.scenes as unknown[]), { id: "demo2", title: "测试场景二", summary: "测试" }], sceneVersions: versions };
}

/** 任务路由测试台：真实 express + 访问中间件 + 真实运行服务；执行用 fake 执行器，不调用付费模型。 */
export async function taskHarness(t: TestContext, options: { executor?: StepExecutor; review?: boolean } = {}) {
  const h = await productionHarness(t, options.executor);
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  await workspace.initialize(taskWorkspace(options.review));
  await h.service.start();
  t.after(() => workspace.shutdown());
  const scenes = new AiSceneService(workspace, h.executors, h.assets, async () => h.settings);
  const tasks = new TaskService(h.store, scenes, h.service);
  const access = new AccessService(h.store, workspace, "");
  async function createUser(username: string, role: "admin" | "user") {
    const user = (await access.create({ userId: randomUUID(), username, displayName: username, password: PASSWORD, role })).user;
    return { ...(await access.login(username, PASSWORD)), user };
  }
  const admin = await createUser("admin", "admin");
  const user = await createUser("user", "user");
  const app = express();
  app.use(express.json());
  app.use(access.middleware(async () => h.settings.projectDirectory));
  app.use(createTaskRouter(tasks));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR", ...(error instanceof HttpError && error.details ? { details: error.details } : {}) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  async function call(method: string, suffix: string, body?: unknown, token = admin.token) {
    const response = await fetch(base + suffix, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  /** 直调服务时模拟已认证管理员：授权永远通过，身份为固定测试账号。 */
  const actor = { ownerUserId: admin.user.id, submitter: { userId: admin.user.id, username: "admin", displayName: "admin" }, authorize() {} };
  /** 一个任务项的最小合法输入：demo 场景发布版要求 flag 必填，style 用发布版默认值。 */
  const item = (label: string, inputValues: Record<string, unknown> = { flag: true }) => ({ label, sceneId: "demo", versionId: "version-a", inputValues });
  const newTaskId = () => randomUUID();
  return { ...h, workspace, scenes, tasks, access, admin, user, actor, base, call, item, newTaskId };
}
