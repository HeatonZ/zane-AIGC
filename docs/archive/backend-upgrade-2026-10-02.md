# 正式后台升级完成（2026-10-02）

## 当前实际状态

**正式后台已完成升级，不需要用户再执行切换脚本。** 已在正式8799端口核验新版进程、ready状态、AI契约与真实Node/Hermes MCP；升级前后数据库逐表哈希和连接配置哈希一致。

| 项目 | 切换后复查值 |
| --- | --- |
| 工作台 | `F:\code\zane-drama` |
| 正式地址 | `http://127.0.0.1:8799` |
| 新进程 | PID 89348，`node dist-server/index.js --production`；2026-10-02 09:51:08（Asia/Shanghai）启动 |
| 原进程 | PID 91696，已退出；仅重启已核对身份且空闲的工作台 |
| 数据目录 | `F:\code\zane-drama\data\production`，数据库 `zane.db` |
| 项目目录 | `F:\project\zane`，未迁移媒体 |
| 数据 | SQLite版本2，quick_check为ok；10场景、10发布场景、150运行、614事件、157步骤、4生产文档；工作区revision 76 |
| Worker | ready/accepting为true，queued/active/preparing均为0 |
| AI接口 | `GET /api/v1/ai` 返回契约1.0.0，不再是404 |
| MCP | 29个业务工具、4个资源、1个提示词；Hermes实际注册33个工具，前缀 `mcp__zane_workbench__` |

以上是本次只读验收的快照，不是后续项目数量、PID或业务配置的永久规则。

## 实际完成的切换与验证

1. 停服前重新生成AI契约并执行完整 `npm run check`，核对验证期间源文件没有变化；保留了工作区其他业务编辑，包括新增的Hermes结果反馈功能。
2. 再次确认原进程PID、创建时间、命令和cwd，确认worker空闲、数据库无未完成运行后，仅停止工作台旧进程。
3. 停服后复制整个正式数据目录，保留WAL/SHM；没有删除原目录、重新初始化工作区或重建场景。
4. 保留原进程环境，以同一cwd、8799端口、同一数据目录隐藏启动新版工作台；项目仍为原目录。
5. 检查实际 `/api/ready`、AI契约、项目和发布场景；升级前后及最终复查的数据库逐表哈希一致，连接配置哈希一致。
6. 实际执行Node stdio doctor与Hermes安装版本MCP客户端的只读验收；没有提交生产任务或调用真实生成服务。

验证结果：

- 全量 `npm run check`：**232测试通过，0失败、0跳过**；包含类型检查、前后端构建、后台/反馈/电商隔离冒烟、AI文档一致性和真实stdio AI冒烟。
- **16项Python接入回归通过**；Hermes隔离冒烟通过。
- 正式Node doctor与正式Hermes doctor通过，guide/skill可读，目标项目正确，当前发布版无 `comfyui-dev` 自调用节点。
- `comfyui-dev` 职责和共享名录已调整为灵活的工作台业务协作者；操作技能升级到1.1.1，增加轻量读取与摘要轮询规则。profile配置字节未改变。
- Hermes用户层 `E:\Data\hermes\bin\hermes.cmd` 的源码根路径已修复，仅修改launcher，未改上游。实际 `hermes -p comfyui-dev chat --help` 返回0；这只证明入口与参数解析正常，不等于真实模型任务已验收。

## 备份与回执

备份目录：`F:\code\zane-drama\backups\workbench-upgrade-20261002-20261002T011720`。

| 文件/目录 | 内容 |
| --- | --- |
| `launch.json`、`upgrade-status.json` | 当前完成状态、旧/新PID、验收概要 |
| `production` | 实际停服后的完整数据目录离线备份，包含WAL/SHM |
| `consistent-data` | 切换准备阶段通过SQLite backup API得到的一致性在线备份 |
| `switch-before-database.json`、`switch-after-database.json`、`final-database.json` | 逐表计数、哈希及完整性快照 |
| `switch-build.log` | 停服前的完整检查日志，232测试通过 |
| `upgraded-server.stdout.log`、`upgraded-server.stderr.log` | 新进程启动日志 |
| `final-ai-doctor.json`、`final-hermes-doctor.json`、`final-verification.json` | 最终只读验收回执 |
| `hermes-entry-repair.json` | 用户层CLI入口修复回执与原launcher备份位置 |
| `ai-usability-audit.json` | 正式接口响应体积与AI使用缺口测量，无生成副作用 |
| `dist`、`dist-server` | 准备阶段的磁盘构建备份，不宣称是旧进程内存代码的精确副本 |
| `process.json`、`process-environment.json` | 原进程身份/环境；环境文件只留在忽略的本地备份，勿提交或粘贴内容 |

`complete-upgrade.ps1` 已成功执行，是绑定旧PID的**一次性切换脚本，不要重复运行**。后续升级应重新取得当时的进程、任务和数据基线，不能继续使用本次旧PID。

## 之前的准备状态（历史）

早期首次检查为218测试通过；随后其他业务代码仍在编辑，一度出现AI契约快照漂移，首次自动停止命令也被执行环境拒绝。因此当时记录“待手动切换/AI入口404”是准确的历史状态。2026-10-02后续切换已重新同步契约、完整验证232测试并成功执行；旧状态不再适用于当前后台。

## 回退、会话与保留

应用产物与数据备份分别保留。回退前核对当前工作台任务和新增记录；优先恢复到另一个明确目录，不用旧备份直接覆盖新增生产记录。数据库备份不等于完整项目媒体备份。

本次没有重启Hermes Gateway或ComfyUI，没有修改 `hermes-agent`、原 `comfyui` profile、现有场景/发布版本或工作区镜像，没有调用真实模型或生成媒体。

旧Hermes会话可能缓存工具和职责；在对应profile的空闲会话按需要 `/reload-mcp` 并开启新会话，不需要为此重启Gateway。本次没有代发频道命令。会话操作见 [Hermes接入说明](hermes-workbench.md)，实测AI改进优先级见 [AI友好性审查](ai-usability.md)。

## 后续基础能力升级

1.1.0的单场景配置、输入契约、轻量结果和后续AI开发约定见 [基础能力升级记录](backend-foundation-2026-10-02.md)。本文件保留1.0.0当时PID、测试与备份事实，不要重复运行旧一次性脚本。
