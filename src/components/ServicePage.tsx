import { useEffect, useRef, useState, type ReactNode } from "react";
import { useProtectedMedia } from "../lib/mediaPreview";
import { formatPoints } from "../../server/domain/creditUnits.js";
import type { PackagePageBlock, PackagePresentation } from "../../server/domain/packageContracts.js";

/** 发布快照里的呈现层就是页面定义：前端只认这一份形状，不在组件里另建一套。 */
export type ServicePresentation = PackagePresentation;
export type { PackagePageBlock };

/** 页面上的行动锚点：跳到表单或结果区，不触发提交。 */
export type ServicePageAction = "form" | "results";

/** 一张受保护的示例图：进入视口才取字节，失败可重试。 */
export function PageShot({ url, caption, kind = "image" }: { url: string; caption?: string; kind?: "image" | "video" }) {
  const media = useProtectedMedia(url, kind);
  return <figure className="spage-shot" ref={node => media.holder(node)}>
    {media.error
      ? <button type="button" className="spage-shot-fallback" onClick={media.retry}>{media.error}</button>
      : kind === "video"
        ? <video src={media.source || undefined} controls playsInline preload="metadata" />
        : <img src={media.source || undefined} alt={caption ?? "示例"} loading="lazy" />}
    {caption && <figcaption>{caption}</figcaption>}
  </figure>;
}

function BlockHeading({ title, subtitle, center }: { title?: string; subtitle?: string; center?: boolean }) {
  if (!title && !subtitle) return null;
  return <header className={`spage-heading${center ? " is-center" : ""}`}>
    {title && <h2>{title}</h2>}
    {subtitle && <p>{subtitle}</p>}
  </header>;
}

/**
 * 服务页面：按发布快照里的 page 区块顺序渲染。
 * 每个包可以有完全不同的页面结构，但都只用这一套基础组件；
 * 没有配置 page 的旧包按 hero + 卖点 + 表单 + 结果合成默认页，不会变成空白。
 */
export function ServicePage({ presentation, title, summary, form, results, activeAction, onAction, onBack, formRef, resultsRef }: {
  presentation?: ServicePresentation;
  title: string;
  summary?: string;
  /** form 区块的内容（真实表单）。 */
  form?: ReactNode;
  /** results 区块的内容（最近一次产出的画廊）。 */
  results?: ReactNode;
  activeAction?: ServicePageAction;
  onAction?: (action: ServicePageAction) => void;
  /** 返回目录：有值时在页面左上角显示返回入口。 */
  onBack?: () => void;
  formRef?: React.RefObject<HTMLElement | null>;
  resultsRef?: React.RefObject<HTMLElement | null>;
}) {
  const blocks = presentation?.page?.length ? presentation.page : defaultBlocks(presentation);
  const rendered = blocks.map((block, index) => {
    switch (block.type) {
      case "hero":
        return <HeroBlock key={index} block={block} title={title} summary={summary} onAction={onAction} />;
      case "features":
        return <section key={index} className="spage-block spage-features" aria-label={block.title ?? "服务特点"}>
          <BlockHeading title={block.title} subtitle={block.subtitle} center />
          <ul>{block.items.map(item => <li key={item.title}>
            {item.badge && <span className="spage-badge">{item.badge}</span>}
            <strong>{item.title}</strong>
            {item.detail && <p>{item.detail}</p>}
          </li>)}</ul>
        </section>;
      case "gallery":
        return <section key={index} className="spage-block spage-gallery" data-columns={block.columns ?? 3} aria-label={block.title ?? "作品示例"}>
          <BlockHeading title={block.title} subtitle={block.subtitle} center />
          <div className="spage-gallery-grid">{block.items.map((item, itemIndex) => <PageShot key={item.url + itemIndex} url={item.url} caption={item.caption} />)}</div>
        </section>;
      case "steps":
        return <section key={index} className="spage-block spage-steps" aria-label={block.title ?? "使用流程"}>
          <BlockHeading title={block.title} subtitle={block.subtitle} center />
          <ol>{block.items.map((item, itemIndex) => <li key={item.title}>
            <span className="spage-step-index" aria-hidden="true">{String(itemIndex + 1).padStart(2, "0")}</span>
            <div><strong>{item.title}</strong>{item.detail && <p>{item.detail}</p>}</div>
          </li>)}</ol>
        </section>;
      case "text":
        return <section key={index} className={`spage-block spage-text${block.align === "center" ? " is-center" : ""}`} aria-label={block.title ?? "说明"}>
          <BlockHeading title={block.title} subtitle={block.subtitle} center={block.align === "center"} />
          <div className="spage-prose">{block.body.split(/\n{2,}/).map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}</div>
        </section>;
      case "form":
        return <section key={index} className={`spage-block spage-form-block${activeAction === "form" ? " is-active" : ""}`} ref={formRef} aria-label={block.title ?? "开始创作"}>
          <BlockHeading title={block.title ?? "开始创作"} subtitle={block.subtitle} center />
          {form}
          {block.note && <p className="spage-note">{block.note}</p>}
        </section>;
      case "results":
        return <section key={index} className={`spage-block spage-results-block${activeAction === "results" ? " is-active" : ""}`} ref={resultsRef} aria-label={block.title ?? "最近产出"}>
          <BlockHeading title={block.title ?? presentation?.resultLabels?.sectionTitle ?? "最近产出"} subtitle={block.subtitle} center />
          {results ?? <div className="spage-empty">{block.emptyHint ?? presentation?.resultLabels?.emptyHint ?? "还没有产出，先在上面开始一次。"}</div>}
        </section>;
      case "faq":
        return <section key={index} className="spage-block spage-faq" aria-label={block.title ?? "常见问题"}>
          <BlockHeading title={block.title ?? "常见问题"} subtitle={block.subtitle} center />
          <div className="spage-faq-list">{block.items.map(item => <details key={item.question}>
            <summary>{item.question}</summary>
            <p>{item.answer}</p>
          </details>)}</div>
        </section>;
      case "cta":
        return <section key={index} className="spage-block spage-cta" aria-label={block.headline}>
          <div className="spage-cta-inner">
            <h2>{block.headline}</h2>
            {block.subline && <p>{block.subline}</p>}
            <button type="button" className="spage-cta-button" onClick={() => onAction?.(block.action ?? "form")}>{block.label ?? "开始生成"}</button>
          </div>
        </section>;
    }
  });
  return <div className="spage" data-surface={presentation?.theme?.surface ?? "light"}>
    {onBack && <button type="button" className="spage-back" onClick={onBack} aria-label="返回全部服务">← 全部服务</button>}
    {rendered}
  </div>;
}

