// 安全与账户流程集成测试：PIN 锁定、找回密码、会话管理、TOTP、确认令牌一次性、退款申请、通知、注销。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers');
const sec = require('../../src/security');

module.exports = function scenario(env) {
  test('安全与账户流程', async (t) => {
    const app = await startApp(env);
    t.after(async () => { await app.close(); });

    const admin = await app.signup('admin@spacepay.test');
    const alice = await app.signup('alice@example.test');
    const bob = await app.signup('bob@example.test');
    const lock = await app.signup('lock@example.test');

    // 1) PIN 连续失败锁定
    let r;
    for (let i = 0; i < 5; i++) {
      r = await app.call('POST', '/api/transfer', { token: lock.token, body: { to_email: bob.email, amount: '1.00', pin: '000000' } });
    }
    assert.equal(r.status, 423);
    assert.equal(r.body.code, 'PIN_LOCKED');
    r = await app.call('POST', '/api/transfer', { token: lock.token, body: { to_email: bob.email, amount: '1.00', pin: lock.pin } });
    assert.equal(r.status, 423, '锁定期间即使 PIN 正确也应拒绝');

    // 2) 找回密码
    app.db.prepare('DELETE FROM verification_codes WHERE email = ?').run(alice.email);
    r = await app.call('POST', '/api/auth/request-code', { body: { email: alice.email, purpose: 'reset_password' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await app.call('GET', '/api/demo-inbox?email=' + encodeURIComponent(alice.email));
    const resetCode = r.body.items[0].code;
    r = await app.call('POST', '/api/auth/reset-password', { body: { email: alice.email, code: resetCode, new_password: 'newpassword456' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await app.call('GET', '/api/me', { token: alice.token });
    assert.equal(r.status, 401, '重置密码后旧会话应失效');
    r = await app.call('POST', '/api/auth/login', { body: { email: alice.email, password: 'password123' } });
    assert.equal(r.status, 401, '旧密码应失效');
    r = await app.call('POST', '/api/auth/login', { body: { email: alice.email, password: 'newpassword456' } });
    assert.equal(r.status, 200);
    alice.token = r.body.token;

    // 验证码不能重复使用
    r = await app.call('POST', '/api/auth/reset-password', { body: { email: alice.email, code: resetCode, new_password: 'anotherpass789' } });
    assert.equal(r.status, 400);

    // 3) 会话管理
    r = await app.call('POST', '/api/auth/login', { body: { email: alice.email, password: 'newpassword456' } });
    const second = r.body.token;
    r = await app.call('GET', '/api/security/sessions', { token: alice.token });
    assert.equal(r.body.count, 2);
    r = await app.call('POST', '/api/security/sessions/revoke-others', { token: alice.token });
    assert.equal(r.status, 200);
    r = await app.call('GET', '/api/me', { token: second });
    assert.equal(r.status, 401, '被注销的会话应失效');
    r = await app.call('GET', '/api/me', { token: alice.token });
    assert.equal(r.status, 200);

    // 4) TOTP
    r = await app.call('POST', '/api/security/totp/setup', { token: alice.token, body: { password: 'newpassword456' } });
    assert.equal(r.status, 200);
    const secret = r.body.secret;
    assert.match(r.body.otpauth_uri, /^otpauth:\/\/totp\//);
    r = await app.call('POST', '/api/security/totp/enable', { token: alice.token, body: { code: '000000' } });
    assert.equal(r.status, 403, '错误动态码不能开启');
    r = await app.call('POST', '/api/security/totp/enable', { token: alice.token, body: { code: sec.totp(secret) } });
    assert.equal(r.status, 200);
    const recovery = r.body.recovery_codes;
    assert.equal(recovery.length, 10);

    await app.call('POST', '/api/auth/logout', { token: alice.token });
    r = await app.call('POST', '/api/auth/login', { body: { email: alice.email, password: 'newpassword456' } });
    assert.equal(r.body.code, 'TOTP_REQUIRED');
    r = await app.call('POST', '/api/auth/login', { body: { email: alice.email, password: 'newpassword456', totp_code: '000000' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'TOTP_INVALID');
    r = await app.call('POST', '/api/auth/login', { body: { email: alice.email, password: 'newpassword456', totp_code: sec.totp(secret) } });
    assert.equal(r.status, 200);
    alice.token = r.body.token;

    // 恢复码只能使用一次
    await app.call('POST', '/api/auth/logout', { token: alice.token });
    r = await app.call('POST', '/api/auth/login', { body: { email: alice.email, password: 'newpassword456', recovery_code: recovery[0] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await app.call('POST', '/api/auth/login', { body: { email: alice.email, password: 'newpassword456', recovery_code: recovery[0] } });
    assert.equal(r.status, 401, '恢复码不能重复使用');

    // 用动态码重新登录，继续后续用例
    r = await app.call('POST', '/api/auth/login', { body: { email: alice.email, password: 'newpassword456', totp_code: sec.totp(secret) } });
    assert.equal(r.status, 200);
    alice.token = r.body.token;

    // 5) 确认令牌一次性
    r = await app.call('POST', '/api/withdrawals', { token: alice.token, body: { amount: '10.00', destination: '1234', pin: alice.pin } });
    assert.equal(r.status, 428);
    const confirmToken = r.body.confirm_token;
    r = await app.call('POST', '/api/withdrawals', { token: alice.token, body: { amount: '10.00', destination: '1234', pin: alice.pin, confirm_token: confirmToken } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const wid = r.body.withdrawal_id;
    r = await app.call('POST', '/api/withdrawals', { token: alice.token, body: { amount: '10.00', destination: '1234', pin: alice.pin, confirm_token: confirmToken } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'CONFIRMATION_INVALID');

    // 用户撤销提现，资金退回
    const balBefore = await app.balance(alice.token);
    let c = await app.confirmed('POST', `/api/withdrawals/${wid}/cancel`, { token: alice.token, body: {} });
    assert.equal(c.final.status, 200, JSON.stringify(c.final.body));
    assert.equal(await app.balance(alice.token), balBefore + 1000);

    // 6) 通知：bob 给 alice 转账
    await app.call('POST', '/api/transfer', { token: bob.token, body: { to_email: alice.email, amount: '3.00', pin: bob.pin } });
    r = await app.call('GET', '/api/notifications', { token: alice.token });
    assert.ok(r.body.unread >= 1);
    assert.ok(r.body.items.some((n) => n.title.includes('收到转账')));
    r = await app.call('POST', '/api/notifications/read-all', { token: alice.token });
    assert.equal(r.body.unread, 0);

    // 7) 退款申请：用户申请 → 管理员批准
    r = await app.call('POST', '/api/pay', { token: alice.token, body: { merchant: '测试商户', amount: '20.00', pin: alice.pin } });
    const paymentId = r.body.payment_id;
    const beforePayRefund = await app.balance(alice.token);
    r = await app.call('POST', `/api/payments/${paymentId}/refund-requests`, { token: alice.token, body: { reason: '未收到服务' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const reqId = r.body.refund_request_id;
    r = await app.call('POST', `/api/payments/${paymentId}/refund-requests`, { token: alice.token, body: { reason: '重复申请' } });
    assert.equal(r.status, 409, '同一支付不能有两条待审核申请');
    c = await app.confirmed('POST', `/api/admin/refund-requests/${reqId}/approve`, { token: admin.token, body: { reason: '核实属实' } });
    assert.equal(c.final.status, 200, JSON.stringify(c.final.body));
    assert.equal(await app.balance(alice.token), beforePayRefund + 2000);

    // 8) 有余额时不能注销
    r = await app.call('POST', '/api/account/close', { token: bob.token, body: { password: bob.password } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'BALANCE_NOT_ZERO');

    // 9) 对账
    r = await app.call('GET', '/api/admin/reconciliation', { token: admin.token });
    assert.deepEqual(r.body.reconciliation.issues, [], JSON.stringify(r.body.reconciliation.issues));
  });
};
