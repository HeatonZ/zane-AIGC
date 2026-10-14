import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskTemplateCsv, csvEscape, parseCsv, parseTaskItemsCsv, serializeTaskItemsCsv, toCsvFieldSpec, type CsvSceneSpec } from "./taskCsv.js";
import { PasteImportError } from "./taskImport.js";

const demo: CsvSceneSpec = {
  sceneId: "demo", versionId: "version-a", title: "演示场景",
  fields: [
    { key: "product_images", label: "商品主图", type: "image_list", required: true },
    { key: "need", label: "描述", type: "textarea", required: false, defaultValue: "无" },
    { key: "language", label: "语言", type: "text", required: true, defaultValue: "英文" },
    { key: "width", label: "宽", type: "number", required: true, minimum: 1, maximum: 1600, defaultValue: 1024 },
    { key: "number", label: "数量", type: "select", required: true, options: ["1", "2", "4"], defaultValue: "4" },
    { key: "flag", label: "开关", type: "boolean", required: true, defaultValue: false },
    { key: "secret", label: "内部", type: "text", required: false, hidden: true, defaultValue: "x" },
  ],
};
const demo2: CsvSceneSpec = { sceneId: "demo2", versionId: "version-b", title: "第二个场景", fields: [{ key: "text", label: "提示词", type: "text", required: true }] };
const scenes = [demo, demo2];

test("发布版字段 → 列规格：约束一项都不能漏", () => {
  // 漏掉任何一项都会让模板少列或让导入校验放水，而这类遗漏在页面里看不出来。
  const spec = toCsvFieldSpec({ key: "width", label: "宽", type: "number", required: true, minimum: 1, maximum: 1600, defaultValue: 1024, placeholder: "px" });
  assert.deepEqual(spec, { key: "width", label: "宽", type: "number", required: true, minimum: 1, maximum: 1600, defaultValue: 1024 });
  // inputSchema 的标题优先于字段自带 label。
  assert.equal(toCsvFieldSpec({ key: "k", label: "旧名", type: "text", required: false }, "新名").label, "新名");
  // 没有 label 时回退到 key，不能出现空表头。
  assert.equal(toCsvFieldSpec({ key: "k", label: "", type: "text", required: false }).label, "k");
  // hidden/options/inputMode 都要原样带过去。
  const hidden = toCsvFieldSpec({ key: "h", label: "内部", type: "text", required: false, hidden: true });
  assert.equal(hidden.hidden, true);
  assert.deepEqual(toCsvFieldSpec({ key: "s", label: "样式", type: "select", required: false, options: ["a", "b"] }).options, ["a", "b"]);
  assert.equal(toCsvFieldSpec({ key: "o", label: "表格", type: "json", required: false, inputMode: "object_array", itemFields: [] }).inputMode, "object_array");
  // 值 0 与 false 的默认值必须保留，不能被当成「没有默认值」丢掉。
  assert.equal(toCsvFieldSpec({ key: "n", label: "偏移", type: "number", required: false, defaultValue: 0 }).defaultValue, 0);
  assert.equal(toCsvFieldSpec({ key: "b", label: "开关", type: "boolean", required: false, defaultValue: false }).defaultValue, false);
});

test("CSV 转义：逗号、引号、换行与首尾空格都必须加引号", () => {
  assert.equal(csvEscape("普通"), "普通");
  assert.equal(csvEscape("a,b"), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape("第一行\n第二行"), '"第一行\n第二行"');
  assert.equal(csvEscape(" 空格 "), '" 空格 "');
  // 空串不加引号，保持模板干净。
  assert.equal(csvEscape(""), "");
});

test("CSV 解析：引号内的逗号与换行不被当作分隔符（Excel 往返的前提）", () => {
  const rows = parseCsv('a,b,c\n"x,1",2,"多\n行"\n');
  assert.deepEqual(rows, [["a", "b", "c"], ["x,1", "2", "多\n行"]]);
  // 双引号转义还原成单个引号。
  assert.deepEqual(parseCsv('"say ""hi"""'), [['say "hi"']]);
  // 末尾无换行也要收尾；全空行丢弃。
  assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv("a,b\n\n\n1,2\n"), [["a", "b"], ["1", "2"]]);
  // BOM 必须剥掉，否则第一列表头会变成 "\ufeff名称" 而认不出来。
  assert.deepEqual(parseCsv("\ufeff名称,场景ID"), [["名称", "场景ID"]]);
});

