// 关键路径集成测试，SQLite 与 JSON 两种后端各跑一遍（见 api.*.test.js）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { startApp } = require('../helpers');

module.exports = function scenario(env) {
  let t;
  let alice;
  let bob;
  let admin;
  let finance;
  let viewer;

  async function reconcileOk() {
    const r = await t.call('GET', '/api/admin/reconciliation', { token: admin.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.reconciliation.issues, [], JSON.stringify(r.body.reconciliation.issues));
    assert.equal(r.body.reconciliation.ok, true);
    return r.body.reconciliation;
  }

  test.before(async () => {
    t = await startApp(env);
    alice = await t.signup('alice@spacepay.test');
    bob = await t.signup('bob@spacepay.test');
    admin = await t.signup('admin@spacepay.test');
    finance = await t.signup('finance@spacepay.test');
    viewer = await t.signup('viewer@spacepay.test');
    for (const [u, role] of [[finance, 'finance'], [viewer, 'viewer']]) {
      const { final } = await t.confirmed('POST', `/api/admin/users/${u.user.id}/role`, { token: admin.token, body: { role } });
      assert.equal(final.status, 200, JSON.stringify(final.body));
    }
  });
  test.after(async () => { if (t) await t.close(); });

  test('注册送体验金；账本期初平衡', async () => {
    assert.equal(await t.balance(alice.token), 5000);
    assert.equal(admin.user.role, 'admin');
    await reconcileOk();
  });

  test('输入校验：零金额、负数、超精度、非法邮箱，错误信息可读且带 code 与 request_id', async () => {
    const cases = [
      [{ to_email: bob.email, amount: 0 }, 'AMOUNT_ZERO'],
      [{ to_email: bob.email, amount: '-5' }, 'AMOUNT_NEGATIVE'],
      [{ to_email: bob.email, amount: '1.005' }, 'AMOUNT_PRECISION'],
      [{ to_email: bob.email, amount: 'ten' }, 'AMOUNT_INVALID'],
      [{ to_email: 'not-an-email', amount: '1' }, 'EMAIL_INVALID'],
      [{ to_email: alice.email, amount: '1' }, 'TRANSFER_TO_SELF'],
    ];
    for (const [body, code] of cases) {
      const r = await t.call('POST', '/api/transfer', { token: alice.token, body: { ...body, pin: alice.pin } });
      assert.equal(r.status, 400, code);
      assert.equal(r.body.code, code);
      assert.equal(typeof r.body.error, 'string');
      assert.match(r.body.request_id, /^req_/);
    }
    const bad = await fetch(t.base + '/api/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + alice.token }, body: '{bad json' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'BAD_JSON');
    assert.equal(await t.balance(alice.token), 5000);
  });

  test('转账：超额拒绝并给出差额；成功后双方余额与账本一致', async () => {
    let r = await t.call('POST', '/api/transfer', { token: alice.token, body: { to_email: bob.email, amount: '50.01', pin: alice.pin } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INSUFFICIENT_FUNDS');
    assert.match(r.body.error, /\$0\.01/);
    r = await t.call('POST', '/api/transfer', { token: alice.token, body: { to_email: bob.email, amount: '12.50', pin: '000000' } });
    assert.equal(r.status, 403);
    r = await t.call('POST', '/api/transfer', { token: alice.token, body: { to_email: bob.email, amount: '12.50', pin: alice.pin } });
    assert.equal(r.status, 200);
    assert.equal(await t.balance(alice.token), 3750);
    assert.equal(await t.balance(bob.token), 6250);
    await reconcileOk();
  });

  test('幂等：同键重放返回原响应不重复扣款；同键不同参数 422；失败请求可用同键重试', async () => {
    const key = t.key();
    const body = { to_email: bob.email, amount: '1.00', pin: alice.pin };
    const a = await t.call('POST', '/api/transfer', { token: alice.token, body, headers: { 'Idempotency-Key': key } });
    const b = await t.call('POST', '/api/transfer', { token: alice.token, body, headers: { 'Idempotency-Key': key } });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(b.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(b.body, a.body);
    assert.equal(await t.balance(alice.token), 3650);
    const c = await t.call('POST', '/api/transfer', { token: alice.token, body: { ...body, amount: '2.00' }, headers: { 'Idempotency-Key': key } });
    assert.equal(c.status, 422);
    assert.equal(c.body.code, 'IDEMPOTENCY_KEY_REUSED');
    // 首次失败（余额不足）不占用键
    const k2 = t.key();
    const f1 = await t.call('POST', '/api/pay', { token: alice.token, body: { merchant: 'Shop', amount: '999', pin: alice.pin }, headers: { 'Idempotency-Key': k2 } });
    assert.equal(f1.status, 400);
    await t.call('POST', '/api/topup', { token: alice.token, body: { amount: '500' }, headers: { 'Idempotency-Key': t.key() } });
    await t.call('POST', '/api/topup', { token: alice.token, body: { amount: '500' }, headers: { 'Idempotency-Key': t.key() } });
    const f2 = await t.call('POST', '/api/pay', { token: alice.token, body: { merchant: 'Shop', amount: '999', pin: alice.pin }, headers: { 'Idempotency-Key': k2 } });
    assert.equal(f2.status, 200, JSON.stringify(f2.body));
    assert.equal(await t.balance(alice.token), 3650 + 100000 - 99900);
    const k3 = await t.call('POST', '/api/topup', { token: alice.token, body: { amount: '1' }, headers: { 'Idempotency-Key': 'short' } });
    assert.equal(k3.body.code, 'IDEMPOTENCY_KEY_INVALID');
    await reconcileOk();
  });

  test('并发扣款：20 笔并发转账只成功余额允许的笔数，余额不为负', async () => {
    const carol = await t.signup('carol@spacepay.test'); // 余额 $50.00
    const reqs = Array.from({ length: 20 }, () => t.call('POST', '/api/transfer', { token: carol.token, body: { to_email: bob.email, amount: '10.00', pin: carol.pin }, headers: { 'Idempotency-Key': t.key() } }));
    const res = await Promise.all(reqs);
    const ok = res.filter((r) => r.status === 200).length;
    const insufficient = res.filter((r) => r.body && r.body.code === 'INSUFFICIENT_FUNDS').length;
    assert.equal(ok, 5);
    assert.equal(insufficient, 15);
    assert.equal(await t.balance(carol.token), 0);
    // 同一个键并发提交 10 次：只扣一次
    const dave = await t.signup('dave@spacepay.test');
    const key = t.key();
    const same = await Promise.all(Array.from({ length: 10 }, () => t.call('POST', '/api/pay', { token: dave.token, body: { merchant: 'Cafe', amount: '3.00', pin: dave.pin }, headers: { 'Idempotency-Key': key } })));
    assert.ok(same.every((r) => r.status === 200 || r.status === 409), JSON.stringify(same.map((r) => r.status)));
    assert.equal(await t.balance(dave.token), 4700);
    const pays = await t.call('GET', '/api/payments', { token: dave.token });
    assert.equal(pays.body.items.length, 1);
    await reconcileOk();
  });

  test('退款：零金额、超额退款被拒绝；部分退款与全额退款走状态机', async () => {
    const pay = await t.call('POST', '/api/pay', { token: bob.token, body: { merchant: 'Book Store', category: '购物', amount: '20.00', pin: bob.pin }, headers: { 'Idempotency-Key': t.key() } });
    assert.equal(pay.status, 200);
    const id = pay.body.payment_id;
    const before = await t.balance(bob.token);
    const url = `/api/admin/payments/${id}/refunds`;
    // 普通用户与只读访客无权退款
    assert.equal((await t.call('POST', url, { token: bob.token, body: { amount: '1', reason: '测试' } })).status, 403);
    assert.equal((await t.call('POST', url, { token: viewer.token, body: { amount: '1', reason: '测试' } })).status, 403);
    let r = await t.call('POST', url, { token: finance.token, body: { amount: '0', reason: '零金额' } });
    assert.equal(r.body.code, 'AMOUNT_ZERO');
    r = await t.call('POST', url, { token: finance.token, body: { amount: '20.01', reason: '超额' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'REFUND_EXCEEDS_REMAINING');
    // 二次确认：第一次只返回摘要，不执行
    const p1 = await t.confirmed('POST', url, { token: finance.token, body: { amount: '5.00', reason: '商品缺货' }, headers: { 'Idempotency-Key': t.key() } });
    assert.equal(p1.first.status, 428);
    assert.ok(p1.first.body.summary.lines.length > 3);
    assert.equal(p1.final.status, 200, JSON.stringify(p1.final.body));
    assert.equal(p1.final.body.payment_status, 'PARTIALLY_REFUNDED');
    assert.equal(await t.balance(bob.token), before + 500);
    // 确认令牌不能被挪用到另一金额
    const first = await t.call('POST', url, { token: finance.token, body: { amount: '1.00', reason: '再退' } });
    const misuse = await t.call('POST', url, { token: finance.token, body: { amount: '2.00', reason: '再退', confirm_token: first.body.confirm_token } });
    assert.equal(misuse.body.code, 'CONFIRMATION_INVALID');
    r = await t.call('POST', url, { token: finance.token, body: { amount: '15.01', reason: '超过剩余' } });
    assert.equal(r.body.code, 'REFUND_EXCEEDS_REMAINING');
    const p2 = await t.confirmed('POST', url, { token: finance.token, body: { amount: '15.00', reason: '全部退回' } });
    assert.equal(p2.final.body.payment_status, 'REFUNDED');
    r = await t.call('POST', url, { token: finance.token, body: { amount: '0.01', reason: '已退完' } });
    assert.equal(r.body.code, 'REFUND_EXCEEDS_REMAINING');
    assert.equal(await t.balance(bob.token), before + 2000);
    const tx = await t.call('GET', '/api/transactions?type=pay&status=REFUNDED', { token: bob.token });
    assert.equal(tx.body.filtered_total, 1);
    const logs = await t.call('GET', '/api/admin/operation-logs?action=refund.create', { token: viewer.token });
    assert.ok(logs.body.items.some((l) => l.result === 'REJECTED:REFUND_EXCEEDS_REMAINING'));
    assert.ok(logs.body.items.filter((l) => l.result === 'SUCCEEDED').length >= 2);
    await reconcileOk();
  });

  test('提现：二次确认 → 待审核（在途科目）→ 驳回退回 / 批准出款；不能审核自己的申请', async () => {
    const before = await t.balance(bob.token);
    let r = await t.confirmed('POST', '/api/withdrawals', { token: bob.token, body: { amount: '10.00', destination: '1234', pin: bob.pin }, headers: { 'Idempotency-Key': t.key() } });
    assert.equal(r.first.status, 428);
    assert.equal(r.final.status, 200, JSON.stringify(r.final.body));
    const w1 = r.final.body.withdrawal_id;
    assert.equal(await t.balance(bob.token), before - 1000);
    let rec = await reconcileOk();
    assert.equal(rec.clearing.withdrawals_in_transit_cents, 1000);
    r = await t.call('POST', '/api/withdrawals', { token: bob.token, body: { amount: '10', destination: '12a4', pin: bob.pin } });
    assert.equal(r.status, 400);
    // 驳回需要原因
    r = await t.call('POST', `/api/admin/withdrawals/${w1}/reject`, { token: finance.token, body: {} });
    assert.equal(r.body.code, 'FIELD_REQUIRED');
    r = await t.confirmed('POST', `/api/admin/withdrawals/${w1}/reject`, { token: finance.token, body: { reason: '账户信息不符' } });
    assert.equal(r.final.status, 200);
    assert.equal(await t.balance(bob.token), before);
    r = await t.confirmed('POST', `/api/admin/withdrawals/${w1}/approve`, { token: finance.token, body: {} });
    assert.equal(r.final.status, 409); // FAILED → SUCCEEDED 不允许
    assert.equal(r.final.body.code, 'INVALID_STATE_TRANSITION');
    // 批准
    r = await t.confirmed('POST', '/api/withdrawals', { token: bob.token, body: { amount: '5.00', destination: '9876', pin: bob.pin } });
    const w2 = r.final.body.withdrawal_id;
    r = await t.confirmed('POST', `/api/admin/withdrawals/${w2}/approve`, { token: finance.token, body: { reason: '核对无误' } });
    assert.equal(r.final.status, 200);
    rec = await reconcileOk();
    assert.equal(rec.clearing.withdrawals_in_transit_cents, 0);
    // 财务不能审核自己的提现
    await t.call('POST', '/api/topup', { token: finance.token, body: { amount: '20' } });
    r = await t.confirmed('POST', '/api/withdrawals', { token: finance.token, body: { amount: '1.00', destination: '1111', pin: finance.pin } });
    const self = await t.call('POST', `/api/admin/withdrawals/${r.final.body.withdrawal_id}/approve`, { token: finance.token, body: {} });
    assert.equal(self.body.code, 'MAKER_CHECKER');
    const reject = await t.confirmed('POST', `/api/admin/withdrawals/${r.final.body.withdrawal_id}/reject`, { token: admin.token, body: { reason: '测试清理' } });
    assert.equal(reject.final.status, 200);
    // 超过单笔上限
    r = await t.call('POST', '/api/withdrawals', { token: bob.token, body: { amount: '500.01', destination: '1234', pin: bob.pin } });
    assert.equal(r.body.code, 'AMOUNT_TOO_LARGE');
  });

  test('冻结：冻结后不能转账/付款/下单/收款；解冻后恢复；只有管理员可操作', async () => {
    const eve = await t.signup('eve@spacepay.test');
    const url = `/api/admin/users/${eve.user.id}/freeze`;
    assert.equal((await t.call('POST', url, { token: finance.token, body: { reason: '风险排查' } })).status, 403);
    let r = await t.call('POST', url, { token: admin.token, body: {} });
    assert.equal(r.body.code, 'FIELD_REQUIRED');
    r = await t.confirmed('POST', url, { token: admin.token, body: { reason: '风险排查' } });
    assert.equal(r.final.status, 200);
    r = await t.call('POST', '/api/transfer', { token: eve.token, body: { to_email: bob.email, amount: '1', pin: eve.pin } });
    assert.equal(r.status, 423);
    assert.equal(r.body.code, 'ACCOUNT_FROZEN');
    r = await t.call('POST', '/api/orders', { token: eve.token, body: { product_id: 'SIM-ETF-01', side: 'BUY', amount: '5', pin: eve.pin } });
    assert.equal(r.status, 423);
    r = await t.call('POST', '/api/demo/reset', { token: eve.token, body: { password: eve.password } });
    assert.equal(r.status, 423); // 冻结账户不能通过重置演示数据改动余额
    r = await t.call('POST', '/api/transfer', { token: bob.token, body: { to_email: eve.email, amount: '1', pin: bob.pin } });
    assert.equal(r.body.code, 'RECIPIENT_UNAVAILABLE');
    r = await t.confirmed('POST', url, { token: admin.token, body: { reason: '重复冻结' } });
    assert.equal(r.final.body.code, 'INVALID_STATE_TRANSITION');
    r = await t.confirmed('POST', `/api/admin/users/${eve.user.id}/unfreeze`, { token: admin.token, body: { reason: '排查完毕' } });
    assert.equal(r.final.status, 200);
    r = await t.call('POST', '/api/transfer', { token: eve.token, body: { to_email: bob.email, amount: '1', pin: eve.pin } });
    assert.equal(r.status, 200);
    assert.equal((await t.call('POST', `/api/admin/users/${admin.user.id}/freeze`, { token: admin.token, body: { reason: '自己' } })).body.code, 'SELF_ACTION_FORBIDDEN');
  });

  test('权限：普通用户不能进后台；只读访客能看不能导出', async () => {
    assert.equal((await t.call('GET', '/api/admin/transactions', { token: alice.token })).status, 403);
    assert.equal((await t.call('GET', '/api/admin/transactions', { token: viewer.token })).status, 200);
    assert.equal((await t.call('GET', '/api/admin/transactions/export?format=csv', { token: viewer.token, raw: true })).status, 403);
    assert.equal((await t.call('GET', '/api/admin/reconciliation', { token: viewer.token })).status, 403);
    assert.equal((await t.call('GET', '/api/admin/overview', { token: viewer.token })).status, 200);
  });

  test('交易列表：多维筛选、排序、分页，口径与汇总一致', async () => {
    let r = await t.call('GET', '/api/admin/transactions?type=transfer_out,transfer_in&min_amount=10&max_amount=10&sort=amount&order=desc&page=1&page_size=3', { token: viewer.token });
    assert.equal(r.status, 200);
    assert.ok(r.body.filtered_total >= 10); // carol 的 5 笔转出 + bob 的 5 笔转入
    assert.equal(r.body.items.length, 3);
    assert.ok(r.body.items.every((x) => Math.abs(x.amount_cents) === 1000 && x.user_email));
    const p2 = await t.call('GET', '/api/admin/transactions?type=transfer_out,transfer_in&min_amount=10&max_amount=10&page=2&page_size=3', { token: viewer.token });
    assert.notDeepEqual(p2.body.items.map((x) => x.id), r.body.items.map((x) => x.id));
    r = await t.call('GET', '/api/admin/transactions?merchant=book&status=REFUNDED', { token: viewer.token });
    assert.equal(r.body.filtered_total, 1);
    r = await t.call('GET', '/api/admin/transactions?email=carol&sort=created_at&order=asc', { token: viewer.token });
    const times = r.body.items.map((x) => x.created_at);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    assert.equal(r.body.summary.outflow_cents, 5000);
    r = await t.call('GET', '/api/admin/transactions?from=2999-01-01', { token: viewer.token });
    assert.equal(r.body.filtered_total, 0);
    r = await t.call('GET', '/api/admin/transactions?min_amount=abc', { token: viewer.token });
    assert.equal(r.status, 400);
    // 旧版接口参数仍可用：limit / offset / type / q
    r = await t.call('GET', '/api/transactions?limit=2&offset=0', { token: bob.token });
    assert.equal(r.body.items.length, 2);
    assert.equal(typeof r.body.total, 'number');
    r = await t.call('GET', '/api/transactions?q=Book', { token: bob.token });
    assert.ok(r.body.items.length >= 1);
    const stats = await t.call('GET', '/api/stats', { token: bob.token });
    const all = await t.call('GET', '/api/transactions?page_size=200', { token: bob.token });
    assert.equal(stats.body.income_cents, all.body.summary.inflow_cents); // 同一指标两处口径一致
    assert.equal(stats.body.expense_cents, all.body.summary.outflow_cents);
    assert.equal(stats.body.period.label, '全部历史');
  });

  test('导出：CSV 与 Excel 与筛选条件一致', async () => {
    const csv = await t.call('GET', '/api/admin/transactions/export?format=csv&email=carol', { token: finance.token, raw: true });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition'), /spacepay-transactions-.*\.csv/);
    const text = csv.buf.toString('utf8');
    assert.ok(text.startsWith('﻿交易编号,时间（UTC）,用户邮箱'));
    const lines = text.trim().split('\r\n');
    assert.equal(lines.length, 1 + 6); // 表头 + 体验金 1 笔 + 转出 5 笔
    assert.ok(lines.some((l) => l.includes('-10.00')));
    const xlsx = await t.call('GET', '/api/admin/transactions/export?format=xlsx&email=carol', { token: finance.token, raw: true });
    assert.equal(xlsx.status, 200);
    assert.equal(xlsx.buf.readUInt32LE(0), 0x04034b50);
    // 找到 sheet1 并解压
    const name = 'xl/worksheets/sheet1.xml';
    const at = xlsx.buf.indexOf(Buffer.from(name));
    const csize = xlsx.buf.readUInt32LE(at - 30 + 18);
    const sheet = zlib.inflateRawSync(xlsx.buf.slice(at + name.length, at + name.length + csize)).toString('utf8');
    assert.equal((sheet.match(/<row /g) || []).length, 7);
    assert.ok(sheet.includes('<v>-10.00</v>'));
    const mine = await t.call('GET', '/api/transactions/export?format=csv', { token: alice.token, raw: true });
    assert.equal(mine.status, 200);
    assert.ok(!mine.buf.toString('utf8').includes('用户邮箱'));
    const logs = await t.call('GET', '/api/admin/operation-logs?action=tx.export', { token: admin.token });
    assert.ok(logs.body.items.length >= 2);
  });

  test('投资：买卖、定存、推进模拟日（分红/利息/到期）后账本仍平衡', async () => {
    let r = await t.call('POST', '/api/orders/preview', { token: alice.token, body: { product_id: 'SIM-ETF-01', side: 'BUY', amount: '10.00' } });
    assert.equal(r.status, 200);
    const key = t.key();
    const order = { product_id: 'SIM-ETF-01', side: 'BUY', quantity_milli: r.body.quantity_milli, pin: alice.pin, idempotency_key: key };
    r = await t.call('POST', '/api/orders', { token: alice.token, body: order });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const dup = await t.call('POST', '/api/orders', { token: alice.token, body: order });
    assert.equal(dup.body.duplicate, true);
    r = await t.call('POST', '/api/orders', { token: alice.token, body: { product_id: 'SIM-ETF-01', side: 'SELL', quantity: '0.05', pin: alice.pin } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await t.call('POST', '/api/orders', { token: alice.token, body: { product_id: 'SIM-FD-01', side: 'BUY', amount: '5.00', pin: alice.pin } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await t.call('POST', '/api/orders', { token: alice.token, body: { product_id: 'SIM-FND-01', side: 'BUY', amount: '20.00', pin: alice.pin } });
    assert.equal(r.status, 200);
    r = await t.call('POST', '/api/orders', { token: alice.token, body: { product_id: 'SIM-ETF-01', side: 'BUY', amount: '1.234', pin: alice.pin } });
    assert.equal(r.status, 400);
    for (let i = 0; i < 8; i++) t.invest.runTick(); // 7 天定存到期 + 货币基金计息
    const fds = await t.call('GET', '/api/fixed-deposits', { token: alice.token });
    assert.equal(fds.body.items[0].status, 'MATURED');
    const tx = await t.call('GET', '/api/transactions?type=FD_REDEEM', { token: alice.token });
    assert.equal(tx.body.items[0].amount_cents, 500); // 本金单独入账，不再混入利息
    const perf = await t.call('GET', '/api/performance?range=ALL', { token: alice.token });
    assert.equal(perf.status, 200);
    assert.ok(perf.body.period.label.startsWith('模拟日'));
    await reconcileOk();
  });

  test('收益率：当日只有资金进出（无价格变化）时 TWR 为 0，不受快照滞后影响', async () => {
    const fay = await t.signup('fay@spacepay.test');
    await t.call('POST', '/api/topup', { token: fay.token, body: { amount: '100.00' } });
    await t.call('POST', '/api/transfer', { token: fay.token, body: { to_email: bob.email, amount: '10.00', pin: fay.pin } });
    const perf = await t.call('GET', '/api/performance?range=1M', { token: fay.token });
    assert.equal(perf.status, 200);
    assert.ok(Math.abs(perf.body.twr_pct) < 1e-9, 'twr=' + perf.body.twr_pct);
    assert.equal(perf.body.series[perf.body.series.length - 1].total_cents, 14000);
  });

  test('演示重置：账本只追加，用冲正分录清零后重新发放体验金', async () => {
    const r = await t.call('POST', '/api/demo/reset', { token: alice.token, body: { password: alice.password } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await t.balance(alice.token), 5000);
    await reconcileOk();
  });

  test('PWA：清单、service worker 与应用图标可访问', async () => {
    const m = await fetch(t.base + '/manifest.webmanifest');
    assert.equal(m.status, 200);
    assert.match(m.headers.get('content-type'), /application\/manifest\+json/);
    const manifest = await m.json();
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
    for (const icon of manifest.icons) assert.equal((await fetch(t.base + icon.src)).status, 200, icon.src);
    const sw = await fetch(t.base + '/sw.js');
    assert.equal(sw.status, 200);
    assert.match(await sw.text(), /\/api\//); // 接口请求不进缓存
  });

  test('健康检查与未知接口', async () => {
    const h = await t.call('GET', '/api/health');
    assert.equal(h.body.service, 'SpacePay');
    assert.equal(h.body.components.db.ok, true);
    const nf = await t.call('GET', '/api/does-not-exist');
    assert.equal(nf.status, 404);
    assert.equal(nf.body.code, 'NOT_FOUND');
    assert.ok(nf.headers.get('x-request-id'));
  });
};
