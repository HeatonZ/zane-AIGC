import { readFile } from "node:fs/promises";

export interface ZipEntry { name: string; file?: string; data?: Buffer }
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let index = 0; index < 8; index++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const value of data) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
/** Stream a standards-compliant STORE ZIP (JPEG is already compressed). Buffers one image at a time. */
export async function* commerceZip(entries: ZipEntry[], signal?: AbortSignal) {
  if (entries.length > 150) throw new Error("打包文件数超过限制");
  const central: Buffer[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (!entry.name || entry.name.startsWith("/") || entry.name.split("/").some((part) => !part || part === "." || part === "..") || /[\\\0]/.test(entry.name) || seen.has(entry.name)) throw new Error("ZIP文件名无效或重复");
    seen.add(entry.name);
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data ?? await readFile(entry.file!, { signal });
    if (data.length > 32 * 1024 * 1024 || offset + data.length > 512 * 1024 * 1024) throw new Error("打包内容超过限制");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(33, 12); // Jan 1, 1980: deterministic legal DOS date.
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(33, 14);
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    central.push(header, name);
    yield local; yield name; yield data;
    offset += local.length + name.length + data.length;
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  for (const part of central) yield part;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  yield end;
}
