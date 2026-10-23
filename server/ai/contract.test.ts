import { AI_FOUNDATION_GUIDE } from "./foundationGuide.js";
import { AI_FOUNDATION_FEATURES } from "./features.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createAiOpenApi, outputTypes } from "./openapi.js";
import { ACCESS_OUTPUT_TYPES } from "./accessContracts.js";
import { loadCapabilityPackages } from "../capabilities/loadPackages.js";
import type { CapabilityRuntime } from "../capabilities/package.js";
import { aiOperations } from "./operations.js";
import { AI_GUIDE_SECTIONS, AI_OPERATOR_GUIDE, AI_OPERATOR_GUIDE_INDEX, aiGuideSection, aiGuideText } from "./guide.js";
import { AI_OPERATOR_CHANGELOG } from "./guideChangelog.js";
import { CATALOGUE_SUMMARY_OMISSION, catalogueDetailQuery, catalogueFeatures, catalogueOperations } from "./discovery.js";
import { directLlmAnthropicVersion } from "../domain/directLlm.js";
import { aiHarness } from "../testing/aiSupport.js";
import { publicRequestAllowed } from "../security/publicEntry.js";

const runtime: CapabilityRuntime = { async hermes() { throw new Error("只读契约测试不调用 Hermes"); }, async comfyui() { throw new Error("只读契约测试不调用 ComfyUI"); }, async condition() { return { result: true }; } };

