## 第三方请求与GPT图片编辑（1.5.29）
基础能力core.http_request通过固定公网HTTP/HTTPS地址（公网域名或公网IP、任意端口）发送请求（默认一次，可配置重试），拒绝本机/内网/回环/链路本地/保留IP与非公网DNS解析结果（DNS重绑定）、重定向、敏感URL参数与手填鉴权头；HTTP为明文传输，API密钥不经TLS保护，能使用HTTPS时优先。默认bodyFormat=json兼容既有场景；bodyFormat=multipart支持标量表单bodyTemplate与multipartImages图片映射。接口配置复用list_capabilities、revision草稿编辑、固定发布和普通/本人运行工具；不新增任意HTTP代理。
multipartImages示例[{inputKey:product_images,fieldName:image[]}]：按输入顺序上传当前运行内已授权归档的PNG/JPEG/WebP原字节；不读取任意路径、其他运行文件、符号链接逃逸路径或previewUrl，不向供应商转发工作台凭据。最多16张、每张20MB、总正文64MB；JSON或表单文本最多256KB。配置/预检/发布均不上传，只有显式执行才向供应商发送图片并可能计费。
responseImages示例{path:data,base64Field:b64_json,expectedCount:1}：按JSON路径读取数组并验证数量、base64与真实图片内容，归档后输出可选images:image_list；response中原base64替换为omitted/decoded_to_images/outputKey/index标记，不静默截断。该模式响应上限64MB；普通JSON仍为4MB。不下载响应中的远程图片URL。图片沿用既有按对象/步骤/逐项分页、鉴权预览和HEAD/Range机制。
GPT官方图片编辑配置：url=https://api.openai.com/v1/images/edits，method=POST，bodyFormat=multipart；apiKeyEnv=OPENAI_API_KEY（工作台服务进程环境，不是工作台登录凭据），默认Authorization与Bearer空格前缀；bodyTemplate填写model、prompt、size、quality、n等标量字段，product_images映射为image[]。当前官方示例模型为gpt-image-2.5-sunburst，账号可用性须另行核验；此文档不代替实际供应商协议。官方依据：https://developers.openai.com/api/docs/guides/image-generation 。
apiKeyEnv仅保存变量名，密钥不主动写入场景/运行输入/日志。请求超时1–600秒，只接受2xx；图片解析错误为INVALID_THIRD_PARTY_IMAGE。固定发布versionId后prepare_scene不调用供应商；提交前保存runId，响应丢失按原ID对账，默认不自动重试。外部请求已接受但未checkpoint时无法保证恰好一次，恢复/重做需先核对供应商任务；异步轮询仍需显式编排。既有发布快照不自动替换；新增multipart配置须在草稿中核对、校验后显式发布。
## 通用开始条件（1.5.32）
每个步骤都可直接声明startCondition开始条件：{match:all|any,rules:[{id,leftRef,operator,valueSource,rightValue,rightRef}]}。leftRef/rightRef引用input.<key>或前序step.<id>.outputs.<key>，运算符与旧条件节点一致（equals/not_equals/greater_than/greater_or_equal/less_than/less_or_equal/contains/not_contains/is_empty/is_not_empty），右侧可为字面量或另一个引用；is_empty/is_not_empty不需要比较值，常用于input.reference（媒体列表）非空判断。规则不满足时该步骤整步跳过（逐项模式按项跳过），其声明输出按null参与下游引用，该步骤的模型/外部服务不会被调用也不计费。第三方接口（core.http_request）等所有执行方式同样遵循：规则不满足时不发出请求。逐项执行的步骤引用被遍历的来源输入键（例如input.prompts）时按当前项求值——先按整个列表判断整层门，未满足直接整步跳过；满足后逐项再按当前项判断，空项只跳过该项并按null占位，其余项照常执行且保持原顺序。
开始条件必须在提交前通过校验：引用后续步骤、未知引用、空规则、无效匹配方式都会拒绝（INVALID_WORKFLOW/INVALID_WORKFLOW_REFERENCE）；重做规划按开始条件引用的步骤失效旧结果。旧core.condition条件步骤、runCondition与data.select条件选择已标记compatibilityOnly，仅用于兼容已发布快照；新场景用开始条件+null输出表达分支，例如「有参考图才分析风格，否则用固定默认文案」= 分析步骤声明startCondition(input.reference is_not_empty)，下游用inputs.analyzed ?? 默认值（null安全）。
草稿编辑在任意步骤的「开始条件」区域配置；编辑后仍需validate_scene_draft与publish_scene固定快照才生效，历史运行与旧发布版不自动替换。机器契约随步骤schema下发：match、rules、运算符与leftRef/rightRef均可用list_capabilities返回值schema与create_scene/update_scene_draft请求体核对。

## 自定义代码沙箱步骤（1.5.30）
基础能力core.code在隔离沙箱中执行本地JavaScript，用于复杂数据变换、聚合、条件控制或结构化计算；不读写文件、不联网、不调用模型、不计费。每次执行使用一次性worker_thread + node:vm：没有Node模块、进程、网络、文件、环境变量和定时器，只有ECMAScript内置对象和console；同步死循环被vm超时终止，等待永不完成的Promise、keep-alive失控或外部取消都会强制终止沙箱并记为失败。
代码以async function体书写：const inputs读取声明的输入端口（JSON值；媒体输入以只读[{filename}]投影进入，可判断数量/顺序/文件名，不暴露路径、URL与二进制），顶层return返回对象，键对应声明的输出端口，类型限text/number/boolean/json。缺失输出、额外键、类型不符、undefined/函数/BigInt/循环引用、超过1MB的返回都是明确错误；console输出仅失败时作为错误上下文返回，不计入输出。配置/预检/发布都不执行代码，只有提交运行后才执行；取消运行会立即终止沙箱。
草稿编辑复用现有步骤能力配置：inputs按key声明输入（可来自input/前序step/iteration），outputs声明输出端口与类型，capabilityConfig.code填写代码（≤64KB），capabilityConfig.timeoutMs为200–60000毫秒（默认5000）。例：inputs=[{key:items,sourceRef:input.items}], outputs=[{key:count,type:number},{key:summary,type:text}], code=return {count:(inputs.items??[]).length,summary:"共"+inputs.items.length+"项"};。
新场景的数据传递、模板拼装、条件控制、媒体选择/排序/合并、列表对齐与数量/唯一ID校验统一使用core.code；core.manual、core.condition、data.select、data.zip、text.template、media.select_references、media.image_layout、media.video_concat均标记compatibilityOnly，只为旧发布快照与历史运行保留，新步骤不再提供。core.code可声明image_list/video_list/audio_list输出端口：返回值是文件名数组（字符串或{filename}），按顺序从本步骤声明输入端口的既有媒体中选择、重排或合并（允许重复），复用同一批已授权归档文件；沙箱不产生、不改名、不拼接媒体内容，引用不存在的文件或媒体类型不符都是INVALID_CODE_OUTPUT。因此旧的“媒体选择与合并”可由一个core.code步骤表达：inputs声明要选择的媒体输入，outputs声明合并后的image_list/audio_list/video_list端口，code返回需要的文件名顺序。执行沿用固定发布快照、普通/本人运行、get_step_result按步骤读取结果与错误码、断点续跑和局部重做；INVALID_CODE_CONFIG/INVALID_CODE_INPUT在预检和提交前失败，CODE_TIMEOUT/CODE_EXECUTION_FAILED/INVALID_CODE_OUTPUT在执行时失败，都不自动重试。机器契约x-code-step。

## 第三方接口请求重试（1.5.31）

core.http_request新增可选capabilityConfig.retries（0–5次，默认0）与retryDelaySeconds（0–30秒，默认2）；两者省略或retries=0时保持一次请求，既有发布快照行为不变。新增字段须在草稿中配置，经validate_scene_draft校验后显式发布；配置/预检不发起请求，prepare_scene仍不调用供应商。

重试条件严格限定：只重试网络失败THIRD_PARTY_REQUEST_FAILED、请求超时THIRD_PARTY_REQUEST_TIMEOUT和HTTP 408/429/500/502/503/504。4xx业务错误、无效JSON、响应超过大小上限、图片解码失败、非公网地址、凭证缺失/无效以及配置或输入错误都是确定性失败，立即结束且不重试。第n次重试前等待retryDelaySeconds×2^(n-1)秒，单次等待不超过60秒；每次重试重新解析DNS并按原配置重发完全相同的请求体，取消运行会立即中断等待，不发出后续请求。

每次重试前写入一条步骤warnings非阻断提示（失败原因、等待秒数与即将发起的重试次数），不改变运行状态；最终仍失败时返回最后一次的原始错误码，改写成成功、自动换ID或重放都不允许。重试是显式权衡：供应商已接受请求但响应丢失时，重发请求可能重复计费或重复变更第三方状态，无法保证恰好一次；异步轮询仍需显式编排。密钥仍只从工作台服务进程环境读取，不写入场景、运行或日志。机器契约x-third-party-json-request v2，新增retries/retryDelaySeconds与automaticRetries说明。

## 固定音色的基础ComfyUI上传（1.5.23）
基础audio_list绑定支持已由权威素材服务授权并归档的固定音色私有路径；旧media.select_references.bundle与data.zip/for_each中间JSON仍可由历史快照使用。提交器读取同一版本原始音频字节，按引用顺序经ComfyUI /upload/image的image表单上传为input附件，再连接LoadAudio及普通/命名autogrow AUDIO端口；每文件最多100MB。私有path优先，不回退到previewUrl或未经授权的显示元数据，不向上游转发工作台token/cookie；普通用户仍只可提交本人固定引用。已有合法ComfyUI input附件不重复上传；读取、超限、上传失败在提交prompt前停止，不自动重试、不重新调用已完成Writer/AIXG。旧失败快照不改写；上线修复后仍须按原runId核对，再经用户明确确认用新runId断点续跑，可能计费。机器契约x-asset-media-execution.audioConsumers与固定发布inputRequirements.mediaExecution；配置、预检、读取不上传或生成。

