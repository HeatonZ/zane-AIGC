import assert from "node:assert/strict";
import test from "node:test";
import { AI_MCP_TRANSPORT_CONTRACT, AI_CONTRACT_VERSION } from "./operations.js";
import { createAiOpenApi } from "./openapi.js";
import { AI_OPERATOR_GUIDE } from "./guide.js";
import { AI_FOUNDATION_FEATURES } from "./features.js";

test("MCP 运行同步的机器契约/发现/手册同源，不把运维重启伪装为业务执行接口", () => {
  const api=createAiOpenApi();assert.deepEqual(api["x-mcp-transport"],AI_MCP_TRANSPORT_CONTRACT);
  assert.equal(api.info.version,AI_CONTRACT_VERSION);assert.equal(AI_MCP_TRANSPORT_CONTRACT.mutationReplay,false);
  assert.deepEqual(AI_MCP_TRANSPORT_CONTRACT.errors.map(error=>error.code),["MCP_RESTARTING","MCP_RESPONSE_UNCONFIRMED"]);
  assert.ok(AI_FOUNDATION_FEATURES.some(feature=>feature.id==="mcp-runtime-sync" && feature.operations.includes("get_workbench")));
  assert.match(AI_OPERATOR_GUIDE,/首次升级/);assert.match(AI_OPERATOR_GUIDE,/MCP_RESPONSE_UNCONFIRMED/);assert.match(AI_OPERATOR_GUIDE,/不重放tools\/call/);
  assert.ok(!Object.keys(api.paths).some(route=>route.includes("shutdown") || route.includes("restart")));
});
