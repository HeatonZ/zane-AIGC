/**
 * 任务 CSV 模板、导出与导入。
 *
 * 为什么不复用粘贴导入：粘贴导入把所有输入塞进一个 JSON 列，JSON 里的逗号会被 CSV 切断，
 * 过不了一轮 Excel 往返。CSV 走「宽表」——每个输入一列，表头是「字段名 [key]」，
 * 用 Excel/WPS 填完再导回来。两种入口共用同一套表头别名（taskImport.canonicalHeader）。
 */
import type { JsonValue, WorkflowInputField } from "../types";
import { canonicalHeader, PasteImportError, type ImportedTaskItem } from "./taskImport";

/** 固定列：名称/场景/发布版。其余列都按发布版输入字段展开。 */
export const CSV_LABEL_HEADER = "名称";
export const CSV_SCENE_HEADER = "场景ID";
export const CSV_VERSION_HEADER = "发布版ID";

/** Excel 在 Windows 上按本地编码读无 BOM 的 UTF-8：不加 BOM 中文会变乱码。 */
export const CSV_BOM = "\ufeff";

export interface CsvFieldSpec {
  key: string;
  label: string;
  type: WorkflowInputField["type"];
  required: boolean;
  /** 隐藏字段不放进模板：用户本就不该填，模板列越少越好填。 */
  hidden?: boolean;
  options?: readonly string[];
  inputMode?: "object_array";
  itemFields?: CsvFieldSource["itemFields"];
  minimum?: number;
  maximum?: number;
  /** 发布版默认值：模板预填用；媒体默认值不预填。 */
  defaultValue?: JsonValue;
}

export interface CsvSceneSpec {
  sceneId: string;
  versionId: string;
  title?: string;
  fields: readonly CsvFieldSpec[];
}

export interface CsvImportOptions {
  scenes: readonly CsvSceneSpec[];
  /** 行内没给场景/发布版时的默认值（来自页面上的默认场景下拉）。 */
  defaultSceneId?: string;
  defaultVersionId?: string;
}

/** 字段列表 → CSV 列规格：只保留该填的字段。 */
export function csvColumnsOf(fields: readonly CsvFieldSpec[]): CsvFieldSpec[] {
  return fields.filter(field => !field.hidden);
}

/**
 * 生成 CSV 列规格所需的最小字段形状。
 * 不直接用客户端 WorkflowInputField：服务端发布快照的 inputs（RunInputField）没有 label，
 * 标题来自 inputSchema.properties[].title。用结构类型避免为了满足类型而编造 label。
 */
export interface CsvFieldSource {
  key: string;
  type: string;
  label?: string;
  required?: boolean;
  hidden?: boolean;
  options?: readonly string[];
  inputMode?: "object_array";
  /** 对象数组的行字段；服务端 RunInputField 与客户端 WorkflowInputField 两边都用结构类型兼容。 */
  itemFields?: readonly { key: string; label?: string; type: string; required?: boolean; minimum?: number; maximum?: number; options?: readonly string[]; placeholder?: string }[];
  minimum?: number;
  maximum?: number;
  /**
   * 用 unknown 而不是 JsonValue：服务端 server/domain/types 与客户端 src/types 各有一份
   * 结构相同但名义不同的 JsonValue，直接引用任一份都会让另一边赋值失败。
   */
  defaultValue?: unknown;
  placeholder?: string;
}

/**
 * 发布版输入字段 → CSV 列规格。抽成纯函数是为了能单测：
 * 漏掉 hidden/options/minimum/maximum/defaultValue 中任何一项，
 * 都会让模板少列或让导入校验放水，而这类遗漏在页面里看不出来。
 * title 来自 inputSchema.properties[].title，优先于字段自带 label。
 */
