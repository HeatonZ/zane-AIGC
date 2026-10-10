# 长文出视频：上下文续接配置

本方案只组合现有基础能力，不新增场景专用执行器。修改服务端草稿需带内容 revision；旧发布快照、历史运行、正在执行的任务不自动迁移。配置不是发布，发布不是生成。

## 流程

新草稿共7步，但只有两次AI调用，视频脚本与模型提示词分开：

1. **Writer**（writer Profile，一次）：完成长文改编与制作级视频分镜脚本，输出可读 `storyboard` 和原始 `shots`；包括每镜叙事任务、景别/机位/站位/动作/光线、起止连续性、素材选择、时长、逐字对白与语气/停顿/时间。**不输出prompt或H3提示词外壳**。
2. **AIXG**（aixg Profile，一次批量）：只转换Writer已确定的全部分镜，输出按原顺序一一对应的 `prompts` 字符串数组；不重新编剧、拆镜、改台词、时长或素材选择。
3. **align / data.zip**：原始Writer分镜与AIXG提示词等长对齐，校验分镜结构和1-based连续序号；原始shots不含prompt，不接受Writer混入模型提示词。
4. **references / media.select_references（旧版兼容）**：按原始selection选择本镜素材，将全局标签确定性映射为实际Picture/Audio编号。该步骤已标记 `compatibilityOnly:true`，只为已发布快照保留；新场景直接绑定已授权媒体输入，省略这一定位步骤。
5. **records / data.zip**：保持原始Writer镜头对象，将映射后的prompt和逐镜媒体包对齐为执行记录。
6. **generate**：同一个ComfyUI工作流以for_each.carry串行自动续接。
7. **assemble**：本地FFmpeg合成，保留原生声音。

不恢复逐镜AIXG调用、单独禁音乐模板、首段生成分支或两路片段收集。两个data.zip分别保证脚本/提示词与最终媒资的逐项边界，使用现有基础能力，不为了减少展示步数让AIXG重写原分镜。确定性素材映射和状态管理不交给AI。
所有片段都使用用户修复后的原文件 `Zane/MiniMax+H3+真·上下文无缝无色差长视频，SelfLift双采(简易版)+.json`，首项267.value=false，后续为true。原图不改动，不塞作者样例视频。已发布旧版使用的 `Zane/long_text_context_first_v1.json` 文件保留供旧快照/历史运行使用，但新草稿不再引用。

本机内置ComfySwitchNode确为lazy，但提交验证会递归验证其两个已连接输入。共享提交器在运行绑定后仅断开已证明静态布尔值开关的未选中可选输入，保留节点、选中分支、输出ID和其他消费者；未知/循环/自定义选择器保持原样。显式空可选视频绑定清除原图示例文件。关闭上下文后SaveVideo不再能追溯到LoadVideo；开启时仍检查真实前段输入。配置/预览不处理，执行UI/API图均处理，不修改ComfyUI插件或源码。契约1.5.22 / x-comfy-static-switch v1。

## 单工作流生成配置

~~~json
{"mode":"for_each","sourceRef":"step.records.outputs.rows","maxConcurrency":1,"onError":"stop","carry":{"outputKey":"result"}}
~~~

不设initialSourceRef：首项iteration.previous=null、hasPrevious=false；后续previous为紧邻上一段result，hasPrevious=true，不是整条累计长视频，第三段接第二段。outputMediaCounts.result=1拒绝缺失或多视频，前段失败不调后段。只有一个分镜时同一生成步骤只执行一项，直接合成，不需首段/rest特殊分支。

逐项JSON来源的嵌套媒体与上游输出共用归档缓存保存，避免归档前后定位符不同导致新链续跑错误重算首项。前缀仍须内容匹配且输出有效，第一处变化/缺口失效后缀，不按文件名猜等价、不修改历史。

## 分镜及素材

