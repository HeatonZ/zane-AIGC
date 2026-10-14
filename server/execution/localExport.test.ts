import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeLocalExport } from "./localExport.js";
import { createRuntimeMediaValue } from "../runtimeValue.js";
import { runArtifactPaths } from "../artifacts/runArtifacts.js";
import { HttpError } from "../errors.js";
import { harness, id, temporaryDirectory } from "../testing/testSupport.js";
import type { RuntimeMediaItem } from "../runtimeValue.js";

/** 造一个真实归档媒体：写入 outputs/media，并按归档后的真实形状给出 filename 与本运行媒体 URL。
 *  归档输出带的是 `{ url: /api/v1/runs/<runId>/media/<file> }`，filesystem 路径由归档目录推导。 */
async function archiveMedia(projectDirectory: string, runId: string, bytes = Buffer.from("PNG-BYTES")) {
  const directory = path.join(runArtifactPaths(projectDirectory, runId).directory, "outputs", "media");
  await mkdir(directory, { recursive: true });
  const filename = "972db12c-1532-46e2-ba37-deef7ddf891c.png";
  await writeFile(path.join(directory, filename), bytes);
  const item = { id: "media-1", kind: "image", locator: { type: "path", value: path.join(directory, filename) }, filename } as RuntimeMediaItem;
  return { directory, filename, item, media: new Map([[filename, item]]) };
}
/** 走真实归档形状的媒体值：经 createRuntimeMediaValue 归一化后放进步骤输入。 */
function archivedMediaValue(runId: string, filename: string) {
  return createRuntimeMediaValue("image", [{ url: "/api/v1/runs/" + runId + "/media/" + filename }]);
}
const authorize = () => {};

test("本地导出：写入受控根目录、原子落盘并返回逐项校验和", async t => {
  const root = await temporaryDirectory(t);
  const projectDirectory = path.join(root, "project");
  await mkdir(projectDirectory);
  const runId = id("local-export-write");
  const { item, filename } = await archiveMedia(projectDirectory, runId, Buffer.from("hello-media"));
  const target = path.join(root, "out", "角色", "イリヤ.png");
  const result = await executeLocalExport({
    plan: { format: "zane-local-export-plan/v1", items: [{ source: filename, target }] },
    media: new Map([[filename, item]]), root: path.join(root, "out"), onConflict: "overwrite", projectDirectory, runId,
  });
  assert.equal(result.written, 1); assert.equal(result.skipped, 0);
  assert.equal(result.items[0]!.target, target);
  assert.equal(result.items[0]!.bytes, Buffer.byteLength("hello-media"));
  assert.equal((await readFile(target)).toString(), "hello-media");
  // 只留下目标文件，临时文件不残留。
  assert.deepEqual((await readdir(path.dirname(target))).sort(), ["イリヤ.png"]);
});

test("本地导出：未配置根目录关闭、目标越界与非法计划都失败且不写文件", async t => {
  const root = await temporaryDirectory(t);
  const projectDirectory = path.join(root, "project");
  await mkdir(projectDirectory);
  const out = path.join(root, "out");
  await mkdir(out);
  const runId = id("local-export-reject");
  const { item, filename } = await archiveMedia(projectDirectory, runId);
  const media = new Map([[filename, item]]);
  const base = { media, projectDirectory, runId, onConflict: "overwrite" as const };
  const code = (error: unknown) => (error as HttpError).code;

  // 未配置根目录：整体关闭，不写任何文件。
  await assert.rejects(() => executeLocalExport({ ...base, root: "", plan: { items: [{ source: filename, target: path.join(out, "a.png") }] } }), error => code(error) === "LOCAL_EXPORT_DISABLED");
  // 盘符/父级逃逸必须被拒绝，而不是被归一到根目录内。
  for (const escape of ["../outside.png", "..\\outside.png", path.join(root, "outside.png"), path.join(out, "..", "..", "outside.png")]) {
    await assert.rejects(() => executeLocalExport({ ...base, root: out, plan: { items: [{ source: filename, target: escape }] } }), error => code(error) === "LOCAL_EXPORT_OUTSIDE_ROOT", escape);
  }
  // 目标就是根目录本身、".."、无扩展名都是无效目标。
  for (const bad of [".", path.join(out, "no-extension"), "sub/../..", ""]) {
    await assert.rejects(() => executeLocalExport({ ...base, root: out, plan: { items: [{ source: filename, target: bad }] } }), error => code(error) === "LOCAL_EXPORT_OUTSIDE_ROOT" || code(error) === "INVALID_CODE_OUTPUT", bad);
  }
  // 非法计划形状。
  for (const plan of [{}, { items: [] }, { items: [{ source: filename }] }, { items: [{ target: path.join(out, "a.png") }] }, { items: "x" }, [1], null]) {
    await assert.rejects(() => executeLocalExport({ ...base, root: out, plan }), error => code(error) === "INVALID_CODE_OUTPUT", JSON.stringify(plan));
  }
  // source 必须是本步骤输入里真实存在的媒体，且不能带路径分隔符。
  for (const source of ["missing.png", "../evil.png", "sub/evil.png", ""]) {
    await assert.rejects(() => executeLocalExport({ ...base, root: out, plan: { items: [{ source, target: path.join(out, "a.png") }] } }), error => code(error) === "INVALID_CODE_OUTPUT", source);
  }
  // 重复目标单独拒绝：否则后一项会静默覆盖前一项。
  await assert.rejects(() => executeLocalExport({ ...base, root: out, plan: { items: [{ source: filename, target: path.join(out, "dup.png") }, { source: filename, target: path.join(out, "DUP.png") }] } }), error => code(error) === "INVALID_CODE_OUTPUT");
  assert.deepEqual(await readdir(out), [], "任何被拒绝的导出都不应留下文件");
});

