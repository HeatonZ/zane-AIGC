# 商业化客户端设计（积分制 · CDK 兑换 · 场景包）

> 状态：**设计稿**，尚未改动任何代码。依据当前仓库（契约 `AI_CONTRACT_VERSION = 1.5.45`，2026-10-17）。
> 本文回答三个问题：能不能做、代价在哪、分几步做。

## 0. 结论与待拍板的四项决策

**结论：可行，而且是当前代码库少有的"顺架构"改造。** 执行、归属、发布三件事都已经收口在单一权威服务上，积分只是在这些收口点上加一层账本；真正的难点不是积分，而是"场景包"引入的**跨场景编排层**。

D1 已定（SaaS 多租户），其余三项按下面推荐的默认值展开；你改哪一项，我改对应章节：

| # | 决策 | 默认取值（推荐） | 改了会怎样 |
| --- | --- | --- | --- |
| D1 | 交付形态 | **已定：SaaS 多租户**（账号=租户，逻辑隔离）；单机起步，水平扩展延后。**不新开代码库、不 fork**（见 §1.4） | — |
| D2 | 计费口径 | **按步骤/项定额**，发布时定价，提交预扣、跑完按实际退差额 | 按上游成本折算不可行（见 §2.2）；一口价会让产出量差异大的包定价失衡 |
| D3 | 包内协同 | **自动串联 + 可选人工确认点**，复用现有 review 机制 | 全自动：不接受中途干预；每项手动：接近现状，用户工作量最大 |
| D4 | 首期范围 | **分期：①积分+CDK → ②场景包 → ③新客户端 UI** | 先做 UI：能演示不能收费；一次全做：周期最长、无中途可交付版本 |

## 1. 可行性判断

### 1.1 三个现成支点（这是可行性的真正来源）

1. **执行收口单一**：所有付费生成都必须经过 `RunService.submit()`（`server/services/runService.ts:109`），以及三条"可能继续生成"的路径——`review`（approve/redo，`runService.ts:155`）、`resume`、`rerun`。积分闸门挂在这四个点，不需要碰任何执行器。
2. **"哪些步骤会花钱"已有静态判定**：`AiSceneService.boundaries()`（`server/services/aiSceneService.ts:75-83`）已经返回 `externalSteps`（hermes / comfyui（排除纯拼接）/ core.http_request）与 `reviewSteps`。定价集合直接复用它，**定价口径与 UI 上"可能产生费用"的提示自动一致**，不会出现"收费的步骤"和"提示会花钱的步骤"两份定义。
3. **归属与自服务面已完备**：`runs.ownerUserId` + `submitter` 身份快照；`/api/v1/self/*` 全套（场景/草稿/运行/素材/凭证/反馈）由 `server/api/accessRoutes.ts` 提供，业务在服务端统一校验身份与授权。积分账户天然是"用户的一个新属性"，不是新的权限体系。

### 1.2 三个真正的风险（按大小排序）

1. **场景包是新增执行层，工作量最大**。现状是"一个发布快照 = 一次运行"，场景之间数据不流转（任务项也被明确设计为互相独立）。包需要：包级发布快照、项间数据传递、人工确认点、子运行编排、包级资金。它比积分+CDK 加起来还重（见 §6、§9 的相对工作量）。
2. **商业上限在本机吞吐，不在软件**。单机 ComfyUI/Hermes，默认并发 `ZANE_MAX_ACTIVE_RUNS=2`、`ZANE_COMFYUI_MAX_CONCURRENCY=2`。定价与套餐兑付量必须按实测产出（每小时多少张图/多少秒视频）反推，否则"卖出 100 份卡但跑不完"是运营事故，不是技术事故。
3. **积分一旦被理解成"成本镜像"就会掉进精算泥潭**。上游网关不回传精确 token 账单，ComfyUI 不报 GPU 秒数；仓库自己的 AI 手册已写明"没有内置费用精算或预算强制上限，不要声称工具已经限制花费"（`server/ai/guide.ts:122`）。积分必须是**产品定价工具**（§2.2）。
4. **SaaS 把"排队公平"和"单点故障"变成产品问题**。运行队列现在是全局 FIFO + 全局并发上限（`ZANE_MAX_ACTIVE_RUNS`），一个客户能占满队列，其他客户只能等；单机故障等于全部客户停服。这不是能不能做的问题，是客户投诉的主要来源，必须在客户端上线前解决（§1.4、§9）。

