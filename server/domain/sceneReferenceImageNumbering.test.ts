import assert from "node:assert/strict";
import test from "node:test";
import { applyCommercePackImageNumbering, applyReferenceVideoImageNumbering, COMMERCE_PLAN_NUMBERING, COMMERCE_PROMPT_NUMBERING, REFERENCE_VIDEO_GENERATE_CONSTRAINT, REFERENCE_VIDEO_PROMPT_CONSTRAINT, SCENE_REFERENCE_IMAGE_PATCHES, scenePatchesFor } from "./sceneReferenceImageNumbering.js";
import { COMMERCE_CARDS_DESCRIPTION, COMMERCE_DEFAULT_STYLE, COMMERCE_DEFAULT_STYLE_MARKER, COMMERCE_DEFAULT_STYLE_V4, COMMERCE_DENSITY_CLAUSE, COMMERCE_DENSITY_CLAUSE_MARKER, COMMERCE_DESIGN_MARKER, COMMERCE_DESIGN_REVISION, COMMERCE_PLAN_DESIGN_BODY, COMMERCE_PROMPT_DESIGN } from "./sceneCommerceDesign.js";
import type { RunWorkflowDefinition } from "./types.js";

/** Verbatim from the live 电商套图 · 商品原图直接排版 draft at run e2fbafc0. */
const commercePlanPrompt = `你是电商套图规划师。下面是本次任务的固定参数；商品图片以附件形式提供，标签为“商品主图”。

套图数量：{{input.number}}
提示词语言：中文
图中目标产品语言：{{input.language}}
套图风格：{{step.step_style_result_code.outputs.value}}
客户需求：{{input.need}}

附件说明：标签为“商品主图”的附件共有 1 张或多张，是同一商品的不同角度或细节，不是多个商品。

事实约束：
1. 只有“客户需求”明确写出的规格、容量、包装内容、功能、卖点和文案，才可以作为商品事实。
2. 附件图片只能支持可见的外观、颜色、轮廓、结构、纹理、材质表现和清晰可读的标识。
3. 不得从图片猜测容量、尺寸、重量、性能、功效、认证、包装数量、材质等级或不可见结构。
4. 客户需求为“无”或为空时，不得写具体数值、性能承诺、套装内容或未经确认的产品描述。

规划要求：
- 第 1 张为主图或首张 hero 图；若客户需求涉及平台主图，使用干净背景，只展示实际售卖内容，且不放未经确认的文字。
- 后续图片分别承担卖点展示、可见细节、使用场景或品牌氛围。
- 每张图只表达一个主要目的，信息密度不要过高。
- 图中文字只能使用客户需求中确认的文案；没有确认文案时可以不留文字。
- 无法确认的内容只写成视觉方向，不要写成商品事实。

必须输出恰好 {{input.number}} 张，id 唯一，index 从 1 连续递增。`;

const commercePromptStep = `你是 Qwen Image 2.1 图生图提示词编辑器，只转写，不新增事实。

目标语言：{{iteration.item.targetLanguage}}
图像类型：{{iteration.item.type}}
本轮设计：{{iteration.item.design}}
允许使用的文字：{{iteration.item.copy}}
客户需求：{{input.need}}

附件说明：标签为“商品主图”的附件是同一商品的原始商品图，1 张或多张，按编号顺序排列，是商品外观的唯一事实来源。

要求：
1. 保留附件中可见的商品外观、颜色、轮廓、结构、纹理、标识和配件关系。
2. 多张附件属于同一商品，只用于补充不同角度和细节，不得组合成多个商品。`;

const commerceWorkflow = (planPrompt = commercePlanPrompt) => ({
  sceneId: "scene_657398fc-87bf-418e-ac18-295cfae9d904",
  name: "电商套图 · 商品原图直接排版",
  inputs: [{ key: "product_images", label: "商品图", type: "image_list", required: true }],
  steps: [
    { id: "plan", name: "套图方案", kind: "hermes", hermesProfile: "ecom-design", inputs: [{ key: "input_1", label: "新输入", sourceRef: "input.product_images", selection: { mode: "all" } }], outputs: [{ key: "cards", type: "json" }], promptTemplate: planPrompt },
    { id: "step_muz67l21_2", name: "转提示词", kind: "hermes", hermesProfile: "aixg", inputs: [{ key: "input_1", label: "新输入", sourceRef: "input.product_images", selection: { mode: "all" } }], outputs: [{ key: "result", type: "text" }], promptTemplate: commercePromptStep },
    { id: "step_muz6cbw4_3", name: "生图", kind: "comfyui", inputs: [{ key: "input_1", label: "新输入变量", sourceRef: "input.product_images", valueSource: "reference" }], outputs: [{ key: "result", type: "image_list" }], promptTemplate: "", comfyui: { workflowFile: "Zane/i2i_UI.json", bindings: [] } },
  ],
  outputs: [],
} as unknown as RunWorkflowDefinition);

test("电商套图方案补上图N编号，并要求每个方案写明外观依据", () => {
  const { workflow, changes } = applyCommercePackImageNumbering(commerceWorkflow());
  const plan = workflow.steps!.find(step => step.id === "plan")!;
  assert.match(plan.promptTemplate!, /图1、图2……（附件前的“第 N 张”即 图N）/);
  assert.match(plan.promptTemplate!, /每个方案都必须写明产品外观依据哪几张 图N（至少 1 张）/);
  assert.match(plan.promptTemplate!, /必须输出恰好 \{\{input\.number\}\} 个方案/);
  assert.equal(plan.inputs?.[0].label, "商品主图");
  assert.ok(changes.some(change => change.includes("图片输入标签 新输入 → 商品主图")));
});

