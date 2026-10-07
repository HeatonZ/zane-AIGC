import assert from "node:assert/strict";
import test from "node:test";
import { isNewWorkbenchRelease } from "./RuntimeUpdateNotice";

test("版本提示只比较明确的新release，缺失/无版本/相同版本不触发",()=>{
  for (const response of [null,{},"new",{releaseId:1},{releaseId:"unversioned"},{releaseId:"same"}]) assert.equal(isNewWorkbenchRelease("same",response),false);
  assert.equal(isNewWorkbenchRelease("same",{releaseId:"new"}),true);
  assert.equal(isNewWorkbenchRelease("unversioned",{releaseId:"new"}),false);
});
