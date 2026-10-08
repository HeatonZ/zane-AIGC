import { validWorkflowMediaRole } from "./workflowMediaRoles.js";
import { HttpError } from "../errors.js";
import { iterationCarrySchema } from "./iterationCarry.js";
import { asRecord, splitWorkflowReference, parseWorkflowJsonPath } from "./workflowValues.js";

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
  const execution = (item: unknown, step?: Record<string, unknown>) => {
    if (item === undefined) return;
    const config = record(item, "逐项执行配置");
    if (config.mode !== undefined && !["once", "for_each"].includes(String(config.mode))) invalid("执行模式");
    if (config.onError !== undefined && !["continue", "stop"].includes(String(config.onError))) invalid("错误处理");
    if (config.maxConcurrency !== undefined && (typeof config.maxConcurrency !== "number" || !Number.isSafeInteger(config.maxConcurrency) || config.maxConcurrency < 1 || config.maxConcurrency > 32)) invalid("最大并行数");
    text(config.sourceRef, "逐项执行来源", true);
    if (config.carry !== undefined) {
      const parsed = iterationCarrySchema.safeParse(config.carry);
      if (!parsed.success || !step || config.mode !== "for_each") invalid("状态传递仅支持步骤级for_each，且必须声明outputKey");
      const carry = parsed.data!;
      const source = typeof config.sourceRef === "string" ? splitWorkflowReference(config.sourceRef) : undefined;
      if (!source || source.root.startsWith("iteration.")) invalid("状态传递遍历来源必须为input或前序step引用");
      try { parseWorkflowJsonPath(source!.path); } catch { invalid("状态传递遍历来源路径"); }
      if (config.maxConcurrency !== undefined && config.maxConcurrency !== 1) invalid("状态传递最大并行数必须为1");
      if (config.onError !== undefined && config.onError !== "stop") invalid("状态传递失败策略必须为stop");
      if (!list(step!.outputs, "步骤输出", true).some(raw => asRecord(raw)?.key === carry.outputKey)) invalid("状态传递输出键未声明");
      if (carry.initialSourceRef !== undefined) {
        const ref = splitWorkflowReference(carry.initialSourceRef);
        if (!ref || ref.root.startsWith("iteration.")) invalid("状态传递初始来源必须为input或前序step引用");
        try { parseWorkflowJsonPath(ref!.path); } catch { invalid("状态传递初始来源路径"); }
      }
    }
  };
  const fields = (items: unknown[], label: string, output = false) => {
    const keys = new Set<string>();
    for (const item of items) {
      const field = record(item, label);
      text(field.key, label); text(field.type, label);
      if (!validWorkflowMediaRole(field.mediaRole, field.type, output ? "output" : "input")) invalid("素材用途与字段类型");
      if (keys.has(String(field.key))) invalid(`${label}重复键`);
      keys.add(String(field.key));
      if (field.options !== undefined && list(field.options, "字段选项").some((option) => typeof option !== "string")) invalid("字段选项");
      if ((field.minimum !== undefined || field.maximum !== undefined) && (output || field.type !== "number")) invalid("数字输入范围类型");
      if (field.minimum !== undefined && (typeof field.minimum !== "number" || !Number.isFinite(field.minimum))) invalid("数字最小值");
      if (field.maximum !== undefined && (typeof field.maximum !== "number" || !Number.isFinite(field.maximum))) invalid("数字最大值");
      if (typeof field.minimum === "number" && typeof field.maximum === "number" && field.minimum > field.maximum) invalid("数字最小值不能大于最大值");
      if (field.required !== undefined && typeof field.required !== "boolean") invalid("必填配置");
      if (field.hidden !== undefined && typeof field.hidden !== "boolean") invalid("输入表单隐藏配置");
      if (field.inputMode !== undefined || field.itemFields !== undefined) {
        if (output || field.type !== "json" || field.inputMode !== "object_array") invalid("对象数组表单配置");
        const itemFields = list(field.itemFields, "对象数组子字段");
        if (!itemFields.length || itemFields.length > 50) invalid("对象数组子字段");
        const itemKeys = new Set<string>();
        for (const rawItem of itemFields) {
          const item = record(rawItem, "对象数组子字段");
          text(item.key, "对象数组子字段键"); text(item.label, "对象数组子字段名称");
          if (itemKeys.has(String(item.key))) invalid("对象数组子字段重复键");
          itemKeys.add(String(item.key));
          if (!["text", "number", "boolean", "select"].includes(String(item.type))) invalid("对象数组子字段类型");
          if ((item.minimum !== undefined || item.maximum !== undefined) && item.type !== "number") invalid("对象数组数字范围类型");
          if (item.minimum !== undefined && (typeof item.minimum !== "number" || !Number.isFinite(item.minimum))) invalid("对象数组数字最小值");
          if (item.maximum !== undefined && (typeof item.maximum !== "number" || !Number.isFinite(item.maximum))) invalid("对象数组数字最大值");
          if (typeof item.minimum === "number" && typeof item.maximum === "number" && item.minimum > item.maximum) invalid("对象数组数字最小值不能大于最大值");
          if (typeof item.required !== "boolean") invalid("对象数组子字段必填配置");
          if (item.type === "select" && (!Array.isArray(item.options) || item.options.length === 0 || item.options.some(option => typeof option !== "string" || !option.trim()))) invalid("对象数组下拉选项");
          if (item.options !== undefined && (!Array.isArray(item.options) || item.options.some(option => typeof option !== "string"))) invalid("对象数组字段选项");
        }
      }
      if (output) text(field.sourceRef, "最终输出来源");
      selection(field.selection);
    }
  };
  fields(list(value.inputs, "场景输入"), "场景输入");
  fields(list(value.outputs, "最终输出"), "最终输出", true);
  execution(value.execution);
  for (const raw of list(value.outputs, "最终输出")) if (/^iteration\.(previous|hasPrevious|index)(?:$|[.\[])/.test(String(asRecord(raw)?.sourceRef))) invalid("状态引用仅在当前逐项步骤内有效");
  for (const item of list(value.steps, "流程步骤")) {
    const step = record(item, "步骤");
    text(step.promptTemplate, "步骤提示词", true); text(step.hermesProfile, "Profile", true);
    text(step.capabilityId, "能力包 ID", true); text(step.capabilityVersion, "能力包版本", true);
    if (step.capabilityConfig !== undefined) record(step.capabilityConfig, "能力包配置");
    for (const raw of list(step.inputs, "步骤输入", true)) {
      const input = record(raw, "步骤输入"); text(input.key, "步骤输入键");
      for (const name of ["sourceRef", "literalValue", "literalType"]) text(input[name], "步骤输入", true);
      if (input.valueSource !== undefined && !["literal", "reference"].includes(String(input.valueSource))) invalid("输入来源");
      if (input.referenceType !== undefined && !["image_list", "video_list", "audio_list"].includes(String(input.referenceType))) invalid("引用媒体类型");
      selection(input.selection);
    }
    fields(list(step.outputs, "步骤输出", true), "步骤输出");
    execution(step.execution, step);
    const checkIteration = (ref: unknown) => {
      if (typeof ref === "string" && /^iteration\.(previous|hasPrevious|index)(?:$|[.\[])/.test(ref) && !asRecord(step.execution)?.carry) invalid("状态引用需要启用步骤状态传递");
    };
    for (const raw of list(step.inputs, "步骤输入", true)) if (asRecord(raw)?.valueSource !== "literal") checkIteration(asRecord(raw)?.sourceRef);
    for (const raw of list(asRecord(step.comfyui)?.bindings, "ComfyUI绑定", true)) if (asRecord(raw)?.direction === "input" && asRecord(raw)?.valueSource !== "literal") checkIteration(asRecord(raw)?.sourceRef);
    for (const match of String(step.promptTemplate ?? "").matchAll(/\{\{([^{}]+)\}\}/g)) checkIteration(match[1].trim());
    if (step.review !== undefined) { const review = record(step.review, "人工确认设置"); if (typeof review.enabled !== "boolean") invalid("人工确认开关"); text(review.instruction, "确认说明", true); }
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
        if (!validWorkflowMediaRole(binding.mediaRole, binding.type, String(binding.direction))) invalid("素材用途与绑定类型/方向");
        for (const name of ["sourceRef", "literalValue"]) text(binding[name], "ComfyUI 绑定", true);
        selection(binding.selection);
      }
      text(config.adapter, "ComfyUI 适配器", true);
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
        checkIteration(rule.leftRef); if (rule.valueSource === "reference") checkIteration(rule.rightRef);
        for (const name of ["id", "leftRef", "operator"]) text(rule[name], "条件规则");
        if (!["literal", "reference"].includes(String(rule.valueSource))) invalid("条件值来源");
        text(rule.rightValue, "条件值", true); text(rule.rightRef, "条件引用", true);
      }
    }
  }
}


/** Validate carry dependency roots against the complete snapshot, never an isolated item override. */
export function validateCarryReferences(flow: import("./types.js").RunWorkflowDefinition) {
  const inputs = new Set(flow.inputs.map(field => field.key));
  const available = new Set<string>();
  for (const step of flow.steps) {
    if (step.execution?.carry) for (const reference of [step.execution.sourceRef, step.execution.carry.initialSourceRef]) {
      if (reference === undefined) continue;
      const root = splitWorkflowReference(reference)?.root;
      if (!root || !(root.startsWith("input.") ? inputs.has(root.slice(6)) : available.has(root))) {
        throw new HttpError(400, "状态传递来源不存在、未声明或引用后续步骤：" + reference, "INVALID_WORKFLOW_REFERENCE", { stepId: step.id, reference });
      }
    }
    for (const port of step.outputs ?? []) available.add(`step.${step.id}.outputs.${port.key}`);
  }
}
