# 基建改造：本地持久化运行链路

## 本轮已落地

采用渐进式模块化单体，不引入 Redis、消息中间件或分布式 Worker：

- 配置、领域类型/引用解析、执行循环、运行归档、存储、服务、HTTP 路由分层。执行循环不依赖 Request/Response。
- 使用 Node 原生 `node:sqlite`，项目支持 Node **24 及以上**。新增依赖为零。
- SQLite 存放共享工作区的带 revision 快照，以及运行索引、步骤 checkpoint、排队提交参数和有序事件。工作区目前仍是事务内 JSON 快照，不是完整的实体级关系模型。
- 后台 Worker 控制运行并发；ComfyUI 队列按上游 URL 隔离，默认串行，步骤 `for_each` 可通过 `execution.maxConcurrency` 提高同一地址的并行上限。
- 异步提交、SSE 进度、断线事件回放、游标分页、明确取消/续跑。
- JSON 归档和配置写入使用临时文件 + fsync + 原子替换，并按路径排队；Windows 短暂文件占用会有限重试。
- 浏览器待保存配置保留在 outbox 中；失败后暂停依赖它的后续保存，可显式重试，不再跳过失败的基线。
- 本地媒体与 ComfyUI 媒体代理采用流式响应，并支持 Range/HEAD；播放中断释放媒体上游连接，不取消工作流任务。
- 请求 ID、结构化运行/HTTP 日志、存活与就绪探针、自动测试发现和 CI 检查。

## 数据目录与迁移

```text
APP_DATA_DIR/
  zane.db                    # SQLite 权威元数据
  zane.db-wal / zane.db-shm   # 数据库打开期间可能存在
  connections.json           # 连接配置，原子写入
  workspace.json             # 工作区 JSON 导出镜像

ZANE_PROJECT_DIR/.zane/runs/<runId>/
  inputs/input.json
  inputs/files/
  workflow.json
  runtime.json
  outputs/result.json
  outputs/media/
```

首次读取共享工作区时，如果数据库没有工作区，会迁移已有的 `workspace.json`。没有旧文件则维持原先的**显式初始化**流程，不自动写入浏览器默认内容。损坏的旧工作区文件会阻止迁移，不覆盖旧文件。

首次访问某项目的运行列表时，按有限并发索引旧 `.zane/runs` 记录，后续列表直接查索引。单条损坏记录会跳过并记录警告；修复后可以通过详情接口再次尝试导入。详情也支持按需读取尚未索引的旧记录。

迁移后 SQLite 是权威来源。不要只改 `workspace.json` 期待数据库同步变化；它是兼容导出镜像。镜像写入失败会产生警告，但不回滚已经提交的数据库事务。场景 JSON 导入/导出、已发布版本、旧归档目录保持兼容。

## 运行生命周期与恢复

```text
queued -> running -> completed / failed / cancelled
              \-> cancelling -> cancelled
              \-> stale（重启或关闭时执行被中断，等待显式续跑）
```

- `POST /api/v1/runs` 在验证、输入归档、排队事务提交后返回 `202`。
- 浏览器断开、刷新、关闭结果等待连接，不取消已经接受的任务。
- 排队任务在服务重启后自动恢复。已经开始的任务不会自动再次调用生成接口，会变为 `stale`。
- 重启前已请求取消的任务会按取消意图结束。
- 续跑创建新的运行记录，复用已完成/已跳过的普通步骤和已完成的逐项结果；失败、取消或中断的逐项会重试，之后尚未执行的逐项继续运行。
- 外部服务可能已经完成一个尚未 checkpoint 的生成；显式续跑仍可能重复正在执行的步骤或逐项。这里不承诺跨外部系统 exactly-once。
- 关闭时停止接受新运行，等待活动任务；达到等待期限后发出中断，最多再等待 5 秒。剩余任务标记 `stale`，未开始的队列保留。然后等待归档镜像写完并关闭数据库。

一个 `APP_DATA_DIR` 只能由**一个 API 进程**管理。当前没有跨进程任务租约或多机调度；不要启动两份服务共用该目录。开发与正式环境的数据目录仍应分开。

## API

