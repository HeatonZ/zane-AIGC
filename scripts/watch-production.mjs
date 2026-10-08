import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { productionSettings, portIsOpen } from "./production-runtime.mjs";

const exec = promisify(execFile);
const settings = await productionSettings();
const dataDirectory = settings.dataDirectory;
const logFile = path.join(dataDirectory, "watchdog.log");
const lockFile = path.join(dataDirectory, "watchdog.lock");
const serverLogFile = path.join(dataDirectory, "watchdog-server.log");
const latestUpgradeFile = path.join(dataDirectory, "maintenance", "upgrades", "latest.json");
const activeUpgradeStates = new Set(["preparing", "checking", "ready", "waiting", "stopping", "switching", "starting"]);

await mkdir(dataDirectory, { recursive: true });

async function writeLog(event, details = {}) {
  await appendFile(logFile, `${JSON.stringify({ time: new Date().toISOString(), event, ...details })}\n`, "utf8");
}

async function acquireLock() {
  try {
    const handle = await open(lockFile, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
    return handle;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const lock = JSON.parse(await readFile(lockFile, "utf8"));
      if (await processInfo(Number(lock?.pid))) return undefined;
      await unlink(lockFile);
      const handle = await open(lockFile, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
      return handle;
    } catch (retryError) {
      if (retryError?.code === "EEXIST" || retryError?.code === "ENOENT") return undefined;
      throw retryError;
    }
  }
}

async function readUpgradeState() {
  try {
    const record = JSON.parse(await readFile(latestUpgradeFile, "utf8"));
    return typeof record?.state === "string" ? record.state : undefined;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function processInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const command = "$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "'; if($p){$p | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress}";
  try {
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 10000 });
    return JSON.parse(stdout.trim() || "null");
  } catch {
    return undefined;
  }
}

async function orphanProductionProcess() {
  try {
    const lease = JSON.parse(await readFile(path.join(dataDirectory, "production-runtime.json"), "utf8"));
    const info = await processInfo(Number(lease?.pid));
    if (!info || !/dist-server[\\/]index\.js/.test(String(info.CommandLine ?? "")) || !/(^|\s)--production(\s|$)/.test(String(info.CommandLine ?? ""))) return false;
    await writeLog("orphan_process_detected", { pid: info.ProcessId });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function probe(pathname) {
  const host = settings.probeHost.includes(":") ? `[${settings.probeHost}]` : settings.probeHost;
  try {
    const response = await fetch(`http://${host}:${settings.port}${pathname}`, { signal: AbortSignal.timeout(4000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function startBackend() {
  const output = await open(serverLogFile, "a");
  try {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const child = spawn(process.execPath, [path.join(projectRoot, "dist-server", "index.js"), "--production"], {
      cwd: projectRoot,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", output.fd, output.fd],
      env: { ...process.env, APP_DATA_DIR: dataDirectory, API_HOST: settings.probeHost, API_PORT: String(settings.port) },
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const pid = child.pid;
    child.unref();
    await writeLog("backend_started", { pid, port: settings.port });
    return pid;
  } finally {
    await output.close();
  }
}

async function main() {
  const lock = await acquireLock();
  if (!lock) return 0;
  try {
    const healthy = await probe("/api/health") && await probe("/api/ready");
    if (healthy) return 0;

    const listening = await portIsOpen(settings.port, settings.probeHost);
    if (listening) {
      await writeLog("backend_degraded", { port: settings.port, health: false });
      return 0;
    }

    const upgradeState = await readUpgradeState();
    if (upgradeState && activeUpgradeStates.has(upgradeState)) {
      await writeLog("upgrade_in_progress_skip", { state: upgradeState });
      return 0;
    }
    if (await orphanProductionProcess()) return 0;

    const pid = await startBackend();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (await probe("/api/health") && await probe("/api/ready")) {
        await writeLog("backend_ready", { pid, port: settings.port });
        return 0;
      }
    }
    await writeLog("backend_start_unconfirmed", { pid, port: settings.port });
    return 1;
  } catch (error) {
    await writeLog("watchdog_error", { error: String(error) });
    return 1;
  } finally {
    await lock.close().catch(() => undefined);
    await unlink(lockFile).catch(() => undefined);
  }
}

process.exitCode = await main();