## 单工作流静态上下文开关（1.5.22）
同一ComfyUI工作流可在for_each.carry省略initialSourceRef时，首项以iteration.hasPrevious=false关闭上下文，后续以true打开并用iteration.previous传入紧邻上一项视频。不要复制首段工作流或塞示例视频。运行绑定后共享提交器只断开已证明静态选择值的内置ComfySwitchNode未选中输入；不执行节点/表达式、不移除其他消费者或改输出ID；未知/循环/自定义选择器保持原样。显式空可选video绑定清除原图样例；被实际选中的必需输入仍按ComfyUI真实校验失败，不吞错。API与UI格式提交均适用，读取检查不改图；原文件、草稿、固定发布/历史不变。声明但未连线的标量端口按object_info绑定，非法端口拒绝。机器契约OpenAPI x-comfy-static-switch v1。
长文精简配置示例examples/scenes/long-text-context-video.json：Writer一次输出制作级storyboard/shots（不含prompt）→AIXG一次批量将确定的分镜转换为prompts，不重写剧情/台词/seconds/selection→data.zip原始分镜与提示词等长对齐→素材选择和标签映射→data.zip执行记录对齐→单工作流串行carry生成→本地音视频合成，共7步、两次AI调用，data.zip.ordinalField=index在生成前拒绝乱序/重复/跳号，省略不改旧快照行为。逐项来源的嵌套媒体与上游输出用同一归档缓存保存，新链失败续跑可复用已完成前缀，不按媒体文件名猜测相等。减少AI回合与冗余节点，不用AI代替媒体归属/固定版本/确定性映射或状态管理。修改用revision，先校验再显式发布；新配置未经真实视听验收，隔离测试不会调用真实模型。

## ComfyUI前端中继兼容（1.5.21）
UI格式工作流在共享转换器中解析Reroute链及扇出，提交真实源节点/出口，不向ComfyUI提交前端虚拟中继；原工作流文件、场景、发布及API格式图不变。循环、缺失源、多源和非零中继出口为400 INVALID_COMFY_REROUTE，details含nodeId/reason；外部生成前拒绝，不自动改图或重试。按原runId核对失败结果后明确resume_run/rerun，可能计费；配置/校验/发布不等于模型生成，首段视频依赖与模型插件端口仍要另行核验。机器契约见OpenAPI x-comfy-ui-routing v1。

## 步骤逐项串行状态传递（1.5.19）
草稿steps[].execution可配{mode:for_each,sourceRef:input.shots,carry:{outputKey:video,initialSourceRef?:input.seed_video}}。outputKey必须是当前步骤已声明单次输出，不是聚合输出；仅步骤级可用。carry省略保持独立遍历；启用时maxConcurrency默认1、onError默认stop，显式其他值拒绝。initialSourceRef仅input/前序step，类型匹配输出；省略首项iteration.previous=null、iteration.hasPrevious=false；有效种子首项即true。随后previous来自紧邻上一成功项；iteration.index从0开始。previous保持声明媒体/JSON类型，可用媒体[0]/JSON路径；数值0、false、空文本有效，missing/null、空或无效媒体及错类型失败，不能回退到样例视频。
通过既有create_scene/update_scene_draft与revision保存完整workflow部分，validate_scene_draft后使用事先保存publicationId显式发布；get_scene读固定快照，prepare_scene只预检，用户授权后submit_scene用事先保存runId执行，响应丢失只查原ID。ComfyUI基础绑定previous到上一段LoadVideo、hasPrevious到上下文开关；具体节点以实际导入图为准，首段视频加载器是否仍必需须单独本地验证，不用样例假装上下文。不能直接假设无缝画面会修正对白节奏。
carry失败不执行后续项；resume_run/本人工具只复用来源值匹配且输出有效的连续完成前缀，第一处缺口或变化后重算。preview_rerun/rerun单项参数修改、反馈、重做会失效该项和后续；替换第k项保留替换结果但重算k+1后缀；一次请求每条状态链只能替换一项，需完成后缀后再替换其他项；不可同时替换并改上游。上游/种子改变重算整链，下游依赖按现有规则失效。不自动替换发布版或历史；执行/续跑/重做可能计费，未checkpoint外部请求不能保证不重复。get_step_result/get_own_step_result仍按items分页、输出省略与result revision读，不搬整批媒体；旧游标409重读。机器契约见OpenAPI x-for-each-carry v1。

## 用户专用入口与登录安全（1.5.18）
ZANE_PUBLIC_USER_PORT留空不开启；显式开启第二监听入口时管理API_HOST必须回环，公网仅转发用户端口。两个入口共享同一服务和SQLite，不生成独立用户/AI场景库。公网白名单只允许普通用户原子操作和经归属/场景授权的媒体GET/HEAD/Range；初始化、管理UI/API/旧入口与管理员/应急凭证拒绝。管理操作保留在私有入口。
先get_workbench读取security.contractVersion/entryMode/loginRateLimit。默认900秒窗口同账号8次、可信请求IP30次（包括成功登录），最多4次并行密码校验；公私入口计数隔离，账户名忽略大小写，客户端X-Forwarded-For不可直接绕过。计数是有界进程内运维状态，重启会清空；同机代理默认多个用户共享来源桶，需根据实际流量调整。429 LOGIN_RATE_LIMITED带Retry-After及details.retryAfterSeconds，UI/MCP不自动重放。
公开入口/生产环境错误保留稳定code、requestId及可操作revision/冲突字段，隐藏未知异常/本机路径/连接凭证；写入5xx或失去回执仍先按原ID对账。用户专用OpenAPI/guide只展示该入口允许的路径。HTTPS可信代理与Origin/Secure Cookie的既有配置问题、任务额度、上传强化和Agent隔离本轮暂未修改；入口限制不等于完整公网安全认证。

# AI 工作台操作手册

契约版本：1.5.32。面向使用工作台的 AI，不是让 AI 直接改数据库或代替人点击网页。
本手册与 MCP 的 zane://guide、HTTP /api/v1/ai/guide 同源。

## 系统任务并发（1.5.15）
管理员在集成连接 → 系统任务并发设置；HTTP GET/PATCH /api/v1/settings/task-concurrency 与 MCP get_task_concurrency/update_task_concurrency 共用SQLite权威服务。固定ID task-concurrency，全系统一份，不按用户/项目创建配置。
先读取当前revision（首次0），再用revision+maxActiveRuns保存，整数1–32。首次默认ZANE_MAX_ACTIVE_RUNS（省略为2），保存值优先且跨重启持久化；读操作不初始化或生成。
保存立即调整队列：调高可能开始已有排队任务，调低不取消正在执行的任务，active可能暂时超过上限，直到低于新上限才放行。不创建任务、不审批、不发布、不重新生成；for_each步骤maxConcurrency与ComfyUI资源限流独立。
参数错误返回400 INVALID_TASK_CONCURRENCY_REQUEST，旧revision返回409 RESOURCE_REVISION_CONFLICT；未认证401，非管理员403 ADMIN_REQUIRED。409或保存响应丢失先get_task_concurrency按同一固定ID对账，核对revision和值后由操作者决定，不自动重放旧请求。没有分页或大值。普通用户与未认证调用不可读写此管理员配置。

## AI 电商套图与通用数据/媒体交付（1.5.14）
模板examples/scenes/commerce-ai.json全部由基础步骤组合：Writer商品事实→Writer套图计划→core.code校验计划数量/角色/结构与唯一ID→core.code合并商品/风格参考（按filename选择本次输入里的既有图片，输出image_list与reference_map）→core.code带素材编号对齐并确认→AIXG逐张prompt→core.code对齐计划与提示词→ComfyUI样张确认→剩余逐张生成→core.code按样张→剩余顺序交付原始成图。模板不再使用media.select_references/media.image_layout/text.template/core.manual等已退役步骤：媒体选择与合并用一个core.code步骤表达（声明媒体输入与image_list输出端口，代码返回需要的文件名顺序），使用的仍是本次运行已授权的同一批文件；已授权媒体输入也直接绑定到Writer/AIXG/ComfyUI步骤，数据传递、模板拼装和结构化控制用core.code。不增加电商专用执行器，不自动改已有发布版或历史运行。模板导入只建立草稿，核对writer/aixg及i2i工作流节点，validate_scene_draft后显式publish_scene；读取/预检/发布均不生成。商品参考和风格参考分开，风格图不得提供商品事实，图生图不保证像素级保真。
data.zip（旧版兼容）：已有发布快照与历史运行仍按({items,expected_count,...等长列})按位置关联，数量不一致/空项/重复identityField/不符合itemSchema直接失败，不截断、补齐、排序或重投。expected_count接受1..1000整数或规范数字字符串，配置minItems/maxItems限制业务规模；itemSchema只支持有限本地JSON Schema，不接受$ref/pattern/format/代码。输出rows/first/rest，可用于任何场景的样张和剩余批次。基础ComfyUI capabilityConfig.outputMediaCounts可按已声明媒体输出key校验每次/逐项执行的准确项数，0..144、最多64项；套图设{images:1}，不得用合并总数掩盖一项多图另一项少图，省略保持旧流程。复用foreach的固定顺序和失败空位；如上游失败先按原runId查看和恢复，不能跳过空项后错配素材。新场景不再新增列表对齐步骤，同类配对、数量与唯一ID校验用 core.code 自定义代码在隔离沙箱内完成。
media.select_references（compatibilityOnly:true）仅为旧发布快照和历史运行保留：selection按组选择素材，bundle输出合并后的images/audios/videos，旧快照不声明则不返回。新场景直接把已授权媒体输入绑定到模型或ComfyUI，不再新增分组选择与合并步骤；steps.inputs.referenceType仍可显式声明JSON字段中的image_list/video_list/audio_list，审核持久化/恢复后仍是媒体附件。每张卡片有唯一id，role可重复；读逐项结果使用get_step_result(itemIndex)，大列表分页。
待审核只使用最新reviewId；样张不满意通过通用反馈/preview_rerun/rerun修订，默认不把样张自动当商品参考。单张重跑先预览影响范围，计划/数量/素材变化可能影响下游；只重做生成项可复用已确认策划与prompt。普通用户复用本人审核redo/反馈链路，不获得管理员任意流程权限。
get_run_media_export/get_own_run_media_export返回只读ZIP元数据和固定revision下载地址。需要终态运行，待审核不能下载为已交付；stepId/itemIndex可显式导出已完成的归档部分，incomplete标明非完成状态。仅归档文件，缺文件/非法来源不自动从ComfyUI重新下载。详细媒体列表按get_run_outputs/get_step_result分段读取；ZIP含manifest.json但不包含隐式多平台适配。下载/HEAD检查同一权限和revision，409后重新核对，不重生成；单文件32MiB、总量512MiB、最多144项。
## 自动安全升级（1.5.13）
这是本机运维能力，不是业务任务执行器。npm run update:prod 创建一次独立后台升级请求并输出 operationId；也可 npm run update:prod -- --id <预先保存的UUID>。本机脚本先复制隔离源码快照并跑 npm run check，旧服务与旧产物保持不动；只使用临时项目/数据与模拟模型。验收失败不关停旧服务。完成准备后自动等待执行/排队/准备/人工审核归零，busy只等不取消、不审批、不重试模型。待审核需按正常业务状态处理。
切换前重新核验实际进程与实例，复用本机控制通道暂停请求、备份SQLite及配置、正常关停；不使用旧PID强杀。候选健康/身份确认前禁止业务请求，明确activate后才开放。Hermes Gateway、ComfyUI和历史运行不自动重启或续跑。前端只提示新release可刷新，不强制刷新、不自动恢复或重放防丢outbox。
get_workbench_upgrade是管理员只读回执，按原UUID operationId或最近一次读取revision/state/checkPassed/阻塞信息/下一步；get_runtime_release是已认证用户只读当前releaseId。不提供HTTP/MCP升级执行代理，构建/部署只使用本机专用脚本。响应丢失先按原ID对账；stop/activate未知时不创建第二个请求、不重复启动。运维回执文件不是旁路业务任务数据库。cancel需原ID和当前revision，仅关停前有效；recover显式接管已退出的升级进程并对账，不盲重放切换。详细限制和回退见docs/production-updates.md。
## H3 提示词格式仅提示、不阻断（1.5.12）

