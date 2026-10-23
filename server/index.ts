import { TaskConcurrencyService } from "./services/taskConcurrencyService.js";
import { createTaskConcurrencyRouter } from "./api/taskConcurrencyRoutes.js";
import { LocalExportService } from "./services/localExportSettings.js";
import { createLocalExportRouter } from "./api/localExportRoutes.js";
import { createRunMediaExportRouter } from "./api/runMediaExportRoutes.js";
import { RunMediaExportService } from "./services/runMediaExportService.js";
import { createWorkbenchUpdateRouter } from "./api/workbenchUpdateRoutes.js";
import { createMetricsRouter } from "./api/metricsRoutes.js";
import { createSystemLogRouter } from "./api/systemLogRoutes.js";
import { SystemLogService } from "./services/systemLogService.js";
import { systemLogBuffer } from "./observability/logger.js";
import { RunMetricsTracker } from "./services/runMetricsTracker.js";
import { createHealthRouter, createWorkspaceRouter, createFilesRouter, createSettingsRouter, createComfyuiRouter, createIntegrationRouter } from "./api/systemRoutes.js";
import { ProductionLifecycle } from "./runtime/productionLifecycle.js";
import { localBackendUrl, publishMcpGeneration } from "./runtime/mcpReload.js";
import { AI_CONTRACT_VERSION } from "./ai/operations.js";
import { AccessService, runSubmitter } from "./services/accessService.js";
import { UserPortalService } from "./services/userPortalService.js";
import { createAuthRouter, createAccessRouter } from "./api/accessRoutes.js";
import { CodeScenePackageService } from "./services/codeScenePackageService.js";
import { createCodePackageRouter } from "./api/codePackageRoutes.js";
import { createAiRouter } from "./api/aiRoutes.js";
import { createCompressionMiddleware } from "./api/compression.js";
import { createTaskRouter } from "./api/taskRoutes.js";
import { TaskService } from "./services/taskService.js";
import { AiSceneService } from "./services/aiSceneService.js";
import { ClipSelectionService } from "./services/clipSelectionService.js";
import { createClipSelectionRouter } from "./api/clipSelectionRoutes.js";
import { AssetService } from "./services/assetService.js";
import { createAssetRouter } from "./api/assetRoutes.js";
import { createCommercePackRouter } from "./api/commercePackRoutes.js";
import { createMediaRouter } from "./api/mediaRoutes.js";
import { SqliteStore } from "./storage/sqliteStore.js";
import { WorkspaceService } from "./services/workspaceService.js";
import { RunService } from "./services/runService.js";
import { loadCapabilityPackages } from "./capabilities/loadPackages.js";
import { createCapabilityRouter } from "./api/capabilityRoutes.js";
import { createRunRouter } from "./api/runRoutes.js";
import { log } from "./observability/logger.js";
import { comfyuiMaxConcurrency, databaseFile, maxActiveRuns, shutdownTimeoutMs, localExportRoot } from "./config.js";
import type { SavedSettings } from "./domain/types.js";
import { normalizeWorkflowTimeoutMinutes, workflowTimeoutMs, isProduction, port, host, localDirectory, settingsFile, distDirectory, defaults, workspaceFile } from "./config.js";
import { evaluateCondition } from "./execution/controlCondition.js";
import { runComfyUIStep } from "./execution/comfyStep.js";
import { runHermesStep } from "./execution/hermesStep.js";
import { ResourceQueues } from "./execution/resourceQueue.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { createPublicUserApp, publicEntryGuard, validatePublicListener } from "./security/publicEntry.js";
import { createErrorHandler, redactErrorText } from "./security/errorHandler.js";
import { executeThirdPartyJsonRequest } from "./execution/thirdPartyJsonRequest.js";
import { LoginLimiter } from "./security/loginLimiter.js";
import { publicUserPort, publicUserHost, loginLimitOptions, trustProxySetting, allowLanIngress } from "./config.js";

