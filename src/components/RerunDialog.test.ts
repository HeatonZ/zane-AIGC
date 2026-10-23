import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 回归：正文滚动区曾经是 <fieldset className="rerun-dialog-body">。Chromium 不滚动
// fieldset 的内容盒：scrollHeight 会正常增长，但 scrollTop 恒为 0，正文超长时底部
// （提示词、原结果、执行计划）永远滚不到。这里锁住「滚动区是 div、禁用语义在内层
// fieldset」的结构，避免以后为了少一层 DOM 又把它合回 fieldset。
test("局部重做对话框的正文滚动区是 div，禁用语义保留在内层 fieldset", async () => {
  const dialog = await readFile(new URL("../components/RerunDialog.tsx", import.meta.url), "utf8");
  assert.match(dialog, /<div className="rerun-dialog-body">/);
  assert.match(dialog, /<fieldset className="rerun-dialog-fields" disabled=\{submitting\}>/);
  // 滚动容器绝不能退回 fieldset。
  assert.doesNotMatch(dialog, /<fieldset className="rerun-dialog-body"/);

  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.rerun-dialog-body \{ min-height: 0; overflow-y: auto;/);
  assert.match(styles, /fieldset\.rerun-dialog-fields \{ border: 0; margin: 0; padding: 0; min-width: 0; \}/);
  // 内层 fieldset 也要保留原来的 .field-group 间距，避免少一层后间距丢失。
  assert.match(styles, /\.rerun-dialog-body > \.field-group, \.rerun-dialog-fields > \.field-group \{ margin: 16px 0; \}/);
  // 旧规则如果残留，会再次把 fieldset 变成滚动容器。
  assert.doesNotMatch(styles, /fieldset\.rerun-dialog-body/);
});