生成边界复用通用段落标题归一化：六个已声明英文标题兼容水平空格/Tab缩进与大小写，明确别名详细描述映射到detailed_description；不接受其它猜测别名，不补缺段、不合并重复段、不调整顺序、不改正文、对白、时长或资产选择。六段缺失、重复或顺序不一致只形成非阻断warnings，格式不会使步骤失败或阻止ComfyUI生成。执行必需的非空/类型/长度、分镜时长与素材引用和容量校验仍保留。机器契约见OpenAPI x-h3-prompt-sections。
原AIXG步骤结果和历史运行保持不变；规范化后的实际生成prompt及prompt_warnings按既有applied_shot输出保存；格式异常不截断尾部，只追加禁音乐策略。通用执行上下文warn在外部生成前保存到step.warnings或step.items[].warnings，运行中或外部失败后仍可读取，复用成功项保留提示；UI以⚠展示。get_step_result/get_own_step_result按既有逐项分页读取warnings，即使includeValues:false也返回；提示改变结果revision，旧cursor仍409重读首页。get_own_run步骤摘要warningCount只计数，不搬整批提示。警告不是error，不取消、不触发重试或审批。不新增任务库或执行器。已有Writer/AIXG完成而generate失败时，先按get_run/get_step_result或本人工具检查结果，经用户明确同意后以新runId显式resume_run/resume_own_run；复用已完成Writer/AIXG，仅执行未完成的视频生成与合成，仍可能产生媒体费用。普通续跑不能绕过审核；未完成或执行必需数据缺失需显式局部修改，不盲重投。

## Hermes 输出 JSON 的有限结构容错（1.5.10）

UI、HTTP、MCP执行统一复用基础core.hermes，不按Writer/AIXG或场景新增执行器。输出仍要求一个完整对象、全部已声明字段且无未知字段，字段类型按原契约校验。可兼容整个回复的JSON代码围栏。
AI电商套图采用完整成图模式：Writer策划整套视觉与逐张brief，AIXG保留需要的文字、图形与版式，基础ComfyUI直接生成完整设计稿；最终只收集模型原始图片。新模板不含add_text/layout，不做无字底图、程序贴字、文案对齐或后置排版。计划/素材/提示词的对齐与校验由core.code完成；data.zip（compatibilityOnly:true）、旧media.image_layout与media.select_references只为已有发布快照和历史运行保留，新场景不再新增。已有发布快照/历史运行保持不变，迁移须以revision保护草稿、校验后显式发布。
通用JSON容错仅限两类且不组合：顶层对象被一个多余右花括号提前关闭、后面仍有逗号与对象字段时，删除这个结构括号；或将字符串中的原始LF/CR/TAB转义为JSON写法，解析后的换行/回车/制表符保持不变，已转义内容与字符串外空白不改。只有整个回复能完整解析且顶层字段无缺失、未知或重复才接受；其他控制字符、反斜杠后裸换行、未完成JSON、多个回复仍失败。不会提取第一个对象、丢掉后续shots、改写字符串/镜头/时长、拼接多个回复或补未完成内容；1.5.14 起的完整对象定位见下节，边界更严。OpenAPI的x-hermes-output-json记录机器契约；修复写入hermes.output_json_repaired日志，仅含步骤/Profile/类型/位置及可选修复数量，不写正文或凭证。
容错不会额外请求模型，也不触发重投。其他格式问题保持failed，错误以Hermes 输出 JSON 格式无效说明，按get_run/get_step_result或本人get_own_run读取原任务对账。后台升级不改写历史失败任务；现有结果替换只允许已完成步骤，不能伪造失败Writer为完成。经用户明确批准后可显式resume_run/resume_own_run，保存新runId，未checkpoint的Writer仍会重新调用/可能计费；读取不生成。

## Hermes 输出 JSON 的完整对象定位（1.5.14）

写报告类提示词常要求模型先给复核结论、闸门报告或导出路径，再给 JSON，模型因此把说明写在对象前后。除原有两类结构容错外，现在允许在其余文字完全不含花括号时定位唯一一个完整根对象：该对象必须能完整解析、已声明字段齐全、无未知字段、无重复顶层字段；对象以外的文字不解析、不改写、不入值，也不参与字段判断。
定位成功与结构容错一样写入 hermes.output_json_repaired：kind为prose_wrapped_json_object，offset是该对象在原始回复中的位置，inner为对象内部实际使用的那一类修复；日志仍不含正文与凭证。共用输出要求同时显式要求回复以 { 开始、以 } 结束，并禁止复核结论、自检报告、完成说明、文件名或路径——这不是放松格式，而是把最常见的跑偏变成可恢复、可观测。
只要其余文字出现任何花括号（示例小对象、第二个对象、围栏内片段都算）、合格对象不唯一、对象未完成或字段缺失/未知/重复，仍按失败处理：不截断、不拼接、不补内容、不猜字段。定位不能替代结构容错，也不叠加第二类对象修复。容错不额外请求模型、不触发重投；失败仍以 Hermes 输出 JSON 格式无效 说明，按原 runId 经 get_run/get_step_result 对账。OpenAPI 的 x-hermes-output-json 记录机器契约。

## 系统反馈与普通用户 Agent 反馈隔离（1.5.8）

系统反馈：submit_system_feedback调用前保存feedbackId，userId由凭证决定，关联runId校验权限。list_own_system_feedback/get_own_system_feedback仅本人；管理员list_system_feedback/get_system_feedback后以revision调用handle_system_feedback。正文最多8000字符、回复最多4000，列表明确省略，详情完整返回。反馈不进入Agent、evolution、模板或运行，不触发生成。回执丢失先按原ID读对账，不能自动换ID或重放；冲突重读revision，分页变化重读首页。pending可处理中/解决/不采纳，结束后必须先显式重新处理。

## 任务草稿收藏（1.5.7）

管理端任务草稿使用 list_task_drafts/get_task_draft/set_task_draft_favorite；本人输入草稿使用 list_own_drafts/get_own_draft/set_own_draft_favorite。二者仍在原权威SQLite，历史全局草稿仅管理员可访问，不补用户归属，不建第二套工作区。
isFavorite为布尔值，旧草稿默认false。收藏组置顶；管理端组内按createdAt、本人组内按updatedAt从新到旧，再按稳定ID破同序。收藏/取消收藏不改变内容、最近保存时间、发布版或执行状态；正常编辑保存保留收藏状态。读、收藏和保存都不调用模型。
先保存原draftId并读取revision，再发送明确isFavorite:true/false，不发toggle。管理端写入revision是get_task_draft或list_task_drafts.workspaceRevision返回的工作区整数，不是分页哈希；本人写入用草稿自身revision。旧revision返回409 DRAFT_REVISION_CONFLICT；5xx或响应丢失先get同一draftId核对目标状态与revision，不能换ID、自动重放或覆盖。
列表默认50最多200，hasMore时沿nextCursor继续；收藏或其它相关写入改变列表后，旧游标409 ACCESS_PAGE_CHANGED，重读首页，不能拼接不同快照。元数据页明确省略大摘要/输入/执行记录；单草稿get读取完整输入，管理端runResult仍省略，有runId时按get_run另读。

## 正式启动与 MCP 同步（1.5.1）

