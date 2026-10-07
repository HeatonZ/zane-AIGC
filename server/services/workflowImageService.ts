import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { asRecord } from "../domain/workflowValues.js";
import type { StepExecutionContext } from "../execution/workflowExecutor.js";
import { readH3ReferenceImage } from "../h3ReferenceImage.js";
import { isRunId, runArtifactPaths } from "../artifacts/runArtifacts.js";

/** Share the existing bounded reader and authoritative archived-media locator. */
export async function readWorkflowImage(value: unknown, context: StepExecutionContext) {
  const url = typeof value === "string" ? value : asRecord(value)?.url;
  const local = typeof url === "string" ? /^\/api\/(?:workflows|v1)\/runs\/([^/]+)\/media\/([A-Za-z0-9_-][A-Za-z0-9._-]*)$/.exec(url) : null;
  if (local) {
    if (!isRunId(local[1]) || local[2].includes("..")) throw new Error("图片归档路径无效");
    const filename = path.join(runArtifactPaths(context.settings.projectDirectory, local[1]).directory, "outputs", "media", local[2]);
    const info = await stat(filename);
    if (!info.isFile() || info.size === 0 || info.size > 32 * 1024 * 1024) throw new Error("排版源图片必须非空且不超过32 MiB");
    return readFile(filename, { signal: context.signal });
  }
  try { return (await readH3ReferenceImage(value, context.settings.comfyuiBaseUrl, context.signal)).bytes; }
  catch (error) { throw new Error((error instanceof Error ? error.message : String(error)).replaceAll("H3", "图片读取")); }
}
