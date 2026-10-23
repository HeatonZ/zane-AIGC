import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { stateSummaryNode } from "./ServiceStateSummary";

const config = { title: "这一集已出的段", format: "list" as const };

const render = (node: ReturnType<typeof stateSummaryNode>) => node === undefined
  ? ""
  : renderToStaticMarkup(createElement("div", null, node));

/**
 * 「这一集已出了哪几段」是包写进 framework.store 的工程账。页面只在真读到账时显示，
 * 读不到就整块不出现——空标题或假的进度比不显示更误导。
 */
test("有账时按 list 形态渲染段号与集名，并说明全局设定是否已存", () => {
  const html = render(stateSummaryNode(config, {
    activeEpisodeLabel: "我家猫有点大 #1",
    segments: ["s01", "s02"],
    bibleReady: true,
    mergedAt: "2026-10-23T10:00:00.000Z",
  }));
  assert.match(html, /这一集已出的段/);
  assert.match(html, /sws-state-list/);
  assert.match(html, /s01/);
  assert.match(html, /s02/);
  assert.match(html, /我家猫有点大 #1/);
  assert.match(html, /本集全局设定已存/);
  assert.match(html, /已出 2 段/);
  assert.match(html, /整集最近一次重拼/);
  // 段号必须按账里的顺序出现，不能排序或去重打乱进度。
  assert.ok(html.indexOf("s01") < html.indexOf("s02"));
});

test("text 形态把段号连成一句；一段都没有时说清「还没出过」，不留空列表", () => {
  const text = render(stateSummaryNode({ format: "text" }, { segments: ["s01", "s03"] }));
  assert.match(text, /s01、s03/);
  assert.doesNotMatch(text, /sws-state-list/);
  const none = render(stateSummaryNode(config, { segments: [] }));
  assert.match(none, /这一集还没有出过段/);
  assert.doesNotMatch(none, /sws-state-list/);
});

test("无账、请求失败、或账不是对象时整块不出现", () => {
  for (const value of [undefined, null, [], "s01,s02", 42]) {
    assert.equal(stateSummaryNode(config, value), undefined, JSON.stringify(value) + " 不应渲染摘要");
  }
  // 包没声明 stateSummary：即使有账也不渲染（不知道该怎么展示就不猜）。
  assert.equal(stateSummaryNode(undefined, { segments: ["s01"] }), undefined);
});
