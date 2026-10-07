import * as z from "zod/v4";
export const imageLayoutSchema = z.object({
  width: z.int().min(64).max(8192), height: z.int().min(64).max(8192),
  margin: z.int().nonnegative().default(0).describe("安全留白，不超过短边四分之一"),
  background: z.string().regex(/^#[a-fA-F0-9]{6}$/).default("#fafaf7"),
  title: z.string().max(2000).default(""), caption: z.string().max(2000).default(""),
  titleHeight: z.int().nonnegative().optional().describe("标题区域高度；有标题时默认短边16%，无标题不保留"),
  captionHeight: z.int().nonnegative().optional().describe("正文区域高度；有正文时默认短边18%，无正文不保留"),
}).strict().describe("通用图片画布：不裁切主体，文字完整排入指定区域；过长报错，不截断；width*height最多3200万像素");
export type ImageLayout = z.infer<typeof imageLayoutSchema>;
