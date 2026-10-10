# 工作台开发约定

## 工作区与运行边界

- 保留用户未提交的代码、数据和其他任务的改动；不要 reset/clean 或整份覆盖工作区。
- 所有业务状态通过现有权威服务与 SQLite 访问；场景、流程、发布版本、预设和任务草稿只维护服务端一套，浏览器不读写本地业务场景库、不补默认场景、不从旧 localStorage 初始化服务端。服务端未初始化时只允许显式建立空工作区，场景通过权威服务创建或显式导入。JSON 是服务端导出镜像；浏览器仅可保留未确认写入的防丢 outbox，重载后仍显示服务端快照，不自动恢复、重放或覆盖。不要为 AI 再建旁路任务数据库。
- 一个系统维护一套场景，不引入个人/共享工作区。普通用户入口使用实时场景授权和固定发布快照；本人草稿、任务和素材归属取服务端验证身份，不接受客户端伪造 owner/userId。管理 API、旧入口、媒体 HEAD/Range 和异步落库/入队都遵循同一权限；未归属历史保持管理员专用。浏览器防丢 outbox 按身份隔离。
- 测试使用临时端口、临时项目和临时数据。未经明确业务授权不要调用真实模型、生成媒体或审批生产运行。
- 正式升级必须先核验进程身份、空闲任务和数据备份，再正常切换工作台；不连带重启 Hermes Gateway 或 ComfyUI。一次性升级脚本不能重复使用旧 PID。
- Hermes 上游及 evolution foundation 保持只读；使用受支持的用户配置、技能和独立脚本。

## 基础优先，专用由自定义代码替代

- 不按场景名称新增执行器或专用步骤；场景差异用 Profile、提示词、输入输出、ComfyUI 工作流/节点绑定表达，场景特有的数据编排用 core.code 自定义代码在隔离沙箱内完成。
- 能力目录统一，不再分基础/专用等级；步骤只声明 `usage.whenToUse`，退役的执行方式标记 `usage.compatibilityOnly`：仍注册可执行，只兼容已有发布快照与历史运行，不作为新步骤推荐。
- 遍历、分支、审核、恢复与本地媒体合成复用通用机制；基础步骤加自定义代码能完整满足需求时，不增加任何场景专用能力包。
- 已发布的旧流程与历史运行不自动替换；迁移必须在草稿中核对行为、以 revision 保护编辑，校验后显式发布。

## 新功能必须同步提供 AI 配套

这不是后续可选优化，而是业务功能的完成条件。新增或修改业务能力时，必须同步完成：

1. **权威业务服务**：UI、HTTP 和 MCP 复用同一服务、校验与状态机，不复制执行逻辑。
2. **HTTP/MCP 操作面**：业务不能只存在于 UI；给 AI 提供目的明确的原子操作，不暴露任意 HTTP/SQL/文件执行代理。AI 已能通过现有工具完整处理的扩展可以复用工具，但必须更新相关字段与说明。
3. **机器契约**：在 `server/ai/operations.ts`、配套 schema 和响应契约中定义参数、类型、必填、默认值、版本、返回数据、错误及副作用。发布场景输入契约只取固定发布快照。
4. **发现与文档**：登记 `server/ai/features.ts` 的功能矩阵；更新 `server/ai/guide.ts`；运行 `npm run docs:ai`，提交生成文档，不直接修改生成文件。
5. **AI 可操作性**：按对象/步骤读取，列表分页；大值明确省略或分段，不静默截断。读操作不生成，配置不等于发布，发布不等于执行；返回稳定 ID、revision 和下一步。
6. **稳定性**：所有共享写入使用 revision/冲突保护；执行/发布前保存 ID；响应丢失先对账，不自动换 ID、重放或覆盖。审核/恢复必须遵循真实状态，不绕过工作流。
7. **回归与验收**：覆盖正常路径、无效参数、并发/旧 revision、响应丢失和相关分页边界；至少一条真实 stdio MCP 隔离闭环。涉及已有工具扩展也要测试新字段通过 MCP 到业务服务。
8. **交付**：`npm run check` 与文档漂移检查通过后才能宣称完成；需要额外客户端/运维步骤的限制必须明确说明。未完成的 AI 配套不能藏在“后续优化”中。

