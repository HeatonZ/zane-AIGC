import * as z from "zod/v4";
import { dataZipConfigSchema, expectedCountSchema } from "../domain/dataZipContracts.js";
import { isRuntimeMediaValue, runtimeMediaExternalValue } from "../runtimeValue.js";
import { asRecord, toJsonValue } from "../domain/workflowValues.js";
import type { JsonValue } from "../domain/types.js";

export function prepareDataZip(value: unknown) {
  let nodes = 0;
  const bounded = (candidate: unknown, depth: number) => {
    if (++nodes > 2048 || depth > 24) throw new Error("列表对齐配置过大或嵌套过深");
    if (Array.isArray(candidate)) candidate.forEach(item => bounded(item, depth + 1));
    else if (candidate && typeof candidate === "object") Object.values(candidate).forEach(item => bounded(item, depth + 1));
  };
  bounded(value, 0);
  const parsed = dataZipConfigSchema.safeParse(value ?? {});
  if (!parsed.success) throw new Error("列表对齐配置无效：" + parsed.error.issues.map(issue => issue.path.join(".") + " " + issue.message).join("；"));
  const config = parsed.data;
  if (config.minItems > config.maxItems) throw new Error("列表对齐最小项数不能超过最大项数");
  // Conversion rejects unsupported/inconsistent definitions during draft validation, not after generation.
  const schema = config.itemSchema ? z.fromJSONSchema(config.itemSchema as Parameters<typeof z.fromJSONSchema>[0]) : undefined;
  return { config, schema };
}

/** Strict positional join. Never truncates, pads, filters, reorders or executes user code. */
export function zipDataLists(configValue: unknown, inputs: Record<string, unknown>) {
  const { config, schema } = prepareDataZip(configValue);
  inputs = Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, isRuntimeMediaValue(value) ? runtimeMediaExternalValue(value) : value]));
  const items = inputs.items;
  if (!Array.isArray(items) || items.length < config.minItems || items.length > config.maxItems) throw new Error("列表对齐items必须是数组，项数范围为" + config.minItems + "–" + config.maxItems);
  if (inputs.expected_count !== undefined && inputs.expected_count !== null) {
    const count = expectedCountSchema.safeParse(inputs.expected_count);
    if (!count.success || Number(count.data) !== items.length) throw new Error("列表对齐项数与expected_count不一致");
  }
  const columns = Object.entries(inputs).filter(([key]) => key !== "items" && key !== "expected_count");
  for (const [key, values] of columns) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || [config.itemKey, "__proto__", "prototype", "constructor"].includes(key)) throw new Error("列表对齐列名与保留字段冲突：" + key);
    if (!Array.isArray(values) || values.length !== items.length) throw new Error("列表对齐列" + key + "的项数不一致，不能截断或补齐");
  }
  const ids = new Set<string>();
  const rows: JsonValue[] = items.map((item, index) => {
    if (item === null || item === undefined) throw new Error("列表对齐第" + (index + 1) + "项为空");
    if (schema) {
      const result = schema.safeParse(item);
      if (!result.success) throw new Error("列表对齐第" + (index + 1) + "项不符合itemSchema：" + result.error.issues.map(issue => issue.path.join(".") + " " + issue.message).join("；"));
    }
    if (config.ordinalField && asRecord(item)?.[config.ordinalField] !== index + 1) throw new Error("列表对齐序号必须按输入顺序从1连续递增：" + config.ordinalField + "，第" + (index + 1) + "项无效");
    if (config.identityField) {
      const id = asRecord(item)?.[config.identityField];
      if (typeof id !== "string" || !id.trim() || id.length > 128 || ids.has(id)) throw new Error("列表对齐标识必须是非空唯一字符串：" + config.identityField);
      ids.add(id);
    }
    const row: Record<string, JsonValue> = { [config.itemKey]: toJsonValue(item) };
    for (const [key, values] of columns) {
      const value = (values as unknown[])[index];
      if (value === undefined || value === null) throw new Error("列表对齐列" + key + "的第" + (index + 1) + "项为空，不能错位关联");
      row[key] = toJsonValue(value);
    }
    return row;
  });
  return { rows, first: rows[0]!, rest: rows.slice(1) };
}
