# 基础优先能力：端到端验收与正式后台切换（2026-10-02）

## 当前实际状态

**已完成隔离端到端测试并切换正式后台，不需要再次执行升级脚本。**

| 项目 | 本次实际验收快照 |
| --- | --- |
| 工作台目录 | `F:\code\zane-drama` |
| 正式地址 | `http://127.0.0.1:8799` |
| 当前进程 | PID **74036**，`node dist-server/index.js --production`；2026-10-02 **15:46:33 +08:00** 启动 |
| 原进程 | PID 89640；已通过独占控制台 Ctrl-C 触发现有 SIGINT 收尾，退出码 0；未强杀 |
| AI 契约 | **1.2.0**；HTTP、编译 Node stdio MCP、已安装 Hermes 客户端均通过 |
| Worker | ready/accepting=true；queued/active/preparing=0 |
| 正式数据 | `F:\code\zane-drama\data\production\zane.db`，SQLite 版本 2，quick_check=ok |
| 项目目录 | `F:\project\zane`，未迁移、替换或重建 |
| 工作区 | revision **78**；10 场景、10 发布场景；未安装测试场景、未自动迁移既有发布快照 |
| 历史业务 | 150 运行、157 步骤、614 事件、4 生产文档，切换前后逐表内容哈希完全一致 |
| 能力发现 | 9 项基础、3 项专用/兼容；UI 新选择默认仅基础，专用按需展开 |

PID、数量、目录和 revision 仅是本次只读验收快照，不是未来升级的固定输入。

## 验收范围和结果

### 最终全量门禁

- 最终 `npm run check`：**280 测试通过，0 失败、0 跳过**。类型检查、前后端构建、后台/反馈/电商隔离冒烟、AI 文档漂移检查、真实 stdio MCP 冒烟、新基础媒体编译产物闭环均通过。
- 已把可重复的基础闭环加入 `test:basic:smoke` 并纳入 `check`，实现文件为 `F:\code\zane-drama\scripts\smoke-basic-capabilities.mjs`。
- 最终检查前后及停服前重新核对源文件 SHA-256，代码和生成 AI 契约未在验证窗口漂移；保留工作区已有未提交改动。
- 另行执行 H3 旧流程隔离兼容测试：本地 mock Writer/ComfyUI、真实 FFmpeg/FFprobe；验证素材映射、音色绑定、帧网格、无音乐规则、失败逐项恢复、祖先归档和含音轨 MP4，**没有真实模型调用**。
- Python 安装/客户端接入回归 **16 项通过**。唯一非阻断构建告警是 Vite 大包超过 500 kB。

### 编译 HTTP + 真实 stdio MCP 闭环

使用临时端口、临时 SQLite、临时项目、本地图片；Hermes home 不存在，ComfyUI 指向不可用的隔离地址。完整验证：

1. 基础/专用 tier 分页、cursor 所属范围、输入 schema 与 HTTP/MCP 同源发现。
2. 上传素材并固定版本；创建/编辑场景；旧 revision 返回 409；校验后显式发布。
3. 使用原 publicationId 对账重复发布；以固定发布快照预检，无外部执行步骤。
4. 提前保存 runId；提交后只读原 ID 对账，重复提交返回 RUN_ALREADY_EXISTS，不创建第二个任务。
5. `media.select_references` → 通用并发 `for_each` → `media.image_layout`，输出 3 个规格，无并发文件覆盖。
6. 分段读清单和逐项结果；媒体 GET、HEAD、Range、尺寸、SHA-256 验证。
7. 只重做一个逐项索引，其余结果复用；原运行记录、原图片与祖先归档保持不变。

### 真实浏览器闭环

- 在隔离项目的创作页从素材库选用固定版本，输入两种规格，点击运行后实际进入完成记录：2 个基础步骤、2 项排版、图片预览和清单正常。
- JSON 对象/数组默认值显示为有效 JSON；导入/导出保留完整结构，已有草稿、显式 null 和旧 JSON 字符串默认值兼容。
- 流程设计器默认 9 个基础选项；手动展开才出现 2 个 H3 专用选项。旧电商包仅保留历史兼容，未作为新选择推荐。
- 截图和机器回执只留在本地忽略备份中；测试页面/数据与正式工作区隔离。

### 测试发现并修复的问题

1. AI 返回的 output-media 下载地址原先拒绝工作台自身的归档 URL。现在由 AssetService 统一解析本地/祖先归档，支持 HEAD/Range；外部 URL 不在这个只读接口中自动下载或生成。已增加路由回归，并通过编译 MCP 实际下载新产物及局部重做复用产物。
2. 创作表单把结构化默认值转换成 `[object Object]`，场景导入还会丢弃对象/数组默认值。现与已有 JSON 机器契约对齐，保留完整默认值，统一转为表单 JSON 文本，并加入两项回归。

