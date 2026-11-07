# 支付管理软件 v2 — 正式版 + 完整模拟投资系统

> **演示版 · SIMULATED DEMO**：全部资金为虚拟体验金，不可提现；全部投资为模拟交易，
> 不产生真实持仓、不构成投资建议。每个资金页面顶部均有 SIMULATED 标识。

基于 v1（FadeHost 部署版）改写，设计依据见 `~/workspace/research_notes/payment-investment-redesign-research-20261107-1227/report.md`
（Robinhood / Coinbase / Wealthfront / 蚂蚁财富的信息架构、数字层级与确认流程；不抄真实交易、
KYC、牌照、投顾与真实资金链路）。

## 一、改了什么

### 1. 正式化 UI（深蓝 #0B2A4A + 炭灰，白/浅灰底）
- 顶部导航：首页 / 投资 / 钱包 / 流水 / 设置（最多 5 项），桌面 ≥1024px 左侧栏，移动端底部 5 项导航栏。
- 数字层级：总资产最大加粗等宽数字（`font-variant-numeric: tabular-nums`）；今日盈亏与总回报为胶囊，
  涨跌同时用颜色 + 符号 + 箭头表示（绝不只靠颜色）；WCAG 2.2 AA 对比度；触控目标 ≥44px。
- 首页：总资产（现金 + 投资）→ 今日盈亏/总回报胶囊 → 业绩折线图（1D/1W/1M/1Y/ALL）
  → 资产配置环形图（金额 + %，现金 vs 投资分块）→ 前 5 持仓 → 最近流水。
- 投资页：持仓表（名称/数量/成本/现价/市值/未实现盈亏/权重/迷你走势）、产品列表、
  买入/卖出（预览 → 复核 → 6 位 PIN → 回执）、自选（星标）+ 提醒（一次/重复，每目标一个）。
- 钱包（转账/账单/充值 $500 上限）、流水（订单 + 账本）、设置（安全/备份/重置/免责）保持可用。

### 2. 完整投资系统（模拟，虚拟资金）
- **产品 11 个，5 类**：股票×2、ETF×2、基金×3（含净值 $1.00 的货币基金）、黄金 ETF、定存×2（7 天 2.00% / 90 天 3.20%），
  另有不可交易的模拟基准指数（业绩对比用）。
- **定价**：种子 GBM `S(t+1)=S(t)·exp((μ−σ²/2)Δt+σ√Δt·Z)`，每产品独立种子 + 分流随机数，
  交易不改变市场路径；已预生成 30 天历史；每小时推进 1 个模拟日（tick）。
- **买卖**：仅市价单 v1；复核屏重述数量/价格/手续费（$0）/总额；6 位 PIN；原子执行；
  幂等键（重复提交返回原订单，不重复扣款）；余额不足时报精确差额（如“还差 $959.99”）；防重复提交。
- **持仓**：FIFO 批次，未实现与已实现盈亏分开记；平均成本仅展示用。
- **收益**：TWR 与 MWR **同时展示并标注方法**：TWR `[(1+R1)…(1+Rn)]−1`；
  MWR 为 Modified Dietz `R=(EV−BV−CF)/(BV+ΣCFi·Wi)`；帮助文案含 Helm 例证
  （+5% 后 −20% → TWR −16%、MWR −24%）；分红/利息与价格收益分开列示；现金分红 v1，无 DRIP。
- **风控**：R1–R5 五题问卷 → 建议配置；买入高于自身风险等级的产品时提示；
  再平衡预览用 5/25 规则（偏离 ≥ min(5pp, 目标×25%) 才建议调），用户确认后一键执行，无自动交易。
- **分红/利息/定存**：季度分红（模拟日每 90 天）、货币基金按日计息、定存到期还本付息、
  提前支取按已存天数计息；投资组合每日快照（图表与 TWR 的数据源）。

### 3. 后端（Node.js，无原生编译）
- **SQLite 优先**（`node:sqlite`，Node ≥22.5），`DATABASE_PATH` 默认 `/data/app.db`（本地 `./data/app.db`）；
  不可用时自动回退 JSON 文件后端（`/data/app.json`），API 完全一致。
  WAL 开启（`journal_mode=WAL, busy_timeout=5000, synchronous=NORMAL, foreign_keys=ON`）。
- **18 张表**：users、verification_codes、demo_inbox、sessions、wallets、transactions、audit_logs、
  products、price_snapshots、holdings、holding_lots、orders（`idempotency_key UNIQUE`）、
  portfolio_snapshots、dividends、watchlist、alerts、goals、fixed_deposits、risk_targets。
