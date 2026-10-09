import { aiOperations, AI_CONTRACT_VERSION } from "./operations.js";
import { AI_FOUNDATION_FEATURES } from "./features.js";
export const AI_FOUNDATION_GUIDE = [
  "# AI 基础能力", "", "由 npm run docs:ai 生成；契约 " + AI_CONTRACT_VERSION + "。当前 " + aiOperations.length + " 个业务操作，功能与请求定义同源。", "",
  "## 功能覆盖", "",
  ...AI_FOUNDATION_FEATURES.flatMap(feature => ["### " + feature.id, "", feature.description, "", "| 工具 | HTTP | 副作用 |", "| --- | --- | --- |", ...feature.operations.map(name => { const operation = aiOperations.find(item => item.name === name); return operation ? "| `" + name + "` | `" + operation.method + " " + operation.path + "` | " + operation.effect + " |" : "| `" + name + "` | 缺失（验收失败） | — |"; }), ""]),
  "## 最小使用闭环", "",
  "- 已有场景：get_workbench → list_scenes → get_scene（固定版本的输入schema/默认值/示例）→ prepare_scene → submit_scene（先保存UUID runId）→ wait_run → get_run_outputs/get_step_result。",
  "- 能力选型：list_capabilities({tier:basic})优先复用；通用素材映射/图片排版使用media.select_references / media.image_layout；逐项计划/素材/提示词严格对齐用data.zip（rows/first/rest）；复杂数据变换与控制流用core.code本地沙箱执行（不联网、不计费，契约x-code-step）；精确JSON值schema随目录返回。基础缺口先补强，专用仅做定制节点适配；compatibilityOnly:true只保留旧流程。",
  "- 新业务：create_scene（先保存scene.id）→ get_scene_draft → update_scene_draft（当前revision）→ validate_scene_draft → publish_scene（先保存UUID publicationId）→ get_scene读取真实发布版；发布不执行生成。",
  "- 共享选项：list_option_presets查看revision/使用场景 → save_option_preset；恢复旧发布版时共享选项冲突会克隆，已发布快照不变。",
  "- 局部修订：preview_rerun确认影响范围 → rerun（先保存新runId）；审核用最新reviewId，不绕过waiting。",
  "- 结果：摘要看状态，输出按key/stepId/itemIndex读取；目录/镜头cursor分页，数组值分段；valueOmitted和valuePage.complete必须检查。媒体返回HTTP地址和稳定source，不塞二进制；终态媒体打包用get_run_media_export/get_own_run_media_export核对revision和下载地址，不生成或下载远程媒体。", "",
  "## 一致性与恢复", "",
  "网页/HTTP/MCP仅服务端一套SQLite场景/流程/发布/预设/草稿；网页不维护本地业务库，空初始化不导入浏览器缓存，重载不自动应用或重放防丢outbox。get_workspace_status核对来源revision；list_scenes按浏览器目录顺序分页，title为草稿、publishedTitle为发布版，draftMatchesPublished明确差异。游标跨revision返回409 SCENE_PAGE_CHANGED；创作get_scene不跟随草稿。网页在空闲时自动同步，在未同步写入/字段编辑/对话框/创作表单中仅提示更新；不覆盖编辑、不自动发布。",
  "内容revision只针对目标场景及其预设/发布目录，无关场景编辑不误冲突；所有写入复用现有工作区锁和SQLite事务。旧revision返回当前revision/冲突对象，重新读取再决策。",
  "发布以publicationId为versionId，在最近10版保留范围内同请求不会重复发布；旧回执不会把新发布指针切回旧版。响应丢失先用同ID读回，不自动换ID重投。",
  "输入schema描述数据结构，不保证素材文件/远程服务/业务质量；最小示例需看requiresUserInput和missingRequiredInputs，媒体不会伪造素材ID。",
  "删除场景不会删除运行/素材/媒体，删除有草稿引用的共享预设会拒绝。高级整工作区操作仍可用三方合并，但不是普通单场景配置的必经步骤。", "",
  "## 后续功能要求", "",
  "新业务功能必须同步交付AI操作面、schema/响应/恢复规则、功能矩阵、手册及真实stdio隔离回归；完成条件见 [AI开发规范](ai-development.md)，仓库根AGENTS.md和PR检查表已纳入约定。",
  "详细参数见 [OpenAPI](ai-openapi.json)，操作与恢复见 [操作手册](ai-operator.md)，工具目录见 [AI工具](ai-tools.md)。", "",
].join("\n");
