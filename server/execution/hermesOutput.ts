/** Shared by every core.hermes step, irrespective of profile or scene. */
export const HERMES_OUTPUT_JSON_CONTRACT = {
  version: "3",
  input: "one_json_object_matching_declared_output_keys",
  acceptedWrapper: [
    "optional_full_json_markdown_fence",
    "brace_free_prose_around_exactly_one_complete_root_object",
  ],
  recovery: [
    "remove_one_premature_root_closing_brace_before_another_object_member",
    "escape_literal_lf_cr_tab_inside_json_strings",
    "locate_the_single_complete_root_object_when_every_other_response_character_is_brace_free",
  ],
  recoveryComposition: "one_object_repair_family_only",
  recoveryGuards: [
    "accepted_object_parses_in_full",
    "all_declared_keys_present",
    "no_undeclared_keys",
    "no_duplicate_root_keys",
    "exactly_one_accepted_object",
    "no_braces_outside_the_accepted_object",
  ],
  contentPolicy: "never_truncate_rewrite_or_concatenate; locating_one_complete_root_object_never_drops_a_declared_field_or_a_second_object",
  modelRetry: "none",
  diagnostics: "hermes.output_json_repaired_log_with_step_profile_kind_and_offset_no_content",
  failure: "run_or_step_failed_with_Hermes_output_JSON_message_no_automatic_resubmit",
} as const;

export type HermesOutputRepair =
  | { kind: "premature_root_closing_brace"; offset: number }
  | { kind: "literal_string_whitespace"; offset: number; count: number }
  | { kind: "prose_wrapped_json_object"; offset: number; inner?: HermesOutputRepair };

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
function rootEndFrom(source: string, start: number): number | undefined {
  if (source[start] !== "{") return;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let offset = start; offset < source.length; offset++) {
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

function rootEnd(source: string) {
  return rootEndFrom(source, 0);
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

interface HermesOutputAttempt {
  value: Record<string, unknown>;
  repair?: HermesOutputRepair;
}

/** Strict first, then at most one repair family per candidate source. */
function attemptObject(source: string, declaredKeys: readonly string[]): HermesOutputAttempt | undefined {
  try {
    return { value: validateObject(JSON.parse(source) as unknown, declaredKeys) };
  } catch {
    // Fall through to the single-family repairs below.
  }
  const whitespace = escapeStringWhitespace(source);
  if (whitespace) {
    try {
      const value = validateObject(JSON.parse(whitespace.source) as unknown, declaredKeys);
      if (!hasDuplicateRootKeys(whitespace.source)) {
        return { value, repair: { kind: "literal_string_whitespace", offset: whitespace.offset, count: whitespace.count } };
      }
    } catch {
      // Preserve the strict failure for incomplete/ambiguous JSON or other defects.
    }
  }
  const offset = rootEnd(source);
  if (offset !== undefined && /^\s*,\s*"(?:[^"\\]|\\.)+"\s*:/.test(source.slice(offset + 1))) {
    const candidate = source.slice(0, offset) + source.slice(offset + 1);
    try {
      const value = validateObject(JSON.parse(candidate) as unknown, declaredKeys);
      if (!hasDuplicateRootKeys(candidate)) {
        return { value, repair: { kind: "premature_root_closing_brace", offset } };
      }
    } catch {
      // Anything other than the one proven redundant delimiter remains a failure.
    }
  }
}

/**
 * Locate one complete declared object inside prose, e.g. a gate report, a
 * markdown fence or a closing remark around the JSON. Only usable when the rest
 * of the response contains no braces at all, which proves no second object was
 * skipped, and when exactly one candidate validates the declared key set.
 */
function locateProseObject(text: string, declaredKeys: readonly string[]): HermesOutputAttempt | undefined {
  const accepted: Array<HermesOutputAttempt & { offset: number }> = [];
  const budget = Math.max(4096, text.length * 8);
  let examined = 0;
  for (let index = 0; index < text.length && examined <= budget; index++) {
    if (text[index] !== "{") continue;
    const end = rootEndFrom(text, index);
    if (end === undefined) { examined += text.length - index; continue; }
    examined += end - index;
    const source = text.slice(index, end + 1);
    const attempt = attemptObject(source, declaredKeys);
    if (!attempt) { index = end; continue; }
    const remainder = text.slice(0, index) + text.slice(end + 1);
    // Any brace outside the accepted object could hide skipped content.
    if (!/[{}]/.test(remainder)) accepted.push({ ...attempt, offset: index });
    index = end;
  }
  const only = accepted[0];
  if (!only || accepted.length > 1) return;
  const { value, repair } = only;
  return { value, repair: repair ? { kind: "prose_wrapped_json_object", offset: only.offset, inner: repair } : { kind: "prose_wrapped_json_object", offset: only.offset } };
}

/**
 * Strict first. Then one redundant root brace OR literal string LF/CR/TAB, and
 * finally one complete root object surrounded by brace-free prose. Never combine
 * repair families, truncate, drop a second object, change decoded values or call models.
 */
export function parseHermesOutput(text: string, declaredKeys: readonly string[]): HermesOutputAttempt {
  const source = jsonSource(text);
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    const repaired = attemptObject(source, declaredKeys);
    if (repaired) return repaired;
    const located = locateProseObject(text, declaredKeys);
    if (located) return located;
    throw new Error(`Hermes 输出 JSON 格式无效：${error instanceof Error ? error.message : String(error)}；未截断内容或自动重试模型`);
  }
  return { value: validateObject(value, declaredKeys) };
}
