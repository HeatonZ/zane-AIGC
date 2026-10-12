import assert from "node:assert/strict";
import test from "node:test";
import { HERMES_MODEL_SELECTION_CONTRACT, hermesModelSelectionError, hermesRequestModelFields } from "./hermesModelSelection.js";

test("省略 provider/model 时请求体保持历史行为", () => {
  for (const selection of [undefined, {}, { provider: undefined, model: undefined }, { provider: "", model: "  " }]) {
    assert.deepEqual(hermesRequestModelFields(selection?.provider, selection?.model), { model: "hermes-agent" });
  }
  assert.equal(HERMES_MODEL_SELECTION_CONTRACT.version, 1);
});

test("只选 provider、只选模型、两者都选分别映射到请求字段", () => {
  assert.deepEqual(hermesRequestModelFields("custom:my-chat", undefined), { model: "hermes-agent", provider: "custom:my-chat" });
  assert.deepEqual(hermesRequestModelFields(undefined, "anthropic/claude-opus-5"), { model: "anthropic/claude-opus-5" });
  assert.deepEqual(hermesRequestModelFields(" opencode-zen ", " gpt-5.6-terra "), { model: "gpt-5.6-terra", provider: "opencode-zen" });
});

test("provider/model 校验拒绝超长、空白与控制字符，接受真实目录值", () => {
  assert.equal(hermesModelSelectionError(undefined, undefined), undefined);
  assert.equal(hermesModelSelectionError("custom:my-chat", "jet-hub-auto/auto"), undefined);
  assert.equal(hermesModelSelectionError("nous", "anthropic/claude-fable-5.1"), undefined);
  for (const value of ["a".repeat(81), "a".repeat(201)]) {
    const provider = value.length > 100 ? undefined : value;
    const model = value.length > 100 ? value : undefined;
    assert.ok(hermesModelSelectionError(provider, model));
  }
  assert.match(String(hermesModelSelectionError("has space", undefined)), /Provider/);
  assert.match(String(hermesModelSelectionError(undefined, "line\nbreak")), /模型/);
  assert.match(String(hermesModelSelectionError(1, undefined)), /文本/);
  assert.match(String(hermesModelSelectionError(undefined, "  ")), /不能为空/);
});
