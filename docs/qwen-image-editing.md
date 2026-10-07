# Qwen Image 2.1 图生图：Writer 整理 → AIXG 转提示词

## 当前配置（2026-10-05）

`图片 + 想法 → Hermes writer（整理编辑说明） → Hermes aixg（转模型提示词） → ComfyUI 图生图`

仅使用基础 Hermes 和 ComfyUI 步骤，没有新增执行器、任务数据库或浏览器场景库。

| 公开输入 key | 页面名称 | 类型及默认 |
| --- | --- | --- |
| reference_images | 图片 | 有序 image_list，必填；全部图片共同参与一次编辑 |
| prompt | 想法 | textarea，必填；用户只写想法，不必编模型提示词 |
| seed | 随机种子 | number，可选；留空保留工作流默认值 |
| ratio | 画幅 | select，默认 1:1 (Square) |
| mp | 像素 | number，默认 1，单位 MP（约 100 万像素） |

不再开放负向提示词、生成步数、CFG、参考图缩放基准、空图等字段。旧发布快照及历史任务仍保留原契约，不自动迁移。

## 步骤与绑定

- `image_edit_writer`：基础 Hermes，Profile `writer`，输入原始有序图片和想法；输出非空 text `edit_brief`。只整理用户目标、参考图角色、修改及保持约束，不扩写故事，不自行增删主体、文字或生成参数。
- `qwen_image_prompt`：基础 Hermes，Profile `aixg`；输入同一图片列表和 `step.image_edit_writer.outputs.edit_brief`，提示词模板也只引用整理结果；输出非空 text `prompt`。不绕过 Writer 使用原始想法。
- `image_to_image`：原基础 ComfyUI。步骤 `inputs.prompt` 与正向 binding 同时指向 `step.qwen_image_prompt.outputs.prompt`；图片仍完整绑定 `471.images`。
- 画幅/像素绑定 `481.aspect_ratio` / `481.megapixels`，`479.switch` 固定为 true，选用 `481 → 480` 建立的目标画布。参考图仍输入 `471` 的 Qwen 编辑条件，不能因目标画布改成无参考图生成。固定 false 会走原图 latent，导致目标画幅和像素不参与输出尺寸选择；此分支已在本机真实工作流只读核对。
- seed 保留 `476.seed`；未开放的负向/步数/CFG/缩放等使用原 ComfyUI 工作流固定配置。不会覆盖 ComfyUI 文件、模型或上游代码。
- Writer 或 AIXG 失败时停止，不以原始想法继续生成。提示词严格按实际附件顺序引用 `<image1>`、`<image2>` 等，不虚构图片编号；多图不自动拆成逐图生成。

## 同源配置与 AI 操作

示例 `examples/scenes/image-to-image-qwen21.json` 可显式导入；它不初始化或回填工作区。基础模板与示例使用同一流程定义。

1. `get_scene_draft` 读取当前草稿，保存 sceneId、revision、publishedVersionId。
2. 在完整 workflow 中配置 Writer → AIXG → ComfyUI 与五项输入；保留场景 ID、已有共享画幅预设、其他场景与历史版本。不能用整个示例覆盖定制流程。
3. `update_scene_draft` 携带当前 revision 保存，`validate_scene_draft` 校验。不发布、不执行或计费。
4. 保存响应丢失时读取同一草稿对账；冲突则停止，不强制覆盖、换 ID 或重放。
5. 用户明确确认发布后才预存 publicationId 并 `publish_scene`。`get_scene` / `get_available_scene` 的输入契约只来自固定发布快照；旧任务不暗中切换到新版。
6. 运行结果用 `get_step_result` 按步骤读取 edit_brief、prompt，不搬整份运行。

`server/domain/qwenImagePrompt.ts` 提供纯配置模板。旧 `addQwenImage21PromptStep` 保留为旧版兼容工具，不是新版五输入流程的自动迁移器，也不写 SQLite、发布或调用模型。现有 HTTP/MCP 编辑工具直接传入完整流程，新字段沿同一业务服务保存与验证。

