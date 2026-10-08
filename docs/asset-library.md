# 管理员素材库

素材库沿用现有 AssetService 与权威 SQLite 的 assets 文档；媒体复制到项目 .zane/assets/blobs，以 SHA-256 去重。没有浏览器业务数据库，也没有 AI 专用旁路库。历史素材无需自动迁移。

## 管理入口

管理员后台 → 素材库。元数据维护、运行收藏、归档及版本管理仅管理员开放。普通用户在客户端媒体输入中可打开“我的素材库”，分页搜索并选择自己上传的固定版本；目录和预览按当前登录身份校验，不能读取他人素材或未归属历史。AI 可通过 `list_own_assets` 读取同一身份范围的分页目录；上传继续使用 `upload_own_asset`。

- 上传图片、视频、音频（非空、最多 250MB），或在完成的运行输出中“存入素材库”。导入和检索不触发生成。
- 分类：角色、场景、道具、音色、普通素材；角色/场景/道具仅图片，音色仅音频。
- 用名称、说明、分组、标签组织素材。说明适合记录具体内容、用途及限制，便于 AI 选材，但不代替执行或版权授权。
- 检索覆盖名称/说明/分组/标签；类型和分类筛选，分组/标签精确筛选；列表按更新时间从新到旧分页。
- 详情可编辑元数据、上传新版本、分页查看旧版本、复制 AI 固定版本引用，以及归档/取消归档。
- 归档不删除文件或历史版本。既有任务不会自动改用最新版。

## 客户端选择本人素材

- 普通用户在已授权场景的图片、视频或音频输入中，选择“从我的素材库选择”。列表按当前字段的媒体类型筛选，可按名称、说明、分组或标签搜索并分页。
- 目录只包含服务端归属为当前登录用户且未归档的素材；服务端从已验证身份取得 owner，不接受客户端传入的 userId。选择返回固定 `assetId` + `assetVersion`，多项输入按选择顺序追加。
- 普通用户仍不能编辑素材说明、上传新版本、归档素材或浏览管理员素材目录。可在输入中上传新文件，后续即可从自己的素材库复用。
- `GET /api/v1/self/assets`、`GET /api/v1/self/assets/{assetId}` 与素材媒体 GET/HEAD/Range 共用身份校验；用户 AI 可使用 `list_own_assets` 按同一边界分页读取目录。

## AI 使用

使用管理员本人 AI 凭证，经已有 stdio MCP 连接工作台；无新增插件或数据库安装要求。普通用户 AI 使用自己的凭证，只能经 `list_own_assets` 读取本人素材目录。

1. list_assets 分页检索（默认 24 条，最多 100 条）；摘要明确省略版本和大参数。
2. get_asset 读取说明、revision、versionCount 及当前固定 reference。
3. list_asset_versions 分页查看历史；get_asset_version 精确读一个版本，参数只按需分段读取。
4. 给任务提供 {"assetId":"素材ID","assetVersion":2}。不要只传 assetId，也不要自动跟随 currentVersion。
5. upload_asset/save_asset 新建前保存 createId；已有素材新增版本提供 assetId + 当前 revision，不能混用 createId。
6. update_asset 提供当前 revision，未提供的元数据保留，提供 tags 则完整替换。

服务端校验、权限复核、固定版本解析及文件归档均来自同一业务服务；没有“AI自动生成/发布”附带副作用。媒体 GET/HEAD/Range 使用同一身份权限。

## 并发与回执未知

创建 ID 在发送前保留；同 ID 并发创建只会一个成功，其余 ASSET_ALREADY_EXISTS。新增版本和元数据变更用 revision 防止覆盖。写入后回执丢失先查询原 ID，并核对 revision/currentVersion/source/sha256；404 也不能立即排除原请求仍在落库，不能换 ID 重试。

浏览器防丢 outbox 按登录身份隔离，只保存未确认写入的 ID、操作和基线 revision；重载后不恢复、重放或覆盖业务状态。管理页可显式读取服务端对账、核对后清除提示。失效身份在异步复制结束、元数据落库前会再次被拒绝。

