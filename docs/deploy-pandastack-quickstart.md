# SpacePay — PandaStack Apps 快速部署（演示环境）

> **虚拟资金演示版**，不可提现，不接入真实支付。部署指南见 **[README-pandastack.md](README-pandastack.md)**（中文，含推 Git 仓库、新建 App、环境变量、常驻/休眠、卷挂载全流程）。

## 目录结构

```
payment-app-deploy-pandastack/
├── app.js               # PandaStack Apps 入口（npm start 即 node app.js）
├── package.json         # 依赖（纯 JS，无原生编译；Node >= 20；start: node app.js）
├── package-lock.json
├── .nvmrc               # 锁定 Node 22（node:sqlite 需要 Node >= 22.5）
├── pandastack.json      # App 配置：名字 jitianyu391、runtime nodejs、npm start、auto_hibernate false
├── .env.example         # 环境变量模板（在控制台逐项填写，不要提交 .env）
├── .gitignore
├── backup.sh            # 数据库备份（按 DATABASE_PATH 自动定位 JSON / SQLite 文件）
├── README-pandastack.md # 完整部署指南（中文）
├── src/
│   ├── server.js        # 应用主程序（Express API + 静态托管，监听 $PORT、绑定 0.0.0.0）
│   ├── db.js            # 数据层：优先 node:sqlite，不可用时自动降级到纯 JS JSON 存储；
│   │                    #   默认 DATABASE_PATH：/workspace 存在时用 /workspace/data/app.json，
│   │                    #   否则用项目内 ./data/app.json
│   └── security.js      # PBKDF2 密码/PIN 哈希、会话 token、验证码
├── public/
│   ├── index.html       # 前端页面（SPA）
│   ├── app.js           # 前端逻辑
│   └── styles.css
└── data/                # 运行时生成（数据库文件，不提交；正式部署请用卷 /workspace/data）
    └── app.json         # JSON 后端默认数据文件（SQLite 后端时为 app.db）
```

## 快速部署（PandaStack 账号已注册）

```sh
# 1. 推到 Git 仓库（公开仓库可免认证克隆，私有仓库用 GitHub App 授权）
cd ~/workspace/payment-app-deploy-pandastack
git init && git add . && git commit -m "SpacePay PandaStack Apps 部署版"
git branch -M main
git remote add origin https://github.com/<你的用户名>/payment-app.git
git push -u origin main

# 2. 控制台 https://app.pandastack.ai/ → Apps → 新建 App
#    NAME: jitianyu391 | Git URL: 上面的仓库地址 | Branch: main
#    Runtime: Node.js | Start: npm start
#    环境变量按 .env.example 填写（DATABASE_PATH=/workspace/data/app.json，
#    SESSION_SECRET 改成随机长字符串，CORS_ORIGIN 改成 App 域名）
# 3. 先在控制台 Volumes 页新建 1 GiB 卷挂载到 /workspace/data（见 README 第 5 节）
# 4. 访问 https://<app-id>.<suffix>/ 注册体验，验证码在应用内「演示收件箱」查看
```

> ⚠️ **免费额度提醒**：`pandastack.json` 的 `auto_hibernate: false` 是常驻设置，官方计费文档说明常驻应用几天内就会耗尽每月 $5.40 额度，额度用完后应用暂停到下个月（数据不删除）。想长期免费跑，删掉这一行恢复默认 15 分钟休眠即可。

## 与 Serv00 版的关键差异

| 项目 | Serv00 适配版 | PandaStack Apps 适配版 |
| --- | --- | --- |
| 运行环境 | FreeBSD 共享主机，无 Docker，无 root，Passenger 或 PM2 | Ubuntu 24.04 微虚拟机（KVM），Git 推送即部署 |
| 部署方式 | 上传代码到 `public_nodejs`，`devil www restart` | 推到 Git 仓库，控制台新建 App，每次 push 自动蓝绿部署 |
| Node 版本 | ≥ 18（JSON 后端）；SQLite 需 ≥ 22.5 | ≥ 20；`.nvmrc` 锁定 22 |
| 入口 | 根目录 `app.js`（Passenger 要求） | 根目录 `app.js` + `npm start` |
| 端口 | Passenger 模式不需要预约端口 | 平台自动注入 `$PORT`，监听 `process.env.PORT`、绑定 `0.0.0.0` |
| HTTPS | 面板一键 Let's Encrypt | 平台自动给稳定 `https://` 域名 |
| 休眠 | 24 小时无请求休眠 | 默认 15 分钟无流量休眠；`auto_hibernate: false` 可常驻（几天耗尽免费额度） |
| 数据持久化 | `./data/app.json`（主机磁盘） | **必须挂载 Volume 到 `/workspace/data`**，否则重新部署/休眠会丢数据 |
| 配置文件 | `serv00-deploy.sh` | `pandastack.json` |
| 功能 | 邮箱注册+验证码、新用户 $50、PBKDF2 密码/PIN、登录锁定、转账/付款需 PIN、余额/账单/安全中心 | **完全一致，未删减** |

功能与原版完全一致：邮箱注册 + 6 位验证码演示收件箱、新用户 $50 虚拟体验金、PBKDF2 密码/PIN 哈希、登录锁定、转账/付款需 PIN、余额/账单/安全中心。

## 本地验证

```sh
npm install
npm start   # 默认 JSON 后端：http://localhost:3000
# SQLite 后端：DATABASE_PATH=./data/app.db node app.js（需要 Node >= 22.5）
```

原版在 `~/workspace/payment-app-deploy/`（Docker 版，未改动）；Serv00 版在 `~/workspace/payment-app-deploy-serv00/`（未改动）。