- **资金**：全程整数分，展示用 `Intl.NumberFormat`；总资产 = 现金 + Σ(数量×现价)。
- **迁移**：首次以 SQLite 启动且存在旧版 `/data/app.json`（或同目录 `.db` 的 `.json` 兄弟文件）时，
  自动导入 v1 七表 + v2 投资表（orders 在 holding_lots 之前，满足外键顺序；只导入目标表真实存在的列），
  成功后原文件重命名为 `.migrated.json`（不删除）。已验证：用户、余额、持仓、订单、流水全部保留。
- **备份**：`VACUUM INTO` / `.backup`，绝不直接 cp 运行中的库文件；另有 `scripts/backup.js`。
- v1 能力原样保留：邮箱 + 6 位演示验证码注册、新用户 $50.00 虚拟体验金（5000 分，不可提现）、
  密码与支付 PIN（PBKDF2-SHA256，12 万次）、登录 5 失败锁 15 分钟、按邮箱转账、账单支付、演示充值 $500 上限。

### 4. 新用户业绩历史（演示约定）
注册时以 $50 体验金为起点，在已生成的 30 天模拟历史内按现金持有回填投资组合快照，
使图表 / TWR / MWR 上线即有完整序列；期初资金不计入期间资金流（TWR/MWR 的分母口径一致）。
业绩页与此处均已注明该约定。老用户（迁移而来）无回填，历史不足时 TWR/MWR 显示“历史不足”。

### 5. 本次修复的三个后端缺陷（验证中发现）
1. `transactions.sim_day` 列原先靠 `invest.js` 启动时的 `ALTER TABLE` 补建，迁移在 `db.js` 加载时先跑，
   导致迁移插入失败 → 已把 `sim_day` 写进 DDL，`ALTER` 仅作旧库兼容保留。
2. JSON 后端 WHERE 解析器不支持 `IN (...)`（投资模块三处使用）→ 已支持 `IN` / `NOT IN` 字面量列表。
3. JSON 后端 UPDATE 的 SET 表达式只支持 `列 ± 数字字面量`，不支持 `列 ± ?` → 已支持占位符操作数。
4. 另修：定存下单 `INSERT INTO orders` 占位符 12 个、列 11 个；演示重置先删 `orders` 触发 `holding_lots` 外键
   回滚 → 删除顺序改为 `holding_lots` 在前；`invest.js` 下单失败的 catch 原先吞掉异常 → 现打印到服务端日志。

## 二、本地验证（2026-11-07，Node v24.22.1）

### A. 主流程套件（49/49 通过，`PORT=3102`，SQLite）
- 注册 Alice → 演示验证码 → 登录 → **$50.00（5000 分）**；设 PIN 123456。
- 产品 11 个，覆盖 STOCK/ETF/FUND/GOLD/FIXED_DEPOSIT；ETF 现价 $83.72，sparkline 14 点。
- 预览买 $10 ETF → 总额 $9.96，现金 $40.04；买入成功，现金 5000→4004；持仓 0.119 份，市值 $9.96，未实现盈亏 $0.00。
- 同一幂等键重放 → 返回 `duplicate: true`，余额不变 4004。
- 错 PIN → 403「支付 PIN 不正确」；买 $1000 → 预览与下单均报精确差额 **$959.99**。
- 卖一半 → 已实现盈亏 $0.00，现金 4004→4498；订单历史记录卖出与已实现盈亏。
- 投资组合：总资产 = 现金 4498 + 投资 502 = 5000；配置合计 **100.00%**（现金 89.96% + ETF 10.04%）。
- 业绩：30 个快照点；**TWR 0%（标注 TWR 方法）、MWR 0%（标注 Modified Dietz）**、Helm 例证 −16%/−24% 在列、基准序列齐全。
- 定存：申购 $5（7 天，maturity_day 37）→ 提前支取，本金 $5.00 + 利息 $0.00。
- 风控问卷 5 题全选 4 分 → Aggressive（20 分），建议配置 STOCK 45/ETF 25/FUND 10/GOLD 10/FIXED 0/CASH 10；
  再平衡预览 6 项、含 5/25 规则文案；**再平衡执行后现金 $5.01、投资 $44.99**，
  配置 STOCK 45.0% / ETF 24.9% / GOLD 10.1% / CASH 10.0% / FUND 10.0%，与目标一致。
- 自选黄金成功；提醒创建成功；同一目标第二个提醒 → 400 拒绝（每目标一个提醒）。
- 目标创建成功，进度 10%；Alice→Bob 转账 $12.50，Bob 5000→6250，Alice 余额相应减少。
- JSON 导出含订单 3 笔、流水 6 笔；DB 备份 `VACUUM INTO` 成功，`integrity: ok`；演示重置恢复 $50.00。
- 前端首页返回 18552 字节，含 SIMULATED 横幅与投资导航；`node --check` 通过 `public/app.js`、
  `src/*.js`；前端调用的全部 `/api/*` 均有后端路由对应（含 DELETE `/api/alerts/:id`、`/api/goals/:id`）。

