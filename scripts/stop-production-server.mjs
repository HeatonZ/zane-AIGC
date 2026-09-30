import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvFile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function productionPort() {
  const values = {};
  for (const filename of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    try { Object.assign(values, parseEnvFile(requireText(path.join(root, filename)))); } catch { /* optional */ }
  }
  const configured = process.env.API_PORT ?? values.API_PORT;
  const port = Number(configured ?? 8799);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 8799;
}

function requireText(filename) {
  return readFileSync(filename, "utf8");
}

async function windowsPids(port) {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$ids = Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -ExpandProperty OwningProcess -Unique`,
    "foreach ($id in $ids) {",
    "  $process = Get-CimInstance Win32_Process -Filter \"ProcessId=$id\"",
    "  if ($process -and $process.Name -eq 'node.exe' -and $process.CommandLine -match 'dist-server[\\\\/]index\\.js' -and $process.CommandLine -match '(^|\\s)--production(\\s|$)') {",
    "    Write-Output $id",
    "  }",
    "}",
    "exit 0",
  ].join("\n");
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, cwd: root, maxBuffer: 1024 * 1024 });
    return [...new Set(stdout.split(/\r?\n/).map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0))];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function unixPids(port) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { cwd: root, maxBuffer: 1024 * 1024 });
    const candidates = [...new Set(stdout.split(/\r?\n/).map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0))];
    const matches = [];
    for (const pid of candidates) {
      try {
        const { stdout: command } = await execFileAsync("ps", ["-p", String(pid), "-o", "args="], { cwd: root });
        if (/dist-server[\\/]index\.js/.test(command) && /(^|\s)--production(\s|$)/.test(command)) matches.push(pid);
      } catch { /* process exited between lsof and ps */ }
    }
    return matches;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.status === 1) return [];
    throw error;
  }
}

async function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

async function stopPid(pid) {
  try {
    if (os.platform() === "win32") {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, cwd: root });
    } else {
      process.kill(pid, "SIGTERM");
    }
    return true;
  } catch (error) {
    if (error?.code === "ESRCH" || error?.code === "ENOENT" || error?.status === 128) return false;
    throw error;
  }
}

const port = productionPort();
const pids = os.platform() === "win32" ? await windowsPids(port) : await unixPids(port);
if (!pids.length) {
  console.log(`没有发现占用生产端口 ${port} 的旧 Zane 服务。`);
  process.exit(0);
}
for (const pid of pids) {
  console.log(`正在停止旧的 Zane 生产服务（PID ${pid}，端口 ${port}）…`);
  await stopPid(pid);
}
const deadline = Date.now() + 5000;
while (Date.now() < deadline && await portIsOpen(port)) await new Promise((resolve) => setTimeout(resolve, 100));
if (await portIsOpen(port)) {
  console.error(`旧 Zane 服务未能在 5 秒内释放端口 ${port}。`);
  process.exit(1);
}
console.log(`旧 Zane 服务已停止，端口 ${port} 已释放。`);
