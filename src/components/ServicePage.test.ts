import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServicePage, ServiceActionBar } from "../components/ServicePage";
import { ServiceWorkspace } from "../components/ServiceWorkspace";
import { validatePresentation } from "../../server/domain/packageContracts.js";

/**
 * 每个服务包可以有自己的页面，但页面只能由基础组件拼出来。
 * 这组测试锁住两件事：区块真的按配置渲染；没配置的旧包仍然能渲染出完整页面。
 */
test("服务页按发布快照的区块顺序渲染，每块内容都来自配置", () => {
  const presentation = validatePresentation({
    theme: { accent: "#2f6b4f", heroFrom: "#24543d", heroTo: "#10201a" },
    page: [
      { type: "hero", eyebrow: "长文视频", headline: "把一篇小说变成成片", subline: "分镜、画面、配音一次跑完", actions: [{ label: "开始创作", action: "form" }] },
      { type: "features", title: "包含什么", items: [{ title: "自动分镜", detail: "按原文切镜" }] },
      { type: "steps", title: "怎么用", items: [{ title: "写分镜" }, { title: "出画面" }] },
      { type: "text", title: "说明", body: "第一段\n\n第二段" },
      { type: "form", title: "开始创作", note: "按项结算" },
      { type: "faq", title: "常见问题", items: [{ question: "多久？", answer: "按镜头数" }] },
      { type: "cta", headline: "现在就试", label: "去生成", action: "form" },
    ],
  });
  const html = renderToStaticMarkup(createElement(ServicePage, {
    presentation, title: "长文视频", summary: "默认摘要", form: createElement("div", null, "FORM-CONTENT"),
  }));
  const order = ["spage-hero", "spage-features", "spage-steps", "spage-text", "spage-form-block", "spage-faq", "spage-cta"];
  const positions = order.map(name => html.indexOf(name));
  assert.ok(positions.every(position => position >= 0), "每个区块都要渲染：" + JSON.stringify(positions));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "区块必须按配置顺序出现");
  assert.match(html, /把一篇小说变成成片/);
  assert.match(html, /自动分镜/);
  assert.match(html, /写分镜/);
  assert.match(html, /第二段/);
  assert.match(html, /FORM-CONTENT/);
  assert.match(html, /按镜头数/);
  assert.match(html, /现在就试/);
  // 表单只渲染一次：重复的表单会让用户不知道哪个按钮才是提交。
  assert.equal((html.match(/FORM-CONTENT/g) ?? []).length, 1);
});

test("没配置 page 的旧包按 hero + 卖点 + 表单 + 结果合成完整页面，不出现空白页", () => {
  const presentation = validatePresentation({
    hero: { headline: "旧包标题", showcase: [] },
    highlights: [{ title: "卖点一", detail: "说明" }],
  });
  const html = renderToStaticMarkup(createElement(ServicePage, {
    presentation, title: "旧包标题", form: createElement("div", null, "FORM-CONTENT"),
  }));
  assert.match(html, /spage-hero/);
  assert.match(html, /旧包标题/);
  assert.match(html, /卖点一/);
  assert.match(html, /spage-form-block/);
  assert.match(html, /FORM-CONTENT/);
  assert.match(html, /spage-results-block/);
});

test("客户端外壳是顶部导航的全幅页面，不是后台侧栏", async () => {
  const [portal, clientCss, pageCss] = await Promise.all([
    "src/features/UserPortal.tsx", "src/styles/client.css", "src/styles/service-page.css",
  ].map(path => readFile(path, "utf8")));
  // 客户端顶栏 + 全幅服务页；不再出现管理端式侧栏骨架。
  assert.match(portal, /className="zclient"/);
  assert.match(portal, /zclient-topbar/);
  assert.match(portal, /zclient-shell is-wide/);
  assert.doesNotMatch(portal, /studio-nav|studio-main/);
  // 服务页渲染器只消费发布快照里的 page 区块。
  assert.match(portal, /ServicePage/);
  assert.match(pageCss, /\.spage-block/);
  assert.match(clientCss, /\.zclient-topbar/);
});

test("工作台布局：左控制栏与右结果画布同屏，提交按钮不在营销页里", () => {
  const presentation = validatePresentation({
    layout: "workspace",
    workspace: { title: "生图", subtitle: "写一句描述", resultTitle: "生成结果", emptyHint: "点生成后出现在这里", history: false },
  });
  const html = renderToStaticMarkup(createElement(ServiceWorkspace, {
    presentation,
    title: "生图",
    summary: "默认说明",
    form: createElement("div", null, "FIELDS"),
    result: createElement("div", null, "RESULT-AREA"),
    history: createElement("div", null, "HISTORY"),
    cost: 0.1,
    onSubmit: () => {},
  }));
  assert.match(html, /sws-controls/);
  assert.match(html, /sws-canvas/);
  assert.match(html, /FIELDS/);
  assert.match(html, /RESULT-AREA/);
  // 工作台标题与结果区标题来自 workspace 配置。
  assert.match(html, /生图/);
  assert.match(html, /生成结果/);
  // history:false 时不渲染历史条。
  assert.doesNotMatch(html, /HISTORY/);
  assert.doesNotMatch(html, /spage-hero/);
  // 积分只在最顶部导航栏出现一处：工作台内不得再重复显示余额。
  assert.doesNotMatch(html, /可用/);
  assert.doesNotMatch(html, /sws-credit/);
});

test("服务页底部操作栏不再重复显示余额，只在余额不足时提示", () => {
  const rich = renderToStaticMarkup(createElement(ServiceActionBar, {
    cost: 0.1, available: 98.9, busy: false, onSubmit: () => {},
  }));
  assert.doesNotMatch(rich, /可用/);
  assert.match(rich, /未消耗自动退回/);

  const poor = renderToStaticMarkup(createElement(ServiceActionBar, {
    cost: 0.1, available: 0.05, busy: false, onSubmit: () => {},
  }));
  assert.match(poor, /余额不足/);
});

test("工作台默认显示历史条；配置隐藏时才不渲染", () => {
  const shown = renderToStaticMarkup(createElement(ServiceWorkspace, {
    presentation: validatePresentation({ layout: "workspace", workspace: { title: "生图" } }),
    title: "生图", form: createElement("div"), result: createElement("div"), history: createElement("div", null, "HISTORY"),
    onSubmit: () => {},
  }));
  assert.match(shown, /HISTORY/);
  assert.match(shown, /sws-history/);
});
