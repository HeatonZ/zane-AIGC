# 长文出视频（原生对白 / 参考音色）

本场景独立于「H3 数字人长视频」。后者使用实际完整音轨驱动分段；本场景以长文/剧情为内容，以声音样本为**音色参考**，由视频模型直接生成脚本对白，不能把两种音频协议混用。

## 流程

长文/剧情与已提供资产 → Writer 输出制作级分镜与对白 → AIXG 按分镜逐镜转换 H3 提示词 → 按分镜选择参考资产/音色并生成有声片段 → 本机 FFmpeg 按顺序合成。

- Writer 负责故事、镜头、对白和连续性；AIXG 只转换模型提示词，不重新编剧、拆镜或更改对白/时长/资产选择。无资产生成、独立配音/TTS、关键帧生成、模型质检节点。
- 每片段最终提示词都由程序追加禁止音乐和仅参考音色的约束，`non_diegetic_music: N/A`。
- FFmpeg 保留片段原生声音，不插入音乐或重新配音。仅做容器/编码/分辨率/音频采样率一致化；不是质量检查模型。
- 提示词约束不能保证模型绝不生成音乐或绝对匹配音色；需要针对实际模型效果做真实样片确认。

## 输入

- `content`：长文/剧情。
- `character_assets`、`scene_assets`：必填图片列表；`prop_assets`：可选道具图列表。
- `voice_reference_audio`：可选的清晰纯人声音色样本。建议不要包含音乐、其他人声音和过长停顿，并确保有权使用。
- `asset_notes`：必填上传顺序与角色/场景/道具/音色对应说明。各组独立编号，从1开始。例如：人物1=林舟，人物2=苏晴；场景1=办公室；道具1=红信封；音色1=林舟，音色2=苏晴。
- `production_notes`：画面风格、改编要求与需保留的内容。
- `target_seconds`、`ratio`、`mp`：目标时长、画幅和生成百万像素；默认60秒、9:16、0.7MP。

当前 Hermes 图片请求最多12张项目参考图；每个 H3 片段最多9张图片、3个参考音频。素材库不必全部用于每一镜：Writer 为每段选择需要的编号，程序按人物→场景→道具次序绑定，避免多个类别互相覆盖。

Hermes 当前不传送音频附件，因此 Writer 不会假装听过样本；它依据音色对应说明写对白和声线分配，实际音频由 `LoadAudio` 接入 H3 的 `ref_audios`。

### 素材用途与 ComfyUI 媒体端口

业务分类不是 ComfyUI 节点类型；上游场景输入支持可选 `mediaRole`：`character` 人物、`scene` 场景、`prop` 道具对应 `image_list`；`voice_reference` 音色对应 `audio_list`；`reference` 或省略表示通用参考。用途不是新的媒体类型，不改变权限、固定版本或节点协议。ComfyUI 编辑器不再提供“添加分类素材”或用途下拉框；它仅绑定普通图片/音频/视频列表。旧用途字段与分类绑定保留兼容，不自动修改旧发布快照。

人物、场景、道具分别取当前镜头子集，复用基础媒体引用服务按人物→场景→道具顺序合并为 `iteration.item.references.images`，**只有一条图片列表绑定到 `192.ref_images`**；本镜音色合并为 `iteration.item.references.audios`，只有一条音频列表绑定到 `192.ref_audios`。空组不占位，组内保持上传顺序、不去重，`Picture/Audio`编号与最终列表严格一致；不把音频和图片混在一起。

通用流程使用 `media.select_references`：上游组名可以是人物/场景/道具、商品/封面等；输出 `selected.GROUP`保留分类，新增可选`images/audios/videos`按媒体类型合并，再通过基础ComfyUI绑定传入。同类型列表合并不是文件内容拼接；视频节点若只支持一个视频，仍必须选择单项或逐项执行，不能静默漏掉其他视频。固定发布版的 HTTP/MCP `get_scene` 同时返回 `inputRequirements.mediaRole` 和 `inputSchema.properties.KEY["x-media-role"]`。已有场景只在当前 revision 下编辑草稿，核对后显式发布，不自动替换旧发布版。

## 执行协议

Writer 输出 `storyboard` 可读文本和 `shots` 对象数组。每项含连续递增 `index`、5..15秒的数字 `seconds`、1-based `characters/scenes/props/voices` 编号数组，以及镜头任务、`visual_description`、逐字对白、起止状态；不输出模型提示词。