test("本地导出：已存在父级符号链接指向根外时拒绝写入", async t => {
  const root = await temporaryDirectory(t);
  const projectDirectory = path.join(root, "project");
  await mkdir(projectDirectory);
  const out = path.join(root, "out");
  const outside = path.join(root, "outside");
  await mkdir(out); await mkdir(outside);
  const runId = id("local-export-symlink");
  const { item, filename } = await archiveMedia(projectDirectory, runId);
  // 在根目录内建一个指向根目录之外的联接目录，写入必须被拒绝（Windows 需要权限，无权限时跳过）。
  try { await symlink(outside, path.join(out, "link"), "junction"); }
  catch { t.skip("当前环境无法创建目录联接，跳过符号链接用例"); return; }
  await assert.rejects(() => executeLocalExport({
    plan: { items: [{ source: filename, target: path.join(out, "link", "escaped.png") }] },
    media: new Map([[filename, item]]), root: out, onConflict: "overwrite", projectDirectory, runId,
  }), error => ["LOCAL_EXPORT_OUTSIDE_ROOT", "LOCAL_EXPORT_FAILED"].includes((error as HttpError).code));
  assert.deepEqual(await readdir(outside), [], "符号链接逃逸不应写到根目录之外");
});

test("本地导出：onConflict 决定覆盖/跳过/失败，且 skip 不改变既有字节", async t => {
  const root = await temporaryDirectory(t);
  const projectDirectory = path.join(root, "project");
  await mkdir(projectDirectory);
  const out = path.join(root, "out");
  await mkdir(out);
  const runId = id("local-export-conflict");
  const { item, filename } = await archiveMedia(projectDirectory, runId, Buffer.from("fresh"));
  const media = new Map([[filename, item]]);
  const target = path.join(out, "same.png");
  const run = (onConflict: "overwrite" | "skip" | "fail") => executeLocalExport({ plan: { items: [{ source: filename, target }] }, media, root: out, onConflict, projectDirectory, runId });

  assert.equal((await run("overwrite")).written, 1);
  assert.equal((await readFile(target)).toString(), "fresh");
  // skip：保留既有内容，记为 skipped 而不是 written。
  await writeFile(target, "kept");
  const skipped = await run("skip");
  assert.equal(skipped.written, 0); assert.equal(skipped.skipped, 1);
  assert.equal((await readFile(target)).toString(), "kept");
  // fail：目标存在即失败，不覆盖。
  await assert.rejects(() => run("fail"), error => (error as HttpError).code === "LOCAL_EXPORT_FAILED");
  assert.equal((await readFile(target)).toString(), "kept");
  // overwrite 重新取最新结果。
  assert.equal((await run("overwrite")).written, 1);
  assert.equal((await readFile(target)).toString(), "fresh");
});

