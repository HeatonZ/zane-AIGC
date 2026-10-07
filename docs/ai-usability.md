# AI友好基础能力（2026-10-02）

## 结论与范围

**基础操作面已从“能执行已有场景”补齐到“能配置、发布、执行、修订和交付业务”。** 契约1.1.0有41个业务工具，分为9类；Hermes注册45个（含4辅助工具）。不另建AI任务数据库，HTTP/MCP复用现有权威服务和SQLite状态。

当前操作面见 [基础能力手册](ai-foundation.md)和 [OpenAPI](ai-openapi.json)；正式部署状态与数据保留以 [基础能力升级记录](backend-foundation-2026-10-02.md)为准。本轮执行测试使用隔离数据和本地节点，未调用真实模型、生成媒体或修改生产场景。

## 从上一轮测量解决实际问题

1.0.0正式只读测量回执位于本地 backups/workbench-upgrade-20261002-20261002T011720/ai-usability-audit.json。下表是2026-10-02当时响应字节，不是token数，也不是固定业务规则。

| 1.0.0读取内容 | 当时体积 | 1.1.0改进 |
| --- | --- | --- |
| 完整工作区 | 648,084 B，约633 KiB | 普通配置用单场景draft和revision，不搬其他场景/历史快照 |
| 10场景目录 | 8,219 B | 从目录挑目标，不读全工作区 |
| 单个发布场景 | 3,499–15,572 B | 新增输入schema/defaults/requirements/examples |
| 默认150条运行目录 | 133,984 B | 按sceneId/status筛选并小limit/cursor分页 |
| 3条代表性完成运行详情 | 17,132–29,759 B | 新增最终输出/单步/逐项接口，不夹带输入和提示词 |
| 即时wait摘要 | 1,057–1,070 B | 保留摘要轮询，不反复读get_run |

本轮正式1.1.0已上线并完成复测：单场景草稿3,404–15,194 B，约3.3–14.8 KiB，相对完整工作区少97.66%–99.47%响应字节；3条代表性运行输出元数据小页557–1,483 B，但元数据不是完整输出。详细回执见升级记录，不推算精确token成本。

## 场景业务配置

- create_scene可原子初始化空工作区；调用前保存scene.id。重复ID返回409要求读取对账，不换ID自动再建。
- get_scene_draft返回目标场景、流程、依赖预设、revision和精简发布目录。
- update_scene_draft带当前revision；提供的scene/workflow是完整部分替换，省略部分保持，不是深层patch。无关场景改动不误冲突，目标及关联预设/发布目录变化会冲突。
- validate_scene_draft校验结构、引用、默认值、预设和已安装能力，不调用生成；草稿可保存待配置能力，但校验失败不能发布。
- publish_scene由服务器生成8位内容哈希和固定能力/预设快照；先保存UUID publicationId，versionId即该ID。最近10版范围内同ID同revision返回旧回执，不重复发布，也不切回旧指针。
- restore_scene_draft只恢复草稿；共享预设冲突时克隆并重映射，不覆盖其他场景依赖。delete_scene保留运行、素材和媒体。

## 共享预设和机器输入

- list_option_presets按q/limit/cursor发现revision与引用关系；覆盖必须带revision，有草稿引用的删除明确拒绝。只读revision/usedBySceneIds不能写进preset对象。
- get_scene/prepare_scene从固定发布版返回JSON Schema 2020-12、默认值、必填/缺失要求与最小示例。false/0是有效默认值；必需媒体不虚构素材ID。
- syntacticallyComplete不等于可立即执行；还要检查requiresUserInput、素材存在性/类型、prepare结果和真实远端服务。

## 按需结果与恢复

- get_run_outputs/get_step_result按outputKey/stepId/itemIndex定位；目录和foreach结果cursor分页，数组按valueOffset/valueLimit分段。
- 默认maxValueBytes为32768，值预算在整个响应内共享；超限/只读元数据明确valueOmitted/omissionReason，不静默截断。超大标量可在上限内提高预算；超过上限需兼容get_run或业务专用读取，不能假装摘要完整。
- 媒体提供稳定source和HTTP地址，不嵌二进制；摘要/省略值不能当完整交付物。
- cursor绑定选择器和结果revision；数据变化返回RESULT_PAGE_CHANGED，重读第一页，不拼接新旧结果。
- 写入复用UI相同锁和SQLite事务，冲突透传机器码/details。响应丢失按保存的runId/publicationId对账，不自动重投。

## 后续开发不再欠AI配套

根AGENTS.md、[开发规范](ai-development.md)和PR检查表规定：功能完成条件包含权威服务、AI操作/schema/响应、错误恢复、分页/稳定ID、发现/文档、HTTP与真实stdio回归。npm run check包含工具覆盖和文档漂移门禁。

自动测试能拒绝“新工具未登记/契约文档漂移”，不能从UI自动推断新业务语义是否遗漏；开发和评审仍须登记功能、证明AI能完成操作。不能只加按钮并把AI配套留到以后。

## 验收与边界

- npm run check：261测试通过，0失败、0跳过；类型检查、前后端构建和后台/反馈/电商/AI隔离冒烟通过。
- 16项Python回归、Hermes安装客户端隔离冒烟通过；技能1.2.0定向安装到comfyui-dev，配置与职责不再修改，不写死业务。
- 预检不探测远端、不保证生成质量/费用；外部请求未落检查点仍可能重做，不承诺永久exactly-once。
- 保留全量工作区/运行接口兼容UI及高级操作；不提供任意SQL/文件/HTTP代理，不新增重复数据库。
- 托管HTTP MCP、底层凭据配置、逐镜独立审核、完整视频时间线等不是本轮承诺。现有业务操作面已覆盖，真实生产生成仍需明确授权的小任务验收。
