# 视频场景双采迁移（2026-10-02）

四个正式场景已通过原有场景服务保存草稿、校验 revision、显式发布，并从正式 HTTP 和真实 stdio MCP 重读确认。刷新工作台后，**新建运行使用以下新发布版本**；历史发布快照、历史运行及其重做来源不自动替换。

| 场景 | ComfyUI 工作流 | 发布版本 | versionId |
| --- | --- | --- | --- |
| AI文生视频 | `Zane/video_双采.json` | `a2d961e8` | `9420992d-f784-4814-8fd7-9bf70e2d8aa4` |
| AI参考生视频 | `Zane/video_双采.json` | `f65b20a6` | `0477c0e8-ddee-4bb7-9dd2-f8a0be092eb2` |
| AI文生视频无设计版 | `Zane/video_双采.json` | `2c58184a` | `ef5412ee-f273-4703-ab99-eb6ed24b858a` |
| 长文出视频 | `Zane/video_双采_json.json` | `f7406da5` | `bb0ce775-3d02-4102-ae9e-4ef119ea0fdd` |

## 绑定与兼容

- 不新增执行器或任务数据库。前三个场景复用基础 ComfyUI 步骤；长文保留原有 `long_text_video` 原生对白适配、通用逐项执行和 `video_concat` 拼接。
- 双采图已在本机安装，实际视频/音频解码来自 196 号 `SelfLiftAvatarH3Sampler`，其 sigmas 来自 197 号 `H3SigmaRefiner`；它们位于实际 SaveVideo 的上游，且未被禁用。保留图自身采样参数，不修改共享 ComfyUI 文件。
- 普通文本入口仍是 `192.prompt`；秒数 `155.value`、画幅/像素 `115.aspect_ratio / megapixels`、最终输出 `92.video`。参考生视频继续按输入顺序把图片接入 `192.ref_images`，不只是提示词中提到参考图。
- 长文 JSON 图的 String 节点为 **201**；`shot_json` 把完整 `iteration.item` 序列化为文本写入 `201.String`。旧图的196号 String 绑定不能保留，因为新图196号是采样器。
- 长文保留 `192.length = iteration.item.frames`、`152.fps = 24`、17k+5帧对齐、逐镜人物/场景/道具 `ref_images`、音色 `ref_audios`、原生声音/禁止音乐策略和顺序拼接。
- 核对了原有长文未发布草稿：仅视频生成输出标签和未设置的素材端口与旧发布版不同。保留原标签和素材来源，将四个空素材端口修复为真实 H3 端口；各镜不需要的素材仍为非必填。未覆盖 Writer、输入契约、分镜或拼接配置。
- 其他场景、共享预设、项目草稿和所有已有保留版本逐项对比未变。本次保留全部旧版本；迁移脚本在发布会触发10版上限裁剪时拒绝继续，而不是静默删掉历史。

## AI 操作与安全边界

复用 `get_scene_draft → update_scene_draft → validate_scene_draft → publish_scene → get_scene`。HTTP 与 MCP 使用同一权威服务、SQLite 和 revision。流程内继续使用原有 `comfyui.workflowFile / bindings`，没有新请求字段，也没有任意 HTTP、SQL 或文件代理。

- 修改提供的整个 workflow 部分，不做深层 patch；不要只换文件名而遗漏节点绑定。
- 修改前读当前 revision；冲突必须重读，不覆盖其他编辑。
- publicationId 在请求前保存，发布响应丢失用同一个 versionId 重读对账；不要换 ID、重放或强制覆盖。
- 保存/校验不发布，发布不执行。真实生成必须另行授权并提交固定的新 versionId/runId。
- AI 功能矩阵、工具/schema说明和手册已同步；`npm run docs:ai` 重新生成文档。新启动/重连的 MCP 进程包含双采说明。**本次未重启正式工作台，HTTP 在线手册的新增说明随下次安全升级加载；现有 HTTP/MCP 参数兼容，四个已发布场景不依赖该说明刷新即可使用。** 未重启 Hermes Gateway 或 ComfyUI。

## 可复用迁移脚本

```powershell
# 默认只读业务状态，输出计划与服务端工作区快照，不保存/发布/生成。
node --import tsx scripts/migrate-video-dual-sampling.mjs

# 仅保存与校验草稿，不发布。
node --import tsx scripts/migrate-video-dual-sampling.mjs --apply

# 确认计划、进程身份、空闲任务和一致性SQLite备份后，显式发布。
node --import tsx scripts/migrate-video-dual-sampling.mjs --apply --publish
```

已有未发布编辑时，脚本拒绝直接发布。先核对相关编辑是否属于本次迁移，再显式加 `--include-existing-draft`；该标志不允许覆盖新 revision。`--output-dir` 必须是未存过 `workspace-before.json` 的目录，避免覆盖备份。脚本不自动重试写入，出错会记录场景 ID、publicationId、revision 和对账入口并停止。已经是相同双采发布版的场景不会再次发布。

## 验收与备份

- `npm run check`：285项测试全部通过，包含类型检查、前后端构建、既有隔离冒烟、AI文档漂移检查，以及新增真实 stdio MCP 四场景迁移闭环。
- 新增闭环覆盖：文本/参考/无设计/长文四种流程，所有新节点绑定通过 MCP 到达权威业务服务；无效绑定、旧 revision 冲突、发布响应对账、同 ID 发布去重、旧发布快照保留、其他草稿不变，以及未产生任何运行。
- `npm run test:long-video:smoke`：模拟 Writer/ComfyUI 与真实 FFmpeg，验证201号JSON入口、采样器未被写入String、原生24fps、逐镜素材与音色选择、成片顺序和失败片段恢复。没有调用实际模型。
- 正式工作台 SQLite 一致性在线备份 `quick_check = ok`；修改前后双采图 SHA-256 相同。正式服务仍为原进程，worker queued/active/preparing 均为0。
- **未运行真实模型生成，不能将配置/隔离验收等同于新双采成片质量验收。**

本次备份与回执：`F:\code\zane-drama\backups\video-dual-sampling-production-20261002-215839-c478fc42`，含一致性 `zane.db`、连接配置、修改前后服务端工作区、预存发布 ID 的迁移计划、实际 MCP 回读和进程身份记录。不要把旧 PID 当成以后升级的目标。
