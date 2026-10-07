# Hermes `comfyui-dev` profile 使用工作台

本接入使用 **Hermes 自带 MCP 客户端 + 用户 profile 配置 + 用户技能**，不修改 `hermes-agent` 上游代码，不用浏览器模拟点击，也不建立另一套任务数据库。

## 当前职责（2026-10-02）

`comfyui-dev` 的名称保留，职责已整体改为**工作台业务协作者**，不是生成引擎的开发测试环境。

- 从用户目标出发，读取实际项目、场景和能力，在授权范围内组织、配置、执行、修复并交付业务。
- 不限定某种内容、固定场景、固定工具清单或固定代理分工；业务适配依据实时文档、能力与参数 schema。
- 删除了旧职责中的模型/LoRA、节点链试验、8188、0.4MP 试验档、固定提示词代理及生产复验交接规则。保留真实状态对账、尊重在途任务、避免重复执行与结果核验等通用稳定性约束。
- 共享 `agent-roster` 中也只更新了 `comfyui-dev` 这一行，其他 profile 的职责不变。

| 位置 | 用途 |
| --- | --- |
| `E:\Data\hermes\profiles\comfyui-dev\config.yaml` | `mcp_servers.zane-workbench`；此次职责调整未改变配置字节，原有 DaVinci、平台、模型配置保留 |
| `E:\Data\hermes\profiles\comfyui-dev\SOUL.md` | 灵活的工作台业务职责和接口接入说明 |
| `E:\Data\hermes\profiles\comfyui-dev\skills\zane-workbench\SKILL.md` | 1.2.0，动态发现、单场景配置/发布、输入契约、轻量结果、revision与稳定ID对账 |
| `E:\Data\hermes\skills_shared\agent-roster\SKILL.md` | 对外协作名录，避免其他代理继续派旧开发测试任务 |
| `E:\Data\hermes\profiles\comfyui-dev\backups\zane-workbench-20261002T011751Z-918c4df8` | 调整前的 SOUL、技能、共享名录及恢复回执；不提交到仓库 |

MCP 运行 `C:/Program Files/nodejs/node.exe F:/code/zane-drama/dist-server/mcp/index.js`，连接 `http://127.0.0.1:8799`。不依赖 Hermes 的 cwd，不启动后台/worker，不直接读 SQLite。**profile 名称含 dev 不意味着使用8798。**

当前 Hermes 将服务名规范化为 `zane_workbench`，工具前缀为 **`mcp__zane_workbench__`**。契约1.1.0提供41个业务工具；Hermes另提供4个资源/提示词辅助工具，实际注册45个工具；4个资源和1个提示词可读取。数量是当前契约，不是永远不变的职责范围。

## 编排者与流程节点

1. **业务编排者**：按用户目标处理工作台业务，发现与配置流程，按需要预检、提交、审核、恢复和交付。底层执行由工作台的能力与节点负责，不绕过工作台再提交同一任务。
2. **流程节点**：被工作台调用来返回某一步产物时，只返回该步结果，不再次提交、恢复、重做、审核或修改所在流程。

角色根据任务上下文判断。只读 doctor 按当前 profile 的实际名称检查**当前发布版**中的同 profile 节点。现有场景中的 `comfyui` 是另一执行者，不因名字相似而自动改写。控制者与执行者可以不同，场景引用不随职责调整而迁移。

submit/resume/rerun/compose **调用前**持久保存新 UUID runId、后台地址、项目目录与发布版本。响应丢失只查原ID，不换ID重投。接口接受不等于业务完成，完成后仍核对真实产物和验收标准。

## 前一轮迁移

用户更正由 `comfyui-dev` 控制工作台后，旧 `comfyui` 的工作台 MCP、受管理 SOUL 段和本次新增技能已撤回，config/SOUL 与首次安装前备份逐字节一致，保留其原生产执行职责与 DaVinci。撤回前快照保存在 `E:\Data\hermes\profiles\comfyui\backups\zane-workbench-move-out-f326d7e67275`。本轮未再次修改该 profile、现有场景或发布版本。

## 安装、职责转换与更新

脚本依赖 Hermes Python 环境已有的 PyYAML；默认只预览。默认安装只插入一个 MCP YAML 块、更新受管理 SOUL 段和安装技能，**不依据 profile 名称偷偷改变原职责**。

显式 `--adopt-workbench-role` 才会备份并整体替换所选 profile 的旧 SOUL；模板由实际 profile 名称渲染，可以用于其他 profile，不包含 `comfyui-dev` 专属分支。模板位于 `examples/hermes/workbench-role.md`，接入段位于 `examples/hermes/workbench-soul-section.md`。