test("电商套图方案改成完整电商成图设计，不再只出商品摄影", () => {
  const { workflow } = applyCommercePackImageNumbering(commerceWorkflow());
  const prompt = workflow.steps!.find(step => step.id === "plan")!.promptTemplate!;
  assert.ok(prompt.endsWith(COMMERCE_PLAN_DESIGN_BODY));
  assert.ok(prompt.includes(COMMERCE_DESIGN_MARKER));
  // 参数头部保留，供步骤模板继续展开
  assert.match(prompt, /套图风格：\{\{step\.step_style_result_code\.outputs\.value\}\}/);
  assert.match(prompt, /客户需求：\{\{input\.need\}\}/);
  // 编号块只出现一次
  assert.equal(prompt.split(COMMERCE_PLAN_NUMBERING).length - 1, 1);
  // 版式、视觉系统、图中文字成为硬要求
  assert.match(prompt, /本组必须是一套电商视觉稿，不是一组商品摄影/);
  assert.match(prompt, /主色与辅助色/);
  assert.match(prompt, /图文网格与对齐方式/);
  assert.match(prompt, /图中必须有文字/);
  assert.match(prompt, /可以写不涉及功效与参数的短标题/);
  assert.match(prompt, /type 字段声明角色，取值只能是 hero、selling_point、detail、lifestyle、mood、specs、package/);
  // 原有事实约束全部保留，且明确不限制版式
  assert.match(prompt, /不得从图片猜测容量、尺寸、重量、性能、功效、认证、包装数量、材质等级或不可见结构/);
  assert.match(prompt, /以上约束限制的是「事实」，不限制版式、配色、图形与装饰/);
  // 旧的无字默认与纯摄影措辞不得残留
  assert.doesNotMatch(prompt, /没有确认文案时可以不留文字/);
  assert.doesNotMatch(prompt, /第 1 张为主图或首张 hero 图/);
  assert.doesNotMatch(prompt, /后续图片分别承担/);
  assert.doesNotMatch(prompt, /每张图只表达一个主要目的/);
  // 旧的纯静物无字示例不再被当作正面示例
  assert.doesNotMatch(prompt, /画面为纯商品静物，无文字层/);
  // 步骤声明的输出说明与新卡片契约一致，运行详情不再显示旧的 id/index/type/design/copy 形状
  const cards = workflow.steps!.find(step => step.id === "plan")!.outputs!.find(output => output.key === "cards")!;
  assert.equal(cards.description, COMMERCE_CARDS_DESCRIPTION);
  assert.match(cards.description!, /hero/);
  assert.match(cards.description!, /完整电商成图设计/);
});

test("已带编号块的草稿（自研版现状）不会重复插入编号，且只替换一次正文", () => {
  // 自研版草稿的 plan 提示词末尾已经带有共享编号块，与首次打补丁的第三方版路径不同。
  const alreadyNumbered = commercePlanPrompt + "\n\n" + COMMERCE_PLAN_NUMBERING;
  const { workflow, changes } = applyCommercePackImageNumbering(commerceWorkflow(alreadyNumbered));
  const prompt = workflow.steps!.find(step => step.id === "plan")!.promptTemplate!;
  assert.equal(prompt.split(COMMERCE_PLAN_NUMBERING).length - 1, 1, prompt);
  assert.equal(prompt.split(COMMERCE_DESIGN_MARKER).length - 1, 1, prompt);
  assert.match(prompt, /本组必须是一套电商视觉稿/);
  // 编号块仍在参数头部之后、设计正文之前，未被挤到末尾
  assert.ok(prompt.indexOf(COMMERCE_PLAN_NUMBERING) < prompt.indexOf(COMMERCE_DESIGN_MARKER));
  assert.ok(changes.some(change => change.includes("电商成图设计")));
  // 幂等
  const again = applyCommercePackImageNumbering(workflow);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.workflow, workflow);
});

test("设计正文要求整组差异化，禁止版式、主标题与背景基调重复", () => {
  // run 369fc48d 已执行 v1 正文，四张里主标题重复三次、01/02 同属「左文右图＋图标列表」家族，
  // 所以差异化必须写成硬要求，否则模型仍会把「视觉系统统一」理解成套模板。
  const { workflow } = applyCommercePackImageNumbering(commerceWorkflow());
  const prompt = workflow.steps!.find(step => step.id === "plan")!.promptTemplate!;
  assert.ok(prompt.includes(COMMERCE_DESIGN_REVISION));
  assert.match(prompt, /主标题不得重复/);
  assert.match(prompt, /同一个版式（例如左文右图、商品居中加渐变、大标题加图标列表）整组最多出现一次/);
  assert.match(prompt, /至少一张深色或高饱和背景，至少一张纯白或极浅背景/);
  assert.match(prompt, /「图标加两行文字」的堆叠列表整组最多出现一次/);
  assert.match(prompt, /发现任意两张在版式、主标题或背景基调上重复时，重写其中一张再输出/);
  // 设计强度要求：v4 起是「每一张都要」，不再是「整组至少一张」。
  // run 1ca5e258 证明整组级下限会被模型用一张达标、其余放平的方式满足（01/03 只剩一行标题）。
  assert.match(prompt, /主标题字号至少是副标题的 2 倍/);
  assert.match(prompt, /设计强度（每一张都必须满足，不是整组满足一张就算）/);
  assert.match(prompt, /每一张都要有 5–8 处图中文字，分布在至少三个层级上/);
  assert.match(prompt, /只有一行标题、或只有「主标题＋副标题」两级的图不合格/);
  assert.match(prompt, /不能是「商品居中 \+ 纯色渐变背景 \+ 一行标题」这种没有设计动作的画面/);
  assert.match(prompt, /至少用到三种/);
  assert.match(prompt, /至少一张用非常规构图/);
  assert.match(prompt, /统一圆角半径/);
});

