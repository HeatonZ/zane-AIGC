# 文生视频 / 参考生视频修复与正式补测 — 2026-10-01

## 结论与范围

**用户指定的两个场景已修复并发布，正式最小真实 E2E 补测 2/2 通过。**

- 仅处理 AI文生视频、AI参考生视频。
- **颜域、测试comfy：未修改配置、未新增测试运行；前轮未通过问题仍保留，不能把跳过记为通过。**
- 正式服务：`http://127.0.0.1:8799`；正式项目目录：`F:\project\zane`。
- 发布时间：2026-10-01 22:21:37（Asia/Shanghai）。生成时间：2026-10-01 22:21:37 至 2026-10-01 22:31:38（Asia/Shanghai）；原始 JSON / SSE 为 UTC。
- 本轮只有 **2 条新正式运行**，每场景一个请求 5 秒、0.4MP、1:1 的最小样本，串行执行，两次均首轮通过。没有额外浏览器提交或自动失败重试。
- 确实调用真实 Hermes / ComfyUI / GPU；未计量费用。新增运行数不等于模型内部调用次数。

## 实际修复

### 两场景共同修复

1. 删除 Hermes 步骤上遗留的 `comfyui: {workflowFile: "", bindings: []}`，解除 HTTP 400 / INVALID_WORKFLOW 提交阻塞；保留原 Profile、其他输入输出及文生视频提示词。
2. 根据当次读取的实际 `Zane/video_UI.json` 节点，把最终视频输出绑定从不存在的 `1092.video` 改到 **`92.video`（SaveVideo）**。
3. 最终 `video_list` 仍指向真正 H3 生成步骤的 `result`，不是另一个文本步骤。

### 参考生视频补上真实参考图链路

- H3 生成步骤新增 `references` 输入，来源为 `input.references`。
- 新增必填图片列表绑定：`192.ref_images ← input.references`。安装的 MiniMaxH3ReferenceToVideo 节点声明该动态图片组，支持最多 9 张有序图片。
- Writer 和 AIXG 都接收有序参考图，并增加 Picture 编号与保持主体外观的提示约束。
- 使用现有部署的动态媒体绑定机制，在每次执行图中创建 LoadImage 并连接真实图片；**没有修改共享 ComfyUI 工作流文件，也没有修改服务器业务代码、重启或部署服务**。

### 发布与数据保护

- 通过正式 `/api/workspace/merge`，基于读取快照执行三方合并，不直接编辑 SQLite。
- 修改前保存完整工作区备份：[发布前备份](F:/code/zane-drama/.local/production-video-retest-20261001/workspace-before-publication-1790864497006.json)。
- 保留两个场景的全部旧版本；其他 8 个场景、工作流、发布记录、选项预设、任务草稿不变，均有断言验证。
- 修复工具默认只预览，只有 `--apply` 才修改发布配置；工具本身不创建任何模型任务。对不明配置、未发布的用户修改或歧义图节点会拒绝处理，不覆盖它们。

## 正式补测结果

| 场景 | E2E 结论 | 成片实测 | 运行耗时 | 新运行 / 证据 |
| --- | --- | --- | --- | --- |
| AI文生视频 | 通过（最小真实用例） | 5.267000 秒；640×640；30fps；H.264/AAC | 218.0 秒 | [ca75daf8-3e97-41fd-a9eb-44efea7f35e2](F:/code/zane-drama/.local/production-video-retest-20261001/03-text-to-video.json) |
| AI参考生视频 | 通过（最小真实用例） | 5.267000 秒；640×640；30fps；H.264/AAC | 380.4 秒 | [ab8a605d-a1f1-4b5e-98c6-61af0caf7031](F:/code/zane-drama/.local/production-video-retest-20261001/05-reference-video.json) |

两条运行均完成：Writer → AIXG 提示词 → H3 生成。持久化事件、终态 SSE、正式输入/工作流/输出归档、最终媒体非空、HEAD / Range / 下载及 FFprobe 验证通过。两份 MP4 再经过 FFmpeg **全文件解码**，返回 0、无解码错误。

正式前端两条记录均显示运行完成，最终媒体可加载；浏览器 readyState=4，尺寸 640×640、时长 5.267 秒、无媒体错误。请求为 5 秒，实际帧对齐/容器时长为 5.267 秒，未把请求值当作精确实测值。

## 参考图实际参与生成的证据

