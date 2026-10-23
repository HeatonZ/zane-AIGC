import { open, stat } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../errors.js";
import { contentRevision } from "../domain/sceneContent.js";
import {
  logOpsFiles, opsLogQuery, systemLogQuery,
  type LogOpsFile, type OpsLogPage, type OpsLogQuery, type SystemLogEntry, type SystemLogPage, type SystemLogQuery,
} from "../domain/systemLogContracts.js";
import { redactLogText } from "../observability/logRedaction.js";
import type { LogEntry, LogLevel } from "../observability/logger.js";

/** The buffer shape this service needs; kept structural so tests can inject a small buffer. */
export interface LogBufferSource {
  snapshot(): { capacity: number; size: number; dropped: number; entries: LogEntry[] };
}

const pageFormat = "system-log-page/v1";
/** 单行文本上限：运维日志可能包含完整堆栈或上游响应体。超出时截断并标记。 */
const opsLineLimit = 4000;
/** 每次运维日志读取的字节上限；超过则只读尾部窗口并明确告知 totalLines 是窗口内行数。 */
const opsReadByteLimit = 4 * 1024 * 1024;
/** 等级过滤是"最低等级"语义，与 ZANE_LOG_LEVEL 一致。 */
const levelRank: Record<string, number> = { info: 0, warn: 1, error: 2 };

function atLeast(level: string, minimum: string) {
  return (levelRank[level] ?? 0) >= (levelRank[minimum] ?? 0);
}

/**
 * Read-only authority for the admin log viewer.
 *
 * Two sources, one implementation shared by HTTP, MCP and the web page:
 *   - `listProcess`: filters and cursor-paginates the in-memory structured buffer.
 *   - `readOpsFile`: reads a bounded tail of one *named* operational log file.
 *
 * There is no caller-supplied path anywhere: `file` is matched against `logOpsFiles`, so this
 * cannot be turned into an arbitrary file-read proxy even by an admin credential.
 */
export class SystemLogService {
  constructor(
    private readonly buffer: LogBufferSource,
    /** Data directory holding the allowlisted operational logs; injected for isolation tests. */
    private readonly dataDirectory: string = "",
  ) {}

  private matches(entry: LogEntry, query: Omit<SystemLogQuery, "limit" | "cursor">) {
    if (query.level && !atLeast(entry.level, query.level)) return false;
    if (query.event && !entry.event.toLowerCase().startsWith(query.event.toLowerCase())) return false;
    if (query.excludeEvent) {
      // 逗号分隔的多个前缀；空段忽略，避免 "run.," 这类输入把匹配意外清空。
      const excluded = query.excludeEvent.split(",").map(prefix => prefix.trim().toLowerCase()).filter(Boolean);
      if (excluded.some(prefix => entry.event.toLowerCase().startsWith(prefix))) return false;
    }
    if (query.runId) {
      const fields = entry.fields as Record<string, unknown>;
      // sourceRunId is matched too: rerun/resume entries carry the ancestor id rather than their own.
      const candidates = [fields.runId, fields.sourceRunId, fields.newRunId].filter((value): value is string => typeof value === "string");
      if (!candidates.some((value) => value.toLowerCase() === query.runId!.toLowerCase())) return false;
    }
    if (query.sceneId && String((entry.fields as Record<string, unknown>).sceneId ?? "").toLowerCase() !== query.sceneId.toLowerCase()) return false;
    // 场景包：包内 log() 写的事件带 packageRunId，子运行的包级事件也带（由场景包服务打标），
    // 所以按 packageRunId 能一次拉出这次包运行的全部日志，不必再按 runId 逐个子运行拼。
    if (query.packageRunId && String((entry.fields as Record<string, unknown>).packageRunId ?? "").toLowerCase() !== query.packageRunId.toLowerCase()) return false;
    if (query.q) {
      const needle = query.q.toLowerCase();
      if (!entry.event.toLowerCase().includes(needle) && !JSON.stringify(entry.fields).toLowerCase().includes(needle)) return false;
    }
    return true;
  }

