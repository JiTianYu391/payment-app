// 外部依赖（邮件服务）的超时、重试与降级。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startApp } = require('../helpers');

let mode = 'flaky';
let calls = 0;
const mail = http.createServer((req, res) => {
  calls++;
  if (mode === 'flaky') {
    if (calls <= 2) { res.statusCode = 503; return res.end('busy'); }
    res.statusCode = 200; return res.end('{}');
  }
  if (mode === 'hang') return undefined; // 不响应，触发超时
  res.statusCode = 400; return res.end('bad');
});

let t;
test.before(async () => {
  await new Promise((r) => mail.listen(0, '127.0.0.1', r));
  t = await startApp({ DEMO_MODE: 'false', MAIL_WEBHOOK_URL: `http://127.0.0.1:${mail.address().port}/send`, MAIL_TIMEOUT_MS: '200' });
});
test.after(async () => {
  await t.close();
  mail.closeAllConnections();
  await new Promise((r) => mail.close(r));
});

test('5xx 时退避重试，第三次成功', async () => {
  mode = 'flaky'; calls = 0;
  const r = await t.call('POST', '/api/auth/request-code', { body: { email: 'a@spacepay.test' } });
  assert.equal(r.status, 200);
  assert.equal(calls, 3);
});

test('下游超时：重试用尽后返回 503，并释放发送频控', async () => {
  mode = 'hang'; calls = 0;
  const started = Date.now();
  const r = await t.call('POST', '/api/auth/request-code', { body: { email: 'b@spacepay.test' } });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'MAIL_UNAVAILABLE');
  assert.equal(calls, 3);
  assert.ok(Date.now() - started < 5000);
  mode = 'flaky'; calls = 2; // 下一次直接成功
  const again = await t.call('POST', '/api/auth/request-code', { body: { email: 'b@spacepay.test' } });
  assert.equal(again.status, 200); // 未被「1 分钟内只能发一次」拦住
});

test('4xx 不重试', async () => {
  mode = 'reject'; calls = 0;
  const r = await t.call('POST', '/api/auth/request-code', { body: { email: 'c@spacepay.test' } });
  assert.equal(r.status, 503);
  assert.equal(calls, 1);
});

test('演示收件箱在非演示模式下关闭；健康检查仍可用（其他功能不受影响）', async () => {
  assert.equal((await t.call('GET', '/api/demo-inbox?email=a@spacepay.test')).status, 404);
  assert.equal((await t.call('GET', '/api/health')).status, 200);
});
