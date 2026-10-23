import assert from "node:assert/strict";
import test from "node:test";
import { AI_MCP_TRANSPORT_CONTRACT, AI_CONTRACT_VERSION } from "./operations.js";
import { createAiOpenApi } from "./openapi.js";
import { AI_GUIDE_SECTIONS, AI_OPERATOR_GUIDE, AI_OPERATOR_GUIDE_INDEX } from "./guide.js";
import { AI_FOUNDATION_FEATURES } from "./features.js";

test("MCP 运行同步的机器契约/发现/手册同源，不把运维重启伪装为业务执行接口", () => {
  const api=createAiOpenApi();assert.deepEqual(api["x-mcp-transport"],AI_MCP_TRANSPORT_CONTRACT);
  assert.equal(api.info.version,AI_CONTRACT_VERSION);assert.equal(AI_MCP_TRANSPORT_CONTRACT.mutationReplay,false);
  assert.deepEqual(AI_MCP_TRANSPORT_CONTRACT.errors.map(error=>error.code),["MCP_RESTARTING","MCP_RESPONSE_UNCONFIRMED"]);
  assert.ok(AI_FOUNDATION_FEATURES.some(feature=>feature.id==="mcp-runtime-sync" && feature.operations.includes("get_workbench")));
  // 传输层错误码与恢复语义的权威来源是 x-mcp-transport 契约与 docs/mcp-runtime.md；
  // 变更记录是滚动窗口，最早条目会被淘汰，不能把「changelog 里还能搜到」当成契约存在的证据。
  assert.match(JSON.stringify(AI_MCP_TRANSPORT_CONTRACT), /reconcile_original_id/);
  assert.equal(AI_MCP_TRANSPORT_CONTRACT.firstUpgrade, "one_time_client_reload_for_legacy_unsupervised_processes");
  assert.match(AI_OPERATOR_GUIDE,/响应丢失/);
  // 会话级资源已改为伞式目录：目录必须自己指出响应丢失的恢复规则，正文才按节读取。
  assert.match(AI_OPERATOR_GUIDE_INDEX,/响应丢失/);
  assert.equal(AI_OPERATOR_GUIDE.indexOf(AI_OPERATOR_GUIDE_INDEX),0);
  // 分节正文逐个注册为 zane://guide/<节号>，且都是整本手册里的连续文本（不改写、不拼装）。
  assert.ok(AI_GUIDE_SECTIONS.length>=10);assert.ok(AI_GUIDE_SECTIONS.every(section=>section.uri==="zane://guide/"+section.id&&AI_OPERATOR_GUIDE.includes(section.text)));
  assert.ok(!Object.keys(api.paths).some(route=>route.includes("shutdown") || route.includes("restart")));
});
