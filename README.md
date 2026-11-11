<p><img src="public/brand/spacepay-logo-light.svg" alt="SpacePay" height="40"></p>

# SpacePay

SpacePay 是一个支付与资金管理系统：钱包、转账、商户付款、退款、提现审核、投资收益模拟，以及面向运营、财务和商户的后台。**账户余额为虚拟资金**，提现为模拟出款，不连接真实银行、支付渠道或交易市场。

- 开放平台文档：[/docs](/docs)（快速开始、接口参考、Webhook、错误码）
- 商户后台：[/merchant](/merchant)
- 改造说明：[`docs/CHANGES.md`](docs/CHANGES.md) · 调研摘要：[`docs/research.md`](docs/research.md) · 标识与配色：[`docs/brand.md`](docs/brand.md)
- 部署：[`README-fadehost.md`](README-fadehost.md)、[`README-pandastack.md`](README-pandastack.md)

## 运行

```bash
npm install
cp .env.example .env              # 至少修改 SESSION_SECRET；ADMIN_EMAILS 填你的邮箱
npm start                         # http://localhost:3000
npm test                          # 单元 + 集成测试（Node 内置 node:test），双后端各跑一遍
```

需要 Node.js ≥ 22.5（使用内置 `node:sqlite`；不可用时自动降级到 JSON 文件存储）。

### 邮件

- 未配置邮件通道时，验证码写入应用内收件箱（`DEMO_MODE=true`）。
- 配置 `MAIL_SMTP_*`（QQ 邮箱授权码、Gmail 应用专用密码、企业邮箱均可）后发送真实邮件；
  配置后应用内收件箱自动关闭，避免任何人凭邮箱读取验证码。
- 也支持 `MAIL_WEBHOOK_URL` 由外部邮件服务转发。

## 功能

| 模块 | 内容 |
| --- | --- |
| 账户 | 邮箱验证码注册、密码登录（5 次失败锁定 15 分钟）、找回密码、6 位支付 PIN（同样按失败次数锁定）、可选 TOTP 两步验证与恢复码 |
| 会话 | httpOnly cookie 会话（兼容 Bearer）；登录设备列表、单条注销、一键注销其他设备；过期会话自动清理 |
| 首页 | 余额卡、转账 / 付款 / 充值 / 提现快捷操作、按天分组的最近交易、资产走势与配置 |
| 交易 | 收支汇总与统计周期；全部流水（筛选、排序、分页、导出 CSV / Excel、详情）、付款、退款申请、提现（日 / 月限额与撤销）、投资订单 |
| 手机端（PWA） | 可安装到主屏幕；底部标签栏、底部抽屉、按天分组的交易列表；浅色 / 深色 / 跟随系统 |
| 投资（模拟） | 11 个模拟产品、买卖、定存、风险测评、再平衡、目标、价格提醒、TWR / MWR |
| 通知 | 转账、付款、退款、提现审核、商户结算等站内通知；配置 SMTP 后同时发送邮件 |
| 商户开放平台 | 入驻审核、API Key（只存哈希、可吊销）、创建支付、结账页、退款、结算提现、HMAC 签名 Webhook 与重试、API 请求日志 |
| 运营后台 | 概览、全量交易、支付与退款、退款申请审核、商户入驻、商户结算、提现审核、用户冻结与角色、对账、操作日志 |

### 角色

| 角色 | 权限 |
| --- | --- |
| 用户 `customer` | 只操作自己的账户（默认） |
| 商户 `merchant` | 自己的商户后台：密钥、支付、退款、结算 |
| 只读访客 `viewer` | 查看运营后台全部页面；不能导出、不能操作 |
| 财务 `finance` | 只读 + 导出报表、发起退款、审核提现与退款申请、商户结算、运行对账 |
| 管理员 `admin` | 全部权限，另可冻结账户、调整角色、审批商户 |

`ADMIN_EMAILS` 中的邮箱在注册或登录时自动成为管理员；其他角色由管理员在「运营后台 → 用户」中分配。审核人不能处理自己提交的提现或退款申请。

## 资金安全设计