/** 旧包兼容：没有 page 时用原有 hero/highlights 合成一页，行为与改造前一致。 */
function defaultBlocks(presentation?: ServicePresentation): PackagePageBlock[] {
  const blocks: PackagePageBlock[] = [];
  const hero = presentation?.hero;
  blocks.push({
    type: "hero",
    ...(hero?.eyebrow ? { eyebrow: hero.eyebrow } : {}),
    ...(hero?.headline ? { headline: hero.headline } : {}),
    ...(hero?.subline ? { subline: hero.subline } : {}),
    ...(hero?.showcase?.length ? { showcase: hero.showcase } : {}),
    actions: [{ label: presentation?.resultLabels?.cta ?? "开始创作", action: "form" }],
  });
  if (presentation?.highlights?.length) blocks.push({ type: "features", items: presentation.highlights });
  blocks.push({ type: "form", title: "开始创作" });
  blocks.push({ type: "results" });
  return blocks;
}

function HeroBlock({ block, title, summary, onAction }: {
  block: Extract<PackagePageBlock, { type: "hero" }>;
  title: string; summary?: string; onAction?: (action: ServicePageAction) => void;
}) {
  const showcase = block.showcase ?? [];
  const actions = block.actions ?? [{ label: "开始创作", action: "form" as const }];
  return <section className={`spage-hero${showcase.length ? "" : " is-plain"}${block.align === "center" ? " is-center" : ""}`}>
    <div className="spage-hero-copy">
      {block.eyebrow && <span className="spage-eyebrow">{block.eyebrow}</span>}
      <h1>{block.headline ?? title}</h1>
      <p>{block.subline ?? summary ?? ""}</p>
      <div className="spage-hero-actions">{actions.map(item => <button key={item.label} type="button" className="spage-hero-button" onClick={() => onAction?.(item.action)}>{item.label}</button>)}</div>
    </div>
    {showcase.length > 0 && <div className="spage-hero-showcase" data-count={Math.min(showcase.length, 4)}>
      {showcase.slice(0, 4).map((item, index) => <PageShot key={item.url + index} url={item.url} caption={item.caption} />)}
    </div>}
  </section>;
}

/**
 * 首屏服务卡：用发布快照里的封面/示例图做视觉主体。
 * 没有图时退化为品牌色块 + 首字，不留空白框。
 */
