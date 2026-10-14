# AI 基础能力

由 npm run docs:ai 生成；契约 1.5.36。当前 105 个业务操作，功能与请求定义同源。

## 功能覆盖

每个功能列出它使用的操作名与副作用。HTTP 方法与路径不再在这里重复：见 ai-tools.md 与 ai-openapi.json，也可用 get_workbench 的 features[].operations 或 list_capabilities 实时读取。

### generic-start-condition

通用开始条件startCondition：每个步骤（hermes/comfyui/手动/能力/旧条件节点）都可声明match(all|any)+rules（左值引用input/前序step输出，运算符equals/not_equals/greater_than/greater_or_equal/less_than/less_or_equal/contains/not_contains/is_empty/is_not_empty，右侧为字面量或另一个引用，字面量 rightValue 可省略并按空串处理）；规则不满足时该步骤整步跳过、逐项模式下按项跳过，其声明输出按null参与下游引用，模型与外部服务不会被调用也不计费。开始条件必须在提交前通过引用存在性与结构校验（引用后续步骤/未知引用/空规则/无效匹配方式均拒绝），重做规划按其引用步骤失效旧结果。旧core.condition条件步骤、runCondition与data.select条件选择保留为compatibilityOnly仅兼容已发布快照，新场景不再需要它们：分支跳过由开始条件+null输出表达。配置不发布不执行，发布快照固定后行为才生效，历史运行不自动替换。

| 工具 | 副作用 |
| --- | --- |
| `list_capabilities` | read |
| `create_scene` | write |
| `get_scene_draft` | read |
| `update_scene_draft` | write |
| `validate_scene_draft` | read |
| `publish_scene` | write |
| `get_scene` | read |
| `prepare_scene` | read |
| `submit_scene` | execute |
| `get_step_result` | read |
| `resume_run` | execute |
| `preview_rerun` | read |
| `rerun` | execute |
| `submit_own_scene` | execute |
| `get_own_step_result` | read |
| `resume_own_run` | execute |

### custom-code-step

通用自定义代码基础步骤core.code：在隔离沙箱（worker_thread + node:vm，每次执行单worker；上下文为无原型global并禁用字符串代码生成，且宿主不向沙箱传递任何函数对象，因此用户代码无法经constructor/原型链逃逸到宿主process、文件系统或子进程；128MB内存上限、200–60000毫秒超时、同步死循环由vm超时终止、失控Promise与外部取消强制终止）执行本地JavaScript，用于新场景的数据传递、模板拼装、条件控制和结构化计算；沙箱自身不读写文件、不联网、不调用模型、不计费（可选本地导出与可选本地文件读取都由宿主在沙箱之外代执行，见core-code-local-export与core-code-file-access）。用户代码以async function体书写，顶层return对象键对应声明的输出端口；输入按声明端口以JSON进入沙箱，媒体值以只读[{filename}]投影进入（只暴露数量/顺序/文件名）；输出必须齐声明端口与text/number/boolean/json/image_list/video_list/audio_list类型，缺失、额外、不可序列化和超大返回都是明确失败；媒体输出端口返回文件名数组（字符串或{filename}），只按filename选择、排序或合并本步骤声明输入里已有的媒体（可重复、可重排），不产生、不改名、不暴露媒体字节/路径/URL，引用不存在文件或类型不符即失败；console日志仅失败时作为错误上下文。代码/端口/超时通过草稿编辑，发布快照固定后才在提交执行时运行，取消即终止沙箱；配置和预检不执行代码。既有发布快照不自动替换；text.template、core.manual、media.select_references、media.image_layout仅保留旧流程兼容。机器契约x-code-step v1。

| 工具 | 副作用 |
| --- | --- |
| `list_capabilities` | read |
| `create_scene` | write |
| `get_scene_draft` | read |
| `update_scene_draft` | write |
| `validate_scene_draft` | read |
| `publish_scene` | write |
| `get_scene` | read |
| `prepare_scene` | read |
| `submit_scene` | execute |
| `get_step_result` | read |
| `resume_run` | execute |
| `rerun` | execute |
| `submit_own_scene` | execute |
| `get_own_step_result` | read |
| `resume_own_run` | execute |

### third-party-json-request

