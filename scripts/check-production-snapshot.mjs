/** Build and regress an immutable source snapshot without replacing live dist/ files. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const includes = ["src", "server", "scripts", "examples", "public", "docs", "AGENTS.md", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.server.json", "vite.config.ts", "index.html"];
const signature = async () => {
  const result = {};
  const visit = async (relative) => {
    const absolute = path.join(root, relative);
    try {
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries) if (entry.isDirectory() || entry.isFile()) await visit(path.join(relative, entry.name));
    } catch (error) {
      if (error.code !== "ENOTDIR") throw error;
      result[relative] = createHash("sha256").update(await readFile(absolute)).digest("hex");
    }
  };
  for (const entry of includes) await visit(entry);
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
};
let snapshot, captured;
for (let attempt = 0; attempt < 3; attempt++) {
  captured = await signature();
  // Express sendFile rejects dot-path ancestors; backups/ is ignored but not hidden.
  snapshot = path.join(root, "backups", "production-source-check-" + randomUUID());
  await mkdir(snapshot, { recursive: true });
  for (const entry of includes) await cp(path.join(root, entry), path.join(snapshot, entry), { recursive: true });
  if (JSON.stringify(captured) === JSON.stringify(await signature())) break;
  if (attempt === 2) throw new Error("Source kept changing during capture; retry after concurrent edits finish. No production files were changed.");
}
await symlink(path.join(root, "node_modules"), path.join(snapshot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
await writeFile(path.join(snapshot, "source-manifest.json"), JSON.stringify(captured, null, 2));
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), snapshot, liveBuildUntouched: true, externalGeneration: false, checks: [] };
async function run(name, args) {
  const log = path.join(snapshot, name + ".log");
  let output = "";
  const child = spawn(process.execPath, args, { cwd: snapshot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  await writeFile(log, output);
  report.checks.push({ name, code, status: code === 0 ? "passed" : "failed", log });
  console.log(`${name}: ${code === 0 ? "PASS" : "FAIL"} (${log})`);
  if (name === "unit-tests") console.log(output.split(/\r?\n/).filter((line) => /^ℹ (tests|pass|fail|skipped)|^✖/.test(line)).join("\n"));
  return code === 0;
}
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
await run("typecheck-web", [tsc, "-b", "--pretty", "false"]);
await run("typecheck-server", [tsc, "-p", "tsconfig.server.json", "--noEmit"]);
await run("unit-tests", ["scripts/run-tests.mjs"]);
await run("audit-helper-tests", ["--test", "scripts/audit-production.test.mjs"]);
const webBuilt = await run("build-web", [vite, "build"]);
const serverBuilt = await run("build-server", [tsc, "-p", "tsconfig.server.json"]);
if (webBuilt && serverBuilt) {
  for (const [name, script] of [["smoke-server", "smoke-server.mjs"], ["smoke-commerce", "smoke-commerce-pack.mjs"], ["smoke-long-video", "smoke-long-text-video.mjs"], ["smoke-commerce-ai", "smoke-commerce-ai.mjs"]]) await run(name, ["scripts/" + script]);
}
report.sourceChangedAfterCapture = JSON.stringify(captured) !== JSON.stringify(await signature());
report.finishedAt = new Date().toISOString();
report.status = report.checks.every((check) => check.status === "passed") ? "passed" : "failed";
await writeFile(path.join(snapshot, "check-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, snapshot, sourceChangedAfterCapture: report.sourceChangedAfterCapture, liveBuildUntouched: true }, null, 2));
assert.ok(snapshot.startsWith(path.join(root, "backups") + path.sep));
if (report.status !== "passed") process.exitCode = 1;
