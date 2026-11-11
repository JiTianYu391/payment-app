// 关键操作二次确认（退款、冻结、提现申请与审核、付款、商户提现）。
// 第一次请求不带 confirm_token：服务端不执行，返回 428 + 操作摘要 + 一次性 confirm_token（5 分钟有效）。
// 前端展示摘要让操作人确认，第二次请求带上 confirm_token 才执行。
// 令牌用 HMAC 绑定（操作人, 动作, 参数摘要）；nonce 落库并以条件更新原子消费：
// 进程重启、多实例部署或重复提交都不能重放同一个令牌。
'use strict';

const crypto = require('crypto');
const { db } = require('./db');

const TTL_MS = 5 * 60 * 1000;
const SECRET = process.env.CONFIRM_SECRET || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function digest(params) {
  return crypto.createHash('sha256').update(JSON.stringify(params || {})).digest('hex').slice(0, 32);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}

function issue(actorId, action, params) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const exp = Date.now() + TTL_MS;
  db.prepare('INSERT INTO confirm_tokens (user_id, action, params_hash, nonce, expires_at, created_at) VALUES (?,?,?,?,?,?)')
    .run(actorId, action, digest(params), nonce, exp, Date.now());
  return sign({ a: action, u: actorId, h: digest(params), n: nonce, exp });
}

function verify(token, actorId, action, params) {
  if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'missing' };
  const [body, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return { ok: false, reason: 'signature' };
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return { ok: false, reason: 'format' }; }
  if (p.exp < Date.now()) return { ok: false, reason: 'expired' };
  if (p.a !== action || p.u !== actorId || p.h !== digest(params)) return { ok: false, reason: 'mismatch' };
  const row = db.prepare('SELECT id, used_at, expires_at FROM confirm_tokens WHERE nonce = ?').get(p.n);
  if (!row || row.expires_at < Date.now()) return { ok: false, reason: 'expired' };
  // 原子消费：并发两个相同请求只有一个能把 used_at 从 NULL 改掉
  const r = db.prepare('UPDATE confirm_tokens SET used_at = ? WHERE nonce = ? AND used_at IS NULL').run(Date.now(), p.n);
  if (!r.changes) return { ok: false, reason: 'used' };
  return { ok: true };
}

function purgeExpired() {
  return db.prepare('DELETE FROM confirm_tokens WHERE expires_at < ?').run(Date.now() - TTL_MS).changes;
}

const REASONS = { missing: '', signature: '确认凭证无效', format: '确认凭证无效', expired: '确认已超时，请重新确认', mismatch: '操作内容已变化，请重新确认', used: '该确认已使用，请重新发起' };

// 在路由里调用：返回 true 表示已确认可执行；返回 false 表示已发送 428 响应。
function requireConfirmation(req, res, { action, params, summary }) {
  const token = req.body && req.body.confirm_token;
  if (token) {
    const v = verify(token, req.user.id, action, params);
    if (v.ok) return true;
    if (v.reason !== 'missing') {
      res.status(409).json({ ok: false, code: 'CONFIRMATION_INVALID', error: REASONS[v.reason], request_id: req.id });
      return false;
    }
  }
  res.status(428).json({
    ok: false, code: 'CONFIRMATION_REQUIRED', requires_confirmation: true,
    error: '请确认操作内容后再提交', action, summary, confirm_token: issue(req.user.id, action, params),
    expires_in_seconds: TTL_MS / 1000, request_id: req.id,
  });
  return false;
}

module.exports = { issue, verify, requireConfirmation, purgeExpired, TTL_MS };
