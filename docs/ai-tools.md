# AI 工具目录

由 npm run docs:ai 生成；不要直接编辑。参数细节见 ai-openapi.json，流程/恢复见 ai-operator.md。

## get_task_concurrency

GET /api/v1/settings/task-concurrency

副作用：read

管理员读取全系统流程任务并发配置（固定单例task-concurrency）、revision、环境默认值和当前active/queued/preparing计数。不启动任务，不分页，不接受userId/project等作用域。未保存时revision为0，ZANE_MAX_ACTIVE_RUNS默认2（1–32），保存后的SQLite配置优先。

## update_task_concurrency

PATCH /api/v1/settings/task-concurrency

副作用：write

管理员用当前revision更新系统流程任务并发maxActiveRuns（整数1–32）。SQLite共享写入、即时生效；调高放行排队任务，调低不取消已运行任务（active可能暂时超过上限），直到active低于新上限才放行。不提交新任务、不审批、不发布、不调用模型；已有排队任务可能开始执行。独立于for_each和ComfyUI资源并发。错误：400 INVALID_TASK_CONCURRENCY_REQUEST、401未认证、403 ADMIN_REQUIRED、409 RESOURCE_REVISION_CONFLICT。409或响应丢失先get_task_concurrency按同一固定ID对账，不自动重放。

## get_run_media_export

GET /api/v1/runs/{runId}/media-export

副作用：read

读取指定最终/步骤媒体输出的归档ZIP信息；只核对已归档文件，不生成、不下载远程媒体。仅终态，stepId可导出已完成部分，返回incomplete、fileCount、revision和需鉴权downloadUrl。下载必须使用该revision；内容变化409重新读取。清单/媒体按既有get_run_outputs/get_step_result分页查看。

## get_own_run_media_export

GET /api/v1/self/runs/{runId}/media-export

副作用：read

本人终态运行媒体归档ZIP信息；实时身份、场景授权与归属校验，与管理员复用同一导出服务。可用stepId显式导出已完成部分，不读取任意路径、不调用模型；返回固定revision下载地址。

## get_workbench_upgrade

GET /api/v1/maintenance/upgrade

副作用：read

管理员只读本地安全升级回执；可按原UUID operationId精确对账，省略读取最近一次。返回revision/state/checkPassed/阻塞原因/下一步，不执行构建、不关停、不审批、不续跑。升级由本机专用 npm run update:prod 管理脚本执行；没有远程任意命令、文件或数据库执行代理。未知回执沿用原ID，不能重投新升级。

## get_runtime_release

GET /api/v1/self/runtime-release

副作用：read

已认证用户只读当前工作台releaseId、契约版本与环境；不含运维路径、进程或凭据。只提示可刷新，不自动刷新或恢复outbox；不生成、不执行升级。

## submit_system_feedback

POST /api/v1/self/system-feedback

副作用：write

提交系统问题/建议给管理员；不发送给Agent、不生成、不修改模板。调用前保存UUID feedbackId；关联runId必须为可读取任务。回执丢失先get_own_system_feedback按原ID对账，404后显式决定是否原ID提交；不能自动换ID或重放。重复ID409 SYSTEM_FEEDBACK_ALREADY_EXISTS。

## list_own_system_feedback

GET /api/v1/self/system-feedback

副作用：read

仅本人反馈，status可选，limit默认50/最大200；身份/状态/revision绑定分页。列表省略description/reply并明确标记，详情完整读取；旧游标409重读首页。

## get_own_system_feedback

GET /api/v1/self/system-feedback/{feedbackId}

副作用：read

按原feedbackId读取本人反馈完整正文、管理员回复、status/revision；他人或不存在404。只读，不向Agent注入内容。

## list_system_feedback

GET /api/v1/system-feedback

副作用：read

仅管理员分页读取系统反馈；status可选，limit默认50/最大200，列表明确省略正文/回复。先get_system_feedback完整读取再处理。

## get_system_feedback

GET /api/v1/system-feedback/{feedbackId}

副作用：read

仅管理员完整读取系统反馈和当前revision，不执行模型。

## handle_system_feedback

POST /api/v1/system-feedback/{feedbackId}/handle

副作用：write

仅管理员以当前revision更新处理状态和回复（必填）。pending可进入processing/resolved/rejected；processing可回复或结束；已结束须先processing显式重开，不能改回pending。只更新反馈，不进入Agent提示词、不发布、不执行。409 SYSTEM_FEEDBACK_REVISION_CONFLICT/STATE_CONFLICT或回执丢失先get_system_feedback对账，不自动重放。

