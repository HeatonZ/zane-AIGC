import * as z from "zod/v4";
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);
const tag = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/);
export const mediaReferenceGroupsSchema = z.array(z.object({
  key: key.describe("步骤输入key，同时对应selection中的key；不限定人物/商品等业务分类"),
  kind: z.enum(["image", "audio", "video"]),
  tag: tag.optional().describe("可选全局标签前缀，如Character；<Character 2>映射到所选媒体的局部引用"),
  referenceTag: tag.optional().describe("可选局部引用前缀；默认image=Picture/audio=Audio/video=Video；共享前缀连续编号"),
}).strict()).min(1).max(16);
export const mediaReferenceSelectionSchema = z.record(key, z.union([z.array(z.int().positive()).max(1000), z.literal("all")])).describe("每组都要提供按输入顺序从1开始的序号数组或all（选择全部）；空数组表示不选择，重复/越界/未知组报错；每组按输入顺序排序，不静默丢弃媒体");
export type MediaReferenceGroup = z.infer<typeof mediaReferenceGroupsSchema>[number];
