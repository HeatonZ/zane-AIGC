import assert from "node:assert/strict";
import test from "node:test";
import { OwnDraftSaveQueue, sameDraftInputs, sameDraftSnapshot, type OwnDraftSaveRequest, type OwnDraftSaveSession } from "./userDraftAutosave.js";

function session(): OwnDraftSaveSession {
  return {
    id: "draft-a", revision: 0, sceneId: "scene-a", versionId: "version-a", title: "草稿", hasServerDraft: false,
    editVersion: 2, savedEditVersion: 0, enqueuedEditVersion: 0,
    reconcileRequired: false, reviewRequired: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("本人草稿自动保存串行使用最新revision并记录确认内容", async () => {
  const writes: OwnDraftSaveRequest[] = [];
  const queue = new OwnDraftSaveQueue(async request => {
    writes.push(request);
    return { draft: { id: request.draftId, revision: request.revision + 1, inputValues: request.inputValues } };
  });
  const current = session();
  const first = queue.save(current, { text: "第一版" }, 1);
  const second = queue.save(current, { text: "第二版" }, 2);
  await Promise.all([first, second]);
  assert.deepEqual(writes.map(item => [item.revision, item.inputValues.text]), [[0, "第一版"], [1, "第二版"]]);
  assert.equal(current.revision, 2);
  assert.equal(current.savedEditVersion, 2);
  assert.deepEqual(current.lastSaved, { editVersion: 2, inputValues: { text: "第二版" } });
});

test("新草稿无内容改动时的显式保存仍会创建服务端记录", async () => {
  const writes: OwnDraftSaveRequest[] = [];
  const queue = new OwnDraftSaveQueue(async request => {
    writes.push(request);
    return { draft: { id: request.draftId, revision: request.revision + 1, inputValues: request.inputValues } };
  });
  const current = session();
  current.editVersion = 0;
  await queue.save(current, { text: "默认值" }, 0);
  assert.equal(writes.length, 1);
  assert.equal(current.hasServerDraft, true);
  assert.equal(current.revision, 1);
});

test("validation rejection can be corrected, while stale revision requires an explicit read", async () => {
  const queue = new OwnDraftSaveQueue(async () => { throw { status: 400 }; });
  const current = session();
  await assert.rejects(queue.save(current, { text: "暂时无效" }, 1));
  assert.equal(current.reconcileRequired, false);
  const staleQueue = new OwnDraftSaveQueue(async () => { throw { status: 409 }; });
  await assert.rejects(staleQueue.save(current, { text: "stale" }, 2));
  assert.equal(current.reconcileRequired, true);
});

test("本人草稿回执未知或revision冲突后不自动重放排队写入", async () => {
  const started = deferred<void>();
  const response = deferred<{ draft: { id: string; revision: number; inputValues: Record<string, unknown> } }>();
  let calls = 0;
  const queue = new OwnDraftSaveQueue(async request => {
    calls += 1;
    if (calls === 1) { started.resolve(); return response.promise; }
    return { draft: { id: request.draftId, revision: request.revision + 1, inputValues: request.inputValues } };
  });
  const current = session();
  const first = queue.save(current, { text: "保存中" }, 1);
  await started.promise;
  const second = queue.save(current, { text: "更新值" }, 2);
  response.reject({ status: 0 });
  await assert.rejects(first);
  await assert.rejects(second);
  assert.equal(calls, 1);
  assert.equal(current.reconcileRequired, true);
  assert.deepEqual(current.failedWrite, { editVersion: 1, inputValues: { text: "保存中" } });
});

test("草稿回执对账比较JSON对象时忽略键顺序", () => {
  assert.equal(sameDraftInputs({ nested: { b: 2, a: 1 }, list: [1, 2] }, { list: [1, 2], nested: { a: 1, b: 2 } }), true);
  assert.equal(sameDraftInputs({ value: 1 }, { value: "1" }), false);
});
test("可选运行标题随草稿一起写入，并在确认与失败快照中保留", async () => {
  const writes: OwnDraftSaveRequest[] = [];
  const queue = new OwnDraftSaveQueue(async request => {
    writes.push(request);
    return { draft: { id: request.draftId, revision: request.revision + 1, inputValues: request.inputValues } };
  });
  const current = session();
  current.runTitle = "第一版";
  await queue.save(current, { text: "内容" }, 1);
  assert.equal(writes[0].runTitle, "第一版");
  assert.deepEqual(current.lastSaved, { editVersion: 1, inputValues: { text: "内容" }, runTitle: "第一版" });
  const clearing = session();
  clearing.revision = 1;
  await queue.save(clearing, { text: "内容" }, 1);
  assert.equal("runTitle" in writes[1], false);
  const failing = new OwnDraftSaveQueue(async () => { throw { status: 409 }; });
  const conflicted = session();
  conflicted.runTitle = "待核对";
  await assert.rejects(failing.save(conflicted, { text: "内容" }, 1));
  assert.deepEqual(conflicted.failedWrite, { editVersion: 1, inputValues: { text: "内容" }, runTitle: "待核对" });
});

test("草稿回执对账同时比较输入与可选运行标题，标题不同不视为已确认", () => {
  assert.equal(sameDraftSnapshot({ inputValues: { a: 1 }, runTitle: "第一版" }, { inputValues: { a: 1 }, runTitle: "第一版" }), true);
  assert.equal(sameDraftSnapshot({ inputValues: { a: 1 }, runTitle: "第一版" }, { inputValues: { a: 1 } }), false);
  assert.equal(sameDraftSnapshot({ inputValues: { a: 1 } }, { inputValues: { a: 1 }, runTitle: "第一版" }), false);
  assert.equal(sameDraftSnapshot({ inputValues: { a: 1 }, runTitle: "第一版" }, { inputValues: { a: 2 }, runTitle: "第一版" }), false);
  assert.equal(sameDraftSnapshot({ inputValues: { a: 1 } }, { inputValues: { a: 1 } }), true);
});