test("v6 抬高的是密度上限：4–6 处文字与三种装饰，同时不放松文字真实性", () => {
  // v5 的实测证据：run 4447a911 四张卡片的 copy 恰好各 3 处，平均 3.0 —— 正是 v5 自己那句
  // 「每一张都要有 2–3 处图中文字」的上限。用户说「感觉跟之前没什么变化呢？」不是错觉：
  // 上限没动，画面语言就不会动。用户样本 presser_b.jpg 是 10 处文字 / 4 个层级 / 4 个实心彩色圆图标。
  // 所以 v6 改的是天花板本身，而不是再追加一条规则（前两次「规则更严」都实测退化为更保守）。
  const { workflow } = applyCommercePackImageNumbering(commerceWorkflow());
  const prompt = workflow.steps!.find(step => step.id === "plan")!.promptTemplate!;
  // 旧上限必须真正消失，否则模型仍会贴着 2–3 写
  assert.doesNotMatch(prompt, /2–3 处图中文字/);
  assert.doesNotMatch(prompt, /1–3 处图中文字/);
  assert.doesNotMatch(prompt, /信息密度不要过高/);
  // 新的密度上限
  assert.match(prompt, /每一张都要有 5–8 处图中文字/);
  assert.match(prompt, /每个方案都要有 5–8 处图中文字/);
  assert.match(prompt, /每张 5–8 处，至少覆盖主标题、副标题、图标标签、角标或底部说明四类中的三类/);
  assert.match(prompt, /「一个目的」说的是主张只有一个，不是信息少/);
  // 密度与真实性是两件事：抬高密度不得放松逐字锁定（v3 的核心成果）
  assert.match(prompt, /design 必须把该张要出现的每一处文字逐字写完/);
  assert.match(prompt, /「文字内容」受限不等于「画面要朴素」/);
  assert.match(prompt, /不要用「少写文字」的方式规避风险/);
});

test("版式段必须写出主角的面积占比与几何形状，细线不算视觉主角", () => {
  // run e8a24f97 执行 v4 后，card 01 逐条满足了「每一张都要有视觉主角」，
  // 却把「底部一条淡蓝弧形色块托底」报成了那个主角 —— 自然语言条文无法区分
  // 「一条 12px 的弧线」和「占画面 40% 的撞色分区」，于是 v4 全过而画面仍空。
  // v5 不再追加禁止项（已实测两次「规则更严→输出更保守」），改为要求写清可核对的量：
  const { workflow } = applyCommercePackImageNumbering(commerceWorkflow());
  const prompt = workflow.steps!.find(step => step.id === "plan")!.promptTemplate!;
  assert.match(prompt, /必须在第 2 段版式里写出它的面积占比与几何形状/);
  assert.match(prompt, /把第 2 段念给别人听，对方能凭这段话把构图画出来，\*\*并且能说出这块面积上有什么信息\*\*，才算写透/);
  assert.match(prompt, /只罗列「某个元素放在哪里」不算写透/);
  // 预算按段分配：版式是唯一要写透的段，低判断成本的段设上限，避免挤占版式段
  assert.match(prompt, /版式（\*\*本张最重要的段，必须写透\*\*）/);
  assert.match(prompt, /图中文字（\*\*不超过 180 字\*\*）/);
  assert.match(prompt, /约束（\*\*不超过 25 字，最多 2 条\*\*）/);
  assert.match(prompt, /保真句，固定句式开头（\*\*不超过 45 字，四张逐字相同，不要改写\*\*）/);
  assert.match(prompt, /不要逐个描述每处文字的像素或分数，那是本段最容易被写臃肿的地方/);
});

test("v7 堵住 v6 实测出的空色块漏洞：面积大不等于主角，面积必须承载内容", () => {
  // run 33dab077 执行 v6 后 card01 产出一条占画面高度 2/5 的深墨蓝横带，带内几乎无内容 ——
  // 全图 44.6% 是一块纯色（用户真值样本只有 6.0%）。根因是本模块自己给的例子：
  // 「画面右侧 40% 的斜切撞色分区」「横贯下半幅的深色色带」两个范例本身就是空色块，
  // 而规则只要求写「面积占比」，从未要求这块面积上要有信息，于是面积大反而成了合格条件。
  const { workflow } = applyCommercePackImageNumbering(commerceWorkflow());
  const prompt = workflow.steps!.find(step => step.id === "plan")!.promptTemplate!;
  assert.match(prompt, /面积大不等于主角：主角面积必须承载内容/);
  assert.match(prompt, /一块只涂了颜色的色块不是视觉主角，是空区/);
  assert.match(prompt, /单一纯色连通区不超过画面 15%/);
  assert.match(prompt, /既无文字也无图形元素的空区不超过画面 20%/);
  assert.match(prompt, /也不能是「商品旁边一块大色块，色块里什么都没有」/);
  // 旧的空色块范例必须消失，否则模型继续照抄
  assert.doesNotMatch(prompt, /画面右侧 40% 的斜切撞色分区/);
  assert.doesNotMatch(prompt, /横贯下半幅的深色色带/);
  // 背景不许纯色平涂
  assert.match(prompt, /背景不得是纯色平涂/);
});

test("v7 把版式家族从「色块几何」改为「信息架构」，并删掉自授的留白许可", () => {
  // 33dab077 的四张色块几何确实不同（横带/竖切/三格/左竖条），但信息架构完全同一个模板：
  // 主标题 + 副标题 + 1 图标标签 + 右上角标 + 4 圆形图标排成一列。原因是本模块的
  // 「版式家族」清单全是色块几何，模型合规地只换了色块。
  const { workflow } = applyCommercePackImageNumbering(commerceWorkflow());
  const prompt = workflow.steps!.find(step => step.id === "plan")!.promptTemplate!;
  assert.match(prompt, /判重看的是「信息架构」——文字与图形怎么组织，不是色块切成什么形状/);
  assert.match(prompt, /只换色块几何与配色、文字与图标仍按同一套位置排列的，算同一个版式/);
  assert.match(prompt, /① 色块托底型/);
  assert.match(prompt, /② 图标标注型/);
  assert.match(prompt, /③ 底部多栏说明型/);
  assert.match(prompt, /④ 圆形放大标注型/);
  // 真值样本的圆图标是「标注」：每个都用虚线引线指向商品具体部位并写明部位名。
  // v6 把它写成「装饰」，模型就产出与商品无关的装饰性图标行。
  assert.match(prompt, /实心彩色圆形图标是「标注」，不是「装饰」/);
  assert.match(prompt, /每个图标必须用细引导线指向商品的一个具体部位/);
  // 本模块自己发过空白许可：真值样本空区 0%，而我却把「极简大留白」列为合格版式、
  // 还要求「至少一张用…极简留白…」。
  assert.doesNotMatch(prompt, /极简大留白、网格错位/);
  assert.match(prompt, /「留白」指背景干净不杂乱，不是画面空白/);
  assert.match(prompt, /不得用「极简大留白」作为不做版式的理由/);
});

