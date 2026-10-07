# 工作台自动安全升级

这不是生产后端的原地模块热替换，也不是保存任意代码即部署。每次由本机管理脚本提出一个明确升级请求，后台先验收、等待空闲、备份，再进行短暂服务切换。无需用户反复手动关闭终端、构建或启动。开发模式仍使用 Vite / tsx watch；正式生成任务不要运行在自动重启开发服务上。

## 使用

```powershell
# 默认独立后台执行，立刻输出 operationId、supervisorPid；窗口不会弹出
npm run update:prod

# 也可预先保存 UUID；响应丢失只按原 UUID 查询，不重新投递
npm run update:prod -- --id <UUID>

# 最近一次，或精确按原 ID 查询
npm run update:prod:status
npm run update:prod:status -- --id <UUID>

# 只准备、不切换；准备完成后可以按原 ID 显式应用
node --import tsx scripts/update-production.mjs prepare --id <UUID>
node --import tsx scripts/update-production.mjs apply --id <UUID>

# 取消仅在关停前有效；读取当前 revision，写入的是取消意图，状态变为 cancelled 才算确认
node --import tsx scripts/update-production.mjs cancel --id <UUID> --revision <REVISION>

# 升级管理进程意外退出时显式接管；不重放未知停机、不重复启动
node --import tsx scripts/update-production.mjs recover --id <UUID>
```

`npm run start:prod` 现在是同一安全升级入口，不再先停旧服务再构建。默认准备完成后，端口已有本工作台实例时升级；端口空闲且旧租约对应进程确实退出时走离线备份首次启动。离线库存在 queued/running/cancelling/waiting 时拒绝首次启动，不通过停机绕过审核或自动恢复付费任务。

## 固定流程与边界

1. 源码只复制明确的代码/文档/测试目录及构建配置。生产 data、.env 凭据、.git、旧 dist 与 .local 不进入快照；源码在复制期间变化会失败。用户源文件、未提交改动和生产业务数据不被覆盖。
2. `.local/upgrades/<operationId>/snapshot` 执行完整 `npm run check`。只继承必要系统环境，不继承生产 API 地址、凭据、NODE_OPTIONS 或 APP_DATA_DIR；所有模型验收使用已有隔离模拟服务。构建/验收期间旧 dist、后台和生产 SQLite 均不切换。使用当前已安装 node_modules，不自动安装/更新依赖。
3. 验收通过的前后端产物固定哈希，复制到 next；应用前及等待结束时再次核验。源码后续编辑不混入本次版本。正常升级只部署生成产物，不修改源文件。
4. queued/running/preparing/waiting 均阻止切换。后台最多等待24小时；超时保留原 ID 的 waiting，可以再次 apply，旧服务保持运行。不会暂停任务来抢升级窗口，不自动审批、取消、续跑或重新生成。
5. 每次读取当前生产租约、核验实例与实际进程；等待期间实例变化会停止升级。复用现有本机控制管道栅栏业务请求、检查空闲、备份权威 SQLite/配置，确认原实例 closedAt 与端口关闭后才替换 dist/dist-server。停机回执未知只读取原备份回执，绝不换 ID 或盲重放。
6. 新进程启动时传入固定 releaseId 和升级 ID，业务请求保持503隔离，仅健康/就绪检查允许读取。新实例 PID、实例 ID、releaseId 与就绪均匹配后才本机显式 activate 开放。激活回执丢失按同一实例 inspect 确认，不重放业务。
7. 页面轮询已认证的只读 release 接口，发现新版本提示先保存再刷新；不强制刷新，不自动恢复或重放按身份隔离的防丢 outbox。前端只有在自身 releaseId 已知时才比较；普通 Vite 构建优先使用 `VITE_WORKBENCH_RELEASE`，否则沿用 `ZANE_RELEASE_ID`，避免无版本前端把任意服务端版本误判为更新并反复提示。正式发布由升级脚本给前后端注入同一个 releaseId。
8. Hermes Gateway、ComfyUI 不重启；业务场景、发布快照、历史运行与任务 ID 不自动替换。运维回执不是新的业务任务数据库。

## 回退及故障

- 验收失败/取消：不停止旧服务。
- 新进程未启动且旧文件可以恢复：恢复旧代码；旧版本支持启动隔离时自动启动并检查旧版本。最初的旧版本不支持隔离时，需要正常启动一次，不能假装可自动安全回退。
- 候选启动失败：只有确认候选保持业务隔离、空闲，且生产数据库逻辑 schema/数据指纹与原备份一致，才正常关停候选、恢复旧代码并启动旧版本。候选已退出还需确认原 PID 不存在且端口空闲。不强杀 PID。
- 数据库已变化、候选身份不明确、停机/启动/激活回执未知：保持 needs_attention，保留原 ID、备份和产物，不自动恢复数据库、不继续重复启动。旧代码不一定兼容新 schema，不能仅凭启动失败就恢复 SQLite。
- 管理进程崩溃遗留锁：recover 只接管确认退出的同一操作；PID 仍存在或复用时拒绝。切换开始后的恢复只对账，不盲继续目录替换或启动。
- 安全性优先于“任何失败都不停机”；needs_attention 可能需要管理员处理，不能承诺零停机或任意数据库变更都自动回退。
- 首次旧服务没有运行租约/控制管道时，仅需一次在旧终端正常 Ctrl+C 关闭；不要 taskkill、不要重启 Hermes/ComfyUI。之后使用此管理入口。

## 操作回执与 AI 配套

运维记录位于 `APP_DATA_DIR/maintenance/upgrades/<operationId>.json`，含 revision、state、checkPassed、固定 release、原/新实例以及 nextAction。`latest.json` 仅是最近记录指针，`lock.json` 是单一管理进程锁；重复分发相同 ID 被专用 dispatch 标记拒绝。操作日志和验收产物位于 `.local/upgrades/<operationId>`，原生成产物保存在 previous，异常候选保存在 rejected；未自动清理备份或快照。

- 管理员 HTTP/MCP：`GET /api/v1/maintenance/upgrade` / `get_workbench_upgrade`，可按原 operationId 精确读取。匿名401、普通用户403；只读、不执行升级。
- 已认证用户 HTTP/MCP：`GET /api/v1/self/runtime-release` / `get_runtime_release`，只返回当前 release、契约版本、环境及不自动刷新策略，不包含进程、路径或凭据。
- 构建/部署使用本机专用 CLI；不暴露远程任意 HTTP、SQL、文件或命令执行代理。提供本机运维入口是明确安全边界，不把升级伪装成业务能力或模型任务。

## 验收

回归覆盖准备失败不停止旧服务、固定产物哈希、并发锁、原 ID 已确认 busy 重试、等待/取消、旧 revision、停机及激活丢回执、候选隔离、健康失败恢复旧代码、数据库变化禁止回退、权限与只读 API。`test:upgrade:smoke` 使用临时项目/端口/数据库、真实编译后台与 stdio MCP；隔离本地条件任务停在审核，升级等待，显式审核后自动切换，原任务与输出保留，同一 MCP 监督进程无需手动重连。不调用真实模型，不切换正式服务。
