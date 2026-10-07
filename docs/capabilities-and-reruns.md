# 能力包与局部重做

## 基础优先：复用 → 补强 → 节点适配

不为长文、商品图、分镜等场景各造一个执行器。Profile、提示词、数据引用、ComfyUI工作流/节点绑定及通用逐项/条件/审核机制优先复用；现有基础能力不足时先拆出或补强通用能力。只有H3数字人这类定制节点的时间轴、提示词注入、帧数/音频协议需要专用适配。

- **媒体引用选择**（`media.select_references`）：输入各组素材与从1开始的序号，输出选中媒体、映射提示词、引用表。不写死人物/场景/商品分类；通用配置groups支持image/audio/video。长文H3适配复用同一素材选择与映射实现，不复制逻辑。
- **图片画布与排版**（`media.image_layout`）：输入恰好一张图与layout规格，本地输出图片和layout_manifest。商品图、封面、海报复用同一实现；批量用通用逐项执行，每项归档按稳定运行/步骤/索引隔离，不覆盖其他项。尺寸、留白、背景和文案都由配置表达；过长文字报错，不截断。
- **H3节点适配**：H3数字人长视频仍保留；旧`long_text_video`标识不变，显示为“H3原生有声适配”。保留H3特有的帧网格、六段提示词、原生声音规则，不把“逐项生成”当成专用能力。
- **旧电商图包**：`comfyui.commerce_pack`只兼容现有发布快照和旧图包ZIP/清单协议，`usage.compatibilityOnly:true`；排版已调用基础服务。新场景用基础生成（需要时）+排版+逐项组合。多平台尺寸和白底/无字策略可作为layout配置，但基础排版不会自动猜平台政策，也不自动产生旧图包ZIP协议。

新空工作区的首个默认方案及可导入示例：`examples/scenes/basic-image-layout.json`；旧电商包移至最后并标注旧版兼容，不给已有工作区自动插入/改写场景。它只需一张源图和多规格参数，执行“基础素材选择 → 通用逐项排版”，不调用Hermes/ComfyUI生成服务。需要AI底图时，可在同一草稿中组合已有Hermes与基础ComfyUI步骤。

目录统一由现有执行器注册表投影：`GET /api/v1/capabilities?tier=basic&limit=50`与MCP `list_capabilities`同源。默认查询all以兼容旧客户端，按基础→专用排序；UI新步骤默认展示基础，专用按需展开，旧兼容包仅在当前步骤使用时显示。响应包含usage、端口/配置valueSchema、完整目录revision、hasMore和nextCursor；跨tier游标400，目录变化409 CAPABILITY_PAGE_CHANGED。客户端读完整分页后才使用目录，不静默截断。

所有已发布快照、稳定能力ID/执行版本和历史运行保持不变；不自动编辑/发布生产草稿。新能力通过已有创建、编辑、发布、执行、结果工具完成闭环，不另建AI数据库或任意执行代理。字体可用`ZANE_IMAGE_FONT_FILE`，兼容`ZANE_COMMERCE_FONT_FILE`；未配置时依赖系统的文字字体支持。


## 用户入口

### 先配置能力包

1. 打开“流程配置”，选中一个步骤。
2. 在“执行方式”中选择能力。目录由服务端提供，名称、输入/输出、配置表单和结果展示方式来自能力声明。
3. 填写配置并连接步骤输入，正常发布场景即可。

新增的“文本模板”是无模型调用的示例能力：模板 `商品：{{product}}` 会使用名为 `product` 的步骤输入。可以新增多个输入；输出 `text` 是固定契约，不能改成其他 key 或类型。

### 再修改结果或局部重做

1. 打开“运行记录”，选择已结束的运行。
2. 点击“修改结果 / 局部重做”，或展开步骤点击“重做本步骤 / 替换本步结果”。逐项结果可使用“只重做第 N 项 / 替换此项结果”。
3. 选择操作：
   - **反馈并重做 Hermes 结果**：无需改提示词，填写哪里不好和希望如何修改；系统会把反馈与原结果一起交给 Hermes。支持整步或某一项，前序与独立分支复用，下游依赖重新计算。
   - **修改参数 / 重新生成**：可改能力配置、提示词、Hermes Profile、步骤输入引用或固定值；不改参数也可重做。
   - **直接替换生成结果**：修改中间文本/JSON，或选择本地图像、视频文件；该步骤不再调用生成器。音频可用 JSON 路径列表替换。本地替换文件在任务接受前复制到新版本的媒体归档，删除原选择文件不影响该修订。