用户执行 npm run start:prod：先核验当前实例/端口，拒绝活动、排队、准备中和待审核任务；排空在途HTTP请求、备份权威SQLite与配置后正常关闭，再构建/启动。新后台worker就绪才写新代次。此操作不重启Hermes Gateway/ComfyUI，不触碰其他MCP，不通过业务工具远程执行运维。
stdio命令和ZANE_BASE_URL/ZANE_API_TOKEN不变。常驻连接仅替换工作台HTTP适配子进程；已发送调用先等待回执，绝不重放tools/call。切换后发工具/资源/提示词目录变化通知，客户端支持时刷新工具缓存；之后get_workbench核对契约和身份。
MCP_RESTARTING是JSON-RPC -32603，data.outcome:rejected，表示没有转发本次请求；等待切换后重读。MCP_RESPONSE_UNCONFIRMED也是-32603，tools/call保守按unknown、发现读按read_failed；用原runId/publicationId/createId/revision对账，不自动换ID或再次执行。OpenAPI x-mcp-transport记录这一传输层契约，不冒充HTTP业务响应。
首次升级：已经运行的旧后台没有正常切换接口时，需要先在其原终端Ctrl+C正常关闭；旧MCP还没有常驻外壳，需要在空闲客户端重载一次。Hermes可在对应会话使用/reload-mcp（会重连该profile的其他MCP，需避开其在途调用），不用重启Gateway。之后start:prod自动同步本项目MCP。更换token/地址/启动配置仍须客户端重载，不是后台重启能自动修改的身份。
构建失败不发布新代次、不伪装完成；命令保留错误，修复后再启动。诊断仅get_workbench/npm run ai:doctor，不通过重复提交业务试连。详见docs/mcp-runtime.md。

## 身份、管理员与用户端（1.5.0，运行详情增强）

先配置 ZANE_API_TOKEN 并读取 get_current_user。HTTP可用登录会话Cookie；MCP只转发本人Bearer凭证，不保管另一套用户/场景库。首次管理员在服务器本机网页显式创建，没有默认密码。管理后台 /admin；用户端 /app；产品没有每人一份工作区。
admin 保留下文管理工具；user 只调用 self 操作。get_workbench 返回当前身份可用操作，管理工具即使出现在旧MCP静态发现里也会由服务端拒绝。AUTH_REQUIRED/ACCOUNT_DISABLED 需要重新登录或管理员处理；ADMIN_REQUIRED不能通过改参数、换profile绕过。
管理员：list_users 分页 → get_user 保存revision → set_user_scene_access设置完整sceneIds。新用户默认空授权，新场景不自动授权；未发布场景即使已授权也不能使用。角色/启停/密码重置使旧会话和AI凭证失效。
普通用户：list_available_scenes分页 → get_available_scene固定versionId和业务输入；填写媒体时可用list_own_assets按类型/关键词分页选择本人素材，或upload_own_asset上传新素材（先保存assetId，固定assetVersion）→ prepare_own_scene → 明确授权执行后submit_own_scene。本人素材目录只返回当前身份拥有的未归档素材，不包含他人及未归属历史。可携带未声明的额外输入键，作为透传值保存在运行输入中；已声明字段仍严格校验，步骤使用哪些输入仍由发布绑定决定。只能提交本人资产引用，不能提交完整workflow或本机路径。SCENE_VERSION_CHANGED重读新表单，不自动切版。可选runTitle（≤120字符）是任务标题，与场景标题分开，submit_own_scene和save_own_draft都可携带，留空时任务记录回退场景标题。
save_own_draft 只保存输入，revision:0新建；更新必须读当前revision。草稿列表省略inputValues时用get_own_draft读，不是空值。可选runTitle与输入一起按完整替换保存，省略或留空即清除已保存任务标题。所有已保存状态必须等服务端回执，客户端乐观显示不等于落库。
submit_own_scene先保存runId；响应丢失get_own_run查询同一ID，RUN_PREPARING稍后再查，禁止换ID重建。get_own_outputs/get_own_step_result按输出/逐项分页，valueOmitted和valuePage明确值是否完整。本人媒体地址支持HEAD/Range；未归属历史任务仅管理员可见。
管理员list_runs分页摘要、get_run详情和wait_run观察包含服务端绑定的ownerUserId及submitter身份快照(userId、username、displayName)。身份从已验证会话/凭证取得，不接受请求体伪造；新任务固定提交时的显示名与登录名。历史已有ownerUserId但无身份快照时仅在管理读取时按当前用户档案补齐，不改写历史；不存在的账号仍显示稳定ownerUserId，未归属历史明确保持未归属。普通用户任务投影不暴露其他人的身份信息。
get_run运行快照会在agentPrompt记录每个已执行Hermes步骤实际发送的提示词（含模板展开、已解析步骤输入、反馈与JSON输出要求）；for_each步骤按各items[].agentPrompt分别保存。解析或输出校验失败时，同一记录在agentResponse保存Hermes返回的完整未trim原文（含首尾空白），仅失败响应写入，旧历史没有此字段时不推测补写。运行记录UI显示失败步骤/逐项的原始返回；管理员get_step_result可用textOffset/textLimit按Unicode码点分页读取agentResponse，先读第一页并按valuePage继续。普通用户工具仍不返回原始回复。
运行详情get_own_run提供revision、固定版本、progress与全部快照步骤(含pending未执行)、逐项计数、结果数、每个已开始步骤的startedAt与步骤结束后的durationMs，以及首次真实startedAt；运行中的步骤用startedAt计算当前已用时间。for_each步骤durationMs表示整个步骤墙钟用时，逐项durationMs由get_own_step_result分页读取；步骤用时不含人工确认等待。旧历史缺少步骤起止记录时省略durationMs并在UI标记未记录。没有持久化run.started事件时省略开始/排队计时，不使用queued占位时间。progress只表示步骤，不代表耗时百分比；totalDurationMs包含排队和人工确认。
get_own_run_inputs按需读取原始运行输入，标签和类型不随当前场景变动。limit/cursor分页字段；inputKey+valueOffset/valueLimit分段字符串(Unicode码点)、数组(项)、对象(键)，valuePage说明完整度。present:false不同于null；valueOmitted不是空值。metadata_only要includeValues:true；value_byte_limit先缩小valueLimit或单字段提高maxValueBytes(最大262144)。游标不兼容查询变更；409 RESULT_PAGE_CHANGED重读第一页。
get_own_outputs/get_own_step_result(以及管理员get_run_outputs/get_step_result)可显式设置textLimit和textOffset分段长文本(Unicode码点，最多32768)，valuePage.kind:string、offset/count/total/nextValueOffset说明片段；未设置textLimit保持原scalar行为。数组仍使用valueOffset/valueLimit，媒体不会按字符切碎。get_own_step_result同时返回步骤和逐项startedAt/durationMs，HTTP/UI/MCP复用同一结果服务。复制本段不代表复制整篇。
get_own_run_activity按afterSequence/limit读取业务时间线，hasMore用nextSequence继续；非连续sequence是内部checkpoint被过滤，不是数据丢失。后续仍用最后nextSequence轮询，空页不代表任务结束。不会返回原始日志/错误payload/提示词或连接。本人历史输入和动态不受后续场景改名/撤权影响，账户及任务归属仍实时校验。
waiting使用review_own_run与最新reviewId，可approve/redo，不接受feedback；使用submit_system_feedback交管理员处理问题，不能改输出或流程。resume_own_run只能按本人原快照续跑且不能绕过waiting。普通用户不开放任意局部重做/选片合成/全局素材管理；使用原有管理工具不会获得权限。
撤销场景授权禁止新任务及继续生成操作，已经接受的任务不自动取消；本人历史结果仍可读取，cancel_own_run只需本人任务与有效身份，不要求保留场景授权。禁用账户使所有访问失效。
create_own_token先保存tokenId，密钥只显示一次；丢失回执list_own_tokens找到原ID，显式吊销后重新决策，不能回读密钥。配置90天凭证不等于发布或执行。Hermes comfyui-dev使用管理员本人凭证，不修改Hermes上游。可选ZANE_ADMIN_TOKEN是部署人员显式提供的32字符以上运维管理凭证，没有默认值；不要放进网页。

## 1. 接管前先检查

1. 读取 get_workbench，确认 contractVersion 与本手册兼容，worker.ready/accepting 为 true，projectConfigured 为 true。
2. 优先读取 list_capabilities，不凭旧印象猜能力包版本、配置或端口；能力目录统一、不分基础/专用等级，场景差异用配置与 core.code 自定义代码表达，核对 usage.whenToUse 与 compatibilityOnly。
3. list_scenes 选择场景；get_scene 读取完整发布快照。publishedVersionId:null 的场景不能执行。
4. 保存 sceneId、versionId、version、输入说明、默认值和审核点。versionId 是快照 ID，version 是内容短哈希，两者不能混用。
5. 如果接口404或返回HTML，通常是后台还没加载新版本或地址指向前端。不要直接改 SQLite 或反复调用生成接口。

用户专用端口未发布独立MCP重启代次，本轮不承诺该地址自动热更新目录；升级后在空闲状态手动重载用户MCP客户端。私有入口原有同步机制保留。
### 基础优先，不按场景造步骤

