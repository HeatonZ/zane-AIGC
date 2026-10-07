# 正式环境真实生成 E2E 测试报告 — 2026-10-01

## 结论

**10 个正式场景，最小真实用例 6 个通过、4 个未通过。不能宣布正式环境全部通过。**

- 真实生成时间：2026-10-01 **17:40:37–18:29:52（Asia/Shanghai）**。本报告使用北京时间；原始 JSON / SSE 为 UTC。
- 正式服务：`http://127.0.0.1:8799`；正式项目目录：`F:\project\zane`；ComfyUI：`http://127.0.0.1:8188`。
- 使用每次提交时读取的真实发布版本，调用真实 Hermes / ComfyUI / H3；不是 Mock，也不是拿历史产物冒充本次生成。
- 对 H3 与长文的测试素材准备各纠正后补测一次；最终 6/4 为两批证据合并结论。原批次报告的 4/6 是当时结果，未覆盖原始证据。
- 本轮创建 **10 条新正式测试运行：7 条后端 completed、3 条 failed**；另外 2 次 API 提交拒绝、1 次真实前端提交拒绝。前端拒绝可能留下 1 个 E2E 草稿。
- 确实发生模型 / GPU 调用；没有计量费用。10 条运行不等于 10 次模型调用，多个场景含多个 AI 步骤，长文 Writer 补测又执行了一次。

## 判定与测试边界

通过要求：提交成功 → 实际执行节点成功 → 持久化事件、终态 SSE 和输入/工作流/输出归档可读取 → **声明的最终输出存在可读媒体** → HEAD、Range、下载与解码通过 → 正式前端能展示结果。不能只凭任务状态 completed 判定通过。

- 已下载图片用 Sharp 读取尺寸和格式；MP4 用 FFprobe 验证时长、尺寸、帧率、编解码器，再用 FFmpeg 对整个文件解码。
- 正式前端核对了成功场景的结果预览；H3、长文、无设计版视频的浏览器解码器读取到正确尺寸/时长，readyState=4、无媒体错误。文生视频提交失败与测试comfy空结果也在真实前端复现。
- 仅覆盖每场景一个低成本样本：单图、单镜、约 3.4–5.2 秒视频；电商仅淘宝 hero 单卡。H3 / 长文输入修正后的补测不应被称为“每场景仅提交一次”。
- 使用程序绘制的原创图片、Windows SAPI 合成中文测试语音；没有使用私人素材。
- 本轮没有修改、发布业务配置，没有重启/部署服务，没有取消他人任务，也没有为绕过校验而改写提交工作流；测试数据与产物保留。

## 十场景结果

| 场景 | 最终 E2E | 实际结果 | 本轮运行 / 证据 |
| --- | --- | --- | --- |
| AI文生图 | 通过（最小用例） | 640×640 PNG；193.4 秒；无参考图分支 | [18636d70-dac6-4485-bb96-c304fd75f013](F:/code/zane-drama/.local/production-real-e2e-20261001/01-text-to-image.json) |
| AI图生图 | 通过（最小用例） | 768×768 PNG；65.3 秒；保留白杯并更换浅蓝背景 | [501e9723-c01d-4c69-b2b2-85c77e2dcdd6](F:/code/zane-drama/.local/production-real-e2e-20261001/02-image-to-image.json) |
| AI文生视频 | 未通过 | 提交 HTTP 400 / INVALID_WORKFLOW；未创建运行 | [拒绝前预分配 d56c2ec3-8bdd-477a-aa1e-cb38d82657b4](F:/code/zane-drama/.local/production-real-e2e-20261001/03-text-to-video.json) |
| 颜域 | 未通过 | 单参考图用例在生视频节点越界；前三步完成 | [55a86135-cf35-4bb3-b26e-f1d61d2890ef](F:/code/zane-drama/.local/production-real-e2e-20261001/04-yanyu.json) |
| AI参考生视频 | 未通过 | 提交 HTTP 400 / INVALID_WORKFLOW；未创建运行 | [拒绝前预分配 49746730-4a1a-4fac-9978-d1529cd507c4](F:/code/zane-drama/.local/production-real-e2e-20261001/05-reference-video.json) |
| 测试comfy | 未通过 | 后台 completed；中间视频 5.267 秒，但最终 result=[] | [be7b5b10-ee1d-4b9a-810e-ae8d71b95ec3](F:/code/zane-drama/.local/production-real-e2e-20261001/06-comfy-test.json) |
| AI文生视频无设计版 | 通过（最小用例） | 640×640、30fps、H.264/AAC；5.267 秒；116.5 秒 | [54090561-d428-46b9-912e-2a42fff3613b](F:/code/zane-drama/.local/production-real-e2e-20261001/07-video-no-design.json) |
| H3 数字人长视频 | 通过（最小用例） | 正确附件补测：640×640、24fps、H.264/AAC；3.378458 秒；205.6 秒 | [df12b0bd-7e8f-44df-bf33-a966119205e2](F:/code/zane-drama/.local/production-real-e2e-20261001/native-fixtures-corrected/08-h3-digital-human.json) |
| 长文出视频 | 通过（最小用例） | 补场景资产：Writer→H3→FFmpeg；成片 5.188 秒，片段 5.167 秒；139.6 秒 | [55a63848-e172-4100-bd0c-a5f53dc04a70](F:/code/zane-drama/.local/production-real-e2e-20261001/native-fixtures-corrected/09-long-text-video.json) |
| 电商套图 | 通过（最小用例） | 淘宝 hero 单卡 AI 分支；1600×1600 JPEG + ZIP；127.0 秒 | [07ae7bb0-a05e-4497-82cd-221dbba7566a](F:/code/zane-drama/.local/production-real-e2e-20261001/10-commerce-ai.json) |

