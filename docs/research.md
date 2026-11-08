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

---

## 6. 界面排版专项调研（第二轮）

第一版界面上线后逐页截图复查，发现排版问题集中在表格、筛选、设置页和空状态四处，于是补充调研了以下设计系统的具体规范。

| 观察 | 来源 | SpacePay 采用方式 |
| --- | --- | --- |
| Carbon 数据表格：工具栏只放全局操作（搜索、复杂筛选、导出），工具栏高度与表格行高匹配；大工具栏 48px 配大行高，小工具栏 32px 配小行高 | Carbon Data table（usage / style） | 所有列表统一为「工具栏 → 可折叠筛选面板 → 已生效筛选条件 → 表格 → 分页」；导出按钮从页头移入工具栏；控件 32px、行高 44px、表头 36px |
| 表格对齐：文字左对齐、数字右对齐，表头与该列同向对齐，不用居中；同列小数位一致；数字用等宽（tabular）数字；溢出内容要有提示 | Matt Ström《Design better data tables》、Max Masnick《Alignment in tables》等表格设计指南 | 全部表格改为单行显示，长文本截断并在悬停提示中给出全文；金额列统一右对齐、两位小数 |
| Polaris 注释式布局：左侧标题与说明，右侧卡片放控件；只用于设置类页面，便于扫读，把「理解」和「配置」分开 | Shopify Polaris Layout、Shopify App 设计指南、Polaris 讨论 #8217 | 设置页改为左说明、右表单；输入框限宽 360px；PIN 区块按是否已设置只显示一种表单；危险操作单独放在红框卡片里 |
| Atlassian：间距以 8px 为基准；空状态说明「没有数据」并告诉用户下一步能做什么 | Atlassian Spacing、Forge Empty state | 间距令牌改为 8px 基准（4px 为半步）；所有空表格显示原因与下一步操作，对账页未运行时给出检查项说明 |
| GOV.UK 摘要列表：确认页用「键 / 值」行列表，便于提交前核对；不要用它展示表格数据 | GOV.UK Summary list、Check answers 模式 | 二次确认、订单核对、成交回单统一用带行分隔的键值列表 |
| Ant Design：中后台按 24 栅格划分，横向并列的区块建议最多 4 个 | Ant Design Grid | 指标块每行最多 4 个；筛选面板 4 列栅格，日期范围与金额区间各占 2 列 |

### 来源（第二轮）

- Carbon Design System, Data table usage — https://carbondesignsystem.com/components/data-table/usage/
- Carbon Design System, Data table style — https://carbondesignsystem.com/components/data-table/style
- Shopify Polaris, Layout — https://polaris.shopify.com/components/layout
- Shopify, App design layout — https://shopify.dev/docs/apps/design/layout
- Shopify Polaris discussion #8217（App settings layout pattern）— https://github.com/Shopify/polaris/discussions/8217
- Atlassian Design System, Spacing — https://atlassian.design/foundations/spacing
- Atlassian Forge UI Kit, Empty state — https://developer.atlassian.com/platform/forge/ui-kit/components/empty-state/
- GOV.UK Design System, Summary list — https://design-system.service.gov.uk/components/summary-list/
- GOV.UK Design System, Check answers — https://design-system.service.gov.uk/patterns/check-answers
- Ant Design, Grid（中文）— https://ant.design/components/grid-cn
- Matt Ström, Design better data tables — https://mattstromawn.com/writing/tables/
- Max Masnick, Alignment in tables — https://maxmasnick.nfshost.com/projects/datatips/guidelines/alignment-in-tables

说明：本轮检索没有拿到 Nielsen Norman Group 关于表格的原文，表格对齐结论来自上面两篇设计指南，彼此一致。

---

## 7. 消费级钱包体验与 PWA（第三轮）

用户反馈界面「像文档站、太冷」。按选定方向（参考 Wise / Monzo / Revolut 一类消费级钱包，做成 PWA，保持原生 JS）补充调研：

