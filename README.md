# Zane Studio

个人使用的 AIGC 工作流工作台。当前内置漫剧制作和商品展示两个定制场景。

## 开发环境

需要 Node 24 或以上版本（运行存储使用原生 `node:sqlite`）。

开发环境由 Vite 前端和本地 API 两个进程组成：

```powershell
npm install
npm run dev
```

Vite 默认使用 `5174`，开发 API 默认使用 `8798`，前端会把 `/api` 代理到 `127.0.0.1:8798`。正式环境默认使用 `8799`，两套服务的端口和数据目录都分开。开发 API 的数据默认写入项目下的 `.local/`，正式环境默认写入 `data/production/`。需要调整开发端口或代理地址时，复制 `.env.example` 为 `.env.development` 后修改。

## 正式环境

正式环境不启动 Vite。构建后的前端文件和 API 由同一个 Node 进程提供：

1. 安装依赖并创建正式环境配置：

   ```powershell
   npm ci
   Copy-Item .env.example .env.production
   notepad .env.production
   ```

2. 至少修改 `.env.production` 中的数据目录和外部服务地址。建议使用项目目录之外的绝对路径：

   ```dotenv
   NODE_ENV=production
   API_HOST=127.0.0.1
   API_PORT=8799
   APP_DATA_DIR=F:/zane-studio-data/production
   HERMES_HOME=C:/Users/Windows11/.hermes
   HERMES_API_BASE_URL=
   HERMES_API_KEY=
   FFMPEG_BIN=ffmpeg.exe
   FFPROBE_BIN=ffprobe.exe
   COMFYUI_BASE_URL=http://127.0.0.1:8188
   ```

   如果需要让局域网或反向代理访问 API，把 `API_HOST` 改为 `0.0.0.0`；只在本机访问时保留 `127.0.0.1`。

3. 构建并启动正式环境：

   ```powershell
   npm run build
   npm run start
   ```

   推荐用 `npm run update:prod`（`start:prod` 为同一入口）提交独立后台安全升级：先在隔离快照构建并完整验收，再自动等待空闲、备份 SQLite/配置、正常切换与健康检查。请求会输出固定 operationId，可用 `npm run update:prod:status` 对账；忙碌/待审核只等待，不自动审批或续跑。详细流程与回退边界见 `docs/production-updates.md`。新后台就绪后，已接入常驻外壳的本项目 MCP 自动替换适配子进程并刷新目录，不重启 Hermes Gateway 或 ComfyUI。首次旧后台需先正常 Ctrl+C、旧 MCP 需在空闲客户端重载一次；更换凭证仍需客户端重载。完整行为与限制见 `docs/mcp-runtime.md`。启动后打开 `http://127.0.0.1:8799`（如果修改了端口则使用对应端口）。`npm run start` 会提供 `dist/` 下的前端文件和 `/api` 接口，不需要再启动 `npm run dev` 或 `vite preview`。

正式环境的连接设置保存在 `APP_DATA_DIR/connections.json`，工作区、运行索引和事件以同一目录的 `zane.db` 为权威存储，`workspace.json` 保留为兼容导出镜像。开发环境默认使用 `.local/`。发布新版本时执行 `npm run update:prod`，按上述先验收、等待空闲、备份、正常切换和 MCP 同步流程后台完成；前端只提示保存后刷新，不强制刷新。

## Hermes API Server

Hermes 步骤通过 Hermes API Server 的 OpenAI 兼容接口执行。请在 Hermes Home 的 `.env` 中启用 API Server 并设置 `API_SERVER_KEY`，然后重启 Gateway：

```dotenv
API_SERVER_ENABLED=true
API_SERVER_KEY=替换为本机专用密钥
API_SERVER_PORT=8642
```

多 Profile Gateway 还需要在每个被调用 Profile 的 `profiles/<profile>/.env` 中设置该 Profile 自己的 `API_SERVER_KEY`。应用会自动读取密钥和端口；`HERMES_API_BASE_URL` 可覆盖自动推导的本机地址。只有在远程 API Server 或所有 Profile 共用同一个密钥时，才在应用 `.env` 中设置 `HERMES_API_KEY`。

Hermes 请求遇到 socket 重置、Gateway 重载或 `502/503/504` 时会自动重试，不会第一次失败就结束。默认在首次请求之外重试 6 次，并使用 250ms 起、最多 4s 的指数退避；可通过 `HERMES_RETRY_ATTEMPTS`、`HERMES_RETRY_INITIAL_DELAY_MS` 和 `HERMES_RETRY_MAX_DELAY_MS` 调整。长时间 Agent 任务使用 Hermes `/v1/runs` 异步接口和幂等键，重试不会重复启动同一个任务。

