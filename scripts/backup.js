// 手动备份脚本：node scripts/backup.js
// SQLite 用 VACUUM INTO 热备份，绝不用 cp 直接复制运行中的库文件。
const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');
const dir = path.join(__dirname, '..', 'data', 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(dir, 'app-' + stamp + '.db');
try {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  const row = db.prepare('PRAGMA integrity_check').get();
  console.log('备份完成:', dest, 'integrity:', row ? Object.values(row)[0] : 'unknown');
} catch (e) {
  console.error('VACUUM INTO 失败（可能为 JSON 后端）:', e.message);
  console.error('JSON 后端请用应用内 设置 → 导出数据（JSON）作为备份。');
  process.exit(1);
}
process.exit(0);
