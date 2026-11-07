// 验证码投递。
// - 演示模式：写入应用内演示收件箱，不发真实邮件。
// - 非演示模式：POST 到 MAIL_WEBHOOK_URL（由部署方接入邮件服务），单次 5 秒超时，
//   网络错误 / 5xx / 429 时指数退避重试 2 次；仍失败则返回 503，提示用户稍后重试（降级，不阻塞其他功能）。
'use strict';

const { withRetry, withTimeout } = require('./resilience');
const { AppError } = require('./errors');

const TIMEOUT_MS = parseInt(process.env.MAIL_TIMEOUT_MS || '5000', 10);

async function deliverCode({ db, demoMode, email, code, purpose, log }) {
  if (demoMode) {
    db.prepare('INSERT INTO demo_inbox (email, code, purpose, created_at) VALUES (?,?,?,?)').run(email, code, purpose, Date.now());
    return { channel: 'demo_inbox' };
  }
  const url = process.env.MAIL_WEBHOOK_URL;
  if (!url) {
    log.error('notifier.not_configured', { hint: '设置 MAIL_WEBHOOK_URL 或开启 DEMO_MODE' });
    throw new AppError(503, 'MAIL_UNAVAILABLE', '验证码发送服务暂不可用，请稍后重试');
  }
  try {
    await withRetry(async () => {
      const r = await withTimeout(() => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: email, template: 'verification_code', purpose, code }),
        signal: AbortSignal.timeout(TIMEOUT_MS + 500),
      }), TIMEOUT_MS, '邮件服务');
      if (!r.ok) { const e = new Error('mail webhook HTTP ' + r.status); e.status = r.status; throw e; }
    }, { retries: 2, baseMs: 200, label: 'mail.send', retryOn: (e) => !e.status || e.status >= 500 || e.status === 429 });
  } catch (e) {
    log.error('notifier.failed', { err: e, email_domain: email.split('@')[1] });
    throw new AppError(503, 'MAIL_UNAVAILABLE', '验证码发送失败，请稍后重试');
  }
  return { channel: 'email' };
}

module.exports = { deliverCode };
