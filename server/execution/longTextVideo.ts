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

export const LONG_TEXT_AUDIO_POLICY = "仅生成本镜头脚本中逐字列出的对白或旁白，以及必要的现场环境声、动作音效。参考音频仅用于对应说话人的音色、发声特征与语气风格，不复制其中的文字、对白内容、时间轴或背景声音；无台词时不生成说话声。禁止任何音乐：无背景音乐、配乐、旋律、乐器声、歌曲、演唱、哼唱、片头片尾音乐，也不得复用参考音频中的音乐。保持对白清晰、说话人与口型对应，不串音色，不额外添加台词。";

/** H3's joint audio/video latent uses 24 fps and a 17k+5 frame grid. */
export function longTextFrameCount(seconds: number) {
  const frames = Math.max(5, Math.ceil(seconds * 24));
  return frames + (5 - frames % 17 + 17) % 17;
}

function selection(value: unknown, count: number, category: Category, shotIndex: number): number[] {
  if (!Array.isArray(value)) throw new Error(`分镜 ${shotIndex} 的 ${category} 必须是按上传顺序编号的数组（从1开始；没有引用时填[]）`);
  if (value.some((index) => typeof index !== "number" || !Number.isSafeInteger(index) || index < 1 || index > count)) {
    throw new Error(`分镜 ${shotIndex} 的 ${category} 引用了不存在的素材（已上传 ${count} 项，编号从1开始）`);
  }
  if (new Set(value).size !== value.length) throw new Error(`分镜 ${shotIndex} 的 ${category} 素材编号不能重复`);
  return [...value].sort((a, b) => a - b) as number[];
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
  const chosen = Object.fromEntries((Object.keys(assetInputs) as Category[]).map((key) => [key, selection(row[key], media[key].length, key, index)])) as Record<Category, number[]>;
  if (!chosen.scenes.length) throw new Error(`分镜 ${index} 至少需要引用一个已上传场景`);
  if (imageCategories.reduce((count, key) => count + chosen[key].length, 0) > 9) throw new Error(`分镜 ${index} 最多引用9张人物/场景/道具图，请拆镜头而不是静默丢弃素材`);
  if (chosen.voices.length > 3) throw new Error(`分镜 ${index} 最多引用3个音色，请拆分多人对白`);

  const references = new Map<string, string>();
  const referenceMap: Array<{ asset: string; reference: string }> = [];
  let picture = 0;
  for (const [tag, category] of Object.entries(tagCategories)) {
    for (const assetIndex of chosen[category]) {
      const reference = category === "voices" ? `<Audio ${referenceMap.filter((item) => item.reference.startsWith("<Audio ")).length + 1}>` : `<Picture ${++picture}>`;
      const asset = `<${tag} ${assetIndex}>`;
      references.set(asset, reference);
      referenceMap.push({ asset, reference });
    }
  }
  let prompt = row.prompt.replace(/\r\n?/g, "\n").trim();
  if (/<(?:Picture|Audio)\s+\d+>/i.test(prompt)) throw new Error(`分镜 ${index} 应使用 <Character n>/<Scene n>/<Prop n>/<Voice n> 全局资产标记；Picture/Audio 局部序号由程序绑定`);
  prompt = prompt.replace(/<(Character|Scene|Prop|Voice)\s+(\d+)>/g, (_, tag: string, number: string) => {
    const asset = `<${tag} ${Number(number)}>`;
    const reference = references.get(asset);
    if (!reference) throw new Error(`分镜 ${index} 的提示词引用了未选中的 ${asset}`);
    return reference;
  });
  const headings = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];
  let last = -1;
  for (const heading of headings) {
    const matches = [...prompt.matchAll(new RegExp(`^${heading}\\s*:`, "gm"))];
    if (matches.length !== 1 || matches[0].index! <= last) throw new Error(`分镜 ${index} 的 H3 提示词需要按顺序包含六个英文段落，当前 ${heading} 缺失、重复或顺序错误`);
    last = matches[0].index!;
  }
  // Do not apply the full-audio H3 adapter: native dialogue needs an actual soundscape.
  prompt = prompt.replace(/^non_diegetic_music\s*:[\s\S]*$/m, `${LONG_TEXT_AUDIO_POLICY}\n\nnon_diegetic_music:\nN/A`);
  prompt = prompt.replace(/^subject_definitions\s*:/m, `subject_definitions:\n本镜头实际引用绑定：${referenceMap.map(({ asset, reference }) => `${asset.slice(1, -1)} = ${reference}`).join("；")}。`);
  const frames = longTextFrameCount(row.seconds);
  return {
    shot: { ...row, ...chosen, prompt, frames, actual_seconds: frames / 24, reference_map: referenceMap } as JsonValue,
    selected: Object.fromEntries((Object.keys(assetInputs) as Category[]).map((key) => [key, chosen[key].map((ordinal) => runtimeMediaItemValue(media[key][ordinal - 1]))])) as Record<Category, JsonValue[]>,
  };
}

export function validateLongTextStoryboard(shots: readonly JsonValue[], assets: LongTextAssets) {
  if (!shots.length || shots.length > 360) throw new Error("制作分镜需要1到360个片段，请将更长的剧情分集制作");
  return shots.map((shot, position) => {
    if (asRecord(shot)?.index !== position + 1) throw new Error("制作分镜 index 必须从1开始，连续递增且与数组顺序一致");
    return prepareLongTextShot(shot, assets);
  });
}

/** Select only this shot's assets, compile stable global IDs, and retain native generated audio. */
export async function runLongTextVideoStep(context: StepExecutionContext, generate: (context: StepExecutionContext) => Promise<Record<string, JsonValue>>): Promise<Record<string, JsonValue>> {
  throwIfAborted(context.signal);
  const inputs = resolveStepInputs(context.step, context.inputValues, context.stepValues);
  const assets: LongTextAssets = { characters: inputs.character_assets, scenes: inputs.scene_assets, props: inputs.prop_assets, voices: inputs.voice_reference_audio };
  if (!runtimeMediaItems(assets.characters).length || !runtimeMediaItems(assets.scenes).length) throw new Error("长文出视频需要先上传人物和场景资产");
  // Check the complete immutable iteration source before spending time on the first clip.
  if (context.iterationItems) validateLongTextStoryboard(context.iterationItems, assets);
  const prepared = prepareLongTextShot(inputs.shot, assets);
  const inputValues: Record<string, JsonValue> = { ...context.inputValues, "iteration.item": prepared.shot };
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
  return { ...result, applied_shot: prepared.shot };
}
