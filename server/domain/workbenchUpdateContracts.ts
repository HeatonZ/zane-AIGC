import * as z from "zod/v4";

export const upgradeId = z.uuid().describe("本地升级请求调用前保存的 UUID；响应丢失沿用此 ID 对账，不重投新升级");
export const upgradeQuery = z.object({ operationId: upgradeId.optional().describe("省略时读取最近一次升级；指定时精确读取原操作") }).strict();
export const upgradeStates = ["preparing", "checking", "ready", "waiting", "stopping", "switching", "starting", "completed", "failed", "cancelled", "needs_attention"] as const;
export const upgradeRecordSchema = z.object({
  schemaVersion: z.literal(1), operationId: upgradeId, revision: z.int().positive(),
  state: z.enum(upgradeStates), createdAt: z.string(), updatedAt: z.string(),
  releaseId: z.string(), message: z.string(), checkPassed: z.boolean(),
  checkPassedAt: z.string().optional(), artifactHash: z.string().optional(),
  oldReleaseId: z.string().optional(), oldActivationSupported: z.boolean().optional(),
  rollbackPid: z.int().positive().optional(), rollbackInstanceId: z.string().optional(),
  oldInstanceId: z.string().optional(), oldPid: z.int().positive().optional(),
  newInstanceId: z.string().optional(), newPid: z.int().positive().optional(),
  shutdownConfirmed: z.boolean().optional(), switched: z.boolean().optional(),
  servingConfirmed: z.boolean().optional(), rollbackOperationId: upgradeId.optional(),
  rollback: z.enum(["not_needed", "code_restored", "manual_required"]).optional(),
  blocked: z.record(z.string(), z.unknown()).optional(),
  nextAction: z.string(),
}).strict();
export type UpgradeRecord = z.infer<typeof upgradeRecordSchema>;
export const upgradeStatusSchema = z.object({ supported: z.literal(true), operation: upgradeRecordSchema.nullable(), execution: z.literal("local_supervisor_only"), nextAction: z.string() }).strict();
export const runtimeReleaseSchema = z.object({ releaseId: z.string(), contractVersion: z.string(), environment: z.enum(["production", "development"]), automaticRefresh: z.literal(false) }).strict();
