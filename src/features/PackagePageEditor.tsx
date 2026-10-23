import { useState } from "react";
import type { PackagePageBlock, PackagePresentation } from "../../server/domain/packageContracts.js";

/**
 * 服务页面编辑：按区块增删与排序，每个区块只暴露常用字段。
 * 形状的权威校验在服务端（validatePresentation）；这里只负责把配置写对，
 * 并给出「这个区块在用户页上长什么样」的一句话说明。
 */
const BLOCK_LABELS: Record<PackagePageBlock["type"], { label: string; hint: string }> = {
  hero: { label: "主视觉", hint: "大标题 + 一句说明 + 示例图，页面第一屏" },
  features: { label: "卖点", hint: "三列卡片：这个服务能做什么" },
  gallery: { label: "作品示例", hint: "图片网格，用真实产出说明效果" },
  steps: { label: "使用流程", hint: "编号步骤：用户需要做什么" },
  text: { label: "长文本", hint: "一段说明，适合规则、限制、注意事项" },
  form: { label: "输入表单", hint: "用户填写的表单与提交按钮（每页最多一个）" },
  results: { label: "产出展示", hint: "最近一次完成的产出画廊" },
  faq: { label: "常见问题", hint: "折叠问答，减少重复咨询" },
  cta: { label: "结尾行动", hint: "页面底部的行动号召按钮" },
};

const emptyBlock = (type: PackagePageBlock["type"]): PackagePageBlock => {
  switch (type) {
    case "hero": return { type: "hero", eyebrow: "", headline: "", subline: "" };
    case "features": return { type: "features", title: "包含什么", items: [{ title: "特点一", detail: "" }] };
    case "gallery": return { type: "gallery", title: "作品示例", columns: 3, items: [] };
    case "steps": return { type: "steps", title: "怎么用", items: [{ title: "第一步" }] };
    case "text": return { type: "text", title: "说明", body: "" };
    case "form": return { type: "form", title: "开始创作", submitLabel: "" };
    case "results": return { type: "results", title: "最近产出" };
    case "faq": return { type: "faq", title: "常见问题", items: [{ question: "", answer: "" }] };
    case "cta": return { type: "cta", headline: "现在就试", label: "开始生成", action: "form" };
  }
};

/** 新建页面时的推荐结构：旧包没有 page 也能用，这里给一个可直接发布的起点。 */
export function defaultServicePage(title: string, cta: string): PackagePageBlock[] {
  return [
    { type: "hero", headline: title, subline: "", actions: [{ label: cta, action: "form" }] },
    { type: "features", title: "包含什么", items: [] },
    { type: "form", title: "开始创作" },
    { type: "results", title: "最近产出" },
  ];
}