| 观察 | 来源 | SpacePay 采用方式 |
| --- | --- | --- |
| 钱包类首页把余额放在最显眼处，大号字体，下面紧跟 3–4 个最常用的快捷操作；交易历史不能被挤到首屏以下 | Wise 帮助中心「账户新外观」、Pratt IxD 对 Wise iOS 的设计评析、多个金融应用首页改版案例 | 首页改为问候语 + 大号余额卡 + 转账 / 付款 / 充值 / 提现四个圆形快捷按钮；手机上「最近交易」紧跟余额卡 |
| Monzo 用户认可的点：商户图标 + 名称、底部标签栏导航、按天浏览交易 | Monzo 社区讨论（交易流改版、App Evolution 反馈） | 交易动态按「今天 / 昨天 / 日期」分组，每笔显示类型图标、对方或商户、时间；收入用绿色，支出用正文色 |
| 底部标签栏承载 3–5 个一级入口；可点区域不小于 44×44pt；内容避开刘海和底部横条等安全区 | Apple HIG 的二手整理（标签栏、触控目标、安全区） | 手机底部标签栏「首页 · 交易 · 转账 · 投资 · 我的」，中间为主操作；控件至少 44px；使用 `viewport-fit=cover` 与 `env(safe-area-inset-*)` |
| 模态底部抽屉位于遮罩之上，可带拖拽条；不要从抽屉里再打开另一个抽屉 | Material 3 Bottom sheet（Android 文档镜像）、eBay Playbook | 手机上所有弹窗改为底部抽屉，带拖拽条，可下滑或点遮罩关闭；确认层使用独立层级 |
| Web App Manifest：`display: standalone`、多尺寸图标、`purpose: maskable`；`theme_color` 与 `<meta name="theme-color">` 一致，深浅色在 meta 中分别设置 | web.dev「Add a web app manifest」 | 新增 `manifest.webmanifest`、192/512 PNG 与 maskable 图标、Apple 触控图标；service worker 只缓存静态资源，接口请求不缓存 |
| Lucide 图标库采用 ISC 许可证，可商用；需保留版权声明 | Lucide GitHub、lucide-static（npm） | 只内联界面用到的 55 个图标（`public/icons.js`），文件头附完整许可证文本，不增加运行时依赖 |

### 来源（第三轮）

- Wise Help Centre, Your Wise account has a new look — https://wise.com/help/articles/645Ve1Ah1Psi0srHGfKYmm/your-wise-account-has-a-new-look
- Pratt IxD, Design Critique: Wise (iOS App) — https://ixd.prattsi.org/2025/09/design-critique-wise-ios-app/
- Jar Home Page Redesign（UX Planet）— https://uxplanet.org/jar-home-page-redesign-45fec5a8a8e9
- Monzo Community, The prospect of a redesigned transaction feed — https://community.monzo.com/t/the-prospect-of-a-redesigned-transaction-feed/124538
- Monzo Community, App Evolution feedback megathread — https://community.monzo.com/t/app-evolution-now-in-monzo-labs/141702/62
- Flat Studio, Neobank UX patterns for daily banking — https://www.flatstudio.co/blog/neobank-ux-patterns-daily-banking
- web.dev, Add a web app manifest — https://web.dev/articles/add-manifest
- Material Components Android, Bottom sheet — https://super12138.github.io/material-components-android/components/BottomSheet.html
- eBay Playbook, Bottom sheet — https://playbook.ebay.com/design-system/components/bottom-sheet
- iOS design guidelines（Apple HIG 的二手整理）— https://smithery.ai/skills/ehmo/ios-design-guidelines
- Lucide — https://github.com/lucide-icons/lucide ；lucide-static — https://npmjs.com/package/lucide-static

说明：Apple HIG 与 Material 3 的官方页面本轮没有直接检索到，相关数值（44pt 触控目标、抽屉拖拽条）来自二手整理，与业内通行做法一致。Wise、Monzo 的具体交易列表实现没有找到官方设计文档，结论来自其帮助中心说明和用户社区讨论。

---

## 8. 设置页（第四轮）