通用第三方JSON HTTP/HTTPS请求基础步骤：固定公网地址（HTTP/HTTPS、任意端口，支持公网IP字面量；拒绝本机/内网/回环/链路本地/保留IP和本机/内网域名）、服务端环境变量鉴权、声明输入模板、超时和响应大小边界；DNS解析结果固定并拒绝非公网地址、重定向、敏感URL参数和本地媒体路径；HTTP为明文传输，密钥不经TLS保护，能使用HTTPS时优先；配置/预检不调用第三方，发布快照固定后执行才发出一次请求，状态码/JSON或文本响应按步骤结果读取（可按场景只声明images输出）；默认一次请求，显式retries(0–5)与retryDelaySeconds(0–30)按指数退避只重试网络失败、超时和HTTP 408/429/500/502/503/504/524，重试会重发同一请求、可能重复计费或重复变更第三方状态（524为边缘节点等待源站超时，源站可能仍在生成），确定性错误（4xx、无效JSON、响应过大、图片解码失败、非公网地址、凭证缺失、配置/输入错误）立即失败不重试，取消运行中断等待；确定性失败时以步骤warnings追加有界脱敏的上游响应摘要（先按4096字节截断再解码、redactErrorText脱敏、600字符截断并标记，空响应体不生成），用于区分参数被拒与内容策略拦截，而抛出的错误消息、错误码与details.status保持既有契约；最终失败返回最后一次原始错误码。普通ComfyUI生图优先core.comfyui；multipart扩展按声明映射上传当前运行的已授权图片——本运行归档的图片，或本运行内已上传/上游产出的ComfyUI图片附件（没有运行内归档副本，按配置的ComfyUI地址取回原字节，只接受普通文件名/子目录段），显式开启multipartLocalFiles（默认false）后还可读取管理员本地导出根目录内的真实文件（与core.code的localExport/fileAccess共用同一授权边界，取真实路径校验包含性，拒绝越界与符号链接逃逸，未配置根目录时该来源不可用），拒绝任意路径、其他运行的文件与预览URL；可解码base64响应为可选images并沿用归档/鉴权/分页，原base64明确标记省略。保留JSON旧模式，不做异步轮询、不保存第三方密钥。

| 工具 | 副作用 |
| --- | --- |
| `list_capabilities` | read |
| `create_scene` | write |
| `get_scene_draft` | read |
| `update_scene_draft` | write |
| `validate_scene_draft` | read |
| `publish_scene` | write |
| `get_scene` | read |
| `prepare_scene` | read |
| `submit_scene` | execute |
| `get_step_result` | read |
| `resume_run` | execute |
| `rerun` | execute |
| `submit_own_scene` | execute |
| `get_own_step_result` | read |
| `resume_own_run` | execute |

### comfy-static-switch

精简长文基础组合：旧版data.zip可选ordinalField校验1-based连续整数序号（仅兼容已发布快照，新场景用core.code做同类校验）；逐项JSON来源内媒体与上游输出共用归档，保持新运行的carry恢复匹配。单工作流上下文切换：运行绑定后仅对可证明静态Boolean的内置ComfySwitchNode断开未选中可选输入；未知、循环和自定义选择器不处理，保留所有节点/输出和其他消费者，不执行表达式或节点。显式空可选视频清除原图示例路径，选中必需输入仍校验；同服务支持HTTP/MCP、固定发布及恢复，配置不生成、旧版不迁移。机器契约x-comfy-static-switch v1。

| 工具 | 副作用 |
| --- | --- |
| `create_scene` | write |
| `update_scene_draft` | write |
| `validate_scene_draft` | read |
| `submit_scene` | execute |
| `resume_run` | execute |
| `rerun` | execute |
| `submit_own_scene` | execute |
| `resume_own_run` | execute |

### comfy-ui-routing

UI格式ComfyUI图在同一转换服务解析前端Reroute链与扇出，保留真实源与出口，拒绝循环/缺失/多来源/非法出口；不修改原文件、场景或发布；API图不变。配置复用现有场景编辑和固定发布执行工具，恢复遵循真实状态且可能计费，错误不自动重试。机器契约x-comfy-ui-routing v1。

| 工具 | 副作用 |
| --- | --- |
| `create_scene` | write |
| `update_scene_draft` | write |
| `submit_scene` | execute |
| `resume_run` | execute |
| `rerun` | execute |
| `submit_own_scene` | execute |
| `resume_own_run` | execute |

### for-each-carry

通用步骤for_each可选execution.carry串行状态传递，不新增视频专用执行器或状态库；上一项输出保持声明类型，首项可选种子或null，boolean hasPrevious与0基index；失败停止、连续匹配前缀续跑、单项重做/反馈失效后缀，替换保留该项重算后续；结果沿用逐项分页/revision，配置不发布/生成，旧快照不迁移。

| 工具 | 副作用 |
| --- | --- |
| `create_scene` | write |
| `get_scene_draft` | read |
| `update_scene_draft` | write |
| `validate_scene_draft` | read |
| `publish_scene` | write |
| `get_scene` | read |
| `prepare_scene` | read |
| `submit_scene` | execute |
| `get_step_result` | read |
| `resume_run` | execute |
| `preview_rerun` | read |
| `rerun` | execute |
| `submit_own_scene` | execute |
| `get_own_step_result` | read |
| `resume_own_run` | execute |

### public-user-security

可选用户专用监听入口，复用同一服务/SQLite；显式用户操作与本人媒体白名单，管理初始化/旧管理API/管理员凭证不可达；get_workbench发现入口和登录策略，进程内有界账户/可信来源窗口与并行密码校验限流，429可操作重试时间；公网/生产错误脱敏保留code/requestId/revision。管理入口默认回环；开启用户入口时把管理入口绑到非回环需显式ZANE_ALLOW_LAN_INGRESS=true（缺省fail closed，只改监听绑定，不放宽白名单/角色/初始化，仍须防火墙限制来源），用户入口自身用ZANE_PUBLIC_USER_HOST=0.0.0.0直接开放。TLS代理、额度、上传与Agent隔离不在本轮。

