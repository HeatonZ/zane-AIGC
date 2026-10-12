/**
 * Step-level Hermes provider/model selection. Values are validated locally and then sent to the
 * Hermes API server as request-level ``provider``/``model`` fields, which the gateway resolves per
 * request (``_request_agent_overrides``): an explicit provider is always honored, a bare model is
 * honored on the Hermes-native runs endpoint, and the virtual model ``hermes-agent`` keeps the
 * profile's own default. Nothing here reads credentials or calls Hermes.
 */

export const hermesProviderMaxLength = 80;
export const hermesModelMaxLength = 200;
export const hermesDefaultVirtualModel = "hermes-agent";

/** One Hermes call's optional step-level provider/model override. */
export interface HermesModelSelection {
  provider?: string;
  model?: string;
}

/** Provider slugs and model ids seen in real catalogs: ``custom:my-chat``, ``opencode-zen``,
 *  ``anthropic/claude-opus-5``, ``jet-hub-auto/auto``. Whitespace and control characters are
 *  rejected so a value can never reshape the request line or a log entry. */
const selectionIdentifier = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/;

function selectionError(label: string, value: unknown, maxLength: number) {
  if (typeof value !== "string") return `${label}必须是文本`;
  const trimmed = value.trim();
  if (!trimmed) return `${label}不能为空`;
  if (trimmed.length > maxLength) return `${label}不能超过 ${maxLength} 个字符`;
  if (!selectionIdentifier.test(trimmed)) return `${label}只能使用字母、数字和 _ . : @ / -`;
  return undefined;
}

/** Validate a step's optional provider/model override; returns the first problem, if any. */
export function hermesModelSelectionError(provider: unknown, model: unknown) {
  if (provider !== undefined && provider !== null && provider !== "") {
    const problem = selectionError("Hermes Provider", provider, hermesProviderMaxLength);
    if (problem) return problem;
  }
  if (model !== undefined && model !== null && model !== "") {
    const problem = selectionError("Hermes 模型", model, hermesModelMaxLength);
    if (problem) return problem;
  }
  return undefined;
}

function clean(value: string | undefined) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

/**
 * Request body fields for one Hermes call. Omitting both keeps the historical body exactly
 * (``model: "hermes-agent"``, no ``provider``), so existing published snapshots are unchanged.
 */
export function hermesRequestModelFields(provider?: string, model?: string): { model: string; provider?: string } {
  const selectedProvider = clean(provider);
  const selectedModel = clean(model);
  return {
    model: selectedModel ?? hermesDefaultVirtualModel,
    ...(selectedProvider ? { provider: selectedProvider } : {}),
  };
}

export const HERMES_MODEL_SELECTION_CONTRACT = {
  version: 1,
  stepFields: ["hermesProvider", "hermesModel"],
  omitted: "两个字段都省略时请求体保持历史行为（model=hermes-agent，不发送provider），按Profile自身的默认模型执行。",
  providerOnly: "只选Provider时发送provider并保留虚拟模型hermes-agent：网关切换到该Provider的凭证与端点，模型仍取该Profile的默认模型。",
  modelOnly: "只选模型时不发送provider：Hermes /v1/runs入口按所选模型执行；旧版/v1/chat/completions回退入口只有网关开启direct_model_requests才接受裸模型，否则按网关默认模型执行。建议同时选择Provider与模型。",
  both: "同时选择时同时发送provider与model，网关按该Provider解析凭证、端点与API模式。",
  validation: "provider最多80字符、模型最多200字符，只允许字母、数字和 _ . : @ / -，不接受空白或控制字符；校验在草稿校验、发布快照预检和执行前各执行一次。",
  discovery: "list_hermes_models按Profile读取网关的模型目录（slug/名称/是否当前/模型列表），只用于配置建议；未安装或未启动网关时仍可手工填写，执行时才需要网关可达。",
  scope: "选择只作用于声明它的Hermes步骤（含for_each逐项），不修改Profile配置、网关默认模型或历史运行快照。",
} as const;
