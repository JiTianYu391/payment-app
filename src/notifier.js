// 邮件投递：验证码、安全提醒与交易通知。
// 传输方式按配置自动选择（优先级从高到低）：
//   1) SMTP：MAIL_SMTP_HOST / MAIL_SMTP_PORT / MAIL_SMTP_USER / MAIL_SMTP_PASS（QQ、Gmail、企业邮箱等）；
//   2) Webhook：POST 到 MAIL_WEBHOOK_URL（由部署方接入邮件服务）；
//   3) 演示收件箱：仅当以上二者都未配置且 DEMO_MODE=true 时使用，验证码只在应用内可见。
// 真实邮件通道一旦配置，应用内演示收件箱会自动关闭，避免任何人凭邮箱读取验证码。
'use strict';

const nodemailer = require('nodemailer');
const { withRetry, withTimeout } = require('./resilience');
const { AppError } = require('./errors');

const TIMEOUT_MS = parseInt(process.env.MAIL_TIMEOUT_MS || '5000', 10);

const SMTP = {
  host: process.env.MAIL_SMTP_HOST || '',
  port: parseInt(process.env.MAIL_SMTP_PORT || '465', 10),
  secure: String(process.env.MAIL_SMTP_SECURE || (String(process.env.MAIL_SMTP_PORT || '465') === '465' ? 'true' : 'false')) === 'true',
  user: process.env.MAIL_SMTP_USER || '',
  pass: process.env.MAIL_SMTP_PASS || '',
};
const MAIL_FROM = process.env.MAIL_FROM || (SMTP.user ? `SpacePay <${SMTP.user}>` : 'SpacePay <no-reply@spacepay.local>');

function mailMode() {
  if (SMTP.host && SMTP.user && SMTP.pass) return 'smtp';
  if (process.env.MAIL_WEBHOOK_URL) return 'webhook';
  if (String(process.env.DEMO_MODE || 'true') === 'true') return 'demo_inbox';
  return 'none';
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP.host,
      port: SMTP.port,
      secure: SMTP.secure,
      auth: { user: SMTP.user, pass: SMTP.pass },
      pool: true,
      maxConnections: 3,
      maxMessages: 50,
      connectionTimeout: TIMEOUT_MS + 5000,
      greetingTimeout: TIMEOUT_MS + 5000,
      socketTimeout: TIMEOUT_MS + 10000,
      tls: { minVersion: 'TLSv1.2' },
    });
  }
  return transporter;
}

// 启动时自检（不阻塞启动）：配置错误会在日志里立刻暴露，而不是等到第一个用户注册失败
function verifyMail() {
  if (mailMode() !== 'smtp') return Promise.resolve({ ok: mailMode() !== 'none', mode: mailMode() });
  return getTransporter().verify()
    .then(() => ({ ok: true, mode: 'smtp', host: SMTP.host }))
    .catch((e) => ({ ok: false, mode: 'smtp', host: SMTP.host, error: e.code || e.message }));
}

const PURPOSE_TEXT = {
  register: { subject: '注册验证码', intro: '你正在注册 SpacePay 账户，请在页面中输入下面的验证码。' },
  reset_password: { subject: '重置密码验证码', intro: '你正在重置 SpacePay 登录密码。如果这不是你本人的操作，请忽略本邮件并尽快修改密码。' },
};

function verificationEmail(code, purpose) {
  const p = PURPOSE_TEXT[purpose] || PURPOSE_TEXT.register;
  const subject = `SpacePay ${p.subject}：${code}`;
  const text = `${p.intro}\n\n验证码：${code}\n\n10 分钟内有效，最多尝试 5 次。\n\nSpacePay 不会通过任何渠道向你索要验证码、密码或支付 PIN。`;
  const html = `<!doctype html><html lang="zh-CN"><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#1a1f26">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 28px 24px;border:1px solid #e6e8ec">
    <div style="font-size:17px;font-weight:600;letter-spacing:.2px;margin-bottom:18px">SpacePay</div>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.7">${p.intro}</p>
    <div style="margin:0 0 16px;padding:16px;background:#f2f5ff;border-radius:10px;text-align:center;font-size:30px;letter-spacing:8px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${code}</div>
    <p style="margin:0 0 8px;font-size:13px;color:#5b6573">10 分钟内有效，最多尝试 5 次。</p>
    <p style="margin:0;font-size:13px;color:#5b6573">SpacePay 不会通过任何渠道向你索要验证码、密码或支付 PIN。</p>
    <hr style="border:0;border-top:1px solid #eceef2;margin:22px 0 14px">
    <p style="margin:0;font-size:12px;color:#8b95a3">本账户余额为虚拟资金，不构成任何投资建议。</p>
  </div></body></html>`;
  return { subject, text, html };
}

async function deliverCode({ db, demoMode, email, code, purpose, log }) {
  const mode = mailMode();
  if (mode === 'demo_inbox') {
    db.prepare('INSERT INTO demo_inbox (email, code, purpose, created_at) VALUES (?,?,?,?)').run(email, code, purpose, Date.now());
    return { channel: 'demo_inbox' };
  }
  if (mode === 'smtp') {
    const mail = verificationEmail(code, purpose);
    try {
      await withRetry(() => withTimeout(
        getTransporter().sendMail({ from: MAIL_FROM, to: email, subject: mail.subject, text: mail.text, html: mail.html }),
        TIMEOUT_MS + 10000, '邮件服务',
      ), { retries: 2, baseMs: 300, label: 'smtp.send', retryOn: (e) => !e.responseCode || e.responseCode >= 500 });
    } catch (e) {
      log.error('notifier.smtp_failed', { err: e, email_domain: email.split('@')[1] });
      throw new AppError(503, 'MAIL_UNAVAILABLE', '验证码发送失败，请稍后重试');
    }
    return { channel: 'smtp' };
  }
  if (mode === 'webhook') {
    const url = process.env.MAIL_WEBHOOK_URL;
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
      log.error('notifier.webhook_failed', { err: e, email_domain: email.split('@')[1] });
      throw new AppError(503, 'MAIL_UNAVAILABLE', '验证码发送失败，请稍后重试');
    }
    return { channel: 'email' };
  }
  log.error('notifier.not_configured', { hint: '配置 MAIL_SMTP_* 或 MAIL_WEBHOOK_URL' });
  throw new AppError(503, 'MAIL_UNAVAILABLE', '验证码发送服务暂不可用，请稍后重试');
}

// 非验证码类通知（交易、审核结果）。失败只记日志，不影响业务主流程。
async function sendNotification({ to, subject, text, html, log }) {
  const mode = mailMode();
  if (mode !== 'smtp' || !to) return { ok: false, mode, skipped: true };
  try {
    await getTransporter().sendMail({ from: MAIL_FROM, to, subject, text, html: html || undefined });
    return { ok: true, mode };
  } catch (e) {
    if (log) log.warn('notifier.notification_failed', { err: e, email_domain: String(to).split('@')[1] });
    return { ok: false, mode, error: e.message };
  }
}

module.exports = { deliverCode, sendNotification, verifyMail, mailMode };