test("不再给 design 设总字数上限：该区间是本模块自造的，曾把版式段挤到最短", () => {
  // 「总长 250–450 字」是 v2 由本模块写进提示词的，平台没有任何 design 长度校验。
  // 九段强制 + 450 上限 ⇒ 每段约 45 字，而版式段需要现场做构图判断、写起来最贵，
  // 于是被「能逐字搬」的保真句/图中文字/约束段挤到最短 —— 这正是平淡的机械成因。
  // ecom-design 侧逐段复算证实：版式段 65.2 字，而图中文字 86.8、保真句 50.0。
  const { workflow } = applyCommercePackImageNumbering(commerceWorkflow());
  const prompt = workflow.steps!.find(step => step.id === "plan")!.promptTemplate!;
  assert.doesNotMatch(prompt, /总长 250–450 字/);
  assert.doesNotMatch(prompt, /总长\s*\d+\s*[–-]\s*\d+\s*字/);
  assert.match(prompt, /\*\*没有总字数上限\*\*/);
  assert.match(prompt, /版式段是唯一需要写透的段，其余段写够即可，不得靠堆字数占额度/);
});

test("设计正文区分「文字内容受限」与「画面要丰富」，不靠少写字规避风险", () => {
  // v3 收紧文字后，run 1ca5e258 的四张里有几张退化成一行标题的干净底图：
  // 约束本意是「不许编造内容」，不是「不许有设计」。
  const { workflow } = applyCommercePackImageNumbering(commerceWorkflow());
  const prompt = workflow.steps!.find(step => step.id === "plan")!.promptTemplate!;
  assert.match(prompt, /「文字内容」受限不等于「画面要朴素」/);
  assert.match(prompt, /不约束文字有几处、也不约束版式、色块、图形与装饰的丰富程度/);
  assert.match(prompt, /不要用「少写文字」的方式规避风险/);
  assert.match(prompt, /允许写、也鼓励多用的文字类型/);
  assert.match(prompt, /这些都不是功效或参数，可以放心写在图上/);
  // 主图也不能退化成白底一行标题
  assert.match(prompt, /「干净」指的是背景不杂乱，不是没有设计/);
  assert.match(prompt, /不允许做成只有一行标题的白底图/);
});

test("设计正文锁死图中文字，禁止生图模型自行补文案", () => {
  // run 369fc48d 的 card 01：design 只授权 2 处文字，图上却有 5 处，
  // 「Keeps Brush Head Clean」等 3 处是生图时编出来的，其中一处还是未确认的功效句。
  // 生图步骤只收到 design（bodyTemplate 里 prompt={{input_2}} <- iteration.item.design），
  // 收不到 copy，所以必须由 design 自己锁死文字。
  const { workflow } = applyCommercePackImageNumbering(commerceWorkflow());
  const prompt = workflow.steps!.find(step => step.id === "plan")!.promptTemplate!;
  assert.match(prompt, /生图模型只收到 design 这一个字段，收不到 copy/);
  assert.match(prompt, /design 没逐字写到的文字一律不得出现在图里/);
  assert.match(prompt, /不要给生图模型留任何自行补文案、补卖点、补标签的空间/);
  assert.match(prompt, /图中文字不得出现未确认的功效、性能、数值、规格、认证、价格、促销信息、品牌名或绝对化用语/);
  // v3 的「宁可少写、只写 1-2 处」已被删除：run 1ca5e258 证明它会诱导模型把画面做空。
  assert.doesNotMatch(prompt, /宁可少写/);
  // 不能把某个具体文案当例子写进提示词：run 46ef94e1 就是逐字照抄了旧提示词里的示例句子。
  assert.doesNotMatch(prompt, /Keeps Brush Head Clean|Cute Seal Shape|Transparent Design/);
});

test("已发布 v4 正文的草稿会升级到 v5，250–450 上限被真正移除", () => {
  // 线上当前草稿带的就是 v4 标记（v4 已发布并被执行），所以 v4→v5 是最关键的一条升级路径：
  // 正文改了但标记没升，线上草稿会被静默跳过，修复永远到不了线上 —— v1→v2 踩过一次。
  const v4PlanBody = `[Zane 电商设计]\n[Zane 电商设计 v4]\ndesign 写作格式（每个方案都遵守，按此顺序，总长 250–450 字）：\n- v4 旧正文`;
  const workflow = commerceWorkflow(commercePlanPrompt + "\n\n" + COMMERCE_PLAN_NUMBERING + "\n\n" + v4PlanBody);
  workflow.steps![1].promptTemplate = commercePromptStep + "\n\n" + COMMERCE_PROMPT_NUMBERING + "\n\n" + `[Zane 电商设计]\n[Zane 电商设计 v4]\n旧版转写正文`;
  const { workflow: patched, changes } = applyCommercePackImageNumbering(workflow);

  const plan = patched.steps!.find(step => step.id === "plan")!.promptTemplate!;
  assert.ok(plan.includes(COMMERCE_DESIGN_REVISION), plan);
  assert.doesNotMatch(plan, /v4 旧正文/);
  assert.doesNotMatch(plan, /总长 250–450 字/, "v4 的字数上限必须被移除，而不是留在正文里");
  assert.equal(plan.split(COMMERCE_DESIGN_MARKER).length - 1, 1, plan);
  assert.equal(plan.split("[Zane 电商设计 v4]").length - 1, 0, plan);
  assert.ok(changes.length > 0);

  const promptStep = patched.steps!.find(step => step.id === "step_muz67l21_2")!.promptTemplate!;
  assert.equal(promptStep.split(COMMERCE_DESIGN_MARKER).length - 1, 1, promptStep);
  assert.equal(promptStep.split("[Zane 电商设计 v4]").length - 1, 0, promptStep);
  assert.doesNotMatch(promptStep, /旧版转写正文/);

  const again = applyCommercePackImageNumbering(patched);
  assert.deepEqual(again.changes, []);
});

