// Focused test runner: run only the test files an edit actually touches.
//
// The full suite (npm test) stays the acceptance gate before claiming completion.
// This is the fast inner loop: one file runs in ~1s instead of ~55s, which is the
// difference between iterating and waiting.
//
// Usage:
//   npm run test:file -- server/ai/contract.test.ts   exact path
//   npm run test:file -- server/ai                     directory
//   npm run test:file -- contract                      substring match
//   npm run test:changed                               tests related to git changes
//
// Exit codes: 0 pass, 1 test failure, 2 bad selection (no match / ambiguous).
import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_PATTERN = /\.test\.(ts|mjs)$/;

async function discover(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(entries.map((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return discover(file);
    return TEST_PATTERN.test(entry.name) ? [file] : [];
  }));
  return found.flat();
}

const allTests = (await Promise.all(["server", "src", "scripts"].map((directory) => discover(path.join(root, directory))))).flat().sort();
if (!allTests.length) throw new Error("No tests found");
const toRelative = (file) => path.relative(root, file).split(path.sep).join("/");

const args = process.argv.slice(2);
const changedMode = args.includes("--changed");
const patterns = args.filter((arg) => !arg.startsWith("--"));

/** Test files related to the current working tree changes. */
async function changedTests() {
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  if (status.error) throw status.error;
  if (status.status !== 0) throw new Error("git status failed: " + (status.stderr || "").trim());
  const changed = status.stdout.split(/\r?\n/).filter(Boolean)
    .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""))
    .filter((file) => file && !file.startsWith(".."));

  const selected = new Set();
  // 1. A changed test file is always relevant.
  for (const file of changed) if (TEST_PATTERN.test(file)) selected.add(path.resolve(root, file));

  // 2. A changed source file makes every test that imports it relevant. Match on
  //    the module basename because sources use ESM ".js" specifiers that resolve
  //    to ".ts" under tsx.
  const sources = changed.filter((file) => /\.(ts|tsx)$/.test(file) && !TEST_PATTERN.test(file));
  if (sources.length) {
    const needles = sources.map((file) => path.basename(file).replace(/\.(ts|tsx)$/, ""));
    const contents = await Promise.all(allTests.map(async (file) => [file, await readFile(file, "utf8").catch(() => "")]));
    for (const [file, text] of contents) {
      if (needles.some((needle) => new RegExp(`[/"']${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(js|ts|tsx)["']`).test(text))) selected.add(file);
    }
  }
  return { selected: [...selected].sort(), changedCount: changed.length, sourceCount: sources.length };
}

let selected;
if (changedMode) {
  const result = await changedTests();
  selected = result.selected;
  console.log(`Selected ${selected.length} test file(s) related to ${result.changedCount} changed path(s), ${result.sourceCount} source file(s).`);
  console.log("This is a focused subset, not a substitute for the full `npm test` acceptance run.");
} else if (!patterns.length) {
  console.error("Usage: npm run test:file -- <path|dir|substring> [...more]\n       npm run test:changed");
  console.error(`\n${allTests.length} test files available, for example:\n` + allTests.slice(0, 8).map((file) => "  " + toRelative(file)).join("\n"));
  process.exit(2);
} else {
  const matched = new Set();
  for (const pattern of patterns) {
    const normalized = pattern.split("\\").join("/").replace(/^\.\//, "");
    const absolute = path.resolve(root, normalized);
    const exact = allTests.filter((file) => file === absolute);
    const under = allTests.filter((file) => toRelative(file).startsWith(normalized.replace(/\/$/, "") + "/"));
    const contains = allTests.filter((file) => toRelative(file).includes(normalized));
    const hits = exact.length ? exact : under.length ? under : contains;
    if (!hits.length) console.error(`No test matches: ${pattern}`);
    for (const hit of hits) matched.add(hit);
  }
  selected = [...matched].sort();
  if (!selected.length) {
    console.error("\nNothing to run. Available tests (first 20):\n" + allTests.slice(0, 20).map((file) => "  " + toRelative(file)).join("\n"));
    process.exit(2);
  }
}

if (!selected.length) {
  console.log("No related tests found; nothing to run.");
  process.exit(0);
}

console.log(`Running ${selected.length} test file(s):\n` + selected.map((file) => "  " + toRelative(file)).join("\n") + "\n");
// Same bounded concurrency as the full runner: several tests launch an HTTP
// server plus stdio MCP/tsx children whose startup budget must not be consumed
// by CPU contention.
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=4", ...selected], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