图片以 `data:image/...` 多模态内容发送。Hermes API 不接收视频，视频输入会由 `ffprobe` 读取时长，再用 `ffmpeg` 抽取最多 6 张代表帧；可通过 `FFMPEG_BIN` 和 `FFPROBE_BIN` 指定可执行文件路径。

## 项目目录与运行归档

首次运行前，在“集成连接”页设置本机项目根目录。运行输入、工作流快照、步骤状态和输出会保存在该目录的 `.zane/runs/<运行 ID>/` 下：

```text
.zane/runs/<运行 ID>/
  inputs/input.json       # 本次场景输入
  inputs/files/           # 可访问的本地图片或视频副本
  workflow.json           # 本次执行的工作流快照
  runtime.json            # 运行时间与逐步执行状态
  outputs/result.json     # 最终输出数据
  outputs/media/          # ComfyUI 生成媒体副本
```

也可以通过 `ZANE_PROJECT_DIR` 设置默认项目目录。应用内“运行记录”页可查看输入、状态和结果，并复制单次运行目录路径。运行元数据与事件存入 SQLite，输入/输出文件继续归档到项目目录，不依赖浏览器草稿存储。

应用内“集成连接”页的“单步运行超时”控制每个 ComfyUI 或 Hermes 步骤的最长执行时间，默认 10 分钟，可设置为 1–1440 分钟。也可以通过 `ZANE_WORKFLOW_TIMEOUT_MINUTES` 设置默认值；连接页保存的值优先。

## 更新正式环境而不覆盖配置

场景、流程、选项预设、任务草稿和场景发布版本只由 8799 服务端保存在 `APP_DATA_DIR/zane.db`（`workspace.json` 为服务端导出镜像）。手机、电脑和 AI 访问同一个服务时使用同一套场景。浏览器不读写本地业务场景库；服务端未初始化时，只允许明确建立空工作区，再通过权威服务创建或显式导入场景，不会读取旧 localStorage 或自动补入内置场景。服务端不可用时显示连接错误，不回退到本地场景。

发布更新时按下面的顺序操作：

1. 保留 `.env.production` 和 `APP_DATA_DIR`，不要把它们替换成开发环境配置。
2. 重新核验正式服务的进程身份和数据目录，确认没有 queued/running/waiting/preparing 等未处理任务；备份现有数据库（含 WAL/SHM）、连接配置与项目归档，再通过原服务管理方式正常停止。不要重复使用旧 PID，不连带重启 Hermes Gateway 或 ComfyUI。
3. 更新代码并执行 `npm run build`。
4. 重新执行 `npm run start`，仍然使用原来的正式地址和端口。

不要在服务端工作区已初始化后用另一台设备的旧 localStorage 覆盖配置；服务端 SQLite 是统一来源。更换 `APP_DATA_DIR` 会切换到另一份本机工作区，应停服后迁移整个数据目录及项目归档；单个场景仍可以使用工作台提供的 JSON 导入导出。

工作台的场景卡片支持导出和导入场景。导出的 JSON 包含场景展示信息、对应流程配置，以及该流程引用的选项预设；导入时会创建一个新的场景并自动处理选项预设 ID 冲突。

场景和流程编辑会自动保存为暂存内容，创作页与运行流程始终使用最近一次发布的版本。完成编辑后，在“流程配置”页发布即可让暂存内容生效；“版本管理”可将历史发布版本一键应用到暂存内容，之后仍需再次发布才会生效。版本标识是场景内容快照 MD5 的前 8 位；每个场景最多保留最近 10 个发布版本。场景导出包含当前暂存内容；导入后作为未发布的新场景，需要检查并发布后才能使用。

`.env.example` 列出了常用配置项。`API_HOST`、`API_PORT`、`APP_DATA_DIR`、`DIST_DIR`、`HERMES_HOME`、`HERMES_API_BASE_URL`、`HERMES_API_KEY`、`HERMES_RETRY_ATTEMPTS`、`HERMES_RETRY_INITIAL_DELAY_MS`、`HERMES_RETRY_MAX_DELAY_MS`、`FFMPEG_BIN`、`FFPROBE_BIN`、`COMFYUI_BASE_URL`、`ZANE_PROJECT_DIR`、`ZANE_WORKFLOW_TIMEOUT_MINUTES` 用于 API；`VITE_API_PROXY_TARGET` 只用于开发环境代理。