export default function PackagePageEditor({ presentation, onChange }: {
  presentation?: PackagePresentation;
  onChange: (next: PackagePresentation | undefined) => void;
}) {
  const [showJson, setShowJson] = useState(false);
  const [jsonDraft, setJsonDraft] = useState("");
  const [jsonError, setJsonError] = useState("");
  const page = presentation?.page;
  const blocks = page ?? [];

  function patch(next: Partial<PackagePresentation>) {
    const merged = { ...presentation, ...next };
    // 空对象不写进草稿：发布快照里不留无意义的空节点。
    const cleaned = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0)));
    onChange(Object.keys(cleaned).length ? cleaned as PackagePresentation : undefined);
  }
  function setBlocks(next: PackagePageBlock[]) {
    patch({ page: next.length ? next : undefined });
  }
  function updateBlock(index: number, next: PackagePageBlock) {
    setBlocks(blocks.map((block, position) => position === index ? next : block));
  }
  function moveBlock(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    setBlocks(next);
  }
  function addBlock(type: PackagePageBlock["type"]) {
    if (type === "form" && blocks.some(block => block.type === "form")) return;
    setBlocks([...blocks, emptyBlock(type)]);
  }
  function removeBlock(index: number) {
    setBlocks(blocks.filter((_block, position) => position !== index));
  }
  function openJson() {
    setJsonDraft(JSON.stringify(presentation ?? {}, null, 2));
    setJsonError("");
    setShowJson(true);
  }
  function applyJson() {
    try {
      const parsed = JSON.parse(jsonDraft) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { setJsonError("需要一个 JSON 对象"); return; }
      onChange(Object.keys(parsed).length ? parsed as PackagePresentation : undefined);
      setJsonError("");
      setShowJson(false);
    } catch (error) {
      setJsonError("JSON 语法错误：" + (error as Error).message);
    }
  }

  return <section className="access-card package-page-editor">
    <h3>服务页面</h3>
    <p className="access-hint">用户打开这个服务时看到的页面。区块按顺序排列，每个包可以完全不同；不配置时用「主视觉 + 卖点 + 表单 + 结果」的默认页。</p>

    <div className="package-page-layout">
      <label>页面类型
        <select className="text-input" value={presentation?.layout ?? "page"} onChange={event => {
          const layout = event.target.value as "page" | "workspace";
          if (layout === "workspace") {
            // 工作台自带表单与结果，清掉 page 里的这两类区块（服务端会拒绝重复表单）。
            setBlocks(blocks.filter(block => block.type !== "form" && block.type !== "results"));
            patch({ layout, workspace: presentation?.workspace ?? {} });
          } else {
            patch({ layout: undefined });
          }
        }}>
          <option value="page">介绍页（主视觉 + 区块）</option>
          <option value="workspace">工作台（左调参 + 右出结果）</option>
        </select>
      </label>
      <small className="access-hint">{presentation?.layout === "workspace"
        ? "出图、改图这类高频工具用工作台：输入与结果在同一屏，出完图不用滚回去找。"
        : "第一次了解服务的人看介绍页更合适；重介绍、轻高频操作时用它。"}</small>
    </div>
    {presentation?.layout === "workspace" && <div className="package-page-theme">
      <label>工作台标题<input className="text-input" maxLength={80} placeholder="默认用服务标题" value={presentation?.workspace?.title ?? ""} onChange={event => patch({ workspace: { ...presentation?.workspace, title: event.target.value || undefined } })} /></label>
      <label>顶部说明<input className="text-input" maxLength={300} placeholder="默认用服务一句话说明" value={presentation?.workspace?.subtitle ?? ""} onChange={event => patch({ workspace: { ...presentation?.workspace, subtitle: event.target.value || undefined } })} /></label>
      <label>结果区标题<input className="text-input" maxLength={40} placeholder="生成结果" value={presentation?.workspace?.resultTitle ?? ""} onChange={event => patch({ workspace: { ...presentation?.workspace, resultTitle: event.target.value || undefined } })} /></label>
      <label>空态提示<input className="text-input" maxLength={200} value={presentation?.workspace?.emptyHint ?? ""} onChange={event => patch({ workspace: { ...presentation?.workspace, emptyHint: event.target.value || undefined } })} /></label>
      <label>底部历史条<select className="text-input" value={presentation?.workspace?.history === false ? "off" : "on"} onChange={event => patch({ workspace: { ...presentation?.workspace, history: event.target.value === "on" } })}>
        <option value="on">显示</option><option value="off">隐藏</option>
      </select></label>
    </div>}

    <div className="package-page-theme">
      <label>主题色<input className="text-input" placeholder="#2f6b4f" value={presentation?.theme?.accent ?? ""} onChange={event => patch({ theme: { ...presentation?.theme, accent: normalizeHex(event.target.value) } })} /></label>
      <label>浅色底<input className="text-input" placeholder="#e7f0eb" value={presentation?.theme?.accentSoft ?? ""} onChange={event => patch({ theme: { ...presentation?.theme, accentSoft: normalizeHex(event.target.value) } })} /></label>
      <label>主视觉起始<input className="text-input" placeholder="#24543d" value={presentation?.theme?.heroFrom ?? ""} onChange={event => patch({ theme: { ...presentation?.theme, heroFrom: normalizeHex(event.target.value) } })} /></label>
      <label>主视觉结束<input className="text-input" placeholder="#10201a" value={presentation?.theme?.heroTo ?? ""} onChange={event => patch({ theme: { ...presentation?.theme, heroTo: normalizeHex(event.target.value) } })} /></label>
      <label>页面底色<select className="text-input" value={presentation?.theme?.surface ?? "light"} onChange={event => patch({ theme: { ...presentation?.theme, surface: event.target.value as "light" | "dark" } })}>
        <option value="light">浅色</option><option value="dark">深色</option>
      </select></label>
      <label>导航短名<input className="text-input" maxLength={20} placeholder="默认用标题" value={presentation?.navLabel ?? ""} onChange={event => patch({ navLabel: event.target.value || undefined })} /></label>
    </div>

    <div className="package-page-blocks">
      {blocks.map((block, index) => <div className="package-page-block" key={index}>
        <div className="package-item-head">
          <strong>{index + 1}. {BLOCK_LABELS[block.type].label}</strong>
          <button className="button button-outline" disabled={index === 0} onClick={() => moveBlock(index, -1)}>上移</button>
          <button className="button button-outline" disabled={index === blocks.length - 1} onClick={() => moveBlock(index, 1)}>下移</button>
          <button className="button button-outline" onClick={() => removeBlock(index)}>删除</button>
        </div>
        <small className="access-hint">{BLOCK_LABELS[block.type].hint}</small>
        <BlockFields block={block} onChange={next => updateBlock(index, next)} />
      </div>)}
      {!blocks.length && <p className="access-hint">还没有配置页面区块；保存后用户会看到默认页。</p>}
    </div>

    <div className="access-inline">
      {(Object.keys(BLOCK_LABELS) as Array<PackagePageBlock["type"]>).map(type => <button key={type} className="button button-outline" disabled={type === "form" && blocks.some(block => block.type === "form")} onClick={() => addBlock(type)}>+ {BLOCK_LABELS[type].label}</button>)}
      {!blocks.length && <button className="button button-dark" onClick={() => setBlocks(defaultServicePage("", "开始创作"))}>生成默认页面</button>}
      <button className="button button-outline" onClick={openJson}>编辑 JSON</button>
    </div>

    {showJson && <div className="package-page-json">
      <textarea className="text-input" rows={16} value={jsonDraft} onChange={event => setJsonDraft(event.target.value)} spellCheck={false} />
      {jsonError && <p className="access-error">{jsonError}</p>}
      <div className="access-inline">
        <button className="button button-dark" onClick={applyJson}>应用 JSON</button>
        <button className="button button-outline" onClick={() => setShowJson(false)}>取消</button>
      </div>
    </div>}
  </section>;
}

