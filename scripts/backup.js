// 手动备份脚本：node scripts/backup.js
// SQLite 用 VACUUM INTO 热备份（绝不用 cp 直接复制运行中的库文件），并在备份文件上做完整性校验：
//   - PRAGMA integrity_check 必须为 ok
//   - 钱包余额合计必须等于账本 wallet 科目合计
//   - 不允许存在借贷不平衡的 journal
// 校验不通过时退出码为 2（备份文件仍保留，便于排查），便于 cron / 监控告警。
'use strict';

const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');

const dir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(dir, 'app-' + stamp + '.db');

function verify(file) {
  const { DatabaseSync } = require('node:sqlite');
  const c = new DatabaseSync(file, { readOnly: true });
  const one = (sql) => { const r = c.prepare(sql).get(); return r ? Object.values(r)[0] : null; };
  const report = {
    integrity: one('PRAGMA integrity_check'),
    users: one('SELECT COUNT(*) AS c FROM users'),
    wallets: one('SELECT COUNT(*) AS c FROM wallets'),
    wallet_cents: one('SELECT COALESCE(SUM(balance_cents), 0) AS s FROM wallets'),
    ledger_wallet_cents: one("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM ledger_entries WHERE account = 'wallet'"),
    unbalanced_journals: one('SELECT COUNT(*) AS c FROM (SELECT journal_id FROM ledger_entries GROUP BY journal_id HAVING SUM(amount_cents) != 0)'),
    entries: one('SELECT COUNT(*) AS c FROM ledger_entries'),
  };
  c.close();
  report.ok = report.integrity === 'ok' && report.wallet_cents === report.ledger_wallet_cents && report.unbalanced_journals === 0;
  return report;
}

try {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
} catch (e) {
  console.error('VACUUM INTO 失败（可能为 JSON 后端）:', e.message);
  console.error('JSON 后端请用应用内 设置 → 导出我的数据（JSON），或 sh backup.sh 做文件级备份。');
  process.exit(1);
}

const report = verify(dest);
const size = fs.statSync(dest).size;
console.log('备份文件:', dest);
console.log('大小:', (size / 1024).toFixed(1) + ' KB');
console.log('校验:', JSON.stringify(report, null, 2));
if (!report.ok) {
  console.error('备份校验未通过：请检查数据库完整性，不要用该备份覆盖线上数据。');
  process.exit(2);
}
console.log('备份与校验均通过。');
process.exit(0);
