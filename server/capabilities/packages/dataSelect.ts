import type { CapabilityFactory } from "../package.js";
import { resolveWorkflowValue, toJsonValue } from "../../domain/workflowValues.js";

/** Lazy, lossless branch merge for any workflow value, including media lists. */
const factory: CapabilityFactory = () => ({
  definition: {
    id: "data.select", version: "1", usage: { tier: "basic", whenToUse: "按布尔条件合并分支结果，支持文本、JSON 和媒体，不调用模型。" }, label: "条件选择", category: "数据",
    description: "按布尔条件选择一个分支的结果；未选中的分支可以跳过。支持文本、JSON 和媒体列表，不调用模型。",
    dependencyMode: "declared", legacy: { kind: "capability" },
    inputs: [
      { key: "condition", label: "条件", type: "boolean", required: true },
      { key: "when_true", label: "条件为真时", type: "json", required: true },
      { key: "when_false", label: "条件为假时", type: "json", required: true },
    ],
    outputs: [{ key: "value", label: "选中的结果", type: "json" }],
    config: [],
    editor: { inputs: "ports", outputs: "ports", editablePorts: true, editableInputs: false },
    result: { renderer: "auto" },
  },
  validate(step) {
    if (step.outputs?.length !== 1 || step.outputs[0].key !== "value") {
      throw new Error("条件选择需要一个 key 为 value 的输出，可按分支结果设置输出类型");
    }
  },
  async execute(context) {
    const read = (key: string) => {
      const input = context.step.inputs?.find((item) => item.key === key);
      if (!input) throw new Error("条件选择缺少输入：" + key);
      return resolveWorkflowValue(input, context.inputValues, context.stepValues);
    };
    const condition = read("condition");
    if (typeof condition !== "boolean") throw new Error("条件选择的条件必须是布尔值");
    // Do not resolve the other branch: it may intentionally reference a skipped step.
    const key = condition ? "when_true" : "when_false";
    const value = read(key);
    if (value === undefined) throw new Error("条件选择的已选分支没有结果：" + key);
    return { value: toJsonValue(value) };
  },
});
export default factory;
