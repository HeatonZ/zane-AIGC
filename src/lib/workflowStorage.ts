import type { WorkflowDefinition } from "../types";

/** Explicit draft transformation only; never reads or writes browser configuration. */
export function migrateWorkflowExecution(workflow: WorkflowDefinition): WorkflowDefinition {
  const legacyExecution = workflow.execution;
  if (!legacyExecution) return workflow;
  const { execution: _legacyExecution, ...withoutLegacyExecution } = workflow;
  if (legacyExecution.mode !== "for_each" || workflow.steps.some((step) => step.execution?.mode === "for_each")) {
    return withoutLegacyExecution;
  }
  const targetIndex = workflow.steps.findIndex((step) => step.kind !== "control");
  if (targetIndex < 0) return withoutLegacyExecution;
  return {
    ...withoutLegacyExecution,
    steps: workflow.steps.map((step, index) => index === targetIndex ? { ...step, execution: legacyExecution } : step),
  };
}
