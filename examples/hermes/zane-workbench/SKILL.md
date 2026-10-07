---
name: zane-workbench
description: "通过工作台公开接口发现、配置、执行与交付业务，按实时项目、能力和授权选择操作。处理工作台业务时加载；作为工作台流程节点时只返回该步结果，不递归编排。"
version: 1.2.0
metadata:
  hermes:
    tags: [zane, workbench, business, mcp]
    category: productivity
---

# Zane 工作台操作

## 先判断自己的角色

- **业务编排者**：帮助用户处理工作台业务。根据实际目标与能力发现、配置、执行和交付，不限定业务类型或固定流程；底层执行留给工作台节点，不绕过工作台直接调用执行引擎。
- **流程节点**：收到工作台对某一步产物的要求，只按该步返回结果；不要调用 `submit_scene`、`resume_run`、`rerun`、`review_run` 等编排操作，也不要修改所在流程或重新启动整个任务。

角色由任务上下文决定，不由 profile 名称决定。无法判断时先厘清上下文，防止自调用。本文的工具名是当前版本示例，不是永久职责清单；业务、输入和操作以实时契约为准。

## 工具入口（当前 Hermes 名称）

服务器配置名是 `zane-workbench`，Hermes 规范化后的前缀为 `mcp__zane_workbench__`。
如果工具被延迟发现，先用客户端工具搜索查 `zane_workbench`；不要猜另一种前缀，也不要因为暂未发现工具改成操作数据库。

1. 用 `mcp__zane_workbench__read_resource`，参数 `{"uri":"zane://guide"}`，读取实时操作手册。
2. `mcp__zane_workbench__get_workbench` 检查契约、worker.ready/accepting、projectConfigured、目标项目目录。
3. `mcp__zane_workbench__list_scenes` → `get_scene` → `prepare_scene`。固定返回的 `sceneId`、`versionId` 和素材版本。预检不调用外部生成，也不保证远端服务正常。
4. 若接口返回404/HTML或后台未就绪，停在诊断，说明需要升级后台；不重启正式服务，不编辑 SQLite/JSON 镜像。

除明确示例外，下文短工具名都必须加上述前缀。参数以当前工具 schema 为准，不照抄旧场景或猜输入键。

## 轻量读取与上下文控制

- 日常业务从 `get_workbench`、`list_scenes` 和目标 `get_scene` 开始；不要为挑场景或查询进度读取整个 `get_workspace`。这些是当前接口示例，操作以实时 schema 为准。
- `list_runs` 优先带目标 sceneId/status 和较小 limit（如20），保留 nextCursor 继续分页；不要默认拉全历史。事件也按 after/limit/nextSequence 分页，按需读取。
- 查询已知 runId 的当前状态，用 `wait_run` 的 `timeoutSeconds:0` 立即返回摘要；它不提交、不取消也不重跑。需要等待进展时再用最多30秒的有界等待。读取 status、nextAction 和 pendingReview；不要靠反复读取全量 `get_run` 轮询。
- 交付或定位步骤问题优先用 `get_run_outputs` / `get_step_result`，按outputKey/stepId/itemIndex选择并分页；必要时才 `get_run` 读完整流程或修订来源。检查valueOmitted、valuePage.complete和游标，省略/分段内容不能当完整结果。
- 配置单个场景用 `get_scene_draft` 及其内容revision，不搬整工作区。只有明确的高级批量配置才用 `get_workspace` / `merge_workspace`；base必须完整，截断时停止写入，不拼凑、不省掉其他场景。
- 目录、字段、默认值、发布版本和能力都取自实时响应，不把本次场景数量、路径、响应体积或业务样例写成永久规则。

## 配置与适配业务

- 先读目标场景草稿；新业务用 `create_scene`，先保存scene.id。按用户目标配置，不绑定固定场景或业务。未发布草稿不能执行。
- `update_scene_draft` 使用当前内容revision；提供的scene/workflow是完整部分替换，省略部分不变。409读取当前revision与冲突，再合并决策，不覆盖共享状态。
- `validate_scene_draft` 校验本地结构/引用/默认值/预设/能力，不生成；再 `publish_scene` 发布。调用前保存UUID publicationId及目标revision，它将成为versionId。响应丢失先get_scene按同versionId读回，不换ID重发；保留范围外不承诺无限去重。
- 发布回执不等于执行；读取真实get_scene版本，再看inputSchema/inputDefaults/inputRequirements/inputExamples，按requiresUserInput和missingRequiredInputs补齐。不要照抄示例文本或虚构媒体素材ID。
- 共享选项先 `list_option_presets` 查看revision和使用场景，再 `save_option_preset`；修改只影响草稿。恢复旧发布版用 `restore_scene_draft`，冲突预设会克隆，不改其他场景。
- `delete_scene` / `delete_option_preset` 仅用于用户明确要求的目标，使用最新revision；不为“清理”擅自删除业务。删除场景不删除运行/媒体，引用中的预设不能直接删除。
- 运行固定发布版本，草稿修改不追溯改变已有运行。初始化空工作区可以用create_scene或initialize_workspace，不能拿旧文件覆盖已有项目。

## 提交与等待

- 先说明输入、场景发布版本、可能产生费用的节点和审核点；在用户授权范围内执行。
- 检查发布快照的 Hermes 节点。若 `hermesProfile` 与当前控制 profile 的实际名称相同（根据运行时 HERMES_HOME/metadata 确认），必须明确它只作为节点返回结果，不能再次编排；无法确认角色时先报告自调用风险，不自动提交。其他 profile 的执行节点不因控制者变更或名称相似而自动改写。
- **提交前**生成 UUID 并持久保存 `runId`、后台地址、项目目录、sceneId、versionId 与输入摘要；账本放到当前 profile 的 `HERMES_HOME/memories/zane-workbench-runs.jsonl`，不能把目录写死为其他 profile。记录时间和授权范围，不记录凭据。
- `submit_scene` 使用保存的 runId 和固定 versionId。工作台已接受的提交以真实返回的 runId/queued/running 为证据；**不要求自己另行调用底层引擎**。工作台运行ID与底层执行凭证不可混用。
- 请求超时、断连或500后，先 `get_run` 查同一 runId；未查到也不能立刻换 ID 重投，先排查是否同一后台/项目并向用户说明结果未知。
- `wait_run` 每次最多30秒。timedOut 不等于失败或取消；继续查原运行，不重复提交。事件用 after/limit/nextSequence 分页。
- waiting：读取最新 pendingReview/reviewId，展示需要审核的真实输出；只按用户授权 approve/redo。完成状态还需检查媒体与内容 QA，不能只报成功。

## 修复与交付

- 失败先看 `get_run` 中的步骤详情和 `get_run_events`，分清阻塞/取消/失败；不要把网络不确定性变成重新生成。
- 恢复/局部重做使用 `resume_run` 或 `preview_rerun` → 用户确认 → `rerun`；都需先保存新的 UUID，响应丢失按该 ID 对账。
- 素材用 `assetId + assetVersion` 固定引用；元数据或选片修改先读当前 revision，409 后重读而非盲重试。
- 选片用真实 shotId 和候选来源；完整后 `compose_clip_selection` 仅本地 FFmpeg 合成，仍先保存新 runId。不要把合成当成重跑生成。
- 交付包含 runId、场景版本、真实媒体地址/文件、审核状态和 QA 结论。未完成时明确当前状态、下一步和需要用户处理的阻塞。

完整参数、状态机与恢复规则以 `zane://guide`、`zane://openapi` 为准；这份技能负责 Hermes 角色和路由，不复制整套接口文档。
