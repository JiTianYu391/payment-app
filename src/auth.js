// 鉴权中间件（server.js 与投资模块共用同一套，避免两份实现逐渐不一致）。
'use strict';

const { sendError } = require('./errors');
const rbac = require('./rbac');

function createAuth({ db, sec, audit }) {
  function auth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.cookies && req.cookies.session) || '';
    if (!token) return sendError(req, res, 401, 'UNAUTHENTICATED', '未登录');
    const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sec.hashToken(token), Date.now());
    if (!row) return sendError(req, res, 401, 'SESSION_EXPIRED', '会话已过期，请重新登录');
    const user = db.prepare('SELECT id, email, nickname, risk_level, risk_score, role, status, frozen_reason, pin_hash IS NOT NULL AS has_pin, created_at FROM users WHERE id = ?').get(row.user_id);
    if (!user) return sendError(req, res, 401, 'USER_NOT_FOUND', '用户不存在');
    user.role = user.role || 'customer';
    user.status = user.status || 'ACTIVE';
    user.permissions = rbac.permsOf(user.role);
    req.user = user;
    req.sessionId = row.id;
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
    const row = db.prepare('SELECT pin_salt, pin_hash FROM users WHERE id = ?').get(req.user.id);
    if (!row || !row.pin_hash) return sendError(req, res, 400, 'PIN_NOT_SET', '请先在安全中心设置支付 PIN');
    if (!sec.verifyPin(pin, row.pin_salt, row.pin_hash)) {
      audit(req.user.id, req.user.email, 'pin_failed', '支付 PIN 验证失败', req.clientIp || '');
      return sendError(req, res, 403, 'PIN_INCORRECT', '支付 PIN 不正确');
    }
    return next();
  }

  return { auth, requireActive, requirePin, requirePerm: rbac.requirePerm };
}

module.exports = { createAuth };
