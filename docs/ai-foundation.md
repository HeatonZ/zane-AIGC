# AI 基础能力

由 npm run docs:ai 生成；契约 1.5.27。当前 92 个业务操作，功能与请求定义同源。

## 功能覆盖

### comfy-static-switch

精简长文基础组合：data.zip可选ordinalField校验1-based连续整数序号，无需额外步骤；逐项JSON来源内媒体与上游输出共用归档，保持新运行的carry恢复匹配。单工作流上下文切换：运行绑定后仅对可证明静态Boolean的内置ComfySwitchNode断开未选中可选输入；未知、循环和自定义选择器不处理，保留所有节点/输出和其他消费者，不执行表达式或节点。显式空可选视频清除原图示例路径，选中必需输入仍校验；同服务支持HTTP/MCP、固定发布及恢复，配置不生成、旧版不迁移。机器契约x-comfy-static-switch v1。

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `create_scene` | `POST /api/v1/scenes` | write |
| `update_scene_draft` | `PATCH /api/v1/scenes/{sceneId}/draft` | write |
| `validate_scene_draft` | `POST /api/v1/scenes/{sceneId}/validate` | read |
| `submit_scene` | `POST /api/v1/scenes/{sceneId}/runs` | execute |
| `resume_run` | `POST /api/v1/runs/{sourceRunId}/resume` | execute |
| `rerun` | `POST /api/v1/runs/{sourceRunId}/rerun` | execute |
| `submit_own_scene` | `POST /api/v1/self/scenes/{sceneId}/runs` | execute |
| `resume_own_run` | `POST /api/v1/self/runs/{runId}/resume` | execute |

### comfy-ui-routing

UI格式ComfyUI图在同一转换服务解析前端Reroute链与扇出，保留真实源与出口，拒绝循环/缺失/多来源/非法出口；不修改原文件、场景或发布；API图不变。配置复用现有场景编辑和固定发布执行工具，恢复遵循真实状态且可能计费，错误不自动重试。机器契约x-comfy-ui-routing v1。

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `create_scene` | `POST /api/v1/scenes` | write |
| `update_scene_draft` | `PATCH /api/v1/scenes/{sceneId}/draft` | write |
| `submit_scene` | `POST /api/v1/scenes/{sceneId}/runs` | execute |
| `resume_run` | `POST /api/v1/runs/{sourceRunId}/resume` | execute |
| `rerun` | `POST /api/v1/runs/{sourceRunId}/rerun` | execute |
| `submit_own_scene` | `POST /api/v1/self/scenes/{sceneId}/runs` | execute |
| `resume_own_run` | `POST /api/v1/self/runs/{runId}/resume` | execute |

### for-each-carry

通用步骤for_each可选execution.carry串行状态传递，不新增视频专用执行器或状态库；上一项输出保持声明类型，首项可选种子或null，boolean hasPrevious与0基index；失败停止、连续匹配前缀续跑、单项重做/反馈失效后缀，替换保留该项重算后续；结果沿用逐项分页/revision，配置不发布/生成，旧快照不迁移。

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `create_scene` | `POST /api/v1/scenes` | write |
| `get_scene_draft` | `GET /api/v1/scenes/{sceneId}/draft` | read |
| `update_scene_draft` | `PATCH /api/v1/scenes/{sceneId}/draft` | write |
| `validate_scene_draft` | `POST /api/v1/scenes/{sceneId}/validate` | read |
| `publish_scene` | `POST /api/v1/scenes/{sceneId}/publish` | write |
| `get_scene` | `GET /api/v1/scenes/{sceneId}` | read |
| `prepare_scene` | `POST /api/v1/scenes/{sceneId}/prepare` | read |
| `submit_scene` | `POST /api/v1/scenes/{sceneId}/runs` | execute |
| `get_step_result` | `GET /api/v1/runs/{runId}/steps/{stepId}/result` | read |
| `resume_run` | `POST /api/v1/runs/{sourceRunId}/resume` | execute |
| `preview_rerun` | `POST /api/v1/runs/{sourceRunId}/rerun/preview` | read |
| `rerun` | `POST /api/v1/runs/{sourceRunId}/rerun` | execute |
| `submit_own_scene` | `POST /api/v1/self/scenes/{sceneId}/runs` | execute |
| `get_own_step_result` | `GET /api/v1/self/runs/{runId}/steps/{stepId}` | read |
| `resume_own_run` | `POST /api/v1/self/runs/{runId}/resume` | execute |