writer/aixg 的视觉 Profile、`Zane/i2i_UI.json`、模型文件、节点及端口必须在本机已配置。配置保存不表示发布，隔离协议测试通过不表示真实模型生成质量已验收。

## 回归与验收边界

- 单图/多图：图片顺序、Writer 原始想法 → AIXG 整理结果 → ComfyUI 最终提示词严格串行；seed/ratio/mp 独立传递。
- 五项公开字段、默认值和目标画布分支；没有已移除输入的悬空引用。
- Writer/AIXG 失败不生成；旧版配置助手仍拒绝覆盖定制链路。
- 真实 stdio MCP 隔离闭环覆盖字段到同一业务服务/SQLite、HTTP 同源读取、校验、非法类型/枚举/旧字段、并发/旧 revision、响应丢失对账、固定发布输入契约和目录分页边界。
- 所有测试使用临时端口/项目/数据、协议 fixture；不调用真实模型，不生成媒体，不审批生产运行。
- AI 契约源：operations.ts、sceneSchemas.ts、openapi.ts、features.ts、guide.ts；通过 `npm run docs:ai` 生成文档，不直接修改生成文件。交付门禁为 `npm run check` 与文档漂移检查。

## 本次权威草稿保存与验收（2026-10-05）

- 通过现有管理员 API 保存 `image_to_image` / AI图生图；只提交一次带当前 revision 的草稿 PATCH。随后用同一 ID 读取对账，并通过 HTTP 和真实 stdio MCP 校验；没有重复共享写入。
- 保存时工作区 r168；目标草稿 revision：`b45c01de2baa89f84fd783e5e32d6653adaccfd7664b48f4640b160fea99fd7b`。三步顺序为 `writer → aixg → comfyui`，公开输入严格为 `reference_images / prompt / seed / ratio / mp`。
- 保存草稿时的发布指针为 `1caa446f-f1b3-4092-87c3-b09efb0b1ae3` / v23f8a1b2，`draftMatchesPublished:false`；当时尚未发布。随后用户明确确认，已发布新版，见下节；原上一发布快照未改写。
- 当前服务已支持所有新配置字段，writer/aixg 都已启用。没有调用真实 Hermes/ComfyUI 模型、执行生产生成、审批生产运行或重启工作台/Gateway/ComfyUI。
- 服务端会把原输出中缺失的 description 规范化为空字符串；对账已核对完整规范化结果，不为此重新提交。
- 工作区复核时已到 r172，目标内容 revision 仍相同；另一个流程及任务草稿有并行变化。本次只修改目标场景与流程，保留并行修改，不用旧全工作区快照回放覆盖。
- 保存前的权威工作区与全部该场景发布快照、操作计划、单次保存回执、服务端校验、保存后读取及 MCP 核验在 `backups/qwen-image-writer-2026-10-05T07-07-11-802Z-262e3935`。备份不包含 API 密钥。
- `npm run check` 通过：389 个 Node 测试全部通过，全部隔离冒烟、真实 stdio MCP 五字段闭环及文档漂移检查通过。最终检查日志：`.local/i2i-writer-check-final-20261005.log`（包含从旧两步骤/八字段变更为新三步骤/五字段的真实 MCP 回归）；前端验收构建输出到独立 `.local/i2i-writer-check-web-20261005`，没有覆盖正式前端目录。
- AI 契约源码/生成文档已同步为 1.5.4，复用现有操作而不新增工具。正在运行的后台在线发现/说明仍需下次正常重载后刷新；本次草稿配置不需要重启，不以刷新说明为由强制停服。

## 新版正式发布状态（2026-10-05 15:31，Asia/Shanghai）

