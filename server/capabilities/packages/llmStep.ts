import type { CapabilityFactory } from "../package.js";
import { emptyDirectLlmTarget, normalizeDirectLlmModel } from "../../domain/directLlm.js";
import { isRuntimeMediaValue } from "../../runtimeValue.js";
import { resolveWorkflowReference, splitWorkflowReference } from "../../domain/workflowValues.js";
import type { JsonValue } from "../../domain/types.js";
import type { RunStep } from "../../domain/types.js";

/** 技能文本：把若干引用（input.<key> / step.<id>.outputs.<key>，可带 JSON 路径）解析成系统指令正文。
 *
 *  典型来源是 core.code 用 fileAccess 读出的 SKILL.md 正文，或本步骤的文本输入。
 *  刻意不做任何内容加工：不剥 frontmatter、不裁剪、不改写——技能正文是用户资产，要改动请在
 *  core.code 里显式做。引用不存在或指向媒体时明确失败，不静默发一段空系统指令。
 *  多个引用用换行或逗号分隔，按填写顺序拼接，引用之间空一行。 */
function skillReferenceParts(reference: unknown) {
  const text = typeof reference === "string" ? reference.trim() : "";
  return text ? text.split(/[\n,]/).map((item) => item.trim()).filter(Boolean) : [];
}

function resolveSkillText(
  stepName: string,
  reference: string,
  inputs: Record<string, JsonValue>,
  stepValues: Map<string, Record<string, JsonValue>>,
) {
  return skillReferenceParts(reference).map((part) => {
    let value: JsonValue | undefined;
    try {
      value = resolveWorkflowReference(part, inputs, stepValues) as JsonValue | undefined;
    } catch (error) {
      throw new Error(`${stepName} 的技能文本引用无效（${part}）：${error instanceof Error ? error.message : String(error)}`);
    }
    if (value === undefined || value === null) throw new Error(`${stepName} 的技能文本引用没有值：${part}；请检查上游步骤是否已执行或该字段是否为空`);
    if (isRuntimeMediaValue(value)) throw new Error(`${stepName} 的技能文本引用指向媒体，不能作为系统指令：${part}`);
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join("\n\n");
    return JSON.stringify(value);
  }).join("\n\n");
}

/** 草稿校验/发布预检只检查引用语法：引用的目标是否存在要等执行期才有上下文，
 *  但「写成 foo.bar 这种永远解析不了的字符串」应当在这里就失败，而不是等付费调用前才报错。 */
function validateSkillRef(step: RunStep) {
  for (const part of skillReferenceParts(step.capabilityConfig?.skillRef)) {
    if (!splitWorkflowReference(part)) throw new Error(`技能文本引用无效：${part}；应填写 input.<本步骤输入key> 或 step.<步骤id>.outputs.<输出key>`);
  }
}

/** General large-model call step: an independent system prompt plus multi-image input,
 *  returning either a raw text reply or the declared structured JSON outputs.
 *
 *  It reuses the proven attachment construction (image compression, inline-media budget,
 *  cancellation, JSON contract) instead of duplicating it, so the only additions are the
 *  system-role message, the raw-text output mode and a text reference that lets a skill body
 *  (for example a SKILL.md read by core.code) act as the system instruction.
 *
 *  `direct` adds a second execution path that is completely independent of Hermes: the worker
 *  POSTs the selected registry provider itself, over that provider's protocol. It neither reads
 *  a Hermes Profile nor requires one to be valid, and it shares the same attachment
 *  construction, so switching modes changes only who is called, not what is sent. */