### 1.3 范围边界（明确不做）

- 不做在线充值/支付（你已明确不充值，CDK 是唯一额度入口；客服补偿走管理端调账，不算充值）。
- 做**逻辑多租户**（按账号隔离数据 + 租户配额 + 公平排队），不做**物理多租户/水平扩展**（多机 GPU 池、分布式队列、外部数据库）——后者在吞吐真正撞墙前不做，不阻塞 SaaS 上线（§1.4）。
- 不删场景概念：场景降级为**包内部件**，管理端照旧用它，用户面不再出现（§2.1）。
- 不改 Hermes Gateway / ComfyUI 上游，不动它们的配置与账单。
- 历史运行（本设计之前）不参与计费，没有价格快照就不收费。

### 1.4 SaaS 落地：代码库边界与四个门槛

**代码库边界（已定）**：在现有系统里改，不新开、不 fork。理由：执行引擎（能力注册表、ComfyUI 绑定解析、Hermes 解析、for_each/审核/续跑/归档）是最值钱的资产，fork 的第一天起每个执行器 bug 都要修两遍。商业化在代码上是**门面（包）+ 账本（积分）+ 编排层（包内协同）**，是附加层，不是另一套引擎。

**部署边界**：先单实例；当商业客户与内部生产（抱枕/电商批次）开始互相干扰时，拆成"同代码、双实例"——各自的数据目录、项目目录、域名与并发上限，共享同一套 ComfyUI/Hermes 上游。注意：并发上限是**按进程**算的，双实例要各自调低，否则一起压垮 GPU；`update:prod` 的升级锁与进程核验是按仓库的，双实例升级流程需先验证再依赖。

SaaS 相对"单机托管"多出四个门槛，都要在现有系统里补：

1. **自助注册与账户生命周期**。现在只有管理员建号（`create_user`）。SaaS 需要自助注册；没有邮件/短信基础设施，最现实的形态是"**用户名 + 密码注册 → 兑换 CDK 后才能用**"（未兑换只有空态与兑换入口），密码找回仍走管理员。注册要配限流与防批量注册（复用 `loginLimiter` 的窗口模型）。
2. **租户边界**。`runs`/草稿/素材/媒体已经按 `ownerUserId` 隔离，包与积分是新增面，天然按账号归属。**默认"一个账号 = 一个客户"**；如果客户是剧组/工作室这类多人共用，就需要"组织层"（成员表 + 共享积分池 + 共享素材库），建议等第一个这样的客户出现再做，不要提前改数据模型。
3. **公平配额**。全局并发上限要升级为"全局 + 每租户"两层：租户级在跑上限 + 排队公平（默认按 FIFO，但单个租户不得占满队列）。上传配额已有 `uploadQuota`。这是客户体验的关键，也是你被投诉最多的地方。
4. **单点与运维，以及客户数据的可带走**。单机是所有客户共命运：备份、日志、指标、升级窗口与公告要按照"面向客户的服务"重新定 SLA 与流程。另外有两处真实缺口要补：**账号注销与数据删除**现在没有；客户数据导出已有媒体 ZIP，可作为"数据可带走"的基础。

**水平扩展的接缝在哪（延后项）**：执行器已抽象在 `ExecutorRegistry`，ComfyUI 地址与并发是配置项；将来要把执行拆到独立 worker 做 GPU 池，本质是"把 `RunService` 的队列与执行搬到另一个进程"，不需要重写业务逻辑。这是延后项，不是现在的阻塞。

## 2. 概念设计

### 2.1 对外概念：场景 → 场景包

- **用户面唯一的"产品"单元 = 场景包（package）**。用户看到的是包目录、包表单、包任务、包产出。`/api/v1/self/scenes` 与现有 UserPortal 保留为兼容面（历史与旧客户端可用），新客户端不出现"场景"这个词。
- **命名冲突要处理**：仓库里"场景包"已被占用——`src/lib/sceneTransfer.ts` 的导出/导入 JSON 文件（现叫"场景包"），`examples/scenes/commerce-pack.json` 是电商图包。建议：**用户面中文叫"创作包"或"场景包"，内部标识统一用 `package`／`packages`；把现有导出文件在文档里改称"场景导出文件"**（只改文案，不改代码标识）。这一条要你点头。
- **存量场景要能一键包起来**：电商套图、长文视频、抱枕出图等现有已发布场景，必须能通过"从场景创建包"（单组件包）直接上线，不需要重建。这是迁移工具，不是新概念。

