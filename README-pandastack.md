# SpacePay — PandaStack Apps 部署指南

> **重要声明：账户余额为虚拟资金**，不可提现，不接入 Stripe / PayPal 等任何真实支付渠道，不可用于真实结算。真实支付需要合规支付通道 + 安全审计。

本指南面向 PandaStack Apps（Git 应用托管）：Firecracker 微虚拟机（KVM，有独立内核，不是容器）、Ubuntu 24.04、Node 22/24、每月 $5.40 免费额度、不用信用卡。按下面步骤走，约 15–30 分钟完成部署（不含推代码的时间）。

---

## 0. PandaStack 是什么？和之前方案的区别

| 方案 | 费用 | 需要信用卡 | 类型 | 备注 |
| --- | --- | --- | --- | --- |
| **PandaStack Apps（本指南）** | **每月 $5.40 免费额度** | ❌ 不需要 | Firecracker 微虚拟机（KVM） | Git 推送即部署；默认 15 分钟无流量休眠 |
| Serv00 | 永久免费 | ❌ 不需要 | FreeBSD 共享主机 + SSH | 人工审核账号（几小时–72 小时），每 90 天登录保活；适配版在 `payment-app-deploy-serv00/` |
| Oracle 免费套餐 | 免费 | ✅ 需要验证 | VPS | 已放弃：租户名问题卡住 |
| Google Cloud 免费试用 | $300 赠金 | ✅ 需要验证 | VPS | 已放弃：激活报错 OR_BACR2_59 |
| AlwaysData | 免费 | ⚠️ 注册时强制验卡 | 共享主机 + SSH | 已放弃：验卡通过后登录报 `credentials incorrect` |
| HelioHost Johnny | 免费 | ❌ 不需要 | 共享主机（Plesk） | 免费名额每天 UTC 午夜和中午 12 点放号，下次为 2026-11-07 20:00 台北时间 |
| Railway / Render | 有免费额度 | ❌ | 容器 PaaS | 免费实例会休眠，是容器形态 |

> ⚠️ **先看清免费额度的代价（官方计费文档原话）：**
> 免费额度只够跑“一个会休眠的副业项目”。本指南的 `pandastack.json` 把 `auto_hibernate` 设为 `false`（常驻不休眠），官方文档明确说明：**常驻应用几天内就会耗尽每月 $5.40 额度，额度用完后应用暂停到下个月（数据不删除），想一直常驻请升级到 Pro。**
> 所以有两个选择：
> - **想长期免费跑**：删掉 `pandastack.json` 里的 `"auto_hibernate": false` 这一行，恢复默认 15 分钟无流量休眠（唤醒亚秒级，数据在卷上不受影响），$5.40 额度就够用。
> - **想一直秒开、接受几天耗尽额度**：保持 `false`，额度到 80% 时会收到邮件提醒，到 100% 时应用暂停，下月自动恢复。
> 下面第 4 步默认按常驻（`false`）写，改回休眠只需改这一行再推送一次。

---

## 1. 账号现状（2026-11-07 已完成）

- 账号邮箱：`goutougroup8888@gmail.com`，控制台：https://app.pandastack.ai/
- 套餐：**Free、Active**，每月 $5.40 额度，未绑卡，未创建任何资源
- 组织：系统自动创建 `goutougroup8888`；**免费版只允许 1 个组织**，新建 `jitianyu391` 组织会被平台拒绝（`org limit reached: your free plan allows 1 org(s)`），也没有重命名入口。**所以 App 的名字用 `jitianyu391`，组织名保持 `goutougroup8888` 不变。**
- API Token：控制台本身不需要；只有用 CLI / SDK / API 时才需要，在 Settings → API Tokens 新建（`pds_` 开头）。本指南用控制台部署，**不需要创建 API Token**。

## 2. 把代码推到 Git 仓库

PandaStack Apps 是 Git 驱动的：你在控制台填 Git 仓库地址，平台克隆仓库、安装、构建、启动到一个持久沙箱，每次 push 到跟踪分支都会自动重新部署。

### 2.1 需要一个 Git 仓库地址