分页游标绑定项目、登录身份、筛选和快照。ASSET_PAGE_CHANGED 要重读第一页；INVALID_ASSET_CURSOR 表示游标不属于本次查询。素材与版本列表、单版参数分段都不会静默截断。

## 兼容与上线

AI 契约现为 1.5.26；1.5.0 引入的兼容边界继续生效：list_assets/get_asset/写入响应改为素材摘要，不再返回整份 versions；管理员应通过 list_asset_versions/get_asset_version 读取历史和参数。普通用户 `list_own_assets` 返回本人素材摘要及当前固定 reference，不返回历史版本/大参数；其分页游标绑定身份、筛选和目录快照。新建管理员上传/收藏需要 createId。存量素材、内部归档和普通用户本人附件接口保持兼容。

代码更新后须按项目正式升级约定核验进程身份、空闲任务和备份，再正常切换工作台及同步 MCP 编译产物。开发与隔离验收不会重启生产、Hermes Gateway 或 ComfyUI。

## 执行端素材读取与 401

任务媒体输入首选真实 {"assetId":"素材ID","assetVersion":1} 固定引用。previewUrl 是需要身份校验的浏览器/HTTP 显示接口，不是执行端下载凭证。后端预检和入队复用 AssetService/SQLite 的固定版本校验，提交时归档任务私有副本。AIXG 提示词步骤与 ComfyUI 生成步骤都消费这个固定版本来源：Hermes/AIXG 识别内部归档对象的 path，读取字节并转换为 inline 图片附件；ComfyUI 读取同一来源的原字节并按参考图绑定顺序上传。不会只把路径文本写进提示词，也不会让两端分别取 currentVersion；不向 Hermes/ComfyUI 或外部 URL 转发工作台 token，不公开媒体、不增加临时签名旁路。

Hermes 继续执行现有单图及整个 inline 请求的预算，必要时压缩图片；固定素材版本和参考图顺序不变，ComfyUI 仍使用原始归档字节。图片在预算内时，两端收到的图片字节完全一致。

若固定引用通过预检，但 AIXG 在发出模型请求前报“图片输入缺少可读取的文件或 URL”，这是旧图片适配器未消费归档对象 path 的兼容漏点，不是提示词配置或素材上传失败。升级后同一固定引用可直接被两个基础步骤读取，不需要重新上传素材或修改提示词；续跑仍需明确授权。

管理员既有的相对 /api/v1/assets/{id}/versions/{version}/media，以及当前后台同源（同协议/端口，localhost、127.0.0.1、::1 等价）的完整地址，也解析为同一固定素材引用。跨源/代理地址不取得本机素材权限，使用固定 ID 引用；普通用户仍只接受本人附件的固定引用，路径、URL 和他人素材在原权限服务中拒绝。无效版本/类型返回 INVALID_ASSET_REFERENCE，文件丢失返回 ASSET_FILE_MISSING，预检不访问外部生成服务。

若旧运行在提示词完成后报“媒体服务返回 401”，先查询原 runId 确认真实状态，升级后显式调用 resume_run（sourceRunId=原运行、runId=预先保存的新ID）。原运行与发布快照不修改，已完成提示词步骤按断点规则复用；不会要求重传仍存在的原素材、改提示词或自动重新执行付费步骤。续跑仍是需明确授权的执行操作。

机器契约由 OpenAPI x-asset-media-execution 与媒体 inputRequirements.mediaExecution 同源提供；imageConsumers 明确两个图片消费端的共同来源和 Hermes 预算策略。npm run test:asset:execution:smoke 使用临时鉴权后台、真实 stdio MCP 及 loopback mock AIXG/ComfyUI，跑固定素材输入 → AIXG 图片提示词 → ComfyUI 的完整双端链路，核对两端图片 SHA256 和参考图顺序、提示词输出连接、不转发工作台凭证、预检无生成、分页/旧 revision/丢回执对账，以及用户归属隔离。可显式传入 --fixture <绝对图片路径> --asset-id <ID> --fixture-sha256 <SHA256> 只读复现指定图片；所有导入、版本测试和运行都在临时项目/数据库中，不修改原素材、不调用真实模型或生产运行。
