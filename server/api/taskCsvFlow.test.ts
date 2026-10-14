import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskTemplateCsv, csvRow, parseCsv, parseTaskItemsCsv, serializeTaskItemsCsv, toCsvFieldSpec, type CsvSceneSpec } from "../../src/lib/taskCsv.js";
import { taskHarness } from "../testing/taskSupport.js";

/**
 * CSV 全链路：用真实 TaskService 证明「导出模板 → 在 Excel 里填 → 导回 → 提交运行」可用。
 * 只做纯函数单测会漏掉「导出的列名服务端根本不认」这类问题，所以这里必须走真服务。
 *
 * 注意：测试工作区的发布版 inputs 没有 label（标题来自 inputSchema），
 * 所以表头可能是 `flag [flag]`；断言一律按 key 定位列，不硬编码中文表头。
 */
async function specsOf(harness: Awaited<ReturnType<typeof taskHarness>>): Promise<CsvSceneSpec[]> {
  return Promise.all(["demo", "demo2"].map(async sceneId => {
    const version = await harness.scenes.get(sceneId);
    return { sceneId, versionId: version.versionId, fields: version.workflow.inputs.map(field => toCsvFieldSpec(field)) };
  }));
}

/** 按 key 找列下标；找不到直接失败，避免 indexOf 返回 -1 后静默写到错误的“列”。 */
function columnOf(header: readonly string[], key: string): number {
  const index = header.findIndex(cell => cell.endsWith("[" + key + "]"));
  assert.notEqual(index, -1, "模板缺少列：" + key + "（表头：" + header.join(" | ") + "）");
  return index;
}

test("CSV 全链路：模板列名与服务端契约一致，导回后能创建并确认", async t => {
  const h = await taskHarness(t);
  const specs = await specsOf(h);
  const demo = specs.find(spec => spec.sceneId === "demo")!;
  // demo 发布版要求 flag 必填；style 有发布版默认值。
  assert.deepEqual(demo.fields.map(field => field.key).sort(), ["flag", "style"]);

  // 1) 导出模板：固定三列 + 每个输入一列，表头带 [key]。
  const template = buildTaskTemplateCsv({ scenes: [demo], sceneId: "demo", rowCount: 2 });
  const rows = parseCsv(template);
  assert.deepEqual(rows[0].slice(0, 3), ["名称", "场景ID", "发布版ID"]);
  assert.equal(rows[0].length, 5);
  assert.equal(rows.length, 3, "表头 + 2 行");

  // 2) 模拟用户填表：只把开关写成 true，风格留默认。
  const flagAt = columnOf(rows[0], "flag");
  for (let index = 1; index < rows.length; index += 1) rows[index][flagAt] = "true";
  const filled = rows.map(csvRow).join("\r\n") + "\r\n";

  // 3) 导回：解析出的值必须和服务端契约类型一致（boolean 不能变成字符串）。
  const items = parseTaskItemsCsv("\ufeff" + filled, { scenes: specs });
  assert.deepEqual(items.map(item => item.inputValues.flag), [true, true]);
  // 模板会预填非媒体默认值，所以 style 带着发布版默认值一起导回。
  assert.deepEqual(items.map(item => item.inputValues.style), ["已发布值", "已发布值"]);
  assert.deepEqual(items.map(item => item.label), ["第 1 项", "第 2 项"]);

  // 4) 真实服务创建：CSV 解析结果必须直接可用，不需要人工修补。
  const taskId = crypto.randomUUID();
  const created = await h.tasks.create({ taskId, name: "CSV 导入的任务", items }, h.actor);
  assert.equal(created.task.status, "draft");
  assert.equal(created.task.items?.length, 2);
  assert.deepEqual(created.task.sceneIds, ["demo"]);
  // 服务端补上了发布版默认值。
  assert.equal(created.task.items?.[0].inputValues?.style, "已发布值");

  // 5) 确认：批量提交成为互相独立的运行。
  const confirmed = await h.tasks.confirm(taskId, { revision: created.task.revision }, h.actor);
  assert.equal(confirmed.failures.length, 0, JSON.stringify(confirmed.failures));
  assert.equal(confirmed.submitted.length, 2);
});

test("CSV 全链路：跨场景模板能在一个任务里同时提交两个场景", async t => {
  const h = await taskHarness(t);
  const specs = await specsOf(h);
  // 不指定 sceneId：每个已发布场景一行。
  const template = buildTaskTemplateCsv({ scenes: specs });
  const rows = parseCsv(template);
  assert.deepEqual(rows.slice(1).map(row => row[1]), ["demo", "demo2"]);
  const flagAt = columnOf(rows[0], "flag");
  rows[1][flagAt] = "true";
  rows[2][flagAt] = "false";

  const items = parseTaskItemsCsv("\ufeff" + rows.map(csvRow).join("\r\n") + "\r\n", { scenes: specs });
  const taskId = crypto.randomUUID();
  const created = await h.tasks.create({ taskId, name: "跨场景任务", items }, h.actor);
  assert.deepEqual(created.task.sceneIds, ["demo", "demo2"], "一个任务可以混合多个场景");

  const confirmed = await h.tasks.confirm(taskId, { revision: created.task.revision }, h.actor);
  assert.equal(confirmed.failures.length, 0, JSON.stringify(confirmed.failures));
  assert.equal(confirmed.submitted.length, 2);
});

test("CSV 全链路：服务端拒绝的输入在本地导入时就能被指出行号", async t => {
  const h = await taskHarness(t);
  const specs = await specsOf(h);
  const template = buildTaskTemplateCsv({ scenes: specs.filter(spec => spec.sceneId === "demo"), sceneId: "demo", rowCount: 1 });
  const rows = parseCsv(template);
  const flagAt = columnOf(rows[0], "flag");
  rows[1][flagAt] = "也许是";
  assert.throws(
    () => parseTaskItemsCsv("\ufeff" + rows.map(csvRow).join("\r\n"), { scenes: specs }),
    (error: Error) => /第 2 行/.test(error.message) && /\[flag\]/.test(error.message) && /布尔值/.test(error.message),
  );
});

test("CSV 全链路：导出已保存的任务项再导回，值不丢失", async t => {
  const h = await taskHarness(t);
  const specs = await specsOf(h);
  const taskId = crypto.randomUUID();
  const created = await h.tasks.create({ taskId, name: "导出验证", items: [h.item("甲", { flag: true, style: "已发布值" })] }, h.actor);

  const csv = serializeTaskItemsCsv(created.task.items!.map(view => ({ label: view.label, sceneId: view.sceneId, versionId: view.versionId, inputValues: view.inputValues as Record<string, never> })), specs);
  const back = parseTaskItemsCsv(csv, { scenes: specs });
  assert.equal(back.length, 1);
  assert.deepEqual(back[0].inputValues, { flag: true, style: "已发布值" });
  // 导回的内容必须能再建一个任务：证明导出没有破坏类型。
  const again = await h.tasks.create({ taskId: crypto.randomUUID(), name: "导回验证", items: back }, h.actor);
  assert.equal(again.task.items?.[0].inputValues?.flag, true);
});
