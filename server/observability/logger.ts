export interface LogFields { [key: string]: unknown }
const levelOrder = { info: 0, warn: 1, error: 2 } as const;
export type LogLevel = keyof typeof levelOrder;
// ZANE_LOG_LEVEL=warn|error suppresses noisier levels; unknown values keep info.
const configured = (process.env.ZANE_LOG_LEVEL ?? "").toLowerCase() as LogLevel;
const minimum = levelOrder[configured] ?? levelOrder.info;
export function log(level: LogLevel, event: string, fields: LogFields = {}) {
  if (levelOrder[level] < minimum) return;
  const entry = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(entry); else if (level === "warn") console.warn(entry); else console.log(entry);
}