### public-user-security

可选用户专用监听入口，复用同一服务/SQLite；显式用户操作与本人媒体白名单，管理初始化/旧管理API/管理员凭证不可达；get_workbench发现入口和登录策略，进程内有界账户/可信来源窗口与并行密码校验限流，429可操作重试时间；公网/生产错误脱敏保留code/requestId/revision。TLS代理、额度、上传与Agent隔离不在本轮。

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `get_workbench` | `GET /api/v1/ai` | read |
| `get_current_user` | `GET /api/v1/self/account` | read |

### system-task-concurrency

管理员在集成连接/HTTP/MCP配置全系统流程任务并发，复用SQLite权威服务与revision冲突保护；默认环境变量2、范围1–32、保存值跨重启/项目目录持久化。即时调整队列放行，不中断已执行任务，不提交新任务或调用模型（已有排队任务可开始）；for_each和ComfyUI并发独立。读取不写入，丢失回执先同ID对账，无自动重放。

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `get_task_concurrency` | `GET /api/v1/settings/task-concurrency` | read |
| `update_task_concurrency` | `PATCH /api/v1/settings/task-concurrency` | write |

### ai-commerce-basic-composition

AI电商套图仅复用基础Writer/AIXG完整视觉设计、媒体选择、严格列表对齐、ComfyUI与审核；直接生成包含所需文字/图形/版式的完整图片，交付模型原始成图，不含add_text、layout、无字底图限制、后置文案、条件排版或程序合成。商品和风格参考分离，固定计划ID、样张先确认、剩余逐张生成。data.zip校验等长/唯一ID/有限本地itemSchema，media.select_references支持all与可选bundle保留逐项边界，steps.inputs.referenceType显式标注JSON内媒体供审核恢复后真实附件使用，基础ComfyUI的outputMediaCounts逐次校验准确媒体数量，不用总数掩盖错配；草稿不自动发布，旧电商快照/历史不迁移。

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `list_capabilities` | `GET /api/v1/capabilities` | read |
| `create_scene` | `POST /api/v1/scenes` | write |
| `get_scene_draft` | `GET /api/v1/scenes/{sceneId}/draft` | read |
| `update_scene_draft` | `PATCH /api/v1/scenes/{sceneId}/draft` | write |
| `validate_scene_draft` | `POST /api/v1/scenes/{sceneId}/validate` | read |
| `publish_scene` | `POST /api/v1/scenes/{sceneId}/publish` | write |
| `get_scene` | `GET /api/v1/scenes/{sceneId}` | read |
| `prepare_scene` | `POST /api/v1/scenes/{sceneId}/prepare` | read |
| `submit_scene` | `POST /api/v1/scenes/{sceneId}/runs` | execute |
| `get_step_result` | `GET /api/v1/runs/{runId}/steps/{stepId}/result` | read |
| `review_run` | `POST /api/v1/runs/{runId}/review` | execute |
| `preview_rerun` | `POST /api/v1/runs/{sourceRunId}/rerun/preview` | read |
| `rerun` | `POST /api/v1/runs/{sourceRunId}/rerun` | execute |
| `submit_own_scene` | `POST /api/v1/self/scenes/{sceneId}/runs` | execute |
| `get_own_step_result` | `GET /api/v1/self/runs/{runId}/steps/{stepId}` | read |
| `review_own_run` | `POST /api/v1/self/runs/{runId}/review` | execute |

### generic-run-media-export

按最终/步骤/逐项媒体输出读取终态归档ZIP信息，HTTP/MCP/UI共用只读导出服务；只读已授权本运行及祖先归档，不读取任意路径或下载远程媒体，不调用模型。返回revision、计数、incomplete和需鉴权下载地址；旧revision409。普通用户实时身份/场景授权/归属，HEAD与下载同权限；元数据不塞媒体列表，详细结果复用分页工具。

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `get_run_media_export` | `GET /api/v1/runs/{runId}/media-export` | read |
| `get_own_run_media_export` | `GET /api/v1/self/runs/{runId}/media-export` | read |
| `get_run_outputs` | `GET /api/v1/runs/{runId}/outputs` | read |
| `get_step_result` | `GET /api/v1/runs/{runId}/steps/{stepId}/result` | read |
| `get_own_outputs` | `GET /api/v1/self/runs/{runId}/outputs` | read |
| `get_own_step_result` | `GET /api/v1/self/runs/{runId}/steps/{stepId}` | read |

