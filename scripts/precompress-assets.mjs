// Build-time precompression for the web release.
//
// The runtime compression middleware passes responses that already carry a
// Content-Length straight through, because it must never buffer a media file.
// `express.static` always sets one, so the largest text payloads — the JS/CSS
// bundle — were the only ones never compressed. Compressing here, once per
// build, keeps the transfer rule intact and costs no request-path CPU.
//
// Output: `<file>.br` and `<file>.gz` beside the original. The server indexes
// them at startup and serves a variant only when the client accepts it.
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { constants as zlibConstants, brotliCompress, gzip } from "node:zlib";
import { promisify } from "node:util";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const directory = path.resolve(process.env.DIST_DIR ?? "dist");
/** Text shapes Vite can emit; already-compressed media is deliberately absent. */
const compressible = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".txt", ".xml"]);
/** Below this the framing overhead outweighs the saving. */
const minimumBytes = 1024;
/** Keep a variant only when it is meaningfully smaller than the identity body. */
const minimumSaving = 0.05;

async function walk(current, prefix = "") {
  const files = [];
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return files; throw error; }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(path.join(current, entry.name), relative));
    else if (entry.isFile() && !/\.(br|gz)$/.test(entry.name)) files.push(relative);
  }
  return files;
}

async function writeVariant(filename, bytes, extension) {
  const body = extension === ".br"
    ? await brotli(bytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length } })
    : await gzipAsync(bytes, { level: 9 });
  // A tiny or already-dense file would only grow on the wire: write no variant,
  // so the server has nothing to offer and falls back to the identity body.
  if (body.length > bytes.length * (1 - minimumSaving)) return 0;
  await writeFile(filename + extension, body);
  return body.length;
}

const files = (await walk(directory)).filter((file) => compressible.has(path.extname(file).toLowerCase()));
let raw = 0, brotliBytes = 0, gzipBytes = 0, skipped = 0;
for (const relative of files) {
  const filename = path.join(directory, relative);
  const info = await stat(filename);
  if (info.size < minimumBytes) { skipped += 1; continue; }
  const bytes = await readFile(filename);
  raw += bytes.length;
  brotliBytes += await writeVariant(filename, bytes, ".br");
  gzipBytes += await writeVariant(filename, bytes, ".gz");
}
const kb = (value) => `${(value / 1024).toFixed(0)}KB`;
console.log(`Precompressed ${files.length - skipped} files: ${kb(raw)} raw, ${kb(brotliBytes)} br, ${kb(gzipBytes)} gzip${skipped ? ` (${skipped} below ${minimumBytes}B skipped)` : ""}.`);
