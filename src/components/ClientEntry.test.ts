import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * 客户端不设独立首页：打开就落在服务页。
 * 产品上「服务」就是客户要的东西，先看一屏介绍再点进去是多余的一步。
 */
test("客户端没有独立首页：默认页面就是服务页，导航只有服务与作品", async () => {
  const portal = await readFile("src/features/UserPortal.tsx", "utf8");
  // 默认页是 services，不存在 home 这个页面状态。
  assert.match(portal, /const \[page, setPage\] = useState<ClientPage>\("services"\)/);
  assert.doesNotMatch(portal, /"home"/, "页面类型与导航里都不应再有 home");
  assert.doesNotMatch(portal, /page === "home"/);
  // 导航只剩服务、作品；账户与反馈走顶栏图标。
  const navLine = portal.split("\n").find(line => line.includes("const navItems: Array<[ClientPage, string]>"))!;
  assert.match(navLine, /\["services", "服务"\]/);
  assert.match(navLine, /\["results", "作品"\]/);
  assert.doesNotMatch(navLine, /首页/);
});

test("进服务页时仍加载服务目录、进行中任务与积分", async () => {
  const portal = await readFile("src/features/UserPortal.tsx", "utf8");
  // 去掉首页后，这些数据必须仍在服务页加载，否则「进行中」和余额会空着。
  const effect = portal.slice(portal.indexOf('if (page === "services") void attempt'));
  assert.match(effect, /await loadPackages\(\)/);
  assert.match(effect, /await loadPackageRuns\(\)/);
  assert.match(effect, /await loadCredits\(\)/);
  assert.match(effect, /await loadRuns\(\)/);
  // 进行中列表被并入服务页（不是随首页一起删掉）。
  assert.match(portal, /\{activeRuns\.length > 0 && <section className="zclient-section">/);
});

test("只授权一个服务时直接进服务页，但仍能退回目录", async () => {
  const portal = await readFile("src/features/UserPortal.tsx", "utf8");
  // 自动进入只在列表恰好一条时发生，并且只自动发生一次。
  assert.match(portal, /list\.length === 1 && !autoOpenedOnce\.current/);
  assert.match(portal, /autoOpenedOnce\.current = true/);
  // 点顶部「服务」必须回到目录，否则用户被锁在服务页里出不来。
  assert.match(portal, /if \(nextPage === "services"\) setActivePackage\(undefined\)/);
});