### 2.2 积分 = 服务定价单位

- 积分不映射上游账单，只映射**你定的价**：AI 文本按次、出图按张、视频按条、第三方 HTTP 按次。
- 好处：提交前能算准上限（`per_item` 的项数在提交时已由输入确定）、能写进宣传页、失败与跳过天然不计费。
- 代价（必须写进产品条款）：定价与真实成本会漂移，需要你定期按实测吞吐校准单价。这是运营工作，不是代码问题。

### 2.3 CDK = 唯一的额度入口

兑换码是"额度凭证"，不是"授权凭证"（默认 D1：单机托管，用户已被管理员开通账号或自助注册）。码 → 积分 → 消耗，中间没有第二套余额。将来若改卖装机版，同一套码可升级为 HMAC 签名格式做离线验签（§5.4 预留）。

## 3. 数据模型（SQLite 迁移 v3）

现有迁移机制在 `server/storage/sqliteStore.ts`（`PRAGMA user_version`，v2 是 `production_documents`）。新增 v3：

```sql
-- 账户：物化余额，便于原子扣减与并发校验
CREATE TABLE credit_accounts (
  user_id     TEXT PRIMARY KEY,
  balance     INTEGER NOT NULL CHECK(balance >= 0),
  revision    INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 账本：不可变流水，唯一事实来源
CREATE TABLE credit_entries (
  entry_id        TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  delta           INTEGER NOT NULL,          -- 正=入账，负=出账
  balance_after   INTEGER NOT NULL,
  kind            TEXT NOT NULL,             -- cdk_redeem|admin_grant|admin_adjust|run_reserve|run_settle|run_refund
  ref_type        TEXT,                      -- run|package_run|code|batch
  ref_id          TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,      -- 例：run_reserve:<runId>
  actor_user_id   TEXT,                      -- 调账管理员或系统
  note            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX credit_entries_user ON credit_entries(user_id, created_at DESC, entry_id);

-- 兑换码：库里只存 hash
CREATE TABLE redeem_batches (
  batch_id TEXT PRIMARY KEY, name TEXT, face_value INTEGER NOT NULL,
  code_count INTEGER NOT NULL, expires_at TEXT,
  created_by TEXT, created_at TEXT NOT NULL, note TEXT
);
CREATE TABLE redeem_codes (
  code_id      TEXT PRIMARY KEY,
  batch_id     TEXT NOT NULL,
  code_hash    TEXT NOT NULL UNIQUE,      -- HMAC-SHA256(规范化码, 服务端盐)
  code_hint    TEXT NOT NULL,             -- 末 4 位，人工核对
  face_value   INTEGER NOT NULL,
  status       TEXT NOT NULL,             -- unused|redeemed|void
  redeemed_by  TEXT, redeemed_at TEXT, redeem_entry_id TEXT,
  expires_at   TEXT, created_at TEXT NOT NULL
);
CREATE INDEX redeem_codes_batch ON redeem_codes(batch_id, status);
```

设计要点：

- 积分表**不带 `project_directory`**：积分是平台货币，与项目解耦，将来换机器/多项目不迁移账户。
- `balance` 是物化值（可 O(1) 校验），`credit_entries` 是权威账本；两者的自检（余额 == 流水累计）作为只读诊断挂在现有 `get_system_metrics` 的 `diagnostics` 模式旁。
- 无独立"冻结额"列：预扣即扣减，结算退差额；"进行中任务占用了多少"由未终态运行的预扣流水聚合得出，不落冗余列，避免双写不一致。

## 4. 计费引擎

### 4.1 定价来源：发布时固化

场景/包的**发布快照**新增 `pricing`（与现有"发布才生效、历史快照不变"的不变量一致）：

```jsonc
pricing: {
  version: 1,
  base: 0,                                        // 可选运行基础费
  steps: { "<stepId>": { unit: "per_call"|"per_item", credits: 5 } }
}
```

