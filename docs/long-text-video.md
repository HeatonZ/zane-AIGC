# 长文出视频（原生对白 / 参考音色）

本场景独立于「H3 数字人长视频」。后者使用实际完整音轨驱动分段；本场景以长文/剧情为内容，以声音样本为**音色参考**，由视频模型直接生成脚本对白，不能把两种音频协议混用。

## 流程

长文/剧情与已提供资产 → Writer 直接输出制作级分镜和 H3 提示词 → 按分镜选择参考资产/音色并生成有声片段 → 本机 FFmpeg 按顺序合成。

- 无 AIXG 二次改写、资产生成、独立配音/TTS、关键帧生成、模型质检节点。
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

## 执行协议

Writer 输出 `storyboard` 可读文本和 `shots` 对象数组。每项含连续递增 `index`、5..15秒的数字 `seconds`、1-based `characters/scenes/props/voices` 编号数组和六段 H3 `prompt`，以及镜头任务、对白、起止状态。

Writer 用 `<Character n>/<Scene n>/<Prop n>/<Voice n>` 全局编号；程序按**当前镜头**所选素材编译为 H3 的 `<Picture n>/<Audio n>` 局部编号。超出参考容量、资产不存在、结构不合法会在提交 ComfyUI 前报错，不静默漏图或漏音色。

`Zane/video_json.json` 的196号 String节点仍接收完整分镜JSON，其中必须包含 `prompt` 和 `seconds`。不能只传纯文本提示词。程序额外覆盖192号 H3 `length` 和152号 CreateVideo `fps`：H3原生24fps，帧数按17k+5网格向上对齐；不沿用旧工作流30fps设置，以免视频加速并裁掉原生音频。实际成片时长可能略高于脚本目标。

逐项生成失败时停止，工作台保留每项状态，可从失败项续跑；拼接时验证片段数量与分镜顺序，防止把残缺片段列表当完整成片。

输出：完整成片及地址、可读分镜脚本、实际执行分镜（含最终提示词与引用映射）、原生有声片段、拼接记录。

## 部署和验证

```powershell
npm run typecheck
npm test
npm run build
npm run test:long-video:smoke
# 先确认生产 /api/health worker.queued/active/preparing 都为0，再重启服务
npm run scene:install:long-video
```

服务需配置 Writer Profile、ComfyUI、本地项目目录、FFmpeg/FFprobe（可设置 `FFMPEG_BIN` / `FFPROBE_BIN`）。安装脚本通过 SQLite 工作区 API 做三方合并，安装前备份工作区，发布新场景，不覆盖旧场景或其他工作流；重复安装不会覆盖现有自定义修改。

场景包：`examples/scenes/long-text-to-video.json`。单元测试包含资产/音色绑定、每镜无音乐约束和真实 FFmpeg 音视频拼接；冒烟测试使用模拟 Writer/ComfyUI 和真实 FFmpeg，**不调用实际模型生成**。
