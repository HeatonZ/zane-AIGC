# AI 工具目录

由 npm run docs:ai 生成；不要直接编辑。参数细节见 ai-openapi.json，流程/恢复见 ai-operator.md。

## get_task_concurrency

GET /api/v1/settings/task-concurrency

副作用：read

读取全系统流程任务并发配置（固定单例）与 revision、环境默认值、当前 active/queued/preparing 计数。未保存时 revision 为 0、默认取 ZANE_MAX_ACTIVE_RUNS（2，范围1–32）。不启动任务，不接受作用域参数。

## get_system_metrics

GET /api/v1/maintenance/metrics

副作用：read

只读运行时指标：进程（node/平台/运行秒数/RSS/堆）与运行队列（maxActiveRuns、queued/active/preparing/accepting/ready/subscribers、未完成计数）；diagnostics=1 追加 SQLite PRAGMA quick_check。不含场景内容、运行明细或凭据，不执行变更。

## get_system_logs

GET /api/v1/maintenance/logs

副作用：read

只读进程内结构化日志窗口（有界环形缓冲，重启清零；容量 ZANE_LOG_BUFFER_ENTRIES）。excludeEvent 可排除前缀（逗号分隔）。游标是 sequence keyset 锚点、追加安全；换筛选复用旧游标 400 INVALID_LOG_CURSOR，更早条目被容量挤出 409 LOG_PAGE_CHANGED 须重读第一页。字段已脱敏、超长值标记 truncated；不含提示词与运行输入全文。细节见手册 §10.2。

## get_ops_log

GET /api/v1/maintenance/logs/ops

副作用：read

只读运维日志文件尾部；file 只取服务端白名单成员，不接受任意路径（不是文件读取代理）。默认末尾200行（最大2000），可按 level/q 过滤。必须读 complete/scannedWholeFile：complete 才是整份文件，超限只扫描末尾窗口。行已脱敏。细节见手册 §10.2。

## update_task_concurrency

PATCH /api/v1/settings/task-concurrency

副作用：write

用当前 revision 更新系统流程任务并发 maxActiveRuns（1–32），SQLite 即时生效。调高放行排队任务，调低不取消已运行任务；已有排队任务可能开始执行。不提交任务、不审批、不发布、不调用模型。409 或回执丢失先 get_task_concurrency 对账，不自动重放。

## get_notification_webhook

GET /api/v1/settings/notification-webhook

副作用：read

读取运行事件聚合通知的固定单例配置、revision、投递统计与可用平台适配器（formats：id/label/maxChars）。地址含平台 token：只返回 urlMasked 与 hasUrl，明文永不回显。只读，不发送通知、不执行生成。

## update_notification_webhook

PATCH /api/v1/settings/notification-webhook

副作用：write

用当前 revision 更新运行事件聚合通知：url 三态（省略=保持、空串=清除、非空=替换）、webhookFormat（discord|slack|feishu|generic）、events（白名单，完整替换）、aggregateSeconds（5–300）、enabled，以及入站转发的 relayEnabled/relayToken（同样三态）。启用要求已有地址且至少 1 个事件；清空地址同时关闭转发。地址明文存本机 SQLite，读接口只回掩码。仅改配置，不发送、不执行；409 或回执丢失先 get_notification_webhook 对账。

## test_notification_webhook

POST /api/v1/settings/notification-webhook/test

副作用：write

按已保存适配器向该地址真实发送一条固定测试消息。唯一立即出网的配置操作：一次请求、不重试（429/5xx 最多再试一次），失败返回 sent:false 与脱敏摘要而非抛错。不改配置、不调用模型、不计费。

## relay_notification

POST /api/v1/settings/notification-webhook/relay

副作用：write

管理员把一段内容转发到已配置的目标 Webhook（与外部系统的入站转发共用投递与适配器，但用管理员身份而非 relay token）。接受任意形状：纯文本、任意 JSON、表单、Slack/Discord/飞书原生载荷都归一成文本，只有空内容才 400。目标与平台只来自服务端配置，请求体不能指定目标；正文按平台上限截断。同步返回 relayed/status/target/chars/truncated；目标拒绝返回 relayed:false 而非抛错。

## get_run_media_export

GET /api/v1/runs/{runId}/media-export

副作用：read

读取指定最终/步骤媒体输出的归档ZIP信息；只核对已归档文件，不生成、不下载远程媒体。仅终态；返回 incomplete/fileCount/revision 与需鉴权 downloadUrl，下载必须用该 revision（内容变化409重读）。清单与媒体用 get_run_outputs/get_step_result。

## get_local_export

GET /api/v1/settings/local-export

副作用：read

读取本地导出根目录（固定单例）与 revision。这是 core.code localExport 写盘与 fileAccess 读文件共用的唯一授权边界：只允许根目录内部，两者各自独立开关。沙箱没有文件系统权限。未配置时分别报 LOCAL_EXPORT_DISABLED / FILE_ACCESS_DISABLED。只读。契约 x-local-export、x-local-file-access。

## update_local_export

PATCH /api/v1/settings/local-export

副作用：write

用当前 revision 设置本地导出根目录 root（绝对路径、不能是盘符根；空串关闭该能力）。保存前真实创建并写入探测。该 root 是 localExport 与 fileAccess 的唯一安全边界：任何 target/路径归一化后必须落在其内，否则 LOCAL_EXPORT_OUTSIDE_ROOT / FILE_OUTSIDE_ROOT，符号链接指向根外同样拒绝。仅改配置，不发布、不执行。409 或回执丢失先 get_local_export 对账。

## list_direct_llm_providers

GET /api/v1/settings/direct-llm/providers

副作用：read

分页读取「直连模型提供商」注册表与列表 revision；core.llm 步骤 direct=true 时按该提供商的 protocol 直接请求，完全不走 Hermes。密钥以明文存本机 SQLite（产品选定），读接口永不回显明文、只给 credential.apiKeyMasked 与 hasApiKey；baseUrl 允许本机/内网。含保留的默认提供商（providerId direct-llm-default，reservedDefault，不可删除）。默认limit24、最大100；目录变化 409 DIRECT_LLM_PROVIDER_PAGE_CHANGED 重读第一页。契约 x-direct-llm v2，细节见手册 §1.4。

## get_direct_llm_provider

GET /api/v1/settings/direct-llm/providers/{providerId}

副作用：read

按稳定 providerId 读取该提供商的配置、revision、origin 与可用模型缓存。origin=saved 时 revision 从 1 起；legacy-singleton/environment 表示来自 1.5.39 单例或环境默认值（revision=0），首次保存会写成新式文档。永不返回密钥明文。不存在返回 404 DIRECT_LLM_PROVIDER_NOT_FOUND。只读，不调用模型。

## create_direct_llm_provider

POST /api/v1/settings/direct-llm/providers

副作用：write