test("已发布 v3 正文的草稿会升级到当前版本，不被上一版标记挡住", () => {
  // 每改一次正文都必须同时升 revision 标记，否则线上已带上一版标记的草稿会被静默跳过。
  const v3PlanBody = `[Zane 电商设计]\n[Zane 电商设计 v3]\n本组必须是一套电商视觉稿，不是一组商品摄影：\n- v3 旧正文`;
  const workflow = commerceWorkflow(commercePlanPrompt + "\n\n" + COMMERCE_PLAN_NUMBERING + "\n\n" + v3PlanBody);
  workflow.steps![1].promptTemplate = commercePromptStep + "\n\n" + COMMERCE_PROMPT_NUMBERING + "\n\n" + `[Zane 电商设计]\n[Zane 电商设计 v3]\n旧版转写正文`;
  const { workflow: patched, changes } = applyCommercePackImageNumbering(workflow);

  const plan = patched.steps!.find(step => step.id === "plan")!.promptTemplate!;
  assert.ok(plan.includes(COMMERCE_DESIGN_REVISION), plan);
  assert.doesNotMatch(plan, /v3 旧正文/);
  assert.equal(plan.split(COMMERCE_DESIGN_MARKER).length - 1, 1, plan);
  assert.equal(plan.split("[Zane 电商设计 v3]").length - 1, 0, plan);
  assert.ok(changes.length > 0);

  const promptStep = patched.steps!.find(step => step.id === "step_muz67l21_2")!.promptTemplate!;
  assert.equal(promptStep.split(COMMERCE_DESIGN_MARKER).length - 1, 1, promptStep);
  assert.equal(promptStep.split("[Zane 电商设计 v3]").length - 1, 0, promptStep);
  assert.doesNotMatch(promptStep, /旧版转写正文/);

  const again = applyCommercePackImageNumbering(patched);
  assert.deepEqual(again.changes, []);
});

test("已发布 v2 正文的草稿同样能一路升到当前版本", () => {
  // 线上历史草稿可能停在任意旧版本，都必须能跨版本升到当前正文，而不是只认上一版。
  const v2PlanBody = `[Zane 电商设计]\n[Zane 电商设计 v2]\n本组必须是一套电商视觉稿，不是一组商品摄影：\n- v2 旧正文`;
  const workflow = commerceWorkflow(commercePlanPrompt + "\n\n" + COMMERCE_PLAN_NUMBERING + "\n\n" + v2PlanBody);
  workflow.steps![1].promptTemplate = commercePromptStep + "\n\n" + COMMERCE_PROMPT_NUMBERING + "\n\n" + `[Zane 电商设计]\n[Zane 电商设计 v2]\n旧版转写正文`;
  const { workflow: patched, changes } = applyCommercePackImageNumbering(workflow);

  const plan = patched.steps!.find(step => step.id === "plan")!.promptTemplate!;
  assert.ok(plan.includes(COMMERCE_DESIGN_REVISION), plan);
  assert.doesNotMatch(plan, /v2 旧正文/);
  assert.equal(plan.split(COMMERCE_DESIGN_MARKER).length - 1, 1, plan);
  assert.equal(plan.split("[Zane 电商设计 v2]").length - 1, 0, plan);
  assert.ok(changes.length > 0);

  const promptStep = patched.steps!.find(step => step.id === "step_muz67l21_2")!.promptTemplate!;
  assert.equal(promptStep.split(COMMERCE_DESIGN_MARKER).length - 1, 1, promptStep);
  assert.equal(promptStep.split("[Zane 电商设计 v2]").length - 1, 0, promptStep);
  assert.doesNotMatch(promptStep, /旧版转写正文/);

  const again = applyCommercePackImageNumbering(patched);
  assert.deepEqual(again.changes, []);
});

test("v1 正文的草稿会升级到 v2，不被家族标记挡住", () => {
  // 已发布的 v1 草稿同样含 COMMERCE_DESIGN_MARKER；若幂等判断只看家族标记，
  // 这个 revision 永远到不了线上，正是这次要防的静默跳过。
  const v1PlanBody = `${COMMERCE_DESIGN_MARKER}\n本组必须是一套电商视觉稿，不是一组商品摄影：\n- 旧版正文`;
  const v1Prompt = commercePlanPrompt + "\n\n" + COMMERCE_PLAN_NUMBERING + "\n\n" + v1PlanBody;
  const workflow = commerceWorkflow(v1Prompt);
  // 线上 v1 草稿的真实块序是「编号块在前、设计块在后」，与首次打补丁的路径一致。
  workflow.steps![1].promptTemplate = commercePromptStep + "\n\n" + COMMERCE_PROMPT_NUMBERING + "\n\n" + `${COMMERCE_DESIGN_MARKER}\n旧版转写正文`;
  const { workflow: patched, changes } = applyCommercePackImageNumbering(workflow);

  const plan = patched.steps!.find(step => step.id === "plan")!.promptTemplate!;
  assert.ok(plan.includes(COMMERCE_DESIGN_REVISION), plan);
  assert.doesNotMatch(plan, /旧版正文/);
  assert.equal(plan.split(COMMERCE_DESIGN_MARKER).length - 1, 1, plan);
  assert.equal(plan.split(COMMERCE_PLAN_NUMBERING).length - 1, 1, plan);

  // 转提示词步骤不能叠加两份设计块
  const promptStep = patched.steps!.find(step => step.id === "step_muz67l21_2")!.promptTemplate!;
  assert.equal(promptStep.split(COMMERCE_DESIGN_MARKER).length - 1, 1, promptStep);
  assert.equal(promptStep.split(COMMERCE_PROMPT_NUMBERING).length - 1, 1, promptStep);
  assert.doesNotMatch(promptStep, /旧版转写正文/);
  assert.ok(promptStep.endsWith(COMMERCE_PROMPT_DESIGN));
  assert.ok(changes.length > 0);

  // 升级后幂等
  const again = applyCommercePackImageNumbering(patched);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.workflow, patched);
});

