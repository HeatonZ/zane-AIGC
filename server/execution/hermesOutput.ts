/** Shared by every core.hermes step, irrespective of profile or scene. */
import { jsonrepair } from "jsonrepair";

export const HERMES_OUTPUT_JSON_CONTRACT = {
  version: "3",
  input: "one_json_object_matching_declared_output_keys",
  acceptedWrapper: [
    "optional_full_json_markdown_fence",
    "brace_free_prose_around_exactly_one_complete_root_object",
    "streamed_residual_fragment_followed_by_a_full_re_emission",
  ],
  recovery: [
    "remove_one_premature_root_closing_brace_before_another_object_member",
    "escape_literal_lf_cr_tab_inside_json_strings",
    "locate_the_single_complete_root_object_when_every_other_response_character_is_brace_free",
    "locate_the_last_declared_root_object_when_the_response_is_a_streamed_residual_plus_re_emission",
    "complete_one_located_root_object_with_bounded_syntax_operations",
    "drop_one_list_closer_that_ended_a_list_before_it_continued_with_another_element",
    "rewrite_the_final_closer_when_it_closes_the_only_root_with_the_wrong_bracket_type",
    "complete_one_located_root_object_whose_nested_brackets_carry_the_wrong_type",
  ],
  recoveryComposition: "one_object_repair_family_only",
  recoveryGuards: [
    "accepted_object_parses_in_full",
    "all_declared_keys_present",
    "no_undeclared_keys",
    "no_duplicate_root_keys",
    "exactly_one_accepted_object",
    "no_braces_outside_the_accepted_object",
    "content_trust_gate_on_short_identifier_keys_and_at_least_one_substantive_value",
  ],
  contentTrustGate: "key_names_at_most_40_chars_without_newline_colon_or_cjk_punctuation_and_at_least_one_substantive_value",
  boundedCompletion: "at_most_three_syntax_operations_inside_one_located_object_under_a_state_budget_no_model_no_network",
  repairDependency: "jsonrepair_3_15_0_offline_no_runtime_network_and_no_runtime_dependency",
  modelRetry: "none",
  diagnostics: "hermes.output_json_repaired_log_with_step_profile_kind_and_offset_no_content",
  failure: "run_or_step_failed_with_Hermes_output_JSON_message_no_automatic_resubmit",
} as const;

export type HermesOutputRepair =
  | { kind: "premature_root_closing_brace"; offset: number }
  | { kind: "literal_string_whitespace"; offset: number; count: number }
  | { kind: "prose_wrapped_json_object"; offset: number; inner?: HermesOutputRepair }
  | { kind: "streamed_residual_reemit"; offset: number }
  | { kind: "completed_residual_repair"; offset: number; operations: number }
  | { kind: "premature_list_closer"; offset: number }
  | { kind: "final_closer_type_repair"; offset: number }
  | { kind: "wrong_bracket_type_completion"; offset: number; operations: number };

/**
 * Output-contract failure the executor can classify without matching message text.
 *
 * `transient` is true only for the stream-artifact signature: the response carries a
 * second declared root object, or its single declared root object never closes. An
 * upstream cut-off can produce that shape, so an executor may treat it as retryable
 * when the step explicitly opts in. Every other failure is a content-level defect
 * that resubmitting would reproduce.
 */
export class HermesOutputParseError extends Error {
  readonly code = "HERMES_OUTPUT_JSON_INVALID";
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "HermesOutputParseError";
    this.transient = transient;
  }
}

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

/**
 * End of the root object at `start` when bracket *type* mismatches are tolerated:
 * nesting depth alone decides where the object ends. Used only to locate the
 * single declared root that a wrong bracket type left unclosed; the located
 * slice is then completed by bounded syntax operations and must still pass the
 * full acceptance gate, so a wrong type is never taken on trust.
 */
