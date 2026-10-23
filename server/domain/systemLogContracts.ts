import * as z from "zod/v4";

/**
 * Machine contract for the admin-only log viewer.
 *
 * Two sources, deliberately separated because they have different lifetimes and different
 * retention guarantees:
 *   - `process`: the bounded in-memory structured buffer fed by `log()`. Cleared on restart.
 *   - `ops`: read-only tails of a fixed allowlist of operational log files under the data
 *     directory (watchdog/server). These survive restarts but are plain text lines.
 *
 * Neither source accepts a caller-supplied path: `source` selects a named file from a
 * server-side allowlist, so this cannot become an arbitrary file-read proxy.
 */

export const logLevels = ["info", "warn", "error"] as const;
export const logSources = ["process", "ops"] as const;
/**
 * Named allowlist of operational log files under `APP_DATA_DIR`; the request only ever names a
 * member of this list, never a path. `watchdog.log`/`watchdog-server.log` are the documented
 * watchdog outputs (`docs/mcp-runtime.md`); the stdout/stderr pairs are how a detached
 * production server is started.
 */
export const logOpsFiles = ["watchdog.log", "watchdog-server.log", "server.stdout.log", "server.stderr.log", "zane-server.stdout.log", "zane-server.stderr.log"] as const;

export type LogLevelName = (typeof logLevels)[number];
export type LogSourceName = (typeof logSources)[number];
export type LogOpsFile = (typeof logOpsFiles)[number];

export const maximumLogLimit = 200;
export const defaultLogLimit = 50;
export const maximumLogTailLines = 2000;
export const defaultLogTailLines = 200;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

/** One captured structured entry. `fields` is already redacted; see server/observability/logRedaction.ts. */
export const systemLogEntrySchema = z.object({
  sequence: z.int().positive().describe("进程内自增序号，跨条目唯一且单调；缺号表示被容量挤出或按筛选跳过"),
  time: z.string().describe("日志写入时间（ISO 8601，UTC）"),
  level: z.enum(logLevels),
  event: z.string().describe("结构化事件名，例如 http.request、run.execution_failed、hermes.request_failed"),
  /** Redacted structured fields. Typed as unknown per key so the value projection stays honest:
   *  redaction guarantees JSON-serialisable output, but the shape is per-event and open. */
  fields: z.record(z.string(), z.unknown()).describe("该事件的结构化字段；凭证/密钥类键值已替换为[REDACTED]，超长值截断并置truncated"),
  truncated: z.boolean().optional().describe("true表示脱敏或长度预算对该条目做了可见裁剪，不是完整原值"),
}).strict();
export type SystemLogEntry = z.infer<typeof systemLogEntrySchema>;

/** One line of a whitelisted operational log file. */
export const systemLogOpsLineSchema = z.object({
  lineNumber: z.int().positive().describe("该文件内的1基行号；配合file用于继续读取。scannedWholeFile:false时只相对末尾字节窗口"),
  text: z.string().describe("行文本；已做凭证脱敏（保留密钥字段名与引号，因此结构化行仍是合法JSON），首行UTF-8 BOM已剥离，超长行截断并置truncated"),
  truncated: z.boolean().optional(),
}).strict();
export type SystemLogOpsLine = z.infer<typeof systemLogOpsLineSchema>;

export const systemLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(maximumLogLimit).default(defaultLogLimit).describe("单页条目数；默认50，最大200"),
  cursor: z.string().min(1).max(4096).optional().describe("上页nextCursor（按sequence定位的keyset锚点，追加安全）。游标绑定筛选条件，换筛选返回400 INVALID_LOG_CURSOR；更早条目被容量挤出时返回409 LOG_PAGE_CHANGED，重读第一页"),
  level: z.enum(logLevels).optional().describe("按最低等级过滤；省略返回全部已记录等级。进程缓冲的等级下限同时受ZANE_LOG_LEVEL约束"),
  event: boundedText(200).optional().describe("事件名筛选：前缀匹配（如run.匹配所有run.*事件），大小写不敏感"),
  excludeEvent: boundedText(1000).optional().describe("排除的事件名前缀，逗号分隔（如 http. 排除全部接口调用）；与 event 同时给出时先按 event 包含、再按 excludeEvent 排除。用于把「接口心跳」这类无业务内容的条目挡在外面，仍是服务端过滤，不是页面内筛选"),
  q: boundedText(200).optional().describe("关键字筛选：在事件名与已脱敏字段JSON中做大小写不敏感的子串匹配"),
  runId: z.string().regex(/^[a-f0-9-]{36}$/i).optional().describe("按运行ID关联筛选：匹配字段中的runId（含sourceRunId）。用于把一次运行的run.*/hermes.*/comfy.*日志聚到一起"),
  sceneId: boundedText(200).optional().describe("按场景ID关联筛选：匹配字段中的sceneId"),
  packageRunId: z.string().regex(/^[a-f0-9-]{36}$/i).optional().describe("按场景包运行ID筛选：匹配字段中的packageRunId。场景包内 log() 写入的 scene_package.log 事件带这个字段，用它能把一次包运行的全部日志（含它提交的子运行的包级日志）聚到一起；与 runId 同时给出时两个条件都要满足"),
}).strict();
export type SystemLogQuery = z.infer<typeof systemLogQuery>;