## get_current_user

GET /api/v1/self/account

副作用：read

读取凭证所属用户与角色，不能指定其他userId。普通用户只使用self操作；管理员可管理场景与用户。

## list_users

GET /api/v1/users

副作用：read

仅管理员。revision绑定分页读取用户、状态和场景授权，不返回密码或会话。

## get_user

GET /api/v1/users/{userId}

副作用：read

仅管理员。读取用户和sceneIds，编辑/授权前保存revision。

## create_user

POST /api/v1/users

副作用：write

仅管理员。保存userId后创建，默认user且空授权。密码至少10字符；响应丢失按同一ID对账，不重建。

## update_user

PATCH /api/v1/users/{userId}

副作用：write

仅管理员。revision保护名称/角色/启停。角色或状态变化使旧会话和AI凭证失效；不能降级/停用最后管理员。

## set_user_scene_access

POST /api/v1/users/{userId}/scene-access

副作用：write

仅管理员。用revision设置完整sceneIds授权集，不发布、不执行。新场景不自动授权；未发布场景不在用户目录。

## reset_user_password

POST /api/v1/users/{userId}/password

副作用：write

仅管理员。revision保护重置密码，所有旧会话/AI凭证失效。敏感参数不要记录或转发。

## list_available_scenes

GET /api/v1/self/scenes

副作用：read

分页读取当前用户授权且已发布的业务目录；标题取发布版，不返回草稿。游标绑定目录和授权revision。

## get_available_scene

GET /api/v1/self/scenes/{sceneId}

副作用：read

读取当前授权场景的固定发布版业务表单；返回fields与inputSchema。number字段可配置包含minimum/maximum，填写时服务端按范围校验；required=false时可以不填写。hidden=true表示网页表单隐藏该字段，仍保留在输入契约中，HTTP/MCP可按inputSchema显式提交；对象数组字段以inputMode=object_array和itemFields描述行表单列、类型、必填、数字范围和选项，运行值为类型化JSON数组；inputSchema允许额外输入键透传，已声明字段仍有类型和必填约束；不返回完整工作流、提示词、连接或本机路径。

## prepare_own_scene

POST /api/v1/self/scenes/{sceneId}/prepare

副作用：read

验证本人授权、当前versionId和输入；对象数组按发布快照itemFields校验每行字段、类型、必填和枚举，用户端传类型化对象数组；允许额外输入键透传并保存在运行输入中，已声明字段照常校验；只读预检，不生成。媒体仅本人上传的assetId+assetVersion，拒绝任意路径；媒体执行契约说明Hermes和ComfyUI共享的固定版本来源。

## submit_own_scene

POST /api/v1/self/scenes/{sceneId}/runs

副作用：execute

可能付费。允许额外输入键透传并保存在运行输入中，已声明字段照常校验。先保存runId；服务端由发布快照构造流程和归属。图片固定版本归档后，Hermes/AIXG读取为inline图片，ComfyUI上传同一来源；不使用previewUrl作凭证。版本/授权变化拒绝；响应丢失查询同一runId。

## list_own_drafts

GET /api/v1/self/drafts

副作用：read

分页读取本人输入草稿元数据，isFavorite:true优先、同组updatedAt降序、ID稳定破同序；旧草稿默认未收藏。inputValuesOmitted:true用get_own_draft读取完整输入。收藏变更使旧游标409 ACCESS_PAGE_CHANGED，重读首页。不是流程草稿。

## get_own_draft

GET /api/v1/self/drafts/{draftId}

副作用：read

读取本人草稿和revision；历史全局草稿不自动分配给用户。

## set_own_draft_favorite

PATCH /api/v1/self/drafts/{draftId}/favorite

副作用：write

本人草稿收藏或取消收藏，isFavorite必须是明确布尔目标值。用get_own_draft的当前revision；不改变输入、发布绑定或updatedAt，不生成。只能操作服务端身份归属的草稿，不接受userId/owner。409 DRAFT_REVISION_CONFLICT、5xx或回执丢失先按原draftId对账，不自动重放。

## save_own_draft

POST /api/v1/self/drafts

副作用：write

保存本人输入草稿。新对象revision:0；更新用读取到的revision。先保存draftId；响应丢失按同一ID对账。输入最大512KB；更新保留收藏状态，收藏通过set_own_draft_favorite显式修改。

## list_own_runs

GET /api/v1/self/runs

副作用：read

按本人归属过滤后分页任务；不会返回其他用户或未归属历史任务。

