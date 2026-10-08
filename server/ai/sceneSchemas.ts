import { workflowMediaRoles, validWorkflowMediaRole } from "../domain/workflowMediaRoles.js";
import { iterationCarrySchema } from "../domain/iterationCarry.js";
import * as z from "zod/v4";
import { id, selection, stepInput, values } from "./schemas.js";

// Keep editor metadata and future package fields, while validating known fields.
// Replacements are whole scene/workflow documents, not ambiguous deep patches.
const extensible = <S extends z.ZodRawShape>(shape: S) => z.object(shape).catchall(z.json());
export const resourceId = id.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
export const contentRevision = z.string().regex(/^[a-f0-9]{64}$/).describe("get_scene_draft或预设读取返回的内容revision，不是全工作区数字revision");
export const fieldType = z.enum(["text", "textarea", "number", "boolean", "select", "json", "image", "video", "audio", "image_list", "video_list", "audio_list"]);
export const mediaRole = z.enum(workflowMediaRoles).describe("可选素材用途，不是新的媒体类型：reference通用参考；character人物、scene场景、prop道具仅配image/image_list；voice_reference音色仅配audio/audio_list且不是驱动音轨。只用于输入，省略兼容旧快照；各组独立上传编号，同一端口按bindings顺序合并，不改变授权或固定版本");
export const objectArrayItemField = extensible({ key: id, label: z.string().min(1).max(200), type: z.enum(["text", "number", "boolean", "select"]), required: z.boolean(), minimum: z.number().finite().optional().describe("number类型的可选包含下限"), maximum: z.number().finite().optional().describe("number类型的可选包含上限"), placeholder: z.string().optional(), options: z.array(z.string()).max(1000).optional() })
  .refine(field => field.type === "number" || (field.minimum === undefined && field.maximum === undefined), { message: "最小值和最大值只适用于数字字段", path: ["minimum"] })
  .refine(field => field.minimum === undefined || field.maximum === undefined || field.minimum <= field.maximum, { message: "最小值不能大于最大值", path: ["maximum"] });
export const inputField = extensible({ mediaRole: mediaRole.optional(), key: id, label: z.string().optional(), type: fieldType, required: z.boolean().optional(), minimum: z.number().finite().optional().describe("number类型的可选包含下限"), maximum: z.number().finite().optional().describe("number类型的可选包含上限"), hidden: z.boolean().optional().describe("true时从网页创作/用户输入表单隐藏；字段仍保留在输入契约、草稿与流程执行中。隐藏的必填字段需要有效defaultValue；这是展示设置，不限制HTTP/MCP调用"), placeholder: z.string().optional(), options: z.array(z.string()).max(1000).optional(), optionPresetId: resourceId.optional(), inputMode: z.literal("object_array").optional().describe("将json字段作为可增删的对象数组表单填写；必须同时声明itemFields；数组最多100行"), itemFields: z.array(objectArrayItemField).max(50).optional().describe("对象数组每行字段；支持文本、数字、布尔和带选项的下拉框；key须唯一，必填字段需填写") , defaultValue: z.json().optional().describe("可选默认输入值；类型和select选项必须匹配。发布后作为创作表单预填，用户输入可覆盖；媒体默认值使用授权的固定素材引用") })
  .refine(field => validWorkflowMediaRole(field.mediaRole, field.type), { message: "素材用途与场景输入类型不兼容", path: ["mediaRole"] })
  .refine(field => field.type === "number" || (field.minimum === undefined && field.maximum === undefined), { message: "最小值和最大值只适用于数字字段", path: ["minimum"] })
  .refine(field => field.minimum === undefined || field.maximum === undefined || field.minimum <= field.maximum, { message: "最小值不能大于最大值", path: ["maximum"] })
  .refine(field => (field.inputMode === "object_array") === Array.isArray(field.itemFields), { message: "对象数组表单必须同时声明inputMode和itemFields", path: ["itemFields"] })
  .refine(field => !field.itemFields || (field.type === "json" && field.itemFields.length > 0 && new Set(field.itemFields.map(item => item.key)).size === field.itemFields.length), { message: "对象数组字段必须使用json类型，且至少声明一个不重复的子字段", path: ["itemFields"] })
  .refine(field => !field.itemFields?.some(item => item.type === "select" && !item.options?.length), { message: "对象数组下拉字段至少需要一个选项", path: ["itemFields"] });
