import { mediaReferenceGroupsSchema, mediaReferenceSelectionSchema, type MediaReferenceGroup } from "../domain/mediaReferenceContracts.js";
import { asRecord, normalizeMediaList } from "../domain/workflowValues.js";
import type { JsonValue } from "../domain/types.js";
import { createRuntimeMediaValue, runtimeMediaItems } from "../runtimeValue.js";

export function selectMediaReferenceIndices(value: unknown, count: number, label: string): number[] {
  if (value === "all") return Array.from({ length: count }, (_, index) => index + 1);
  if (!Array.isArray(value)) throw new Error(label + "必须是按输入顺序从1开始的序号数组；没有引用时填[]");
  if (value.some((index) => typeof index !== "number" || !Number.isSafeInteger(index) || index < 1 || index > count)) throw new Error(label + "引用了不存在的素材（共" + count + "项，编号从1开始）");
  if (new Set(value).size !== value.length) throw new Error(label + "素材编号不能重复");
  return [...value].sort((left, right) => left - right) as number[];
}
export function validateMediaReferenceGroups(value: unknown): MediaReferenceGroup[] {
  const parsed = mediaReferenceGroupsSchema.safeParse(value);
  if (!parsed.success) throw new Error("媒体引用分组配置无效");
  const groups = parsed.data;
  if (new Set(groups.map((group) => group.key)).size !== groups.length || new Set(groups.map((group) => group.tag).filter(Boolean)).size !== groups.filter((group) => group.tag).length) throw new Error("媒体引用分组key和全局tag不能重复");
  if (groups.some((group) => ["selection", "prompt", "__proto__", "prototype", "constructor"].includes(group.key))) throw new Error("媒体引用分组key与保留字段冲突");
  const referenceKinds = new Map<string, string>();
  for (const group of groups.filter((group) => group.tag)) {
    const referenceTag = group.referenceTag ?? ({ image: "Picture", audio: "Audio", video: "Video" } as const)[group.kind];
    if (referenceKinds.has(referenceTag) && referenceKinds.get(referenceTag) !== group.kind) throw new Error("不同媒体类型不能共用同一局部referenceTag");
    referenceKinds.set(referenceTag, group.kind);
  }
  return groups;
}
/** Generic, deterministic selection/tag mapping; no model, scene policy or node/frame assumptions. */
export function selectMediaReferences(groupsValue: unknown, sources: Record<string, unknown>, selectionValue: unknown, promptValue: unknown = "") {
  const groups = validateMediaReferenceGroups(groupsValue);
  const parsed = mediaReferenceSelectionSchema.safeParse(selectionValue);
  if (!parsed.success) throw new Error("媒体选择需要每组的序号数组");
  const selection = parsed.data;
  if (Object.keys(selection).some((key) => !groups.some((group) => group.key === key)) || groups.some((group) => !Object.hasOwn(selection, group.key))) throw new Error("媒体选择必须与分组配置一致，不能省略或包含未知组");
  if (typeof promptValue !== "string" || promptValue.length > 32000) throw new Error("引用提示词需要文本，最多32000字");
  const counters = new Map<string, number>();
  const referenceMap: Array<{ asset: string; reference: string }> = [];
  const selected: Record<string, JsonValue> = {};
  const indices: Record<string, number[]> = {};
  const merged = { image: [] as ReturnType<typeof runtimeMediaItems>, audio: [] as ReturnType<typeof runtimeMediaItems>, video: [] as ReturnType<typeof runtimeMediaItems> };
  for (const group of groups) {
    const source = sources[group.key];
    const items = runtimeMediaItems(source, group.kind);
    if ((asRecord(source)?.mediaKind && asRecord(source)?.mediaKind !== group.kind) || items.some((item) => item.kind !== group.kind) || items.length !== normalizeMediaList(source).length) throw new Error(group.key + "媒体类型或格式无效，不能静默丢弃素材");
    const chosen = selectMediaReferenceIndices(selection[group.key], items.length, group.key);
    indices[group.key] = chosen;
    const chosenItems = chosen.map((ordinal) => items[ordinal - 1]);
    selected[group.key] = createRuntimeMediaValue(group.kind, chosenItems);
    // Group order then original upload order; keep repeats so reference numbering stays exact.
    merged[group.kind].push(...chosenItems);
    if (group.tag) for (const ordinal of chosen) {
      const referenceTag = group.referenceTag ?? ({ image: "Picture", audio: "Audio", video: "Video" } as const)[group.kind];
      const next = (counters.get(referenceTag) ?? 0) + 1; counters.set(referenceTag, next);
      referenceMap.push({ asset: "<" + group.tag + " " + ordinal + ">", reference: "<" + referenceTag + " " + next + ">" });
    }
  }
  const map = new Map(referenceMap.map((row) => [row.asset, row.reference]));
  const tags = groups.map((group) => group.tag).filter(Boolean);
  const prompt = tags.length ? promptValue.replace(new RegExp("<(" + tags.join("|") + ")\\s+(\\d+)>", "g"), (_match, tag: string, number: string) => {
    const asset = "<" + tag + " " + Number(number) + ">";
    const reference = map.get(asset);
    if (!reference) throw new Error("提示词引用了未选中的 " + asset);
    return reference;
  }) : promptValue;
  return { selected, prompt, reference_map: referenceMap, indices, images: createRuntimeMediaValue("image", merged.image), audios: createRuntimeMediaValue("audio", merged.audio), videos: createRuntimeMediaValue("video", merged.video) };
}