test("模板：带 BOM、固定三列加输入列，隐藏字段不进模板，媒体列留空", () => {
  const csv = buildTaskTemplateCsv({ scenes: [demo], sceneId: "demo", rowCount: 3 });
  assert.equal(csv.startsWith("\ufeff"), true, "Excel 需要 BOM 才不乱码");
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], ["名称", "场景ID", "发布版ID", "商品主图 [product_images]", "描述 [need]", "语言 [language]", "宽 [width]", "数量 [number]", "开关 [flag]"]);
  // hidden 字段不出现在模板里。
  assert.equal(csv.includes("secret"), false);
  assert.equal(rows.length, 4, "表头 + 3 行");
  assert.deepEqual(rows[1].slice(0, 3), ["第 1 项", "demo", "version-a"]);
  // 媒体列留空：不伪造素材引用。
  assert.equal(rows[1][3], "");
  // 非媒体默认值预填，方便直接跑。
  assert.deepEqual(rows[1].slice(4), ["无", "英文", "1024", "4", "false"]);
});

test("模板：不指定场景时每个已发布场景一行，跨场景列取并集", () => {
  const rows = parseCsv(buildTaskTemplateCsv({ scenes }));
  assert.equal(rows.length, 3, "表头 + 每个场景一行");
  assert.deepEqual(rows.slice(1).map(row => row[1]), ["demo", "demo2"]);
  const header = rows[0];
  assert.equal(header.includes("提示词 [text]"), true);
  assert.equal(header.includes("商品主图 [product_images]"), true);
  // demo2 那一行只填自己的列，demo 的列留空。
  const demo2Row = rows[2];
  assert.equal(demo2Row[header.indexOf("语言 [language]")], "");
  assert.equal(demo2Row[header.indexOf("提示词 [text]")], "");
});

test("模板：指定场景时只输出该场景的列，绝不带出别的场景", () => {
  // 回归：曾经把「所有已发布场景的字段并集」写进表头，选了一个场景却导出几十个
  // 别的场景的列，表格根本没法填。指定 sceneId 时必须只用它自己的字段。
  const rows = parseCsv(buildTaskTemplateCsv({ scenes, sceneId: "demo2", rowCount: 2 }));
  assert.deepEqual(rows[0], ["名称", "场景ID", "发布版ID", "提示词 [text]"], "只应有 demo2 的列");
  // demo 的字段一个都不能出现。
  for (const leaked of ["商品主图 [product_images]", "语言 [language]", "宽 [width]", "数量 [number]", "开关 [flag]", "描述 [need]"]) {
    assert.equal(rows[0].includes(leaked), false, "不该出现其他场景的列：" + leaked);
  }
  assert.equal(rows.length, 3);
  // 传全部场景但指定了其中一个，也不能泄漏。
  assert.equal(buildTaskTemplateCsv({ scenes, sceneId: "demo", rowCount: 1 }).includes("提示词 [text]"), false);
});

test("导出当前项：列只取用到的场景，不把无关场景的字段全带上", () => {
  // 回归：导出曾按「所有已发布场景」取并集，一个只用 demo2 的任务也会带上 demo 的几十列。
  const onlySecond = parseCsv(serializeTaskItemsCsv([{ label: "甲", sceneId: "demo2", versionId: "version-b", inputValues: { text: "你好" } }], scenes));
  assert.deepEqual(onlySecond[0], ["名称", "场景ID", "发布版ID", "提示词 [text]"]);
  assert.deepEqual(onlySecond[1], ["甲", "demo2", "version-b", "你好"]);

  // 真的用到两个场景时才取并集。
  const both = parseCsv(serializeTaskItemsCsv([
    { label: "甲", sceneId: "demo", versionId: "version-a", inputValues: { language: "英文" } },
    { label: "乙", sceneId: "demo2", versionId: "version-b", inputValues: { text: "你好" } },
  ], scenes));
  assert.equal(both[0].includes("语言 [language]"), true);
  assert.equal(both[0].includes("提示词 [text]"), true);
  // demo 行不填 demo2 的列。
  assert.equal(both[1][both[0].indexOf("提示词 [text]")], "");

  // 项引用了未知场景（例如已取消发布）时退回全部场景，宁可多列也不要少列。
  const unknown = parseCsv(serializeTaskItemsCsv([{ label: "甲", sceneId: "不见了", versionId: "v", inputValues: {} }], scenes));
  assert.equal(unknown[0].includes("语言 [language]"), true);
});

