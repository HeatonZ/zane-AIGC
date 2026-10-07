import { TaskConcurrencyService } from "./services/taskConcurrencyService.js";
import { createTaskConcurrencyRouter } from "./api/taskConcurrencyRoutes.js";
import { workflowMediaValueKind } from "./domain/workflowValues.js";
import { createRunMediaExportRouter } from "./api/runMediaExportRoutes.js";
import { RunMediaExportService } from "./services/runMediaExportService.js";
import { createWorkbenchUpdateRouter } from "./api/workbenchUpdateRoutes.js";
import { readHermesImageSource } from "./execution/hermesImageSource.js";
import { ProductionLifecycle } from "./runtime/productionLifecycle.js";
import { localBackendUrl, publishMcpGeneration } from "./runtime/mcpReload.js";
import { AI_CONTRACT_VERSION } from "./ai/operations.js";
import { AccessService, runSubmitter } from "./services/accessService.js";
import { UserPortalService } from "./services/userPortalService.js";
import { createAuthRouter, createAccessRouter } from "./api/accessRoutes.js";
import { appendHermesFeedback } from "./execution/hermesFeedback.js";
import type { HermesFeedbackContext } from "./domain/feedbackContracts.js";
import { createAiRouter } from "./api/aiRoutes.js";
import { AiSceneService } from "./services/aiSceneService.js";
import { resolveComfyInputBindingTarget } from "./comfyuiBindingTarget.js";
import { resolveComfyUIReroutes } from "./comfyuiReroutes.js";
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
import type { ComfyPromptTransform } from "./capabilities/package.js";
import type { StepExecutionContext } from "./execution/workflowExecutor.js";
import { createRunRouter } from "./api/runRoutes.js";
import { describeHermesError, fetchHermesWithRetry, HermesHttpError, HermesRunEndpointUnavailableError, requestHermesRun } from "./hermesTransport.js";
import { log } from "./observability/logger.js";
import { parseHermesJson, parseHermesOutput } from "./execution/hermesOutput.js";
import { databaseFile, maxActiveRuns, shutdownTimeoutMs } from "./config.js";
import os from "node:os";
import { validateProjectDirectory, mediaContentTypeExtension } from "./artifacts/runArtifacts.js";
import { writeJsonFile } from "./storage/jsonFileStore.js";
import type { SavedSettings, HermesProfile, HermesApiConnection, ComfyUIWorkflowSummary, ComfyUIWorkflowNode, ComfyUIPropertyInfo, ComfyUINodeInfo, JsonValue, RunInputField, RunComfyBinding, RunStep } from "./domain/types.js";
import { normalizeMediaList, externalizeRuntimeValue, asRecord, uniqueStrings, workflowReferenceRoot, resolveWorkflowReference, parseWorkflowLiteral, resolveWorkflowValue, resolvePromptTemplate, toJsonValue } from "./domain/workflowValues.js";
import { cancellationError, throwIfAborted, delayWithAbort } from "./execution/cancellation.js";
import { ResourceQueues } from "./execution/resourceQueue.js";
import { bindComfyAudioPaths, comfyAutogrowInputNames, comfyBindingMediaKind, groupComfyMediaBindings } from "./execution/comfyMediaBindings.js";
import { defaultWorkflowTimeoutMinutes, minimumWorkflowTimeoutMinutes, maximumWorkflowTimeoutMinutes, parseWorkflowTimeoutMinutes, normalizeWorkflowTimeoutMinutes, workflowTimeoutMs, workflowTimeoutLabel, parseEnvFile, nonEmpty, isProduction, port, host, localDirectory, settingsFile, workspaceFile, distDirectory, hermesHome, ffmpegBinary, ffprobeBinary, execFileAsync, defaults } from "./config.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createRuntimeMediaValue,
  isRuntimeMediaValue,
  mediaKindFromWorkflowType,
  selectRuntimeMedia,
} from "./runtimeValue.js";

import { createPublicUserApp, publicEntryGuard, validatePublicListener } from "./security/publicEntry.js";
import { createErrorHandler, redactErrorText } from "./security/errorHandler.js";
import { LoginLimiter } from "./security/loginLimiter.js";
import { publicUserPort, publicUserHost, loginLimitOptions } from "./config.js";

validatePublicListener(host, port, publicUserPort);
const app = express();
app.disable("x-powered-by");
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
  hermes: ({ step, inputValues, stepValues, types, settings, signal, feedback }) => runHermesStep(step, inputValues, stepValues, types, settings, signal, feedback),
  comfyui: (context, transform) => comfyuiQueues.run(context.settings.comfyuiBaseUrl, () => runComfyUIStep(context.step, context.inputValues, context.stepValues, context.settings.comfyuiBaseUrl, context.signal, context.inputFields, context.types, workflowTimeoutMs(context.settings.workflowTimeoutMinutes), context, transform), context.signal, context.step.execution?.mode === "for_each" ? context.step.execution.maxConcurrency ?? 1 : 1),
});
const assetService: AssetService = new AssetService(metadataStore, readSettings, (project, id) => runService.getRun(project, id), () => {
  const address = server.address();
  return localBackendUrl(host, address && typeof address !== "string" ? address.port : port);
});
const taskConcurrency = new TaskConcurrencyService(metadataStore, maxActiveRuns, () => runService.metrics(), () => runService.refreshConcurrency());
const runService: RunService = new RunService({ store: metadataStore, executors, loadSettings: readSettings, getMaxActiveRuns: () => taskConcurrency.getLimit(), resolveAssets: (project, workflow, values) => assetService.resolveInputs(project, workflow, values) });
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
app.use(express.json({ limit: "16mb" }));
const aiScenes = new AiSceneService(workspaceService, executors, assetService, readSettings);
const accessService = new AccessService(metadataStore, workspaceService, process.env.ZANE_ADMIN_TOKEN ?? "", new LoginLimiter(loginLimitOptions));
const portalService = new UserPortalService(accessService, aiScenes, runService);
app.use((_req, res, next) => { res.locals.httpSecurityPolicy = accessService.securityPolicy(Boolean(res.locals.publicUserOnly)); next(); });
app.use(createAuthRouter(accessService));
app.use(accessService.middleware(async () => (await readSettings()).projectDirectory));
app.use(createTaskConcurrencyRouter(taskConcurrency));
app.use(createWorkbenchUpdateRouter(localDirectory, process.env.ZANE_RELEASE_ID ?? "unversioned", isProduction));
app.use(createAccessRouter(accessService, portalService));
app.use(createAiRouter(aiScenes, runService, readSettings, userId => { const user = accessService.find(userId); return user ? runSubmitter(user) : undefined; }));
app.use(createRunRouter(runService, readSettings, userId => { const user = accessService.find(userId); return user ? runSubmitter(user) : undefined; }));
app.use(createRunMediaExportRouter(new RunMediaExportService(readSettings, (project, id) => runService.getRun(project, id))));
app.use(createCapabilityRouter(executors));
app.use(createAssetRouter(assetService));
app.use(createClipSelectionRouter(new ClipSelectionService(assetService, runService)));
app.use(createMediaRouter(readSettings));
app.use(createCommercePackRouter(readSettings, (project, id) => runService.getRun(project, id)));


async function readSettings(): Promise<SavedSettings> {
  try {
    const text = await readFile(settingsFile, "utf8");
    const parsed = JSON.parse(text) as Partial<SavedSettings>;
    return {
      ...defaults,
      ...parsed,
      workflowTimeoutMinutes: normalizeWorkflowTimeoutMinutes(parsed.workflowTimeoutMinutes, defaults.workflowTimeoutMinutes),
      projectDirectory: normalizeProjectDirectory(parsed.projectDirectory, defaults.projectDirectory),
    };
  } catch {
    return defaults;
  }
}

function publicSettings(settings: SavedSettings) {
  return {
    enabledHermesProfiles: settings.enabledHermesProfiles,
    comfyuiBaseUrl: settings.comfyuiBaseUrl,
    projectDirectory: settings.projectDirectory,
    workflowTimeoutMinutes: settings.workflowTimeoutMinutes,
  };
}

function normalizeBaseUrl(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().replace(/\/+$/, "");
}

function normalizeProjectDirectory(value: unknown, fallback: string) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) return "";
  return path.resolve(value.trim());
}

async function probe(
  id: "comfyui",
  name: string,
  url: string,
  headers?: HeadersInit,
) {
  if (!url) {
    return { id, name, status: "not_configured" as const, message: "尚未配置" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    // Probes must consume their response body so repeated checks do not leave
    // undici keep-alive connections in an indeterminate state.
    await response.arrayBuffer();
    if (!response.ok) {
      return {
        id,
        name,
        status: "disconnected" as const,
        message: `服务返回 ${response.status}`,
      };
    }
    return { id, name, status: "connected" as const, message: "连接正常" };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "连接超时" : "无法访问服务";
    return { id, name, status: "disconnected" as const, message };
  } finally {
    clearTimeout(timeout);
  }
}

async function listHermesProfiles(): Promise<HermesProfile[]> {
  const profiles: HermesProfile[] = [];
  try {
    await access(path.join(hermesHome, "config.yaml"));
    profiles.push({ id: "default", isDefault: true });
  } catch {
    // The default profile is absent from this Hermes home.
  }

  try {
    const entries = await readdir(path.join(hermesHome, "profiles"), { withFileTypes: true });
    const discovered = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entry.name))
      .map(async (entry) => {
        try {
          await access(path.join(hermesHome, "profiles", entry.name, "config.yaml"));
          return { id: entry.name, isDefault: false };
        } catch {
          return undefined;
        }
      }));
    profiles.push(...discovered.filter((profile): profile is HermesProfile => Boolean(profile)));
  } catch {
    // Hermes may use a single-profile home without a profiles directory.
  }

  return profiles.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id));
}

async function readHermesProfileEnvironment(profile: string) {
  const profileDirectory = profile === "default" ? hermesHome : path.join(hermesHome, "profiles", profile);
  try {
    return parseEnvFile(await readFile(path.join(profileDirectory, ".env"), "utf8"));
  } catch {
    return {};
  }
}

async function readHermesApiConnection(profile: string): Promise<HermesApiConnection> {
  const [rootEnvironment, profileEnvironment] = await Promise.all([
    readHermesProfileEnvironment("default"),
    profile === "default" ? Promise.resolve(undefined) : readHermesProfileEnvironment(profile),
  ]);
  const effectiveProfileEnvironment = profileEnvironment ?? rootEnvironment;
  const apiKey = nonEmpty(process.env.HERMES_API_KEY) ?? nonEmpty(effectiveProfileEnvironment.API_SERVER_KEY);
  if (!apiKey) {
    throw new Error(`Hermes Profile「${profile}」未配置 API_SERVER_KEY；请在对应 Profile 的 .env 中启用 API Server 并设置密钥`);
  }

  const configuredBaseUrl = nonEmpty(process.env.HERMES_API_BASE_URL);
  let baseUrl = configuredBaseUrl;
  if (!baseUrl) {
    const rawHost = nonEmpty(process.env.API_SERVER_HOST) ?? nonEmpty(rootEnvironment.API_SERVER_HOST) ?? "127.0.0.1";
    const host = rawHost === "0.0.0.0" || rawHost === "::" ? "127.0.0.1" : rawHost;
    const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    const rawPort = Number(nonEmpty(process.env.API_SERVER_PORT) ?? nonEmpty(rootEnvironment.API_SERVER_PORT) ?? 8642);
    if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
      throw new Error("Hermes API_SERVER_PORT 配置无效");
    }
    baseUrl = `http://${urlHost}:${rawPort}`;
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error("HERMES_API_BASE_URL 必须是有效的 HTTP 或 HTTPS 地址");
  }
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new Error("HERMES_API_BASE_URL 必须使用 HTTP 或 HTTPS");
  }
  return { baseUrl: parsedBaseUrl.toString().replace(/\/+$/, ""), apiKey };
}