const factory: CapabilityFactory = (runtime) => ({
  definition: {
    id: "core.llm", version: "1",
    usage: { whenToUse: "需要独立 system 指令（例如把某个 PE/增强器的系统提示词直接交给大模型）、需要把一段技能文本（例如 core.code 读出的 SKILL.md 正文或场景文本输入）作为系统指令传入、并可能同时传入多张参考图的大模型调用；输出可选原始文本或按声明端口返回结构化 JSON。只做一次模型调用，不生成媒体；图像生成仍用 core.comfyui。" },
    label: "大模型调用", category: "模型",
    description: "调用大模型，把「系统指令」作为独立 system 消息、把「提示词模板 + 步骤输入」作为 user 消息发送；声明为 image_list/video_list 的输入会作为多模态附件一并发送（沿用与 Hermes 步骤相同的抽帧、压缩与 10MB 内联上限）。系统指令有两种来源，可同时使用：直接写在 capabilityConfig.systemPrompt 的固定文本，以及 capabilityConfig.skillRef 引用的技能文本（例如 core.code 用 fileAccess 读出的 SKILL.md 正文、或场景的文本输入）；两者按「固定文本在前、技能文本在后」用空行拼接，留空则不发送 system 消息。技能文本只按引用取值，不剥 frontmatter、不裁剪、不改写，引用不存在或指向媒体时明确失败。输出模式有两种：默认 json 要求模型返回与声明输出端口一致的 JSON 对象（严格校验，缺失/多余字段都是失败）；text 模式只允许声明恰好一个 text 输出，并把模型回复原文（不做 JSON 解析、不裁剪）作为该输出返回。默认走已配置的 Hermes Profile（可用 provider/model 覆盖）。开启 capabilityConfig.direct 后改为直连：选中的提供商来自「集成连接 → 直连模型提供商」注册表（providerId + 可选 model），worker 按该提供商的协议直接 POST /chat/completions（OpenAI Chat 兼容）或 /messages（Anthropic），**不读任何 Hermes Profile、网关地址或网关密钥**。API 密钥在页面上直接填写、以明文保存在本机 SQLite（也可改用 apiKeyEnv 环境变量回退），读出时只给掩码；密钥不进入场景配置、运行记录、运行输入、发布快照、日志或导出。直连允许本机/内网地址（常见形态是本机代理或自建网关），这是对第三方请求「仅公网」限制的有意例外。两种模式都是真实模型调用，可能计费，且都不自动重试；配置、校验、预检与查询模型都不调用模型。",
    dependencyMode: "declared", legacy: { kind: "capability" },
    inputs: [], outputs: [],
    config: [
      { key: "systemPrompt", label: "系统指令（system）", type: "textarea", description: "作为独立 system 消息发送，用于承载角色设定、输出规范等长期约束（例如从旧 PE 节点迁移过来的系统提示词）。留空则不发送 system 消息，请求体与普通 Hermes 调用一致。与「提示词模板」分开：系统指令放这里，本次任务的具体要求放提示词模板。Anthropic 协议下它作为顶层 system 字段发送（不是 messages 条目）。" },
      { key: "skillRef", label: "技能文本引用（可选）", type: "reference", placeholder: "例如 step.load_skill.outputs.text", description: "把一段已有文本作为系统指令正文，最典型的用法是用 core.code 的 fileAccess 读出 SKILL.md 等技能文件、再在这里引用它的 text 输出；也可以引用本步骤的文本输入。写法与提示词模板里的引用一致：input.<本步骤输入key>、step.<步骤id>.outputs.<输出key>，可带 JSON 路径（如 [0].text）；多个引用用换行或逗号分隔，按填写顺序用空行拼接。内容原样发送：不剥 frontmatter、不裁剪、不改写，需要处理请在 core.code 里先做。引用不存在或指向媒体时在发出请求前明确失败；解析结果为空时继续执行，但会在步骤警告里记录，避免悄悄丢掉技能正文。与上面的固定系统指令同时填写时，固定文本在前、技能文本在后。" },
      { key: "outputMode", label: "输出模式", type: "select", defaultValue: "json", options: ["json", "text"], description: "json：要求模型只返回一个 JSON 对象，字段与下方输出端口一一对应，缺失或多余字段都判为失败。text：把模型回复原文作为唯一 text 输出返回，适合「提示词正文」这类不需要结构化的场景；此时必须只声明一个 text 输出端口。" },
      { key: "direct", label: "直连模型提供商", type: "boolean", defaultValue: false, description: "默认关闭，走 Hermes Profile（历史行为完全不变）。开启后 worker 按下面选中的提供商协议直接请求它，**完全不读 Hermes Profile、网关地址或网关密钥**；提供商与模型来自「集成连接 → 直连模型提供商」注册表。API 密钥可在页面上直接填写（明文保存在本机 SQLite，请自行保护数据目录与备份），或在提供商里改填环境变量名回退读取；密钥值不会进入步骤配置、运行记录、运行输入、发布快照、日志或导出。直连失败会在步骤结果里明确说明是直连而非 Hermes；不自动重试，因为补全不是幂等操作。" },
      { key: "providerId", label: "直连提供商", type: "text", placeholder: "留空则用保留的默认提供商", description: "capabilityConfig.direct=true 时使用。填写 list_direct_llm_providers 返回的 providerId（稳定 ID）。留空表示保留的默认提供商：1.5.39 单例或环境默认值 ZANE_DIRECT_LLM_BASE_URL/ZANE_DIRECT_LLM_API_KEY_ENV/ZANE_DIRECT_LLM_MODEL，因此升级前的已发布快照继续可用。" },
      { key: "model", label: "直连模型（可选）", type: "text", placeholder: "留空则用提供商的第一个模型", description: "覆盖该提供商的模型名；留空时用提供商 models 列表的第一个。提供商没有模型且这里也为空时，执行前明确失败，不会猜一个默认模型。" },
    ],
    editor: { inputs: "ports", outputs: "ports", editablePorts: true, editableInputs: true, editableOutputs: true, profile: true, prompt: true },
    result: { renderer: "auto" },
  },
  validate: validateSkillRef,
  async execute(context) {
    const raw = context.step.capabilityConfig?.outputMode;
    const outputMode = raw === "text" ? "text" as const : "json" as const;
    const rawSystem = context.step.capabilityConfig?.systemPrompt;
    // 原样保留固定文本（只判断是否空白），避免给历史快照带来首尾空白的差异。
    const fixedSystem = typeof rawSystem === "string" && rawSystem.trim() ? rawSystem : "";
    const rawSkill = context.step.capabilityConfig?.skillRef;
    const skillReference = typeof rawSkill === "string" ? rawSkill.trim() : "";
    // 技能文本与固定系统指令合成同一条 system 消息：固定文本在前，技能正文在后。
    // 两者都为空时不发送 system 消息，请求体与历史行为逐字节一致。
    const skillText = skillReference ? resolveSkillText(context.step.name, skillReference, context.inputValues, context.stepValues) : "";
    // 技能正文解析成空文本多半是上游漏了内容：继续执行，但留下可核对的警告，
    // 不让「系统指令实际是空的」这件事静默通过。
    if (skillReference && !skillText.trim()) {
      await context.warn?.(`${context.step.name} 的技能文本引用解析结果为空，本次请求没有携带技能正文：${skillReference}`);
    }
    const systemPrompt = [fixedSystem, skillText].filter((part) => part.trim()).join("\n\n") || undefined;
    const direct = context.step.capabilityConfig?.direct === true;
    // 未开启直连时不带 direct 字段：调用方（runHermesStep）据此完全走历史路径，连 directLlm 都不读。
    if (!direct) return runtime.hermes(context, { systemPrompt, outputMode });
    const rawProvider = context.step.capabilityConfig?.providerId;
    const providerId = typeof rawProvider === "string" && rawProvider.trim() ? rawProvider.trim() : undefined;
    const rawModel = context.step.capabilityConfig?.model;
    // 步骤里的模型名按同一口径归一化；无效值在发出任何请求之前就失败。
    const model = typeof rawModel === "string" && rawModel.trim() ? normalizeDirectLlmModel(rawModel) : undefined;
    return runtime.hermes(context, { systemPrompt, outputMode, direct: runtime.directLlm?.({ providerId, model }) ?? emptyDirectLlmTarget() });
  },
});
export default factory;