validatePublicListener(host, port, publicUserPort, allowLanIngress);
const app = express();
app.disable("x-powered-by");
// Only a configured, same-host reverse proxy may set X-Forwarded-*; unset keeps headers untrusted.
if (trustProxySetting !== undefined) app.set("trust proxy", trustProxySetting);
const comfyuiQueues = new ResourceQueues();
const metadataStore = new SqliteStore(databaseFile);
const workspaceService = new WorkspaceService(metadataStore, workspaceFile);
const executors = await loadCapabilityPackages({
  async condition({ step, inputValues, stepValues, types }) {
    const control = step.control;
    if (!control || control.type !== "condition" || !control.rules.length) throw new Error("条件节点至少需要一条规则");
    const results = control.rules.map((rule) => evaluateCondition(rule, inputValues, stepValues, types));
    return { result: control.match === "all" ? results.every(Boolean) : results.some(Boolean) };
  },
  hermes: ({ step, inputValues, stepValues, types, settings, signal, feedback, captureAgentPrompt, captureAgentResponse }) => runHermesStep(step, inputValues, stepValues, types, settings, signal, feedback, captureAgentPrompt, captureAgentResponse),
  comfyui: (context, transform) => comfyuiQueues.run(context.settings.comfyuiBaseUrl, () => runComfyUIStep(context.step, context.inputValues, context.stepValues, context.settings.comfyuiBaseUrl, context.signal, context.inputFields, context.types, workflowTimeoutMs(context.settings.workflowTimeoutMinutes), context, transform), context.signal, Math.min(context.step.execution?.mode === "for_each" ? context.step.execution.maxConcurrency ?? 1 : 1, comfyuiMaxConcurrency)),
  thirdPartyRequest: executeThirdPartyJsonRequest,
});
const assetService: AssetService = new AssetService(metadataStore, readSettings, (project, id) => runService.getRun(project, id), () => {
  const address = server.address();
  return localBackendUrl(host, address && typeof address !== "string" ? address.port : port);
});
const taskConcurrency = new TaskConcurrencyService(metadataStore, maxActiveRuns, () => runService.metrics(), () => runService.refreshConcurrency());
const localExport = new LocalExportService(metadataStore, localExportRoot);
const runMetricsTracker = new RunMetricsTracker();
const runService: RunService = new RunService({ store: metadataStore, executors, loadSettings: readSettings, getMaxActiveRuns: () => taskConcurrency.getLimit(), getLocalExportRoot: () => localExport.root(), resolveAssets: (project, workflow, values) => assetService.resolveInputs(project, workflow, values), metricsTracker: runMetricsTracker });
let lifecycle: ProductionLifecycle | undefined;
const upgradeBootId = process.env.ZANE_UPGRADE_OPERATION_ID;
if (upgradeBootId && !/^[0-9a-f-]{36}$/i.test(upgradeBootId)) throw new Error("Invalid upgrade operation ID");
app.use((request, response, next) => {
  if (lifecycle) { lifecycle.middleware(request, response, next); return; }
  if (upgradeBootId && !["/api/health", "/api/ready"].includes(request.path)) { response.status(503).json({code:"WORKBENCH_UPGRADING",error:"新工作台正在健康检查，暂不接受业务请求。"}); return; }
  next();
});
app.use((request, response, next) => {
  const requestId = randomUUID();
  const started = performance.now();
  response.set("X-Request-ID", requestId);
  response.once("finish", () => log("info", "http.request", { requestId, method: request.method, path: request.path, status: response.statusCode, durationMs: Math.round(performance.now() - started) }));
  next();
});
app.use(publicEntryGuard);
// Registered before the routers so every JSON reply can negotiate an encoding.
// Streamed bodies (media, ranged video, SSE) pass through untouched.
app.use(createCompressionMiddleware());
app.use(express.json({ limit: "16mb" }));
const aiScenes = new AiSceneService(workspaceService, executors, assetService, readSettings);
const accessService = new AccessService(metadataStore, workspaceService, process.env.ZANE_ADMIN_TOKEN ?? "", new LoginLimiter(loginLimitOptions));
const portalService = new UserPortalService(accessService, aiScenes, runService);
// 代码子工程（场景包）：磁盘工程 + 宿主框架。加载失败只影响该包，不影响工作台启动。
// 运行入口与运行记录都在 createCodePackageRouter 里，执行与排队完全复用 runService。
const codeScenePackages = new CodeScenePackageService({
  store: metadataStore,
  scenes: aiScenes,
  runs: runService,
  assets: assetService,
  loadSettings: readSettings,
  workbenchBaseUrl: () => localBackendUrl(host, port),
});
app.use((_req, res, next) => { res.locals.httpSecurityPolicy = accessService.securityPolicy(Boolean(res.locals.publicUserOnly)); next(); });
app.use(createAuthRouter(accessService));
app.use(accessService.middleware(async () => (await readSettings()).projectDirectory));
app.use(createTaskConcurrencyRouter(taskConcurrency));
app.use(createLocalExportRouter(localExport));
app.use(createWorkbenchUpdateRouter(localDirectory, process.env.ZANE_RELEASE_ID ?? "unversioned", isProduction));
app.use(createMetricsRouter(runService, metadataStore, runMetricsTracker));
app.use(createSystemLogRouter(new SystemLogService(systemLogBuffer, localDirectory)));
app.use(createCodePackageRouter(codeScenePackages));
app.use(createAccessRouter(accessService, portalService));
app.use(createAiRouter(aiScenes, runService, readSettings, userId => { const user = accessService.find(userId); return user ? runSubmitter(user) : undefined; }));
app.use(createTaskRouter(new TaskService(metadataStore, aiScenes, runService)));
app.use(createRunRouter(runService, readSettings, userId => { const user = accessService.find(userId); return user ? runSubmitter(user) : undefined; }));
app.use(createRunMediaExportRouter(new RunMediaExportService(readSettings, (project, id) => runService.getRun(project, id))));
app.use(createCapabilityRouter(executors, workspaceService));
app.use(createAssetRouter(assetService));
app.use(createClipSelectionRouter(new ClipSelectionService(assetService, runService)));
app.use(createMediaRouter(readSettings));
app.use(createCommercePackRouter(readSettings, (project, id) => runService.getRun(project, id)));
app.use(createHealthRouter({ runService, executors }));
app.use(createWorkspaceRouter({ workspaceService }));
app.use(createFilesRouter());
app.use(createSettingsRouter({ readSettings, invalidateSettingsCache, normalizeProjectDirectory }));
app.use(createComfyuiRouter({ readSettings }));
app.use(createIntegrationRouter({ readSettings }));


