// PandaStack Apps 入口文件
// PandaStack Apps 会自动检测 package.json，用 `npm install` 安装依赖后
// 执行 `npm start`（即 `node app.js`）启动应用。平台自动注入 $PORT 与 $HOST，
// 应用必须监听 process.env.PORT（默认 3000）并绑定 0.0.0.0（见 src/server.js）。
// 实际逻辑在 src/server.js，require 它即启动监听。
require('./src/server.js');