新建一个直连模型提供商。providerId 由客户端预生成并持久保存：回执丢失用 get_direct_llm_provider 读同一 ID 对账，不换 ID 重建；重复 ID 返回 409 PROVIDER_ALREADY_EXISTS（不是幂等成功）。必填 providerId/name/protocol/baseUrl，且 apiKey 与 apiKeyEnv 至少填一个。apiKey 明文写入本机 SQLite，读接口只回掩码与末4位。enabled=true 需配置齐全，否则400。只改配置，不执行、不计费。

## update_direct_llm_provider

PATCH /api/v1/settings/direct-llm/providers/{providerId}

副作用：write

用当前 revision 更新 name/protocol/baseUrl/apiKey/apiKeyEnv/enabled（models 省略=保持、给出=完整替换）；providerId 不可改。apiKey 三态：省略=保持已保存密钥（只改名称或地址不会清空）、空串=清除、非空=替换。首次保存保留的默认提供商会写成新式文档并删除旧单例，避免同一 ID 两个真相。409 或回执丢失先读同一 ID 对账。只改配置，不执行、不计费。

## delete_direct_llm_provider

DELETE /api/v1/settings/direct-llm/providers/{providerId}

副作用：write

用当前 revision 删除一个直连模型提供商记录。保留的默认提供商拒绝删除（400）：改为 update 置 enabled=false，或让步骤显式选择另一个。删除只移除配置记录：不删除历史运行、媒体、素材或已发布快照；引用它的新执行会明确失败。409 或回执丢失先 list_direct_llm_providers 对账。

## query_direct_llm_models

POST /api/v1/settings/direct-llm/providers/{providerId}/models

副作用：write

按该提供商协议 GET <baseUrl>/models（真实访问一次，用保存的明文密钥或 apiKeyEnv 指向的环境变量），成功后与已有 models 合并去重并更新 modelsFetchedAt。手填模型永不丢失，返回 data:[] 也不清空本地列表。只发一次 GET、不重试、不调用模型、不计费。失败明确报错并带上游状态码，绝不用空列表冒充成功。并发改动返回409，本次结果不写入。

## get_own_run_media_export

GET /api/v1/self/runs/{runId}/media-export

副作用：read

本人终态运行媒体归档ZIP信息；实时身份、场景授权与归属校验，与管理员复用同一导出服务。可用stepId显式导出已完成部分，不读取任意路径、不调用模型；返回固定revision下载地址。

## get_workbench_upgrade

GET /api/v1/maintenance/upgrade

副作用：read

只读本地安全升级回执；可按原 UUID operationId 精确对账，省略读最近一次。返回 revision/state/checkPassed/阻塞原因/下一步，不执行构建、不关停、不审批、不续跑。升级只由本机专用 npm run update:prod 执行；没有远程任意命令或数据库执行代理。未知回执沿用原 ID，不能重投新升级。

## get_runtime_release

GET /api/v1/self/runtime-release

副作用：read

已认证用户只读当前工作台 releaseId、契约版本与环境；不含运维路径、进程或凭据。只提示可刷新，不自动刷新或恢复 outbox；不生成、不执行升级。

## submit_system_feedback

POST /api/v1/self/system-feedback

副作用：write

提交系统问题/建议给管理员；不发送给 Agent、不生成、不修改模板。调用前保存 UUID feedbackId；关联 runId 必须为可读取任务。回执丢失先 get_own_system_feedback 按原 ID 对账，404 后显式决定是否原 ID 提交；不能自动换 ID 或重放。重复 ID 返回 409 SYSTEM_FEEDBACK_ALREADY_EXISTS。

## list_own_system_feedback

GET /api/v1/self/system-feedback

副作用：read

仅本人反馈，status 可选，limit 默认50/最大200；身份/状态/revision 绑定分页。列表省略 description/reply 并明确标记，详情完整读取；旧游标 409 重读首页。

## get_own_system_feedback

GET /api/v1/self/system-feedback/{feedbackId}

副作用：read

按原 feedbackId 读取本人反馈完整正文、管理员回复、status/revision；他人或不存在 404。只读，不向 Agent 注入内容。

## list_system_feedback

GET /api/v1/system-feedback

副作用：read

仅管理员分页读取系统反馈；status 可选，limit 默认50/最大200，列表明确省略正文/回复。先 get_system_feedback 完整读取再处理。

## get_system_feedback

GET /api/v1/system-feedback/{feedbackId}

副作用：read

仅管理员完整读取系统反馈和当前 revision，不执行模型。

## handle_system_feedback

POST /api/v1/system-feedback/{feedbackId}/handle

副作用：write

仅管理员以当前 revision 更新处理状态和回复（必填）。pending→processing/resolved/rejected；processing 可回复或结束；已结束须先回 processing 显式重开，不能改回 pending。只更新反馈，不进入 Agent 提示词、不发布、不执行。409 或回执丢失先 get_system_feedback 对账，不自动重放。

## get_current_user

GET /api/v1/self/account

副作用：read

读取凭证所属用户与角色，不能指定其他 userId。普通用户只使用 self 操作；管理员可管理场景与用户。

## list_users

GET /api/v1/users

副作用：read

仅管理员。revision 绑定分页读取用户、状态和场景授权，不返回密码或会话。

## get_user

GET /api/v1/users/{userId}

副作用：read

仅管理员。读取用户和 sceneIds，编辑/授权前保存 revision。

## create_user

POST /api/v1/users

副作用：write

仅管理员。保存 userId 后创建，默认 user 且空授权。密码至少10字符；响应丢失按同一 ID 对账，不重建。

## update_user

PATCH /api/v1/users/{userId}

副作用：write

仅管理员。revision 保护名称/角色/启停。角色或状态变化使旧会话和 AI 凭证失效；不能降级/停用最后管理员。普通用户可用范围由卡密绑定的服务决定。

## set_user_scene_access

POST /api/v1/users/{userId}/scene-access

副作用：write

仅管理员。用 revision 设置完整 sceneIds 授权集（兼容旧账户与直接跑场景；卡密用户由绑定服务授权）。不发布、不执行；新场景不自动授权。

## reset_user_password

POST /api/v1/users/{userId}/password

副作用：write

仅管理员。revision 保护重置密码，所有旧会话/AI 凭证失效。敏感参数不要记录或转发。

## get_own_credits

GET /api/v1/self/credits

副作用：read

本人积分余额与在跑占用：available=balance（预扣已扣进余额），reserved 只作对账。只读。口径见手册 §12。

## list_own_credit_entries

GET /api/v1/self/credits/entries

副作用：read

本人积分流水分页（新到旧，keyset 游标）：kind 区分兑换/调账/预扣/结算，ref_id 可反查运行。只读。

## redeem_own_code

POST /api/v1/self/credits/redeem

副作用：write

兑换本人卡密：与记账同事务，同码重复提交返回已兑换回执不重复加分；无效/已用/作废统一拒绝防枚举。

## list_redeem_batches

GET /api/v1/redeem-batches

副作用：read

仅管理员。卡密批次与未用/已用/作废计数；逐张明文用 list_redeem_codes 读取。

## list_redeem_codes

GET /api/v1/redeem-batches/{batchId}/codes

副作用：read

