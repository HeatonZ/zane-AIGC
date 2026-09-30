import { HttpError } from "../errors.js";
import { asRecord } from "./workflowValues.js";

/** Validate nested execution contracts before normalization or side effects. */
export function validateWorkflowShape(value: Record<string, unknown>) {
  const invalid = (label: string): never => { throw new HttpError(400, `${label}格式无效`, "INVALID_WORKFLOW"); };
  const record = (item: unknown, label: string) => asRecord(item) ?? invalid(label);
  const text = (item: unknown, label: string, optional = false) => {
    if (item === undefined && optional) return;
    if (typeof item !== "string" || (!optional && !item)) invalid(label);
  };
  const list = (item: unknown, label: string, optional = false): unknown[] => {
    if (item === undefined && optional) return [];
    if (!Array.isArray(item)) return invalid(label);
    return item;
  };
  const selection = (item: unknown) => {
    if (item === undefined) return;
    const choice = record(item, "列表选择");
    if (!["all", "item", "for_each"].includes(String(choice.mode))) invalid("列表选择");
    if (choice.index !== undefined && (typeof choice.index !== "number" || !Number.isSafeInteger(choice.index) || choice.index < 0)) invalid("列表序号");
  };
  const execution = (item: unknown) => {
    if (item === undefined) return;
    const config = record(item, "逐项执行配置");
    if (config.mode !== undefined && !["once", "for_each"].includes(String(config.mode))) invalid("执行模式");
    if (config.onError !== undefined && !["continue", "stop"].includes(String(config.onError))) invalid("错误处理");
    if (config.maxConcurrency !== undefined && (typeof config.maxConcurrency !== "number" || !Number.isSafeInteger(config.maxConcurrency) || config.maxConcurrency < 1 || config.maxConcurrency > 32)) invalid("最大并行数");
    text(config.sourceRef, "逐项执行来源", true);
  };
  const fields = (items: unknown[], label: string, output = false) => {
    const keys = new Set<string>();
    for (const item of items) {
      const field = record(item, label);
      text(field.key, label); text(field.type, label);
      if (keys.has(String(field.key))) invalid(`${label}重复键`);
      keys.add(String(field.key));
      if (field.options !== undefined && list(field.options, "字段选项").some((option) => typeof option !== "string")) invalid("字段选项");
      if (field.required !== undefined && typeof field.required !== "boolean") invalid("必填配置");
      if (output) text(field.sourceRef, "最终输出来源");
      selection(field.selection);
    }
  };
  fields(list(value.inputs, "场景输入"), "场景输入");
  fields(list(value.outputs, "最终输出"), "最终输出", true);
  execution(value.execution);
  for (const item of list(value.steps, "流程步骤")) {
    const step = record(item, "步骤");
    for (const raw of list(step.inputs, "步骤输入", true)) {
      const input = record(raw, "步骤输入"); text(input.key, "步骤输入键");
      for (const name of ["sourceRef", "literalValue", "literalType"]) text(input[name], "步骤输入", true);
      if (input.valueSource !== undefined && !["literal", "reference"].includes(String(input.valueSource))) invalid("输入来源");
      selection(input.selection);
    }
    fields(list(step.outputs, "步骤输出", true), "步骤输出");
    execution(step.execution);
    if (step.runCondition !== undefined) {
      const condition = record(step.runCondition, "运行条件"); text(condition.conditionStepId, "条件步骤");
      if (typeof condition.expectedResult !== "boolean") invalid("条件结果");
    }
    if (step.comfyui !== undefined) {
      const config = record(step.comfyui, "ComfyUI 配置"); text(config.workflowFile, "ComfyUI 工作流");
      for (const item of list(config.bindings, "ComfyUI 绑定", true)) {
        const binding = record(item, "ComfyUI 绑定");
        for (const name of ["key", "nodeId", "property", "type"]) text(binding[name], "ComfyUI 绑定");
        if (!["input", "output"].includes(String(binding.direction))) invalid("绑定方向");
        for (const name of ["sourceRef", "literalValue"]) text(binding[name], "ComfyUI 绑定", true);
        selection(binding.selection);
      }
      if (config.adapter !== undefined && !["h3_long_video", "commerce_pack", "long_text_video", "video_concat"].includes(String(config.adapter))) invalid("ComfyUI 适配器");
      if (config.h3LongVideo !== undefined) {
        const adapter = record(config.h3LongVideo, "H3 适配器");
        for (const name of ["planRef", "promptRowsRef", "referenceImagesRef"]) text(adapter[name], "H3 输入引用");
        text(adapter.materialNoteRef, "H3 素材说明引用", true);
      }
    }
    if (step.control !== undefined) {
      const config = record(step.control, "条件节点");
      if (config.type !== "condition" || !["all", "any"].includes(String(config.match))) invalid("条件节点");
      for (const item of list(config.rules, "条件规则")) {
        const rule = record(item, "条件规则");
        for (const name of ["id", "leftRef", "operator"]) text(rule[name], "条件规则");
        if (!["literal", "reference"].includes(String(rule.valueSource))) invalid("条件值来源");
        text(rule.rightValue, "条件值", true); text(rule.rightRef, "条件引用", true);
      }
    }
  }
}
