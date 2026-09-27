import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface SavedSettings {
  enabledHermesProfiles: string[];
  comfyuiBaseUrl: string;
}

interface HermesProfile {
  id: string;
  isDefault: boolean;
}

const app = express();
const port = Number(process.env.API_PORT ?? 8799);
const localDirectory = path.resolve(process.cwd(), ".local");
const settingsFile = path.join(localDirectory, "connections.json");
const hermesHome = path.resolve(process.env.HERMES_HOME ?? process.env.HERMES_INSTALL_ROOT ?? path.join(os.homedir(), ".hermes"));
const execFileAsync = promisify(execFile);
const defaults: SavedSettings = {
  enabledHermesProfiles: ["default"],
  comfyuiBaseUrl: "http://127.0.0.1:8188",
};

app.use(express.json({ limit: "64kb" }));

async function readSettings(): Promise<SavedSettings> {
  try {
    const text = await readFile(settingsFile, "utf8");
    return { ...defaults, ...(JSON.parse(text) as Partial<SavedSettings>) };
  } catch {
    return defaults;
  }
}

function publicSettings(settings: SavedSettings) {
  return {
    enabledHermesProfiles: settings.enabledHermesProfiles,
    comfyuiBaseUrl: settings.comfyuiBaseUrl,
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

function parseHermesProfileStates(output: string) {
  const states = new Map<string, boolean>();
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  for (const line of plain.split(/\r?\n/)) {
    const columns = line.trim().split(/\s{2,}/);
    const profileId = columns[0]?.replace(/^[◆*+\s]+/, "");
    const gateway = columns[2]?.trim().toLowerCase();
    if (/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profileId ?? "") && gateway) {
      states.set(profileId, gateway === "running");
    }
  }
  return states;
}

async function checkHermesProfiles(enabledIds: string[]) {
  if (enabledIds.length === 0) {
    return { id: "hermes" as const, name: "Hermes Agent", status: "not_configured" as const, message: "尚未启用 Profile" };
  }

  const available = await listHermesProfiles();
  if (available.length === 0) {
    return { id: "hermes" as const, name: "Hermes Agent", status: "disconnected" as const, message: "未找到本机 Hermes Profile" };
  }

  try {
    const { stdout } = await execFileAsync(process.env.HERMES_BIN ?? "hermes", ["profile", "list"], {
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const gatewayStates = parseHermesProfileStates(stdout);
    const known = new Set(available.map((profile) => profile.id));
    const valid = enabledIds.filter((id) => known.has(id));
    const runningCount = valid.filter((id) => gatewayStates.get(id) === true).length;
    if (valid.length === 0) {
      return { id: "hermes" as const, name: "Hermes Agent", status: "disconnected" as const, message: "所选 Profile 已不存在" };
    }
    const status = runningCount === valid.length ? "connected" as const : "disconnected" as const;
    return {
      id: "hermes" as const,
      name: "Hermes Agent",
      status,
      message: `${runningCount}/${valid.length} 个已启用 Profile 的 Gateway 正常`,
    };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    const message = code === "ENOENT"
      ? "找不到 Hermes CLI，请检查 PATH 或设置 HERMES_BIN"
      : "读取 Hermes Profile Gateway 状态失败";
    return { id: "hermes" as const, name: "Hermes Agent", status: "disconnected" as const, message };
  }
}

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/api/settings", async (_request, response) => {
  response.json(publicSettings(await readSettings()));
});

app.get("/api/hermes/profiles", async (_request, response) => {
  response.json(await listHermesProfiles());
});

app.put("/api/settings", async (request, response) => {
  const current = await readSettings();
  const profiles = await listHermesProfiles();
  const available = new Set(profiles.map((profile) => profile.id));
  const requestedProfiles: string[] = Array.isArray(request.body?.enabledHermesProfiles)
    ? (request.body.enabledHermesProfiles as unknown[]).filter((id): id is string => typeof id === "string" && available.has(id))
    : current.enabledHermesProfiles;
  const next: SavedSettings = {
    enabledHermesProfiles: [...new Set(requestedProfiles)],
    comfyuiBaseUrl: normalizeBaseUrl(request.body?.comfyuiBaseUrl, defaults.comfyuiBaseUrl),
  };

  await mkdir(localDirectory, { recursive: true });
  await writeFile(settingsFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
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

app.listen(port, "127.0.0.1", () => {
  console.log(`Local API listening on http://127.0.0.1:${port}`);
});
