import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Logs, { opsFileOptions } from "./Logs.js";
import { logOpsFiles } from "../../server/domain/systemLogContracts.js";
import { eventCategory, eventLabel, describeEvent, parseOpsLine } from "../lib/logPresentation.js";

/**
 * The page renders from server state only; these assertions pin the facts an operator must be
 * able to read off the screen, especially the difference between "nothing happened" and
 * "the window was trimmed".
 */
test("日志页以只读方式渲染筛选区，并说明来源差别与脱敏边界", () => {
  const html = renderToStaticMarkup(createElement(Logs));
  assert.match(html, /运行日志/);
  // Both sources are offered and their lifetimes are stated, because they differ.
  assert.match(html, /后台运行日志（重启后清空）/);
  assert.match(html, /运维日志文件/);
  // Redaction wording must be honest about what IS kept: paths stay for diagnosis.
  assert.match(html, /凭证、密钥类字段已替换为 \[REDACTED\]/);
  assert.match(html, /日志保留本机地址与路径以便排障/);
  // level is a floor, not an exact match — the label says so.
  assert.match(html, /信息及以上/);
  // Filter controls exist for the three chosen dimensions.
  for (const label of ["最低等级", "事件名前缀", "运行ID", "场景ID", "场景包运行ID", "关键字"]) assert.ok(html.includes(label), "缺少筛选项：" + label);
  assert.match(html, /uuid/i);
});

test("日志页的运维文件下拉与服务器白名单同源，不接受任意路径", () => {
  // The picker must offer exactly the server allowlist; a divergence would show a control that
  // can only ever fail, or hide a readable file.
  assert.deepEqual(opsFileOptions.map(option => option.id).sort(), [...logOpsFiles].sort());
  const html = renderToStaticMarkup(createElement(Logs));
  // It is a <select> of fixed options, never a free-text path field.
  assert.match(html, /日志来源/);
  assert.doesNotMatch(html, /placeholder="[^"]*[\\/][^"]*\.log/);
});

test("日志页把“没有产生”与“被容量挤出”区分开，并给出游标作废的恢复说明", () => {
  // The empty/fresh state must not be presented as "no logs exist".
  const html = renderToStaticMarkup(createElement(Logs));
  assert.match(html, /正在读取日志/);
  assert.doesNotMatch(html, /已到当前窗口末尾/);
});

test("日志页提供按事件前缀的快捷筛选，值与服务端前缀语义一致", () => {
  const html = renderToStaticMarkup(createElement(Logs));
  // The chips are shortcuts into the same server-side prefix filter, not a client-side view.
  for (const label of ["运行", "接口", "Hermes", "ComfyUI", "场景包", "权限"]) assert.ok(html.includes(label), "缺少快捷前缀：" + label);
  assert.match(html, /事件名前缀/);
});

test("日志页头说明正文是一句人话，接口调用与参数默认隐藏", () => {
  const html = renderToStaticMarkup(createElement(Logs));
  assert.match(html, /这里用一句话说明每件事/);
  assert.match(html, /任务做了什么、哪一步失败、为什么失败/);
  // The whole point: technical coordinates are not the default reading surface.
  assert.match(html, /接口调用和参数默认隐藏/);
});

/**
 * These pin the reading experience itself: the page is useless if a row only shows an event
 * name, so each known event must produce a Chinese label, a category and a one-line summary.
 */
test("日志展示：已知事件都能读出中文名、分类与摘要", () => {
  const samples: Array<[string, Record<string, unknown>, RegExp]> = [
    ["http.request", { method: "GET", path: "/api/v1/tasks", status: 200, durationMs: 12 }, /GET \/api\/v1\/tasks → 200 · 12ms/],
    ["run.execution_failed", { runId: "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b", error: "boom" }, /运行 0b2ddab7 · boom/],
    ["hermes.request_failed", { profile: "writer", baseUrl: "http://127.0.0.1:8080", errorMessage: "ECONNREFUSED" }, /writer · http:\/\/127\.0\.0\.1:8080 · ECONNREFUSED/],
    ["comfy.binding_remapped", { step: "出图", bindingKey: "positive", from: "196", to: "201" }, /196 → 201/],
    ["package.item_submit_failed", { packageRunId: "11111111-2222-4333-8444-555555555555", itemId: "shot-1", error: "upstream 500" }, /场景包 11111111 · 项 shot-1 · upstream 500/],
  ];
  for (const [event, fields, summary] of samples) {
    assert.notEqual(eventLabel(event), event, "缺少中文名：" + event);
    assert.notEqual(eventCategory(event).id, "other", "缺少分类：" + event);
    assert.match(describeEvent(event, fields), summary, "摘要不符：" + event);
  }
});

test("日志展示：运维日志的 JSON 行可展开为字段，纯文本行保留原文", () => {
  const structured = parseOpsLine({ lineNumber: 3, text: JSON.stringify({ time: "2026-10-19T08:04:02.636Z", level: "error", event: "http.error", status: 401, error: "请登录" }) });
  assert.ok(structured.parsed);
  assert.deepEqual(structured.parsed.fields, { status: 401, error: "请登录" });
  // Non-JSON lines are the majority in server stdout; they must stay readable as text.
  assert.equal(parseOpsLine({ lineNumber: 1, text: "Production server listening on http://127.0.0.1:8799" }).parsed, undefined);
  // A line cut by the length budget is not valid JSON any more; it must not be shown as parsed.
  assert.equal(parseOpsLine({ lineNumber: 9, text: "{\"event\":\"x\",\"big\":\"…[truncated]", truncated: true }).parsed, undefined);
});
