import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createWorkbenchMcp } from "./server.js";
import { WorkbenchHttpClient } from "./httpClient.js";
import { AI_CONTRACT_VERSION } from "../ai/operations.js";

// Only the HTTP adapter: no API server, SQLite or worker execution is imported.
try {
  const client = new WorkbenchHttpClient(process.env.ZANE_BASE_URL ?? "http://127.0.0.1:8799", Number(process.env.ZANE_MCP_TIMEOUT_MS ?? 45000));
  let server: ReturnType<typeof createWorkbenchMcp> | undefined;
  const handle = serveStdio(() => { server = createWorkbenchMcp(client); return server; }, { onerror: error => console.error("[zane-mcp]", error.message) });
  process.on("message", message => {
    if ((message as { type?: string })?.type !== "zane-mcp-catalog-changed" || !server) return;
    server.sendToolListChanged(); server.sendResourceListChanged(); server.sendPromptListChanged();
  });
  const close = async () => { await handle.close(); if (process.connected) process.disconnect(); };
  process.stdin.once("end", () => { void close(); });
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  process.send?.({ type: "zane-mcp-ready", contractVersion: AI_CONTRACT_VERSION });
} catch (error) { console.error("[zane-mcp]", error instanceof Error ? error.message : String(error)); process.exitCode = 1; if (process.connected) process.disconnect(); }
