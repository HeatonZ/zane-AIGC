/** 本地媒体路径的识别与编号规则（无依赖的纯函数，服务端与浏览器共用同一份）。
 *
 *  为什么单独成文件：这套规则必须前后端完全一致——前端据此决定「第几个本地图」，
 *  服务端据此从运行记录里取出同一个文件。若两边各写一份，会静默错位。
 *  这里不引入 zod 等依赖，浏览器端可以安全地直接引用。 */

export const MAX_LOCAL_MEDIA_VALUE_LENGTH = 1024;

/** 媒体扩展名：只把「确实像媒体文件」的路径当成可预览媒体，避免把普通文本误判成图片。 */
const MEDIA_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp|m4v|mkv|mov|mp4|mpeg|mpg|webm|aac|aiff?|flac|m4a|mp3|oga|ogg|opus|wav)$/i;

/** 判断一个值是否是「本机绝对路径形态的媒体文件」。
 *
 *  只接受整串就是绝对路径的字符串：
 *   - Windows 盘符绝对路径（E:\... 或 E:/...）
 *   - UNC 路径（\\server\share\...）
 *   - 以 / 开头的绝对路径，但排除 /api/（那是本工作台自己的路由，另行处理）与 //（协议相对）
 *  并排除带协议头的字符串（http:、data:、blob: 等），那些属于外部地址而不是本地文件。
 *  例外：单字母 + 冒号会被误当成协议头，所以先判盘符再判协议头。
 *  普通文本（提示词、角色名、说明）既不是绝对路径也通常没有媒体扩展名，因此不会被误判。 */
export function isLocalMediaPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text || text.length > MAX_LOCAL_MEDIA_VALUE_LENGTH) return false;
  if (/[\0\r\n]/.test(text)) return false;
  if (/^[a-z]:[\\/]/i.test(text)) return MEDIA_EXTENSION.test(text);
  if (text.startsWith("\\\\")) return MEDIA_EXTENSION.test(text);
  if (!text.startsWith("/")) return false;
  if (text.startsWith("/api/") || text.startsWith("//")) return false;
  return MEDIA_EXTENSION.test(text);
}

/** 按出现顺序收集值里的本地媒体路径（数组按顺序、对象按字段顺序深度优先）。
 *
 *  重复出现的同一个路径只记第一次，因此同一张图总有稳定坐标（mediaIndex）。 */
export function collectLocalMediaPaths(value: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const visit = (candidate: unknown) => {
    if (isLocalMediaPath(candidate)) {
      const key = candidate.trim();
      if (!seen.has(key)) { seen.add(key); found.push(key); }
      return;
    }
    if (Array.isArray(candidate)) { candidate.forEach(visit); return; }
    if (candidate && typeof candidate === "object") {
      for (const nested of Object.values(candidate)) visit(nested);
    }
  };
  visit(value);
  return found;
}
