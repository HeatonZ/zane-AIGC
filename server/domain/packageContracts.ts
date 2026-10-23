import * as z from "zod/v4";
import { HttpError } from "../errors.js";
import { hasAtMostTwoDecimals } from "./creditUnits.js";
import { asRecord } from "./workflowValues.js";
import type { JsonValue, RunInputField, RunWorkflowDefinition } from "./types.js";

/** 包内一项引用前序产出的方式：取全部、取第 N 个、或按前序项逐项配对（for_each）。 */
export const packageSelection = z.object({
  mode: z.enum(["all", "item", "for_each"]),
  index: z.int().min(0).max(1000).optional().describe("selection=item 时的序号，从0开始"),
}).strict();

/** 包级输入如何流向组件：直接引用包输入、用固定值、或用前序项的产出。 */
export const packageBinding = z.object({
  key: z.string().min(1).max(200).describe("组件场景已声明的输入键"),
  valueSource: z.enum(["input", "literal", "previous"]),
  sourceRef: z.string().max(400).optional().describe("input.<键> 或 <前序项ID>.<输出键>"),
  literalValue: z.string().max(100_000).optional().describe("valueSource=literal 的固定值"),
  selection: packageSelection.optional().describe("前序产出取值方式，省略=all"),
}).strict().superRefine((binding, context) => {
  if (binding.valueSource === "previous" && !binding.sourceRef) context.addIssue({ code: "custom", path: ["sourceRef"], message: "引用前序产出时必须给出 sourceRef（<项ID>.<输出键>）" });
  if (binding.valueSource === "literal" && binding.literalValue === undefined) context.addIssue({ code: "custom", path: ["literalValue"], message: "固定值必须给出 literalValue" });
  if (binding.valueSource === "input" && !binding.sourceRef) context.addIssue({ code: "custom", path: ["sourceRef"], message: "引用包输入时必须给出 sourceRef（input.<键>）" });
});

export const packageItem = z.object({
  id: z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).describe("包内稳定项ID，供 sourceRef 引用"),
  name: z.string().min(1).max(200),
  sceneId: z.string().min(1).max(200),
  versionId: z.string().min(1).max(200).describe("固定发布版本ID；发布时内嵌快照，之后改版不影响包"),
  inputs: z.array(packageBinding).max(200).default([]),
  confirmAfter: z.boolean().optional().describe("完成后暂停等人工确认"),
}).strict();

/**
 * 服务的呈现层：决定用户打开这个服务时看到什么。
 * 在 MCP 里只保留为 JSON 对象（避免把整套展示字段塞进每次会话都下发的 tools/list），
 * 真正的形状校验在发布时由 validatePresentation 完成。
 */
export const packagePresentation = z.record(z.string(), z.unknown());

export interface PackagePresentationTheme {
  accent?: string; accentSoft?: string; heroFrom?: string; heroTo?: string; dark?: boolean;
  /** 整页底色：light=暖白（默认），dark=深色画布（媒体在深底上更亮）。 */
  surface?: "light" | "dark";
}
export type PackagePageAction = "form" | "results";

/**
 * 服务页面区块：用户打开一个包时看到的就是这些基础组件的有序组合。
 * 每个包可以有完全不同的页面，但只用这一套组件；未知 type 在发布时被拒绝，
 * 避免拼错字段后页面静默少一块。
 */
export type PackagePageBlock =
  | { type: "hero"; eyebrow?: string; headline?: string; subline?: string; align?: "left" | "center"; showcase?: Array<{ url: string; caption?: string }>; actions?: Array<{ label: string; action: PackagePageAction }> }
  | { type: "features"; title?: string; subtitle?: string; items: Array<{ title: string; detail?: string; badge?: string }> }
  | { type: "gallery"; title?: string; subtitle?: string; columns?: 2 | 3 | 4; items: Array<{ url: string; caption?: string }> }
  | { type: "steps"; title?: string; subtitle?: string; items: Array<{ title: string; detail?: string }> }
  | { type: "text"; title?: string; subtitle?: string; body: string; align?: "left" | "center" }
  | { type: "form"; title?: string; subtitle?: string; submitLabel?: string; note?: string }
  | { type: "results"; title?: string; subtitle?: string; emptyHint?: string }
  | { type: "faq"; title?: string; subtitle?: string; items: Array<{ question: string; answer: string }> }
  | { type: "cta"; headline: string; subline?: string; label?: string; action?: PackagePageAction };