### safe-workbench-upgrade

本机专用升级管理脚本在隔离源码快照先执行完整check，再等待queued/running/preparing/waiting归零，核验新鲜实例、通过现有生命周期备份SQLite并正常切换。UUID运维回执不另建业务任务库；未知停机/激活回执按原ID对账、不重放。候选启动先隔离业务请求，健康就绪后明确激活；不重启Hermes/ComfyUI、不审批、不自动续跑。HTTP/MCP管理员只读升级状态；用户只读当前release并提示手动保存后刷新。运维执行限定本机CLI，不暴露HTTP/MCP任意执行代理。

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `get_workbench_upgrade` | `GET /api/v1/maintenance/upgrade` | read |
| `get_runtime_release` | `GET /api/v1/self/runtime-release` | read |

### h3-prompt-section-format

H3生成前用通用段落标题归一化处理英文大小写/水平缩进与明确详细描述别名，六段缺失/重复/顺序不一致只给warnings，不阻断执行；步骤/逐项通用warn在外部执行前持久化，UI显示⚠，HTTP/MCP按同一记录分页读取；不猜缺失段落、不改正文/镜头内容，原AIXG输出不变、实际prompt与prompt_warnings写入既有applied_shot，缺段不截掉可能包含动作/对白的尾部，追加禁音乐策略；固定快照和授权沿用原服务，读取不生成，显式续跑复用完成Writer/AIXG只重做未完成生成步骤，原runId不重投

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `get_run` | `GET /api/v1/runs/{runId}` | read |
| `get_step_result` | `GET /api/v1/runs/{runId}/steps/{stepId}/result` | read |
| `resume_run` | `POST /api/v1/runs/{sourceRunId}/resume` | execute |
| `preview_rerun` | `POST /api/v1/runs/{sourceRunId}/rerun/preview` | read |
| `get_own_run` | `GET /api/v1/self/runs/{runId}` | read |
| `get_own_step_result` | `GET /api/v1/self/runs/{runId}/steps/{stepId}` | read |
| `resume_own_run` | `POST /api/v1/self/runs/{runId}/resume` | execute |

### hermes-output-json

所有基础Hermes步骤共用完整JSON解析与声明字段校验；仅一个提前闭合顶层对象的多余括号或字符串内原始LF/CR/TAB可确定性修复，不组合修复；全回复解析且禁止未知/缺失/重复顶层字段，保留全部解码值并记录不含正文的修复日志；不截断、不提取首对象、不重试模型、不改历史运行，类型仍按既有输出契约校验。失败读原runId对账，显式续跑仍可能重新调用未checkpoint步骤

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `submit_scene` | `POST /api/v1/scenes/{sceneId}/runs` | execute |
| `get_run` | `GET /api/v1/runs/{runId}` | read |
| `get_step_result` | `GET /api/v1/runs/{runId}/steps/{stepId}/result` | read |
| `resume_run` | `POST /api/v1/runs/{sourceRunId}/resume` | execute |
| `submit_own_scene` | `POST /api/v1/self/scenes/{sceneId}/runs` | execute |
| `get_own_run` | `GET /api/v1/self/runs/{runId}` | read |
| `get_own_step_result` | `GET /api/v1/self/runs/{runId}/steps/{stepId}` | read |
| `resume_own_run` | `POST /api/v1/self/runs/{runId}/resume` | execute |

### system-feedback

普通用户提交/按ID对账/分页查看本人系统反馈；仅管理员完整读取、revision保护回复和处理状态，不注入Agent或触发模型；普通审核不接受Agent反馈

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `submit_system_feedback` | `POST /api/v1/self/system-feedback` | write |
| `list_own_system_feedback` | `GET /api/v1/self/system-feedback` | read |
| `get_own_system_feedback` | `GET /api/v1/self/system-feedback/{feedbackId}` | read |
| `list_system_feedback` | `GET /api/v1/system-feedback` | read |
| `get_system_feedback` | `GET /api/v1/system-feedback/{feedbackId}` | read |
| `handle_system_feedback` | `POST /api/v1/system-feedback/{feedbackId}/handle` | write |

