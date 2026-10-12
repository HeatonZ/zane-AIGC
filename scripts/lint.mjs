// oxlint 会跳过被父级 .gitignore 忽略目录下的文件（升级的隔离快照位于 .local/ 下），
// 目录参数在快照里会报 "No files found to lint"。显式枚举源文件可绕开该行为，
// 同时保持与 "oxlint src server" 相同的检查范围。
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
    return /\.(ts|tsx)$/.test(entry.name) ? [file] : [];
  }));
  return found.flat();
}
const files = (await Promise.all(["src", "server"].map((directory) => discover(path.join(root, directory))))).flat().sort();
if (!files.length) throw new Error("No source files found to lint");
const bin = path.join(root, "node_modules", "oxlint", "bin", "oxlint");
let failed = false;
// 分批以避免超出 Windows 命令行长度上限。
for (let index = 0; index < files.length; index += 100) {
  const chunk = files.slice(index, index + 100);
  const result = spawnSync(process.execPath, [bin, ...chunk], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) failed = true;
}
if (failed) {
  console.error("lint 未通过；修复后重跑 npm run lint");
  process.exitCode = 1;
}
