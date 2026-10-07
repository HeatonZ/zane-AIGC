/** Shared by every core.hermes step, irrespective of profile or scene. */
export const HERMES_OUTPUT_JSON_CONTRACT = {
  version: "2",
  input: "one_json_object_matching_declared_output_keys",
  acceptedWrapper: "optional_full_json_markdown_fence",
  recovery: ["remove_one_premature_root_closing_brace_before_another_object_member", "escape_literal_lf_cr_tab_inside_json_strings"],
  recoveryComposition: "one_recovery_family_only",
  recoveryGuards: ["entire_response_parses", "all_declared_keys_present", "no_undeclared_keys", "no_duplicate_root_keys"],
  contentPolicy: "never_truncate_extract_first_object_or_rewrite_values",
  modelRetry: "none",
  diagnostics: "hermes.output_json_repaired_log_with_step_profile_kind_and_offset_no_content",
  failure: "run_or_step_failed_with_Hermes_output_JSON_message_no_automatic_resubmit",
} as const;

function jsonSource(text: string) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

export function parseHermesJson(text: string): unknown {
  return JSON.parse(jsonSource(text)) as unknown;
}

/** Escape only literal LF/CR/TAB inside strings, preserving the decoded value.
 * Existing escapes, structural whitespace, other controls and incomplete JSON
 * remain untouched. A backslash followed by a literal newline is not repaired.
 */
function escapeStringWhitespace(source: string) {
  let inString = false;
  let escaped = false;
  let offset: number | undefined;
  let count = 0;
  let start = 0;
  const parts: string[] = [];
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (!inString) {
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') { inString = false; continue; }
    const replacement = char === "\n" ? "\\n" : char === "\r" ? "\\r" : char === "\t" ? "\\t" : undefined;
    if (replacement === undefined) continue;
    offset ??= index;
    count++;
    parts.push(source.slice(start, index), replacement);
    start = index + 1;
  }
  if (offset === undefined) return;
  parts.push(source.slice(start));
  return { source: parts.join(""), offset, count };
}

/** Find only a complete root object's end, respecting strings and nesting. */
function rootEnd(source: string): number | undefined {
  if (!source.startsWith("{")) return;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let offset = 0; offset < source.length; offset++) {
    const char = source[offset];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      if (stack.pop() !== (char === "}" ? "{" : "[")) return;
      if (!stack.length) return offset;
    }
  }
}

/** Used only on a fully parsed repair candidate; JSON.parse alone ignores duplicate keys. */
function hasDuplicateRootKeys(source: string) {
  const keys = new Set<string>();
  let depth = 0;
  for (let offset = 0; offset < source.length; offset++) {
    const char = source[offset];
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    else if (char === '"') {
      const start = offset;
      while (++offset < source.length) {
        if (source[offset] === "\\") offset++;
        else if (source[offset] === '"') break;
      }
      if (depth === 1 && /^\s*:/.test(source.slice(offset + 1))) {
        const key = JSON.parse(source.slice(start, offset + 1)) as string;
        if (keys.has(key)) return true;
        keys.add(key);
      }
    }
  }
  return false;
}

function validateObject(value: unknown, declaredKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Hermes 输出必须是 JSON 对象");
  const result = value as Record<string, unknown>;
  const declared = new Set(declaredKeys);
  const extra = Object.keys(result).filter(key => !declared.has(key));
  if (extra.length) throw new Error(`Hermes 输出包含未声明字段：${extra.join("、")}`);
  for (const key of declaredKeys) if (!Object.hasOwn(result, key)) throw new Error(`Hermes 输出缺少字段：${key}`);
  return result;
}

/**
 * Strict first. Recover one redundant root brace OR literal string LF/CR/TAB.
 * The rest of the response must parse in full and match the declared key set.
 * Never combine repair families, extract/truncate, change decoded values or call models.
 */
export function parseHermesOutput(text: string, declaredKeys: readonly string[]): {
  value: Record<string, unknown>;
  repair?: { kind: "premature_root_closing_brace"; offset: number } | { kind: "literal_string_whitespace"; offset: number; count: number };
} {
  const source = jsonSource(text);
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    const whitespace = escapeStringWhitespace(source);
    if (whitespace) {
      try {
        const repaired = validateObject(JSON.parse(whitespace.source) as unknown, declaredKeys);
        if (!hasDuplicateRootKeys(whitespace.source)) return { value: repaired, repair: { kind: "literal_string_whitespace", offset: whitespace.offset, count: whitespace.count } };
      } catch {
        // Preserve strict failure for incomplete/ambiguous JSON or other defects.
      }
    }
    const offset = rootEnd(source);
    if (offset !== undefined && /^\s*,\s*"(?:[^"\\]|\\.)+"\s*:/.test(source.slice(offset + 1))) {
      const candidate = source.slice(0, offset) + source.slice(offset + 1);
      try {
        const repaired = validateObject(JSON.parse(candidate) as unknown, declaredKeys);
        if (!hasDuplicateRootKeys(candidate)) return { value: repaired, repair: { kind: "premature_root_closing_brace", offset } };
      } catch {
        // Anything other than the one proven redundant delimiter remains a failure.
      }
    }
    throw new Error(`Hermes 输出 JSON 格式无效：${error instanceof Error ? error.message : String(error)}；未截断内容或自动重试模型`);
  }
  return { value: validateObject(value, declaredKeys) };
}
