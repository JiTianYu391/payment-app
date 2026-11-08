<p><img src="public/brand/spacepay-logo-light.svg" alt="SpacePay" height="40"></p>

# SpacePay

SpacePay 是一个支付与资金管理系统的**演示环境**：钱包、转账、商户付款、退款、提现审核、投资模拟，以及面向运营和财务的后台。全部资金为虚拟资金，提现为模拟出款，不连接真实银行、支付渠道或交易市场。

- 改造说明（改了什么、为什么、假设、未覆盖、兼容性、测试结果）：[`docs/CHANGES.md`](docs/CHANGES.md)
- 调研摘要与来源：[`docs/research.md`](docs/research.md)
- 标识与配色：[`docs/brand.md`](docs/brand.md)
- 部署：[`README-fadehost.md`](README-fadehost.md)、[`README-pandastack.md`](README-pandastack.md)

## 运行

```bash
npm install
cp .env.example .env              # 至少修改 SESSION_SECRET；ADMIN_EMAILS 填你的邮箱
npm start                         # http://localhost:3000
npm test                          # 单元 + 集成测试（Node 内置 node:test）
```

需要 Node.js ≥ 22.5（使用内置 `node:sqlite`；不可用时自动降级到 JSON 文件存储）。无需编译原生模块，本次改造没有新增依赖。

## 功能

| 模块 | 内容 |
| --- | --- |
| 账户 | 邮箱验证码注册、密码登录（5 次失败锁定 15 分钟）、6 位支付 PIN |
| 钱包 | 充值（演示）、转账、商户付款、提现申请；收支统计与统计周期 |
| 交易记录 | 时间 / 类型 / 状态 / 金额区间 / 商户 / 关键字筛选，排序，分页，导出 CSV 与 Excel |
| 投资（模拟） | 11 个模拟产品、买卖、定存、风险测评、再平衡、目标、价格提醒、TWR / MWR |
| 运营后台 | 概览、全量交易、支付与退款、提现审核、用户冻结与角色、对账、操作日志 |

### 角色

| 角色 | 权限 |
| --- | --- |
| 用户 `customer` | 只操作自己的账户（默认） |
| 只读访客 `viewer` | 查看运营后台全部页面；不能导出、不能操作 |
| 财务 `finance` | 只读 + 导出报表、发起退款、审核提现、运行对账 |
| 管理员 `admin` | 全部权限，另可冻结 / 解冻账户、调整角色 |

`ADMIN_EMAILS` 中的邮箱在注册或登录时自动成为管理员；其他角色由管理员在「运营后台 → 用户」中分配。审核人不能处理自己提交的提现。

## 资金安全设计

- **整数分**：所有金额以整数分存储和计算（`src/money.js`），输入按字符串解析，不经过浮点。
- **复式账本**：每笔资金变动写一个借贷平衡的 journal（`ledger_entries`，只追加）；钱包余额必须等于账本余额（`src/ledger.js`）。
- **唯一入口**：钱包余额只通过 `wallet.applyCash` 修改，扣款为条件更新 `WHERE balance_cents >= 扣款额`，与流水、分录在同一事务内。
- **幂等**：资金类 `POST` 接受 `Idempotency-Key` 请求头，24 小时内同键同参重放原响应，同键异参返回 422。
- **状态机**：支付（成功 → 部分退款 → 已退款）、提现（待审核 → 已出款 / 已驳回）、账户（正常 ↔ 冻结）。
- **二次确认**：退款、冻结 / 解冻、调整角色、提现申请与审核先返回 `428` 和操作摘要，确认后带一次性 `confirm_token` 再提交；全部写入操作日志。
- **对账**：`GET /api/admin/reconciliation` 检查分录平衡、钱包与账本一致、钱包与最后一笔流水一致、清算科目与在途提现一致。

## 主要接口

已有接口路径和字段保持不变，只做了新增（兼容性细节见 `docs/CHANGES.md`）。错误响应统一为：

```json
{ "ok": false, "error": "余额不足：还差 $0.01", "code": "INSUFFICIENT_FUNDS", "request_id": "req_…" }
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/transactions` | 新增参数 `from` `to` `type`（逗号分隔）`status` `min_amount` `max_amount` `merchant` `sort=created_at\|amount` `order` `page` `page_size`；新增返回 `filtered_total` `summary` `period` |
| GET | `/api/transactions/export?format=csv\|xlsx` | 按相同筛选条件导出本人交易 |
| POST | `/api/withdrawals` | 申请提现（PIN + 二次确认） |
| GET | `/api/payments`、`/api/withdrawals` | 本人付款与提现记录 |
| GET | `/api/admin/overview` | 运营 KPI 与按日收支 |
| GET | `/api/admin/transactions`（`/export`） | 全量交易查询与导出，另支持 `email` |
| POST | `/api/admin/payments/:id/refunds` | 退款（部分 / 全额） |
| POST | `/api/admin/withdrawals/:id/approve`、`/reject` | 提现审核 |
| POST | `/api/admin/users/:id/freeze`、`/unfreeze`、`/role` | 账户管理 |
| GET | `/api/admin/reconciliation`、`/api/admin/operation-logs` | 对账、操作日志 |

## 目录

```
app.js                 入口（npm start）
src/server.js          createApp() 组装中间件与路由；start() 监听端口
src/admin.js           运营后台接口
src/invest.js          投资模块接口；src/products.js 模拟行情与每日推进
src/money.js           整数金额解析、运算、格式化
src/ledger.js          复式账本与对账；src/wallet.js 钱包变动唯一入口
src/idempotency.js     Idempotency-Key；src/confirm.js 二次确认；src/state.js 状态机
src/rbac.js            角色与权限；src/auth.js 鉴权中间件；src/oplog.js 操作日志
src/reports.js         交易筛选、排序、分页、导出；src/xlsx.js 零依赖 Excel 生成
src/metrics.js         指标口径（唯一来源）
src/logger.js          结构化日志；src/errors.js 统一错误；src/validate.js 输入校验
src/resilience.js      超时 / 重试 / 降级；src/notifier.js 验证码投递
src/db.js              SQLite / JSON 双后端、表结构与迁移
public/                前端（index.html、styles.css 设计令牌、app.js、charts.js）与 brand/ 标识
test/                  unit/ 单元测试，integration/ 集成测试
```