export function ServiceCard({ title, summary, accent, cover, itemCount, onOpen, disabled }: {
  title: string; summary?: string; accent?: string; cover?: string; itemCount?: number; onOpen: () => void; disabled?: boolean;
}) {
  return <button type="button" className="scard" disabled={disabled} onClick={onOpen}
    style={accent ? { "--svc-accent": accent } as React.CSSProperties : undefined}>
    <span className="scard-art">
      {cover ? <PageShot url={cover} /> : <span className="scard-glyph" aria-hidden="true">{title.slice(0, 1)}</span>}
    </span>
    <span className="scard-body">
      <strong>{title}</strong>
      {summary && <span className="scard-summary">{summary}</span>}
      <span className="scard-foot">{itemCount ? `${itemCount} 个步骤` : "开始"}<span className="scard-arrow" aria-hidden="true">→</span></span>
    </span>
  </button>;
}

/** 服务页的主题变量：整页配色由发布快照决定，容器只需带上这两个变量。 */
export function serviceThemeStyle(presentation?: ServicePresentation): React.CSSProperties | undefined {
  const theme = presentation?.theme;
  if (!theme?.accent && !theme?.accentSoft && !theme?.heroFrom && !theme?.heroTo) return undefined;
  return {
    ...(theme?.accent ? { "--svc-accent": theme.accent } as Record<string, string> : {}),
    ...(theme?.accentSoft ? { "--svc-accent-soft": theme.accentSoft } as Record<string, string> : {}),
    ...(theme?.heroFrom ? { "--svc-hero-from": theme.heroFrom } as Record<string, string> : {}),
    ...(theme?.heroTo ? { "--svc-hero-to": theme.heroTo } as Record<string, string> : {}),
  } as React.CSSProperties;
}

/** 页面内锚点：区块进入视口后给一个短高亮，让用户知道点到了哪里。 */
export function useBlockAnchor(active?: ServicePageAction) {
  const formRef = useRef<HTMLElement | null>(null);
  const resultsRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const target = active === "form" ? formRef.current : resultsRef.current;
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [active]);
  return { formRef, resultsRef };
}

/** 顶部滚动时的浮起状态：客户端顶栏在滚动后加阴影，避免一直"贴"在内容上。 */
export function useScrolled(threshold = 8) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return scrolled;
}

/** 提示词灵感 + 风格预设：点一下就填进表单，降低空白页焦虑。 */
export function ServiceQuickStarts({ presentation, onApplyPrompt, onApplyPreset }: {
  presentation?: ServicePresentation;
  onApplyPrompt: (value: string, inputKey?: string) => void;
  onApplyPreset: (values: Record<string, unknown>) => void;
}) {
  const ideas = presentation?.promptIdeas ?? [];
  const presets = presentation?.presets ?? [];
  if (!ideas.length && !presets.length) return null;
  return <div className="spage-quickstarts">
    {presets.length > 0 && <div className="spage-quickstart-group">
      <span className="spage-quickstart-label">风格</span>
      <div className="spage-chips">{presets.map(preset => <button type="button" className="spage-chip" key={preset.label} title={preset.description} onClick={() => onApplyPreset(preset.values)}>{preset.label}</button>)}</div>
    </div>}
    {ideas.length > 0 && <div className="spage-quickstart-group">
      <span className="spage-quickstart-label">试试这些</span>
      <div className="spage-chips">{ideas.map(idea => <button type="button" className="spage-chip spage-chip-idea" key={idea.label} onClick={() => onApplyPrompt(idea.value, idea.inputKey)}>{idea.label}</button>)}</div>
    </div>}
  </div>;
}

/** 提交栏：价格、余额与主行动按钮，放在表单最后一步。 */
export function ServiceActionBar({ cost, available, busy, cta, onSubmit }: {
  cost: number | null; available: number | undefined; busy: boolean; cta?: string; onSubmit: () => void;
}) {
  // 积分余额只在最顶部导航栏显示一处：这里再写一遍「可用 X 积分」会和顶栏重复。
  // 余额是不是够，由提交时的服务端校验负责；这里只说明计费方式。
  const short = available !== undefined && cost !== null && available < cost;
  return <div className="zclient-actionbar">
    <div className="zclient-price">
      <strong>{cost === null ? "…" : formatPoints(cost)}</strong>
      <span>积分 / 次</span>
    </div>
    <div className="zclient-actionbar-meta">
      {short ? "余额不足，请先充值或兑换" : "按实际生成量计费 · 未消耗自动退回"}
    </div>
    <button type="button" className="zclient-cta" disabled={busy} onClick={onSubmit}>{busy ? "提交中…" : cta ?? "开始生成"}</button>
  </div>;
}
