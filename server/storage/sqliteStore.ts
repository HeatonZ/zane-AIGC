import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import type { RunArtifactPaths, RunEvent, RunRecord, RunStatus, RunSubmitter } from "../domain/types.js";
import type { CreditAccountRow, CreditEntry, CreditEntryKind, RedeemBatch, RedeemCode } from "../domain/creditContracts.js";
import { fromUnits, toUnits, formatPoints } from "../domain/creditUnits.js";

export interface RunListQuery { ownerUserId?: string; limit?: number; before?: { createdAt: string; runId: string }; status?: RunStatus; sceneId?: string; q?: string }
/** 搜索词按字面匹配：把 LIKE 通配符转义成普通字符，% 与 _ 不再被当成通配。 */
function runSearchPattern(q: string) {
  return "%" + q.replace(/[\\%_]/g, (char) => "\\" + char) + "%";
}
/** 关键字匹配运行标题、流程名、场景、运行编号、错误与提交人。 */
function runSearchClause(q: string, params: Array<string | number>) {
  const pattern = runSearchPattern(q);
  params.push(pattern, pattern, pattern, pattern, pattern, pattern);
  return " AND (COALESCE(json_extract(snapshot_json,'$.runTitle'),'') LIKE ? ESCAPE '\\'"
    + " OR COALESCE(json_extract(snapshot_json,'$.workflowName'),'') LIKE ? ESCAPE '\\'"
    + " OR scene_id LIKE ? ESCAPE '\\'"
    + " OR run_id LIKE ? ESCAPE '\\'"
    + " OR COALESCE(json_extract(snapshot_json,'$.error'),'') LIKE ? ESCAPE '\\'"
    + " OR COALESCE(json_extract(snapshot_json,'$.submitter.username'),'') || ' ' || COALESCE(json_extract(snapshot_json,'$.submitter.displayName'),'') LIKE ? ESCAPE '\\')";
}
/** 列表页投影：不含 steps/outputs 明细，只有标量、计数、血缘与归档路径。 */
export interface RunSummaryRow {
  runId: string; sceneId: string; status: RunStatus; createdAt: string;
  ownerUserId?: string; submitter?: RunSubmitter; workflowName?: string; runTitle?: string;
  startedAt?: string; finishedAt?: string; durationMs?: number; error?: string;
  stepCount: number; outputCount: number; artifacts: RunArtifactPaths;
  rerunFromRunId?: string; resumedFromRunId?: string;
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
  /** 运行快照解析缓存：键为 project+runId，命中要求 updated_at 与全局写入序号都未变。 */
  private readonly snapshotCache = new Map<string, { stamp: string; writes: number; run: RunRecord }>();
  /** 任一运行写入即自增；比时间戳更可靠地让缓存失效。 */
  private writes = 0;
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
    if (version > 3) { this.database.close(); throw new Error(`数据库版本 ${version} 高于当前应用支持的版本 3`); }
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
    // 金额一律以「厘」存储（1 分 = 100 厘）：0.05 分 = 5 厘，整数账本不丢精度。
    // 对外 API 与界面按分显示两位小数，换算只在边界发生。
    if (version < 3) this.transaction(() => this.database.exec(`
        CREATE TABLE IF NOT EXISTS credit_accounts (
          user_id TEXT PRIMARY KEY, balance INTEGER NOT NULL CHECK(balance >= 0),
          revision INTEGER NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS credit_entries (
          entry_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, delta INTEGER NOT NULL, balance_after INTEGER NOT NULL,
          kind TEXT NOT NULL, ref_type TEXT, ref_id TEXT, idempotency_key TEXT NOT NULL UNIQUE,
          actor_user_id TEXT, note TEXT, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS credit_entries_user ON credit_entries(user_id, created_at DESC, entry_id DESC);
        CREATE INDEX IF NOT EXISTS credit_entries_ref ON credit_entries(ref_type, ref_id);
        CREATE TABLE IF NOT EXISTS redeem_batches (
          batch_id TEXT PRIMARY KEY, name TEXT NOT NULL, face_value INTEGER NOT NULL, code_count INTEGER NOT NULL,
          expires_at TEXT, created_by TEXT, created_at TEXT NOT NULL, note TEXT
        );
        CREATE TABLE IF NOT EXISTS redeem_codes (
          code_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE, code_hint TEXT NOT NULL,
          face_value INTEGER NOT NULL, status TEXT NOT NULL, redeemed_by TEXT, redeemed_at TEXT, redeem_entry_id TEXT,
          expires_at TEXT, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS redeem_codes_batch ON redeem_codes(batch_id, status);
        PRAGMA user_version = 3;
      `));
    this.database.exec("CREATE INDEX IF NOT EXISTS access_credentials_hash ON production_documents(project_directory, json_extract(snapshot_json, '$.hash')) WHERE collection='credentials'; CREATE INDEX IF NOT EXISTS runs_owner_recent ON runs(project_directory, json_extract(snapshot_json, '$.ownerUserId'), created_at DESC, run_id DESC);");
    // 卡密可绑定一个具体服务：用卡登录后直接进入该服务，不再让用户挑。
    const batchColumns = this.database.prepare("PRAGMA table_info(redeem_batches)").all() as unknown as Array<{ name: string }>;
    if (!batchColumns.some(column => column.name === "package_id")) this.database.exec("ALTER TABLE redeem_batches ADD COLUMN package_id TEXT");
    // 管理端需要随时回读卡密明文（运营发放/客服核对）。旧批次没有该列值时明文不可恢复，
    // 读接口明确标记而不是伪造；哈希与末四位仍然保留，兑换校验继续走哈希。
    const codeColumnNames = () => (this.database.prepare("PRAGMA table_info(redeem_codes)").all() as unknown as Array<{ name: string }>).map(column => column.name);
    if (!codeColumnNames().includes("code_plain")) this.database.exec("ALTER TABLE redeem_codes ADD COLUMN code_plain TEXT");
    // 已兑换的卡也能作废（退款场景）：作废时把面值从兑换人账户收回，这里记录作废人与实际收回金额。
    // 旧行没有这些列时按「未收回」读取，不伪造金额。
    for (const [column, type] of [["voided_at", "TEXT"], ["voided_by", "TEXT"], ["refund_entry_id", "TEXT"], ["reclaimed_face_value", "INTEGER"]] as const) {
      if (!codeColumnNames().includes(column)) this.database.exec("ALTER TABLE redeem_codes ADD COLUMN " + column + " " + type);
    }
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
  /** 租户级在跑数：排队、执行、取消收尾与等待审核都算占用（审核会继续生成）。 */
  activeRunsForOwner(projectDirectory: string, userId: string): number {
    const row = this.stmt("SELECT COUNT(*) AS count FROM runs WHERE project_directory=? AND json_extract(snapshot_json,'$.ownerUserId')=? AND status IN ('queued','running','cancelling','waiting')").get(projectDirectory, userId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
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

  /**
   * Revision alone, without parsing the snapshot.
   *
   * `/api/workspace/status` is polled every few seconds by every open workbench
   * and only needs the counter. Going through `getWorkspace()` made each poll
   * JSON.parse and spread the whole multi-megabyte snapshot for one integer.
   */
  getWorkspaceRevision(): number | undefined {
    const row = this.stmt("SELECT revision FROM workspace WHERE id = 1").get() as { revision: number } | undefined;
    return row?.revision;
  }

  saveWorkspace(snapshot: Record<string, unknown>): Record<string, unknown> & { revision: number } {
    const previous = this.getWorkspace();
    const revision = (previous?.revision ?? 0) + 1;
    this.stmt("INSERT INTO workspace VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, snapshot_json=excluded.snapshot_json, updated_at=excluded.updated_at")
      .run(revision, JSON.stringify(snapshot), new Date().toISOString());
    return { ...snapshot, revision };
  }

  getRun(projectDirectory: string, runId: string): RunRecord | undefined {
    const row = this.stmt("SELECT snapshot_json, updated_at FROM runs WHERE project_directory = ? AND run_id = ?").get(projectDirectory, runId) as { snapshot_json: string; updated_at: string } | undefined;
    if (!row) return undefined;
    return this.parseRunCached(projectDirectory, runId, row.snapshot_json, row.updated_at);
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
    this.writes += 1;
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

  /** 批量状态投影：任务进度只需 runId→状态/待确认/错误，避免为每个任务项解析整份运行快照。 */
  runStatuses(projectDirectory: string, runIds: readonly string[]): Map<string, { status: RunStatus; reviewId?: string; error?: string }> {
    const result = new Map<string, { status: RunStatus; reviewId?: string; error?: string }>();
    const unique = [...new Set(runIds)].filter(id => typeof id === "string" && id.length > 0);
    for (let index = 0; index < unique.length; index += 400) {
      const chunk = unique.slice(index, index + 400);
      const rows = this.database.prepare("SELECT run_id, status, json_extract(snapshot_json,'$.pendingReview.id') AS review_id, json_extract(snapshot_json,'$.error') AS error FROM runs WHERE project_directory=? AND run_id IN (" + chunk.map(() => "?").join(",") + ")")
        .all(projectDirectory, ...chunk) as unknown as Array<{ run_id: string; status: string; review_id: string | null; error: string | null }>;
      for (const row of rows) result.set(row.run_id, { status: row.status as RunStatus, ...(row.review_id ? { reviewId: row.review_id } : {}), ...(row.error ? { error: row.error } : {}) });
    }
    return result;
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
    if (query.q) where += runSearchClause(query.q, params);
    if (query.before) { where += " AND (created_at < ? OR (created_at = ? AND run_id < ?))"; params.push(query.before.createdAt, query.before.createdAt, query.before.runId); }
    const limit = Math.max(1, Math.min(200, query.limit ?? 50));
    params.push(limit + 1);
    const rows = this.database.prepare(`SELECT run_id, snapshot_json, updated_at FROM runs WHERE ${where} ORDER BY created_at DESC, run_id DESC LIMIT ?`).all(...params) as Array<{ run_id: string; snapshot_json: string; updated_at: string }>;
    const more = rows.length > limit;
    // 复用解析缓存，但向调用方返回浅拷贝：列表消费方可能就地修改记录字段。
    const runs = rows.slice(0, limit).map((row) => ({ ...this.parseRunCached(projectDirectory, row.run_id, row.snapshot_json, row.updated_at) }));
    const last = runs.at(-1);
    return { runs, ...(more && last ? { nextCursor: { createdAt: last.createdAt, runId: last.runId } } : {}) };
  }

  private parseRunCached(projectDirectory: string, runId: string, snapshotJson: string, updatedAt: string): RunRecord {
    const key = projectDirectory + "\n" + runId;
    const cached = this.snapshotCache.get(key);
    if (cached && cached.stamp === updatedAt && cached.writes === this.writes) return cached.run;
    const run = JSON.parse(snapshotJson) as RunRecord;
    if (this.snapshotCache.size >= 512) this.snapshotCache.clear();
    this.snapshotCache.set(key, { stamp: updatedAt, writes: this.writes, run });
    return run;
  }

  /** 摘要列表：只抽取列表页需要的标量与计数，避免解析整份运行快照（大运行单份可达数百 KB）。 */
  listRunSummaries(projectDirectory: string, query: RunListQuery = {}): { runs: RunSummaryRow[]; nextCursor?: { createdAt: string; runId: string } } {
    const params: Array<string | number> = [projectDirectory];
    let where = "project_directory=?";
    if (query.ownerUserId) { where += " AND json_extract(snapshot_json, '$.ownerUserId')=?"; params.push(query.ownerUserId); }
    if (query.status) { where += " AND status=?"; params.push(query.status); }
    if (query.sceneId) { where += " AND scene_id=?"; params.push(query.sceneId); }
    if (query.q) where += runSearchClause(query.q, params);
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
  /** 积分账户：余额是物化值，账本是权威；两者只在 applyCreditDelta 内同事务更新。 */
  creditAccount(userId: string): CreditAccountRow | undefined {
    const row = this.stmt("SELECT user_id, balance, revision, updated_at FROM credit_accounts WHERE user_id=?").get(userId) as { user_id: string; balance: number; revision: number; updated_at: string } | undefined;
    return row ? { userId: row.user_id, balance: fromUnits(Number(row.balance)), revision: Number(row.revision), updatedAt: row.updated_at } : undefined;
  }
  creditEntryByKey(idempotencyKey: string): CreditEntry | undefined {
    const row = this.stmt("SELECT entry_id, user_id, delta, balance_after, kind, ref_type, ref_id, idempotency_key, actor_user_id, note, created_at FROM credit_entries WHERE idempotency_key=?").get(idempotencyKey) as Record<string, unknown> | undefined;
    return row ? this.mapCreditEntry(row) : undefined;
  }
  private mapCreditEntry(row: Record<string, unknown>): CreditEntry {
    const text = (value: unknown) => value === null || value === undefined ? undefined : String(value);
    return {
      entryId: String(row.entry_id), userId: String(row.user_id), delta: fromUnits(Number(row.delta)), balanceAfter: fromUnits(Number(row.balance_after)),
      kind: String(row.kind) as CreditEntryKind,
      ...(text(row.ref_type) !== undefined ? { refType: text(row.ref_type)! } : {}),
      ...(text(row.ref_id) !== undefined ? { refId: text(row.ref_id)! } : {}),
      idempotencyKey: String(row.idempotency_key),
      ...(text(row.actor_user_id) !== undefined ? { actorUserId: text(row.actor_user_id)! } : {}),
      ...(text(row.note) !== undefined ? { note: text(row.note)! } : {}),
      createdAt: String(row.created_at),
    };
  }
  listCreditEntries(userId: string, query: { before?: { createdAt: string; entryId: string }; limit: number }): { entries: CreditEntry[]; nextCursor?: { createdAt: string; entryId: string } } {
    const params: Array<string | number> = [userId];
    let where = "user_id=?";
    if (query.before) { where += " AND (created_at < ? OR (created_at = ? AND entry_id < ?))"; params.push(query.before.createdAt, query.before.createdAt, query.before.entryId); }
    params.push(query.limit + 1);
    const rows = this.database.prepare(`SELECT entry_id, user_id, delta, balance_after, kind, ref_type, ref_id, idempotency_key, actor_user_id, note, created_at FROM credit_entries WHERE ${where} ORDER BY created_at DESC, entry_id DESC LIMIT ?`).all(...params) as unknown as Array<Record<string, unknown>>;
    const more = rows.length > query.limit;
    const entries = rows.slice(0, query.limit).map(row => this.mapCreditEntry(row));
    const last = entries.at(-1);
    return { entries, ...(more && last ? { nextCursor: { createdAt: last.createdAt, entryId: last.entryId } } : {}) };
  }
  /**
   * 对账：一次读出全部账户的余额、流水累计、未结算预扣与预扣缺结清明细。
   * 三类不一致都会被点名：余额≠流水累计（绕过账本写余额）、预扣无结清且远超运行生命周期（漏结算）、
   * 结清金额超过预扣（多退）。
   */
  creditReconciliation() {
    const accounts = this.database.prepare("SELECT user_id, balance, revision, updated_at FROM credit_accounts ORDER BY user_id").all() as unknown as Array<{ user_id: string; balance: number; revision: number; updated_at: string }>;
    const ledger = new Map((this.database.prepare("SELECT user_id, COALESCE(SUM(delta),0) AS total FROM credit_entries GROUP BY user_id").all() as unknown as Array<{ user_id: string; total: number }>).map(row => [row.user_id, Number(row.total)]));
    const reserved = new Map((this.database.prepare(`SELECT reserve.user_id AS user_id, COALESCE(SUM(-reserve.delta),0) AS total, COUNT(*) AS count FROM credit_entries reserve
      WHERE reserve.kind='run_reserve' AND NOT EXISTS (SELECT 1 FROM credit_entries settle WHERE settle.kind='run_settle' AND settle.ref_id=reserve.ref_id)
      GROUP BY reserve.user_id`).all() as unknown as Array<{ user_id: string; total: number; count: number }>).map(row => [row.user_id, { total: Number(row.total), count: Number(row.count) }]));
    // 结清金额超过同一 ref 的预扣：只有手工改库或代码缺陷才会出现。
    const overRefunded = (this.database.prepare(`SELECT settle.user_id AS user_id, settle.ref_id AS ref_id, COALESCE(SUM(settle.delta),0) AS refunded,
        COALESCE((SELECT SUM(-reserve.delta) FROM credit_entries reserve WHERE reserve.kind='run_reserve' AND reserve.ref_id=settle.ref_id AND reserve.user_id=settle.user_id),0) AS reserved
      FROM credit_entries settle WHERE settle.kind='run_settle' GROUP BY settle.user_id, settle.ref_id
      HAVING refunded > reserved`).all() as unknown as Array<{ user_id: string; ref_id: string; refunded: number; reserved: number }>)
      .map(row => ({ userId: row.user_id, refId: row.ref_id, refunded: fromUnits(Number(row.refunded)), reserved: fromUnits(Number(row.reserved)) }));
    const rows = accounts.map(account => {
      const total = ledger.get(account.user_id) ?? 0;
      const held = reserved.get(account.user_id) ?? { total: 0, count: 0 };
      const balancePoints = fromUnits(Number(account.balance));
      const ledgerPoints = fromUnits(total);
      const reservedPoints = fromUnits(held.total);
      return {
        userId: account.user_id, balance: balancePoints, revision: Number(account.revision), updatedAt: account.updated_at,
        ledgerTotal: ledgerPoints, reserved: reservedPoints, reservedRefs: held.count,
        balanceMatchesLedger: Number(account.balance) === total,
        available: fromUnits(Math.max(0, Number(account.balance) - held.total)),
      };
    });
    return {
      accounts: rows,
      mismatchedBalances: rows.filter(row => !row.balanceMatchesLedger),
      overRefunded,
      totals: {
        accounts: rows.length,
        // 合计同样在厘域累加：直接对 0.05 这类分数求和会带出浮点尾数。
        balance: fromUnits(rows.reduce((sum, row) => sum + toUnits(row.balance), 0)),
        reserved: fromUnits(rows.reduce((sum, row) => sum + toUnits(row.reserved), 0)),
        usersWithReserved: rows.filter(row => row.reserved > 0).length,
      },
    };
  }
  /** 只读自检：余额必须等于流水累计；不一致说明有人绕过账本写了余额。 */
  creditIntegrity(userId?: string) {
    const filter = userId ? "WHERE user_id=?" : "";
    const args = userId ? [userId] : [];
    const accounts = this.database.prepare(`SELECT user_id, balance FROM credit_accounts ${filter}`).all(...(args as never[])) as unknown as Array<{ user_id: string; balance: number }>;
    const ledger = new Map((this.database.prepare(`SELECT user_id, COALESCE(SUM(delta),0) AS total FROM credit_entries ${filter} GROUP BY user_id`).all(...(args as never[])) as unknown as Array<{ user_id: string; total: number }>).map(row => [row.user_id, Number(row.total)]));
    const mismatches = accounts.filter(row => ledger.get(row.user_id) !== Number(row.balance)).map(row => ({ userId: row.user_id, balance: fromUnits(Number(row.balance)), ledger: fromUnits(ledger.get(row.user_id) ?? 0) }));
    return { accounts: accounts.length, mismatches };
  }
  /** 单笔预扣金额（同一 ref 的所有 run_reserve 之和）；结算退款以它为上限。 */
  reservedForRef(userId: string, refId: string): number {
    const row = this.stmt("SELECT COALESCE(SUM(-delta),0) AS total FROM credit_entries WHERE user_id=? AND ref_id=? AND kind='run_reserve'").get(userId, refId) as { total: number } | undefined;
    return Math.max(0, fromUnits(Number(row?.total ?? 0)));
  }
  /** 未结算的预扣合计：有 run_reserve 但没有同 ref 的 run_settle。 */
  reservedCredits(userId: string) {
    const row = this.stmt(`SELECT COALESCE(SUM(-reserve.delta),0) AS total, COUNT(*) AS runs FROM credit_entries reserve
      WHERE reserve.user_id=? AND reserve.kind='run_reserve'
        AND NOT EXISTS (SELECT 1 FROM credit_entries settle WHERE settle.kind='run_settle' AND settle.ref_id=reserve.ref_id)`).get(userId) as { total: number; runs: number } | undefined;
    return { total: fromUnits(Number(row?.total ?? 0)), runs: Number(row?.runs ?? 0) };
  }
  /** 唯一写入点：幂等键命中直接回现有条目；余额不足不落账。 */
  /** 入参 delta 是对外的「分」（可含两位小数），写入账本时换算成「厘」整数。 */
  applyCreditDelta(input: { userId: string; delta: number; kind: CreditEntryKind; idempotencyKey: string; refType?: string; refId?: string; actorUserId?: string; note?: string }) {
    return this.transaction(() => this.applyCreditDeltaInTransaction(input));
  }
  private applyCreditDeltaInTransaction(input: { userId: string; delta: number; kind: CreditEntryKind; idempotencyKey: string; refType?: string; refId?: string; actorUserId?: string; note?: string }) {
    const existing = this.creditEntryByKey(input.idempotencyKey);
    if (existing) return { applied: false as const, entry: existing, account: { balance: existing.balanceAfter, revision: this.creditAccount(input.userId)?.revision ?? 0 } };
    const current = this.creditAccount(input.userId);
    // 入参与 creditAccount 都是「分」，账本以「厘」存；整条链路只在厘域做加减，避免分/厘混用。
    const currentUnits = toUnits(current?.balance ?? 0);
    const deltaUnits = toUnits(input.delta);
    const balance = currentUnits + deltaUnits;
    if (balance < 0) return { applied: false as const, insufficient: true as const, account: { balance: fromUnits(currentUnits), revision: current?.revision ?? 0 } };
    const now = new Date().toISOString();
    const revision = (current?.revision ?? 0) + 1;
    const entry: CreditEntry = {
      entryId: randomUUID(), userId: input.userId, delta: fromUnits(deltaUnits), balanceAfter: fromUnits(balance), kind: input.kind,
      ...(input.refType !== undefined ? { refType: input.refType } : {}),
      ...(input.refId !== undefined ? { refId: input.refId } : {}),
      idempotencyKey: input.idempotencyKey,
      ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      createdAt: now,
    };
    this.stmt("INSERT INTO credit_accounts VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET balance=excluded.balance, revision=excluded.revision, updated_at=excluded.updated_at")
      .run(input.userId, balance, revision, now);
    // 表里存厘（整数），返回值是对外的分：两者必须分开，否则调账响应会把 100 厘当成 100 分。
    this.stmt("INSERT INTO credit_entries VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(entry.entryId, entry.userId, deltaUnits, balance, entry.kind, entry.refType ?? null, entry.refId ?? null, entry.idempotencyKey, entry.actorUserId ?? null, entry.note ?? null, entry.createdAt);
    return { applied: true as const, entry, account: { balance: fromUnits(balance), revision } };
  }

  insertRedeemBatch(batch: RedeemBatch, codes: Array<{ codeId: string; codeHash: string; codeHint: string; codePlain: string }>) {
    return this.transaction(() => {
      this.stmt("INSERT INTO redeem_batches (batch_id, name, face_value, code_count, expires_at, created_by, created_at, note, package_id) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(batch.batchId, batch.name, toUnits(batch.faceValue), batch.codeCount, batch.expiresAt ?? null, batch.createdBy ?? null, batch.createdAt, batch.note ?? null, batch.packageId ?? null);
      const insert = this.stmt("INSERT INTO redeem_codes (code_id, batch_id, code_hash, code_hint, face_value, status, redeemed_by, redeemed_at, redeem_entry_id, expires_at, created_at, code_plain) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
      codes.forEach(code => insert.run(code.codeId, batch.batchId, code.codeHash, code.codeHint, toUnits(batch.faceValue), "unused", null, null, null, batch.expiresAt ?? null, batch.createdAt, code.codePlain));
      return batch;
    });
  }
  redeemBatchList(): Array<RedeemBatch & { unused: number; redeemed: number; voided: number }> {
    const rows = this.database.prepare(`SELECT b.batch_id, b.name, b.face_value, b.code_count, b.expires_at, b.created_by, b.created_at, b.note, b.package_id,
        COALESCE(SUM(CASE WHEN c.status='unused' THEN 1 ELSE 0 END),0) AS unused,
        COALESCE(SUM(CASE WHEN c.status='redeemed' THEN 1 ELSE 0 END),0) AS redeemed,
        COALESCE(SUM(CASE WHEN c.status='void' THEN 1 ELSE 0 END),0) AS voided
      FROM redeem_batches b LEFT JOIN redeem_codes c ON c.batch_id=b.batch_id GROUP BY b.batch_id ORDER BY b.created_at DESC, b.batch_id DESC`).all() as unknown as Array<Record<string, unknown>>;
    return rows.map(row => ({
      batchId: String(row.batch_id), name: String(row.name), faceValue: fromUnits(Number(row.face_value)), codeCount: Number(row.code_count),
      ...(row.expires_at ? { expiresAt: String(row.expires_at) } : {}), ...(row.created_by ? { createdBy: String(row.created_by) } : {}),
      createdAt: String(row.created_at), ...(row.note ? { note: String(row.note) } : {}),
      ...(row.package_id ? { packageId: String(row.package_id) } : {}),
      unused: Number(row.unused), redeemed: Number(row.redeemed), voided: Number(row.voided),
    }));
  }
  private mapRedeemCode(row: Record<string, unknown>): RedeemCode {
    const text = (value: unknown) => value === null || value === undefined ? undefined : String(value);
    return {
      codeId: String(row.code_id), batchId: String(row.batch_id), codeHash: String(row.code_hash), codeHint: String(row.code_hint),
      faceValue: fromUnits(Number(row.face_value)), status: String(row.status) as RedeemCode["status"],
      ...(text(row.redeemed_by) !== undefined ? { redeemedBy: text(row.redeemed_by)! } : {}),
      ...(text(row.redeemed_at) !== undefined ? { redeemedAt: text(row.redeemed_at)! } : {}),
      ...(text(row.redeem_entry_id) !== undefined ? { redeemEntryId: text(row.redeem_entry_id)! } : {}),
      ...(text(row.expires_at) !== undefined ? { expiresAt: text(row.expires_at)! } : {}),
      // 明文列是后加的：旧批次没有值，读接口据此明确标记「不可回读」而不是回空串。
      ...(text(row.code_plain) !== undefined ? { codePlain: text(row.code_plain)! } : {}),
      ...(text(row.voided_at) !== undefined ? { voidedAt: text(row.voided_at)! } : {}),
      ...(text(row.voided_by) !== undefined ? { voidedBy: text(row.voided_by)! } : {}),
      ...(text(row.refund_entry_id) !== undefined ? { refundEntryId: text(row.refund_entry_id)! } : {}),
      // 列在退款能力上线前为 NULL：表示该码作废时没有收回过余额（旧行或未兑换码）。
      ...(row.reclaimed_face_value !== null && row.reclaimed_face_value !== undefined ? { reclaimedFaceValue: fromUnits(Number(row.reclaimed_face_value)) } : {}),
      // batch_package_id 来自 JOIN（redeem_codes LEFT JOIN redeem_batches），决定登录后进哪个服务。
      ...(text(row.batch_package_id) !== undefined ? { packageId: text(row.batch_package_id)! } : {}),
      createdAt: String(row.created_at),
    };
  }
  redeemCodeByHash(codeHash: string): RedeemCode | undefined {
    const row = this.stmt("SELECT c.*, b.package_id AS batch_package_id FROM redeem_codes c LEFT JOIN redeem_batches b ON b.batch_id=c.batch_id WHERE c.code_hash=?").get(codeHash) as Record<string, unknown> | undefined;
    return row ? this.mapRedeemCode(row) : undefined;
  }
  redeemCodeById(codeId: string): RedeemCode | undefined {
    const row = this.stmt("SELECT c.*, b.package_id AS batch_package_id FROM redeem_codes c LEFT JOIN redeem_batches b ON b.batch_id=c.batch_id WHERE c.code_id=?").get(codeId) as Record<string, unknown> | undefined;
    return row ? this.mapRedeemCode(row) : undefined;
  }
  listRedeemCodes(batchId: string): RedeemCode[] {
    return (this.database.prepare("SELECT c.*, b.package_id AS batch_package_id FROM redeem_codes c LEFT JOIN redeem_batches b ON b.batch_id=c.batch_id WHERE c.batch_id=? ORDER BY c.code_id").all(batchId) as unknown as Array<Record<string, unknown>>).map(row => this.mapRedeemCode(row));
  }
  /** 该用户当前仍有效的卡（已兑换且未作废、未过期）。卡即身份：没有有效卡就没有登录依据。 */
  activeRedeemCodeForUser(userId: string): RedeemCode | undefined {
    const row = this.database.prepare("SELECT c.*, b.package_id AS batch_package_id FROM redeem_codes c LEFT JOIN redeem_batches b ON b.batch_id=c.batch_id WHERE c.redeemed_by=? AND c.status='redeemed' ORDER BY c.redeemed_at DESC LIMIT 1").get(userId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const code = this.mapRedeemCode(row);
    return code.expiresAt && code.expiresAt <= new Date().toISOString() ? undefined : code;
  }
  /**
   * 作废单张卡。已兑换的卡也可以作废（退款场景），状态变更与回收在同一事务：
   * - reclaim=true 时按面值从兑换人账户扣回；余额不足就扣到 0 为止（不拒绝、不要求先充值），
   *   差额在返回的 shortfall 里如实报告。幂等键 cdk_refund:<codeId> 保证重复调用只扣一次。
   * - reclaim=false 时只作废不退分（例如线下已退款）。
   * 作废后 redeemCode 会把该码当作不存在，因此「先退款再作废」不会让用户二次兑换。
   */
  voidRedeemCode(codeId: string, options: { reclaim?: boolean; actorUserId?: string } = {}) {
    return this.transaction(() => this.voidRedeemCodeInTransaction(codeId, options));
  }
  /** 事务内版本：整批作废逐张调用它，避免 SQLite 嵌套 BEGIN。 */
  private voidRedeemCodeInTransaction(codeId: string, options: { reclaim?: boolean; actorUserId?: string } = {}) {
    const code = this.redeemCodeById(codeId);
    if (!code) return { status: "not_found" as const };
    if (code.status === "void") return { status: "void" as const, code };
    const now = new Date().toISOString();
    const actor = options.actorUserId;
    if (code.status === "redeemed" && options.reclaim !== false) {
      if (!code.redeemedBy) throw new Error("已兑换卡密缺少兑换人，无法回收积分");
      // 只扣到 0 为止：余额不足是常见情况（积分已经花掉了），不能因此拒绝作废，
      // 也不能让账户出现负余额。差额作为 shortfall 明确返回，由人决定是否另行追收。
      const balance = this.creditAccount(code.redeemedBy)?.balance ?? 0;
      const recoverable = Math.min(Math.max(0, balance), code.faceValue);
      let entry: CreditEntry | undefined;
      if (recoverable > 0) {
        const applied = this.applyCreditDeltaInTransaction({ userId: code.redeemedBy, delta: -recoverable, kind: "cdk_refund", idempotencyKey: "cdk_refund:" + code.codeId, refType: "code", refId: code.codeId, ...(actor ? { actorUserId: actor } : {}), note: "作废已兑换卡密，收回 " + formatPoints(recoverable) + "（" + code.codeHint + "）" });
        entry = applied.entry;
      }
      // 幂等重放（回执丢失后重试）时条目已存在，仍按已收回读取。
      const reclaimed = entry ? Math.abs(entry.delta) : 0;
      const shortfall = fromUnits(Math.max(0, toUnits(code.faceValue) - toUnits(reclaimed)));
      const voided: RedeemCode = { ...code, status: "void", voidedAt: now, ...(actor ? { voidedBy: actor } : {}), reclaimedFaceValue: reclaimed, ...(entry ? { refundEntryId: entry.entryId } : {}) };
      this.stmt("UPDATE redeem_codes SET status='void', voided_at=?, voided_by=?, refund_entry_id=?, reclaimed_face_value=? WHERE code_id=? AND status='redeemed'")
        .run(now, actor ?? null, entry?.entryId ?? null, toUnits(reclaimed), codeId);
      return { status: "voided" as const, code: voided, reclaimed, shortfall, entry };
    }
    const voided: RedeemCode = { ...code, status: "void", voidedAt: now, ...(actor ? { voidedBy: actor } : {}), ...(code.status === "redeemed" ? { reclaimedFaceValue: 0 } : {}) };
    this.stmt("UPDATE redeem_codes SET status='void', voided_at=?, voided_by=?, reclaimed_face_value=? WHERE code_id=? AND status=?")
      .run(now, actor ?? null, code.status === "redeemed" ? 0 : null, codeId, code.status);
    return { status: "voided" as const, code: voided, reclaimed: 0, shortfall: code.status === "redeemed" ? code.faceValue : 0 };
  }
  /**
   * 整批作废。默认把已兑换的码也纳入范围并逐张收回面值（退款场景）；
   * includeRedeemed=false 时退回旧行为，只作废未使用的码。
   * 逐张扣到余额为 0 为止：余额不足不中断其余张，缺口合计在 shortfall 里报告。
   */
  voidRedeemBatch(batchId: string, options: { reclaim?: boolean; includeRedeemed?: boolean; actorUserId?: string } = {}) {
    return this.transaction(() => {
      const batch = this.database.prepare("SELECT batch_id FROM redeem_batches WHERE batch_id=?").get(batchId) as { batch_id: string } | undefined;
      if (!batch) return { status: "not_found" as const };
      const reclaim = options.reclaim === true;
      const includeRedeemed = options.includeRedeemed !== false;
      const targets = this.listRedeemCodes(batchId).filter(code => code.status === "unused" || (includeRedeemed && code.status === "redeemed"));
      let voided = 0; let reclaimed = 0; let shortfall = 0;
      const partial: Array<{ codeId: string; codeHint: string; faceValue: number; reclaimed: number; shortfall: number }> = [];
      for (const code of targets) {
        const result = this.voidRedeemCodeInTransaction(code.codeId, { ...(code.status === "redeemed" ? { reclaim } : {}), ...(options.actorUserId ? { actorUserId: options.actorUserId } : {}) });
        if (result.status !== "voided") continue;
        voided += 1; reclaimed += result.reclaimed ?? 0;
        const gap = result.shortfall ?? 0;
        if (gap > 0) { shortfall += gap; partial.push({ codeId: code.codeId, codeHint: code.codeHint, faceValue: code.faceValue, reclaimed: result.reclaimed ?? 0, shortfall: gap }); }
      }
      const counts = this.database.prepare("SELECT COALESCE(SUM(CASE WHEN status='unused' THEN 1 ELSE 0 END),0) AS unused, COALESCE(SUM(CASE WHEN status='redeemed' THEN 1 ELSE 0 END),0) AS redeemed, COALESCE(SUM(CASE WHEN status='void' THEN 1 ELSE 0 END),0) AS voided FROM redeem_codes WHERE batch_id=?").get(batchId) as { unused: number; redeemed: number; voided: number };
      return { status: "voided" as const, voided, reclaimed, shortfall, partial, counts: { unused: Number(counts.unused), redeemed: Number(counts.redeemed), voided: Number(counts.voided) } };
    });
  }
  /** 兑换：校验、记账、置为已兑现在同一事务内完成，重复提交返回既有回执。 */
  redeemCode(codeHash: string, userId: string) {
    return this.transaction(() => {
      const code = this.redeemCodeByHash(codeHash);
      if (!code) return { status: "not_found" as const };
      if (code.status === "void") return { status: "not_found" as const };
      if (code.status === "redeemed") return { status: "already" as const, code };
      const now = new Date().toISOString();
      if (code.expiresAt && code.expiresAt <= now) return { status: "expired" as const, code };
      const applied = this.applyCreditDeltaInTransaction({ userId, delta: code.faceValue, kind: "cdk_redeem", idempotencyKey: "cdk_redeem:" + code.codeId, refType: "code", refId: code.codeId, note: code.codeHint });
      if (!applied.applied) return { status: "already" as const, code, entry: applied.entry };
      const redeemed: RedeemCode = { ...code, status: "redeemed", redeemedBy: userId, redeemedAt: now, redeemEntryId: applied.entry!.entryId };
      this.stmt("UPDATE redeem_codes SET status='redeemed', redeemed_by=?, redeemed_at=?, redeem_entry_id=? WHERE code_id=? AND status='unused'")
        .run(userId, now, applied.entry!.entryId, code.codeId);
      return { status: "redeemed" as const, code: redeemed, entry: applied.entry! };
    });
  }

  getDocument<T>(project: string, collection: string, id: string): T | undefined {
    const row = this.stmt("SELECT snapshot_json FROM production_documents WHERE project_directory=? AND collection=? AND id=?").get(project, collection, id) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) as T : undefined;
  }
  listDocuments<T>(project: string, collection: string): T[] {
    return (this.stmt("SELECT snapshot_json FROM production_documents WHERE project_directory=? AND collection=? ORDER BY updated_at DESC, id DESC").all(project, collection) as Array<{ snapshot_json: string }>).map(row => JSON.parse(row.snapshot_json) as T);
  }
  /** 跨项目按集合列举：只用于归属反查（如「这个子运行属于哪个服务运行」），不做业务读取。 */
  listDocumentsAcrossProjects<T>(collection: string): T[] {
    return (this.stmt("SELECT snapshot_json FROM production_documents WHERE collection=? ORDER BY updated_at DESC, id DESC").all(collection) as Array<{ snapshot_json: string }>).map(row => JSON.parse(row.snapshot_json) as T);
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

  /** 删除单个文档；仅由惰性清理（过期凭证等）使用，不做级联。 */
  deleteDocument(project: string, collection: string, id: string): boolean {
    return this.stmt("DELETE FROM production_documents WHERE project_directory=? AND collection=? AND id=?").run(project, collection, id).changes > 0;
  }

  /** revision 保护的删除：与 putDocumentChecked 同一冲突语义（DOCUMENT_CONFLICT），
   *  因此并发删除只有一个成功，旧 revision 不会删掉别人刚保存的内容。 */
  deleteDocumentChecked(project: string, collection: string, id: string, expectedRevision: number, check: () => void = () => {}): boolean {
    return this.transaction(() => {
      check();
      const current = this.getDocument<{ revision: number }>(project, collection, id);
      if ((current?.revision ?? 0) !== expectedRevision) throw new Error("DOCUMENT_CONFLICT");
      return this.stmt("DELETE FROM production_documents WHERE project_directory=? AND collection=? AND id=?").run(project, collection, id).changes > 0;
    });
  }

  hasImported(projectDirectory: string) { return Boolean(this.stmt("SELECT 1 FROM imports WHERE project_directory=?").get(projectDirectory)); }
  markImported(projectDirectory: string) { this.stmt("INSERT OR REPLACE INTO imports VALUES (?, ?)").run(projectDirectory, new Date().toISOString()); }
  diagnostics() { return this.stmt("PRAGMA quick_check").all(); }
  close() { this.database.close(); }
}
