/**
 * 任务表格的输入预填：把发布版输入契约变成「可以直接改的行」。
 *
 * 场景发布后，get_scene 已经返回了 inputDefaults / inputRequirements[].needsValue /
 * missingRequiredInputs / inputExamples。任务页要用的是同一份契约，不能自己再猜一遍默认值，
 * 否则表里看到的和服务端实际执行用的会不一致。
 */
import type { JsonValue, WorkflowInputField } from "../types";
import { mediaItemsOf } from "./mediaInput";

/** 与服务端一致的空值判定：空串、null、undefined、空媒体列表、空对象数组都算没填。 */
export function isEmptyInputValue(field: WorkflowInputField, value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (isMediaField(field) && mediaItemsOf(value).length === 0) return true;
  if (field.inputMode === "object_array" && Array.isArray(value) && value.length === 0) return true;
  return false;
}

export function isMediaField(field: WorkflowInputField): boolean {
  return /image|video|audio/.test(field.type);
}

export function mediaKindOf(field: WorkflowInputField): "image" | "video" | "audio" {
  return /audio/.test(field.type) ? "audio" : /video/.test(field.type) ? "video" : "image";
}

export function isMultipleMedia(field: WorkflowInputField): boolean {
  return /\[\]|_list|images|videos|audios/.test(field.type);
}

/**
 * 新任务项的初始输入：直接采用发布版默认值。
 * 这样表里显示的就是服务端实际会用的值，而不是让人以为「空着等于没有」。
 */
export function prefillInputValues(fields: readonly WorkflowInputField[]): Record<string, JsonValue> {
  return Object.fromEntries(fields.flatMap(field => field.defaultValue !== undefined ? [[field.key, structuredClone(field.defaultValue) as JsonValue]] : []));
}

/**
 * 按发布版的 inputExamples 填充一行：示例里没有的字段保持缺键，
 * 让服务端继续用发布版默认值，而不是用示例占位文本覆盖掉真实默认值。
 */
export function applyExampleValues(fields: readonly WorkflowInputField[], example: Record<string, JsonValue> | undefined): Record<string, JsonValue> {
  if (!example) return {};
  const known = new Set(fields.map(field => field.key));
  return Object.fromEntries(Object.entries(example).filter(([key, value]) => known.has(key) && value !== undefined).map(([key, value]) => [key, structuredClone(value) as JsonValue]));
}

/** 任务页可编辑表格的一行：与服务端任务项同形，便于往返。 */
export interface TaskRow { label?: string; sceneId: string; versionId: string; inputValues: Record<string, JsonValue> }

/**
 * 服务端任务项 → 表格行。
 *
 * 打开草稿与「创建成功」都必须用它把回执里的项读回表格：新建和草稿详情共用同一张
 * 可编辑表格，创建后若把表单重置成一行默认值，用户会以为自己刚填的内容被丢掉了。
 * 服务端已把发布版默认值与用户输入合并后落库，这里原样呈现，不重新推默认值。
 *
 * inputValues 用 unknown 接收：服务端 server/domain 与客户端 src 各有一份结构相同
 * 但名义不同的 JsonValue，直接引用任一份都会让另一边赋值失败（与 taskCsv 同一处理）。
 */
export function rowsOfTaskItems(items: readonly { label?: string; sceneId: string; versionId: string; inputValues?: Record<string, unknown> }[]): TaskRow[] {
  return items.map(item => ({
    label: item.label ?? "",
    sceneId: item.sceneId,
    versionId: item.versionId,
    // 深拷贝：行会被就地改写，不能和 selected 快照共享引用。
    inputValues: structuredClone(item.inputValues ?? {}) as Record<string, JsonValue>,
  }));
}

/**
 * 发布版契约的展示阶段。
 *
 * 关键：必须把「还在读取」「读取失败」与「读取完成、但这个发布版没有任何输入字段」
 * 三者分开。已发布的工作流可以没有输入字段（合法配置），此时 fields 是空数组；
 * 只看 fields.length 会把它永远显示成「正在读取」，看起来就像页面卡住了。
 * 读取失败同样没有缓存，所以必须先判失败再判有没有契约，否则失败也永远停在「读取中」。
 *
 * 返回带契约的判别联合，调用方按 phase 分支后就能直接拿到非空的 contract。
 */
export type ContractState<C> =
  | { phase: "no_scene" }
  | { phase: "loading" }
  | { phase: "failed"; error: string }
  | { phase: "empty"; contract: C }
  | { phase: "ready"; contract: C };

export function contractState<C extends { fields: readonly unknown[]; error?: string }>(input: { hasScene: boolean; contract?: C }): ContractState<C> {
  if (!input.hasScene) return { phase: "no_scene" };
  if (!input.contract) return { phase: "loading" };
  if (input.contract.error) return { phase: "failed", error: input.contract.error };
  return input.contract.fields.length ? { phase: "ready", contract: input.contract } : { phase: "empty", contract: input.contract };
}

/**
 * 这一行还差什么：用于创建前把「缺哪个字段」直接说清楚，
 * 而不是等确认提交后才从服务端错误里逐个试。
 *
 * 优先用服务端算好的 needsValue（inputRequirements[].needsValue）：它还能发现
 * 「有默认值、但该默认值本身不满足契约」这类前端推不出来的情况——此时把默认值原样
 * 提交仍然会失败，所以「等于发布版默认值」也算没填。没有服务端数据时回退到
 * required + 空值判定。填成别的有效值后提示即消失。
 */
export function rowMissingInputs(fields: readonly WorkflowInputField[], values: Record<string, JsonValue>, options: { hiddenKeys?: readonly string[]; needsValueKeys?: readonly string[] } = {}): string[] {
  const hidden = new Set(options.hiddenKeys ?? []);
  const authoritative = options.needsValueKeys ? new Set(options.needsValueKeys) : undefined;
  return fields
    .filter(field => !hidden.has(field.key))
    .filter(field => authoritative ? authoritative.has(field.key) : Boolean(field.required))
    .filter(field => {
      if (isEmptyInputValue(field, values[field.key])) return true;
      // 服务端说这个字段需要值，而当前填的就是它那个不合格的发布版默认值：仍算缺。
      return authoritative?.has(field.key) === true && !isEmptyInputValue(field, values[field.key]) && isSameValue(values[field.key], field.defaultValue);
    })
    .map(field => field.label || field.key);
}

function isSameValue(left: unknown, right: unknown): boolean {
  return right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 单行为什么还不能继续；null 表示可以继续。
 * 抽成纯函数是为了能单测这条规则：它同时被「创建/保存草稿」「确认提交」用来在本地先拦一道。
 *
 * requireInputs:false 是保存草稿：只拦结构性缺项（没选场景/发布版），必填留到确认提交前再拦——
 * 草稿本来就允许先存进度、后补素材。填错的值仍会被服务端拒绝，这里不替代服务端校验。
 */
export function rowBlockReason(row: { sceneId?: string; versionId?: string }, gaps: readonly string[], options: { requireInputs?: boolean } = {}): string | null {
  if (!row.sceneId || !row.versionId) return "请先选择场景（任务项必须固定已发布版本）。";
  if (options.requireInputs !== false && gaps.length) return "还缺必填：" + gaps.join("、");
  return null;
}
