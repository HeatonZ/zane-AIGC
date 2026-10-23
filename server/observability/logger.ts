import { redactLogFields } from "./logRedaction.js";

export interface LogFields { [key: string]: unknown }
const levelOrder = { info: 0, warn: 1, error: 2 } as const;
export type LogLevel = keyof typeof levelOrder;
// ZANE_LOG_LEVEL=warn|error suppresses noisier levels; unknown values keep info.
// Console output and the in-memory buffer share this floor, so the admin log viewer
// shows exactly the levels this process was asked to emit — no second filter to drift.
const configured = (process.env.ZANE_LOG_LEVEL ?? "").toLowerCase() as LogLevel;
const minimum = levelOrder[configured] ?? levelOrder.info;

const defaultCapacity = 2000;
const minimumCapacity = 100;
const maximumCapacity = 20_000;

/** One captured line. `fields` is already redacted and length-bounded. */
export interface LogEntry {
  sequence: number;
  time: string;
  level: LogLevel;
  event: string;
  fields: LogFields;
  /** true when redaction or the entry/field budget visibly cut something. */
  truncated?: boolean;
}

export interface LogBufferSnapshot {
  capacity: number;
  size: number;
  /** Evicted-by-capacity count, so a reader can tell the window is not the whole history. */
  dropped: number;
  entries: LogEntry[];
}

/**
 * Process-local bounded structured log buffer.
 *
 * Deliberately not persisted: this keeps the feature free of a new SQLite table, its retention
 * policy and its write amplification, and matches the existing `RunMetricsTracker` precedent
 * (in-process, cleared on restart). The gap is stated to callers rather than hidden: `dropped`
 * counts evictions and `sequence` is monotonic, so a reader can detect trimmed history.
 */
export class LogBuffer {
  private readonly entries: LogEntry[] = [];
  private sequence = 0;
  private dropped = 0;
  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("日志缓冲容量必须是正整数");
  }
  append(level: LogLevel, event: string, fields: LogFields = {}): LogEntry {
    const { fields: projected, truncated } = redactLogFields(fields);
    const entry: LogEntry = { sequence: ++this.sequence, time: new Date().toISOString(), level, event, fields: projected, ...(truncated ? { truncated: true } : {}) };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.dropped += this.entries.length - this.capacity;
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    return entry;
  }
  /** Copy out, so callers can neither mutate the buffer nor pin it while filtering. */
  snapshot(): LogBufferSnapshot {
    return { capacity: this.capacity, size: this.entries.length, dropped: this.dropped, entries: [...this.entries] };
  }
}

function bufferCapacity() {
  const numeric = Number(process.env.ZANE_LOG_BUFFER_ENTRIES);
  return Number.isSafeInteger(numeric) && numeric >= minimumCapacity && numeric <= maximumCapacity ? numeric : defaultCapacity;
}

/** Composition-root singleton: every existing `log()` call site feeds it without being touched. */
export const systemLogBuffer = new LogBuffer(bufferCapacity());

export function log(level: LogLevel, event: string, fields: LogFields = {}) {
  if (levelOrder[level] < minimum) return;
  const entry = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(entry); else if (level === "warn") console.warn(entry); else console.log(entry);
  systemLogBuffer.append(level, event, fields);
}