export interface PackagePresentation {
  theme?: PackagePresentationTheme;
  hero?: { eyebrow?: string; headline?: string; subline?: string; showcase?: Array<{ url: string; caption?: string }> };
  highlights?: Array<{ title: string; detail?: string }>;
  promptIdeas?: Array<{ label: string; value: string; inputKey?: string }>;
  presets?: Array<{ label: string; description?: string; values: Record<string, unknown> }>;
  resultLabels?: { sectionTitle?: string; emptyHint?: string; cta?: string };
  /**
   * 页面结构：page=营销/介绍型整页（区块顺序自定，默认）；workspace=工具型工作台
   * （左侧控制栏 + 右侧结果画布，结果常驻不滚走）。高频反复使用的出图/改图类服务用 workspace。
   */
  layout?: "page" | "workspace";
  /** layout=workspace 时的文案与历史条配置；其余字段（主题、灵感、预设、表单）照常复用。 */
  workspace?: {
    title?: string;
    subtitle?: string;
    /** 结果区标题与空态文案。 */
    resultTitle?: string;
    emptyHint?: string;
    /** 底部最近几次产出的缩略条；省略=显示，false=隐藏。 */
    history?: boolean;
    /**
     * 结果区上方的只读工程状态摘要。包把 framework.store 里的工程账投影成一段文本或列表，
     * 由用户面 `GET /api/v1/self/packages/{packageId}/state` 读取后渲染；读不到就整块不渲染。
     * stateKey 选定包里的哪条工程账，省略时取该包最近更新的那条。
     */
    stateSummary?: { title?: string; format?: "list" | "text"; stateKey?: string };
  };
  /** 页面区块（有序）。省略时由 hero/highlights 自动合成默认页，旧包无需改配置。 */
  page?: PackagePageBlock[];
  /** 顶部导航里这个服务的短名（默认取 title）。 */
  navLabel?: string;
  /** 页脚：一段说明 + 可选链接。 */
  footer?: { text?: string; links?: Array<{ label: string; href: string }> };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const PAGE_BLOCKS = ["hero", "features", "gallery", "steps", "text", "form", "results", "faq", "cta"] as const;

/** 发布前的呈现层校验：形状、长度与配色格式，避免坏配置把用户页搞崩。 */
export function validatePresentation(raw: unknown): PackagePresentation | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = asRecord(raw);
  if (!value) throw new HttpError(400, "presentation 必须是对象", "INVALID_PACKAGE_PRESENTATION");
  const invalid = (label: string): never => { throw new HttpError(400, "presentation." + label + " 无效", "INVALID_PACKAGE_PRESENTATION"); };
  const text = (field: unknown, max: number, label: string) => {
    if (field === undefined) return undefined;
    if (typeof field !== "string" || field.length > max) invalid(label);
    return field as string;
  };
  const hex = (field: unknown, label: string) => {
    if (field === undefined) return undefined;
    if (typeof field !== "string" || !HEX.test(field)) invalid(label + "（需要 #RRGGBB）");
    return field as string;
  };
  const themeRaw = asRecord(value.theme);
  // surface 与配色一样属于整页外观：写了非法值就拒绝，不静默退回浅色。
  if (themeRaw?.surface !== undefined && themeRaw.surface !== "light" && themeRaw.surface !== "dark") invalid("theme.surface（light|dark）");
  const theme = themeRaw ? {
    ...(hex(themeRaw.accent, "theme.accent") ? { accent: hex(themeRaw.accent, "theme.accent")! } : {}),
    ...(hex(themeRaw.accentSoft, "theme.accentSoft") ? { accentSoft: hex(themeRaw.accentSoft, "theme.accentSoft")! } : {}),
    ...(hex(themeRaw.heroFrom, "theme.heroFrom") ? { heroFrom: hex(themeRaw.heroFrom, "theme.heroFrom")! } : {}),
    ...(hex(themeRaw.heroTo, "theme.heroTo") ? { heroTo: hex(themeRaw.heroTo, "theme.heroTo")! } : {}),
    ...(typeof themeRaw.dark === "boolean" ? { dark: themeRaw.dark } : {}),
    ...(themeRaw.surface === "light" || themeRaw.surface === "dark" ? { surface: themeRaw.surface as "light" | "dark" } : {}),
  } : undefined;

