// Runs the isolated smoke suites in parallel child processes instead of the
// former strictly serial chain. Each smoke already satisfies the workspace
// convention (temporary port, temporary project, temporary data) and runs in
// its own process, so implicit globals such as smoke-auth's fetch monkeypatch
// stay safe. Bound the fan-out the same way run-tests does: several smokes
// spawn a server plus stdio MCP/tsx children whose startup budget must not be
// consumed by CPU contention.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logDir = path.join(root, ".local", "smoke-logs");

const SMOKES = [
  { name: "server", file: "scripts/smoke-server.mjs", npm: "test:smoke" },
  { name: "hermes-output", file: "scripts/smoke-hermes-output.mjs", npm: "test:hermes-output:smoke" },
  { name: "hermes-feedback", file: "scripts/smoke-hermes-feedback.mjs", npm: "test:feedback:smoke" },
  { name: "commerce-pack", file: "scripts/smoke-commerce-pack.mjs", npm: "test:commerce:smoke" },
  { name: "ai", file: "scripts/smoke-ai.mjs", npm: "test:ai:smoke" },
  { name: "basic-capabilities", file: "scripts/smoke-basic-capabilities.mjs", npm: "test:basic:smoke" },
  { name: "dual-video", file: "scripts/smoke-video-dual-sampling.mjs", npm: "test:dual-video:smoke", tsx: true },
  { name: "access", file: "scripts/smoke-access.mjs", npm: "test:access:smoke" },
  { name: "mcp-restart", file: "scripts/smoke-mcp-restart.mjs", npm: "test:mcp:restart:smoke" },
  { name: "asset-execution", file: "scripts/smoke-asset-execution.mjs", npm: "test:asset:execution:smoke" },
  { name: "long-text-video", file: "scripts/smoke-long-text-video.mjs", npm: "test:long-video:smoke" },
  { name: "director-console", file: "scripts/smoke-long-text-director-console.mjs", npm: "test:director-console:smoke", tsx: true },
  { name: "context-video", file: "scripts/smoke-single-context-video.mjs", npm: "test:context-video:smoke" },
  { name: "production-upgrade", file: "scripts/smoke-production-upgrade.mjs", npm: "test:upgrade:smoke", tsx: true },
  { name: "commerce-ai", file: "scripts/smoke-commerce-ai.mjs", npm: "test:commerce-ai:smoke" },
  { name: "public-user", file: "scripts/smoke-public-user.mjs", npm: "test:public:smoke" },
];

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const concurrencyArg = args.find((arg) => arg.startsWith("--concurrency="));
const concurrency = Math.max(1, Number(concurrencyArg?.split("=")[1] ?? process.env.SMOKE_CONCURRENCY ?? 3));
const timeoutMs = Math.max(60_000, Number(process.env.SMOKE_TIMEOUT_MS ?? 15 * 60_000));
const filters = args.filter((arg) => !arg.startsWith("--"));
const selected = filters.length ? SMOKES.filter((smoke) => filters.some((filter) => smoke.name === filter || smoke.npm === filter)) : SMOKES;

if (listOnly) {
  for (const smoke of selected) console.log(`${smoke.name}\t${smoke.npm}`);
  process.exit(0);
}
if (!selected.length) {
  console.error(`No smoke matches: ${filters.join(", ")}`);
  process.exit(1);
}

await mkdir(logDir, { recursive: true });
const failures = [];
let index = 0;

async function runSmoke(smoke) {
  const started = Date.now();
  const args = [...(smoke.tsx ? ["--import", "tsx"] : []), smoke.file];
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const collect = (chunk) => {
    output += chunk;
    // Keep a bounded tail: verbose smokes can emit megabytes, but failures are
    // diagnosed from the end of the log.
    if (output.length > 2_000_000) output = output.slice(-1_000_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const [code] = await new Promise((resolve) => {
    child.on("close", (code) => resolve([code]));
  });
  clearTimeout(timer);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const logFile = path.join(logDir, `${smoke.name}.log`);
  await writeFile(logFile, output).catch(() => {});
  if (code === 0 && !timedOut) {
    console.log(`[ok]   ${smoke.name} (${seconds}s)`);
    return;
  }
  failures.push(smoke.name);
  const reason = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exit code ${code}`;
  console.log(`[FAIL] ${smoke.name} (${seconds}s, ${reason}) — log: ${logFile}`);
  const tail = output.split(/\r?\n/).filter(Boolean).slice(-40).join("\n");
  if (tail) console.log(`--- ${smoke.name} tail ---\n${tail}\n--- end ${smoke.name} tail ---`);
}

async function worker() {
  while (index < selected.length) {
    const smoke = selected[index++];
    await runSmoke(smoke);
  }
}

console.log(`Running ${selected.length} smoke suites with concurrency ${concurrency}...`);
await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));
if (failures.length) {
  console.error(`\n${failures.length} smoke suite(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\nAll ${selected.length} smoke suites passed.`);