仅管理员。批次逐张码明细：**完整卡密明文**、状态、面值与兑换人。明文存本机 SQLite 可随时回读；创建于该能力上线前的旧批次 recoverable=false（只有末四位，只能作废重发）。批次不存在 404 REDEEM_BATCH_NOT_FOUND。只读。

## create_redeem_batch

POST /api/v1/redeem-batches

副作用：write

仅管理员。生成卡密批次（≤500张），明文存本机 SQLite 可随时经 list_redeem_codes 回读。**幂等且固定返回 200**，用响应体 created 区分：true=本次新建；false=同 batchId 已存在，返回原批次与它的明文，不新建也不重复发码。

## void_redeem_code

POST /api/v1/redeem-codes/{codeId}/void

副作用：write

仅管理员。作废单张卡密，**已兑换的也可以作废（退款场景）**：默认 reclaim=true 按面值从兑换人账户收回并写 cdk_refund 负向流水（幂等键 cdk_refund:<codeId>）。余额不足不拒绝：扣到余额为 0 为止，未收回的差额在 shortfall 返回，永不出现负余额。reclaim=false 只作废不退分。作废后不可再兑换；重复调用幂等。卡即身份：兑换人失去最后一枚有效卡时账户自动停用（suspendedUsers），会话与AI凭证立即失效，换新卡即恢复。

## void_redeem_batch

POST /api/v1/redeem-batches/{batchId}/void

副作用：write

仅管理员。整批作废：默认 includeRedeemed=true，未使用的全部作废、已兑换的逐张按 reclaim（默认 true）收回；余额不足的扣到 0 为止并照样作废，缺口合计在 shortfall、逐张缺口在 partial 返回。includeRedeemed=false 退回旧行为（只作废未使用的）。重复调用幂等。失去最后一枚有效卡的用户自动停用（suspendedUsers）。见手册 §12。

## get_credit_reconciliation

GET /api/v1/settings/credits/reconciliation

副作用：read

仅管理员。积分账本对账（只读）：逐账户列出余额、流水累计、未结算预扣，并单列余额≠流水（绕过账本）与退款超过预扣（多退）两类异常。结算写错时余额与流水仍然一致，所以必须同时看 reserved；只报告事实与计数，不自动修复。

## adjust_user_credits

POST /api/v1/users/{userId}/credits

副作用：write

仅管理员。按 revision 加减积分（正赠负收），必须写 note；余额不能为负，旧 revision 409 后重读。只写账本。

## list_available_scenes

GET /api/v1/self/scenes

副作用：read

分页读取当前用户授权且已发布的业务目录；标题取发布版，不返回草稿。游标绑定目录和授权 revision。

## list_available_packages

GET /api/v1/self/packages

副作用：read

用户面产品目录：只列已授权且已发布的包。

## get_available_package

GET /api/v1/self/packages/{packageId}

副作用：read

读取已授权包的固定发布版：包级输入、项名与确认点、余额，以及 presentation（用户页区块与主题）。

## prepare_own_package

POST /api/v1/self/packages/{packageId}/prepare

副作用：read

包预检（无副作用）：返回上限价 costPlan 与余额，不创建运行。

## submit_own_package

POST /api/v1/self/packages/{packageId}/runs

副作用：execute

提交包：一次预扣全部上限价，逐项串行提交。保存 packageRunId；丢回执只查同一ID；遇确认点/失败/取消即停。

## list_own_package_runs

GET /api/v1/self/package-runs

副作用：read

本人服务运行分页：服务级进度、阶段与结算。

## get_own_package_run

GET /api/v1/self/package-runs/{packageRunId}

副作用：read

读取本人服务运行：进度、阶段与结算；确认点给出第几步与 itemId。不含内部组件与错误原文。

## get_own_package_outputs

GET /api/v1/self/package-runs/{packageRunId}/outputs

副作用：read

产出媒体地址。

## get_own_package_run_inputs

GET /api/v1/self/package-runs/{packageRunId}/inputs

副作用：read

只读本人服务运行的原始输入：字段取该次运行固化的包发布快照、值取提交时快照，改版不影响。分页/省略/媒体投影同 get_own_run_inputs。返回值可直接作为 prepare_own_package/submit_own_package 的 inputValues。

## confirm_own_package_item

POST /api/v1/self/package-runs/{packageRunId}/items/{itemId}/confirm

副作用：execute

确认点：approve 继续、redo 重跑本项；失败态用 retry 重试失败项（费用沿用本次预扣）。

## cancel_own_package_run

POST /api/v1/self/package-runs/{packageRunId}/cancel

副作用：write

取消本人包运行：尽力取消在途子运行，按已完成项结算并退还差额。

## list_package_drafts

GET /api/v1/packages

副作用：read

仅管理员。包草稿目录。

## get_package_draft

GET /api/v1/packages/{packageId}

副作用：read

仅管理员。读取包草稿、revision 与已发布版本目录。

## create_package_draft

POST /api/v1/packages

副作用：write

仅管理员。创建包草稿：包级输入 + 组件绑定 + 服务页面（见手册 §13）。校验项ID与引用。不发布。

## update_package_draft

PATCH /api/v1/packages/{packageId}

副作用：write

仅管理员。用当前 revision 修改包草稿（见手册 §13），校验同创建。presentation 省略=保持。

## publish_package

POST /api/v1/packages/{packageId}/publish

副作用：write

仅管理员。发布包：内嵌组件快照并固化定价与页面。先保存 publicationId，重复调用对账。

## set_user_package_access

POST /api/v1/users/{userId}/package-access

副作用：write

仅管理员。用 revision 设置完整包授权集；组件场景无需单独授权。

## get_available_scene

GET /api/v1/self/scenes/{sceneId}

副作用：read

读取当前授权场景的固定发布版业务表单，返回 fields 与 inputSchema。number 字段可含 minimum/maximum；required=false 可留空；hidden=true 仅从网页表单隐藏、仍在输入契约中（HTTP/MCP 可显式提交）；对象数组以 inputMode=object_array 与 itemFields 描述行字段。inputSchema 允许额外输入键透传，已声明字段仍有类型与必填校验。不返回完整工作流、提示词、连接或本机路径。

## prepare_own_scene

POST /api/v1/self/scenes/{sceneId}/prepare

副作用：read

只读预检本人授权、versionId 与输入；对象数组按发布快照 itemFields 逐行校验；允许额外输入键透传并保存在运行输入中。不生成。媒体仅本人上传的 assetId+assetVersion，拒绝任意路径；媒体执行契约见手册 §7。

## submit_own_scene

POST /api/v1/self/scenes/{sceneId}/runs

副作用：execute

可能付费。先保存 runId；服务端由发布快照构造流程与归属，允许额外输入键透传。可选 runTitle（≤120字符）作为运行标题。图片固定版本归档后 Hermes/AIXG 读为 inline 图片、ComfyUI 上传同一来源；不使用 previewUrl 作凭证。版本/授权变化拒绝；响应丢失只查同一 runId。

## list_own_drafts

GET /api/v1/self/drafts

副作用：read

