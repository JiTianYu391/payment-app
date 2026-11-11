# SpacePay — FadeHost 部署说明

- 应用类型：Node.js，启动命令 `npm start`，监听 `$PORT`。
- 数据必须落在 `/data`（持久盘）。`src/db.js` 默认优先 `/data/app.db`（SQLite），
  其次 `/workspace/data/app.db`，本地开发回退 `./data/app.db`。
  FadeHost 的仓库目录是只读的，不要往项目目录写数据。
- 部署：FadeHost 面板 → Create app → 连接 GitHub 仓库 `JiTianYu391/payment-app`，
  运行时 Node.js，启动命令 `npm start`。
- 内存建议 ≥ 512MB（SQLite 与 Express 常驻约 60–120MB，投资模拟 tick 另占少量）。

## 环境变量

在 FadeHost 应用设置里填写，**不要提交到 Git**。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `SESSION_SECRET` | 是 | 32 字符以上随机串；会话与确认令牌签名 |
| `ADMIN_EMAILS` | 建议 | 管理员邮箱，逗号分隔；注册或登录时自动提升 |
| `DATABASE_PATH` | 否 | 默认 `/data/app.db`；填 `.json` 结尾可切回 JSON 后端 |
| `DEMO_MODE` | 否 | 未配置邮件通道时用应用内收件箱；配置 SMTP 后无关紧要 |
| `MAIL_SMTP_HOST` | 否 | 例如 `smtp.qq.com` |
| `MAIL_SMTP_PORT` | 否 | 465（SSL）或 587（STARTTLS） |
| `MAIL_SMTP_SECURE` | 否 | 465 端口设为 `true` |
| `MAIL_SMTP_USER` | 否 | 发信邮箱完整地址，例如 `123456789@qq.com` |
| `MAIL_SMTP_PASS` | 否 | QQ 邮箱的**授权码**（不是登录密码） |
| `MAIL_FROM` | 否 | 默认 `SpacePay <MAIL_SMTP_USER>`；QQ 邮箱要求与登录账号一致 |
| `PUBLIC_BASE_URL` | 建议 | 例如 `https://<名字>.fadehost.app`，用于生成结账链接 |
| `CORS_ORIGIN` | 否 | 允许跨域的来源，逗号分隔；留空只允许同源 |
| `METRICS_TOKEN` | 否 | 非空时 `/metrics` 需要 `Authorization: Bearer <token>` |
| `WITHDRAW_*` | 否 | 提现单笔 / 日 / 月限额 |
| `MERCHANT_RATE_LIMIT` | 否 | 每个 API Key 每分钟请求数，默认 120 |
| `WEBHOOK_ALLOW_HTTP` | 否 | 仅本地联调设为 `true`；生产保持 HTTPS |

配置了 `MAIL_SMTP_*` 后，验证码会发到真实邮箱，`/api/demo-inbox` 自动关闭。

## 部署后检查

1. `GET /api/health` → `ok:true`，`mail` 显示 `smtp`（或按预期为 `demo_inbox`）。
2. 注册一个账户，确认能收到验证码邮件。
3. 设置支付 PIN，完成一次转账或付款。
4. 管理员访问「运营后台 → 对账」，确认无差异。
5. `GET /metrics` 可被监控抓取。

## 商户接入

1. 用户登录后在「我的 → 商户后台」提交入驻申请。
2. 管理员在「运营后台 → 商户」通过审核；申请人角色自动变为商户。
3. 商户在 `/merchant` 创建 API Key（只显示一次），按 `/developers` 文档接入。
4. 商户结算在「运营后台 → 商户结算」审核出款。

## 备份

```bash
npm run backup    # SQLite：VACUUM INTO + 完整性 / 账本一致性校验
```

建议通过 FadeHost 的计划任务定期执行，并把备份文件同步到外部存储。

## 注意

- 账户余额是**虚拟资金**，不接入真实银行卡或支付渠道；提现与商户结算均为模拟出款。
- 真实邮件通道只用于发送验证码与通知，不改变资金性质。
- 公网地址建议启用 HTTPS；反向代理后应用已设置 `trust proxy`，安全 cookie 会按 `X-Forwarded-Proto` 自动启用。