test("模板行数有上限，避免误填出几千行", () => {
  assert.equal(parseCsv(buildTaskTemplateCsv({ scenes: [demo], sceneId: "demo", rowCount: 999 })).length, 201);
  assert.equal(parseCsv(buildTaskTemplateCsv({ scenes: [demo], sceneId: "demo", rowCount: 0 })).length, 2);
});

test("模板：没有已发布场景或场景不存在时明确报错", () => {
  assert.throws(() => buildTaskTemplateCsv({ scenes: [] }), (error: Error) => error instanceof PasteImportError && /没有可用的已发布场景/.test(error.message));
  assert.throws(() => buildTaskTemplateCsv({ scenes: [demo], sceneId: "不存在" }), (error: Error) => error instanceof PasteImportError && /不在当前已发布场景/.test(error.message));
});

test("CSV 导入：模板原样导回，默认值按类型还原", () => {
  const csv = buildTaskTemplateCsv({ scenes: [demo], sceneId: "demo", rowCount: 2 });
  const items = parseTaskItemsCsv(csv, { scenes });
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].inputValues, { need: "无", language: "英文", width: 1024, number: "4", flag: false });
  assert.equal(items[0].label, "第 1 项");
  // 媒体列留空 → 缺键，交给服务端/素材库，而不是塞一个空字符串。
  assert.equal("product_images" in items[0].inputValues, false);
});

test("CSV 导入：媒体用素材库固定版本引用 JSON，含逗号也能穿过 CSV", () => {
  const ref = JSON.stringify([{ assetId: "a-1", assetVersion: 2, assetName: "主图, 正面" }]);
  const csv = ["名称,场景ID,发布版ID,商品主图 [product_images]", `第 1 张,demo,version-a,"${ref.replace(/"/g, '""')}"`].join("\n");
  const items = parseTaskItemsCsv(csv, { scenes });
  assert.deepEqual(items[0].inputValues.product_images, [{ assetId: "a-1", assetVersion: 2, assetName: "主图, 正面" }]);
});

test("CSV 导入：每行可指向不同场景，按该行场景解释列", () => {
  const csv = ["名称,场景ID,发布版ID,语言 [language],提示词 [text]", "A,demo,version-a,中文,", "B,demo2,version-b,,一只猫"].join("\n");
  const items = parseTaskItemsCsv(csv, { scenes });
  assert.deepEqual(items[0], { label: "A", sceneId: "demo", versionId: "version-a", inputValues: { language: "中文" } });
  assert.deepEqual(items[1], { label: "B", sceneId: "demo2", versionId: "version-b", inputValues: { text: "一只猫" } });
});

test("CSV 导入：行内留空场景/发布版时用页面默认值", () => {
  const csv = ["名称,场景ID,发布版ID,语言 [language]", "A,,,中文"].join("\n");
  const items = parseTaskItemsCsv(csv, { scenes, defaultSceneId: "demo", defaultVersionId: "version-a" });
  assert.deepEqual(items[0], { label: "A", sceneId: "demo", versionId: "version-a", inputValues: { language: "中文" } });
});