分页读取本人输入草稿元数据，isFavorite 优先、同组 updatedAt 降序、ID 稳定破同序；旧草稿默认未收藏。inputValuesOmitted:true 时用 get_own_draft 读完整输入。收藏变更使旧游标 409 ACCESS_PAGE_CHANGED，重读首页。不是流程草稿。

## get_own_draft

GET /api/v1/self/drafts/{draftId}

副作用：read

读取本人草稿和 revision；历史全局草稿不自动分配给用户。

## set_own_draft_favorite

PATCH /api/v1/self/drafts/{draftId}/favorite

副作用：write

本人草稿收藏或取消收藏，isFavorite 必须是明确布尔目标值。用 get_own_draft 的当前 revision；不改变输入、发布绑定或 updatedAt，不生成。只能操作服务端身份归属的草稿，不接受 userId/owner。409 或回执丢失先按原 draftId 对账，不自动重放。

## save_own_draft

POST /api/v1/self/drafts

副作用：write

保存本人输入草稿。新对象 revision:0；更新用读取到的 revision。先保存 draftId；响应丢失按同一 ID 对账。输入最大512KB。可选 runTitle（≤120字符）与 title（场景标题）分开保存；保存请求是完整替换，省略或留空即清除已保存标题。

## list_own_runs

GET /api/v1/self/runs

副作用：read

按本人归属过滤后分页任务；不会返回其他用户或未归属历史任务。q 按字面匹配运行标题、流程名、场景 ID、运行编号、错误与提交人，只在本人的任务内搜索；游标绑定关键字，换 q 后必须从第一页重读。

## get_own_run

GET /api/v1/self/runs/{runId}

副作用：read

读取本人任务的 revision、固定快照版本、步骤计数与真实时间。每步含 startedAt，结束后写 durationMs；for_each 的 durationMs 是墙钟总历时、不含审核等待。progress 是步骤计数，不是耗时百分比或 ETA。输入/动态分别按需读取，不返回执行流程或内部错误路径。RUN_PREPARING 时稍后查询同一 ID。

## get_own_run_inputs

GET /api/v1/self/runs/{runId}/inputs

副作用：read

只读本人运行原始输入快照，标签/类型/范围取运行快照而非最新场景。inputKey 选字段；valueOffset/valueLimit 分段字符串(Unicode码点)、数组(项)、对象(键)，默认2000、最大8192。maxValueBytes 为单页总值预算，省略明确标记、不能当空值。游标绑定运行/查询/revision，变化 409 RESULT_PAGE_CHANGED 重读首页。不返回媒体本机路径或任意 URL。

## get_own_run_activity

GET /api/v1/self/runs/{runId}/activity

副作用：read

按 sequence 增量分页本人任务的业务事件：排队、执行、步骤/逐项完成与失败、审核和结束。默认30、最大100；hasMore 时用 nextSequence 继续。过滤内部 checkpoint 与错误 payload，不返回日志、提示词或连接配置；空页不代表执行结束，状态用 get_own_run 核验。只读。

## get_own_outputs

GET /api/v1/self/runs/{runId}/outputs

副作用：read

分页读取本人最终结果；数组用 valueOffset/valueLimit；长文本可用 textLimit（最大32768）与 textOffset 按 Unicode 码点读取，valuePage.kind:string 标记。大值明确省略或分段；媒体用权限校验的 output-media 地址，不返回本机路径。

## get_own_step_result

GET /api/v1/self/runs/{runId}/steps/{stepId}

副作用：read

按步骤/逐项读取本人业务结果与真实用时，复用结果分页；长文本可用 textOffset/textLimit 分段。不返回提示词或工作流配置，也不返回管理员可见的 Hermes 原始错误回复。

## wait_own_run

GET /api/v1/self/runs/{runId}/wait

副作用：read

最长30秒等待本人任务。timedOut 不代表失败；返回前再次核验身份。

## cancel_own_run

POST /api/v1/self/runs/{runId}/cancel

副作用：write

请求取消本人已接受任务，无需保留场景授权；仍需有效身份及本人归属，遵循真实状态。

## review_own_run

POST /api/v1/self/runs/{runId}/review

副作用：execute

可能付费。仅本人且仍授权；用最新 reviewId 批准或退回。普通用户不允许 Agent 反馈（问题走 submit_system_feedback），不能改流程、输出或 stepChanges。409 重读，不重放。

## resume_own_run

POST /api/v1/self/runs/{runId}/resume

副作用：execute

按本人既有执行快照续跑，可能付费。保存 newRunId；不能绕过 waiting，不能修改流程或输入。

## list_own_assets

GET /api/v1/self/assets

副作用：read

分页读取本人未归档素材，按名称/说明/分组/标签检索并按媒体类型筛选；不返回他人或未归属历史。摘要省略版本历史与大参数；previewUrl 仅供预览，不是执行端下载凭证。游标绑定身份、筛选与目录快照，ASSET_PAGE_CHANGED 重读第一页。

## upload_own_asset

POST /api/v1/self/assets/upload

副作用：write

上传本人媒体。调用前保存 assetId(UUID)，重复 ID 拒绝；回执丢失用 get_own_asset 对账。filePath 是 MCP 所在机器路径，最大250MB。不执行生成。

## get_own_asset

GET /api/v1/self/assets/{assetId}

副作用：read

按预先保存的 ID 读取本人上传素材与固定版本引用；不返回存储文件路径。

## list_own_tokens

GET /api/v1/self/tokens

副作用：read

分页读取本人 AI 凭证元数据，不返回密钥。禁用/改角色/重置密码使旧凭证失效。

## create_own_token

POST /api/v1/self/tokens

副作用：write

保存 tokenId 后创建90天本人 AI 凭证，继承实时角色与场景授权。token 明文只返回一次，立即保存；丢回执先按原 ID 对账并显式吊销，不重放。

## revoke_own_token

POST /api/v1/self/tokens/{tokenId}/revoke

副作用：write

用当前 revision 吊销本人凭证；不能吊销他人凭证。

## get_workbench

GET /api/v1/ai

副作用：read

首先读取：契约版本、当前身份、可用操作入口与 security（entryMode、管理入口监听类别 managementIngress、登录限流策略；只读发现，AI 不能修改监听或限流配置）。detail（默认 summary）只返回路由/副作用/权限事实并显式标记省略的说明文本，detail=full 返回完整说明。管理员含项目配置与 worker 管理摘要，普通用户仅就绪/接受状态。用户专用入口拒绝管理路径与管理员凭证，429 遵守 Retry-After 不自动重放。不会执行外部生成。

## list_capabilities

GET /api/v1/capabilities

副作用：read

分页读取已安装能力及 usage 适用范围；目录统一、不分基础/专用等级，场景差异用 Profile/提示词/输入输出/ComfyUI 绑定表达，场景特有编排用 core.code。compatibilityOnly:true 仅兼容已有发布快照与历史运行。能力级事实（重试/沙箱限制/端口语义/valueSchema/退役清单）以各能力的 usage 与 description 为唯一来源。compatibilityUsage=true 额外返回退役能力被引用的场景数（仅第一页）。默认limit50、最大100。

## list_hermes_profiles

