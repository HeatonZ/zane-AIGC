/** 长文出视频：单镜时长下限 5s→2s 的场景草稿迁移（Writer 模板 + prepare_console code）。
 *
 * 为什么需要这个脚本：
 *  - Writer 的 promptTemplate 只存在于场景草稿/发布快照（数据），不在仓库源码里；
 *    prepare_console 的 core.code 也是在发布快照时内嵌进草稿的。
 *    所以只改 server/*.ts 并 tsc -b 不会改变正在生效的运行，必须显式改草稿再发布。
 *
 * 只做三件事，且全部走工作台公开接口：
 *  1. Writer promptTemplate 的时长区间（3 处：规则、字段说明、结构示意）
 *  2. prepare_console.capabilityConfig.code = 当前仓库编译出的 DIRECTOR_CONSOLE_PREPARE_CODE
 *  3. 先存草稿 → 校验 → 显式发布（revision + 预先生成的 publicationId 保护）
 *
 * 硬约束：不提交运行、不重启进程、不写数据库、不碰 ComfyUI 图、不改其它步骤。
 * dry-run 默认；--apply 存草稿；--apply --publish 发布。
 */
import { workbenchFetch } from "./workbench-auth.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { DIRECTOR_CONSOLE_PREPARE_CODE } from "../server/domain/directorConsoleMigration.ts";

const SCENE_ID = "scene_long_text_to_video";
const SCENE_TITLE = "长文出视频";

/** Writer 模板的三处时长表述，逐字替换。任何一处不匹配即中止（不猜、不模糊替换）。 */
export const WRITER_TEMPLATE_EDITS = Object.freeze([
  {
    label: "片段时长规则",
    from: "3. 每个片段5到15秒，优先6到10秒，一个明确的叙事任务和主要动作",
    to: "3. 每个片段2到15秒：快节奏/反应/插入镜头用2到3秒，常规叙事用5到8秒，一个明确的叙事任务和主要动作",
  },
  {
    label: "shots 字段说明",
    from: "seconds（5..15数字）",
    to: "seconds（2..15数字）",
  },
  {
    label: "结构示意示例",
    from: "\"index\":1,\"seconds\":5,",
    to: "\"index\":1,\"seconds\":3,",
  },
  // 示例必须与自己的规则自洽：规则要求 0<=start<end<=seconds-0.6，
  // 所以 seconds 改成 3 后，示例里的「0-5秒」和 end:3 都得一起收。
  {
    label: "示例画面时间范围",
    from: "0-5秒，人物看向桌上的信后抬眼",
    to: "0-3秒，人物看向桌上的信后抬眼",
  },
  {
    label: "示例对白结束时间",
    from: "\"start\":1,\"end\":3",
    to: "\"start\":1,\"end\":2.4",
  },
]);