| 工具 | 副作用 |
| --- | --- |
| `get_workbench` | read |
| `get_current_user` | read |

### core-code-local-export

core.code 可选本地导出：步骤可声明 capabilityConfig.localExport={enabled:true,planKey?,onConflict?}，由用户代码返回 {items:[{source,target}]} 计划，宿主在沙箱之外执行真正的写盘。沙箱本身始终没有文件系统访问，也拿不到写权限或真实根路径，用户代码只能给出「哪个已声明输入的媒体写到哪个目标」；因此这不放宽隔离。写入仅允许落在管理员配置的 local-export 根目录内部：root 经 HTTP/MCP get_local_export/update_local_export 以 revision 保护保存在 SQLite 单例（未配置则整步失败 LOCAL_EXPORT_DISABLED），每个 target 归一化后必须仍在根目录内，.. 逃逸拒绝且报 LOCAL_EXPORT_OUTSIDE_ROOT 而非被中和，已存在父级经符号链接指向根外同样拒绝；source 必须是本步骤声明输入端口里真实存在的媒体文件名：已归档媒体按本运行及授权来源运行的归档读取（局部重做/续跑复用祖先媒体同样可读），本运行内刚由 ComfyUI 生成、尚未归档的媒体（归档发生在流程末尾）按配置的 comfyuiBaseUrl 取回该产物；任意外部 URL 与其它未归档媒体仍明确失败。单文件32MB、单次总量512MB、最多144项，越限即失败。写入走临时文件加原子改名，onConflict 默认overwrite（重跑取最新），可选skip/fail；计划先全量校验再写盘，一项非法不产生半写结果。步骤声明 local_export(json) 输出端口时记录逐项 bytes/sha256/status。配置、草稿校验与预检都不写文件，只有提交执行才落盘，也不调用模型、不计费；历史运行与已发布快照不自动替换。机器契约 x-local-export v1 与 x-code-step。

| 工具 | 副作用 |
| --- | --- |
| `get_local_export` | read |
| `update_local_export` | write |
| `list_capabilities` | read |
| `get_scene_draft` | read |
| `update_scene_draft` | write |
| `validate_scene_draft` | read |
| `publish_scene` | write |
| `get_scene` | read |
| `prepare_scene` | read |
| `submit_scene` | execute |
| `get_step_result` | read |
| `resume_run` | execute |
| `rerun` | execute |
| `submit_own_scene` | execute |
| `get_own_step_result` | read |
| `resume_own_run` | execute |

### core-code-file-access

core.code 可选本地文件读取：capabilityConfig.fileAccess={enabled:true} 时沙箱内出现只读对象 zane.fs，可 list(相对路径) 列出目录、stat(相对路径) 查看元数据、readText(相对路径) 读取文本内容；调用由宿主在沙箱之外执行，沙箱本身始终没有文件系统访问与写权限。读取与写入共用同一个管理员配置的 local-export 根目录（唯一授权边界，经 get_local_export/update_local_export 以 revision 保护保存；未配置报 FILE_ACCESS_DISABLED），两者独立开关。路径相对根目录解析，越界与指向根外的符号链接都拒绝。list/stat 只返回文件名、根内绝对路径、类型与字节数；readText 只返回 UTF-8 文本（用于从动作/提示词这类多行文本里挑一行），单次上限1MB、超出报 FILE_TOO_LARGE，读到的文本不执行、不解析、不写回，也不写入/删除/重命名任何文件；list 按名称排序、单次最多500项，stat 对不存在路径返回 exists:false。返回的根内绝对路径可供下游步骤使用（例如作为 ComfyUI 输入上传）。宿主不向沙箱传函数对象，不放宽既有逃逸隔离；关闭（默认）时 zane 不存在。配置、校验与预检都不读文件，只有提交执行才真实读取，不调用模型、不计费。机器契约 x-local-file-access v1。

| 工具 | 副作用 |
| --- | --- |
| `get_local_export` | read |
| `update_local_export` | write |
| `list_capabilities` | read |
| `get_scene_draft` | read |
| `update_scene_draft` | write |
| `validate_scene_draft` | read |
| `publish_scene` | write |
| `get_scene` | read |
| `prepare_scene` | read |
| `submit_scene` | execute |
| `get_step_result` | read |
| `resume_run` | execute |
| `rerun` | execute |
| `submit_own_scene` | execute |
| `get_own_step_result` | read |
| `resume_own_run` | execute |

### system-task-concurrency

管理员在集成连接/HTTP/MCP配置全系统流程任务并发，复用SQLite权威服务与revision冲突保护；默认环境变量2、范围1–32、保存值跨重启/项目目录持久化。即时调整队列放行，不中断已执行任务，不提交新任务或调用模型（已有排队任务可开始）；for_each和ComfyUI并发独立。读取不写入，丢失回执先同ID对账，无自动重放。