function hermesApiEndpoint(baseUrl: string, profile: string, resource: string) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const profilePath = profile === "default" ? "" : `/p/${encodeURIComponent(profile)}`;
  url.pathname = `${basePath}${profilePath}/v1/${resource.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function probeHermesApiProfile(profile: string, connection: HermesApiConnection) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchHermesWithRetry(hermesApiEndpoint(connection.baseUrl, profile, "models"), {
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    // Always drain the small /models response. Leaving undici response bodies
    // unread can retain stale keep-alive sockets after Gateway reloads and make
    // later probes fail with a misleading connection error.
    await response.arrayBuffer();
    if (response.status === 401 || response.status === 403) throw new Error(`Hermes Profile「${profile}」API 密钥认证失败`);
    if (!response.ok) throw new Error(`Hermes API Server 返回 ${response.status}`);
  } catch (error) {
    if (error instanceof TypeError) throw hermesTransportError(profile, connection, "models", error);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkHermesProfiles(enabledIds: string[]) {
  if (enabledIds.length === 0) {
    return { id: "hermes" as const, name: "Hermes Agent", status: "not_configured" as const, message: "尚未启用 Profile" };
  }

  const available = await listHermesProfiles();
  if (available.length === 0) {
    return { id: "hermes" as const, name: "Hermes Agent", status: "disconnected" as const, message: "未找到本机 Hermes Profile" };
  }

  const known = new Set(available.map((profile) => profile.id));
  const valid = uniqueStrings(enabledIds).filter((id) => known.has(id));
  if (valid.length === 0) {
    return { id: "hermes" as const, name: "Hermes Agent", status: "disconnected" as const, message: "所选 Profile 已不存在" };
  }

  const results = await Promise.all(valid.map(async (profile) => {
    try {
      const connection = await readHermesApiConnection(profile);
      await probeHermesApiProfile(profile, connection);
      return { profile, connected: true as const };
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError"
        ? "连接 Hermes API Server 超时"
        : error instanceof Error
          ? error.message
          : "无法访问 Hermes API Server";
      return { profile, connected: false as const, message };
    }
  }));
  const connectedCount = results.filter((result) => result.connected).length;
  const failure = results.find((result) => !result.connected);
  return {
    id: "hermes" as const,
    name: "Hermes Agent",
    status: connectedCount === valid.length ? "connected" as const : "disconnected" as const,
    message: failure?.connected === false
      ? failure.message
      : `${connectedCount}/${valid.length} 个已启用 Profile 的 Hermes API Server 正常`,
  };
}

function comfyPropertyType(value: unknown): ComfyUIPropertyInfo["type"] {
  switch (typeof value === "string" ? value.toUpperCase() : "") {
    case "INT":
    case "FLOAT":
    case "NUMBER": return "number";
    case "BOOLEAN": return "boolean";
    case "IMAGE":
    case "MASK": return "image_list";
    case "VIDEO": return "video_list";
    case "AUDIO": return "audio_list";
    case "STRING":
    case "COMBO": return "text";
    default: return "json";
  }
}

function comfyAutogrowImageInputNames(rawSchema: unknown) {
  return comfyAutogrowInputNames(rawSchema, "image");
}

function comfyNodeInputSchema(payload: unknown, nodeType: string, property: string) {
  const root = asRecord(payload);
  const definition = asRecord(root?.[nodeType]) ?? root;
  const inputSchema = asRecord(definition?.input);
  for (const section of ["required", "optional"]) {
    const entries = asRecord(inputSchema?.[section]);
    if (entries && property in entries) return entries[property];
  }
  return undefined;
}

function summarizeComfyUINodeInfo(payload: unknown, nodeType: string): ComfyUINodeInfo {
  const root = asRecord(payload);
  const definition = asRecord(root?.[nodeType]) ?? root;
  const inputSchema = asRecord(definition?.input);
  const inputs = ["required", "optional"].flatMap((section) => {
    const entries = asRecord(inputSchema?.[section]);
    return Object.entries(entries ?? {}).flatMap(([name, rawSchema]) => {
      const schema = Array.isArray(rawSchema) ? rawSchema : [rawSchema];
      const rawType = schema[0];
      const options = Array.isArray(rawType)
        ? uniqueStrings(rawType.map((option) => typeof option === "string" ? option : typeof option === "number" ? String(option) : ""))
        : [];
      const typeToken = options.length ? "COMBO" : rawType;
      const type = comfyAutogrowImageInputNames(rawSchema).length ? "image_list"
        : comfyAutogrowInputNames(rawSchema, "audio").length ? "audio_list" : comfyPropertyType(typeToken);
      return [{ name, type, required: section === "required", ...(options.length ? { options } : {}) }];
    });
  });
  const outputTypes = Array.isArray(definition?.output) ? definition.output : [];
  const outputNames = Array.isArray(definition?.output_name) ? definition.output_name : [];
  const outputs = outputTypes.flatMap((rawType, index) => {
    const name = typeof outputNames[index] === "string" ? outputNames[index] : `output_${index + 1}`;
    return [{ name, type: comfyPropertyType(rawType) }];
  });
  return { type: nodeType, inputs, outputs };
}

interface ComfyWorkflowConversion {
  format: "ui" | "api" | "unknown";
  converted: boolean;
  graph: Record<string, Record<string, unknown>>;
  outputProperties: Record<string, string[]>;
}

function comfyNodeId(value: unknown) {
  return typeof value === "number" || typeof value === "string" ? String(value) : undefined;
}

function comfyWidgetName(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  const widget = asRecord(value);
  if (typeof widget?.name === "string" && widget.name.trim()) return widget.name.trim();
  return undefined;
}

function comfyWidgetNames(node: Record<string, unknown>) {
  const inputNames = Array.isArray(node.inputs) ? node.inputs.flatMap((value) => {
    const input = asRecord(value);
    const name = comfyWidgetName(input?.widget);
    return name ? [name] : [];
  }) : [];
  const widgetNames = Array.isArray(node.widgets) ? node.widgets.flatMap((value) => {
    const widget = asRecord(value);
    return typeof widget?.name === "string" && widget.name.trim() ? [widget.name.trim()] : [];
  }) : [];
  return uniqueStrings([...inputNames, ...widgetNames]);
}

function comfyWidgetValues(node: Record<string, unknown>) {
  const named = asRecord(node.widgets_values_named) ?? asRecord(node.widgets_values);
  const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  const valueEntries = values.flatMap((value) => {
    const entry = asRecord(value);
    if (typeof entry?.name !== "string" || !("value" in entry)) return [];
    return [{ name: entry.name, value: entry.value }];
  });
  const namedValues = Object.fromEntries([
    ...Object.entries(named ?? {}),
    ...valueEntries.map((entry) => [entry.name, entry.value] as const),
  ]);
  return { named: namedValues, values: valueEntries.length ? [] : values };
}

function comfyObjectInfoDefinition(payload: unknown) {
  const root = asRecord(payload);
  if (!root) return undefined;
  const firstKey = Object.keys(root)[0];
  return asRecord((firstKey && asRecord(root[firstKey])?.input) ? root[firstKey] : root);
}

function comfyObjectInfoInputNames(payload: unknown) {
  const definition = comfyObjectInfoDefinition(payload);
  const input = asRecord(definition?.input);
  const inputOrder = asRecord(definition?.input_order);
  const ordered = ["required", "optional"].flatMap((section) => {
    const names = inputOrder?.[section];
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
  });
  const schemaNames = ["required", "optional"].flatMap((section) => {
    const entries = asRecord(input?.[section]);
    return Object.keys(entries ?? {});
  });
  return uniqueStrings([...ordered, ...schemaNames]);
}

function comfyLink(value: unknown) {
  if (Array.isArray(value)) {
    const originId = comfyNodeId(value[0]);
    const originSlot = typeof value[1] === "number" ? value[1] : Number(value[1]);
    return originId && Number.isInteger(originSlot) ? [originId, originSlot] as const : undefined;
  }
  const link = asRecord(value);
  const originId = comfyNodeId(link?.origin_id ?? link?.originId);
  const originSlot = typeof (link?.origin_slot ?? link?.originSlot) === "number"
    ? (link?.origin_slot ?? link?.originSlot) as number
    : Number(link?.origin_slot ?? link?.originSlot);
  return originId && Number.isInteger(originSlot) ? [originId, originSlot] as const : undefined;
}

interface ComfyUIWorkflowNodeEntry {
  id: string;
  node: Record<string, unknown>;
}

interface ComfyUIWorkflowLink {
  id: string;
  originId: string;
  originSlot: number;
  targetId: string;
  targetSlot: number;
}

type ComfyLinkSource =
  | { kind: "link"; value: readonly [string, number] }
  | { kind: "literal"; value: unknown };

interface ComfyUIWorkflowExpansion {
  nodes: ComfyUIWorkflowNodeEntry[];
  sources: Map<string, ComfyLinkSource>;
}

function comfyNodeEntries(payload: unknown): ComfyUIWorkflowNodeEntry[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((value) => {
    const node = asRecord(value);
    const id = comfyNodeId(node?.id);
    return id && node ? [{ id, node }] : [];
  });
}

function comfyLinkRecords(payload: unknown): ComfyUIWorkflowLink[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((value) => {
    if (Array.isArray(value)) {
      const id = comfyNodeId(value[0]);
      const originId = comfyNodeId(value[1]);
      const originSlot = typeof value[2] === "number" ? value[2] : Number(value[2]);
      const targetId = comfyNodeId(value[3]);
      const targetSlot = typeof value[4] === "number" ? value[4] : Number(value[4]);
      return id && originId && targetId && Number.isInteger(originSlot) && Number.isInteger(targetSlot)
        ? [{ id, originId, originSlot, targetId, targetSlot }]
        : [];
    }
    const link = asRecord(value);
    const id = comfyNodeId(link?.id);
    const originId = comfyNodeId(link?.origin_id ?? link?.originId);
    const originSlot = typeof (link?.origin_slot ?? link?.originSlot) === "number"
      ? (link?.origin_slot ?? link?.originSlot) as number
      : Number(link?.origin_slot ?? link?.originSlot);
    const targetId = comfyNodeId(link?.target_id ?? link?.targetId);
    const targetSlot = typeof (link?.target_slot ?? link?.targetSlot) === "number"
      ? (link?.target_slot ?? link?.targetSlot) as number
      : Number(link?.target_slot ?? link?.targetSlot);
    return id && originId && targetId && Number.isInteger(originSlot) && Number.isInteger(targetSlot)
      ? [{ id, originId, originSlot, targetId, targetSlot }]
      : [];
  });
}

function comfySubgraphDefinitions(root: Record<string, unknown>) {
  const definitions = asRecord(root.definitions);
  const subgraphs = Array.isArray(definitions?.subgraphs) ? definitions.subgraphs : [];
  const result = new Map<string, Record<string, unknown>>();
  for (const value of subgraphs) {
    const definition = asRecord(value);
    const id = typeof definition?.id === "string" ? definition.id : undefined;
    if (id && definition) result.set(id, definition);
  }
  return result;
}

function comfySourceFromLink(value: unknown, sources: Map<string, ComfyLinkSource>): ComfyLinkSource | undefined {
  if (value !== null && value !== undefined) {
    const source = sources.get(String(value));
    if (source) return source;
  }
  const link = comfyLink(value);
  return link ? { kind: "link", value: link } : undefined;
}

function comfySubgraphInputValue(
  instance: Record<string, unknown>,
  definition: Record<string, unknown>,
  inputSlot: number,
  parentSources: Map<string, ComfyLinkSource>,
) {
  const subgraphInputs = Array.isArray(definition.inputs) ? definition.inputs : [];
  const subgraphInput = asRecord(subgraphInputs[inputSlot]);
  const name = typeof subgraphInput?.name === "string" ? subgraphInput.name : undefined;
  if (!name) return undefined;
  const instanceInputs = Array.isArray(instance.inputs) ? instance.inputs : [];
  const instanceInput = instanceInputs.map(asRecord).find((input) => input?.name === name);
  if (instanceInput && instanceInput.link !== null && instanceInput.link !== undefined) {
    return comfySourceFromLink(instanceInput.link, parentSources);
  }
  const widget = comfyWidgetValues(instance);
  if (Object.prototype.hasOwnProperty.call(widget.named, name)) {
    return { kind: "literal" as const, value: widget.named[name] };
  }
  const widgetNames = comfyWidgetNames(instance);
  const valueIndex = widgetNames.indexOf(name);
  if (valueIndex >= 0 && valueIndex < widget.values.length) {
    return { kind: "literal" as const, value: widget.values[valueIndex] };
  }
  return undefined;
}

function expandComfyUIWorkflow(
  nodePayload: unknown,
  linkPayload: unknown,
  definitions: Map<string, Record<string, unknown>>,
  initialSources = new Map<string, ComfyLinkSource>(),
  stack = new Set<string>(),
): ComfyUIWorkflowExpansion {
  const nodes = comfyNodeEntries(nodePayload);
  const links = comfyLinkRecords(linkPayload);
  const sources = new Map(initialSources);
  for (const link of links) {
    if (!sources.has(link.id) && link.originId !== "-10" && link.originId !== "-20") {
      sources.set(link.id, { kind: "link", value: [link.originId, link.originSlot] });
    }
  }

  const expandedNodes: ComfyUIWorkflowNodeEntry[] = [];
  for (const entry of nodes) {
    const nodeType = typeof entry.node.type === "string" ? entry.node.type : "";
    const definition = definitions.get(nodeType);
    if (!definition || stack.has(nodeType)) {
      expandedNodes.push(entry);
      continue;
    }

    const childSources = new Map<string, ComfyLinkSource>();
    const childLinks = comfyLinkRecords(definition.links);
    for (const link of childLinks) {
      if (link.originId === "-10") {
        const value = comfySubgraphInputValue(entry.node, definition, link.originSlot, sources);
        if (value) childSources.set(link.id, value);
      } else if (link.originId !== "-20") {
        childSources.set(link.id, { kind: "link", value: [link.originId, link.originSlot] });
      }
    }
    const child = expandComfyUIWorkflow(
      definition.nodes,
      definition.links,
      definitions,
      childSources,
      new Set([...stack, nodeType]),
    );
    expandedNodes.push(...child.nodes);
    for (const [linkId, source] of child.sources) sources.set(linkId, source);

    const outputSources = new Map<number, ComfyLinkSource>();
    for (const link of childLinks) {
      if (link.targetId !== "-20") continue;
      const source = child.sources.get(link.id);
      if (source) outputSources.set(link.targetSlot, source);
    }
    for (const link of links) {
      if (link.originId !== entry.id) continue;
      const source = outputSources.get(link.originSlot);
      if (source) sources.set(link.id, source);
    }
  }
  return { nodes: expandedNodes, sources };
}

async function convertComfyUIWorkflow(payload: unknown, baseUrl?: string, signal?: AbortSignal): Promise<ComfyWorkflowConversion> {
  const root = asRecord(payload);
  if (!root) return { format: "unknown", converted: false, graph: {}, outputProperties: {} };

  const apiRoot = asRecord(root.prompt) ?? root;
  const apiGraph = Object.entries(apiRoot).flatMap(([id, value]) => {
    const node = asRecord(value);
    if (!node || typeof node.class_type !== "string" || !asRecord(node.inputs)) return [];
    return [[id, structuredClone(node)] as const];
  });
  if (!Array.isArray(root.nodes) || (!root.nodes.length && apiGraph.length)) {
    return apiGraph.length
      ? { format: "api", converted: false, graph: Object.fromEntries(apiGraph), outputProperties: {} }
      : { format: "unknown", converted: false, graph: {}, outputProperties: {} };
  }

  const expansion = expandComfyUIWorkflow(root.nodes, root.links, comfySubgraphDefinitions(root));
  const uiNodes = expansion.nodes;
  if (!uiNodes.length && apiGraph.length) {
    return { format: "api", converted: false, graph: Object.fromEntries(apiGraph), outputProperties: {} };
  }
  const objectInfoCache = new Map<string, Promise<unknown>>();
  async function loadObjectInfo(nodeType: string) {
    if (!baseUrl) return undefined;
    const cached = objectInfoCache.get(nodeType);
    if (cached) return cached;
    const request = fetchComfyUIJson(`${baseUrl}/object_info/${encodeURIComponent(nodeType)}`, 4500, signal).catch((error) => {
      if (signal?.aborted) throw error;
      return undefined;
    });
    objectInfoCache.set(nodeType, request);
    return request;
  }

  const objectInfoTypes = uniqueStrings(uiNodes.flatMap(({ node }) => {
    const values = comfyWidgetValues(node);
    return Object.keys(values.named).length || values.values.length
      ? [typeof node.type === "string" ? node.type : ""]
      : [];
  }));
  await Promise.all(objectInfoTypes.map((nodeType) => loadObjectInfo(nodeType)));

  const graph: Record<string, Record<string, unknown>> = {};
  const outputProperties: Record<string, string[]> = {};
  for (const { id, node } of uiNodes) {
    const nodeType = typeof node.type === "string" && node.type.trim() ? node.type : "Unknown";
    if (nodeType === "MarkdownNote" || nodeType === "Note") continue;
    const nodeInputs = Array.isArray(node.inputs) ? node.inputs.flatMap((value) => {
      const input = asRecord(value);
      return input && typeof input.name === "string" ? [{ input, name: input.name }] : [];
    }) : [];
    const inputs: Record<string, unknown> = {};
    const linkedNames = new Set<string>();
    for (const { input, name } of nodeInputs) {
      if (input.link === null || input.link === undefined) continue;
      linkedNames.add(name);
      const source = comfySourceFromLink(input.link, expansion.sources);
      if (source?.kind === "link") inputs[name] = [...source.value];
      if (source?.kind === "literal") inputs[name] = source.value;
    }

    const widget = comfyWidgetValues(node);
    const definition = Object.keys(widget.named).length || widget.values.length ? await loadObjectInfo(nodeType) : undefined;
    const apiInputNames = comfyObjectInfoInputNames(definition);
    const isApiInput = (name: string) => {
      if (!apiInputNames.length) return true;
      const parentName = name.split(".", 1)[0];
      return apiInputNames.includes(name) || apiInputNames.includes(parentName);
    };
    for (const [name, value] of Object.entries(widget.named)) {
      if (!linkedNames.has(name) && isApiInput(name)) inputs[name] = value;
    }
    if (widget.values.length && !Object.keys(widget.named).length) {
      let names = comfyWidgetNames(node).filter((name) => !linkedNames.has(name));
      if (widget.values.length > names.length) {
        names = uniqueStrings([
          ...names,
          ...apiInputNames.filter((name) => !linkedNames.has(name)),
        ]);
      }
      if (widget.values.length > names.length) {
        names = uniqueStrings([
          ...names,
          ...nodeInputs.map(({ name }) => name).filter((name) => !linkedNames.has(name)),
        ]);
      }
      widget.values.forEach((value, index) => {
        const name = names[index];
        if (name && !linkedNames.has(name) && isApiInput(name) && !(name in inputs)) inputs[name] = value;
      });
    }

    const outputs = Array.isArray(node.outputs) ? node.outputs.flatMap((value) => {
      const output = asRecord(value);
      return typeof output?.name === "string" ? [output.name] : [];
    }) : [];
    outputProperties[id] = uniqueStrings(outputs);
    const properties = asRecord(node.properties);
    const title = typeof properties?.["Node name for S&R"] === "string"
      ? properties["Node name for S&R"]
      : typeof node.title === "string" ? node.title : undefined;
    graph[id] = {
      class_type: nodeType,
      inputs,
      ...(title ? { _meta: { title } } : {}),
    };
  }
  const routedGraph = resolveComfyUIReroutes(graph);
  const converted = Object.keys(routedGraph).length > 0;
  return {
    format: converted ? "ui" : "unknown",
    converted,
    graph: routedGraph,
    outputProperties: Object.fromEntries(Object.entries(outputProperties).filter(([id]) => Object.hasOwn(routedGraph, id))),
  };
}

async function summarizeComfyUIWorkflow(payload: unknown, filename: string, baseUrl?: string, signal?: AbortSignal) {
  const conversion = await convertComfyUIWorkflow(payload, baseUrl, signal);
  const nodes: ComfyUIWorkflowNode[] = Object.entries(conversion.graph).map(([id, node]) => ({
    id,
    type: typeof node.class_type === "string" ? node.class_type : "Unknown",
    inputProperties: Object.keys(asRecord(node.inputs) ?? {}),
    outputProperties: conversion.outputProperties[id] ?? [],
  }));
  return {
    filename,
    format: conversion.format === "ui" ? "api" as const : conversion.format,
    converted: conversion.converted,
    nodes,
  };
}

async function fetchComfyUIJson(url: string, timeoutMs = 10000, parentSignal?: AbortSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`ComfyUI 返回 ${response.status}`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function comfyApiErrorMessage(body: unknown, fallback: string) {
  const root = asRecord(body);
  const error = asRecord(root?.error);
  const parts = [
    typeof root?.error === "string" ? root.error : undefined,
    typeof error?.message === "string" ? error.message : undefined,
    typeof error?.details === "string" ? error.details : undefined,
    typeof error?.type === "string" ? error.type : undefined,
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
  const nodeErrors = asRecord(root?.node_errors);
  if (nodeErrors && Object.keys(nodeErrors).length) {
    const detail = Object.entries(nodeErrors).map(([nodeId, value]) => {
      const node = asRecord(value);
      const messages = [
        typeof node?.errors === "string" ? node.errors : undefined,
        typeof node?.message === "string" ? node.message : undefined,
        typeof node?.details === "string" ? node.details : undefined,
      ].filter((item): item is string => Boolean(item));
      return `${nodeId}: ${messages.join("；") || JSON.stringify(value)}`;
    }).join("；");
    if (detail) parts.push(`节点错误：${detail}`);
  }
  return parts.length ? parts.join("；") : fallback;
}

async function fetchJson(url: string, init: RequestInit = {}, parentSignal?: AbortSignal, timeoutMs = workflowTimeoutMs(defaultWorkflowTimeoutMinutes), timeoutLabelMinutes = timeoutMs / 60 / 1000): Promise<unknown> {
  const controller = new AbortController();
  const initSignal = init.signal;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromParent = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  if (initSignal) {
    if (initSignal.aborted) controller.abort();
    else initSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      throw new Error(comfyApiErrorMessage(body, `服务返回 ${response.status}`));
    }
    return body;
  } catch (error) {
    if (timedOut && !parentSignal?.aborted && !initSignal?.aborted) {
      throw new Error(`ComfyUI 请求超时（单步上限 ${workflowTimeoutLabel(timeoutLabelMinutes)}）`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
    initSignal?.removeEventListener("abort", abortFromParent);
  }
}

function coerceHermesOutput(value: unknown, type: string): JsonValue {
  if (type === "text") return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  if (type === "number") {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) throw new Error("Hermes 输出不是有效数字");
    return parsed;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
    throw new Error("Hermes 输出不是有效布尔值");
  }
  if (type === "json") return toJsonValue(typeof value === "string" ? parseHermesJson(value) : value);
  const mediaKind = mediaKindFromWorkflowType(type);
  if (mediaKind) {
    return createRuntimeMediaValue(mediaKind, value);
  }
  return toJsonValue(value);
}

function evaluateCondition(rule: NonNullable<RunStep["control"]>["rules"][number], inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, types: Map<string, string>) {
  const left = resolveWorkflowReference(rule.leftRef, inputs, stepValues);
  const leftType = types.get(workflowReferenceRoot(rule.leftRef)) ?? "text";
  const right = rule.valueSource === "reference"
    ? resolveWorkflowReference(rule.rightRef, inputs, stepValues)
    : leftType === "number" && rule.rightValue.trim() !== ""
      ? Number(rule.rightValue)
      : leftType === "boolean"
        ? rule.rightValue === "true"
        : leftType === "json" && rule.rightValue.trim() !== ""
          ? JSON.parse(rule.rightValue) as JsonValue
          : rule.rightValue;
  const comparableLeft = externalizeRuntimeValue(left);
  const comparableRight = externalizeRuntimeValue(right);
  switch (rule.operator) {
    case "equals": return JSON.stringify(comparableLeft) === JSON.stringify(comparableRight);
    case "not_equals": return JSON.stringify(comparableLeft) !== JSON.stringify(comparableRight);
    case "greater_than": return Number(comparableLeft) > Number(comparableRight);
    case "greater_or_equal": return Number(comparableLeft) >= Number(comparableRight);
    case "less_than": return Number(comparableLeft) < Number(comparableRight);
    case "less_or_equal": return Number(comparableLeft) <= Number(comparableRight);
    case "contains": return Array.isArray(comparableLeft) ? comparableLeft.some((item) => JSON.stringify(item) === JSON.stringify(comparableRight)) : typeof comparableLeft === "string" ? comparableLeft.includes(String(comparableRight ?? "")) : typeof comparableLeft === "object" && comparableLeft !== null ? String(comparableRight) in comparableLeft : false;
    case "not_contains": return Array.isArray(comparableLeft) ? !comparableLeft.some((item) => JSON.stringify(item) === JSON.stringify(comparableRight)) : typeof comparableLeft === "string" ? !comparableLeft.includes(String(comparableRight ?? "")) : typeof comparableLeft === "object" && comparableLeft !== null ? !(String(comparableRight) in comparableLeft) : true;
    case "is_empty": return comparableLeft === undefined || comparableLeft === null || comparableLeft === "" || (Array.isArray(comparableLeft) && comparableLeft.length === 0) || (typeof comparableLeft === "object" && comparableLeft !== null && Object.keys(comparableLeft).length === 0);
    case "is_not_empty": return !(comparableLeft === undefined || comparableLeft === null || comparableLeft === "" || (Array.isArray(comparableLeft) && comparableLeft.length === 0) || (typeof comparableLeft === "object" && comparableLeft !== null && Object.keys(comparableLeft).length === 0));
    default: throw new Error(`不支持的条件运算符：${rule.operator}`);
  }
}

function workflowApiPath(filename: string) {
  if (!filename || filename.includes("..") || filename.startsWith("/") || filename.includes("\\")) throw new Error("ComfyUI 工作流文件名无效");
  return `workflows/${filename}`.split("/").map((segment) => encodeURIComponent(segment)).join("%252F");
}

async function interruptComfyUI(baseUrl: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(`${baseUrl}/interrupt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
  } catch {
    // Cancellation should still finish locally when ComfyUI is unreachable.
  } finally {
    clearTimeout(timeout);
  }
}

