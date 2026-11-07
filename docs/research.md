# SpacePay 改造前调研摘要

调研日期：2026-11-07。只提炼信息架构、交互和账务机制，不照搬任何产品的视觉样式（配色、图形、字体）。

## 1. 信息架构与导航

| 观察 | 来源 | SpacePay 采用方式 |
| --- | --- | --- |
| Adyen Customer Area 用左侧主导航，报表单独成组，支持页面搜索和置顶常用页 | Adyen 新版 Customer Area 菜单说明 | 桌面左侧栏分两组：「我的账户」（总览 / 投资 / 钱包 / 支付 / 流水 / 设置）和「运营后台」（交易 / 用户 / 提现审核 / 对账 / 操作日志）。后台组只对员工角色显示 |
| Stripe Dashboard 用固定的预置角色（Administrator、Developer、Analyst、View only 等）；一人有多个角色时取权限并集 | Stripe User roles 文档、Stripe 角色博客 | 预置 4 个角色：`customer`（终端用户，默认）、`viewer`（只读访客）、`finance`（财务）、`admin`（管理员）。权限按动作定义（`perm`），角色映射到权限集合；不做自定义角色 |

## 2. 表格与报表的交互

| 观察 | 来源 | SpacePay 采用方式 |
| --- | --- | --- |
| Stripe 支付列表：先筛选（日期范围、状态、类型），再导出；导出时选列；导出结果和当前筛选一致 | Stripe Support「Exporting payment data」 | 交易列表的筛选条件（时间、状态、类型、金额区间、商户、用户）原样作用于 CSV / Excel 导出；导出受行数上限保护（10,000 行） |
| Adyen Transactions 组件支持按筛选导出 CSV，并限制单次导出行数 | Adyen Transactions component | 同上；分页使用 page / page_size，响应带过滤后的总数 |
| Adyen 报表保留期、列可配置 | Adyen Reporting | 本次不做列配置（列在「未覆盖」中说明） |
| Stripe 发票列表用状态徽标（Pending、Past due 等） | Stripe Invoicing 文档 | 交易状态使用语义化徽标：成功 / 处理中 / 失败 / 部分退款 / 已退款 / 已冲正 |

## 3. 账务模型

| 观察 | 来源 | SpacePay 采用方式 |
| --- | --- | --- |
| Stripe Ledger：不可变事件日志 + 复式记账，每笔资金流动在贷方与借方平衡，把扣款处理视为可观察的状态机 | Stripe 工程博客「Ledger」 | 新增 `ledger_entries`（追加写入、不改不删）。每笔资金流动生成一个 journal，所有分录金额之和为 0。钱包余额与账本余额可逐户核对 |
| Square Books：不可变复式账本，用正负数而非借/贷方向列 | Square 开发者博客 Books（2019）及 HN 讨论 | 分录用带符号整数（分）表示，正数为借、负数为贷，校验只需 `SUM = 0` |
| Modern Treasury：账本不可变，更正用冲正分录 | Modern Treasury「Enforcing immutability」 | 退款、提现驳回、演示重置都用新的冲正 journal，不修改历史分录 |
| Stripe 部分退款：金额用最小货币单位整数；累计退款不能超过原支付金额 | Stripe Refunds 文档 | 退款金额 > 0 且 ≤ 可退余额（原金额 − 已退）；超额返回 `REFUND_EXCEEDS_REMAINING` |
| Square RefundPayment：退款金额不能超过支付金额减去已完成退款；每次退款用新的幂等键 | Square Idempotency 文档、Square 开发者论坛 | 同上；每次退款独立幂等键 |

交易状态机（参考 Stripe PaymentIntent 与 Adyen 支付生命周期的「授权 → 结算 → 退款」阶段划分，按本系统的即时到账场景做了简化）：

```
支付 payment:   SUCCEEDED → PARTIALLY_REFUNDED → REFUNDED
                SUCCEEDED → REFUNDED
提现 withdrawal: PENDING → SUCCEEDED（财务批准）
                PENDING → FAILED（财务驳回，资金冲正退回）
```