function looseRootEndFrom(source: string, start: number): number | undefined {
  if (source[start] !== "{") return;
  let depth = 0;
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
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (!depth) return offset;
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

function validateObject(value: unknown, declaredKeys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} 输出必须是 JSON 对象`);
  const result = value as Record<string, unknown>;
  const declared = new Set(declaredKeys);
  const extra = Object.keys(result).filter(key => !declared.has(key));
  if (extra.length) throw new Error(`${label} 输出包含未声明字段：${extra.join("、")}`);
  for (const key of declaredKeys) if (!Object.hasOwn(result, key)) throw new Error(`${label} 输出缺少字段：${key}`);
  return result;
}

interface HermesOutputAttempt {
  value: Record<string, unknown>;
  repair?: HermesOutputRepair;
}

/** Strict first, then at most one repair family per candidate source. */
function attemptObject(source: string, declaredKeys: readonly string[], label: string): HermesOutputAttempt | undefined {
  try {
    return { value: validateObject(JSON.parse(source) as unknown, declaredKeys, label) };
  } catch {
    // Fall through to the single-family repairs below.
  }
  const whitespace = escapeStringWhitespace(source);
  if (whitespace) {
    try {
      const value = validateObject(JSON.parse(whitespace.source) as unknown, declaredKeys, label);
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
      const value = validateObject(JSON.parse(candidate) as unknown, declaredKeys, label);
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
function locateProseObject(text: string, declaredKeys: readonly string[], label: string): HermesOutputAttempt | undefined {
  const accepted: Array<HermesOutputAttempt & { offset: number }> = [];
  const budget = Math.max(4096, text.length * 8);
  let examined = 0;
  for (let index = 0; index < text.length && examined <= budget; index++) {
    if (text[index] !== "{") continue;
    const end = rootEndFrom(text, index);
    if (end === undefined) { examined += text.length - index; continue; }
    examined += end - index;
    const source = text.slice(index, end + 1);
    const attempt = attemptObject(source, declaredKeys, label);
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

/* ------------------------------------------------------------------ *
 * Streamed-residual families, added because a live upstream can deliver
 * an answer, get cut off, and then re-emit the whole object from the
 * start; the gateway joins both halves with no separator. The result is a
 * broken leading fragment followed by a complete object, which the
 * conservative families above reject by design (two declared roots, or a
 * root that never closes). Only the located object is ever completed.
 * ------------------------------------------------------------------ */

/** Content trust gate: a repaired object must look like structured output, not prose. */
const CONTENT_TRUST_MAX_KEY_LENGTH = 40;
const CONTENT_TRUST_KEY_FORBIDDEN = /[\n\r\t:，。；：！？、（）【】《》“”‘’]/;
function contentTrustPass(value: Record<string, unknown>) {
  const keys = Object.keys(value);
  if (!keys.length) return false;
  for (const key of keys) {
    if (!key.length || key.length > CONTENT_TRUST_MAX_KEY_LENGTH) return false;
    if (CONTENT_TRUST_KEY_FORBIDDEN.test(key)) return false;
  }
  return Object.values(value).some(item =>
    typeof item === "string"
      ? item.trim().length >= 8
      : Array.isArray(item)
        ? item.length > 0
        : Boolean(item && typeof item === "object"));
}

/** Every offset in `text` where a root object starts with one of the declared keys. */
function declaredRootStarts(text: string, declaredKeys: readonly string[]) {
  if (!declaredKeys.length) return [] as number[];
  const alternation = declaredKeys.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`\\{\\s*"(?:${alternation})"\\s*:`, "g");
  const starts: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) starts.push(match.index);
  return starts;
}

/** True when the response carries the upstream partial-delivery signature. */
function streamedArtifactSignature(text: string, declaredKeys: readonly string[]) {
  const starts = declaredRootStarts(text, declaredKeys);
  if (starts.length > 1) return true;
  const only = starts[0];
  return only !== undefined && rootEndFrom(text, only) === undefined;
}

/** Remove commas that sit directly before a closing brace or bracket. */
function dropTrailingComma(source: string) {
  let out = "";
  let inString = false;
  let escaped = false;
  let count = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; out += char; continue; }
    if (char === ",") {
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next]!)) next++;
      if (next >= source.length || source[next] === "}" || source[next] === "]") { count++; continue; }
    }
    out += char;
  }
  return count ? out : undefined;
}

function openStack(source: string) {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") stack.pop();
  }
  return { stack, inString };
}

/** Append whatever closers (and an unterminated string) the object still needs. */
function appendMissingClosers(source: string) {
  const { stack, inString } = openStack(source);
  if (!stack.length && !inString) return undefined;
  const tail = (inString ? '"' : "") + [...stack].reverse().map(open => open === "{" ? "}" : "]").join("");
  return tail ? source + tail : undefined;
}

/** Rewrite the final closer so it closes every still-open level. */
function syncFinalCloser(source: string) {
  if (!source.length) return undefined;
  const last = source.slice(-1);
  if (last !== "}" && last !== "]") return undefined;
  const { stack, inString } = openStack(source.slice(0, -1));
  if (inString || !stack.length) return undefined;
  const tail = [...stack].reverse().map(open => open === "{" ? "}" : "]").join("");
  return tail === last ? undefined : source.slice(0, -1) + tail;
}

/** Drop exactly one structural delimiter (bounded to punctuation positions). */
function dropOneDelimiter(source: string) {
  const out: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "}" || char === "]" || char === ",") out.push(source.slice(0, index) + source.slice(index + 1));
  }
  return out;
}

/** A keyed array literal ( `["key": value]` ) whose members need object braces. */
function wrapKeyedArrayElements(source: string) {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char !== "[") continue;
    if (!/^\[\s*"(?:[^"\\]|\\.)*"\s*:/.test(source.slice(index, index + 400))) continue;
    let depth = 0;
    let innerString = false;
    let innerEscaped = false;
    let start = index + 1;
    const elements: Array<[number, number]> = [];
    let closed = -1;
    for (let scan = index + 1; scan < source.length; scan++) {
      const current = source[scan]!;
      if (innerString) {
        if (innerEscaped) innerEscaped = false;
        else if (current === "\\") innerEscaped = true;
        else if (current === '"') innerString = false;
        continue;
      }
      if (current === '"') innerString = true;
      else if (current === "{" || current === "[") depth++;
      else if (current === "}" || current === "]") {
        if (depth === 0 && current === "]") { closed = scan; elements.push([start, scan]); break; }
        depth--;
      } else if (current === "," && depth === 0) { elements.push([start, scan]); start = scan + 1; }
    }
    if (closed < 0) continue;
    let rebuilt = source.slice(0, index + 1);
    for (let at = 0; at < elements.length; at++) {
      const [from, to] = elements[at]!;
      rebuilt += `{${source.slice(from, to).trim()}}`;
      if (to !== closed) rebuilt += ",";
    }
    return rebuilt + source.slice(closed);
  }
  return undefined;
}

/** Library repair, applied only to a located candidate and never to the whole response. */
function jsonRepairSource(source: string) {
  try {
    const repaired = jsonrepair(source);
    const text = typeof repaired === "string" ? repaired : JSON.stringify(repaired);
    return text && text !== source ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rewrite each bracket whose type contradicts the still-open level (a list
 * closed by `}`, a member object closed by `]`). String bodies are never
 * touched, so no decoded value can change; only the delimiter that could not
 * have been legal stays rewritten. Bounded: after `MAX_BRACKET_TYPE_FIXES`
 * rewrites a remaining mismatch makes the whole attempt fail.
 */
const MAX_BRACKET_TYPE_FIXES = 2;
function normalizeBracketTypes(source: string): { text: string; fixes: number } | undefined {
  let text = source;
  let fixes = 0;
  for (;;) {
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    let fixedAt = -1;
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === "{" || char === "[") { stack.push(char); continue; }
      if (char !== "}" && char !== "]") continue;
      const want = char === "}" ? "{" : "[";
      const open = stack.pop();
      if (open === want) continue;
      if (fixes >= MAX_BRACKET_TYPE_FIXES) return;
      text = text.slice(0, index) + (open === "{" ? "}" : "]") + text.slice(index + 1);
      fixedAt = index;
      fixes++;
      break;
    }
    if (fixedAt < 0) return { text, fixes };
  }
}

const MAX_COMPLETION_DEPTH = 3;
const MAX_COMPLETION_STATES = 64;

function completionCandidates(source: string) {
  const next: string[] = [];
  const whitespace = escapeStringWhitespace(source);
  if (whitespace) next.push(whitespace.source);
  const trailingComma = dropTrailingComma(source);
  if (trailingComma) next.push(trailingComma);
  const closers = appendMissingClosers(source);
  if (closers) next.push(closers);
  const synced = syncFinalCloser(source);
  if (synced) next.push(synced);
  const wrapped = wrapKeyedArrayElements(source);
  if (wrapped) next.push(wrapped);
  next.push(...dropOneDelimiter(source));
  const repaired = jsonRepairSource(source);
  if (repaired) next.push(repaired);
  return next;
}

/** Accept a candidate only when it parses, matches the declared keys and passes the gate. */
function acceptCandidate(source: string, declaredKeys: readonly string[]) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const declared = new Set(declaredKeys);
  const keys = Object.keys(record);
  if (keys.length !== declaredKeys.length) return undefined;
  if (keys.some(key => !declared.has(key))) return undefined;
  if (hasDuplicateRootKeys(source)) return undefined;
  if (!contentTrustPass(record)) return undefined;
  return record;
}

/** Bounded breadth-first completion of one located object. */
function completeLocatedObject(slice: string, declaredKeys: readonly string[]) {
  const direct = acceptCandidate(slice, declaredKeys);
  if (direct) return { value: direct, operations: 0 };
  const seen = new Set([slice]);
  let frontier = [slice];
  for (let depth = 1; depth <= MAX_COMPLETION_DEPTH; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const candidate of completionCandidates(current)) {
        if (seen.has(candidate) || seen.size > MAX_COMPLETION_STATES) continue;
        seen.add(candidate);
        const value = acceptCandidate(candidate, declaredKeys);
        if (value) return { value, operations: depth };
        next.push(candidate);
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  return undefined;
}

/**
 * The text before a located object must not already contain a complete root
 * object: that shape is a genuinely ambiguous response (two whole answers, or a
 * worked example before the real one), not a cut-off fragment. A streamed
 * fragment never closes its root, so it stays allowed.
 */
function prefixIsFragmentsOrProse(prefix: string, _declaredKeys: readonly string[]) {
  for (let index = 0; index < prefix.length; index++) {
    if (prefix[index] !== "{") continue;
    const end = rootEndFrom(prefix, index);
    if (end === undefined) continue;
    // A complete root object in the debris makes the accepted object ambiguous,
    // whichever declared keys it happens to use.
    return false;
  }
  return true;
}

/**
 * Locate the last declared root object in a streamed residual-plus-re-emission
 * response. The accepted object must close on its own (a cut-off root is a
 * truncated answer, never a repair), must be brace-free outside itself, and the
 * preceding debris must be fragment or prose only. Only that one slice is ever
 * completed, never the surrounding debris.
 */
function locateStreamedResidual(text: string, declaredKeys: readonly string[]): HermesOutputAttempt | undefined {
  const starts = declaredRootStarts(text, declaredKeys);
  let examined = 0;
  const budget = Math.max(4096, text.length * 8);
  for (let at = starts.length - 1; at >= 0; at--) {
    const start = starts[at]!;
    const end = rootEndFrom(text, start);
    if (end === undefined) { examined += text.length - start; if (examined > budget) return; continue; }
    const slice = text.slice(start, end + 1);
    examined += slice.length;
    if (examined > budget) return;
    const completed = completeLocatedObject(slice, declaredKeys);
    if (!completed) continue;
    // Debris after the object could hide a second answer.
    if (/[{}]/.test(text.slice(end + 1))) continue;
    if (!prefixIsFragmentsOrProse(text.slice(0, start), declaredKeys)) continue;
    return {
      value: completed.value,
      repair: completed.operations === 0
        ? { kind: "streamed_residual_reemit", offset: start }
        : { kind: "completed_residual_repair", offset: start, operations: completed.operations },
    };
  }
  return;
}

/**
 * A list closer that ended an object or array before the same list continued
 * with another element. Dropping exactly that one closer merges the
 * continuation back into the list under the same declared root object.
 * The continuation must be a bare element, never a member key, so a genuine
 * extra member is never welded onto the accepted object.
 */
function locatePrematureListCloser(text: string, declaredKeys: readonly string[]): HermesOutputAttempt | undefined {
  const starts = declaredRootStarts(text, declaredKeys);
  if (starts.length !== 1 || starts[0] !== 0) return;
  const budget = Math.max(4096, text.length * 8);
  let examined = 0;
  for (const offset of closerBeforeElementOffsets(text)) {
    examined += text.length;
    if (examined > budget) return;
    const candidate = text.slice(0, offset) + text.slice(offset + 1);
    const value = acceptCandidate(candidate, declaredKeys);
    if (value) return { value, repair: { kind: "premature_list_closer", offset } };
  }
  return;
}

/** Every `]`/`}` outside a string followed by `,` and a bare string element (never a `"key":` member). */
function closerBeforeElementOffsets(text: string) {
  const offsets: number[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char !== "]" && char !== "}") continue;
    let cursor = index + 1;
    while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++;
    if (text[cursor] !== ",") continue;
    cursor++;
    while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++;
    if (text[cursor] !== '"') continue;
    const literal = stringLiteralEnd(text, cursor);
    if (literal === undefined) continue;
    let after = literal + 1;
    while (after < text.length && /\s/.test(text[after]!)) after++;
    if (text[after] === ":") continue;   // a member key: that belongs to the other repair family
    offsets.push(index);
    // Bound downstream candidate parsing and string-literal scans to a fixed
    // number of full-text passes, even for delimiter-dense untrusted output.
    if (offsets.length >= 8) return offsets;
  }
  return offsets;
}

/** End offset of the string literal starting at `start`, or undefined when it never closes. */
function stringLiteralEnd(text: string, start: number) {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === "\\") { index++; continue; }
    if (text[index] === '"') return index;
  }
  return;
}

/**
 * The response's only declared root object is closed with the wrong bracket
 * type (a list closed by `}`), so the root never closes. Only the final
 * closer is rewritten to close every still-open level, and only when the
 * mis-closed list already carries a complete element: an empty list tells us
 * nothing about what was meant, so nothing is invented there.
 */
function locateWrongFinalCloser(text: string, declaredKeys: readonly string[]): HermesOutputAttempt | undefined {
  const starts = declaredRootStarts(text, declaredKeys);
  if (starts.length !== 1 || starts[0] !== 0) return;
  if (rootEndFrom(text, 0) !== undefined) return;
  const last = text.slice(-1);
  if (last !== "}" && last !== "]") return;
  const body = text.slice(0, -1);
  const { stack, inString } = openStack(body);
  if (inString || !stack.length || stack[stack.length - 1] !== "[") return;
  const trimmed = body.replace(/\s+$/, "");
  if (trimmed.endsWith("[") || trimmed.endsWith(",") || trimmed.endsWith(":")) return;
  const tail = [...stack].reverse().map(open => (open === "{" ? "}" : "]")).join("");
  const value = acceptCandidate(body + tail, declaredKeys);
  if (!value) return;
  return { value, repair: { kind: "final_closer_type_repair", offset: body.length } };
}

/**
 * The response's only declared root object never closes because a nested
 * bracket was written with the wrong type (a list closed by `}`, or a member
 * object closed by `]`). The object's extent is still unambiguous — nesting
 * depth alone locates it — so that one located slice gets its bracket types
 * normalized and is then completed with the bounded syntax operations above.
 * It is accepted only when the result parses in full, matches the declared
 * keys exactly and passes the content trust gate.
 *
 * Nothing outside the located slice is ever touched, string bodies are never
 * rewritten, and a response whose bracket types are consistent (so the strict
 * locator already returned) never reaches this family.
 */
function locateLooseRootCompletion(source: string, declaredKeys: readonly string[]): HermesOutputAttempt | undefined {
  const starts = declaredRootStarts(source, declaredKeys);
  if (starts.length !== 1 || starts[0] !== 0) return;
  if (rootEndFrom(source, 0) !== undefined) return;
  const end = looseRootEndFrom(source, 0);
  if (end === undefined) return;
  // Debris after the located object could hide a second answer.
  if (/[{}]/.test(source.slice(end + 1))) return;
  const normalized = normalizeBracketTypes(source.slice(0, end + 1));
  if (!normalized || normalized.fixes === 0) return;
  const completed = completeLocatedObject(normalized.text, declaredKeys);
  if (!completed) return;
  return {
    value: completed.value,
    repair: { kind: "wrong_bracket_type_completion", offset: end, operations: normalized.fixes + completed.operations },
  };
}

/**
 * Strict first. Then one redundant root brace OR literal string LF/CR/TAB, then
 * one complete root object surrounded by brace-free prose, and finally the
 * streamed-residual families, which complete exactly one located object with
 * bounded syntax operations. Never concatenate two objects, truncate a located
 * object, drop a second object that itself validates, change decoded values, or
 * call models.
 *
 * `label` only changes the user-visible service name in failures; the default keeps
 * core.hermes wording byte-identical, and core.llm's direct mode passes 直连模型提供商.
 */
export function parseHermesOutput(text: string, declaredKeys: readonly string[], label = "Hermes"): HermesOutputAttempt {
  const source = jsonSource(text);
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    const repaired = attemptObject(source, declaredKeys, label);
    if (repaired) return repaired;
    const located = locateProseObject(text, declaredKeys, label);
    if (located) return located;
    const streamed = locateStreamedResidual(source, declaredKeys);
    if (streamed) return streamed;
    const listCloser = locatePrematureListCloser(source, declaredKeys);
    if (listCloser) return listCloser;
    const wrongCloser = locateWrongFinalCloser(source, declaredKeys);
    if (wrongCloser) return wrongCloser;
    const looseRoot = locateLooseRootCompletion(source, declaredKeys);
    if (looseRoot) return looseRoot;
    throw new HermesOutputParseError(
      `${label} 输出 JSON 格式无效：${error instanceof Error ? error.message : String(error)}；未截断内容或自动重试模型`,
      streamedArtifactSignature(source, declaredKeys),
    );
  }
  return { value: validateObject(value, declaredKeys, label) };
}