场景差异优先配置 Profile、提示词、输入输出、ComfyUI 工作流/节点绑定；遍历、条件执行、审核和恢复复用通用流程机制。普通文生图/商品图/分镜视频不要仅因场景名称新增专用执行器。
新步骤可选能力包含 Hermes、ComfyUI、core.code自定义代码、for_each通用逐项、通用开始条件startCondition、第三方接口请求等；UI/MCP只把这些作为新步骤可选项。数据传递core.manual、条件判断core.condition、条件选择data.select、文本模板text.template、媒体选择与合并media.select_references、图片画布与排版media.image_layout、本地视频拼接media.video_concat、列表对齐data.zip均标记compatibilityOnly:true，仍注册可执行（已发布快照与历史运行继续正常工作），但不再向新步骤提供、也不作为AI推荐；需要它们的能力时改用core.code、直接绑定已授权媒体或让图像模型直接生成含版式与文案的完整图片。comfyui.h3_long_video、comfyui.long_text_video、comfyui.commerce_pack 同样标记 compatibilityOnly:true，只为已有发布快照与历史运行继续执行；新场景不再新增这类专用适配，改用 core.code 等基础组合。
先复用配置与基础能力（Hermes、ComfyUI、core.code自定义代码、通用逐项/开始条件），其次补强或拆出可复用能力；不再新增场景专用执行器：场景特有的编排用 core.code 在隔离沙箱内表达。H3 数字人时间轴、多段提示词注入、帧网格与原生音频规则只保留在已有发布快照与历史运行中继续执行；长文、分镜、商品等场景名称不是专用步骤的理由。
media.select_references（旧版兼容）：固定发布快照仍按selection和groups解析素材，保留selected、bundle、prompt与reference_map的旧输出契约；新场景不再新增该步骤，直接绑定已授权媒体输入。
media.image_layout（旧版兼容）：已有发布快照仍支持一张image与layout输入，输出images与layout_manifest；新场景不再新增本地画布与排版步骤。
media.video_concat（旧版兼容）：已有发布快照仍按本机 FFmpeg 顺序拼接片段并保留原生声音，输出 video/download/manifest；新场景不再新增本地拼接步骤，成片顺序与媒体序列整理用 core.code 自定义代码完成，整片由 ComfyUI 工作流或导演台直接输出。
comfyui.commerce_pack的usage.compatibilityOnly:true：保留已有快照/旧图包下载协议，不再推荐新场景使用；文本模板与图片画布与排版同样只兼容旧快照。新图按配置组合Hermes + core.code + ComfyUI（需要生成时）+ 通用逐项执行，图中文字/图形/版式由图像模型直接生成；旧协议迁移必须显式核对清单、Amazon白底/无字等政策，不能自动替换。
长文H3已选人物→场景→道具合并为iteration.item.references.images，音色合并为iteration.item.references.audios；仅两条媒体列表分别绑定192.ref_images/ref_audios，不向节点发送四个业务分类。旧分类绑定仍兼容、不自动迁移。视频节点只接收单项时显式选择/逐项，不能静默取第一项。H3节点适配只保留在已有发布快照与历史运行中；comfyui.long_text_video保留旧ID以兼容快照并标记compatibilityOnly，显示为H3原生有声适配，通用素材选择已抽离共用。
list_capabilities 默认 limit:50（最大100），目录按安装注册顺序返回，不再分基础/专用等级；hasMore 时用同一目录的 nextCursor 继续读取，单能力声明不截断。目录 revision 变化返回 409 CAPABILITY_PAGE_CHANGED，重新读取第一页；无效参数或失效游标返回400。
只读目录/筛选不修改任何草稿、已发布快照或历史运行。已标记 compatibilityOnly 的旧步骤仍可出现在已有草稿里并继续执行，只有核对语义后才用当前 revision 显式编辑草稿，校验并重新发布。

### Qwen Image 2.1 图生图：Writer 整理 → AIXG 转提示词
复用基础 Hermes writer → Hermes aixg → ComfyUI，不安装专用执行器。先 get_scene_draft 保存 sceneId/revision/当前 publishedVersionId；完整 workflow 中先加 image_edit_writer（kind:hermes、hermesProfile:writer），接收 input.reference_images 与 input.prompt（用户想法），输出非空 text edit_brief。Writer 只整理目标、各参考图角色、修改与保持约束，忠实保留原意及指定文字，不生成参数或媒体。
仅开放五项场景输入：reference_images（图片，有序 image_list，必填）、prompt（想法，textarea，必填）、seed（随机种子，可选 number）、ratio（画幅，select，默认 1:1 (Square)）、mp（像素，number，单位 MP，默认 1）。内部 prompt key 仍代表用户想法，不要求用户自行写模型提示词。移除 negative_prompt、steps、cfg、resolution、empty 等公开字段时，同时清除相应步骤引用；负向与采样等保留 ComfyUI 固定配置，不增加隐藏用户输入。
AIXG 步骤 qwen_image_prompt 的 inputs.prompt 及模板均引用 step.image_edit_writer.outputs.edit_brief，而非绕过 Writer 的 input.prompt；同时绑定完整 input.reference_images 为真实附件。提示词按真实附件顺序使用 <image1>/<image2> 等，明确编辑目标、其他参考图角色、改动和保持、文字及空间/融合关系；不虚构图片编号，不把局部编辑改成纯文生图，不注入独立生成参数。只输出非空 text prompt，遵循统一 JSON 返回契约。
生成步骤的 inputs.prompt 与 ComfyUI 正向 binding.sourceRef 都引用 step.qwen_image_prompt.outputs.prompt。reference_images 保持完整有序列表用于同一次编辑。Zane/i2i_UI.json 的 ratio/mp 绑定 481.aspect_ratio/megapixels；479.switch 固定 true 选择由 481 → 480 建立的目标画布，图像仍进入 471 的 Qwen 图像编辑条件编码，不能把参考图丢掉。seed 绑定 476.seed；负向、步数及 CFG 不再由用户输入。节点和分支必须以本机真实工作流核对，不能盲套其他文件。
用 update_scene_draft 当前内容revision保存，再 validate_scene_draft；这些操作不执行Hermes/ComfyUI。共享选项预设保持不变，历史运行/已发布快照不自动迁移。保存响应丢失先 get_scene_draft 对账，不自动重放或覆盖；只有用户明确确认发布后才预存 publicationId 并 publish_scene，再 get_scene 固定新 versionId。get_scene/get_available_scene 的五项输入契约只来自该固定发布快照，不能从新草稿或共享预设拼装。
可显式导入 examples/scenes/image-to-image-qwen21.json，但不能让浏览器回填默认场景。writer/aixg Profile、视觉模型和 Zane/i2i_UI.json 必须在本机已配置；模型文件/节点版本需核对。Writer/AIXG失败时停止，不回退原始想法偷偷生成。真实图像质量需要用户授权另验；运行后用 get_step_result 按步骤读取 edit_brief 与 prompt，避免搬整份运行。

### 长文出视频：Writer 分镜 → AIXG 提示词 → 单工程整片顺序续接（原生有声、无音乐）
显式导入 examples/scenes/long-text-to-video.json，或用 get_scene_draft/update_scene_draft 在当前revision下编辑已有草稿；不要从浏览器默认场景回填服务端，也不自动修改旧发布/历史运行。Writer、AIXG 复用基础 core.hermes；分镜对齐、素材映射与多轨时间线由 core.code 步骤完成，ComfyUI 步骤只绑定节点，不造任何长文专用步骤（编辑、拼接、上下文续接均由 Easy-Media 工程节点内部处理）。README 与文档以 ComfyUI-Easy-Media 的 easy multiTrackEditor / easy multitrackProject / easy makeAudioList 为准。
Writer 只输出可读 storyboard 和结构化 shots（index/seconds、characters/scenes/props/voices、purpose/visual_description、逐字 dialogue 与 continuity_in/out），不负责 H3 提示词。AIXG 一次批量转换全部分镜，输出与 shots 等长的提示词字符串数组，不改写镜头元数据。项目配置须在服务端显式创建（create_scene/update_scene_draft），不从草稿拼接。
prepare_console 是 core.code 步骤：读 Writer shots、AIXG prompts 与四类媒体列表的只读 [{filename}] 投影，先校验分镜连续性、5..15秒、编号存在与不重复、每镜最多 9 图 3 音，再把 <Character n>/<Scene n>/<Prop n>/<Voice n> 全局标记编译为本镜头的 <Picture n>/<Audio n> 局部编号，生成导演台 TRACK_DATA、按运行隔离的 project_name 和计划 manifest。沙箱不接触本地路径、URL 与二进制；图片/音频文件由最终 ComfyUI 步骤直接绑定原始输入。任何越界都是明确失败，不静默漏图或漏音色。
console 是单次运行的 ComfyUI 步骤：track_data 绑定编辑器 track_data，画幅/生成像素绑定其 resolution.aspect_ratio/megapixels，project_name/segment_start_number/segment_count 绑定工程节点；人物、场景、道具图片按绑定顺序合并进编辑器 image 输入（槽位 image1..imageN），参考音色按上传顺序占用 easy makeAudioList 的 audio1..audio10 后汇入编辑器 audio 输入（槽位 audio1..audio10）。槽位顺序即全局资产顺序，与 <Picture n>/<Audio n> 局部编号一一对应；首镜 continuity_mode 为 shot，其余为 context。
场景输入与ComfyUI输入bindings可带mediaRole：character人物、scene场景、prop道具使用image_list；voice_reference参考音色使用audio_list；reference是通用参考，省略兼容旧配置。固定发布版的 get_scene 返回 inputRequirements.mediaRole 与 inputSchema x-media-role，不从草稿拼接。
先保存并validate_scene_draft，得到用户明确确认后预存publicationId再publish_scene。必须已有writer/aixg Profile、含音频列表桥接的导演台ComfyUI工作流；配置或发布不执行模型。真实生成须另获用户授权并固定versionId/runId；按get_step_result读取Writer脚本、AIXG提示词与prepare_console的manifest（分段帧数、衔接模式与槽位映射），响应丢失先按原ID对账。

## 2. 入口与部署

后台开发端口默认8798、正式端口默认8799。MCP 默认连接正式后台，可通过 ZANE_BASE_URL 指向开发/测试后台。
MCP 是独立的 stdio 薄适配器；不启动 worker，不读写 SQLite，不读取后台配置文件，不自动重启后台。必须先有兼容后台。
当前没有托管的 /mcp HTTP 协议端点；/api/v1/ai 是业务发现接口，不是 MCP transport URL。
本地 stdio 客户端可用以下启动信息；路径替换为实际安装目录，Node 必须24或以上：

~~~json
{
  "mcpServers": {
    "zane-workbench": {
      "command": "node",
      "args": ["F:/code/zane-drama/dist-server/mcp/index.js"],
      "env": { "ZANE_BASE_URL": "http://127.0.0.1:8799", "ZANE_API_TOKEN": "REPLACE_WITH_OWN_API_TOKEN", "ZANE_MCP_TIMEOUT_MS": "45000" }
    }
  }
}
~~~

