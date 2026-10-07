import { workbenchFetch } from "./workbench-auth.mjs";
/** Migrate only the four approved video scenes through revision-protected scene APIs.
 * Dry-run by default. --apply saves drafts; --apply --publish explicitly publishes.
 * Never submits runs, modifies ComfyUI graphs, restarts services, or writes a database.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { DUAL_VIDEO_FILES, migrateVideoSampling } from "../server/domain/videoWorkflowMigration.ts";

export const VIDEO_SAMPLING_TARGETS = Object.freeze([
  { sceneId: "scene_8ea4173e-d278-4703-9bec-418498ace6ee", title: "AI文生视频", mode: "text" },
  { sceneId: "scene_3a95a9cb-ed5e-468f-aac9-59b670b1f979", title: "AI参考生视频", mode: "text" },
  { sceneId: "scene_e3ef7b38-2c2c-4f0a-9ab4-ddc729ba67af", title: "AI文生视频无设计版", mode: "text" },
  { sceneId: "scene_long_text_to_video", title: "长文出视频", mode: "json" },
]);

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    apply: { type: "boolean", default: false }, publish: { type: "boolean", default: false },
    "include-existing-draft": { type: "boolean", default: false },
    "base-url": { type: "string", default: "http://127.0.0.1:8799" },
    "output-dir": { type: "string", default: `backups/video-dual-sampling-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}` },
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
  const schemas = {};
  for (const type of ["SelfLiftAvatarH3Sampler", "H3SigmaRefiner", "MiniMaxH3ReferenceToVideo"]) {
    const r = await fetch(new URL(`/object_info/${type}`, comfyBase), { signal: AbortSignal.timeout(10000) });
    assert.ok(r.ok, `Cannot read installed ${type}`);
    schemas[type] = (await r.json())[type];
    assert.ok(schemas[type], `Required dual-sampling node is not installed: ${type}`);
  }
  const graphs = {};
  for (const [mode, filename] of Object.entries(DUAL_VIDEO_FILES)) graphs[mode] = await json(`/api/comfyui/workflow?filename=${encodeURIComponent(filename)}`);
  const plans = [];
  for (const target of VIDEO_SAMPLING_TARGETS) {
    const draft = await json(`/api/v1/scenes/${target.sceneId}/draft`);
    assert.equal(draft.scene.title, target.title, "Scene identity changed; review before proceeding");
    assert.ok(draft.publishedVersionId, `Missing published scene: ${target.title}`);
    const workflow = migrateVideoSampling(draft.workflow, target.mode, graphs[target.mode].nodes, schemas.MiniMaxH3ReferenceToVideo);
    const alreadyPublished = draft.draftMatchesPublished && isDeepStrictEqual(workflow, draft.workflow);
    if (values.publish && !alreadyPublished) {
      assert.ok(draft.versions.length < 10, "Publication would prune old versions; archive/review history explicitly before migrating");
      assert.ok(draft.draftMatchesPublished || values["include-existing-draft"], "Unpublished edits exist; inspect them before using --include-existing-draft");
    }
    plans.push({ ...target, publicationId: alreadyPublished ? draft.publishedVersionId : randomUUID(), originalRevision: draft.revision, previousPublishedVersionId: draft.publishedVersionId, hadUnpublishedDraft: !draft.draftMatchesPublished, originalWorkflow: draft.workflow, workflow, alreadyPublished, status: "planned" });
  }
  const output = path.resolve(values["output-dir"]);
  await mkdir(output, { recursive: true });
  // Logical workspace backup is read from the authoritative service, not the JSON mirror.
  await writeFile(path.join(output, "workspace-before.json"), JSON.stringify(before, null, 2), { flag: "wx" });
  const report = { format: "zane-video-sampling-migration/v1", baseUrl: base.origin, startedAt: new Date().toISOString(), apply: values.apply, publish: values.publish, modelJobsSubmitted: 0, comfyGraphsModified: false, plans };
  const save = () => writeFile(path.join(output, "migration-plan.json"), JSON.stringify(report, null, 2));
  // Persist IDs and intended changes before the first shared write/publication.
  await save();
  if (values.apply) {
    for (const plan of plans) {
      if (plan.alreadyPublished) { plan.status = "already_published"; await save(); continue; }
      await idle();
      let draft;
      try {
        draft = await json(`/api/v1/scenes/${plan.sceneId}/draft`, { revision: plan.originalRevision, workflow: plan.workflow }, "PATCH");
        plan.revision = draft.revision;
        plan.savedWorkflow = draft.workflow;
        plan.status = "draft_saved";
        await save();
        const validation = await json(`/api/v1/scenes/${plan.sceneId}/validate`, { revision: plan.revision });
        assert.equal(validation.valid, true);
        plan.status = "validated";
        await save();
        if (values.publish) {
          const published = await json(`/api/v1/scenes/${plan.sceneId}/publish`, { revision: plan.revision, publicationId: plan.publicationId });
          assert.equal(published.versionId, plan.publicationId);
          plan.version = published.version;
          const actual = await json(`/api/v1/scenes/${plan.sceneId}?versionId=${plan.publicationId}`);
          assert.equal(actual.versionId, plan.publicationId);
          assert.ok(actual.workflow.steps.some(step => step.comfyui?.workflowFile === DUAL_VIDEO_FILES[plan.mode]));
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
    const targetIds = new Set(plans.map(plan => plan.sceneId));
    for (const key of ["scenes", "optionPresets", "drafts"]) assert.deepEqual(after[key], before[key], `Unexpected changes to ${key}`);
    for (const id of Object.keys(before.workflows)) if (!targetIds.has(id)) assert.deepEqual(after.workflows[id], before.workflows[id], `Unrelated workflow changed: ${id}`);
    for (const id of Object.keys(before.sceneVersions)) {
      if (!targetIds.has(id)) assert.deepEqual(after.sceneVersions[id], before.sceneVersions[id], `Unrelated versions changed: ${id}`);
      else for (const old of before.sceneVersions[id].versions) assert.deepEqual(after.sceneVersions[id].versions.find(version => version.id === old.id), old, "Historical versions must not be rewritten or pruned by this migration");
    }
    await writeFile(path.join(output, "workspace-after.json"), JSON.stringify(after, null, 2));
  }
  console.log(JSON.stringify({ output, apply: values.apply, publish: values.publish, modelJobsSubmitted: 0, scenes: plans.map(({ sceneId, title, mode, publicationId, previousPublishedVersionId, hadUnpublishedDraft, status, version }) => ({ sceneId, title, workflowFile: DUAL_VIDEO_FILES[mode], publicationId, previousPublishedVersionId, hadUnpublishedDraft, status, version })) }, null, 2));
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1; });