| 工具 | 副作用 |
| --- | --- |
| `get_task_concurrency` | read |
| `update_task_concurrency` | write |

### workbench-metrics

管理员只读运行时指标快照：进程内存/运行时长与运行队列（maxActiveRuns、queued/active/preparing、accepting/ready、未完成状态计数），diagnostics=1 时附带 SQLite PRAGMA quick_check。只读、不分页、不暴露场景内容、运行明细或凭据，不执行任何变更；供监控面板与 AI 巡检使用。

| 工具 | 副作用 |
| --- | --- |
| `get_system_metrics` | read |

### ai-commerce-basic-composition

AI电商套图仅复用基础Writer/AIXG完整视觉设计、已授权媒体输入、严格列表对齐、ComfyUI与审核；直接生成包含所需文字/图形/版式的完整图片，交付模型原始成图，不含add_text、layout、无字底图限制、后置文案、条件排版或程序合成。商品和风格参考分离，固定计划ID、样张先确认、剩余逐张生成。列表配对与数量/唯一ID校验由core.code自定义代码完成（旧版data.zip仅兼容已发布快照）；参考图合并与成图交付由core.code媒体输出端口按filename选择本次输入的既有媒体（不产生新媒体、不暴露路径/URL），模板不再使用已退役的media.select_references步骤；已授权媒体输入直接绑定到模型/ComfyUI步骤，steps.inputs.referenceType显式标注JSON内媒体供审核恢复后真实附件使用，基础ComfyUI的outputMediaCounts逐次校验准确媒体数量，不用总数掩盖错配；草稿不自动发布，旧电商快照/历史不迁移。

| 工具 | 副作用 |
| --- | --- |
| `list_capabilities` | read |
| `create_scene` | write |
| `get_scene_draft` | read |
| `update_scene_draft` | write |
| `validate_scene_draft` | read |
| `publish_scene` | write |
| `get_scene` | read |
| `prepare_scene` | read |
| `submit_scene` | execute |
| `get_step_result` | read |
| `review_run` | execute |
| `preview_rerun` | read |
| `rerun` | execute |
| `submit_own_scene` | execute |
| `get_own_step_result` | read |
| `review_own_run` | execute |

### generic-run-media-export

按最终/步骤/逐项媒体输出读取终态归档ZIP信息，HTTP/MCP/UI共用只读导出服务；只读已授权本运行及祖先归档，不读取任意路径或下载远程媒体，不调用模型。返回revision、计数、incomplete和需鉴权下载地址；旧revision409。普通用户实时身份/场景授权/归属，HEAD与下载同权限；元数据不塞媒体列表，详细结果复用分页工具。

| 工具 | 副作用 |
| --- | --- |
| `get_run_media_export` | read |
| `get_own_run_media_export` | read |
| `get_run_outputs` | read |
| `get_step_result` | read |
| `get_own_outputs` | read |
| `get_own_step_result` | read |

### safe-workbench-upgrade

本机专用升级管理脚本在隔离源码快照先执行完整check，再等待queued/running/preparing/waiting归零，核验新鲜实例、通过现有生命周期备份SQLite并正常切换。UUID运维回执不另建业务任务库；未知停机/激活回执按原ID对账、不重放。候选启动先隔离业务请求，健康就绪后明确激活；不重启Hermes/ComfyUI、不审批、不自动续跑。HTTP/MCP管理员只读升级状态；用户只读当前release并提示手动保存后刷新。运维执行限定本机CLI，不暴露HTTP/MCP任意执行代理。

| 工具 | 副作用 |
| --- | --- |
| `get_workbench_upgrade` | read |
| `get_runtime_release` | read |

### h3-prompt-section-format

H3生成前用通用段落标题归一化处理英文大小写/水平缩进与明确详细描述别名，六段缺失/重复/顺序不一致只给warnings，不阻断执行；步骤/逐项通用warn在外部执行前持久化，UI显示⚠，HTTP/MCP按同一记录分页读取；不猜缺失段落、不改正文/镜头内容，原AIXG输出不变、实际prompt与prompt_warnings写入既有applied_shot，缺段不截掉可能包含动作/对白的尾部，追加禁音乐策略；固定快照和授权沿用原服务，读取不生成，显式续跑复用完成Writer/AIXG只重做未完成生成步骤，原runId不重投

| 工具 | 副作用 |
| --- | --- |
| `get_run` | read |
| `get_step_result` | read |
| `resume_run` | execute |
| `preview_rerun` | read |
| `get_own_run` | read |
| `get_own_step_result` | read |
| `resume_own_run` | execute |

### hermes-output-json

所有基础Hermes步骤共用完整JSON解析与声明字段校验；仅一个提前闭合顶层对象的多余括号或字符串内原始LF/CR/TAB可确定性修复，不组合修复；全回复解析且禁止未知/缺失/重复顶层字段，保留全部解码值并记录不含正文的修复日志；不截断、不提取首对象、不重试模型、不改历史运行，类型仍按既有输出契约校验。失败读原runId对账，显式续跑仍可能重新调用未checkpoint步骤

