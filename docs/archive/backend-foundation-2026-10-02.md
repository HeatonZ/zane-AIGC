# 基础能力1.1.0升级记录（2026-10-02）

## 当前状态：已上线并验收

正式8799已切换到最终构建，**AI契约1.1.0、41业务工具**；真实Node stdio与Hermes安装客户端的正式只读验收通过。不是只完成磁盘构建或隔离冒烟。旧一次性脚本已执行，不能重复运行。

| 项目 | 实际状态 |
| --- | --- |
| 后台 | http://127.0.0.1:8799；最终PID 89640，本次最终切换旧PID 89880 |
| 项目 | F:\project\zane，数据仍在F:\code\zane-drama\data\production |
| Worker | ready/accepting为true，queued/active/preparing均为0（验收快照） |
| 数据 | SQLite version2、quick_check为ok；10场景/10发布场景、150运行、614事件、157步骤、4生产文档；revision77 |
| MCP | 41业务工具；Hermes注册45工具（含4辅助）、4资源、1提示词 |
| Hermes技能 | comfyui-dev的zane-workbench升级到1.2.0；只改技能，config.yaml和SOUL.md字节不变 |

数量、PID和目录是本机这次验收快照，不写死为profile职责或未来项目规则。

## 实际验证

- 最终全量npm run check：**261测试通过，0失败、0跳过**；包含类型检查、前后端构建、后台/反馈/电商隔离冒烟、文档一致性和真实stdio基础业务闭环。
- 16项Python安装/接入回归通过；最终编译产物的Hermes安装客户端隔离验收通过。
- 正式Node/Hermes doctor通过，项目正确、guide/skill可读，当前发布版无控制profile自调用节点。
- 发布接口201/200回执与预设读写响应契约已复查；修正了只读revision字段不能被写入限制排除的OpenAPI交叉约束，新增回归，**在线OpenAPI实际确认已加载修正**。
- 所有执行测试使用隔离端口/项目/数据和本地节点；正式验收只有读取，没有提交任务、批准审核或调用真实模型/媒体生成。

## 数据保留与切换

先核验实际进程身份、创建时间、ready和空闲状态、无未完成运行；重新生成文档、全量检查并核对源码指纹后，仅切换工作台，离线复制整个数据目录（含WAL/SHM），同cwd/端口/数据/启动环境运行新版。未重启Hermes Gateway或ComfyUI，上游Git工作区保持清洁。

最终切换前后及最终复查：**全部数据库表哈希一致，连接配置哈希一致，场景业务快照一致**。首轮切换之后，日志在2026-10-02 12:06:52 +08:00记录外部页面重新加载与POST /api/workspace/merge，revision76→77但业务快照内容哈希及其他表不变；没有为维持旧哈希而回滚外部写入。最终切换基线与复查均为revision77。

本轮环境文件沿用已核验前一进程的启动输入，不声称重新捕获运行时环境。敏感文件只留忽略备份，不粘贴/提交。数据备份不是完整项目媒体备份；回退前需核对新记录，不能用旧备份覆盖新增生产数据。

## 正式响应体积复测

下表为本次HTTP响应字节，**不是token数**，也不是所有业务的固定成本。

| 读取 | 实测 |
| --- | --- |
| 完整工作区 | 648,084 B，约633 KiB |
| 单场景草稿（10场景） | 3,404–15,194 B，约3.3–14.8 KiB |
| 相对完整工作区的读取减量 | 97.66%–99.47%响应字节 |
| 3条代表性运行详情 | 11,838–52,499 B |
| 对应输出元数据小页 | 557–1,483 B |

输出元数据页不含完整值；必须按key/stepId/itemIndex继续读取并检查valueOmitted/分页完整性，不能拿这个体积宣称读取了完整产物。当前修改普通单场景不再搬整个工作区；发布版输入schema/示例可直接消费。

## 备份与回执

最终备份：F:\code\zane-drama\backups\workbench-foundation-contract-20261002T121410。首轮备份：F:\code\zane-drama\backups\workbench-foundation-20261002T115536。

| 文件/目录 | 内容 |
| --- | --- |
| production | 实际停服后的完整正式数据目录离线备份，含WAL/SHM |
| switch-build.log、hermes-isolated-smoke.log、python-tests.log | 最终全量261测试及隔离/接入验收 |
| switch-source-fingerprints.txt | 验证期间源码指纹；最终文档回执变化单独登记 |
| switch-before-database.json、switch-after-database.json、final-database.json | 切换及最终数据库计数/哈希 |
| launch.json、final-verification.json、database-preservation.json | 最终PID、数据和配置/其他服务保留证明 |
| final-ai-doctor.json、final-hermes-doctor.json | 正式只读MCP验收 |
| ai-foundation-audit.json | 正式响应体积/输入契约复测，不保存提示词或输入内容 |
| dist、dist-server | 切换准备时的磁盘构建备份，不宣称是进程内存代码的精确副本 |
| process.json、process-environment.json | 身份与启动环境来源说明；环境内容含秘密，仅本地保留 |

Hermes技能备份：E:\Data\hermes\profiles\comfyui-dev\backups\zane-workbench-20261002T035649Z-e9baec0f。安装器复查changedFiles为空；平台/模型/DaVinci配置与SOUL保留。

## 后续使用

旧Hermes会话可能缓存工具/职责；需要时在comfyui-dev空闲会话使用受支持的/reload-mcp，并开启新会话，不必重启Gateway。本轮没有替用户发频道命令。

下一步是一个明确授权的小业务真实验收，尚未进行付费模型/媒体生成；不以doctor通过代替真实产物质量验收。以后业务功能必须同步交付AI配套，见 [开发规范](ai-development.md)、根AGENTS.md和PR检查表。前一轮1.0.0事实保留于 [历史升级记录](backend-upgrade-2026-10-02.md)。
