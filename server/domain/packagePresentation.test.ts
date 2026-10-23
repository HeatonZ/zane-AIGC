import assert from "node:assert/strict";
import test from "node:test";
import { validatePresentation } from "./packageContracts.js";

/**
 * 服务页面是发布快照的一部分：坏配置不能等到用户打开页面才暴露，
 * 也不能静默丢掉一块（页面少一块看不出来）。因此逐块校验、失败即拒绝。
 */
test("页面区块：已知类型按序保留，未知类型与重复表单在发布前拒绝", () => {
  const presentation = validatePresentation({
    theme: { accent: "#2f6b4f", accentSoft: "#e8f1ec", surface: "dark" },
    navLabel: "长文视频",
    page: [
      { type: "hero", eyebrow: "长文视频", headline: "把一篇小说变成成片", subline: "分镜、画面、配音一次跑完", showcase: [{ url: "/api/v1/x", caption: "示例" }], actions: [{ label: "开始", action: "form" }] },
      { type: "features", title: "包含什么", items: [{ title: "自动分镜", detail: "按原文切镜" }, { title: "逐镜出片", badge: "推荐" }] },
      { type: "steps", items: [{ title: "写分镜" }, { title: "出画面", detail: "逐镜生成" }] },
      { type: "gallery", columns: 3, items: [{ url: "/api/v1/a" }, { url: "/api/v1/b", caption: "第二张" }] },
      { type: "text", title: "说明", body: "一段正文" },
      { type: "form", submitLabel: "生成成片", note: "提交后按项结算" },
      { type: "faq", items: [{ question: "多久？", answer: "按镜头数" }] },
      { type: "cta", headline: "现在就试", label: "去生成", action: "results" },
    ],
    footer: { text: "由 Zane Studio 提供", links: [{ label: "帮助", href: "https://example.com/help" }] },
  });
  assert.equal(presentation?.theme?.surface, "dark");
  assert.equal(presentation?.navLabel, "长文视频");
  assert.deepEqual(presentation?.page?.map(block => block.type), ["hero", "features", "steps", "gallery", "text", "form", "faq", "cta"]);
  assert.equal(presentation?.footer?.links?.length, 1);

  assert.throws(() => validatePresentation({ page: [{ type: "carousel" }] }), /page\[0\]\.type/);
  assert.throws(() => validatePresentation({ page: [{ type: "form" }, { type: "form" }] }), /form 区块最多 1 个/);
  assert.throws(() => validatePresentation({ page: [{ type: "text" }] }), /body（必填）/);
  assert.throws(() => validatePresentation({ page: "hero" }), /page（需要数组）/);
  assert.throws(() => validatePresentation({ theme: { surface: "sepia" } }), /presentation\./);
});

test("省略 page 时保持旧呈现层形状：老包不需要补配置", () => {
  const presentation = validatePresentation({
    theme: { accent: "#2f6b4f" },
    hero: { headline: "旧包标题", showcase: [{ url: "/api/v1/a", caption: "图" }] },
    highlights: [{ title: "卖点" }],
    resultLabels: { cta: "开始生成" },
  });
  assert.equal(presentation?.page, undefined);
  assert.equal(presentation?.hero?.headline, "旧包标题");
  assert.equal(presentation?.resultLabels?.cta, "开始生成");
  // 未配置的字段不落库，避免发布快照里堆空对象。
  assert.deepEqual(Object.keys(presentation ?? {}).sort(), ["hero", "highlights", "resultLabels", "theme"]);
});

test("非法链接与超长文案被拒绝或截断，不让坏数据进快照", () => {
  const presentation = validatePresentation({
    footer: { text: "说明", links: [{ label: "坏链接", href: "javascript:alert(1)" }, { label: "好链接", href: "https://example.com" }] },
    page: [{ type: "features", items: [{ title: "卖点", detail: "x".repeat(500) }] }],
  });
  // javascript: 链接被丢弃，只留合法 http(s)。
  assert.deepEqual(presentation?.footer?.links, [{ label: "好链接", href: "https://example.com" }]);
  const feature = presentation?.page?.[0];
  assert.equal(feature?.type, "features");
  assert.equal((feature as { items: Array<{ detail?: string }> }).items[0].detail?.length, 240);
});

/**
 * 工作台布局：高频出图工具要「左调参、右出结果」，而不是营销页。
 * 它自带表单与结果，因此 page 里再配 form/results 会重复渲染两套，必须在发布前拒绝。
 */
test("工作台布局：接受 workspace 文案，拒绝重复表单与非法 layout", () => {
  const presentation = validatePresentation({
    layout: "workspace",
    theme: { accent: "#0f766e", accentSoft: "#e6fffb" },
    workspace: { title: "生图", subtitle: "写一句描述", resultTitle: "生成结果", emptyHint: "点生成后出现在这里", history: false },
    promptIdeas: [{ label: "产品图", value: "一只白色马克杯" }],
    presets: [{ label: "商业摄影", values: { prompt: "柔光棚拍" } }],
  });
  assert.equal(presentation?.layout, "workspace");
  assert.equal(presentation?.workspace?.title, "生图");
  assert.equal(presentation?.workspace?.history, false);
  // 灵感与预设两种布局共用，不能被吞掉。
  assert.equal(presentation?.promptIdeas?.length, 1);
  assert.equal(presentation?.presets?.length, 1);

  // 工作台自带表单与结果：重复配置会渲染两套，直接拒绝而不是静默忽略。
  assert.throws(() => validatePresentation({ layout: "workspace", page: [{ type: "form" }] }), /layout=workspace/);
  assert.throws(() => validatePresentation({ layout: "workspace", page: [{ type: "results" }] }), /layout=workspace/);
  // 其它区块（说明、示例图）仍可与工作台共存。
  assert.doesNotThrow(() => validatePresentation({ layout: "workspace", page: [{ type: "text", body: "使用说明" }] }));
  assert.throws(() => validatePresentation({ layout: "studio" }), /layout（page\|workspace）/);
  assert.throws(() => validatePresentation({ workspace: "big" }), /workspace（需要对象）/);
});

test("未声明 layout 的旧包保持 page 骨架：不会因为新增字段而变成工作台", () => {
  const presentation = validatePresentation({ hero: { headline: "旧包" }, page: [{ type: "form" }] });
  assert.equal(presentation?.layout, undefined);
  assert.equal(presentation?.page?.length, 1);
});
