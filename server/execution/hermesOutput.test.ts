import assert from "node:assert/strict";
import test from "node:test";
import { HermesOutputParseError, parseHermesJson, parseHermesOutput } from "./hermesOutput.js";

const keys = ["storyboard", "shots"];
const shots = Array.from({ length: 15 }, (_, index) => ({ index: index + 1, seconds: 8, visual_description: `镜头${index + 1}：字符 }, "shots": 不是结构`, dialogue: [] }));
const expected = { storyboard: "15镜，共120秒。\n完整对白与连续性，不截断。", shots };
const broken = JSON.stringify({ storyboard: expected.storyboard }) + ',"shots":' + JSON.stringify(shots) + '}';

test("Hermes strict JSON and full Markdown fence preserve entire declared outputs", () => {
  for (const source of [JSON.stringify(expected), '```json\n' + JSON.stringify(expected) + '\n```', '```\n' + JSON.stringify(expected) + '\n```']) {
    assert.deepEqual(parseHermesOutput(source, keys), { value: expected });
  }
  assert.deepEqual(parseHermesJson('[1, {"a": true}]'), [1, { a: true }]);
});

test("Hermes recovers one premature root brace without dropping any of the 15 shots", () => {
  for (const source of [broken, '```json\n' + broken + '\n```', broken.replace('},"shots":', '}  , \n "shots":')]) {
    const result = parseHermesOutput(source, keys);
    assert.deepEqual(result.value, expected);
    assert.equal(result.repair?.kind, "premature_root_closing_brace");
    assert.equal(result.value.shots instanceof Array && result.value.shots.length, 15);
  }
  // JSON-valued strings remain strict; only the outer Hermes output object is recoverable.
  assert.throws(() => parseHermesJson(broken), SyntaxError);
});

test("Hermes recovery respects escaped quotes, backslashes, braces and nested JSON", () => {
  const value = { storyboard: 'quote " backslash \\ } { [ ] emoji 😺', shots: [{ nested: { a: ["}", { b: "]", c: '\\"' }] } }] };
  const source = JSON.stringify({ storyboard: value.storyboard }) + ',"shots":' + JSON.stringify(value.shots) + '}';
  assert.deepEqual(parseHermesOutput(source, keys).value, value);
});

test("Hermes locates exactly one complete declared object inside brace-free prose", () => {
  const preamble = '说明：以下是提示词 JSON：\n';
  for (const source of [
    preamble + JSON.stringify(expected),
    JSON.stringify(expected) + '\n\n复核：15镜齐全，导出路径 out.json。',
    '两个闸门都全绿，现在输出最终 JSON：\n```json\n' + JSON.stringify(expected) + '\n```\n以上。',
  ]) {
    const result = parseHermesOutput(source, keys);
    assert.deepEqual(result.value, expected);
    assert.equal(result.repair?.kind, "prose_wrapped_json_object");
    assert.equal(result.value.shots instanceof Array && result.value.shots.length, 15);
  }
  assert.deepEqual(parseHermesOutput(preamble + JSON.stringify(expected), keys).repair, { kind: "prose_wrapped_json_object", offset: preamble.length });
});

test("Hermes keeps one object repair when the located object still needs whitespace escaping", () => {
  const text = "商品事实\n保持黑色\r\n禁区\t不虚构参数";
  const object = '{"product_brief":"' + text + '"}';
  const result = parseHermesOutput('说明：\n' + object + '\n完成。', ["product_brief"]);
  assert.deepEqual(result.value, { product_brief: text });
  assert.deepEqual(result.repair, { kind: "prose_wrapped_json_object", offset: 4, inner: { kind: "literal_string_whitespace", offset: object.indexOf("\n"), count: 4 } });
  const value = { storyboard: text, shots: [{ description: "多行\n\t对白\r\n完整" }] };
  const source = '{"storyboard":"' + text + '","shots":[{"description":"多行\n\t对白\r\n完整"}]}';
  const wrapped = parseHermesOutput('复核完成。\n' + source + '\n以上。', keys);
  assert.deepEqual(wrapped.value, value);
  assert.deepEqual(wrapped.repair, { kind: "prose_wrapped_json_object", offset: 6, inner: { kind: "literal_string_whitespace", offset: source.indexOf("\n"), count: 8 } });
});

