import { createHash, randomInt } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord, resolveStepInputs } from "../domain/workflowValues.js";
import type { JsonValue } from "../domain/types.js";
import type { StepExecutionContext } from "../execution/workflowExecutor.js";
import { throwIfAborted } from "../execution/cancellation.js";
import { createRuntimeMediaValue, runtimeMediaItems, runtimeMediaItemValue } from "../runtimeValue.js";
import { readWorkflowImage as readImage } from "../services/workflowImageService.js";
import { composeCommerceImage, type CommerceCopy } from "./compose.js";
import { commerceShotId, commerceShots, selectCommerceProfiles, validateCommerceShots } from "./profiles.js";

function text(value: unknown, label: string, required = false) {
  if (value === null || value === undefined) { if (required) throw new Error(`${label}不能为空`); return ""; }
  if (typeof value !== "string" || (required && !value.trim()) || value.length > 2000) throw new Error(`${label}需要有效文本（最多2000字）`);
  return value.trim();
}
function planPrompt(value: unknown, shot: string, selected: string[]) {
  if (!Array.isArray(value)) throw new Error("Hermes套图脚本必须是数组，每项含id和prompt；请从脚本步骤重试");
  const rows = value.map((row) => asRecord(row));
  const ids = rows.map((row) => row?.id);
  if (rows.some((row) => !row || typeof row.id !== "string" || typeof row.prompt !== "string" || !row.prompt.trim() || row.prompt.length > 6000) || new Set(ids).size !== ids.length || ids.length !== selected.length || selected.some((id) => !ids.includes(id))) throw new Error("套图脚本的id/数量/提示词与所选清单不一致，不能静默漏图；请从脚本步骤重试");
  return rows.find((row) => row!.id === shot)!.prompt as string;
}

/** Narrow ComfyUI adapter: the workbench still owns publishing, iteration and recovery. */
export async function runCommercePackStep(context: StepExecutionContext, generate: (context: StepExecutionContext) => Promise<Record<string, JsonValue>>) {
  const { step, runId, artifacts, signal } = context;
  const input = resolveStepInputs(step, context.inputValues, context.stepValues);
  const original = resolveStepInputs(step, context.runInputValues, context.stepValues);
  const selected = validateCommerceShots(original.shot_types);
  const shot = commerceShotId(input.shot_id);
  if (!selected.includes(shot)) throw new Error("当前卡片不在套图清单中");
  const profiles = selectCommerceProfiles(input.platform_preset, input.platform_profiles);
  const references = runtimeMediaItems(input.reference_images);
  if (!references.length) throw new Error("至少需要一张商品参考图");
  const mode = input.generation_mode;
  if (mode !== "原图保真排版" && mode !== "AI场景重绘") throw new Error("画面生成方式无效");
  if (typeof input.add_text !== "boolean") throw new Error("add_text需要布尔值");
  const copy: CommerceCopy = { productName: text(input.product_name, "商品名称", true), sellingPoints: text(input.selling_points, "真实卖点", true), productSpecs: text(input.product_specs, "规格参数"), packageContents: text(input.package_contents, "包装清单"), visualStyle: text(input.visual_style, "视觉风格"), addText: input.add_text };
  if (copy.productName.length > 120) throw new Error("商品名称最多120字，请将完整参数放入规格字段");
  const brandNotes = text(input.brand_notes, "外观约束");
  const explicitIndex = asRecord(input.shot_id)?.reference_index;
  if (explicitIndex !== undefined && (typeof explicitIndex !== "number" || !Number.isSafeInteger(explicitIndex) || explicitIndex < 0 || explicitIndex >= references.length)) throw new Error("reference_index超出参考图列表");
  const referenceIndex = typeof explicitIndex === "number" ? explicitIndex : Math.min(commerceShots.indexOf(shot), references.length - 1);
  const prompt = mode === "AI场景重绘" ? planPrompt(input.shot_plan, shot, selected) : "";
  // Reuse one base image across all normal platform exports; white hero gets its own base.
  const sources = new Map<string, Buffer>();
  const rows: JsonValue[] = [];
  const urls: JsonValue[] = [];
  const mediaDirectory = path.join(artifacts.directory, "outputs", "media");
  await mkdir(mediaDirectory, { recursive: true });
  for (const profile of profiles) {
    throwIfAborted(signal);
    const whiteHero = profile.whiteHero && shot === "hero";
    const variant = whiteHero ? "white-hero" : "standard";
    let source = sources.get(variant);
    if (!source) {
      if (mode === "原图保真排版") source = await readImage(runtimeMediaItemValue(references[referenceIndex]), context);
      else {
        const direction = `${prompt}\n商品名称：${copy.productName}\n统一视觉风格：${copy.visualStyle}\n外观约束：${brandNotes}\n仅以参考商品为主体，严格保持形状、比例、材质、Logo与包装事实，不新增配件或宣传文字。${whiteHero ? "本张为纯白背景商品主图，仅展示真实商品，不要文字、边框、徽章、道具。" : "只生成商品摄影底图，文字将由系统后置排版，不要水印、标题或价格。"}`;
        const outputs = await generate({ ...context, step: { ...step, comfyui: { ...step.comfyui!, adapter: undefined } }, inputValues: { ...context.inputValues, "iteration.item": { id: shot, prompt: direction, seed: randomInt(2 ** 31) } }, types: new Map(context.types).set("iteration.item", "json") });
        const images = runtimeMediaItems(outputs.images);
        if (images.length !== 1) throw new Error("套图底图工作流每项必须恰好输出一张图片，请关闭额外预览/批量输出");
        source = await readImage(runtimeMediaItemValue(images[0]), context);
      }
      sources.set(variant, source);
    }
    const composed = await composeCommerceImage(source, profile, shot, copy, signal);
    const filename = `commerce-${profile.id}-${shot}.jpg`;
    const file = path.join(mediaDirectory, filename);
    const temporary = `${file}.${randomInt(2 ** 31)}.tmp`;
    try { await writeFile(temporary, composed.bytes, { signal }); throwIfAborted(signal); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
    const preview = `/api/workflows/runs/${runId}/media/${filename}`;
    urls.push({ url: preview });
    rows.push({ format: "zane-commerce-pack/item-v1", sourceRunId: runId, platformId: profile.id, platformName: profile.name, shotId: shot, outputFile: `outputs/media/${filename}`, exportName: `${profile.id}/${String(commerceShots.indexOf(shot) + 1).padStart(2, "0")}-${shot}.jpg`, preview, bytes: composed.bytes.length, sha256: createHash("sha256").update(composed.bytes).digest("hex"), generationMode: mode, referenceIndex: mode === "原图保真排版" ? referenceIndex : null, hasText: composed.hasText, copy: { ...copy }, qa: composed.qa, review: ["尺寸为可调整的设计预设，实际刊登位置和类目规则需人工确认", mode === "AI场景重绘" ? "AI主体一致性仅做提示约束，核对Logo/包装文字/结构/颜色" : "原图缩放保留主体与图片内容，非自动抠图", ...(composed.whiteHero ? ["已关闭后置文字并使用白底画布；人工确认原图背景和商品占比"] : [])] });
  }
  throwIfAborted(signal);
  return { images: createRuntimeMediaValue("image", urls), commerce_manifest: rows };
}
