// 鉴权中间件（server.js、投资模块与商户后台共用同一套，避免多份实现逐渐不一致）。
'use strict';

const { sendError } = require('./errors');
const rbac = require('./rbac');

// PIN 失败锁定：6 位 PIN 只有 100 万种组合，必须限制尝试次数
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;
const SESSION_TOUCH_MS = 5 * 60 * 1000; // 最多每 5 分钟更新一次 last_seen_at，避免每请求写库

function createAuth({ db, sec, audit }) {
  function auth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.cookies && req.cookies.session) || '';
    if (!token) return sendError(req, res, 401, 'UNAUTHENTICATED', '未登录');
    const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sec.hashToken(token), Date.now());
    if (!row) return sendError(req, res, 401, 'SESSION_EXPIRED', '会话已过期，请重新登录');
    const user = db.prepare('SELECT id, email, nickname, risk_level, risk_score, role, status, frozen_reason, pin_hash IS NOT NULL AS has_pin, created_at FROM users WHERE id = ?').get(row.user_id);
    if (!user) return sendError(req, res, 401, 'USER_NOT_FOUND', '用户不存在');
    if (user.status === 'CLOSED') return sendError(req, res, 401, 'ACCOUNT_CLOSED', '账户已注销');
    user.role = user.role || 'customer';
    user.status = user.status || 'ACTIVE';
    user.permissions = rbac.permsOf(user.role);
    req.user = user;
    req.sessionId = row.id;
    if (!row.last_seen_at || Date.now() - row.last_seen_at > SESSION_TOUCH_MS) {
      try { db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(Date.now(), row.id); } catch (_) { /* 非关键 */ }
    }
    if (req.log) req.log = req.log.child({ user_id: user.id });
    return next();
  }

  // 冻结账户不能发起任何资金操作（仍可登录查看）
  function requireActive(req, res, next) {
    if (req.user && req.user.status === 'FROZEN') {
      return sendError(req, res, 423, 'ACCOUNT_FROZEN', '账户已冻结，暂不能进行资金操作。如有疑问请联系客服' + (req.user.frozen_reason ? `（原因：${req.user.frozen_reason}）` : ''));
    }
    return next();
  }

  function requirePin(req, res, next) {
    const pin = String((req.body && req.body.pin) || '');
    if (!sec.isValidPin(pin)) return sendError(req, res, 400, 'PIN_REQUIRED', '请输入 6 位支付 PIN');
    const row = db.prepare('SELECT pin_salt, pin_hash, pin_failed_attempts, pin_locked_until FROM users WHERE id = ?').get(req.user.id);
    if (!row || !row.pin_hash) return sendError(req, res, 400, 'PIN_NOT_SET', '请先在安全中心设置支付 PIN');
    const lockedUntil = row.pin_locked_until || 0;
    if (lockedUntil > Date.now()) {
      const mins = Math.ceil((lockedUntil - Date.now()) / 60000);
      return sendError(req, res, 423, 'PIN_LOCKED', `支付 PIN 错误次数过多，请 ${mins} 分钟后再试`);
    }
    if (!sec.verifyPin(pin, row.pin_salt, row.pin_hash)) {
      const fails = (row.pin_failed_attempts || 0) + 1;
      const lock = fails >= PIN_MAX_FAILS ? Date.now() + PIN_LOCK_MS : null;
      db.prepare('UPDATE users SET pin_failed_attempts = ?, pin_locked_until = ? WHERE id = ?').run(fails, lock, req.user.id);
      audit(req.user.id, req.user.email, 'pin_failed', `支付 PIN 验证失败 ${fails} 次` + (lock ? `，已锁定 ${PIN_LOCK_MS / 60000} 分钟` : ''), req.clientIp || '');
      if (lock) return sendError(req, res, 423, 'PIN_LOCKED', `支付 PIN 错误 ${PIN_MAX_FAILS} 次，已锁定 ${PIN_LOCK_MS / 60000} 分钟`);
      return sendError(req, res, 403, 'PIN_INCORRECT', `支付 PIN 不正确（还可尝试 ${PIN_MAX_FAILS - fails} 次）`);
    }
    if (row.pin_failed_attempts) db.prepare('UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?').run(req.user.id);
    return next();
  }

  return { auth, requireActive, requirePin, requirePerm: rbac.requirePerm, PIN_MAX_FAILS, PIN_LOCK_MS };
}

module.exports = { createAuth };