先 npm ci，再 npm run build:server。客户端应直接运行 node，不要用会向 stdout 打印 npm 标题的普通 npm run mcp。
命令行调试可使用 npm run --silent mcp；stdio 看似停住是在等待客户端，不是服务挂了。
启动日志只能进入 stderr；stdout 必须只有 MCP 协议。
ZANE_MCP_TIMEOUT_MS 范围1000–300000，默认45000；wait_run 会至少保留等待时间+5秒。
大型素材上传/长时间提交准备可增大该值和客户端工具超时，超时不是任务失败。

Codex 配置示例见 examples/mcp/codex.toml；其他使用 mcpServers 的客户端参考 examples/mcp/stdio.json。
没有自动修改任何客户端的全局配置。修改启动路径/后台地址后在客户端重新加载 MCP。

## 2.1 网页、HTTP、MCP 的场景一致性

三者共用同一 WorkspaceService/SQLite，场景、流程、发布版本、预设和任务草稿只维护服务端一套。浏览器不读写本地业务场景库，不从旧localStorage初始化、不补默认或已删除场景、不改写已发布快照；未初始化时网页只提供显式空工作区初始化。浏览器仅保留待确认写入的防丢outbox：重载显示服务端快照，不自动应用或重放旧编辑；明确恢复先读服务端对账，原ID/base及冲突校验不变。坏outbox不静默过滤，原始数据保留至明确放弃。
get_workspace_status（GET /api/workspace/status）轻量返回 authority:sqlite、initialized、workspaceRevision、catalogView:draft、executionView:published。网页显示当前来源地址和共享配置 revision；与get_workspace/list_scenes核对时，先确认后台地址，再确认同一revision。
list_scenes 与网页场景目录保持同一顺序，title/summary为草稿名称，publishedTitle/publishedSummary为当前发布快照名称。draftRevision与get_scene_draft.revision一致，draftMatchesPublished标记内容差异；草稿重命名不会改掉创作页/get_scene的旧发布名称。
场景目录默认limit:50（最大200）；hasMore:true时按nextCursor续读，不能将第一页当作全部场景。游标绑定工作区revision；跨页编辑、删除、排序或其他配置变更返回409 SCENE_PAGE_CHANGED，重读第一页以避免拼出混合目录。无效游标400 INVALID_SCENE_CURSOR，无效参数400 INVALID_AI_REQUEST。空目录返回scenes:[]、total:0、hasMore:false，不补内置场景。
场景展示标题只取对应scene.title，不能用workflow.name代替：后者是独立流程配置名，复制/导入后可以沿用原名。创作表单和版本列表使用各自发布快照的场景标题；空输入任务草稿的摘要回退到该场景标题。场景改名不自动改流程配置名、不自动发布、不重写历史运行workflowName；运行记录中的workflowName仍表示当时的流程名，不是最新场景标题。
get_scene_draft 的 view:draft 对应流程配置；get_scene 的 view:published 对应创作页，按明确versionId读取不可变发布快照；正在创作的网页可能保留打开时的旧versionId，须用该ID核对，不自动切到新版。目录统一不等于自动发布草稿；历史运行保持原快照。
网页每3秒检查轻量revision，回到页面/网络恢复时也检查；未编辑时自动加载新增、编辑、排序、发布与删除。存在未同步写入、正在编辑字段/打开对话框或处于创作表单时只显示配置更新，保留内容；退出编辑后再同步，创作页先保存任务草稿再显式刷新。创作打开时固定发布快照，保存任务草稿的回执也不会暗中切换版本或重置输入；新发布版会单独提示。读取期间产生的新编辑或保存回执也会阻止旧快照覆盖。
旧后台没有轻量status端点时，网页仅兼容读取同一GET /api/workspace权威快照，不降级到localStorage。兼容模式需下载完整快照；新增get_workspace_status、目录分页和视图字段必须在后台升级到1.3.0后才可用，不能因为前端/MCP文件已构建就声称已上线。重启只切换工作台，不需要重启Hermes Gateway或ComfyUI。
写入409时仍需重读并决策；不要清除浏览器缓存/未同步队列、自动换ID重放、写镜像JSON、修改SQLite或强行重启来解决场景差异。手动放弃本机配置必须明确确认，且只有成功读取、无在途保存时才清除队列；读取失败保留原修改。

## 2.2 流程配置差异预览（1.5.5）

网页流程配置的差异预览与 get_scene_draft_diff（GET /api/v1/scenes/{sceneId}/draft/diff）共用 SceneDraftService/SQLite。对比对象是服务端已保存草稿与当前publishedVersionId的不可变快照；不是上一条历史版本，也不从浏览器缓存或实时共享预设替换发布基线。尚未发布时baseline:null，明确按空基线展示首次发布内容。
comparisonBasis:publication-ready 表示步骤复用发布时本地prepareStep规范化，避免能力版本固定和默认配置产生虚假差异；旧网页/历史未固定能力版本的步骤仅在对比副本中做同样规范化，已固定的历史版本不替换，原快照绝不改写；不能代替validate_scene_draft。规范化失败仍展示草稿并返回preparationWarnings，须修复后校验再显式发布。预览不写入、不发布、不执行模型、不创建任务。
changes按场景、流程设置、输入、步骤、输出及关联预设分组，按稳定ID/key对齐（ComfyUI绑定为direction:key）。kind为added/removed/changed/reordered；数组插入不会将后续对象误判为改动，排列顺序单独显示。path是语义对象定位，不是可执行JSON Patch；changeId稳定用于按需读取。baseline包含versionId/version/publishedAt，draftRevision供后续校验/发布，revision仅用于此差异快照。
默认limit:50，最大100；单页值文本预算65536码点，可能提前分页/分段而不是静默截断；summary/total涵盖所有差异，hasMore时使用nextCursor并沿用revision继续读取。每项before/after默认最多4000 Unicode码点（valueLimit最大32768），present区分不存在和null/空串，format区分文本/格式化JSON，complete:false与nextOffset明确标记未读完，不能把摘要当完整值。用get_scene_draft_diff_value传sceneId、revision、changeId、side、offset:nextOffset、limit继续读取；complete:true才结束。
界面仅在保存确认后预览，可传contentHash核对服务端与当前编辑一致；409 SCENE_DRAFT_CHANGED须等待保存/重读get_scene_draft。草稿、发布指针或能力配置变化导致409 SCENE_DIFF_CHANGED，丢弃旧分页拼接并从第一页重读。无关场景编辑不使差异失效。无效/跨场景游标400 INVALID_SCENE_DIFF_CURSOR，未知changeId为404 SCENE_DIFF_CHANGE_NOT_FOUND，值offset越界400 INVALID_SCENE_DIFF_OFFSET；HTTP未知键/错误类型400 INVALID_AI_REQUEST。读取响应丢失可重读同revision，不能换ID重放写入。
预览后仍按get_scene_draft → update_scene_draft → get_scene_draft_diff → validate_scene_draft → 保存publicationId → 用户明确确认后publish_scene；没有差异不意味着已经执行，预览不授予发布或生成权限。两个差异工具仅管理员可用，普通用户不能读取流程配置/提示词。后台须升级到1.5.5才能使用此入口，仅构建前端/MCP不代表已部署；无需重启Hermes Gateway或ComfyUI。

## 3. 正常生产顺序

get_workbench → list_scenes → get_scene（inputSchema/默认值/示例）→ prepare_scene → submit_scene → wait_run → get_run_outputs/get_step_result → 审核/收藏/选片/合成。

prepare_scene 参数：sceneId、versionId、inputValues。它填默认值；允许额外输入键透传并保存在运行输入中，但额外键不属于场景表单字段，也不参与workflow.inputs字段级类型/必填校验。已声明字段仍按固定发布版本的选项预设校验输入类型、素材版本/文件和已安装能力配置；步骤引用仍由发布工作流中的显式绑定决定。
它不调用 Hermes/ComfyUI、不创建任务或复制运行归档。返回 validationScope 和 externalServicesChecked:false；不承诺外部服务在线、全部引用可执行、最终费用或生成质量。
submit_scene 会重新预检，并复制发布快照进运行。之后场景改版不会改变这个运行。
历史发布版本可以通过 versionId 使用，但版本最多保留10个，过期返回 SCENE_VERSION_UNAVAILABLE；不能静默换成新版本。
workflow.publishedScene 保存来源快照 ID/哈希/日期；局部重做可能编辑工作流，所以它是来源标记，不代表修改后仍等于发布版。

执行前明确用户授权范围：允许什么生成、多少镜头、哪些审核可代决、是否允许重做。只读与预览不产生生成费用；submit/resume/rerun/approve/redo 可能生成并付费。
没有内置费用精算或预算强制上限，不要声称工具已经限制花费。

HTTP 示例（scene-demo 需替换成 list_scenes 实际返回的 ID，version-demo 同理）：

~~~http
GET /api/v1/scenes/scene-demo
POST /api/v1/scenes/scene-demo/prepare
Content-Type: application/json

{"versionId":"version-demo","inputValues":{"brief":"商品展示短片"}}
~~~

提交之前先在 AI 的任务记录中持久保存 UUID，不能直到收到响应才保存：

~~~http
POST /api/v1/scenes/scene-demo/runs
Content-Type: application/json

{"runId":"0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b","versionId":"version-demo","runTitle":"商品展示·第一版","inputValues":{"brief":"商品展示短片"}}
~~~

成功返回202：

~~~json
{"runId":"0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b","status":"queued","createdAt":"2026-10-01T00:00:00.000Z","sceneId":"scene-demo","versionId":"version-demo","version":"12ab34cd"}
~~~

## 4. 状态机与有限等待

| 状态 | AI 应做的事 |
| --- | --- |
| queued / running | 等待或读取事件；禁止重复提交 |
| cancelling | 等待取消收尾；外部已经提交的任务/费用未必撤回 |
| waiting | 读取 pendingReview 与当前节点结果，使用最新 reviewId 决策；不是失败 |
| completed | 读取输出与 archiveWarnings；完成不代表每个 foreach 子项成功，仍检查 items |
| failed | 查看 error、失败步骤/子项、事件；优先预览局部重做 |
| cancelled | 不自动恢复；授权后才创建新 runId 续跑或局部重做 |
| stale | 中断运行；读取检查点后显式恢复，不能假设外部请求未执行 |

