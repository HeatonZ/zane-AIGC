import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskTemplateCsv, csvRow, parseCsv, parseTaskItemsCsv, toCsvFieldSpec, type CsvSceneSpec } from "../../src/lib/taskCsv.js";
import { taskHarness } from "../testing/taskSupport.js";
import type { WorkflowInputField } from "../../src/types.js";

/**
 * 媒体列最重要的一条：素材库「复制 AI 固定版本引用」给的是裸对象
 * {assetId,assetVersion}，不是数组。用户会直接粘进 CSV，所以必须能穿过 CSV
 * 并被真实服务接受（服务端把它归一成 image_list 的一项）。
 */
async function addMediaInput(h: Awaited<ReturnType<typeof taskHarness>>) {
  await h.workspace.mutateScoped(current => {
    const versions = current.sceneVersions as Record<string, { versions: Array<Record<string, unknown>> }>;
    const workflow = versions.demo.versions[0].workflow as { inputs: WorkflowInputField[] };
    workflow.inputs = [...workflow.inputs, { key: "product_images", type: "image_list", required: true, label: "商品主图" } as WorkflowInputField];
    return { workspace: current, result: {}, changed: true };
  });
}

test("CSV 媒体列：素材库复制的裸引用对象能穿过 CSV 并被服务端接受", async t => {
  const h = await taskHarness(t);
  await addMediaInput(h);
  const version = await h.scenes.get("demo");
  const spec: CsvSceneSpec = { sceneId: "demo", versionId: version.versionId, fields: version.workflow.inputs.map(field => toCsvFieldSpec(field)) };

  // 1) 素材库里能真实解析的引用：用服务端已归档的固定版本引用。
  const reference = { assetId: "asset-csv-media", assetVersion: 1 };
  const copied = JSON.stringify(reference);

  const rows = parseCsv(buildTaskTemplateCsv({ scenes: [spec], sceneId: "demo", rowCount: 1 }));
  const at = rows[0].findIndex(cell => cell.endsWith("[product_images]"));
  assert.notEqual(at, -1, "模板必须有媒体列");
  rows[1][at] = copied;
  const flagAt = rows[0].findIndex(cell => cell.endsWith("[flag]"));
  rows[1][flagAt] = "true";

  // 2) 解析：媒体列的 JSON 必须还原成对象，且是数组（image_list 语义）。
  const items = parseTaskItemsCsv("\ufeff" + rows.map(csvRow).join("\r\n"), { scenes: [spec] });
  assert.deepEqual(items[0].inputValues.product_images, reference);

  // 3) 纯文本媒体值（没写 JSON）也接受：服务端按引用/路径语义处理，不在这里拦。
  const textRows = rows.map(row => [...row]);
  textRows[1][at] = "https://example.invalid/hero.png";
  const textItems = parseTaskItemsCsv("\ufeff" + textRows.map(csvRow).join("\r\n"), { scenes: [spec] });
  assert.equal(textItems[0].inputValues.product_images, "https://example.invalid/hero.png");

  // 4) 非法媒体 JSON 必须带行号报错，而不是静默变成字符串。
  const badRows = rows.map(row => [...row]);
  badRows[1][at] = "{不是JSON}";
  assert.throws(
    () => parseTaskItemsCsv("\ufeff" + badRows.map(csvRow).join("\r\n"), { scenes: [spec] }),
    (error: Error) => /第 2 行/.test(error.message) && /\[product_images\]/.test(error.message) && /合法 JSON/.test(error.message),
  );
});