| 工具 | 副作用 |
| --- | --- |
| `submit_scene` | execute |
| `get_run` | read |
| `get_step_result` | read |
| `resume_run` | execute |
| `submit_own_scene` | execute |
| `get_own_run` | read |
| `get_own_step_result` | read |
| `resume_own_run` | execute |

### system-feedback

普通用户提交/按ID对账/分页查看本人系统反馈；仅管理员完整读取、revision保护回复和处理状态，不注入Agent或触发模型；普通审核不接受Agent反馈

| 工具 | 副作用 |
| --- | --- |
| `submit_system_feedback` | write |
| `list_own_system_feedback` | read |
| `get_own_system_feedback` | read |
| `list_system_feedback` | read |
| `get_system_feedback` | read |
| `handle_system_feedback` | write |

### mcp-runtime-sync

用户执行start:prod时新鲜进程核验、持久化待审核/在途请求门禁、SQLite备份和正常关闭；仅新后台就绪后替换本项目MCP适配子进程，保留stdio会话并通知目录刷新；在途调用排空，回执丢失明确unknown且不重放。首次旧进程需客户端重载一次，不重启Hermes Gateway/ComfyUI，也不向AI开放任意运维执行代理

| 工具 | 副作用 |
| --- | --- |
| `get_workbench` | read |

### identity-and-users

管理员/用户身份；SQLite账户与会话，启停/角色/密码重置使旧凭证失效；稳定ID、revision冲突、分页；管理员直接配置用户sceneIds，不复制场景

| 工具 | 副作用 |
| --- | --- |
| `get_current_user` | read |
| `list_users` | read |
| `get_user` | read |
| `create_user` | write |
| `update_user` | write |
| `set_user_scene_access` | write |
| `reset_user_password` | write |

### user-scene-operation

本人授权且已发布场景的业务目录与输入契约；服务端构造执行快照和归属，允许额外输入键透传且仍校验已声明字段，禁止任意流程与本机路径；本人输入草稿/运行/结果分页；按身份读取本人素材并选择固定版本；版本变化显式冲突，审核/续跑遵守真实状态

| 工具 | 副作用 |
| --- | --- |
| `list_available_scenes` | read |
| `get_available_scene` | read |
| `prepare_own_scene` | read |
| `submit_own_scene` | execute |
| `list_own_drafts` | read |
| `get_own_draft` | read |
| `save_own_draft` | write |
| `list_own_runs` | read |
| `get_own_run` | read |
| `get_own_outputs` | read |
| `get_own_step_result` | read |
| `wait_own_run` | read |
| `cancel_own_run` | write |
| `review_own_run` | execute |
| `resume_own_run` | execute |
| `list_own_assets` | read |
| `upload_own_asset` | write |
| `get_own_asset` | read |

### task-draft-favorites

任务草稿/本人输入草稿收藏与取消收藏，服务端SQLite权威持久化；收藏置顶、组内最近保存、同时间稳定ID排序，旧草稿未收藏；编辑保留收藏，收藏不更新保存时间/发布/执行；管理员全局草稿原归属不变、本人草稿身份隔离，显式目标值与revision保护，列表变更游标失效，回执丢失按原ID读后决策

| 工具 | 副作用 |
| --- | --- |
| `list_task_drafts` | read |
| `get_task_draft` | read |
| `set_task_draft_favorite` | write |
| `list_own_drafts` | read |
| `get_own_draft` | read |
| `save_own_draft` | write |
| `set_own_draft_favorite` | write |

### business-run-details

UI/HTTP/MCP同源业务详情：固定运行快照的步骤进度、未执行步骤和逐项计数、每步真实startedAt/durationMs及首次真实开始/排队/总历时；for_each步骤durationMs是墙钟时间，逐项用时按步骤结果分页读取；按字段/字符串/数组/对象分页原始输入，sequence增量业务动态，明确省略与revision冲突；无提示词、连接、内部错误payload，不生成

| 工具 | 副作用 |
| --- | --- |
| `get_own_run` | read |
| `get_own_run_inputs` | read |
| `get_own_run_activity` | read |
| `get_own_step_result` | read |

### user-ai-credentials

本人90天AI凭证，密钥只返回一次；stable tokenId、revision吊销、元数据分页；失去回执先读取同一ID元数据并显式吊销，不能盲重放

| 工具 | 副作用 |
| --- | --- |
| `list_own_tokens` | read |
| `create_own_token` | write |
| `revoke_own_token` | write |

### discovery

实时工作台、项目和能力发现；统一能力目录的适用范围与旧版兼容边界，目录revision绑定分页；core.code的新场景数据处理契约；媒体选择与合并、图片画布与排版等旧能力的兼容边界与值schema。发现负载分级：get_workbench的detail（默认summary）只返回路由、副作用与权限事实并显式标记省略的说明文本，detail=full返回完整说明；zane://guide默认只返回当前生效契约，历史版本小节在zane://guide/changelog。分级不改变业务语义。

