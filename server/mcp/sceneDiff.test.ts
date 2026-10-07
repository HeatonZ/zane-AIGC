import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { aiHarness } from "../testing/aiSupport.js";
import type { ApiResult } from "./httpClient.js";
import type { SceneDiffPage, SceneDiffValuePage } from "../domain/sceneDiffContracts.js";

test("真实stdio MCP隔离闭环：草稿编辑→diff分页/Unicode值→并发冲突→校验发布→无差异，同源只读无生成", async t => {
  let executions = 0;
  const h = await aiHarness(t, { emptyWorkspace: true, executor: { kind: "fake", async execute() { executions++; return { value: "must-not-run" }; } } });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.resolve("server/mcp/index.ts")], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === "string")), ZANE_BASE_URL: h.base }, stderr: "pipe" });
  let stderr = ""; transport.stderr?.on("data", chunk => { stderr += chunk; });
  const client = new Client({ name: "scene-diff-isolated", version: "1.0.0" });
  t.after(() => client.close());
  try { await client.connect(transport); } catch (error) { throw new Error(String(error) + "\n" + stderr); }
  async function call<T = Record<string, any>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result)); const payload = result.structuredContent as ApiResult; assert.ok(payload.ok); return payload.data as T;
  }
  const tools = await client.listTools();
  for (const name of ["get_scene_draft_diff", "get_scene_draft_diff_value"]) assert.equal(tools.tools.find(tool => tool.name === name)?.annotations?.readOnlyHint, true);
  const made = await call("create_scene", { scene: { id: "mcp-diff", title: "隔离流程" }, workflow: { name: "流程", inputs: [], steps: [{ id: "one", name: "本地步骤", kind: "fake", promptTemplate: "旧提示词", outputs: [{ key: "value", type: "text" }] }], outputs: [{ key: "result", type: "text", sourceRef: "step.one.outputs.value" }] } });
  const unpublished = await call<SceneDiffPage>("get_scene_draft_diff", { sceneId: made.sceneId, valueLimit: 1 }); assert.equal(unpublished.baseline, null);
  const publicationId = randomUUID();
  await call("publish_scene", { sceneId: made.sceneId, revision: made.revision, publicationId });
  assert.equal((await call<SceneDiffPage>("get_scene_draft_diff", { sceneId: made.sceneId })).total, 0);
  const draft = await call("get_scene_draft", { sceneId: made.sceneId });
  const prompt = "😀前缀\n更新提示词\n尾部";
  const updated = await call("update_scene_draft", { sceneId: made.sceneId, revision: draft.revision, workflow: { ...draft.workflow, name: "新流程", steps: [{ ...draft.workflow.steps[0], promptTemplate: prompt }] } });
  const first = await call<SceneDiffPage>("get_scene_draft_diff", { sceneId: made.sceneId, contentHash: updated.contentHash, limit: 1, valueLimit: 2 });
  assert.equal(first.baseline?.versionId, publicationId); assert.equal(first.total, 2); assert.equal(first.changes.length, 1); assert.equal(first.hasMore, true);
  const next = await call<SceneDiffPage>("get_scene_draft_diff", { sceneId: made.sceneId, revision: first.revision, cursor: first.nextCursor, valueLimit: 2 });
  const promptChange = [...first.changes, ...next.changes].find(change => change.path.endsWith("/promptTemplate"))!;
  let text = promptChange.after.text, offset = promptChange.after.nextOffset;
  while (offset !== null) {
    const value = await call<SceneDiffValuePage>("get_scene_draft_diff_value", { sceneId: made.sceneId, revision: first.revision, changeId: promptChange.changeId, side: "after", offset, limit: 2 });
    text += value.value.text; offset = value.value.nextOffset;
  }
  assert.equal(text, prompt);
  // Dropped read receipt: querying the same snapshot returns the same page.
  assert.deepEqual(await call("get_scene_draft_diff", { sceneId: made.sceneId, contentHash: updated.contentHash, revision: first.revision, limit: 1, valueLimit: 2 }), first);
  const invalid = await client.callTool({ name: "get_scene_draft_diff", arguments: { sceneId: made.sceneId, limit: 0 } }); assert.equal(invalid.isError, true);
  const changed = await call("update_scene_draft", { sceneId: made.sceneId, revision: updated.revision, scene: { ...updated.scene, title: "再次更新" } });
  const stale = await client.callTool({ name: "get_scene_draft_diff", arguments: { sceneId: made.sceneId, revision: first.revision, cursor: first.nextCursor } }); assert.equal(stale.isError, true); assert.equal((stale.structuredContent as ApiResult).error?.code, "SCENE_DIFF_CHANGED");
  const staleWrite = await client.callTool({ name: "update_scene_draft", arguments: { sceneId: made.sceneId, revision: updated.revision, scene: updated.scene } }); assert.equal((staleWrite.structuredContent as ApiResult).error?.code, "RESOURCE_REVISION_CONFLICT");
  const fresh = await call<SceneDiffPage>("get_scene_draft_diff", { sceneId: made.sceneId }); assert.equal(fresh.draftRevision, changed.revision);
  const http = await (await fetch(h.base + "/api/v1/scenes/" + made.sceneId + "/draft/diff")).json(); assert.deepEqual(fresh, http);
  await call("validate_scene_draft", { sceneId: made.sceneId, revision: fresh.draftRevision });
  const nextId = randomUUID(); await call("publish_scene", { sceneId: made.sceneId, revision: fresh.draftRevision, publicationId: nextId });
  const done = await call<SceneDiffPage>("get_scene_draft_diff", { sceneId: made.sceneId }); assert.equal(done.baseline?.versionId, nextId); assert.equal(done.hasChanges, false);
  assert.equal(executions, 0); assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);
});