async function readWorkflowApiGraph(payload: unknown, baseUrl?: string, signal?: AbortSignal) {
  const conversion = await convertComfyUIWorkflow(payload, baseUrl, signal);
  const graph = conversion.graph;
  if (!Object.keys(graph).length) {
    if (conversion.format === "ui") throw new Error("ComfyUI 画布工作流中没有可转换的节点");
    throw new Error("ComfyUI 工作流内容格式无效，未找到可执行节点");
  }
  return graph;
}

function comfyOutputMedia(value: unknown) {
  const items: unknown[] = [];
  const collect = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(collect);
      return;
    }
    if (candidate !== undefined && candidate !== null) items.push(candidate);
  };
  collect(value);
  return items.flatMap((item) => {
    const media = asRecord(item);
    return media && typeof media.filename === "string" ? [{
      filename: media.filename,
      subfolder: typeof media.subfolder === "string" ? media.subfolder : "",
      type: typeof media.type === "string" ? media.type : "output",
      url: `/api/comfyui/view?${new URLSearchParams({
        filename: media.filename,
        subfolder: typeof media.subfolder === "string" ? media.subfolder : "",
        type: typeof media.type === "string" ? media.type : "output",
      })}`,
    }] : [];
  });
}

function isComfyVideoMedia(media: { filename: string }) {
  return [".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"].includes(path.extname(media.filename).toLowerCase());
}