- **整数分**：所有金额以整数分存储和计算（`src/money.js`），输入按字符串解析，不经过浮点。
- **复式账本**：每笔资金变动写一个借贷平衡的 journal（`ledger_entries`，只追加）；钱包余额必须等于账本余额（`src/ledger.js`）。
- **唯一入口**：钱包余额只通过 `wallet.applyCash` 修改，扣款为条件更新 `WHERE balance_cents >= 扣款额`，与流水、分录在同一事务内。
- **幂等**：资金类 `POST` 接受 `Idempotency-Key` 请求头，24 小时内同键同参重放原响应，同键异参返回 422。
- **状态机**：支付、商户支付、提现、商户结算、账户、商户准入均有明确状态迁移。
- **二次确认**：退款、冻结 / 解冻、调整角色、提现申请 / 撤销 / 审核、商户结算、退款申请审核、注销账户先返回 `428` 和操作摘要；确认令牌落库、一次性、原子消费，进程重启或多实例部署都不能重放。
- **商户资金**：付款人钱包 → `merchant:payable`（商户待结算）→ 提现申请转入 `clearing:merchant_payouts` → 审核通过后出款；驳回原路退回。
- **对账**：`GET /api/admin/reconciliation` 检查分录平衡、钱包与账本一致、钱包与最后一笔流水一致、清算科目与在途金额一致，并校验商户待结算 = 成功支付 − 退款 − 已出款。

## 商户开放平台

| 接口 | 说明 |
| --- | --- |
| `POST /api/v1/payments` | 创建支付单，返回 `checkout_url`；支持 `Idempotency-Key` 与 `reference` 去重 |
| `GET /api/v1/payments/:id` | 查询支付与退款记录 |
| `GET /api/v1/payments` | 列表与游标分页 |
| `POST /api/v1/payments/:id/refund` | 部分 / 全额退款 |
| `GET /api/v1/balance` | 可结算余额与在途结算 |
| `GET/POST /api/v1/payouts` | 结算提现 |
| `POST /api/checkout/:token/pay` | 付款人结账（登录 + 支付 PIN） |

鉴权：`Authorization: Bearer sp_live_<key_id>_<secret>`，每个 Key 每分钟限流。Webhook 使用 `X-SpacePay-Signature: t=…,v1=HMAC-SHA256(secret, t + "." + rawBody)`，失败按 1 分钟 / 5 分钟 / 30 分钟 / 2 小时 / 6 小时重试，共 6 次。完整说明见 [/docs](/docs)。

## 运维

```bash
npm run backup       # SQLite：VACUUM INTO + 完整性 / 账本一致性校验，校验失败退出码 2
sh backup.sh         # 兼容 JSON 后端：先校验 JSON 可解析，再 gzip
```

- `GET /api/health`：数据库、投资模块与邮件通道状态。
- `GET /metrics`：Prometheus 文本指标（用户、余额、流水、待审核提现、商户余额、Webhook 投递、会话数）；设置 `METRICS_TOKEN` 后需要 Bearer 令牌。

## 目录

```
app.js                 入口（npm start）
src/server.js          createApp() 组装中间件与路由；start() 监听端口
src/auth.js            鉴权中间件、PIN 锁定
src/confirm.js         二次确认令牌（落库、一次性）
src/security.js        PBKDF2、令牌、验证码、TOTP、API Key、Webhook 签名
src/merchant.js        商户开放平台：/api/v1、/api/merchant、/api/checkout、运营侧审核
src/notify.js          站内通知；src/notifier.js SMTP / Webhook / 应用内收件箱
src/admin.js           运营后台接口
src/invest.js          投资模块接口；src/products.js 模拟行情与每日推进
src/money.js           整数金额解析、运算、格式化
src/ledger.js          复式账本与对账；src/wallet.js 钱包变动唯一入口
src/idempotency.js     Idempotency-Key；src/state.js 状态机
src/rbac.js            角色与权限；src/oplog.js 操作日志
src/reports.js         交易筛选、排序、分页、导出；src/xlsx.js 零依赖 Excel 生成
src/metrics.js         指标口径（唯一来源）
src/logger.js          结构化日志；src/errors.js 统一错误；src/validate.js 输入校验
src/resilience.js      超时 / 重试 / 降级
src/db.js              SQLite / JSON 双后端、表结构与迁移
public/                主应用（index.html、app.js、styles.css）、商户后台（merchant.html / merchant.js）、
                      开发者文档站（docs/）、结账页（pay.html）、PWA 与品牌资源
test/                  unit/ 单元测试，integration/ 集成测试（SQLite 与 JSON 各跑一遍）
```
