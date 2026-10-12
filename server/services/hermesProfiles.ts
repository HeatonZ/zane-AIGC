import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnvFile, nonEmpty, hermesHome } from "../config.js";
import { fetchHermesWithRetry, hermesTransportError } from "../hermesTransport.js";
import type { HermesProfile, HermesApiConnection } from "../domain/types.js";
import { uniqueStrings } from "../domain/workflowValues.js";

export async function listHermesProfiles(): Promise<HermesProfile[]> {
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

export async function readHermesApiConnection(profile: string): Promise<HermesApiConnection> {
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

export function hermesApiEndpoint(baseUrl: string, profile: string, resource: string) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const profilePath = profile === "default" ? "" : `/p/${encodeURIComponent(profile)}`;
  url.pathname = `${basePath}${profilePath}/v1/${resource.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** The gateway mirrors its whole route table under ``/p/<profile>/``; dashboard-style resources
 *  such as ``api/model/options`` live outside ``/v1`` and must keep their own prefix. */
export function hermesApiRoute(baseUrl: string, profile: string, route: string) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const profilePath = profile === "default" ? "" : `/p/${encodeURIComponent(profile)}`;
  url.pathname = `${basePath}${profilePath}/${route.replace(/^\/+/, "")}`;
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

export async function checkHermesProfiles(enabledIds: string[]) {
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