  const heroRaw = asRecord(value.hero);
  const showcase = Array.isArray(heroRaw?.showcase) ? heroRaw.showcase.slice(0, 8).flatMap(item => {
    const entry = asRecord(item);
    if (!entry || typeof entry.url !== "string" || entry.url.length > 2000) return [];
    return [{ url: entry.url, ...(typeof entry.caption === "string" ? { caption: entry.caption.slice(0, 80) } : {}) }];
  }) : undefined;
  const hero = heroRaw ? {
    ...(text(heroRaw.eyebrow, 60, "hero.eyebrow") ? { eyebrow: text(heroRaw.eyebrow, 60, "hero.eyebrow")! } : {}),
    ...(text(heroRaw.headline, 120, "hero.headline") ? { headline: text(heroRaw.headline, 120, "hero.headline")! } : {}),
    ...(text(heroRaw.subline, 300, "hero.subline") ? { subline: text(heroRaw.subline, 300, "hero.subline")! } : {}),
    ...(showcase?.length ? { showcase } : {}),
  } : undefined;

  const mapList = <T>(field: unknown, limit: number, map: (item: Record<string, unknown>) => T | undefined) =>
    Array.isArray(field) ? field.slice(0, limit).flatMap(rawItem => { const item = asRecord(rawItem); const mapped = item ? map(item) : undefined; return mapped === undefined ? [] : [mapped]; }) : undefined;

  const highlights = mapList(value.highlights, 6, item => typeof item.title === "string" && item.title.length <= 40
    ? { title: item.title, ...(typeof item.detail === "string" ? { detail: item.detail.slice(0, 160) } : {}) } : undefined);
  const promptIdeas = mapList(value.promptIdeas, 12, item => typeof item.label === "string" && item.label.length <= 40 && typeof item.value === "string" && item.value.length <= 2000
    ? { label: item.label, value: item.value, ...(typeof item.inputKey === "string" ? { inputKey: item.inputKey.slice(0, 200) } : {}) } : undefined);
  const presets = mapList(value.presets, 12, item => typeof item.label === "string" && item.label.length <= 40 && asRecord(item.values)
    ? { label: item.label, ...(typeof item.description === "string" ? { description: item.description.slice(0, 120) } : {}), values: asRecord(item.values)! as Record<string, unknown> } : undefined);
  const resultRaw = asRecord(value.resultLabels);
  const resultLabels = resultRaw ? {
    ...(text(resultRaw.sectionTitle, 40, "resultLabels.sectionTitle") ? { sectionTitle: text(resultRaw.sectionTitle, 40, "resultLabels.sectionTitle")! } : {}),
    ...(text(resultRaw.emptyHint, 200, "resultLabels.emptyHint") ? { emptyHint: text(resultRaw.emptyHint, 200, "resultLabels.emptyHint")! } : {}),
    ...(text(resultRaw.cta, 40, "resultLabels.cta") ? { cta: text(resultRaw.cta, 40, "resultLabels.cta")! } : {}),
  } : undefined;

