import assert from "node:assert/strict";
import test from "node:test";
import { parseHermesJson, parseHermesOutput } from "./hermesOutput.js";

const keys = ["storyboard", "shots"];
const shots = Array.from({ length: 15 }, (_, index) => ({ index: index + 1, seconds: 8, visual_description: `镜头${index + 1}：字符 }, \"shots\": 不是结构`, dialogue: [] }));
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