export function toCsvFieldSpec(field: CsvFieldSource, title?: string): CsvFieldSpec {
  return {
    key: field.key,
    label: title || field.label || field.key,
    type: field.type as WorkflowInputField["type"],
    required: Boolean(field.required),
    ...(field.hidden ? { hidden: true } : {}),
    ...(field.options ? { options: field.options } : {}),
    ...(field.inputMode ? { inputMode: field.inputMode } : {}),
    ...(field.itemFields ? { itemFields: field.itemFields } : {}),
    ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
    ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
    ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue as JsonValue } : {}),
  };
}

/** 表头文本：`字段名 [key]`。同时带上人看的名字和机器认的 key。 */
export function fieldHeader(field: Pick<CsvFieldSpec, "key" | "label">): string {
  return (field.label || field.key) + " [" + field.key + "]";
}

/** RFC4180 转义：含逗号/引号/换行或首尾空格时加引号，内部引号翻倍。 */
export function csvEscape(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}

export function csvRow(cells: readonly string[]): string {
  return cells.map(csvEscape).join(",");
}

/** 值 → 单元格文本。媒体与对象数组写成 JSON，靠引号转义安全穿过 CSV。 */
export function cellOfValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * 解析 RFC4180 CSV。引号内的逗号、换行、双引号都被正确保留——
 * 这是模板能用 Excel 往返的前提，也是不能靠 split(",") 的原因。
 */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\ufeff/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false;
  const endCell = () => { row.push(cell); cell = ""; started = false; };
  const endRow = () => { endCell(); rows.push(row); row = []; };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { cell += '"'; index += 1; } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"' && cell === "") { quoted = true; started = true; continue; }
    if (char === ",") { endCell(); continue; }
    if (char === "\r") continue;
    if (char === "\n") { endRow(); continue; }
    cell += char; started = true;
  }
  // 最后一行没有换行结尾时也要收尾；整行空白的行丢弃，避免模板末尾空行变成空任务项。
  if (cell !== "" || started || row.length) endRow();
  return rows.filter(cells => cells.some(value => value.trim() !== ""));
}

interface ResolvedColumn {
  index: number;
  kind: "label" | "sceneId" | "versionId" | "input";
  /** 输入列的字段 key；表头认不出时留空，按行内场景再匹配。 */
  key?: string;
  header: string;
}

/** 表头 → 列；输入列优先取 `[key]`，其次精确 key，最后按字段名匹配。 */
function resolveColumns(headerCells: readonly string[], knownKeys: readonly string[]): ResolvedColumn[] {
  const known = new Set(knownKeys);
  return headerCells.map((raw, index) => {
    const header = raw.trim();
    const alias = canonicalHeader(header);
    if (alias === "label") return { index, kind: "label" as const, header };
    if (alias === "sceneId") return { index, kind: "sceneId" as const, header };
    if (alias === "versionId") return { index, kind: "versionId" as const, header };
    if (alias === "inputs") return { index, kind: "input" as const, header };
    const bracketed = /\[([^\]]+)\]\s*$/.exec(header);
    const candidate = (bracketed?.[1] ?? header).trim();
    return { index, kind: "input" as const, header, ...(known.has(candidate) ? { key: candidate } : {}) };
  });
}