| 工具 | 副作用 |
| --- | --- |
| `get_workbench` | read |
| `list_capabilities` | read |

### hermes-model-selection

步骤级Hermes provider/model选择：每个Hermes步骤可声明hermesProvider/hermesModel，作为请求级provider/model发送给网关（两者都省略时请求体保持历史行为，按Profile默认模型执行）；只作用于声明它的步骤（含for_each逐项），不修改Profile配置、网关默认模型或历史运行快照。校验：provider≤80字符、模型≤200字符，只允许字母数字与 _ . : @ / -，草稿校验、发布预检与执行前各校验一次；同时设置时按该Provider解析凭证与端点，只设模型时/v1/runs入口按所选模型执行、旧版chat/completions回退入口需网关开启direct_model_requests。配套只读发现：list_hermes_profiles列出本机真实Profile，list_hermes_models按Profile读取网关模型选择器目录（slug/显示名/是否当前/是否有凭证/模型ID，每Provider最多200个并明确标记截断；不返回凭证、密钥环境变量名或上游地址），目录按Profile缓存60秒、refresh显式重读、游标绑定profile与revision（变化409重读第一页）、网关不可达502且可继续手工填写。重做/反馈链路同样可修改这两个字段（preview_rerun/rerun的stepOverrides、review_run的stepChanges）。

| 工具 | 副作用 |
| --- | --- |
| `list_hermes_profiles` | read |
| `list_hermes_models` | read |
| `create_scene` | write |
| `get_scene_draft` | read |
| `update_scene_draft` | write |
| `validate_scene_draft` | read |
| `publish_scene` | write |
| `get_scene` | read |
| `prepare_scene` | read |
| `submit_scene` | execute |
| `get_step_result` | read |
| `resume_run` | execute |
| `preview_rerun` | read |
| `rerun` | execute |
| `review_run` | execute |
| `submit_own_scene` | execute |
| `get_own_step_result` | read |
| `resume_own_run` | execute |

### workspace

仅服务端一套场景/流程/发布/预设/草稿，轻量revision同步、显式空工作区初始化与高级三方合并；网页不维护本地业务场景库，重载只读服务端，防丢outbox须明确恢复且冲突保护，不自动补场景或发布

| 工具 | 副作用 |
| --- | --- |
| `get_workspace_status` | read |
| `get_workspace` | read |
| `initialize_workspace` | write |
| `merge_workspace` | write |

### scene-input-defaults

流程输入可设置类型匹配的workflow.inputs[].defaultValue（select必须属于options）；number输入可定义包含minimum/maximum范围，两者可省略，配置后由表单、inputSchema和服务端校验；required=false允许不输入。hidden=true可从管理创作页和用户端网页输入表单隐藏字段，但仍保留在inputSchema、输入值和流程执行中；隐藏必填字段需要有效默认值。json输入可声明inputMode=object_array和itemFields，把规格等对象数组渲染成用户可增删行填写的表单，并按每行字段类型、数字范围、必填和下拉选项校验；草稿revision写入后由validate_scene_draft检查，显式发布后只影响该固定发布版的新输入表单和prepare契约，用户显式输入覆盖默认值；UI/HTTP/MCP复用同一契约，不自动发布或执行

| 工具 | 副作用 |
| --- | --- |
| `create_scene` | write |
| `get_scene_draft` | read |
| `update_scene_draft` | write |
| `validate_scene_draft` | read |
| `publish_scene` | write |
| `get_scene` | read |
| `prepare_scene` | read |
| `get_available_scene` | read |
| `prepare_own_scene` | read |

### scenes

与网页同源同序的revision绑定分页目录，显式草稿/发布名称与差异；场景展示取对应scene.title，不以独立workflow.name代替，不改历史；场景草稿创建/编辑/校验/发布/恢复/删除，固定版本输入契约和预检，允许额外输入键透传并保留，已声明字段仍按类型/必填校验；用基础步骤组合新场景，不为场景另造执行器；Qwen Image 2.1图生图以基础Hermes writer整理有序图片与想法，再由aixg将text edit_brief转为text prompt连接正向端口；仅图片/想法/seed/ratio/mp五项输入，画幅与MP走目标画布且参考图片仍参与条件编码，其余参数用固定配置，revision保护编辑后显式发布；双采视频复用workflowFile和bindings的草稿编辑/校验/显式发布，长文精简草稿采用Writer一次写制作级视频分镜（storyboard/shots无prompt）→基础Hermes aixg一次批量转换prompts、不重编剧情→data.zip等长对齐与确定性素材映射→同一个ComfyUI上下文开关工作流for_each.carry串行续接→拼接，共7步、两次AI调用，保留Writer时长/对白/选择与整镜JSON/24fps；业务分类留在上游，ComfyUI仅接收图片/音频/视频列表；基础引用选择images/audios/videos输出按分组顺序合并，H3本镜分类素材先选择并合并为references.images/audios，保留全局标签到连续局部编号的映射；场景输入不再配置素材用途子类（mediaRole只兼容旧发布快照），分类写在输入名称里，固定发布契约原样回传旧值；revision编辑不自动迁移或发布