### B. JSON 后端端到端（`PORT=3103`，`DB_BACKEND=json`）
- Carol 注册 → $50.00；设 PIN；买 $20.01 ETF → 现金 2999，持仓 0.239 份；卖一半 → 已实现盈亏 $0.00，现金 3995。

### C. JSON → SQLite 迁移（同一目录，先 JSON 后 SQLite）
- 迁移日志：`已从旧版 JSON 迁移用户数据: /tmp/migtest/app.json -> /tmp/migtest/app.json.migrated.json`。
- Carol 登录成功；余额 **3995** 保留；持仓 ETF 0.12 份（市值 $10.05）保留；订单 2 笔保留；流水 3 笔（bonus/BUY/SELL）保留；
  投资组合总资产 $50.00。

### D. Tick 推进（进程内，60 次 tick，模拟日 30→90）
- 货币基金 $1000：60 天利息 **5¢/天 × 60 = $3.00**，60 笔 INTEREST 流水。
- 股票 1 股：第 90 天季度分红 **$0.58**（当日价 $191.81 × 1.2% / 4），dividends 表有记录。
- 定存 $1000（7 天 2%）：到期状态 MATURED，到账 **$1000.38**（本金 + 利息 $0.38）。
- 提醒：黄金 ABOVE 阈值低于现价 → 首个 tick 触发，状态 FIRED（ONCE）。
- 投资组合快照 61 个（第 30 天 + 60 次 tick）；现金对账精确：$2000.00 → **$3003.96**（+利息 3.00 + 分红 0.58 + 定存 1000.38）。

### E. 备份脚本
- `node scripts/backup.js` → `备份完成: data/backups/app-….db integrity: ok`。

## 三、部署（FadeHost，父代理经浏览器执行）
1. 把本目录内容推送到 GitHub `JiTianYu391/payment-app`（main 分支）。
   注意：不要提交 `node_modules/`、`data/`、`.env`（已提供 `.gitignore`）。
2. FadeHost 面板会自动重新部署（GitHub 集成）；若未自动部署，在面板点 Redeploy。
3. 环境变量确认：`DATABASE_PATH=/data/app.db`（首次启动自动从旧版 `/data/app.json` 迁移用户与余额；
   也可留空，默认即 `/data/app.db`）、`DEMO_MODE=true`、`SESSION_SECRET`（已设，保持不变）。
4. 验证 `https://jitianyu391.fadehost.app`：注册新用户得 $50.00；首页显示总资产、折线图与环形图；
   投资页买入 ETF 后持仓出现；老用户登录后余额与历史保留。
5. 回滚：若 v2 有问题，FadeHost 面板回滚到上一次部署（v1 代码仍在 Git 历史中）。

## 四、文件清单
```
app.js                 FadeHost 入口（npm start = node app.js，监听 $PORT，0.0.0.0）
package.json           payment-app-v2 2.0.0，engines node >=22.5
.env.example           DATABASE_PATH=/data/app.db 等
scripts/backup.js      VACUUM INTO 备份 + integrity_check
src/server.js          v1 服务端（认证/钱包/转账/账单/充值）+ v2 注册回填
src/db.js              SQLite 优先 / JSON 回退双后端 + 旧版 JSON 迁移
src/security.js        PBKDF2-SHA256（密码与 PIN）
src/products.js        11 产品目录、种子 GBM 定价、tick（分红/利息/定存到期/提醒/快照）
src/invest.js          投资 API（产品/持仓/订单/业绩/风控/再平衡/目标/备份/重置）
public/index.html      v2 前端结构（5 视图 + 弹窗：复核→PIN→回执等）
public/styles.css      深蓝正式主题、等宽数字、WCAG AA
public/app.js          v2 前端逻辑（手绘 canvas 折线/环形/迷你走势图）
```

## 五、已知限制（v1 明确不做）
- 仅市价单，无限价/止损单；无杠杆、做空、期权；无 DRIP；定存提前支取按已存天数计息、无罚息。
- 模拟价格与真实市场无关；TWR/MWR 均为演示口径；新用户历史为回填约定（见上）。
- 提醒仅应用内展示，无推送/短信/邮件；每小时 tick（非实时行情）。
- 迁移用户无回填历史，业绩需积累新的快照后才有 TWR/MWR。
- 网关/定时任务依赖：tick 由进程内 `setInterval`（每小时）驱动，应用休眠时不推进；
  FadeHost 免费版闲时休眠，唤醒后继续按每小时推进，不补跑错过的模拟日。