wait_run 默认等待20秒、最多30秒；到 waiting 或终态立即返回。timedOut:true 仅表示等待窗口耗尽，不是运行失败。
返回摘要包含 nextAction、pendingReview、步骤状态与输出数量；先get_run_outputs/get_step_result按需读结果，需要完整运行时才get_run。目录和事件都分页。
MCP 调用被取消、HTTP断开或AI停止等待，不会取消后台任务。真正取消用 cancel_run。

GET /api/v1/runs/{runId}/events/history?after=0&limit=100 返回 events、nextSequence、hasMore。
每次保存 nextSequence，下次作为 after；事件可能分页，不把一次返回当完整历史。
实时客户端可用 GET /api/v1/runs/{runId}/events，SSE重连带 Last-Event-ID；MCP用有限等待/持久化事件，不保持无限工具调用。

## 5. 审核不能绕过

先 get_run 得到 pendingReview.id、stepId、instruction，再读取对应 steps 的结果。

~~~json
{"runId":"0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b","reviewId":"本次pendingReview.id","action":"approve"}
~~~

approve 可带 outputs 替换单次节点的部分结果；服务端会校验结果类型。逐项节点目前整批审核，不支持逐镜独立暂停或 outputs 编辑。
仅管理员管理审核的Hermes redo 可带 feedback 文本说明问题和期望；服务端捕获原结果、保存 feedbackHistory 并让模型按意见修订，不需要改写整段提示词。
redo 可带 stepChanges 修改 promptTemplate、hermesProfile、capabilityConfig、inputs；对象/数组配置是完整替换，不是深度merge。
approve 可能启动后续生成，redo 会重做当前节点并产生新的 reviewId。旧/重复reviewId 返回409 REVIEW_CONFLICT，重读后检查是否已执行，不自动再次批准。
waiting 时普通 resume/rerun 返回 REVIEW_REQUIRED。取消后恢复也不承诺绕过未批准关卡。

## 6. 局部修改与断点恢复

Hermes 已完成结果可用 changes.feedback:[{stepId,message,itemIndex?}] 反馈重做；单项反馈只改该项，整步反馈应用所有项。反馈和原结果保留在 feedbackHistory，后续修订/断点续跑继承有效意见；原模板和旧运行不变。
优先 preview_rerun，检查每步 action:reuse/run/replace、reason 及镜头索引。输入变化可能影响整个下游，不只一个节点。
同一份 changes 预览确认后再 rerun，使用新的、已保存的 runId。预览不是持久化锁定计划；提交时重算并校验来源状态。

~~~json
{
  "sourceRunId":"0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b",
  "changes":{"rerunSteps":[{"stepId":"video-generation","itemIndexes":[2]}]}
}
~~~

itemIndexes 从0开始；stepId 必须来自实际工作流；不要把显示名或镜头编号当 ID。
stepOverrides 修改提示词/绑定/配置，outputOverrides 代替上游文本/JSON结果，inputOverrides 修改场景输入；未改部分由服务端判断可复用。
resume_run 复用已持久化完成步骤，但尚未checkpoint的远程请求可能重做。系统不保证 exactly-once，不得把“断点续跑”描述成绝不重复计费。

## 7. 素材与媒体

素材元数据维护、运行收藏、归档和版本管理仅管理员（含使用管理员本人凭证的AI）可用。普通用户可用list_own_assets分页检索自己的未归档素材，并在用户端输入中选择其固定版本；upload_own_asset上传的素材归属从已验证身份取得。本人目录不返回他人或未归属历史，也不能维护管理员素材。UI、HTTP、MCP共用AssetService与SQLite，没有AI旁路库。
媒体执行输入首选真实assetId+assetVersion；previewUrl只是需鉴权的浏览器/HTTP显示接口，不是执行端读取凭证。后端在预检/入队阶段校验固定版本，提交时从权威素材服务归档同一任务私有副本。Hermes/AIXG把归档字节转换为inline图片附件，ComfyUI读取并上传同一来源，参考图顺序保持一致；不会把本机路径文本当图片，也不让两端自行取最新版。Hermes保留现有inline图片预算、必要时压缩；不会改变固定素材版本，ComfyUI继续使用原归档字节。不向ComfyUI/外部URL转发工作台token。管理员已有本后台同源（同协议/端口、loopback等价）或相对固定版本媒体地址也按同一服务解析；跨源地址仍为外部源，不取得本机素材权限，代理地址请用固定ID引用。普通用户仍只接受本人固定引用、不接受路径或URL。INVALID_ASSET_REFERENCE/ASSET_FILE_MISSING在排队前拒绝，不重传素材、不改提示词；读原runId确认真实失败后，显式resume_run保存新的runId并复用已完成步骤，不自动触发付费生成。OpenAPI x-asset-media-execution和媒体inputRequirements.mediaExecution提供机器契约。
list_assets默认24条、最多100条，可用q检索名称/description/分组/标签，用kind/category/group/tag筛选；archived:true包含归档。摘要含currentVersion/versionCount/revision/versionsOmitted，不携带历史与大参数。hasMore时用同一筛选的nextCursor继续；游标绑定项目、身份、筛选与目录快照。ASSET_PAGE_CHANGED重读第一页，不拼接不同快照。
get_asset读取一个摘要和当前固定reference；list_asset_versions分页读取新到旧的历史，每版含固定reference和parametersOmitted。get_asset_version读取一个版本；includeParameters:true按parametersOffset/parametersLimit读取JSON字符片段（默认8000、最多16000）。hasMore时沿nextOffset续读，完整拼接后解析，不能把片段当完整参数。
固定输入示例：

~~~json
{"reference_images":[{"assetId":"素材UUID","assetVersion":2}]}
~~~

不要只传 assetId，也不要运行时自动改成 currentVersion。归档不删除历史版本。
upload_asset 读取 MCP 进程所在机器的绝对 filePath，流式上传到后台（最多250MB），返回固定版本reference。远程后台不能看到AI所在机器的路径；用上传，不直接把该路径作为后台输入。
HTTP 上传 POST /api/v1/assets/upload?createId=预先保存的UUID&kind=image&category=material，Content-Type:application/octet-stream，X-File-Name 用 encodeURIComponent 编码；请求体是文件字节，不是 JSON 或 multipart。
upload_asset/save_asset新建必须先生成并持久保存createId；响应丢失先get_asset(assetId=createId)对账，ASSET_ALREADY_EXISTS不是幂等成功，不换ID重投。新增版本带assetId+当前revision且不带createId；回执丢失核对同ID的revision/currentVersion/source/sha256，不盲追加第二版。并发创建同ID只有一个成功。
description（最多4000字）、group（160字）、tags（最多30个，每个80字）用于检索和选材；tags更新时完整替换，其他未提供元数据保留。新建未指定category默认material，新增版本未指定分类保留原值。类型/分类不匹配、未知键与错误类型会拒绝，不静默截断。HTTP上传tags是JSON数组查询参数；不是逗号串。
浏览器只保存按身份隔离的未确认写入ID/基线revision outbox，不缓存或恢复素材快照；重载仍读取服务端。明确点击读取原ID对账后才清除提示，不自动重放。
update_asset 必须带当前revision；409后重读，不能盲覆盖。

媒体访问：GET/HEAD /api/v1/assets/{assetId}/versions/{version}/media 支持Range。
缩放预览（显示用）：GET /api/v1/assets/{assetId}/versions/{version}/preview?w=512、GET /api/v1/runs/{runId}/media/{filename}/preview?w=512，或在 output-media 上加 w。仅图片返回 WebP 派生图，非图片或缩放失败回退原字节；鉴权、HEAD/Range 与原媒体一致，不修改原媒体，也不用于执行/导出。需要原始字节时省略 w。
运行媒体用 GET /api/v1/runs/{runId}/output-media?stepId=...&itemIndex=...&outputKey=...&mediaIndex=0；最终输出不传stepId/itemIndex。本地归档（包括局部重做复用的祖先归档）支持HEAD/Range，不触发下载外部媒体或生成。
也可使用归档结果中已有的 /api/v1/runs/{runId}/media/{filename} URL；不要自行构造本地绝对路径。
相对 /api 地址应以工作台 ZANE_BASE_URL 为基址拼接；不要以MCP协议URI为基址。
当前 MCP 返回媒体位置与元数据，不把大视频/base64塞进工具结果，也不自动下载成片到AI机器。

## 8. 选片与成片整理

1. create_clip_selection：sourceRunId、视频foreach stepId、outputKey、name；来源必须终态。
2. get_clip_selection 取全部 shotId/revision；get_clip_candidates 查询同一家族、相同分镜内容的候选。
3. update_clip_selection 用当前revision替换某shotId的source，或传完整shotOrder调整顺序；每次写入后保存返回的新revision。
4. 所有镜头有固定素材版本后，compose_clip_selection 用当前revision与新的已保存runId提交。
5. 整理只执行本地 core.code 自定义代码，按选片镜头顺序输出成片媒体序列与清单 JSON，不调用生成模型、不生成新媒体文件。等待新runId，读取成片与清单。

缺镜头会拒绝合成，不静默漏镜。清单本轮不提供裁切、转场、字幕时间线等完整剪辑器功能。
候选刷新不覆盖已选版本；更新和合成的过期revision返回409。

## 9. 响应丢失与冲突恢复（最重要）

| 现象 | 正确恢复 |
| --- | --- |
| GET409 RUN_PREPARING | 遵守Retry-After，继续查询原runId |
| POST409 RUN_ALREADY_EXISTS | 查询该runId并核对来源；它不是相同payload幂等重放成功 |
| POST超时/连接中断/5xx/非JSON | 结果未知，只查事先保存的runId；不换ID，不自动重新POST |
| 未知提交后GET404 | 可能仍在准备或请求尚未处理完，继续有界查询；不能马上当成未提交 |
| REVIEW_CONFLICT | 重读run，核对新reviewId/状态，旧决定不可重放 |
| WORKSPACE_CONFLICT / ASSET_CONFLICT / CLIP_SELECTION_CONFLICT | 重读对象与revision，重新合并/选择；不要覆盖并发更改 |
| CAPABILITY_VERSION_MISMATCH | 重新发现能力与场景配置，再决定是否重新发布 |
| SCENE_VERSION_UNAVAILABLE | 重读场景并重新确认新版本；不能静默升级 |