保留原场景公共输入。每镜index从1连续递增，seconds为5..15，selection内有characters/scenes/props/voices四组1-based数组，空组填[]。每段最多4张人物、1张场景、4张道具（总计最多9张），音色最多3条；不得虚构未上传的可选组。

全局<Character n>/<Scene n>/<Prop n>/<Voice n>由基础媒体选择服务映射为真实合并顺序的<Picture n>/<Audio n>。图片按人物→场景→道具顺序，音色独立编号；Writer/AIXG不自行猜局部编号。data.zip用ordinalField=index在首段提交前拒绝跳号、重复或重排，并校验原始分镜的5..15秒、所选素材及制作字段结构；AIXG提示词与分镜、映射列数量必须一致，不截断或补齐。提示词要求为非空六段字符串，不是Writer分镜字段；拼接服务再次核验片段数量/顺序。结构校验不等于提示词语义、对白可发声时间或演出质量验收。

原专用适配的applied_shot交付改为records：原分镜、最终prompt、参考媒体与reference_map；manifest保留实际探测片段时长及原声音轨信息。

## 节点绑定

| 数据 | 节点与端口 |
| --- | --- |
| 当前段prompt | 138.value |
| 当前段新内容秒数 | 132.value |
| 画幅/像素 | 115.aspect_ratio / 115.megapixels |
| 当前段参考图 | 136.ref_images |
| 当前段参考音色 | 136.ref_audios（不是ref_video_audios） |
| 上一段视频 | 256.file ← iteration.previous，可选video_list；输出每次严格1项，无需首项单项选择 |
| 上下文开关 | 267.value ← iteration.hasPrevious |
| 上下文帧组数 | 273.value = 1，即22帧 |
| 总帧数公式 | 131.expression，131.values.b ← iteration.hasPrevious |
| 原生帧率 | 179.fps = 24；续段另设297.fps = 24 |
| 本机裁切兼容 | 179.codec = auto（保留已有裁切兼容） |
| 本段新视频 | 298.video → result |

## 本机插件兼容

修复前250号节点的 `SelfLiftH3Sampler.model_hires` 与本机当前插件函数不兼容，会在真实执行时报 unexpected keyword argument。用户已在原图换成339号 `SelfLiftAvatarH3Sampler`，实际端口为 `low_res_model` / `high_res_model`。所有片段均直接使用该修复原图，不使用首段/续段副本；原图自身的开关按首段/续段选择既有采样参数。不修改插件、不重启ComfyUI。

原图含4个前端 `Reroute`，它们不是ComfyUI后端节点。工作台共享UI转换器（契约1.5.21 / x-comfy-ui-routing v1）在提交时解析中继链与扇出，保留真实源/出口并移除API图中的虚拟中继；不修改原文件。循环、缺失源、多来源或非零中继出口拒绝为400 INVALID_COMFY_REROUTE，API格式工作流不受影响。

ComfyUI JSON 的 `widgets_values_named` 可能优先于 `widgets_values`；本方案不改原图或复制副本，统一使用显式运行绑定。声明但未连线的V3 named autogrow标量端口（如values.b）按object_info中枚举名称解析与发现，拒绝任意点号端口。隔离测试检查转换后公式、开关、实际采样class_type、两个模型端口与输出可达分支，不能仅检查保存fps。

本机 `VideoFromComponents.as_trimmed` 对 `start_time + duration` 做严格浮点比较；158/24秒与22/24 + 136/24秒可产生约8.88e-16秒差值，导致有效裁切返回None。续段179.codec运行绑定为auto，通过现有编码视频包装的裁切实现规避空结果，不修改ComfyUI源码/插件或原图。会增加一次中间编码及一定耗时；上游修复后可另行验收是否恢复none，不能只删除兼容参数而不真实测试。

## 时间轴

本机安装的MiniMax H3节点源码声明原生音视频为24fps、帧数对齐17k+5。原图的30fps与a*30不能直接套原生音频；若未来真正添加24→30同步重采样链路，应重新核验，而不是只改保存帧率。

