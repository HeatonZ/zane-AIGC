import { workbenchFetch } from "./workbench-auth.mjs";
/** Collapse the five deterministic steps of 长文出视频 into one custom-code step and drop text.template.
 * Dry-run by default. --apply saves the draft; --apply --publish publishes explicitly.
 * Never submits runs, never writes ComfyUI workflows. Requires the patched director workflow. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { DIRECTOR_CONSOLE_WORKFLOW_FILE, migrateLongTextToDirectorConsole } from "../server/domain/directorConsoleMigration.ts";

export const DIRECTOR_CONSOLE_TARGET = Object.freeze({ sceneId: "scene_long_text_to_video", title: "长文出视频" });
const DESCRIPTION = "长文/剧情 + 人物/场景/道具 + 参考音色 → Writer一次编写制作级视频分镜脚本 → AIXG一次批量转换H3提示词（不重新编剧） → 一个自定义代码步骤完成分镜对齐、全局资产到局部编号映射和多轨时间线构建（媒体只以数量/顺序进入，实际文件由最终步骤绑定） → 同一个ComfyUI导演台工程按分镜顺序续接整片并自动拼接；共4步、两次AI调用，原生24fps，禁止音乐。";
const STAGES = ["剧情与素材", "Writer制作级分镜", "AIXG提示词转换", "导演台时间线与单工程续接成片"];
const KEPT_STEP_IDS = ["writer", "aixg"];
const DIRECTOR_CONSOLE_STEP_IDS = ["writer", "aixg", "prepare_console", "console"];

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    apply: { type: "boolean", default: false }, publish: { type: "boolean", default: false },
    "allow-version-prune": { type: "boolean", default: false },
    "base-url": { type: "string", default: "http://127.0.0.1:8799" },
    "output-dir": { type: "string", default: `backups/director-console-compact-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}` },
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
  const audioBridges = (summary.nodes ?? []).filter(node => node.type === "easy makeAudioList");
  assert.equal(audioBridges.length, 1, `导演台工作流需要且只能有一个 easy makeAudioList 音频列表节点；请先运行 node scripts/patch-director-console-comfyui-workflow.mjs --apply`);
  const editor = (summary.nodes ?? []).find(node => node.type === "easy multiTrackEditor");
  assert.ok(editor?.inputProperties.includes("audio"), "导演台编辑器没有连接音频列表节点；请先运行 node scripts/patch-director-console-comfyui-workflow.mjs --apply");

  const draft = await json(`/api/v1/scenes/${DIRECTOR_CONSOLE_TARGET.sceneId}/draft`);
  assert.equal(draft.scene.title, DIRECTOR_CONSOLE_TARGET.title, "Scene identity changed; review before proceeding");
  assert.ok(draft.publishedVersionId, `Missing published scene: ${DIRECTOR_CONSOLE_TARGET.title}`);
  // Re-running on an already-compacted draft must reconcile, not fail closed.
  const alreadyCompact = (draft.workflow.steps ?? []).map(step => step.id).join(",") === DIRECTOR_CONSOLE_STEP_IDS.join(",");
  const workflow = alreadyCompact
    ? structuredClone(draft.workflow)
    : migrateLongTextToDirectorConsole(draft.workflow, summary.nodes ?? []);
  if (alreadyCompact) {
    assert.equal(workflow.steps.filter(step => step.capabilityId === "text.template").length, 0, "草稿仍是旧的文本模板流程，无法直接核对");
    assert.ok(workflow.steps.every(step => DIRECTOR_CONSOLE_STEP_IDS.includes(step.id)), "草稿步骤不是合并后的四步流程");
    assert.ok([...workflow.steps].sort((left, right) => DIRECTOR_CONSOLE_STEP_IDS.indexOf(left.id) - DIRECTOR_CONSOLE_STEP_IDS.indexOf(right.id)).length === 4, "草稿步骤不是合并后的四步流程");
  }
  const scene = { ...draft.scene, description: DESCRIPTION, stages: STAGES };
  const documentChanged = scene.description !== draft.scene.description || !isDeepStrictEqual(scene.stages, draft.scene.stages);
  const alreadyMigrated = isDeepStrictEqual(workflow, draft.workflow) && !documentChanged;
  const preservedDraftFields = [];
  for (const field of ["inputs"]) {
    const left = JSON.stringify(draft.workflow[field] ?? null);
    if (JSON.stringify(workflow[field] ?? null) !== left) throw Error(`迁移必须原样保留草稿的输入契约（${field} 发生变化）`);
  }
  for (const id of KEPT_STEP_IDS) {
    const before = JSON.stringify((draft.workflow.steps ?? []).find(step => step.id === id) ?? null);
    const after = JSON.stringify(workflow.steps.find(step => step.id === id) ?? null);
    assert.equal(after, before, `步骤 ${id} 必须原样保留，不得在合并中被改写`);
  }
  assert.equal(workflow.steps.some(step => step.capabilityId === "text.template"), false, "迁移结果不得再包含文本模板执行方式");
  const prunedVersion = draft.versions.length >= 10 ? draft.versions[0] : undefined;
  if (values.publish && !alreadyMigrated) assert.ok(!prunedVersion || values["allow-version-prune"], `发布会裁剪最旧版本 ${prunedVersion?.version ?? ""}；确认备份后加 --allow-version-prune`);

  const plans = [{ sceneId: DIRECTOR_CONSOLE_TARGET.sceneId, title: DIRECTOR_CONSOLE_TARGET.title, publicationId: alreadyMigrated ? draft.publishedVersionId : randomUUID(), originalRevision: draft.revision, previousPublishedVersionId: draft.publishedVersionId, prunedVersionOnPublish: prunedVersion ? { id: prunedVersion.id, version: prunedVersion.version } : null, documentChanged, alreadyMigrated, stepIds: workflow.steps.map(step => step.id), audioListNodeId: audioBridges[0].id, status: "planned" }];
  const output = path.resolve(values["output-dir"]);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "workspace-before.json"), JSON.stringify(before, null, 2), { flag: "wx" });
  const report = { format: "zane-director-console-compact/v1", baseUrl: base.origin, startedAt: new Date().toISOString(), apply: values.apply, publish: values.publish, modelJobsSubmitted: 0, comfyGraphsModified: false, workflowFile: DIRECTOR_CONSOLE_WORKFLOW_FILE, plans };
  const save = () => writeFile(path.join(output, "migration-plan.json"), JSON.stringify(report, null, 2));
  await save();
  if (values.apply) {
    const plan = plans[0];
    if (plan.alreadyMigrated) { plan.status = "already_published"; await save(); }
    else {
      await idle();
      try {
        const saved = await json(`/api/v1/scenes/${plan.sceneId}/draft`, { revision: plan.originalRevision, workflow, scene }, "PATCH");
        plan.revision = saved.revision;
        plan.status = "draft_saved";
        await save();
        const validation = await json(`/api/v1/scenes/${plan.sceneId}/validate`, { revision: saved.revision });
        assert.equal(validation.valid, true, "导演台合并草稿校验失败");
        plan.status = "validated";
        await save();
        if (values.publish) {
          const published = await json(`/api/v1/scenes/${plan.sceneId}/publish`, { revision: saved.revision, publicationId: plan.publicationId });
          assert.equal(published.versionId, plan.publicationId);
          const actual = await json(`/api/v1/scenes/${plan.sceneId}?versionId=${plan.publicationId}`);
          assert.deepEqual(actual.workflow.steps.map(step => step.id), plan.stepIds, "发布快照不是合并后的四步流程");
          assert.equal(actual.workflow.steps.some(step => step.capabilityId === "text.template"), false, "发布快照仍包含文本模板执行方式");
          assert.equal(actual.workflow.steps.some(step => step.comfyui?.workflowFile === DIRECTOR_CONSOLE_WORKFLOW_FILE), true, "发布快照未包含导演台工作流");
          const prepare = actual.workflow.steps.find(step => step.id === "prepare_console");
          assert.equal(prepare?.capabilityId, "core.code", "发布快照缺少合并后的自定义代码步骤");
          assert.deepEqual(prepare.inputs.map(input => input.sourceRef), ["step.writer.outputs.shots", "step.aixg.outputs.prompts", "input.character_assets", "input.scene_assets", "input.prop_assets", "input.voice_reference_audio"]);
          const bindings = actual.workflow.steps.find(step => step.id === "console").comfyui.bindings;
          assert.deepEqual(bindings.filter(binding => binding.property === "image" && binding.direction === "input").map(binding => binding.sourceRef), ["input.character_assets", "input.scene_assets", "input.prop_assets"]);
          assert.deepEqual(bindings.filter(binding => binding.nodeId === String(plan.audioListNodeId)).map(binding => binding.property), Array.from({ length: 10 }, (_unused, index) => `audio${index + 1}`));
          assert.equal(actual.scene.description, DESCRIPTION, "发布快照未包含新场景说明");
          assert.ok(isDeepStrictEqual(actual.scene.stages, STAGES), "发布快照未包含新阶段");
          plan.version = published.version;
          plan.status = "published";
          await save();
        }
      } catch (error) {
        plan.status = "inspect_before_retry";
        plan.error = String(error);
        plan.nextAction = { draft: `/api/v1/scenes/${plan.sceneId}/draft`, publication: `/api/v1/scenes/${plan.sceneId}?versionId=${plan.publicationId}` };
        await save();
        throw Error(`Migration stopped without replay. Read saved IDs/revisions and reconcile first: ${path.join(output, "migration-plan.json")}\n${error}`);
      }
    }
    const after = (await json("/api/workspace")).workspace;
    for (const key of ["optionPresets", "drafts"]) assert.deepEqual(after[key], before[key], `Unexpected changes to ${key}`);
    for (const item of after.scenes) {
      const previous = before.scenes.find(candidate => candidate.id === item.id);
      if (item.id !== plan.sceneId) { assert.deepEqual(item, previous, `Unrelated scene changed: ${item.id}`); continue; }
      for (const field of ["id", "title", "summary", "shortTitle", "cover", "coverPosition", "accent"]) assert.equal(item[field], previous[field], `场景展示字段 ${field} 不得被流程合并改写`);
    }
    const publishedScene = (await json(`/api/v1/scenes/${plan.sceneId}?versionId=${plan.publicationId}`)).scene;
    assert.equal(publishedScene.description, DESCRIPTION, "发布快照未包含合并后的场景说明");
    assert.ok(isDeepStrictEqual(publishedScene.stages, STAGES), "发布快照未包含合并后的阶段");
    for (const id of Object.keys(before.workflows)) if (id !== plan.sceneId) assert.deepEqual(after.workflows[id], before.workflows[id], `Unrelated workflow changed: ${id}`);
    const approvedPrune = new Set(plan.prunedVersionOnPublish && values["allow-version-prune"] ? [plan.prunedVersionOnPublish.id] : []);
    for (const id of Object.keys(before.sceneVersions)) {
      if (id !== plan.sceneId) { assert.deepEqual(after.sceneVersions[id], before.sceneVersions[id], `Unrelated versions changed: ${id}`); continue; }
      for (const old of before.sceneVersions[id].versions) {
        if (approvedPrune.has(old.id)) { assert.equal(after.sceneVersions[id].versions.find(version => version.id === old.id), undefined, "Approved prune must remove exactly the announced oldest version"); continue; }
        assert.deepEqual(after.sceneVersions[id].versions.find(version => version.id === old.id), old, "Historical versions must not be rewritten or pruned by this migration");
      }
    }
    await writeFile(path.join(output, "workspace-after.json"), JSON.stringify(after, null, 2));
  }
  console.log(JSON.stringify({ output, apply: values.apply, publish: values.publish, modelJobsSubmitted: 0, workflowFile: DIRECTOR_CONSOLE_WORKFLOW_FILE, plans }, null, 2));
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1; });