MCP 工具结果外层为 {ok,data?,error?,requestId?}，HTTP原始API通常返回业务对象或 {error,code}。
失败的 MCP 工具会带 isError:true；error 含 code/message/status/outcome/recovery，提交相关还带 runId。
调用参数不符合schema时由SDK拒绝，未到业务API；不要把它当生成失败。
outcome:unknown 明确表示变更可能已发生。即使AI没有收到 runId 的成功响应，也不能擅自重提。
可用 requestId 对照后台日志；它不是幂等键。

## 10. 配置场景与发布业务

单场景读取get_scene_draft，返回scene/workflow、它引用的预设、内容revision、contentHash和保留版本目录；不会搬整工作区。
创建使用create_scene，先保存scene.id；空工作区原子初始化。响应丢失先读同一sceneId，SCENE_ALREADY_EXISTS不是同请求自动成功，不换ID重建。
update_scene_draft必须带当前内容revision，提供的scene/workflow是完整部分替换（不是深层patch），省略部分保持不变。可随场景添加引用的新预设，不能暗中改已有共享预设。
流程输入可设置workflow.inputs[].defaultValue；按字段类型填写，select默认值须在options中。validate_scene_draft会校验默认值；发布后固定版本的inputDefaults/inputSchema和prepare使用它预填输入，提交人明确填写的值优先。默认值修改仍需用当前revision保存并显式发布，不会自动执行。workflow.inputs[].hidden=true会从管理创作页与普通用户网页输入表单隐藏字段，输入契约和流程执行仍保留该字段；隐藏必填字段必须有有效默认值。hidden只控制网页展示，AI/HTTP/MCP仍可按发布契约提交该字段，请勿用来存放需要保密或禁止用户提交的值。
number类型的场景输入可配置minimum和maximum，都是包含边界且可分别省略；required=false表示提交人可以留空，填写时UI与服务端都会检查范围。数字默认值也必须在范围内。get_scene的inputSchema及inputRequirements会返回范围；普通用户get_available_scene返回同样的发布快照限制。对象数组itemFields中的number也支持minimum/maximum，表单和服务端按每个行字段校验。反向范围会被草稿校验拒绝。
需要用户以普通表单填写对象数组（如规格列表）时，输入字段配置示例：{key:'specs',label:'规格数组',type:'json',required:true,inputMode:'object_array',itemFields:[{key:'size',label:'尺寸',type:'select',required:true,options:['S','M','L']},{key:'stock',label:'库存',type:'number',required:false,minimum:0,maximum:999}] }。itemFields的key唯一，type支持text/number/boolean/select，select必须提供options；数字行字段可分别设包含minimum/maximum，不设置的一侧不限制。表单显示可增删行的“尺寸/库存”控件，运行值为{specs:[{size:'S',stock:24}]}这样的类型化对象数组，不要把JSON文本传给用户表单。服务端按固定发布快照校验行结构、类型、数字范围、必填和选项，最多100行。get_scene/get_available_scene返回itemFields/inputMode和对应inputSchema；步骤仍可把该数组作为JSON引用或逐项遍历。用当前draft revision更新并显式validate/publish，不自动修改现有发布版本。
双采视频是现有ComfyUI配置，不新增场景执行器：AI文生视频、AI参考生视频、文生无设计版用Zane/video_双采.json；长文用Zane/video_双采_json.json。改workflowFile必须同步核对bindings；不能只换文件名。
文本入口192.prompt、秒数155.value、分辨率115、视频92.video；参考图仍接192.ref_images。长文shot_json把完整iteration.item序列化为text写201.String；196现在是SelfLiftAvatarH3Sampler，不可写String；197是H3SigmaRefiner。长文保留逐项执行、192.length=iteration.item.frames、152.fps=24、素材ref_images/音色ref_audios、原生对白和无音乐策略以及原有拼接。
AI参考生视频的系统提示词必须写明参考图编号：writer（内容生成）步骤按上传顺序声明 图1、图2……，凡主体外观、结构、颜色、材质、logo 位置等可见事实必须标注依据 图N，且只能描述图上可见内容，不得据此猜测尺寸、容量、性能、认证、包装数量或不可见结构；aixg（提示词）步骤保持第1张对应 <Picture 1> 的映射，并与脚本引用的 图N 一一对应。附件本身不带编号语义，提示词不写编号时模型只能笼统引用“参考图”，等于放任它编造无法核验的外观事实。改这些提示词用 get_scene_draft/update_scene_draft 当前revision保存，validate_scene_draft后显式publish_scene；不自动改已发布快照或历史运行，也不在执行层临时拼编号。
电商套图（自研版与第三方版）的 套图方案 / 转提示词 系统提示词同样必须写明参考图编号：商品图附件按上传顺序编号为 图1、图2……（附件前的“第 N 张”即 图N），每个方案都必须写明产品外观依据哪几张 图N；没有编号时只有前两张沾光的方案有外观依据，后面的方案会凭空长外观。规划要求里的“第 1 张/后续图片/每张图”必须写成“第 1 个方案/后续方案/每个方案”，否则模型会把输出序号当成附件序号。商品图输入标签用“商品主图”，与提示词里的称呼一致，不要留“新输入”。改法同样是 get_scene_draft/update_scene_draft 当前revision → validate_scene_draft → 显式publish_scene；草稿有未发布改动时先人工核对，不用脚本强改。
只迁移已确认场景的草稿，保留其他配置与旧发布/运行快照；核对已有未发布编辑后，用revision校验并显式publish_scene。配置迁移不submit_scene；需要外部客户端安装双采节点/工作流，草稿结构校验不会探测其安装。
validate_scene_draft固定revision，无生成副作用地校验结构、已声明引用、默认值、预设与能力；不检查实际业务输入/素材，也不调用远程服务。
publish_scene固定revision，先保存UUID publicationId作为versionId，服务端生成内容短哈希、发布快照并固定能力版本；发布不提交运行。然后用get_scene读取真正的发布版。
发布同publicationId/同revision在保留范围内不会创建第二版；旧请求回执不会把新发布版指针切回旧版。不同请求复用ID返回PUBLICATION_ID_CONFLICT。只保留最近10版，超出范围不能无限承诺去重。响应丢失优先get_scene(sceneId,versionId=publicationId)和草稿目录对账，不盲目换ID重发。
restore_scene_draft把指定保留版本恢复到草稿，不自动发布；共享预设冲突会克隆并重映射，其他场景和既有发布快照不变。
delete_scene需要当前revision和明确删除目标；删除工作区场景/草稿/版本目录，不删除运行、素材或媒体。只在用户要求删除时调用。
list_option_presets分页读取共享预设、revision和usedBySceneIds；save_option_preset新建省略revision，替换已有必须带当前revision。修改会影响引用它的草稿，历史发布选项不变。delete_option_preset有草稿引用时拒绝并返回sceneIds。
RESOURCE_REVISION_CONFLICT返回resource、expectedRevision、currentRevision和conflicts；重新读目标对象再决策。无关场景的变化不会让单场景写入误冲突；共享预设和发布目录变化会使关联场景revision失效。
只有高级批量工作区操作才get_workspace→保存完整base→编辑完整workspace→merge_workspace。base不能是摘要或被截断的JSON；不直接写SQLite、JSON镜像或陈旧localStorage。
HTTP高级POST /api/v1/runs仍可提交完整workflow；常规生产优先固定发布版submit_scene。

## 10.1 输入契约与轻量结果

get_scene返回固定发布版本的inputSchema、inputDefaults、inputRequirements、missingRequiredInputs和inputExamples；prepare填默认值并再次验证真实输入及素材。schema描述结构，不证明素材存在、服务在线或业务内容已验收。
inputExamples标记requiresUserInput、missingRequiredInputs和syntacticallyComplete；示例文本须替换为实际内容，必需媒体不会伪造assetId。缺少素材时先list_assets/upload_asset并保存固定版本。
已知runId进度用wait_run(timeoutSeconds:0)即时摘要，不反复拉完整运行。最终输出用get_run_outputs，可按outputKey选择；单步结果用get_step_result，可按outputKey/itemIndex定位foreach镜头。
结果目录/foreach列表按cursor/limit分页，数组值按valueOffset/valueLimit分段。includeValues:false只看元数据；超过maxValueBytes明确valueOmitted/omissionReason/valueBytes，不能把缺省值当成完整结果。媒体提供精确source和HTTP预览地址，不嵌入二进制。
结果响应revision与cursor绑定到当前查询/结果版本；运行结果在分页中变化返回RESULT_PAGE_CHANGED，重新读第一页。输入、提示词和完整流程不会夹带在单步结果里。

## 11. 接管验收清单

- 后台 /api/v1/ai 返回当前契约；worker就绪，场景已发布，能力版本匹配。
- npm run ai:doctor 能从真实stdio协议发现工具/资源，并只读工作台/场景/能力，不执行生成。
- npm run test:ai:smoke 在隔离临时后台走场景→预检→提交→waiting→审核→完成，且与正式数据无关。
- AI任务日志保存 runId、scene版本、输入、事件游标、素材版本、reviewId 和清单revision。
- 已确认何时需要人工审核、允许的生成规模和重做范围。
- 提交响应丢失演练不会出现第二个运行；客户端断开不会取消后台运行。
- 正式后台升级由用户安排；本实现不自动重启正式服务或调用真实Hermes/ComfyUI。

机器契约：docs/ai-openapi.json（AI操作面与高级提交/媒体/SSE）；工具目录：docs/ai-tools.md。
生成命令 npm run docs:ai，校验命令 npm run docs:ai:check；修改schema或手册源文件后一起更新，避免文档漂移。
