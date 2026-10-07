# 反推提示词后纯文生图：真实端到端验收（2026-10-01）

## 已发布配置

- 场景：AI文生图；发布版本 `a88e49d6`，版本 ID `dfc99f0b-86ab-415d-8acc-af3ce8416a6c`。
- 输入为有序 `reference_images` 图片列表，描述可留空。
- 普通条件步骤 → 有图 AIXG 反推 / 无图 writer 润色 → 提示词整理 → 同一个 `Zane/t2i_UI.json` 纯文生图步骤。
- 移除误加的原图重绘分支、分支结果选择、重绘强度及未绑定的重绘种子输入。
- 原图仅绑定反推步骤。整理与生成步骤均只消费文本，不向生图模型传原图。
- 正式版本和草稿均已更新；其余 9 个场景的工作流和已发布版本保持不变。

## 两次全新真实运行

| 测试 | 运行 ID | 结果 | 用时 |
| --- | --- | --- | --- |
| 有内容的咖啡店甜点柜参考图，描述为空 | `9b65db31-9859-463d-a0bb-f71a8517be63` | completed；反推完成、writer 跳过、纯文生图完成 | 170.8 秒 |
| 从正式页面提交咖啡杯与蛋糕的文字描述，无图 | `1429010f-c5ab-4f23-8704-3978d9fe9b24` | completed；反推跳过、writer 完成、同一纯文生图完成 | 144.4 秒 |

有图输入复用已上传的 `coffee-display-dieppe.jpg`（1920×1446），并非空白图或单色测试图。运行归档包含实际反推文字与实际生图提示词。

## 实际 ComfyUI 请求核验

- 两次生成步骤 ID 都是 `step_mukrmtmz_2`，最终输出直接来自此步骤。
- 实际采样图均没有 `LoadImage`、`VAEEncode` 和参考图条件。
- `KSampler` 节点 476 的 `latent_image` 来自节点 474 `EmptyLatentImage`，`denoise=1`。
- 节点 471 `TextEncodeQwenImage21` 只绑定文字正向/负向，不带 `images.image_1` 或参考 latent。
- 核对了节点 471 中的实际提示词与上一步输出完全相等。有图生图提示词 1108 字符。
- 两次输出归档图片均可访问，页面真实运行详情显示完成。
- `node scripts/smoke-reference-reconstruction.mjs 9b65db31-9859-463d-a0bb-f71a8517be63 1429010f-c5ab-4f23-8704-3978d9fe9b24` 验证通过。

## 视觉核对与限制

实看原图和本轮新结果：新图保留玻璃展示柜、蛋糕、外带餐碗、橙子篮、三明治及底层饮料这些主要类别和分层布局；但具体物品数量、陈列位置、字体和视角仍有变化。例如原图可见四只餐碗，反推和实际提示词都明确写了四只，本轮文生图结果仍只有三只。

因此验收结论是**反推文本 → 纯文生图链路通过**，不是像素一致或全部物品细节完全一致。没有通过原图 latent、低强度重绘或图像条件来掩盖纯文本重生成的差异。

## 本地检查

- `npm test`：202 项通过，0 失败。
- `npm run typecheck`：通过。
- `npm run build`：通过（现有 bundle 大小提示不影响构建）。
- 模拟执行覆盖空描述单图、多图、附加要求、无图空列表与省略图片输入。
- 页面已在构建后刷新；服务有其他运行中任务，因此未停止或重启服务。

## 证据

- F:/code/zane-drama/.local/prompt-regeneration/publication.json
- F:/code/zane-drama/.local/prompt-regeneration/e2e-verification.json
- F:/code/zane-drama/.local/prompt-regeneration/9b65db31-9859-463d-a0bb-f71a8517be63-comfy-history.json
- F:/code/zane-drama/.local/prompt-regeneration/1429010f-c5ab-4f23-8704-3978d9fe9b24-comfy-history.json
- F:/code/zane-drama/.local/prompt-regeneration/run-proof.png
