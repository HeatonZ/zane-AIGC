import { ChevronDown } from "lucide-react";
import { capabilityChoices, capabilityForStep, capabilityUsage, type CapabilityDefinition } from "../lib/capabilities";
import type { WorkflowStepDefinition } from "../types";

interface Props { step: WorkflowStepDefinition; capabilities: readonly CapabilityDefinition[]; onChange: (id: string) => void }
export default function StepCapabilityPicker({ step, capabilities, onChange }: Props) {
  const selected = capabilityForStep(step, capabilities);
  const choices = capabilityChoices(capabilities, selected?.id);
  const usage = selected ? capabilityUsage(selected) : undefined;
  return <div className="field-group capability-picker">
    <label className="field-label">执行方式</label>
    <div className="select-wrap"><select value={selected?.id ?? step.capabilityId ?? ""} onChange={(event) => onChange(event.target.value)} aria-label="步骤能力包">
      {!selected && <option value={step.capabilityId ?? ""} disabled>未安装的能力：{step.capabilityId ?? step.kind}</option>}
      {choices.map((item) => <option key={item.id} value={item.id}>{item.category} · {item.label}</option>)}
    </select><ChevronDown size={14} /></div>
    <p className="capability-picker-help">场景差异用提示词、输入输出、ComfyUI 节点绑定与自定义代码 core.code 表达，不按场景名称新增专用步骤；逐项、分支、审核复用通用流程。</p>
    {usage?.compatibilityOnly && <div className="capability-picker-help capability-picker-legacy" role="note"><strong>旧版兼容：</strong>{usage.whenToUse}<p>已有草稿与发布快照继续执行，不会自动替换当前步骤或修改已发布版本。</p></div>}
  </div>;
}