## get_own_run

GET /api/v1/self/runs/{runId}

副作用：read

读取本人任务revision、固定快照版本、步骤总数/完成/跳过/失败/未执行和逐项计数、输出数、审核状态与真实时间。每个已开始步骤含实际startedAt，步骤结束后写入durationMs；运行中用startedAt计算当前已用时间，for_each步骤durationMs是墙钟总历时、不含人工审核等待；历史未保存步骤时间时省略。steps含尚未执行步骤；progress是步骤计数，不是耗时百分比/ETA。startedAt只取持久化run.started事件，排队/历史缺失时省略；totalDurationMs包含排队和审核等待。输入/动态分别按需读取，不返回执行流程或内部错误路径。RUN_PREPARING时稍后查询同一ID。

## get_own_run_inputs

GET /api/v1/self/runs/{runId}/inputs

副作用：read

只读本人运行的原始输入快照，标签/类型/数字范围取运行快照而非最新场景。inputKey按字段选取；limit分页字段，valueOffset/valueLimit分段字符串(Unicode码点)、数组(项)、对象(键)，默认2000、最大8192。maxValueBytes为单页总值预算，省略明确标记，不能当空值。游标绑定运行/查询/revision；变化409 RESULT_PAGE_CHANGED重读首页。不返回媒体本机路径/任意URL，只保留固定素材引用；不执行生成。

## get_own_run_activity

GET /api/v1/self/runs/{runId}/activity

副作用：read

按sequence增量分页本人任务的业务事件：排队、执行、步骤/逐项完成与失败、审核和结束。默认30最大100；hasMore时用nextSequence继续。过滤内部checkpoint和错误payload，不返回日志、提示词、连接配置；空页不意味着执行结束，状态用get_own_run核验。只读。

## get_own_outputs

GET /api/v1/self/runs/{runId}/outputs

副作用：read

分页读取本人最终结果；数组用valueOffset/valueLimit；长文本可加textLimit(最大32768)和textOffset按Unicode码点读取，valuePage.kind:string标记；大值明确省略/分段，媒体使用权限校验的output-media地址，不返回本机路径。

## get_own_step_result

GET /api/v1/self/runs/{runId}/steps/{stepId}

副作用：read

按步骤/逐项读取本人业务结果与真实用时，复用结果分页；步骤和for_each各项有实际startedAt，结束后写入durationMs，运行中用startedAt计算已用时间；长文本可用textOffset/textLimit分段；不返回提示词或工作流配置，也不返回管理员可见的Hermes原始错误回复。

## wait_own_run

GET /api/v1/self/runs/{runId}/wait

副作用：read

最长30秒等待本人任务。timedOut不代表失败；返回前再次核验身份。

## cancel_own_run

POST /api/v1/self/runs/{runId}/cancel

副作用：write

请求取消本人已接受任务，无需保留场景授权；仍需有效身份及本人归属，遵循真实状态。

## review_own_run

POST /api/v1/self/runs/{runId}/review

副作用：execute

可能付费。仅本人且仍授权；使用最新reviewId批准或退回；普通用户不允许Agent反馈，问题使用submit_system_feedback交管理员；不允许改流程、输出或stepChanges。409重读，不重放。

## resume_own_run

POST /api/v1/self/runs/{runId}/resume

副作用：execute

按本人既有执行快照续跑，可能付费。保存newRunId；不能绕过waiting，不能修改流程或输入。

## list_own_assets

GET /api/v1/self/assets

副作用：read

分页读取当前登录用户自己的未归档素材，按名称/说明/分组/标签检索并可按媒体类型筛选；不会返回其他用户或未归属历史。摘要省略版本历史和大参数，reference固定为当前assetVersion；previewUrl仅供浏览器/HTTP预览，不是执行端下载凭证。游标绑定身份、筛选和目录快照，ASSET_PAGE_CHANGED重读第一页。

## upload_own_asset

POST /api/v1/self/assets/upload

副作用：write

上传本人媒体。调用前保存assetId(UUID)，重复ID拒绝；响应丢失用get_own_asset对账。filePath是MCP所在机器路径，最大250MB，不执行生成。

## get_own_asset

GET /api/v1/self/assets/{assetId}

副作用：read

按预先保存ID读取本人上传的素材和固定版本引用；不返回存储文件路径。

## list_own_tokens

GET /api/v1/self/tokens

副作用：read

分页读取本人AI凭证元数据，不返回密钥。禁用/改角色/重置密码使旧凭证失效。

