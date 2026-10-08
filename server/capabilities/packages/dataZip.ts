import * as z from "zod/v4";
import type { CapabilityFactory } from "../package.js";
import type { CapabilityValue } from "../contracts.js";
import { dataZipConfigSchema, expectedCountSchema } from "../../domain/dataZipContracts.js";
import { resolveWorkflowValue } from "../../domain/workflowValues.js";
import { prepareDataZip, zipDataLists } from "../../services/dataZipService.js";
const configSchema = z.toJSONSchema(dataZipConfigSchema) as unknown as { properties: Record<string, Record<string, CapabilityValue>>; $defs?: Record<string, CapabilityValue> };
const configProperties = configSchema.properties;
const factory: CapabilityFactory = () => ({
  definition: {
    id: "data.zip", version: "1", label: "列表对齐", category: "数据", legacy: { kind: "capability" }, dependencyMode: "declared",
    usage: { tier: "basic", whenToUse: "逐项步骤之间按位置严格关联计划、素材与提示词，校验数量/标识/数据结构，并拆分首项样张与后续批次；不调用模型。" },
    description: "items为主列表，其他自定义输入为等长列表；expected_count可校验用户期望项数。输出rows/first/rest。数量不等、空项、重复标识或结构不符报错，不截断补齐。仅支持本地有限JSON Schema，不执行代码。",
    inputs: [{ key: "items", label: "主列表", type: "json", required: true }, { key: "expected_count", label: "预期项数（整数或数字字符串）", type: "json", valueSchema: z.toJSONSchema(expectedCountSchema) as Record<string, CapabilityValue> }],
    outputs: [{ key: "rows", label: "对齐后的记录", type: "json" }, { key: "first", label: "首项", type: "json", required: false }, { key: "rest", label: "剩余记录", type: "json", required: false }],
    config: [
      { key: "itemKey", label: "主项字段名", type: "text", defaultValue: "item", valueSchema: configProperties.itemKey },
      { key: "ordinalField", label: "连续1-based序号字段（可选）", type: "text", valueSchema: configProperties.ordinalField, description: "主项此字段必须严格等于输入顺序1,2,...；生成前拒绝重复/跳号/重排，不改列表。省略兼容旧快照。" },
      { key: "identityField", label: "主项唯一标识字段（可选）", type: "text", valueSchema: configProperties.identityField },
      { key: "itemSchema", label: "主项结构契约（可选）", type: "json", valueSchema: { ...configProperties.itemSchema, $defs: configSchema.$defs ?? {} }, description: "仅支持type/properties/required/additionalProperties/items/enum、长度/项数/数值上下界；不支持$ref、pattern、format。" },
      { key: "minItems", label: "最少项数", type: "number", defaultValue: 1, valueSchema: configProperties.minItems },
      { key: "maxItems", label: "最多项数", type: "number", defaultValue: 200, valueSchema: configProperties.maxItems },
    ],
    editor: { inputs: "ports", outputs: "ports", editablePorts: true, editableOutputs: false }, result: { renderer: "json" },
  },
  validate(step) { prepareDataZip(step.capabilityConfig); },
  async execute(context) {
    const inputs = Object.fromEntries((context.step.inputs ?? []).map(input => [input.key, resolveWorkflowValue(input, context.inputValues, context.stepValues)]));
    const result = zipDataLists(context.step.capabilityConfig, inputs);
    return Object.fromEntries((context.step.outputs ?? []).map(output => [output.key, result[output.key as keyof typeof result]]));
  },
});
export default factory;