function isComfyAudioMedia(media: { filename: string }) {
  return [".aac", ".aif", ".aiff", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"].includes(path.extname(media.filename).toLowerCase());
}

function isComfyImageMedia(media: { filename: string }) {
  return !isComfyVideoMedia(media) && !isComfyAudioMedia(media);
}

function readComfyOutputValue(history: unknown, promptId: string, nodeId: string, property: string, type: string): JsonValue {
  const prompt = asRecord(history)?.[promptId];
  const outputs = asRecord(asRecord(prompt)?.outputs);
  const nodeOutput = asRecord(outputs?.[nodeId]);
  const uiOutput = asRecord(nodeOutput?.ui);
  let resolvedNodeId = nodeOutput ? nodeId : undefined;
  const directOutputProperty = nodeOutput && Object.prototype.hasOwnProperty.call(nodeOutput, property)
    ? property
    : Object.keys(nodeOutput ?? {}).find((name) => name.toLowerCase() === property.toLowerCase());
  const uiOutputProperty = uiOutput && Object.prototype.hasOwnProperty.call(uiOutput, property)
    ? property
    : Object.keys(uiOutput ?? {}).find((name) => name.toLowerCase() === property.toLowerCase());
  let outputProperty = directOutputProperty ?? uiOutputProperty;
  let outputRecord = directOutputProperty ? nodeOutput : uiOutput;
  let propertyValue = outputProperty ? outputRecord?.[outputProperty] : undefined;
  let media = comfyOutputMedia(propertyValue);
  const mediaKind = mediaKindFromWorkflowType(type);
  const isExpectedMedia = mediaKind === "video" ? isComfyVideoMedia : mediaKind === "audio" ? isComfyAudioMedia : isComfyImageMedia;
  if (mediaKind && !media.some(isExpectedMedia) && nodeOutput) {
    const videoCandidates = Object.entries(nodeOutput).flatMap(([name, value]) => {
      const candidateMedia = comfyOutputMedia(value).filter(isExpectedMedia);
      return candidateMedia.length ? [{ name, value, media: candidateMedia }] : [];
    });
    if (videoCandidates.length === 1) {
      outputProperty = videoCandidates[0].name;
      propertyValue = videoCandidates[0].value;
      media = videoCandidates[0].media;
    } else if (videoCandidates.length > 1) {
      throw new Error(`ComfyUI 节点 ${nodeId} 找到多个${mediaKind === "audio" ? "音频" : mediaKind === "video" ? "视频" : "图像"}输出属性：${videoCandidates.map((candidate) => candidate.name).join("、")}`);
    }
  }
  if (mediaKind && !media.some(isExpectedMedia) && outputs) {
    const videoCandidates = Object.entries(outputs).flatMap(([candidateNodeId, rawOutput]) => {
      if (candidateNodeId === nodeId) return [];
      return Object.entries(asRecord(rawOutput) ?? {}).flatMap(([name, value]) => {
        const candidateMedia = comfyOutputMedia(value).filter(isExpectedMedia);
        return candidateMedia.length ? [{ nodeId: candidateNodeId, name, value, media: candidateMedia }] : [];
      });
    });
    if (videoCandidates.length === 1) {
      resolvedNodeId = videoCandidates[0].nodeId;
      outputProperty = videoCandidates[0].name;
      propertyValue = videoCandidates[0].value;
      media = videoCandidates[0].media;
    } else if (videoCandidates.length > 1) {
      const candidates = videoCandidates.map((candidate) => `${candidate.nodeId}.${candidate.name}`);
      throw new Error(`ComfyUI 节点 ${nodeId}.${property} 没有输出记录，执行结果中找到多个${mediaKind === "audio" ? "音频" : mediaKind === "video" ? "视频" : "图像"}：${candidates.join("、")}`);
    }
  }
  if (!resolvedNodeId || !outputProperty) {
    const available = Object.keys(nodeOutput ?? {});
    const mediaOutputs = Object.entries(outputs ?? {}).flatMap(([candidateNodeId, rawOutput]) =>
      Object.entries(asRecord(rawOutput) ?? {}).flatMap(([name, value]) => comfyOutputMedia(value).filter(mediaKind ? isExpectedMedia : isComfyVideoMedia).length ? [`${candidateNodeId}.${name}`] : []),
    );
    throw new Error(`ComfyUI 节点 ${nodeId} 没有输出属性 ${property}${available.length ? `（可用属性：${available.join("、")}）` : "（节点没有返回输出字段）"}${mediaOutputs.length ? `；检测到媒体：${mediaOutputs.join("、")}` : ""}`);
  }
  if (mediaKind) {
    const previewMedia = media.filter(isExpectedMedia);
    if (!previewMedia.length) throw new Error(`ComfyUI 属性 ${resolvedNodeId}.${outputProperty} 中没有可预览${mediaKind === "audio" ? "音频" : mediaKind === "video" ? "视频" : "图像"}`);
    return createRuntimeMediaValue(mediaKind, previewMedia);
  }
  let value = propertyValue;
  if (value === undefined) return null;
  if (!mediaKind && Array.isArray(value) && value.length === 1) value = value[0];
  if (type === "json" && typeof value === "string") {
    try {
      return toJsonValue(JSON.parse(value) as unknown);
    } catch {
      throw new Error("ComfyUI 节点 " + nodeId + "." + outputProperty + " 声明为结构化数据，但返回内容不是有效 JSON");
    }
  }
  return toJsonValue(value);
}

function coerceComfyInputValue(value: JsonValue | undefined, binding: RunComfyBinding, stepName: string, required = binding.required): JsonValue | undefined {
  if (value === undefined) throw new Error(`${stepName} 的输入引用没有值`);
  // Optional scene inputs are represented as null by the Studio. Leaving the
  // ComfyUI widget untouched lets it keep its own default (for example, a
  // random seed) instead of trying to convert null into a number.
  if ((value === null || value === "") && !required) return undefined;
  if (binding.options?.length) {
    if ((value === null || value === "") && !required) return undefined;
    const optionValue = typeof value === "string" ? value : String(value);
    if (!binding.options.includes(optionValue)) {
      throw new Error(`${stepName} 的 ${binding.property} 需要从可用选项中选择：${binding.options.join("、")}`);
    }
    return optionValue;
  }
  if (binding.type === "number") {
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(number)) throw new Error(`${stepName} 的 ${binding.property} 需要有效数字`);
    return number;
  }
  if (binding.type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
    throw new Error(`${stepName} 的 ${binding.property} 需要布尔值`);
  }
  if (binding.type === "text") {
    const external = externalizeRuntimeValue(value);
    return typeof external === "string" ? external : JSON.stringify(external) ?? String(external);
  }
  const mediaKind = mediaKindFromWorkflowType(binding.type);
  if (mediaKind) {
    const media = normalizeMediaList(externalizeRuntimeValue(value));
    if (media.length !== 1) throw new Error(`${stepName} 的 ${binding.property} 需要一个${mediaKind === "audio" ? "音频" : mediaKind === "video" ? "视频" : "图像"}，请在引用中选择单项或启用逐项执行`);
    return media[0];
  }
  return toJsonValue(externalizeRuntimeValue(value));
}

function comfyInputBaseType(rawSchema: unknown) {
  const schema = Array.isArray(rawSchema) ? rawSchema : [rawSchema];
  return typeof schema[0] === "string" ? schema[0].toUpperCase() : "";
}

function comfyInputImagePath(value: unknown, stepName: string, imageIndex: number) {
  const attachment = asRecord(value);
  const filename = attachment?.filename;
  const subfolder = attachment?.subfolder;
  if (attachment?.type !== "input" || typeof filename !== "string" || !filename || /[\\/]/.test(filename) || filename === "." || filename === "..") {
    throw new Error(`${stepName} 的第 ${imageIndex + 1} 张图片不是有效的 ComfyUI 上传附件`);
  }
  if (typeof subfolder !== "string" || subfolder.startsWith("/") || subfolder.startsWith("\\") || subfolder.split(/[\\/]/).some((part) => part === "." || part === "..")) {
    throw new Error(`${stepName} 的第 ${imageIndex + 1} 张图片目录无效`);
  }
  return [subfolder.replace(/[\\/]+$/, "").replace(/[\\/]/g, "/"), filename].filter(Boolean).join("/");
}

function isComfyInputImageAttachment(value: unknown) {
  const attachment = asRecord(value);
  return typeof attachment?.filename === "string"
    && typeof attachment.subfolder === "string"
    && attachment.type === "input"
    && typeof attachment.url === "string";
}

async function uploadComfyImageSource(value: unknown, baseUrl: string, stepName: string, signal?: AbortSignal) {
  if (isComfyInputImageAttachment(value)) return value;
  let filename = "input.png";
  let contentType = "image/png";
  let bytes: Buffer;
  const candidate = asRecord(value);
  const source = typeof value === "string" ? value.trim()
    : typeof candidate?.path === "string" ? candidate.path.trim()
      : typeof candidate?.url === "string" ? candidate.url.trim() : "";
  if (candidate?.filename && typeof candidate.filename === "string") filename = candidate.filename;
  if (typeof value === "string") filename = path.basename(value) || filename;
  if (candidate?.url && typeof candidate.url === "string") filename = path.basename(new URL(candidate.url, "http://localhost").pathname) || filename;
  if (candidate?.filename && typeof candidate.filename === "string") {
    filename = candidate.filename;
    const mediaType = candidate.type === "input" || candidate.type === "output" ? candidate.type : "output";
    const query = new URLSearchParams({
      filename,
      subfolder: typeof candidate.subfolder === "string" ? candidate.subfolder : "",
      type: mediaType,
    });
    const fetched = await fetchMediaResponse(`${baseUrl}/view?${query}`, signal, 100_000_000, `${stepName} 的图片超过 100 MB 限制`);
    bytes = fetched.bytes;
    contentType = fetched.contentType || mimeTypeForMediaPath(filename, contentType);
  } else if (/^data:image\//i.test(source)) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(source);
    if (!match) throw new Error(`${stepName} 的图片 data URL 格式无效`);
    bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    contentType = match[1];
    filename = `input${mediaContentTypeExtension(contentType)}`;
  } else if (/^https?:\/\//i.test(source)) {
    const fetched = await fetchMediaResponse(source, signal, 100_000_000, `${stepName} 的图片超过 100 MB 限制`);
    bytes = fetched.bytes;
    contentType = fetched.contentType || mimeTypeForMediaPath(filename, contentType);
  } else if (source) {
    const localPath = path.resolve(source);
    const info = await stat(localPath).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`${stepName} 无法读取图片文件：${source}`);
    if (info.size > 100_000_000) throw new Error(`${stepName} 的图片超过 100 MB 限制`);
    bytes = await readFile(localPath, { signal });
    filename = path.basename(localPath) || filename;
    contentType = mimeTypeForMediaPath(filename, contentType);
  } else {
    throw new Error(`${stepName} 的图片输入缺少可读取的路径、URL 或 ComfyUI 附件`);
  }
  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(bytes)], { type: contentType }), filename);
  form.set("type", "input");
  form.set("subfolder", "zane-studio");
  form.set("overwrite", "false");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const response = await fetch(`${baseUrl}/upload/image`, { method: "POST", body: form, signal: controller.signal });
    const payload = await response.json().catch(() => null) as unknown;
    const uploaded = asRecord(payload);
    if (!response.ok || typeof uploaded?.name !== "string") {
      const detail = typeof uploaded?.error === "string" ? uploaded.error : `ComfyUI 返回 ${response.status}`;
      throw new Error(`上传到 ComfyUI 失败：${detail}`);
    }
    const subfolder = typeof uploaded.subfolder === "string" ? uploaded.subfolder : "";
    return {
      id: randomUUID(),
      filename: uploaded.name,
      subfolder,
      type: "input",
      url: `/api/comfyui/view?${new URLSearchParams({ filename: uploaded.name, subfolder, type: "input" })}`,
    };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw cancellationError();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

function isComfyInputVideoAttachment(value: unknown) {
  const attachment = asRecord(value);
  return typeof attachment?.filename === "string"
    && typeof attachment.subfolder === "string"
    && attachment.type === "input"
    && typeof attachment.url === "string";
}

function comfyInputVideoPath(value: unknown, stepName: string, required: boolean): string | undefined {
  if ((value === null || value === "") && !required) return undefined;
  const attachment = asRecord(value);
  const filename = attachment?.filename;
  const subfolder = attachment?.subfolder;
  if (!isComfyInputVideoAttachment(value) || typeof filename !== "string" || !filename || /[\\/]/.test(filename) || filename === "." || filename === "..") {
    throw new Error(`${stepName} 的视频输入不是有效的 ComfyUI 上传附件`);
  }
  if (typeof subfolder !== "string" || subfolder.startsWith("/") || subfolder.startsWith("\\") || subfolder.split(/[\\/]/).some((part) => part === "." || part === "..")) {
    throw new Error(`${stepName} 的视频文件目录无效`);
  }
  return [subfolder.replace(/[\\/]+$/, "").replace(/[\\/]/g, "/"), filename].filter(Boolean).join("/");
}