/** 单元格 → 该字段的值。空单元格返回 undefined，表示「沿用发布版默认值」。 */
function valueOfCell(cell: string, field: CsvFieldSpec): JsonValue | undefined {
  const text = cell.trim();
  if (text === "") return undefined;
  if (/image|video|audio/.test(field.type)) {
    if (!/^[[{]/.test(text)) return text;
    try { return JSON.parse(text) as JsonValue; }
    catch { throw new Error("媒体值不是合法 JSON（请从素材库复制固定版本引用）"); }
  }
  if (field.inputMode === "object_array") {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("不是合法 JSON 数组"); }
    if (!Array.isArray(parsed)) throw new Error("必须是 JSON 数组");
    return parsed as JsonValue;
  }
  if (field.type === "json") {
    try { return JSON.parse(text) as JsonValue; } catch { throw new Error("不是合法 JSON"); }
  }
  if (field.type === "boolean") {
    if (/^(true|1|是|y|yes)$/i.test(text)) return true;
    if (/^(false|0|否|n|no)$/i.test(text)) return false;
    throw new Error("布尔值请填 true/false（或 是/否）");
  }
  if (field.type === "number") {
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error("不是合法数字");
    if (field.minimum !== undefined && value < field.minimum) throw new Error("小于最小值 " + field.minimum);
    if (field.maximum !== undefined && value > field.maximum) throw new Error("大于最大值 " + field.maximum);
    return value;
  }
  if (field.type === "select" && field.options?.length && !field.options.includes(text)) {
    throw new Error("只能是：" + field.options.join(" / "));
  }
  return text;
}

/**
 * CSV → 任务项。每一行先确定自己的场景与发布版，再只解释「属于该场景」的输入列；
 * 行里填了别的场景的列会明确报错，而不是静默丢弃——静默丢弃会让人以为值生效了。
 */
export function parseTaskItemsCsv(text: string, options: CsvImportOptions): ImportedTaskItem[] {
  const rows = parseCsv(text);
  if (!rows.length) throw new PasteImportError("CSV 是空的；请先导出模板再填写");
  if (rows.length < 2) throw new PasteImportError("只有表头没有数据行");
  const knownKeys = [...new Set(options.scenes.flatMap(scene => scene.fields.map(field => field.key)))];
  const columns = resolveColumns(rows[0], knownKeys);

  return rows.slice(1).map((row, index) => {
    const line = index + 2;
    const cellAt = (column: ResolvedColumn) => (row[column.index] ?? "").trim();
    const pick = (kind: ResolvedColumn["kind"]) => {
      const column = columns.find(item => item.kind === kind);
      return column ? cellAt(column) : "";
    };
    const label = pick("label") || "第 " + (index + 1) + " 项";
    const sceneId = pick("sceneId") || options.defaultSceneId || "";
    const versionId = pick("versionId") || options.defaultVersionId || "";
    if (!sceneId) throw new PasteImportError("第 " + line + " 行没有场景；请填写场景 ID 或先在页面上选择默认场景", line);
    const scene = options.scenes.find(candidate => candidate.sceneId === sceneId);
    if (!scene) throw new PasteImportError("第 " + line + " 行的场景 “" + sceneId + "” 不在当前已发布场景里", line);
    if (!versionId) throw new PasteImportError("第 " + line + " 行没有发布版本；请填写发布版 ID 或先在页面上选择默认场景", line);
    if (versionId !== scene.versionId) throw new PasteImportError("第 " + line + " 行的发布版 “" + versionId + "” 不是场景 “" + sceneId + "” 的当前发布版（应为 " + scene.versionId + "）", line);

    const inputValues: Record<string, JsonValue> = {};
    for (const column of columns) {
      if (column.kind !== "input") continue;
      const raw = cellAt(column);
      if (raw === "") continue;
      // 表头阶段认不出 key 时，按该场景的字段名再匹配一次。
      const field = column.key
        ? scene.fields.find(candidate => candidate.key === column.key)
        : scene.fields.filter(candidate => (candidate.label || candidate.key) === column.header).at(0);
      if (!field) {
        const belongsElsewhere = options.scenes.some(other => other.sceneId !== sceneId && other.fields.some(candidate => candidate.key === column.key));
        throw new PasteImportError("第 " + line + " 行的列 “" + column.header + "” " + (belongsElsewhere ? "属于别的场景，本行场景 “" + sceneId + "” 没有这个输入" : "不是该场景的输入字段"), line);
      }
      try {
        const value = valueOfCell(raw, field);
        if (value !== undefined) inputValues[field.key] = value;
      } catch (reason) {
        throw new PasteImportError("第 " + line + " 行的列 “" + column.header + "”：" + (reason as Error).message, line);
      }
    }
    return { label, sceneId, versionId, inputValues };
  });
}

/**
 * 表头行：固定三列 + 给定场景的输入列并集。
 * 传进来的 scenes 必须是「这次真正要用的场景」——传全部已发布场景会把几十个
 * 无关字段一起写进表头，表格没法填。模板按所选场景收窄，导出按实际用到的场景收窄。
 */
function headerOf(scenes: readonly CsvSceneSpec[]): { cells: string[]; fields: CsvFieldSpec[] } {
  const seen = new Set<string>();
  const fields: CsvFieldSpec[] = [];
  for (const scene of scenes) {
    for (const field of csvColumnsOf(scene.fields)) {
      if (seen.has(field.key)) continue;
      seen.add(field.key);
      fields.push(field);
    }
  }
  return { cells: [CSV_LABEL_HEADER, CSV_SCENE_HEADER, CSV_VERSION_HEADER, ...fields.map(fieldHeader)], fields };
}

/**
 * 导出已有任务项：列只取这些项真正用到的场景。
 * items 里的项可能各自指向不同场景，所以按 sceneId 收窄，再取并集；
 * 不能直接用传入的全部场景，否则会带出大量当前任务用不到的字段。
 */
export function serializeTaskItemsCsv(items: readonly { label?: string; sceneId: string; versionId: string; inputValues?: Record<string, JsonValue> }[], scenes: readonly CsvSceneSpec[]): string {
  const used = new Set(items.map(item => item.sceneId));
  // 项引用了未知场景时（例如场景已被取消发布）退回全部场景，宁可多列也不要少列。
  const relevant = scenes.filter(scene => used.has(scene.sceneId));
  const { cells, fields } = headerOf(relevant.length ? relevant : scenes);
  const lines = [csvRow(cells)];
  items.forEach((item, index) => {
    const values = item.inputValues ?? {};
    lines.push(csvRow([
      item.label?.trim() || "第 " + (index + 1) + " 项",
      item.sceneId,
      item.versionId,
      ...fields.map(field => cellOfValue(values[field.key])),
    ]));
  });
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}

/**
 * 生成模板。
 * - 指定 sceneId：只输出那个场景的列，生成 rowCount 行，预填场景/发布版与非媒体默认值，
 *   方便「一个场景连续出几十张」。
 * - 不指定：每个已发布场景一行，列取所有场景的并集（跨场景任务才需要这么多列）。
 * 媒体列一律留空：示例不伪造素材引用，必须从素材库选固定版本。
 */
export function buildTaskTemplateCsv(options: { scenes: readonly CsvSceneSpec[]; sceneId?: string; rowCount?: number }): string {
  const { scenes } = options;
  if (!scenes.length) throw new PasteImportError("没有可用的已发布场景，无法生成模板");
  const chosen = options.sceneId ? scenes.find(scene => scene.sceneId === options.sceneId) : undefined;
  if (options.sceneId && !chosen) throw new PasteImportError("指定的场景不在当前已发布场景里");
  // 指定场景时刻意只用它自己的列：带上其他场景的字段会让表头塞进几十个填不到的列。
  const { cells, fields } = headerOf(chosen ? [chosen] : scenes);
  const lines = [csvRow(cells)];
  const defaultsOf = (scene: CsvSceneSpec) => Object.fromEntries(scene.fields.filter(field => field.defaultValue !== undefined).map(field => [field.key, field.defaultValue]));
  const rowOf = (scene: CsvSceneSpec, label: string, values: Record<string, JsonValue | undefined>) => csvRow([
    label,
    scene.sceneId,
    scene.versionId,
    ...fields.map(field => /image|video|audio/.test(field.type) ? "" : cellOfValue(values[field.key])),
  ]);

  if (chosen) {
    const count = Math.max(1, Math.min(options.rowCount ?? 10, 200));
    const defaults = defaultsOf(chosen) as Record<string, JsonValue | undefined>;
    for (let index = 1; index <= count; index += 1) lines.push(rowOf(chosen, "第 " + index + " 项", defaults));
  } else {
    scenes.forEach(scene => lines.push(rowOf(scene, "示例：" + (scene.title || scene.sceneId), defaultsOf(scene) as Record<string, JsonValue | undefined>)));
  }
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}
