export type CodePackageStatus = "ok" | "error" | "disabled";

export interface CodePackageRow {
  source: "code";
  packageId: string;
  title: string;
  version: string;
  status: CodePackageStatus;
  error?: string;
  directory: string;
  entryPath: string;
  enabled: boolean;
  revision?: number;
  executor?: { sceneId: string; versionId: string } | null;
  inputs?: Array<Record<string, unknown>>;
}

export interface ConfigPackageRow {
  source: "config";
  id: string;
  title: string;
  revision?: number;
}

export type PackageCatalogRow = CodePackageRow | ConfigPackageRow;

/** 包列表合并：代码子工程优先，各自按标题排序。 */
export function mergePackageCatalog(
  config: ConfigPackageRow[],
  code: CodePackageRow[],
): PackageCatalogRow[] {
  const sortedCode = [...code].sort((a, b) => a.title.localeCompare(b.title));
  const sortedConfig = [...config].sort((a, b) => a.title.localeCompare(b.title));
  return [...sortedCode, ...sortedConfig];
}

/** 代码包加载状态展示（tone/label/detail）。 */
export function describeCodePackageStatus(
  status: CodePackageStatus,
  error?: string,
): { tone: CodePackageStatus; label: string; detail?: string } {
  switch (status) {
    case "ok":
      return { tone: "ok", label: "正常", detail: error };
    case "disabled":
      return { tone: "disabled", label: "已禁用", detail: error };
    case "error":
    default:
      return { tone: "error", label: "失败", detail: error };
  }
}

/** 执行场景必填校验（纯函数）。 */
export function executorSelectionError(sceneId: string, versionId: string): string {
  if (!sceneId) return "请选择执行场景";
  if (!versionId) return "请选择该场景的已发布版本";
  return "";
}

/** 跳运行记录：返回应筛选的 sceneId。 */
export function packageRunsFilter(row: PackageCatalogRow): { sceneId: string } | null {
  if (row.source !== "code") return null;
  const executor = (row as CodePackageRow).executor;
  if (!executor?.sceneId) return null;
  return { sceneId: executor.sceneId };
}

/** 输入契约 rows：package.json 字段 + 覆盖。 */
export function inputContractRows(
  manifestInputs: Array<Record<string, unknown>>,
  overrides: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  const byKey = new Map(overrides.map((item) => [String((item as any).key ?? ""), item]));
  return manifestInputs.map((field) => {
    const key = String((field as any).key ?? "");
    const override = byKey.get(key);
    if (!override) return field;
    return {
      ...field,
      ...(override.label !== undefined ? { label: override.label } : {}),
      ...(override.required !== undefined ? { required: override.required } : {}),
      ...(override.defaultValue !== undefined ? { defaultValue: override.defaultValue } : {}),
    };
  });
}

/**
 * 保存时送出的输入契约覆盖：只保留与 package.json 声明不同的字段。
 *
 * 全量送出会把「管理员没动过的默认值」固化进配置，之后改 package.json 的标签或必填
 * 就不再生效（配置优先于磁盘）。所以这里按字段逐项比对，只写真正改过的。
 */
export function inputOverridePayload(
  rows: Array<Record<string, unknown>>,
  manifestInputs: Array<Record<string, unknown>>,
): Array<{ key: string; label?: string; required?: boolean; defaultValue?: unknown }> {
  const manifestByKey = new Map(manifestInputs.map((field) => [String((field as any).key ?? ""), field as Record<string, unknown>]));
  const payload: Array<{ key: string; label?: string; required?: boolean; defaultValue?: unknown }> = [];
  for (const row of rows) {
    const key = String((row as any).key ?? "");
    if (!key) continue;
    const base = manifestByKey.get(key) ?? {};
    const item: { key: string; label?: string; required?: boolean; defaultValue?: unknown } = { key };
    const label = (row as any).label;
    if (typeof label === "string" && label !== "" && label !== base.label) item.label = label;
    const required = (row as any).required === true;
    if (required !== (base.required === true)) item.required = required;
    const defaultValue = (row as any).defaultValue;
    if (defaultValue !== undefined && defaultValue !== "" && defaultValue !== base.defaultValue) item.defaultValue = defaultValue;
    // 只保留至少一项覆盖的字段：纯 key 的行对配置没有意义。
    if (item.label !== undefined || item.required !== undefined || item.defaultValue !== undefined) payload.push(item);
  }
  return payload;
}