| 观察 | 来源 | SpacePay 采用方式 |
| --- | --- | --- |
| 设置总览用列表布局，每项直接显示当前状态（如「已开启」），而不是一段说明 | Android 设置设计指南 | 每行右侧显示状态：PIN「已设置 / 未设置」、外观「跟随系统」、安全日志显示上次登录时间 |
| 设置项少于约 15 个时放在一个列表页，分组呈现；更多时分组后进入详情页 | SAP Fiori for Android「Profile and settings」 | 一个列表页分五组：安全、偏好、数据、关于、危险操作；具体表单放在抽屉里 |
| 按使用频率排序；删除账户、退出登录等危险操作放在最后 | Uxcel 设置最佳实践、uxdesign.cc《Designing a better Settings screen》 | 安全排第一组；危险操作与退出登录放在页面最后 |
| iOS 设置使用分组列表（grouped / inset grouped），以页眉和间距分隔各组 | Apple HIG「Lists and tables」 | 圆角分组列表，组标题放在组外上方，行内 32px 图标块、标题、副标题、状态值和右箭头 |
| 开关只用于立即生效的二选一；标签用正向表述，避免「隐藏……」这类否定说法；切换不需要再点确认 | 引用 NN/g 的设计系统文档（Mesa、Configura 等） | 「显示金额」用开关，立即生效并记住选择；外观有三个选项，所以用单选列表而不是开关 |
| 密码默认遮罩，提供可来回切换的显示按钮，用「显示 / 隐藏」文字比只用图标更清楚，并有可访问名称 | SitePoint《Masking passwords》、Uxcel、Vaadin、Shopware 设计系统 | 每个密码框右侧有「显示 / 隐藏」文字按钮（带 aria-label）；新密码实时检查「至少 8 位」「与当前密码不同」 |
| 危险操作集中到「Danger Zone」，用红色边框和危险按钮 | GitHub Primer「Danger pattern guidance」PR #113 | 「危险操作」分组使用红色描边；重置抽屉先提示后果，再要求输入密码，确认按钮为红色 |
| Monzo 把安全设置放在「隐私与安全」分组，Revolut 设有独立的安全中心 | Monzo 帮助中心（Added Security）、Revolut 安全功能博客 | 安全相关项（PIN、密码、安全日志）作为第一组集中放置 |

### 来源（第四轮）

- Android Developers, Settings pattern — https://developer.android.com/design/ui/mobile/guides/patterns/settings
- Android Open Source Project, Settings guidelines — https://source.android.com/docs/core/settings/settings-guidelines
- SAP Fiori for Android, Profile and settings — https://www.sap.com/design-system/fiori-design-android/v26-4/patterns/profile-and-settings/usage
- Uxcel, Settings best practices — https://uxcel.com/lessons/settings-best-practices-572
- uxdesign.cc, Designing a better Settings screen for your app — https://uxdesign.cc/designing-a-better-settings-page-for-your-app-fcc32fe8c724
- Apple HIG, Lists and tables — https://developer.apple.com/design/human-interface-guidelines/lists-and-tables
- Sarun W., Inset grouped List in SwiftUI — https://sarunw.com/tips/inset-grouped-in-swiftui/
- Mesa Design System, Toggle — https://mesadesignsystem.lanl.gov/components/toggle/overview
- Configura Design System, Toggle switch — https://dev-docs.configura.com/design-system/toggle-switch
- SitePoint, Masking passwords: help or hindrance — https://www.sitepoint.com/masking-passwords-help-or-hindrance/
- Vaadin, Password field — https://origin.vaadin.com/docs/v23/components/password-field
- Shopware Meteor, Password field — https://meteor.shopware.com/components/password-field
- GitHub Primer, Danger pattern guidance（PR #113）— https://github-redirect.dependabot.com/primer/design/pull/113
- Monzo, Added Security FAQs — https://monzo.com/help/Account%20Security/addedsecurityfaqs
- Revolut, New security features — https://www.revolut.com/blog/post/new-revolut-security-features/

说明：NN/g 关于开关的原文本轮没有直接打开，结论来自引用它的设计系统文档；Primer 的危险操作规范引用的是讨论中的 PR，正式文档可能有调整。
