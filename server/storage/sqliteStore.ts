import { mkdirSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { RunArtifactPaths, RunEvent, RunRecord, RunStatus, RunSubmitter } from "../domain/types.js";

export interface RunListQuery { ownerUserId?: string; limit?: number; before?: { createdAt: string; runId: string }; status?: RunStatus; sceneId?: string }
/** 列表页投影：不含 steps/outputs 明细，只有标量、计数与归档路径。 */
export interface RunSummaryRow {
  runId: string; sceneId: string; status: RunStatus; createdAt: string;
  ownerUserId?: string; submitter?: RunSubmitter; workflowName?: string; runTitle?: string;
  startedAt?: string; finishedAt?: string; durationMs?: number; error?: string;
  stepCount: number; outputCount: number; artifacts: RunArtifactPaths;
}
interface RunRow { snapshot_json: string; submission_json: string | null }
interface RunSummaryDbRow {
  run_id: string; scene_id: string; status: string; created_at: string;
  owner_user_id: string | null; submitter_json: string | null; workflow_name: string | null; run_title: string | null;
  started_at: string | null; finished_at: string | null; duration_ms: number | null; error: string | null;
  artifacts_json: string; step_count: number; output_count: number;
}

/** One local transactional metadata store; media and export artifacts stay on disk. */
export class SqliteStore {
  private readonly database: DatabaseSync;
  private readonly statements = new Map<string, import("node:sqlite").StatementSync>();
  /** node:sqlite 语句可复用；高频路径避免每次请求重新 prepare。动态拼装的 SQL 仍直连。 */
  private stmt(sql: string): import("node:sqlite").StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.database.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  constructor(public readonly filename: string) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const version = Number((this.stmt("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version > 2) { this.database.close(); throw new Error(`数据库版本 ${version} 高于当前应用支持的版本 2`); }
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
    if (version < 2) this.transaction(() => this.database.exec(`CREATE TABLE production_documents (project_directory TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_directory, collection, id)); CREATE INDEX production_recent ON production_documents(project_directory, collection, updated_at DESC); PRAGMA user_version = 2;`));
    this.database.exec("CREATE INDEX IF NOT EXISTS access_credentials_hash ON production_documents(project_directory, json_extract(snapshot_json, '$.hash')) WHERE collection='credentials'; CREATE INDEX IF NOT EXISTS runs_owner_recent ON runs(project_directory, json_extract(snapshot_json, '$.ownerUserId'), created_at DESC, run_id DESC);");
  }

  findCredentialByHash<T>(project: string, digest: string): T | undefined {
    const row = this.stmt("SELECT snapshot_json FROM production_documents WHERE project_directory=? AND collection='credentials' AND json_extract(snapshot_json, '$.hash')=?").get(project,digest) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) as T : undefined;
  }

  /** Maintenance only: include waiting reviews, not just the in-memory worker queue. */
  unfinishedRunCounts(): Record<string, number> {
    const rows = this.stmt("SELECT status, COUNT(*) AS count FROM runs WHERE status IN ('queued','running','cancelling','waiting') GROUP BY status").all() as Array<{status: string; count: number}>;
    return Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
  }
  async backupTo(filename: string): Promise<void> { await backup(this.database, filename); }

  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  getWorkspace(): (Record<string, unknown> & { revision: number }) | undefined {
    const row = this.stmt("SELECT revision, snapshot_json FROM workspace WHERE id = 1").get() as { revision: number; snapshot_json: string } | undefined;
    return row ? { ...JSON.parse(row.snapshot_json), revision: row.revision } : undefined;
  }

  saveWorkspace(snapshot: Record<string, unknown>): Record<string, unknown> & { revision: number } {
    const previous = this.getWorkspace();
    const revision = (previous?.revision ?? 0) + 1;
    this.stmt("INSERT INTO workspace VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, snapshot_json=excluded.snapshot_json, updated_at=excluded.updated_at")
      .run(revision, JSON.stringify(snapshot), new Date().toISOString());
    return { ...snapshot, revision };
  }

  getRun(projectDirectory: string, runId: string): RunRecord | undefined {
    const row = this.stmt("SELECT snapshot_json FROM runs WHERE project_directory = ? AND run_id = ?").get(projectDirectory, runId) as unknown as RunRow | undefined;
    return row ? JSON.parse(row.snapshot_json) as RunRecord : undefined;
  }

  createRun(projectDirectory: string, run: RunRecord, submission: unknown): RunEvent[] {
    return this.transaction(() => {
      this.stmt("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(projectDirectory, run.runId, run.status, run.sceneId, run.createdAt, JSON.stringify(run), JSON.stringify(submission), new Date().toISOString());
      return this.saveRunInTransaction(projectDirectory, run, [{ type: "run.queued" }]);
    });
  }

  importRun(projectDirectory: string, run: RunRecord) {
    this.transaction(() => {
      this.stmt("INSERT OR IGNORE INTO runs VALUES (?, ?, ?, ?, ?, ?, NULL, ?)")
        .run(projectDirectory, run.runId, run.status, run.sceneId, run.createdAt, JSON.stringify(run), new Date().toISOString());
    });
  }

  saveRun(projectDirectory: string, run: RunRecord, events: Array<{ type: string; stepId?: string; payload?: Record<string, unknown> }>, options?: { changedStepIds?: ReadonlySet<string> }): RunEvent[] {
    return this.transaction(() => this.saveRunInTransaction(projectDirectory, run, events, options?.changedStepIds));
  }

  private saveRunInTransaction(projectDirectory: string, run: RunRecord, events: Array<{ type: string; stepId?: string; payload?: Record<string, unknown> }>, changedStepIds?: ReadonlySet<string>): RunEvent[] {
    const now = new Date().toISOString();
    const updated = this.stmt("UPDATE runs SET status=?, snapshot_json=?, updated_at=? WHERE project_directory=? AND run_id=?")
      .run(run.status, JSON.stringify(run), now, projectDirectory, run.runId);
    if (!updated.changes) throw new Error(`运行 ${run.runId} 不存在`);
    const putStep = this.stmt("INSERT INTO run_steps VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_directory, run_id, step_id) DO UPDATE SET step_index=excluded.step_index, status=excluded.status, snapshot_json=excluded.snapshot_json");
    run.steps.forEach((step, index) => {
      // Incremental checkpoints rewrite only steps the caller knows changed; other rows
      // keep their last persisted state. Callers without a hint rewrite every step.
      if (changedStepIds && !changedStepIds.has(step.stepId)) return;
      putStep.run(projectDirectory, run.runId, step.stepId, index, step.status, JSON.stringify(step));
    });
    let sequence = this.latestSequence(projectDirectory, run.runId);
    const append = this.stmt("INSERT INTO run_events VALUES (?, ?, ?, ?, ?, ?)");
    return events.map((event) => {
      const stored: RunEvent = { runId: run.runId, sequence: ++sequence, at: now, ...event };
      append.run(projectDirectory, run.runId, stored.sequence, stored.type, now, JSON.stringify(stored));
      return stored;
    });
  }

  latestSequence(projectDirectory: string, runId: string): number {
    return Number((this.stmt("SELECT COALESCE(MAX(sequence), 0) seq FROM run_events WHERE project_directory=? AND run_id=?").get(projectDirectory, runId) as { seq: number }).seq);
  }

  firstEventAt(projectDirectory: string, runId: string, type: string): string | undefined {
    return (this.stmt("SELECT created_at FROM run_events WHERE project_directory=? AND run_id=? AND type=? ORDER BY sequence LIMIT 1")
      .get(projectDirectory, runId, type) as { created_at: string } | undefined)?.created_at;
  }

  events(projectDirectory: string, runId: string, after = 0, limit = 1000, types?: readonly string[]): RunEvent[] {
    if (types && !types.length) return [];
    const filter = types ? " AND type IN (" + types.map(() => "?").join(",") + ")" : "";
    const rows = this.database.prepare("SELECT payload_json FROM run_events WHERE project_directory=? AND run_id=? AND sequence>?" + filter + " ORDER BY sequence LIMIT ?")
      .all(projectDirectory, runId, after, ...(types ?? []), limit) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as RunEvent);
  }

  listRuns(projectDirectory: string, query: RunListQuery = {}): { runs: RunRecord[]; nextCursor?: { createdAt: string; runId: string } } {
    const params: Array<string | number> = [projectDirectory];
    let where = "project_directory=?";
    if (query.ownerUserId) { where += " AND json_extract(snapshot_json, '$.ownerUserId')=?"; params.push(query.ownerUserId); }
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

  /** 摘要列表：只抽取列表页需要的标量与计数，避免解析整份运行快照（大运行单份可达数百 KB）。 */
  listRunSummaries(projectDirectory: string, query: RunListQuery = {}): { runs: RunSummaryRow[]; nextCursor?: { createdAt: string; runId: string } } {
    const params: Array<string | number> = [projectDirectory];
    let where = "project_directory=?";
    if (query.ownerUserId) { where += " AND json_extract(snapshot_json, '$.ownerUserId')=?"; params.push(query.ownerUserId); }
    if (query.status) { where += " AND status=?"; params.push(query.status); }
    if (query.sceneId) { where += " AND scene_id=?"; params.push(query.sceneId); }
    if (query.before) { where += " AND (created_at < ? OR (created_at = ? AND run_id < ?))"; params.push(query.before.createdAt, query.before.createdAt, query.before.runId); }
    const limit = Math.max(1, Math.min(200, query.limit ?? 50));
    params.push(limit + 1);
    const rows = this.database.prepare(`SELECT run_id, scene_id, status, created_at,
        json_extract(snapshot_json,'$.ownerUserId') AS owner_user_id,
        json_extract(snapshot_json,'$.submitter') AS submitter_json,
        json_extract(snapshot_json,'$.workflowName') AS workflow_name,
        json_extract(snapshot_json,'$.runTitle') AS run_title,
        json_extract(snapshot_json,'$.startedAt') AS started_at,
        json_extract(snapshot_json,'$.finishedAt') AS finished_at,
        json_extract(snapshot_json,'$.durationMs') AS duration_ms,
        json_extract(snapshot_json,'$.error') AS error,
        json_extract(snapshot_json,'$.artifacts') AS artifacts_json,
        COALESCE(json_array_length(snapshot_json,'$.steps'),0) AS step_count,
        COALESCE(json_array_length(snapshot_json,'$.outputs'),0) AS output_count
      FROM runs WHERE ${where} ORDER BY created_at DESC, run_id DESC LIMIT ?`).all(...params) as unknown as RunSummaryDbRow[];
    const more = rows.length > limit;
    const text = (value: string | null | undefined) => value === null || value === undefined ? undefined : value;
    const runs = rows.slice(0, limit).map((row): RunSummaryRow => ({
      runId: row.run_id, sceneId: row.scene_id, status: row.status as RunStatus, createdAt: row.created_at,
      ...(text(row.owner_user_id) !== undefined ? { ownerUserId: text(row.owner_user_id)! } : {}),
      ...(text(row.submitter_json) !== undefined ? { submitter: JSON.parse(text(row.submitter_json)!) as RunSubmitter } : {}),
      ...(text(row.workflow_name) !== undefined ? { workflowName: text(row.workflow_name)! } : {}),
      ...(text(row.run_title) !== undefined ? { runTitle: text(row.run_title)! } : {}),
      ...(text(row.started_at) !== undefined ? { startedAt: text(row.started_at)! } : {}),
      ...(text(row.finished_at) !== undefined ? { finishedAt: text(row.finished_at)! } : {}),
      ...(row.duration_ms !== null && row.duration_ms !== undefined ? { durationMs: Number(row.duration_ms) } : {}),
      ...(text(row.error) !== undefined ? { error: text(row.error)! } : {}),
      stepCount: Number(row.step_count), outputCount: Number(row.output_count),
      artifacts: JSON.parse(row.artifacts_json) as RunArtifactPaths,
    }));
    const last = runs.at(-1);
    return { runs, ...(more && last ? { nextCursor: { createdAt: last.createdAt, runId: last.runId } } : {}) };
  }

  unfinishedRuns(): Array<{ projectDirectory: string; run: RunRecord; submission: unknown }> {
    const rows = this.stmt("SELECT project_directory, snapshot_json, submission_json FROM runs WHERE status IN ('queued', 'running', 'cancelling') ORDER BY created_at ASC, run_id ASC").all() as unknown as Array<RunRow & { project_directory: string }>;
    return rows.map((row) => ({ projectDirectory: row.project_directory, run: JSON.parse(row.snapshot_json), submission: row.submission_json ? JSON.parse(row.submission_json) : undefined }));
  }

  getSubmission(projectDirectory: string, runId: string): unknown {
    const row = this.stmt("SELECT submission_json FROM runs WHERE project_directory=? AND run_id=?").get(projectDirectory, runId) as { submission_json: string | null } | undefined;
    return row?.submission_json ? JSON.parse(row.submission_json) : undefined;
  }
  saveRunSubmission(projectDirectory: string, run: RunRecord, submission: unknown, events: Array<{ type: string; stepId?: string; payload?: Record<string, unknown> }>) {
    return this.transaction(() => {
      this.stmt("UPDATE runs SET submission_json=? WHERE project_directory=? AND run_id=?").run(JSON.stringify(submission), projectDirectory, run.runId);
      return this.saveRunInTransaction(projectDirectory, run, events);
    });
  }
  getDocument<T>(project: string, collection: string, id: string): T | undefined {
    const row = this.stmt("SELECT snapshot_json FROM production_documents WHERE project_directory=? AND collection=? AND id=?").get(project, collection, id) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) as T : undefined;
  }
  listDocuments<T>(project: string, collection: string): T[] {
    return (this.stmt("SELECT snapshot_json FROM production_documents WHERE project_directory=? AND collection=? ORDER BY updated_at DESC, id DESC").all(project, collection) as Array<{ snapshot_json: string }>).map(row => JSON.parse(row.snapshot_json) as T);
  }
  putDocument<T extends { id: string; revision: number }>(project: string, collection: string, value: T, expectedRevision: number): T {
    return this.putDocumentChecked(project, collection, value, expectedRevision);
  }
  putDocumentChecked<T extends { id: string; revision: number }>(project: string, collection: string, value: T, expectedRevision: number, check: () => void = () => {}): T {
    return this.transaction(() => {
      check();
      const current = this.getDocument<T>(project, collection, value.id);
      if ((current?.revision ?? 0) !== expectedRevision) throw new Error("DOCUMENT_CONFLICT");
      const saved = { ...value, revision: expectedRevision + 1 };
      this.stmt("INSERT INTO production_documents VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_directory, collection, id) DO UPDATE SET revision=excluded.revision, snapshot_json=excluded.snapshot_json, updated_at=excluded.updated_at").run(project, collection, value.id, saved.revision, JSON.stringify(saved), new Date().toISOString());
      return saved;
    });
  }

  hasImported(projectDirectory: string) { return Boolean(this.stmt("SELECT 1 FROM imports WHERE project_directory=?").get(projectDirectory)); }
  markImported(projectDirectory: string) { this.stmt("INSERT OR REPLACE INTO imports VALUES (?, ?)").run(projectDirectory, new Date().toISOString()); }
  diagnostics() { return this.stmt("PRAGMA quick_check").all(); }
  close() { this.database.close(); }
}