const execution = extensible({ mode: z.enum(["once", "for_each"]).optional(), sourceRef: z.string().optional(), onError: z.enum(["continue", "stop"]).optional(), maxConcurrency: z.int().min(1).max(32).optional(), carry: iterationCarrySchema.optional().describe("仅步骤级for_each可用；启用后串行且失败停止；显式maxConcurrency必须1、onError必须stop；普通遍历不变") });
const legacyExecution = execution.extend({ carry: z.never().optional() });
const port = extensible({ key: id, label: z.string().optional(), description: z.string().optional(), type: fieldType });
const binding = extensible({ mediaRole: mediaRole.optional(), key: id, label: z.string().optional(), direction: z.enum(["input", "output"]), nodeId: id.describe("当前workflowFile中的真实节点ID；切换工作流必须重核对，双采长文JSON为201而非196"), property: id.describe("真实输入/输出端口；长文shot_json绑定String，整镜JSON序列化为text；物理素材绑定只接合并后的image_list/audio_list/video_list；H3引用iteration.item.references.images/audios绑定ref_images/ref_audios，人物/场景/道具分类不是新端口"), type: fieldType, options: z.array(z.string()).optional(), required: z.boolean().optional(), sourceRef: z.string().optional(), valueSource: z.enum(["literal", "reference"]).optional(), literalValue: z.string().optional(), selection: selection.optional(), sourceInputFormat: extensible({ type: fieldType, required: z.boolean().optional(), options: z.array(z.string()).optional(), optionPresetId: resourceId.optional() }).optional() }).refine(binding => validWorkflowMediaRole(binding.mediaRole, binding.type, binding.direction), { message: "素材用途与ComfyUI绑定类型/方向不兼容", path: ["mediaRole"] });
const step = extensible({
  id: resourceId, name: z.string().min(1).max(200), kind: id,
  capabilityId: id.optional(), capabilityVersion: id.optional(), capabilityConfig: values.optional(), hermesProfile: z.string().describe("已启用的Hermes Profile；Qwen图生图用writer整理图片与想法再由aixg转换；长文用writer输出storyboard/shots、aixg按writer.shots逐镜输出text prompt，生成prompts引用汇总列表；原分镜元数据不交模型回写").optional(),
  promptTemplate: z.string().describe("基础步骤提示词模板；AI套图逐张计划包含稳定唯一ID与完整设计brief（包括所需文字/图形/版式），data.zip只校验数量/结构并关联媒体bundle与AIXG完整成图提示词；ComfyUI直接生成完整图片，收集并交付模型原始结果，不配置add_text、layout或后置文案排版。样张与成图使用通用review，剩余图片使用for_each，不新增电商适配器。图生图writer输出text edit_brief，aixg模板引用该输出而非原始想法，明确改动/保持与真实图片编号，输出text prompt再绑定ComfyUI正向端口；不在提示词中调用生成工具").optional(), inputs: z.array(stepInput).max(200).optional(), outputs: z.array(port).max(200).optional(), execution: execution.optional(),
  comfyui: extensible({ workflowFile: z.string().describe("已安装ComfyUI工作流路径；文本视频Zane/video_双采.json，长文整镜JSON用Zane/video_双采_json.json；配置不等于发布或生成"), bindings: z.array(binding).max(1000).optional(), adapter: z.string().optional(), h3LongVideo: extensible({ planRef: z.string(), promptRowsRef: z.string(), referenceImagesRef: z.string(), materialNoteRef: z.string().optional() }).optional() }).optional(),
  control: extensible({ type: z.literal("condition"), match: z.enum(["all", "any"]), rules: z.array(extensible({ id, leftRef: z.string(), operator: id, valueSource: z.enum(["literal", "reference"]), rightValue: z.string().optional(), rightRef: z.string().optional() })).max(200) }).optional(),
  review: extensible({ enabled: z.boolean(), instruction: z.string().optional() }).optional(),
  runCondition: extensible({ conditionStepId: resourceId, expectedResult: z.boolean() }).optional(),
});
export const sceneDocument = extensible({ id: resourceId, title: z.string().min(1).max(200).describe("场景展示标题；目录取草稿，创作与版本列表取对应发布快照。独立于workflow.name，改名不自动发布或改写历史"), shortTitle: z.string().optional(), summary: z.string().optional(), description: z.string().optional(), cover: z.string().optional(), coverPosition: z.string().optional(), accent: z.enum(["green", "coral"]).optional(), stages: z.array(z.string()).optional() });
export const workflowDocument = extensible({ id: id.optional(), sceneId: resourceId.optional(), name: z.string().describe("独立流程配置名，可与场景标题不同；不能作为场景展示标题。改scene.title不会自动改此字段或历史运行workflowName").optional(), inputs: z.array(inputField).max(200), steps: z.array(step).max(100), outputs: z.array(port.extend({ sourceRef: z.string().min(1), selection: selection.optional() })).max(200), execution: legacyExecution.optional() });
export const optionPreset = extensible({ id: resourceId, name: z.string().min(1).max(200), options: z.array(z.string()).max(1000), revision: z.never().optional().describe("只读派生字段，不可写入预设"), usedBySceneIds: z.never().optional().describe("只读引用关系，不可写入预设") });
export const createScene = z.object({ scene: sceneDocument, workflow: workflowDocument, optionPresets: z.array(optionPreset).max(200).optional() }).strict();
export const updateSceneDraft = z.object({ revision: contentRevision, scene: sceneDocument.optional(), workflow: workflowDocument.optional(), optionPresets: z.array(optionPreset).max(200).optional() }).strict();
export const revisionRequest = z.object({ revision: contentRevision }).strict();
export const publishScene = revisionRequest.extend({ publicationId: z.uuid().describe("调用前保存的UUID，将成为发布versionId；响应丢失先读同一versionId对账") }).strict();
export const restoreSceneDraft = revisionRequest.extend({ versionId: id }).strict();
export const saveOptionPreset = z.object({ preset: optionPreset, revision: contentRevision.optional().describe("新建时省略；修改现有预设必须使用读取到的revision") }).strict();
export const sceneQuery = z.object({ limit: z.int().min(1).max(200).default(50), cursor: z.string().max(4096).optional() }).strict();
export type SceneQuery = z.output<typeof sceneQuery>;

export const presetQuery = z.object({ q: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().optional() }).strict();
export type SceneCreate = z.output<typeof createScene>;
export type SceneUpdate = z.output<typeof updateSceneDraft>;

export const outputQuery = z.object({ textOffset: z.coerce.number().int().nonnegative().default(0), textLimit: z.coerce.number().int().min(1).max(32768).optional(), outputKey: id.optional(), cursor: z.string().max(4096).optional(), limit: z.coerce.number().int().min(1).max(100).default(20), valueOffset: z.coerce.number().int().nonnegative().default(0), valueLimit: z.coerce.number().int().min(1).max(200).default(20), includeValues: z.boolean().default(true), maxValueBytes: z.coerce.number().int().min(1024).max(262144).default(32768) }).strict();
export const stepResultQuery = outputQuery.extend({ itemIndex: z.coerce.number().int().nonnegative().optional() }).strict();
export type ResultQuery = z.output<typeof stepResultQuery>;