  const page = validatePage(value.page, invalid);
  const navLabel = text(value.navLabel, 20, "navLabel");
  // layout 决定用哪一种页面骨架：写错就拒绝，否则用户会莫名看到营销页而不是工作台。
  if (value.layout !== undefined && value.layout !== "page" && value.layout !== "workspace") invalid("layout（page|workspace）");
  const layout = value.layout as "page" | "workspace" | undefined;
  const workspaceRaw = asRecord(value.workspace);
  if (value.workspace !== undefined && !workspaceRaw) invalid("workspace（需要对象）");
  // 状态摘要的展示位置与取哪个键写错就拒绝：静默丢一块，用户页上看不出来。
  if (workspaceRaw?.stateSummary !== undefined && !asRecord(workspaceRaw.stateSummary)) invalid("workspace.stateSummary（需要对象）");
  const stateSummaryRaw = asRecord(workspaceRaw?.stateSummary);
  if (stateSummaryRaw?.format !== undefined && stateSummaryRaw.format !== "list" && stateSummaryRaw.format !== "text") invalid("workspace.stateSummary.format（list|text）");
  const stateSummary = stateSummaryRaw ? {
    ...(text(stateSummaryRaw.title, 80, "workspace.stateSummary.title") ? { title: text(stateSummaryRaw.title, 80, "workspace.stateSummary.title")! } : {}),
    ...(stateSummaryRaw.format === "list" || stateSummaryRaw.format === "text" ? { format: stateSummaryRaw.format as "list" | "text" } : {}),
    ...(text(stateSummaryRaw.stateKey, 200, "workspace.stateSummary.stateKey") ? { stateKey: text(stateSummaryRaw.stateKey, 200, "workspace.stateSummary.stateKey")! } : {}),
  } : undefined;
  const workspace = workspaceRaw ? {
    ...(text(workspaceRaw.title, 80, "workspace.title") ? { title: text(workspaceRaw.title, 80, "workspace.title")! } : {}),
    ...(text(workspaceRaw.subtitle, 300, "workspace.subtitle") ? { subtitle: text(workspaceRaw.subtitle, 300, "workspace.subtitle")! } : {}),
    ...(text(workspaceRaw.resultTitle, 40, "workspace.resultTitle") ? { resultTitle: text(workspaceRaw.resultTitle, 40, "workspace.resultTitle")! } : {}),
    ...(text(workspaceRaw.emptyHint, 200, "workspace.emptyHint") ? { emptyHint: text(workspaceRaw.emptyHint, 200, "workspace.emptyHint")! } : {}),
    ...(typeof workspaceRaw.history === "boolean" ? { history: workspaceRaw.history } : {}),
    ...(stateSummary && Object.keys(stateSummary).length ? { stateSummary } : {}),
  } : undefined;
  // 工作台布局自带表单与结果区，再配 page 会出现两套表单，直接拒绝而不是静默忽略。
  if (layout === "workspace" && page?.some(block => block.type === "form" || block.type === "results")) {
    invalid("page（layout=workspace 时由工作台自带表单与结果，不要再配 form/results 区块）");
  }
  const footerRaw = asRecord(value.footer);
  const footer = footerRaw ? {
    ...(text(footerRaw.text, 400, "footer.text") ? { text: text(footerRaw.text, 400, "footer.text")! } : {}),
    ...(Array.isArray(footerRaw.links) ? {
      links: footerRaw.links.slice(0, 6).flatMap(link => {
        const entry = asRecord(link);
        return entry && typeof entry.label === "string" && entry.label.length <= 40 && typeof entry.href === "string" && /^https?:\/\//.test(entry.href) && entry.href.length <= 2000
          ? [{ label: entry.label, href: entry.href }] : [];
      }),
    } : {}),
  } : undefined;

  return {
    ...(theme && Object.keys(theme).length ? { theme } : {}),
    ...(hero && Object.keys(hero).length ? { hero } : {}),
    ...(highlights?.length ? { highlights } : {}),
    ...(promptIdeas?.length ? { promptIdeas } : {}),
    ...(presets?.length ? { presets } : {}),
    ...(resultLabels && Object.keys(resultLabels).length ? { resultLabels } : {}),
    ...(page?.length ? { page } : {}),
    ...(layout ? { layout } : {}),
    ...(workspace && Object.keys(workspace).length ? { workspace } : {}),
    ...(navLabel ? { navLabel } : {}),
    ...(footer && Object.keys(footer).length ? { footer } : {}),
  };
}

/**
 * 页面区块校验：只接受已知 type，逐块按类型校验字段与长度。
 * 校验失败的块直接报错（而不是丢弃），因为「少一块」在页面上看不出来，只会变成莫名缺内容。
 */