## create_own_token

POST /api/v1/self/tokens

副作用：write

保存tokenId后创建90天本人AI凭证；继承实时角色和场景授权。token明文只返回一次，立即安全保存；丢失回执先对账并显式吊销，不重放。

## revoke_own_token

POST /api/v1/self/tokens/{tokenId}/revoke

副作用：write

用当前revision吊销本人凭证；不可吊销他人凭证。

## get_workbench

GET /api/v1/ai

副作用：read

同时返回security契约版本、entryMode和登录限流策略；用户专用入口仅接受普通用户，拒绝管理路径/管理员凭证，429遵守Retry-After且不自动重放。首先读取工作台契约版本、当前身份与可用操作入口。管理员包含项目配置和worker管理摘要；普通用户仅就绪/接受状态，不返回项目路径或全局运行数量。不会执行外部生成。正式后台就绪后MCP可保留stdio连接并更新适配子进程；接到目录变化通知后重读此入口核对契约，不能重放写入。

## list_capabilities

GET /api/v1/capabilities

副作用：read

分页读取已安装能力及usage适用范围；先查tier:basic，基础步骤能满足就不定制。确有缺口再查specialized并核对whenToUse/basicAlternative；compatibilityOnly:true仅兼容旧流程，不用于新场景。JSON端口/配置的valueSchema提供精确值契约。data.zip按items与等长输入列关联，expected_count校验数量，itemSchema/identityField校验结构与唯一标识，rows/first/rest用于样张和剩余批次；media.select_references支持组内序号数组或all，以及可选bundle逐项媒体包。默认all保留完整目录、基础优先排序。只读，不改场景或执行生成。

## get_workspace_status

GET /api/workspace/status

副作用：read

轻量读取SQLite权威工作区revision、初始化状态与视图边界；与浏览器相同来源。revision变化后重读目录/对象，不能用本地缓存覆盖。不会发布或生成。

## get_workspace

GET /api/workspace

副作用：read

读取权威工作区和 revision，包括草稿与发布版本。日常生产优先使用场景工具。

## initialize_workspace

POST /api/workspace/initialize

副作用：write

仅在服务端尚无工作区时初始化；已有工作区返回 created:false，不覆盖。必须提供完整快照；空初始化使用空scenes/workflows/optionPresets/drafts/sceneVersions。网页不读取旧浏览器场景用于初始化；显式批量导入才传入已核对的业务数据。

## merge_workspace

POST /api/workspace/merge

副作用：write

三方合并工作区，用于配置场景、流程和发布快照。base 必须是先前读取的原始快照；workspace 是在其上编辑的完整快照。冲突409时重新读取与合并，不覆盖数据库或镜像文件。此操作不生成媒体。

## list_task_drafts

GET /api/v1/task-drafts

副作用：read

管理员分页读取原全局任务草稿；历史不自动分配给用户。isFavorite:true优先、同组createdAt降序、ID稳定破同序；默认50最多200。summary/inputValues/runResult在元数据页明确省略；完整输入按get_task_draft读取，运行结果按runId用get_run读取。分页revision是列表哈希，写入用workspaceRevision或对象revision（工作区整数）。游标绑定身份和工作区revision，变化409 ACCESS_PAGE_CHANGED重读首页。不执行。

## get_task_draft

GET /api/v1/task-drafts/{draftId}

副作用：read

管理员按ID读取原全局任务草稿的完整摘要/输入及isFavorite；返回revision是当前工作区整数，用于收藏写入。旧草稿默认未收藏。runResult明确省略，提供runId时用get_run读取；不生成，不改归属。

## set_task_draft_favorite

PATCH /api/v1/task-drafts/{draftId}/favorite

副作用：write

管理员收藏/取消收藏原全局任务草稿；isFavorite必须为明确布尔目标值，revision用get_task_draft的工作区整数。与UI共用SQLite工作区及锁，不修改内容、createdAt、发布或执行状态；同值不增加revision。409 DRAFT_REVISION_CONFLICT、5xx或丢失回执按原draftId对账，不能自动重放或换ID。

## list_scenes

GET /api/v1/scenes

副作用：read

分页读取与浏览器同序的草稿场景目录。title/summary属于草稿；publishedTitle/publishedSummary属于当前发布快照；draftRevision与draftMatchesPublished用于核对差异。默认limit:50，最大200，hasMore时按nextCursor继续；目录变更返回409 SCENE_PAGE_CHANGED，重读第一页。创作仍用get_scene的发布版，不能自动发布草稿。

