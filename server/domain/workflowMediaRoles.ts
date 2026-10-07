/** Semantic asset use is separate from the physical ComfyUI media socket type. */
export const workflowMediaRoles = ["reference", "character", "scene", "prop", "voice_reference"] as const;
export type WorkflowMediaRole = typeof workflowMediaRoles[number];
export const workflowMediaRoleLabels: Record<WorkflowMediaRole, string> = {
  reference: "通用参考", character: "人物资产", scene: "场景资产", prop: "道具资产", voice_reference: "参考音色",
};
export function workflowMediaRoleOptions(type: unknown): WorkflowMediaRole[] {
  if (type === "image" || type === "image_list") return ["reference", "character", "scene", "prop"];
  if (type === "audio" || type === "audio_list") return ["reference", "voice_reference"];
  if (type === "video" || type === "video_list") return ["reference"];
  return [];
}
export function validWorkflowMediaRole(role: unknown, type: unknown, direction = "input"): role is WorkflowMediaRole | undefined {
  return role === undefined || (direction === "input" && workflowMediaRoleOptions(type).includes(role as WorkflowMediaRole));
}