function validatePage(raw: unknown, invalid: (label: string) => never): PackagePageBlock[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) invalid("page（需要数组）");
  const blocks: PackagePageBlock[] = [];
  const list = raw as unknown[];
  if (list.length > 40) invalid("page（最多 40 个区块）");
  const str = (value: unknown, max: number, label: string) => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length > max) invalid(label);
    return value as string;
  };
  const required = (value: unknown, max: number, label: string) => {
    const parsed = str(value, max, label);
    if (!parsed) invalid(label + "（必填）");
    return parsed;
  };
  const action = (value: unknown, label: string): PackagePageAction | undefined => {
    if (value === undefined) return undefined;
    if (value !== "form" && value !== "results") invalid(label + "（form|results）");
    return value;
  };
  const media = (value: unknown, label: string, limit: number) => {
    if (!Array.isArray(value)) invalid(label + "（需要数组）");
    return (value as unknown[]).slice(0, limit).flatMap(item => {
      const entry = asRecord(item);
      if (!entry || typeof entry.url !== "string" || entry.url.length > 2000) return [];
      return [{ url: entry.url, ...(typeof entry.caption === "string" ? { caption: entry.caption.slice(0, 80) } : {}) }];
    });
  };
  const titled = (item: Record<string, unknown>, label: string, max = 60) => {
    const title = required(item.title, max, label + ".title");
    return { title, ...(typeof item.detail === "string" ? { detail: item.detail.slice(0, 240) } : {}) };
  };
  list.forEach((rawBlock, index) => {
    const at = "page[" + index + "]";
    const block = asRecord(rawBlock);
    if (!block) invalid(at);
    const type = block!.type;
    if (typeof type !== "string" || !(PAGE_BLOCKS as readonly string[]).includes(type)) invalid(at + ".type（" + PAGE_BLOCKS.join("|") + "）");
    const title = str(block!.title, 80, at + ".title");
    const subtitle = str(block!.subtitle, 300, at + ".subtitle");
    const head = { ...(title ? { title } : {}), ...(subtitle ? { subtitle } : {}) };
    switch (type as typeof PAGE_BLOCKS[number]) {
      case "hero":
        blocks.push({
          type: "hero", ...head,
          ...(str(block!.eyebrow, 60, at + ".eyebrow") ? { eyebrow: str(block!.eyebrow, 60, at + ".eyebrow")! } : {}),
          ...(str(block!.headline, 120, at + ".headline") ? { headline: str(block!.headline, 120, at + ".headline")! } : {}),
          ...(str(block!.subline, 300, at + ".subline") ? { subline: str(block!.subline, 300, at + ".subline")! } : {}),
          ...(block!.align === "left" || block!.align === "center" ? { align: block!.align } : {}),
          ...(Array.isArray(block!.showcase) ? { showcase: media(block!.showcase, at + ".showcase", 8) } : {}),
          ...(Array.isArray(block!.actions) ? {
            actions: block!.actions.slice(0, 3).flatMap(item => {
              const entry = asRecord(item);
              const label = entry ? str(entry.label, 40, at + ".actions.label") : undefined;
              const act = entry ? action(entry.action, at + ".actions.action") : undefined;
              return label && act ? [{ label, action: act }] : [];
            }),
          } : {}),
        });
        break;
      case "features": {
        if (!Array.isArray(block!.items)) invalid(at + ".items（需要数组）");
        blocks.push({ type: "features", ...head, items: (block!.items as unknown[]).slice(0, 12).map((item, itemIndex) => {
          const entry = asRecord(item);
          if (!entry) invalid(at + ".items[" + itemIndex + "]");
          const mapped = titled(entry!, at + ".items[" + itemIndex + "]");
          return { ...mapped, ...(typeof entry!.badge === "string" ? { badge: entry!.badge.slice(0, 16) } : {}) };
        }) });
        break;
      }
      case "gallery":
        blocks.push({ type: "gallery", ...head, ...(block!.columns === 2 || block!.columns === 3 || block!.columns === 4 ? { columns: block!.columns } : {}), items: media(block!.items, at + ".items", 24) });
        break;
      case "steps": {
        if (!Array.isArray(block!.items)) invalid(at + ".items（需要数组）");
        blocks.push({ type: "steps", ...head, items: (block!.items as unknown[]).slice(0, 12).map((item, itemIndex) => {
          const entry = asRecord(item);
          if (!entry) invalid(at + ".items[" + itemIndex + "]");
          return titled(entry!, at + ".items[" + itemIndex + "]");
        }) });
        break;
      }
      case "text":
        blocks.push({ type: "text", ...head, body: required(block!.body, 8000, at + ".body"), ...(block!.align === "left" || block!.align === "center" ? { align: block!.align } : {}) });
        break;
      case "form":
        blocks.push({
          type: "form", ...head,
          ...(str(block!.submitLabel, 40, at + ".submitLabel") ? { submitLabel: str(block!.submitLabel, 40, at + ".submitLabel")! } : {}),
          ...(str(block!.note, 400, at + ".note") ? { note: str(block!.note, 400, at + ".note")! } : {}),
        });
        break;
      case "results":
        blocks.push({
          type: "results", ...head,
          ...(str(block!.emptyHint, 200, at + ".emptyHint") ? { emptyHint: str(block!.emptyHint, 200, at + ".emptyHint")! } : {}),
        });
        break;
      case "faq": {
        if (!Array.isArray(block!.items)) invalid(at + ".items（需要数组）");
        blocks.push({ type: "faq", ...head, items: (block!.items as unknown[]).slice(0, 16).map((item, itemIndex) => {
          const entry = asRecord(item);
          if (!entry) invalid(at + ".items[" + itemIndex + "]");
          return { question: required(entry!.question, 200, at + ".items[" + itemIndex + "].question"), answer: required(entry!.answer, 2000, at + ".items[" + itemIndex + "].answer") };
        }) });
        break;
      }
      case "cta": {
        const headline = required(block!.headline, 120, at + ".headline");
        blocks.push({
          type: "cta", headline,
          ...(str(block!.subline, 300, at + ".subline") ? { subline: str(block!.subline, 300, at + ".subline")! } : {}),
          ...(str(block!.label, 40, at + ".label") ? { label: str(block!.label, 40, at + ".label")! } : {}),
          ...(action(block!.action, at + ".action") ? { action: action(block!.action, at + ".action")! } : {}),
        });
        break;
      }
    }
  });
  // 表单只能出现一次：重复出现会让用户不知道哪个按钮才是提交。
  if (blocks.filter(block => block.type === "form").length > 1) invalid("page（form 区块最多 1 个）");
  return blocks;
}