- 用户明确确认后，通过既有 `publish_scene` HTTP API 发布；版本 `804a8914`，固定 versionId `908d6057-8c4e-4a54-a53f-d494f9ec17f9`。调用前已保存 publicationId 与完整权威工作区备份，仅提交一次发布请求。
- 当前发布快照和普通创作入口均为 **Writer → AIXG → ComfyUI**，公开字段严格为 **图片、想法、随机种子、画幅、像素**。AIXG 消费 Writer 的 edit_brief，ComfyUI 消费 AIXG 的 prompt；原图片顺序保持。
- 已通过 HTTP 和真实 stdio MCP 回读固定 versionId、当前发布指针、普通创作输入契约以及草稿；`draftMatchesPublished:true`。发布未改变已核准的 workflow；原上一发布快照仍可按旧 versionId 读取且内容未改写。
- 发布后草稿 revision：`50165953e28dfc919c3b906d5281a3194d39986ac3a9c7ccb88264f56bcc0173`。后续编辑必须重新读取当前 revision；不使用发布前 revision 或旧工作区镜像覆盖。
- 发布前备份、预存请求 ID、单次回执、发布后 HTTP/MCP 读取和核验结果保存在 `backups/qwen-image-writer-publish-2026-10-05T07-31-25-285Z-908d6057`，不包含 API 密钥。
- 仅发布场景，不提交生成、调用真实模型、审批生产任务或重启工作台、Hermes Gateway、ComfyUI；既有任务/历史运行不自动切换版本。正在运行的在线发现说明仍在下次正常重载后刷新，不影响新发布配置读取与执行。

## 历史记录（以下为旧版两步骤流程，非当前修改的发布回执）

## 首次草稿保存状态（2026-10-04，发布前）

- 场景：`image_to_image` / AI图生图；共享工作区 r121。
- 已保存并校验的草稿 revision：`ba6b0427bd21dbe68fa57b61095d9374c93a5216a8b3fff22120381371ecf481`。
- 保存草稿时的发布版为 `90b685a4-f9c5-4475-be37-819d40e46265`；当时尚未发布，随后已按用户明确要求发布，见下节。
- 正式写入只改变该场景的 workflow；元数据、所有发布/历史快照、预设、任务草稿及其他流程均与服务端备份一致。
- 本次 `npm run check` 通过，314 个 Node 测试全部通过；文档漂移检查和真实 stdio MCP 隔离闭环通过。
- 服务端读取得到的保存前后快照、操作计划、回执和检查日志在 `backups/qwen-image-prompt-2026-10-04T06-48-14-716Z-3d6a4e99`。
- 未调用真实模型，未发布或审批生产任务，未重启工作台、Hermes Gateway 或 ComfyUI。现有后台已支持这份配置；本次新增 AI 发现/手册描述属于源码与生成文档更新，正在运行的后台需下次正常重载后刷新这些描述。不要因此强制停服或连带重启其他服务。

## 正式发布状态（2026-10-04 15:37，Asia/Shanghai）

- 用户明确确认后发布；版本 `1daf5911`，固定 versionId `8137a203-c531-41c5-8276-740f3b7ac983`，共享工作区 r122。
- 新发布快照包含 `qwen_image_prompt`（基础 Hermes，Profile `aixg`）→ `image_to_image`（原基础 ComfyUI），两处正向来源均指向转换步骤的 `prompt` 输出。
- 发布后草稿 revision 为 `a5a5f60faf24cec848145ed4aa197d2fab3ea828923fc3d0bf4a1201d1dfab8b`，`draftMatchesPublished:true`。revision 包含发布版本目录，因此发布后发生变化；后续编辑必须重新读取当前 revision。
- 只提交一次固定 publicationId 的发布请求，随后以只读请求核对同一 ID、当前发布指针、内容与回执。未提交生成任务、未审批任务、未重启服务。
- 发布前完整权威工作区及所有 10 个版本已备份在 `backups/qwen-image-prompt-publish-2026-10-04T07-37-03-317Z-8137a203`。按照既有最近 10 版规则，最旧版本 `66fce6bb-99b7-4222-95f4-ddbe180dce5f` 从在线目录移出，但完整快照保留在该备份中；其余旧快照未改写。
- 其他场景、流程、预设和任务草稿与发布前一致。已打开的创作/历史任务不会被自动切换版本；新建该场景任务时使用新发布版。