async function uploadComfyVideoSource(value: unknown, baseUrl: string, stepName: string, signal?: AbortSignal) {
  if (isComfyInputVideoAttachment(value)) return value;
  const maxBytes = 500_000_000;
  const candidate = asRecord(value);
  let filename = "input.mp4";
  let contentType = "video/mp4";
  let bytes: Buffer;
  const candidateType = candidate?.type === "input" || candidate?.type === "output" ? candidate.type : undefined;
  const source = typeof value === "string" ? value.trim()
    : typeof candidate?.path === "string" ? candidate.path.trim()
      : typeof candidate?.url === "string" ? candidate.url.trim() : "";

  if (typeof candidate?.filename === "string" && candidate.filename.trim()) {
    filename = path.basename(candidate.filename) || filename;
  } else if (typeof value === "string") {
    filename = path.basename(value) || filename;
  } else if (typeof candidate?.url === "string") {
    filename = path.basename(new URL(candidate.url, "http://localhost").pathname) || filename;
  }

  if (candidate?.filename && candidateType) {
    const query = new URLSearchParams({
      filename: String(candidate.filename),
      subfolder: typeof candidate.subfolder === "string" ? candidate.subfolder : "",
      type: candidateType,
    });
    const fetched = await fetchMediaResponse(`${baseUrl}/view?${query}`, signal, maxBytes, `${stepName} 的视频超过 500 MB 限制`);
    bytes = fetched.bytes;
    contentType = fetched.contentType || mimeTypeForMediaPath(filename, contentType);
  } else if (/^data:video\//i.test(source)) {
    const match = /^data:(video\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(source);
    if (!match) throw new Error(`${stepName} 的视频 data URL 格式无效`);
    bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    contentType = match[1];
    filename = `input${mediaContentTypeExtension(contentType)}`;
  } else if (/^https?:\/\//i.test(source)) {
    const fetched = await fetchMediaResponse(source, signal, maxBytes, `${stepName} 的视频超过 500 MB 限制`);
    bytes = fetched.bytes;
    contentType = fetched.contentType || mimeTypeForMediaPath(filename, contentType);
  } else if (source) {
    const localPath = path.resolve(source);
    const info = await stat(localPath).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`${stepName} 无法读取视频文件：${source}`);
    if (info.size > maxBytes) throw new Error(`${stepName} 的视频超过 500 MB 限制`);
    bytes = await readFile(localPath, { signal });
    filename = path.basename(localPath) || filename;
    contentType = mimeTypeForMediaPath(filename, contentType);
  } else {
    throw new Error(`${stepName} 的视频输入缺少可读取的路径、URL 或 ComfyUI 附件`);
  }

  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(bytes)], { type: contentType }), filename);
  form.set("type", "input");
  form.set("subfolder", "zane-studio");
  form.set("overwrite", "false");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const response = await fetch(`${baseUrl}/upload/image`, { method: "POST", body: form, signal: controller.signal });
    const payload = await response.json().catch(() => null) as unknown;
    const uploaded = asRecord(payload);
    if (!response.ok || typeof uploaded?.name !== "string") {
      const detail = typeof uploaded?.error === "string" ? uploaded.error : `ComfyUI 返回 ${response.status}`;
      throw new Error(`上传视频到 ComfyUI 失败：${detail}`);
    }
    const subfolder = typeof uploaded.subfolder === "string" ? uploaded.subfolder : "";
    return {
      id: randomUUID(),
      filename: uploaded.name,
      subfolder,
      type: "input",
      url: `/api/comfyui/view?${new URLSearchParams({ filename: uploaded.name, subfolder, type: "input" })}`,
    };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw cancellationError();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

function isComfyInputAudioAttachment(value: unknown) {
  const attachment = asRecord(value);
  return typeof attachment?.id === "string"
    && typeof attachment.filename === "string"
    && typeof attachment.subfolder === "string"
    && attachment.type === "input"
    && typeof attachment.url === "string";
}

function comfyInputAudioPath(value: unknown, stepName: string, required: boolean): string | undefined {
  if ((value === undefined || value === null || value === "") && !required) return undefined;
  const attachment = asRecord(value);
  const filename = attachment?.filename;
  const subfolder = attachment?.subfolder;
  if (!isComfyInputAudioAttachment(value) || typeof filename !== "string" || !filename || /[\\/]/.test(filename) || filename === "." || filename === "..") {
    throw new Error(stepName + " 的音频输入不是有效的 ComfyUI 上传附件");
  }
  if (typeof subfolder !== "string" || subfolder.startsWith("/") || subfolder.startsWith("\\") || subfolder.split(/[\\/]/).some((part) => part === "." || part === "..")) {
    throw new Error(stepName + " 的音频文件目录无效");
  }
  return [subfolder.replace(/[\\/]+$/, "").replace(/[\\/]/g, "/"), filename].filter(Boolean).join("/");
}

function nextComfyGraphNodeId(graph: Record<string, Record<string, unknown>>) {
  const numericIds = Object.keys(graph).map(Number).filter((id) => Number.isSafeInteger(id) && id >= 0);
  let nextId = (numericIds.length ? Math.max(...numericIds) : 0) + 1;
  while (String(nextId) in graph) nextId += 1;
  return String(nextId);
}

function addComfyLoadImage(graph: Record<string, Record<string, unknown>>, imagePath: string): [string, number] {
  const nodeId = nextComfyGraphNodeId(graph);
  graph[nodeId] = { class_type: "LoadImage", inputs: { image: imagePath, upload: "image" } };
  return [nodeId, 0];
}

function addComfyImageBatch(graph: Record<string, Record<string, unknown>>, images: Array<[string, number]>) {
  let combined = images[0];
  for (const image of images.slice(1)) {
    const nodeId = nextComfyGraphNodeId(graph);
    graph[nodeId] = { class_type: "ImageBatch", inputs: { image1: combined, image2: image } };
    combined = [nodeId, 0];
  }
  return combined;
}

async function bindComfyImageList(graph: Record<string, Record<string, unknown>>, nodeInputs: Record<string, unknown>, nodeType: string, property: string, rawSchema: unknown, value: JsonValue | undefined, stepName: string, required: boolean, baseUrl: string, signal?: AbortSignal) {
  const external = externalizeRuntimeValue(value);
  const values = Array.isArray(external) ? external : external === undefined || external === null ? [] : [external];
  if (!values.length && required) throw new Error(`${stepName} 的图片列表至少需要一张图片`);
  const attachments = await Promise.all(values.map((item) => uploadComfyImageSource(item, baseUrl, stepName, signal)));
  const imagePaths = attachments.map((item, index) => comfyInputImagePath(item, stepName, index));
  const slotNames = comfyAutogrowImageInputNames(rawSchema);
  if (slotNames.length) {
    if (imagePaths.length > slotNames.length) {
      throw new Error(`${stepName} 的 ${nodeType}.${property} 最多支持 ${slotNames.length} 张有序图片，当前有 ${imagePaths.length} 张`);
    }
    slotNames.forEach((slotName, index) => {
      const inputName = `${property}.${slotName}`;
      delete nodeInputs[inputName];
      if (imagePaths[index]) nodeInputs[inputName] = addComfyLoadImage(graph, imagePaths[index]);
    });
    return;
  }
  if (comfyInputBaseType(rawSchema) === "IMAGE") {
    if (!imagePaths.length) {
      delete nodeInputs[property];
      return;
    }
    const imageNodes = imagePaths.map((imagePath) => addComfyLoadImage(graph, imagePath));
    nodeInputs[property] = addComfyImageBatch(graph, imageNodes);
    return;
  }
  throw new Error(`${stepName} 的 ${nodeType}.${property} 不支持图片列表；请绑定 IMAGE 输入或 ComfyUI 动态图片组`);
}

