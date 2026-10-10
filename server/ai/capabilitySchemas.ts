import * as z from "zod/v4";
const portType = z.enum(["text", "number", "boolean", "json", "image_list", "video_list", "audio_list"]);
const port = z.object({ key: z.string(), label: z.string(), type: portType, required: z.boolean().optional(), description: z.string().optional(), valueSchema: z.record(z.string(), z.json()).optional() });
export const capabilityUsageSchema = z.object({
  whenToUse: z.string().min(1).describe("适用条件；场景差异用配置与core.code自定义代码表达，不按场景名称新增专用步骤"),
  compatibilityOnly: z.boolean().optional().describe("true表示只保留旧快照/历史流程兼容；新场景应使用core.code与基础组合，不再推荐选用"),
});
export const capabilityDefinitionSchema = z.object({
  id: z.string(), version: z.string(), label: z.string(), description: z.string(), category: z.string(),
  usage: capabilityUsageSchema,
  legacy: z.object({ kind: z.enum(["hermes", "comfyui", "manual", "control", "capability"]), adapter: z.string().optional() }),
  inputs: z.array(port), outputs: z.array(port),
  config: z.array(z.object({ key: z.string(), label: z.string(), type: z.enum(["text", "textarea", "number", "boolean", "select", "json", "reference"]), path: z.string().optional(), required: z.boolean().optional(), defaultValue: z.json().optional(), options: z.array(z.string()).optional(), placeholder: z.string().optional(), description: z.string().optional(), valueSchema: z.record(z.string(), z.json()).optional() })),
  editor: z.object({ inputs: z.enum(["bindings", "ports"]), outputs: z.enum(["bindings", "ports"]), editablePorts: z.boolean().optional(), editableInputs: z.boolean().optional(), editableOutputs: z.boolean().optional(), bindings: z.boolean().optional(), profile: z.boolean().optional(), prompt: z.boolean().optional(), condition: z.boolean().optional(), bindingTypes: z.array(z.object({ direction: z.enum(["input", "output"]), nodeType: z.string(), property: z.string(), type: portType })).optional() }),
  dependencyMode: z.enum(["declared", "all-prior"]).optional(),
  result: z.object({ renderer: z.enum(["auto", "text", "json", "media"]) }),
});
