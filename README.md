# Zane Studio

个人使用的 AIGC 工作流工作台。当前内置漫剧制作和商品展示两个定制场景。

## 开发环境

开发环境由 Vite 前端和本地 API 两个进程组成：

```powershell
npm install
npm run dev
```

Vite 默认使用 `5173`，并把 `/api` 代理到 `127.0.0.1:8799`。API 的开发数据默认写入项目下的 `.local/`，因此不会和正式环境的数据混用。需要调整端口或代理地址时，复制 `.env.example` 为 `.env.development` 后修改。

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
   HERMES_BIN=hermes.exe
   COMFYUI_BASE_URL=http://127.0.0.1:8188
   ```

   如果需要让局域网或反向代理访问 API，把 `API_HOST` 改为 `0.0.0.0`；只在本机访问时保留 `127.0.0.1`。

3. 构建并启动正式环境：

   ```powershell
   npm run build
   npm run start
   ```

   也可以用 `npm run start:prod` 一次完成构建和启动。启动后打开 `http://127.0.0.1:8799`（如果修改了端口则使用对应端口）。`npm run start` 会提供 `dist/` 下的前端文件和 `/api` 接口，不需要再启动 `npm run dev` 或 `vite preview`。

正式环境的连接设置保存在 `APP_DATA_DIR/connections.json`，开发环境仍保存在 `.local/connections.json`。浏览器的工作流和草稿也按访问地址分别保存在各自的 localStorage 中。发布新版本时重新执行 `npm run build`，然后重启 `npm run start`。

## 更新正式环境而不覆盖配置

流程配置和草稿目前保存在浏览器中：开发地址 `http://127.0.0.1:5173` 与正式地址 `http://127.0.0.1:8799` 使用不同的 localStorage。重新构建前端、替换 `dist/`、重启 Node 服务都不会清除正式地址的流程配置。正式环境的连接设置则由 `APP_DATA_DIR/connections.json` 持久化。

发布更新时按下面的顺序操作：

1. 保留 `.env.production` 和 `APP_DATA_DIR`，不要把它们替换成开发环境配置。
2. 停止正式环境的 `npm run start`。
3. 更新代码并执行 `npm run build`。
4. 重新执行 `npm run start`，仍然使用原来的正式地址和端口。

不要清除正式地址的浏览器站点数据，也不要改用新的域名或端口后再判断配置是否丢失；浏览器会把新地址视为另一份 localStorage。若需要把正式配置迁移到新地址，当前版本需要在浏览器侧单独导出或迁移 localStorage。

`.env.example` 列出了常用配置项。`API_HOST`、`API_PORT`、`APP_DATA_DIR`、`DIST_DIR`、`HERMES_HOME`、`HERMES_BIN`、`COMFYUI_BASE_URL` 用于 API；`VITE_API_PROXY_TARGET` 只用于开发环境代理。

## 当前能力

- `流程配置` 使用表单编辑场景输入、按顺序执行的步骤、每步输入/输出和场景最终输出，不提供图形画布。
- 步骤输入可引用场景字段或前序步骤的输出；最终输出可引用场景字段或任意步骤输出。Hermes 提示词可插入这些引用。
- 场景输入表单随流程定义生成；流程与草稿保存在浏览器本地存储。
- 集成页可启用多个 Hermes Profile，并检查本机 Profile Gateway；ComfyUI 使用 `/system_stats` 检查。
- Hermes Profile 从 `HERMES_HOME` 下的 `config.yaml` 和 `profiles/*/config.yaml` 发现。Hermes 不按 OpenAI 兼容 `/models` 接口探测。若 API 进程找不到 CLI，可设置 `HERMES_BIN` 为 `hermes.exe` 完整路径。
- ComfyUI 工作流支持直接选择画布（UI）格式；后台在读取和运行时会实时转换为 `/prompt` 所需的 API 图，不需要用户手动导出 API JSON。
- 连接设置写入 `.local/connections.json`，该目录已加入 `.gitignore`。

目前流程定义和输入/输出引用已可编辑、保存；任务执行引擎会按步骤调用 Hermes 和 ComfyUI。集成页显示的 Hermes 状态表示 Profile Gateway 可用；ComfyUI 画布工作流会在后台转换后提交。

## 代码入口

- `src/data/scenes.ts`：场景清单与导航展示信息。
- `src/features/Studio.tsx`：根据场景流程定义动态生成输入表单并保存草稿。
- `src/features/FlowDesigner.tsx`：表单式场景流程定义。
- `src/features/Dashboard.tsx`：工作台场景入口、最近草稿和服务状态。
- `server/index.ts`：本地设置存储、工作流执行，以及 Hermes、ComfyUI 连通性检查和 ComfyUI 工作流转换。