async function runComfyUIStep(step: RunStep, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, baseUrl: string, signal?: AbortSignal, inputFields: RunInputField[] = [], variableTypes: Map<string, string> = new Map(), timeoutMs = workflowTimeoutMs(defaultWorkflowTimeoutMinutes), context?: StepExecutionContext, transform?: ComfyPromptTransform) {
  throwIfAborted(signal);
  const workflowFile = step.comfyui?.workflowFile;
  if (!workflowFile) throw new Error(`${step.name} 尚未选择 ComfyUI 工作流`);
  const encodedPath = workflowApiPath(workflowFile);
  let payload: unknown;
  try {
    payload = await fetchJson(`${baseUrl}/api/userdata/${encodedPath}`, {}, signal, timeoutMs);
  } catch {
    throwIfAborted(signal);
    payload = await fetchJson(`${baseUrl}/userdata/${encodedPath}`, {}, signal, timeoutMs);
  }
  let graph: Record<string, Record<string, unknown>>;
  try {
    graph = await readWorkflowApiGraph(payload, baseUrl, signal);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${step.name} 的 ComfyUI 工作流「${workflowFile}」格式无效：${detail}`);
  }
  const bindings = step.comfyui?.bindings ?? [];
  const nodeInfoCache = new Map<string, Promise<unknown>>();
  const resolvedBindings = bindings.filter((item) => item.direction === "input").map((binding) => {
    const inputKey = binding.valueSource === "literal" ? undefined : /^input\.([a-zA-Z0-9_]+)$/.exec(workflowReferenceRoot(binding.sourceRef ?? ""))?.[1];
    const sourceField = inputKey ? inputFields.find((field) => field.key === inputKey) : undefined;
    const sourceType = binding.valueSource === "literal" ? binding.type : variableTypes.get(workflowReferenceRoot(binding.sourceRef ?? "")) ?? sourceField?.type ?? binding.type;
    const rawValue = binding.valueSource === "literal"
      ? parseWorkflowLiteral(binding.literalValue, binding.type, binding.label ?? binding.key)
      : resolveWorkflowReference(binding.sourceRef ?? "", inputs, stepValues);
    const mediaKind = comfyBindingMediaKind(rawValue, sourceType, binding.type);
    const normalizedValue = mediaKind && !isRuntimeMediaValue(rawValue) ? createRuntimeMediaValue(mediaKind, rawValue) : rawValue;
    const value = (binding.selection ? selectRuntimeMedia(normalizedValue, binding.selection) : normalizedValue) as JsonValue | undefined;
    return { binding, sourceField, value, mediaKind };
  });
  for (const group of groupComfyMediaBindings(resolvedBindings)) {
    const { binding, sourceField, value, mediaKind: sourceMediaKind } = group[0]!;
    const directNode = graph[binding.nodeId];
    const directInputs = asRecord(directNode?.inputs);
    let directPropertyDeclared = false;
    // UI/API graphs omit unconnected IMAGE/autogrow inputs. Check the real
    // schema before migrating; earlier bindings may have inserted LoadImage.image.
    if (directInputs && !Object.prototype.hasOwnProperty.call(directInputs, binding.property) && typeof directNode.class_type === "string") {
      const directType = directNode.class_type;
      let request = nodeInfoCache.get(directType);
      if (!request) {
        request = fetchComfyUIJson(`${baseUrl}/object_info/${encodeURIComponent(directType)}`, 4500, signal);
        nodeInfoCache.set(directType, request);
      }
      directPropertyDeclared = comfyNodeInputSchema(await request, directType, binding.property) !== undefined;
    }
    const resolvedTarget = resolveComfyInputBindingTarget(graph, binding, directPropertyDeclared);
    const node = resolvedTarget.node;
    const nodeInputs = resolvedTarget.nodeInputs;
    if (resolvedTarget.remapped) {
      log("warn", "comfy.binding_remapped", { step: step.name, workflowFile, bindingKey: binding.key, from: binding.nodeId, to: resolvedTarget.nodeId, property: binding.property });
    }
    if (!node) {
      const availableNodes = Object.entries(graph).map(([id, candidate]) => `${id}${typeof candidate.class_type === "string" ? `（${candidate.class_type}）` : ""}`).join("、");
      throw new Error(`${step.name} 的 ComfyUI 工作流「${workflowFile}」中不存在节点 ${binding.nodeId}（绑定 ${binding.key}）。可用节点：${availableNodes || "无"}；请重新绑定节点。`);
    }
    if (!nodeInputs) throw new Error(`${step.name} 的 ComfyUI 工作流「${workflowFile}」节点 ${binding.nodeId} 没有可执行输入；请重新导出或选择 API/UI 工作流文件。`);
    if (sourceMediaKind === "image") {
      const nodeType = typeof node.class_type === "string" ? node.class_type : "Unknown";
      let infoRequest = nodeInfoCache.get(nodeType);
      if (!infoRequest) {
        infoRequest = fetchComfyUIJson(`${baseUrl}/object_info/${encodeURIComponent(nodeType)}`, 4500, signal);
        nodeInfoCache.set(nodeType, infoRequest);
      }
      const objectInfo = await infoRequest;
      const inputSchema = comfyNodeInputSchema(objectInfo, nodeType, binding.property);
      const imageValues = group.flatMap((item) => {
        const media = normalizeMediaList(externalizeRuntimeValue(item.value));
        if (!media.length && (item.sourceField?.required ?? item.binding.required ?? false)) {
          throw new Error(`${step.name} 的 ${item.binding.label ?? item.binding.key} 至少需要一张图片`);
        }
        return media;
      });
      await bindComfyImageList(graph, nodeInputs, nodeType, binding.property, inputSchema, imageValues as JsonValue[], step.name, false, baseUrl, signal);
      continue;
    }
    if (sourceMediaKind === "video") {
      const required = sourceField?.required ?? binding.required ?? false;
      const videos = normalizeMediaList(externalizeRuntimeValue(value));
      if (!videos.length) {
        if (required) throw new Error(`${step.name} 的视频输入不能为空`);
        continue;
      }
      if (videos.length !== 1) {
        throw new Error(`${step.name} 的 ${binding.property} 需要一个视频，请在引用中选择单项或启用逐项执行`);
      }
      const video = videos[0];
      // Existing ComfyUI input choices can be passed through directly. New
      // paths, URLs, data URLs, and previous-step outputs are uploaded so
      // every downstream video loader receives an input-folder path.
      if (typeof video === "string" && binding.options?.includes(video)) {
        nodeInputs[binding.property] = video;
      } else {
        const attachment = await uploadComfyVideoSource(video, baseUrl, step.name, signal);
        const videoPath = comfyInputVideoPath(attachment, step.name, required);
        if (videoPath !== undefined) nodeInputs[binding.property] = videoPath;
      }
      continue;
    }
    if (sourceMediaKind === "audio") {
      const nodeType = typeof node.class_type === "string" ? node.class_type : "Unknown";
      const audios = group.flatMap((item) => {
        const media = normalizeMediaList(externalizeRuntimeValue(item.value));
        if (!media.length && (item.sourceField?.required ?? item.binding.required ?? false)) {
          throw new Error(`${step.name} 的 ${item.binding.label ?? item.binding.key} 至少需要一个参考音频`);
        }
        return media;
      });
      let inputSchema: unknown;
      if (nodeType !== "LoadAudio" || binding.property !== "audio") {
        let infoRequest = nodeInfoCache.get(nodeType);
        if (!infoRequest) {
          infoRequest = fetchComfyUIJson(`${baseUrl}/object_info/${encodeURIComponent(nodeType)}`, 4500, signal);
          nodeInfoCache.set(nodeType, infoRequest);
        }
        inputSchema = comfyNodeInputSchema(await infoRequest, nodeType, binding.property);
      }
      const paths = audios.map((audio) => comfyInputAudioPath(audio, step.name, true)!);
      bindComfyAudioPaths(graph, nodeInputs, nodeType, binding.property, inputSchema, paths, step.name);
      continue;
    }
    if (!(binding.property in nodeInputs)) {
      const nodeType = typeof node.class_type === "string" ? `（${node.class_type}）` : "";
      const availableProperties = Object.keys(nodeInputs);
      throw new Error(`${step.name} 的 ComfyUI 工作流「${workflowFile}」节点 ${binding.nodeId}${nodeType} 没有输入属性 ${binding.property}（可用属性：${availableProperties.join("、") || "无"}）。工作流可能已更换，请重新绑定节点和属性。`);
    }
    const converted = coerceComfyInputValue(value, binding, step.name, sourceField?.required ?? binding.required);
    if (converted !== undefined) nodeInputs[binding.property] = converted;
  }
  if (transform) {
    if (!context) throw new Error("能力包缺少执行上下文");
    const transformed = await transform({ graph, workflow: payload, context, baseUrl, timeoutMs, request: (route, init, requestSignal) => fetchJson(baseUrl + route, init, requestSignal, Math.min(timeoutMs, 120000), timeoutMs / 60 / 1000) });
    if (transformed.outputs) return transformed.outputs;
    if (transformed.graph) graph = transformed.graph;
  }
  let promptId: string | undefined;
  let promptSubmitted = false;
  let interruptPromise: Promise<void> | undefined;
  const requestInterrupt = () => {
    if (!promptSubmitted || interruptPromise) return interruptPromise;
    interruptPromise = interruptComfyUI(baseUrl);
    return interruptPromise;
  };
  const onAbort = () => { void requestInterrupt(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfAborted(signal);
    promptSubmitted = true;
    const queued = asRecord(await fetchJson(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: "zane-aigc-studio" }),
    }, signal, timeoutMs));
    promptId = typeof queued?.prompt_id === "string" ? queued.prompt_id : undefined;
    if (!promptId) {
      throw new Error(comfyApiErrorMessage(queued, "ComfyUI 未返回任务 ID"));
    }
    throwIfAborted(signal);
    const deadline = Date.now() + timeoutMs;
    let history: unknown;
    while (Date.now() < deadline) {
      await delayWithAbort(1000, signal);
      const remainingMs = Math.max(1, deadline - Date.now());
      const found = asRecord(await fetchJson(`${baseUrl}/history/${encodeURIComponent(promptId)}`, {}, signal, Math.min(timeoutMs, remainingMs), timeoutMs / 60 / 1000));
      if (found && found[promptId]) {
        history = found;
        break;
      }
    }
    if (!history) throw new Error(`等待 ComfyUI 任务完成超时（单步上限 ${workflowTimeoutLabel(timeoutMs / 60 / 1000)}）`);
    const historyEntry = asRecord(asRecord(history)?.[promptId]);
    const status = asRecord(historyEntry?.status);
    if (status?.status_str === "error") {
      const messages = Array.isArray(status.messages) ? status.messages : [];
      const executionError = messages.find((item) => Array.isArray(item) && item[0] === "execution_error");
      const detail = Array.isArray(executionError) ? asRecord(executionError[1]) : undefined;
      const errorMessage = typeof detail?.exception_message === "string" ? detail.exception_message : "ComfyUI 节点执行失败";
      const nodeType = typeof detail?.node_type === "string" ? `（${detail.node_type}）` : "";
      throw new Error(`ComfyUI 执行失败${nodeType}：${errorMessage}`);
    }
    const outputValues: Record<string, JsonValue> = {};
    for (const binding of bindings.filter((item) => item.direction === "output")) {
      const declared = step.outputs?.find((output) => output.key === binding.key);
      const type = declared?.type ?? binding.type;
      outputValues[binding.key] = readComfyOutputValue(history, promptId, binding.nodeId, binding.property, type);
    }
    return outputValues;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) await requestInterrupt();
  }
}

type HermesMessagePart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" } };

const hermesImageLimit = 12;
const hermesVideoFrameCount = 6;
const hermesInlineMediaLimit = 9_500_000;
const hermesImageSourceLimit = 100_000_000;
const hermesImageTargetBytes = 5_500_000;

function mimeTypeForMediaPath(filename: string, fallback = "application/octet-stream") {
  const extension = path.extname(filename).toLowerCase();
  return ({
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".webm": "video/webm",
    ".webp": "image/webp",
  } as Record<string, string>)[extension] ?? fallback;
}

function mediaDataUrl(bytes: Buffer, contentType: string) {
  const normalizedType = contentType.split(";")[0].trim().toLowerCase();
  if (!normalizedType.startsWith("image/")) throw new Error("Hermes 多模态输入只支持图像附件");
  return `data:${normalizedType};base64,${bytes.toString("base64")}`;
}

async function prepareHermesImage(bytes: Buffer, filename: string, contentType: string, signal?: AbortSignal, maxBytes = hermesImageTargetBytes) {
  if (bytes.length <= maxBytes) return { bytes, contentType };
  const directory = await mkdtemp(path.join(os.tmpdir(), "zane-hermes-image-"));
  const extension = path.extname(filename).replace(/[^.A-Za-z0-9]/g, "").slice(0, 12) || ".img";
  const input = path.join(directory, `input${extension}`);
  try {
    await writeFile(input, bytes);
    let probeResult: Record<string, unknown> | undefined;
    try {
      const probe = await execFileAsync(ffprobeBinary, [
        "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,pix_fmt", "-of", "json", input,
      ], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024, signal });
      probeResult = asRecord(JSON.parse(probe.stdout));
    } catch (error) {
      if (signal?.aborted) throw cancellationError();
      if (asRecord(error)?.code === "ENOENT") throw new Error("找不到 ffprobe，无法压缩 Hermes 图片");
      throw new Error("无法识别超限图片，请确认文件有效且为常见图像格式");
    }
    const stream = Array.isArray(probeResult?.streams) ? asRecord(probeResult.streams[0]) : undefined;
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error("无法识别超限图片的尺寸");
    }
    const hasAlpha = typeof stream?.pix_fmt === "string" && /(?:rgba|bgra|argb|abgr|yuva|gbrap|ya\d)/i.test(stream.pix_fmt);
    const maxEdge = Math.max(width, height);
    const edgeTargets = [...new Set([3072, 2560, 2048, 1600, 1280, 1024, 768, 512].map((edge) => Math.min(edge, maxEdge)))];
    for (const edge of edgeTargets) {
      for (const quality of hasAlpha ? [undefined] : [4, 7, 10, 13]) {
        throwIfAborted(signal);
        const output = path.join(directory, hasAlpha ? "resized.png" : "resized.jpg");
        try {
          await execFileAsync(ffmpegBinary, [
            "-hide_banner", "-loglevel", "error", "-y", "-max_pixels", "100000000", "-i", input,
            "-frames:v", "1", "-vf", `scale=${edge}:${edge}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
            ...(hasAlpha ? ["-compression_level", "9", "-pred", "mixed"] : ["-q:v", String(quality)]), output,
          ], { timeout: 60000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, signal });
        } catch (error) {
          if (signal?.aborted) throw cancellationError();
          if (asRecord(error)?.code === "ENOENT") throw new Error("找不到 ffmpeg，无法压缩 Hermes 图片");
          throw new Error("压缩 Hermes 图片失败，请确认文件有效且为常见图像格式");
        }
        const resized = await readFile(output).catch(() => undefined);
        if (resized?.length && resized.length <= maxBytes) {
          return { bytes: resized, contentType: hasAlpha ? "image/png" : "image/jpeg" };
        }
      }
    }
    throw new Error("图片无法压缩到本次请求预算；请减少图片数量或缩小图片");
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function hermesImageDataUrl(bytes: Buffer, filename: string, contentType: string, signal?: AbortSignal, maxBytes = hermesImageTargetBytes) {
  const prepared = await prepareHermesImage(bytes, filename, contentType, signal, maxBytes);
  return mediaDataUrl(prepared.bytes, prepared.contentType || "image/jpeg");
}

async function fetchMediaResponse(url: string, signal?: AbortSignal, maxBytes = 100_000_000, limitMessage = "视频附件超过 100 MB 限制") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`媒体服务返回 ${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error(limitMessage);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(limitMessage);
    return { bytes, contentType: response.headers.get("content-type") ?? "" };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

async function readComfyMediaBytes(media: Record<string, unknown>, settings: SavedSettings, signal?: AbortSignal, maxBytes = 100_000_000, limitMessage?: string) {
  if (!settings.comfyuiBaseUrl || typeof media.filename !== "string") {
    throw new Error("无法读取 ComfyUI 媒体附件，请检查 ComfyUI 连接");
  }
  const query = new URLSearchParams({
    filename: media.filename,
    subfolder: typeof media.subfolder === "string" ? media.subfolder : "",
    type: typeof media.type === "string" ? media.type : "output",
  });
  try {
    return await fetchMediaResponse(`${settings.comfyuiBaseUrl}/view?${query}`, signal, maxBytes, limitMessage);
  } catch (error) {
    if (signal?.aborted) throw cancellationError();
    throw new Error(error instanceof Error ? `无法读取 ComfyUI 媒体附件：${error.message}` : "无法读取 ComfyUI 媒体附件");
  }
}

async function hermesImageUrl(value: unknown, settings: SavedSettings, signal?: AbortSignal, maxBytes = hermesImageTargetBytes): Promise<string> {
  const source = await readHermesImageSource(value, {
    sourceLimitBytes: hermesImageSourceLimit,
    signal,
    readComfy: media => readComfyMediaBytes(media, settings, signal, hermesImageSourceLimit, "Hermes 图片原文件超过 100 MB 限制"),
  });
  if (source.kind === "url") return source.url;
  return hermesImageDataUrl(source.bytes, source.filename, mimeTypeForMediaPath(source.filename, source.contentType || "image/jpeg"), signal, maxBytes);
}

async function materializeHermesVideo(value: unknown, settings: SavedSettings, directory: string, signal?: AbortSignal) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^data:/i.test(trimmed)) {
      const match = /^data:(video\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(trimmed);
      if (!match) throw new Error("视频 data URL 格式无效");
      const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
      if (!bytes.length || bytes.length > 100_000_000) throw new Error("视频附件超过 100 MB 限制");
      const filename = path.join(directory, `input${mediaContentTypeExtension(match[1])}`);
      await writeFile(filename, bytes);
      return filename;
    }
    const filename = path.resolve(trimmed);
    const info = await stat(filename).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`无法读取视频文件：${trimmed}`);
    return filename;
  }

  const media = asRecord(value);
  if (!media) throw new Error("Hermes 视频输入格式无效");
  if (typeof media.filename === "string") {
    const { bytes } = await readComfyMediaBytes(media, settings, signal);
    const extension = path.extname(media.filename).replace(/[^.A-Za-z0-9]/g, "").slice(0, 12) || ".mp4";
    const filename = path.join(directory, `input${extension}`);
    await writeFile(filename, bytes);
    return filename;
  }
  if (typeof media.url === "string" && /^https?:\/\//i.test(media.url)) return media.url;
  throw new Error("Hermes 视频输入缺少可读取的文件或 URL");
}

function formatVideoTimestamp(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = (seconds - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${remainder}`;
}

