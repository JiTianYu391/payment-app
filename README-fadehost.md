# SpacePay — FadeHost 部署说明（演示环境）

- 来源：PandaStack 部署包改编，逻辑不变（邮箱注册 + 6 位验证码、新用户虚拟 $50、支付 PIN、转账/账单）。
- FadeHost 免费版：1 个 App，不用卡，256MB / 0.25 vCPU，/data 下 3GB 持久盘。
- 关键：数据必须存在 /data。src/db.js 默认路径已改：/data 存在时用 /data/app.json，
  其次 /workspace/data/app.json（兼容 PandaStack），本地用 ./data/app.json。
  FadeHost 仓库目录是只读的，不要把数据放项目里。
- 部署：FadeHost 面板 → Create app → 连 GitHub 仓库 JiTianYu391/payment-app，
  运行时 Node.js，start 命令 npm start，监听 $PORT，域名 https://<名字>.fadehost.app。
- 环境变量：SESSION_SECRET 改成随机长串，DATABASE_PATH=/data/app.json，DEMO_MODE=true。
- 免费版公网地址闲置会休眠，访问时唤醒等几秒；数据在 /data 里不会丢。