## 当前能力

- `流程配置` 使用表单编辑场景输入、按顺序执行的步骤、每步输入/输出和场景最终输出，不提供图形画布。
- 工作台支持将单个场景导出为 JSON，也可以从 JSON 导入场景和对应流程配置。
- 步骤输入和 ComfyUI 输入绑定可引用场景字段、前序步骤输出，也可以配置带类型的固定值；最终输出可引用场景字段或任意步骤输出。Hermes 提示词可插入这些引用。
- 场景输入表单随流程定义生成；流程与草稿由共享工作区保存，浏览器仅保留未确认写入的防丢 outbox，重载仍显示服务端场景、不自动应用或恢复旧编辑；运行元数据存入 SQLite，文件归档到项目目录。
- 集成页可启用多个 Hermes Profile，并通过 API Server 的 `/v1/models` 检查认证和连通性；ComfyUI 使用 `/system_stats` 检查。
- 后台 Worker 默认允许 2 个流程并发，可通过 `ZANE_MAX_ACTIVE_RUNS` 调整；步骤启用 `for_each` 后可配置 `execution.maxConcurrency`（1–32），ComfyUI 同一上游地址按已请求的最大并行数限流，不同地址互不阻塞。
- 运行中的流程可以点击“取消运行”。服务端会中止 Hermes API 请求，ComfyUI 会调用 `/interrupt`；关闭页面不会取消后台任务。“继续编辑”会恢复草稿输入和上次运行结果。
- 失败记录可以在“运行记录”页点击“从失败步骤继续”；取消记录或服务重启后标记为“待恢复”的记录可以点击“从断点继续”。操作会按原记录的工作流快照创建新运行，复用已完成或已跳过步骤及已完成的逐项结果，只重试未完成的逐项并继续后续步骤；原记录和输入文件会保留。服务中断时正在执行的步骤或逐项可能被外部服务实际完成但尚未保存，续跑时可能重复执行。
- Hermes Profile 从 `HERMES_HOME` 下的 `config.yaml` 和 `profiles/*/config.yaml` 发现。Hermes 连接状态按 Profile 检查 API Server 和 API 密钥。
- ComfyUI 工作流支持直接选择画布（UI）格式；后台在读取和运行时会实时转换为 `/prompt` 所需的 API 图，不需要用户手动导出 API JSON。
- 连接设置写入 `.local/connections.json`，该目录已加入 `.gitignore`。

目前流程定义和输入/输出引用已可编辑、保存；任务执行引擎会按步骤调用 Hermes API Server 和 ComfyUI。集成页显示的 Hermes 状态表示所选 Profile 的 API Server 可用；ComfyUI 画布工作流会在后台转换后提交。

## 能力包与结果修订

- **新增能力不用再改核心设计器与执行分发**：在 `server/capabilities/packages/` 增加能力包，声明输入、输出、配置、执行器和通用结果展示方式。内置“文本模板”可直接验证，不调用模型。
- **中间结果可修改，步骤或单镜可重做**：“运行记录” → “修改结果 / 局部重做” → 预览影响范围 → 创建新版本；只失效相关依赖，保留未变化结果和原版本，并支持对比。
- 新包或新构建需要重启服务才生效；未重启的旧后端不会把局部重做降级成整条流程重跑。开发契约、API、依赖与逐项重算边界见 `docs/capabilities-and-reruns.md`。

## 代码入口

- `src/data/scenes.ts`：场景清单与导航展示信息。
- `src/features/Studio.tsx`：根据场景流程定义动态生成输入表单并保存草稿。
- `src/features/FlowDesigner.tsx`：表单式场景流程定义。
- `src/features/Dashboard.tsx`：工作台场景入口、最近草稿和服务状态。
- `server/index.ts`：启动与连接器组装；`server/services`、`server/execution`、`server/storage`、`server/api` 分别负责业务、执行、持久化和路由。

## 基建、迁移与检查

异步运行、SQLite 迁移、SSE、取消/重启语义、配置参数与 WAL 备份注意事项见 `docs/infrastructure.md`。一个数据目录只支持一个 API 进程。

```powershell
npm run check       # 类型检查、自动发现测试、构建和隔离冒烟验证
```

