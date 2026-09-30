import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunEvent, RunRecord, RunStatus } from "../domain/types.js";

export interface RunListQuery { limit?: number; before?: { createdAt: string; runId: string }; status?: RunStatus; sceneId?: string }
interface RunRow { snapshot_json: string; submission_json: string | null }

/** One local transactional metadata store; media and export artifacts stay on disk. */
export class SqliteStore {
  private readonly database: DatabaseSync;
  constructor(public readonly filename: string) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const version = Number((this.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version > 1) { this.database.close(); throw new Error(`数据库版本 ${version} 高于当前应用支持的版本 1`); }
    if (version === 0) this.transaction(() => {
      this.database.exec(`
        CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE runs (
          project_directory TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL,
          scene_id TEXT NOT NULL, created_at TEXT NOT NULL, snapshot_json TEXT NOT NULL,
          submission_json TEXT, updated_at TEXT NOT NULL,
          PRIMARY KEY(project_directory, run_id)
        );
        CREATE INDEX runs_recent ON runs(project_directory, created_at DESC, run_id DESC);
        CREATE INDEX runs_status ON runs(project_directory, status, created_at DESC);
        CREATE INDEX runs_scene ON runs(project_directory, scene_id, created_at DESC);
        CREATE TABLE run_steps (
          project_directory TEXT NOT NULL, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
          step_index INTEGER NOT NULL, status TEXT NOT NULL, snapshot_json TEXT NOT NULL,
          PRIMARY KEY(project_directory, run_id, step_id),
          FOREIGN KEY(project_directory, run_id) REFERENCES runs(project_directory, run_id) ON DELETE CASCADE
        );
        CREATE TABLE run_events (
          project_directory TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
          type TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL,
          PRIMARY KEY(project_directory, run_id, sequence),
          FOREIGN KEY(project_directory, run_id) REFERENCES runs(project_directory, run_id) ON DELETE CASCADE
        );
        CREATE TABLE imports (project_directory TEXT PRIMARY KEY, completed_at TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
    });
  }

  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  getWorkspace(): (Record<string, unknown> & { revision: number }) | undefined {
    const row = this.database.prepare("SELECT revision, snapshot_json FROM workspace WHERE id = 1").get() as { revision: number; snapshot_json: string } | undefined;
    return row ? { ...JSON.parse(row.snapshot_json), revision: row.revision } : undefined;
  }

  saveWorkspace(snapshot: Record<string, unknown>): Record<string, unknown> & { revision: number } {
    const previous = this.getWorkspace();
    const revision = (previous?.revision ?? 0) + 1;
    this.database.prepare("INSERT INTO workspace VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, snapshot_json=excluded.snapshot_json, updated_at=excluded.updated_at")
      .run(revision, JSON.stringify(snapshot), new Date().toISOString());
    return { ...snapshot, revision };
  }

  getRun(projectDirectory: string, runId: string): RunRecord | undefined {
    const row = this.database.prepare("SELECT snapshot_json FROM runs WHERE project_directory = ? AND run_id = ?").get(projectDirectory, runId) as unknown as RunRow | undefined;
    return row ? JSON.parse(row.snapshot_json) as RunRecord : undefined;
  }

  createRun(projectDirectory: string, run: RunRecord, submission: unknown): RunEvent[] {
    return this.transaction(() => {
      this.database.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(projectDirectory, run.runId, run.status, run.sceneId, run.createdAt, JSON.stringify(run), JSON.stringify(submission), new Date().toISOString());
      return this.saveRunInTransaction(projectDirectory, run, [{ type: "run.queued" }]);
    });
  }

  importRun(projectDirectory: string, run: RunRecord) {
    this.transaction(() => {
      this.database.prepare("INSERT OR IGNORE INTO runs VALUES (?, ?, ?, ?, ?, ?, NULL, ?)")
        .run(projectDirectory, run.runId, run.status, run.sceneId, run.createdAt, JSON.stringify(run), new Date().toISOString());
    });
  }

  saveRun(projectDirectory: string, run: RunRecord, events: Array<{ type: string; stepId?: string; payload?: Record<string, unknown> }>): RunEvent[] {
    return this.transaction(() => this.saveRunInTransaction(projectDirectory, run, events));
  }

  private saveRunInTransaction(projectDirectory: string, run: RunRecord, events: Array<{ type: string; stepId?: string; payload?: Record<string, unknown> }>): RunEvent[] {
    const now = new Date().toISOString();
    const updated = this.database.prepare("UPDATE runs SET status=?, snapshot_json=?, updated_at=? WHERE project_directory=? AND run_id=?")
      .run(run.status, JSON.stringify(run), now, projectDirectory, run.runId);
    if (!updated.changes) throw new Error(`运行 ${run.runId} 不存在`);
    const putStep = this.database.prepare("INSERT INTO run_steps VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_directory, run_id, step_id) DO UPDATE SET step_index=excluded.step_index, status=excluded.status, snapshot_json=excluded.snapshot_json");
    run.steps.forEach((step, index) => putStep.run(projectDirectory, run.runId, step.stepId, index, step.status, JSON.stringify(step)));
    let sequence = this.latestSequence(projectDirectory, run.runId);
    const append = this.database.prepare("INSERT INTO run_events VALUES (?, ?, ?, ?, ?, ?)");
    return events.map((event) => {
      const stored: RunEvent = { runId: run.runId, sequence: ++sequence, at: now, ...event };
      append.run(projectDirectory, run.runId, stored.sequence, stored.type, now, JSON.stringify(stored));
      return stored;
    });
  }

  latestSequence(projectDirectory: string, runId: string): number {
    return Number((this.database.prepare("SELECT COALESCE(MAX(sequence), 0) seq FROM run_events WHERE project_directory=? AND run_id=?").get(projectDirectory, runId) as { seq: number }).seq);
  }

  events(projectDirectory: string, runId: string, after = 0, limit = 1000): RunEvent[] {
    const rows = this.database.prepare("SELECT payload_json FROM run_events WHERE project_directory=? AND run_id=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(projectDirectory, runId, after, limit) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as RunEvent);
  }

  listRuns(projectDirectory: string, query: RunListQuery = {}): { runs: RunRecord[]; nextCursor?: { createdAt: string; runId: string } } {
    const params: Array<string | number> = [projectDirectory];
    let where = "project_directory=?";
    if (query.status) { where += " AND status=?"; params.push(query.status); }
    if (query.sceneId) { where += " AND scene_id=?"; params.push(query.sceneId); }
    if (query.before) { where += " AND (created_at < ? OR (created_at = ? AND run_id < ?))"; params.push(query.before.createdAt, query.before.createdAt, query.before.runId); }
    const limit = Math.max(1, Math.min(200, query.limit ?? 50));
    params.push(limit + 1);
    const rows = this.database.prepare(`SELECT snapshot_json FROM runs WHERE ${where} ORDER BY created_at DESC, run_id DESC LIMIT ?`).all(...params) as unknown as RunRow[];
    const more = rows.length > limit;
    const runs = rows.slice(0, limit).map((row) => JSON.parse(row.snapshot_json) as RunRecord);
    const last = runs.at(-1);
    return { runs, ...(more && last ? { nextCursor: { createdAt: last.createdAt, runId: last.runId } } : {}) };
  }

  unfinishedRuns(): Array<{ projectDirectory: string; run: RunRecord; submission: unknown }> {
    const rows = this.database.prepare("SELECT project_directory, snapshot_json, submission_json FROM runs WHERE status IN ('queued', 'running', 'cancelling') ORDER BY created_at ASC, run_id ASC").all() as unknown as Array<RunRow & { project_directory: string }>;
    return rows.map((row) => ({ projectDirectory: row.project_directory, run: JSON.parse(row.snapshot_json), submission: row.submission_json ? JSON.parse(row.submission_json) : undefined }));
  }

  hasImported(projectDirectory: string) { return Boolean(this.database.prepare("SELECT 1 FROM imports WHERE project_directory=?").get(projectDirectory)); }
  markImported(projectDirectory: string) { this.database.prepare("INSERT OR REPLACE INTO imports VALUES (?, ?)").run(projectDirectory, new Date().toISOString()); }
  diagnostics() { return this.database.prepare("PRAGMA quick_check").all(); }
  close() { this.database.close(); }
}
