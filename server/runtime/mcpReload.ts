import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export function canonicalOrigin(base: string): string {
  const url = new URL(base);
  if (["localhost", "0.0.0.0"].includes(url.hostname)) url.hostname = "127.0.0.1";
  return url.origin;
}
export function localBackendUrl(host: string, port: number): string {
  const target = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return "http://" + (target.includes(":") && !target.startsWith("[") ? "[" + target + "]" : target) + ":" + port;
}
export function mcpReloadFile(base: string): string {
  return process.env.ZANE_MCP_RELOAD_FILE
    ? path.resolve(process.env.ZANE_MCP_RELOAD_FILE)
    : path.join(repositoryRoot, ".local", "mcp-runtime", createHash("sha256").update(canonicalOrigin(base)).digest("hex").slice(0, 24) + ".json");
}
export interface McpGeneration { schemaVersion: 1; generation: string; baseUrl: string; contractVersion: string; pid: number; startedAt: string }
type AtomicJsonIO = { replace?: typeof rename; pause?: (milliseconds: number) => Promise<unknown>; platform?: NodeJS.Platform };
export async function atomicJson(filename: string, value: unknown, io: AtomicJsonIO = {}): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = filename + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  const replace = io.replace ?? rename, pause = io.pause ?? sleep;
  try {
    // Windows readers can briefly hold a destination open. Keep the old file intact,
    // retry only the same atomic replacement, and never unlink the destination.
    for (let attempt = 0; ; attempt++) {
      try { await replace(temporary, filename); break; }
      catch (error) {
        const transient = (io.platform ?? process.platform) === "win32" && ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "");
        if (!transient || attempt >= 9) throw error;
        await pause(Math.min(25 * 2 ** attempt, 200));
      }
    }
  } finally { await unlink(temporary).catch(() => {}); }

}
export async function readMcpGeneration(filename: string, baseUrl: string): Promise<McpGeneration | undefined> {
  try {
    const value = JSON.parse(await readFile(filename, "utf8"));
    if (value?.schemaVersion !== 1 || typeof value.generation !== "string" || !/^[0-9a-f-]{36}$/i.test(value.generation)
      || typeof value.contractVersion !== "string" || canonicalOrigin(value.baseUrl) !== canonicalOrigin(baseUrl)) return undefined;
    return value as McpGeneration;
  } catch { return undefined; } // Atomic replacement/missing/invalid markers never stop the active MCP.
}
export async function publishMcpGeneration(baseUrl: string, contractVersion: string): Promise<McpGeneration> {
  const value: McpGeneration = { schemaVersion: 1, generation: randomUUID(), baseUrl: canonicalOrigin(baseUrl), contractVersion, pid: process.pid, startedAt: new Date().toISOString() };
  await atomicJson(mcpReloadFile(baseUrl), value);
  return value;
}
