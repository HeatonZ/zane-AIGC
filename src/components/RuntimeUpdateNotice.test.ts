import assert from "node:assert/strict";
import test from "node:test";
import { isNewWorkbenchRelease, shouldPollRelease } from "./RuntimeUpdateNotice";

test("版本提示只比较明确的新release，缺失/无版本/相同版本不触发",()=>{
  for (const response of [null,{},"new",{releaseId:1},{releaseId:"unversioned"},{releaseId:"same"}]) assert.equal(isNewWorkbenchRelease("same",response),false);
  assert.equal(isNewWorkbenchRelease("same",{releaseId:"new"}),true);
  assert.equal(isNewWorkbenchRelease("unversioned",{releaseId:"new"}),false);
});

test("被公网用户入口拒绝的管理员身份不再重复轮询，换身份后恢复",()=>{
  // The public entry answers 403 PUBLIC_USER_ONLY for an administrator session; that answer
  // cannot change for the same identity, so re-asking every 15s only floods the log window.
  assert.equal(shouldPollRelease("admin-1","admin-1"),false);
  assert.equal(shouldPollRelease("admin-1",""),true);
  // A different login on the same tab is a different question and must be asked again.
  assert.equal(shouldPollRelease("user-2","admin-1"),true);
  // No identity yet: nothing to ask, and no credential to send.
  assert.equal(shouldPollRelease("","admin-1"),false);
});