GET /api/v1/hermes/profiles

副作用：read

只读列出本机 Hermes Home 中真实存在的 Profile（id、是否默认），用于步骤 hermesProfile 与 list_hermes_models 的 profile 参数。只读目录与 config.yaml 存在性，不返回凭证、密钥变量名或网关地址，不修改配置，也不调用模型。

## list_hermes_models

GET /api/v1/hermes/models

副作用：read

按 Profile 只读读取网关模型选择器目录（GET /api/model/options），返回 currentProvider/currentModel 与可分页 Provider 行（slug/显示名/是否当前/是否有凭证/模型ID）。不返回凭证、密钥变量名、上游 base_url 或账号；无凭证 Provider 默认不返回（includeUnconfigured=true 才列出）。只读：不写场景、不发布、不执行、不改 Profile 或网关默认值。目录按 Profile 缓存60秒，refresh=true 绕过；profile 必填且须为本机真实 Profile（否则404 HERMES_PROFILE_NOT_FOUND）；游标变化 409 HERMES_MODEL_PAGE_CHANGED 重读第一页；网关不可达 502 HERMES_MODELS_UNAVAILABLE，此时仍可手工填写 provider 与模型。

## get_workspace_status

GET /api/workspace/status

副作用：read

轻量读取 SQLite 权威工作区 revision、初始化状态与视图边界；与浏览器同源。revision 变化后重读目录/对象，不能用本地缓存覆盖。不会发布或生成。

## get_workspace

GET /api/workspace

副作用：read

读取权威工作区和 revision，包括草稿与发布版本。日常生产优先使用场景工具。

## initialize_workspace

POST /api/workspace/initialize

副作用：write

仅在服务端尚无工作区时初始化；已有工作区返回 created:false，不覆盖。必须提供完整快照；空初始化使用空 scenes/workflows/optionPresets/drafts。网页不读取旧浏览器场景用于初始化；只有显式批量导入才传入已核对的业务数据。

## merge_workspace

POST /api/workspace/merge

副作用：write

三方合并工作区，用于配置场景、流程和发布快照。base 必须是先前读取的原始快照；workspace 是在其上编辑的完整快照。冲突 409 时重新读取与合并，不覆盖数据库或镜像文件。只用于高级批量操作；不生成媒体。

## list_task_drafts

GET /api/v1/task-drafts

副作用：read

管理员分页读取原全局任务草稿；历史不自动分配给用户。isFavorite 优先、同组 createdAt 降序、ID 稳定破同序；默认50、最多200。列表明确省略 summary/inputValues/runResult，完整输入用 get_task_draft、运行结果按 runId 用 get_run 读取。写入用 workspaceRevision 或对象 revision。游标绑定身份与工作区 revision，变化 409 ACCESS_PAGE_CHANGED 重读首页。

## get_task_draft

GET /api/v1/task-drafts/{draftId}

副作用：read

管理员按 ID 读取原全局任务草稿的完整摘要/输入及 isFavorite；返回的 revision 是当前工作区整数，用于收藏写入。旧草稿默认未收藏。runResult 明确省略，提供 runId 时用 get_run 读取；不生成，不改归属。

## set_task_draft_favorite

PATCH /api/v1/task-drafts/{draftId}/favorite

副作用：write

管理员收藏/取消收藏原全局任务草稿；isFavorite 必须为明确布尔目标值，revision 用 get_task_draft 的工作区整数。与 UI 共用 SQLite 工作区及锁，不修改内容、createdAt、发布或执行状态；同值不增加 revision。409 或回执丢失按原 draftId 对账，不自动重放或换 ID。

## list_scenes

GET /api/v1/scenes

副作用：read

分页读取与浏览器同序的草稿场景目录。title/summary 属于草稿，publishedTitle/publishedSummary 属于当前发布快照，draftRevision 与 draftMatchesPublished 用于核对差异。默认limit50、最大200；hasMore 时按 nextCursor 继续；目录变更 409 SCENE_PAGE_CHANGED 重读第一页。创作仍用 get_scene 的发布版，不能自动发布草稿。

## create_scene

POST /api/v1/scenes

副作用：write

创建单场景草稿及流程，可附带它引用的新预设；空工作区原子初始化。scene.id 先保存，响应丢失读同一 ID、不换 ID 重建。不会发布或生成。步骤支持 startCondition 开始条件（不满足即跳过、输出按 null 参与下游）与 for_each 执行配置。字段细节见手册 §10、§5.1。

## get_scene_draft

GET /api/v1/scenes/{sceneId}/draft

副作用：read

读取单场景草稿、关联预设、内容 revision、发布版本目录与缺失预设。scene.title 是草稿展示标题，workflow.name 是独立流程配置名、不作场景标题。不搬整工作区；发布版仍用 get_scene。

## get_scene_draft_diff

GET /api/v1/scenes/{sceneId}/draft/diff

副作用：read

只读预览服务端草稿与当前固定发布快照的字段差异；尚未发布则对空基线显示新增。步骤按发布时同一本地能力规范化，规范化失败返回 preparationWarnings（不阻止预览，但仍须校验）。按稳定 ID/key 对齐，顺序变化单独列出，关联预设取发布快照。返回 baseline/versionId、draftRevision 与独立 diff revision、全量 summary 与分页 changes；大值每侧默认4000码点，complete:false 用 get_scene_draft_diff_value 续读，不静默截断。contentHash 可核对 UI 保存状态；后续页/值必须沿用 revision，变化 409 重读第一页。不会保存、发布或生成。

## get_scene_draft_diff_value

GET /api/v1/scenes/{sceneId}/draft/diff/value

副作用：read

按差异 revision/changeId/side 分段读取一个差异值的完整文本或格式化 JSON；offset/limit 按 Unicode 码点，沿用 nextOffset，complete:true 才读完。409 SCENE_DIFF_CHANGED 重读差异，不拼接不同快照。不存在 404 SCENE_DIFF_CHANGE_NOT_FOUND，越界 400 INVALID_SCENE_DIFF_OFFSET。只读，不保存/发布/执行。

## update_scene_draft

PATCH /api/v1/scenes/{sceneId}/draft

副作用：write

用当前内容 revision 完整替换提供的 scene/workflow 部分（省略部分保持不变，不是深层 patch）；可创建引用的新预设，不暗中覆盖共享预设。数字输入可配 minimum/maximum，required=false 允许留空；步骤可配 startCondition 与 for_each 执行配置，见手册 §5.1。不会发布或执行；冲突返回 currentRevision 后重读。能力级事实（含 ordinalField）以 list_capabilities 的 usage 与 description 为唯一来源。

## validate_scene_draft

POST /api/v1/scenes/{sceneId}/validate

副作用：read

校验指定 revision 草稿的结构、引用、默认值、预设与已安装能力；默认值必须匹配字段类型、select 值须在选项中。无生成副作用，不探测远程服务，也不发布。

## publish_scene

POST /api/v1/scenes/{sceneId}/publish

副作用：write