具体检查表见 `docs/ai-development.md`；当前基础能力和操作说明由 `docs/ai-foundation.md`、`docs/ai-operator.md` 提供。

## 本机工作台 AI 接入定位

- 本机用户环境变量已提供 `ZANE_ADMIN_TOKEN`（≥32 字符运维管理凭证，无默认值、不进网页）。它同时可用于两条入口：HTTP API 作 `Authorization: Bearer <token>`，MCP 入口作 `ZANE_API_TOKEN`；服务端都识别为 `@operator`（运维管理员，admin）。2026-10-10 实测通过：`GET /api/v1/self/account` 返回 `@operator`/admin，stdio MCP `get_current_user` 返回同一身份且 92 个工具可用。不要说“本机没有凭证、访问不了 MCP 和 API”；只有实测失败时才报告存在性、地址与错误类别（401 鉴权未通过、403 权限不足、服务未启动）。
- 只读核验先做后写：`GET /api/health` 确认 `http://127.0.0.1:8799` 在跑；再用同一凭证调 `/api/v1/self/account`，或经 MCP 调 `get_workbench` / `get_current_user`，核对 contractVersion、`worker.ready/accepting`、`projectConfigured` 与身份角色，然后才操作服务端场景。核验只输出存在性、长度/前缀、是否启用、地址、身份与错误类别；不输出密钥全量，不写入仓库、日志、回复、AGENTS.md 或示例文件，不绕过身份验证，不读取生产 SQLite 找凭证。
- MCP 入口为 `F:\code\zane-drama\dist-server\mcp\index.js`，只读取启动环境、不自动加载项目 `.env*`；Codex 的 `.env` 配置表只传给它启动的 MCP 子进程，不会自动传给终端命令。要起 MCP 必须显式把同一 token 传进启动环境（PowerShell：`$env:ZANE_API_TOKEN = $env:ZANE_ADMIN_TOKEN`；`ZANE_BASE_URL` 默认 `http://127.0.0.1:8799`）。`npm run ai:doctor` 同样只读启动环境；独立执行需显式传入同一配置的环境，禁止输出密钥或使用任意文件执行代理。只读核验不重启工作台、Hermes Gateway 或 ComfyUI。
- 本机 Codex 工作台连接固定配置在 `C:\Users\Windows11\.codex\config.toml` 的 `[mcp_servers.zane-workbench]` 与 `[mcp_servers.zane-workbench.env]`；2026-10-10 已按 `examples/mcp/codex.toml` 注册（`command=node`、`args=dist-server/mcp/index.js`、env 表注入 `ZANE_BASE_URL`/`ZANE_API_TOKEN`/`ZANE_MCP_TIMEOUT_MS`，密钥取本机 `ZANE_ADMIN_TOKEN`、只写进该配置，不进仓库），改动前的备份为 `config.toml.bak-20261010`。注册或改过配置后需客户端重新加载 MCP 连接才生效；先检查已连接的工作台 MCP，未加载时不要反复要求用户在聊天里提供密钥——直接用环境变量里的 `ZANE_ADMIN_TOKEN` 按上面两条访问 HTTP/MCP。此路径是本机约定，不是所有开发机器的通用路径。
- 普通用户与其他机器的工作台凭证仍由管理后台“用户管理 → 本人 AI 凭证”创建后作为 `ZANE_API_TOKEN` 使用；它与本机运维 `ZANE_ADMIN_TOKEN` 是两条并行入口，不互相否定，也不把模型供应商 Key 当作工作台凭证。
