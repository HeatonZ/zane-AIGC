# AI 接管验收与启用

接口交付日期：2026-10-01；正式升级与AI使用体验检查：2026-10-02；AI契约版本：1.1.0。

本机Hermes `comfyui-dev` 已接入，技能1.2.0已安装，职责保持灵活的工作台业务协作者。基础能力代码、隔离验收及正式1.1.0切换均已完成；最终Node/Hermes只读验收和数据保留状态见 [基础能力升级记录](backend-foundation-2026-10-02.md)。[前一轮1.0.0升级记录](backend-upgrade-2026-10-02.md)保留历史，不能重复执行旧一次性脚本。

## 当前已实现

- 41 个 stdio MCP 工具、4 个资源和一个操作提示词。使用官方 SDK，不手写 MCP 协议。
- MCP 是纯 HTTP 适配器，复用权威工作区/运行/素材/选片服务，不直接访问 SQLite 或 JSON 镜像。
- 单场景创建/草稿读取/编辑/校验/发布/恢复/删除，内容revision保护；共享预设分页、修改revision和引用保护。普通单场景配置不读取整工作区。
- 发布场景与最近10版可发现；输入JSON Schema、默认值、必填/缺失要求和最小示例取自发布快照，媒体示例不伪造素材ID。发布前保存publicationId；响应丢失用同versionId对账。
- 最终输出和单步/逐项结果按key/stepId/itemIndex读取，目录/逐项cursor分页、数组值分段，明确valueOmitted与完整性；不夹带输入/提示词/全流程。
- 场景预检允许未声明的额外输入键透传并保存在运行输入中；已声明字段仍校验类型、选项、必填、素材版本/文件和能力配置。额外键不自动成为场景字段或步骤绑定。
- 固定发布快照提交，运行保存 workflow.publishedScene 来源标记；AI 客户端必须预先保存新 runId。
- 最长30秒有界等待；waiting 正常返回待审核信息；断开或超时只释放等待，不取消任务。
- 事件历史支持 limit/hasMore/nextSequence，防止无限历史塞进上下文。
- 本地文件流式上传、固定素材版本、审核/metadata/选片冲突提示。
- 局部重做先预览；resume/rerun/compose 均可保留 AI 指定的新 runId，便于响应丢失对账。
- AI 手册、工具目录、OpenAPI、在线契约与 MCP schema 同源，检查文档漂移。

## 其他环境接入与后续升级步骤（本机已完成）

1. 保留现有数据和正在执行的任务；安排正常升级窗口，不为了接 MCP 强杀后台。
2. 安装锁定依赖并构建：npm ci、npm run build。新建或再次升级环境需要安排正常切换/重启；仅构建不会让正在运行的旧进程自动加载新接口。
3. 用 GET /api/v1/ai 确认正式后台实际返回 contractVersion:1.1.0，worker.ready/accepting:true，projectConfigured:true；核对 projectDirectory 是目标项目。
4. npm run ai:doctor 只读验收真实 stdio、工具/资源/场景/能力目录；不创建任务或调用生成。未发布场景或旧版后台会明确失败。
5. 将 examples/mcp/stdio.json、examples/mcp/codex.toml 或 examples/mcp/hermes.yaml 的启动路径、后台地址调整后合并进所用客户端配置。不要覆盖已有整份配置。
6. 客户端重载后先读 zane://guide，运行 get_workbench/list_scenes/get_scene。不要一接入就调用 submit_scene。
7. 用明确授权的小任务验证一条真实生产链；保留 runId、版本、事件游标和审核记录。外部生成费用、凭据和客户端授权由用户确认。

基础接口交付阶段不自动修改客户端全局配置、不自动重启正式服务、不自动执行付费验收。之后用户指定的 Hermes comfyui-dev profile 已定向接入，见下节；其他客户端/profile 保持不动。不同后台环境和项目不能混用 runId 对账。

## Hermes comfyui-dev 定向接入

用户最终选择 Hermes comfyui-dev profile 控制工作台，而不是 Codex 或 comfyui profile。原 comfyui 的工作台接入已撤回，config/SOUL 恢复为首次安装前内容，保留生产执行职责。comfyui-dev 的 MCP 配置和技能已安装；SOUL 已整体改为灵活的工作台业务协作者，共享代理名录也同步更新，不再保留直接生成引擎的开发测试职责。按实时业务与能力选择操作，不绑定固定场景、工具清单或代理分工。保留 DaVinci MCP 与其他配置，不修改 Hermes 上游。

前一轮1.0.0（历史）：2026-10-02重新同步契约并完成全量232测试与16项Python回归，正式切换到新PID 89348。实际正式Node/Hermes MCP注册、调用、资源/提示词、guide及1.1.1技能读取通过，AI入口为契约1.0.0、worker就绪；升级前后及最终复查数据库逐表哈希和连接配置一致。用户层CLI launcher的路径问题也已修复，chat --help返回0。没有重启Gateway/ComfyUI，没有调用真实模型或生成媒体。备份与回执见 [后台升级记录](backend-upgrade-2026-10-02.md)；职责、重装/撤回、只读doctor、会话重载和CLI验证边界见 [Hermes接入说明](hermes-workbench.md)。