test("设计块与编号块顺序相反时，升级不会丢掉编号块", () => {
  // 块序不是契约的一部分：无论编号块在设计块之前还是之后，升级都必须只换设计块并保留编号块。
  const promptStepWithDesignFirst = commercePromptStep + "\n\n" + `${COMMERCE_DESIGN_MARKER}\n旧版转写正文`;
  const workflow = commerceWorkflow(commercePlanPrompt);
  workflow.steps![1].promptTemplate = promptStepWithDesignFirst;
  const { workflow: patched } = applyCommercePackImageNumbering(workflow);
  const promptStep = patched.steps!.find(step => step.id === "step_muz67l21_2")!.promptTemplate!;
  assert.equal(promptStep.split(COMMERCE_DESIGN_MARKER).length - 1, 1, promptStep);
  assert.equal(promptStep.split(COMMERCE_PROMPT_NUMBERING).length - 1, 1, promptStep);
  assert.doesNotMatch(promptStep, /旧版转写正文/);
  assert.ok(promptStep.includes(COMMERCE_DESIGN_REVISION));
  const again = applyCommercePackImageNumbering(patched);
  assert.deepEqual(again.changes, []);
});

test("v1 默认风格注释会被 v2 替换，而不是残留两份", () => {
  const styleCode = [
    `const DEFAULT_STYLE = "${COMMERCE_DEFAULT_STYLE}"; // [Zane 电商设计默认风格]`,
    "return { style, size };",
  ].join("\n");
  const workflow = commerceWorkflow();
  workflow.steps!.push({ id: "params", name: "风格与尺寸", kind: "capability", capabilityId: "core.code", inputs: [], outputs: [{ key: "style", type: "text" }], capabilityConfig: { code: styleCode, timeoutMs: 5000 } } as never);
  const { workflow: patched } = applyCommercePackImageNumbering(workflow);
  const code = patched.steps!.find(step => step.id === "params")!.capabilityConfig!.code as string;
  assert.equal(code.split("const DEFAULT_STYLE").length - 1, 1, code);
  assert.ok(code.includes(COMMERCE_DEFAULT_STYLE_MARKER));
  assert.doesNotMatch(code, /\[Zane 电商设计默认风格\]/);
});

test("缺少客户需求参数行时明确失败，不静默产出半截提示词", () => {
  const broken = commercePlanPrompt.replace("客户需求：{{input.need}}", "需求：（已改名）");
  assert.throws(() => applyCommercePackImageNumbering(commerceWorkflow(broken)), /缺少「客户需求：\{\{input\.need\}\}」参数行/);
});

test("转提示词步骤保留版式与图中文字，不得压回商品摄影底图", () => {
  const { workflow, changes } = applyCommercePackImageNumbering(commerceWorkflow());
  const step = workflow.steps!.find(item => item.id === "step_muz67l21_2")!;
  assert.ok(step.promptTemplate!.endsWith(COMMERCE_PROMPT_DESIGN));
  assert.match(step.promptTemplate!, /提示词中引用商品外观时必须写明依据 图N/);
  assert.match(step.promptTemplate!, /必须完整保留 design 中的版式分区、图文关系、字体层级、配色与图形装饰元素/);
  assert.match(step.promptTemplate!, /不得简化成商品居中加纯色背景/);
  assert.match(step.promptTemplate!, /只有 copy 中的文字可以出现在图中/);
  assert.equal(step.inputs?.[0].label, "商品主图");
  assert.ok(changes.some(change => change.startsWith("转提示词") && change.includes("不得压回商品摄影底图")));
});

test("第三方版同样修好，且不动生图等无关步骤", () => {
  const thirdPartyPlan = commercePlanPrompt + "\n\n功能与品类锚点（每张都遵守）：\n- 只展示客户提供的这一个商品。";
  const workflow = commerceWorkflow(thirdPartyPlan);
  workflow.steps![2].id = "step_muz9npd0_9";
  const { workflow: patched, changes } = applyCommercePackImageNumbering(workflow);
  assert.match(patched.steps!.find(step => step.id === "plan")!.promptTemplate!, /图1、图2……/);
  assert.match(patched.steps!.find(step => step.id === "plan")!.promptTemplate!, /本组必须是一套电商视觉稿/);
  assert.deepEqual(patched.steps![2], workflow.steps![2]);
  assert.ok(changes.every(change => !change.includes("生图")));
});

test("幂等：已打补丁的电商草稿不再改动", () => {
  const first = applyCommercePackImageNumbering(commerceWorkflow());
  const second = applyCommercePackImageNumbering(first.workflow);
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.workflow, first.workflow);
});