export const packageDraftDocument = z.object({
  id: z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  title: z.string().min(1).max(200),
  summary: z.string().max(2000).optional(),
  description: z.string().max(10_000).optional(),
  cover: z.string().max(2000).optional(),
  inputs: z.array(z.record(z.string(), z.unknown())).max(200).describe("包级输入契约（与场景输入同构）"),
  items: z.array(packageItem).min(1).max(50),
  /** 服务定价（可选）：省略时继承组件场景定价。字段语义见手册 §13。 */
  pricing: z.object({
    version: z.literal(1),
    base: z.number().min(0).max(1_000_000).refine(hasAtMostTwoDecimals, "基础分最多两位小数").default(0),
    items: z.record(z.string(), z.object({
      unit: z.enum(["per_call", "per_item"]),
      credits: z.number().min(0).max(1_000_000).refine(hasAtMostTwoDecimals, "单价最多两位小数"),
    })).default({}),
  }).optional(),
  presentation: packagePresentation.optional().describe("服务呈现层，随发布快照固化"),
}).strict();

export type PackageDraft = z.output<typeof packageDraftDocument>;
export type PackageBinding = z.output<typeof packageBinding>;

/** 包发布快照：自包含组件快照，避免引用悬空。 */
export interface PackageVersionItem {
  id: string;
  name: string;
  sceneId: string;
  versionId: string;
  /** 组件发布版的完整快照副本（scene/workflow/optionPresets），包发布后不再读原场景。 */
  scene: Record<string, unknown>;
  workflow: RunWorkflowDefinition;
  optionPresets: Array<Record<string, unknown>>;
  inputs: PackageBinding[];
  confirmAfter?: boolean;
}
export interface PackageVersion {
  versionId: string;
  version: string;
  publishedAt: string;
  packageId: string;
  title: string;
  summary?: string;
  description?: string;
  cover?: string;
  inputs: RunInputField[];
  items: PackageVersionItem[];
  /** 发布时固化的服务定价。source=package 表示服务自己定价，source=component 表示继承组件场景定价。 */
  pricing: {
    version: 1;
    base: number;
    source: "package" | "component";
    components: Record<string, { credits: number }>;
    items?: Record<string, { unit: "per_call" | "per_item"; credits: number }>;
  };
  presentation?: PackagePresentation;
  revision: number;
}