  listProcess(query: SystemLogQuery): SystemLogPage {
    // Re-validate here: this service is the shared authority, and callers other than the router
    // (tests, future MCP paths) must not be able to bypass the declared query contract.
    const parsed = systemLogQuery.safeParse(query);
    if (!parsed.success) throw new HttpError(400, "日志查询参数无效：" + parsed.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; "), "INVALID_LOG_REQUEST");
    const { limit, cursor, ...filters } = parsed.data;
    const snapshot = this.buffer.snapshot();
    // Newest first: an operator opening the page wants the most recent failure, not the oldest line.
    const matched = snapshot.entries.filter((entry) => this.matches(entry, filters)).reverse();

    // Window identity — deliberately NOT the entry set.
    //
    // Reading this log appends an `http.request` entry, so the entry set changes on every single
    // request. Hashing the set would make every continuation 409 and pagination unusable. What
    // actually invalidates a cursor is the *oldest retained boundary* moving (capacity eviction),
    // because then entries the caller has not yet read are genuinely gone. So the revision covers
    // the filter set plus that boundary, and is stable while entries are only being appended.
    const retainedFromSequence = snapshot.entries[0]?.sequence ?? 0;
    const revision = contentRevision({ source: "process", filters, capacity: snapshot.capacity, retainedFromSequence });
    const scopeHash = contentRevision({ source: "process", filters });

    // Keyset pagination anchored on `sequence` rather than an array offset: appends land at
    // higher sequences, so an anchor keeps pointing at the same entry and pages never shift or
    // overlap. This is what makes the cursor append-safe.
    let before = Number.POSITIVE_INFINITY;
    if (cursor) {
      try {
        const token = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
        if (token.format !== pageFormat) throw new Error("shape");
        if (token.scope !== scopeHash) throw new HttpError(400, "日志分页游标不属于当前筛选条件", "INVALID_LOG_CURSOR", { nextAction: "read_first_page" });
        if (token.revision !== revision) {
          throw new HttpError(409, "日志窗口在分页期间变化（更早的条目已被容量挤出），请重读第一页", "LOG_PAGE_CHANGED", { currentRevision: revision, retainedFromSequence, nextAction: "read_first_page" });
        }
        if (!Number.isSafeInteger(token.before) || (token.before as number) < 1) throw new Error("shape");
        before = token.before as number;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "日志分页游标无效或不属于当前筛选", "INVALID_LOG_CURSOR");
      }
    }

    const candidates = Number.isFinite(before) ? matched.filter((entry) => entry.sequence < before) : matched;
    const entries = candidates.slice(0, limit) as SystemLogEntry[];
    // hasMore is about the remaining *matched* entries beyond this page, not about the buffer size.
    const hasMore = candidates.length > entries.length;
    const anchor = entries.length ? entries[entries.length - 1]!.sequence : 0;
    const levels = [...new Set(snapshot.entries.map((entry) => entry.level))].sort((left, right) => levelRank[left]! - levelRank[right]!);
    return {
      schemaVersion: 1, source: "process", revision, entries, total: matched.length, hasMore,
      ...(hasMore && anchor > 0 ? { nextCursor: Buffer.from(JSON.stringify({ format: pageFormat, scope: scopeHash, revision, before: anchor })).toString("base64url") } : {}),
      buffer: {
        capacity: snapshot.capacity,
        size: snapshot.size,
        dropped: snapshot.dropped,
        retainedFromSequence,
      },
      levelsAvailable: levels as LogLevel[],
      nextAction: "read_ops_log_or_narrow_filter",
    };
  }

  /** Which allowlisted ops files exist right now; used for `available`/`missing` reporting. */
  private async availableFiles(): Promise<LogOpsFile[]> {
    const found: LogOpsFile[] = [];
    for (const file of logOpsFiles) {
      try { if ((await stat(path.join(this.dataDirectory, file))).isFile()) found.push(file); }
      catch { /* absent or unreadable: reported through `available`, never as a hard failure */ }
    }
    return found;
  }

