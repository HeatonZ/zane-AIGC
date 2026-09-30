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

   也可以用 `npm run start:prod` 一次完成构建和启动。启动后打开 `http://127.0.0.1:8799`（如果修改了端口则使用对应端口）。`npm run start` 会提供 `dist/` 下的前端文件和 `/api` 接口，不需要再启动 `npm run dev` 或 `vite preview`。

正式环境的连接设置保存在 `APP_DATA_DIR/connections.json`，工作区、运行索引和事件以同一目录的 `zane.db` 为权威存储，`workspace.json` 保留为兼容导出镜像。开发环境默认使用 `.local/`。发布新版本时重新执行 `npm run build`，然后重启 `npm run start`。

## Hermes API Server

Hermes 步骤通过 Hermes API Server 的 OpenAI 兼容接口执行。请在 Hermes Home 的 `.env` 中启用 API Server 并设置 `API_SERVER_KEY`，然后重启 Gateway：

```dotenv
API_SERVER_ENABLED=true
API_SERVER_KEY=替换为本机专用密钥
API_SERVER_PORT=8642
```

多 Profile Gateway 还需要在每个被调用 Profile 的 `profiles/<profile>/.env` 中设置该 Profile 自己的 `API_SERVER_KEY`。应用会自动读取密钥和端口；`HERMES_API_BASE_URL` 可覆盖自动推导的本机地址。只有在远程 API Server 或所有 Profile 共用同一个密钥时，才在应用 `.env` 中设置 `HERMES_API_KEY`。

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

场景、流程、选项预设、草稿和场景发布版本由 8799 服务端统一保存在 `APP_DATA_DIR/zane.db`（`workspace.json` 为导出镜像），手机和电脑访问同一个 8799 服务时使用同一份工作区。首次启动会列出当前浏览器已有的场景，需在保存着目标配置的设备上明确点击初始化；其他设备不会自动写入默认场景。初始化后，服务端是共享来源，浏览器的 localStorage 只作本地副本。

发布更新时按下面的顺序操作：

1. 保留 `.env.production` 和 `APP_DATA_DIR`，不要把它们替换成开发环境配置。
2. 停止正式环境的 `npm run start`。
3. 更新代码并执行 `npm run build`。
4. 重新执行 `npm run start`，仍然使用原来的正式地址和端口。

不要在服务端工作区已初始化后用另一台设备的旧 localStorage 覆盖配置；服务端 SQLite 是统一来源。更换 `APP_DATA_DIR` 会切换到另一份本机工作区，应停服后迁移整个数据目录及项目归档；单个场景仍可以使用工作台提供的 JSON 导入导出。

工作台的场景卡片支持导出和导入场景。导出的 JSON 包含场景展示信息、对应流程配置，以及该流程引用的选项预设；导入时会创建一个新的场景并自动处理选项预设 ID 冲突。

场景和流程编辑会自动保存为暂存内容，创作页与运行流程始终使用最近一次发布的版本。完成编辑后，在“流程配置”页发布即可让暂存内容生效；“版本管理”可将历史发布版本一键应用到暂存内容，之后仍需再次发布才会生效。版本标识是场景内容快照 MD5 的前 8 位；每个场景最多保留最近 10 个发布版本。场景导出包含当前暂存内容；导入后作为未发布的新场景，需要检查并发布后才能使用。

`.env.example` 列出了常用配置项。`API_HOST`、`API_PORT`、`APP_DATA_DIR`、`DIST_DIR`、`HERMES_HOME`、`HERMES_API_BASE_URL`、`HERMES_API_KEY`、`FFMPEG_BIN`、`FFPROBE_BIN`、`COMFYUI_BASE_URL`、`ZANE_PROJECT_DIR`、`ZANE_WORKFLOW_TIMEOUT_MINUTES` 用于 API；`VITE_API_PROXY_TARGET` 只用于开发环境代理。

## 当前能力

- `流程配置` 使用表单编辑场景输入、按顺序执行的步骤、每步输入/输出和场景最终输出，不提供图形画布。
- 工作台支持将单个场景导出为 JSON，也可以从 JSON 导入场景和对应流程配置。
- 步骤输入和 ComfyUI 输入绑定可引用场景字段、前序步骤输出，也可以配置带类型的固定值；最终输出可引用场景字段或任意步骤输出。Hermes 提示词可插入这些引用。
- 场景输入表单随流程定义生成；流程与草稿由共享工作区保存，浏览器保留本地副本和待同步 outbox；运行元数据存入 SQLite，文件归档到项目目录。
- 集成页可启用多个 Hermes Profile，并通过 API Server 的 `/v1/models` 检查认证和连通性；ComfyUI 使用 `/system_stats` 检查。
- 后台 Worker 默认允许 2 个流程并发，可通过 `ZANE_MAX_ACTIVE_RUNS` 调整；步骤启用 `for_each` 后可配置 `execution.maxConcurrency`（1–32），ComfyUI 同一上游地址按已请求的最大并行数限流，不同地址互不阻塞。
- 运行中的流程可以点击“取消运行”。服务端会中止 Hermes API 请求，ComfyUI 会调用 `/interrupt`；关闭页面不会取消后台任务。“继续编辑”会恢复草稿输入和上次运行结果。
- 失败记录可以在“运行记录”页点击“从失败步骤继续”；取消记录或服务重启后标记为“待恢复”的记录可以点击“从断点继续”。操作会按原记录的工作流快照创建新运行，复用已完成或已跳过步骤及已完成的逐项结果，只重试未完成的逐项并继续后续步骤；原记录和输入文件会保留。服务中断时正在执行的步骤或逐项可能被外部服务实际完成但尚未保存，续跑时可能重复执行。
- Hermes Profile 从 `HERMES_HOME` 下的 `config.yaml` 和 `profiles/*/config.yaml` 发现。Hermes 连接状态按 Profile 检查 API Server 和 API 密钥。
- ComfyUI 工作流支持直接选择画布（UI）格式；后台在读取和运行时会实时转换为 `/prompt` 所需的 API 图，不需要用户手动导出 API JSON。
- 连接设置写入 `.local/connections.json`，该目录已加入 `.gitignore`。

目前流程定义和输入/输出引用已可编辑、保存；任务执行引擎会按步骤调用 Hermes API Server 和 ComfyUI。集成页显示的 Hermes 状态表示所选 Profile 的 API Server 可用；ComfyUI 画布工作流会在后台转换后提交。

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

## 长文出视频（原生有声片段）

提供长文/剧情、人物/场景/道具资产与参考音色，Writer直接生成制作级分镜，H3原生生成对白和视频片段，本机FFmpeg顺序合成。无独立配音、关键帧或模型质检节点，每个片段提示词禁止音乐。

构建并重启服务后执行 `npm run scene:install:long-video` 安装并发布独立场景（保留已有场景与草稿）。配置与执行协议见 [长文出视频说明](docs/long-text-video.md)，模拟完整链路验证执行 `npm run test:long-video:smoke`（不调用真实生成模型）。