export const packagePrepareRequest = z.object({
  versionId: z.string().min(1).max(200),
  inputValues: z.record(z.string(), z.unknown()),
}).strict();

export const packageSubmitRequest = packagePrepareRequest.extend({
  runId: z.uuid().describe("调用前生成并保存"),
  packageRunId: z.uuid().describe("包运行ID（父协调器）").optional(),
  runTitle: z.string().trim().max(120).optional(),
}).strict();

export const packageConfirmItemRequest = z.object({
  packageRunId: z.uuid(),
  itemId: z.string().min(1).max(200),
  /** retry 只在失败态可用：把失败项重新排入执行，不需要先经过确认点。 */
  action: z.enum(["approve", "redo", "retry"]),
  feedback: z.string().trim().min(1).max(10_000).optional(),
}).strict();

/** 校验包草稿：项 ID 唯一、引用只指向更早的项、组件发布版存在且输入键已声明。 */
export function validatePackageDraft(draft: PackageDraft, component: (sceneId: string, versionId: string) => { workflow: RunWorkflowDefinition } | undefined) {
  const seen = new Set<string>();
  const packageInputs = new Set(draft.inputs.map(field => String(asRecord(field)?.key ?? "")));
  for (const [index, item] of draft.items.entries()) {
    if (seen.has(item.id)) throw new HttpError(400, "包内项ID重复：" + item.id, "INVALID_PACKAGE");
    const resolved = component(item.sceneId, item.versionId);
    if (!resolved) throw new HttpError(400, "第 " + (index + 1) + " 项引用的场景发布版不存在：" + item.sceneId + "@" + item.versionId, "PACKAGE_COMPONENT_UNAVAILABLE", { itemId: item.id, sceneId: item.sceneId, versionId: item.versionId });
    const declared = new Map(resolved.workflow.inputs.map(field => [field.key, field]));
    const bound = new Set<string>();
    for (const binding of item.inputs) {
      if (bound.has(binding.key)) throw new HttpError(400, "第 " + (index + 1) + " 项重复绑定输入：" + binding.key, "INVALID_PACKAGE", { itemId: item.id, inputKey: binding.key });
      bound.add(binding.key);
      const field = declared.get(binding.key);
      if (!field) throw new HttpError(400, "第 " + (index + 1) + " 项绑定了组件未声明的输入：" + binding.key, "INVALID_PACKAGE", { itemId: item.id, inputKey: binding.key });
      if (binding.valueSource === "input") {
        const key = binding.sourceRef?.startsWith("input.") ? binding.sourceRef.slice(6) : "";
        if (!key || !packageInputs.has(key)) throw new HttpError(400, "第 " + (index + 1) + " 项引用了不存在的包输入：" + String(binding.sourceRef), "INVALID_PACKAGE", { itemId: item.id, inputKey: binding.key });
      }
      if (binding.valueSource === "previous") {
        const reference = /^([a-zA-Z0-9][a-zA-Z0-9_.-]*)\.([a-zA-Z0-9_]+)$/.exec(binding.sourceRef ?? "");
        const source = reference ? draft.items.slice(0, index).find(candidate => candidate.id === reference[1]) : undefined;
        if (!reference || !source) throw new HttpError(400, "第 " + (index + 1) + " 项只能引用更早的项产出：" + String(binding.sourceRef), "INVALID_PACKAGE", { itemId: item.id, reference: binding.sourceRef });
        const sourceResolved = component(source.sceneId, source.versionId);
        if (!sourceResolved?.workflow.outputs.some(output => output.key === reference[2])) throw new HttpError(400, "前序项没有该输出：" + binding.sourceRef, "INVALID_PACKAGE", { itemId: item.id, reference: binding.sourceRef });
      }
    }
    // 必填输入必须被绑定或被组件默认值覆盖，否则提交时才会失败。
    for (const field of resolved.workflow.inputs) {
      if (!field.required || bound.has(field.key)) continue;
      if (field.defaultValue !== undefined) continue;
      throw new HttpError(400, "第 " + (index + 1) + " 项缺少必填输入绑定：" + field.key, "INVALID_PACKAGE", { itemId: item.id, inputKey: field.key, nextAction: "bind_required_input" });
    }
    seen.add(item.id);
  }
}