发布指定 revision 草稿；服务端生成哈希、不可变快照并固定能力版本，不执行生成。调用前保存 publicationId(UUID)，成为 versionId。同 ID 同请求重读可对账，重复调用不会重复发布；仅保留最近10版。

## restore_scene_draft

POST /api/v1/scenes/{sceneId}/restore

副作用：write

用当前 revision 恢复保留的发布版本到草稿，不自动发布。冲突共享预设会克隆并重映射，不影响其他场景；已有运行快照不变。

## delete_scene

DELETE /api/v1/scenes/{sceneId}

副作用：write

用当前草稿 revision 显式删除该场景、草稿及工作区发布目录；不删除历史运行、媒体或素材。只在用户明确要求删除时使用。

## list_option_presets

GET /api/v1/option-presets

副作用：read

分页读取共享选项预设、内容 revision 及引用它的草稿场景；不读取整工作区。

## save_option_preset

POST /api/v1/option-presets

副作用：write

创建/替换完整共享预设：新建省略 revision，修改现有必须带当前 revision。改动影响引用它的草稿，不修改历史发布快照；先查看使用场景。

## delete_option_preset

DELETE /api/v1/option-presets/{presetId}

副作用：write

用当前 revision 删除未被草稿引用的共享预设；有引用返回冲突和 sceneIds，不暗中解除引用。已发布快照不变。

## get_scene

GET /api/v1/scenes/{sceneId}

副作用：read

取得已发布版本的流程、inputSchema/默认值/必填汇总/示例、输出与费用/审核节点。workflow.inputs[].hidden 只影响网页表单展示，字段仍保留在输入契约与执行中（隐藏必填字段需要有效默认值）；对象数组表单用 inputMode=object_array 与 itemFields 定义，并反映在 inputSchema/inputRequirements。inputSchema 允许未声明的额外输入键透传，已声明字段仍有类型与必填校验。场景展示用该快照 scene.title 而非 workflow.name。省略 versionId 读取当前发布版；之后固定返回的 versionId。

## prepare_scene

POST /api/v1/scenes/{sceneId}/prepare

副作用：read

无生成副作用预检：固定已发布版本、填默认值、允许额外输入键透传并保存在运行输入中；额外键不作为场景字段参与字段级校验，已声明字段仍校验类型/选项、必填、素材版本/文件与能力配置。返回执行/审核边界：reviewSteps 列出步骤边界审核与循环内确认点（batch_checkpoint 带 afterItems），外部步骤标注 mayCostMoney。并发引用在此按输入解析，0/负数/小数/超32 返回 400 INVALID_ITERATION_CONCURRENCY，留空=不限制。不是外部服务健康或计费承诺，提交时仍重新校验。媒体首选 assetId+assetVersion 固定引用，返回媒体执行契约（含 audioConsumers）。

## submit_scene

POST /api/v1/scenes/{sceneId}/runs

副作用：execute

执行已确认的发布版场景，可能调用付费 Hermes/ComfyUI，运行失败不自动重试。开始条件不满足的步骤直接跳过（不调用模型或外部服务、不计费），输出为 null、下游按 null 继续。必须提供固定 versionId 与预先保存的 runId；响应丢失只查同一 runId，不换 ID 再提交。素材固定版本由后端解析并归档（Hermes/AIXG 转 inline 图片，ComfyUI 上传同一来源）；audio_list 上传契约见 x-asset-media-execution.audioConsumers；UI 格式工作流按 x-comfy-ui-routing 解析 Reroute 链与扇出（循环/缺失/多来源/非零出口 400 INVALID_COMFY_REROUTE）；运行绑定后按 x-comfy-static-switch 只断开已证明静态布尔值的 ComfySwitchNode 未选中输入；Hermes 返回按 x-hermes-output-json 严格解析。细节见手册 §3、§7。

## list_runs

GET /api/v1/runs

副作用：read

分页查询运行摘要，保留 nextCursor 继续读取。每条含服务端绑定的 ownerUserId 与 submitter 身份快照；旧记录有归属但无快照时按当前档案补齐，不改写历史。q 按字面（% 与 _ 不当通配）匹配运行标题、流程名、场景 ID、运行编号、错误与提交人，并把结果限定在该关键字内；游标绑定当前筛选，换 q/status/sceneId 后必须从第一页重读，不拼接不同查询的页。

## get_run_outputs

GET /api/v1/runs/{runId}/outputs

副作用：read

按 outputKey 读取最终输出；目录 cursor 分页，数组 valueOffset/valueLimit 分段，长文本可显式传 textOffset/textLimit 按 Unicode 码点分段（最大32768）。includeValues:false 只取元数据，值超 maxValueBytes 明确省略，不静默截断；媒体含精确 source 与 HTTP 预览地址。

## get_step_result

GET /api/v1/runs/{runId}/steps/{stepId}/result

副作用：read

读取指定步骤结果与真实用时，不带提示词、输入或完整流程。可指定 outputKey/itemIndex；foreach 结果 cursor 分页、数组值分段，文本可显式 textOffset/textLimit 分段；Hermes 解析或输出校验失败时返回完整原始回复的分页投影，保留首尾空白。结果变化（含 warnings 或原始回复）时旧 cursor 409 重读第一页。warnings 为非阻断提示，不当成 error 或自动重试原因。

## get_run

GET /api/v1/runs/{runId}

副作用：read

读取完整运行快照、输入、步骤结果、pendingReview 与输出，并返回 submitter 身份快照。步骤与 for_each 各项含 startedAt 与结束后的 durationMs；已执行 Hermes 步骤含实际发送的 agentPrompt（for_each 在各 item.agentPrompt），解析或输出校验失败时保存完整未 trim 的原始回复 agentResponse（用 get_step_result 分页读取）。旧记录有归属但无快照时按当前档案补齐，不改写历史；原失败快照不因后台修复而改写。waiting 是审核不是失败；pendingReview.scope=batch_items 表示 for_each 循环内确认点（步骤仍 running，afterItems 是已产出项数）；stale 需显式恢复。

## wait_run

GET /api/v1/runs/{runId}/wait

副作用：read

最多等待30秒，到终态或 waiting 即返回摘要、提交人快照与审核信息。不取消后台运行。timedOut:true 仅表示等待窗口耗尽，继续查询；最终输出用 get_run_outputs，事件用 get_run_events。

## get_run_events

GET /api/v1/runs/{runId}/events/history

副作用：read

按 sequence 游标读取持久化事件；下一次 after 使用 nextSequence，避免重复消费。

## cancel_run

POST /api/v1/runs/{runId}/cancel

副作用：execute

显式取消此运行；已发送的外部请求未必能撤销费用。cancelling 时继续等待收尾，不把迟到结果当成功。

## resume_run

POST /api/v1/runs/{sourceRunId}/resume

副作用：execute

从非活动、非 waiting 运行创建新运行，复用已持久化的完成步骤；未 checkpoint 的外部请求可能重做/计费，不是 exactly-once。必须保存新 runId。状态传递 for_each 仅复用来源值匹配、状态有效的连续完成前缀，缺口后全部重算；失败停止后续项。H3 生成前按 x-h3-prompt-sections 归一化已声明标题，缺段/重复/顺序问题只记 warnings、不阻止生成、不补正文、不重调已完成 Writer/AIXG。