- 只有 §1.1-2 的"外部步骤"集合可以出现在 `steps` 里；发布校验拒绝给纯本地步骤（core.code/text.template/media.* 等）定价，避免"无成本步骤也收费"的观感问题。
- `per_item` 的项数在提交时由已解析输入确定（与 `prepare` 同一套解析），因此**提交前能给出确定的上限价**。
- 发布时返回"价格表预览 + 该包典型输入的预估消耗"，管理端确认后才落快照。

### 4.2 预估 → 预扣 → 结算 → 退还

| 时点 | 动作 | 幂等键 |
| --- | --- | --- |
| `submit`（校验通过后、入队前） | `estimate()` 计算上限价 → 预扣 | `run_reserve:<runId>` |
| `review approve`（解冻后续生成） | 对本次解冻段再预扣 | `run_reserve:<runId>:<reviewId>` |
| `resume` / `rerun` | 新 runId，自然重新预扣（复用步骤不重复扣：见结算规则） | `run_reserve:<newRunId>` |
| 运行终态 | 结算：`actual = Σ 已计费且成功的项`；`diff = reserve − actual`；`diff > 0` 写退还 | `run_refund:<runId>` |
| 包运行 | 包级一次预扣（各组件之和），子运行标记 `funded_by`，不再各自扣费；包运行终态时一次结算 | `package_reserve:<packageRunId>` |

**结算单位是 item 级状态**（`RunStepItemRecord.status`，`server/domain/types.ts:198-216`）：`completed` 项计费，`failed`/`cancelled`/`skipped` 项退还。这一条同时解决三件事，且**不需要改任何执行器**：

- `for_each` 部分失败（3 项 2 成功）→ 只收 2 份。
- `startCondition` 跳过的步骤 → 输出为 null、不计费，与现有"跳过不调用外部服务、不计费"的既有语义（`submit_scene` 描述）完全一致。
- 取消 / 服务重启 `stale` → 未执行项全部退还。
- 规则一句话可宣传：**只有成功的产出落定积分；但任何一次派发都需要额度支撑**（所以暴力重试仍然付费，失败不坑用户）。

**永不出现"事后补扣"**：预扣即上限价（`per_item` 项数在提交时固定），差额只退不收，避免欠费与投诉。

### 4.3 与运行状态机的对齐

`RunStatus`（`server/domain/types.ts:235`）= `waiting|queued|running|cancelling|completed|failed|cancelled|stale`：

- `waiting`（含 `batch_items` 循环内确认点）：**不结算**，这是暂停不是终态；approve 时按解冻段二次预扣。
- `cancelling`：等待收尾，最终按 `cancelled` 的 item 分布结算（已完成的项照收）。
- `stale`：可恢复状态；未执行项退还，已执行完成项照收。用户执行 `resume` 时重新预扣新 run。
- 运行状态机、审核、归档、媒体权限全部复用，积分不引入第二套状态。

### 4.4 幂等与并发

- 余额校验与扣减是**单条原子 SQL**（SQLite 单写者 + 事务）：
  `UPDATE credit_accounts SET balance = balance - :amount, revision = revision + 1 WHERE user_id = :u AND balance >= :amount`；`changes = 0` → `409 CREDIT_INSUFFICIENT`（返回 `balance`、`estimate`、`shortfall`、`nextAction: "redeem_code"`）。
- 先查 `idempotency_key`：命中直接返回既有 entry（**响应丢失后按同一 runId 对账，不重复扣费**）——与现有"保存 ID、丢回执先对账、不自动重放"的产品哲学一致。
- 并发提交只够一次额度：一个成功、一个 409，余额不会为负（事务内断言 + 单测覆盖）。

### 4.5 与 AI/MCP 的关系

积分闸门对 HTTP、UI、MCP **一视同仁**（都经过同一 `RunService`）。AI 调用被拒时同样拿到 `CREDIT_INSUFFICIENT` 与差额，因此需要只读的余额与流水操作（§7），否则 AI 无法向用户解释"为什么提交不了"。

## 5. CDK 兑换

### 5.1 管理端

- `create_redeem_batch`（面值、数量、有效期、备注）→ **明文码只在创建响应里返回一次**，库里只存 HMAC 哈希 + 末 4 位。
- `list_redeem_batches` / `get_redeem_batch`（进度：未用/已用/作废）。
- `void_redeem_code`（作废；已兑换的不可作废，要回收就调账）。
- 导出文件丢失 → 该批码不可用（只存 hash），作废整批重发。这是刻意的安全取舍，要写进运营说明。