## 4. 幂等与对账

| 观察 | 来源 | SpacePay 采用方式 |
| --- | --- | --- |
| Stripe：所有 POST 接受 `Idempotency-Key`；保存首次请求的状态码和响应体，重试原样返回；参数不同则报错；键至少保留 24 小时；建议 UUID v4，最长 255 字符 | Stripe API Idempotent requests | 资金类 POST 接受 `Idempotency-Key` 请求头（兼容旧的 body `idempotency_key`）。首个响应按（用户, 接口, 键）保存；同键同参数重放原响应并加 `Idempotent-Replayed: true`；同键不同参数返回 422；保留 24 小时；键长 8–255 |
| PayPal：`PayPal-Request-Id`；同一 ID 并发时可能让第二个请求失败；ID 按 API 调用类型唯一 | PayPal REST Idempotency | 同一键的请求处理中时，第二个请求返回 409 `IDEMPOTENCY_IN_PROGRESS`；键的作用域包含接口路径 |
| Adyen：Payment accounting report 覆盖 Received / Authorised，Settlement details report 用于按批次核对出款 | Adyen reports and the payments lifecycle | 新增对账接口：①每个 journal 借贷平衡；②每个用户钱包余额 = 账本现金科目余额；③钱包余额 = 最后一条流水的交易后余额。差异逐条列出 |

## 5. 标识设计参考

| 观察 | 来源 | SpacePay 采用方式 |
| --- | --- | --- |
| Mastercard 标识由简单几何（圆）组成，规定最小尺寸和留白（留白 ≥ 符号中一个圆宽度的 1/4） | Mastercard Brand Center | 只借鉴「纯几何、少元素、可缩放」的原则。SpacePay 符号是两个错位的半圆，合成字母 S 的轮廓；不用双圆相交的构图，不用红黄配色。规定留白 ≥ 符号宽度的 1/4，最小尺寸 16px |

## 来源

- Stripe, Idempotent requests — https://docs.stripe.com/api/idempotent_requests
- Stripe, Ledger: Stripe's system for tracking and validating money movement — https://stripe.dev/blog/ledger-stripe-system-for-tracking-and-validating-money-movement
- Stripe, Refund and cancel payments — https://docs.stripe.com/refunds
- Stripe Support, Exporting payment data — https://support.stripe.com/questions/exporting-payment-data
- Stripe, User roles — https://docs.stripe.com/dashboard/teams/roles
- Stripe, Manage invoices（状态徽标）— https://docs.stripe.com/invoicing/dashboard/manage-invoices
- Adyen, Reports and the payments lifecycle — https://docs.adyen.com/reporting/reports-and-the-payments-lifecycle
- Adyen, Settlement details report — https://docs.adyen.com/reporting/settlement-reconciliation/transaction-level/settlement-details-report
- Adyen, Transactions component — https://docs.adyen.com/platforms/components-overview/after-payment/transactions-component
- Adyen, New Customer Area menu — https://docs.adyen.com/new-customer-area-menu
- PayPal, Idempotency — https://developer.paypal.com/api/rest/reference/idempotency/
- Square, Idempotency — https://developer.squareup.com/docs/working-with-apis/idempotency
- Square Developer Forums, Multiple refunds on same payment id — https://developer.squareup.com/forums/t/multiple-refunds-on-same-payment-id/13153
- Square, Books: an immutable double-entry accounting database service（2019-10-16，博客归档）— https://developer.squareup.com/blog/archive/16
- Modern Treasury, Enforcing immutability in your double-entry ledger — https://moderntreasury.com/journal/enforcing-immutability-in-your-double-entry-ledger
- Mastercard Brand Center, Brand requirements — https://www.mastercard.com/brandcenter/us/en/brand-requirements/mastercard.html

说明：Square Books 原文未能直接读取，相关结论来自博客归档标题和 HN 讨论中的二手描述；Stripe 角色的完整权限表以官方页面为准。
