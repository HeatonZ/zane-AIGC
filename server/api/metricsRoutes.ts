import { Router } from "express";
import type { RunService } from "../services/runService.js";
import type { SqliteStore } from "../storage/sqliteStore.js";

export function createMetricsRouter(runService: RunService, store: SqliteStore) {
  const router = Router();
  // Mounted under /api/v1/maintenance/*: the access middleware already rejects
  // non-admins; the explicit call is defense in depth.
  router.get("/api/v1/maintenance/metrics", (req, res) => {
    res.locals.authorizeAdmin?.();
    const diagnostics = req.query.diagnostics === "1";
    res.set("Cache-Control", "no-store").json({
      time: new Date().toISOString(),
      process: { node: process.version, platform: process.platform, uptimeSec: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576), heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576) },
      runs: { ...runService.metrics(), unfinished: store.unfinishedRunCounts() },
      ...(diagnostics ? { database: { quickCheck: store.diagnostics() } } : {}),
      nextAction: "read_only",
    });
  });
  return router;
}
