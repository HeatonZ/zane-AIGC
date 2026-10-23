# 商业化上线前检查清单

> 本清单基于 2026-10-17 对**生产环境只读核验**与**生产数据库副本迁移演练**的结果编写。
> 生产升级是单向、影响全部用户的操作，必须逐条确认后再执行 `npm run update:prod`。

## 0. 当前生产事实（已核验，2026-10-17 19:14 左右）

| 项 | 实测值 | 含义 |
| --- | --- | --- |
| 管理入口 | `127.0.0.1:8799`，health/ready 均 200 | 服务健康 |
| 用户入口 | `0.0.0.0:8800`（公网，经 Cloudflare Tunnel） | 对外可达 |
| 身份 | `@operator` / admin，`ZANE_ADMIN_TOKEN` 有效 | 可运维 |
| 队列 | `queued=0 active=0 preparing=0 accepting=true` | **空闲，适合升级** |
| 运行记录 | 1264 条（completed 571 / failed 262 / cancelled 419 / stale 12） | 无排队、无待审核 |
| 数据库版本 | `user_version = 2` | 本次升级将迁移到 **v3** |
| 场景 | 14 个已发布场景 | **全部无 pricing** |
| 用户 | 4 个 | 全部无 `packageIds` |
| 包 | 0 | 尚未创建任何场景包 |

## 1. 迁移安全性（已在生产副本上演练）

在 `data/production/zane.db` 的副本上执行 v3 迁移，结果：

- `user_version` 2 → 3，成功；
- 既有 6 张表全部保留，新增 4 张：`credit_accounts`、`credit_entries`、`redeem_batches`、`redeem_codes`；
- `runs` 1263/1264、`production_documents` 161/161 保留（差额 1 条是 WAL 未 checkpoint，不是丢失）；
- 新表为空，`creditIntegrity()` 无不一致，`PRAGMA quick_check` = ok；
- 迁移语句使用 `CREATE TABLE IF NOT EXISTS`，**可重跑**，部分失败后重启不会炸。

**结论：迁移是纯加法，不改既有表结构与数据。**

## 2. 升级后不会自动发生的三件事（必须人工做）

### 2.1 不会自动开始收费

生产 14 个场景全部没有 `scene.pricing`。按实现，**没有定价的场景运行不扣费**（`planSceneCost` 返回 0，`submit` 不预扣）。
这是有意的安全默认，但意味着：

- 升级后普通用户仍可无限使用现有场景；
- 要开始收费，必须逐个场景在草稿里配置 `pricing` 并**重新发布**（发布快照才生效）；
- 历史发布版本不会追溯定价，历史运行也不会补扣。

### 2.2 用户看不到任何场景包

`packageIds` 全为空、包数量为 0。新客户端首屏是「场景包」页，**上线后用户会看到空目录**。
上线前必须二选一：

- **方案 A（推荐）**：至少创建 1 个场景包并发布，给测试账号授权，验证端到端；
- **方案 B**：暂时保留旧场景入口 —— 用户端侧栏底部「单项场景」仍可用，但首屏空态会让人以为没东西可做。

### 2.3 自助注册默认关闭

`ZANE_SELF_SIGNUP` 未配置 = 关闭；`ZANE_SIGNUP_GRANT_CREDITS` 未配置 = 0。
如果 SaaS 需要用户自己注册，必须在 `.env.production.local` 显式打开并决定赠送额度。

## 3. 建议的配置变更（`.env.production.local`）

按需逐条确认，**不要一次全开**：

```dotenv
# 单账户在跑上限：防止一个客户占满全局队列。0=不限制（当前默认）。
# 建议 SaaS 对外后设为 1–2；内部生产不受影响（管理员运行也计入）。
ZANE_MAX_ACTIVE_RUNS_PER_USER=2

# 自助注册：默认关闭。打开前先确认你有能力处理批量注册与滥用。
# ZANE_SELF_SIGNUP=true
# 注册赠送积分：默认 0。建议先给小额（如 50）做试用，不要给大额。
# ZANE_SIGNUP_GRANT_CREDITS=50
```

