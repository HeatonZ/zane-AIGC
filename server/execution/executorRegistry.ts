import type { JsonValue } from "../domain/types.js";
import type { StepExecutionContext } from "./workflowExecutor.js";
export interface StepExecutor { kind: string; execute(context: StepExecutionContext): Promise<Record<string, JsonValue>> }
export class ExecutorRegistry {
  private readonly executors = new Map<string, StepExecutor>();
  register(executor: StepExecutor) {
    if (this.executors.has(executor.kind)) throw new Error(`执行器 ${executor.kind} 已注册`);
    this.executors.set(executor.kind, executor);
    return this;
  }
  supports(kind: string) { return this.executors.has(kind); }
  async execute(context: StepExecutionContext) {
    const executor = this.executors.get(context.step.kind);
    if (!executor) throw new Error(`暂不支持执行方式：${context.step.kind}`);
    return executor.execute(context);
  }
}