async function hermesVideoFrameParts(value: unknown, label: string, settings: SavedSettings, signal?: AbortSignal, maxImageBytes = hermesImageTargetBytes): Promise<HermesMessagePart[]> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zane-hermes-video-"));
  try {
    const source = await materializeHermesVideo(value, settings, directory, signal);
    const inputOptions = /^https?:\/\//i.test(source)
      ? ["-protocol_whitelist", "file,http,https,tcp,tls,crypto", "-rw_timeout", "15000000"]
      : [];
    let probeOutput: string;
    try {
      const probe = await execFileAsync(ffprobeBinary, [
        "-v", "error", ...inputOptions, "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", source,
      ], { timeout: 45000, windowsHide: true, maxBuffer: 1024 * 1024, signal });
      probeOutput = probe.stdout;
    } catch (error) {
      if (signal?.aborted) throw cancellationError();
      if (asRecord(error)?.code === "ENOENT") throw new Error("找不到 ffprobe，请安装 ffmpeg 并设置 FFPROBE_BIN");
      throw new Error("无法读取视频时长，请确认视频有效且可访问");
    }
    const duration = Number(probeOutput.trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("视频时长无效，无法抽取代表帧");
    const frameCount = duration < 1 ? 1 : hermesVideoFrameCount;
    const parts: HermesMessagePart[] = [];
    for (let index = 0; index < frameCount; index += 1) {
      throwIfAborted(signal);
      const timestamp = duration < 1 ? duration / 2 : Math.min(duration - 0.05, duration * (index + 1) / (frameCount + 1));
      const filename = path.join(directory, `frame-${index + 1}.jpg`);
      try {
        await execFileAsync(ffmpegBinary, [
          "-hide_banner", "-loglevel", "error", "-y", "-ss", timestamp.toFixed(3), ...inputOptions,
          "-i", source, "-frames:v", "1", "-vf", "scale=1280:1280:force_original_aspect_ratio=decrease", "-q:v", "4", filename,
        ], { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024, signal });
      } catch (error) {
        if (signal?.aborted) throw cancellationError();
        if (asRecord(error)?.code === "ENOENT") throw new Error("找不到 ffmpeg，请安装 ffmpeg 并设置 FFMPEG_BIN");
        throw new Error(`抽取视频代表帧失败（${formatVideoTimestamp(timestamp)}）`);
      }
      const bytes = await readFile(filename).catch(() => undefined);
      if (!bytes?.length) throw new Error(`无法读取视频代表帧（${formatVideoTimestamp(timestamp)}）`);
      parts.push({ type: "text", text: `${label}，${formatVideoTimestamp(timestamp)} 帧` });
      const imageUrl = await hermesImageDataUrl(bytes, filename, "image/jpeg", signal, maxImageBytes);
      parts.push({ type: "image_url", image_url: { url: imageUrl, detail: "high" } });
    }
    return parts;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function hermesMessageContent(step: RunStep, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, types: Map<string, string>, prompt: string, settings: SavedSettings, signal?: AbortSignal): Promise<string | HermesMessagePart[]> {
  const parts: HermesMessagePart[] = [{ type: "text", text: prompt }];
  const mediaInputs = (step.inputs ?? []).flatMap((input) => {
    const type = input.valueSource === "literal" ? input.literalType ?? "text" : types.get(workflowReferenceRoot(input.sourceRef ?? ""));
    const rawValue = resolveWorkflowValue(input, inputs, stepValues);
    const mediaKind = workflowMediaValueKind(rawValue, type);
    if (mediaKind !== "image" && mediaKind !== "video") return [];
    const value = normalizeMediaList(externalizeRuntimeValue(rawValue));
    return value.length ? [{ input, mediaKind, value }] : [];
  });
  const expectedImageCount = Math.max(1, mediaInputs.reduce((total, media) => total + (
    media.mediaKind === "video" ? hermesVideoFrameCount * media.value.length : media.value.length
  ), 0));
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const imageBudgetBytes = Math.min(
    hermesImageTargetBytes,
    Math.floor(Math.max(0, hermesInlineMediaLimit - promptBytes - 32_000) * 0.7 / expectedImageCount),
  );
  let imageCount = 0;
  for (const { input, mediaKind, value } of mediaInputs) {
    const label = input.label?.trim() || input.key;
    if (mediaKind === "video") {
      for (let index = 0; index < value.length; index += 1) {
        const videoLabel = value.length > 1 ? `${label}（第 ${index + 1} 个视频）` : label;
        const frames = await hermesVideoFrameParts(value[index], videoLabel, settings, signal, imageBudgetBytes);
        imageCount += frames.filter((part) => part.type === "image_url").length;
        if (imageCount > hermesImageLimit) throw new Error(`${step.name} 最多支持 ${hermesImageLimit} 张图片或视频帧`);
        parts.push(...frames);
      }
      continue;
    }
    const imageValues = value;
    for (let index = 0; index < imageValues.length; index += 1) {
      throwIfAborted(signal);
      if (imageCount >= hermesImageLimit) throw new Error(`${step.name} 最多支持 ${hermesImageLimit} 张图片或视频帧`);
      const imageUrl = await hermesImageUrl(imageValues[index], settings, signal, imageBudgetBytes);
      imageCount += 1;
      parts.push({ type: "text", text: imageValues.length > 1 ? `${label}（第 ${index + 1} 张）` : label });
      parts.push({ type: "image_url", image_url: { url: imageUrl, detail: "high" } });
    }
  }
  const serializedLength = Buffer.byteLength(JSON.stringify(parts), "utf8");
  if (serializedLength > hermesInlineMediaLimit) {
    throw new Error("Hermes API Server 单次请求上限为 10 MB；附件已按数量压缩后仍超限，请减少附件数量或缩短提示词");
  }
  return parts.some((part) => part.type === "image_url") ? parts : prompt;
}

function hermesTransportError(profile: string, connection: HermesApiConnection, endpoint: string, error: unknown) {
  const details = describeHermesError(error);
  log("error", "hermes.request_failed", {
    profile,
    baseUrl: connection.baseUrl,
    endpoint,
    errorName: details.name,
    errorMessage: details.message,
    ...(details.code ? { code: details.code } : {}),
    ...(details.causeMessage ? { causeMessage: details.causeMessage } : {}),
  });
  const detail = [details.code, details.causeMessage, details.message]
    .filter((item, index, items): item is string => Boolean(item) && items.indexOf(item) === index)
    .join(" / ");
  return new Error(`Hermes 网络连接失败（${connection.baseUrl}）：${detail || "未知网络错误"}`);
}

async function requestHermesChatCompletion(profile: string, connection: HermesApiConnection, content: string | HermesMessagePart[], timeoutMs: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const response = await fetchHermesWithRetry(hermesApiEndpoint(connection.baseUrl, profile, "chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "hermes-agent",
        messages: [{ role: "user", content }],
        stream: false,
      }),
      signal: controller.signal,
    }, { retryHttpStatuses: [] });
    const payload = await response.json().catch(() => null) as unknown;
    const envelope = asRecord(payload);
    if (!response.ok) {
      const apiError = asRecord(envelope?.error);
      const message = typeof apiError?.message === "string" ? apiError.message : typeof envelope?.message === "string" ? envelope.message : `HTTP ${response.status}`;
      if (response.status === 401 || response.status === 403) throw new Error(`Hermes Profile「${profile}」API 密钥认证失败`);
      throw new Error(`Hermes API 请求失败：${message}`);
    }
    const choices = Array.isArray(envelope?.choices) ? envelope.choices : [];
    const choice = asRecord(choices[0]);
    const message = asRecord(choice?.message);
    if (typeof message?.content !== "string") throw new Error("Hermes API 没有返回文本内容");
    return message.content;
  } catch (error) {
    if (signal?.aborted) throw cancellationError();
    if (error instanceof Error && error.name === "AbortError") throw new Error(`Hermes API 请求超时（单步上限 ${workflowTimeoutLabel(timeoutMs / 60 / 1000)}）`);
    if (error instanceof TypeError) throw hermesTransportError(profile, connection, "chat/completions", error);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

async function requestHermesCompletion(profile: string, connection: HermesApiConnection, content: string | HermesMessagePart[], timeoutMs = workflowTimeoutMs(defaultWorkflowTimeoutMinutes), signal?: AbortSignal) {
  throwIfAborted(signal);
  try {
    return await requestHermesRun({
      startUrl: hermesApiEndpoint(connection.baseUrl, profile, "runs"),
      statusUrl: (runId) => hermesApiEndpoint(connection.baseUrl, profile, `runs/${encodeURIComponent(runId)}`),
      stopUrl: (runId) => hermesApiEndpoint(connection.baseUrl, profile, `runs/${encodeURIComponent(runId)}/stop`),
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
      },
      body: {
        model: "hermes-agent",
        input: [{ role: "user", content }],
      },
      idempotencyKey: randomUUID(),
      timeoutMs,
      signal,
    });
  } catch (error) {
    // Keep compatibility with older Hermes installations. Current Hermes uses
    // /v1/runs, but a 404/405 here should not make existing profiles unusable.
    if (error instanceof HermesRunEndpointUnavailableError) {
      log("warn", "hermes.runs_endpoint_unavailable", { profile, baseUrl: connection.baseUrl, status: error.status });
      return requestHermesChatCompletion(profile, connection, content, timeoutMs, signal);
    }
    if (error instanceof HermesHttpError && (error.status === 401 || error.status === 403)) {
      throw new Error(`Hermes Profile「${profile}」API 密钥认证失败`);
    }
    if (signal?.aborted) throw cancellationError();
    if (error instanceof Error && error.name === "AbortError") throw new Error(`Hermes API 请求超时（单步上限 ${workflowTimeoutLabel(timeoutMs / 60 / 1000)}）`);
    if (error instanceof TypeError) throw hermesTransportError(profile, connection, "runs", error);
    throw error;
  }
}

async function runHermesStep(step: RunStep, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, types: Map<string, string>, settings: SavedSettings, signal?: AbortSignal, feedback?: HermesFeedbackContext) {
  throwIfAborted(signal);
  const profile = step.hermesProfile;
  if (!profile || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) throw new Error(`${step.name} 的 Hermes Profile 无效`);
  const outputs = step.outputs ?? [];
  if (!outputs.length) throw new Error(`${step.name} 至少需要定义一个步骤输出`);
  const outputKeys = outputs.map((item) => item.key.trim());
  if (outputKeys.some((key) => !/^[a-zA-Z0-9_]+$/.test(key))) throw new Error(`${step.name} 的输出 key 无效`);
  if (new Set(outputKeys).size !== outputKeys.length) throw new Error(`${step.name} 的输出 key 不能重复`);
  const connection = await readHermesApiConnection(profile);
  const promptTypes = new Map(types);
  for (const input of step.inputs ?? []) if (input.valueSource !== "literal" && input.referenceType && input.sourceRef) promptTypes.set(input.sourceRef, input.referenceType);
  const templatePrompt = resolvePromptTemplate(step.promptTemplate ?? "", inputs, stepValues, promptTypes);
  const stepInputLines = (step.inputs ?? []).flatMap((input) => {
    const type = input.valueSource === "literal" ? input.literalType ?? "text" : types.get(workflowReferenceRoot(input.sourceRef ?? ""));
    if (mediaKindFromWorkflowType(type)) return [];
    const value = input.valueSource === "literal"
      ? parseWorkflowLiteral(input.literalValue, type, input.label ?? input.key)
      : resolveWorkflowValue(input, inputs, stepValues);
    if (value === undefined || workflowMediaValueKind(value, input.referenceType ?? type)) return [];
    const formatted = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
    return [`${input.label?.trim() || input.key}: ${formatted}`];
  });
  const prompt = stepInputLines.length
    ? `${templatePrompt}\n\n步骤输入：\n${stepInputLines.join("\n")}`
    : templatePrompt;
  if (!prompt.trim()) throw new Error(`${step.name} 的提示词为空`);
  const outputInstructions = outputs.map((item, index) => {
    const description = typeof item.description === "string" ? item.description.trim() : "";
    return `${index + 1}. ${item.key}（${item.label ?? item.key}，类型：${item.type}）${description ? `；说明：${description}` : ""}`;
  }).join("\n");
  const executionPrompt = `${appendHermesFeedback(prompt, feedback)}\n\n输出要求：\n只输出一个 JSON 对象，不要使用 Markdown 代码围栏，不要附加说明。\n字符串内的换行、回车、制表符、双引号和反斜杠必须按 JSON 语法转义，不能直接写入原始控制字符。\n对象必须包含以下字段，字段名必须完全一致：\n${outputInstructions}\n不得输出未声明的字段。`;
  const content = await hermesMessageContent(step, inputs, stepValues, types, executionPrompt, settings, signal);
  const output = (await requestHermesCompletion(profile, connection, content, workflowTimeoutMs(settings.workflowTimeoutMinutes), signal)).trim();
  const parsed = parseHermesOutput(output, outputKeys);
  if (parsed.repair) log("warn", "hermes.output_json_repaired", { stepId: step.id, profile, ...parsed.repair });
  const result = parsed.value;
  return Object.fromEntries(outputs.map((item) => {
    const value = result[item.key];
    if (value === undefined) throw new Error(`Hermes 输出缺少字段：${item.key}`);
    return [item.key, coerceHermesOutput(value, item.type)];
  }));
}

