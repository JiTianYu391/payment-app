// 商户开放平台集成测试：入驻 → API Key → 创建支付 → 结账付款 → Webhook 签名 → 退款 → 结算 → 对账。
// SQLite 与 JSON 两种后端各跑一遍（见 merchant.*.test.js）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { startApp } = require('../helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = function scenario(env) {
  test('商户全流程：支付、Webhook 签名、退款、结算与对账', async (t) => {
    const app = await startApp({ ...env, WEBHOOK_ALLOW_HTTP: 'true' });
    t.after(async () => { await app.close(); });

    const admin = await app.signup('admin@spacepay.test');
    const owner = await app.signup('owner@shop.test');
    const buyer = await app.signup('buyer@shop.test');

    // 入驻申请与审批
    let r = await app.call('POST', '/api/merchant/apply', { token: owner.token, body: { name: '测试商户', website: 'https://shop.test' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await app.call('GET', '/api/merchant/status', { token: owner.token });
    assert.equal(r.body.merchant.status, 'PENDING');

    r = await app.call('GET', '/api/admin/merchants?status=PENDING', { token: admin.token });
    assert.equal(r.body.items.length, 1);
    const mid = r.body.items[0].id;
    let c = await app.confirmed('POST', `/api/admin/merchants/${mid}/approve`, { token: admin.token, body: {} });
    assert.equal(c.final.status, 200, JSON.stringify(c.final.body));

    r = await app.call('GET', '/api/me', { token: owner.token });
    assert.equal(r.body.user.role, 'merchant');

    // Webhook 接收端
    const received = [];
    const hookServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { received.push({ headers: req.headers, body }); res.writeHead(200); res.end('ok'); });
    });
    await new Promise((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => hookServer.close(resolve)));
    const hookPort = hookServer.address().port;

    r = await app.call('PATCH', '/api/merchant/profile', { token: owner.token, body: { webhook_url: `http://127.0.0.1:${hookPort}/hook` } });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // API Key
    r = await app.call('POST', '/api/merchant/keys', { token: owner.token, body: { label: '测试', mode: 'live' } });
    assert.equal(r.status, 201);
    const key = r.body.key.token;
    const apiHeaders = { Authorization: 'Bearer ' + key };

    // 未知/损坏密钥
    r = await app.call('GET', '/api/v1/balance', { headers: { Authorization: 'Bearer sp_live_0000000000000000_invalidinvalidinvalid' } });
    assert.equal(r.status, 401);

    // 创建支付（幂等键）
    const idem = app.key();
    const h = { ...apiHeaders, 'Idempotency-Key': idem };
    r = await app.call('POST', '/api/v1/payments', { headers: h, body: { amount: '12.34', reference: 'order-1', description: '拿铁两杯', customer_email: buyer.email } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const pay = r.body.payment;
    assert.equal(pay.status, 'CREATED');
    assert.equal(pay.amount_cents, 1234);

    const replay = await app.call('POST', '/api/v1/payments', { headers: h, body: { amount: '12.34', reference: 'order-1', description: '拿铁两杯', customer_email: buyer.email } });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.payment.id, pay.id);
    assert.equal(replay.headers.get('Idempotent-Replayed'), 'true');

    // 同一 reference 不同金额必须冲突
    r = await app.call('POST', '/api/v1/payments', { headers: apiHeaders, body: { amount: '13.00', reference: 'order-1' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'REFERENCE_CONFLICT');

    // 结账：指定付款人
    const token = new URL(pay.checkout_url).searchParams.get('token');
    const other = await app.signup('other@shop.test');
    r = await app.call('POST', `/api/checkout/${token}/pay`, { token: other.token, body: { pin: '123456' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'CUSTOMER_MISMATCH');

    const before = await app.balance(buyer.token);
    r = await app.call('POST', `/api/checkout/${token}/pay`, { token: buyer.token, body: { pin: '123456' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await app.balance(buyer.token), before - 1234);

    // 重复付款必须失败
    r = await app.call('POST', `/api/checkout/${token}/pay`, { token: buyer.token, body: { pin: '123456' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'PAYMENT_NOT_PAYABLE');

    // 商户余额
    r = await app.call('GET', '/api/v1/balance', { headers: apiHeaders });
    assert.equal(r.body.balance.available_cents, 1234);

    // Webhook：签名可验证
    for (let i = 0; i < 20 && !received.length; i++) await sleep(100);
    assert.equal(received.length, 1, '应收到一次 payment.succeeded');
    const evt = JSON.parse(received[0].body);
    assert.equal(evt.type, 'payment.succeeded');
    assert.equal(evt.data.id, pay.id);
    const sigHeader = received[0].headers['x-spacepay-signature'];
    const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=')));
    const secret = app.db.prepare('SELECT webhook_secret FROM merchants WHERE id = ?').get(mid).webhook_secret;
    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${received[0].body}`).digest('hex');
    assert.equal(parts.v1, expected, 'Webhook 签名应可通过 HMAC-SHA256 复算');
    assert.equal(received[0].headers['x-spacepay-event'], 'payment.succeeded');

    // 部分退款
    r = await app.call('POST', `/api/v1/payments/${pay.numeric_id}/refund`, { headers: apiHeaders, body: { amount: '2.34', reason: '部分退单' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.payment.status, 'PARTIALLY_REFUNDED');
    assert.equal(await app.balance(buyer.token), before - 1000);
    r = await app.call('GET', '/api/v1/balance', { headers: apiHeaders });
    assert.equal(r.body.balance.available_cents, 1000);

    // 超额退款被拒绝
    r = await app.call('POST', `/api/v1/payments/${pay.numeric_id}/refund`, { headers: apiHeaders, body: { amount: '99.00', reason: '超额' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'REFUND_EXCEEDS_REMAINING');

    // 未付款的支付单不能退款
    r = await app.call('POST', '/api/v1/payments', { headers: apiHeaders, body: { amount: '1.00', reference: 'order-unpaid' } });
    const unpaid = r.body.payment;
    r = await app.call('POST', `/api/v1/payments/${unpaid.numeric_id}/refund`, { headers: apiHeaders, body: { reason: '未支付' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'PAYMENT_NOT_REFUNDABLE');

    // 结算提现：申请 → 财务批准
    c = await app.confirmed('POST', '/api/merchant/payouts', { token: owner.token, body: { amount: '10.00', destination: '招商银行 尾号 8888' } });
    assert.equal(c.final.status, 200, JSON.stringify(c.final.body));
    const payoutId = c.final.body.payout.numeric_id;
    r = await app.call('GET', '/api/v1/balance', { headers: apiHeaders });
    assert.equal(r.body.balance.available_cents, 0);
    assert.equal(r.body.balance.pending_payout_cents, 1000);

    c = await app.confirmed('POST', `/api/admin/merchant-payouts/${payoutId}/approve`, { token: admin.token, body: {} });
    assert.equal(c.final.status, 200, JSON.stringify(c.final.body));

    // 对账必须通过
    r = await app.call('GET', '/api/admin/reconciliation', { token: admin.token });
    assert.deepEqual(r.body.reconciliation.issues, [], JSON.stringify(r.body.reconciliation.issues));

    // 吊销密钥后 API 立即失效
    r = await app.call('GET', '/api/merchant/keys', { token: owner.token });
    const keyRow = r.body.items.find((k) => k.key_id === key.split('_')[2]);
    r = await app.call('POST', `/api/merchant/keys/${keyRow.id}/revoke`, { token: owner.token, body: {} });
    assert.equal(r.status, 200);
    r = await app.call('GET', '/api/v1/balance', { headers: apiHeaders });
    assert.equal(r.status, 401);
  });
};