注意：工具注册成功不等于正式可执行。也不能把工作台 runId 当成 ComfyUI prompt_id，或让作为流程节点的控制 profile 再提交工作台导致自调用。当前控制者为 comfyui-dev，现有 comfyui 生产节点不做迁移。

## 自动化验收

- npm run typecheck：API、MCP、SDK 和参数契约类型检查。
- npm test：含发布版本固定、默认值/选项、已声明输入校验与额外输入透传、无副作用预检、审核冲突、等待超时/断开、事件分页、媒体上传/Range、固定合成ID、机器引用与文档一致性、真实stdio工具发现/调用、提交响应丢失/500/超时不重放等回归。
- npm run docs:ai:check：检查发布的手册/OpenAPI/工具目录与源文件一致。
- npm run test:ai:smoke：在临时端口/临时SQLite/临时项目启动编译后的后台和真实MCP进程，走发布场景→预检→提交→审核→完成→局部重做，另走创建→编辑→校验→发布/重复回执→固定输入→执行→轻量结果→恢复/删除与预设闭环→安装doctor。
- npm run check：统一执行原有检查和新增 AI 验收；原有电商/长视频验收仍保留。

隔离 AI 冒烟仅执行本地条件节点；Hermes目录和ComfyUI地址指向无服务夹具，不使用正式数据，不调用模型。

## 基础接口交付阶段验证结果（历史）

- 全量 npm run check 通过：218个测试通过，0失败、0跳过；包含16个新增AI/MCP回归。
- 类型检查、前后端构建、原有server/电商隔离冒烟、文档一致性检查和新增真实stdio隔离冒烟均通过。
- 基础交付时只读检查正式8799后台，GET /api/v1/ai曾返回404，因为旧进程尚未加载新入口；2026-10-02已完成正式升级并通过实际MCP验收，该404不是当前状态。
- 基础接口交付阶段未重启正式后台、未修改客户端全局配置、未调用真实生成服务；之后的 Hermes定向接入记录见上节。

## 当前仍有的边界

- 是本地 stdio MCP，不是多客户端托管 HTTP MCP 服务；在线 OpenAPI 不等于 /mcp transport。
- 这是 AI 操作面契约，不是所有旧设置/连接器 API 的完整开放文档。凭据及底层连接器设置保留现有UI；业务场景配置已支持HTTP/MCP，不要求模拟页面。
- 工作区高级三方合并保留，但普通场景配置使用单场景API/MCP；没有额外AI图形编辑器。草稿不等于发布，发布不等于执行；版本和内容哈希由服务器生成。
- 不做费用精准预估/预算强制拦截；明确说明 submit/resume/rerun/approve/redo 可能计费。
- 不承诺 exactly-once。未落检查点的外部请求仍可能重做；HTTP响应丢失的执行绝不自动重放。
- 预检覆盖发布快照、输入、固定素材与能力配置，不探测外部服务、不保证所有运行时引用和远程媒体可用。
- 当前审核 foreach 是整批，逐镜独立审核及逐项结果编辑未实现。
- 媒体返回地址和元数据，不把大视频嵌入工具结果；AI需使用HTTP媒体地址预览/下载。
- 选片合成是已有本地FFmpeg串接，不是裁切/转场/字幕时间线编辑器。

实际后台升级与选定Hermes客户端接入已完成。开始真实业务前仍需明确生成和审核授权范围，并用一个明确授权的小任务验收；本次没有做付费生成。

基础能力已补齐上述操作面，261项全量测试、16项Python回归和Hermes安装客户端隔离验收通过（41业务工具+4辅助工具）。新功能的AI配套是完成条件，见 [基础能力手册](ai-foundation.md)与 [开发规范](ai-development.md)。实际部署、正式响应体积测量与验收边界见 [基础能力升级记录](backend-foundation-2026-10-02.md)和 [AI友好性审查](ai-usability.md)。

## 契约来源

- 操作目录与 schema：server/ai/operations.ts、server/ai/schemas.ts、server/ai/sceneSchemas.ts；功能覆盖：server/ai/features.ts。
- 手册源：server/ai/guide.ts；OpenAPI生成器：server/ai/openapi.ts。
- 协议适配：server/mcp/server.ts、server/mcp/httpClient.ts；只从HTTP读取业务状态。
- 官方SDK资料：https://github.com/modelcontextprotocol/typescript-sdk（本轮核验并锁定server/client 2.2.0）。
- Codex MCP配置参考：https://developers.openai.com/codex/mcp/（本轮核验stdio的command/args/env、启动/工具超时字段）。