运行测试不会调用真实 Hermes/ComfyUI 生成服务。后续资产去重、工作流编译与进一步连接器拆分尚未包含在本轮改造中。

## 电商套图（独立场景）

新增多平台电商套图场景，复用现有工作台，支持AI场景重绘、原图保真排版、准确文案后置、多平台尺寸覆盖及ZIP导出。使用与安装说明见 `docs/commerce-pack.md`。已有共享工作区运行 `npm run scene:install:commerce` 只追加并发布新场景，不替换原有场景。

## 视频场景双采工作流

AI文生视频、AI参考生视频、文生无设计版使用 `Zane/video_双采.json`；长文使用 `Zane/video_双采_json.json` 的201号整镜JSON入口，保留原生24fps/音色/有声拼接。发布版本、安全迁移、AI入口和验收见 [双采迁移说明](docs/video-dual-sampling.md)。

## 长文出视频（原生有声片段）

提供长文/剧情、人物/场景/道具资产与参考音色，Writer直接生成制作级分镜，H3原生生成对白和视频片段，本机FFmpeg顺序合成。无独立配音、关键帧或模型质检节点，每个片段提示词禁止音乐。

构建并重启服务后执行 `npm run scene:install:long-video` 安装并发布独立场景（保留已有场景与草稿）。配置与执行协议见 [长文出视频说明](docs/long-text-video.md)，模拟完整链路验证执行 `npm run test:long-video:smoke`（不调用真实生成模型）。

### 创作生产能力

素材库已接入实际媒体归档与固定版本引用；流程步骤可设置人工确认关卡；逐镜视频支持跨修订选版并仅用本地 FFmpeg 合成。使用入口、API 和边界见 [生产工作台说明](docs/production-workbench.md)。

## AI 接管与 MCP

工作台提供可发现的 AI 操作面与独立 stdio MCP。AI 可以创建、配置、校验、发布和恢复业务场景，使用固定发布版本完成预检、提交、有限等待、审核、局部重做、素材版本管理、选片与本地合成，并按输出/步骤/逐项读取结果，不需要模拟点击页面。

- [AI 基础能力](docs/ai-foundation.md)：当前业务操作面、身份边界与最小闭环。
- [AI 开发规范](docs/ai-development.md)：以后业务功能必须同步提供AI配套，根AGENTS.md与PR检查表共同约束。
- [AI 操作手册](docs/ai-operator.md)：完整操作顺序、请求/响应示例、状态机与提交结果未知时的恢复规则。
- [AI 工具目录](docs/ai-tools.md)：当前工具与参数 schema 同源，含管理员和当前用户操作。
- [OpenAPI 3.1 契约](docs/ai-openapi.json)：机器可读的 AI 操作面、媒体与高级 HTTP 提交入口。
- [接管验收与启用](docs/ai-handover.md)：上线前检查、部署边界与当前限制。
- [Hermes comfyui-dev 接入](docs/hermes-workbench.md)：profile 配置、操作技能、角色隔离、安装与真实 Hermes 只读验收。
- 客户端配置示例：[通用 stdio JSON](examples/mcp/stdio.json)、[Codex TOML](examples/mcp/codex.toml)、[Hermes YAML](examples/mcp/hermes.yaml)。

~~~powershell
npm ci
npm run build:server
# 前提：兼容后台已启动；此检查只读，不触发生成。
$env:ZANE_BASE_URL = "http://127.0.0.1:8799"
$env:ZANE_API_TOKEN = "<从本人账户创建并妥善保管的API凭证>"
npm run ai:doctor
~~~

HTTP 发现入口为 GET /api/v1/ai，在线契约为 GET /api/v1/ai/openapi.json，在线手册为 GET /api/v1/ai/guide。
MCP 客户端直接运行 node dist-server/mcp/index.js；它只访问 ZANE_BASE_URL，不启动或重启后台。开发环境改用8798，避免误连正式环境。

新增发布场景查询 /api/v1/scenes、场景预检 /api/v1/scenes/:sceneId/prepare 与固定版本提交 /api/v1/scenes/:sceneId/runs。
AI 提交必须先保存 UUID runId 与 versionId；响应丢失只查询原 ID，不自动重新POST或换 ID。wait_run 最长30秒，停止等待不取消运行。