注意：两条“拒绝前预分配”ID 只存在于测试提交证据中，不能当成正式运行；测试comfy是真实生成过中间视频，但最终预览契约失败。

## 4 个未通过用例与修复建议

### 1. AI文生视频：发布快照带空 ComfyUI 配置，提交被拒绝

真实 API 返回 HTTP 400：`{"error":"ComfyUI 工作流格式无效","code":"INVALID_WORKFLOW"}`。正式前端填写 5 秒、1:1、0.4MP 的合法最小表单后也显示“运行操作失败：ComfyUI 工作流格式无效”和“运行未能启动”。未进入模型生成。

发布快照的 `generate` 为 `kind: "hermes"`，但残留 `comfyui: {workflowFile: "", bindings: []}`。[工作流校验实现](F:/code/zane-drama/server/domain/workflowValidation.ts) 对任何存在的 `step.comfyui` 验证 workflowFile，空值被拒绝。这不是测试脚本清洗/序列化造成的差异：原发布工作流原样提交，前端同样复现。

建议：修正发布快照并补充“步骤类型切换清理不相关配置”的回归；发布前执行与运行时一致的验证。本轮没有代为修复或重新发布。

证据：[提交工作流](F:/code/zane-drama/.local/production-real-e2e-20261001/03-text-to-video/submitted-workflow.json)、[真实前端拒绝截图](F:/code/zane-drama/.local/production-real-e2e-20261001/03-text-to-video/browser-rejection.jpg)。

### 2. AI参考生视频：同样在提交入口被拒绝

相同的 Hermes 步骤空 ComfyUI 配置，HTTP 400 / INVALID_WORKFLOW。**本轮未能验证参考图接入及参考一致性**，不能把前序审计的绑定警告当成本轮真实生成结果。

建议先解除提交阻塞，再单独验证参考图上传、图像绑定与最终输出节点。

证据：[真实发布工作流提交快照](F:/code/zane-drama/.local/production-real-e2e-20261001/05-reference-video/submitted-workflow.json)。

### 3. 颜域：单参考图用例在拆图节点越界

本轮上传 1 张原创人物参考图；设计、提示词、生图三步已完成，生视频报：`ComfyUI 执行失败（easy imagesSplitImage）：list index out of range`。

发布表单仅声明 reference_images 必填，没有明确最小图数和顺序；所用 Comfy 拆分节点导出多个图像槽。结论限定为 **单参考图用例未通过、输入数量契约与提前校验不足**，不是宣称正确数量的多图用例也必然失败，更不是直接归因 GPU 故障。

另有最终输出类型风险：发布场景的“场景图”和“视频”都声明为 text，前端可能展示原始 JSON，而不是媒体预览。

建议：定义并显示合法图片数量/排序，提交前校验；或让拆分节点支持实际接受的数量；修正最终图片/视频输出类型。

证据：[完整失败运行及步骤输出](F:/code/zane-drama/.local/production-real-e2e-20261001/04-yanyu/run.json)、[输入与输出契约](F:/code/zane-drama/.local/production-real-e2e-20261001/04-yanyu/submitted-workflow.json)。

### 4. 测试comfy：后台已完成，但最终生成结果为空

实际生成并下载了中间 MP4（5.267 秒，640×640，30fps，H.264/AAC），全文件解码正常；但发布最终输出指向末尾 Hermes `step_mumphtoi_4.outputs.result`，不是生成节点的媒体。最终：

