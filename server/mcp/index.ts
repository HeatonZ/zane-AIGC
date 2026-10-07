import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpSupervisor } from "./supervisor.js";

// The entry/command is unchanged for existing clients. It now owns a replaceable
// HTTP adapter child, not a business worker or an independent task database.
const entry = fileURLToPath(import.meta.url);
const supervisor = new McpSupervisor({ workerEntry: path.join(path.dirname(entry), "worker" + path.extname(entry)), baseUrl: process.env.ZANE_BASE_URL ?? "http://127.0.0.1:8799" });
try { await supervisor.start(); }
catch (error) { console.error("[zane-mcp]", error instanceof Error ? error.message : String(error)); await supervisor.close(); process.exitCode = 1; }
process.once("SIGINT", () => { void supervisor.close(); });
process.once("SIGTERM", () => { void supervisor.close(); });
