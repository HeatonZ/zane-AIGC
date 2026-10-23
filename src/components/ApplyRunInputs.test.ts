import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/** 取出 applyRunInputs 函数体：按大括号配平截取，不靠「下一个函数名」猜边界。 */
function applyRunInputsBody(source: string): string {
  const start = source.indexOf("async function applyRunInputs");
  assert.ok(start >= 0, "找不到 applyRunInputs");
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart, index + 1);
    }
  }
  throw new Error("applyRunInputs 函数体没有闭合");
}

/**
 * 「用这组参数」必须复用同一份 reusableInputs 校验，不能在工作台里另写一套。
 * 否则会出现：从运行详情套用参数是安全的，从工作台套用却把已删除字段硬塞进表单。
 */
test("工作台就地套用参数：走同一份 reusableInputs 校验，不跳页重开服务", async () => {
  const portal = await readFile("src/features/UserPortal.tsx", "utf8");
  const body = applyRunInputsBody(portal);
  // 必须调用共用的校验函数，而不是自己判断字段是否合法。
  assert.match(portal, /import \{ reusableInputs \} from "\.\.\/lib\/packageRunInputs"/);
  assert.match(body, /reusableInputs\(page\.inputs as never, activePackage\.fields as never\)/);
  // 读的是该次运行的原始输入快照（字段与值都取自提交当时）。
  assert.match(body, /\/api\/v1\/self\/package-runs\/" \+ encodeURIComponent\(packageRunId\) \+ "\/inputs/);
  // 就地填回表单：合并默认值 + 重新预检。
  assert.match(body, /const next = \{ \.\.\.activePackage\.inputDefaults, \.\.\.reusable\.values \}/);
  assert.match(body, /setPackageValues\(next\)/);
  assert.match(body, /refreshEstimate\(next\)/);
  assert.doesNotMatch(body, /openPackage\(/, "就地套用不应重新打开服务（会丢掉当前工作台状态）");
  // 复用了哪些、丢了哪些必须说清楚，不能静默少填。
  assert.match(body, /setNotice\(reusable\.notice\)/);
});

test("结果区与历史条都提供套用入口；读取期间按钮禁用，避免连点重复请求", async () => {
  const portal = await readFile("src/features/UserPortal.tsx", "utf8");
  assert.match(portal, /function workspaceResultActions/);
  assert.match(portal, /用这组参数/);
  assert.match(portal, /sws-history-reuse/);
  assert.match(portal, /disabled=\{Boolean\(reuseBusy\)\}/);
  assert.match(portal, /resultActions=\{workspaceResultActions\(\)\}/);
  const workspace = await readFile("src/components/ServiceWorkspace.tsx", "utf8");
  assert.match(workspace, /resultActions\?: ReactNode/);
  assert.match(workspace, /sws-canvas-actions/);
});

test("套用不改变计费与审核路径：只填表单，不提交也不创建运行", async () => {
  const portal = await readFile("src/features/UserPortal.tsx", "utf8");
  const body = applyRunInputsBody(portal);
  assert.doesNotMatch(body, /submitPackage\(/, "套用参数不应直接提交运行");
  assert.doesNotMatch(body, /\/runs"/, "套用参数不应创建运行");
});