## create_scene

POST /api/v1/scenes

副作用：write

创建单场景草稿及流程，可附带它引用的新预设；空工作区原子初始化。scene.id先保存，响应丢失读同一ID，不换ID重建。不会发布或生成。

## get_scene_draft

GET /api/v1/scenes/{sceneId}/draft

副作用：read

读取单场景草稿、关联预设、内容revision、发布版本目录和缺失预设；scene.title是草稿展示标题，workflow.name是独立流程配置名，不作场景标题。不搬整工作区。发布版仍用get_scene。

## get_scene_draft_diff

GET /api/v1/scenes/{sceneId}/draft/diff

副作用：read

只读预览服务端草稿与当前固定发布快照的字段差异；尚未发布则对空基线显示新增。步骤按发布时同一本地能力规范化，失败返回preparationWarnings，不阻止预览但仍须校验。按稳定ID/key对齐，顺序变化单独列出，关联预设取发布快照而非当前共享值。返回baseline/versionId、draftRevision及独立diff revision、全量summary和分页changes。大值每侧默认4000码点，complete:false用get_scene_draft_diff_value续读；不静默截断。contentHash可核对UI保存状态，后续页/值必须沿用revision；变化409重读第一页。不会保存、发布或生成。

## get_scene_draft_diff_value

GET /api/v1/scenes/{sceneId}/draft/diff/value

副作用：read

按差异revision/changeId/side分段读取一个差异值的完整文本或格式化JSON；offset/limit按Unicode码点，沿用nextOffset，complete:true才读完。409 SCENE_DIFF_CHANGED重读差异，不拼接不同快照。不存在404 SCENE_DIFF_CHANGE_NOT_FOUND，越界400 INVALID_SCENE_DIFF_OFFSET；只读，不保存/发布/执行。

## update_scene_draft

PATCH /api/v1/scenes/{sceneId}/draft

副作用：write

数字类型场景输入可配置包含minimum和maximum（两者均可省略，配置后填写值须在范围内）；required=false允许留空。数字行字段itemFields使用相同范围约束，反向范围会被草稿校验拒绝。步骤级for_each可配置execution.carry:{outputKey,initialSourceRef?}串行继承上一项输出；仅当前步骤已声明输出键，初始来源仅input/前序step；启用后默认maxConcurrency=1、onError=stop，显式冲突拒绝。iteration.previous/hasPrevious/index见x-for-each-carry；续跑仅复用匹配完成前缀，单项编辑/反馈重做失效整个后缀。用当前内容revision替换提供的完整scene/workflow部分，省略部分保持不变；不是深层patch。可创建引用的新预设，不暗中覆盖共享预设。图生图复用基础hermes链路：writer先将有序reference_images与想法prompt整理为text edit_brief，aixg只消费该输出与原图片转为text prompt；生成步骤inputs和ComfyUI正向binding均引用aixg输出。公开输入仅reference_images（图片）、prompt（想法）、seed、ratio、mp；负向/步数/CFG/缩放/空图不作为用户输入，保留工作流固定配置。ratio/mp绑定目标画布，参考图仍传给图像编辑条件。切换ComfyUI工作流必须同步核对bindings节点与端口；双采视频只改配置，长文JSON入口为201.String而非196采样器。长文用writer输出storyboard/shots，基础hermes aixg按writer.shots逐项只输出text prompt；H3生成inputs.prompts引用step.aixg.outputs.prompt列表，保持Writer镜头元数据且全列表校验后才生成。ComfyUI只绑定image_list/audio_list/video_list物理列表，业务分类不作为节点类型；基础media.select_references新增可选images/audios/videos合并输出（旧快照可省略），按groups顺序及组内原上传顺序合并且不去重，提示词Picture/Audio/Video编号同步；长文H3绑定iteration.item.references.images到192.ref_images、references.audios到192.ref_audios，适配在逐镜选择后合并。场景输入和兼容旧ComfyUI输入绑定可配mediaRole（character/scene/prop为图片，voice_reference为音频，reference通用参考）；不新增媒体类型或执行器，同端口按绑定顺序合并，旧快照不自动替换。AI套图配置复用基础Writer完整设计→data.zip数量/结构校验→媒体选择bundle→AIXG完整成图提示词→data.zip对齐→基础ComfyUI样张审核→剩余逐张生成→收集模型原始图片。新模板不含add_text、layout、文字后置或条件选择，不把AI成图当无字底图；图中需要的文字、图形、版式由图像模型直接生成。不用commerce_pack专用适配器，旧发布快照不自动替换。data.zip可选ordinalField要求主项该整数属性严格按输入顺序1,2,...，拒绝重复/跳号/重排且不排序；省略保持旧行为。data.zip的itemSchema为有限本地JSON Schema，不能嵌入引用/代码；selection每组可用序号数组或all，bundle保留逐项边界。steps.inputs.referenceType可显式标注JSON字段中的image_list/video_list/audio_list，审核恢复后仍为真实附件；省略保持旧行为，不生成媒体。基础ComfyUI capabilityConfig.outputMediaCounts按声明输出key校验每次/逐项执行的媒体数量（0..144，最多64项），如{images:1}；省略兼容旧流程，多图/少图直接失败，不截断或错配。不会发布或执行。冲突返回currentRevision，重读后决策。

