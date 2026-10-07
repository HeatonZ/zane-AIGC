import { normalizePromptSectionHeadings } from "../domain/promptSections.js";
import { selectMediaReferences } from "../services/mediaReferenceService.js";
import { asRecord, resolveStepInputs } from "../domain/workflowValues.js";
import type { JsonValue } from "../domain/types.js";
import type { StepExecutionContext } from "./workflowExecutor.js";
import { throwIfAborted } from "./cancellation.js";
import { createRuntimeMediaValue, runtimeMediaItems, runtimeMediaItemValue } from "../runtimeValue.js";

const imageCategories = ["characters", "scenes", "props"] as const;
const assetInputs = { characters: "character_assets", scenes: "scene_assets", props: "prop_assets", voices: "voice_reference_audio" } as const;
const tagCategories = { Character: "characters", Scene: "scenes", Prop: "props", Voice: "voices" } as const;
type Category = keyof typeof assetInputs;
export type LongTextAssets = Record<Category, unknown>;

export const H3_PROMPT_SECTIONS_CONTRACT = {
  version: "2",
  sections: ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"],
  aliases: { "详细描述": "detailed_description" },
  normalization: ["case_insensitive_declared_headers", "horizontal_header_whitespace_only", "explicit_aliases_only"],
  validation: "format_is_advisory_only_never_blocks_generation",
  warningField: "step.warnings_and_step.items[].warnings_and_applied_shot.prompt_warnings",
  warningPolicy: "persist_before_generation_survive_external_failure_not_run_errors",
  contentPolicy: "no_missing_section_fill_no_reorder_preserve_malformed_prompt_body_append_audio_policy",
  persistence: "raw_aixg_outputs_unchanged_normalized_prompt_in_applied_shot",
  execution: "no_additional_model_request_resume_reuses_completed_writer_and_aixg",
} as const;


export const LONG_TEXT_AUDIO_POLICY = "仅生成本镜头脚本中逐字列出的对白或旁白，以及必要的现场环境声、动作音效。参考音频仅用于对应说话人的音色、发声特征与语气风格，不复制其中的文字、对白内容、时间轴或背景声音；无台词时不生成说话声。禁止任何音乐：无背景音乐、配乐、旋律、乐器声、歌曲、演唱、哼唱、片头片尾音乐，也不得复用参考音频中的音乐。保持对白清晰、说话人与口型对应，不串音色，不额外添加台词。";

/** H3's joint audio/video latent uses 24 fps and a 17k+5 frame grid. */
export function longTextFrameCount(seconds: number) {
  const frames = Math.max(5, Math.ceil(seconds * 24));
  return frames + (5 - frames % 17 + 17) % 17;
}

/** A boundary/schema check, not a generated-video quality-review stage. */
export function prepareLongTextShot(value: unknown, assets: LongTextAssets) {
  const row = asRecord(value);
  if (!row || typeof row.index !== "number" || !Number.isSafeInteger(row.index) || row.index < 1) throw new Error("分镜必须有从1开始的整数 index");
  const index = row.index;
  if (typeof row.seconds !== "number" || !Number.isFinite(row.seconds) || row.seconds < 5 || row.seconds > 15) throw new Error(`分镜 ${index} 的 seconds 需要在5到15秒之间；长对白或复杂动作请拆成多个片段`);
  if (typeof row.prompt !== "string" || !row.prompt.trim() || row.prompt.length > 16000) throw new Error(`分镜 ${index} 的 prompt 必须是非空文本，最多16000字`);
  const media = {
    characters: runtimeMediaItems(assets.characters, "image"),
    scenes: runtimeMediaItems(assets.scenes, "image"),
    props: runtimeMediaItems(assets.props, "image"),
    voices: runtimeMediaItems(assets.voices, "audio"),
  };
  let prompt = row.prompt.replace(/\r\n?/g, "\n").trim();
  if (/<(?:Picture|Audio)\s+\d+>/i.test(prompt)) throw new Error("分镜 " + index + " 应使用 <Character n>/<Scene n>/<Prop n>/<Voice n> 全局资产标记；Picture/Audio 局部序号由程序绑定");
  const preparedReferences = selectMediaReferences(
    Object.entries(tagCategories).map(([tag, key]) => ({ key, kind: key === "voices" ? "audio" : "image", tag })), assets,
    Object.fromEntries((Object.keys(assetInputs) as Category[]).map((key) => [key, row[key]])), prompt,
  );
  const chosen = preparedReferences.indices as Record<Category, number[]>;
  const referenceMap = preparedReferences.reference_map;
  prompt = preparedReferences.prompt;
  if (!chosen.scenes.length) throw new Error(`分镜 ${index} 至少需要引用一个已上传场景`);
  if (imageCategories.reduce((count, key) => count + chosen[key].length, 0) > 9) throw new Error(`分镜 ${index} 最多引用9张人物/场景/道具图，请拆镜头而不是静默丢弃素材`);
  if (chosen.voices.length > 3) throw new Error(`分镜 ${index} 最多引用3个音色，请拆分多人对白`);

  const headings = H3_PROMPT_SECTIONS_CONTRACT.sections;
  prompt = normalizePromptSectionHeadings(prompt, headings, H3_PROMPT_SECTIONS_CONTRACT.aliases);
  const promptWarnings: string[] = [];
  let last = -1;
  for (const heading of headings) {
    const matches = [...prompt.matchAll(new RegExp(`^${heading}\\s*:`, "gm"))];
    if (matches.length !== 1 || matches[0].index! <= last) promptWarnings.push(`分镜 ${index}：建议使用六段H3提示词；${heading} 缺失、重复或顺序不一致，仅提示，不阻止生成`);
    if (matches.length) last = Math.max(last, matches[0].index!);
  }
  // Well-formed prompts retain the existing no-music rewrite. For free-form or
  // malformed prompts never cut away a tail that may contain actions/dialogue.
  if (!promptWarnings.length) prompt = prompt.replace(/^non_diegetic_music\s*:[\s\S]*$/m, `${LONG_TEXT_AUDIO_POLICY}\n\nnon_diegetic_music:\nN/A`);
  else prompt += `\n\n${LONG_TEXT_AUDIO_POLICY}\n\nnon_diegetic_music:\nN/A`;
  const bindingNote = `本镜头实际引用绑定：${referenceMap.map(({ asset, reference }) => `${asset.slice(1, -1)} = ${reference}`).join("；")}。`;
  if (/^subject_definitions\s*:/m.test(prompt)) prompt = prompt.replace(/^subject_definitions\s*:/m, `subject_definitions:\n${bindingNote}`);
  else prompt += "\n\n" + bindingNote;
  const frames = longTextFrameCount(row.seconds);
  return {
    shot: { ...row, ...chosen, prompt, ...(promptWarnings.length ? { prompt_warnings: promptWarnings } : {}), frames, actual_seconds: frames / 24, reference_map: referenceMap } as JsonValue,
    references: { images: preparedReferences.images, audios: preparedReferences.audios, videos: preparedReferences.videos },
    selected: Object.fromEntries((Object.keys(assetInputs) as Category[]).map((key) => [key, chosen[key].map((ordinal) => runtimeMediaItemValue(media[key][ordinal - 1]))])) as Record<Category, JsonValue[]>,
  };
}

