// 测试辅助：在独立临时目录启动 SpacePay（不监听固定端口），提供注册/登录/请求封装。
// node --test 默认每个测试文件一个进程，因此每个文件拿到独立的数据库与模块缓存。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'spacepay-test-'));
}

async function startApp(env = {}) {
  const dir = tmpDir();
  Object.assign(process.env, {
    DATABASE_PATH: path.join(dir, env.DB_BACKEND === 'json' ? 'app.json' : 'app.db'),
    LOG_LEVEL: 'silent', DEMO_MODE: 'true', RATE_LIMIT_MAX: '100000', AUTH_RATE_LIMIT_MAX: '100000',
    ADMIN_EMAILS: 'admin@spacepay.test', SESSION_SECRET: 'test-secret-'.padEnd(40, 'x'),
    // 测试绝不发送真实邮件：清空本地 .env 里可能存在的邮件配置，强制走应用内收件箱
    MAIL_SMTP_HOST: '', MAIL_SMTP_USER: '', MAIL_SMTP_PASS: '', MAIL_WEBHOOK_URL: '',
  }, env);
  const { createApp } = require('../src/server');
  const ctx = createApp();
  const server = await new Promise((resolve) => { const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;

  async function call(method, url, { token, body, headers, raw } = {}) {
    const r = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
    const json = await r.json().catch(() => null);
    return { status: r.status, headers: r.headers, body: json };
  }

  async function signup(email, { pin = '123456', password = 'password123' } = {}) {
    let res = await call('POST', '/api/auth/request-code', { body: { email, purpose: 'register' } });
    if (res.status !== 200) throw new Error('request-code failed: ' + JSON.stringify(res.body));
    res = await call('GET', '/api/demo-inbox?email=' + encodeURIComponent(email));
    const code = res.body.items[0].code;
    res = await call('POST', '/api/auth/register', { body: { email, nickname: email.split('@')[0], password, code } });
    if (res.status !== 200) throw new Error('register failed: ' + JSON.stringify(res.body));
    res = await call('POST', '/api/auth/login', { body: { email, password } });
    const token = res.body.token;
    if (pin) {
      const r2 = await call('POST', '/api/security/set-pin', { token, body: { pin, password } });
      if (r2.status !== 200) throw new Error('set-pin failed: ' + JSON.stringify(r2.body));
    }
    return { token, user: res.body.user, email, pin, password };
  }

  // 两步确认：第一次拿 428 + confirm_token，第二次带上令牌执行
  async function confirmed(method, url, { token, body, headers }) {
    const first = await call(method, url, { token, body, headers });
    if (first.status !== 428) return { first, final: first };
    const final = await call(method, url, { token, body: { ...body, confirm_token: first.body.confirm_token }, headers });
    return { first, final };
  }

  async function balance(token) {
    return (await call('GET', '/api/wallet', { token })).body.balance_cents;
  }

  async function close() {
    await new Promise((r) => server.close(r));
  }

  return { ...ctx, base, call, signup, confirmed, balance, close, dir, key: () => crypto.randomUUID() };
}

module.exports = { startApp, tmpDir };