本轮不只凭发布配置或文字提示判断参考生视频通过，还匹配了该视频输出文件对应的真实 ComfyUI history：

- runId：`ab8a605d-a1f1-4b5e-98c6-61af0caf7031`。
- Comfy promptId：`e4120070-d4ad-4424-9209-9f8fd66d83fb`，执行状态 success。
- 实际节点 `193` 为 LoadImage，读取 `zane-studio/synthetic-cup.png`。
- 实际连接：`192.inputs["ref_images.ref_image_0"] = ["193", 0]`。
- 从 SaveVideo 节点 `92` 回溯，H3 条件节点 `192` 和 LoadImage 节点 `193` 都在最终视频依赖链中；不是上传了图片但未参与生成。
- 无参考图的文生视频执行图没有参考图动态槽，避免混入之前的图片。
- 关键帧目测：参考视频保留测试杯的白色杯身、右侧把手、灰背景和插画风格。该检查不代表全程量化一致性、多参考图或复杂动作的质量评估。

证据：[参考生视频实际 Comfy 执行图](F:/code/zane-drama/.local/production-video-retest-20261001/05-reference-video/comfy-history.json)、[文生视频实际 Comfy 执行图](F:/code/zane-drama/.local/production-video-retest-20261001/03-text-to-video/comfy-history.json)、[输入参考与两个输出视频关键帧对照](F:/code/zane-drama/.local/production-video-retest-20261001/video-retest-contact-sheet.jpg)。

## 修复发布版本

| 场景 | 修复前 publishedVersionId | 修复后 publishedVersionId / 内容版本 |
| --- | --- | --- |
| AI文生视频 | `e47fdc0d-5b55-43ef-b34a-2868f8d846bd` | `d65282c5-6a9b-4f64-a6c9-db06aa4c3c46` / `7f29dddb` |
| AI参考生视频 | `662c2d87-7437-44a0-a01b-e970d0b1a394` | `9f506ee4-472c-498c-a184-ad78a10151e4` / `f554af01` |

结论针对这两次提交使用的发布版本。没有重新跑其他已通过场景，也没有对颜域和测试comfy宣称已修复。

## 校验与交付文件

- 修复专项单元测试：**9/9 通过**；覆盖范围限制、空配置清理、真实输出节点、参考图直连、幂等、旧版本保留、用户草稿保护、异常配置拒绝与场景导入格式往返。
- 真实生成测试工具辅助测试：**7/7 通过**。这是专项工具回归，不是对当前整个工作区或正式部署的全量源码回归声明。
- 2026-10-01 22:35:26（Asia/Shanghai）终验：健康状态 ok，worker queued=0 / active=0 / preparing=0，Comfy running=0 / pending=0。没有遗留本轮 active 任务，未取消他人运行。

文件：

- [可重复执行的两场景修复工具（默认预览）](F:/code/zane-drama/scripts/repair-production-videos.mjs)
- [修复专项测试](F:/code/zane-drama/scripts/repair-production-videos.test.mjs)
- [可导入的文生视频修复场景包](F:/code/zane-drama/examples/scenes/text-to-video-repaired.json)
- [可导入的参考生视频修复场景包](F:/code/zane-drama/examples/scenes/reference-to-video-repaired.json)
- [本轮完整机器报告](F:/code/zane-drama/.local/production-video-retest-20261001/retest-final-report.json)
- [真实生成原始报告](F:/code/zane-drama/.local/production-video-retest-20261001/real-e2e-report.json)
- [完整解码、图像实际绑定、健康与保护验证](F:/code/zane-drama/.local/production-video-retest-20261001/final-verification.json)
- [正式前端验收状态](F:/code/zane-drama/.local/production-video-retest-20261001/browser-verification.json)
- [正式前端成功截图](F:/code/zane-drama/.local/production-video-retest-20261001/05-reference-video/browser-final.jpg)
- [文生视频真实成片](F:/code/zane-drama/.local/production-video-retest-20261001/03-text-to-video/media-1.mp4)
- [参考生视频真实成片](F:/code/zane-drama/.local/production-video-retest-20261001/05-reference-video/media-1.mp4)
- [前轮十场景报告（历史 6 通过 / 4 未通过）](F:/code/zane-drama/docs/production-real-e2e-2026-10-01.md)

原始失败记录和前轮证据没有覆盖或删除。本次两个场景补测通过，不意味着十场景已全通过；颜域和测试comfy按用户要求保持未修复、未复测。
