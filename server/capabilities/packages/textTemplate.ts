import type { CapabilityFactory } from "../package.js";
import { resolveStepInputs } from "../../domain/workflowValues.js";
/** Reference implementation: adding this file alone makes the capability selectable and executable. */
const factory: CapabilityFactory = () => ({
  definition: {
    id: "text.template", version: "1", usage: { compatibilityOnly: true, whenToUse: "仅兼容已有发布快照与历史运行；新场景用core.code完成文本模板和文案拼装：读取声明的输入端口，按需要拼装文本并返回声明的text输出。" }, label: "文本模板（旧版兼容）", description: "旧版文本模板步骤：把步骤输入填入 {{变量名}}，用于拼装提示词或文案，不调用模型。新场景使用自定义代码。", category: "文本",
    dependencyMode: "declared", legacy: { kind: "capability" }, inputs: [{ key: "text", label: "文本", type: "text" }], outputs: [{ key: "text", label: "拼装文本", type: "text" }],
    config: [{ key: "template", label: "文本模板", type: "textarea", required: true, defaultValue: "{{text}}", placeholder: "例如：为 {{product}} 写一条 {{style}} 风格文案", description: "变量名对应下方步骤输入的 key。" }],
    editor: { inputs: "ports", outputs: "ports", editablePorts: true, editableOutputs: false }, result: { renderer: "text" },
  },
  async execute(context) {
    const inputs = resolveStepInputs(context.step, context.inputValues, context.stepValues);
    const template = String(context.step.capabilityConfig?.template ?? "");
    const text = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(inputs, key) || inputs[key] === null) throw new Error("文本模板缺少变量：" + key);
      return typeof inputs[key] === "string" ? inputs[key] : JSON.stringify(inputs[key]);
    });
    return Object.fromEntries((context.step.outputs?.length ? context.step.outputs : [{ key: "text" }]).map((output) => [output.key, text]));
  },
});
export default factory;