app.get("/api/ready", (_request, response) => {
  const worker = runService.metrics();
  response.status(worker.ready && worker.accepting ? 200 : 503).json({ status: worker.ready && worker.accepting ? "ready" : "not_ready", worker });
});

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", storage: "sqlite", worker: runService.metrics(), adapters: executors.definitions().flatMap((item) => item.legacy.adapter ? [item.legacy.adapter] : []), capabilities: executors.definitions().map((item) => ({ id: item.id, version: item.version })) });
});

app.get("/api/workspace", async (_request, response) => {
  response.set("Cache-Control", "no-store");
  response.json({ workspace: await workspaceService.get() ?? null });
});
app.post("/api/workspace/initialize", async (request, response) => {
  response.set("Cache-Control", "no-store");
  response.json(await workspaceService.initialize(request.body));
});
app.post("/api/workspace/merge", async (request, response) => {
  response.set("Cache-Control", "no-store");
  response.json({ workspace: await workspaceService.merge(request.body?.base, request.body?.workspace) });
});

app.post("/api/files/pick", async (request, response) => {
  const type = request.body?.type;
  if (type !== "image" && type !== "video") {
    response.status(400).json({ error: "只支持选择图像或视频文件" });
    return;
  }
  if (process.platform !== "win32") {
    response.status(501).json({ error: "本机路径选择器目前仅支持 Windows，请手动输入资源 URL 或文件路径" });
    return;
  }

  const title = type === "image" ? "选择图像文件" : "选择视频文件";
  const filter = type === "image"
    ? "图像文件|*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif;*.tif;*.tiff|所有文件|*.*"
    : "视频文件|*.mp4;*.mov;*.webm;*.mkv;*.avi;*.m4v|所有文件|*.*";
  const script = [
    "$utf8 = New-Object System.Text.UTF8Encoding($false)",
    "[Console]::OutputEncoding = $utf8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
    `$dialog.Title = '${title}'`,
    `$dialog.Filter = '${filter}'`,
    "$dialog.Multiselect = $false",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.FileName) }",
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
      windowsHide: true,
      timeout: 10 * 60 * 1000,
    });
    response.json({ path: stdout.trim() || null });
  } catch {
    response.status(500).json({ error: "无法打开本机文件选择器" });
  }
});

app.get("/api/settings", async (_request, response) => {
  response.json(publicSettings(await readSettings()));
});

app.get("/api/hermes/profiles", async (_request, response) => {
  response.json(await listHermesProfiles());
});

app.get("/api/comfyui/workflows", async (_request, response) => {
  const settings = await readSettings();
  if (!settings.comfyuiBaseUrl) {
    response.status(400).json({ error: "尚未配置 ComfyUI 地址" });
    return;
  }

  try {
    const payload = await fetchComfyUIJson(`${settings.comfyuiBaseUrl}/api/userdata?dir=workflows&recurse=true&full_info=true`);
    const workflows: ComfyUIWorkflowSummary[] = Array.isArray(payload)
      ? payload.flatMap((entry) => {
        if (typeof entry === "string") return [{ filename: entry }];
        const item = asRecord(entry);
        return typeof item?.path === "string" ? [{
          filename: item.path,
          size: typeof item.size === "number" ? item.size : undefined,
          modified: typeof item.modified === "number" ? item.modified : undefined,
        }] : [];
      }).filter((workflow) => workflow.filename.toLowerCase().endsWith(".json") && !workflow.filename.includes(".bak-"))
      : [];
    response.json(workflows.sort((a, b) => a.filename.localeCompare(b.filename, "zh-CN")));
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "读取 ComfyUI 工作流超时" : "读取 ComfyUI 工作流失败";
    response.status(502).json({ error: message });
  }
});

app.get("/api/comfyui/workflow", async (request, response) => {
  const settings = await readSettings();
  const filename = typeof request.query.filename === "string" ? request.query.filename : "";
  if (!settings.comfyuiBaseUrl || !filename) {
    response.status(400).json({ error: "缺少 ComfyUI 地址或工作流文件名" });
    return;
  }

  // Aiohttp decodes the path parameter once before ComfyUI unquotes it again.
  // Encode each filename segment once and keep separators double encoded.
  const encodedFilename = `workflows/${filename}`.split("/").map((segment) => encodeURIComponent(segment)).join("%252F");
  try {
    let payload: unknown;
    try {
      payload = await fetchComfyUIJson(`${settings.comfyuiBaseUrl}/api/userdata/${encodedFilename}`);
    } catch {
      payload = await fetchComfyUIJson(`${settings.comfyuiBaseUrl}/userdata/${encodedFilename}`);
    }
    response.json(await summarizeComfyUIWorkflow(payload, filename, settings.comfyuiBaseUrl));
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "读取 ComfyUI 工作流超时" : "读取 ComfyUI 工作流内容失败";
    response.status(502).json({ error: message });
  }
});

app.get("/api/comfyui/node-info", async (request, response) => {
  const settings = await readSettings();
  const nodeType = typeof request.query.type === "string" ? request.query.type.trim() : "";
  if (!settings.comfyuiBaseUrl || !nodeType || nodeType.length > 200) {
    response.status(400).json({ error: "缺少 ComfyUI 地址或节点类型" });
    return;
  }

  try {
    const payload = await fetchComfyUIJson(`${settings.comfyuiBaseUrl}/object_info/${encodeURIComponent(nodeType)}`);
    const info = summarizeComfyUINodeInfo(payload, nodeType);
    if (!info.inputs.length && !info.outputs.length) {
      response.status(404).json({ error: `ComfyUI 中没有找到节点类型：${nodeType}` });
      return;
    }
    response.json(info);
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "读取 ComfyUI 节点属性超时" : "读取 ComfyUI 节点属性失败";
    response.status(502).json({ error: message });
  }
});

app.post("/api/comfyui/upload-image", express.raw({ type: "application/octet-stream", limit: "100mb" }), async (request, response) => {
  const settings = await readSettings();
  const encodedFilename = request.get("x-file-name") ?? "";
  const contentType = request.get("x-file-type") ?? "";
  const imageBytes = request.body as Buffer;
  let filename = "";
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    response.status(400).json({ error: "图片文件名无效" });
    return;
  }
  const acceptedImageTypes: Record<string, string[]> = {
    ".bmp": ["image/bmp", "image/x-ms-bmp"],
    ".gif": ["image/gif"],
    ".jpeg": ["image/jpeg"],
    ".jpg": ["image/jpeg"],
    ".png": ["image/png"],
    ".tif": ["image/tiff"],
    ".tiff": ["image/tiff"],
    ".webp": ["image/webp"],
  };
  const extension = path.extname(filename).toLowerCase();
  if (!settings.comfyuiBaseUrl || !filename || filename !== path.basename(filename) || filename.includes("\0") || !acceptedImageTypes[extension]?.includes(contentType.toLowerCase()) || !Buffer.isBuffer(imageBytes) || imageBytes.length === 0) {
    response.status(400).json({ error: "缺少有效的图片文件或 ComfyUI 地址" });
    return;
  }

  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(imageBytes)], { type: contentType }), filename);
  form.set("type", "input");
  form.set("subfolder", "zane-studio");
  form.set("overwrite", "false");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const upstream = await fetch(`${settings.comfyuiBaseUrl}/upload/image`, { method: "POST", body: form, signal: controller.signal });
    const payload = await upstream.json().catch(() => null) as unknown;
    const uploaded = asRecord(payload);
    if (!upstream.ok || typeof uploaded?.name !== "string") {
      const detail = typeof uploaded?.error === "string" ? uploaded.error : `ComfyUI 返回 ${upstream.status}`;
      response.status(502).json({ error: `上传到 ComfyUI 失败：${detail}` });
      return;
    }
    const subfolder = typeof uploaded.subfolder === "string" ? uploaded.subfolder : "";
    response.json({
      id: randomUUID(),
      filename: uploaded.name,
      subfolder,
      type: "input",
      url: `/api/comfyui/view?${new URLSearchParams({ filename: uploaded.name, subfolder, type: "input" })}`,
    });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "上传图片到 ComfyUI 超时" : "无法连接 ComfyUI 上传图片";
    response.status(502).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
});

app.post("/api/comfyui/upload-audio", express.raw({ type: "application/octet-stream", limit: "100mb" }), async (request, response) => {
  const settings = await readSettings();
  const encodedFilename = request.get("x-file-name") ?? "";
  const contentType = request.get("x-file-type") ?? "";
  const audioBytes = request.body as Buffer;
  let filename = "";
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    response.status(400).json({ error: "音频文件名无效" });
    return;
  }
  const extension = path.extname(filename).toLowerCase();
  const acceptedExtensions = new Set([".aac", ".aif", ".aiff", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"]);
  if (!settings.comfyuiBaseUrl || !filename || filename !== path.basename(filename) || /[\\/]/.test(filename) || filename.includes("\0")
    || !acceptedExtensions.has(extension) || !Buffer.isBuffer(audioBytes) || audioBytes.length === 0) {
    response.status(400).json({ error: "请选择有效的音频文件，并确认已配置 ComfyUI 地址" });
    return;
  }

  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(audioBytes)], { type: contentType || "application/octet-stream" }), filename);
  form.set("type", "input");
  form.set("subfolder", "");
  form.set("overwrite", "false");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const upstream = await fetch(settings.comfyuiBaseUrl + "/upload/image", { method: "POST", body: form, signal: controller.signal });
    const payload = await upstream.json().catch(() => null) as unknown;
    const uploaded = asRecord(payload);
    if (!upstream.ok || typeof uploaded?.name !== "string") {
      const detail = typeof uploaded?.error === "string" ? uploaded.error : "ComfyUI 返回 " + upstream.status;
      response.status(502).json({ error: "上传到 ComfyUI 失败：" + detail });
      return;
    }
    const subfolder = typeof uploaded.subfolder === "string" ? uploaded.subfolder : "";
    response.json({
      id: randomUUID(),
      filename: uploaded.name,
      subfolder,
      type: "input",
      url: "/api/comfyui/view?" + new URLSearchParams({ filename: uploaded.name, subfolder, type: "input" }),
    });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "上传音频到 ComfyUI 超时" : "无法连接 ComfyUI 上传音频";
    response.status(502).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
});

app.put("/api/settings", async (request, response) => {
  const current = await readSettings();
  const profiles = await listHermesProfiles();
  const available = new Set(profiles.map((profile) => profile.id));
  const requestedProfiles: string[] = Array.isArray(request.body?.enabledHermesProfiles)
    ? (request.body.enabledHermesProfiles as unknown[]).filter((id): id is string => typeof id === "string" && available.has(id))
    : current.enabledHermesProfiles;
  const requestedWorkflowTimeoutMinutes = request.body?.workflowTimeoutMinutes;
  if (requestedWorkflowTimeoutMinutes !== undefined && parseWorkflowTimeoutMinutes(requestedWorkflowTimeoutMinutes) === undefined) {
    response.status(400).json({ error: `单步运行超时必须是 ${minimumWorkflowTimeoutMinutes} 到 ${maximumWorkflowTimeoutMinutes} 分钟的整数` });
    return;
  }
  const next: SavedSettings = {
    enabledHermesProfiles: [...new Set(requestedProfiles)],
    comfyuiBaseUrl: normalizeBaseUrl(request.body?.comfyuiBaseUrl, defaults.comfyuiBaseUrl),
    projectDirectory: normalizeProjectDirectory(request.body?.projectDirectory, current.projectDirectory),
    workflowTimeoutMinutes: normalizeWorkflowTimeoutMinutes(requestedWorkflowTimeoutMinutes, current.workflowTimeoutMinutes),
  };

  try {
    next.projectDirectory = await validateProjectDirectory(next.projectDirectory);
    await mkdir(localDirectory, { recursive: true });
    await writeJsonFile(settingsFile, next);
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "项目目录不可写" });
    return;
  }
  response.json(publicSettings(next));
});

app.post("/api/integrations/check", async (_request, response) => {
  const settings = await readSettings();
  const requestedProfiles = Array.isArray(_request.body?.enabledHermesProfiles)
    ? _request.body.enabledHermesProfiles.filter((id: unknown): id is string => typeof id === "string")
    : settings.enabledHermesProfiles;
  const [hermes, comfyui] = await Promise.all([
    checkHermesProfiles(requestedProfiles),
    probe(
      "comfyui",
      "ComfyUI",
      settings.comfyuiBaseUrl ? `${settings.comfyuiBaseUrl}/system_stats` : "",
    ),
  ]);
  response.json([hermes, comfyui]);
});

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
