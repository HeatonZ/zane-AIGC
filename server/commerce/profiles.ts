import { asRecord } from "../domain/workflowValues.js";

export interface CommerceProfile {
  id: string;
  name: string;
  width: number;
  height: number;
  safeMargin: number;
  whiteHero: boolean;
  showText: boolean;
}

// Design/export presets, not a claim that every category or placement accepts them.
export const commerceProfiles: CommerceProfile[] = [
  { id: "taobao", name: "淘宝 / 天猫", width: 1600, height: 1600, safeMargin: 80, whiteHero: false, showText: true },
  { id: "jd", name: "京东", width: 1600, height: 1600, safeMargin: 80, whiteHero: false, showText: true },
  { id: "pdd", name: "拼多多", width: 1200, height: 1200, safeMargin: 60, whiteHero: false, showText: true },
  { id: "douyin", name: "抖音电商", width: 1200, height: 1200, safeMargin: 72, whiteHero: false, showText: true },
  { id: "xiaohongshu", name: "小红书", width: 1242, height: 1656, safeMargin: 80, whiteHero: false, showText: true },
  { id: "amazon", name: "Amazon", width: 2000, height: 2000, safeMargin: 100, whiteHero: true, showText: true },
];

const combinations: Record<string, string[]> = {
  "国内三平台（淘宝/京东/抖音）": ["taobao", "jd", "douyin"],
  "国内五平台（含拼多多/小红书）": ["taobao", "jd", "pdd", "douyin", "xiaohongshu"],
  "全部六平台（含Amazon）": commerceProfiles.map((profile) => profile.id),
  ...Object.fromEntries(commerceProfiles.map((profile) => [profile.name, [profile.id]])),
  "自定义平台": [],
};

function dimension(value: unknown, fallback: number | undefined, label: string) {
  const number = value === undefined ? fallback : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 600 || number > 4000) throw new Error(`${label}必须是600–4000之间的整数`);
  return number;
}

export function selectCommerceProfiles(preset: unknown, overrides: unknown): CommerceProfile[] {
  const ids = typeof preset === "string" ? combinations[preset] ?? (commerceProfiles.some((profile) => profile.id === preset) ? [preset] : undefined) : undefined;
  if (!ids) throw new Error("目标平台组合无效");
  if (overrides !== null && overrides !== undefined && !Array.isArray(overrides)) throw new Error("平台配置覆盖需要JSON数组");
  const custom = (overrides ?? []) as unknown[];
  if (custom.length > 12) throw new Error("平台配置最多12项");
  const seen = new Set<string>();
  const merged = new Map(commerceProfiles.map((profile) => [profile.id, { ...profile }]));
  const customIds: string[] = [];
  for (const value of custom) {
    const item = asRecord(value);
    if (!item || typeof item.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(item.id) || seen.has(item.id)) throw new Error("平台ID必须唯一，且只含小写字母、数字、下划线或横线");
    seen.add(item.id);
    const base = merged.get(item.id);
    const width = dimension(item.width, base?.width, `${item.id}宽度`);
    const height = dimension(item.height, base?.height, `${item.id}高度`);
    const safeMargin = item.safeMargin ?? base?.safeMargin ?? Math.round(Math.min(width, height) * .05);
    if (typeof safeMargin !== "number" || !Number.isSafeInteger(safeMargin) || safeMargin < 0 || safeMargin > Math.min(width, height) / 4) throw new Error("安全留白必须是0至短边四分之一之间的整数");
    const name = item.name ?? base?.name;
    if (typeof name !== "string" || !name.trim() || name.length > 60) throw new Error("自定义平台需要名称（最多60字）");
    for (const flag of ["showText", "whiteHero"]) if (item[flag] !== undefined && typeof item[flag] !== "boolean") throw new Error(`${flag}必须是布尔值`);
    // Amazon hero suppression is a safety constraint, not an editable text toggle.
    merged.set(item.id, { id: item.id, name: name.trim(), width, height, safeMargin, showText: item.showText as boolean ?? base?.showText ?? true, whiteHero: item.id === "amazon" || (item.whiteHero as boolean ?? base?.whiteHero ?? false) });
    customIds.push(item.id);
  }
  const selected = preset === "自定义平台" ? customIds : ids;
  if (!selected.length) throw new Error("至少配置一个目标平台");
  return selected.map((id) => merged.get(id)!);
}

export const commerceShots = ["hero", "selling_point", "detail", "lifestyle", "specs", "package"] as const;
export type CommerceShotId = typeof commerceShots[number];
export const commerceShotLabels: Record<CommerceShotId, string> = { hero: "主视觉", selling_point: "卖点展示", detail: "商品细节", lifestyle: "使用场景", specs: "规格参数", package: "包装清单" };
export function commerceShotId(value: unknown): CommerceShotId {
  const id = typeof value === "string" ? value : asRecord(value)?.id;
  if (!commerceShots.includes(id as CommerceShotId)) throw new Error("套图清单含未知类型；只支持hero/selling_point/detail/lifestyle/specs/package");
  return id as CommerceShotId;
}
export function validateCommerceShots(value: unknown): CommerceShotId[] {
  if (!Array.isArray(value) || !value.length || value.length > 6) throw new Error("套图清单需要1–6项JSON数组");
  const ids = value.map(commerceShotId);
  if (new Set(ids).size !== ids.length) throw new Error("套图清单不能重复");
  return ids;
}
