/**
 * 粘贴导入解析：把「一行一项」的表格文本转成任务项草稿。
 * 纯函数、无副作用，便于单测；解析失败必须明确报出第几行，不静默丢弃。
 */
export interface ImportedTaskItem { label: string; sceneId: string; versionId: string; inputValues: Record<string, unknown> }

export interface PasteImportOptions {
  /** 默认场景与发布版：粘贴文本只给每项的差异输入时使用。 */
  defaultSceneId: string;
  defaultVersionId: string;
  /** 已发布场景的可选 ID 集合；用于校验每行显式给出的场景。 */
  knownSceneIds: readonly string[];
}

export class PasteImportError extends Error {
  constructor(message: string, public readonly line?: number) { super(message); }
}

/**
 * 提交前清理任务项：把「未填写」表达为缺键，而不是显式空串/null。
 * 否则表单里没碰过的字段会覆盖掉发布版默认值，必填字段还会被误判为空。
 * 输入只要求 label 可有可无（表单里常留空），值类型由调用方决定并原样保留。
 */
export function cleanTaskItemInputs<T>(items: readonly { label?: string; sceneId: string; versionId: string; inputValues?: Record<string, T> }[]): Array<{ label?: string; sceneId: string; versionId: string; inputValues: Record<string, T> }> {
  return items.map(item => ({
    ...(item.label?.trim() ? { label: item.label.trim() } : {}),
    sceneId: item.sceneId,
    versionId: item.versionId,
    inputValues: Object.fromEntries(Object.entries(item.inputValues ?? {}).filter(([, value]) => value !== undefined && value !== "")) as Record<string, T>,
  }));
}

/** 表头别名：允许中英文与常见写法，降低粘贴 Excel/表格的成本。 */
const HEADER_ALIASES: Record<string, string> = {
  label: "label", 名称: "label", 标签: "label", 项: "label", 序号: "label",
  sceneid: "sceneId", scene: "sceneId", 场景: "sceneId", 场景id: "sceneId",
  versionid: "versionId", version: "versionId", 发布版: "versionId", 发布版本: "versionId", 版本: "versionId", 发布版id: "versionId", 版本id: "versionId",
  inputs: "inputs", inputvalues: "inputs", 输入: "inputs", 参数: "inputs",
};
/** 表头归一化的唯一实现：粘贴导入与 CSV 导入必须用同一套别名，否则两种入口行为不一致。 */
export function canonicalHeader(value: string) {
  return HEADER_ALIASES[value.trim().toLowerCase().replace(/[\s_-]/g, "")];
}

/**
 * 解析规则：
 * - 空行跳过；以 # 开头的行视为注释。
 * - 含制表符的行按 Tab 分列；否则整行视为一个输入值（label 自动编号）。
 * - 第一行若所有列都是已知表头，则作为表头；否则按位置理解为 [label, 场景, 发布版, 输入]。
 * - 输入列是 JSON 对象（每项的 inputValues）；不是对象时按字符串放进 `text` 键，便于纯文本批量场景。
 */
export function parseTaskItemsPaste(text: string, options: PasteImportOptions): ImportedTaskItem[] {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  if (!lines.length) throw new PasteImportError("没有可导入的内容；每行一项，用 Tab 分隔列");
  const cells = lines.map(line => line.includes("\t") ? line.split("\t").map(cell => cell.trim()) : [line]);
  const headerCells = cells[0].map(canonicalHeader);
  const hasHeader = headerCells.every(Boolean) && new Set(headerCells).size === headerCells.length;
  const columns = hasHeader ? headerCells as string[] : ["label", "sceneId", "versionId", "inputs"];
  const body = hasHeader ? cells.slice(1) : cells;
  if (!body.length) throw new PasteImportError("只有表头没有数据行");

  return body.map((row, index) => {
    // 行号按原文本计：报错时用户能直接定位到粘贴内容里的那一行。
    const line = lines.indexOf(lines[index]) + (hasHeader ? 2 : 1);
    const cell = (key: string) => {
      const at = columns.indexOf(key);
      return at < 0 ? "" : row[at] ?? "";
    };
    const label = cell("label") || "第 " + (index + 1) + " 项";
    const sceneId = cell("sceneId") || options.defaultSceneId;
    const versionId = cell("versionId") || options.defaultVersionId;
    if (!sceneId) throw new PasteImportError("第 " + line + " 行没有场景；请在表格里填写场景 ID 或先选择默认场景", line);
    if (options.knownSceneIds.length && !options.knownSceneIds.includes(sceneId)) throw new PasteImportError("第 " + line + " 行的场景 “" + sceneId + "” 不在当前已发布场景里", line);
    if (!versionId) throw new PasteImportError("第 " + line + " 行没有发布版本；请先在左侧选择默认场景，或在表格里填写发布版本 ID", line);
    const raw = cell("inputs");
    let inputValues: Record<string, unknown> = {};
    if (raw) {
      if (raw.startsWith("{")) {
        try { inputValues = JSON.parse(raw) as Record<string, unknown>; }
        catch { throw new PasteImportError("第 " + line + " 行的输入不是合法 JSON", line); }
        if (!inputValues || typeof inputValues !== "object" || Array.isArray(inputValues)) throw new PasteImportError("第 " + line + " 行的输入必须是 JSON 对象", line);
      } else {
        // 非 JSON 的单元格按纯文本处理：常见于「一行一个提示词」的批量场景。
        inputValues = { text: raw };
      }
    }
    return { label, sceneId, versionId, inputValues };
  });
}