test("CSV 导入：报错都带行号，且不静默丢弃", () => {
  const bad = (csv: string, pattern: RegExp) => assert.throws(() => parseTaskItemsCsv(csv, { scenes }), (error: PasteImportError) => error instanceof PasteImportError && pattern.test(error.message), csv);
  bad("名称,场景ID,发布版ID\nA,,", /第 2 行没有场景/);
  bad("名称,场景ID,发布版ID\nA,不存在,version-a", /第 2 行.*不在当前已发布场景/);
  bad("名称,场景ID,发布版ID\nA,demo,", /第 2 行没有发布版本/);
  bad("名称,场景ID,发布版ID\nA,demo,version-b", /不是场景 “demo” 的当前发布版/);
  bad("名称,场景ID,发布版ID,宽 [width]\nA,demo,version-a,abc", /第 2 行.*宽 \[width\].*不是合法数字/);
  bad("名称,场景ID,发布版ID,宽 [width]\nA,demo,version-a,9999", /大于最大值 1600/);
  bad("名称,场景ID,发布版ID,数量 [number]\nA,demo,version-a,7", /只能是：1 \/ 2 \/ 4/);
  bad("名称,场景ID,发布版ID,开关 [flag]\nA,demo,version-a,也许", /布尔值请填 true\/false/);
  // 填了别的场景的列：明确说清原因，不当作未知列丢掉。
  bad("名称,场景ID,发布版ID,提示词 [text]\nA,demo,version-a,一只猫", /属于别的场景/);
  bad("名称,场景ID,发布版ID,不存在的列\nA,demo,version-a,1", /不是该场景的输入字段/);
  bad("", /CSV 是空的/);
  bad("名称,场景ID,发布版ID", /只有表头/);
});

test("CSV 导入：没有 key 的表头按字段名匹配，中文表头也能用", () => {
  const csv = ["名称,场景ID,发布版ID,语言,数量", "A,demo,version-a,中文,2"].join("\n");
  const items = parseTaskItemsCsv(csv, { scenes });
  assert.deepEqual(items[0].inputValues, { language: "中文", number: "2" });
});

test("导出已有任务项：多场景并集列，未填字段留空，可原样导回", () => {
  const csv = serializeTaskItemsCsv([
    { label: "A", sceneId: "demo", versionId: "version-a", inputValues: { language: "中文", width: 800, flag: true } },
    { label: "B", sceneId: "demo2", versionId: "version-b", inputValues: { text: "一只猫" } },
  ], scenes);
  const rows = parseCsv(csv);
  assert.equal(rows[0][1], "场景ID");
  assert.deepEqual(rows.slice(1).map(row => row[0]), ["A", "B"]);
  // 导出的内容必须能再导回来（往返一致）。
  const back = parseTaskItemsCsv(csv, { scenes });
  assert.deepEqual(back[0].inputValues, { language: "中文", width: 800, flag: true });
  assert.deepEqual(back[1].inputValues, { text: "一只猫" });
});

test("导出：逗号与中文不被破坏，媒体引用完整往返", () => {
  const ref = [{ assetId: "x,1", assetVersion: 1 }];
  const csv = serializeTaskItemsCsv([{ label: "含,逗号", sceneId: "demo", versionId: "version-a", inputValues: { product_images: ref, need: "两行\n文字" } }], [demo]);
  const back = parseTaskItemsCsv(csv, { scenes: [demo] });
  assert.equal(back[0].label, "含,逗号");
  assert.deepEqual(back[0].inputValues.product_images, ref);
  assert.equal(back[0].inputValues.need, "两行\n文字");
});

test("导出：布尔 false 与数字 0 不被当成空值丢掉", () => {
  // 用没有最小值限制的数字字段：width 的最小值是 1，填 0 本来就该报范围错。
  const counting: CsvSceneSpec = { sceneId: "demo3", versionId: "version-c", fields: [{ key: "offset", label: "偏移", type: "number", required: false }, { key: "flag", label: "开关", type: "boolean", required: false }] };
  const csv = serializeTaskItemsCsv([{ label: "A", sceneId: "demo3", versionId: "version-c", inputValues: { flag: false, offset: 0 } }], [counting]);
  const back = parseTaskItemsCsv(csv, { scenes: [counting] });
  assert.equal(back[0].inputValues.flag, false);
  assert.equal(back[0].inputValues.offset, 0);
});
