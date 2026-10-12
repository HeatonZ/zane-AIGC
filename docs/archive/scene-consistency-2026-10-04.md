# UI / HTTP / MCP 场景一致性验收（2026-10-04）

此文件是本次修复的历史验收记录，不是当前运行版本的自动探测结果。在线契约以 `get_workbench` 为准；操作手册及机器契约仍由 AI 文档生成器维护。

## 问题和统一原则

只读对账确认：正式工作区、HTTP 场景目录与真实 stdio MCP 的场景 ID、名称和顺序来自同一 SQLite 工作区。浏览器的首次读取后缺少持续同步，读取路径还会迁移流程、重新计算发布版本；场景目录使用草稿，而创作使用发布快照，两种视图之前不够明确。

修复保持 SQLite / WorkspaceService 为唯一权威，不增加 AI 旁路数据库，不通过清理浏览器数据或自动发布来抹平差异。

## 交付的能力

- 浏览器初始化及后续同步严格读取权威快照，不回填内置场景、不迁移发布快照、不因读取自动写回。
- 每 3 秒核对共享 revision，重新聚焦、联网和切换页面时同步。配置提交、编辑字段、对话框或创作输入未完成时仅提示，不自动覆盖。
- 刷新替换工作区时先读成功，再检查期间的新编辑和保存回执；失败时保留本机修改与待提交队列。
- 创作页固定打开时的发布快照。AI 发布或任务草稿保存回执不会静默切换版本、重置正在输入的内容；新版本单独提示。
- 目录 / 流程配置是草稿视图，创作 / `get_scene` 是发布视图，均显示对应标识。差异不等于不同数据源；发布仍须显式操作。
- `GET /api/workspace/status` 与 MCP `get_workspace_status` 返回 SQLite authority、workspaceRevision 和两个视图边界。
- `list_scenes` 保持权威顺序，提供分页及草稿 / 发布名称、draftRevision、draftMatchesPublished。默认每页 50 条，最大 200 条；旧 revision 游标返回 `409 SCENE_PAGE_CHANGED`，不能混合多个版本的分页。
- 新网页仅在旧后台状态接口返回 404 时，兼容读取原有 `/api/workspace` 权威快照；连接故障及 503 不回退本地数据。兼容读取不代表旧后台已提供新增 AI 工具。
- 操作 schema、响应契约、OpenAPI、功能矩阵、指南及生成文档已同步。

## 验收

- 最后一轮 `npm run check` 退出码 0：301 个 Node 测试全部通过，无失败；类型检查、编译、文档漂移和全部隔离 smoke 通过。
- 17 个 Hermes Python 辅助脚本回归通过。
- 真实 stdio MCP 隔离闭环覆盖状态、场景分页、新字段、无效参数、旧游标、并发 revision 及发布响应丢失对账。
- 隔离真实网页验证：MCP 创建 / 改名后浏览器同步；正在输入时发布不覆盖表单；保存任务草稿回执仍保留输入与原发布版；删除最后场景后显示空目录而不恢复内置场景。
- 正式只读验收于 2026-10-04 11:17（Asia/Shanghai）确认网页、HTTP 与 MCP 对账为共享 r120、9 个场景，ID / 名称 / 顺序一致；worker 空闲且 ready / accepting。
- 正式数据只读前后数据库验收文件 SHA256 相同；195 个历史运行、263 个步骤、1048 个事件等数据未被本次验收修改。未调用真实生成模型，未审批生产任务。

## 正式上线状态与剩余操作

**本次交付时：网页构建已更新并完成旧后台兼容验证；正在运行的后台仍是 AI 契约 1.2.0，目标构建是 1.3.0。新增状态工具、场景分页和视图字段尚未在正式后台生效。**

正式切换前已核验工作台进程身份、启动链、空闲状态，完成一致性 SQLite 在线备份。自动停止 / 启动命令被执行策略拒绝，未执行，因此没有停服、没有新进程。没有重启或修改 Hermes Gateway / ComfyUI。不要绕过策略，不重复使用本次一次性升级脚本里的旧 PID。

由用户在原工作台终端正常切换：

1. 保存并核对浏览器未同步配置和创作草稿，确认没有生成 / 排队 / 审核中的任务。
2. 在原工作台终端按 `Ctrl+C`，等待原后台正常退出。
3. 在同一终端、工作区 `F:\code\zane-drama` 执行 `npm run start`，使用已验证的编译产物。不要使用带强制停服 prestart helper 的 `start:prod`。
4. 保存输入后刷新网页；通过 `get_workbench` 确认契约 1.3.0，再读取 `get_workspace_status`，核对场景和 revision。
5. 如果 Hermes 缓存了 MCP 工具目录，只重新加载工作台 MCP 连接；无需重启 Hermes Gateway 或 ComfyUI，不清浏览器缓存，不自动发布场景。

如正常退出失败，应停在该步骤检查原因，不使用旧 PID 的强制终止脚本。

## 证据与文档

本次备份包：`backups/scene-sync-upgrade-2026-10-04T02-49-40-346Z-1d11d2de`。

- `check.log`：最后完整门禁，与工作区 `scene-sync-check.log` 的 SHA256 一致。
- `python-check.log`：Hermes Python 回归。
- `live-readonly-comparison.json`：真实 stdio MCP / HTTP / 浏览器兼容读取对账。
- `final-verification.json`：最后只读状态、301 测试结果与仍需手工切换的状态。
- `zane.online-backup.db`：正式数据一致性备份。
- `source-final-verified.json`：最终源码指纹；此前切换准备时的指纹早于兼容修复，不能当作最终版本。
- `backups/scene-sync-verification-20261004/live-catalog-r120.png`：新建只读正式网页显示共享 r120 和 9 个场景。
- `backups/scene-sync-verification-20261004/input-and-version-preservation.png`：隔离网页的输入及发布版本保护验收。

`process-environment.json` 仅用于本机恢复，可能包含私密配置，不应粘贴到聊天或对外分享。日常 AI 操作参见生成文档 `docs/ai-operator.md`、`docs/ai-foundation.md` 和 `docs/ai-tools.md`。