import assert from "node:assert/strict";
import test from "node:test";
import { normalizePromptSectionHeadings } from "./promptSections.js";

test("section normalization changes only exact declared header prefixes, never body text", () => {
  const source = '  FIRST : value\nquoted FIRST: and 详细描述: must stay unchanged\n\t详细描述: 0-8秒；Dialogue: "你好"\nUnknown: untouched\n';
  const normalized = normalizePromptSectionHeadings(source, ["first", "details"], { "详细描述": "details" });
  assert.equal(normalized, 'first: value\nquoted FIRST: and 详细描述: must stay unchanged\ndetails: 0-8秒；Dialogue: "你好"\nUnknown: untouched\n');
  assert.equal(normalizePromptSectionHeadings(normalized, ["first", "details"], { "详细描述": "details" }), normalized);
});

test("section normalization preserves gaps, duplicate sections, order and punctuation for caller validation", () => {
  const source = '\n First:\n\n FIRST:\nsecond：fullwidth colon is not accepted\n';
  assert.equal(normalizePromptSectionHeadings(source, ["first", "second"]), '\nfirst:\n\nfirst:\nsecond：fullwidth colon is not accepted\n');
  assert.equal(normalizePromptSectionHeadings("unchanged", []), "unchanged");
  assert.throws(() => normalizePromptSectionHeadings("alias:", ["first"], { alias: "missing" }), /未声明段落/);
});

test("section normalization escapes declared names rather than accepting regexp wildcards", () => {
  assert.equal(normalizePromptSectionHeadings("a.b: yes\naxb: no\n", ["a.b"]), "a.b: yes\naxb: no\n");
});
