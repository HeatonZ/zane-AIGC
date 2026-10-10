import { workbenchFetch } from "./workbench-auth.mjs";
/** Migrate the long-text-to-video scene to the MiniMaxH3 director console (Easy-Media multi-track project).
 * Dry-run by default. --apply saves the draft; --apply --publish publishes explicitly.
 * Never submits runs, modifies ComfyUI graphs, restarts services, or writes a database directly. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { DIRECTOR_CONSOLE_WORKFLOW_FILE, migrateLongTextToDirectorConsole } from "../server/domain/directorConsoleMigration.ts";

export const DIRECTOR_CONSOLE_TARGET = Object.freeze({
  sceneId: "scene_long_text_to_video",
  title: "长文出视频",
  previousWorkflowFile: "Zane/MiniMax+H3+真·上下文无缝无色差长视频，SelfLift双采(简易版)+.json",
});

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    apply: { type: "boolean", default: false }, publish: { type: "boolean", default: false },
    "allow-version-prune": { type: "boolean", default: false },
    "base-url": { type: "string", default: "http://127.0.0.1:8799" },
    "output-dir": { type: "string", default: `backups/director-console-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}` },
  } });
  assert.ok(!values.publish || values.apply, "--publish requires --apply");
  const base = new URL(values["base-url"]);
  assert.ok(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) && !base.username && !base.password, "Only the local workbench can be migrated");
  const json = async (route, body, method = "POST") => {
    const r = await workbenchFetch(new URL(route, base), { ...(body ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw Error(`${route}: HTTP ${r.status} ${await r.text()}`);
    return r.json();
  };
  const idle = async () => {
    const health = await json("/api/health");
    assert.equal(health.storage, "sqlite");
    assert.ok(health.worker.ready && health.worker.accepting);
    for (const key of ["active", "queued", "preparing"]) assert.equal(health.worker[key], 0, `Workbench has ${key} runs; stop before changing production configuration`);
  };
  if (values.apply) await idle();
  const before = (await json("/api/workspace")).workspace;
  assert.ok(before, "No initialized workspace");
  const settings = await json("/api/settings");
  const comfyBase = new URL(settings.comfyuiBaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(comfyBase.hostname) && !comfyBase.username && !comfyBase.password, "Read only the configured local ComfyUI");
  const summary = await json(`/api/comfyui/workflow?filename=${encodeURIComponent(DIRECTOR_CONSOLE_WORKFLOW_FILE)}`);
  const consoleNodes = summary.nodes ?? [];
  assert.ok(consoleNodes.some(node => node.type === "easy multiTrackEditor"), `ComfyUI 中缺少导演台编辑器节点：${DIRECTOR_CONSOLE_WORKFLOW_FILE}`);
  const draft = await json(`/api/v1/scenes/${DIRECTOR_CONSOLE_TARGET.sceneId}/draft`);
  assert.equal(draft.scene.title, DIRECTOR_CONSOLE_TARGET.title, "Scene identity changed; review before proceeding");
  assert.ok(draft.publishedVersionId, `Missing published scene: ${DIRECTOR_CONSOLE_TARGET.title}`);
  const workflow = migrateLongTextToDirectorConsole(draft.workflow, consoleNodes);
  const alreadyMigrated = draft.draftMatchesPublished && isDeepStrictEqual(workflow, draft.workflow);
  const publishedSnapshot = await json(`/api/v1/scenes/${DIRECTOR_CONSOLE_TARGET.sceneId}?versionId=${draft.publishedVersionId}`);
  const preservedDiff = [];
  for (const field of ["name", "inputs"]) {
    const left = JSON.stringify(draft.workflow[field] ?? null);
    const right = JSON.stringify(publishedSnapshot.workflow[field] ?? null);
    if (left !== right) {
      assert.ok(field === "inputs", `草稿在 ${field} 上有未发布改动且迁移不保留该字段，请先核对`);
      assert.ok(JSON.stringify(workflow.inputs ?? null) === left, "迁移必须原样保留草稿的输入契约");
      preservedDiff.push(field);
    }
  }
  const untouchedSteps = ["writer", "aixg", "align", "references", "records"];
  for (const id of untouchedSteps) {
    const before = JSON.stringify((draft.workflow.steps ?? []).find(step => step.id === id) ?? null);
    const after = JSON.stringify((publishedSnapshot.workflow.steps ?? []).find(step => step.id === id) ?? null);
    assert.equal(before, after, `步骤 ${id} 在草稿与发布版之间已有差异，请先人工核对再迁移`);
  }
  // Publication keeps the newest 10 by array order (server slice(-10)); announce the array head.
const prunedVersion = draft.versions.length >= 10 ? draft.versions[0] : undefined;
  if (values.publish && !alreadyMigrated) {
    assert.ok(!prunedVersion || values["allow-version-prune"], `发布会裁剪最旧版本 ${prunedVersion?.version ?? ""}；确认备份后加 --allow-version-prune`);
  }
  const plans = [{ sceneId: DIRECTOR_CONSOLE_TARGET.sceneId, title: DIRECTOR_CONSOLE_TARGET.title, publicationId: alreadyMigrated ? draft.publishedVersionId : randomUUID(), originalRevision: draft.revision, previousPublishedVersionId: draft.publishedVersionId, preservedDraftFields: preservedDiff, prunedVersionOnPublish: prunedVersion ? { id: prunedVersion.id, version: prunedVersion.version } : null, alreadyMigrated, status: "planned" }];
  const output = path.resolve(values["output-dir"]);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "workspace-before.json"), JSON.stringify(before, null, 2), { flag: "wx" });
  const report = { format: "zane-director-console-migration/v1", baseUrl: base.origin, startedAt: new Date().toISOString(), apply: values.apply, publish: values.publish, modelJobsSubmitted: 0, comfyGraphsModified: false, workflowFile: DIRECTOR_CONSOLE_WORKFLOW_FILE, plans };
  const save = () => writeFile(path.join(output, "migration-plan.json"), JSON.stringify(report, null, 2));
  // Persist IDs and intended changes before the first shared write/publication.
  await save();
  if (values.apply) {
    const plan = plans[0];
    if (plan.alreadyMigrated) { plan.status = "already_published"; await save(); }
    else {
      await idle();
      try {
        const saved = await json(`/api/v1/scenes/${plan.sceneId}/draft`, { revision: plan.originalRevision, workflow }, "PATCH");
        plan.revision = saved.revision;
        plan.status = "draft_saved";
        await save();
        const validation = await json(`/api/v1/scenes/${plan.sceneId}/validate`, { revision: saved.revision });
        assert.equal(validation.valid, true, "导演台迁移草稿校验失败");
        plan.status = "validated";
        await save();
        if (values.publish) {
          const published = await json(`/api/v1/scenes/${plan.sceneId}/publish`, { revision: saved.revision, publicationId: plan.publicationId });
          assert.equal(published.versionId, plan.publicationId);
          const actual = await json(`/api/v1/scenes/${plan.sceneId}?versionId=${plan.publicationId}`);
          assert.ok(actual.workflow.steps.some(step => step.comfyui?.workflowFile === DIRECTOR_CONSOLE_WORKFLOW_FILE));
          plan.version = published.version;
          plan.status = "published";
          await save();
        }
      } catch (error) {
        // A lost reply does not permit a new ID, an automatic replay or a forced overwrite.
        plan.status = "inspect_before_retry";
        plan.error = String(error);
        plan.nextAction = { draft: `/api/v1/scenes/${plan.sceneId}/draft`, publication: `/api/v1/scenes/${plan.sceneId}?versionId=${plan.publicationId}` };
        await save();
        throw Error(`Migration stopped without replay. Read saved IDs/revisions and reconcile first: ${path.join(output, "migration-plan.json")}\n${error}`);
      }
    }
    const after = (await json("/api/workspace")).workspace;
    for (const key of ["scenes", "optionPresets", "drafts"]) assert.deepEqual(after[key], before[key], `Unexpected changes to ${key}`);
    for (const id of Object.keys(before.workflows)) if (id !== plan.sceneId) assert.deepEqual(after.workflows[id], before.workflows[id], `Unrelated workflow changed: ${id}`);
    const approvedPrune = new Set(plan.prunedVersionOnPublish && values["allow-version-prune"] ? [plan.prunedVersionOnPublish.id] : []);
    for (const id of Object.keys(before.sceneVersions)) {
      if (id !== plan.sceneId) assert.deepEqual(after.sceneVersions[id], before.sceneVersions[id], `Unrelated versions changed: ${id}`);
      else for (const old of before.sceneVersions[id].versions) {
        if (approvedPrune.has(old.id)) {
          assert.equal(after.sceneVersions[id].versions.find(version => version.id === old.id), undefined, "Approved prune must remove exactly the announced oldest version");
          continue;
        }
        assert.deepEqual(after.sceneVersions[id].versions.find(version => version.id === old.id), old, "Historical versions must not be rewritten or pruned by this migration");
      }
    }
    await writeFile(path.join(output, "workspace-after.json"), JSON.stringify(after, null, 2));
  }
  console.log(JSON.stringify({ output, apply: values.apply, publish: values.publish, modelJobsSubmitted: 0, workflowFile: DIRECTOR_CONSOLE_WORKFLOW_FILE, plans }, null, 2));
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1; });