文档同步：npm run docs:ai；漂移检查：npm run docs:ai:check。隔离协议/编译产物验收：npm run test:ai:smoke（需要先构建后台）。以上已接入 npm run check。
2026-10-02：基础能力契约扩展到1.1.0、41个业务工具；新增场景草稿/发布闭环、共享选项、输入schema/示例和轻量结果。261项全量测试及16项Python接入回归通过，真实Node stdio和Hermes隔离验收通过，comfyui-dev操作技能升级到1.2.0。正式8799已上线并通过Node/Hermes只读验收，数据保留状态见 [基础能力升级记录](docs/backend-foundation-2026-10-02.md)；前一轮1.0.0记录保留于 [后台升级记录](docs/backend-upgrade-2026-10-02.md)。未调用真实生成，旧Hermes会话需要时在空闲状态重载MCP并新建会话。

## 管理员后台与用户使用页（契约1.4.0）

系统只有一套服务端场景，不再提供个人/共享工作区切换。现有功能成为管理员后台 /admin；普通用户进入 /app，只能使用管理员授予的已发布场景。新用户初始无场景权限。授权不复制场景、不发布、不执行。

- 首次启用：升级后在服务器本机打开根入口，显式初始化首个管理员。无默认账号或密码；初始化不修改现有场景和历史数据。
- 管理员：用户管理支持创建、启停、角色/显示名、密码重置和场景授权，所有更新带 revision。不能停用/降级最后一个有效管理员。
- 用户：固定发布版业务表单、本人服务端草稿、本人任务/步骤/逐项结果、业务审核、取消和原快照续跑；不能自定义流程或更改全局连接。
- 系统反馈（契约1.5.8）：普通用户移除直接向 Agent 提交退回意见的入口，HTTP/MCP 同样拒绝 feedback 字段；保留确认和无意见退回。用户在“系统反馈”提交问题/建议并查看本人处理进度，管理员在后台“系统反馈”读取完整内容、回复及更新待处理/处理中/已解决/不采纳状态。已结束反馈须显式重新处理。反馈使用现有 SQLite 权威服务，不自动注入 Agent、evolution 或工作流，也不触发生成；提交先保存 feedbackId，处理带 revision，未知回执读取原ID对账，不自动重放。
- 媒体：本人上传时先保存 assetId，使用 assetId + assetVersion 固定引用；不接受服务器本地路径。媒体与HEAD/Range也检查归属。
- 历史：旧场景/任务/素材原地保留；没有可靠归属的历史资源仅管理员可见，不自动发给新用户。旧浏览器无归属 outbox 保留，管理页可下载备份但不会自动恢复。
- AI：本人“账户与AI接入”创建 token（明文仅显示一次，90天有效），stdio/HTTP配置 ZANE_API_TOKEN。comfyui-dev 若需管理业务，使用管理员本人的 token；profile 名称不能提权。示例配置不包含真实凭证，不提交密钥到仓库。旧后台1.3.0与新MCP1.4.0不兼容，先安排工作台正式升级再启用。

本次代码不等于正式服务已切换，正式账户和 Hermes token 仍需在正常升级后显式配置。完整实现范围、启用和限制见 [管理员/用户设计与实施](docs/admin-user-design.md)。临时验收避免影响当前网页：

~~~powershell
$env:DIST_DIR = "F:/code/zane-drama/.local/user-access-web"
npm run docs:ai
npm run check
# 后续正式构建前清除临时构建目录覆盖；停服/备份后再执行正常升级
Remove-Item Env:DIST_DIR
~~~

公共 HTTP 接口为 /api/auth/status、/api/auth/setup（本机）、/api/auth/login。业务 API、发现、在线契约和指南都需要有效身份；/api/health 与 /api/ready 保持只读公共运维入口。ZANE_ADMIN_TOKEN 只作为可选、显式配置的应急运维身份，不提供默认值，也不代替首次浏览器管理员初始化。

## 用户专用公网入口（可选）

公网仅提供普通用户入口及必要 API；管理 UI/API、首次初始化、旧管理接口与管理员/应急凭证在该入口不可用。通过 `ZANE_PUBLIC_USER_PORT` 开启同进程第二监听入口，仍复用同一权威服务与 SQLite；原管理端口必须回环，不建立第二套场景库。登录增加账户/可信来源窗口限流与密码校验并行限制，公开入口/生产错误脱敏保留业务 code、requestId 与冲突信息。

默认不开启，不会自动修改生产环境或启动端口。配置、MCP契约、测试及本轮未调整的 HTTPS/代理与资源隔离限制见 [用户入口部署说明](docs/public-user-deployment.md)。