test("本地导出：复用祖先运行的归档媒体（局部重做/续跑）", async t => {
  // 回归：局部重做的第二步会复用祖先步骤的媒体引用，其 URL 指向祖先运行；
  // 只读本运行归档会因为"文件不在本运行"而失败，但也不能因此信任 URL 里的任意 runId。
  const root = await temporaryDirectory(t);
  const projectDirectory = path.join(root, "project");
  await mkdir(projectDirectory);
  const out = path.join(root, "out");
  const ancestorRunId = id("local-export-ancestor");
  const childRunId = id("local-export-child");
  const otherRunId = id("local-export-other");
  const { filename } = await archiveMedia(projectDirectory, ancestorRunId, Buffer.from("ancestor-bytes"));
  // 无关运行也有同名文件：血缘链外必须读不到，避免按 URL 里的 runId 越权读别的运行。
  await archiveMedia(projectDirectory, otherRunId, Buffer.from("other-bytes"));
  const media = new Map([[filename, { id: "media-1", kind: "image", locator: { type: "url", value: "/api/v1/runs/" + ancestorRunId + "/media/" + filename }, filename } as RuntimeMediaItem]]);
  const target = path.join(out, "角色", "reused.png");
  const request = (allowedRunIds: readonly string[] | undefined) => executeLocalExport({
    plan: { items: [{ source: filename, target }] }, media, root: out, onConflict: "overwrite", projectDirectory, runId: childRunId, ...(allowedRunIds ? { allowedRunIds } : {}),
  });

  // 未声明血缘时只读本运行：祖先媒体定位不到，明确失败而不是静默跳过。
  await assert.rejects(() => request(undefined), error => (error as HttpError).code === "INVALID_CODE_OUTPUT");
  // URL 指向血缘链外的运行时同样拒绝。
  await assert.rejects(() => request([childRunId, otherRunId]), error => (error as HttpError).code === "INVALID_CODE_OUTPUT");
  // 血缘链包含祖先运行：读到的是祖先归档里的字节。
  const result = await request([childRunId, ancestorRunId]);
  assert.equal(result.written, 1);
  assert.equal((await readFile(target)).toString(), "ancestor-bytes");
});

test("本地导出设置：单例、revision 保护、只读不初始化、旧 revision 冲突", async t => {
  const root = await temporaryDirectory(t);
  const h = await harness(t);
  const { LocalExportService } = await import("../services/localExportSettings.js");
  const configuredRoot = path.join(root, "exports");
  const service = new LocalExportService(h.store, "");
  const initial = service.read();
  assert.equal(initial.revision, 0); assert.equal(initial.root, ""); assert.equal(initial.enabled, false);
  assert.equal(initial.source, "unset"); assert.equal(initial.format, "zane-studio.local-export/v1");
  assert.deepEqual(h.store.listDocuments("@zane-system", "settings"), [], "只读不初始化");
  await assert.rejects(() => service.update({}, authorize), error => (error as HttpError).status === 400);
  for (const invalid of [{ revision: 0 }, { revision: 0, root: 5 }, { revision: 0, root: "relative/dir" }, { revision: 0, root: path.parse(root).root }, { revision: -1, root: configuredRoot }, { revision: 0, root: configuredRoot, extra: 1 }]) {
    await assert.rejects(() => service.update(invalid, authorize), error => (error as HttpError).status === 400, JSON.stringify(invalid));
  }
  const saved = await service.update({ revision: 0, root: configuredRoot }, authorize);
  assert.equal(saved.revision, 1); assert.equal(saved.source, "saved"); assert.equal(saved.enabled, true);
  assert.equal(saved.root, path.resolve(configuredRoot));
  assert.ok((await stat(configuredRoot)).isDirectory(), "保存会真实创建根目录");
  await assert.rejects(() => service.update({ revision: 0, root: configuredRoot }, authorize), error => (error as HttpError).code === "RESOURCE_REVISION_CONFLICT");
  // 空串关闭：运行期读取随之失效，且显式保存的空值优先于环境默认值。
  const closed = await service.update({ revision: 1, root: "" }, authorize);
  assert.equal(closed.revision, 2); assert.equal(closed.enabled, false); assert.equal(service.root(), "");
  const stillClosed = new LocalExportService(h.store, path.join(root, "env-exports"));
  assert.equal(stillClosed.read().source, "saved");
  assert.equal(stillClosed.root(), "", "已保存的空值优先于环境默认值");
  // 环境默认值只在完全没有保存值时生效。
  const { SqliteStore } = await import("../storage/sqliteStore.js");
  const fresh = new SqliteStore(path.join(root, "fresh.db"));
  try {
    const fromEnv = new LocalExportService(fresh, path.join(root, "env-exports"));
    assert.equal(fromEnv.read().source, "environment");
    assert.equal(fromEnv.root(), path.resolve(path.join(root, "env-exports")));
  } finally { fresh.close(); }
});