- 首段对round(seconds*24)向上对齐17k+5。
- 续段先加入22帧上下文，再对齐，避免裁掉上下文后新内容缩短。
- 统一131.expression：`max(5, round(a * 24) + 22 * b) + (5 - (max(5, round(a * 24) + 22 * b) % 17)) % 17`，b是iteration.hasPrevious；首项不加上下文，后续加22帧。
- Hermes在一次输出中把续段prompt采样时间整体加22/24秒（约0.9167秒），不把新对白写进会被裁掉的上下文；结构化分镜和对白新段相对时间保持原值。
- 保留原图尾帧采样、Guide、音频羽化、时序裁切及颜色转移。帧网格可能使片长略高于目标，不为凑整数加速对白。
- 音色参考不复用文字/背景声；禁止音乐、演唱、哼唱。明确呼吸、反应、停顿、收尾，不重复上一段句尾或已完成动作。

## 验收

`npm run test:context-video:smoke`使用临时端口/项目/数据、真实stdio MCP、模拟Hermes/ComfyUI服务和真实FFmpeg，覆盖7步Writer/AIXG各一次、Writer无prompt、AIXG消费原始分镜、执行记录保留原始脚本、提示词素材映射与采样补偿、原图开关拓扑转换、无样例首段、三段滚动carry、单段、前段准确字节上传、失败只重做续段、revision冲突/丢回执对账、Writer缺字段/混入prompt、AIXG数量不等/非文本、无效素材/乱序生成前拒绝、逐项分页及音轨合成。测试图是原图拓扑的去布局fixture，不要求本机模型/安装路径；真实原图文件保持不变。

真实生成必须有业务授权。使用受鉴权的管理员高级HTTP运行入口，通过同一RunService绑定本人身份，不为测试发布生产场景，不直接写任务SQLite，不建旁路任务库。提交前保存UUID runId；丢回执只对账，不自动重投。真实短测建议恰好两段各5秒、低像素；失败停止，不自动付费重试。此7步草稿本轮不调用真实模型，不能复用旧11步样片作为新配置的真实验收。

可导入配置见 `examples/scenes/long-text-context-video.json`。Writer一次制作、AIXG一次批量转换减少逐镜调用，但超长内容仍受所选Profile的上下文/输出预算限制；响应被截断或结构无效会停在数据阶段，不自动增加AI重试/旁路补全。

技术成功（节点/时间轴/音轨/续接来源正确）不代表视听质量必然达标。应交付真实样片供验收，未生成不能宣称真实端到端成功。

AIXG数组按位置关联：程序能校验数量和数据类型，不能证明生成文本的语义一定对应原镜头，仍需视听验收。脚本不回写不等于模型一定忠实演出。仅修改配置不要求升级服务；本轮更新的本地发现/说明源码须随下一次安全升级生效，当前正式服务的运行能力已支持该7步草稿。

## 固定音色的执行上传（1.5.23）

参考音色首选素材库固定 `assetId + assetVersion`。后端完成权限与版本校验并保存任务私有副本；即使经素材选择、bundle、data.zip及for_each传递，基础audio_list绑定也须读取该私有path的原始音频字节，按当前镜头引用顺序上传为ComfyUI input附件，再以LoadAudio接ref_audios。不能直接把私有路径对象当作ComfyUI filename，也不能尝试访问受保护previewUrl或转发工作台凭证。每文件最多100MB；现有合法input音频附件保持原行为，不重复上传。读取/超限/上传失败发生在prompt提交前，无自动重试。

回归以临时数据中的两个音色固定版本覆盖真实stdio MCP上传、丢回执对账、旧revision冲突、版本分页、预检无上传、素材选择/列表对齐后的准确字节与顺序、上传失败不提交prompt、legacy附件及失败续跑不重放Writer/AIXG。不调用真实模型。历史失败保持原样；修复部署后仍需明确确认断点续跑（新runId），不能仅因服务恢复就自动重试。