export const opsLogQuery = z.object({
  file: z.enum(logOpsFiles).describe("服务端白名单内的运维日志文件名；不接受任意路径，越界一律拒绝"),
  tailLines: z.coerce.number().int().min(1).max(maximumLogTailLines).default(defaultLogTailLines).describe("从文件末尾向前读取的行数；默认200，最大2000。只读尾部，不返回整份文件"),
  level: z.enum(logLevels).optional().describe("可选的行内等级过滤：按行文本中的\"level\":\"info|warn|error\"判断。非JSON行不受等级影响，仅在省略level时返回"),
  q: boundedText(200).optional().describe("关键字筛选：行文本子串匹配，大小写不敏感"),
}).strict();
export type OpsLogQuery = z.infer<typeof opsLogQuery>;

/** Aggregate view: both sources in one read so the admin page renders without two round trips. */
export const systemLogPageSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("process"),
  revision: z.string().regex(/^[a-f0-9]{64}$/).describe("窗口标识：覆盖来源、筛选条件、容量与最旧保留序号（不含条目集合）。读取本日志本身会追加http.request条目，所以revision刻意不随每次追加变化——所有页面追加安全；只有容量挤出改变了最旧保留边界时才变化并让旧游标409"),
  entries: z.array(systemLogEntrySchema),
  total: z.int().nonnegative().describe("当前筛选下的匹配总数（本次读取时刻）"),
  hasMore: z.boolean(),
  nextCursor: z.string().optional(),
  buffer: z.object({
    capacity: z.int().positive().describe("进程缓冲容量上限（ZANE_LOG_BUFFER_ENTRIES）"),
    size: z.int().nonnegative().describe("当前保留条目数"),
    dropped: z.int().nonnegative().describe("被容量挤出的条目总数；大于0表示更早的日志已不在缓冲中，不是没有产生"),
    retainedFromSequence: z.int().nonnegative().describe("当前保留的最小sequence；0表示缓冲为空"),
  }).strict(),
  levelsAvailable: z.array(z.enum(logLevels)).describe("本进程实际记录过的等级；受ZANE_LOG_LEVEL下限影响，缺失的等级表示未记录而不是无事件"),
  nextAction: z.literal("read_ops_log_or_narrow_filter"),
}).strict();
export type SystemLogPage = z.infer<typeof systemLogPageSchema>;

export const opsLogPageSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("ops"),
  file: z.enum(logOpsFiles),
  lines: z.array(systemLogOpsLineSchema),
  totalLines: z.int().nonnegative().describe("本次实际扫描到的行数。scannedWholeFile为false时这只是尾部字节窗口内的行数，不是文件总行数"),
  tailLines: z.int().positive().describe("本次请求的尾部窗口大小"),
  scannedWholeFile: z.boolean().describe("true表示从文件开头完整扫描；false表示文件超过服务端读取上限，只扫描了末尾字节窗口，totalLines与lineNumber都只相对该窗口"),
  scannedBytes: z.int().nonnegative().describe("本次读取的字节数，便于判断是否触达上限"),
  complete: z.boolean().describe("true表示返回内容确实是整份文件（完整扫描且行数不超过tailLines）；false表示只返回尾部窗口或在字节窗口内"),
  available: z.array(z.enum(logOpsFiles)).describe("本机数据目录中实际存在、可读的白名单日志文件"),
  missing: z.boolean().describe("true表示该文件当前不存在（例如服务尚未以该方式启动过）；不是读取失败"),
  truncated: z.boolean().describe("true表示有行因长度预算被裁剪；不静默截断"),
  nextAction: z.literal("read_process_buffer_or_narrow_filter"),
}).strict();
export type OpsLogPage = z.infer<typeof opsLogPageSchema>;