export function rewriteWriterTemplate(template) {
  assert.equal(typeof template, "string", "Writer 步骤缺少 promptTemplate");
  let next = template;
  // 幂等：模板已经是目标状态时直接返回，重复运行不报错、不二次改写。
  const alreadyTarget = WRITER_TEMPLATE_EDITS.every(edit => next.includes(edit.to) && !next.includes(edit.from));
  if (alreadyTarget) return next;
  for (const edit of WRITER_TEMPLATE_EDITS) {
    const hits = next.split(edit.from).length - 1;
    assert.equal(hits, 1, `Writer 模板「${edit.label}」应恰好命中 1 次，实际 ${hits} 次；模板已变化，请人工核对后再改`);
    next = next.replace(edit.from, edit.to);
  }
  // 改完必须已经不存在旧的 5 秒下限表述，避免只改了一半就发布。
  for (const forbidden of ["每个片段5到15秒", "seconds（5..15数字）", "\"seconds\":5,"]) {
    assert.equal(next.includes(forbidden), false, `Writer 模板仍残留旧下限表述：${forbidden}`);
  }
  assert.ok(next.includes("2到15秒"), "Writer 模板未包含新的 2到15秒 区间");
  // 原有制作约束必须保留，不得为了改时长删掉。
  for (const kept of ["一个明确的叙事任务和主要动作", "复杂动作、场景切换、多人抢话、长对白必须拆分", "所有 seconds 之和尽量接近目标时长"]) {
    assert.ok(next.includes(kept), `Writer 模板丢失原有约束：${kept}`);
  }
  return next;
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    apply: { type: "boolean", default: false },
    publish: { type: "boolean", default: false },
    "allow-version-prune": { type: "boolean", default: false },
    "base-url": { type: "string", default: "http://127.0.0.1:8799" },
    "output-dir": { type: "string", default: `backups/long-text-shot-floor-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}` },
  } });
  assert.ok(!values.publish || values.apply, "--publish requires --apply");
  const base = new URL(values["base-url"]);
  assert.ok(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) && !base.username && !base.password, "Only the local workbench can be changed");
  const json = async (route, body, method = body === undefined ? "GET" : "POST") => {
    const response = await workbenchFetch(new URL(route, base), { ...(body ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error(`${route}: HTTP ${response.status} ${await response.text()}`);
    return response.json();
  };
  const idle = async () => {
    const health = await json("/api/health");
    assert.equal(health.storage, "sqlite");
    assert.ok(health.worker.ready && health.worker.accepting, "工作台未就绪");
    for (const key of ["active", "queued", "preparing"]) assert.equal(health.worker[key], 0, `工作台有 ${key} 运行，先停止再改发布配置`);
  };
  if (values.apply) await idle();

  const before = (await json("/api/workspace")).workspace;
  assert.ok(before, "No initialized workspace");
  const draft = await json(`/api/v1/scenes/${SCENE_ID}/draft`);
  assert.equal(draft.scene.title, SCENE_TITLE, "场景身份不符，停止");
  assert.ok(draft.publishedVersionId, "缺少已发布版本");

  const writer = (draft.workflow.steps ?? []).find(step => step.id === "writer");
  assert.ok(writer, "草稿缺少 writer 步骤");
  const prepare = (draft.workflow.steps ?? []).find(step => step.id === "prepare_console");
  assert.ok(prepare, "草稿缺少 prepare_console 步骤（导演台迁移未完成）");

  const writerBefore = writer.promptTemplate;
  const writerAfter = rewriteWriterTemplate(writerBefore);
  const codeBefore = prepare.capabilityConfig?.code;
  assert.equal(typeof codeBefore, "string", "prepare_console 缺少 capabilityConfig.code");

  const workflow = structuredClone(draft.workflow);
  workflow.steps.find(step => step.id === "writer").promptTemplate = writerAfter;
  workflow.steps.find(step => step.id === "prepare_console").capabilityConfig.code = DIRECTOR_CONSOLE_PREPARE_CODE;

  // 除这两个步骤的这两处字段外，草稿其余内容必须逐字节不变。
  const expected = structuredClone(draft.workflow);
  expected.steps.find(step => step.id === "writer").promptTemplate = writerAfter;
  expected.steps.find(step => step.id === "prepare_console").capabilityConfig.code = DIRECTOR_CONSOLE_PREPARE_CODE;
  assert.ok(isDeepStrictEqual(workflow, expected), "产生的草稿不是「只改这两处」的结果");
  assert.deepEqual(workflow.steps.map(step => step.id), draft.workflow.steps.map(step => step.id), "步骤顺序不得变化");
  assert.deepEqual(workflow.inputs, draft.workflow.inputs, "场景输入契约不得变化");
  assert.deepEqual(workflow.outputs, draft.workflow.outputs, "场景输出契约不得变化");

  const codeChanged = codeBefore !== DIRECTOR_CONSOLE_PREPARE_CODE;
  const templateChanged = writerBefore !== writerAfter;
  const alreadyApplied = !codeChanged && !templateChanged;
  const prunedVersion = draft.versions.length >= 10 ? draft.versions[0] : undefined;
  // 「内容已写进草稿」≠「已发布」：只有草稿与发布快照一致才算真的发布过，否则跳发布会假成功。
  const alreadyPublished = alreadyApplied && draft.draftMatchesPublished === true;
  const publicationId = alreadyPublished ? draft.publishedVersionId : randomUUID();
  if (values.publish && !alreadyPublished) {
    assert.ok(!prunedVersion || values["allow-version-prune"], `发布会裁剪最旧版本 ${prunedVersion?.version ?? ""}；确认备份后加 --allow-version-prune`);
  }

  const output = path.resolve(values["output-dir"]);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "workspace-before.json"), JSON.stringify(before, null, 2), { flag: "wx" });
  await writeFile(path.join(output, "writer-template-before.txt"), writerBefore, "utf8");
  await writeFile(path.join(output, "writer-template-after.txt"), writerAfter, "utf8");
  const report = {
    format: "zane-long-text-shot-floor/v1",
    baseUrl: base.origin,
    startedAt: new Date().toISOString(),
    apply: values.apply,
    publish: values.publish,
    modelJobsSubmitted: 0,
    comfyGraphsModified: false,
    sceneId: SCENE_ID,
    originalRevision: draft.revision,
    previousPublishedVersionId: draft.publishedVersionId,
    publicationId,
    prunedVersionOnPublish: prunedVersion ? { id: prunedVersion.versionId, version: prunedVersion.version } : null,
    templateChanged,
    codeChanged,
    alreadyApplied,
    status: "planned",
  };
  const save = () => writeFile(path.join(output, "shot-floor-plan.json"), JSON.stringify(report, null, 2));
  await save();

  let revision = draft.revision;
  if (values.apply && !alreadyApplied) {
    await idle();
    try {
      const saved = await json(`/api/v1/scenes/${SCENE_ID}/draft`, { revision: draft.revision, workflow }, "PATCH");
      revision = saved.revision;
      report.revision = saved.revision;
      report.status = "draft_saved";
      await save();
      const validation = await json(`/api/v1/scenes/${SCENE_ID}/validate`, { revision: saved.revision });
      assert.equal(validation.valid, true, `草稿校验失败：${JSON.stringify(validation)}`);
      report.status = "validated";
      await save();
    } catch (error) {
      report.status = "inspect_before_retry";
      report.error = String(error);
      report.nextAction = { draft: `/api/v1/scenes/${SCENE_ID}/draft`, publication: `/api/v1/scenes/${SCENE_ID}?versionId=${publicationId}` };
      await save();
      throw Error(`迁移已停止且未重放；先按已保存的 ID/revision 对账：${path.join(output, "shot-floor-plan.json")}\n${error}`);
    }
  }
  // 发布独立于「草稿是否刚被改写」：草稿内容已到位但尚未发布时也必须真的发布，
  // 否则会报 published 却没有任何新版本。revision 用当前草稿的 revision。
  if (values.apply && values.publish && !alreadyPublished) {
    await idle();
    try {
      const published = await json(`/api/v1/scenes/${SCENE_ID}/publish`, { revision, publicationId });
      assert.equal(published.versionId, publicationId, "发布返回了不同的 versionId；先对账，不要换 ID 重放");
      const actual = await json(`/api/v1/scenes/${SCENE_ID}?versionId=${publicationId}`);
      const actualPrepare = actual.workflow.steps.find(step => step.id === "prepare_console");
      assert.ok(actualPrepare?.capabilityConfig?.code.includes("seconds >= 2 && seconds <= 15"), "发布快照的 prepare_console code 未包含新的 2 秒下限");
      assert.equal(actualPrepare.capabilityConfig.code.includes("seconds >= 5 && seconds <= 15"), false, "发布快照仍包含旧的 5 秒下限");
      const actualWriter = actual.workflow.steps.find(step => step.id === "writer");
      assert.equal(actualWriter.promptTemplate, writerAfter, "发布快照的 Writer 模板与预期不一致");
      report.version = published.version;
      report.status = "published";
      await save();
    } catch (error) {
      report.status = "inspect_before_retry";
      report.error = String(error);
      report.nextAction = { draft: `/api/v1/scenes/${SCENE_ID}/draft`, publication: `/api/v1/scenes/${SCENE_ID}?versionId=${publicationId}` };
      await save();
      throw Error(`发布已停止且未重放；先按已保存的 ID/revision 对账：${path.join(output, "shot-floor-plan.json")}\n${error}`);
    }
  }
  if (alreadyPublished) {
    report.version = draft.versions.find(version => version.versionId === draft.publishedVersionId)?.version ?? null;
    report.status = "already_published";
    await save();
  }

  const after = (await json("/api/workspace")).workspace;
  // 本次改动只允许动这张场景的草稿/发布版本；其余键逐项对账。
  assert.deepEqual(after.optionPresets, before.optionPresets, "Unexpected changes to optionPresets");
  assert.deepEqual(after.drafts, before.drafts, "Unexpected changes to drafts");
  assert.deepEqual(after.scenes, before.scenes, "场景展示字段不得被本次改动影响");
  for (const id of Object.keys(before.workflows)) if (id !== SCENE_ID) assert.deepEqual(after.workflows[id], before.workflows[id], `Unrelated workflow changed: ${id}`);
  const approvedPrune = new Set(report.prunedVersionOnPublish && values["allow-version-prune"] ? [report.prunedVersionOnPublish.id] : []);
  for (const id of Object.keys(before.sceneVersions)) {
    if (id !== SCENE_ID) { assert.deepEqual(after.sceneVersions[id], before.sceneVersions[id], `Unrelated versions changed: ${id}`); continue; }
    for (const old of before.sceneVersions[id].versions) {
      const next = after.sceneVersions[id].versions.find(version => version.id === old.id);
      if (approvedPrune.has(old.id)) { assert.equal(next, undefined, "Approved prune must remove exactly the announced oldest version"); continue; }
      assert.deepEqual(next, old, "历史版本不得被改写或裁剪");
    }
  }
  await writeFile(path.join(output, "workspace-after.json"), JSON.stringify(after, null, 2));

  console.log(JSON.stringify({
    output,
    apply: values.apply,
    publish: values.publish,
    status: report.status,
    version: report.version ?? null,
    publicationId,
    templateChanged,
    codeChanged,
    alreadyApplied,
    prunedVersionOnPublish: report.prunedVersionOnPublish,
    modelJobsSubmitted: 0,
  }, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1; });
