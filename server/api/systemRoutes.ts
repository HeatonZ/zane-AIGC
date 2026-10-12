import express, { Router } from "express";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { validateProjectDirectory } from "../artifacts/runArtifacts.js";
import { defaults, execFileAsync, localDirectory, maximumWorkflowTimeoutMinutes, minimumWorkflowTimeoutMinutes, normalizeWorkflowTimeoutMinutes, parseWorkflowTimeoutMinutes, settingsFile } from "../config.js";
import type { ComfyUIWorkflowSummary, SavedSettings } from "../domain/types.js";
import { asRecord } from "../domain/workflowValues.js";
import { fetchComfyUIJson, summarizeComfyUINodeInfo, summarizeComfyUIWorkflow } from "../execution/comfyWorkflow.js";
import type { ExecutorRegistry } from "../execution/executorRegistry.js";
import { HttpError } from "../errors.js";
import type { RunService } from "../services/runService.js";
import type { WorkspaceService } from "../services/workspaceService.js";
import { checkHermesProfiles, listHermesProfiles } from "../services/hermesProfiles.js";
import { HermesModelCatalogService } from "../services/hermesModelCatalogService.js";
import { writeJsonFile } from "../storage/jsonFileStore.js";

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

export function createHealthRouter(deps: { runService: RunService; executors: ExecutorRegistry }) {
  const { runService, executors } = deps;
  const router = Router();
  router.get("/api/ready", (_request, response) => {
    const worker = runService.metrics();
    response.status(worker.ready && worker.accepting ? 200 : 503).json({ status: worker.ready && worker.accepting ? "ready" : "not_ready", worker });
  });

  router.get("/api/health", (_request, response) => {
    response.json({ status: "ok", storage: "sqlite", worker: runService.metrics(), adapters: executors.definitions().flatMap((item) => item.legacy.adapter ? [item.legacy.adapter] : []), capabilities: executors.definitions().map((item) => ({ id: item.id, version: item.version })) });
  });
  return router;
}

export function createWorkspaceRouter(deps: { workspaceService: WorkspaceService }) {
  const { workspaceService } = deps;
  const router = Router();
  router.get("/api/workspace", async (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.json({ workspace: await workspaceService.get() ?? null });
  });
  router.post("/api/workspace/initialize", async (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(await workspaceService.initialize(request.body));
  });
  router.post("/api/workspace/merge", async (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json({ workspace: await workspaceService.merge(request.body?.base, request.body?.workspace) });
  });
  return router;
}

export function createFilesRouter() {
  const router = Router();
  router.post("/api/files/pick", async (request, response) => {
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
  return router;
}

export function createSettingsRouter(deps: {
  readSettings: () => Promise<SavedSettings>;
  invalidateSettingsCache: () => void;
  normalizeProjectDirectory: (value: unknown, fallback: string) => string;
}) {
  const { readSettings, invalidateSettingsCache, normalizeProjectDirectory } = deps;
  const router = Router();
  router.get("/api/settings", async (_request, response) => {
    response.json(publicSettings(await readSettings()));
  });

  router.put("/api/settings", async (request, response) => {
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
      invalidateSettingsCache();
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "项目目录不可写" });
      return;
    }
    response.json(publicSettings(next));
  });
  return router;
}

export function createComfyuiRouter(deps: { readSettings: () => Promise<SavedSettings> }) {
  const { readSettings } = deps;
  const router = Router();
  router.get("/api/comfyui/workflows", async (_request, response) => {
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

  router.get("/api/comfyui/workflow", async (request, response) => {
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
      if (error instanceof HttpError) {
        response.status(error.status).json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
        return;
      }
      const message = error instanceof Error && error.name === "AbortError" ? "读取 ComfyUI 工作流超时" : "读取 ComfyUI 工作流内容失败";
      response.status(502).json({ error: message });
    }
  });

  router.get("/api/comfyui/node-info", async (request, response) => {
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

  router.post("/api/comfyui/upload-image", express.raw({ type: "application/octet-stream", limit: "100mb" }), async (request, response) => {
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

  router.post("/api/comfyui/upload-audio", express.raw({ type: "application/octet-stream", limit: "100mb" }), async (request, response) => {
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
  return router;
}

export function createIntegrationRouter(deps: { readSettings: () => Promise<SavedSettings>; hermesModels?: HermesModelCatalogService }) {
  const { readSettings } = deps;
  const router = Router();
  router.get("/api/hermes/profiles", async (_request, response) => {
    response.json(await listHermesProfiles());
  });

  // Read-only model picker inventory per Profile. The same service backs the AI operation, so
  // the web editor and MCP see one contract; nothing here writes scenes or executes.
  const hermesModels = deps.hermesModels ?? new HermesModelCatalogService();
  router.get("/api/hermes/models", async (request, response) => {
    const query = (key: string) => typeof request.query[key] === "string" ? request.query[key] as string : undefined;
    const flag = (key: string) => {
      const value = query(key);
      if (value === undefined) return undefined;
      if (value !== "true" && value !== "false") throw new HttpError(400, `${key}必须是true或false`, "INVALID_HERMES_MODEL_QUERY");
      return value === "true";
    };
    const rawLimit = query("limit");
    response.set("Cache-Control", "no-store").json(await hermesModels.list({
      profile: query("profile") ?? "",
      ...(query("q") ? { q: query("q") } : {}),
      ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }),
      ...(query("cursor") ? { cursor: query("cursor") } : {}),
      ...(flag("refresh") === undefined ? {} : { refresh: flag("refresh") }),
      ...(flag("includeUnconfigured") === undefined ? {} : { includeUnconfigured: flag("includeUnconfigured") }),
    }));
  });

  router.post("/api/integrations/check", async (_request, response) => {
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
  return router;
}
