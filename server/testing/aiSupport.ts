import express from "express";
import path from "node:path";
import type { TestContext } from "node:test";
import type { StepExecutor } from "../execution/executorRegistry.js";
import type { CapabilityRuntime } from "../capabilities/package.js";
import { productionHarness } from "./productionSupport.js";
import { WorkspaceService } from "../services/workspaceService.js";
import { AiSceneService } from "../services/aiSceneService.js";
import { createAiRouter } from "../api/aiRoutes.js";
import { createRunRouter } from "../api/runRoutes.js";
import { createAssetRouter } from "../api/assetRoutes.js";
import { createClipSelectionRouter } from "../api/clipSelectionRoutes.js";
import { createRunMediaExportRouter } from "../api/runMediaExportRoutes.js";
import { RunMediaExportService } from "../services/runMediaExportService.js";
import { createCapabilityRouter } from "../api/capabilityRoutes.js";
import { HttpError } from "../errors.js";
import { workflow } from "./testSupport.js";

export function aiWorkspace(review = false) {
  const definition = workflow([{ id: "first", name: "first", kind: "fake", review: { enabled: review, instruction: "确认测试结果" }, outputs: [{ key: "value", type: "text" }] }, { id: "last", name: "last", kind: "fake", outputs: [{ key: "value", type: "text" }] }]);
  definition.sceneId = "demo";
  definition.inputs = [{ key: "flag", type: "boolean", required: true }, { key: "style", type: "select" }];
  const saved = { ...definition, inputs: [{ ...definition.inputs[0], defaultValue: false }, { ...definition.inputs[1], optionPresetId: "style-options", options: ["草稿值"], defaultValue: "已发布值" }] };
  const scene = { id: "demo", title: "测试场景", summary: "测试" };
  return { format: "zane-studio.workspace/v1", scenes: [scene, { id: "unpublished", title: "未发布" }], workflows: { demo: { ...saved, name: "不能运行的草稿" } }, optionPresets: [{ id: "style-options", name: "新草稿选项", options: ["草稿值"] }], drafts: [], sceneVersions: { demo: { publishedVersionId: "version-a", versions: [{ id: "version-a", version: "1234abcd", publishedAt: "2026-10-01T00:00:00.000Z", scene, workflow: saved, optionPresets: [{ id: "style-options", name: "发布版选项", options: ["已发布值"] }] }] } } };
}
export async function aiHarness(t: TestContext, options: { review?: boolean; executor?: StepExecutor; emptyWorkspace?: boolean; thirdPartyRequest?: CapabilityRuntime["thirdPartyRequest"] } = {}) {
  const h = await productionHarness(t, options.executor, undefined, options.thirdPartyRequest);
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  if (!options.emptyWorkspace) await workspace.initialize(aiWorkspace(options.review));
  await h.service.start();
  t.after(() => workspace.shutdown());
  const scenes = new AiSceneService(workspace, h.executors, h.assets, async () => h.settings);
  const app = express();
  app.use((_req, res, next) => { res.set("X-Request-ID", "ai-test-request"); next(); });
  app.use(express.json());
  app.use(createAiRouter(scenes, h.service, async () => h.settings));
  app.use(createRunRouter(h.service, async () => h.settings));
  app.use(createRunMediaExportRouter(new RunMediaExportService(async () => h.settings, (project, id) => h.service.getRun(project, id))));
  app.use(createCapabilityRouter(h.executors));
  app.use(createAssetRouter(h.assets));
  app.use(createClipSelectionRouter(h.clips));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR", ...(error instanceof HttpError && error.details ? { details: error.details } : {}) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return { ...h, workspace, scenes, base: "http://127.0.0.1:" + (server.address() as { port: number }).port };
}