### mcp-runtime-sync

用户执行start:prod时新鲜进程核验、持久化待审核/在途请求门禁、SQLite备份和正常关闭；仅新后台就绪后替换本项目MCP适配子进程，保留stdio会话并通知目录刷新；在途调用排空，回执丢失明确unknown且不重放。首次旧进程需客户端重载一次，不重启Hermes Gateway/ComfyUI，也不向AI开放任意运维执行代理

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `get_workbench` | `GET /api/v1/ai` | read |

### identity-and-users

管理员/用户身份；SQLite账户与会话，启停/角色/密码重置使旧凭证失效；稳定ID、revision冲突、分页；管理员直接配置用户sceneIds，不复制场景

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `get_current_user` | `GET /api/v1/self/account` | read |
| `list_users` | `GET /api/v1/users` | read |
| `get_user` | `GET /api/v1/users/{userId}` | read |
| `create_user` | `POST /api/v1/users` | write |
| `update_user` | `PATCH /api/v1/users/{userId}` | write |
| `set_user_scene_access` | `POST /api/v1/users/{userId}/scene-access` | write |
| `reset_user_password` | `POST /api/v1/users/{userId}/password` | write |

### user-scene-operation

本人授权且已发布场景的业务目录与输入契约；服务端构造执行快照和归属，允许额外输入键透传且仍校验已声明字段，禁止任意流程与本机路径；本人输入草稿/运行/结果分页；按身份读取本人素材并选择固定版本；版本变化显式冲突，审核/续跑遵守真实状态

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `list_available_scenes` | `GET /api/v1/self/scenes` | read |
| `get_available_scene` | `GET /api/v1/self/scenes/{sceneId}` | read |
| `prepare_own_scene` | `POST /api/v1/self/scenes/{sceneId}/prepare` | read |
| `submit_own_scene` | `POST /api/v1/self/scenes/{sceneId}/runs` | execute |
| `list_own_drafts` | `GET /api/v1/self/drafts` | read |
| `get_own_draft` | `GET /api/v1/self/drafts/{draftId}` | read |
| `save_own_draft` | `POST /api/v1/self/drafts` | write |
| `list_own_runs` | `GET /api/v1/self/runs` | read |
| `get_own_run` | `GET /api/v1/self/runs/{runId}` | read |
| `get_own_outputs` | `GET /api/v1/self/runs/{runId}/outputs` | read |
| `get_own_step_result` | `GET /api/v1/self/runs/{runId}/steps/{stepId}` | read |
| `wait_own_run` | `GET /api/v1/self/runs/{runId}/wait` | read |
| `cancel_own_run` | `POST /api/v1/self/runs/{runId}/cancel` | write |
| `review_own_run` | `POST /api/v1/self/runs/{runId}/review` | execute |
| `resume_own_run` | `POST /api/v1/self/runs/{runId}/resume` | execute |
| `list_own_assets` | `GET /api/v1/self/assets` | read |
| `upload_own_asset` | `POST /api/v1/self/assets/upload` | write |
| `get_own_asset` | `GET /api/v1/self/assets/{assetId}` | read |

### task-draft-favorites

任务草稿/本人输入草稿收藏与取消收藏，服务端SQLite权威持久化；收藏置顶、组内最近保存、同时间稳定ID排序，旧草稿未收藏；编辑保留收藏，收藏不更新保存时间/发布/执行；管理员全局草稿原归属不变、本人草稿身份隔离，显式目标值与revision保护，列表变更游标失效，回执丢失按原ID读后决策

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `list_task_drafts` | `GET /api/v1/task-drafts` | read |
| `get_task_draft` | `GET /api/v1/task-drafts/{draftId}` | read |
| `set_task_draft_favorite` | `PATCH /api/v1/task-drafts/{draftId}/favorite` | write |
| `list_own_drafts` | `GET /api/v1/self/drafts` | read |
| `get_own_draft` | `GET /api/v1/self/drafts/{draftId}` | read |
| `save_own_draft` | `POST /api/v1/self/drafts` | write |
| `set_own_draft_favorite` | `PATCH /api/v1/self/drafts/{draftId}/favorite` | write |

