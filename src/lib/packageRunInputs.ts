import type { RunInputFieldShape } from "../components/RunInputSnapshot";

export interface ReusableInputs {
  values: Record<string, unknown>;
  /** 丢弃字段的 key，按输入顺序。 */
  dropped: string[];
  /** 可直接展示给用户的一句话：带上了什么、丢了什么。 */
  notice: string;
}
type PackageField = { key: string; label: string; type: string; required: boolean; hidden: boolean; options?: string[]; minimum?: number; maximum?: number };

const mediaType = (type: string) => /^(image|video|audio)(_list)?$/.test(type);
const listType = (type: string) => /\[\]|_list|images|videos|audios/.test(type);
/** 服务端输入投影把媒体收窄成固定引用；只接受这个形状，不把 locatorOmitted 之类当成素材。 */
export function isReusableMediaReference(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.assetId === "string" && record.assetId.length > 0
    && Number.isSafeInteger(record.assetVersion) && Number(record.assetVersion) >= 1;
}
function mediaValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(mediaValues);
  return isReusableMediaReference(value) ? [{ assetId: (value as Record<string, unknown>).assetId, assetVersion: (value as Record<string, unknown>).assetVersion }] : [];
}
function usable(field: PackageField, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (mediaType(field.type)) return mediaValues(value).length > 0;
  if (field.type === "number") return typeof value === "number" && Number.isFinite(value)
    && (field.minimum === undefined || value >= field.minimum) && (field.maximum === undefined || value <= field.maximum);
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "select") return typeof value === "string" && (!field.options?.length || field.options.includes(value));
  if (field.type === "json") return typeof value === "object";
  return typeof value === "string";
}

/**
 * 把一次历史运行的原始输入转成「当前发布版可以直接预填」的值。
 *
 * 只保留当前发布版仍然声明、且类型/选项/范围仍然合法的字段：字段被删、类型变了、
 * 选项不在当前列表里，都丢弃而不是硬塞——否则创建页会显示一个提交时必然失败的表单。
 * 媒体只保留固定素材引用（assetId+assetVersion），复用同一版本而不重新上传。
 */
export function reusableInputs(inputs: RunInputFieldShape[], fields: PackageField[]): ReusableInputs {
  const declared = new Map(fields.map(field => [field.key, field]));
  const values: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const input of inputs) {
    // 值被省略（响应预算）时不能当作「用户没填」：宁可不预填，也不写一个错值。
    if (input.valueOmitted || !input.present) { if (input.present) dropped.push(input.key); continue; }
    const field = declared.get(input.key);
    if (!field) { dropped.push(input.key); continue; }
    if (mediaType(field.type)) {
      const media = mediaValues(input.value);
      if (!media.length) { dropped.push(input.key); continue; }
      values[field.key] = listType(field.type) ? media : media[0];
      continue;
    }
    if (!usable(field as PackageField, input.value)) { dropped.push(input.key); continue; }
    values[field.key] = input.value;
  }
  const kept = Object.keys(values).length;
  const notice = !kept && !dropped.length ? "这个服务没有可复用的输入字段。"
    : dropped.length ? `已带上 ${kept} 个字段；${dropped.length} 个字段在当前版本已不适用（${dropped.join("、")}），未带入。`
      : `已带上 ${kept} 个字段，可直接提交或再改。`;
  return { values, dropped, notice };
}