`result: video_list = []`；`output_2: text = ""`。

正式前端显示“已完成”与 `[]`，没有最终成片预览。因此 **后端 completed 不等于完整 E2E 通过**。

建议：把最终 sourceRef 指向真实媒体，或明确末尾转换步骤必须输出媒体；加“最终声明媒体非空”的执行后校验。

证据：[前端空结果截图](F:/code/zane-drama/.local/production-real-e2e-20261001/06-comfy-test/browser-empty-final.jpg)、[实际生成的中间视频](F:/code/zane-drama/.local/production-real-e2e-20261001/06-comfy-test/media-1.mp4)。

## H3 / 长文补测说明

### H3：纠正附件格式后通过

- 初始运行 `cdcc47d2-4346-478d-a1d1-192d259d5006` 使用测试脚本的裸 WAV 路径，特殊 H3 音频分析步骤拒绝：“音频输入不是有效的 ComfyUI 上传附件”。这是测试素材准备错误，不计为最终生产功能失败。
- 修正脚本，使用与生产前端相同的 `/api/comfyui/upload-image`、`/api/comfyui/upload-audio` 协议，将服务返回的附件对象传入正式输入。
- 新运行 `df12b0bd-7e8f-44df-bf33-a966119205e2` 完成：音频分析 → AIXG 分段提示词 → H3 生成/合成，得到 **1 个 3.378458 秒视频**。使用 3.378458 秒原音频，仅验证单分段，不代表长视频/多分段负载通过。
- 成片 640×640、24fps、H.264/AAC、音频 22050Hz；全文件解码无错误。音轨 mean_volume=-23.2dB、max_volume=-2.9dB，存在可测非静音声音；未进行逐帧口型评分。

### 长文：补充场景资产后完整 Writer → H3 → FFmpeg 通过

- 初始运行 `b029facd-f3dd-4bc8-9af9-4652e31a2462` 的 Writer 已成功，生成阶段因没有场景资产报“长文出视频需要先上传人物和场景资产”。不是历史 Writer JSON 截断错误的复现。
- 发布输入 `scene_assets.required=false`，但执行要求场景资产，存在 **表单与执行契约不一致风险**：界面允许留空，却在已调用 Writer 后才失败。建议同步必填或允许无场景生成，并把验证前置以避免不必要调用。
- 正确上传原创人物和场景图片，要求 `characters=[1], scenes=[1]`、一个 5 秒分镜后，新运行 `55a63848-e172-4100-bd0c-a5f53dc04a70` 的 Writer、H3、FFmpeg 三步全部完成。
- 最终成片 **5.188 秒，640×640，24fps，H.264/AAC，48000Hz**；有声原片段 5.167 秒、32000Hz。时长来自实际媒体探测，不把请求的 5 秒当成精确实测值。
- 成片及片段均全文件解码无错误，音轨 mean_volume=-20.5dB、max_volume=-0.8dB。前端最终成片可加载，无媒体解码错误。
- **短文本单镜通过，不证明历史长文本 Writer JSON 截断已修复，也不证明长文本/多镜/多分段稳定性。**

## 附加技术验收

- 五个已下载 MP4（含测试comfy中间视频、长文片段）均 FFmpeg 完整解码返回 0、无解码错误。无设计版/测试comfy输入要求无对白无音乐，低音量不作为它们的失败依据；H3/长文有实际非静音音轨。
- 电商 ZIP 独立通过 .NET ZipArchive 打开并逐条读取，3 个条目：`taobao/01-hero.jpg`、`manifest.json`、`REVIEW.txt`。实际读取长度与归档长度相等，manifest 为合法 JSON，ZIP 中 JPEG 与下载预览 JPEG 的 SHA256 一致。
- 2026-10-01 **18:37:33（Asia/Shanghai）** 只读终验：本轮 10 条正式运行均终态；健康接口 HTTP 200 / ok；worker queued=0、active=0、preparing=0；Comfy running=0、pending=0。没有遗留本轮 active 任务，未处理他人历史“待恢复”记录。
- 仅对本轮新增测试工具执行语法检查与辅助单测：**7/7 通过**。上一轮的 197/197 源码测试属于当时稳定源码快照，不能据此声称本轮实时工作区/正式部署全量回归通过。

## 版本与证据

结论针对下列**提交时发布版本**。并发开发/发布可能使后续版本改变；不要把本报告当作任何未来发布版本的验收结果。

