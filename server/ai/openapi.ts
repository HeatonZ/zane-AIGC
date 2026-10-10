import { COMFY_STATIC_SWITCH_CONTRACT } from "../comfyuiStaticSwitches.js";
import { COMFY_UI_ROUTING_CONTRACT } from "../comfyuiReroutes.js";
import { ITERATION_CARRY_CONTRACT } from "../domain/iterationCarry.js";
import { taskConcurrencySettingsSchema } from "../domain/taskConcurrencyContracts.js";
import { runMediaExportSchema } from "../domain/runMediaExportContracts.js";
import { dataZipConfigSchema } from "../domain/dataZipContracts.js";
import { upgradeStatusSchema, runtimeReleaseSchema } from "../domain/workbenchUpdateContracts.js";
import { systemFeedbackSchema, systemFeedbackEnvelope, systemFeedbackPage } from "../domain/systemFeedbackContracts.js";
import { taskDraftSchema, taskDraftEnvelopeSchema, taskDraftPageSchema } from "./taskDraftSchemas.js";
import { sceneDiffPageSchema, sceneDiffValuePageSchema } from "./sceneDiffSchemas.js";
import { ASSET_MEDIA_EXECUTION_CONTRACT } from "../domain/assetMediaReference.js";
import { H3_PROMPT_SECTIONS_CONTRACT } from "../execution/longTextVideo.js";
import { HERMES_OUTPUT_JSON_CONTRACT } from "../execution/hermesOutput.js";
import { THIRD_PARTY_JSON_REQUEST_CONTRACT } from "../execution/thirdPartyJsonRequest.js";
import { CODE_STEP_CONTRACT } from "../execution/codeSandbox.js";
import { AI_MCP_TRANSPORT_CONTRACT } from "./mcpRuntimeContract.js";
import { ASSET_RESPONSE_SCHEMAS, ASSET_OUTPUT_TYPES } from "./assetContracts.js";
import { adminSetup, authLogin } from "./accessSchemas.js";
import { ACCESS_RESPONSE_SCHEMAS, ACCESS_OUTPUT_TYPES } from "./accessContracts.js";
import * as z from "zod/v4";
import { publicRequestAllowed } from "../security/publicEntry.js";
import { HTTP_SECURITY_CONTRACT } from "../security/contracts.js";
import { aiOperations, AI_CONTRACT_VERSION } from "./operations.js";
import { runId, values } from "./schemas.js";
import { imageLayoutSchema } from "../domain/imageLayoutContracts.js";
import { mediaReferenceGroupsSchema, mediaReferenceSelectionSchema } from "../domain/mediaReferenceContracts.js";
import { capabilityDefinitionSchema, capabilityUsageSchema } from "./capabilitySchemas.js";
import { sceneDocument, workflowDocument, optionPreset } from "./sceneSchemas.js";

type Schema = Record<string, unknown>;
const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
const object = { type: "object", additionalProperties: true };
const outputTypes: Record<string, string> = { list_runs: "RunPage", get_task_concurrency: "TaskConcurrencySettings", update_task_concurrency: "TaskConcurrencySettings", get_run_media_export: "RunMediaExport", get_own_run_media_export: "RunMediaExport", get_workbench_upgrade: "WorkbenchUpgradeStatus", get_runtime_release: "RuntimeRelease", submit_system_feedback: "SystemFeedbackEnvelope", get_own_system_feedback: "SystemFeedbackEnvelope", get_system_feedback: "SystemFeedbackEnvelope", handle_system_feedback: "SystemFeedbackEnvelope", list_own_system_feedback: "SystemFeedbackPage", list_system_feedback: "SystemFeedbackPage", ...ASSET_OUTPUT_TYPES, list_task_drafts: "TaskDraftPage", get_task_draft: "TaskDraftEnvelope", set_task_draft_favorite: "TaskDraftEnvelope", get_workspace_status: "WorkspaceStatus", list_scenes: "SceneCatalog", list_capabilities: "CapabilityCatalog", create_scene: "SceneDraft", get_scene_draft: "SceneDraft", get_scene_draft_diff: "SceneDiffPage", get_scene_draft_diff_value: "SceneDiffValuePage", update_scene_draft: "SceneDraft", restore_scene_draft: "SceneDraft", publish_scene: "ScenePublication", get_scene: "PublishedScene", prepare_scene: "PublishedScene", list_option_presets: "OptionPresetPage", save_option_preset: "OptionPresetMutation", get_run_outputs: "RunOutputPage", get_step_result: "StepResult", get_run: "RunRecord", wait_run: "RunObservation", submit_scene: "SubmittedRun", resume_run: "SubmittedRun", rerun: "SubmittedRun", review_run: "SubmittedRun", cancel_run: "RunRecord", get_run_events: "EventPage" };
const status = { type: "string", enum: ["queued", "running", "cancelling", "waiting", "completed", "failed", "cancelled", "stale"] };
const observation: Schema = { type: "object", required: ["runId", "status", "timedOut", "nextAction"], properties: { runId: { type: "string" }, sceneId: { type: "string" }, status, runTitle: { type: "string" }, workflowName: { type: "string" }, createdAt: { type: "string" }, finishedAt: { type: "string" }, submitter: ref("RunSubmitter"), timedOut: { type: "boolean", description: "等待窗口耗尽，不代表任务失败" }, nextAction: { type: "string", enum: ["wait", "review", "inspect_before_recovery", "read_outputs"] }, pendingReview: ref("PendingReview"), steps: { type: "array", items: object }, outputCount: { type: "integer" }, error: { type: "string" } }, additionalProperties: true };

