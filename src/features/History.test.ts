import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import History from "./History.js";
import type { SceneModule, WorkflowDraft } from "../types.js";
const scene: SceneModule = { id: "demo", title: "测试", shortTitle: "测试", summary: "", description: "", cover: "", accent: "green", stages: [] };
const draft: WorkflowDraft = { id: "favorite", sceneId: "demo", title: "常用草稿", summary: "复用", status: "draft", createdAt: "2026-10-05T00:00:00Z", isFavorite: true };
const props = { drafts: [draft], scenes: [scene], onNavigate: () => {}, onOpenScene: () => {}, onSetFavorite: async () => {}, onReconcileFavorites: async () => {}, favoriteBusy: false, favoriteUnknown: false };
test("任务草稿展示已收藏状态、取消收藏入口和服务端说明；旧草稿可收藏", () => {
  const saved = renderToStaticMarkup(createElement(History, props));
  assert.match(saved, /aria-pressed="true"/); assert.match(saved, /取消收藏：常用草稿/); assert.match(saved, /收藏置顶/); assert.match(saved, /收藏保存在服务端/); assert.match(saved, /继续编辑/);
  const legacy = renderToStaticMarkup(createElement(History, { ...props, drafts: [{ ...draft, isFavorite: undefined }] }));
  assert.match(legacy, /aria-pressed="false"/); assert.match(legacy, /收藏：常用草稿/);
});
test("收藏在途禁用重复操作；未知回执显示显式服务端对账入口", () => {
  const pending = renderToStaticMarkup(createElement(History, { ...props, favoriteBusy: true })); assert.match(pending, /disabled=""/);
  const unknown = renderToStaticMarkup(createElement(History, { ...props, favoriteUnknown: true })); assert.match(unknown, /读取服务端收藏状态对账/); assert.match(unknown, /disabled=""/);
});