### business-run-details

UI/HTTP/MCP同源业务详情：固定运行快照的步骤进度、未执行步骤和逐项计数、每步真实startedAt/durationMs及首次真实开始/排队/总历时；for_each步骤durationMs是墙钟时间，逐项用时按步骤结果分页读取；按字段/字符串/数组/对象分页原始输入，sequence增量业务动态，明确省略与revision冲突；无提示词、连接、内部错误payload，不生成

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `get_own_run` | `GET /api/v1/self/runs/{runId}` | read |
| `get_own_run_inputs` | `GET /api/v1/self/runs/{runId}/inputs` | read |
| `get_own_run_activity` | `GET /api/v1/self/runs/{runId}/activity` | read |
| `get_own_step_result` | `GET /api/v1/self/runs/{runId}/steps/{stepId}` | read |

### user-ai-credentials

本人90天AI凭证，密钥只返回一次；stable tokenId、revision吊销、元数据分页；失去回执先读取同一ID元数据并显式吊销，不能盲重放

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `list_own_tokens` | `GET /api/v1/self/tokens` | read |
| `create_own_token` | `POST /api/v1/self/tokens` | write |
| `revoke_own_token` | `POST /api/v1/self/tokens/{tokenId}/revoke` | write |

### discovery

实时工作台、项目和能力发现；基础优先的适用范围与专用替代说明，目录revision/tier绑定分页；基础媒体引用选择及按物理媒体类型合并列表、图片排版的声明与值schema；旧电商兼容边界

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `get_workbench` | `GET /api/v1/ai` | read |
| `list_capabilities` | `GET /api/v1/capabilities` | read |

### workspace

仅服务端一套场景/流程/发布/预设/草稿，轻量revision同步、显式空工作区初始化与高级三方合并；网页不维护本地业务场景库，重载只读服务端，防丢outbox须明确恢复且冲突保护，不自动补场景或发布

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `get_workspace_status` | `GET /api/workspace/status` | read |
| `get_workspace` | `GET /api/workspace` | read |
| `initialize_workspace` | `POST /api/workspace/initialize` | write |
| `merge_workspace` | `POST /api/workspace/merge` | write |

### scene-input-defaults

流程输入可设置类型匹配的workflow.inputs[].defaultValue（select必须属于options）；number输入可定义包含minimum/maximum范围，两者可省略，配置后由表单、inputSchema和服务端校验；required=false允许不输入。hidden=true可从管理创作页和用户端网页输入表单隐藏字段，但仍保留在inputSchema、输入值和流程执行中；隐藏必填字段需要有效默认值。json输入可声明inputMode=object_array和itemFields，把规格等对象数组渲染成用户可增删行填写的表单，并按每行字段类型、数字范围、必填和下拉选项校验；草稿revision写入后由validate_scene_draft检查，显式发布后只影响该固定发布版的新输入表单和prepare契约，用户显式输入覆盖默认值；UI/HTTP/MCP复用同一契约，不自动发布或执行

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `create_scene` | `POST /api/v1/scenes` | write |
| `get_scene_draft` | `GET /api/v1/scenes/{sceneId}/draft` | read |
| `update_scene_draft` | `PATCH /api/v1/scenes/{sceneId}/draft` | write |
| `validate_scene_draft` | `POST /api/v1/scenes/{sceneId}/validate` | read |
| `publish_scene` | `POST /api/v1/scenes/{sceneId}/publish` | write |
| `get_scene` | `GET /api/v1/scenes/{sceneId}` | read |
| `prepare_scene` | `POST /api/v1/scenes/{sceneId}/prepare` | read |
| `get_available_scene` | `GET /api/v1/self/scenes/{sceneId}` | read |
| `prepare_own_scene` | `POST /api/v1/self/scenes/{sceneId}/prepare` | read |

### scenes

