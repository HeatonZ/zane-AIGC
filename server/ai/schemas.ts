import { assetSourceSchema } from "../domain/assetLibraryContracts.js";
import { feedbackMessageMaxLength } from "../domain/feedbackContracts.js";
import { hermesProviderMaxLength, hermesModelMaxLength } from "../domain/hermesModelSelection.js";
// 协议常量只有一处定义：散文插值引用，避免改了常量而说明仍停在旧值。这里刻意引用无导入的
// directLlmProtocol.js 而不是 domain/directLlm.js——本模块在浏览器依赖链上（src →
// server/ai/taskDraftSchemas → ./schemas），引注册表会把 x-direct-llm 契约打进客户端包。
import { directLlmAnthropicVersion } from "../domain/directLlmProtocol.js";
import * as z from "zod/v4";

export const id = z.string().min(1).max(200);
export const runId = z.string().regex(/^[a-f0-9-]{36}$/i).describe("客户端事先生成并保存的 UUID；响应丢失时只查询这个 ID，不换 ID 重试提交");
export const capabilityQuery = z.object({
  limit: z.int().min(1).max(100).default(50).describe("单页能力数量；默认50，最大100；hasMore时使用同一目录的nextCursor继续读取"),
  cursor: z.string().min(1).max(2048).optional().describe("上页nextCursor，绑定目录revision；409 CAPABILITY_PAGE_CHANGED时重读第一页，不拼接不同目录快照"),
  compatibilityUsage: z.string().optional().describe("传true时第一页额外返回compatibilityUsage：各退役能力在草稿与发布快照中被引用的场景数，用于下线决策；只读统计，不修改任何快照"),
}).strict();
export const hermesModelQuery = z.object({
  profile: z.string().min(1).max(200).describe("要读取模型目录的Hermes Profile（list_hermes_profiles或网页连接设置中的ID）；本机不存在该Profile时返回404 HERMES_PROFILE_NOT_FOUND，不会退化为默认Profile"),
  q: z.string().max(200).optional().describe("可选关键词，按Provider slug、显示名或模型ID过滤；省略返回全部可见Provider"),
  limit: z.int().min(1).max(100).default(24).describe("单页Provider数量；默认24，最大100；hasMore时用同一目录revision的nextCursor继续读取"),
  cursor: z.string().min(1).max(2048).optional().describe("上页nextCursor，绑定profile与目录revision；409 HERMES_MODEL_PAGE_CHANGED时重读第一页，不拼接不同目录快照"),
  refresh: z.boolean().optional().describe("true时绕过服务端60秒缓存重新读取网关目录；省略使用缓存。只读操作，不修改Profile或网关配置"),
  includeUnconfigured: z.boolean().optional().describe("true时包含网关列出但当前没有可用模型/凭证的Provider；默认只返回可用Provider与当前Provider"),
}).strict();
export const values = z.record(z.string(), z.json());
export const source = assetSourceSchema;
export const selection = z.object({ mode: z.enum(["all", "item", "for_each"]), index: z.int().nonnegative().optional() }).strict();
export const stepInput = z.object({ key: id, label: z.string().optional(), sourceRef: z.string().optional(), valueSource: z.enum(["literal", "reference"]).optional(), literalValue: z.string().optional(), literalType: z.string().optional(), referenceType: z.enum(["image_list", "video_list", "audio_list"]).describe("引用JSON字段中的媒体时显式声明列表类型；恢复/审核后同样作为真实附件，非媒体JSON不要声明。省略保留旧行为，不生成媒体").optional(), selection: selection.optional() }).strict();
export const stepChanges = z.object({ promptTemplate: z.string().optional(), hermesProfile: z.string().optional(), hermesProvider: z.string().max(hermesProviderMaxLength).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/).describe("可选：把本Hermes步骤的请求级Provider覆盖为这个网关slug（如custom:my-chat）；空串或省略表示清除覆盖、按Profile默认执行。只改本次修订/重做使用的步骤配置，不改Profile、网关默认值或历史运行快照。").optional(), hermesModel: z.string().max(hermesModelMaxLength).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/).describe("可选：把本Hermes步骤的请求级模型覆盖为这个模型ID（如anthropic/claude-opus-5）；空串或省略表示清除覆盖、按Profile默认执行。建议与hermesProvider同时设置；可用list_hermes_models读取所选Profile的实际目录。").optional(), capabilityConfig: values.describe("能力包配置；core.http_request使用list_capabilities返回的url/method/headers/apiKeyEnv/apiKeyHeader/apiKeyPrefix/bodyFormat/bodyTemplate/multipartImages/multipartLocalFiles/responseImages/timeoutSeconds/retries/retryDelaySeconds字段契约（密钥值不得写入配置；retries默认0保持单次请求，只重试网络失败、超时和408/429/500/502/503/504/524（524为边缘节点等待源站超时），重试会重发同一请求，可能重复计费；multipartLocalFiles默认false，开启后multipart图片还可读取管理员本地导出根目录内的真实文件，取真实路径校验包含性并拒绝越界与符号链接逃逸），密钥值不得写入配置；core.code使用code（本地沙箱JavaScript，return输出对象）与timeoutMs（200–60000毫秒，默认5000）字段，输出端口与类型在步骤outputs声明；core.llm使用systemPrompt（独立system消息，留空不发送）、skillRef（可选引用，取一段文本作为system正文，如core.code读出的SKILL.md；写法input.<key>或step.<id>.outputs.<key>，可带JSON路径，多个用换行/逗号分隔；原样发送，与systemPrompt同时填写时固定文本在前；目标不存在或指向媒体在请求前失败）、outputMode（json默认，按声明输出端口严格校验；text则要求恰好一个text输出并原样返回）与direct（boolean，默认false走Hermes Profile；true时按providerId（list_direct_llm_providers的稳定ID，省略=保留默认提供商）与可选model直接请求该提供商，**完全不读Hermes Profile、网关地址或网关密钥**，协议为openai-chat的/chat/completions或anthropic的/messages（x-api-key + anthropic-version " + directLlmAnthropicVersion + "）；密钥明文存本机SQLite、读接口只回掩码、不进运行记录与快照；地址允许本机/内网；不自动重试）字段；字段全集与协议细节见list_capabilities与契约x-direct-llm/x-llm-step，输出端口与类型在步骤outputs声明；可选localExport={enabled,planKey?,onConflict?}只提交{items:[{source,target}]}写盘计划由宿主在沙箱之外执行（契约x-local-export），可选fileAccess={enabled:true}只开启只读的zane.fs.list/zane.fs.stat/zane.fs.readText，列出管理员授权根目录内的文件名与元数据、并按相对路径读取文本内容（用于从动作/提示词等多行文本里挑一行；单次上限1MB，超出报FILE_TOO_LARGE；读到的文本不执行、不解析、不写回）（契约x-local-file-access）；两者都以管理员配置的local-export根目录为唯一边界且各自独立开关，沙箱始终没有直接文件系统权限；媒体输出端口（image_list/video_list/audio_list）返回文件名数组，只选择本步骤输入中的既有媒体，契约x-code-step；步骤级startCondition（match+rules）声明开始条件，不满足即跳过且输出为null").optional(), inputs: z.array(stepInput).optional(), comfyui: values.optional() }).strict();
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
