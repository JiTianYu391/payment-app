// 旧存档兼容：v4.1 之前的商户支付单没有 settle_mode 列，钱记在 merchant:payable。
// 目标：升级后这些历史数据能被正确识别（回填 manual）、对账仍然通过、退款照常工作。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers');

module.exports = function scenario(env) {
  test('旧存档：settle_mode 留空的历史支付单回填为 manual，对账与退款都不受影响', async (t) => {
    const app = await startApp({ ...env, ADMIN_EMAILS: 'admin4@spacepay.test' });
    t.after(async () => { await app.close(); });

    const admin = await app.signup('admin4@spacepay.test');
    const owner = await app.signup('owner4@legacy.test');
    // 让 owner 具备商户角色（正常流程是运营审批时赋权，这里直接造历史数据）
    app.db.prepare("UPDATE users SET role = 'merchant' WHERE id = ?").run(owner.user.id);

    // 造一条 v4.0 形态的数据：商户 + 已收款支付单 + 钱在 merchant:payable，settle_mode 为空
    const now = Date.now();
    const mid = Number(app.db.prepare(`INSERT INTO merchants (name, email, owner_user_id, status, settlement_mode, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?)`).run('历史商户', 'owner4@legacy.test', owner.user.id, 'ACTIVE', 'auto', now, now).lastInsertRowid);
    const pid = Number(app.db.prepare(`INSERT INTO merchant_payments (merchant_id, reference, amount_cents, currency, status, settle_mode, refunded_cents, created_at, paid_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(mid, 'legacy-1', 2000, 'USD', 'SUCCEEDED', null, 0, now, now, now).lastInsertRowid);

    const ledger = require('../../src/ledger');
    ledger.post(app.db, {
      journalType: 'merchant_payment',
      entries: [
        { account: 'external:merchants', user_id: null, amount_cents: -2000 },
        { account: 'merchant:payable', user_id: mid, amount_cents: 2000 },
      ],
      refType: 'merchant_payment', refId: pid, memo: '历史收款（付款人账户已注销）',
    });

    // 回填：v4.1 之前没有这列，历史已收款单一律视为待结算
    const { backfillMerchantSettleMode } = require('../../src/db');
    assert.equal(backfillMerchantSettleMode(app.db), 1, '应回填 1 条历史支付单');
    assert.equal(app.db.prepare('SELECT settle_mode FROM merchant_payments WHERE id = ?').get(pid).settle_mode, 'manual');
    assert.equal(backfillMerchantSettleMode(app.db), 0, '重复执行必须幂等');

    // 回填后对账仍然通过：这笔钱在 payable 里，预期也算在 payable 里
    let r = await app.call('GET', '/api/admin/reconciliation', { token: admin.token });
    assert.ok(r.body.reconciliation, '对账接口应返回结果: ' + JSON.stringify(r.body));
    assert.deepEqual(r.body.reconciliation.issues, [], JSON.stringify(r.body.reconciliation.issues));

    // 历史单仍然可以退款，且从可结算余额扣
    const refund = await app.confirmed('POST', `/api/merchant/payments/${pid}/refunds`, {
      token: owner.token, body: { amount: '5.00', reason: '历史订单退款' },
    });
    assert.equal(refund.final.status, 200, JSON.stringify(refund.final.body));
    assert.equal(refund.final.body.payment.status, 'PARTIALLY_REFUNDED');
    assert.equal(app.db.prepare("SELECT SUM(amount_cents) AS s FROM ledger_entries WHERE account = 'merchant:payable' AND user_id = ?").get(mid).s, 1500);

    // 退款之后账本依旧平衡
    r = await app.call('GET', '/api/admin/reconciliation', { token: admin.token });
    assert.deepEqual(r.body.reconciliation.issues, [], JSON.stringify(r.body.reconciliation.issues));
  });
};
