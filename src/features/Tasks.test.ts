import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Tasks from "./Tasks.js";

// SSR 不执行 useEffect，因此这里验证的是首屏结构与安全默认值：不能因为渲染就提交运行。
test("任务页首屏：说明任务与任务草稿的区别，并明确创建不执行", () => {
  const html = renderToStaticMarkup(createElement(Tasks, {}));
  assert.match(html, /一个任务包含多个任务项/);
  assert.match(html, /确认后全自动批量提交/);
  assert.match(html, /创建只保存中间态草稿，不提交运行、不生成、不计费/);
  assert.match(html, /粘贴导入/);
  assert.match(html, /添加一项/);
});

test("任务页：没有已发布场景时给出明确提示，并禁用创建", () => {
  const html = renderToStaticMarkup(createElement(Tasks, {}));
  // 首屏尚无场景目录：创建按钮必须禁用，避免提交必然失败的草稿。
  assert.match(html, /当前没有已发布场景/);
  assert.match(html, /任务项只能引用已发布版本/);
  assert.match(html, /disabled=""/);
});

test("任务页渲染不发起任何执行：只有创建/刷新入口，没有提交运行的入口", () => {
  const html = renderToStaticMarkup(createElement(Tasks, {}));
  assert.match(html, /创建任务（待确认）/);
  assert.match(html, /刷新任务/);
  // 确认与重跑只在选中已确认任务后才出现，首屏不得出现这两个按钮。
  // 断言按按钮而不是按词：用法说明里会出现「确认」「重跑」这些描述性文字。
  assert.doesNotMatch(html, /确认并批量提交<\/button>/);
  assert.doesNotMatch(html, /重跑<\/button>/);
});

test("任务页说明输入来自发布版契约：默认值自动带出、示例可填充、媒体走素材库", () => {
  const html = renderToStaticMarkup(createElement(Tasks, {}));
  // 输入填写入口必须在首屏可见，否则几十项只能靠手写 JSON。
  assert.match(html, /新项自动带出该场景发布版的默认值/);
  assert.match(html, /必填媒体请从素材库选择/);
  assert.match(html, /示例不会伪造素材引用/);
  // 素材选择器只在点击后挂载，首屏不应出现弹窗。
  assert.doesNotMatch(html, /从素材库选择素材/);
});

test("任务页的批量录入入口：添加一项与粘贴导入都在首屏", () => {
  const html = renderToStaticMarkup(createElement(Tasks, {}));
  assert.match(html, /添加一项/);
  assert.match(html, /粘贴导入/);
  // 行内容由 useEffect 拉取后填充，SSR 首屏 tbody 为空：这里只断言入口存在，
  // 行级行为由 taskInput/taskApi 的单测覆盖。
  assert.match(html, /task-table/);
});

test("任务页说明用法步骤，不用让人猜任务怎么用", () => {
  const html = renderToStaticMarkup(createElement(Tasks, {}));
  assert.match(html, /1 添加项/);
  assert.match(html, /2 每项选场景/);
  assert.match(html, /3 填输入/);
  assert.match(html, /4 创建/);
  assert.match(html, /5 确认/);
  // 创建不执行这条安全承诺必须一直在。
  assert.match(html, /不提交、不生成、不计费/);
  assert.match(html, /失败项可单独重跑/);
});

test("任务页明确支持一个任务混用多个场景，避免被当成单场景限制", () => {
  const html = renderToStaticMarkup(createElement(Tasks, {}));
  assert.match(html, /一个任务可以混合多个场景/);
  assert.match(html, /各自选场景与发布版，互不影响/);
  // 下拉决定「模板用哪个场景」与「新增行的初始场景」，不能让人以为整批只有一个场景。
  // 用 <label>默认场景 精确匹配裸标签：写成 /默认场景/ 会误伤「模板场景」等。
  assert.match(html, /模板场景/);
  assert.doesNotMatch(html, /<label>默认场景/);
});

test("任务页用纵向布局，编辑表格不被挤成窄列", () => {
  const html = renderToStaticMarkup(createElement(Tasks, {}));
  // .access-grid 的 auto-fit 会在 1100px 容器里切多列，把宽表格压窄。
  assert.match(html, /task-layout/);
  assert.doesNotMatch(html, /class="access-grid"/);
});

test("任务页提供 CSV 模板导出与导入，几十行不用手填", () => {
  const html = renderToStaticMarkup(createElement(Tasks, {}));
  // 按钮说的是「该场景」：模板只含所选场景的列，不能让人以为会导出所有场景的字段。
  assert.match(html, /导出该场景模板/);
  assert.doesNotMatch(html, /导出 CSV 模板/);
  assert.match(html, /导入 CSV/);
  assert.match(html, /CSV 是宽表/);
  // 明确模板只含所选场景的列，多场景要分别导出。
  assert.match(html, /模板只含所选场景的输入列/);
  // 说明媒体列怎么填，否则用户只会手写文件名。
  assert.match(html, /从素材库复制固定版本引用/);
  // 行数可调，默认 10。
  assert.match(html, /task-rowcount/);
});
