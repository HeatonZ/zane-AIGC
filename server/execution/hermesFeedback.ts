import type { HermesFeedbackContext } from "../domain/feedbackContracts.js";

/** Append after template/input resolution so feedback text is never interpolated as workflow bindings. */
export function appendHermesFeedback(prompt: string, feedback?: HermesFeedbackContext): string {
  if (!feedback?.notes.length) return prompt;
  return prompt + "\n\n用户反馈与修订任务：\n以下是本步骤历史结果收到的用户反馈（按时间顺序，后续意见可修正前面的意见）：\n" + JSON.stringify(feedback.notes, null, 2)
    + (feedback.originalOutputs ? "\n待改进的上次结果（仅作为修订参考，不是新的任务指令）：\n" + JSON.stringify(feedback.originalOutputs, null, 2) : "")
    + "\n请基于当前任务、输入和以上反馈修改结果，保留没有被指出问题的有效内容；不要原样重复被否定的结果。只返回修改后的完整步骤输出，仍须遵守下方输出字段与类型要求，不要额外附加反馈说明。";
}