二选一：

- **已有 GitHub 仓库**：把本项目目录推上去（公开仓库可免认证克隆，私有仓库用 GitHub App 授权），记下仓库地址，例如 `https://github.com/<你的用户名>/payment-app.git`。
- **还没有仓库**：在 GitHub 新建一个空仓库（名字建议 `payment-app` 或 `jitianyu391`），再把本项目推上去：

```sh
cd ~/workspace/payment-app-deploy-pandastack
git init
git add .
git commit -m "SpacePay PandaStack Apps 部署版"
git branch -M main
git remote add origin https://github.com/<你的用户名>/payment-app.git
git push -u origin main
```

> 注意：不要把 `.env` 和 `data/` 推上去（`.gitignore` 已排除）。`data/` 里是本地测试产生的数据库，部署后会在卷上重新生成。

### 2.2 仓库里必须有的关键文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | 依赖（纯 JS，无原生编译）；`start` 为 `node app.js`；`engines` 为 Node ≥ 20 |
| `app.js` | 根目录入口，`require('./src/server.js')` 启动监听 |
| `.nvmrc` | 锁定 Node 22（`node:sqlite` 需要 Node ≥ 22.5；平台基础镜像为 Ubuntu 24.04 + Node 24 LTS，也可用 24） |
| `pandastack.json` | App 配置：名字 `jitianyu391`、runtime `nodejs`、启动命令 `npm start`、常驻 `auto_hibernate: false` |
| `src/server.js` / `src/db.js` / `src/security.js` | 应用主程序、双后端数据层、安全工具 |
| `public/` | 前端页面（SPA） |
| `.env.example` | 环境变量模板（部署时在控制台逐项填写，不要提交 `.env`） |

## 3. 在控制台新建 App

1. 打开 https://app.pandastack.ai/ 登录，左侧菜单进 **Apps** 页，点 **新建 App**（或 Create App）。
2. 按下面填写：

| 字段 | 填什么 |
| --- | --- |
| **NAME** | `jitianyu391` |
| **Git URL** | 第 2 节的仓库地址，如 `https://github.com/<你的用户名>/payment-app.git` |
| **Branch** | `main`（与你推送的分支一致） |
| **Runtime** | `Node.js`（或自动检测；`.nvmrc` 已锁定 Node 22） |
| **Install command** | `npm install`（自动检测一般已填好） |
| **Start command** | `npm start`（即 `node app.js`） |

3. **环境变量**（Apps → 你的 App → Environment variables，按 `.env.example` 逐项填写）：
   - `DATABASE_PATH=/workspace/data/app.json`（已挂载卷时；见第 5 节）
   - `SESSION_SECRET=`：随机长字符串（至少 32 字符），生成方法：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`，**不要用默认值**
   - `CORS_ORIGIN=`：先填 `*` 或你的 App 域名，拿到域名后改成 `https://<你的 App 域名>`（如 `https://jitianyu391.<suffix>/`）
   - `DEMO_MODE=true`（验证码显示在应用内演示收件箱，不发真实邮件）
   - `WELCOME_BONUS_CENTS=5000`（新用户 $50 虚拟体验金）、`TOPUP_MAX_CENTS=50000`（演示充值单次上限 $500）
   - `PORT` 不用填：平台自动注入 `$PORT`（默认 3000），应用监听 `process.env.PORT` 并绑定 `0.0.0.0`。
4. 点 **创建 / 部署**。平台会在一台全新的 Firecracker 微虚拟机里克隆仓库、安装依赖、启动应用，并对端口做 HTTP 健康检查，**通过后才把流量切换过去（蓝绿部署）**，构建失败不会影响线上版本。
5. 部署成功后，App 会得到一个稳定域名，格式为 `https://<app-id>.<suffix>/`（每次部署、休眠唤醒都不会变），备用地址为 `https://api.pandastack.ai/v1/apps/{id}/proxy/`。还支持自定义域名、PR 预览。

### 注册体验流程