## validate_scene_draft

POST /api/v1/scenes/{sceneId}/validate

副作用：read

校验指定revision草稿的结构、引用、默认值、预设与已安装能力；输入默认值必须匹配字段类型且select值属于已配置选项。无生成副作用，不探测远程服务，也不发布。

## publish_scene

POST /api/v1/scenes/{sceneId}/publish

副作用：write

发布指定revision草稿；服务端生成哈希、不可变快照并固定能力版本，不执行生成。调用前保存publicationId(UUID)，成为versionId。同ID同请求重读可对账，重复调用不会重复发布；仅保留最近10版。

## restore_scene_draft

POST /api/v1/scenes/{sceneId}/restore

副作用：write

用当前revision恢复保留的发布版本到草稿，不自动发布。冲突共享预设会克隆并重映射，不影响其他场景；已有运行快照不变。

## delete_scene

DELETE /api/v1/scenes/{sceneId}

副作用：write

用当前草稿revision显式删除该场景、草稿及工作区发布目录；不删除历史运行、媒体或素材。只在用户明确要求删除时使用。

## list_option_presets

GET /api/v1/option-presets

副作用：read

分页读取共享选项预设、内容revision及引用它的草稿场景；不读取整工作区。

## save_option_preset

POST /api/v1/option-presets

副作用：write

创建/替换完整共享预设：新建省略revision，修改现有必须带当前revision。改动影响引用它的草稿，不修改历史发布快照；先查看使用场景。

## delete_option_preset

DELETE /api/v1/option-presets/{presetId}

副作用：write

用当前revision删除未被草稿引用的共享预设；有引用返回冲突和sceneIds，不暗中解除引用。已发布快照不变。

## get_scene

GET /api/v1/scenes/{sceneId}

副作用：read

取得已发布版本的流程、inputSchema/默认值/必填汇总/示例、输出与费用/审核节点；workflow.inputs[].hidden表示从网页输入表单隐藏但仍保留在输入契约与执行中，隐藏必填字段需要有效默认值；对象数组表单通过workflow.inputs中的inputMode=object_array及itemFields定义，并在inputSchema/inputRequirements反映行字段约束。inputSchema允许未声明的额外输入键透传，已声明字段仍有类型与必填校验。场景展示用该快照scene.title而非独立workflow.name，不能用最新草稿名替换。省略 versionId 读取当前发布版；之后固定返回的 versionId。

## prepare_scene

POST /api/v1/scenes/{sceneId}/prepare

副作用：read

无生成副作用预检：固定已发布版本、填默认值、允许额外输入键透传并保存在运行输入中；额外键不作为场景字段参与字段级校验，已声明字段仍校验类型/选项、必填、素材版本/文件和能力配置。对象数组表单按已发布itemFields校验类型化数组中的每一行。返回执行/审核边界。不是外部服务健康或计费承诺，提交时仍会重新校验。媒体首选assetId+assetVersion固定引用；管理员的本后台同源/相对固定素材媒体URL也由权威素材服务解析和校验，不走无凭据HTTP下载。返回媒体执行契约（含audioConsumers），说明Hermes/AIXG与ComfyUI共享固定版本来源；不放宽用户归属权限。

## submit_scene

POST /api/v1/scenes/{sceneId}/runs

副作用：execute

