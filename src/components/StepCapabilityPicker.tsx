import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { capabilityChoices, capabilityForStep, capabilityUsage, type CapabilityDefinition } from "../lib/capabilities";
import type { WorkflowStepDefinition } from "../types";

interface Props { step: WorkflowStepDefinition; capabilities: readonly CapabilityDefinition[]; onChange: (id: string) => void }
export default function StepCapabilityPicker({ step, capabilities, onChange }: Props) {
  const [expanded, setExpanded] = useState(false);
  const selected = capabilityForStep(step, capabilities);
  const groups = capabilityChoices(capabilities, selected?.id, expanded);
  const usage = selected ? capabilityUsage(selected) : undefined;
  return <div className="field-group capability-picker">
    <label className="field-label">执行方式</label>
    <div className="select-wrap"><select value={selected?.id ?? step.capabilityId ?? ""} onChange={(event) => onChange(event.target.value)} aria-label="步骤能力包">
      {!selected && <option value={step.capabilityId ?? ""} disabled>未安装的能力：{step.capabilityId ?? step.kind}</option>}
      <optgroup label="基础步骤（优先复用）">{groups.basic.map((item) => <option key={item.id} value={item.id}>{item.category} · {item.label}</option>)}</optgroup>
      {groups.specialized.length > 0 && <optgroup label={expanded ? "专用步骤（必要时使用）" : "当前专用步骤（保留配置）"}>{groups.specialized.map((item) => <option key={item.id} value={item.id}>{item.category} · {item.label}</option>)}</optgroup>}
    </select><ChevronDown size={14} /></div>
    <p className="capability-picker-help">优先用基础步骤；场景差异用提示词、工作流和绑定配置，逐项、分支、审核复用通用流程。</p>
    {groups.specializedCount > 0 && <button type="button" className="text-button capability-picker-toggle" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>{expanded ? "收起专用步骤" : "查看专用步骤（" + groups.specializedCount + "）"}</button>}
    {usage?.tier === "specialized" && <div className="capability-picker-help capability-picker-specialized" role="note"><strong>{usage.compatibilityOnly ? "旧版兼容：" : "仅在需要时："}</strong>{usage.whenToUse}{usage.basicAlternative && <p><strong>基础替代：</strong>{usage.basicAlternative}</p>}<p>不会自动替换当前步骤或修改已发布版本。</p></div>}
  </div>;
}
