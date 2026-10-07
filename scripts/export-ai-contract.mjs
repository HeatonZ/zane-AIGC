import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAiOpenApi } from "../server/ai/openapi.ts";
import { aiOperations } from "../server/ai/operations.ts";
import { AI_FOUNDATION_GUIDE } from "../server/ai/foundationGuide.ts";
import { AI_OPERATOR_GUIDE } from "../server/ai/guide.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = new Map([
  ["docs/ai-foundation.md", AI_FOUNDATION_GUIDE],
  ["docs/ai-openapi.json", JSON.stringify(createAiOpenApi(), null, 2) + "\n"],
  ["docs/ai-operator.md", AI_OPERATOR_GUIDE],
  ["docs/ai-tools.md", "# AI 工具目录\n\n由 npm run docs:ai 生成；不要直接编辑。参数细节见 ai-openapi.json，流程/恢复见 ai-operator.md。\n\n" + aiOperations.map(operation => "## " + operation.name + "\n\n" + operation.method + " " + operation.path + "\n\n副作用：" + operation.effect + "\n\n" + operation.description + "\n").join("\n")],
]);
let drift = false;
for (const [name, contents] of files) {
  const file = path.join(root, name);
  if (process.argv.includes("--check")) {
    if ((await readFile(file, "utf8").catch(() => "")).replace(/\r\n/g, "\n") !== contents) { console.error("AI contract drift: " + name + "; run npm run docs:ai"); drift = true; }
  } else { await writeFile(file, contents); console.log("Generated " + name); }
}
if (drift) process.exitCode = 1;