test("AI机器契约：每个MCP工具对应OpenAPI，JSON递归引用全部可解析", () => {
  const api = createAiOpenApi(); const names = new Set<string>();
  for (const operation of aiOperations) {
    assert.ok(!names.has(operation.name)); names.add(operation.name);
    const spec = api.paths[operation.path][operation.method.toLowerCase()] as { operationId: string; responses: Record<string, unknown> };
    assert.equal(spec.operationId, operation.name); assert.ok(spec.responses[String(operation.success)]);
  }
  // 每个操作都必须映射到具名响应 schema：漏登记会得到无类型泛型响应，属契约缺陷。
  const mapped = new Set<string>([...Object.keys(ACCESS_OUTPUT_TYPES), ...Object.keys(outputTypes)]);
  const schemas = api.components.schemas as Record<string, unknown>;
  for (const operation of aiOperations) {
    const spec = api.paths[operation.path][operation.method.toLowerCase()] as { responses: Record<string, { content: Record<string, { schema: { $ref?: string } }> }> };
    const schema = spec.responses[String(operation.success)].content["application/json"].schema;
    assert.ok(schema.$ref, operation.name + " 缺少具名响应 schema（在 openapi.ts 的 outputTypes 登记）");
    const name = String(schema.$ref).split("/").pop()!;
    assert.ok(schemas[name], operation.name + " 的响应 schema 未定义：" + name);
    assert.ok(mapped.has(operation.name), operation.name + " 未登记到响应类型映射表");
  }
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if ("$ref" in value) { const pointer = String(value.$ref); assert.ok(pointer.startsWith("#/"), pointer); let target: unknown = api; for (const key of pointer.slice(2).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"))) target = (target as Record<string, unknown> | undefined)?.[key]; assert.notEqual(target, undefined, "Unresolved " + pointer); }
    for (const child of Object.values(value)) visit(child);
  };
  visit(api);
  const upload = api.paths["/api/v1/assets/upload"].post as { parameters: Array<{ name: string }> }; assert.ok(!upload.parameters.some(parameter => parameter.name === "filePath")); assert.ok(upload.parameters.some(parameter => parameter.name === "X-File-Name"));
  const body = (api.paths["/api/v1/scenes/{sceneId}/runs"].post as { requestBody: { content: Record<string, { schema: { properties: Record<string, unknown>; required: string[] } }> } }).requestBody.content["application/json"].schema;
  assert.ok(!body.properties.sceneId); assert.ok(body.required.includes("versionId")); assert.ok(body.required.includes("runId"));
});

test("管理员运行响应契约声明提交人快照且普通用户响应不暴露归属", () => {
  const api = createAiOpenApi(); const schemas = api.components.schemas as Record<string, any>;
  assert.deepEqual(schemas.RunSubmitter.required, ["userId", "username", "displayName"]);
  for (const field of ["ownerUserId", "submitter"]) assert.ok(field in schemas.RunSummary.properties);
  assert.equal(schemas.RunSummary.properties.submitter.$ref, "#/components/schemas/RunSubmitter");
  assert.equal(schemas.RunRecord.properties.submitter.$ref, "#/components/schemas/RunSubmitter");
  assert.equal(schemas.RunObservation.properties.submitter.$ref, "#/components/schemas/RunSubmitter");
  const list = (api.paths["/api/v1/runs"].get as any).responses[200].content["application/json"].schema;
  assert.equal(list.$ref, "#/components/schemas/RunPage");
  assert.equal(schemas.RunPage.properties.runs.items.$ref, "#/components/schemas/RunSummary");
  const detail = (api.paths["/api/v1/runs/{runId}"].get as any).responses[200].content["application/json"].schema;
  assert.equal(detail.$ref, "#/components/schemas/RunRecord");
  const wait = (api.paths["/api/v1/runs/{runId}/wait"].get as any).responses[200].content["application/json"].schema;
  assert.equal(wait.$ref, "#/components/schemas/RunObservation");
  const ownRun = schemas.UserRun;
  assert.ok(!("ownerUserId" in ownRun.properties)); assert.ok(!("submitter" in ownRun.properties));
});

test("AI文档同源：操作手册及OpenAPI快照与运行时契约一致", async () => {
  assert.equal((await readFile("docs/ai-operator.md", "utf8")).replace(/\r\n/g, "\n"), AI_OPERATOR_GUIDE);
  assert.equal((await readFile("docs/ai-operator-changelog.md", "utf8")).replace(/\r\n/g, "\n"), AI_OPERATOR_CHANGELOG);
  assert.deepEqual(JSON.parse(await readFile("docs/ai-openapi.json", "utf8")), createAiOpenApi());
});

test("能力散文只引用已注册能力：描述里出现的能力 ID 必须在目录中", async () => {
  // 描述文本会随能力增删而漂移；这里断言散文提到的一切能力 ID 都已注册，
  // 退役能力清单由 list_capabilities 的 compatibilityUsage 动态给出，不再手写。
  const registry = await loadCapabilityPackages(runtime);
  const known = new Set(registry.definitions().map((definition) => definition.id));
  // 能力 ID 形如 core.code / comfyui.h3_long_video；排除 MCP 错误负载字段（data.outcome 等）。
  const capabilityIdPattern = /\b(?:core|comfyui|media|text)\.[a-z0-9_]+|\bdata\.[a-z0-9_]{3,}/g;
  const payloadFields = new Set(["data.outcome"]);
  const documents = [
    ...aiOperations.map((operation) => ({ name: "operation:" + operation.name, text: operation.description })),
    { name: "guide", text: AI_OPERATOR_GUIDE },
    { name: "guide-changelog", text: AI_OPERATOR_CHANGELOG },
    { name: "foundation", text: AI_FOUNDATION_GUIDE },
  ];
  const unknown = new Map<string, string[]>();
  for (const document of documents) {
    for (const match of document.text.match(capabilityIdPattern) ?? []) {
      if (known.has(match) || payloadFields.has(match)) continue;
      unknown.set(match, [...(unknown.get(match) ?? []), document.name]);
    }
  }
  assert.deepEqual([...unknown.entries()].map(([id, where]) => `${id} (${[...new Set(where)].join(", ")})`), [], "散文引用了未注册的能力 ID");
});

test("AI手册体积预算：伞式目录与会话级拆分不随版本小节无限膨胀", () => {
  // 会话级上下文成本：每次 MCP 会话只下发 zane://guide 的伞式目录，正文按节读取。
  // 预算因此分三层：目录（会话级真实成本）、整本手册（detail=full 与 docs/ai-operator.md）、
  // 单节（一次按需读取最多付多少）；历史版本小节另有独立预算。
  const indexBytes = Buffer.byteLength(AI_OPERATOR_GUIDE_INDEX, "utf8");
  const guideBytes = Buffer.byteLength(AI_OPERATOR_GUIDE, "utf8");
  const foundationBytes = Buffer.byteLength(AI_FOUNDATION_GUIDE, "utf8");
  const changelogBytes = Buffer.byteLength(AI_OPERATOR_CHANGELOG, "utf8");
  assert.ok(indexBytes <= 8_000, `伞式目录 ${indexBytes} 字节超过 8000 预算：目录只放节号/标题/子节/字节数/读取入口，不要夹带正文`);
  assert.ok(indexBytes * 10 < guideBytes, `伞式目录必须显著小于整本手册：${indexBytes} vs ${guideBytes}`);
  // 1.7.0 新增场景包（§13）：结构、发布、运行与授权语义保留在正文，版本沿革与长文在 CHANGELOG/x-packages。
  // 1.7.4 新增 core.llm 技能文本引用：手册正文只留一段操作要点（引用语法、合成顺序、失败语义），
  // 设计理由、与 local-export 边界的关系、完整失败矩阵都在 CHANGELOG 1.7.4 与能力目录 skillRef 说明里。
  // 1.7.7 新增运行事件通知 Webhook（§10.4）：事件白名单、聚合窗口、投递旁路、地址掩码与
  // 多平台适配器都留在 §10.4 与 x-notification-webhook，只按实际增量放宽；再增长应先合并旧小节。
  // 1.7.8 的「卡即身份」只改 §12 一句话，不新增小节。
  // 1.7.9 新增入站转发（§10.4 子节，约 0.9KB）：只写调用前事实（端点、鉴权、不能指定目标、同步回执），
  // 已合并成单段而不是四段；按实际增量放宽 1KB，再增长应先合并旧小节。
  // 伞式改造后整本手册不再是会话入场费（只有 detail=full 与 docs/ai-operator.md 付这份成本），
  // 预算含义改为「仓库与整本导出的体积」，因此按实际增量放宽到 120KB；会话级成本由上面的目录预算把关。
  assert.ok(guideBytes <= 120_000, `整本手册 ${guideBytes} 字节超过 120000 预算：把历史版本小节移到 AI_OPERATOR_CHANGELOG，不要留在手册正文里`);
  // 基础能力文档是按需生成的目录（detail=full / docs/ai-foundation.md），不是每次会话下发的内容；
  // 它的预算随功能矩阵增长而调整，前提是「长文留在权威契约里、不在这里重复」：
  // 1.5.42 新增的任务质检通道只登记功能与工具表，字段语义、截断/省略标记、状态机与恢复细节
  // 都写在 operations.ts 的单个操作说明、AI_OPERATOR_CHANGELOG 与 x-run-quality 契约里，没有搬进这里。
  // 1.6.0 新增积分与卡密域（7 个操作 + 1 条功能矩阵）：口径、时序与幂等长文写在手册 §12 与
  // x-credits 契约，这里只增长功能登记本身；后续新增功能仍应先拆分而不是继续抬高上限。
  // 1.7.7 新增通知 Webhook（3 个工具 + 1 条功能矩阵）：投递语义在 §10.4 与 x-notification-webhook，
  // 1.7.8 只在积分/卡密功能矩阵里补一句「卡即身份」，这里只增长功能登记，按实际增量放宽。
  assert.ok(foundationBytes <= 64_000, `基础能力文档 ${foundationBytes} 字节超过 64000 预算：把长文留在 operations.ts/CHANGELOG，不要复制进功能矩阵`);
  // 变更记录是滚动窗口：预算超限时从末尾整条删除最早的记录，因此断言只能依赖
  // 「结构仍然成立」（倒序、有最新条目、能按需读取），不能钉死某个历史版本号。
  assert.ok(changelogBytes <= 88_000, `变更记录 ${changelogBytes} 字节超过 88000 预算：追加新条目时从末尾整条删除最早的记录，不要压缩合并`);
  // 叶子节是最小按需读取单位：太大就说明该用 "### " 再拆一层，而不是让读者整章拉取。
  const leaves = AI_GUIDE_SECTIONS.filter(section => !section.childIds.length);
  const biggestLeaf = Math.max(...leaves.map(section => section.bytes));
  assert.ok(leaves.length >= 10, "手册必须真的按主题拆出可直接读取的叶子节");
  assert.ok(biggestLeaf <= 10_000, `叶子节 ${biggestLeaf} 字节超过 10000 预算：用 "### " 拆出子节`);
  // 父节号一次返回「本节 + 全部子节」，它是按需读取里最贵的一档：单节读取不能无限接近整本，
  // 否则伞式拆分就失去意义。超限时把该父节收短（细节下沉到子节），而不是抬高上限。
  // §1「接管前先检查」当前含 1.1–1.6，是最大的一节；按实际增量放宽到 24000。
  const biggestSection = Math.max(...AI_GUIDE_SECTIONS.map(section => section.bytes));
  assert.ok(biggestSection <= 24_000, `单节 ${biggestSection} 字节超过 24000 预算：把该父节正文下沉到 "### " 子节`);
  // 拆分不得丢内容：手册正文与变更记录合起来仍覆盖原来的版本小节。
  assert.ok(!AI_OPERATOR_GUIDE.includes("## 局域网管理入口（1.5.34）"), "版本小节不应留在手册正文里");
  assert.ok(!AI_OPERATOR_GUIDE_INDEX.includes("## 局域网管理入口（1.5.34）"), "版本小节不应留在会话级目录里");
  // 滚动窗口可能已经淘汰更早的条目，所以只断言"不在正文"与"窗口结构成立"，不要求它仍在 changelog。
  assert.ok(AI_OPERATOR_GUIDE.includes("## 1. 接管前先检查"));
});

test("AI工具说明预算：说明只写调用前事实，字段语义与长文各有归属", async () => {
  // 工具说明每次 MCP 会话固定下发，且与 schema 字段说明在同一份 tools/list 里。此前两者把同一批
  // 内容各写一遍，改一处要改两处、还容易漂移。预算按下发成本设：超限时先去重（指向手册节），
  // 不要把字段语义或设计理由搬回说明。
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const total = aiOperations.reduce((sum, operation) => sum + bytes(operation.description), 0);
  // 1.6.0 的积分/卡密与 1.7.0 的场景包操作说明合计约 2.3KB：计费时序、包内协同与授权语义
  // 写在手册 §12/§13 与 x-credits/x-packages 契约，工具说明只保留「调用前必须知道」的那几句。
  // 1.7.7 的 3 个通知 Webhook 工具（get/update/test）合计约 1.1KB：事件白名单、聚合与投递语义
  // 在 §10.4 与 x-notification-webhook，说明只保留调用前事实，因此按实际增量放宽 1.5KB。
  // 1.7.9 新增 relay_notification（约 0.2KB，入站转发的管理员入口）：字段语义在 relayMessage schema，
  // 调用前事实（不能指定目标、同步回执）留在说明里，因此按实际增量再放宽 0.5KB。
  // 1.7.10 新增 get_own_package_run_inputs（约 0.4KB，服务运行原始输入）：分页/省略语义与
  // get_own_run_inputs 相同，说明只写「字段取固定快照、值可带进新提交」，其余指向既有工具，
  // 因此按实际增量放宽 0.5KB。
  assert.ok(total <= 44_500, `工具说明合计 ${total} 字节超过 44500 预算：字段语义在 schema 里，长文在手册分节`);
  const longest = aiOperations.map(operation => ({ name: operation.name, bytes: bytes(operation.description) })).reduce((a, b) => a.bytes >= b.bytes ? a : b);
  assert.ok(longest.bytes <= 900, `工具说明 ${longest.name} 为 ${longest.bytes} 字节超过 900 预算：把它拆到手册分节并在说明里引用节号`);
  // 瘦身不得删掉「调用前就得知道」的事实：写操作必须仍然说明先保存哪个 ID。
  for (const name of ["submit_scene", "submit_own_scene", "resume_run", "rerun", "create_scene", "publish_scene", "create_direct_llm_provider", "submit_run_critique"]) {
    const description = aiOperations.find(operation => operation.name === name)!.description;
    assert.match(description, /保存/, name + " 的说明必须仍写明写前先保存 ID");
  }
  // 协议常量只有 domain 一处定义：散文写成字面量会在常量变更后静默失真。
  for (const file of ["server/ai/operations.ts", "server/ai/features.ts", "server/ai/schemas.ts", "server/ai/guide.ts"]) {
    assert.ok(!(await readFile(file, "utf8")).includes(directLlmAnthropicVersion), file + " 把 anthropic-version 写成了字面量，应插值引用 directLlmAnthropicVersion");
  }
});

test("AI手册伞式目录契约：目录列出全部节、正文按节可读且逐字节不丢内容", () => {
  // 伞式目录是会话级唯一入口：它必须自己就能导航（节号、标题、字节数、读取入口），
  // 又不能夹带正文，否则「按需读取」会退化成「整本下发」。
  const ids = AI_GUIDE_SECTIONS.map(section => section.id);
  assert.equal(new Set(ids).size, ids.length, "节号必须唯一：" + ids.join(","));
  const topLevel = AI_GUIDE_SECTIONS.filter(section => !section.parentId);
  const encoder = new TextEncoder();
  assert.equal(AI_OPERATOR_GUIDE, AI_OPERATOR_GUIDE_INDEX + "\n\n" + topLevel.map(section => section.text).join("\n"), "整本手册必须等于目录 + 全部顶层节，不能少一节也不能重复计费");
  for (const section of AI_GUIDE_SECTIONS) {
    // 目录必须给出该节的节号、标题、字节数与可直接读取的入口。
    assert.ok(AI_OPERATOR_GUIDE_INDEX.includes("| " + section.id + " |"), section.id + " 未出现在目录里");
    assert.ok(AI_OPERATOR_GUIDE_INDEX.includes(section.uri), section.uri + " 未出现在目录里");
    assert.equal(aiGuideText(section.id), section.text, section.id + " 的 detail 读取与目录声明不一致");
    assert.equal(aiGuideSection(section.id)?.text, section.text);
    assert.equal(section.bytes, encoder.encode(section.text).length, section.id + " 的字节数与正文不一致");
    // 节正文必须是整本手册里的一段连续文本，不能是剪切拼装的产物。
    assert.ok(AI_OPERATOR_GUIDE.includes(section.text), section.id + " 的正文不是手册里的连续文本");
    if (section.parentId) assert.ok(aiGuideSection(section.parentId)!.text.includes(section.text), section.id + " 必须完整包含在父节里");
  }
  // 目录本身不含正文标题行；会话级成本必须只是目录。
  assert.doesNotMatch(AI_OPERATOR_GUIDE_INDEX, /\n## [0-9]/);
  assert.ok(encoder.encode(AI_OPERATOR_GUIDE_INDEX).length < encoder.encode(AI_OPERATOR_GUIDE).length / 5);
  // detail 选择：默认目录、整本含目录与历史、旧默认值 handbook 仍是目录、未知值明确 undefined（路由转 400）。
  assert.equal(aiGuideText("index"), AI_OPERATOR_GUIDE_INDEX);
  assert.equal(aiGuideText("handbook"), AI_OPERATOR_GUIDE_INDEX);
  assert.ok(aiGuideText("full")!.startsWith(AI_OPERATOR_CHANGELOG));
  assert.ok(aiGuideText("full")!.includes(AI_OPERATOR_GUIDE));
  assert.equal(aiGuideText("changelog"), AI_OPERATOR_CHANGELOG);
  // "12" 已是被占用的真实节号（积分与卡密），未知值改用真正不存在的节号。
  for (const missing of ["", "0", "1.7", "12.1", "bogus", "handbook "]) assert.equal(aiGuideText(missing), undefined, "未知 detail 必须返回 undefined：" + missing);
  // 目录必须能把最关键的恢复规则指出来，否则「只读目录」的 AI 会漏掉它。
  assert.match(AI_OPERATOR_GUIDE_INDEX, /响应丢失/);
  assert.match(AI_OPERATOR_GUIDE_INDEX, /zane:\/\/guide\/9/);
});

test("AI契约接受 Hermes 单项反馈和退回意见，拒绝空文本和伪造快照", () => {
  const preview = aiOperations.find(operation => operation.name === "preview_rerun")!.schema;
  const sourceRunId = "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b";
  assert.equal(preview.safeParse({ sourceRunId, changes: { feedback: [{ stepId: "writer", itemIndex: 1, message: "加强冲突" }] } }).success, true);
  assert.equal(preview.safeParse({ sourceRunId, changes: { feedback: [{ stepId: "writer", message: " " }] } }).success, false);
  assert.equal(preview.safeParse({ sourceRunId, changes: { feedback: [{ stepId: "writer", message: "意见", originalOutputs: {} }] } }).success, false);
  const review = aiOperations.find(operation => operation.name === "review_run")!.schema;
  assert.equal(review.safeParse({ runId: sourceRunId, reviewId: "review", action: "redo", feedback: "缩短开头" }).success, true);
});


test("AI发现契约：summary默认省略说明文本且明确标记，full与契约同源，非法detail拒绝", () => {
  // get_workbench 每次会话都会被读取：默认 summary 只保留路由/副作用/权限事实并显式声明省略，
  // full 仍返回与契约完全一致的说明，避免静默变薄。
  assert.deepEqual(catalogueDetailQuery.parse({}), { detail: "summary" });
  assert.equal(catalogueDetailQuery.safeParse({ detail: "full" }).success, true);
  assert.equal(catalogueDetailQuery.safeParse({ detail: "everything" }).success, false);

  const summary = catalogueOperations(aiOperations, "summary");
  const full = catalogueOperations(aiOperations, "full");
  assert.equal(summary.length, aiOperations.length);
  assert.equal(full.length, aiOperations.length);
  assert.deepEqual(summary.map(o => o.name), aiOperations.map(o => o.name));
  for (const operation of summary) {
    assert.equal(operation.description, undefined, operation.name + " 在 summary 里不应带说明文本");
    assert.ok(operation.path && operation.method && operation.effect && operation.access);
  }
  for (const operation of full) assert.equal(operation.description, aiOperations.find(item => item.name === operation.name)!.description);
  const summaryBytes = Buffer.byteLength(JSON.stringify({ features: catalogueFeatures(AI_FOUNDATION_FEATURES, "summary"), operations: summary }));
  const fullBytes = Buffer.byteLength(JSON.stringify({ features: catalogueFeatures(AI_FOUNDATION_FEATURES, "full"), operations: full }));
  assert.ok(summaryBytes < fullBytes / 2, "summary 必须显著小于 full：" + summaryBytes + " vs " + fullBytes);
  assert.equal(CATALOGUE_SUMMARY_OMISSION.descriptionsOmitted, true);
  assert.ok(CATALOGUE_SUMMARY_OMISSION.omissionReason.includes("detail=full"));
});

test("AI手册拆分契约：会话级只下发伞式目录，正文与历史小节按需读取且不丢内容", () => {
  // 会话级资源只有目录；历史小节移到 changelog，正文按节读取，避免每次会话都付整本手册的成本。
  // 变更记录是滚动窗口（见体积预算用例），这里不钉死具体历史版本号，只校验结构与读取入口。
  assert.ok(!AI_OPERATOR_GUIDE_INDEX.includes("## 局域网管理入口（1.5.34）"));
  assert.ok(!AI_OPERATOR_GUIDE.includes("## 局域网管理入口（1.5.34）"), "版本小节不应留在手册正文里");
  // 编号正文必须能从目录声称的节号读到，而不是只存在于整本手册里。
  for (const [id, heading] of [["1", "## 1. 接管前先检查"], ["9", "## 9. 响应丢失与冲突恢复（最重要）"], ["11", "## 11. 接管验收清单"]]) {
    assert.ok(AI_OPERATOR_GUIDE.includes(heading), heading);
    assert.ok(aiGuideText(id)!.includes(heading), id + " 节读不到 " + heading);
  }
  // 变更记录是滚动窗口：结构（标题、倒序、可读）必须稳定，但不保证某个历史版本号仍在窗口内。
  assert.ok(AI_OPERATOR_CHANGELOG.startsWith("# 版本变更记录"));
  const changelogEntries = AI_OPERATOR_CHANGELOG.match(/^## .+$/gm) ?? [];
  assert.ok(changelogEntries.length >= 20, "变更记录应保留足够的历史窗口：" + changelogEntries.length);
});

test("AI手册HTTP入口：默认只回伞式目录，节号取正文，未知detail明确拒绝", async t => {
  const h = await aiHarness(t);
  const index = await (await fetch(h.base + "/api/v1/ai/guide")).text();
  assert.match(index, /伞式目录/);
  assert.ok(Buffer.byteLength(index, "utf8") < 12_000, "默认入口不得再回整本手册");
  assert.doesNotMatch(index, /\n## [0-9]/, "目录不应夹带正文");
  // 旧默认值 handbook 现在与 index 同义（会话级手册 = 目录），不静默变薄也不静默变大。
  assert.equal(await (await fetch(h.base + "/api/v1/ai/guide?detail=handbook")).text(), index);
  const section = await (await fetch(h.base + "/api/v1/ai/guide?detail=9")).text();
  assert.match(section, /^## 9\. 响应丢失与冲突恢复/);
  assert.ok(section.length < index.length * 2);
  const full = await (await fetch(h.base + "/api/v1/ai/guide?detail=full")).text();
  assert.ok(full.includes(index) && full.includes(section), "full 必须同时含目录与全部正文");
  const changelog = await (await fetch(h.base + "/api/v1/ai/guide?detail=changelog")).text();
  assert.ok(changelog.startsWith("# 版本变更记录"));
  for (const bad of ["99", "1.7", "", "bogus"]) assert.equal((await fetch(h.base + "/api/v1/ai/guide?detail=" + bad)).status, 400, "未知 detail 必须 400：" + bad);
});

test("AI发现接口：detail分级经HTTP契约暴露，默认与full都可用", async t => {
  const h = await aiHarness(t);
  const summary = await (await fetch(h.base + "/api/v1/ai")).json() as { operations: Array<{ name: string; description?: string }>; features: Array<{ id: string; description?: string }>; catalogueSummary?: { descriptionsOmitted: boolean } };
  assert.equal(summary.operations.length, aiOperations.length);
  assert.equal(summary.operations[0].description, undefined);
  assert.equal(summary.features[0].description, undefined);
  assert.equal(summary.catalogueSummary?.descriptionsOmitted, true);
  const full = await (await fetch(h.base + "/api/v1/ai?detail=full")).json() as { operations: Array<{ name: string; description?: string }>; catalogueSummary?: unknown };
  assert.equal(full.operations[0].description, aiOperations.find(operation => operation.name === full.operations[0].name)!.description);
  assert.equal(full.catalogueSummary, undefined);
  assert.equal((await fetch(h.base + "/api/v1/ai?detail=bogus")).status, 400);
});

test("AI基础能力覆盖门禁：每个功能的工具存在，每个工具都有功能归属", () => {
  const operations = new Set(aiOperations.map(operation => operation.name)); const covered = new Set<string>(); const ids = new Set<string>();
  for (const feature of AI_FOUNDATION_FEATURES) {
    assert.ok(!ids.has(feature.id), "重复功能ID：" + feature.id); ids.add(feature.id); assert.ok(feature.description); assert.ok(feature.operations.length);
    for (const name of feature.operations) { assert.ok(operations.has(name), feature.id + "缺少工具：" + name); covered.add(name); }
  }
  for (const operation of aiOperations) assert.ok(covered.has(operation.name), "新工具必须同步登记AI功能矩阵：" + operation.name);
  for (const name of ["create_scene", "get_scene_draft", "update_scene_draft", "validate_scene_draft", "publish_scene", "restore_scene_draft", "delete_scene", "list_option_presets", "save_option_preset", "delete_option_preset", "get_run_outputs", "get_step_result"]) assert.ok(operations.has(name));
});

test("AI基础能力文档由功能矩阵生成，不允许手册与实际工具漂移", async () => {
  assert.equal((await readFile("docs/ai-foundation.md", "utf8")).replace(/\r\n/g, "\n"), AI_FOUNDATION_GUIDE);
});


test("发布OpenAPI同时声明首次201和重复回执200", () => {
  const responses = (createAiOpenApi().paths["/api/v1/scenes/{sceneId}/publish"].post as { responses: Record<string, { content: unknown }> }).responses;
  assert.ok(responses["201"]); assert.ok(responses["200"]); assert.deepEqual(responses["201"].content, responses["200"].content);
});


test("预设读写契约分离：读模型允许revision，写模型拒绝派生字段", () => {
  const api = createAiOpenApi(); const preset = api.components.schemas.OptionPreset as { properties: Record<string, unknown> };
  assert.ok(!("revision" in preset.properties)); assert.ok(!("usedBySceneIds" in preset.properties));
  const save = aiOperations.find(operation => operation.name === "save_option_preset")!.schema;
  assert.equal(save.safeParse({ preset: { id: "p", name: "选项", options: ["a"], revision: "a".repeat(64) } }).success, false);
  const responses = (api.paths["/api/v1/option-presets"].post as { responses: Record<string, { content: Record<string, { schema: { $ref: string } }> }> }).responses;
  assert.equal(responses["200"].content["application/json"].schema.$ref, "#/components/schemas/OptionPresetMutation");
});


test("统一能力目录请求/响应契约包含revision分页与通用媒体值schema", () => {
  const operation = aiOperations.find((item) => item.name === "list_capabilities")!;
  assert.equal(operation.effect, "read"); assert.deepEqual(operation.schema.parse({}), { limit: 50 });
  assert.equal(operation.schema.safeParse({ limit: 1 }).success, true); assert.equal(operation.schema.safeParse({ tier: "basic" }).success, false); assert.equal(operation.schema.safeParse({ limit: 0 }).success, false);
  const api = createAiOpenApi();
  assert.ok(api.components.schemas.CapabilityCatalog); assert.ok(api.components.schemas.MediaReferenceGroups); assert.ok(api.components.schemas.ImageLayout);
  const response = (api.paths["/api/v1/capabilities"].get as { responses: Record<string, any> }).responses["200"].content["application/json"].schema;
  assert.equal(response.$ref, "#/components/schemas/CapabilityCatalog");
});

test("认证HTTP契约区分公共初始化/登录与需身份业务；不假装存在密码MCP工具", () => {
  const api = createAiOpenApi();
  for (const [path, method] of [["/api/auth/status", "get"], ["/api/auth/setup", "post"], ["/api/auth/login", "post"]]) {
    const operation = api.paths[path][method] as Record<string, unknown>;
    assert.deepEqual(operation.security, []);
    assert.equal(operation["x-mcp-tool"], undefined);
  }
  const logout = api.paths["/api/v1/self/logout"].post as Record<string, unknown>;
  assert.equal(logout["x-access-role"], "authenticated");
  assert.equal(logout["x-mcp-tool"], undefined);
  assert.ok(Array.isArray(logout.security));
  assert.ok(!aiOperations.some(operation => /auth_(login|setup)/.test(operation.name)));
});


test("素材AI契约：稳定新建/追加版本约束，新字段与分页响应同源", () => {
  const upload = aiOperations.find(operation => operation.name === "upload_asset")!.schema;
  const createId = "00000000-0000-4000-8000-000000000111";
  const metadata = { filePath: "C:/temporary/hero.png", kind: "image" };
  assert.equal(upload.safeParse(metadata).success, false);
  assert.equal(upload.safeParse({ ...metadata, createId, description: "雨夜角色", group: "第一集", tags: ["雨夜"] }).success, true);
  assert.equal(upload.safeParse({ ...metadata, assetId: createId, revision: 1 }).success, true);
  for (const extra of [{ createId, assetId: createId, revision: 1 }, { assetId: createId }, { createId, revision: 1 }, { createId, ownerUserId: "spoof" }, { createId, description: "x".repeat(4001) }]) assert.equal(upload.safeParse({ ...metadata, ...extra }).success, false);
  const query = aiOperations.find(operation => operation.name === "list_assets")!.schema; const defaults = query.parse({}); assert.equal(defaults.limit, 24); assert.equal(defaults.archived, false);
  const api = createAiOpenApi(); const uploadHttp = api.paths["/api/v1/assets/upload"].post as { parameters: Array<{ name: string }> };
  for (const name of ["createId", "description", "group", "tags"]) assert.ok(uploadHttp.parameters.some(parameter => parameter.name === name));
  const responses = (api.paths["/api/v1/assets"].get as { responses: Record<string, { content: { "application/json": { schema: { $ref: string } } } }> }).responses;
  assert.equal(responses["200"].content["application/json"].schema.$ref, "#/components/schemas/AssetPage");
  assert.ok(api.paths["/api/v1/assets/{assetId}/versions"].get); assert.ok(api.paths["/api/v1/assets/{assetId}/versions/{version}"].get);
});

test("流程diff工具与HTTP响应机器契约同源，只读且值读取要求差异revision", () => {
  const api = createAiOpenApi();
  for (const name of ["get_scene_draft_diff", "get_scene_draft_diff_value"]) {
    const op = aiOperations.find(operation => operation.name === name)!;
    assert.equal(op.effect, "read"); assert.equal(op.access ?? "admin", "admin");
    const response = (api.paths[op.path].get as any).responses["200"].content["application/json"].schema;
    assert.ok(response.$ref.endsWith(name.endsWith("_value") ? "/SceneDiffValuePage" : "/SceneDiffPage"));
  }
  const query = aiOperations.find(operation => operation.name === "get_scene_draft_diff")!.schema;
  assert.equal(query.safeParse({ sceneId: "demo", limit: 1, valueLimit: 2, contentHash: "deadbeef" }).success, true);
  assert.equal(query.safeParse({ sceneId: "demo", revision: "bad" }).success, false);
  assert.equal(query.safeParse({ sceneId: "demo", limit: 0 }).success, false);
  const value = aiOperations.find(operation => operation.name === "get_scene_draft_diff_value")!.schema;
  assert.equal(value.safeParse({ sceneId: "demo", changeId: "c".repeat(24), side: "after" }).success, false);
  assert.equal(value.safeParse({ sceneId: "demo", revision: "a".repeat(64), changeId: "c".repeat(24), side: "after", offset: 2, limit: 2 }).success, true);
});

test("收藏机器契约是显式布尔目标值且必须带revision，拒绝伪造归属；HTTP输出有isFavorite和版本", () => {
  for (const name of ["set_task_draft_favorite", "set_own_draft_favorite"]) {
    const operation = aiOperations.find(item => item.name === name)!;
    assert.equal(operation.effect, "write");
    assert.equal(operation.schema.safeParse({ draftId: "stable-id", revision: 1, isFavorite: true }).success, true);
    for (const args of [{ draftId: "stable-id", revision: 1 }, { draftId: "stable-id", isFavorite: true }, { draftId: "stable-id", revision: 0, isFavorite: true }, { draftId: "stable-id", revision: 1, isFavorite: "true" }, { draftId: "stable-id", revision: 1, isFavorite: false, userId: "forged" }]) assert.equal(operation.schema.safeParse(args).success, false, JSON.stringify(args));
  }
  const api = createAiOpenApi();
  for (const name of ["TaskDraft", "UserDraft"]) assert.ok((api.components.schemas[name] as {properties:Record<string,unknown>}).properties.isFavorite);
  assert.equal(aiOperations.find(item => item.name === "set_own_draft_favorite")!.access, "authenticated");
});


test("系统反馈机器契约与普通审核边界：唯一原子工具、默认类型、owner不可伪造和明确返回schema", () => {
  const input = { feedbackId: "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b", title: "问题", description: "详情" };
  const submit = aiOperations.find(operation => operation.name === "submit_system_feedback")!;
  assert.equal(submit.schema.parse(input).category, "bug"); assert.equal(submit.effect, "write"); assert.equal(submit.access, "authenticated");
  assert.equal(submit.schema.safeParse({ ...input, userId: "fake" }).success, false);
  const handle = aiOperations.find(operation => operation.name === "handle_system_feedback")!;
  assert.equal(handle.access ?? "admin", "admin"); assert.equal(handle.effect, "write");
  assert.equal(handle.schema.safeParse({ feedbackId: input.feedbackId, status: "resolved", reply: "回复" }).success, false);
  const ownReview = aiOperations.find(operation => operation.name === "review_own_run")!.schema;
  assert.equal(ownReview.safeParse({ runId: input.feedbackId, reviewId: "review", action: "redo" }).success, true);
  assert.equal(ownReview.safeParse({ runId: input.feedbackId, reviewId: "review", action: "redo", feedback: "不允许直接进入Agent" }).success, false);
  const api = createAiOpenApi();
  assert.equal(((api.paths[submit.path].post as any).responses["201"].content["application/json"].schema).$ref, "#/components/schemas/SystemFeedbackEnvelope");
  assert.ok(api.components.schemas.SystemFeedbackPage); assert.ok(api.components.schemas.SystemFeedbackEnvelope);
});


test("AI机器契约：通用开始条件进入步骤schema，拒绝无效规则并保留旧条件兼容", () => {
  const operation = aiOperations.find(item => item.name === "update_scene_draft")!;
  const base = { sceneId: "scene", revision: "a".repeat(64), workflow: { inputs: [], outputs: [], steps: [{ id: "step", name: "step", kind: "hermes", startCondition: { match: "all", rules: [{ id: "r1", leftRef: "input.reference", operator: "is_not_empty", valueSource: "literal", rightValue: "", rightRef: "" }] } }] } };
  assert.equal(operation.schema.safeParse(base).success, true);
  const referenced = { match: "any", rules: [{ id: "r1", leftRef: "input.flag", operator: "equals", valueSource: "reference", rightRef: "step.other.outputs.value", rightValue: "" }] };
  assert.equal(operation.schema.safeParse({ ...base, workflow: { inputs: [], outputs: [], steps: [{ id: "step", name: "step", kind: "hermes", startCondition: referenced }] } }).success, true);
  for (const startCondition of [
    { match: "all" },
    { match: "all", rules: [{ leftRef: "input.reference" }] },
    { match: "sometimes", rules: [{ id: "r1", leftRef: "input.reference", operator: "is_not_empty", valueSource: "literal", rightValue: "", rightRef: "" }] },
    { match: "all", rules: [{ id: "r1", leftRef: "input.reference", operator: "is_not_empty", valueSource: "maybe", rightValue: "", rightRef: "" }] },
  ]) assert.equal(operation.schema.safeParse({ ...base, workflow: { inputs: [], outputs: [], steps: [{ id: "step", name: "step", kind: "hermes", startCondition }] } }).success, false, JSON.stringify(startCondition));
  const legacy = { id: "cond", name: "判断", kind: "control", control: { type: "condition", match: "all", rules: [{ id: "r1", leftRef: "input.flag", operator: "is_not_empty", valueSource: "literal", rightValue: "", rightRef: "" }] }, outputs: [{ key: "result", type: "boolean" }] };
  assert.equal(operation.schema.safeParse({ ...base, workflow: { inputs: [], outputs: [], steps: [legacy] } }).success, true);
  assert.ok(JSON.stringify(createAiOpenApi()).includes("startCondition"), "OpenAPI 必须包含开始条件");
  // 开始条件的行为契约写在手册正文与 schema 里；changelog 是滚动窗口，不保证该历史条目仍在。
  assert.match(AI_OPERATOR_GUIDE, /startCondition/);
});

test("AI草稿媒体引用类型字段显式可操作，拒绝未声明类型与伪造配置", () => {
  const operation = aiOperations.find(item => item.name === "update_scene_draft")!;
  const base = { sceneId: "scene", revision: "a".repeat(64), workflow: { inputs: [], outputs: [], steps: [{ id: "step", name: "step", kind: "hermes", inputs: [{ key: "refs", sourceRef: "iteration.item.references.images", referenceType: "image_list" }] }] } };
  assert.equal(operation.schema.safeParse(base).success, true);
  for (const referenceType of ["image", "json", "unknown"]) {
    const invalid = structuredClone(base); invalid.workflow.steps[0].inputs[0].referenceType = referenceType;
    assert.equal(operation.schema.safeParse(invalid).success, false);
  }
});

test("AI机器契约公开静态开关、命名动态标量与连续序号配置", () => {
  const api = createAiOpenApi() as Record<string, any>;
  assert.equal(api["x-comfy-static-switch"].version, 1);
  assert.equal(api["x-comfy-static-switch"].nodeType, "ComfySwitchNode");
  assert.match(api["x-comfy-static-switch"].emptyOptionalVideo, /clears/);
  assert.match(aiOperations.find(operation => operation.name === "submit_scene")!.description, /x-comfy-static-switch/);
  assert.match(aiOperations.find(operation => operation.name === "update_scene_draft")!.description, /ordinalField/);
  assert.ok(api.components.schemas.DataZipConfig.properties.ordinalField);
  // 长文配置的行为契约在手册正文（§1 长文小节）；changelog 是滚动窗口，不保证 1.5.14 条目仍在。
  assert.match(AI_OPERATOR_GUIDE, /Writer 只输出可读 storyboard 和结构化 shots/);
  assert.match(AI_OPERATOR_GUIDE, /AIXG 以 for_each 逐镜转换/);
});


test("固定音色上传契约经既有HTTP/MCP入口发现，预检无生成", () => {
  const api = createAiOpenApi();
  const audio = api["x-asset-media-execution"].audioConsumers;
  assert.equal(audio.uploadLimitBytes, 100_000_000);
  assert.equal(audio.previewFallback, false);
  assert.equal(audio.uploadRoute, "/upload/image");
  assert.equal(audio.uploadFormField, "image");
  assert.equal(audio.failure, "fail_before_prompt_submission_no_automatic_retry");
  assert.deepEqual(api.components.schemas.MediaExecutionAccess.const, api["x-asset-media-execution"]);
  assert.match(aiOperations.find(operation => operation.name === "submit_scene")!.description, /audioConsumers/);
  // 音频列表上传契约在 x-asset-media-execution 与功能矩阵；changelog 是滚动窗口，不钉死 1.5.23 条目。
  assert.ok(AI_FOUNDATION_FEATURES.find(feature => feature.id === "asset-execution-access")!.description.includes("audio_list"));
});

test("日志查看机器契约：两个只读工具、具名响应schema、越界文件名与无效参数被拒", () => {
  const api = createAiOpenApi() as Record<string, any>;
  for (const name of ["get_system_logs", "get_ops_log"]) {
    const operation = aiOperations.find(item => item.name === name)!;
    assert.equal(operation.effect, "read", name + " 必须是只读操作");
    // Read-only tools must stay admin-only: raw logs carry host paths and service addresses.
    assert.equal(operation.access ?? "admin", "admin");
  }
  assert.equal((api.paths["/api/v1/maintenance/logs"].get as any).responses["200"].content["application/json"].schema.$ref, "#/components/schemas/SystemLogPage");
  assert.equal((api.paths["/api/v1/maintenance/logs/ops"].get as any).responses["200"].content["application/json"].schema.$ref, "#/components/schemas/OpsLogPage");
  assert.ok(api.components.schemas.SystemLogPage);
  assert.ok(api.components.schemas.OpsLogPage);

  const logs = aiOperations.find(item => item.name === "get_system_logs")!.schema;
  assert.deepEqual(logs.parse({}), { limit: 50 });
  assert.equal(logs.safeParse({ limit: 1, level: "warn", event: "run.", q: "boom", runId: "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b", sceneId: "demo" }).success, true);
  for (const invalid of [{ limit: 0 }, { limit: 201 }, { level: "debug" }, { runId: "nope" }, { file: "watchdog.log" }, { path: "/etc/passwd" }, { userId: "admin" }]) {
    assert.equal(logs.safeParse(invalid).success, false, "get_system_logs 应拒绝：" + JSON.stringify(invalid));
  }

  const ops = aiOperations.find(item => item.name === "get_ops_log")!.schema;
  assert.deepEqual(ops.parse({ file: "watchdog.log" }), { file: "watchdog.log", tailLines: 200 });
  assert.equal(ops.safeParse({ file: "watchdog.log", tailLines: 2000, level: "error", q: "boom" }).success, true);
  // The file parameter is an allowlist, so no path-like value can ever be accepted.
  for (const file of ["../../zane.db", "zane.db", "/etc/passwd", "", "watchdog.log.bak", "C:\\Windows\\win.ini"]) {
    assert.equal(ops.safeParse({ file }).success, false, "get_ops_log 应拒绝：" + JSON.stringify(file));
  }
  for (const invalid of [{ file: "watchdog.log", tailLines: 0 }, { file: "watchdog.log", tailLines: 2001 }, { file: "watchdog.log", level: "debug" }, { file: "watchdog.log", userId: "admin" }]) {
    assert.equal(ops.safeParse(invalid).success, false, "get_ops_log 应拒绝：" + JSON.stringify(invalid));
  }
});

test("日志查看已登记功能矩阵与手册，普通用户入口不暴露", () => {
  const feature = AI_FOUNDATION_FEATURES.find(item => item.id === "system-logs");
  assert.ok(feature, "日志查看必须有功能矩阵归属");
  assert.deepEqual([...feature.operations], ["get_system_logs", "get_ops_log"]);
  // The description must keep stating the boundaries the UI and guide also state.
  for (const fact of ["ZANE_LOG_BUFFER_ENTRIES", "LOG_PAGE_CHANGED", "INVALID_LOG_CURSOR", "追加安全", "白名单", "脱敏", "truncated", "available", "complete", "BOM", "合法JSON"]) {
    assert.ok(feature.description.includes(fact), "功能说明缺少边界事实：" + fact);
  }
  // It must also state what the surface is NOT, so an AI cannot mistake it for a state oracle
  // or an arbitrary-file reader.
  assert.match(feature.description, /不接受任意路径|不是任意文件读取代理/);
  assert.match(feature.description, /只读/);
  assert.match(AI_OPERATOR_GUIDE, /## 10\.2 日志查看/);
  // 行为契约以手册正文为准；changelog 是滚动窗口，不保证 1.5.37 条目仍在窗口内。
  // Admin surface only: a user-only OpenAPI document must not advertise either tool.
  const userDoc = createAiOpenApi({ userOnly: true });
  assert.ok(!userDoc.paths["/api/v1/maintenance/logs"]);
  assert.ok(!userDoc.paths["/api/v1/maintenance/logs/ops"]);
  // Both are real MCP tools on the full management contract.
  assert.equal((createAiOpenApi().paths["/api/v1/maintenance/logs"] as any).get["x-mcp-tool"], "get_system_logs");
  assert.equal((createAiOpenApi().paths["/api/v1/maintenance/logs/ops"] as any).get["x-mcp-tool"], "get_ops_log");
});

test("本机媒体查看已登记功能矩阵与手册，不在用户入口暴露且不接受路径", () => {
  const feature = AI_FOUNDATION_FEATURES.find(item => item.id === "local-media-view");
  assert.ok(feature, "本机媒体查看必须有功能矩阵归属");
  // 必须写清授权边界、只读性与「只收坐标不收路径」这三件事。
  for (const fact of ["local-export", "FILE_ACCESS_DISABLED", "local-media", "只读"]) {
    assert.ok(feature.description.includes(fact), "功能说明缺少边界事实：" + fact);
  }
  assert.match(feature.description, /不是任意文件读取代理/);
  assert.match(feature.description, /只提交坐标|不接受路径/);
  assert.match(AI_OPERATOR_GUIDE, /## 10\.3 查看运行里的本机媒体/);

  // 机器契约与 OpenAPI 媒体路径同源：GET/HEAD 都在，参数只含坐标与缩放宽度。
  const api = createAiOpenApi();
  assert.equal(api["x-local-media"].access.role, "admin");
  assert.equal(api["x-local-media"].route.path, "/api/v1/runs/{runId}/local-media");
  const document = api.paths["/api/v1/runs/{runId}/local-media"] as { get: { operationId: string; parameters: Array<{ name: string; in: string; required?: boolean }> }; head: { operationId: string } };
  assert.equal(document.get.operationId, "media_local");
  assert.equal(document.head.operationId, "head_local");
  const names = document.get.parameters.map(parameter => parameter.name);
  for (const name of ["runId", "Range", "stepId", "itemIndex", "outputKey", "mediaIndex", "w"]) assert.ok(names.includes(name), name);
  // 只有 outputKey 是必填查询参数；路径参数与 Range 头单独存在。
  for (const parameter of document.get.parameters) {
    if (parameter.in === "query" && parameter.required) assert.equal(parameter.name, "outputKey");
  }
  // 群举里不能出现任何「直接给路径」的参数，否则就变成了任意文件读取代理。
  for (const name of ["path", "file", "filename", "url", "absolutePath"]) assert.ok(!names.includes(name), name);

  // 仅管理员：用户专用入口文档不得出现该路径，公开入口也不允许它。
  const userDoc = createAiOpenApi({ userOnly: true });
  assert.ok(!userDoc.paths["/api/v1/runs/{runId}/local-media"], "本机媒体查看是管理员能力，不得出现在用户入口契约里");
  for (const method of ["GET", "HEAD"]) assert.equal(publicRequestAllowed(method, "/api/v1/runs/1/local-media"), false, method);
  assert.equal(publicRequestAllowed("POST", "/api/v1/runs/1/local-media"), false);
});

test("直连模型提供商机器契约：密钥明文入库但永不回显、地址允许本机、不在用户入口暴露", () => {
  const feature = AI_FOUNDATION_FEATURES.find(item => item.id === "llm-step");
  assert.ok(feature, "core.llm 必须有功能矩阵归属");
  const operationNames: readonly string[] = feature.operations;
  for (const name of ["list_direct_llm_providers", "get_direct_llm_provider", "create_direct_llm_provider", "update_direct_llm_provider", "delete_direct_llm_provider", "query_direct_llm_models"]) {
    assert.ok(operationNames.includes(name), "core.llm 的功能矩阵缺少工具：" + name);
  }
  // 功能说明必须写清密钥边界与直连语义。
  for (const fact of ["apiKey", "明文", "本机 SQLite", "环境变量", "direct", "chat/completions", "回显", "本机"]) {
    assert.ok(feature.description.includes(fact), "功能说明缺少边界事实：" + fact);
  }
  assert.match(AI_OPERATOR_GUIDE, /### 直连模型提供商（core\.llm\.direct，1\.5\.40）/);

  const api = createAiOpenApi();
  const directLlm = api["x-direct-llm"];
  assert.equal(directLlm.version, "2");
  assert.equal(directLlm.capabilityId, "core.llm");
  assert.equal(directLlm.mode.default, false, "direct 默认 false 是向后兼容的关键事实");
  const fields = directLlm.providers.fields;
  assert.equal(fields.apiKeyEnv.format, "^[A-Z][A-Z0-9_]{0,127}$");
  assert.equal(fields.apiKeyEnv.precedence, "apiKey (plaintext, saved) wins; otherwise apiKeyEnv is read from process.env at request time");
  assert.equal(fields.apiKey.storage, "plaintext in the local SQLite direct-llm-provider record");
  assert.equal(fields.apiKey.optional, true);
  // 密钥传输语义必须是三态：省略=保持、空串=清除、非空=替换。
  assert.deepEqual(fields.apiKey.writeSemantics, { omitted: "keep the stored key unchanged (editing only the name or address never clears it)", emptyString: "clear the stored key", nonEmpty: "replace the stored key" });
  assert.match(fields.baseUrl.addressPolicy, /loopback and private addresses are allowed/);
  assert.equal(directLlm.providers.enabledRequires.join(","), "name,baseUrl,one of apiKey|apiKeyEnv");
  // 明文入库这一事实必须写进契约，并且护栏逐条列出。
  assert.match(directLlm.providers.plaintextAtRest.fact, /stored in plaintext in this machine's SQLite database/);
  assert.ok(directLlm.providers.plaintextAtRest.guards.length >= 5);
  assert.match(directLlm.providers.plaintextAtRest.guards.join(" "), /no read operation returns the plaintext/);
  assert.match(directLlm.providers.plaintextAtRest.guards.join(" "), /run records/);
  assert.equal(Object.keys(directLlm.protocols).join(","), "openai-chat,anthropic");
  assert.match(directLlm.protocols["openai-chat"].request, /\/chat\/completions$/);
  assert.equal(directLlm.protocols.anthropic.authentication, "x-api-key: <key> 与 anthropic-version: 2023-06-01");
  assert.equal(directLlm.protocols.anthropic.body.system.includes("top-level field"), true);

  // 路径：列表/新建、单条读改删、查询模型；响应都是具名 schema。
  const collection = api.paths["/api/v1/settings/direct-llm/providers"] as { get: Record<string, unknown>; post: Record<string, unknown> };
  assert.equal(collection.get.operationId, "list_direct_llm_providers");
  assert.equal(collection.post.operationId, "create_direct_llm_provider");
  for (const method of ["get", "post"] as const) {
    const response = (collection[method].responses as Record<string, { content: { "application/json": { schema: { $ref: string } } } }>)["200" in (collection[method].responses as object) ? "200" : "201"];
    assert.ok(response.content["application/json"].schema.$ref.includes("DirectLlmProvider"), method);
  }
  const item = api.paths["/api/v1/settings/direct-llm/providers/{providerId}"] as { get: Record<string, unknown>; patch: Record<string, unknown>; delete: Record<string, unknown> };
  assert.equal(item.get.operationId, "get_direct_llm_provider");
  assert.equal(item.patch.operationId, "update_direct_llm_provider");
  assert.equal(item.delete.operationId, "delete_direct_llm_provider");
  assert.equal((api.paths["/api/v1/settings/direct-llm/providers/{providerId}/models"] as { post: { operationId: string } }).post.operationId, "query_direct_llm_models");

  // 响应 schema 里绝不能出现任何密钥值字段：只有掩码投影与 hasApiKey 布尔。
  const provider = (api.components.schemas.DirectLlmProvider as { properties: Record<string, unknown>; required: string[] }).properties;
  for (const name of ["apiKey", "apiKeyValue", "secret", "token", "authorization"]) assert.ok(!(name in provider), "读接口 schema 不得含密钥字段：" + name);
  assert.ok("hasApiKey" in provider);
  assert.ok("credential" in provider);
  assert.ok("apiKeyEnv" in provider);
  const credential = (api.components.schemas.DirectLlmCredentialView as { properties: Record<string, unknown> }).properties;
  assert.ok("apiKeyMasked" in credential);
  assert.ok("lastFour" in credential);
  assert.ok("plaintextAtRest" in credential);
  for (const name of ["apiKey", "secret", "value"]) assert.ok(!(name in credential), name);

  // 请求契约：密钥三态 + 未知字段被拒。
  const create = aiOperations.find(operation => operation.name === "create_direct_llm_provider")!;
  assert.equal(create.effect, "write");
  assert.equal(create.access ?? "admin", "admin");
  assert.equal(create.schema.safeParse({ providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: "https://api.example.com/v1", apiKey: "sk-typed-by-operator" }).success, true);
  for (const invalid of [
    { providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: "https://api.example.com/v1" },
    { providerId: "p1", name: "P1", protocol: "unsupported", baseUrl: "https://api.example.com/v1", apiKey: "k" },
    { providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: "https://api.example.com/v1", apiKey: "k", userId: "forged" },
  ]) assert.equal(create.schema.safeParse(invalid).success, false, JSON.stringify(invalid));
  const update = aiOperations.find(operation => operation.name === "update_direct_llm_provider")!;
  assert.equal(update.effect, "write");
  assert.equal(update.access ?? "admin", "admin");
  // providerId 是路径参数，因此也是 MCP 工具入参；省略 apiKey 必须合法：它表示保持已保存的密钥。
  assert.equal(update.schema.safeParse({ providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: "https://api.example.com/v1", enabled: true, revision: 0 }).success, true);
  // 显式空串同样合法（=清除），因为「清除 + 关闭」是一个有意义的中间状态。
  assert.equal(update.schema.safeParse({ providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: "https://api.example.com/v1", apiKey: "", enabled: false, revision: 0 }).success, true);
  for (const invalid of [
    { name: "P1", protocol: "openai-chat", baseUrl: "https://api.example.com/v1", enabled: true, revision: 0 },
    { providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: "https://api.example.com/v1", enabled: true, revision: -1 },
    { providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: "https://api.example.com/v1", enabled: true, revision: 1, userId: "forged" },
  ]) assert.equal(update.schema.safeParse(invalid).success, false, JSON.stringify(invalid));

  // 仅管理员：用户专用入口文档不得出现这些路径，公开入口也不允许它们。
  const userDoc = createAiOpenApi({ userOnly: true });
  for (const route of ["/api/v1/settings/direct-llm", "/api/v1/settings/direct-llm/providers", "/api/v1/settings/direct-llm/providers/{providerId}", "/api/v1/settings/direct-llm/providers/{providerId}/models"]) {
    assert.ok(!userDoc.paths[route], "直连配置是管理员能力：" + route);
  }
  assert.ok(!api.paths["/api/v1/settings/direct-llm"], "1.5.39 的单例路径必须已被移除");
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    assert.equal(publicRequestAllowed(method, "/api/v1/settings/direct-llm/providers"), false, method);
    assert.equal(publicRequestAllowed(method, "/api/v1/settings/direct-llm/providers/p1"), false, method);
    assert.equal(publicRequestAllowed(method, "/api/v1/settings/direct-llm/providers/p1/models"), false, method);
  }
  // 写配置本身不接触外部世界：既不生成也不计费。
  assert.equal((api.paths["/api/v1/settings/direct-llm/providers"] as { post: { "x-ai-effect": string } }).post["x-ai-effect"], "write");
});

test("core.llm 技能文本引用进入机器契约：能力目录、手册与功能矩阵同源", async () => {
  // 能力目录是唯一权威声明：skillRef 必须是可选的 reference 字段，且说明里写清来源与边界。
  const registry = await loadCapabilityPackages({
    async hermes() { return {}; }, async condition() { return {}; }, async comfyui() { return {}; },
  });
  const definition = registry.definitions().find(item => item.id === "core.llm")!;
  const skill = definition.config.find(field => field.key === "skillRef");
  assert.ok(skill, "能力目录必须声明 skillRef");
  assert.equal(skill?.type, "reference");
  assert.notEqual(skill?.required, true);
  for (const fact of ["SKILL.md", "fileAccess", "input.", "step.", "原样", "frontmatter"]) {
    assert.ok(String(skill?.description).includes(fact), "skillRef 说明缺少事实：" + fact);
  }
  // 手册正文（zane://guide 的分节源）必须解释两种系统指令来源的合成顺序与失败语义。
  assert.match(AI_OPERATOR_GUIDE, /capabilityConfig\.skillRef/);
  assert.match(AI_OPERATOR_GUIDE, /固定文本在前/);
  assert.match(AI_OPERATOR_GUIDE, /不剥 frontmatter/);
  // 功能矩阵描述同步，AI 才能从 features 判断这条能力存在。
  const feature = AI_FOUNDATION_FEATURES.find(item => item.id === "llm-step")!;
  assert.match(feature.description, /skillRef/);
  // 版本变更记录按版本倒序，新条目在最前面；滚动窗口会淘汰最旧条目，
  // 所以只断言「窗口内的条目仍按倒序」和「最新条目在最前」，不钉死具体历史版本号。
  const entries = AI_OPERATOR_CHANGELOG.match(/^## .+$/gm) ?? [];
  assert.ok(entries.length >= 2, "变更记录应至少保留两条");
  const [newest, next] = entries;
  assert.ok(AI_OPERATOR_CHANGELOG.indexOf(newest!) < AI_OPERATOR_CHANGELOG.indexOf(next!), "新条目必须排在更早条目之前");
});
