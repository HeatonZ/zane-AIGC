import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CopyableId from "./CopyableId";

const id = "0f3c9a52-8a1e-4d7b-9f10-2b6c5d4e7a81";

test("客户端任务编号完整可见，复制按钮与 title 使用完整编号", () => {
  const html = renderToStaticMarkup(createElement(CopyableId, { id }));
  assert.match(html, new RegExp(id));
  assert.match(html, /复制/);
  assert.match(html, new RegExp(`aria-label="复制任务编号 ${id}"`));
  assert.match(html, new RegExp(`title="${id}"`));
});

test("紧凑编号只缩短显示，复制目标仍是完整编号", () => {
  const html = renderToStaticMarkup(createElement(CopyableId, { id, label: "编号", compact: true }));
  assert.match(html, />编号</);
  assert.match(html, new RegExp(`title="${id}"`));
  assert.match(html, new RegExp(`aria-label="复制编号 ${id}"`));
  assert.ok(!html.includes(`>${id}<`), "紧凑模式不直接铺满完整编号");
});

test("结果页与任务记录都展示服务运行编号", async () => {
  const portal = await readFile("src/features/UserPortal.tsx", "utf8");
  // 结果详情卡：完整编号（对账/报障用）。
  assert.match(portal, /<CopyableId id=\{packageRun\.packageRunId\} \/>/);
  // 任务记录：每条都是完整编号，不用展开详情才能拿到。
  assert.match(portal, /<CopyableId id=\{item\.packageRunId\} \/>/);
  // 首屏「进行中」空间有限，只显示短编号；点开详情即完整编号。
  assert.match(portal, /<CopyableId id=\{item\.packageRunId\} label="编号" compact \/>/);
  assert.ok((portal.match(/CopyableId/g) ?? []).length >= 4, "结果页、任务记录、进行中列表都要有编号入口");
});
