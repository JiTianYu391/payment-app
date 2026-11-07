// FadeHost 入口文件
// FadeHost 从 GitHub 仓库读取 package.json，npm install 后执行 npm start（即 node app.js）。
// 平台自动注入 $PORT，应用必须监听 process.env.PORT（默认 3000）并绑定 0.0.0.0。
// 数据必须存在 /data 下（免费版 3GB 持久盘），见 src/db.js 默认路径。
require('./src/server.js');
