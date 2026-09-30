import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "zane-commerce-smoke-"));
const project = path.join(temporary, "project");
await mkdir(project);
let child, exited, logs = "";
async function bounded(promise, milliseconds = 60000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Commerce smoke timeout\n${logs.slice(-3000)}`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function json(base, route, body) {
  const response = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  assert.ok(response.ok, `${route}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}
try {
  const reference = path.join(temporary, "product.png");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="700"><rect width="500" height="700" fill="#ffffff"/><ellipse cx="250" cy="635" rx="120" ry="18" fill="#e4e6df"/><rect x="175" y="70" width="150" height="65" rx="14" fill="#2d4635"/><rect x="150" y="125" width="200" height="500" rx="48" fill="#839680"/><rect x="175" y="260" width="150" height="160" rx="5" fill="#f1f1e5"/><text x="250" y="335" text-anchor="middle" font-family="Arial" font-size="24" fill="#2d4635">DEMO</text><text x="250" y="368" text-anchor="middle" font-family="Arial" font-size="14" fill="#2d4635">500 mL</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(reference);
  child = spawn(process.execPath, [path.join(root, "dist-server", "index.js"), "--production"], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", API_HOST: "127.0.0.1", API_PORT: "0", APP_DATA_DIR: path.join(temporary, "data"), ZANE_PROJECT_DIR: project, HERMES_HOME: path.join(temporary, "unused-hermes"), COMFYUI_BASE_URL: "http://127.0.0.1:1", ZANE_SHUTDOWN_TIMEOUT_MS: "1000" },
  });
  exited = new Promise((resolve) => child.once("exit", resolve));
  const base = await bounded(new Promise((resolve, reject) => {
    child.on("error", reject);
    child.stderr.on("data", (chunk) => { logs += chunk; });
    child.stdout.on("data", (chunk) => { logs += chunk; const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs); if (match) resolve(match[1]); });
    child.once("exit", (code) => reject(new Error(`Server exited (${code})\n${logs}`)));
  }), 10000);
  await json(base, "/api/ready");
  const pkg = JSON.parse(await readFile(path.join(root, "examples", "scenes", "commerce-pack.json"), "utf8"));
  const legacyScene = { ...pkg.scene, id: "legacy_scene", title: "原有场景（隔离测试）" };
  const original = { format: "zane-studio.workspace/v1", scenes: [legacyScene], workflows: { legacy_scene: { ...pkg.workflow, sceneId: "legacy_scene" } }, optionPresets: [], drafts: [], sceneVersions: {} };
  await json(base, "/api/workspace/initialize", original);
  const install = () => promisify(execFile)(process.execPath, ["--import", "tsx", path.join(root, "scripts", "install-commerce-pack.mjs"), base], { cwd: root, windowsHide: true, timeout: 20000, env: { ...process.env, ZANE_COMMERCE_BACKUP_DIRECTORY: path.join(temporary, "backups") } });
  await install();
  const installed = (await json(base, "/api/workspace")).workspace;
  assert.equal(installed.scenes.length, 2);
  assert.deepEqual(installed.scenes[0], legacyScene);
  assert.deepEqual(installed.workflows.legacy_scene, original.workflows.legacy_scene);
  assert.ok(installed.sceneVersions.commerce_pack.publishedVersionId);
  assert.deepEqual(installed.optionPresets, original.optionPresets); assert.deepEqual(installed.drafts, original.drafts);
  assert.match((await install()).stdout, /已存在/);
  assert.deepEqual((await json(base, "/api/workspace")).workspace, installed);
  console.log("Additive scene install / legacy workspace preserved / published version / idempotent reinstall verified");
  const runId = randomUUID();
  const values = { project_name: "电商套图隔离验收", product_name: "通勤保温杯", reference_images: [reference], selling_points: "轻巧便携\n防滑杯底", product_specs: "容量500mL", package_contents: "杯体 × 1", audience: "通勤", generation_mode: "原图保真排版", platform_preset: "国内三平台（淘宝/京东/抖音）", platform_profiles: null, shot_types: ["hero", "selling_point", "detail", "lifestyle", "specs", "package"], visual_style: "自然生活", brand_notes: "这是测试插图，不是实际商品", add_text: true };
  await json(base, "/api/v1/runs", { runId, workflow: pkg.workflow, inputValues: values });
  const run = await bounded((async () => {
    for (;;) {
      const record = await json(base, `/api/v1/runs/${runId}`);
      if (!["queued", "running", "cancelling"].includes(record.status)) return record;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  })());
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.steps[1].status, "skipped"); assert.equal(run.steps[2].status, "skipped");
  const images = run.outputs.find((item) => item.key === "images").value;
  const rows = run.outputs.find((item) => item.key === "commerce_manifest").value.flat();
  assert.equal(images.length, 18); assert.equal(rows.length, 18);
  assert.deepEqual([...new Set(rows.map((row) => row.platformId))].sort(), ["douyin", "jd", "taobao"]);
  for (const row of rows) {
    assert.equal(row.generationMode, "原图保真排版"); assert.equal(row.referenceIndex, 0);
    const response = await fetch(base + row.preview); assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()); const info = await sharp(bytes).metadata();
    const size = row.platformId === "douyin" ? 1200 : 1600;
    assert.equal(info.width, size); assert.equal(info.height, size); assert.equal(info.format, "jpeg");
    assert.equal(bytes.length, row.bytes);
    assert.ok((await stat(path.join(run.artifacts.directory, row.outputFile))).size > 0);
  }
  const response = await fetch(`${base}/api/v1/runs/${runId}/commerce-pack.zip`);
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /application\/zip/);
  const zip = Buffer.from(await response.arrayBuffer());
  const archive = path.join(temporary, "commerce-pack.zip"); await writeFile(archive, zip);
  assert.equal(zip.readUInt16LE(zip.length - 12), 20);
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${archive.replaceAll("'", "''")}'); try { if($z.Entries.Count -ne 20){throw 'Wrong ZIP count'}; foreach($e in $z.Entries){$s=$e.Open(); try{$m=[IO.MemoryStream]::new(); $s.CopyTo($m); if($e.FullName -eq 'manifest.json'){$manifest=[Text.Encoding]::UTF8.GetString($m.ToArray()) | ConvertFrom-Json; if($manifest.totalImages -ne 18 -or $manifest.incomplete){throw 'Wrong manifest'}}; $m.Dispose()} finally{$s.Dispose()}}; Write-Output 'ZIP independently opened and all entries extracted by .NET' } finally {$z.Dispose()}`;
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 20000 });
    console.log(stdout.trim());
  }
  if (process.argv.includes("--save-preview")) {
    const output = path.join(root, ".local", "commerce-smoke"); await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "commerce-pack.zip"), zip);
    for (const row of rows.filter((item) => item.platformId === "taobao")) await writeFile(path.join(output, `${row.shotId}.jpg`), await readFile(path.join(run.artifacts.directory, row.outputFile)));
    console.log(`Synthetic test previews saved to ${output}`);
  }
  console.log("PASS: compiled commerce scene / real control branching / skipped generation / 18 JPEGs / archived HTTP previews / platform ZIP (isolated data, no AI calls)");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    try { await bounded(exited, 10000); } catch { child.kill("SIGKILL"); await exited; }
  }
  const resolved = path.resolve(temporary);
  assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}zane-commerce-smoke-`));
  await rm(resolved, { recursive: true, force: true });
}