| 工具 | 副作用 |
| --- | --- |
| `list_scenes` | read |
| `create_scene` | write |
| `get_scene_draft` | read |
| `update_scene_draft` | write |
| `validate_scene_draft` | read |
| `publish_scene` | write |
| `restore_scene_draft` | write |
| `delete_scene` | write |
| `get_scene` | read |
| `prepare_scene` | read |

### scene-diff

流程配置与当前固定发布版的只读差异预览；权威服务按稳定ID/key比较场景、输入、步骤/提示词/ComfyUI绑定、输出和关联预设，增删改/顺序变化；发布同源能力规范化但不代替校验，草稿哈希核对、diff revision绑定分页/大值Unicode分段、变更409重读；不保存/发布/生成

| 工具 | 副作用 |
| --- | --- |
| `get_scene_draft_diff` | read |
| `get_scene_draft_diff_value` | read |

### option-presets

共享选项依赖与revision保护

| 工具 | 副作用 |
| --- | --- |
| `list_option_presets` | read |
| `save_option_preset` | write |
| `delete_option_preset` | write |

### runs

固定发布版执行、管理员分页历史/详情含服务端验证并记录的提交人身份快照；步骤和for_each各项保存startedAt/durationMs；get_run保存已执行Hermes步骤实际发送提示词agentPrompt，解析或输出校验失败时保存完整未trim原始回复agentResponse，for_each按item.agentPrompt/agentResponse保存；get_step_result可分页读逐项用时与原始回复；有界等待、事件、取消和恢复

| 工具 | 副作用 |
| --- | --- |
| `submit_scene` | execute |
| `list_runs` | read |
| `get_run` | read |
| `wait_run` | read |
| `get_run_events` | read |
| `cancel_run` | execute |
| `resume_run` | execute |

### results

最终输出/单步/逐项按需读取和媒体引用；可选textOffset/textLimit按Unicode码点读取长文本，Hermes失败原始回复agentResponse同样分页且明确valuePage与页预算，不静默截断

| 工具 | 副作用 |
| --- | --- |
| `get_run_outputs` | read |
| `get_step_result` | read |

### revision-and-review

修订反馈、局部重做预览和执行、显式审核

| 工具 | 副作用 |
| --- | --- |
| `preview_rerun` | read |
| `rerun` | execute |
| `review_run` | execute |

### asset-execution-access

UI/HTTP/MCP复用权威素材服务；assetId+assetVersion固定版本解析为同一任务私有归档，Hermes/AIXG读取字节构造inline图片、ComfyUI按参考图顺序上传同一来源；基础audio_list从已授权固定音色私有路径读取原字节，按引用顺序上传再连接LoadAudio；旧media.select_references/data.zip中间JSON仍可被历史快照使用；每文件100MB、合法既有附件不重传、preview不回退、失败在prompt前停止且不自动重试，机器契约audioConsumers；Hermes保留现有预算/压缩，不改选版本，不依赖受保护previewUrl或转发工作台token；管理员兼容本后台同源/相对固定素材URL，预检提前拒绝错误版本/类型/丢失文件；普通用户仍仅本人固定引用；原运行不变、显式断点续跑不盲重放

| 工具 | 副作用 |
| --- | --- |
| `get_scene` | read |
| `prepare_scene` | read |
| `submit_scene` | execute |
| `get_asset` | read |
| `get_asset_version` | read |
| `prepare_own_scene` | read |
| `submit_own_scene` | execute |
| `get_own_asset` | read |
| `resume_run` | execute |

### assets

管理员素材库：本地上传/运行收藏、说明/分组/标签检索与筛选、快照分页、固定版本引用、版本分页与生成参数分段、revision写入和稳定createId对账；普通用户另有按身份隔离的本人素材分页目录，可在自己的任务输入中选择固定版本

| 工具 | 副作用 |
| --- | --- |
| `list_assets` | read |
| `get_asset` | read |
| `list_asset_versions` | read |
| `get_asset_version` | read |
| `save_asset` | write |
| `upload_asset` | write |
| `update_asset` | write |
| `list_own_assets` | read |

### clip-selections

选版清单、修订家族候选与成片顺序整理

| 工具 | 副作用 |
| --- | --- |
| `list_clip_selections` | read |
| `create_clip_selection` | write |
| `get_clip_selection` | read |
| `get_clip_candidates` | read |
| `update_clip_selection` | write |
| `compose_clip_selection` | execute |

### tasks

