export interface LogFields { [key: string]: unknown }
export function log(level: "info" | "warn" | "error", event: string, fields: LogFields = {}) {
  const entry = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(entry); else if (level === "warn") console.warn(entry); else console.log(entry);
}
