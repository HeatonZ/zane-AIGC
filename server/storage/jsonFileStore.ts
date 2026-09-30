import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { asRecord } from "../domain/workflowValues.js";

const pendingWrites = new Map<string, Promise<void>>();

/** Atomic file replacement; per-path FIFO also avoids simultaneous Windows renames. */
export async function writeJsonFile(filename: string, value: unknown) {
  const resolved = path.resolve(filename);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => replaceFile(resolved, contents));
  pendingWrites.set(key, operation);
  try { await operation; }
  finally { if (pendingWrites.get(key) === operation) pendingWrites.delete(key); }
}

async function replaceFile(filename: string, contents: string) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx");
    try { await file.writeFile(contents, "utf8"); await file.sync(); }
    finally { await file.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, filename); break; }
      catch (error) {
        const transient = ["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");
        if (process.platform !== "win32" || !transient || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

export async function readJsonFile(filename: string) {
  try { return asRecord(JSON.parse(await readFile(filename, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`无法读取 JSON 文件 ${filename}`, { cause: error });
  }
}
