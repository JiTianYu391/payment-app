// v2 入口文件：FadeHost 从 GitHub 仓库读取 package.json，npm install 后执行 npm start（node app.js）。
// 平台自动注入 $PORT，应用必须监听 process.env.PORT（默认 3000）并绑定 0.0.0.0。
// 数据存在 /data/app.db（SQLite，WAL），见 src/db.js；JSON 降级时为 /data/app.json。
require('./src/server.js');