执行已确认的发布版场景，可能调用付费 Hermes/ComfyUI。输入允许额外键透传并保存到运行输入，已声明字段仍按原契约校验；步骤引用仍由发布工作流中的绑定决定。UI格式ComfyUI工作流按x-comfy-ui-routing解析前端Reroute链与扇出，不提交虚拟中继；循环/缺失/多来源/非零出口返回INVALID_COMFY_REROUTE，不修改原图或自动重试；API格式转换保持原样。运行绑定后按x-comfy-static-switch仅断开已证明静态布尔值的内置ComfySwitchNode未选中输入，避免无上下文首段校验示例视频；未知/循环选择器原样交给ComfyUI。显式空可选视频清除示例输入；真实选中的必需输入仍由上游校验，声明但未连线的标量输入可按object_info绑定。先预检；必须提供固定 versionId 和预先保存的 runId。素材固定版本由后端解析并归档；Hermes/AIXG以归档字节构造inline图片，ComfyUI读取并上传同一来源与顺序；Hermes保留现有图片预算/压缩，不改选素材版本。基础audio_list绑定将已授权私有音频（含media.select_references/data.zip中间JSON）按引用顺序上传为ComfyUI输入附件再连接LoadAudio；每文件100MB，保留已有合法附件，不读取previewUrl或转发工作台凭证；上传/读取失败在提交prompt前停止，不自动重试。完整机器契约见x-asset-media-execution.audioConsumers。不要求执行端持有工作台token或访问previewUrl。Hermes返回对象按x-hermes-output-json契约解析；仅单个提前闭合顶层括号或字符串内原始LF/CR/TAB可确定性修复，不组合修复；全回复解析、声明字段无缺失/未知/重复，完整保留解码值且不重试模型。返回后用 wait_run/get_run 查询。响应丢失只查同一 runId，不换 ID 再提交。

## list_runs

GET /api/v1/runs

副作用：read

管理员分页查询运行摘要；保留nextCursor继续读取。每条摘要返回服务端绑定的ownerUserId及submitter身份快照(userId、username、displayName)；旧记录有归属但无快照时按当前用户档案补齐，不改写历史。

## get_run_outputs

GET /api/v1/runs/{runId}/outputs

副作用：read

按outputKey读取最终输出，目录cursor分页，数组valueOffset/valueLimit分段，长文本可显式提供textOffset/textLimit按Unicode码点分段(最大32768，未提供保持scalar行为)。includeValues:false只取元数据，值超maxValueBytes明确省略，不静默截断；媒体含精确source和HTTP预览地址。

## get_step_result

GET /api/v1/runs/{runId}/steps/{stepId}/result

副作用：read

读取指定步骤结果与真实用时，不带提示词、输入或完整流程。步骤和foreach各项有实际startedAt，结束后写入durationMs，运行中可用startedAt计算当前已用时间。可指定outputKey/itemIndex，foreach结果cursor分页、数组值分段，文本可显式textOffset/textLimit分段；Hermes解析或输出校验失败时返回完整原始回复的分页投影，保留首尾空白；结果变化（包括warnings或原始回复）时旧cursor返回409重新读第一页。warnings为步骤/逐项非阻断提示，可在生成中或外部失败后读取，不当成error或自动重试原因。

## get_run

GET /api/v1/runs/{runId}

副作用：read

管理员读取完整运行快照、输入、步骤结果、pendingReview和输出，并返回服务端记录的submitter身份快照(userId、username、displayName)；已开始步骤和for_each各项有实际startedAt，结束后写durationMs，运行中可据startedAt计算已用时间；已执行Hermes步骤含实际发送的agentPrompt，for_each时记录在各item.agentPrompt中，便于核对模板展开、步骤输入、反馈与输出要求；Hermes解析或输出校验失败时还保存完整未trim的原始回复agentResponse（旧历史未记录时不推测补写），可通过get_step_result分页读取；旧记录有归属但无快照时按当前用户档案补齐，不改写历史。Hermes JSON不可安全解析时保持failed及可读错误，不截取第一个对象、不自动重投；原失败快照不因后台修复而改写。waiting 是审核，不是失败；stale 需显式恢复。

## wait_run

GET /api/v1/runs/{runId}/wait

副作用：read

最多等待30秒，到终态或waiting即返回摘要、提交人快照及审核信息。不取消后台运行。timedOut:true 时继续查询；最终输出再用 get_run，事件用 get_run_events。

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

状态传递for_each仅复用来源值匹配、状态有效的连续完成前缀，缺口后全部重算，失败停止后续项；未checkpoint外部调用仍可能重复计费。从非活动、非waiting运行创建新运行，复用已持久化的完成步骤。未checkpoint的外部请求可能重做/计费。H3生成前按x-h3-prompt-sections归一化已声明标题的缩进/大小写及明确别名（详细描述→detailed_description），缺段/重复/顺序问题仅作为warnings提示，不阻止生成，不补正文、不重新调用已完成Writer/AIXG。必须保存新 runId；不是 exactly-once。