| 场景 | publishedVersionId | 原始证据目录 |
| --- | --- | --- |
| AI文生图 | `aab1a2c3-1820-43c8-9255-aaf8cd0025b1` | [01-text-to-image](F:/code/zane-drama/.local/production-real-e2e-20261001/01-text-to-image) |
| AI图生图 | `91bebd72-74d4-4d82-ae20-d44bdbda51c0` | [02-image-to-image](F:/code/zane-drama/.local/production-real-e2e-20261001/02-image-to-image) |
| AI文生视频 | `e47fdc0d-5b55-43ef-b34a-2868f8d846bd` | [03-text-to-video](F:/code/zane-drama/.local/production-real-e2e-20261001/03-text-to-video) |
| 颜域 | `75b8b421-e80f-4bf2-9cf7-0eeeaecdd08b` | [04-yanyu](F:/code/zane-drama/.local/production-real-e2e-20261001/04-yanyu) |
| AI参考生视频 | `662c2d87-7437-44a0-a01b-e970d0b1a394` | [05-reference-video](F:/code/zane-drama/.local/production-real-e2e-20261001/05-reference-video) |
| 测试comfy | `8b5030e9-18be-4056-85a0-f76192b20007` | [06-comfy-test](F:/code/zane-drama/.local/production-real-e2e-20261001/06-comfy-test) |
| AI文生视频无设计版 | `35f77575-ccd9-49d8-964e-8b662dcd0bcf` | [07-video-no-design](F:/code/zane-drama/.local/production-real-e2e-20261001/07-video-no-design) |
| H3 数字人长视频 | `c55fa4f3-d205-4c5a-9dae-ba51c92acad7` | [08-h3-digital-human](F:/code/zane-drama/.local/production-real-e2e-20261001/native-fixtures-corrected/08-h3-digital-human) |
| 长文出视频 | `26a00bbb-38f1-431d-988f-0c8e7ed57278` | [09-long-text-video](F:/code/zane-drama/.local/production-real-e2e-20261001/native-fixtures-corrected/09-long-text-video) |
| 电商套图 | `c187f543-4045-498b-94d9-7329b4669803` | [10-commerce-ai](F:/code/zane-drama/.local/production-real-e2e-20261001/10-commerce-ai) |

- [合并最终机器报告（6通过/4未通过）](F:/code/zane-drama/.local/production-real-e2e-20261001/real-e2e-final-report.json)
- [原批次原始报告（4通过/6失败，含素材准备问题）](F:/code/zane-drama/.local/production-real-e2e-20261001/real-e2e-report.json)
- [H3/长文正确素材补测原始报告（2通过）](F:/code/zane-drama/.local/production-real-e2e-20261001/native-fixtures-corrected/real-e2e-report.json)
- [终态/健康/队列/完整解码/音量测量](F:/code/zane-drama/.local/production-real-e2e-20261001/post-verification.json)
- [电商 ZIP 独立读取与哈希验证](F:/code/zane-drama/.local/production-real-e2e-20261001/commerce-zip-verification.json)
- [前端初批成功和失败证据](F:/code/zane-drama/.local/production-real-e2e-20261001/browser-evidence.json)
- [补充前端预览及浏览器媒体解码状态](F:/code/zane-drama/.local/production-real-e2e-20261001/browser-final-validation.json)
- [本轮生成媒体的截帧与电商图抽查](F:/code/zane-drama/.local/production-real-e2e-20261001/acceptance-contact-sheet.jpg)
- [长文三步完成的正式前端截图](F:/code/zane-drama/.local/production-real-e2e-20261001/native-fixtures-corrected/09-long-text-video/browser-final.jpg)

每个已创建运行的证据目录包含 run.json、events.json、terminal.sse.txt、媒体；提交工作流以 submitted-workflow.json 或运行归档快照为准。原始失败记录保留，未覆盖为成功。

## 测试工具与后续工作

- [真实生成测试脚本](F:/code/zane-drama/scripts/e2e-production-real.mjs)
- [7 个辅助单元测试](F:/code/zane-drama/scripts/e2e-production-real.test.mjs)
- [上一轮无 AI 正式审计/烟测报告](F:/code/zane-drama/docs/production-e2e-2026-10-01.md)

真实生成脚本只有明确 `--allow-generation` 才提交；读取真实发布快照，串行等待空闲，不自动审批或重试失败模型，同证据目录预分配 runId 防重复提交。既有报告可直接读取；**为查看本次结果无需再次执行生成脚本**。更换输出目录或修复后补测会产生新的模型调用。

优先修复：两个视频场景的提交阻塞 → 测试comfy最终媒体映射 → 颜域输入数量/输出类型 → 长文场景必填契约，再对修复版本各做有界补测。本轮仅记录建议，不自动修改正式配置、重新发布或追加生成。