  private async readTailBytes(file: string, byteLimit: number) {
    const full = path.join(this.dataDirectory, file);
    const info = await stat(full);
    const start = Math.max(0, info.size - byteLimit);
    const length = info.size - start;
    const handle = await open(full, "r");
    try {
      const buffer = Buffer.alloc(length);
      // A single positional read may return short; loop until the window is filled or EOF.
      let read = 0;
      while (read < length) {
        const chunk = await handle.read(buffer, read, length - read, start + read);
        if (!chunk.bytesRead) break;
        read += chunk.bytesRead;
      }
      return { text: buffer.subarray(0, read).toString("utf8"), scannedWholeFile: start === 0, bytes: read };
    } finally { await handle.close(); }
  }

  async readOpsFile(query: OpsLogQuery): Promise<OpsLogPage> {
    // Validate BEFORE any filesystem access: an invalid `file` must be rejected on the contract,
    // not incidentally by a failed stat, so no caller can probe paths through error shapes.
    const parsed = opsLogQuery.safeParse(query);
    if (!parsed.success) throw new HttpError(400, "运维日志参数无效：file 必须是白名单内的文件名", "INVALID_OPS_LOG_REQUEST");
    const { file, tailLines, level, q } = parsed.data;
    const available = await this.availableFiles();

    let raw: { text: string; scannedWholeFile: boolean; bytes: number };
    try {
      raw = await this.readTailBytes(file, opsReadByteLimit);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        return { schemaVersion: 1, source: "ops", file, lines: [], totalLines: 0, tailLines, scannedWholeFile: true, scannedBytes: 0, complete: false, available, missing: true, truncated: false, nextAction: "read_process_buffer_or_narrow_filter" };
      }
      // A permission or IO failure is a real error, not an empty log.
      throw new HttpError(500, `运维日志读取失败（${file}）`, "OPS_LOG_READ_FAILED");
    }

    // A byte-window read can start mid-character and mid-line; drop the partial first line so we
    // never present a corrupted line as a complete one.
    const all = raw.text.split(/\r?\n/);
    const lines = raw.scannedWholeFile ? all : all.slice(1);
    // A trailing newline produces one empty final element; drop it rather than show a blank line.
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    // Windows tooling (and PowerShell's UTF-8 writers) may prefix the file with a BOM. Left in
    // place it makes the first line unparseable as JSON and shows up as a stray glyph in the UI,
    // so strip it from the head of the first line only.
    if (lines.length) lines[0] = lines[0]!.replace(/^\uFEFF/, "");
    const firstLineNumber = raw.scannedWholeFile ? 1 : 0;

    let truncated = false;
    const projected = lines.map((text, index) => {
      const redacted = redactLogText(text);
      const clipped = redacted.length > opsLineLimit;
      if (clipped) truncated = true;
      return { lineNumber: firstLineNumber + index, text: clipped ? redacted.slice(0, opsLineLimit) + "…[truncated]" : redacted, ...(clipped ? { truncated: true } : {}) };
    });

    const filtered = projected.filter((line) => {
      if (level && !new RegExp(`"level"\\s*:\\s*"${level}"`).test(line.text)) return false;
      if (q && !line.text.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
    // Keep the newest lines: the tail window is already the newest bytes, and the caller asked for N lines.
    const window = filtered.slice(Math.max(0, filtered.length - tailLines));
    return {
      schemaVersion: 1, source: "ops", file, lines: window, totalLines: filtered.length, tailLines,
      scannedWholeFile: raw.scannedWholeFile, scannedBytes: raw.bytes,
      // Only the whole-file, whole-window case is genuinely complete; everything else says so.
      complete: raw.scannedWholeFile && filtered.length <= tailLines,
      available, missing: false, truncated, nextAction: "read_process_buffer_or_narrow_filter",
    };
  }
}
