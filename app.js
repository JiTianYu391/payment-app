// SpacePay 入口：FadeHost / PandaStack 执行 npm start（node app.js），平台注入 $PORT。
// 数据库默认 /data/app.db（SQLite，WAL），JSON 降级时为 /data/app.json，见 src/db.js。
require('./src/server.js').start();
