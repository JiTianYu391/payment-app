// 子进程：对同一个 SQLite 文件里的同一个钱包反复扣款，输出成功笔数。
'use strict';

process.env.LOG_LEVEL = 'silent';
const { db, withTransaction } = require('../../../src/db');
const wallet = require('../../../src/wallet');

const [userId, times, amount] = process.argv.slice(2).map(Number);
let ok = 0;
let insufficient = 0;
for (let i = 0; i < times; i++) {
  try {
    withTransaction(() => wallet.applyCash(db, { userId, delta: -amount, type: 'pay', merchant: 'worker', description: 'concurrency test', simDay: null }));
    ok++;
  } catch (e) {
    if (e.code === 'INSUFFICIENT_FUNDS') insufficient++;
    else { process.stderr.write(String(e && e.stack) + '\n'); process.exit(2); }
  }
}
process.stdout.write(JSON.stringify({ ok, insufficient }));