1. 打开你的 App 域名，点 **注册**（在首页下方，如手机上需向下滚动）。
2. 填邮箱 + 昵称 + 密码 → 点“发送验证码”。
3. **演示版不发真实邮件**：点页面里的 **演示收件箱**，6 位验证码会显示在那里（有效期 10 分钟，最多试 5 次）。
4. 输入验证码完成注册，**立即获得 $50.00 虚拟体验金**（5000 分）。
5. 首次转账/付款前，先在「安全中心」设置 6 位支付 PIN；每次转账和付款都要输 PIN。

## 4. 常驻还是休眠（二选一，必读）

| 设置 | 效果 | 免费额度 |
| --- | --- | --- |
| `pandastack.json` 里 `"auto_hibernate": false`（本指南默认） | 常驻不休眠，第一次请求和第一千次一样快 | **几天内耗尽 $5.40**，额度用完后应用暂停到下个月（数据不删除） |
| 删掉 `"auto_hibernate": false` 这一行（恢复默认） | 15 分钟无流量后休眠，唤醒亚秒级 | $5.40 够用一个月；额度到 80% 邮件提醒 |

改法：改完 `pandastack.json` 后 `git push` 一次即自动重新部署。也可以在控制台直接改 App 的配置。

> 提醒：PandaStack 会把 uptime 监控、爬虫、健康检查探针单独分类处理，不会因为监控请求就一直把应用 pin 在唤醒状态，所以“用监控保活”骗不过休眠。

## 5. 数据持久化（非常重要，否则数据会丢）

**PandaStack 每次部署都是一台全新的机器，休眠会完全释放沙箱，官方文档说明休眠后只保留部署时 baked 的产物。** 所以：

- ❌ **不要**把正式数据只放在仓库目录（`./data/app.json`）：重新部署会新建沙箱，旧文件就没了。
- ✅ **必须挂载 Volume**：控制台 **Volumes** 页新建一个卷（Free 套餐限 **1 个、最大 1 GiB**，配额内免费），挂载到 `/workspace/data`，再把环境变量设为 `DATABASE_PATH=/workspace/data/app.json`（或 `/workspace/data/app.db` 想用 SQLite 时）。
- 数据后端是双后端自动选择（`src/db.js`）：优先 `node:sqlite`（需要 Node ≥ 22.5，`.nvmrc` 已锁定 22），加载失败自动降级到纯 JS JSON 文件存储，接口与功能完全一致。本地未设置 `DATABASE_PATH` 且没有 `/workspace` 时，默认用项目内 `./data/app.json`。
- 备份：`sh backup.sh`（会按 `DATABASE_PATH` 自动定位数据库文件，生成 `backups/app-YYYYMMDD-HHMMSS.json.gz`），**每周备份一次并下载到本地电脑**，不要只留在沙箱/卷上。

## 6. 常用操作

```sh
# 本地验证（部署前）
cd ~/workspace/payment-app-deploy-pandastack
npm install
npm start   # 默认 JSON 后端：http://localhost:3000
# SQLite 后端：DATABASE_PATH=./data/app.db node app.js（需要 Node >= 22.5）

# 健康检查（部署后）
curl https://<你的 App 域名>/api/health
# 正常返回 {"ok":true,"demo":true,"welcome_bonus_cents":5000,...}

# 查看日志：控制台 Apps → 你的 App → Runtime logs（stdout/stderr 实时流）
# 回滚：控制台 Apps → 你的 App → Rollback（一键回到上一个部署版本）
# 重新部署：git push 到 main 分支即自动部署；或用 CLI：
#   pandastack app deploy <app-id> --follow   # 需要先在 Settings → API Tokens 新建 pds_ 开头的 token
```

## 7. 与 Serv00 版的关键差异

