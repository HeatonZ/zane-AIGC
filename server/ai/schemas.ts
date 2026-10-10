import { assetSourceSchema } from "../domain/assetLibraryContracts.js";
import { feedbackMessageMaxLength } from "../domain/feedbackContracts.js";
import * as z from "zod/v4";

export const id = z.string().min(1).max(200);
export const runId = z.string().regex(/^[a-f0-9-]{36}$/i).describe("客户端事先生成并保存的 UUID；响应丢失时只查询这个 ID，不换 ID 重试提交");
export const capabilityQuery = z.object({
  limit: z.int().min(1).max(100).default(50).describe("单页能力数量；默认50，最大100；hasMore时使用同一目录的nextCursor继续读取"),
  cursor: z.string().min(1).max(2048).optional().describe("上页nextCursor，绑定目录revision；409 CAPABILITY_PAGE_CHANGED时重读第一页，不拼接不同目录快照"),
}).strict();
export const values = z.record(z.string(), z.json());
export const source = assetSourceSchema;
export const selection = z.object({ mode: z.enum(["all", "item", "for_each"]), index: z.int().nonnegative().optional() }).strict();
export const stepInput = z.object({ key: id, label: z.string().optional(), sourceRef: z.string().optional(), valueSource: z.enum(["literal", "reference"]).optional(), literalValue: z.string().optional(), literalType: z.string().optional(), referenceType: z.enum(["image_list", "video_list", "audio_list"]).describe("引用JSON字段中的媒体时显式声明列表类型；恢复/审核后同样作为真实附件，非媒体JSON不要声明。省略保留旧行为，不生成媒体").optional(), selection: selection.optional() }).strict();
export const stepChanges = z.object({ promptTemplate: z.string().optional(), hermesProfile: z.string().optional(), capabilityConfig: values.describe("能力包配置；core.http_request使用list_capabilities返回的url/method/headers/apiKeyEnv/apiKeyHeader/apiKeyPrefix/bodyFormat/bodyTemplate/multipartImages/responseImages/timeoutSeconds/retries/retryDelaySeconds字段契约（密钥值不得写入配置；retries默认0保持单次请求，只重试网络失败、超时和408/429/5xx，重试会重发同一请求，可能重复计费），密钥值不得写入配置；core.code使用code（本地沙箱JavaScript，return输出对象）与timeoutMs（200–60000毫秒，默认5000）字段，输出端口与类型在步骤outputs声明；媒体输出端口（image_list/video_list/audio_list）返回文件名数组，只选择本步骤输入中的既有媒体，契约x-code-step；步骤级startCondition（match+rules）声明开始条件，不满足即跳过且输出为null").optional(), inputs: z.array(stepInput).optional(), comfyui: values.optional() }).strict();
export const feedbackMessage = z.string().trim().min(1).max(feedbackMessageMaxLength);
export const changes = z.object({
  feedback: z.array(z.object({ stepId: id, itemIndex: z.int().nonnegative().optional(), message: feedbackMessage }).strict()).optional(),
  inputOverrides: values.optional(),
  stepOverrides: z.array(stepChanges.extend({ stepId: id, itemIndex: z.int().nonnegative().optional() })).optional(),
  outputOverrides: z.array(z.object({ stepId: id, itemIndex: z.int().nonnegative().optional(), outputs: values }).strict()).optional(),
  rerunSteps: z.array(z.object({ stepId: id, itemIndexes: z.array(z.int().nonnegative()).optional() }).strict()).optional(),
}).strict();
export const scenePreparation = z.object({ versionId: id, inputValues: values }).strict();
export const sceneSubmission = scenePreparation.extend({ runId, runTitle: z.string().max(120).optional() }).strict();
export const runStatuses = z.enum(["queued", "running", "cancelling", "waiting", "completed", "failed", "cancelled", "stale"]);