test("Hermes never locates an object when the remaining text hides structure", () => {
  const invalid = [
    '格式如 {"storyboard":"demo"}，正式内容：\n' + JSON.stringify(expected),
    '第一个对象：\n' + JSON.stringify(expected) + '\n第二个对象：' + JSON.stringify({ storyboard: "other", shots: [] }),
    JSON.stringify(expected) + '\n{"result":"后续小对象"}',
    JSON.stringify(expected) + '\n```json\n{"result":"围栏内小对象"}\n```',
    '未完成：\n' + JSON.stringify({ storyboard: expected.storyboard }).slice(0, -1),
    '未完成：\n' + broken.slice(0, -1),
    '先说一个输入冲突，必\n' + broken + '\n末镜不丢。',
    broken + "额外说明", broken + JSON.stringify(expected),
    JSON.stringify({ storyboard: "only storyboard" }) + ' , "shots": [',
    '{"storyboard":"missing close", "shots": [}',
    '{"storyboard":"wrong nesting"] , "shots": []}',
    '{"storyboard":"first"},"storyboard":"second","shots":[]}',
    '{"storyboard":"first"},"story\\u0062oard":"second","shots":[]}',
    '{"storyboard":"only"},"unknown":[],"shots":[]}',
    '{"storyboard":"only"},"unknown":[]}',
    '{"other":"only"},"shots":[]}',
    '{"storyboard":"only"},"shots":[]},"extra":1}',
    '```json\n' + broken + '\n```\n解释',
    JSON.stringify({ storyboard: "only" }) + JSON.stringify({ shots: [] }),
    '[{"storyboard":"only"}],"shots":[]}',
  ];
  for (const source of invalid) assert.throws(() => parseHermesOutput(source, keys), /Hermes 输出 JSON 格式无效/, source);
});

test("Hermes retains strict object, missing-key and undeclared-key validation", () => {
  for (const source of ['null', '[]', '42', '"text"']) assert.throws(() => parseHermesOutput(source, keys), /必须是 JSON 对象/);
  assert.throws(() => parseHermesOutput('{"storyboard":"only"}', keys), /缺少字段：shots/);
  assert.throws(() => parseHermesOutput('{"storyboard":"only","shots":[],"extra":true}', keys), /未声明字段：extra/);
  assert.throws(() => parseHermesOutput('{}', ["toString"]), /缺少字段：toString/);
});


test("Hermes repairs literal LF/CR/TAB in text without changing decoded content", () => {
  const text = "商品事实\n保持黑色\r\n禁区\t不虚构参数";
  const source = '{"product_brief":"' + text + '"}';
  for (const wrapped of [source, '```json\n' + source + '\n```']) {
    const result = parseHermesOutput(wrapped, ["product_brief"]);
    assert.deepEqual(result.value, { product_brief: text });
    assert.deepEqual(result.repair, { kind: "literal_string_whitespace", offset: source.indexOf("\n"), count: 4 });
  }
  assert.throws(() => parseHermesJson(source), SyntaxError, "JSON-valued strings remain strict");
  assert.deepEqual(parseHermesOutput(JSON.stringify({ product_brief: text }), ["product_brief"]), { value: { product_brief: text } });
});

test("Hermes string whitespace repair preserves nested arrays, escapes and structural whitespace", () => {
  const value = { storyboard: 'quote " backslash \\ literal \\n\n } [ ] 😺', shots: [{ description: "多行\n\t对白\r\n完整" }, { description: "末镜不丢" }] };
  const source = JSON.stringify(value, null, 2).replace(/\\n/g, (match, offset, all) => all[offset - 1] === "\\" ? match : "\n").replace(/\\r/g, "\r").replace(/\t/g, "\t");
  const result = parseHermesOutput(source, keys);
  assert.deepEqual(result.value, value);
  assert.equal(result.repair?.kind, "literal_string_whitespace");
  assert.deepEqual(parseHermesOutput(JSON.stringify(value, null, 2), keys), { value });
});

test("Hermes whitespace repair never accepts ambiguous fields, partial JSON or stacked repairs", () => {
  const source = '{"storyboard":"one\ntwo","shots":[]}';
  const invalid = [
    source + source,
    source.replace(',"shots":[]', ''),
    source.replace(',"shots":[]', ',"unknown":[],"shots":[]'),
    source.replace(',"shots":[]', ',"storyboard":"second","shots":[]'),
    source.replace(',"shots":[]', ',"story\\u0062oard":"second","shots":[]'),
    source.slice(0, -1), source.replace(',"shots":[]', ',"shots":['),
    source.replace(',"shots":[]', '},"shots":[]'),
    source.replace("one\ntwo", "one\\\ntwo"),
    source.replace("one\ntwo", "one\u0000two"),
    source.replace("one\ntwo", "one\ntwo\u000bthree"),
    '说明：' + source + '\n补充：{"shots":[]}',
  ];
  for (const candidate of invalid) assert.throws(() => parseHermesOutput(candidate, keys), /Hermes 输出 JSON 格式无效/, candidate);
});