const schemaOf = (source: z.ZodType, name: string): Schema => {
  const schema = z.toJSONSchema(source, { io: "input" }) as Schema;
  delete schema.$schema;
  return JSON.parse(JSON.stringify(schema).replace(/#\/\$defs\//g, "#/components/schemas/" + name + "/$defs/")) as Schema;
};
export function createAiOpenApi(options: { userOnly?: boolean } = {}) {
  const schemas: Record<string, Schema> = {
    WorkbenchUpgradeStatus: schemaOf(upgradeStatusSchema, "WorkbenchUpgradeStatus"), RuntimeRelease: schemaOf(runtimeReleaseSchema, "RuntimeRelease"),
    SystemFeedback: schemaOf(systemFeedbackSchema, "SystemFeedback"), SystemFeedbackEnvelope: schemaOf(systemFeedbackEnvelope, "SystemFeedbackEnvelope"), SystemFeedbackPage: schemaOf(systemFeedbackPage, "SystemFeedbackPage"),
    TaskDraft: schemaOf(taskDraftSchema, "TaskDraft"), TaskDraftEnvelope: schemaOf(taskDraftEnvelopeSchema, "TaskDraftEnvelope"), TaskDraftPage: schemaOf(taskDraftPageSchema, "TaskDraftPage"),
    ...ACCESS_RESPONSE_SCHEMAS,
    ...ASSET_RESPONSE_SCHEMAS,
    RunStatus: status,
    RunSubmitter: { type: "object", required: ["userId", "username", "displayName"], properties: { userId: { type: "string", description: "由已验证服务端身份绑定的稳定用户ID；不是请求参数" }, username: { type: "string", description: "提交时的登录名快照" }, displayName: { type: "string", description: "提交时的显示名快照" } }, additionalProperties: false },
    RunSummary: { type: "object", required: ["runId", "sceneId", "workflowName", "status", "startedAt", "createdAt", "stepCount", "outputCount", "artifacts"], properties: { ownerUserId: { type: "string", description: "服务端验证身份的稳定归属ID；缺省表示历史未归属" }, submitter: ref("RunSubmitter"), runId: { type: "string" }, sceneId: { type: "string" }, workflowName: { type: "string" }, runTitle: { type: "string" }, status: ref("RunStatus"), startedAt: { type: "string" }, createdAt: { type: "string" }, finishedAt: { type: "string" }, durationMs: { type: "integer" }, stepCount: { type: "integer" }, outputCount: { type: "integer" }, error: { type: "string" }, artifacts: { type: "object", required: ["directory", "inputs", "workflow", "runtime", "output"], properties: { directory: { type: "string" }, inputs: { type: "string" }, workflow: { type: "string" }, runtime: { type: "string" }, output: { type: "string" } }, additionalProperties: false } }, additionalProperties: true },
    RunPage: { type: "object", required: ["projectDirectory", "runs"], properties: { projectDirectory: { type: "string" }, runs: { type: "array", items: ref("RunSummary") }, nextCursor: { type: "string" } }, additionalProperties: false },
    ImageLayout: schemaOf(imageLayoutSchema, "ImageLayout"),
    TaskConcurrencySettings: schemaOf(taskConcurrencySettingsSchema, "TaskConcurrencySettings"),
    RunMediaExport: schemaOf(runMediaExportSchema, "RunMediaExport"),
    DataZipConfig: schemaOf(dataZipConfigSchema, "DataZipConfig"),
    MediaReferenceGroups: schemaOf(mediaReferenceGroupsSchema, "MediaReferenceGroups"),
    MediaReferenceSelection: schemaOf(mediaReferenceSelectionSchema, "MediaReferenceSelection"),
    CapabilityUsage: schemaOf(capabilityUsageSchema, "CapabilityUsage"),
    CapabilityDefinition: schemaOf(capabilityDefinitionSchema, "CapabilityDefinition"),
    CapabilityCatalog: { type: "object", required: ["schemaVersion", "revision", "selectionPolicy", "capabilities", "hasMore"], properties: {
      schemaVersion: { type: "integer", const: 1 }, revision: { type: "string", pattern: "^[a-f0-9]{64}$", description: "完整能力目录快照revision；跨页保持一致" },
      selectionPolicy: { type: "object", required: ["sceneDifferences", "sceneSpecificLogic"], properties: { sceneDifferences: { const: "configuration-first" }, sceneSpecificLogic: { const: "core.code" } }, additionalProperties: false },
      capabilities: { type: "array", items: ref("CapabilityDefinition"), description: "完整声明，不截断字段；按安装注册顺序返回，不分基础/专用等级" }, hasMore: { type: "boolean" }, nextCursor: { type: "string", description: "hasMore:true时提供；绑定revision" },
    }, additionalProperties: false },
    WorkspaceStatus: { type: "object", required: ["authority", "initialized", "workspaceRevision", "catalogView", "executionView"], properties: { authority: { const: "sqlite" }, initialized: { type: "boolean" }, workspaceRevision: { type: ["integer", "null"], description: "数字工作区revision，与网页及get_workspace相同；变化后重读，不代表场景内容revision" }, catalogView: { const: "draft" }, executionView: { const: "published" } }, additionalProperties: false },
    SceneCatalogItem: { type: "object", required: ["sceneId", "title", "summary", "draftRevision", "draftMatchesPublished", "publishedTitle", "publishedSummary", "publishedVersionId", "publishedVersion", "publishedAt", "versions"], properties: {
      sceneId: { type: "string" }, title: { type: "string", description: "目录/流程草稿名称，与网页目录一致，不是发布快照名称" }, summary: { type: "string" }, draftRevision: { type: "string", pattern: "^[a-f0-9]{64}$" }, draftMatchesPublished: { type: "boolean", description: "使用与get_scene_draft相同的内容比较，包括发布时能力版本固定" }, publishedTitle: { type: ["string", "null"], description: "当前发布快照名称，与创作页/get_scene一致" }, publishedSummary: { type: ["string", "null"] }, publishedVersionId: { type: ["string", "null"] }, publishedVersion: { type: ["string", "null"] }, publishedAt: { type: ["string", "null"] }, versions: { type: "array", maxItems: 10, items: { type: "object", required: ["versionId", "version", "publishedAt"], properties: { versionId: { type: "string" }, version: { type: "string" }, publishedAt: { type: "string" } }, additionalProperties: false } },
    }, additionalProperties: false },
    SceneCatalog: { type: "object", required: ["workspaceRevision", "initialized", "catalogView", "executionView", "total", "scenes", "hasMore"], properties: { workspaceRevision: { type: ["integer", "null"] }, initialized: { type: "boolean" }, catalogView: { const: "draft" }, executionView: { const: "published" }, total: { type: "integer" }, scenes: { type: "array", items: ref("SceneCatalogItem") }, hasMore: { type: "boolean" }, nextCursor: { type: "string", description: "绑定当前工作区revision与目录顺序；场景编辑/删除/排序后返回409 SCENE_PAGE_CHANGED，重读第一页" } }, additionalProperties: false },
    SceneDiffPage: schemaOf(sceneDiffPageSchema, "SceneDiffPage"),
    SceneDiffValuePage: schemaOf(sceneDiffValuePageSchema, "SceneDiffValuePage"),
    SceneDocument: schemaOf(sceneDocument, "SceneDocument"),
    WorkflowDocument: schemaOf(workflowDocument, "WorkflowDocument"),
    // Input-only derived-field prohibitions must not invalidate the read projection.
    OptionPreset: schemaOf(optionPreset.omit({ revision: true, usedBySceneIds: true }), "OptionPreset"),
    OptionPresetMutation: { type: "object", required: ["created", "preset", "workspaceRevision"], properties: { created: { type: "boolean" }, preset: { allOf: [ref("OptionPreset"), { type: "object", required: ["revision"], properties: { revision: { type: "string", pattern: "^[a-f0-9]{64}$" } } }] }, workspaceRevision: { type: "integer" } }, additionalProperties: true },
    SceneDraft: { type: "object", required: ["view", "sceneId", "revision", "scene", "workflow", "optionPresets", "publishedVersionId"], properties: { view: { const: "draft" }, sceneId: { type: "string" }, revision: { type: "string", pattern: "^[a-f0-9]{64}$" }, workspaceRevision: { type: ["integer", "null"] }, contentHash: { type: "string" }, scene: ref("SceneDocument"), workflow: { anyOf: [ref("WorkflowDocument"), { type: "null" }], description: "完整草稿流程；图生图方言转换复用hermesProfile/promptTemplate及text输出绑定，保留原图顺序和采样配置；草稿不等于已发布快照" }, optionPresets: { type: "array", items: ref("OptionPreset") }, publishedVersionId: { type: ["string", "null"] }, versions: { type: "array", items: object }, missingPresetIds: { type: "array", items: { type: "string" } }, draftMatchesPublished: { type: "boolean" } }, additionalProperties: true },
    ScenePublication: { type: "object", required: ["sceneId", "versionId", "version", "created", "isCurrentPublished", "revision"], properties: { view: { const: "published" }, sceneId: { type: "string" }, versionId: { type: "string" }, version: { type: "string", pattern: "^[a-f0-9]{8}$" }, publishedAt: { type: "string" }, revision: { type: "string" }, created: { type: "boolean" }, isCurrentPublished: { type: "boolean" } }, additionalProperties: true },
    MediaExecutionAccess: { type: "object", const: ASSET_MEDIA_EXECUTION_CONTRACT, description: "固定素材版本的服务端内部执行读取与凭证边界；不授予客户端读取或签名权限" },
    SceneInputRequirement: { type: "object", required: ["key", "type", "required", "hidden", "needsValue"], properties: { key: { type: "string" }, type: { type: "string" }, required: { type: "boolean" }, minimum: { type: "number", description: "数字输入（或数字行字段）的包含下限；省略表示不限制" }, maximum: { type: "number", description: "数字输入（或数字行字段）的包含上限；省略表示不限制" }, hidden: { type: "boolean", description: "网页表单展示设置，不是访问控制；值仍参与输入契约和执行。隐藏必填字段必须有有效默认值" }, needsValue: { type: "boolean" }, mediaRole: { type: "string", enum: ["reference", "character", "scene", "prop", "voice_reference"], description: "固定发布快照的素材用途；与媒体类型分离，参考音色不是驱动音轨" }, options: { type: "array", items: { type: "string" } }, inputMode: { type: "string", enum: ["object_array"], description: "用户以可增删的行表单填写对象数组，不提交JSON文本" }, itemFields: { type: "array", items: { type: "object", required: ["key", "label", "type", "required"], properties: { key: { type: "string" }, label: { type: "string" }, type: { type: "string", enum: ["text", "number", "boolean", "select"] }, required: { type: "boolean" }, minimum: { type: "number" }, maximum: { type: "number" }, options: { type: "array", items: { type: "string" } } }, additionalProperties: true } }, defaultValue: {}, mediaReference: { type: "object", required: ["assetId", "assetVersion"], properties: { assetId: { type: "string" }, assetVersion: { type: "string", description: "正整数固定版本的说明，不是可执行示例" } }, additionalProperties: false }, mediaExecution: ref("MediaExecutionAccess") }, additionalProperties: false },
    PublishedScene: { type: "object", required: ["view", "sceneId", "versionId", "workflow", "inputSchema", "inputDefaults", "inputRequirements", "missingRequiredInputs", "inputExamples"], properties: { sceneId: { type: "string" }, versionId: { type: "string" }, version: { type: "string" }, scene: { ...ref("SceneDocument"), description: "指定发布快照的场景，scene.title用于创作与该版本的展示，不取最新草稿或workflow.name" }, workflow: { ...ref("WorkflowDocument"), description: "指定发布快照的流程；name是独立配置名，不是场景标题，不因展示修复改写" }, inputSchema: { ...object, description: "按固定发布快照描述已声明字段、字段级约束与默认值；字段x-hidden:true表示从网页输入表单隐藏，但值仍参与契约和执行且HTTP/MCP仍可显式提交，这不是访问控制；additionalProperties为true，未声明的额外键可透传并保存到运行输入，但不作为workflow.inputs字段校验，也不改变工作流绑定。媒体属性可含x-media-role（人物/场景/道具/参考音色），与inputRequirements.mediaRole同取快照；不读取草稿。公开prompt是想法而非AIXG最终提示词" }, inputDefaults: { ...object, description: "固定发布快照中的显式默认值；新版图生图ratio默认1:1 (Square)、mp默认1（MP），不是新增用户字段" }, inputRequirements: { type: "array", items: ref("SceneInputRequirement") }, missingRequiredInputs: { type: "array", items: { type: "string" } }, inputExamples: { type: "array", items: { type: "object", required: ["inputValues", "requiresUserInput", "missingRequiredInputs", "syntacticallyComplete"], properties: { inputValues: object, requiresUserInput: { type: "array", items: { type: "string" } }, missingRequiredInputs: { type: "array", items: { type: "string" } }, syntacticallyComplete: { type: "boolean" } }, additionalProperties: true } }, boundaries: object }, additionalProperties: true },
    OptionPresetPage: { type: "object", required: ["presets", "hasMore"], properties: { presets: { type: "array", items: { allOf: [ref("OptionPreset"), { type: "object", required: ["revision", "usedBySceneIds"], properties: { revision: { type: "string" }, usedBySceneIds: { type: "array", items: { type: "string" } } } }] } }, hasMore: { type: "boolean" }, nextCursor: { type: "string" } }, additionalProperties: true },
    OutputProjection: { type: "object", required: ["key", "type", "source", "valuePage"], properties: { key: { type: "string" }, type: { type: "string" }, label: { type: "string" }, source: object, value: {}, valueOmitted: { type: "boolean" }, omissionReason: { type: "string" }, valueBytes: { type: "integer" }, valuePage: { type: "object", required: ["kind", "total", "offset", "count", "pageSize", "complete", "hasMore"], properties: { kind: { enum: ["array", "scalar", "string"] }, total: { type: "integer" }, offset: { type: "integer" }, count: { type: "integer" }, pageSize: { type: "integer" }, complete: { type: "boolean" }, hasMore: { type: "boolean" }, nextValueOffset: { type: "integer" } } }, mediaReferences: { type: "array", items: { type: "object", required: ["source", "url"], properties: { source: object, url: { type: "string" } } } } }, additionalProperties: true },
    AgentResponseProjection: { type: "object", required: ["valuePage", "valueBytes"], properties: { value: { type: "string", description: "完整Hermes原始返回，按textOffset/textLimit分段时为当前片段；保留首尾空白" }, valueOmitted: { type: "boolean" }, omissionReason: { type: "string" }, valueBytes: { type: "integer" }, nextAction: { type: "string" }, valuePage: { type: "object", required: ["kind", "total", "offset", "count", "pageSize", "complete", "hasMore"], properties: { kind: { enum: ["scalar", "string"] }, total: { type: "integer" }, offset: { type: "integer" }, count: { type: "integer" }, pageSize: { type: "integer" }, complete: { type: "boolean" }, hasMore: { type: "boolean" }, nextValueOffset: { type: "integer" } } } }, additionalProperties: false },
    RunOutputPage: { type: "object", required: ["runId", "status", "revision", "outputs", "total", "hasMore"], properties: { runId: { type: "string" }, status, revision: { type: "string" }, outputs: { type: "array", items: ref("OutputProjection") }, total: { type: "integer" }, hasMore: { type: "boolean" }, nextCursor: { type: "string" } }, additionalProperties: true },
    StepResult: { type: "object", required: ["runId", "stepId", "status", "revision", "items", "hasMore"], properties: { runId: { type: "string" }, stepId: { type: "string" }, status: { enum: ["running", "completed", "skipped", "failed", "cancelled"] }, startedAt: { type: "string", description: "步骤实际开始时间；运行中可用于计算实时用时" }, durationMs: { type: "integer", description: "步骤实际执行用时；for_each是墙钟时间，不含审核等待；历史记录可能缺失" }, revision: { type: "string" }, warnings: { type: "array", items: { type: "string" }, description: "非阻断业务提示；不会改变运行状态，不自动重试模型" }, agentResponse: { ...ref("AgentResponseProjection"), description: "解析或输出校验失败时保存的Hermes完整原始返回" }, outputs: { type: "array", items: ref("OutputProjection") }, items: { type: "array", items: { type: "object", required: ["index", "status", "outputs"], properties: { index: { type: "integer" }, status: { type: "string" }, startedAt: { type: "string", description: "逐项实际开始时间；运行中可用于计算实时用时" }, durationMs: { type: "integer", description: "该逐项执行的实际用时" }, warnings: { type: "array", items: { type: "string" }, description: "非阻断业务提示；不会改变运行状态，不自动重试模型" }, agentResponse: { ...ref("AgentResponseProjection"), description: "该for_each项解析或输出校验失败时保存的Hermes完整原始返回" }, outputs: { type: "array", items: ref("OutputProjection") } }, additionalProperties: true } }, hasMore: { type: "boolean" }, nextCursor: { type: "string" } }, additionalProperties: true },
    ApiError: { type: "object", required: ["error", "code"], properties: { error: { type: "string" }, code: { type: "string" }, requestId: { type: "string" }, details: object } },
    SubmittedRun: { type: "object", required: ["runId", "status"], properties: { runId: { type: "string" }, status, createdAt: { type: "string" }, sceneId: { type: "string" }, versionId: { type: "string" }, version: { type: "string" } }, additionalProperties: true },
    PendingReview: { type: "object", required: ["id", "stepId", "name", "createdAt"], properties: { id: { type: "string" }, stepId: { type: "string" }, name: { type: "string" }, createdAt: { type: "string" }, instruction: { type: "string" } } },
    RunRecord: {
      type: "object", required: ["runId", "status", "workflow", "inputValues", "steps", "outputs"],
      properties: {
        ownerUserId: { type: "string", description: "服务端验证身份的稳定归属ID；未归属历史省略" }, submitter: ref("RunSubmitter"), runId: { type: "string" }, sceneId: { type: "string" }, status,
        workflow: object, inputValues: object, pendingReview: ref("PendingReview"),
        steps: { type: "array", items: { type: "object", properties: {
          startedAt: { type: "string", description: "步骤实际开始时间；运行中可用于计算实时用时" }, finishedAt: { type: "string" }, durationMs: { type: "integer", description: "步骤实际执行用时；for_each是墙钟时间，不含审核等待" },
          agentPrompt: { type: "string", description: "该步骤实际发送给Hermes Agent的完整文本，包含模板展开、解析后的步骤输入、反馈和输出要求；仅执行时保存，历史快照不补写" },
          agentResponse: { type: "string", description: "解析或输出校验失败时保存的Hermes完整原始返回，保留首尾空白；未失败不写入，旧历史不补写" },
          warnings: { type: "array", items: { type: "string" }, description: "非阻断业务提示；不会改变运行状态，不自动重试模型" },
          items: { type: "array", items: { type: "object", properties: {
            startedAt: { type: "string", description: "逐项实际开始时间；运行中可用于计算实时用时" }, finishedAt: { type: "string" }, durationMs: { type: "integer", description: "该逐项执行的实际用时" },
            agentPrompt: { type: "string", description: "该for_each项实际发送给Hermes Agent的完整文本" },
            agentResponse: { type: "string", description: "该for_each项解析或输出校验失败时保存的Hermes完整原始返回，保留首尾空白" },
            warnings: { type: "array", items: { type: "string" }, description: "非阻断业务提示；不会改变运行状态，不自动重试模型" },
          }, additionalProperties: true } },
        }, additionalProperties: true } },
        outputs: { type: "array", items: { type: "object", required: ["key", "type", "value"], properties: { key: { type: "string" }, label: { type: "string" }, type: { type: "string" }, value: {} } } },
        error: { type: "string" }, archiveWarnings: { type: "array", items: { type: "string" } },
      }, additionalProperties: true,
    },
    RunObservation: observation,
    EventPage: { type: "object", required: ["events", "nextSequence", "hasMore"], properties: { events: { type: "array", items: { type: "object", required: ["runId", "sequence", "type", "at"], properties: { runId: { type: "string" }, sequence: { type: "integer" }, type: { type: "string" }, at: { type: "string" }, payload: object }, additionalProperties: true } }, nextSequence: { type: "integer" }, hasMore: { type: "boolean" } } },
  };
  const paths: Record<string, Record<string, unknown>> = {};
  const errors = Object.fromEntries([400, 401, 403, 404, 409, 413, 429, 500, 503].map(code => [String(code), { description: code === 429 ? "LOGIN_RATE_LIMITED；遵守Retry-After秒数，不自动重放登录或业务写入。" : code === 409 ? "状态/版本冲突；RUN_PREPARING 遵守 Retry-After。其它冲突先重读，禁止盲重试。" : "业务错误；执行响应5xx可能已经提交，查询原runId。", headers: { "X-Request-ID": { schema: { type: "string" } }, "Retry-After": { schema: { type: "string" }, description: "RUN_PREPARING 的重查或LOGIN_RATE_LIMITED的登录等待秒数" } }, content: { "application/json": { schema: ref("ApiError") } } }]));
  const install = (operation: typeof aiOperations[number]) => {
    const name = operation.name + "Input";
    const input = z.toJSONSchema(operation.schema, { io: "input" }) as Schema;
    delete input.$schema;
    // Zod recursive JSON refs are document-root relative. Relocate them into their component.
    const encoded = JSON.stringify(input).replace(/#\/\$defs\//g, "#/components/schemas/" + name + "/$defs/");
    schemas[name] = JSON.parse(encoded) as Schema;
    const properties = schemas[name].properties as Record<string, Schema>;
    const required = schemas[name].required as string[] ?? [];
    const pathNames = [...operation.path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
    const parameters: unknown[] = pathNames.map(key => ({ name: key, in: "path", required: true, schema: { $ref: "#/components/schemas/" + name + "/properties/" + key } }));
    const rest = Object.keys(properties).filter(key => !pathNames.includes(key) && !(operation.upload && key === "filePath"));
    if (operation.method === "GET" || operation.upload) parameters.push(...rest.map(key => ({ name: key, in: "query", required: required.includes(key), schema: { $ref: "#/components/schemas/" + name + "/properties/" + key } })));
    let requestBody: unknown;
    if (operation.upload) {
      parameters.push({ name: "X-File-Name", in: "header", required: true, description: "encodeURIComponent 编码的文件名", schema: { type: "string" } });
      requestBody = { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary", description: "最大250MB；filePath仅用于stdio工具，不是HTTP参数" } } } };
    } else if (operation.method !== "GET" && rest.length) {
      requestBody = { required: required.some(key => rest.includes(key)), content: { "application/json": { schema: { type: "object", properties: Object.fromEntries(rest.map(key => [key, { $ref: "#/components/schemas/" + name + "/properties/" + key }])), ...(required.some(key => rest.includes(key)) ? { required: required.filter(key => rest.includes(key)) } : {}), additionalProperties: false } } } };
    }
    paths[operation.path] ??= {};
    paths[operation.path][operation.method.toLowerCase()] = { operationId: operation.name, description: operation.description, "x-ai-effect": operation.effect, "x-access-role": operation.access ?? "admin", security:[{BearerAuth:[]},{SessionCookie:[]}], "x-mcp-tool": operation.name, ...(parameters.length ? { parameters } : {}), ...(requestBody ? { requestBody } : {}), responses: { [operation.success]: { description: operation.success === 202 ? "已接受；保存runId，有限等待或查询，不能重复提交。" : "成功。HTTP直接返回业务对象；MCP包裹为{ok,data,requestId?}。", headers: { "X-Request-ID": { schema: { type: "string" } } }, content: { "application/json": { schema: (ACCESS_OUTPUT_TYPES[operation.name] ?? outputTypes[operation.name]) ? ref(ACCESS_OUTPUT_TYPES[operation.name] ?? outputTypes[operation.name]) : object } } }, ...errors } };
  };
  aiOperations.forEach(install);
  for (const operation of [
    { name: "auth_status_http", path: "/api/auth/status", method: "GET" as const, schema: z.object({}).strict(), effect: "read" as const, success: 200, description: "只读初始化状态；不泄露账号，不自动创建管理员。", responseType: "AuthStatus" },
    { name: "auth_setup_http", path: "/api/auth/setup", method: "POST" as const, schema: adminSetup, effect: "write" as const, success: 201, description: "仅服务器loopback显式初始化首个管理员；无默认密码。保存userId，响应丢失先查初始化状态，再用原登录名登录，不能自动重复创建。成功设置HttpOnly会话Cookie，不返回会话密钥。", responseType: "UserEnvelope" },
    { name: "auth_login_http", path: "/api/auth/login", method: "POST" as const, schema: authLogin, effect: "write" as const, success: 200, description: "人工配置账户后的浏览器登录。成功设置HttpOnly会话Cookie；AI优先使用本人API token，不把管理员密码放入工具配置。", responseType: "UserEnvelope" },
    { name: "auth_logout_http", path: "/api/v1/self/logout", method: "POST" as const, schema: z.object({}).strict(), effect: "write" as const, success: 200, description: "吊销当前会话/凭证并清除浏览器会话Cookie。其他设备会话不受影响；不删除用户或数据。", responseType: "AuthLogout" },
  ]) {
    install(operation);
    const document = paths[operation.path][operation.method.toLowerCase()] as Schema;
    delete document["x-mcp-tool"];
    document["x-access-role"] = operation.name === "auth_logout_http" ? "authenticated" : operation.name === "auth_setup_http" ? "local_setup" : "public";
    if (operation.name !== "auth_logout_http") document.security = [];
    const responses = document.responses as Record<string, Schema>;
    responses[operation.success].content = { "application/json": { schema: ref(operation.responseType) } };
  }
  const publishResponses = (paths["/api/v1/scenes/{sceneId}/publish"].post as { responses: Record<string, Schema> }).responses;
  publishResponses["200"] = { ...publishResponses["201"], description: "同publicationId、同revision的已保存发布回执；不创建新版本，也不切回旧发布指针。" };
  install({ name: "submit_workflow_http", path: "/api/v1/runs", method: "POST", schema: z.object({ runId, workflow: z.object({ sceneId: z.string().optional(), name: z.string().optional(), inputs: z.array(values).max(200), steps: z.array(values).max(100), outputs: z.array(values), execution: values.optional() }).passthrough(), inputValues: values, runTitle: z.string().max(120).optional() }).strict(), effect: "execute", success: 202, description: "高级HTTP入口：直接提交完整流程快照，无需写入工作区。AI推荐submit_scene；此接口服务端兼容省略runId，但自动化客户端必须预先保存runId以便提交对账。" });
  // This HTTP-only operation isn't a registered MCP tool.
  delete (paths["/api/v1/runs"].post as Schema)["x-mcp-tool"];
  for (const mediaPath of ["/api/v1/assets/{assetId}/versions/{version}/media", "/api/v1/assets/{assetId}/versions/{version}/preview", "/api/v1/runs/{runId}/output-media", "/api/v1/runs/{runId}/media/{filename}", "/api/v1/runs/{runId}/media/{filename}/preview"]) {
    const parameters: unknown[] = [...mediaPath.matchAll(/\{([^}]+)\}/g)].map(match => ({ name: match[1], in: "path", required: true, schema: match[1] === "version" ? { type: "integer", minimum: 1 } : { type: "string" } }));
    parameters.push({ name: "Range", in: "header", schema: { type: "string" } });
    if (mediaPath.endsWith("output-media")) for (const key of ["stepId", "itemIndex", "outputKey", "mediaIndex"]) parameters.push({ name: key, in: "query", required: key === "outputKey", schema: key.endsWith("Index") ? { type: "integer", minimum: 0 } : { type: "string" } });
    const preview = mediaPath.endsWith("/preview");
    if (preview || mediaPath.endsWith("output-media")) parameters.push({ name: "w", in: "query", required: false, schema: { type: "integer", minimum: 16, maximum: 2048, default: 512, description: "显示用缩放宽度：图片返回 WebP 派生图，非图片或缩放失败回退原字节；省略为原媒体。" } });
    const op = { description: preview ? "读取服务端归档媒体的缩放预览（WebP 派生图，仅显示用，不修改原媒体、不参与执行/导出/归档）。图片按 w 缩放，非图片或缩放失败回退原字节；鉴权与原媒体完全一致。支持 HEAD/Range。输出定位由记录解析，不接受任意本地路径。最终输出不传 stepId/itemIndex。" : "读取服务端归档媒体；支持 HEAD/Range。输出定位由记录解析，不接受任意本地路径。最终输出不传 stepId/itemIndex。", parameters, responses: { 200: { description: preview ? "预览内容或回退的原媒体" : "媒体内容", content: preview ? { "image/webp": { schema: { type: "string", format: "binary" } }, "application/octet-stream": { schema: { type: "string", format: "binary" } } } : { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }, 206: { description: "Range 内容" }, 416: { description: "Range 无效" }, ...errors } };
    const kind = mediaPath.includes("assets") ? "asset" : mediaPath.includes("output-media") ? "output" : "archived";
    paths[mediaPath] = { get: { ...op, operationId: "media_" + kind + (preview ? "_preview" : "") }, head: { ...op, operationId: "head_" + kind + (preview ? "_preview" : ""), responses: { 200: { description: "媒体头，无 body" }, ...errors } } };
  }
  paths["/api/v1/runs/{runId}/events"] = { get: { operationId: "stream_run_events", description: "SSE事件流。重连携带Last-Event-ID或after；终态发送完关闭。MCP不保持无限等待。", parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }, { name: "after", in: "query", schema: { type: "integer", minimum: 0 } }, { name: "Last-Event-ID", in: "header", schema: { type: "string" } }], responses: { 200: { description: "id为sequence；data为{event,run}。", content: { "text/event-stream": { schema: { type: "string" } } } }, ...errors } } };
  paths["/api/v1/ai/openapi.json"] = { get: { operationId: "get_ai_openapi", responses: { 200: { description: "此OpenAPI文档", content: { "application/json": { schema: object } } } } } };
  paths["/api/v1/ai/guide"] = { get: { operationId: "get_ai_guide", responses: { 200: { description: "AI操作手册", content: { "text/markdown": { schema: { type: "string" } } } } } } };
  if (options.userOnly) for (const [path, methods] of Object.entries(paths)) {
    for (const method of Object.keys(methods)) if (!publicRequestAllowed(method.toUpperCase(), path.replace(/\{[^}]+\}/g, "1"))) delete methods[method];
    if (!Object.keys(methods).length) delete paths[path];
  }
  return { openapi: "3.1.0", "x-comfy-ui-routing": COMFY_UI_ROUTING_CONTRACT, "x-comfy-static-switch": COMFY_STATIC_SWITCH_CONTRACT, "x-for-each-carry": ITERATION_CARRY_CONTRACT, "x-http-security": HTTP_SECURITY_CONTRACT, "x-third-party-json-request": THIRD_PARTY_JSON_REQUEST_CONTRACT, "x-code-step": CODE_STEP_CONTRACT, "x-entry-mode": options.userOnly ? "user-only" : "full", "x-h3-prompt-sections": H3_PROMPT_SECTIONS_CONTRACT, "x-hermes-output-json": HERMES_OUTPUT_JSON_CONTRACT, "x-mcp-transport": AI_MCP_TRANSPORT_CONTRACT, "x-asset-media-execution": ASSET_MEDIA_EXECUTION_CONTRACT, info: { title: "Zane Workbench AI API", version: AI_CONTRACT_VERSION, description: "AI操作面契约，不是所有旧版设置/连接器接口的全集。工具参数与文档同源；只读/预检不生成，执行可能计费。MCP响应包装与原HTTP对象不同。" }, servers: [{ url: "/", description: "以实际工作台后台地址为基址" }], paths, security: [{BearerAuth:[]},{SessionCookie:[]}], components: { schemas, securitySchemes:{BearerAuth:{type:"http",scheme:"bearer",description:"ZANE_API_TOKEN，继承本人实时角色和场景授权"},SessionCookie:{type:"apiKey",in:"cookie",name:"zane_session"}} } };
}