与网页同源同序的revision绑定分页目录，显式草稿/发布名称与差异；场景展示取对应scene.title，不以独立workflow.name代替，不改历史；场景草稿创建/编辑/校验/发布/恢复/删除，固定版本输入契约和预检，允许额外输入键透传并保留，已声明字段仍按类型/必填校验；用基础步骤组合新场景，不为场景另造执行器；Qwen Image 2.1图生图以基础Hermes writer整理有序图片与想法，再由aixg将text edit_brief转为text prompt连接正向端口；仅图片/想法/seed/ratio/mp五项输入，画幅与MP走目标画布且参考图片仍参与条件编码，其余参数用固定配置，revision保护编辑后显式发布；双采视频复用workflowFile和bindings的草稿编辑/校验/显式发布，长文精简草稿采用Writer一次写制作级视频分镜（storyboard/shots无prompt）→基础Hermes aixg一次批量转换prompts、不重编剧情→data.zip等长对齐与确定性素材映射→同一个ComfyUI上下文开关工作流for_each.carry串行续接→拼接，共7步、两次AI调用，保留Writer时长/对白/选择与整镜JSON/24fps；业务分类留在上游，ComfyUI仅接收图片/音频/视频列表；基础引用选择images/audios/videos输出按分组顺序合并，H3本镜分类素材先选择并合并为references.images/audios，保留全局标签到连续局部编号的映射；输入与兼容旧ComfyUI绑定的可选mediaRole区分人物/场景/道具/参考音色，类型不变，固定发布契约回传用途；省略兼容旧版，revision编辑不自动迁移或发布

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `list_scenes` | `GET /api/v1/scenes` | read |
| `create_scene` | `POST /api/v1/scenes` | write |
| `get_scene_draft` | `GET /api/v1/scenes/{sceneId}/draft` | read |
| `update_scene_draft` | `PATCH /api/v1/scenes/{sceneId}/draft` | write |
| `validate_scene_draft` | `POST /api/v1/scenes/{sceneId}/validate` | read |
| `publish_scene` | `POST /api/v1/scenes/{sceneId}/publish` | write |
| `restore_scene_draft` | `POST /api/v1/scenes/{sceneId}/restore` | write |
| `delete_scene` | `DELETE /api/v1/scenes/{sceneId}` | write |
| `get_scene` | `GET /api/v1/scenes/{sceneId}` | read |
| `prepare_scene` | `POST /api/v1/scenes/{sceneId}/prepare` | read |

### scene-diff

流程配置与当前固定发布版的只读差异预览；权威服务按稳定ID/key比较场景、输入、步骤/提示词/ComfyUI绑定、输出和关联预设，增删改/顺序变化；发布同源能力规范化但不代替校验，草稿哈希核对、diff revision绑定分页/大值Unicode分段、变更409重读；不保存/发布/生成

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `get_scene_draft_diff` | `GET /api/v1/scenes/{sceneId}/draft/diff` | read |
| `get_scene_draft_diff_value` | `GET /api/v1/scenes/{sceneId}/draft/diff/value` | read |

### option-presets

共享选项依赖与revision保护

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `list_option_presets` | `GET /api/v1/option-presets` | read |
| `save_option_preset` | `POST /api/v1/option-presets` | write |
| `delete_option_preset` | `DELETE /api/v1/option-presets/{presetId}` | write |

### runs

固定发布版执行、管理员分页历史/详情含服务端验证并记录的提交人身份快照；步骤和for_each各项保存startedAt/durationMs；get_run保存已执行Hermes步骤实际发送提示词agentPrompt，解析或输出校验失败时保存完整未trim原始回复agentResponse，for_each按item.agentPrompt/agentResponse保存；get_step_result可分页读逐项用时与原始回复；有界等待、事件、取消和恢复

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `submit_scene` | `POST /api/v1/scenes/{sceneId}/runs` | execute |
| `list_runs` | `GET /api/v1/runs` | read |
| `get_run` | `GET /api/v1/runs/{runId}` | read |
| `wait_run` | `GET /api/v1/runs/{runId}/wait` | read |
| `get_run_events` | `GET /api/v1/runs/{runId}/events/history` | read |
| `cancel_run` | `POST /api/v1/runs/{runId}/cancel` | execute |
| `resume_run` | `POST /api/v1/runs/{sourceRunId}/resume` | execute |

### results

最终输出/单步/逐项按需读取和媒体引用；可选textOffset/textLimit按Unicode码点读取长文本，Hermes失败原始回复agentResponse同样分页且明确valuePage与页预算，不静默截断

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `get_run_outputs` | `GET /api/v1/runs/{runId}/outputs` | read |
| `get_step_result` | `GET /api/v1/runs/{runId}/steps/{stepId}/result` | read |