## 正式切换与保留证明

1. 全量验证后重新核验当前 8799 listener 的 PID、创建时间、exe、命令、cwd；通过只读进程接口新捕获该进程启动环境，秘密只保存在忽略备份内。
2. 再次确认 ready、无 queued/active/preparing、SQLite 无 queued/running/cancelling/waiting。**原有 6 条 stale 历史记录保留，不自动恢复或重跑**。
3. 停服前通过 Node SQLite backup API 做一致性在线备份；另外备份 JSON 镜像和项目 `.zane` 的 **713 文件 / 164,817,520 字节**，逐文件核对复制后 SHA-256。
4. 在隔离进程验证 Ctrl-C 会执行现有关闭逻辑。正式停服前确认控制台仅属于工作台及短暂信号助手，避免信号影响其他服务；原进程正常收尾并以 0 退出。
5. 停服后离线复制整个正式数据目录，保留当时存在的 WAL/SHM；SQLite 表哈希与停服前一致，再以同 cwd、端口、数据路径和捕获环境启动新版隐藏子进程。
6. 在线验收契约、基础能力、兼容 metadata、发布场景、guide/OpenAPI 和实际前端静态构建；Node/Hermes 正式 doctor 通过。Hermes 实际调用新 tier/limit/cursor，确认分页与 valueSchema 通过已安装客户端，不仅检查工具名。
7. 切换前、切换后和最终复查的 **全部 SQLite 表内容哈希一致**；连接配置字节哈希一致；713 项目归档文件哈希一致。
8. ComfyUI PID 43340、Hermes supervisor PID 29268、Gateway PID 58408 的创建时间、exe、命令均未改变，**未重启这些服务**。未修改 Hermes 上游/evolution foundation。

正式验收仅读取，没有新建生成任务、批准审核、发布场景或修改连接。

## 备份和回执位置

本次备份目录：`F:\code\zane-drama\backups\workbench-basic-20261002T150403`。

| 内容 | 文件/目录 |
| --- | --- |
| 最终门禁和源指纹 | `final-check.log`、`final-source-before.json`、`final-source-after.json` |
| 编译/MCP/浏览器端到端 | `basic-ui-final-e2e.log`、`basic-ui-acceptance.log`、`browser-acceptance.json`、`browser-basic-run.png`、`browser-basic-picker.png` |
| H3/Python 隔离兼容 | `legacy-h3-isolated-smoke.log`、`python-acceptance.log` |
| 一致性在线数据备份 | `consistent-data`、`online-backup.json` |
| 停服后的完整正式数据 | `production` |
| 项目归档及哈希清单 | `project-archive`、`project-archive-manifest.json` |
| 数据和进程保留证明 | `switch-live-database.json`、`switch-before-database.json`、`switch-after-database.json`、`final-database.json`、`database-preservation.json` |
| 正式可操作性验收 | `online-acceptance.json`、`final-ai-doctor.json`、`final-hermes-doctor.json`、`final-hermes-basic.json` |
| 身份、正常关闭和启动 | `process.json`、`new-process.json`、`old-process-shutdown.json`、`upgraded-server-launch.json`、`upgraded-server.stdout.log`、`upgraded-server.stderr.log` |
| 总回执 | `final-verification.json` |
| 敏感环境 | `process-environment.json`，只留本机忽略目录，不提交、不粘贴 |
| 构建参考 | `dist`、`dist-server`、`rollback-previous`；后者来自经核验的前一次部署备份，不声称是旧进程内存的精确副本 |

本机助手/启动文件用于本次切换，**不要复用历史 PID 或重复运行**。回退前应核对新发生的正式写入，不能为了恢复旧哈希覆盖新数据。项目备份范围是 `.zane` 权威归档，不宣称包含任意项目外原始素材或所有磁盘文件。

## 现在如何使用 / 验收边界

- 浏览器刷新即可加载基础优先的步骤选择 UI；旧页面不应自动替换已保存、已发布的专用节点。
- 已有工作区未自动插入新示例。需要基础图片流程时可显式导入 `F:\code\zane-drama\examples\scenes\basic-image-layout.json` 为草稿，核对后再发布。
- Hermes 已安装客户端的短时只读验收已通过；已有会话若缓存旧工具 schema，可在空闲会话使用受支持的 `/reload-mcp` 或开启新会话，不必重启 Gateway。本次没有代发频道命令。
- 本地确定性排版、模拟 H3 兼容和生产只读接入都已验收；**真实付费模型、真实 H3 成片质量与计费尚未验收**，须另行明确业务授权。