AIXG 复用基础 Hermes 的 `for_each` 遍历 `step.writer.outputs.shots`，只输出当前镜头的非空 text `prompt`（六段 H3 格式）。生成步骤仍遍历 Writer 原始 `shots`，`inputs.prompts` 引用 `step.aixg.outputs.prompt` 汇总列表；程序仅按对应顺序注入提示词，不让模型改写原镜头元数据。整列表数量、所有分镜和提示词的非空/类型/长度、时长与素材引用在第一次 ComfyUI 提交前校验；六段标题只是建议，缺段、重复或顺序不一致仅给 ⚠ 非阻断提示，不因格式停止生成。提示在生成前写入既有步骤/逐项 warnings，UI、HTTP/MCP 可读取；实际结果也保留 applied_shot.prompt_warnings。格式异常不截断可能包含动作/对白的尾部，追加既有禁音乐策略；AIXG 缺失、失败或空提示词直接停止，不回退 Writer 提示词。旧发布快照未配置 `prompts` 输入时保持原有 inline `prompt` 协议。

Writer 和 AIXG 用 `<Character n>/<Scene n>/<Prop n>/<Voice n>` 全局编号；程序按**当前镜头**所选素材编译为 H3 的 `<Picture n>/<Audio n>` 局部编号。超出参考容量、资产不存在、结构不合法会在提交 ComfyUI 前报错，不静默漏图或漏音色。

`Zane/video_双采_json.json` 的201号 String节点仍接收完整分镜JSON，其中必须包含 `prompt` 和 `seconds`。不能只传纯文本提示词。双采图的196号节点是 `SelfLiftAvatarH3Sampler`，不得再向196号写入 `String`；197号 `H3SigmaRefiner` 保留工作流自身配置。旧版发布快照和历史运行仍引用原工作流，不自动替换。程序额外覆盖192号 H3 `length` 和152号 CreateVideo `fps`：H3原生24fps，帧数按17k+5网格向上对齐；不沿用旧工作流30fps设置，以免视频加速并裁掉原生音频。实际成片时长可能略高于脚本目标。

逐项生成失败时停止，工作台保留每项状态，可从失败项续跑；拼接时验证片段数量与分镜顺序，防止把残缺片段列表当完整成片。

输出：完整成片及地址、可读分镜脚本、实际执行分镜（含最终提示词与引用映射）、原生有声片段、拼接记录。

## 部署和验证

```powershell
npm run docs:ai
npm run check
# check 包含真实 stdio MCP、长文隔离冒烟和文档漂移检查
```

服务需配置 Writer 与 AIXG Profile、ComfyUI、本地项目目录、FFmpeg/FFprobe（可设置 `FFMPEG_BIN` / `FFPROBE_BIN`）。正式部署须另外获得明确确认，核验工作台进程身份、worker queued/active/preparing均为0并备份数据后正常切换；不重启 Hermes Gateway 或 ComfyUI。仅构建不代表运行中的后台或场景已升级。

`npm run scene:install:long-video` 只用于明确授权安装**新场景**：通过 SQLite 权威工作区 API 做三方合并，安装前备份工作区并发布新场景，不覆盖旧场景或其他工作流；重复安装不会升级已有场景。已有长文场景应先读取当前草稿和发布快照，在当前 revision 下合并 AIXG 步骤与四类用途，保留自定义输入/绑定/预设，校验及差异核对后显式发布。不要直接用新版整包覆盖已有未发布修改。

场景包：`examples/scenes/long-text-to-video.json`。单元测试包含资产/音色绑定、每镜无音乐约束和真实 FFmpeg 音视频拼接；冒烟测试通过真实 stdio MCP 执行固定发布版，使用模拟 Writer/AIXG/ComfyUI 和真实 FFmpeg，**不调用实际模型生成**。


## 上下文续接方案

需要第二段起自动参考上一段视频时，按[上下文续接配置](long-text-context-video.md)在草稿中迁移为基础能力组合：独立首段 + 串行 `for_each.carry` + 本地合成。该方案不会自动替换本文旧发布版；首段不使用作者样例视频，原生帧率、上下文帧数及裁切后的新内容时长需同时核验。