export function validateLongTextStoryboard(shots: readonly JsonValue[], assets: LongTextAssets, prompts?: unknown) {
  if (!shots.length || shots.length > 360) throw new Error("制作分镜需要1到360个片段，请将更长的剧情分集制作");
  if (prompts !== undefined && (!Array.isArray(prompts) || prompts.length !== shots.length)) throw new Error("AIXG 提示词必须是与 Writer 分镜数量和顺序一致的列表；不回退 Writer 提示词");
  return shots.map((shot, position) => {
    if (asRecord(shot)?.index !== position + 1) throw new Error("制作分镜 index 必须从1开始，连续递增且与数组顺序一致");
    // Only prompt comes from AIXG; timing, selection, dialogue and continuity stay Writer-owned.
    return prepareLongTextShot(prompts === undefined ? shot : { ...asRecord(shot), prompt: (prompts as unknown[])[position] }, assets);
  });
}

/** Select only this shot's assets, compile stable global IDs, and retain native generated audio. */
export async function runLongTextVideoStep(context: StepExecutionContext, generate: (context: StepExecutionContext) => Promise<Record<string, JsonValue>>): Promise<Record<string, JsonValue>> {
  throwIfAborted(context.signal);
  const inputs = resolveStepInputs(context.step, context.inputValues, context.stepValues);
  const assets: LongTextAssets = { characters: inputs.character_assets, scenes: inputs.scene_assets, props: inputs.prop_assets, voices: inputs.voice_reference_audio };
  if (!runtimeMediaItems(assets.characters).length || !runtimeMediaItems(assets.scenes).length) throw new Error("长文出视频需要先上传人物和场景资产");
  // Check the complete immutable iteration source before spending time on the first clip.
  const hasAixgPrompts = context.step.inputs?.some(input => input.key === "prompts");
  let prepared: ReturnType<typeof prepareLongTextShot>;
  if (hasAixgPrompts) {
    if (!context.iterationItems || !Number.isSafeInteger(context.itemIndex) || context.itemIndex! < 0 || context.itemIndex! >= context.iterationItems.length) throw new Error("独立 AIXG 提示词需要 Writer 分镜的逐项执行上下文");
    const shots = validateLongTextStoryboard(context.iterationItems, assets, inputs.prompts ?? null);
    prepared = shots[context.itemIndex!]!;
  } else {
    // Existing published snapshots keep their original inline-prompt protocol.
    if (context.iterationItems) validateLongTextStoryboard(context.iterationItems, assets);
    prepared = prepareLongTextShot(inputs.shot, assets);
  }
  // New bindings consume one merged list per physical media type. Legacy bindings remain unchanged.
  const warnings = asRecord(prepared.shot)?.prompt_warnings;
  if (Array.isArray(warnings)) for (const warning of warnings) if (typeof warning === "string") await context.warn?.(warning);
  const mergedBindings = context.step.comfyui?.bindings?.some(binding => binding.direction === "input" && binding.sourceRef?.startsWith("iteration.item.references."));
  const executionShot: JsonValue = mergedBindings ? { ...asRecord(prepared.shot), references: prepared.references } : prepared.shot;
  const inputValues: Record<string, JsonValue> = { ...context.inputValues, "iteration.item": executionShot };
  for (const category of Object.keys(assetInputs) as Category[]) {
    inputValues[assetInputs[category]] = createRuntimeMediaValue(category === "voices" ? "audio" : "image", prepared.selected[category]) as unknown as JsonValue;
  }
  const selectedKeys = new Set<string>(Object.values(assetInputs));
  const result = await generate({
    ...context,
    inputValues,
    // A cutaway may have no character or prop even though the project asset bank is required.
    inputFields: context.inputFields.map((field) => selectedKeys.has(field.key) ? { ...field, required: false } : field),
  });
  if (runtimeMediaItems(result.result, "video").length !== 1) throw new Error("每个制作分镜必须生成一个视频片段，当前输出数量不符");
  return { ...result, applied_shot: executionShot };
}