```powershell
Set-Location F:\code\zane-drama
$python = 'E:\Data\hermes\hermes-agent\venv\Scripts\python.exe'
$profile = 'E:\Data\hermes\profiles\comfyui-dev'

# 预览：将当前所选 profile 转换为工作台业务职责。
& $python -B scripts/install-hermes-workbench.py --profile-home $profile --adopt-workbench-role
# 确认后应用，修改前自动备份；本机已经应用，重复运行应无变化。
& $python -B scripts/install-hermes-workbench.py --profile-home $profile --adopt-workbench-role --apply
```

安装器持有现有 profile 协作锁，保持无关配置字节。已有但设置不同的同名 MCP 不覆盖；技能更新只接受当前模板或精确匹配已交付旧版的内容哈希，不能只凭版本标题覆盖用户改动。每次改动有 manifest；撤回前确认期间没有其他人修改这些文件，勿拿旧整份配置覆盖后续用户设置。共享名录的本轮单行修改另有 `shared-roster-change.json` 与原文件备份。

## 只读验收

不使用 `hermes chat`，不调用模型。脚本使用安装版本的 `register_mcp_servers`、registry dispatch 和 skill_view，仅启动工作台 MCP 子进程；日志、缓存和技能读取副本放临时 home，不启动其他 MCP、Gateway 或后台。

```powershell
$python = 'E:\Data\hermes\hermes-agent\venv\Scripts\python.exe'
$profile = 'E:\Data\hermes\profiles\comfyui-dev'
$source = 'E:\Data\hermes\hermes-agent'

# 仅检查真实工具发现、资源、提示词和技能读取。
& $python -B F:\code\zane-drama\scripts\check-hermes-workbench.py --profile-home $profile --hermes-source $source --discovery-only
# 检查正式后台的实际契约、场景、能力、项目及发布快照；本机已通过。
& $python -B F:\code\zane-drama\scripts\check-hermes-workbench.py --profile-home $profile --hermes-source $source --expected-project F:\project\zane
```

`--base-url` 只临时覆盖本次验收的地址，不改配置。`--expected-project` 防止接错项目。

```powershell
Set-Location F:\code\zane-drama
$env:ZANE_HERMES_PYTHON = 'E:\Data\hermes\hermes-agent\venv\Scripts\python.exe'
$env:ZANE_HERMES_SOURCE = 'E:\Data\hermes\hermes-agent'
$env:ZANE_HERMES_PROFILE_HOME = 'E:\Data\hermes\profiles\comfyui-dev'
npm run test:hermes:smoke
& $env:ZANE_HERMES_PYTHON -B scripts/test-hermes-workbench.py
```

隔离冒烟使用临时端口、SQLite、项目和本地条件节点，不使用正式数据、不调用模型。普通 `npm run check` 不强制要求安装 Hermes。

## 前一轮1.0.0上线记录（历史）

- **2026-10-02正式后台升级完成**：8799由新PID 89348提供服务，`/api/v1/ai` 返回契约1.0.0，worker.ready/accepting为true，项目仍为 `F:\project\zane`。不需要再运行本次切换脚本。
- 切换前重新同步契约并执行全量 `npm run check`：**232个测试通过，0失败、0跳过**，含构建、后台/反馈/电商/AI隔离冒烟与文档一致性；保留了工作区其他业务改动。
- **16个Python接入回归**及Hermes隔离冒烟通过。正式Node/Hermes MCP只读验收也通过，真实工具、资源、提示词、guide与1.1.1技能可读；当前发布版无同profile自调用节点。
- 切换前后及最终复查的数据库逐表哈希一致，连接配置哈希一致：10场景/10发布场景/150运行/614事件/157步骤/4生产文档。已保留一致性在线备份及实际停服后的完整数据目录备份（含WAL/SHM）。详见 [后台升级记录](backend-upgrade-2026-10-02.md)。
- profile配置字节未变，DaVinci、平台与模型设置保留；没有重启Gateway或ComfyUI，没有真实生成，`hermes-agent` Git工作区未改变。
- 修复了用户层 `E:\Data\hermes\bin\hermes.cmd` 的源码根路径，保留原wrapper机制并加 `-B`。实际 `hermes -p comfyui-dev chat --help` 返回0；没有修改上游，也没有用真实模型chat做验收。原launcher及回执位于 `E:\Data\hermes\backups\workbench-cli-20261002T020444Z`。
- 1.1.1技能已安装，备份位于 `E:\Data\hermes\profiles\comfyui-dev\backups\zane-workbench-20261002T020448Z-51b1d1de`。日常从目标场景开始，运行目录分页，`wait_run(timeoutSeconds:0)` 查摘要；只有配置场景才读取完整工作区，截断时不拼凑base。