test("第三方版默认风格不再命令模型退回纯商品摄影", () => {
  // 第三方版的 套图风格 来自这个 core.code 默认值，原值要求「以真实可售商品图为第一目标，不做扁平插画风」
  const styleCode = [
    'const DEFAULT_STYLE = "真实商品摄影风格：干净通透的棚拍质感，柔和自然光，材质细节清晰，留白充足，高级简约；以真实可售商品图为第一目标，不做扁平插画风";',
    'const analyzed = typeof inputs.analyzed === "string" ? inputs.analyzed.trim() : "";',
    'const hint = typeof inputs.styleHint === "string" ? inputs.styleHint.trim() : "";',
    'const style = analyzed.length > 0 ? analyzed : (hint.length > 0 ? hint : DEFAULT_STYLE);',
    "return { style, size };",
  ].join("\n");
  const workflow = commerceWorkflow();
  workflow.steps!.push({ id: "params", name: "风格与尺寸", kind: "capability", capabilityId: "core.code", inputs: [], outputs: [{ key: "style", type: "text" }], capabilityConfig: { code: styleCode, timeoutMs: 5000 } } as never);
  const { workflow: patched, changes } = applyCommercePackImageNumbering(workflow);
  const step = patched.steps!.find(item => item.id === "params")!;
  const code = step.capabilityConfig!.code as string;
  assert.ok(code.includes(COMMERCE_DEFAULT_STYLE));
  assert.ok(code.includes(COMMERCE_DEFAULT_STYLE_MARKER));
  assert.doesNotMatch(code, /以真实可售商品图为第一目标/);
  assert.doesNotMatch(code, /不做扁平插画风/);
  // 其余逻辑原样保留，风格参考与用户补充仍然优先
  assert.match(code, /const BASE_STYLE = analyzed\.length > 0 \? analyzed : \(hint\.length > 0 \? hint : DEFAULT_STYLE\)/);
  assert.match(code, /const SIZES|return \{ style, size \}/);
  assert.ok(changes.some(change => change.includes("默认风格")));
  // 幂等：再次应用不改动
  const again = applyCommercePackImageNumbering(patched);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.workflow, patched);
});

test("v7：密度要求拼接到实际生效的风格之后，用户填了风格补充也不丢", () => {
  // run 33dab077 实测：客户每次都传 风格补充=亚马逊电商，而 params 写的是
  // `hint.length > 0 ? hint : DEFAULT_STYLE` —— 用户补充一旦非空就整条替换掉默认风格。
  // 于是 v6 对默认风格的改写「货架信息密度型」根本没进提示词（该轮 style 就是「亚马逊电商」），
  // 密度提升全靠设计正文。v7 把密度子句拼到胜出的 base 之后，两个来源变成叠加而非互相删除。
  const styleCode = [
    'const DEFAULT_STYLE = "真实商品摄影风格：干净通透的棚拍质感，留白充足，高级简约";',
    'const analyzed = typeof inputs.analyzed === "string" ? inputs.analyzed.trim() : "";',
    'const hint = typeof inputs.styleHint === "string" ? inputs.styleHint.trim() : "";',
    'const style = analyzed.length > 0 ? analyzed : (hint.length > 0 ? hint : DEFAULT_STYLE);',
    "return { style, size };",
  ].join("\n");
  const workflow = commerceWorkflow();
  workflow.steps!.push({ id: "params", name: "风格与尺寸", kind: "capability", capabilityId: "core.code", inputs: [], outputs: [{ key: "style", type: "text" }], capabilityConfig: { code: styleCode, timeoutMs: 5000 } } as never);
  const { workflow: patched } = applyCommercePackImageNumbering(workflow);
  const code = patched.steps!.find(item => item.id === "params")!.capabilityConfig!.code as string;
  assert.ok(code.includes(COMMERCE_DENSITY_CLAUSE_MARKER));
  assert.ok(code.includes(COMMERCE_DENSITY_CLAUSE));
  // 拼接逻辑必须真的作用在胜出的 base 上，而不是只在默认分支里
  assert.match(code, /BASE_STYLE\.includes\(DENSITY_CLAUSE\) \? BASE_STYLE : BASE_STYLE \+ "；" \+ DENSITY_CLAUSE/);
  // 密度子句里不得再出现数字：数字只在设计正文单点定义，避免两处失步（v6 的 4–6 就是这么漂移的）
  assert.doesNotMatch(COMMERCE_DENSITY_CLAUSE, /\d/);
  assert.doesNotMatch(COMMERCE_DEFAULT_STYLE, /\d/);
  // 幂等
  const again = applyCommercePackImageNumbering(patched);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.workflow, patched);
});

test("没有该默认风格行的场景不被误改", () => {
  const { workflow, changes } = applyCommercePackImageNumbering(commerceWorkflow());
  assert.ok(changes.every(change => !change.includes("默认风格")));
  assert.equal(workflow.steps!.filter(step => step.capabilityConfig?.code !== undefined).length, 0);
});

test("自研版的风格字面量补上货架密度要求，不再用「简洁」抵消设计正文", () => {
  // 自研版没有 params 步骤：套图风格来自 core.code 的 fallback 字面量。它的另一个输入 analyzed
  // 由 startCondition `input.reference is_not_empty` 的步骤提供，而该字段在此场景恒为空，
  // 所以真正生效的就是这条字面量。它当时仍写着「简洁」—— 与 v6 抬高的密度上限互相抵消，
  // 和第三方版旧默认风格是同一类 bug。
  const workflow = {
    sceneId: "scene_657398fc-87bf-418e-ac18-295cfae9d904",
    name: "电商套图流程",
    inputs: [],
    steps: [
      {
        id: "step_style_result_code",
        name: "风格参考与结果",
        kind: "capability",
        outputs: [],
        capabilityConfig: { code: "return { value: inputs.analyzed ?? inputs.fallback };" },
        inputs: [
          { key: "analyzed", valueSource: "reference", sourceRef: "step_muz9j09b_6.outputs.result" },
          { key: "fallback", valueSource: "literal", literalValue: "整体风格活泼、时尚、高级、简洁，采用撞色设计，具有强视觉冲击力" },
        ],
      },
    ],
    outputs: [],
  } as unknown as RunWorkflowDefinition;

  const { workflow: patched, changes } = applyCommercePackImageNumbering(workflow);
  const fallback = patched.steps![0].inputs!.find(input => input.key === "fallback")!;
  assert.ok(fallback.literalValue!.includes("货架信息密度型"), fallback.literalValue);
  // 场景自己的意图保留下来，而不是被整条替换
  assert.ok(fallback.literalValue!.includes("撞色"), fallback.literalValue);
  // 引用型输入不受影响
  assert.equal(patched.steps![0].inputs!.find(input => input.key === "analyzed")!.sourceRef, "step_muz9j09b_6.outputs.result");
  assert.equal(changes.length, 1);
  assert.ok(changes[0].includes("风格字面量"));

  // 幂等
  const again = applyCommercePackImageNumbering(patched);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.workflow, patched);
});

