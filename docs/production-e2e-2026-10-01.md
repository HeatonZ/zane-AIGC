# 正式环境端到端测试报告 — 2026-10-01

## 结论

**已完成 10 个已发布场景的浏览器基础检查、正式 API / 配置审计，以及不调用 AI 的正式环境实跑；尚不能认定所有场景的完整 AI 生成链路通过。**

- 正式环境只读审计：**210 项通过、1 项失败、8 项警告、2 项待验收**。这是检查项数量，不是场景数量。
- 浏览器：**10/10 场景可打开；10/10 空输入提交被必填或媒体校验阻止**，未因此创建生成任务。
- 正式环境新增实跑：电商原图套图、素材版本、人工确认、选片与本地合成均通过。
- 冻结源码快照：**197/197 自动测试通过，0 失败 / 跳过**；另有 **5/5 审计辅助测试**通过。前后端类型检查、生产构建及 3 套隔离烟测均通过。
- 剩余明确问题：**AI参考生视频的参考图片未接入 Comfy 视频生成节点**；长文出视频、颜域等真实生成与内容质量仍需补验收。

## 环境、时间与安全边界

- 日期及本报告显示的时间：2026-10-01，Asia/Shanghai（UTC+8）；原始 JSON 时间使用 UTC。
- 正式访问地址：[http://127.0.0.1:8799](http://127.0.0.1:8799)。
- 正式项目数据：`F:\project\zane`。
- 代码目录：`F:\code\zane-drama`；Node.js v26.4.0。
- 当前正式配置审计：16:07:42–16:07:44，工作区 revision 65；严格选择实际发布版本，而非最后一个工作副本。
- 源码快照验收：16:06:45–16:07:03；快照的清单与哈希保存在 `F:\code\zane-drama\backups\production-source-check-cd4c83cc-5d02-4b4f-bec5-8aee780cb8ec\source-manifest.json`。
- 电商正式实跑：15:47:58–15:47:59；生产工作台正式实跑：16:13:12–16:13:14；素材版本和选片界面补验收：16:22–16:23。

本次没有主动重启正式服务，没有发布或替换正式场景 / 连接配置，没有取消其他人的运行，没有删除真实素材；保留用户与同期操作的源码修改。测试期间存在并发真实任务及部署更新，下面按复测后的状态给结论。

没有新增 Hermes / Comfy 模型生成调用；新产物来自合成测试素材、模板或人工媒体输入、原图保真电商分支和本地 FFmpeg。**未执行每个 AI 场景的新生成，也未验收模型账单、参考一致性、人物一致性或长视频内容质量。历史运行成功不等同于当前发布版本的新生成成功。**

## 一、场景覆盖

下表所有场景均已在真实浏览器打开并验证空输入拦截。“历史产物”表示选取既有成功运行做媒体检查，不表示本次 AI 生成成功。

| 已发布场景 | 浏览器 / 空输入 | 当前发布配置审计 | 产物证据与本次实跑 | 完整新 AI 生成验收 |
| --- | --- | --- | --- | --- |
| AI文生图 | 通过 | 通过 | 1 张历史图片可访问并读取尺寸 | 未执行 |
| AI图生图 | 通过 | 通过 | 1 张历史图片可访问并读取尺寸 | 未执行 |
| AI文生视频 | 通过 | 通过 | 1 个历史 MP4 可读取；H.264 + AAC，10.367 秒 | 未执行 |
| 颜域 | 通过 | 基础配置通过，产物有警告 | 已完成旧记录仅有文本，无可验收的最终同源媒体 | 未执行；不能认定完整链路通过 |
| AI参考生视频 | 通过 | **参考图片链路失败**；另有输出绑定警告 | 无已完成历史运行 | 先修配置，再真实生成 |
| 测试comfy | 通过 | 当前静态绑定检查通过 | 2 个历史视频输出可读取，均为 3 秒 H.264 + AAC | 未执行 |
| AI文生视频无设计版 | 通过 | 通过 | 1 个历史 MP4 可读取；H.264 + AAC，10.367 秒 | 未执行 |
| H3 数字人长视频 | 通过 | 通过 | 1 个历史 MP4：73.003537 秒、24 fps、H.264 + AAC | 未执行 |
| 长文出视频 | 通过 | 发布配置可读取；存在未发布修改 | 5 次历史失败、0 次已完成；最后为 Writer JSON 不完整 | 未执行；隔离烟测不替代正式 AI 实跑 |
| 电商套图 | 通过 | 通过；存在未发布修改 | **本次正式原图分支实跑成功：18 张 JPEG + ZIP** | AI 设计 / 生成分支未执行 |

媒体验证包括同源 URL 的 HTTP HEAD、Range，以及已归档真实文件的 Sharp / FFprobe 检查。5 个历史视频输出记录均含视频与音频流。电商 18 张图片是本次新增的非 AI 实跑产物，在之后的只读审计中也被作为既有完成运行读取。

## 二、正式环境新增实跑

### 2.1 电商套图：原图保真、不调用 AI

- 采用正式已发布工作流，版本 `c187f543-4045-498b-94d9-7329b4669803`。
- 测试标题：`E2E-20261001-电商套图-原图保真-无AI`。
- 运行 ID：`12b5171f-7c7c-470a-9e95-c1d18a0e7c35`。
- 两个 Hermes 步骤被条件分支跳过；本地渲染、预览、归档、下载完成。
- 6 张卡片 × 淘宝 / 京东 / 抖音，共 **18 张 JPEG**。
- 淘宝 / 京东均为 **1600 × 1600**；抖音为 **1200 × 1200**。检查了文件字节数、尺寸、哈希与预览路径。
- 独立打开 ZIP 并读取所有条目：**20 个条目（18 张图 + manifest + README），无缺件**。
- SSE 终态与持久化事件通过；本次实跑没有更改工作区或草稿。

证据：
- [实跑报告](F:/code/zane-drama/.local/production-e2e-20261001/live-commerce.json)
- [ZIP 检查日志](F:/code/zane-drama/.local/production-e2e-20261001/zip-verification.log)
- [下载包](F:/code/zane-drama/.local/production-e2e-20261001/commerce-pack.zip)

### 2.2 生产工作台：素材 → 人工确认 → 选片 → 合成

测试标记：`E2E-生产工作台-b0264a41`。以下均在正式服务上测试，但使用测试专属模板 / 人工媒体步骤，不把它们算作已发布 AI 场景的新生成成功。

| 检查项 | 结果 |
| --- | --- |
| 把测试电商结果保存到素材库 | 通过 |
| 创建 v2；固定 v1 的下载哈希不漂移 | 通过 |
| 素材历史版本 Range 下载 | 通过 |
| 过期素材 revision 更新返回 409，不覆盖新版本 | 通过 |
| 人工关卡等待时，下游不会提前运行 | 通过 |
| 退回重做生成新 reviewId；旧 reviewId 确认返回 409 | 通过 |
| 编辑人工输出再确认，下游收到修改后的值 | 通过 |
| 重复确认返回 409，保留确认历史 | 通过 |
| 两个合成视频逐镜输入，选片归档固定素材版本 | 通过 |
| 候选镜头读取、调整顺序及持久化 | 通过 |
| 过期选片 revision 合成返回 409 | 通过 |
| 纯本地 FFmpeg 合成、下载及保留音轨 | 通过 |
| 浏览器切换 v1；当前素材卡仍指向 v2 | 通过 |
| 浏览器重开选片清单：版本 3、已选 2/2 镜、顺序 2 → 1、固定 v1 | 通过 |

新合成视频：**1.188 秒、H.264、24 fps、AAC**。未调用 Writer 或视频生成模型。

[工作台实跑报告](F:/code/zane-drama/.local/production-e2e-20261001/live-workbench.json) · [浏览器版本 / 选片证据](F:/code/zane-drama/.local/production-e2e-20261001/browser-workbench-evidence.json) · [合成视频](F:/code/zane-drama/.local/production-e2e-20261001/synthetic-composed.mp4)

## 三、剩余问题与风险

### 3.1 AI参考生视频：参考图片没有送入视频生成节点（明确失败）

正式发布配置中的图片只传入 Hermes 设计环节，Comfy 视频生成节点没有图片绑定。因此，即使能生成视频，也不能保证它符合“参考生视频”的语义。本次未改动正式工作流。

同一场景的输出绑定写为 `1092.video`，当前工作流输出节点为 `92.video`。**这是警告而非已经证明的运行失败**：当前后端可回退到唯一媒体输出。应显式修正绑定，或通过真实执行验证回退行为。

建议验收步骤：修复正式工作副本的参考图片接入及输出绑定，人工检查后发布；使用辨识度明确的合成参考图生成一个最短样本，确认输入图片真实进入工作流并检查输出一致性。

### 3.2 长文出视频：历史 Writer JSON 失败，尚无正式成功样本

审计时有 5 次失败历史、0 次已完成运行。最后一次失败：

```text
Unterminated string in JSON at position 31537 (line 1 column 31538)
```

对应历史运行：`46d4c9c9-71b9-4b44-9be6-4e7004506ff4`。**本次没有新增生成来复现该失败**；源码隔离烟测已通过，但不能证明 Hermes 长文本输出或完整正式视频链路已经修复。下一轮应验证 JSON 输出完整性 / 恢复能力，再用最短长文样本完成真实视频验收。

### 3.3 颜域：完成状态不足以证明媒体链路成功

历史完成记录没有可访问的最终同源媒体，只有文本证据。仍需真实最小样本补测。其他 AI 场景的历史可读产物也不能替代当前配置实跑。

### 3.4 其他警告及历史错误

- AI图生图、AI文生视频、颜域、测试comfy 的部分迁移记录没有历史事件；仍验证了 SSE 终态快照。本次新电商运行的持久化事件单独验收通过。
- 长文出视频、电商套图存在工作副本修改；本次审计 / 电商实跑使用发布版本，未自行发布修改。
- 历史最新失败还包括 AI图生图的 Hermes 连接失败、测试comfy 的 `196.String` 输入绑定错误。当前配置 / 连通检查没有把它们复现为新失败；**也没有通过真实模型运行证明这些历史错误永不重现**。

## 四、源码回归与部署复测

为避免触碰正在运行的正式构建产物，在非隐藏的隔离目录复制源码、记录哈希、构建并启动临时服务：

`F:\code\zane-drama\backups\production-source-check-cd4c83cc-5d02-4b4f-bec5-8aee780cb8ec`

| 验证 | 结果 |
| --- | --- |
| 前端 / 后端 TypeScript 检查 | 通过 |
| 源码自动测试 | 197/197 通过，0 跳过 |
| 审计工具辅助测试 | 5/5 通过 |
| 前端 / 后端生产构建 | 通过 |
| 核心 server 隔离烟测 | 通过 |
| commerce 隔离烟测 | 通过 |
| long-text-video 隔离烟测 | 通过 |
| 测试结束后与快照清单比较 | 捕获期间源码未变化 |

[完整源码回归结果与各项日志路径](F:/code/zane-drama/backups/production-source-check-cd4c83cc-5d02-4b4f-bec5-8aee780cb8ec/check-report.json)。这些是冻结快照的测试结果，不声称覆盖之后发生的源码变更，也不等价于正式模型验收。

测试早期发现旧后端与新前端版本不一致：素材 / 选片 API 返回 404，并有 5 项源码测试失败。期间同期操作完成更新和重启（正式进程由 PID 53280 变为 PID 92348）。随后复测素材 / 选片 API 为 200，工作台链路完成实跑，上述最终快照全部通过。**这些早期问题不列为当前未解决故障，部署更新与修复不归因于本次测试操作。**

另一个早期快照放在隐藏目录下，Express 静态文件读取策略导致隔离前端烟测 404；改为非隐藏的 `backups` 路径后通过。此项属于测试夹具问题，不是正式环境缺陷。

## 五、保留的测试数据

本次共创建 **4 条带 E2E 标记的正式运行、3 个素材（其中一个有 v1 / v2）、1 个选片清单**，全部保留用于人工检查。没有删除真实数据，也没有取消同期运行。

| 类型 | ID |
| --- | --- |
| 电商运行 | `12b5171f-7c7c-470a-9e95-c1d18a0e7c35` |
| 人工确认运行 | `971e356e-0d75-4fdf-a46f-f25485dba153` |
| 合成测试逐镜运行 | `802c6a1a-67d6-47e8-a9d4-78c297360759` |
| 本地合成运行 | `71eb1932-0ea6-456d-bf7c-2a231d058ea2` |
| 测试杯素材（v1 / v2） | `e6698b85-ddf7-44a9-bfc5-ed81d801629f` |
| 选片清单 | `73a44a90-6dc1-433c-a348-cccf9f32de2b` |

## 六、复测入口与证据目录

新增脚本，不修改业务源码；所有正式写入烟测均需显式 `--allow-local-write`，且限制为无 AI 分支 / 测试专属数据。

```powershell
Set-Location 'F:\code\zane-drama'

# 只读正式审计；发现真实失败时以非零退出码结束
node 'F:\code\zane-drama\scripts\audit-production.mjs' --output-dir 'F:\code\zane-drama\.local\production-e2e-audit'

# 审计辅助用例
node --test 'F:\code\zane-drama\scripts\audit-production.test.mjs'

# 冻结源码并隔离构建 / 自动测试 / 烟测，不改正式 dist
node 'F:\code\zane-drama\scripts\check-production-snapshot.mjs'

# 注意：以下两项会新增 E2E 正式测试数据，但不调用 AI
node 'F:\code\zane-drama\scripts\smoke-production-commerce.mjs' --allow-local-write --output-dir 'F:\code\zane-drama\.local\production-e2e-commerce'
node 'F:\code\zane-drama\scripts\smoke-production-workbench.mjs' --allow-local-write --commerce-report 'F:\code\zane-drama\.local\production-e2e-commerce\live-commerce.json' --output-dir 'F:\code\zane-drama\.local\production-e2e-workbench'
```

本次原始证据目录：`F:\code\zane-drama\.local\production-e2e-20261001`。

- [重启后只读审计（Markdown）](F:/code/zane-drama/.local/production-e2e-20261001/after-restart/audit.md)
- [重启后只读审计（完整 JSON）](F:/code/zane-drama/.local/production-e2e-20261001/after-restart/audit.json)
- [10 个场景浏览器与空输入证据](F:/code/zane-drama/.local/production-e2e-20261001/browser-evidence.json)
- [历史媒体与电商文件验证](F:/code/zane-drama/.local/production-e2e-20261001/media-validation.json)
- [当前素材版本截图](F:/code/zane-drama/.local/production-e2e-20261001/asset-v1-version.jpg)
- [当前选片清单截图](F:/code/zane-drama/.local/production-e2e-20261001/selection-persisted.jpg)

旧截图 `F:\code\zane-drama\.local\production-e2e-20261001\assets-unavailable.jpg` 仅保留故障时间线，不能当作当前状态。

### 正式电商实跑成功截图

![正式电商原图分支实跑完成](F:/code/zane-drama/.local/production-e2e-20261001/commerce-run.jpg)

## 七、完成全部场景验收的下一步

需确认 GPU 占用和外部模型费用预算，再安排每个 AI 场景一次最小真实生成（参考生视频先修发布配置）。将实际模型输入、生成进度、事件、归档、预览、下载和内容质量一并验收；不将历史成功或隔离 stub 测试当作真实 AI 成功。
