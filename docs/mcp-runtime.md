# 正式启动与 MCP 自动同步

## 日常命令

```powershell
Set-Location F:\code\zane-drama
npm run start:prod
```

命令保留原先的 `prestart:prod → build → start` 顺序，但不再使用 `taskkill /F`：

1. 从当前数据目录读取运行租约，重新查询监听端口与 Node 进程，再通过该实例专属本地 named pipe/socket 核对 instanceId、PID、仓库、入口及端口。保存的 PID 不是结束进程指令。
2. 旧实例暂时拒绝新 HTTP 请求；持久化 SQLite 中的 queued/running/cancelling/waiting，以及 worker 的 active/queued/preparing，任一不空就拒绝升级。SSE 建立前也会排空，已建立的读流不妨碍空闲切换。
3. 排空其他在途 HTTP 请求，用 SQLite backup API 备份权威数据库及 connections/workspace 镜像。回执在 `APP_DATA_DIR/backups/restart-<operationId>/receipt.json`。
4. 正常关闭 HTTP、worker、镜像和数据库。只有原 operationId/instanceId 的 `closedAt` 回执与端口释放同时确认，脚本才继续构建/启动。不强制结束进程；响应丢失先读取原回执，不换 ID 重放。
5. 新后台监听成功、worker 就绪、生命周期入口建立后发布新 MCP 代次。构建失败或后台未就绪不发送“重启成功”。

已经停机但存在旧数据时，启动脚本也会先对只读打开的 SQLite 做备份。数据库备份不包含项目目录的大体积媒体文件；已归档媒体不会移动/删除，媒体仍按原项目备份策略保留。

这是用户显式运维命令，不是 AI 业务工具。不会启动/重启 Hermes Gateway、ComfyUI 或其他 MCP，也不授予任何生成/发布/审批权限。构建失败会保持停机，修复后再执行命令；不会悄悄恢复旧代码或重复业务请求。

## Windows 后台守护

正式后台可以由 Windows 计划任务每分钟运行 `npm run watch:prod`。watchdog 只在 `/api/health` 和 `/api/ready` 不可用、8799 端口已释放且没有进行中的升级时启动 `dist-server/index.js --production`；升级的 `preparing/checking/ready/waiting/stopping/switching/starting` 状态会跳过自动启动。它不强杀进程、不复用旧 PID，也不重启 Hermes Gateway 或 ComfyUI。启动日志写入 `APP_DATA_DIR/watchdog-server.log`，动作日志写入 `APP_DATA_DIR/watchdog.log`。

计划任务应设置为“如果任务已经运行则不启动新实例”，并使用当前用户的交互式凭据。升级仍只通过 `npm run start:prod` 完成；watchdog 不参与版本构建、备份、切换或任务恢复。

## MCP 的重启方式

MCP 启动命令仍是 `node F:/code/zane-drama/dist-server/mcp/index.js`；`npm run mcp`、`npm run mcp:dev` 也保留。

入口是常驻 stdio 转接层，真正的 HTTP 适配器在它自己的子进程中。成功启动正式后台会更新本项目/后台地址的 UUID 代次，常驻层约 500ms 检查一次：

- 已发送的请求先等待返回或既有超时；不会切掉在途写入，也不会重放 tools/call。
- 先启动并核验新适配器，恢复协议握手/目录订阅，再切换；失败保留原连接并在 stderr 报错。
- 只关闭自己持有的旧子进程；不扫描/结束全机 MCP，不以旧 PID 操作进程。
- stdio 客户端连接不变。切换后通知工具、资源、提示词目录变化；支持动态发现的客户端可刷新缓存。不支持者仍要自行刷新目录/重新连接。
- 不读取业务 SQLite、不建立旁路任务库。运行租约、代次和关闭回执只是本地运维元数据，不含业务输入、API token 或模型配置。

默认代次文件在仓库 `.local/mcp-runtime/`，按规范化后台地址区分，localhost 与 127.0.0.1 视为同一地址。远程地址/其他仓库不会被本机后台的默认代次更新影响。自定义位置时，后台和 MCP 都设置同一个绝对 `ZANE_MCP_RELOAD_FILE`，并确保后台地址一致。

## 首次升级与配置变化

**首次部署不能让已运行的旧进程凭空获得常驻转接层。**

1. 旧后台无本地正常切换租约时，`start:prod` 明确停止并提示在原终端 Ctrl+C。先核对真实任务/待审核状态为空，并正常关闭；再次执行命令会先备份现有数据库。
2. 已运行的旧 MCP 要在空闲客户端重载一次，之后相同启动命令会进入常驻外壳。Hermes 对应会话可以使用 `/reload-mcp`，这是会话工具重连，不是 Gateway 重启；该命令也会重连同 profile 的其他 MCP，须避开其在途调用。
3. 以后执行 `start:prod`，无需为这次代码升级手动重连工作台 MCP。
4. 更换 ZANE_API_TOKEN、ZANE_BASE_URL 或客户端启动环境，仍需客户端重载，后台命令不会替用户修改另一进程的身份/配置。

## 错误与对账

机器契约在 `server/ai/mcpRuntimeContract.ts`，由 `server/ai/operations.ts` 导出，生成 OpenAPI 的 `x-mcp-transport` 提供版本、触发条件、无重放声明和传输错误。

- `MCP_RESTARTING`：JSON-RPC `-32603`，data.outcome 是 rejected，本次没有转发。等待切换，读 `get_workbench` 核对契约/身份。写入仍按原稳定 ID/revision 处理。
- `MCP_RESPONSE_UNCONFIRMED`：子进程异常退出导致回执丢失；tools/call 保守为 unknown，发现读取为 read_failed。重建连接不重放业务，用原 runId/publicationId/createId/对象 revision 对账。
- 后台短暂不可达仍由原 HTTP 适配器返回 read_failed/unknown；不把重启等同于业务任务执行成功。

## 隔离回归

```powershell
npm run test:mcp:restart:smoke
npm run check
npm run docs:ai:check
```

真实编译后台与真实 stdio MCP，临时端口/项目/数据库；本地 condition 流程验证待审核拒绝升级、空闲备份/正常退出、同一 MCP 客户端在后台重启后继续调用、目录通知和原 runId 对账。另有适配器换版、在途写入排空、丢响应不重放、损坏/跨地址代次和契约不一致回归。没有真实模型、Gateway 重启、ComfyUI 调用或生产审批。
