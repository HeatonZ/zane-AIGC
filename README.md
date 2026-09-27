# Zane Studio

个人使用的 AIGC 工作流工作台。当前内置漫剧制作和商品展示两个定制场景。

## 本地运行

```powershell
npm install
npm run dev
```

Vite 默认使用 `5173`，端口被占用时会自动选择下一个可用端口。本地 API 默认运行在 `127.0.0.1:8799`。

## 当前能力

- `流程配置` 使用表单编辑场景输入、按顺序执行的步骤、每步输入/输出和场景最终输出，不提供图形画布。
- 步骤输入可引用场景字段或前序步骤的输出；最终输出可引用场景字段或任意步骤输出。Hermes 提示词可插入这些引用。
- 场景输入表单随流程定义生成；流程与草稿保存在浏览器本地存储。
- 集成页可启用多个 Hermes Profile，并检查本机 Profile Gateway；ComfyUI 使用 `/system_stats` 检查。
- Hermes Profile 从 `HERMES_HOME` 下的 `config.yaml` 和 `profiles/*/config.yaml` 发现。Hermes 不按 OpenAI 兼容 `/models` 接口探测。若 API 进程找不到 CLI，可设置 `HERMES_BIN` 为 `hermes.exe` 完整路径。
- 连接设置写入 `.local/connections.json`，该目录已加入 `.gitignore`。

目前流程定义和输入/输出引用已可编辑、保存；任务执行引擎尚未接入。集成页显示的 Hermes 状态表示 Profile Gateway 可用，不代表应用已经把提示词发送给 Agent。ComfyUI 工作流提交也尚未接入。

## 代码入口

- `src/data/scenes.ts`：场景清单与导航展示信息。
- `src/features/Studio.tsx`：根据场景流程定义动态生成输入表单并保存草稿。
- `src/features/FlowDesigner.tsx`：表单式场景流程定义。
- `src/features/Dashboard.tsx`：工作台场景入口、最近草稿和服务状态。
- `server/index.ts`：本地设置存储与 Hermes、ComfyUI 连通性检查。
