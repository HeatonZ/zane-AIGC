import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import type { SavedSettings } from "./domain/types.js";

export const defaultWorkflowTimeoutMinutes = 10;
export const minimumWorkflowTimeoutMinutes = 1;
export const maximumWorkflowTimeoutMinutes = 24 * 60;

export function parseWorkflowTimeoutMinutes(value: unknown) {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(numeric) && numeric >= minimumWorkflowTimeoutMinutes && numeric <= maximumWorkflowTimeoutMinutes
    ? numeric
    : undefined;
}

export function normalizeWorkflowTimeoutMinutes(value: unknown, fallback = defaultWorkflowTimeoutMinutes) {
  return parseWorkflowTimeoutMinutes(value) ?? fallback;
}

export function workflowTimeoutMs(minutes: number) {
  return minutes * 60 * 1000;
}

export function workflowTimeoutLabel(minutes: number) {
  return `${minutes} 分钟`;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const numeric = value === undefined || value.trim() === "" ? NaN : Number(value);
  return Number.isInteger(numeric) && numeric >= minimum && numeric <= maximum ? numeric : fallback;
}

export function parseEnvFile(text: string) {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function loadEnvironmentFiles(environment: string) {
  const values: Record<string, string> = {};
  const filenames = [
    ".env",
    ".env.local",
    `.env.${environment}`,
    `.env.${environment}.local`,
  ];
  for (const filename of filenames) {
    try {
      Object.assign(values, parseEnvFile(readFileSync(path.resolve(process.cwd(), filename), "utf8")));
    } catch {
      // Environment files are optional; deployment variables still work.
    }
  }
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function nonEmpty(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export const productionFlag = process.argv.includes("--production");
export const runtimeEnvironment = productionFlag ? "production" : (process.env.NODE_ENV ?? "development");
if (productionFlag) process.env.NODE_ENV = "production";
loadEnvironmentFiles(runtimeEnvironment);

export const isProduction = runtimeEnvironment === "production";
export const port = Number(process.env.API_PORT ?? (isProduction ? 8799 : 8798));
export const host = nonEmpty(process.env.API_HOST) ?? (isProduction ? "0.0.0.0" : "127.0.0.1");
export const localDirectory = path.resolve(nonEmpty(process.env.APP_DATA_DIR) ?? (isProduction ? path.join("data", "production") : ".local"));
export const settingsFile = path.join(localDirectory, "connections.json");
export const workspaceFile = path.join(localDirectory, "workspace.json");
export const distDirectory = path.resolve(nonEmpty(process.env.DIST_DIR) ?? "dist");
export const hermesHome = path.resolve(nonEmpty(process.env.HERMES_HOME) ?? nonEmpty(process.env.HERMES_INSTALL_ROOT) ?? path.join(os.homedir(), ".hermes"));
export const configuredComfyuiBaseUrl = nonEmpty(process.env.COMFYUI_BASE_URL)?.replace(/\/+$/, "");
export const configuredWorkflowTimeoutMinutes = normalizeWorkflowTimeoutMinutes(process.env.ZANE_WORKFLOW_TIMEOUT_MINUTES);
// Network retries are deliberately bounded: enough time for a local Hermes Gateway
// reload to finish, without making a genuinely offline service look hung forever.
export const hermesRetryAttempts = boundedInteger(process.env.HERMES_RETRY_ATTEMPTS, 6, 0, 20);
export const hermesRetryInitialDelayMs = boundedInteger(process.env.HERMES_RETRY_INITIAL_DELAY_MS, 250, 0, 10_000);
export const hermesRetryMaxDelayMs = boundedInteger(process.env.HERMES_RETRY_MAX_DELAY_MS, 4_000, 0, 60_000);
export const ffmpegBinary = nonEmpty(process.env.FFMPEG_BIN) ?? "ffmpeg";
export const ffprobeBinary = nonEmpty(process.env.FFPROBE_BIN) ?? "ffprobe";
export const execFileAsync = promisify(execFile);
export const defaults: SavedSettings = {
  enabledHermesProfiles: ["default"],
  comfyuiBaseUrl: configuredComfyuiBaseUrl ?? "http://127.0.0.1:8188",
  projectDirectory: nonEmpty(process.env.ZANE_PROJECT_DIR) ? path.resolve(process.env.ZANE_PROJECT_DIR as string) : "",
  workflowTimeoutMinutes: configuredWorkflowTimeoutMinutes,
};


export const databaseFile = path.join(localDirectory, "zane.db");
export const maxActiveRuns = boundedInteger(process.env.ZANE_MAX_ACTIVE_RUNS, 2, 1, 32);
export const shutdownTimeoutMs = Math.max(1000, Number.parseInt(process.env.ZANE_SHUTDOWN_TIMEOUT_MS ?? "15000", 10) || 15000);

// Optional second ingress: same process/services/SQLite, ordinary users only. Not enabled by default.
export const publicUserPort = nonEmpty(process.env.ZANE_PUBLIC_USER_PORT) === undefined ? undefined : Number(process.env.ZANE_PUBLIC_USER_PORT);
export const publicUserHost = nonEmpty(process.env.ZANE_PUBLIC_USER_HOST) ?? "127.0.0.1";
const loginNumber = (key: string) => nonEmpty(process.env[key]) === undefined ? undefined : Number(process.env[key]);
const loginWindowSeconds = loginNumber("ZANE_LOGIN_WINDOW_SECONDS");
if (loginWindowSeconds !== undefined && !Number.isInteger(loginWindowSeconds)) throw new Error("ZANE_LOGIN_WINDOW_SECONDS 必须为整数秒");
export const loginLimitOptions = {
  windowMs: loginWindowSeconds === undefined ? undefined : loginWindowSeconds * 1000,
  accountAttempts: loginNumber("ZANE_LOGIN_ACCOUNT_ATTEMPTS"),
  sourceAttempts: loginNumber("ZANE_LOGIN_SOURCE_ATTEMPTS"),
  maxConcurrent: loginNumber("ZANE_LOGIN_MAX_CONCURRENT"),
};