## preview_rerun

POST /api/v1/runs/{sourceRunId}/rerun/preview

副作用：read

先预览局部修改会复用/替换/重跑哪些节点和镜头；不执行生成。changes 里的配置对象是完整替换，不是局部 merge。Hermes 结果可用 changes.feedback 提交 stepId、可选 itemIndex 和 message，不必改提示词。

## rerun

POST /api/v1/runs/{sourceRunId}/rerun

副作用：execute

执行先前预览的局部重做，可能付费；changes 必须与确认的预览一致。必须保存新 runId；响应丢失只查该 ID。waiting 不可绕过审核。

## review_run

POST /api/v1/runs/{runId}/review

副作用：execute

处理当前 pendingReview：approve 可启动后续付费生成，redo 重做当前步骤并再次审核。必须使用最新 reviewId；outputs 编辑仅单次节点，foreach 是整批审核、不支持 outputs 编辑。pendingReview.scope=batch_items 表示 for_each 循环内确认点（execution.reviewAfterItems=N）：approve 复用已完成的前 N 项继续剩余项、不再在该点暂停，redo 重做截至该点的这一段并再次暂停；都不重复生成已确认的前段。Hermes redo 可填 feedback，连同原结果交模型修订并保存历史。409 后重读，不重放旧决定。

## get_run_audit

GET /api/v1/runs/{runId}/audit

副作用：read

只读一次运行的质检材料包（契约 x-run-quality v1）：有界、可续读、带省略标记的证据索引——运行身份与固定发布版本、血缘、pendingReview、脱敏且受预算的输入值、逐步状态/真实用时/警告/审核状态/逐项计数/输出元数据，以及该步骤实际发出的提示词与解析失败时才保存的原始回复（按 promptLimit 截断，默认2000、最大8000码点，另有整包预算）。省略或未读完的项给出 promptPage 与 nextAction；for_each 只内联前 itemSample 项（默认2、最大10）；步骤与最终输出一律不内联值，只给元数据。不返回本机路径、归档目录、提示词模板或连接配置。只读，不生成、不调用模型、不计费。

## request_step_agent_feedback

POST /api/v1/runs/{runId}/steps/{stepId}/feedback

副作用：execute

把一条反馈连同执行期上下文交给该步骤原本调用的 Agent 一次，返回原文与按该步骤输出契约解析的修订结果——**不重做**：不排队、不新建运行、不写运行记录、不改场景、不发布、不生成媒体（契约 x-step-agent-feedback v1）。上下文按运行快照真实重建（解析后的步骤输入、上游结果、逐项来源项、原结果与步骤级 Profile/provider/model），结论与后续重做一致；不返回完整提示词。真实调用模型、可能计费、一次请求不自动重试；解析失败返回 502 STEP_FEEDBACK_AGENT_FAILED 并带一段原文，回执丢失核实后自行决定是否重发（会再次计费）。要采纳修订仍须显式走反馈重做链路（review_run redo 或 preview_rerun/rerun 的 changes.feedback），两者共用同一份反馈校验。仅管理员，见手册 §6。

## submit_run_critique

POST /api/v1/runs/{runId}/critiques

副作用：write

为一次运行提交结构化质检意见（契约 x-run-quality v1）：verdict=pass|warn|fail、可选0–100分、summary、findings（severity/category/evidence/stepId/itemIndex）与 recommendations。先保存 critiqueId（UUID）：重复 ID 返回 409 RUN_CRITIQUE_ALREADY_EXISTS（不是幂等成功），回执丢失读同一 ID 对账、不换 ID 重投。source 只接受 manual|agent；source=hermes 由 audit_run_with_hermes 独占写入。findings 省略 id 时服务端按顺序补 f1..fN；引用不存在步骤的 finding 直接拒绝，不静默丢弃证据。新记录 revision=1、status=open。只写质检记录，不重跑、不发布、不调用模型、不计费。

## list_run_critiques

GET /api/v1/runs/{runId}/critiques

副作用：read

分页读取一次运行的质检意见索引：按创建时间倒序、ID 稳定破同序，可按 verdict/status 筛选。列表省略正文（summaryOmitted/findingsOmitted/recommendationsOmitted=true），逐条详情用 get_run_critique。游标绑定运行与筛选条件，目录变化 409 ACCESS_PAGE_CHANGED 需重读第一页、不拼接。只读，不执行生成。

## get_run_critique

GET /api/v1/quality/critiques/{critiqueId}

副作用：read

按 critiqueId 读取一条完整质检意见并给出下一步：open→update_run_critique，accepted→preview_rerun（按建议局部重做前先预览），dismissed/fixed→get_run_audit。不存在返回 404 RUN_CRITIQUE_NOT_FOUND。只读，不重跑、不发布、不调用模型。

## update_run_critique

PATCH /api/v1/quality/critiques/{critiqueId}

副作用：write

用当前 revision 收敛一条质检意见的状态：open→accepted|dismissed，accepted→fixed|dismissed，dismissed|fixed→open（显式重开，不允许静默跳转）。可选 note 记录处理理由。非法跳转 409 RUN_CRITIQUE_STATE_CONFLICT；revision 过期 409 RUN_CRITIQUE_REVISION_CONFLICT（重读同一 critiqueId 后再决定，不盲重试）。只更新质检记录，不重跑、不发布、不调用模型、不计费。

## audit_run_with_hermes

POST /api/v1/runs/{runId}/audit/hermes

副作用：execute

直连 Hermes 做第三方质检，**会真实调用模型、可能计费，一次请求不自动重试**：按 get_run_audit 同一份材料包（更小预算）拼装固定提示词，调用工作台已启用的 Hermes Profile（可指定 profile/provider/model），要求只返回一个 JSON 对象 verdict/score/summary/findings/recommendations 并逐字段校验；任一项不符即 502 RUN_AUDIT_INVALID_OUTPUT 且不写入任何记录。通过后写入 source=hermes 的意见（状态 open）。profile 省略取已启用列表第一个（空则 400 RUN_AUDIT_PROFILE_UNAVAILABLE），不存在 404 RUN_AUDIT_PROFILE_NOT_FOUND，超时 RUN_AUDIT_TIMEOUT，网关或凭证失败 RUN_AUDIT_HERMES_FAILED。响应丢失用同一 critiqueId 对账；记录不存在时由操作者显式决定是否重跑（会再次计费）。不改运行、不重跑、不发布、不生成媒体。

## list_assets

GET /api/v1/assets

副作用：read

管理员素材库：按名称/说明/分组/标签检索，kind/category/group/tag 筛选，默认24条最多100条；archived:true 包含归档。仅返回元数据摘要，版本与参数明确省略；用 nextCursor 继续，ASSET_PAGE_CHANGED 重读第一页。执行输入固定 assetId+assetVersion。

## get_asset

GET /api/v1/assets/{assetId}

副作用：read