test("v7：已带 v4 默认风格的 fallback 要迁移，不能被关键词守卫永久跳过", () => {
  // v6 的补丁把 COMMERCE_DEFAULT_STYLE（v4 文本，内含「货架信息密度型」和「4–6 处图中文字」）
  // 前缀到了自研版的 fallback 上。若继续用「含关键词就跳过」的守卫，这条字面量会永远停在 v4：
  // 设计正文说 5–8 处，风格字面量说 4–6 处，两个来源再次互相抵消 —— 正是前几轮修掉的那类 bug。
  const workflow = {
    sceneId: "scene_657398fc-87bf-418e-ac18-295cfae9d904",
    name: "电商套图流程",
    inputs: [],
    steps: [
      {
        id: "step_style_result_code",
        name: "风格参考与结果",
        kind: "capability",
        outputs: [],
        capabilityConfig: { code: "return { value: inputs.analyzed ?? inputs.fallback };" },
        inputs: [
          { key: "fallback", valueSource: "literal", literalValue: `${COMMERCE_DEFAULT_STYLE_V4}；整体风格活泼、时尚、高级、简洁` },
        ],
      },
    ],
    outputs: [],
  } as unknown as RunWorkflowDefinition;

  const { workflow: patched, changes } = applyCommercePackImageNumbering(workflow);
  const fallback = patched.steps![0].inputs!.find(input => input.key === "fallback")!;
  assert.ok(fallback.literalValue!.includes(COMMERCE_DEFAULT_STYLE), fallback.literalValue);
  // v4 文本必须整段消失，不能只留「4–6 处」这一句
  assert.ok(!fallback.literalValue!.includes(COMMERCE_DEFAULT_STYLE_V4), fallback.literalValue);
  assert.ok(!fallback.literalValue!.includes("4–6 处图中文字"), fallback.literalValue);
  // 场景自己的「简洁」尾巴仍在（只迁风格，不动场景意图）
  assert.ok(fallback.literalValue!.includes("简洁"), fallback.literalValue);
  assert.equal(changes.length, 1);
  assert.ok(changes[0].includes("v4"), changes[0]);

  const again = applyCommercePackImageNumbering(patched);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.workflow, patched);
});

test("非字面量或已含新风格的 fallback 不被误改", () => {
  const make = (input: Record<string, unknown>) => ({
    sceneId: "scene_657398fc-87bf-418e-ac18-295cfae9d904",
    name: "电商套图流程",
    inputs: [],
    steps: [{ id: "step_style_result_code", name: "风格参考与结果", kind: "capability", outputs: [], capabilityConfig: { code: "return { value: inputs.analyzed ?? inputs.fallback };" }, inputs: [input] }],
    outputs: [],
  } as unknown as RunWorkflowDefinition);

  // 引用型：不动
  const byRef = applyCommercePackImageNumbering(make({ key: "fallback", valueSource: "reference", sourceRef: "step.x.outputs.y" }));
  assert.deepEqual(byRef.changes, []);
  // 已含新风格：不动
  const already = applyCommercePackImageNumbering(make({ key: "fallback", valueSource: "literal", literalValue: `${COMMERCE_DEFAULT_STYLE}；撞色` }));
  assert.deepEqual(already.changes, []);
  // 别的 key：不动
  const otherKey = applyCommercePackImageNumbering(make({ key: "hint", valueSource: "literal", literalValue: "简洁" }));
  assert.deepEqual(otherKey.changes, []);
});

test("参考生视频补丁保持原行为并已入库注册", () => {
  const workflow = {
    sceneId: "scene_3a95a9cb-ed5e-468f-aac9-59b670b1f979",
    name: "AI文生视频流程",
    inputs: [],
    steps: [
      { id: "generate", name: "内容生成", kind: "hermes", inputs: [{ key: "input_1", label: "新输入", sourceRef: "input.references" }], outputs: [], promptTemplate: "基于参考图、用户想法来联想并设计扩写成详细的制作级分镜视频脚本\n画面参数： {{input.ratio}}，{{input.time}}秒\n用户输入：{{input.thought}}" },
      { id: "step_mul07sy6_2", name: "提示词", kind: "hermes", inputs: [], outputs: [], promptTemplate: "基于文案转换为提示词，模型：Minimax H3，r2v，视频脚本：{{step.generate.outputs.result}}" },
    ],
    outputs: [],
  } as unknown as RunWorkflowDefinition;
  const { workflow: patched, changes } = applyReferenceVideoImageNumbering(workflow);
  assert.ok(patched.steps![0].promptTemplate!.endsWith(REFERENCE_VIDEO_GENERATE_CONSTRAINT));
  assert.ok(patched.steps![1].promptTemplate!.endsWith(REFERENCE_VIDEO_PROMPT_CONSTRAINT));
  assert.equal(patched.steps![0].inputs?.[0].label, "有序参考图");
  assert.equal(changes.length, 3);
  const ids = SCENE_REFERENCE_IMAGE_PATCHES.map(patch => patch.sceneId);
  assert.deepEqual(ids, ["scene_3a95a9cb-ed5e-468f-aac9-59b670b1f979", "scene_657398fc-87bf-418e-ac18-295cfae9d904", "scene_48e63890-1801-429f-8dd6-0214f0a0cf0a"]);
  assert.equal(scenePatchesFor("all").length, 3);
  assert.equal(scenePatchesFor("scene_48e63890-1801-429f-8dd6-0214f0a0cf0a")[0].title, "电商套图第三方版");
  assert.throws(() => scenePatchesFor("scene_missing"), /未知场景/);
});
