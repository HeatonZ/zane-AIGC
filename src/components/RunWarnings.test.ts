import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RunWarnings from "./RunWarnings";

test("无警告不展示提示；警告正文转义且使用非错误语义", () => {
  assert.equal(renderToStaticMarkup(createElement(RunWarnings, {})), "");
  assert.equal(renderToStaticMarkup(createElement(RunWarnings, { warnings: [] })), "");
  const html = renderToStaticMarkup(createElement(RunWarnings, { warnings: ["<script>bad()</script>", "段落顺序建议"] }));
  assert.match(html, /role="note"/);
  assert.match(html, /aria-label="非阻断提示"/);
  assert.match(html, /⚠/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|role="alert"/);
});