| 项目 | Serv00 适配版 | PandaStack Apps 适配版 |
| --- | --- | --- |
| 运行环境 | FreeBSD 共享主机，无 Docker，无 root，Passenger 或 PM2 | Ubuntu 24.04 微虚拟机（KVM），Git 推送即部署 |
| 部署方式 | 上传代码到 `public_nodejs`，`devil www restart` | 推到 Git 仓库，控制台新建 App，每次 push 自动蓝绿部署 |
| Node 版本 | ≥ 18（JSON 后端）；SQLite 需 ≥ 22.5 | ≥ 20（`engines`）；`.nvmrc` 锁定 22，SQLite 需 ≥ 22.5 |
| 入口 | 根目录 `app.js`（Passenger 要求） | 根目录 `app.js` + `npm start` |
| 端口 | Passenger 模式不需要预约端口 | 平台自动注入 `$PORT`，应用监听 `process.env.PORT`、绑定 `0.0.0.0` |
| HTTPS | 面板一键 Let's Encrypt | 平台自动给稳定 `https://` 域名 |
| 休眠 | 24 小时无请求休眠 | 默认 15 分钟无流量休眠；`auto_hibernate: false` 可常驻（但几天耗尽免费额度） |
| 数据持久化 | `./data/app.json`（主机磁盘） | **必须挂载 Volume 到 `/workspace/data`**，否则重新部署/休眠会丢数据 |
| 配置文件 | `serv00-deploy.sh` | `pandastack.json`（名字、runtime、启动命令、常驻设置） |
| 功能 | 邮箱注册+验证码、新用户 $50、PBKDF2 密码/PIN、登录锁定、转账/付款需 PIN、余额/账单/安全中心 | **完全一致，未删减** |

## 8. 安全说明（演示版）

- 密码和支付 PIN 用 PBKDF2-SHA256（120000 次迭代）加盐哈希存储；会话 token 只存 SHA256 哈希；登录失败 5 次锁定 15 分钟；验证码 10 分钟过期、最多 5 次尝试。
- 演示版**只用虚拟资金**，不可提现，不接入任何真实支付。
- 部署后请确认：`.env` 里的 `SESSION_SECRET` 已是随机长字符串（不要用默认值）；不要把 `.env` 和 `data/` 提交到公开仓库；不要把数据库卷共享给他人。
- 正式上生产前需要：真实邮箱发信（SMTP）、合规支付通道、安全审计、HTTPS 强制、定期备份与漏洞修复——本演示版不包含这些，**请勿直接用于真实资金**。

## 9. 常见问题

**Q：注册时收不到验证码邮件？**
A：演示版不发真实邮件。点页面里的「演示收件箱」，验证码直接显示在那里。

**Q：部署失败，健康检查不通过？**
A：先看控制台的构建日志和 Runtime logs。常见原因：`npm install` 失败（依赖问题）、应用没监听 `$PORT`（本项目已正确处理）、环境变量没填（特别是 `DATABASE_PATH` 指向了不存在的卷挂载点——先确认卷已创建并挂载）。

**Q：打开网站显示 404 / 应用一直在休眠唤醒？**
A：确认 App 的域名没填错、`auto_hibernate` 的设置符合你的预期（见第 4 节）。休眠唤醒本身是亚秒级，首次访问慢几秒属正常。

**Q：数据丢了 / 重新部署后账号没了？**
A：数据没放卷上。按第 5 节挂载 Volume 并把 `DATABASE_PATH` 设为 `/workspace/data/app.json`，再重新部署。已丢失的数据只能从 `backup.sh` 的备份恢复。

**Q：`node:sqlite` 报错 / 应用起不来？**
A：本项目会自动降级到 JSON 存储。看启动日志：`数据后端: json` 即已降级，功能不受影响。如需 SQLite，确认 `.nvmrc` 为 22（或改成 24）后重新部署。

**Q：免费额度用完了怎么办？**
A：应用会暂停到下个月，数据不删除，下月额度恢复后自动恢复；也可以升级到 Pro 立即恢复常驻。Billing 页可以看到额度用量，到 80% 会收到邮件提醒。

**Q：Serv00 那边还要继续等吗？**
A：Serv00 账号仍在人工审核（官方说法几小时到 72 小时），HelioHost Johnny 下次放号是 2026-11-07 20:00 台北时间。PandaStack 这条路先跑通，哪个先成就用哪个，两个不冲突。

---

项目目录结构见 `README.md`。部署配置：`pandastack.json`；备份：`backup.sh`。
