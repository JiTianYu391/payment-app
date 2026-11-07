// 多进程并发扣款：4 个进程同时对同一钱包扣款，验证条件扣款 + BEGIN IMMEDIATE + 写锁重试
// 不会透支、不会重复扣款，且钱包、流水、账本三方一致。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFile } = require('child_process');
const { tmpDir } = require('../helpers');

const dir = tmpDir();
process.env.DATABASE_PATH = path.join(dir, 'app.db');
process.env.LOG_LEVEL = 'silent';
const { db, withTransaction, backend } = require('../../src/db');
const wallet = require('../../src/wallet');
const ledger = require('../../src/ledger');

function runWorker(userId, times, amount) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--no-warnings', path.join(__dirname, 'fixtures', 'debit-worker.js'), String(userId), String(times), String(amount)],
      { env: process.env, timeout: 60000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        return resolve(JSON.parse(stdout));
      });
  });
}

test('多进程并发扣款不透支，账本平衡', { skip: backend !== 'sqlite' && 'node:sqlite 不可用' }, async () => {
  const u = db.prepare('INSERT INTO users (email, nickname, password_salt, password_hash, created_at) VALUES (?,?,?,?,?)').run('conc@spacepay.test', 'conc', 'x', 'x', Date.now());
  const userId = Number(u.lastInsertRowid);
  db.prepare('INSERT INTO wallets (user_id, balance_cents, updated_at) VALUES (?,?,?)').run(userId, 0, Date.now());
  withTransaction(() => wallet.applyCash(db, { userId, delta: 10000, type: 'topup', simDay: null }));

  const results = await Promise.all([1, 2, 3, 4].map(() => runWorker(userId, 10, 300))); // 共 40 笔 × $3.00，余额只够 33 笔
  const ok = results.reduce((s, r) => s + r.ok, 0);
  const insufficient = results.reduce((s, r) => s + r.insufficient, 0);
  assert.equal(ok, 33);
  assert.equal(insufficient, 7);
  assert.equal(wallet.balanceOf(db, userId), 100);
  assert.equal(ledger.walletLedgerBalance(db, userId), 100);
  const rec = ledger.reconcile(db);
  assert.deepEqual(rec.issues, []);
});