| 操作 | 接口 |
| --- | --- |
| 提交 | `POST /api/v1/runs`，请求为 `{ workflow, inputValues, runId?, runTitle?, resumeFromRunId? }` |
| 列表 | `GET /api/v1/runs?limit=50&cursor=...&status=...&sceneId=...` |
| 详情 | `GET /api/v1/runs/:runId` |
| 取消 | `POST /api/v1/runs/:runId/cancel` |
| 续跑 | `POST /api/v1/runs/:runId/resume` |
| SSE | `GET /api/v1/runs/:runId/events` |
| 历史事件 | `GET /api/v1/runs/:runId/events/history?after=序号` |
| 媒体 | `GET /api/v1/runs/:runId/media/:filename` |
| 存活/就绪 | `GET /api/health` / `GET /api/ready` |

列表按创建时间 + runId 降序，分页上限 200，通过返回的 `nextCursor` 获取下一页。SSE 首次连接发送当前快照；断线重连的 `Last-Event-ID`（或 `after`）用于回放后续持久化事件，再发送当前快照。历史事件每页最多 1000，使用返回的 `nextSequence` 继续读取。慢客户端会被关闭，以重连回放代替无限缓冲。

旧 `/api/workflows/run` 同步等待接口，以及旧列表/详情/取消/媒体路径保留；旧列表也支持游标分页。旧同步接口断开只结束等待，不取消任务。

前端优先访问 `/api/v1/runs`。如果连接到尚未重启的旧版服务，发现 v1 路由返回非 JSON 的 404，会自动回退到 `/api/workflows/runs` 兼容路径；有明确 JSON 错误的 404 仍按“记录不存在”处理，不会重复提交运行。发布新构建后仍应重启 8799 服务，使前后端版本保持一致。

共享工作区按实体进行三方合并：不同实体的编辑保留，同一实体的冲突返回 `409 WORKSPACE_CONFLICT`。浏览器 outbox 的冲突不会被静默覆盖；需要比较修改后解决。outbox 依赖浏览器存储可用，并非完整的离线协同系统。

## 配置、发布与备份

新增配置：

```dotenv
ZANE_MAX_ACTIVE_RUNS=2
ZANE_SHUTDOWN_TIMEOUT_MS=15000
```

`ZANE_MAX_ACTIVE_RUNS` 为整个流程的并发上限（1–32），不是 GPU 并发数。ComfyUI 同地址仍串行。`ZANE_SHUTDOWN_TIMEOUT_MS` 是优雅关闭的等待时间，单位毫秒。

发布前执行 `npm run check`。停止服务，备份现有数据目录，再更新代码/构建并使用同一个数据目录重新启动。第一次升级前建议额外保留旧 `workspace.json` 与整个项目归档目录，便于回退。

**简单可靠的备份方式：停止服务后复制整个 `APP_DATA_DIR`，再复制项目的 `.zane` 目录。** 数据库不包含媒体文件；只备份数据库不能恢复媒体。复制目录时保留可能残留的 WAL/SHM 文件，不要在数据库仍打开时只复制 `zane.db`，否则可能缺少已提交数据。在线备份需要 SQLite 的一致性备份机制，本轮未提供在线备份命令。

恢复时先停止服务，再将备份恢复到另一个明确的数据目录，配置 `APP_DATA_DIR` 指向它，并恢复对应项目归档路径。旧运行中的任务会走上述重启恢复规则。回退旧应用版本时应使用升级前的备份，不要直接让旧版读已迁移的目录。

## 验证和后续阶段

`npm test` 自动发现 `server` 和 `src` 下的 `*.test.ts`。基建测试使用临时 SQLite/归档目录、模拟执行器和本地 HTTP 上游，不调用真实生成服务。`npm run check` 执行类型检查、测试、前后端构建和隔离的构建产物冒烟测试。

本轮不是整个路线图的终点。后续仍需独立推进：

1. 统一 AssetStore、内容哈希去重、输出归档下载流式化和资产生命周期。
2. 工作流编译器：执行前的跨步骤引用/类型检查、依赖计划、确定性快照。
3. 进一步抽离 Hermes/ComfyUI 连接器、模型调用与工作流格式转换。
4. 实体级工作区存储与更细粒度协同冲突处理、outbox 冲突解决交互。
5. 在线备份、事件保留/压缩与历史数据维护；在确有多机需求时再加入任务租约。

安全改造不在本轮范围内。