## preview_rerun

POST /api/v1/runs/{sourceRunId}/rerun/preview

副作用：read

先预览局部修改会复用/替换/重跑哪些节点和镜头；不执行生成。配置对象是完整替换，不是局部merge。Hermes 结果可用 changes.feedback 提交 stepId、可选 itemIndex 和 message，不必改提示词。

## rerun

POST /api/v1/runs/{sourceRunId}/rerun

副作用：execute

执行先前预览的局部重做，可能付费；changes 必须与确认的预览一致。必须保存新 runId；响应丢失查该 ID。waiting 不可绕过审核。

## review_run

POST /api/v1/runs/{runId}/review

副作用：execute

处理当前 pendingReview：approve 可启动后续付费生成；redo 重做当前步骤并再次审核。必须使用最新 reviewId；outputs 编辑仅单次节点，foreach 是整批审核。Hermes redo 可填写 feedback，连同原结果交给模型修订并保存历史。409 后重读，不重放旧决定。

## list_assets

GET /api/v1/assets

副作用：read

管理员素材库：按名称/说明/分组/标签检索，kind/category/group/tag筛选，默认24条最多100条；archived:true包含归档。仅返回元数据摘要，版本与参数明确省略；用nextCursor继续，ASSET_PAGE_CHANGED重读第一页。输入固定assetId+assetVersion。

## get_asset

GET /api/v1/assets/{assetId}

副作用：read

管理员读取素材元数据、说明、revision、versionCount和当前固定reference，不返回版本历史；list_asset_versions按页读取历史。可用createId对账丢失的创建回执。执行输入直接用返回的assetId+assetVersion，不将previewUrl当作下载授权；内部解析不向外部服务转发工作台凭证。

## list_asset_versions

GET /api/v1/assets/{assetId}/versions

副作用：read

管理员按页读取素材版本（从新到旧）和精确source/sha256/bytes/reference，参数明确省略。游标绑定素材revision、对象、身份；变化需重读第一页。

## get_asset_version

GET /api/v1/assets/{assetId}/versions/{version}

副作用：read

管理员读取一个固定素材版本，不生成/下载。includeParameters:true按JSON字符分段读取生成参数（默认8000，最多16000）；hasMore时沿nextOffset继续，拼完再解析，不能把片段当完整JSON。媒体GET/HEAD/Range地址在reference。

## save_asset

POST /api/v1/assets

副作用：write

管理员将完成步骤/最终输出收藏为素材。source精确定位输出；新建先保存createId，新增版本带assetId+当前revision，二者互斥。可保存description/group/tags供AI检索。可能复制/下载输出，不重新生成；丢失回执先get_asset对账，不换ID重投。

## upload_asset

POST /api/v1/assets/upload

副作用：write

管理员上传MCP所在机器的本地媒体（最多250MB），filePath须绝对路径。新建先保存createId，新增版本带assetId+revision。支持description/group/tags；返回固定reference，无完整历史。丢失回执先查询原ID；不会自动重试。

## update_asset

PATCH /api/v1/assets/{assetId}

副作用：write

管理员部分更新名称/说明/分类/分组/标签/归档；不删除版本，tags提供时完整替换。必须带当前revision；409重读。归档后历史固定引用仍可用。

## list_clip_selections

GET /api/v1/clip-selections

副作用：read

查询持久化镜头选版清单；runId 筛选同一续跑/修订家族。

## create_clip_selection

POST /api/v1/clip-selections

副作用：write

从终态运行的foreach视频步骤创建选片清单；成功镜头自动固定为素材版本，失败镜头保留空位。

## get_clip_selection

GET /api/v1/clip-selections/{id}

副作用：read

读取清单、revision、完整shotId、选择和lastRunId；不要猜镜头ID。

## get_clip_candidates

GET /api/v1/clip-selections/{id}/candidates

副作用：read

查询同一修订家族且分镜内容一致的镜头候选及媒体地址。

## update_clip_selection

PATCH /api/v1/clip-selections/{id}

副作用：write

用当前revision修改名称、完整shotOrder或一个shotId的source；source:null清除该镜头。候选选择会固定媒体版本，不自动跟随新生成。

## compose_clip_selection

POST /api/v1/clip-selections/{id}/compose

副作用：execute

按完整选片清单创建仅本地FFmpeg合成运行，不调用模型。需要最新revision和保存的新runId。缺镜头拒绝合成；响应丢失先查询runId和清单lastRunId。
