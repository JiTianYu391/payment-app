// 升级兼容：旧版（v1/v2）数据文件启动后，老用户余额保留、补齐期初分录、可正常登录与转账、对账无差异。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const sec = require('../../src/security');

test('旧版 JSON 数据迁移到 SQLite 后余额与账本一致', async () => {
  const dir = tmpDir();
  const pw = sec.hashPassword('password123');
  const pin = sec.hashPin('123456');
  const legacy = {
    tables: {
      users: [{ id: 1, email: 'old@spacepay.test', nickname: 'old', password_salt: pw.salt, password_hash: pw.hash, pin_salt: pin.salt, pin_hash: pin.hash, failed_login_attempts: 0, locked_until: null, created_at: 1 }],
      wallets: [{ user_id: 1, balance_cents: 4321, updated_at: 1 }],
      transactions: [{ id: 1, user_id: 1, type: 'bonus', amount_cents: 5000, balance_after_cents: 5000, description: '体验金', created_at: 1 },
        { id: 2, user_id: 1, type: 'pay', amount_cents: -679, balance_after_cents: 4321, merchant: '超市', category: '购物', description: '付款', created_at: 2 }],
    },
    seq: { users: 2, transactions: 3 },
  };
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify(legacy));
  Object.assign(process.env, { DATABASE_PATH: path.join(dir, 'app.db'), LOG_LEVEL: 'silent', DEMO_MODE: 'true', RATE_LIMIT_MAX: '100000', AUTH_RATE_LIMIT_MAX: '100000', ADMIN_EMAILS: 'old@spacepay.test' });
  const { createApp } = require('../../src/server');
  const { app, db } = createApp();
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, token, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.ok(fs.existsSync(path.join(dir, 'app.json.migrated.json')));
    const login = await call('POST', '/api/auth/login', null, { email: 'old@spacepay.test', password: 'password123' });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.role, 'admin'); // ADMIN_EMAILS 引导
    const token = login.body.token;
    assert.equal((await call('GET', '/api/wallet', token)).body.balance_cents, 4321);
    const tx = await call('GET', '/api/transactions', token);
    assert.equal(tx.body.items[0].status, 'SUCCEEDED'); // 旧流水补默认状态
    const pay = await call('POST', '/api/pay', token, { merchant: '书店', amount: '3.21', pin: '123456' });
    assert.equal(pay.status, 200);
    const rec = await call('GET', '/api/admin/reconciliation', token);
    assert.deepEqual(rec.body.reconciliation.issues, []);
    const opening = db.prepare("SELECT COUNT(*) AS c FROM ledger_entries WHERE journal_type = 'opening_balance'").get().c;
    assert.equal(opening, 2);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
