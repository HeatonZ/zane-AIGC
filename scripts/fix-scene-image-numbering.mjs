/** Restore 图1/图2 reference-image numbering to scene prompts that hand raw attachments to a model.
 * Dry-run by default. --apply saves the draft; --apply --publish publishes explicitly.
 * Never submits runs, modifies ComfyUI graphs, restarts services or writes a database directly. */
import { workbenchFetch } from "./workbench-auth.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { SCENE_REFERENCE_IMAGE_PATCHES, scenePatchesFor } from "../server/domain/sceneReferenceImageNumbering.ts";

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    apply: { type: "boolean", default: false },
    publish: { type: "boolean", default: false },
    scene: { type: "string", default: "all" },
    "allow-draft-diff": { type: "boolean", default: false },
    "base-url": { type: "string", default: "http://127.0.0.1:8799" },
    "output-dir": { type: "string", default: `backups/scene-image-numbering-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}` },
  } });
  assert.ok(!values.publish || values.apply, "--publish requires --apply");
  const base = new URL(values["base-url"]);
  assert.ok(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) && !base.username && !base.password, "Only the local workbench can be patched");
  const patches = scenePatchesFor(values.scene);
  const json = async (route, body, method = "POST") => {
    const response = await workbenchFetch(new URL(route, base), { ...(body ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      const detail = await response.text();
      if (response.status === 401) throw Error(`${route}: HTTP 401 需要工作台凭证；请设置 ZANE_API_TOKEN（管理后台 → 用户管理 → 本人 AI 凭证）后重试：${detail}`);
      throw Error(`${route}: HTTP ${response.status} ${detail}`);
    }
    return response.json();
  };
  const idle = async () => {
    const health = await json("/api/health", undefined, "GET");
    assert.equal(health.storage, "sqlite");
    assert.ok(health.worker.ready && health.worker.accepting);
    for (const key of ["active", "queued", "preparing"]) assert.equal(health.worker[key], 0, `Workbench has ${key} runs; stop before changing a published scene`);
  };
  if (values.apply) await idle();
  const before = (await json("/api/workspace", undefined, "GET")).workspace;
  assert.ok(before, "No initialized workspace");
  const output = path.resolve(values["output-dir"]);
  await mkdir(output, { recursive: true });
  const report = { format: "zane-scene-image-numbering/v1", baseUrl: base.origin, startedAt: new Date().toISOString(), apply: values.apply, publish: values.publish, modelJobsSubmitted: 0, comfyGraphsModified: false, plans: [] };
  const save = () => writeFile(path.join(output, "prompt-patch-plan.json"), JSON.stringify(report, null, 2));
  await save();

  for (const patch of patches) {
    const draft = await json(`/api/v1/scenes/${patch.sceneId}/draft`, undefined, "GET");
    assert.equal(draft.scene.title, patch.title, `场景身份不符：${patch.sceneId} 期望 ${patch.title}，实际 ${draft.scene.title}`);
    assert.ok(draft.publishedVersionId, `缺少已发布场景：${patch.title}`);
    if (!draft.draftMatchesPublished) assert.ok(values["allow-draft-diff"], `${patch.title} 草稿有未发布改动；先人工核对，或显式加 --allow-draft-diff`);
    const { workflow, changes } = patch.apply(draft.workflow);
    const plan = { sceneId: patch.sceneId, title: patch.title, originalRevision: draft.revision, previousPublishedVersionId: draft.publishedVersionId, publicationId: randomUUID(), changes, status: "planned" };
    report.plans.push(plan);
    await save();
    console.log(`##### ${patch.title} (${patch.sceneId})`);
    for (const step of workflow.steps) {
      const beforeStep = (draft.workflow.steps ?? []).find(item => item.id === step.id);
      if (JSON.stringify(beforeStep) === JSON.stringify(step)) continue;
      console.log(`--- ${step.id} (${step.name}) after:\n${step.promptTemplate ?? ""}\n`);
    }
    if (!changes.length) { console.log(`${patch.title}：已经是修复后的提示词，无需改动\n`); continue; }
    if (!values.apply) { console.log("Dry run only. Re-run with --apply to save drafts, --apply --publish to publish explicitly.\n"); continue; }
    try {
      const saved = await json(`/api/v1/scenes/${patch.sceneId}/draft`, { revision: plan.originalRevision, workflow }, "PATCH");
      plan.revision = saved.revision;
      plan.status = "draft_saved";
      await save();
      const validation = await json(`/api/v1/scenes/${patch.sceneId}/validate`, { revision: saved.revision });
      assert.equal(validation.valid, true, `${patch.title} 草稿校验失败`);
      plan.status = "validated";
      await save();
      if (values.publish) {
        const published = await json(`/api/v1/scenes/${patch.sceneId}/publish`, { revision: saved.revision, publicationId: plan.publicationId });
        assert.equal(published.versionId, plan.publicationId);
        plan.version = published.version;
        plan.status = "published";
        await save();
      }
    } catch (error) {
      plan.status = "inspect_before_retry";
      plan.error = String(error);
      plan.nextAction = { draft: `/api/v1/scenes/${patch.sceneId}/draft`, publication: `/api/v1/scenes/${patch.sceneId}?versionId=${plan.publicationId}` };
      await save();
      throw Error(`${patch.title} 补丁中断且不重放。先读保存的 ID/revision 对账：${path.join(output, "prompt-patch-plan.json")}\n${error}`);
    }
  }

  if (values.apply) {
    const after = (await json("/api/workspace", undefined, "GET")).workspace;
    const touched = new Set(patches.map(patch => patch.sceneId));
    for (const id of Object.keys(before.workflows)) if (!touched.has(id)) assert.deepEqual(after.workflows[id], before.workflows[id], `无关流程被改动：${id}`);
    for (const id of Object.keys(before.sceneVersions)) if (!touched.has(id)) assert.deepEqual(after.sceneVersions[id], before.sceneVersions[id], `无关场景版本被改动：${id}`);
    await writeFile(path.join(output, "workspace-after.json"), JSON.stringify(after, null, 2));
    if (!values.publish) console.log("草稿已保存并校验；核对后用 --apply --publish 显式发布，发布不提交运行。");
  }
  console.log(JSON.stringify({ output, apply: values.apply, publish: values.publish, modelJobsSubmitted: 0, plans: report.plans.map(plan => ({ sceneId: plan.sceneId, title: plan.title, status: plan.status, changes: plan.changes })) }, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1; });