test("本地导出：core.code 在沙箱之外落盘，沙箱仍不能访问文件系统", async t => {
  const root = await temporaryDirectory(t);
  const out = path.join(root, "out");
  const projectDirectory = path.join(root, "project");
  await mkdir(projectDirectory);
  const runId = id("local-export-step");
  const { filename } = await archiveMedia(projectDirectory, runId, Buffer.from("archived-bytes"));
  // 用真实能力目录：core.code 走生产注册表与真实沙箱，而不是测试桩。
  const { loadCapabilityPackages } = await import("../capabilities/loadPackages.js");
  const executors = await loadCapabilityPackages({
    async hermes() { throw new Error("测试禁止调用 Hermes"); },
    async comfyui() { throw new Error("测试禁止调用 ComfyUI"); },
    async condition() { return { result: true }; },
    async thirdPartyRequest() { throw new Error("测试禁止调用第三方接口"); },
  });
  // 步骤只声明一个媒体输入与承载计划/报告的 json 输出端口。
  const step = {
    id: "export", name: "导出", kind: "capability", capabilityId: "core.code", capabilityVersion: "1",
    inputs: [{ key: "images", sourceRef: "input.images" }],
    outputs: [{ key: "export_plan", type: "json" }, { key: "local_export", type: "json", required: false }, { key: "probe", type: "text" }],
    capabilityConfig: {
      localExport: { enabled: true, planKey: "export_plan" },
      code: "const list = Array.isArray(inputs.images) ? inputs.images : [];\nconst target = " + JSON.stringify(path.join(out, "角色", "name.png")) + ";\nlet fs = 'none';\ntry { fs = typeof this.constructor.constructor('return process')() === 'object' ? 'escaped' : 'no'; } catch (e) { fs = 'blocked'; }\nreturn { export_plan: { items: list.map(function (item, i) { return { source: item.filename, target: i === 0 ? target : target.replace(/\\.png$/, '_' + (i + 1) + '.png') }; }) }, probe: fs };",
    },
  };
  const prepared = executors.prepareStep(step);
  const media = archivedMediaValue(runId, filename);
  const outputs = await executors.execute({
    runId, artifacts: runArtifactPaths(projectDirectory, runId), step: prepared, inputValues: { images: media },
    stepValues: new Map(), types: new Map(), inputFields: [], settings: { projectDirectory, comfyuiBaseUrl: "", workflowTimeoutMinutes: 1, enabledHermesProfiles: [] },
    localExportRoot: out, signal: AbortSignal.timeout(30000),
  } as never);
  // 沙箱依旧逃不出去，而宿主按计划把归档媒体复制到了受控目录。
  assert.equal(outputs.probe, "blocked");
  const written = path.join(out, "角色", "name.png");
  assert.equal((await readFile(written)).toString(), "archived-bytes");
  const report = outputs.local_export as { written: number; items: Array<{ sha256: string; status: string }> };
  assert.equal(report.written, 1); assert.equal(report.items[0]!.status, "written");
  assert.match(report.items[0]!.sha256, /^[a-f0-9]{64}$/);
});