// Settings are read on every request; serve from cache until the file's identity
// (mtime+size) changes or the writer invalidates it explicitly.
let settingsCache: { stamp: string; value: SavedSettings } | undefined;
function invalidateSettingsCache() { settingsCache = undefined; }

async function readSettings(): Promise<SavedSettings> {
  try {
    const info = await stat(settingsFile);
    const stamp = `${info.mtimeMs}:${info.size}`;
    if (settingsCache?.stamp === stamp) return settingsCache.value;
    const text = await readFile(settingsFile, "utf8");
    const parsed = JSON.parse(text) as Partial<SavedSettings>;
    const value: SavedSettings = {
      ...defaults,
      ...parsed,
      workflowTimeoutMinutes: normalizeWorkflowTimeoutMinutes(parsed.workflowTimeoutMinutes, defaults.workflowTimeoutMinutes),
      projectDirectory: normalizeProjectDirectory(parsed.projectDirectory, defaults.projectDirectory),
    };
    settingsCache = { stamp, value };
    return value;
  } catch {
    invalidateSettingsCache();
    return defaults;
  }
}

function normalizeProjectDirectory(value: unknown, fallback: string) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) return "";
  return path.resolve(value.trim());
}

if (isProduction) {
  app.use(express.static(distDirectory, { index: false }));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path === "/api" || request.path.startsWith("/api/") || path.extname(request.path)) {
      next();
      return;
    }
    response.sendFile(path.join(distDirectory, "index.html"), { dotfiles: "allow" }, (error) => {
      if (error) next(error);
    });
  });
}

app.use(createErrorHandler(isProduction, (error, status, requestId) => {
  log(status >= 500 ? "error" : "warn", "http.error", { requestId, status, error: redactErrorText(error instanceof Error ? error.message : String(error)) });
}));

const server = app.listen(port, host, () => {
  void (async () => {
    await runService.start();
    // 场景包加载失败只记录在该包状态里，绝不阻塞工作台启动。
    await codeScenePackages.loadAll().then(
      result => log("info", "scene_packages.loaded", { loaded: result.loaded, failed: result.failed, packageIds: result.packages.filter(item => item.status === "ok").map(item => item.packageId) }),
      error => log("warn", "scene_packages.load_failed", { error: error instanceof Error ? error.message : String(error) }),
    );
    if (isProduction) {
      const address = server.address();
      const listeningPort = address && typeof address === "object" ? address.port : port;
      lifecycle = new ProductionLifecycle({ dataDirectory: localDirectory, port: listeningPort, store: metadataStore, metrics: () => runService.metrics(), shutdown: () => shutdown(), releaseId: process.env.ZANE_RELEASE_ID, upgradeOperationId: upgradeBootId });
      await lifecycle.start();
      await publishMcpGeneration(localBackendUrl(host, listeningPort), AI_CONTRACT_VERSION);
      log("info", "server.mcp_reload_published", { contractVersion: AI_CONTRACT_VERSION });
    }
  })().catch((error) => { log("error", "worker.start_failed", { error: String(error) }); void shutdown(1); });
  const address = server.address();
  const listeningPort = address && typeof address === "object" ? address.port : port;
  console.log(`${isProduction ? "Production" : "Development"} server listening on http://${host}:${listeningPort}`);
  if (isProduction) console.log(`Serving web assets from ${distDirectory}`);
});

const publicUserServer = publicUserPort === undefined ? undefined : createPublicUserApp(app).listen(publicUserPort, publicUserHost, () => {
  const address = publicUserServer?.address();
  log("info", "server.public_user_listening", { host: publicUserHost, port: address && typeof address === "object" ? address.port : publicUserPort, entryMode: "user-only" });
});
publicUserServer?.once("error", (error) => { log("error", "server.public_user_failed", { error: redactErrorText(error.message) }); void shutdown(1); });

let shuttingDown = false;
async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "server.shutdown_started");
  server.close();
  publicUserServer?.close();
  await lifecycle?.close();
  await Promise.all([runService.shutdown(shutdownTimeoutMs), workspaceService.shutdown()]);
  server.closeAllConnections();
  publicUserServer?.closeAllConnections();
  metadataStore.close();
  await lifecycle?.markClosed();
  log("info", "server.shutdown_completed");
  process.exit(exitCode);
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
