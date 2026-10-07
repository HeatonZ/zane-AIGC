import * as z from "zod/v4";
import type { CapabilityFactory } from "../package.js";
import type { CapabilityValue } from "../contracts.js";
import { resolveWorkflowValue } from "../../domain/workflowValues.js";
import { mediaReferenceGroupsSchema, mediaReferenceSelectionSchema } from "../../domain/mediaReferenceContracts.js";
import { selectMediaReferences, validateMediaReferenceGroups } from "../../services/mediaReferenceService.js";
const factory: CapabilityFactory = () => ({
  definition: {
    id: "media.select_references", version: "1", label: "媒体选择与合并", category: "数据", legacy: { kind: "capability" }, dependencyMode: "declared",
    description: "按序号数组或all选择业务分类素材，再按媒体类型合并成图片/音频/视频列表，可映射提示词标签；不限定人物、商品等场景，不调用模型。",
    usage: { tier: "basic", whenToUse: "任何逐项任务只需部分素材或稳定的局部引用编号时，先用此基础步骤，业务分类按groups顺序合并；ComfyUI仅绑定images/audios/videos媒体列表。" },
    inputs: [{ key: "selection", label: "各组素材序号或all", type: "json", required: true, valueSchema: z.toJSONSchema(mediaReferenceSelectionSchema) as Record<string, CapabilityValue> }, { key: "prompt", label: "待映射提示词", type: "text" }, { key: "images", label: "素材图片", type: "image_list" }],
    outputs: [{ key: "bundle", label: "逐项媒体包", type: "json", required: false, description: "包含images/audios/videos、selected、indices和reference_map，保持逐项边界与局部编号；用于列表对齐后向模型传递完整媒体列表。旧快照不声明则不返回" }, { key: "images", label: "合并后的图片列表", type: "image_list", required: false, description: "按groups顺序合并所有已选图片组，组内按原上传顺序；空组不占编号，不去重，与Picture编号一致；旧快照可不声明此输出" }, { key: "audios", label: "合并后的音频列表", type: "audio_list", required: false, description: "按groups顺序合并所有已选音频组；不拼接音频内容、不混入图片或视频" }, { key: "videos", label: "合并后的视频列表", type: "video_list", required: false, description: "按groups顺序合并所有已选视频组；不拼接视频内容，节点只接受单项时需显式选择或逐项执行" }, { key: "selected", label: "各组已选媒体", type: "json", description: "按分组key存放完整媒体列表；节点绑定可引用step.ID.outputs.selected.GROUP" }, { key: "prompt", label: "映射后提示词", type: "text" }, { key: "reference_map", label: "引用映射", type: "json" }],
    config: [{ key: "groups", label: "素材分组", type: "json", required: true, defaultValue: [{ key: "images", kind: "image", tag: "Image" }], valueSchema: z.toJSONSchema(mediaReferenceGroupsSchema) as Record<string, CapabilityValue>, description: "每组key对应下方媒体输入及selection中的序号数组或all（选择全部，允许空组）；可自由分组，不需要新执行器。" }],
    editor: { inputs: "ports", outputs: "ports", editablePorts: true, editableOutputs: false }, result: { renderer: "auto" },
  },
  validate(step) {
    const groups = validateMediaReferenceGroups(step.capabilityConfig?.groups);
    for (const group of groups) if (!step.inputs?.some((input) => input.key === group.key && (input.valueSource === "literal" ? Boolean(input.literalValue) : Boolean(input.sourceRef)))) throw new Error("媒体引用缺少分组输入：" + group.key);
  },
  async execute(context) {
    const inputs = Object.fromEntries((context.step.inputs ?? []).map((input) => [input.key, resolveWorkflowValue(input, context.inputValues, context.stepValues)]));
    const result = selectMediaReferences(context.step.capabilityConfig?.groups, inputs, inputs.selection, inputs.prompt ?? "");
    const outputs: Record<string, import("../../domain/types.js").JsonValue> = { selected: result.selected, prompt: result.prompt, reference_map: result.reference_map };
    // Additive, explicitly declared ports; old fixed snapshots retain their output contract.
    for (const key of ["images", "audios", "videos"] as const) if (context.step.outputs?.some(output => output.key === key)) outputs[key] = result[key];
    if (context.step.outputs?.some(output => output.key === "bundle")) outputs.bundle = { images: result.images, audios: result.audios, videos: result.videos, selected: result.selected, indices: result.indices, reference_map: result.reference_map };
    return outputs;
  },
});
export default factory;