## 1.1.0基础能力与本轮验收

- 单场景create/draft/update/validate/publish/restore/delete、共享预设、发布输入schema/示例和按需输出已实现。
- 261项全量测试和16项Python接入回归通过；真实Hermes安装客户端隔离验收发现45工具、4资源、1提示词，契约1.1.0。
- 1.2.0技能仅更新上述操作规则；config.yaml和SOUL.md字节不变，不调整模型/平台/DaVinci。备份：`E:\Data\hermes\profiles\comfyui-dev\backups\zane-workbench-20261002T035649Z-e9baec0f`。重跑安装器无差异。
- 最终正式后台PID89640、契约1.1.0，Node/Hermes只读验收通过；数据保留回执见 [基础能力升级记录](backend-foundation-2026-10-02.md)，上下文收益与具体边界见 [AI友好性审查](ai-usability.md)。
- 无真实模型/媒体生成，未重启Gateway或ComfyUI，上游保持只读。

## 会话中启用

正式后台已切换；旧会话需要重连时，在对应 `comfyui-dev` 会话/频道中使用当前 Hermes 支持的 `/reload-mcp` 并按提示确认。这是会话工具重连，不是 Gateway 重启；也会重连该 profile 原有 MCP（如 DaVinci），请在空闲时处理。本次未替用户发送命令。

随后开启新任务会话，确保新 SOUL 与技能生效。旧 `comfyui` 会话若曾加载过工作台工具，也需在空闲时重载以撤去缓存。CLI launcher已修复，但本次仅验证了help入口和只读MCP，不宣称真实模型业务已验收。

第一条任务可用：

> 加载 zane-workbench，仅做工作台只读接管验收。读取实时手册、项目、场景和能力，确认实际后台并说明可处理的业务。不要提交运行、生成媒体、批准审核或重启服务。

通过后再用用户授权的小任务验证真实链路。接入本身不授予自动付费、发布或审批权限。

## 管理员/用户版本接入（2026-10-04，待正式启用）

契约1.4.0新增账户与授权。先按正常流程升级工作台；旧8799后台与新版stdio契约不一致时 doctor 会拒绝接管。此次未切换正式后台、未创建正式管理员或 token，也没有重启/修改 Hermes Gateway 或 ComfyUI。以上2026-10-02配置和验收是历史记录，不代表当前已携带新凭证。

1. 在工作台服务器本机创建首个管理员，进入 /admin → 用户管理 → 本人AI凭证，创建并立即保存 token（仅返回一次）。
2. 在 comfyui-dev 的用户 profile 配置 mcp_servers.zane-workbench.env 中合并 ZANE_API_TOKEN，保留 ZANE_BASE_URL=http://127.0.0.1:8799 和原模型/平台/其他MCP配置。不要把凭证写入 SOUL/技能/仓库，不修改 Hermes 上游或 evolution foundation。
3. 先以相同 token 执行 npm run ai:doctor。普通用户 token 只检查本人身份和授权目录；管理员 token 检查管理目录/能力。权限由 token 对应账户决定，不由 comfyui-dev 名称决定。
4. Hermes 自己的会话在安全空闲时重新加载此 MCP 配置，再进行只读发现；无需连带重启 Gateway/ComfyUI。stdio 启动命令不变，工具数量以实时 listTools 为准，get_workbench 返回当前身份可使用的操作面。

token 不等于授权；改场景授权立即影响之后请求。停用、改角色或重置密码会使已有会话和 token 失效，需要重新登录/创建 token。响应丢失按稳定ID对账，不能重新创建另一个有副作用的任务。

## `start:prod` 同步 MCP（1.5.1）

工作台 MCP 原启动命令保持不变，但现在由常驻 stdio 层管理 HTTP 适配子进程。用户执行 `npm run start:prod` 后，仅在新工作台真正就绪时发布代次；在途调用排空后替换自己的子进程，并发送目录变化通知。当前已安装 Hermes 的动态工具发现处理器支持该通知；不修改 Hermes 上游或 evolution foundation，不重启 Gateway、ComfyUI 或其他 MCP。

首次已经运行的旧 MCP 仍须在空闲的对应会话重载一次；`/reload-mcp` 会重连该 profile 的其他 MCP，应避开其在途操作。更换 token、地址或环境同样需要重载。之后日常工作台代码升级不再要求重连这个 MCP。详情、备份、忙碌拒绝和回执恢复见 `docs/mcp-runtime.md`。