4. 点击“预览影响范围”，确认哪些步骤替换、重算、复用，以及逐项步骤要重做的项。预览不创建任务，也不调用模型。再编辑会废弃旧预览。
5. 点击“创建新版本并执行”。服务接受后才跳转到新运行；提交失败时编辑器保留草稿。
6. 新记录可“查看原运行 / 对比原结果”。旧记录、文件和场景原配置不会被覆盖。

例如三镜头逐项生成只重做第二镜：第一、第三镜的成功结果复用；后续汇总/合成步骤重新执行，独立分支复用。修改中间分镜文本后，生成步骤使用新文本，不需要再次让 Writer 生成全文。

### Hermes 反馈闭环

- 创作结果页及运行记录中展开 Hermes 步骤，点击“反馈并重做”；逐项结果可点击“反馈并重做第 N 项”。
- 填写具体问题和修改目标，预览影响范围后提交，创建关联到原运行的新修订版。原结果、已发布场景和提示词不会被覆盖。
- 人工确认关卡可直接填写“退回重做的反馈意见”，再点击退回；同一运行重新执行当前关卡，保留前序结果，并产生新的确认令牌。
- “Hermes 反馈历史”保存意见、作用范围、时间、来源运行和当时原结果；再次反馈时累积意见，但使用最新被反馈的结果作修订参考。断点恢复与服务重启不会丢失反馈。
- 单项意见只应用于同一索引且来源内容未变的项，避免修改列表后误用另一项的反馈；整批意见会应用于所有项，但每次只把该项自己的原结果交给模型。
- API/MCP 局部重做使用 `changes.feedback: [{ stepId, message, itemIndex? }]`，审核退回使用 `{ reviewId, action: "redo", feedback: "具体意见" }`。只接受已有完成结果的 Hermes 步骤；空意见、伪造原结果、重叠范围或同时替换并反馈同一步骤会被拒绝。
- 提交反馈重做可能产生模型及下游生成费用，预览本身不执行生成。

## 能力包开发

核心契约在 `server/capabilities/contracts.ts`；运行接口在 `server/capabilities/package.ts`。在 `server/capabilities/packages/` 新增一个 `.ts` 文件，默认导出工厂即可自动发现。开发加载 TypeScript，构建后的服务加载对应 JavaScript；新增或修改包后需构建并重启正式服务。

下例可保存为 `server/capabilities/packages/prefixText.ts`。不需要修改设计器下拉菜单、执行器 switch 或结果面板：

```ts
import type { CapabilityFactory } from "../package.js";
import { resolveStepInputs } from "../../domain/workflowValues.js";

const factory: CapabilityFactory = () => ({
  definition: {
    id: "text.prefix", version: "1", label: "文本加前缀",
    description: "本地拼接，不调用模型。", category: "文本",
    legacy: { kind: "capability" }, dependencyMode: "declared",
    inputs: [{ key: "text", label: "原文", type: "text", required: true }],
    outputs: [{ key: "text", label: "结果", type: "text" }],
    config: [{ key: "prefix", label: "前缀", type: "text", defaultValue: "" }],
    editor: { inputs: "ports", outputs: "ports", editablePorts: false },
    result: { renderer: "text" },
  },
  async execute(context) {
    const inputs = resolveStepInputs(context.step, context.inputValues, context.stepValues);
    return { text: String(context.step.capabilityConfig?.prefix ?? "") + String(inputs.text ?? "") };
  },
});
export default factory;
```

### 声明责任

- `id` 必须唯一；当前同一服务只安装每个 ID 的一个版本。版本是显式字符串，不做范围匹配。
- 运行快照固定 `capabilityId`、`capabilityVersion` 和有效配置。能力缺失或版本不一致在排队前拒绝，避免静默用新实现重放旧流程。
- `legacy` 将旧的 kind/ComfyUI adapter 映射到内置能力；旧场景无需先批量迁移。新自定义包使用 `kind: "capability"`。
- 配置支持 `text / textarea / number / boolean / select / json / reference`。默认写入 `capabilityConfig`；`path` 可映射到旧嵌套配置。JSON 配置为对象/数组；无效草稿不会被旧值偷偷代替后继续执行。
- `editor` 决定端口、ComfyUI bindings、Profile、提示词、条件编辑区；固定输出端口不可增删或改 key/类型。
- `result.renderer` 支持 `auto / text / json / media`。本机制覆盖这些通用展示方式，不声称任意定制界面都无需扩展前端。
- 工厂可使用注入的 Hermes、ComfyUI、条件运行接口，或直接实现本地能力；连接器核心仍由服务组装，不是全部从 `server/index.ts` 抽离了。
- 包执行器应返回与端口契约相符的 JSON 数据。`validate(step)` 可补充包自己的参数预检。

