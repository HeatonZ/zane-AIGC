import assert from "node:assert/strict";
import test from "node:test";

import { mergePackageCatalog, describeCodePackageStatus, executorSelectionError, packageRunsFilter, inputContractRows, inputOverridePayload } from "./packageCatalog.js";

test("mergePackageCatalog sorts code before config and sorts each group by title", () => {
  const merged = mergePackageCatalog(
    [
      { source: "config", id: "z", title: "Zeta" },
      { source: "config", id: "a", title: "Alpha" },
    ],
    [
      { source: "code", packageId: "c2", title: "Gamma", version: "1", status: "ok", directory: "/x", entryPath: "x.js", enabled: true },
      { source: "code", packageId: "c1", title: "Beta", version: "1", status: "ok", directory: "/y", entryPath: "y.js", enabled: true },
    ] as any,
  );
  assert.equal(merged[0].source, "code");
  assert.equal((merged[0] as any).title, "Beta");
  assert.equal((merged[1] as any).title, "Gamma");
  assert.equal(merged[2].source, "config");
  assert.equal((merged[2] as any).title, "Alpha");
  assert.equal(merged[3].title, "Zeta");
});

test("describeCodePackageStatus maps ok/error/disabled", () => {
  assert.equal(describeCodePackageStatus("ok", "x").label, "正常");
  assert.equal(describeCodePackageStatus("error", "Unexpected end of input").label, "失败");
  assert.equal(describeCodePackageStatus("error", "Unexpected end of input").detail, "Unexpected end of input");
  assert.equal(describeCodePackageStatus("disabled").label, "已禁用");
});

test("executorSelectionError requires scene and published version", () => {
  assert.equal(executorSelectionError("", "v1"), "请选择执行场景");
  assert.equal(executorSelectionError("scene-a", ""), "请选择该场景的已发布版本");
  assert.equal(executorSelectionError("scene-a", "v1"), "");
});

test("packageRunsFilter returns sceneId only for code rows with executor", () => {
  assert.deepEqual(
    packageRunsFilter({ source: "code", packageId: "p", title: "P", version: "1", status: "ok", directory: "", entryPath: "", enabled: true, executor: { sceneId: "scene-a", versionId: "v1" } } as any),
    { sceneId: "scene-a" },
  );
  assert.equal(packageRunsFilter({ source: "config", id: "c", title: "C", revision: 1 } as any), null);
  assert.equal(packageRunsFilter({ source: "code", packageId: "p", title: "P", version: "1", status: "ok", directory: "", entryPath: "", enabled: true, executor: null } as any), null);
});

test("inputContractRows merges label/required/defaultValue by key", () => {
  const rows = inputContractRows(
    [{ key: "topic", label: "旧", required: false }],
    [{ key: "topic", label: "新主题", required: true, defaultValue: "d" }],
  );
  assert.equal(rows[0].label, "新主题");
  assert.equal(rows[0].required, true);
  assert.equal(rows[0].defaultValue, "d");
});

test("inputContractRows keeps package.json fields when overrides are empty", () => {
  const rows = inputContractRows([{ key: "content", label: "剧情", required: true }], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "剧情");
  assert.equal(rows[0].required, true);
});

test("inputOverridePayload only sends fields that differ from package.json", () => {
  const manifest = [{ key: "content", label: "剧情", required: true }];
  // 管理员没改任何东西：不应产生覆盖，磁盘改标签后仍然生效。
  assert.deepEqual(inputOverridePayload([{ key: "content", label: "剧情", required: true }], manifest), []);
  // 改了标签与默认值：只送改过的字段。
  assert.deepEqual(
    inputOverridePayload([{ key: "content", label: "故事", required: true, defaultValue: "默认剧情" }], manifest),
    [{ key: "content", label: "故事", defaultValue: "默认剧情" }],
  );
  // 把必填从 true 改成 false 也要落库（false 是有意义的覆盖）。
  assert.deepEqual(
    inputOverridePayload([{ key: "content", label: "剧情", required: false }], manifest),
    [{ key: "content", required: false }],
  );
});