### 5.2 用户端

- `redeem_own_code`：规范化（去空格/连字符、大写）→ 哈希 → 事务内校验（存在、`unused`、未过期）→ 置 `redeemed` + 写账本 `cdk_redeem` → 返回余额与流水条目。**同码重复提交返回"已兑换 + 兑换时间"**（幂等，不重复加分）。
- 别人已用的码 → 与"码不存在"返回**同一个错误**（防枚举）。

### 5.3 防爆破

- 复用 `server/security/loginLimiter.ts` 的窗口模型（账号 + 来源两个桶）新建 redeem 限流实例：429 `REDEEM_RATE_LIMITED` + `Retry-After`，客户端不自动重放。
- 码空间 ≥ 100 bit（20 字符 Crockford base32，形如 `ZANE-XXXXX-…`），杜绝暴力枚举。

### 5.4 预留：装机版接缝

码格式可升级为 `ZANE-<payload>-<HMAC 签名>`（payload 含面值+批次+有效期）。在线时仍走 DB + 账本；离线装机版校验签名即可发额度。现在不做，但格式预留，改造成本几乎为零。

## 6. 场景包

### 6.1 定义与发布

包草稿与发布快照走既有 `production_documents` 机制（`collection = "packages"` / `"packageVersions"`），**不塞进 workspace 快照**——工作区快照已有全量三方合并与 3 秒轮询同步，把包放进去会放大冲突面。

```ts
interface ScenePackageDraft {
  id: string; title: string; summary: string; cover?: string;   // 用户面产品信息
  inputs: RunInputField[];                                       // 包级输入契约（用户只填这一次）
  items: Array<{
    id: string; name: string;
    sceneId: string; versionId: string;                          // 组件必须指向已发布场景
    inputs: Array<{ key: string; valueSource: "input" | "literal" | "previous"; sourceRef?: string; literalValue?: string }>;
    selection?: { mode: "all" | "item"; index?: number };         // 引用前序产出时取全部/第 N 个
    confirmAfter?: boolean;                                      // 本项完成是否停下等人工确认（选片/审美）
  }>;
  pricing: PackagePricing;
  revision: number;
}
```

**发布快照自包含**：内嵌各组件的 workflow 快照副本（而非只引用 `sceneId@versionId`）。理由：已发布场景仅保留最近 10 版，引用会悬空；自包含后已发布的包可审计、可迁移，组件场景后续改版/删除都不影响它。代价是快照体积，可接受。

### 6.2 运行模型：包运行 = 父协调器 + N 个子运行

- **不新建第二个状态机**：子运行仍是 `runs` 表里的普通运行（复用审核、续跑、局部重做、取消、归档、媒体、归属与全部 self API）。
- 包运行的状态由子运行状态**投影**（与现有 `Task` 的做法完全一致——任务的进度就是"由各项运行状态投影"）。
- 新增 `RunService` 内部通道：`funded_by` 标记（`runs` 加一列），标记的子运行不做资金检查、不写账本；资金由包运行层一次性预扣与结算（§4.2）。
- 客户端先用 `production_documents` 存包运行协调器状态（当前项、每项 runId、确认待办），不占新表。

### 6.3 项间传递与人工确认点

- `valueSource: "previous"` 把前序项的输出喂给后序项的输入，`selection` 决定取全部还是第 N 个。若前序项是 for_each（例如 4 张图），`mode:"item"` 取第 N 张。
- `confirmAfter: true` → 该项完成后包运行进入 `waiting`：UI 展示该项产出（媒体画廊），用户 **[接受并继续]** 或 **[重跑本项]**。重跑复用现有 `preview_rerun`/`rerun`（带 `feedback` 可改提示词），确认后继续剩余项，已确认的前段不重跑。
- 这是"自动串联 + 可选人工确认点"（默认 D3）的落地方式，也是唯一能同时满足"省事"与"审美可控"的形态。

### 6.4 授权语义（最容易出安全问题的点）

- 用户授权单元从 `sceneIds` 升级为 `packageIds`（新增字段；`sceneIds` 保留用于兼容与管理员场景）。
- 包运行的组件场景**不需要**单独授权给用户：授权检查以"包已授权 + 组件属于该包快照"为准。反过来，"只有组件场景授权、没有包授权"不能提交包。
- 这条必须写进契约与测试，否则要么过度授权（把内部场景暴露给用户）要么用户根本跑不了包。

