import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function discover(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = await Promise.all(entries.map((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return discover(file);
    return entry.name.endsWith(".test.ts") ? [file] : [];
  }));
  return found.flat();
}
const tests = (await Promise.all(["server", "src"].map((directory) => discover(path.join(root, directory))))).flat().sort();
if (!tests.length) throw new Error("No tests found");
// Bound process fan-out: several integration tests launch an HTTP server plus
// stdio MCP/tsx children, whose startup budgets must not be consumed by CPU contention.
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=4", ...tests], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
