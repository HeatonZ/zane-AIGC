import { workbenchFetch } from "./workbench-auth.mjs";
/** Refresh the long-text-to-video scene document so the published copy describes the
 * director-console flow. Revision-protected draft PATCH + validate + explicit publish;
 * dry-run by default. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const SCENE_ID = "scene_long_text_to_video";
const DESCRIPTION = "长文/剧情 + 人物/场景/道具 + 参考音色 → Writer一次编写制作级视频分镜脚本 → AIXG一次批量转换H3提示词（不重新编剧） → 确定性分镜对齐与素材映射 → 自定义代码步骤构建Easy-Media导演台多轨时间线（分镜时长/上下文标记/本地资产音轨） → 同一个ComfyUI导演台工程按分镜顺序续接整片并自动拼接；共8步、两次AI调用，原生24fps，禁止音乐。";
const STAGES = ["剧情与素材", "Writer制作级分镜", "AIXG提示词转换", "素材映射与数据对齐", "导演台时间线", "单工程顺序续接成片"];

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    apply: { type: "boolean", default: false }, publish: { type: "boolean", default: false },
    "allow-version-prune": { type: "boolean", default: false },
    "base-url": { type: "string", default: "http://127.0.0.1:8799" },
    "output-dir": { type: "string", default: `backups/long-text-scene-doc-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}` },
  } });
  assert.ok(!values.publish || values.apply, "--publish requires --apply");
  const base = new URL(values["base-url"]);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Only the local workbench can be updated");
  const json = async (route, body, method = body === undefined ? "GET" : "POST") => {
    const r = await workbenchFetch(new URL(route, base), { ...(body ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw Error(`${route}: HTTP ${r.status} ${await r.text()}`);
    return r.json();
  };
  const idle = async () => {
    const health = await json("/api/health");
    for (const key of ["active", "queued", "preparing"]) assert.equal(health.worker[key], 0, `Workbench has ${key} runs; stop before changing production configuration`);
  };
  if (values.apply) await idle();
  const before = (await json("/api/workspace")).workspace;
  const draft = await json(`/api/v1/scenes/${SCENE_ID}/draft`);
  assert.equal(draft.scene.title, "长文出视频", "Scene identity changed; review before proceeding");
  assert.ok(draft.draftMatchesPublished, "Scene draft differs from the published version; reconcile before refreshing the document");
  assert.ok(draft.workflow.steps.some(step => step.id === "console" && step.comfyui?.workflowFile === "Zane/MiniMaxH3-极简导演台+.json"), "Director-console migration is not published yet");
  const scene = { ...draft.scene, description: DESCRIPTION, stages: STAGES };
  const alreadyRefreshed = scene.description === draft.scene.description && isDeepStrictEqual(scene.stages, draft.scene.stages);
  const publicationId = alreadyRefreshed ? draft.publishedVersionId : randomUUID();
  const prunedVersion = draft.versions.length >= 10 ? draft.versions[0] : undefined;
  if (values.publish && !alreadyRefreshed) {
    assert.ok(!prunedVersion || values["allow-version-prune"], `发布会裁剪最旧版本 ${prunedVersion?.version ?? ""}；确认备份后加 --allow-version-prune`);
  }
  const output = path.resolve(values["output-dir"]);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "workspace-before.json"), JSON.stringify(before, null, 2), { flag: "wx" });
  const report = { format: "zane-long-text-scene-document/v1", baseUrl: base.origin, startedAt: new Date().toISOString(), apply: values.apply, publish: values.publish, sceneId: SCENE_ID, alreadyRefreshed, publicationId, prunedVersionOnPublish: prunedVersion ? { id: prunedVersion.id, version: prunedVersion.version } : null, status: "planned" };
  const save = () => writeFile(path.join(output, "document-plan.json"), JSON.stringify(report, null, 2));
  await save();
  if (values.apply && !alreadyRefreshed) {
    await idle();
    try {
      const saved = await json(`/api/v1/scenes/${SCENE_ID}/draft`, { revision: draft.revision, scene }, "PATCH");
      report.revision = saved.revision; report.status = "draft_saved"; await save();
      const validation = await json(`/api/v1/scenes/${SCENE_ID}/validate`, { revision: saved.revision });
      assert.equal(validation.valid, true, "场景文案草稿校验失败");
      report.status = "validated"; await save();
      if (values.publish) {
        const published = await json(`/api/v1/scenes/${SCENE_ID}/publish`, { revision: saved.revision, publicationId });
        assert.equal(published.versionId, publicationId, "发布 returned a different versionId; 对账 before continuing");
        const actual = await json(`/api/v1/scenes/${SCENE_ID}?versionId=${publicationId}`);
        assert.equal(actual.scene.description, DESCRIPTION, "发布快照未包含新文案");
        assert.ok(isDeepStrictEqual(actual.scene.stages, STAGES), "发布快照未包含新阶段");
        report.version = published.version; report.status = "published"; await save();
      }
      const after = (await json("/api/workspace")).workspace;
      for (const key of ["scenes", "optionPresets", "drafts"]) assert.deepEqual(after[key], before[key], `Unexpected changes to ${key}`);
      for (const id of Object.keys(before.workflows)) assert.deepEqual(after.workflows[id], before.workflows[id], `Unexpected workflow change: ${id}`);
      const approvedPrune = new Set(values["allow-version-prune"] && report.prunedVersionOnPublish ? [report.prunedVersionOnPublish.id] : []);
      for (const id of Object.keys(before.sceneVersions)) {
        if (id !== SCENE_ID) { assert.deepEqual(after.sceneVersions[id], before.sceneVersions[id], `Unrelated versions changed: ${id}`); continue; }
        for (const old of before.sceneVersions[id].versions) {
          const next = after.sceneVersions[id].versions.find(version => version.id === old.id);
          if (approvedPrune.has(old.id)) { assert.equal(next, undefined, "Approved prune must remove exactly the announced oldest version"); continue; }
          assert.ok(next && isDeepStrictEqual(next, old), "Historical versions must not be rewritten or pruned");
        }
      }
      await writeFile(path.join(output, "workspace-after.json"), JSON.stringify(after, null, 2));
    } catch (error) {
      report.status = "inspect_before_retry"; report.error = String(error); await save();
      throw Error(`Scene document refresh stopped without replay: ${path.join(output, "document-plan.json")}\n${error}`);
    }
  }
  console.log(JSON.stringify({ output, apply: values.apply, publish: values.publish, status: report.status, version: report.version ?? null, publicationId, prunedVersionOnPublish: report.prunedVersionOnPublish }, null, 2));
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1; });