### 6.5 存量化迁移

- 提供"从场景创建单组件包"的管理端操作（或安装脚本，参照 `scripts/install-commerce-pack.mjs` 的既有做法），把现有已发布场景包成包并定价，一步上线。
- 已发布场景与历史运行不变；旧 self 场景接口保留。

## 7. 对外 API 与 AI 契约

新增 self 操作（`server/ai/operations.ts` 的 `self(...)`）+ 管理操作，全部按 AGENTS.md 要求配 schema、features、guide、`npm run docs:ai`：

| 操作 | 效果 | 说明 |
| --- | --- | --- |
| `list_own_packages` / `get_own_package` | read | 用户面产品目录（仅已授权+已发布），含价格表与预估消耗 |
| `prepare_own_package` | read | 预检 + 返回 `costEstimate` 与 `creditBalance`（提交前给用户看"要花多少、够不够"） |
| `submit_own_package` | execute | 保存 `runId`/`packageRunId` 后提交；余额不足 409 |
| `get_own_package_run` / `get_own_package_activity` / `wait_own_package_run` / `cancel_own_package_run` | read/write | 包运行视图（子运行聚合 + 待确认项） |
| `confirm_own_package_item` | execute | 接受并继续 / 重跑本项（可能再次计费） |
| `get_own_credits` | read | 可用余额、进行中占用、最近流水 |
| `list_own_credit_entries` | read | 分页账本（`ref_id` 可反查运行） |
| `redeem_own_code` | write | CDK 兑换（幂等） |
| `create_redeem_batch` / `list_redeem_batches` / `void_redeem_code` / `adjust_user_credits` / `set_user_package_access` | admin | 发码、作废、调账、包授权 |

**一个必须知道的机制**：公网用户入口的路径白名单由 `aiOperations` 中 `access === "authenticated"` 的条目**自动派生**（`server/security/publicEntry.ts:8,20`），并有测试断言一一对应（`server/security/publicEntry.test.ts:45`）。含义：**每声明一个 self 操作，就等于对公网开放它**。所以新 self 操作必须按"公网可达"标准设计：限流、脱敏、幂等、不接受任意路径或 userId。

契约版本升到 1.6.0（新增包与积分域），`src/lib/accessApi.ts`、`docs/ai-*.md` 同步。

## 8. 客户端 UI 设计

### 8.1 信息架构（普通用户只有四页）

1. **工作台**：积分余额卡 + 进行中的包任务（进度与待确认提醒）+ 最近产出缩略图。
2. **创作**：包目录（封面/标题/一句话/预计消耗）→ 包表单（一屏填完）→ 提交前明示"预计消耗 X 分 · 余额 Y 分"，不足时直接给兑换入口。
3. **结果**：产出物画廊（媒体为主角，按任务分组）+ 打包下载 + 单张重跑入口。
4. **账户**：积分余额与流水、CDK 兑换、AI 凭证（MCP 接入）、退出。

现有"我的草稿"降级为表单内的自动保存状态（用户不需要知道"草稿"这个词）；"系统反馈"收进"帮助"。

### 8.2 设计系统（"简洁大气"的可执行定义）

- 一套 CSS 变量 token：1 个主色（建议深墨蓝或品牌橙二选一）+ 6 档中性色 + 3 个语义色；5 档字号、4 的倍数间距、2 档圆角（卡片 16 / 控件 10）、1 档阴影。
- 深色优先（生成类产品的主流选择，产出物在深底上更亮），媒体全屏查看器；空的、加载的、错误的三态都有明确设计，不留裸骨架。
- **文案纪律**：主界面不出现 `revision`/`runId`/`幂等`/`对账`/`outbox` 这类词——它们只出现在"诊断"折叠区和错误 details 里。防丢与对账能力照旧保留，只是不再占据主视线（现有 `UserPortal` 的文案是最主要的"工程感"来源）。
- 实现建议：**不引入 Tailwind、不引路由库**。现有前端是手写 CSS（`src/styles.css`，1575 行）+ hash 导航；新客户端加一层 `src/styles/tokens.css` + 自己的样式作用域，替换 `src/features/UserPortal.tsx`（`/app` 路径不变，管理端 `App.tsx` 不动），`Application.tsx` 的角色分流逻辑复用。这样既不碰管理端样式（避免回归），也不引入与 `npm run check` 的 lint 规则冲突的新依赖。