test("本地导出：根目录经 RunService→executeWorkflow 注入，未配置时不落盘", async t => {
  // 覆盖此前没人验证的一环：管理员设置如何经 RunService 传到步骤上下文。
  // 上游步骤正常产出并归档媒体，第二步 core.code 只提交计划、由宿主落盘。
  const root = await temporaryDirectory(t);
  const out = path.join(root, "out");
  const { loadCapabilityPackages } = await import("../capabilities/loadPackages.js");
  const executors = await loadCapabilityPackages({
    async hermes() { throw new Error("测试禁止调用 Hermes"); },
    async comfyui() { throw new Error("测试禁止调用 ComfyUI"); },
    async condition() { return { result: true }; },
    async thirdPartyRequest() { throw new Error("测试禁止调用第三方接口"); },
  });
  const filename = "972db12c-1532-46e2-ba37-deef7ddf891c.png";
  const rootsSeen: Array<string | undefined> = [];
  executors.register({
    kind: "producer",
    async execute(context) {
      rootsSeen.push(context.localExportRoot);
      const directory = path.join(context.artifacts.directory, "outputs", "media");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, filename), Buffer.from("produced-bytes"));
      return { images: createRuntimeMediaValue("image", [{ url: "/api/v1/runs/" + context.runId + "/media/" + filename }]) as unknown as never };
    },
  });
  const target = path.join(out, "批次", "角色名.png");
  const workflow = {
    sceneId: "scene", name: "导出接线", inputs: [],
    steps: [
      { id: "generate", name: "生图", kind: "producer", inputs: [], outputs: [{ key: "images", type: "image_list" }] },
      {
        id: "export", name: "导出", kind: "capability", capabilityId: "core.code", capabilityVersion: "1",
        inputs: [{ key: "images", sourceRef: "step.generate.outputs.images" }],
        outputs: [{ key: "export_plan", type: "json" }, { key: "local_export", type: "json", required: false }],
        capabilityConfig: {
          localExport: { enabled: true, planKey: "export_plan" },
          code: "const list = Array.isArray(inputs.images) ? inputs.images : [];\nreturn { export_plan: { items: list.map(function (item) { return { source: item.filename, target: " + JSON.stringify(target) + " }; }) } };",
        },
      },
    ],
    outputs: [{ key: "plan", type: "json", sourceRef: "step.export.outputs.export_plan" }],
  };

  // 未配置根目录：能力关闭，导出步骤必须明确失败，且不产生任何导出文件。
  const closedRun = id("local-export-wiring-closed");
  const disabled = await harness(t, { executors, getLocalExportRoot: () => "" });
  await disabled.service.start();
  await disabled.service.submit({ runId: closedRun, workflow: workflow as never, inputValues: {} });
  const closed = await disabled.service.wait(disabled.settings.projectDirectory, closedRun);
  assert.equal(closed.status, "failed", "未配置根目录时启用导出的步骤必须失败而不是静默跳过");
  const closedStep = closed.steps.find(item => item.stepId === "export");
  assert.equal(closedStep?.status, "failed");
  assert.match(String(closedStep?.message), /LOCAL_EXPORT_DISABLED|本地导出/);
  await assert.rejects(() => readdir(out), "未配置时不应创建任何导出目录");

  // 已配置根目录：同一流程把上游归档媒体写到受控目录。
  const openRun = id("local-export-wiring-open");
  const enabled = await harness(t, { executors, getLocalExportRoot: () => out });
  await enabled.service.start();
  await enabled.service.submit({ runId: openRun, workflow: workflow as never, inputValues: {} });
  const done = await enabled.service.wait(enabled.settings.projectDirectory, openRun);
  assert.equal(done.status, "completed", JSON.stringify(done.steps.map(item => item.message)));
  assert.equal((await readFile(target)).toString(), "produced-bytes");
  const written = await enabled.service.getRun(enabled.settings.projectDirectory, openRun);
  const plan = written!.steps.find(item => item.stepId === "export")!.outputs!.export_plan;
  assert.equal((plan as { items: unknown[] }).items.length, 1);
  // 根目录确实由 RunService 注入步骤上下文，而不是测试自己塞进去的。
  assert.deepEqual(rootsSeen, ["", out]);
});

