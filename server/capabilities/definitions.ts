import type { CapabilityDefinition } from "./contracts.js";
const ports = { inputs: "ports", outputs: "ports", editablePorts: true } as const;
const bindings = { inputs: "bindings", outputs: "bindings", bindings: true } as const;
export const builtinCapabilities: CapabilityDefinition[] = [
  { id: "core.hermes", version: "1", label: "Hermes Agent", description: "调用已配置的 Hermes Profile 生成文本或结构化结果。", category: "模型", legacy: { kind: "hermes" }, inputs: [], outputs: [], config: [], editor: { ...ports, profile: true, prompt: true }, result: { renderer: "auto" } },
  { id: "core.comfyui", version: "1", label: "ComfyUI", description: "执行 ComfyUI 工作流，按节点绑定输入和输出。", category: "模型", legacy: { kind: "comfyui" }, inputs: [], outputs: [], config: [], editor: bindings, result: { renderer: "auto" } },
  { id: "core.manual", version: "1", label: "数据传递", description: "把已填写的步骤输入按同名输出传递，不调用外部服务。", category: "数据", legacy: { kind: "manual" }, inputs: [], outputs: [], config: [], editor: ports, result: { renderer: "auto" } },
  { id: "core.condition", version: "1", label: "条件判断", description: "比较输入或前序结果，输出布尔判断。", category: "控制", legacy: { kind: "control" }, inputs: [], outputs: [{ key: "result", label: "判断结果", type: "boolean" }], config: [], editor: { inputs: "ports", outputs: "ports", condition: true }, result: { renderer: "json" } },
  { id: "comfyui.h3_long_video", version: "1", label: "H3 长视频", description: "按计划与提示词表适配 H3 视频工作流。", category: "视频", legacy: { kind: "comfyui", adapter: "h3_long_video" }, inputs: [], outputs: [{ key: "applied_prompts", label: "已应用提示词", type: "json" }], config: [
    { key: "planRef", path: "comfyui.h3LongVideo.planRef", label: "分镜计划", type: "reference", required: true },
    { key: "promptRowsRef", path: "comfyui.h3LongVideo.promptRowsRef", label: "提示词表", type: "reference", required: true },
    { key: "referenceImagesRef", path: "comfyui.h3LongVideo.referenceImagesRef", label: "参考图片", type: "reference", required: true },
    { key: "materialNoteRef", path: "comfyui.h3LongVideo.materialNoteRef", label: "素材说明", type: "reference" },
  ], editor: bindings, result: { renderer: "auto" } },
  { id: "comfyui.commerce_pack", version: "1", label: "电商图包", description: "执行电商图卡生产与后置排版，保留图包清单。", category: "图片", legacy: { kind: "comfyui", adapter: "commerce_pack" }, inputs: [], outputs: [{ key: "commerce_manifest", label: "图包清单", type: "json" }], config: [], editor: { ...bindings, inputs: "ports" }, result: { renderer: "auto" } },
  { id: "comfyui.long_text_video", version: "1", label: "长文逐镜生成", description: "按分镜逐项生成视频并记录应用的镜头参数。", category: "视频", legacy: { kind: "comfyui", adapter: "long_text_video" }, inputs: [], outputs: [{ key: "applied_shot", label: "已应用镜头", type: "json" }], config: [], editor: { ...bindings, inputs: "ports", outputs: "ports", editablePorts: true }, result: { renderer: "auto" } },
  { id: "media.video_concat", version: "1", label: "本地视频拼接", description: "本机 FFmpeg 按顺序拼接片段，保留原生声音，不调用生成服务。", category: "视频", legacy: { kind: "comfyui", adapter: "video_concat" }, inputs: [], outputs: [], config: [], editor: ports, result: { renderer: "media" } },
];