### 8.3 与现有 UserPortal 的关系

- 直接替换 `/app` 的壳与页面，**复用业务 lib**：`accessApi`、媒体上传（`UserMediaInput`）、运行轮询与详情（`UserRunDetail`）、草稿自动保存（`userDraftAutosave`）、防丢对账（保留逻辑，弱化文案）。
- 管理端的"用户端预览"按钮继续指向新客户端。

## 9. 分期计划与验收

相对工作量：**①积分+CDK ≈ 25%，②场景包 ≈ 45%，③新客户端 UI ≈ 30%**（UI 视觉稿可与①并行）。

### 阶段 ① 积分地基 + CDK（不动 UI 结构）

- v3 迁移 + `CreditService`（账户/账本/幂等/并发）+ 挂 `RunService.submit|resume|rerun|review` + `TaskService.confirm`（批量预分配 runId 后逐项提交，天然适合同一批预扣）。
- **SaaS 门槛 ①②**：自助注册（含注册限流）+ 租户级在跑上限（全局上限之外的第二层准入）；账号=客户的默认边界，不引入组织层。
- 管理端：调账、发码/作废/进度；用户端：余额与流水（旧壳加一页即可）。
- 验收：并发只够一次额度 → 一成功一 409 且余额非负；同 runId 重放不重复扣；for_each 部分失败只收成功项；取消/stale 退还未执行项；approve 二次预扣；余额不足时 submit/resume/rerun/approve **全部**被拒；账本自检通过。

### 阶段 ② 场景包

- 包草稿/发布（production_documents）+ `PackageRunService`（串行泵 + 依赖 + 确认点）+ 包级资金 + self 包 API + MCP 工具 + 从场景创建包的迁移工具。
- 验收：包快照自包含（组件场景改版/删除后仍可跑）；包授权语义正确（无场景授权也能跑已授权包；无包授权必拒）；确认点 accept/redo 不重复生成前段；包级结算只退不收。

### 阶段 ③ 新客户端 UI

- 设计 token + 四页 IA + 替换 `UserPortal` + 文案纪律 + 真实浏览器截图视觉验收。

### SaaS 上线前清单（在对外收费之前必须完成）

- **公平排队**：单个租户不得占满队列；租户级在跑上限与全局上限同时生效（§1.4-3）。
- **跨租户隔离回归**：用户 A 读不到 B 的包、运行、媒体、素材、积分与流水；管理端以外的任何路径都拿不到他人数据。
- **注册与兑换限流**：注册、登录、兑换三类窗口独立计数，429 带 `Retry-After` 且客户端不自动重放。
- **客户数据可带走 + 注销**：媒体 ZIP 导出可用；补上账号注销与数据删除（现在没有）。
- **服务公告与升级窗口**：升级前公告、失败回滚、单点故障时的对外说明模板。

### 每期都要做的（AGENTS.md 硬要求）

- `server/ai/features.ts` 登记、`server/ai/guide.ts` 补章节、`npm run docs:ai` 提交生成文档、OpenAPI 契约与 `AI_CONTRACT_VERSION` 同步。
- 回归覆盖：正常路径、无效参数、旧 revision/并发、响应丢失对账、分页边界；至少一条真实 stdio MCP 隔离闭环。
- `npm run check` + 文档漂移检查通过；生产生效走 `npm run update:prod`（注意把 `TEMP` 指进仓库，见既有构建约定）。

## 10. 待你确认

1. D2/D3/D4 三项默认值是否照用（D2 定额计费 / D3 自动串联+确认点 / D4 分期）。
2. §2.1 的命名：用户面是否叫"场景包"（内部 `package`），并把现有导出文件改称"场景导出文件"。
3. §4.2 的计费规则：**success-only 落定**（失败/跳过/取消退还，派发前必须额度够）——这条会直接决定用户投诉量与你的运营成本。
4. 定价数字（AI 文本 / 出图 / 视频 / 第三方 HTTP 各多少分），以及单张卡面额（如 100 分 / 500 分 / 3000 分）。可以先给占位值，上线前按实测吞吐校准。