test("本地导出：下游步骤可导出尚未归档的 ComfyUI 输出（归档顺序回归）", async t => {
  // 回归：workflowExecutor 在流程末尾才归档，因此下游步骤拿到的是 ComfyUI 的原始
  // {filename,subfolder,type}（文件还没改名落盘）。此前这类媒体一律导出失败
  // （「未归档的 ComfyUI 输出不能导出」），导致「生成后按角色名归档到固定目录」无法实现。
  // 现在归档里找不到时按配置的 comfyuiBaseUrl 取回本机 ComfyUI 刚生成的产物。
  const requested: string[] = [];
  const upstream = createServer((request, response) => {
    requested.push(request.url ?? "");
    if (!(request.url ?? "").startsWith("/view?")) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": "image/png" });
    response.end(Buffer.from("fresh-comfy-bytes"));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const root = await temporaryDirectory(t);
  const out = path.join(root, "out");
  const { loadCapabilityPackages } = await import("../capabilities/loadPackages.js");
  const executors = await loadCapabilityPackages({
    async hermes() { throw new Error("测试禁止调用 Hermes"); },
    async comfyui() { throw new Error("测试禁止调用 ComfyUI"); },
    async condition() { return { result: true }; },
    async thirdPartyRequest() { throw new Error("测试禁止调用第三方接口"); },
  });
  // 模拟 ComfyUI 步骤刚返回、尚未归档的输出形状：运行时媒体值（含 comfy 定位器），
  // 沙箱只看到 {filename}，宿主凭定位器去 ComfyUI 取字节。
  executors.register({
    kind: "comfy-producer",
    async execute() {
      return { images: createRuntimeMediaValue("image", [{ filename: "qwen21_i2i_00001_.png", subfolder: "Zane", type: "output", url: "/api/comfyui/view?filename=qwen21_i2i_00001_.png&subfolder=Zane&type=output" }]) as unknown as never };
    },
  });
  const target = path.join(out, "11", "结果1", "アリサ・ミハイロヴナ・九条.png");
  const code = "const list = Array.isArray(inputs.images) ? inputs.images : [];\nreturn { export_plan: { items: list.map(function (item) { return { source: item.filename, target: " + JSON.stringify(target) + " }; }) } };";
  const runId = id("local-export-unarchived-comfy");
  const h = await harness(t, { executors, getLocalExportRoot: () => out });
  h.settings.comfyuiBaseUrl = "http://127.0.0.1:" + port;
  await h.service.start();
  await h.service.submit({ runId, inputValues: {}, workflow: {
    sceneId: "scene", name: "未归档 ComfyUI 输出导出", inputs: [],
    steps: [
      { id: "generate", name: "生图", kind: "comfy-producer", inputs: [], outputs: [{ key: "images", type: "image_list" }] },
      { id: "export", name: "导出", kind: "capability", capabilityId: "core.code", capabilityVersion: "1",
        inputs: [{ key: "images", sourceRef: "step.generate.outputs.images" }],
        outputs: [{ key: "export_plan", type: "json" }, { key: "local_export", type: "json", required: false }],
        capabilityConfig: { localExport: { enabled: true, planKey: "export_plan" }, code } },
    ],
    outputs: [{ key: "plan", type: "json", sourceRef: "step.export.outputs.export_plan" }],
  } as never });
  const result = await h.service.wait(h.settings.projectDirectory, runId);
  assert.equal(result.status, "completed", JSON.stringify(result.steps.map(item => item.message)));
  assert.equal((await readFile(target)).toString(), "fresh-comfy-bytes");
  assert.ok(requested.some(url => url.includes("filename=qwen21_i2i_00001_.png")), "应按 filename/subfolder/type 向 ComfyUI 请求该产物");
});

test("本地导出：未归档的远程 URL 媒体仍然明确失败，不因回退而放宽", async t => {
  // 回退只针对本机 ComfyUI 产物；任意外部 URL 不能借这条路径被下载。
  const root = await temporaryDirectory(t);
  const out = path.join(root, "out");
  const { loadCapabilityPackages } = await import("../capabilities/loadPackages.js");
  const executors = await loadCapabilityPackages({
    async hermes() { throw new Error("测试禁止调用 Hermes"); },
    async comfyui() { throw new Error("测试禁止调用 ComfyUI"); },
    async condition() { return { result: true }; },
    async thirdPartyRequest() { throw new Error("测试禁止调用第三方接口"); },
  });
  executors.register({
    kind: "url-producer",
    async execute() { return { images: createRuntimeMediaValue("image", [{ id: "remote", url: "https://example.invalid/secret.png", filename: "secret.png" }]) as unknown as never }; },
  });
  const h = await harness(t, { executors, getLocalExportRoot: () => out });
  await h.service.start();
  const runId = id("local-export-remote-url");
  const code = "const list = Array.isArray(inputs.images) ? inputs.images : [];\nreturn { export_plan: { items: list.map(function (item) { return { source: item.filename, target: \"远程.png\" }; }) } };";
  await h.service.submit({ runId, inputValues: {}, workflow: {
    sceneId: "scene", name: "远程 URL 导出", inputs: [],
    steps: [
      { id: "generate", name: "取图", kind: "url-producer", inputs: [], outputs: [{ key: "images", type: "image_list" }] },
      { id: "export", name: "导出", kind: "capability", capabilityId: "core.code", capabilityVersion: "1",
        inputs: [{ key: "images", sourceRef: "step.generate.outputs.images" }],
        outputs: [{ key: "export_plan", type: "json" }],
        capabilityConfig: { localExport: { enabled: true, planKey: "export_plan" }, code } },
    ],
    outputs: [],
  } as never });
  const result = await h.service.wait(h.settings.projectDirectory, runId);
  assert.equal(result.status, "failed");
  assert.match(String(result.error ?? result.steps.map(item => item.message).join(" ")), /没有可读取的本地文件|未归档/);
  await assert.rejects(() => readFile(path.join(out, "远程.png")), "不得写出任何文件");
});

test("本地导出：局部重做复用祖先媒体时，RunService 传入授权血缘链", async t => {
  // 端到端回归：真实提交 → 真实 rerun 规划 → 第二步复用第一步的媒体引用来导出。
  // 被复用的媒体留在祖先运行归档里，宿主必须沿授权血缘链去读，而不是只读本运行。
  const root = await temporaryDirectory(t);
  const out = path.join(root, "out");
  const { loadCapabilityPackages } = await import("../capabilities/loadPackages.js");
  const executors = await loadCapabilityPackages({
    async hermes() { throw new Error("测试禁止调用 Hermes"); },
    async comfyui() { throw new Error("测试禁止调用 ComfyUI"); },
    async condition() { return { result: true }; },
    async thirdPartyRequest() { throw new Error("测试禁止调用第三方接口"); },
  });
  const filename = "972db12c-1532-46e2-ba37-deef7ddf891c.png";
  let produced = 0;
  executors.register({
    kind: "producer",
    async execute(context) {
      produced++;
      const directory = path.join(context.artifacts.directory, "outputs", "media");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, filename), Buffer.from("ancestor-produces-" + produced));
      return { images: createRuntimeMediaValue("image", [{ url: "/api/v1/runs/" + context.runId + "/media/" + filename }]) as unknown as never };
    },
  });
  const exportCode = (name: string) => "const list = Array.isArray(inputs.images) ? inputs.images : [];\nreturn { export_plan: { items: list.map(function (item) { return { source: item.filename, target: " + JSON.stringify(path.join(out, "批次", name + ".png")) + " }; }) } };";
  const exportStep = (code: string) => ({
    id: "export", name: "导出", kind: "capability", capabilityId: "core.code", capabilityVersion: "1",
    inputs: [{ key: "images", sourceRef: "step.generate.outputs.images" }],
    outputs: [{ key: "export_plan", type: "json" }, { key: "local_export", type: "json", required: false }],
    capabilityConfig: { localExport: { enabled: true, planKey: "export_plan" }, code },
  });
  const workflow = {
    sceneId: "scene", name: "血缘导出", inputs: [],
    steps: [
      { id: "generate", name: "生图", kind: "producer", inputs: [], outputs: [{ key: "images", type: "image_list" }] },
      exportStep(exportCode("第一次")),
    ],
    outputs: [{ key: "plan", type: "json", sourceRef: "step.export.outputs.export_plan" }],
  };

  const firstRun = id("local-export-lineage-first");
  const h = await harness(t, { executors, getLocalExportRoot: () => out });
  await h.service.start();
  await h.service.submit({ runId: firstRun, workflow: workflow as never, inputValues: {} });
  const first = await h.service.wait(h.settings.projectDirectory, firstRun);
  assert.equal(first.status, "completed", JSON.stringify(first.steps.map(item => item.message)));
  assert.equal((await readFile(path.join(out, "批次", "第一次.png"))).toString(), "ancestor-produces-1");

  // 只改第二步的代码做局部重做：第一步被复用，媒体字节仍留在第一次运行的归档里。
  const secondRun = id("local-export-lineage-second");
  const revised = { ...workflow, steps: [workflow.steps[0]!, exportStep(exportCode("第二次"))] };
  await h.service.submit({ runId: secondRun, workflow: revised as never, inputValues: {}, rerunFromRunId: firstRun, rerunRequest: { stepOverrides: [{ stepId: "export", capabilityConfig: { localExport: { enabled: true, planKey: "export_plan" }, code: exportCode("第二次") } }] } });
  const second = await h.service.wait(h.settings.projectDirectory, secondRun);
  assert.equal(second.status, "completed", JSON.stringify(second.steps.map(item => item.message)));
  // 第一步真的被复用（没有重新生成），因此字节只能来自祖先归档。
  assert.equal(produced, 1, "局部重做不应重新执行被复用的第一步");
  assert.equal((await readFile(path.join(out, "批次", "第二次.png"))).toString(), "ancestor-produces-1");
});