### revision-and-review

修订反馈、局部重做预览和执行、显式审核

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `preview_rerun` | `POST /api/v1/runs/{sourceRunId}/rerun/preview` | read |
| `rerun` | `POST /api/v1/runs/{sourceRunId}/rerun` | execute |
| `review_run` | `POST /api/v1/runs/{runId}/review` | execute |

### asset-execution-access

UI/HTTP/MCP复用权威素材服务；assetId+assetVersion固定版本解析为同一任务私有归档，Hermes/AIXG读取字节构造inline图片、ComfyUI按参考图顺序上传同一来源；基础audio_list从已授权固定音色私有路径（含media.select_references/data.zip中间JSON）读取原字节，按引用顺序上传再连接LoadAudio；每文件100MB、合法既有附件不重传、preview不回退、失败在prompt前停止且不自动重试，机器契约audioConsumers；Hermes保留现有预算/压缩，不改选版本，不依赖受保护previewUrl或转发工作台token；管理员兼容本后台同源/相对固定素材URL，预检提前拒绝错误版本/类型/丢失文件；普通用户仍仅本人固定引用；原运行不变、显式断点续跑不盲重放

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `get_scene` | `GET /api/v1/scenes/{sceneId}` | read |
| `prepare_scene` | `POST /api/v1/scenes/{sceneId}/prepare` | read |
| `submit_scene` | `POST /api/v1/scenes/{sceneId}/runs` | execute |
| `get_asset` | `GET /api/v1/assets/{assetId}` | read |
| `get_asset_version` | `GET /api/v1/assets/{assetId}/versions/{version}` | read |
| `prepare_own_scene` | `POST /api/v1/self/scenes/{sceneId}/prepare` | read |
| `submit_own_scene` | `POST /api/v1/self/scenes/{sceneId}/runs` | execute |
| `get_own_asset` | `GET /api/v1/self/assets/{assetId}` | read |
| `resume_run` | `POST /api/v1/runs/{sourceRunId}/resume` | execute |

### assets

管理员素材库：本地上传/运行收藏、说明/分组/标签检索与筛选、快照分页、固定版本引用、版本分页与生成参数分段、revision写入和稳定createId对账；普通用户另有按身份隔离的本人素材分页目录，可在自己的任务输入中选择固定版本

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `list_assets` | `GET /api/v1/assets` | read |
| `get_asset` | `GET /api/v1/assets/{assetId}` | read |
| `list_asset_versions` | `GET /api/v1/assets/{assetId}/versions` | read |
| `get_asset_version` | `GET /api/v1/assets/{assetId}/versions/{version}` | read |
| `save_asset` | `POST /api/v1/assets` | write |
| `upload_asset` | `POST /api/v1/assets/upload` | write |
| `update_asset` | `PATCH /api/v1/assets/{assetId}` | write |
| `list_own_assets` | `GET /api/v1/self/assets` | read |

### clip-selections

选版清单、修订家族候选与本地合成

| 工具 | HTTP | 副作用 |
| --- | --- | --- |
| `list_clip_selections` | `GET /api/v1/clip-selections` | read |
| `create_clip_selection` | `POST /api/v1/clip-selections` | write |
| `get_clip_selection` | `GET /api/v1/clip-selections/{id}` | read |
| `get_clip_candidates` | `GET /api/v1/clip-selections/{id}/candidates` | read |
| `update_clip_selection` | `PATCH /api/v1/clip-selections/{id}` | write |
| `compose_clip_selection` | `POST /api/v1/clip-selections/{id}/compose` | execute |

## 最小使用闭环

- 已有场景：get_workbench → list_scenes → get_scene（固定版本的输入schema/默认值/示例）→ prepare_scene → submit_scene（先保存UUID runId）→ wait_run → get_run_outputs/get_step_result。
- 能力选型：list_capabilities({tier:basic})优先复用；通用素材映射/图片排版使用media.select_references / media.image_layout；逐项计划/素材/提示词严格对齐用data.zip（rows/first/rest）；精确JSON值schema随目录返回。基础缺口先补强，专用仅做定制节点适配；compatibilityOnly:true只保留旧流程。
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