### 依赖声明与复用

`dependencyMode: "declared"` 表示执行器只读取公开声明的引用：步骤输入、ComfyUI 输入绑定、提示词中的流程引用、条件、遍历来源，以及 `type: "reference"` 配置字段。读取其他上游结果而未声明，会造成错误复用，因此不要对这种包使用 `declared`。

未声明依赖模式或显式 `all-prior` 的包保守依赖全部场景输入和此前步骤。电商图包、长文逐镜等读取较宽上下文的能力使用保守模式。历史单项参数快照的引用也参与失效分析，不只检查全局步骤。

## 修订 API

- `GET /api/v1/capabilities`：返回 `{ schemaVersion: 1, capabilities }`，只含声明，不包含执行代码。
- `POST /api/v1/runs/:runId/rerun/preview`：请求 `{ changes }`，返回执行计划。
- `POST /api/v1/runs/:runId/rerun`：请求 `{ changes, runId?, runTitle? }`，成功返回 `202` 和新运行 ID/计划。进度、取消、事件与归档继续使用普通运行接口。

`changes` 允许下面四组修改，可以组合不同步骤的修改；逐项编号从 **0** 开始：

```json
{
  "inputOverrides": { "story_seed": "新的场景输入" },
  "stepOverrides": [{
    "stepId": "generate",
    "itemIndex": 1,
    "promptTemplate": "本次修订提示词"
  }],
  "outputOverrides": [{
    "stepId": "writer",
    "outputs": { "text": "手动修改的中间文本" }
  }],
  "rerunSteps": [{ "stepId": "compose" }]
}
```

这只是字段结构示例，引用的 key/步骤 ID 必须实际存在。存在上下游冲突时请求会被拒绝，应拆成两次修订。常见单独请求：

```json
{ "rerunSteps": [{ "stepId": "generate", "itemIndexes": [1] }] }
```

```json
{ "outputOverrides": [{ "stepId": "writer", "outputs": { "text": "修改后的文案" } }] }
```

`stepOverrides` 只接受 `promptTemplate / hermesProfile / capabilityConfig / inputs / comfyui`；不能改步骤身份、执行方式或输出契约。配置对象是**完整替换**而非深合并，清空可用 `{}`，之后依能力默认值进行准备。`outputOverrides.outputs` 只替换提交的输出 key，其他输出保留。场景输入整体修改目前通过 API；界面支持编辑选中步骤自己的输入。

## 版本、恢复与边界

- 已完成、失败、取消、待恢复运行可以创建修订；活动运行返回 409。失败步骤继续支持原来的断点续跑。
- 替换仅适用于已完成结果。逐项步骤必须指定具体项目，且父步骤已完成；不把失败父步骤伪装成成功。
- 选中逐项重做会保留其他成功项，失败或中断项仍会重试。参数快照跟随修订版本保存，失败后续跑不会恢复为旧提示词。
- 历史单项参数只在同一索引且来源值未变时继续应用。列表长度、顺序或项目内容变化导致无法证明对应关系时，重新计算而不把旧参数套到新项目。
- 无法证明下游逐项步骤的索引对应关系时，保守重算整个下游步骤；不承诺“第二镜变化后任何下游都只算第二镜”。
- 旧的**整流程级** `workflow.execution.mode = "for_each"` 记录暂不支持局部修订。应先迁移成步骤级逐项执行。
- 每次修订都创建新 ID，记录 `rerunFromRunId / rerunPlan / rerunRequest`，并标记复用和替换的步骤/项。排队修订跨重启恢复；正在执行的任务中断后仍遵循 `stale` + 显式续跑语义，不承诺外部模型 exactly-once。
- 复用结果可能引用原运行的媒体归档。**不要只删除旧运行的 `.zane/runs/<id>` 文件夹**；当前没有按引用计数自动回收祖先媒体。
- 未重启的旧服务不支持修订路由时，前端明确提示重启，绝不偷偷回退为整条流程重跑。

## 验证

`npm run check` 覆盖类型检查、自动发现的前后端测试、构建、编译产物与电商隔离冒烟。修订回归覆盖依赖失效、源版本不变、单项参数/结果替换、错误请求、排队修订跨 SQLite 重开恢复和单项失败后续跑。编译冒烟验证动态能力发现、模板执行、无副作用预览、选择性修订及跨进程重启后的版本持久化。均不调用真实付费模型。
