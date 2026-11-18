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

    // 本用例专测「待结算」模式：收款先计入 merchant:payable，提现需财务审核。
    // 「即时结算」模式见下一个用例。
    r = await app.call('PATCH', '/api/merchant/profile', { token: owner.token, body: { settlement_mode: 'manual' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.merchant.settlement_mode, 'manual');

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

    // 收款二维码：商户可直接把接口嵌进自己的收银台
    assert.equal(pay.qr.payload, pay.checkout_url, '二维码内容应等于结账链接');
    assert.ok(pay.qr_svg && pay.qr_svg.startsWith('<svg'), '创建支付时应返回内联二维码 SVG');
    let qrRes = await app.call('GET', pay.qr.svg_url, { raw: true });
    assert.equal(qrRes.status, 200);
    assert.match(String(qrRes.headers.get('content-type')), /image\/svg\+xml/);
    assert.ok(qrRes.buf.toString('utf8').includes('<svg'));
    qrRes = await app.call('GET', '/api/checkout/' + pay.qr.svg_url.split('/')[3] + '/qr?size=320');
    assert.equal(qrRes.status, 200);
    assert.equal(qrRes.body.qr.payload, pay.checkout_url);
    assert.equal(qrRes.body.qr.size, 320);
    assert.ok(qrRes.body.qr.svg.includes('width="320"'));
    qrRes = await app.call('GET', '/api/checkout/not-a-real-token/qr.svg', { raw: true });
    assert.equal(qrRes.status, 404);

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

    // 付款成功后二维码失效，避免重复收款
    r = await app.call('GET', `/api/checkout/${token}/qr.svg`, { raw: true });
    assert.equal(r.status, 409);

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

  // 即时结算：默认模式，收款直接进商户所有者本人钱包，退款从该钱包扣回。
  test('商户即时结算：收款进本人钱包、退款扣回、对账通过', async (t) => {
    // 同进程内复用同一邮箱会触发「验证码发送太频繁」，所以本用例换管理员邮箱
    const app = await startApp({ ...env, ADMIN_EMAILS: 'admin2@spacepay.test' });
    t.after(async () => { await app.close(); });

    const admin = await app.signup('admin2@spacepay.test');
    const owner = await app.signup('owner@instant.test');
    const buyer = await app.signup('buyer@instant.test');

    let r = await app.call('POST', '/api/merchant/apply', { token: owner.token, body: { name: '即时结算商户' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await app.call('GET', '/api/admin/merchants?status=PENDING', { token: admin.token });
    const mid = r.body.items[0].id;
    const c = await app.confirmed('POST', `/api/admin/merchants/${mid}/approve`, { token: admin.token, body: {} });
    assert.equal(c.final.status, 200, JSON.stringify(c.final.body));

    // 新商户默认即时结算
    r = await app.call('GET', '/api/merchant/profile', { token: owner.token });
    assert.equal(r.body.merchant.settlement_mode, 'auto');

    r = await app.call('POST', '/api/merchant/keys', { token: owner.token, body: { label: '即时', mode: 'live' } });
    const apiHeaders = { Authorization: 'Bearer ' + r.body.key.token };

    const ownerBefore = await app.balance(owner.token);
    const buyerBefore = await app.balance(buyer.token);

    r = await app.call('POST', '/api/v1/payments', { headers: apiHeaders, body: { amount: '20.00', reference: 'instant-1', description: '扫码收款' } });
    const pay = r.body.payment;
    const token = new URL(pay.checkout_url).searchParams.get('token');

    r = await app.call('POST', `/api/checkout/${token}/pay`, { token: buyer.token, body: { pin: '123456' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.payment.settle_mode, 'auto', '订单应记录为即时结算');

    // 钱进商户所有者本人钱包，而不是平台待结算科目
    assert.equal(await app.balance(owner.token), ownerBefore + 2000);
    assert.equal(await app.balance(buyer.token), buyerBefore - 2000);
    r = await app.call('GET', '/api/v1/balance', { headers: apiHeaders });
    assert.equal(r.body.balance.available_cents, 0, '即时结算不产生待结算余额');
    assert.equal(r.body.balance.settlement_mode, 'auto');
    assert.equal(r.body.balance.wallet_cents, ownerBefore + 2000);
    assert.equal(r.body.balance.pending_payout_cents, 0);

    // 商户的交易流水能看到这笔收入
    r = await app.call('GET', '/api/transactions?type=sale', { token: owner.token });
    assert.ok(r.body.items.some((x) => x.ref_type === 'merchant_payment' && x.ref_id === pay.numeric_id), '商户流水应包含这笔收款');

    // 部分退款 5.00：商户钱包扣回，买家退回
    r = await app.call('POST', `/api/v1/payments/${pay.numeric_id}/refund`, { headers: apiHeaders, body: { amount: '5.00', reason: '部分退单' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.payment.status, 'PARTIALLY_REFUNDED');
    assert.equal(await app.balance(owner.token), ownerBefore + 1500);
    assert.equal(await app.balance(buyer.token), buyerBefore - 1500);

    // 退款不能超过商户钱包余额（先把钱转走，再看是否拒绝）
    const poor = await app.signup('poor@instant.test');
    r = await app.call('POST', '/api/v1/payments', { headers: apiHeaders, body: { amount: '30.00', reference: 'instant-2' } });
    const pay2 = r.body.payment;
    const token2 = new URL(pay2.checkout_url).searchParams.get('token');
    r = await app.call('POST', `/api/checkout/${token2}/pay`, { token: poor.token, body: { pin: '123456' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ownerBal = await app.balance(owner.token);
    // 把余额几乎全部转走，只留 1.00
    const withdrawable = ownerBal - 100;
    r = await app.call('POST', '/api/transfer', { token: owner.token, body: { to_email: buyer.email, amount: (withdrawable / 100).toFixed(2), pin: '123456' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await app.balance(owner.token), 100);
    r = await app.call('POST', `/api/v1/payments/${pay2.numeric_id}/refund`, { headers: apiHeaders, body: { amount: '5.00', reason: '余额不足' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INSUFFICIENT_MERCHANT_BALANCE');

    // 账本对账必须通过（含即时结算清算科目归零）
    r = await app.call('GET', '/api/admin/reconciliation', { token: admin.token });
    assert.deepEqual(r.body.reconciliation.issues, [], JSON.stringify(r.body.reconciliation.issues));
    assert.equal(r.body.reconciliation.clearing.merchant_income_cents, 0);

    // 切回待结算后，新收款重新计入 payable
    r = await app.call('PATCH', '/api/merchant/profile', { token: owner.token, body: { settlement_mode: 'manual' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await app.call('POST', '/api/v1/payments', { headers: apiHeaders, body: { amount: '8.00', reference: 'manual-after-switch' } });
    const token3 = new URL(r.body.payment.checkout_url).searchParams.get('token');
    const before3 = await app.balance(owner.token);
    r = await app.call('POST', `/api/checkout/${token3}/pay`, { token: buyer.token, body: { pin: '123456' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await app.balance(owner.token), before3, '待结算模式不动商户钱包');
    r = await app.call('GET', '/api/v1/balance', { headers: apiHeaders });
    assert.equal(r.body.balance.available_cents, 800);
    assert.equal(r.body.balance.settlement_mode, 'manual');
  });
};