test("Hermes merges a list continuation and re-closes a wrong final bracket without changing values", () => {
  const continuation = '{"prompts":["first prompt"],"second prompt"]}';
  const merged = parseHermesOutput(continuation, ["prompts"]);
  assert.deepEqual(merged.value, { prompts: ["first prompt", "second prompt"] });
  assert.deepEqual(merged.repair, { kind: "premature_list_closer", offset: continuation.indexOf("],") });

  const wrongCloser = '{"prompts":["A complete prompt line"]';
  const closed = parseHermesOutput(wrongCloser, ["prompts"]);
  assert.deepEqual(closed.value, { prompts: ["A complete prompt line"] });
  assert.deepEqual(closed.repair, { kind: "final_closer_type_repair", offset: wrongCloser.length - 1 });

  // A member key is never welded onto the located object, and an empty list closed by the
  // wrong bracket is never invented into an empty member.
  assert.throws(() => parseHermesOutput('{"prompts":["first"],"other":"value"}', ["prompts"]), /Hermes 输出/);
  assert.throws(() => parseHermesOutput('{"prompts": [}', ["prompts"]), /Hermes 输出 JSON 格式无效/);
});

test("Hermes keeps only the re-emitted object when a streamed fragment is cut off", () => {
  const text = '{"prompt":"partial fragment cut off' + '{"prompt":"the complete final prompt"}';
  const result = parseHermesOutput(text, ["prompt"]);
  assert.deepEqual(result.value, { prompt: "the complete final prompt" });
  assert.equal(result.repair?.kind, "streamed_residual_reemit");
});

test("Hermes completes a single root whose nested brackets carry the wrong type", () => {
  // A member list closed by `]` where its object still needed `}`: nesting depth
  // alone still locates the one root, and only delimiters are rewritten.
  const broken = '{"visual_bible":{"axes":["angle","scale"]],"cards":[{"id":"card one"}]}';
  const repaired = parseHermesOutput(broken, ["visual_bible", "cards"]);
  assert.deepEqual(Object.keys(repaired.value), ["visual_bible", "cards"]);
  assert.deepEqual((repaired.value.visual_bible as { axes: string[] }).axes, ["angle", "scale"]);
  assert.equal(repaired.repair?.kind, "wrong_bracket_type_completion");

  // An empty mis-closed list invents nothing, and an unclosed root stays a failure.
  assert.throws(() => parseHermesOutput('{"visual_bible":[}', ["visual_bible"]), /Hermes 输出 JSON 格式无效/);
  assert.throws(() => parseHermesOutput('{"visual_bible":{"a":"b"}', ["visual_bible"]), /Hermes 输出 JSON 格式无效/);
});

test("Hermes keeps the valid path untouched and still fails ambiguous, prose-shaped or content-level output", () => {
  assert.deepEqual(parseHermesOutput(JSON.stringify({ prompts: ["x"] }), ["prompts"]), { value: { prompts: ["x"] } });
  // Two complete answers are ambiguous delivery, not a fragment plus a re-emission.
  assert.throws(
    () => parseHermesOutput(JSON.stringify({ result: "first complete answer" }) + JSON.stringify({ result: "second complete answer" }), ["result"]),
    /Hermes 输出 JSON 格式无效/,
  );
  // Prose-shaped keys are never accepted as structured output (fails as a Hermes output error).
  assert.throws(() => parseHermesOutput('{"subject_definitions:\nA block of prose":"x"}', ["prompts"]), /Hermes 输出/);
  // A cut-off single root keeps the published failure wording and is classed retryable for the executor.
  assert.throws(() => parseHermesOutput('{"prompts":["only one closed item"', ["prompts"]), (error: unknown) => {
    assert.ok(error instanceof HermesOutputParseError);
    assert.equal(error.code, "HERMES_OUTPUT_JSON_INVALID");
    assert.equal(error.transient, true);
    assert.match(error.message, /^Hermes 输出 JSON 格式无效：/);
    assert.match(error.message, /；未截断内容或自动重试模型$/);
    return true;
  });
  // A content-level answer is neither repaired nor retryable.
  assert.throws(() => parseHermesOutput("这不是 JSON 输出", ["prompts"]), (error: unknown) => {
    assert.ok(error instanceof HermesOutputParseError);
    assert.equal(error.transient, false);
    assert.match(error.message, /^Hermes 输出 JSON 格式无效：/);
    return true;
  });
});