/** 引用前序产出时的取值：all 取整份；item 取第 N 个；for_each 由调用方逐项配对。 */
export function selectPackageValue(value: JsonValue | undefined, selection: PackageBinding["selection"]): JsonValue {
  if (value === undefined || value === null) return value as JsonValue;
  const mode = selection?.mode ?? "all";
  if (mode === "all") return value;
  const items = Array.isArray(value) ? value : [value];
  const index = selection?.index ?? 0;
  if (index >= items.length) throw new HttpError(409, "前序产出没有第 " + index + " 个结果", "PACKAGE_PREVIOUS_VALUE_MISSING", { index, available: items.length });
  return items[index] as JsonValue;
}

/** 场景包的机器契约：结构、自包含发布、运行与授权语义的唯一事实来源。 */
export const PACKAGE_CONTRACT = {
  version: "1",
  unit: "场景包（package）= 用户面产品单元；场景是包内部件，用户面不出现「场景」",
  structure: {
    draft: "包级输入 inputs + 有序组件项 items；每项固定 sceneId+versionId 并声明输入绑定",
    binding: { input: "取包输入（sourceRef=input.<键>）", literal: "固定值", previous: "取前序项产出（sourceRef=<项ID>.<输出键>，selection all/item）" },
    validation: ["项ID唯一", "只能引用更早的项", "组件必须已发布", "组件必填输入必须被绑定或被默认值覆盖"],
  },
  publish: {
    selfContained: "发布时把组件发布版内嵌成快照（scene/workflow/optionPresets）；组件之后改版或删除不影响已发布的包",
    idempotent: "publicationId 即包版本ID；同一ID重复调用返回既有版本，不重复发布",
    effect: "只固化快照与定价，不执行生成",
  },
  run: {
    model: "父协调器 + N 个普通子运行；复用现有队列/审核/续跑/归档/媒体权限，不新建状态机",
    funding: "submit 一次预扣全部上限价（包级资金）；子运行不各自扣费；按已完成项结算并退还差额，永不补扣",
    serial: "逐项串行；失败、取消或确认点即停",
    confirmAfter: "项完成后包运行与该顸都进入 waiting_confirm；approve 继续剩余项、redo 重跑本项；已确认前段不重复生成",
    terminal: ["completed", "completed_with_errors", "failed", "cancelled"],
  },
  access: {
    unit: "packageIds（set_user_package_access）",
    rule: "组件场景不需要单独授权；只有组件场景授权而无包授权不能提交包",
    notFound: "非本人包运行一律 404，避免探测",
  },
  presentation: {
    purpose: "发布快照里的服务呈现层，决定用户打开这个包时看到的页面；不改执行、不影响定价",
    page: "有序区块数组，每个包可以完全不同：hero/features/gallery/steps/text/form/results/faq/cta。form 最多 1 个，未知 type 在发布时拒绝",
    fallback: "省略 page 时按 hero+highlights 合成默认页，旧包无需改配置",
    theme: "accent/accentSoft/heroFrom/heroTo 为 #RRGGBB；surface=light|dark 决定整页底色",
  },
  errors: ["PACKAGE_ACCESS_DENIED", "PACKAGE_NOT_PUBLISHED", "PACKAGE_COMPONENT_UNAVAILABLE", "PACKAGE_PREVIOUS_VALUE_MISSING", "PACKAGE_NOT_WAITING", "PACKAGE_BUSY", "PACKAGE_REVISION_CONFLICT", "PACKAGE_ALREADY_EXISTS", "PACKAGE_RUN_CANCELLED", "INVALID_PACKAGE_PRESENTATION"],
} as const;