读取素材元数据、说明、revision、versionCount 与当前固定 reference，不返回版本历史（用 list_asset_versions 按页读取）。可用 createId 对账丢失的创建回执。执行输入直接用 assetId+assetVersion，不把 previewUrl 当下载授权；内部解析不向外部服务转发工作台凭证。

## list_asset_versions

GET /api/v1/assets/{assetId}/versions

副作用：read

按页读取素材版本（从新到旧）与精确 source/sha256/bytes/reference，生成参数明确省略。游标绑定素材 revision、对象与身份；变化需重读第一页。

## get_asset_version

GET /api/v1/assets/{assetId}/versions/{version}

副作用：read

读取一个固定素材版本，不生成、不下载。includeParameters:true 按 JSON 字符分段读取生成参数（默认8000、最多16000）；hasMore 时沿 nextOffset 继续，拼完再解析，不能把片段当完整 JSON。媒体 GET/HEAD/Range 地址在 reference。

## save_asset

POST /api/v1/assets

副作用：write

将完成步骤或最终输出收藏为素材。source 精确定位输出；新建先保存 createId，新增版本带 assetId+当前 revision，二者互斥。可保存 description/group/tags 供 AI 检索。可能复制/下载输出，不重新生成；丢回执先 get_asset 对账，不换 ID 重投。

## upload_asset

POST /api/v1/assets/upload

副作用：write

上传 MCP 所在机器的本地媒体（最多250MB），filePath 须绝对路径。新建先保存 createId，新增版本带 assetId+revision。支持 description/group/tags；返回固定 reference，无完整历史。丢回执先查询原 ID；不会自动重试。

## update_asset

PATCH /api/v1/assets/{assetId}

副作用：write

部分更新名称/说明/分类/分组/标签/归档；不删除版本，tags 提供时完整替换。必须带当前 revision，409 重读。归档后历史固定引用仍可用。

## list_clip_selections

GET /api/v1/clip-selections

副作用：read

查询持久化镜头选版清单；runId 筛选同一续跑/修订家族。

## create_clip_selection

POST /api/v1/clip-selections

副作用：write

从终态运行的 foreach 视频步骤创建选片清单；成功镜头自动固定为素材版本，失败镜头保留空位。

## get_clip_selection

GET /api/v1/clip-selections/{id}

副作用：read

读取清单、revision、完整 shotId、选择与 lastRunId；不要猜镜头 ID。

## get_clip_candidates

GET /api/v1/clip-selections/{id}/candidates

副作用：read

查询同一修订家族且分镜内容一致的镜头候选及媒体地址。

## update_clip_selection

PATCH /api/v1/clip-selections/{id}

副作用：write

用当前 revision 修改名称、完整 shotOrder 或一个 shotId 的 source；source:null 清除该镜头。候选选择会固定媒体版本，不自动跟随新生成。

## compose_clip_selection

POST /api/v1/clip-selections/{id}/compose

副作用：execute

按完整选片清单创建仅本地自定义代码整理运行，按镜头顺序输出成片媒体序列与清单 JSON，不调用模型、不生成新媒体文件。需要最新 revision 与保存的新 runId。缺镜头拒绝整理；丢回执先查询 runId 与清单 lastRunId。

## list_tasks

GET /api/v1/tasks

副作用：read

分页读取任务目录。任务=批量执行容器：一个任务含多个任务项，每项固定自己的「已发布场景+versionId+输入」，用于连续出多张图而不必建多条运行记录。进度完全由各项运行状态投影，不是另一套状态机。列表省略 items 与 inputValues 并标记 itemsOmitted，用 get_task 读完整项。游标绑定任务目录快照，变化 409 ACCESS_PAGE_CHANGED 重读第一页。只读，不生成。

## get_task

GET /api/v1/tasks/{taskId}

副作用：read

读取单个任务的完整任务项（每项 inputValues/state/runId/reviewId/attemptCount/lastError）与进度。status 为 draft 时任务项仍可编辑；confirmedAt 非空后输入冻结，只能 rerun_task_item。只读，不生成。

## create_task

POST /api/v1/tasks

副作用：write

创建任务草稿（中间态）：一次最多200个任务项，每项独立指定 sceneId+versionId+inputValues，因此可跨场景、跨发布版。创建时逐项按发布快照校验输入类型/选项与固定素材版本，但不校验必填——草稿允许缺，确认前补齐即可；不发布、不生成、不提交运行，确认前可反复修改。任务项互相独立、不自动串联数据；需要「下一步依赖上一步」时在场景内用步骤 sourceRef 或 execution.carry 表达。调用前保存 taskId；丢回执用 get_task 读同一 ID 对账，不换 ID 重建。

## update_task

PATCH /api/v1/tasks/{taskId}

副作用：write

用当前 revision 修改确认前任务草稿的名称/说明/任务项（items 为完整替换、不是局部 patch，按位置保留 itemId）。任务项同样逐项校验场景、发布版本与输入类型/选项/素材版本，但不校验必填（与 create_task 同一口径）。已确认（confirmedAt 非空）的任务拒绝编辑并返回 TASK_ALREADY_CONFIRMED，只能单项重跑。不提交运行、不生成；409 后重读同一任务，不盲重试。

## confirm_task

POST /api/v1/tasks/{taskId}/confirm

副作用：execute

确认任务并按项全自动批量提交为互相独立的运行，可能调用付费 Hermes/ComfyUI。确认是单向冻结：先为每项预分配稳定 runId 落库再逐项提交，因此丢回执用同一批 runId 对账、重复调用不会重复提交或重复计费（alreadyConfirmed:true）。冻结前先整体判一次必填：缺项返回 400 TASK_ITEMS_INCOMPLETE（details.items 指出哪几项）且不冻结、不提交、不计费，补齐后用 update_task 保存再确认。单项提交失败不阻断整批，失败项在 failures 中返回并可单独重跑；并发上限、排队、审核与重启恢复复用现有运行队列。跨项依赖不要寄托在提交顺序上。开始前先 get_task 取当前 revision。

## rerun_task_item

POST /api/v1/tasks/{taskId}/items/{itemId}/rerun

副作用：execute

重跑任务的单个任务项，可能计费。旧 runId 保留在 previousRunIds 中以便回溯，不覆盖历史结果。正在执行（TASK_ITEM_ACTIVE）或等待人工确认（REVIEW_REQUIRED）的项拒绝重跑，不能借重跑绕过审核。需确认后的任务与当前 revision。

## cancel_task

POST /api/v1/tasks/{taskId}/cancel

副作用：write

取消任务：标记取消，并尽力取消所有仍在排队/执行/待确认的任务项；已完成的项保留结果，单项取消失败由该项真实状态反映，不回滚也不删除运行记录。可重复调用（已取消时直接返回当前状态）。不删除历史运行、媒体或素材。

## delete_task

DELETE /api/v1/tasks/{taskId}

副作用：write

用当前 revision 显式删除任务记录。不删除历史运行、媒体或素材。仍有排队/执行/等待确认的项时返回 409 TASK_ITEM_ACTIVE，需先取消任务。只在用户明确要求删除任务时使用。