**不要**在未确认前修改 `ZANE_MAX_ACTIVE_RUNS`（全局并发，当前 2）与 `ZANE_COMFYUI_MAX_CONCURRENCY` —— 这两项直接影响 GPU 吞吐与内部生产。

## 4. 升级步骤

```powershell
# 1) 确认空闲（应全部为 0/true）
curl -H "Authorization: Bearer $env:ZANE_ADMIN_TOKEN" http://127.0.0.1:8799/api/v1/maintenance/metrics

# 2) 备份（升级脚本自身也会备份；这一步是额外的可读副本）
#    确认 data/production/zane.db 与 .env.production.local 已纳入备份目录

# 3) 构建必须把 TEMP 指进仓库（系统 Temp 会让 esbuild 收尾失败并清空 dist）
$env:TEMP = "F:\code\zane-drama\.tmp"; $env:TMP = "F:\code\zane-drama\.tmp"
npm run update:prod

# 4) 查看升级回执
npm run update:prod:status
```

升级脚本会：快照源码 → 完整 `npm run check` → 备份 SQLite 与配置 → 正常关闭 → 切换 → 健康检查 → 激活。
**不会**重启 Hermes Gateway 或 ComfyUI。

## 5. 升级后验收（逐条打勾）

### 5.1 服务与数据

- [ ] `GET /api/health` 与 `/api/ready` 均 200
- [ ] 管理入口 `@operator` 身份正常
- [ ] `GET /api/v1/settings/credits/reconciliation` 返回 `healthy: true`、`totals.accounts` 为 0 或既有账户数
- [ ] `PRAGMA user_version` = 3
- [ ] 运行记录总数与升级前一致（1264）

### 5.2 老功能未回归

- [ ] 管理端「用户管理」能打开，用户列表与场景授权可见
- [ ] 「场景包」页能新建草稿（不发布也应成功）
- [ ] 现有 14 个场景仍能在「单项场景」里打开并提交（无定价 → 不扣费）
- [ ] 一次真实运行能完成（建议用最小的图生图场景）
- [ ] 运行记录、素材库、任务页均正常

### 5.3 新功能端到端

- [ ] 管理端生成 1 张卡密，明文只显示一次、可下载
- [ ] 测试用户兑换成功，余额增加、流水出现
- [ ] 给一个场景配置 `pricing` 并**重新发布**
- [ ] 该场景预检返回 `costPlan.total > 0`
- [ ] 提交后余额下降（预扣），运行结束按实际结算（失败项退回）
- [ ] 余额不足时返回 402，且**没有**进入队列
- [ ] 创建一个单组件包 → 发布 → 授权给测试用户 → 用户端「创作」可见并能提交

### 5.4 公网入口

- [ ] `https://<你的域名>/app` 返回 200
- [ ] 登录成功（Secure Cookie）
- [ ] 管理路径在公网入口仍为 404
- [ ] 普通用户看不到管理端任何入口

## 6. 回滚条件与方式

出现以下任一情况立即回滚：迁移报错、`ready` 持续 200 但业务接口 5xx、运行记录数异常减少、老场景无法提交。

- 升级脚本保留切换前的完整备份（源码 + SQLite + 配置）；
- SQLite 是**纯加法**迁移，回滚到旧版本代码后，v3 的新表会被旧代码忽略（旧代码只读 v1/v2 表），**数据不会损坏**；
- 但升级后产生的积分与包数据在回滚后不可见（旧代码不认识），**不要**在回滚后又升级回去做"对账"，先导出 `credit_entries` 与 `packageRuns`。

## 7. 明确不做的事

- 不改 Hermes Gateway / ComfyUI 配置，不重启它们；
- 不为历史场景追溯定价，不补扣历史运行；
- 不删除任何既有场景、素材、运行或用户；
- 不在升级窗口内创建新用户或批量发码（避免与迁移争锁）。
