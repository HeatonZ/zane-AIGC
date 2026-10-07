import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "./sqliteStore.js";
import { temporaryDirectory, id, workflow } from "../testing/testSupport.js";
import { runArtifactPaths } from "../artifacts/runArtifacts.js";
import type { RunRecord } from "../domain/types.js";

test("SQLite v1 升级保留工作区、运行、步骤、事件与提交快照，新增文档具备版本冲突保护", async t => {
  let store: SqliteStore | undefined;
  const root = await temporaryDirectory(t, () => store?.close());
  const filename = path.join(root, "metadata.db");
  const project = path.join(root, "project");
  store = new SqliteStore(filename);
  const definition = workflow();
  const run: RunRecord = { runId: id("migration"), sceneId: definition.sceneId!, workflowName: definition.name!,
    status: "completed", createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z",
    steps: [{stepId: "first", name: "第一步", status: "completed", outputs: {value: "旧数据"}}],
    outputs: [{key: "result", label: "结果", type: "text", value: "旧数据"}], inputValues: {}, workflow: definition,
    artifacts: runArtifactPaths(project, id("migration")) };
  const workspace = store.saveWorkspace({scenes: [{id: "old-scene"}]});
  const submission = {workflow: definition, inputValues: {story: "旧提交"}};
  store.createRun(project, run, submission);
  store.markImported(project);
  const events = store.events(project, run.runId);
  store.close(); store = undefined;
  const legacy = new DatabaseSync(filename);
  legacy.exec("DROP TABLE production_documents; PRAGMA user_version = 1;");
  legacy.close();
  store = new SqliteStore(filename);
  assert.deepEqual(store.getWorkspace(), workspace);
  assert.deepEqual(store.getRun(project, run.runId), run);
  assert.deepEqual(store.getSubmission(project, run.runId), submission);
  assert.deepEqual(store.events(project, run.runId), events);
  assert.ok(store.hasImported(project));
  const saved = store.putDocument(project, "assets", {id: "asset", revision: 0, name: "素材"}, 0);
  assert.equal(saved.revision, 1);
  assert.deepEqual(store.getDocument(project, "assets", "asset"), saved);
  assert.throws(() => store!.putDocument(project, "assets", saved, 0), /DOCUMENT_CONFLICT/);
  const inspect = new DatabaseSync(filename);
  assert.equal(inspect.prepare("PRAGMA user_version").get()!.user_version, 2);
  assert.equal(inspect.prepare("SELECT COUNT(*) n FROM run_steps").get()!.n, 1);
  inspect.close();
});

test("数据库版本高于当前支持版本时拒绝打开", async t => {
  const root = await temporaryDirectory(t);
  const filename = path.join(root, "future.db");
  const future = new DatabaseSync(filename);
  future.exec("PRAGMA user_version = 3;");
  future.close();
  assert.throws(() => new SqliteStore(filename), /高于当前应用支持的版本 2/);
});
