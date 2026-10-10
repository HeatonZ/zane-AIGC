import * as z from "zod/v4";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CapabilityFactory } from "../package.js";
import type { CapabilityValue } from "../contracts.js";
import { imageLayoutSchema } from "../../domain/imageLayoutContracts.js";
import { normalizeMediaList, resolveWorkflowValue } from "../../domain/workflowValues.js";
import { composeImageLayout, prepareImageLayout } from "../../services/imageLayoutService.js";
import { readWorkflowImage } from "../../services/workflowImageService.js";
import { createRuntimeMediaValue, runtimeMediaItems, runtimeMediaItemValue } from "../../runtimeValue.js";
import { isRunId, runArtifactPaths } from "../../artifacts/runArtifacts.js";
import { throwIfAborted } from "../../execution/cancellation.js";
const factory: CapabilityFactory = () => ({
  definition: {
    id: "media.image_layout", version: "1", label: "图片画布与排版（旧版兼容）", category: "图片", legacy: { kind: "capability" }, dependencyMode: "declared",
    description: "本地调整画布/留白/背景并完整排入标题正文，保留主体不裁切；不调用生成模型，不内置电商/平台政策。",
    usage: { compatibilityOnly: true, whenToUse: "仅兼容已有发布快照与历史运行；新场景不再新增确定性图片画布与排版步骤：让图像模型直接生成包含版式与文案的完整图片，其他数据编排使用core.code。" },
    inputs: [{ key: "image", label: "源图片（恰好一张）", type: "image_list", required: true }, { key: "layout", label: "画布与文案", type: "json", required: true, valueSchema: z.toJSONSchema(imageLayoutSchema) as Record<string, CapabilityValue> }],
    outputs: [{ key: "images", label: "排版图片", type: "image_list" }, { key: "layout_manifest", label: "排版记录", type: "json", description: "format=zane-image-layout/item-v1；sourceRunId、outputFile、preview、bytes、sha256、layout与qa完整保留" }],
    config: [], editor: { inputs: "ports", outputs: "ports" }, result: { renderer: "auto" },
  },
  validate(step) {
    const binding = step.inputs?.find((input) => input.key === "layout");
    if (binding?.valueSource === "literal") {
      let value: unknown;
      try { value = JSON.parse(binding.literalValue ?? ""); } catch { throw new Error("图片排版固定layout需要有效JSON"); }
      prepareImageLayout(value);
    }
  },
  async execute(context) {
    const inputs = Object.fromEntries((context.step.inputs ?? []).map((input) => [input.key, resolveWorkflowValue(input, context.inputValues, context.stepValues)]));
    const layout = prepareImageLayout(inputs.layout);
    const images = runtimeMediaItems(inputs.image, "image");
    if (images.length !== 1 || images[0].kind !== "image" || normalizeMediaList(inputs.image).length !== 1) throw new Error("图片排版需要恰好一张源图片；多张图片请用通用逐项执行");
    if (!isRunId(context.runId)) throw new Error("图片排版运行ID无效");
    const rendered = await composeImageLayout(await readWorkflowImage(runtimeMediaItemValue(images[0]), context), layout, context.signal);
    const index = context.itemIndex;
    const suffix = typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? String(index) : "0";
    const filename = "layout-" + createHash("sha256").update(context.step.id).digest("hex") + "-" + suffix + ".jpg";
    const mediaDirectory = path.join(runArtifactPaths(context.settings.projectDirectory, context.runId).directory, "outputs", "media");
    await mkdir(mediaDirectory, { recursive: true });
    const target = path.join(mediaDirectory, filename); const temporary = target + "." + randomUUID() + ".tmp";
    try { await writeFile(temporary, rendered.bytes, { signal: context.signal }); throwIfAborted(context.signal); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
    const preview = "/api/workflows/runs/" + context.runId + "/media/" + filename;
    return { images: createRuntimeMediaValue("image", preview), layout_manifest: { format: "zane-image-layout/item-v1", sourceRunId: context.runId, outputFile: "outputs/media/" + filename, preview, bytes: rendered.bytes.length, sha256: createHash("sha256").update(rendered.bytes).digest("hex"), layout: rendered.layout, qa: rendered.qa } };
  },
});
export default factory;
