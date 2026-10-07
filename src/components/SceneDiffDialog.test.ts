import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SceneDiffContent, changedLineRange } from "./SceneDiffDialog";
import type { SceneDiffPage, SceneDiffChange } from "../../server/domain/sceneDiffContracts";
const value = (text: string, present = true) => ({ present, text, format: "text" as const, totalChars: Array.from(text).length, offset: 0, nextOffset: null, complete: true });
const page = (changes: SceneDiffChange[] = []): SceneDiffPage => ({ sceneId: "demo", revision: "a".repeat(64), draftRevision: "b".repeat(64), contentHash: "1234abcd", baseline: { versionId: "current-not-last", version: "fixed123", publishedAt: "2026-10-01T00:00:00.000Z" }, comparisonBasis: "publication-ready", preparationWarnings: [], hasChanges: changes.length > 0, summary: { added: 0, removed: 0, changed: changes.length, reordered: 0 }, total: changes.length, valueBudgetChars: 65536, changes, hasMore: false, nextCursor: null, nextAction: changes.length ? "validate_scene_draft" : "get_scene" });

test("差异内容：固定当前发布版、分组、双列与精确改动行高亮；不提供发布/生成动作", () => {
  const data = page([{ changeId: "c".repeat(24), path: "/workflow/steps/writer/promptTemplate", section: "steps", objectId: "writer", objectLabel: "编剧", label: "提示词模板", kind: "changed", before: value("保持\n旧内容\n结尾"), after: value("保持\n新内容\n结尾") }]);
  const markup = renderToStaticMarkup(createElement(SceneDiffContent, { page: data, onInvalidated() { throw new Error("render must not invalidate"); } }));
  assert.match(markup, /当前发布 vfixed123/); assert.match(markup, /处理步骤/); assert.match(markup, /提示词模板/); assert.match(markup, /旧内容/); assert.match(markup, /新内容/);
  assert.equal((markup.match(/scene-diff-line highlighted/g) ?? []).length, 2);
  assert.ok(!markup.includes("发布更新")); assert.ok(!markup.includes("开始生成"));
  assert.deepEqual(changedLineRange("头\n旧\n尾", "头\n新\n尾"), { before: { start: 1, end: 2 }, after: { start: 1, end: 2 } });
});

test("无差异与首次发布/大值未读完/不存在/空串与警告都明确展示", () => {
  const render = (data: SceneDiffPage) => renderToStaticMarkup(createElement(SceneDiffContent, { page: data, onInvalidated() {} }));
  assert.match(render(page()), /草稿与当前发布版一致/);
  const data = page([{ changeId: "c".repeat(24), path: "/workflow/steps/new", section: "steps", objectId: "new", objectLabel: "新步骤", label: "整体配置", kind: "added", before: value("", false), after: { ...value("😀"), totalChars: 9000, complete: false, nextOffset: 1 } }]);
  data.baseline = null; data.preparationWarnings = [{ stepId: "new", message: "未安装能力" }];
  const markup = render(data); assert.match(markup, /尚未发布 · 空基线/); assert.match(markup, /不存在/); assert.match(markup, /内容未读完/); assert.match(markup, /9000/); assert.match(markup, /继续读取/); assert.match(markup, /未安装能力/);
  data.changes[0].after = value(""); assert.match(render(data), /空字符串/);
});