任务=批量执行容器：一个任务含最多200个任务项，每项独立固定「已发布场景+versionId+输入」，因此一个任务可以跨场景/跨发布版，用于「一个项目连续出几十张图」而不必建几十条互不相关的运行记录。中间态草稿可反复编辑（items为完整替换、按位置保留itemId），逐项按发布快照校验输入与固定素材版本；确认是单向冻结：先为每项预分配稳定runId落库再逐项提交，响应丢失用同一批runId对账、重复确认不会重复提交或重复计费（alreadyConfirmed）。单项提交失败不阻断整批，失败项可单独重跑（旧runId保留在previousRunIds），等待人工确认的项拒绝重跑、不能绕过审核。进度与状态完全由各项运行状态投影，复用现有运行队列的并发上限、排队、审核与重启恢复，不新建调度器、不新建旁路任务库。取消尽力取消在途项并保留已完成结果；删除任务不删除历史运行、媒体或素材

| 工具 | 副作用 |
| --- | --- |
| `list_tasks` | read |
| `get_task` | read |
| `create_task` | write |
| `update_task` | write |
| `confirm_task` | execute |
| `rerun_task_item` | execute |
| `cancel_task` | write |
| `delete_task` | write |

## 最小使用闭环

- 已有场景：get_workbench → list_scenes → get_scene（固定版本的输入schema/默认值/示例）→ prepare_scene → submit_scene（先保存UUID runId）→ wait_run → get_run_outputs/get_step_result。
- 能力选型：list_capabilities 读取统一目录，能力不分基础/专用等级；新场景的数据传递、模板拼装和结构化控制使用core.code本地沙箱执行（不联网、不计费，契约x-code-step）；已授权媒体直接绑定到模型或ComfyUI步骤；逐项计划/素材/提示词的对齐、数量与唯一ID校验用core.code。需要真实文件时用core.code的两个可选开关：localExport提交写盘计划（x-local-export）、fileAccess只读列出授权根目录内的文件名与元数据（x-local-file-access），两者都以管理员配置的local-export根目录为唯一边界、各自独立开关，沙箱本身始终没有文件系统权限。media.select_references、media.image_layout、text.template、core.manual、core.condition、data.select、data.zip、comfyui.h3_long_video、comfyui.long_text_video、comfyui.commerce_pack均标记compatibilityOnly:true，仅保留已有发布快照与历史运行，不再作为新步骤推荐。分支跳过用任意步骤的startCondition开始条件（被跳过步骤输出为null，不再需要条件判断/条件选择步骤）；精确JSON值schema随目录返回。不再新增场景专用步骤；能力缺口先补强或拆出可复用能力，场景特有的数据编排用core.code表达。
- 新业务：create_scene（先保存scene.id）→ get_scene_draft → update_scene_draft（当前revision）→ validate_scene_draft → publish_scene（先保存UUID publicationId）→ get_scene读取真实发布版；发布不执行生成。
- 共享选项：list_option_presets查看revision/使用场景 → save_option_preset；恢复旧发布版时共享选项冲突会克隆，已发布快照不变。
- 局部修订：preview_rerun确认影响范围 → rerun（先保存新runId）；审核用最新reviewId，不绕过waiting。
- 结果：摘要看状态，输出按key/stepId/itemIndex读取；目录/镜头cursor分页，数组值分段；valueOmitted和valuePage.complete必须检查。媒体返回HTTP地址和稳定source，不塞二进制；终态媒体打包用get_run_media_export/get_own_run_media_export核对revision和下载地址，不生成或下载远程媒体。

## 一致性与恢复

网页/HTTP/MCP仅服务端一套SQLite场景/流程/发布/预设/草稿；网页不维护本地业务库，空初始化不导入浏览器缓存，重载不自动应用或重放防丢outbox。get_workspace_status核对来源revision；list_scenes按浏览器目录顺序分页，title为草稿、publishedTitle为发布版，draftMatchesPublished明确差异。游标跨revision返回409 SCENE_PAGE_CHANGED；创作get_scene不跟随草稿。网页在空闲时自动同步，在未同步写入/字段编辑/对话框/创作表单中仅提示更新；不覆盖编辑、不自动发布。
内容revision只针对目标场景及其预设/发布目录，无关场景编辑不误冲突；所有写入复用现有工作区锁和SQLite事务。旧revision返回当前revision/冲突对象，重新读取再决策。
发布以publicationId为versionId，在最近10版保留范围内同请求不会重复发布；旧回执不会把新发布指针切回旧版。响应丢失先用同ID读回，不自动换ID重投。
输入schema描述数据结构，不保证素材文件/远程服务/业务质量；最小示例需看requiresUserInput和missingRequiredInputs，媒体不会伪造素材ID。
删除场景不会删除运行/素材/媒体，删除有草稿引用的共享预设会拒绝。高级整工作区操作仍可用三方合并，但不是普通单场景配置的必经步骤。

## 后续功能要求

新业务功能必须同步交付AI操作面、schema/响应/恢复规则、功能矩阵、手册及真实stdio隔离回归；完成条件见 [AI开发规范](ai-development.md)，仓库根AGENTS.md和PR检查表已纳入约定。
详细参数见 [OpenAPI](ai-openapi.json)，操作与恢复见 [操作手册](ai-operator.md)，工具目录见 [AI工具](ai-tools.md)。
