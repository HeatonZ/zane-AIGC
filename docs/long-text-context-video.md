# 长文出视频：上下文续接配置

本方案只组合现有基础能力，不新增场景专用执行器。修改服务端草稿需带内容 revision；旧发布快照、历史运行、正在执行的任务不自动迁移。配置不是发布，发布不是生成。

## 流程

Writer → data.zip 分镜结构校验 → AIXG逐镜转换 → data.zip提示词对齐 → media.select_references素材选择及局部编号映射 → text.template强制禁音乐边界 → data.zip执行数据 → ComfyUI无上下文首段 → ComfyUI串行续段 → 基础视频列表合并 → 本地FFmpeg合成。

首段使用用户原图的独立副本，保留采样链路，移除LoadVideo、上下文Guide与上段颜色/重复帧裁切依赖，不用作者样例视频。原始图文件保持不变；续段使用用户修复后的原文件 `Zane/MiniMax+H3+真·上下文无缝无色差长视频，SelfLift双采(简易版)+.json`，绑定在提交图中修正时间轴。首段使用同采样链的无视频入口 `Zane/long_text_context_first_v1.json`；原图的 LoadVideo/Guide 不能作为无上下文首段依赖。

## 续段配置

~~~json
{"mode":"for_each","sourceRef":"step.records.outputs.rest","maxConcurrency":1,"onError":"stop","carry":{"outputKey":"result","initialSourceRef":"step.first.outputs.result"}}
~~~

`iteration.previous`为紧邻上一段result，不是整条累计长视频；第三段必须接第二段，不能反复取首段。`iteration.hasPrevious`是真布尔值。首段和每次续段均用outputMediaCounts.result=1拒绝缺失或多视频。只有一个分镜时rest为空，续段零项，合成仍保留首段。

## 分镜及素材

保留原场景公共输入。每镜index从1连续递增，seconds为5..15，selection内有characters/scenes/props/voices四组1-based数组，空组填[]。每段最多4张人物、1张场景、4张道具（总计最多9张），音色最多3条；不得虚构未上传的可选组。

全局<Character n>/<Scene n>/<Prop n>/<Voice n>由基础媒体选择服务映射为真实合并顺序的<Picture n>/<Audio n>。图片按人物→场景→道具顺序，音色独立编号；AIXG不自行猜局部编号。结构、提示词数量与所选素材在首段提交前校验；index连续性和成片片段数量还由拼接服务核验，结构校验不等于语义和演出质量验收。

原专用适配的applied_shot交付改为records：原分镜、最终prompt、参考媒体与reference_map；manifest保留实际探测片段时长及原声音轨信息。

## 节点绑定

| 数据 | 节点与端口 |
| --- | --- |
| 当前段prompt | 138.value |
| 当前段新内容秒数 | 132.value |
| 画幅/像素 | 115.aspect_ratio / 115.megapixels |
| 当前段参考图 | 136.ref_images |
| 当前段参考音色 | 136.ref_audios（不是ref_video_audios） |
| 上一段视频 | 256.file，video_list单项选择 |
| 上下文开关 | 267.value ← iteration.hasPrevious |
| 上下文帧组数 | 273.value = 1，即22帧 |
| 总帧数公式 | 131.expression |
| 原生帧率 | 179.fps = 24；续段另设297.fps = 24 |
| 本段新视频 | 298.video → result |

## 本机插件兼容

修复前250号节点的 `SelfLiftH3Sampler.model_hires` 与本机当前插件函数不兼容，会在真实执行时报 unexpected keyword argument。用户已在原图换成339号 `SelfLiftAvatarH3Sampler`，实际端口为 `low_res_model` / `high_res_model`。续段直接使用该修复原图，不使用临时续段副本；首段入口保持相同双模型、LoRA、采样器及采样参数。不修改插件、不重启ComfyUI。

原图含4个前端 `Reroute`，它们不是ComfyUI后端节点。工作台共享UI转换器（契约1.5.21 / x-comfy-ui-routing v1）在提交时解析中继链与扇出，保留真实源/出口并移除API图中的虚拟中继；不修改原文件。循环、缺失源、多来源或非零中继出口拒绝为400 INVALID_COMFY_REROUTE，API格式工作流不受影响。

ComfyUI JSON 的 `widgets_values_named` 可能优先于 `widgets_values`；修改副本时二者同步，首段131.expression再提供显式运行绑定。隔离测试必须检查转换后提交图的首段24fps公式、实际采样class_type与两个模型端口，不能仅检查保存fps。

## 时间轴

本机安装的MiniMax H3节点源码声明原生音视频为24fps、帧数对齐17k+5。原图的30fps与a*30不能直接套原生音频；若未来真正添加24→30同步重采样链路，应重新核验，而不是只改保存帧率。

- 首段对round(seconds*24)向上对齐17k+5。
- 续段先加入22帧上下文，再对齐，避免裁掉上下文后新内容缩短。
- 续段131.expression：`max(5, round(a * 24) + 22) + (5 - (max(5, round(a * 24) + 22) % 17)) % 17`。
- 续段AIXG采样时间整体加22/24秒（约0.9167秒），不把新对白写进会被裁掉的上下文；Writer的新段相对时间保持原值。
- 保留原图尾帧采样、Guide、音频羽化、时序裁切及颜色转移。帧网格可能使片长略高于目标，不为凑整数加速对白。
- 音色参考不复用文字/背景声；禁止音乐、演唱、哼唱。明确呼吸、反应、停顿、收尾，不重复上一段句尾或已完成动作。

## 验收

隔离测试使用临时端口/项目/数据、真实stdio MCP、模拟模型与真实FFmpeg，覆盖无视频首段、三段滚动carry、单段空rest、前段准确字节上传、失败只重做续段与音轨合成。

真实生成必须有业务授权。使用受鉴权的管理员高级HTTP运行入口，通过同一RunService绑定本人身份，不为测试发布生产场景，不直接写任务SQLite，不建旁路任务库。提交前保存UUID runId；丢回执只对账，不自动重投。短测收紧为恰好两段各5秒、低像素；失败停止，不自动付费重试。

技术成功（节点/时间轴/音轨/续接来源正确）不代表视听质量必然达标。应交付真实样片供验收，未生成不能宣称真实端到端成功。