/** 颜色只接受 #RRGGBB：非法值不写进草稿，避免发布时才被服务端拒绝。 */
function normalizeHex(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : undefined;
}

function BlockFields({ block, onChange }: { block: PackagePageBlock; onChange: (next: PackagePageBlock) => void }) {
  const text = (label: string, value: string | undefined, key: string, max = 200) => <label>{label}
    <input className="text-input" maxLength={max} value={value ?? ""} onChange={event => onChange({ ...block, [key]: event.target.value || undefined } as PackagePageBlock)} />
  </label>;
  const longText = (label: string, value: string | undefined, key: string, rows = 4) => <label>{label}
    <textarea className="text-input" rows={rows} value={value ?? ""} onChange={event => onChange({ ...block, [key]: event.target.value } as PackagePageBlock)} />
  </label>;
  switch (block.type) {
    case "hero":
      return <div className="package-page-fields">
        {text("小标题", block.eyebrow, "eyebrow", 60)}
        {text("大标题", block.headline, "headline", 120)}
        {longText("一句说明", block.subline, "subline", 3)}
        <label>对齐<select className="text-input" value={block.align ?? "left"} onChange={event => onChange({ ...block, align: event.target.value as "left" | "center" })}>
          <option value="left">左对齐</option><option value="center">居中</option>
        </select></label>
        <label>主按钮文字
          <input className="text-input" maxLength={40} value={block.actions?.[0]?.label ?? ""} onChange={event => onChange({
            ...block,
            actions: event.target.value ? [{ label: event.target.value, action: block.actions?.[0]?.action ?? "form" }] : undefined,
          })} />
        </label>
      </div>;
    case "features":
    case "steps": {
      const items = block.items;
      return <div className="package-page-fields">
        {text("区块标题", block.title, "title", 80)}
        {text("副标题", block.subtitle, "subtitle", 300)}
        {items.map((item, index) => <div className="package-page-row" key={index}>
          <input className="text-input" placeholder="标题" maxLength={60} value={item.title} onChange={event => onChange({ ...block, items: items.map((entry, position) => position === index ? { ...entry, title: event.target.value } : entry) } as PackagePageBlock)} />
          <input className="text-input" placeholder="说明（可选）" maxLength={240} value={item.detail ?? ""} onChange={event => onChange({ ...block, items: items.map((entry, position) => position === index ? { ...entry, detail: event.target.value || undefined } : entry) } as PackagePageBlock)} />
          <button className="button button-outline" onClick={() => onChange({ ...block, items: items.filter((_entry, position) => position !== index) } as PackagePageBlock)}>移除</button>
        </div>)}
        <button className="button button-outline" onClick={() => onChange({ ...block, items: [...items, { title: "新条目" }] } as PackagePageBlock)}>添加一条</button>
      </div>;
    }
    case "gallery":
      return <div className="package-page-fields">
        {text("区块标题", block.title, "title", 80)}
        <label>列数<select className="text-input" value={block.columns ?? 3} onChange={event => onChange({ ...block, columns: Number(event.target.value) as 2 | 3 | 4 })}>
          <option value={2}>2 列</option><option value={3}>3 列</option><option value={4}>4 列</option>
        </select></label>
        {block.items.map((item, index) => <div className="package-page-row" key={index}>
          <input className="text-input" placeholder="图片地址（/api/... 或 https://...）" value={item.url} onChange={event => onChange({ ...block, items: block.items.map((entry, position) => position === index ? { ...entry, url: event.target.value } : entry) })} />
          <input className="text-input" placeholder="说明（可选）" maxLength={80} value={item.caption ?? ""} onChange={event => onChange({ ...block, items: block.items.map((entry, position) => position === index ? { ...entry, caption: event.target.value || undefined } : entry) })} />
          <button className="button button-outline" onClick={() => onChange({ ...block, items: block.items.filter((_entry, position) => position !== index) })}>移除</button>
        </div>)}
        <button className="button button-outline" onClick={() => onChange({ ...block, items: [...block.items, { url: "" }] })}>添加图片</button>
      </div>;
    case "text":
      return <div className="package-page-fields">
        {text("区块标题", block.title, "title", 80)}
        {longText("正文（空行分段）", block.body, "body", 8)}
        <label>对齐<select className="text-input" value={block.align ?? "left"} onChange={event => onChange({ ...block, align: event.target.value as "left" | "center" })}>
          <option value="left">左对齐</option><option value="center">居中</option>
        </select></label>
      </div>;
    case "form":
      return <div className="package-page-fields">
        {text("区块标题", block.title, "title", 80)}
        {text("副标题", block.subtitle, "subtitle", 300)}
        {text("提交按钮文字（留空用服务设置）", block.submitLabel, "submitLabel", 40)}
        {longText("表单下方说明", block.note, "note", 3)}
      </div>;
    case "results":
      return <div className="package-page-fields">
        {text("区块标题", block.title, "title", 80)}
        {text("副标题", block.subtitle, "subtitle", 300)}
        {text("没有产出时的提示", block.emptyHint, "emptyHint", 200)}
      </div>;
    case "faq":
      return <div className="package-page-fields">
        {text("区块标题", block.title, "title", 80)}
        {block.items.map((item, index) => <div className="package-page-row" key={index}>
          <input className="text-input" placeholder="问题" maxLength={200} value={item.question} onChange={event => onChange({ ...block, items: block.items.map((entry, position) => position === index ? { ...entry, question: event.target.value } : entry) })} />
          <input className="text-input" placeholder="回答" maxLength={2000} value={item.answer} onChange={event => onChange({ ...block, items: block.items.map((entry, position) => position === index ? { ...entry, answer: event.target.value } : entry) })} />
          <button className="button button-outline" onClick={() => onChange({ ...block, items: block.items.filter((_entry, position) => position !== index) })}>移除</button>
        </div>)}
        <button className="button button-outline" onClick={() => onChange({ ...block, items: [...block.items, { question: "", answer: "" }] })}>添加问答</button>
      </div>;
    case "cta":
      return <div className="package-page-fields">
        {text("大标题", block.headline, "headline", 120)}
        {longText("一句说明", block.subline, "subline", 3)}
        {text("按钮文字", block.label, "label", 40)}
        <label>点击后<select className="text-input" value={block.action ?? "form"} onChange={event => onChange({ ...block, action: event.target.value as "form" | "results" })}>
          <option value="form">跳到表单</option><option value="results">跳到产出</option>
        </select></label>
      </div>;
  }
}
