/**
 * SpacePay 服务端入口（Express）。
 * 全部余额为虚拟资金，不接入真实支付渠道，提现为模拟出款。
 *
 * 结构：
 *   createApp()  组装中间件与路由，返回 { app, db, ... }，测试直接使用，不监听端口；
 *   直接运行本文件或 app.js 时调用 start() 监听 $PORT（FadeHost / PandaStack 注入）。
 *
 * 资金安全要点：
 *   - 金额一律为整数分（src/money.js），钱包变动只走 wallet.applyCash（条件扣款 + 流水 + 复式分录）；
 *   - 资金类 POST 支持 Idempotency-Key（src/idempotency.js）；
 *   - 退款 / 冻结 / 提现等关键操作需要二次确认（src/confirm.js，令牌落库、一次性）并写入操作日志（src/oplog.js）；
 *   - 密码 / PIN 使用 PBKDF2-SHA256；会话令牌只存哈希，httpOnly cookie 或 Bearer；
 *     登录与支付 PIN 都按失败次数锁定；支持 TOTP 两步验证与恢复码。
 */
'use strict';

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { db, audit, withTransaction, backend } = require('./db');
const sec = require('./security');
const logger = require('./logger');
const money = require('./money');
const v = require('./validate');
const wallet = require('./wallet');
const ledger = require('./ledger');
const metrics = require('./metrics');
const reports = require('./reports');
const rbac = require('./rbac');
const { createAuth } = require('./auth');
const { idempotent, purgeExpired } = require('./idempotency');
const { requireConfirmation, purgeExpired: purgeConfirmTokens } = require('./confirm');
const oplog = require('./oplog');
const notify = require('./notify');
const { deliverCode, mailMode, verifyMail } = require('./notifier');
const { requestTimeout, degrade } = require('./resilience');
const { AppError, badRequest, notFound, conflict, sendError, errorHandler } = require('./errors');

const DEMO_MODE = String(process.env.DEMO_MODE || 'true') === 'true';
const WELCOME_BONUS_CENTS = parseInt(process.env.WELCOME_BONUS_CENTS || '5000', 10);
const TOPUP_MAX_CENTS = parseInt(process.env.TOPUP_MAX_CENTS || '50000', 10);
const WITHDRAW_MAX_CENTS = parseInt(process.env.WITHDRAW_MAX_CENTS || '50000', 10);
const WITHDRAW_DAILY_COUNT = parseInt(process.env.WITHDRAW_DAILY_COUNT || '3', 10);
const WITHDRAW_DAILY_MAX_CENTS = parseInt(process.env.WITHDRAW_DAILY_MAX_CENTS || '100000', 10);
const WITHDRAW_MONTHLY_COUNT = parseInt(process.env.WITHDRAW_MONTHLY_COUNT || '10', 10);
const WITHDRAW_MONTHLY_MAX_CENTS = parseInt(process.env.WITHDRAW_MONTHLY_MAX_CENTS || '500000', 10);
const LOCK_MINUTES = 15;
const MAX_LOGIN_FAILS = 5;
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10);

const now = () => Date.now();
const fmt = (c) => money.formatCents(c);
// Express 4 不会捕获 async 处理函数的异常，统一包一层交给错误中间件
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 会话同时支持 httpOnly cookie（浏览器）与 Bearer（命令行 / 移动端）。
// Secure 跟随请求实际协议，避免本地 http 调试时 cookie 完全不生效。
const COOKIE_NAME = 'session';
function cookieOptions(req, maxAgeMs) {
  const https = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return { httpOnly: true, sameSite: 'lax', secure: https, path: '/', maxAge: maxAgeMs || SESSION_TTL_MS };
}
function setSessionCookie(req, res, token) { res.cookie(COOKIE_NAME, token, cookieOptions(req)); }
function clearSessionCookie(req, res) { res.clearCookie(COOKIE_NAME, { ...cookieOptions(req), maxAge: undefined }); }

function createApp() {
  const app = express();
  const { auth, requireActive, requirePin, requirePerm } = createAuth({ db, sec, audit });

  // ---------- 启动时数据维护 ----------
  const opened = ledger.backfillOpeningBalances(db, withTransaction);
  if (opened) logger.info('ledger.opening_balances_backfilled', { wallets: opened });
  const promoted = rbac.bootstrapAdmins(db);
  if (promoted) logger.info('rbac.admins_bootstrapped', { count: promoted });
  try { purgeExpired(db); } catch (e) { logger.warn('idempotency.purge_failed', { err: e }); }
  try { purgeConfirmTokens(); } catch (e) { logger.warn('confirm.purge_failed', { err: e }); }
  purgeSessions();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // 会话清理：过期会话会永久留在表里，启动时与每小时清理一次
  function purgeSessions() {
    try {
      const r = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
      if (r.changes) logger.info('sessions.purged', { count: r.changes });
    } catch (e) { logger.warn('sessions.purge_failed', { err: e }); }
  }

  // ---------- 请求编号 + 结构化访问日志 ----------
  app.use((req, res, next) => {
    const incoming = String(req.get('X-Request-Id') || '');
    req.id = /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : 'req_' + crypto.randomBytes(8).toString('hex');
    req.clientIp = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    req.log = logger.child({ request_id: req.id });
    res.set('X-Request-Id', req.id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (!req.path.startsWith('/api/')) return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      // 428（等待二次确认）是正常流程，不算告警
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 && res.statusCode !== 428 ? 'warn' : 'info';
      req.log[level]('http.request', { method: req.method, path: req.path, status: res.statusCode, duration_ms: Math.round(ms), user_id: req.user ? req.user.id : undefined, ip: req.clientIp });
    });
    next();
  });

  // CSP：前端是自包含的静态资源，不加载任何外部脚本 / 样式。
  // 页面使用内联事件属性（onclick），所以 script-src 仍需 'unsafe-inline'；
  // 其余指令依然能阻止外部脚本注入、插件、被 iframe 嵌套与 base 标签劫持。
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", "'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'manifest-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': [],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));
  // CORS：只允许显式白名单；未配置时不发任何跨域许可（同源访问不需要 CORS）
  const allowedOrigins = String(process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed', 'Content-Disposition'],
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const limitMax = parseInt(process.env.RATE_LIMIT_MAX || '300', 10);
  const authLimitMax = parseInt(process.env.AUTH_RATE_LIMIT_MAX || '50', 10);
  const limited = (max) => rateLimit({
    windowMs: 15 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => sendError(req, res, 429, 'RATE_LIMITED', '请求过于频繁，请稍后再试'),
  });
  app.use('/api/', limited(limitMax));
  app.use('/api/auth/', limited(authLimitMax));
  app.use('/api/', requestTimeout(REQUEST_TIMEOUT_MS));

  // ---------- 投资模块（模拟） ----------
  const invest = require('./invest')(app, { db, audit, withTransaction, sec, authz: { auth, requireActive, requirePin } });

  // ---------- 商户开放平台（/api/v1、/api/merchant、/api/checkout） ----------
  const merchant = require('./merchant')(app, { db, withTransaction, sec, auth, requireActive, requirePin, requirePerm });

  // ---------- 健康检查（含降级状态） ----------
  app.get('/api/health', (req, res) => {
    const dbCheck = degrade('db', () => { db.prepare('SELECT COUNT(*) AS c FROM users').get(); return { ok: true, backend }; }, (e) => ({ ok: false, backend, error: e.message }), req.log);
    const inv = degrade('invest', () => invest.status(), (e) => ({ ok: false, error: e.message }), req.log);
    const degraded = !dbCheck.value.ok || inv.degraded || (inv.value && inv.value.last_tick_error);
    res.status(dbCheck.value.ok ? 200 : 503).json({
      ok: dbCheck.value.ok, status: degraded ? 'degraded' : 'ok', service: 'SpacePay', demo: DEMO_MODE, mail: mailMode(),
      welcome_bonus_cents: WELCOME_BONUS_CENTS, time: new Date().toISOString(),
      components: { db: dbCheck.value, invest: inv.value }, invest: inv.value,
    });
  });

  // ---------- Prometheus 指标（可选 Bearer 保护） ----------
  app.get('/metrics', (req, res) => {
    const token = process.env.METRICS_TOKEN;
    if (token && String(req.headers.authorization || '') !== 'Bearer ' + token) {
      return sendError(req, res, 401, 'UNAUTHENTICATED', '未授权');
    }
    const lines = [];
    const metric = (name, help, type, rows) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of rows) lines.push(`${name}${labels ? '{' + labels + '}' : ''} ${value}`);
    };
    try {
      metric('spacepay_up', '服务是否可用', 'gauge', [['', 1]]);
      metric('spacepay_process_uptime_seconds', '进程运行秒数', 'gauge', [['', Math.round(process.uptime())]]);
      metric('spacepay_process_resident_memory_bytes', '常驻内存（字节）', 'gauge', [['', process.memoryUsage().rss]]);
      metric('spacepay_users', '按账户状态统计的用户数', 'gauge',
        db.prepare('SELECT status, COUNT(*) AS c FROM users GROUP BY status').all().map((r) => [`status="${r.status || 'ACTIVE'}"`, r.c]));
      metric('spacepay_wallet_balance_cents_total', '全部用户钱包余额（分）', 'gauge', [['', db.prepare('SELECT SUM(balance_cents) AS s FROM wallets').get().s || 0]]);
      metric('spacepay_transactions', '按类型统计的流水笔数', 'counter',
        db.prepare('SELECT type, COUNT(*) AS c FROM transactions GROUP BY type').all().map((r) => [`type="${r.type}"`, r.c]));
      metric('spacepay_withdrawals_pending', '待审核提现笔数', 'gauge', [['', db.prepare("SELECT COUNT(*) AS c FROM withdrawals WHERE status = 'PENDING'").get().c]]);
      metric('spacepay_withdrawals_pending_cents', '待审核提现金额（分）', 'gauge', [['', db.prepare("SELECT SUM(amount_cents) AS s FROM withdrawals WHERE status = 'PENDING'").get().s || 0]]);
      metric('spacepay_sessions_active', '未过期会话数', 'gauge', [['', db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE expires_at > ?').get(now()).c]]);
      metric('spacepay_merchants', '按状态统计的商户数', 'gauge',
        db.prepare('SELECT status, COUNT(*) AS c FROM merchants GROUP BY status').all().map((r) => [`status="${r.status}"`, r.c]));
      metric('spacepay_merchant_payable_cents', '商户待结算余额合计（分）', 'gauge', [['', ledger.accountBalance(db, 'merchant:payable')]]);
      metric('spacepay_webhook_deliveries', '按状态统计的 Webhook 投递数', 'gauge',
        db.prepare('SELECT status, COUNT(*) AS c FROM webhook_deliveries GROUP BY status').all().map((r) => [`status="${r.status}"`, r.c]));
    } catch (e) {
      logger.warn('metrics.render_failed', { err: e });
      lines.push('# metrics unavailable');
    }
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n') + '\n');
  });

  // ---------- 验证码 ----------
  app.post('/api/auth/request-code', ah(async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const purpose = String((req.body && req.body.purpose) || 'register');
    if (!sec.isValidEmail(email)) throw badRequest('EMAIL_INVALID', '邮箱格式不正确');
    if (!['register', 'reset_password'].includes(purpose)) throw badRequest('PURPOSE_INVALID', '用途不正确');
    const recent = db.prepare('SELECT created_at FROM verification_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(email);
    if (recent && now() - recent.created_at < 60 * 1000) return sendError(req, res, 429, 'CODE_TOO_FREQUENT', '验证码发送太频繁，请 1 分钟后再试');
    const code = sec.generateCode();
    const ins = db.prepare('INSERT INTO verification_codes (email, code_hash, purpose, expires_at, created_at) VALUES (?,?,?,?,?)')
      .run(email, sec.hashCode(code), purpose, now() + CODE_TTL_MS, now());
    try {
      await deliverCode({ db, demoMode: DEMO_MODE, email, code, purpose, log: req.log });
    } catch (e) {
      db.prepare('DELETE FROM verification_codes WHERE id = ?').run(ins.lastInsertRowid); // 发送失败不占用 1 分钟频控
      throw e;
    }
    const demoInbox = mailMode() === 'demo_inbox';
    return res.json({ ok: true, demo: demoInbox, message: demoInbox ? '验证码已发送到应用内收件箱' : '验证码已发送到邮箱，请查收' });
  }));

  app.get('/api/demo-inbox', (req, res) => {
    // 配置了真实邮件通道后必须关闭：否则任何人凭邮箱就能读到验证码
    if (!DEMO_MODE || mailMode() !== 'demo_inbox') return sendError(req, res, 404, 'NOT_FOUND', '应用内收件箱未开启');
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!sec.isValidEmail(email)) return sendError(req, res, 400, 'EMAIL_INVALID', '邮箱格式不正确');
    const rows = db.prepare('SELECT code, purpose, created_at FROM demo_inbox WHERE email = ? ORDER BY id DESC LIMIT 5').all(email);
    return res.json({ ok: true, demo: true, notice: '验证码仅显示在此收件箱，不会发送真实邮件', items: rows });
  });

  function verifyCode(email, code, purpose) {
    const row = db.prepare('SELECT * FROM verification_codes WHERE email = ? AND purpose = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1').get(email, purpose, now());
    if (!row) return { ok: false, error: '验证码不存在或已过期，请重新获取' };
    if (row.attempts >= CODE_MAX_ATTEMPTS) return { ok: false, error: '验证码尝试次数过多，请重新获取' };
    if (!sec.safeEqualHex(sec.hashCode(String(code)), row.code_hash)) {
      db.prepare('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      return { ok: false, error: '验证码不正确' };
    }
    db.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?').run(row.id);
    return { ok: true };
  }

  // ---------- 注册 ----------
  app.post('/api/auth/register', (req, res) => {
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const nickname = String(body.nickname || '').trim();
    const password = String(body.password || '');
    const code = String(body.code || '').trim();
    if (!sec.isValidEmail(email)) throw badRequest('EMAIL_INVALID', '邮箱格式不正确');
    if (!nickname || nickname.length > 30) throw badRequest('NICKNAME_INVALID', '昵称不能为空且不超过 30 字');
    if (password.length < 8) throw badRequest('PASSWORD_TOO_SHORT', '密码至少 8 位');
    if (!/^\d{6}$/.test(code)) throw badRequest('CODE_INVALID', '请输入 6 位验证码');
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) throw badRequest('EMAIL_TAKEN', '该邮箱已注册，请直接登录');
    const vc = verifyCode(email, code, 'register');
    if (!vc.ok) throw badRequest('CODE_REJECTED', vc.error);

    const { salt, hash } = sec.hashPassword(password);
    const userId = withTransaction(() => {
      const u = db.prepare('INSERT INTO users (email, nickname, password_salt, password_hash, created_at) VALUES (?,?,?,?,?)').run(email, nickname, salt, hash, now());
      db.prepare('INSERT INTO wallets (user_id, balance_cents, updated_at) VALUES (?,?,?)').run(u.lastInsertRowid, 0, now());
      if (WELCOME_BONUS_CENTS > 0) {
        wallet.applyCash(db, { userId: u.lastInsertRowid, delta: WELCOME_BONUS_CENTS, type: 'bonus', category: '体验金', description: `新用户体验金 ${fmt(WELCOME_BONUS_CENTS)}（虚拟资金）` });
      }
      return u.lastInsertRowid;
    });
    rbac.bootstrapAdmins(db, email);
    try { require('./products').backfillCashHistory(db, userId, WELCOME_BONUS_CENTS); } catch (e) { req.log.warn('register.backfill_failed', { err: e }); }
    audit(userId, email, 'register', `注册成功，体验金 ${fmt(WELCOME_BONUS_CENTS)}`, req.clientIp);
    return res.json({ ok: true, message: `注册成功，已到账 ${fmt(WELCOME_BONUS_CENTS)} 体验金（虚拟资金）` });
  });

  // ---------- 登录 ----------
  function verifyRecoveryCode(user, code) {
    let list = [];
    try { list = JSON.parse(user.totp_recovery_json || '[]'); } catch (_) { /* 损坏视为无恢复码 */ }
    if (!Array.isArray(list) || !list.length) return false;
    const h = sec.hashToken(sec.normalizeRecoveryCode(code));
    const idx = list.indexOf(h);
    if (idx === -1) return false;
    list.splice(idx, 1); // 一次性使用
    db.prepare('UPDATE users SET totp_recovery_json = ? WHERE id = ?').run(JSON.stringify(list), user.id);
    return true;
  }

  app.post('/api/auth/login', (req, res) => {
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const totpCode = String(body.totp_code || '').replace(/\s/g, '');
    const recoveryCode = String(body.recovery_code || '').trim();
    if (!sec.isValidEmail(email) || !password) return sendError(req, res, 400, 'CREDENTIALS_INVALID', '邮箱或密码不正确');
    rbac.bootstrapAdmins(db, email);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return sendError(req, res, 401, 'CREDENTIALS_INVALID', '邮箱或密码不正确');
    if (user.status === 'CLOSED') return sendError(req, res, 403, 'ACCOUNT_CLOSED', '该账户已注销');
    if (user.locked_until && user.locked_until > now()) {
      const mins = Math.ceil((user.locked_until - now()) / 60000);
      return sendError(req, res, 423, 'LOGIN_LOCKED', `账户已锁定，请 ${mins} 分钟后再试`);
    }
    if (!sec.verifyPassword(password, user.password_salt, user.password_hash)) {
      const fails = (user.failed_login_attempts || 0) + 1;
      const lockedUntil = fails >= MAX_LOGIN_FAILS ? now() + LOCK_MINUTES * 60 * 1000 : null;
      db.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?').run(fails, lockedUntil, user.id);
      audit(user.id, email, 'login_failed', `登录失败 ${fails} 次`, req.clientIp);
      if (lockedUntil) return sendError(req, res, 423, 'LOGIN_LOCKED', `密码错误 ${MAX_LOGIN_FAILS} 次，账户已锁定 ${LOCK_MINUTES} 分钟`);
      return sendError(req, res, 401, 'CREDENTIALS_INVALID', `邮箱或密码不正确（已失败 ${fails} 次，${MAX_LOGIN_FAILS} 次锁定）`);
    }
    // 第二步验证：已开启 TOTP 的账户必须提供动态码或一个未使用的恢复码
    if (user.totp_enabled) {
      if (!totpCode && !recoveryCode) {
        return sendError(req, res, 401, 'TOTP_REQUIRED', '请输入身份验证器中的 6 位动态码');
      }
      const ok = recoveryCode ? verifyRecoveryCode(user, recoveryCode) : sec.verifyTotp(user.totp_secret, totpCode);
      if (!ok) {
        const fails = (user.failed_login_attempts || 0) + 1;
        const lockedUntil = fails >= MAX_LOGIN_FAILS ? now() + LOCK_MINUTES * 60 * 1000 : null;
        db.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?').run(fails, lockedUntil, user.id);
        audit(user.id, email, 'totp_failed', '两步验证失败', req.clientIp);
        if (lockedUntil) return sendError(req, res, 423, 'LOGIN_LOCKED', `两步验证失败 ${MAX_LOGIN_FAILS} 次，账户已锁定 ${LOCK_MINUTES} 分钟`);
        return sendError(req, res, 401, 'TOTP_INVALID', '动态码或恢复码不正确');
      }
    }
    const token = sec.generateToken();
    db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(now(), user.id);
    db.prepare('INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent, last_seen_at, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(user.id, sec.hashToken(token), now() + SESSION_TTL_MS, req.clientIp, String(req.headers['user-agent'] || '').slice(0, 200), now(), now());
    setSessionCookie(req, res, token);
    audit(user.id, email, 'login', '登录成功', req.clientIp);
    const role = user.role || 'customer';
    return res.json({ ok: true, token, user: { id: user.id, email: user.email, nickname: user.nickname, has_pin: !!user.pin_hash, totp_enabled: !!user.totp_enabled, role, status: user.status || 'ACTIVE', permissions: rbac.permsOf(role) } });
  });

  app.post('/api/auth/logout', auth, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(req.sessionId);
    clearSessionCookie(req, res);
    audit(req.user.id, req.user.email, 'logout', '退出登录', req.clientIp);
    res.json({ ok: true });
  });

  // ---------- 找回密码 ----------
  // 验证码复用 request-code（purpose=reset_password）；重置成功后注销全部会话。
  app.post('/api/auth/reset-password', (req, res) => {
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim();
    const newPassword = String(body.new_password || '');
    if (!sec.isValidEmail(email)) throw badRequest('EMAIL_INVALID', '邮箱格式不正确');
    if (!/^\d{6}$/.test(code)) throw badRequest('CODE_INVALID', '请输入 6 位验证码');
    if (newPassword.length < 8) throw badRequest('PASSWORD_TOO_SHORT', '新密码至少 8 位');
    // 无论邮箱是否存在都校验并消耗验证码，避免通过响应枚举账户
    const vc = verifyCode(email, code, 'reset_password');
    if (!vc.ok) throw badRequest('CODE_REJECTED', vc.error);
    const user = db.prepare('SELECT id, email, status FROM users WHERE email = ?').get(email);
    if (!user || user.status === 'CLOSED') throw badRequest('RESET_FAILED', '邮箱或验证码不正确');
    const { salt, hash } = sec.hashPassword(newPassword);
    withTransaction(() => {
      db.prepare('UPDATE users SET password_salt = ?, password_hash = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(salt, hash, user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    });
    audit(user.id, user.email, 'reset_password', '通过邮箱验证码重置登录密码，已注销全部会话', req.clientIp);
    notify.email(db, user.id, 'SpacePay 密码已重置', '你的 SpacePay 登录密码刚刚被重置，所有设备已退出登录。如果不是你本人操作，请立即使用「找回密码」重新设置并联系支持。', req.log);
    res.json({ ok: true, message: '密码已重置，请用新密码登录' });
  });

  // ---------- 钱包 / 统计 ----------
  app.get('/api/wallet', auth, (req, res) => {
    const bal = wallet.balanceOf(db, req.user.id);
    res.json({ ok: true, balance_cents: bal, balance: money.centsToDecimal(bal), currency: 'USD', virtual: true, notice: '虚拟资金；提现为模拟出款，不会到达真实银行账户' });
  });

  // 收支统计：口径见 metrics.DEFINITIONS；可选 from / to（不传 = 全部历史）
  app.get('/api/stats', auth, (req, res) => {
    const from = v.dateMs(req.query.from, '开始日期', false);
    const to = v.dateMs(req.query.to, '结束日期', true);
    const rows = db.prepare('SELECT type, category, amount_cents, created_at FROM transactions WHERE user_id = ?').all(req.user.id)
      .filter((r) => (from === null || r.created_at >= from) && (to === null || r.created_at <= to));
    const s = metrics.summarize(rows);
    const byCategory = {};
    for (const r of rows) {
      if (!metrics.OUTFLOW_TYPES.includes(r.type)) continue;
      const key = r.category || '其他';
      byCategory[key] = (byCategory[key] || 0) + r.amount_cents;
    }
    const recent = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5').all(req.user.id);
    res.json({
      ok: true, income_cents: s.inflow_cents, expense_cents: s.outflow_cents, net_flow_cents: s.net_flow_cents,
      investment_net_cents: s.investment_net_cents, investment_income_cents: s.investment_income_cents,
      by_category: byCategory, recent, period: { from, to, label: metrics.periodLabel(from, to) }, definitions: metrics.DEFINITIONS,
    });
  });

  // ---------- 账单：多维筛选 + 排序 + 分页（兼容旧参数 type/category/q/from/to/limit/offset） ----------
  app.get('/api/transactions', auth, (req, res) => {
    const f = reports.parseFilters(req.query);
    const paging = reports.parsePaging(req.query);
    const legacy = req.query.limit !== undefined || req.query.offset !== undefined;
    const opts = { scopeUserId: req.user.id };
    if (legacy && req.query.page === undefined) {
      opts.limit = v.intInRange(req.query.limit, { min: 1, max: 200, def: 50, label: 'limit' });
      opts.offset = v.intInRange(req.query.offset, { min: 0, max: 1e9, def: 0, label: 'offset' });
    } else if (req.query.page_size === undefined && req.query.page === undefined) {
      opts.limit = 50; opts.offset = 0; // 旧版默认值：最近 50 条
    }
    const r = reports.query(db, backend, f, paging, opts);
    const total = db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?').get(req.user.id).c;
    res.json({
      ok: true, total, items: r.items, filtered_total: r.filtered_total, summary: r.summary,
      page: paging.page, page_size: opts.limit || paging.pageSize, sort: paging.sort, order: paging.order,
      period: { from: f.from, to: f.to, label: metrics.periodLabel(f.from, f.to) },
    });
  });

  app.get('/api/transactions/export', auth, (req, res) => {
    const f = reports.parseFilters(req.query);
    const paging = reports.parsePaging(req.query);
    const format = v.oneOf(String(req.query.format || 'csv'), ['csv', 'xlsx'], '导出格式');
    const out = reports.buildExport(db, backend, f, paging, { format, scopeUserId: req.user.id, includeUser: false });
    audit(req.user.id, req.user.email, 'export', `导出交易 ${out.count} 笔（${format.toUpperCase()}）`, req.clientIp);
    res.set('Content-Type', out.contentType);
    res.set('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.body);
  });

  // ---------- 转账 ----------
  app.post('/api/transfer', auth, requireActive, requirePin, idempotent(db, 'transfer'), (req, res) => {
    const toEmail = v.str(req.body, 'to_email', { required: true, label: '收款邮箱', max: 120 }).toLowerCase();
    if (!sec.isValidEmail(toEmail)) throw badRequest('EMAIL_INVALID', '收款邮箱格式不正确');
    const amountCents = v.amount(req.body, 'amount', { label: '转账金额' });
    const note = v.str(req.body, 'note', { max: 100, label: '备注' });
    if (toEmail === req.user.email) throw badRequest('TRANSFER_TO_SELF', '不能给自己转账');
    const recipient = db.prepare('SELECT id, email, status FROM users WHERE email = ?').get(toEmail);
    if (!recipient) throw new AppError(404, 'RECIPIENT_NOT_FOUND', '收款方不存在，请确认邮箱');
    if (recipient.status === 'FROZEN') throw badRequest('RECIPIENT_UNAVAILABLE', '收款账户暂不可收款');
    const result = withTransaction(() => {
      const out = wallet.applyCash(db, { userId: req.user.id, delta: -amountCents, type: 'transfer_out', counterparty: toEmail, category: '转账', description: note || `转账给 ${toEmail}` });
      const inn = wallet.applyCash(db, { userId: recipient.id, delta: amountCents, type: 'transfer_in', counterparty: req.user.email, category: '转账', description: note || `来自 ${req.user.email} 的转账` });
      return { out, inn };
    });
    audit(req.user.id, req.user.email, 'transfer', `转账 ${fmt(amountCents)} 给 ${toEmail}`, req.clientIp);
    notify.push(db, { userId: recipient.id, kind: 'transfer', title: `收到转账 ${fmt(amountCents)}`, body: `来自 ${req.user.email}${note ? '：' + note : ''}`, refType: 'transaction', refId: result.inn.transactionId });
    res.json({ ok: true, message: '转账成功', balance_cents: result.out.balance, transaction_id: result.out.transactionId });
  });

  // ---------- 商户付款 / 缴费 ----------
  app.post('/api/pay', auth, requireActive, requirePin, idempotent(db, 'pay'), (req, res) => {
    const merchant = v.str(req.body, 'merchant', { required: true, max: 80, label: '商户名称' });
    const category = v.str(req.body, 'category', { max: 30, label: '分类', default: '购物' }) || '购物';
    const amountCents = v.amount(req.body, 'amount', { label: '付款金额' });
    const note = v.str(req.body, 'note', { max: 100, label: '备注' });
    const r = withTransaction(() => {
      const p = db.prepare('INSERT INTO payments (user_id, merchant, category, amount_cents, refunded_cents, currency, status, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(req.user.id, merchant, category, amountCents, 0, 'USD', 'SUCCEEDED', note || null, now(), now());
      const mv = wallet.applyCash(db, { userId: req.user.id, delta: -amountCents, type: 'pay', merchant, category, description: note || `向 ${merchant} 付款`, refType: 'payment', refId: p.lastInsertRowid });
      db.prepare('UPDATE payments SET transaction_id = ? WHERE id = ?').run(mv.transactionId, p.lastInsertRowid);
      return { paymentId: p.lastInsertRowid, ...mv };
    });
    audit(req.user.id, req.user.email, 'pay', `向 ${merchant} 付款 ${fmt(amountCents)}（${category}）`, req.clientIp);
    res.json({ ok: true, message: '付款成功', balance_cents: r.balance, payment_id: r.paymentId, transaction_id: r.transactionId });
  });

  app.get('/api/payments', auth, (req, res) => {
    const items = db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
    res.json({ ok: true, items: items.map((p) => ({ ...p, refundable_cents: p.amount_cents - p.refunded_cents })) });
  });

  // ---------- 退款申请（用户发起，财务审核） ----------
  app.post('/api/payments/:id/refund-requests', auth, requireActive, idempotent(db, 'refund_request'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('ID_INVALID', '支付编号格式不正确');
    const p = db.prepare('SELECT * FROM payments WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!p) throw notFound('PAYMENT_NOT_FOUND', '支付记录不存在');
    if (!['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(p.status)) throw badRequest('PAYMENT_NOT_REFUNDABLE', '该支付当前不能申请退款');
    const remaining = p.amount_cents - p.refunded_cents;
    if (remaining <= 0) throw badRequest('ALREADY_REFUNDED', '该支付已全额退款');
    const pending = db.prepare("SELECT id FROM refund_requests WHERE payment_id = ? AND user_id = ? AND status = 'PENDING'").get(id, req.user.id);
    if (pending) throw conflict('REFUND_REQUEST_PENDING', '该支付已有待审核的退款申请，请等待处理');
    const reason = v.str(req.body, 'reason', { required: true, min: 2, max: 200, label: '退款原因' });
    const amountCents = req.body && req.body.amount !== undefined && req.body.amount !== '' ? v.amount(req.body, 'amount', { label: '退款金额', max: remaining }) : remaining;
    if (amountCents > remaining) throw badRequest('REFUND_EXCEEDS_REMAINING', `退款金额超过可退余额：最多可退 ${fmt(remaining)}`);
    const r = db.prepare('INSERT INTO refund_requests (payment_id, user_id, amount_cents, reason, status, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, req.user.id, amountCents, reason, 'PENDING', now());
    audit(req.user.id, req.user.email, 'refund_request', `对支付 #${id} 申请退款 ${fmt(amountCents)}：${reason}`, req.clientIp);
    const admins = db.prepare("SELECT id FROM users WHERE role IN ('admin','finance')").all();
    for (const a of admins) notify.push(db, { userId: a.id, kind: 'refund_request', title: '新的退款申请', body: `${req.user.email}：${reason}`, refType: 'refund_request', refId: r.lastInsertRowid });
    res.status(201).json({ ok: true, message: '退款申请已提交，等待审核', refund_request_id: r.lastInsertRowid, amount_cents: amountCents });
  });

  app.get('/api/refund-requests', auth, (req, res) => {
    const items = db.prepare('SELECT * FROM refund_requests WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
    res.json({ ok: true, items });
  });

  // ---------- 通知中心 ----------
  app.get('/api/notifications', auth, (req, res) => {
    const limit = v.intInRange(req.query.limit, { min: 1, max: 100, def: 30, label: '条数' });
    const items = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(req.user.id, limit);
    res.json({ ok: true, items, unread: notify.unreadCount(db, req.user.id) });
  });

  app.post('/api/notifications/:id/read', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('ID_INVALID', '通知编号格式不正确');
    const r = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(now(), id, req.user.id);
    res.json({ ok: true, updated: r.changes, unread: notify.unreadCount(db, req.user.id) });
  });

  app.post('/api/notifications/read-all', auth, (req, res) => {
    const r = db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), req.user.id);
    res.json({ ok: true, updated: r.changes, unread: 0 });
  });

  // ---------- 注销账户 ----------
  // 余额必须为 0、没有待审核提现。账户状态改为 CLOSED，会话全部失效；账本记录保留以满足审计。
  app.post('/api/account/close', auth, (req, res) => {
    const password = String((req.body && req.body.password) || '');
    const row = db.prepare('SELECT password_salt, password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!sec.verifyPassword(password, row.password_salt, row.password_hash)) return sendError(req, res, 403, 'PASSWORD_INCORRECT', '登录密码不正确');
    const bal = wallet.balanceOf(db, req.user.id);
    if (bal !== 0) throw badRequest('BALANCE_NOT_ZERO', `注销前请先转出或提现全部余额（当前 ${fmt(bal)}）`);
    const pendingWd = db.prepare("SELECT COUNT(*) AS c FROM withdrawals WHERE user_id = ? AND status = 'PENDING'").get(req.user.id).c;
    if (pendingWd > 0) throw badRequest('PENDING_WITHDRAWAL', '还有待审核的提现，请先撤销或等待处理');
    if (!requireConfirmation(req, res, {
      action: 'account.close', params: { id: req.user.id },
      summary: { title: '确认注销账户', lines: [['账户', req.user.email], ['余额', fmt(bal)], ['影响', '注销后无法登录，所有会话立即失效；交易与账本记录按法规保留']] },
    })) return;
    withTransaction(() => {
      db.prepare("UPDATE users SET status = 'CLOSED', closed_at = ? WHERE id = ?").run(now(), req.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
      // 账户注销后其商户不能再收款或结算，交由运营复核
      db.prepare("UPDATE merchants SET status = 'SUSPENDED', updated_at = ? WHERE owner_user_id = ? AND status = 'ACTIVE'").run(now(), req.user.id);
    });
    clearSessionCookie(req, res);
    audit(req.user.id, req.user.email, 'account_closed', '账户已注销', req.clientIp);
    res.json({ ok: true, message: '账户已注销' });
  });

  // ---------- 充值（虚拟资金） ----------
  app.post('/api/topup', auth, requireActive, idempotent(db, 'topup'), (req, res) => {
    const amountCents = v.amount(req.body, 'amount', { label: '充值金额', max: Math.max(TOPUP_MAX_CENTS, 1) });
    const mv = withTransaction(() => wallet.applyCash(db, { userId: req.user.id, delta: amountCents, type: 'topup', category: '充值', description: '充值（虚拟资金）' }));
    audit(req.user.id, req.user.email, 'topup', `充值 ${fmt(amountCents)}（虚拟资金）`, req.clientIp);
    res.json({ ok: true, message: '充值成功（虚拟资金）', balance_cents: mv.balance, transaction_id: mv.transactionId });
  });

  // ---------- 提现（模拟出款，需财务审核） ----------
  app.get('/api/withdrawals', auth, (req, res) => {
    const items = db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
    res.json({ ok: true, items });
  });

  // 提现限额：按最近 24 小时 / 30 天统计（被驳回的不计入，因为资金已退回）
  function withdrawalUsage(userId) {
    const since30 = now() - 30 * 24 * 3600 * 1000;
    const since1 = now() - 24 * 3600 * 1000;
    const rows = db.prepare('SELECT amount_cents, status, created_at FROM withdrawals WHERE user_id = ?').all(userId)
      .filter((w) => w.status !== 'FAILED' && w.created_at >= since30);
    const day = rows.filter((w) => w.created_at >= since1);
    return {
      day_count: day.length, day_cents: day.reduce((s, w) => s + w.amount_cents, 0),
      month_count: rows.length, month_cents: rows.reduce((s, w) => s + w.amount_cents, 0),
    };
  }
  app.get('/api/withdrawals/limits', auth, (req, res) => {
    res.json({
      ok: true, usage: withdrawalUsage(req.user.id),
      limits: {
        per_request_cents: WITHDRAW_MAX_CENTS,
        daily_count: WITHDRAW_DAILY_COUNT, daily_cents: WITHDRAW_DAILY_MAX_CENTS,
        monthly_count: WITHDRAW_MONTHLY_COUNT, monthly_cents: WITHDRAW_MONTHLY_MAX_CENTS,
      },
    });
  });

  app.post('/api/withdrawals', auth, requireActive, requirePin, idempotent(db, 'withdrawal'), (req, res) => {
    const amountCents = v.amount(req.body, 'amount', { label: '提现金额', max: WITHDRAW_MAX_CENTS });
    const destination = v.str(req.body, 'destination', { required: true, label: '收款银行卡尾号', pattern: /^\d{4}$/, message: '收款银行卡尾号应为 4 位数字' });
    const bal = wallet.balanceOf(db, req.user.id);
    if (bal < amountCents) throw new AppError(400, 'INSUFFICIENT_FUNDS', `余额不足：还差 ${fmt(amountCents - bal)}`, { shortfall_cents: amountCents - bal });
    const usage = withdrawalUsage(req.user.id);
    if (usage.day_count >= WITHDRAW_DAILY_COUNT) throw new AppError(429, 'WITHDRAW_DAILY_COUNT', `24 小时内提现已达 ${WITHDRAW_DAILY_COUNT} 笔上限`);
    if (usage.day_cents + amountCents > WITHDRAW_DAILY_MAX_CENTS) throw new AppError(429, 'WITHDRAW_DAILY_AMOUNT', `24 小时内提现总额不能超过 ${fmt(WITHDRAW_DAILY_MAX_CENTS)}`);
    if (usage.month_count >= WITHDRAW_MONTHLY_COUNT) throw new AppError(429, 'WITHDRAW_MONTHLY_COUNT', `30 天内提现已达 ${WITHDRAW_MONTHLY_COUNT} 笔上限`);
    if (usage.month_cents + amountCents > WITHDRAW_MONTHLY_MAX_CENTS) throw new AppError(429, 'WITHDRAW_MONTHLY_AMOUNT', `30 天内提现总额不能超过 ${fmt(WITHDRAW_MONTHLY_MAX_CENTS)}`);
    const params = { amount_cents: amountCents, destination };
    if (!requireConfirmation(req, res, {
      action: 'withdrawal.create', params,
      summary: { title: '确认提现', lines: [['提现金额', fmt(amountCents)], ['收款账户', `尾号 ${destination}`], ['到账方式', '模拟出款，需财务审核'], ['提现后余额', fmt(bal - amountCents)]] },
    })) return;
    const r = withTransaction(() => {
      const w = db.prepare('INSERT INTO withdrawals (user_id, amount_cents, destination, status, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run(req.user.id, amountCents, destination, 'PENDING', now(), now());
      const mv = wallet.applyCash(db, { userId: req.user.id, delta: -amountCents, type: 'withdrawal', status: 'PENDING', category: '提现', description: `提现到尾号 ${destination}（待审核）`, refType: 'withdrawal', refId: w.lastInsertRowid });
      db.prepare('UPDATE withdrawals SET transaction_id = ? WHERE id = ?').run(mv.transactionId, w.lastInsertRowid);
      return { id: w.lastInsertRowid, ...mv };
    });
    oplog.record(db, req, { action: 'withdrawal.create', target_type: 'withdrawal', target_id: r.id, amount_cents: amountCents });
    audit(req.user.id, req.user.email, 'withdrawal', `申请提现 ${fmt(amountCents)} 到尾号 ${destination}`, req.clientIp);
    notify.push(db, { userId: req.user.id, kind: 'withdrawal', title: `提现申请已提交 ${fmt(amountCents)}`, body: '等待财务审核', refType: 'withdrawal', refId: r.id });
    res.json({ ok: true, message: '提现申请已提交，等待审核', withdrawal_id: r.id, status: 'PENDING', balance_cents: r.balance });
  });

  // 用户撤销待审核提现：资金原路退回钱包
  app.post('/api/withdrawals/:id/cancel', auth, requireActive, idempotent(db, 'withdrawal_cancel'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('ID_INVALID', '提现编号格式不正确');
    const w = db.prepare('SELECT * FROM withdrawals WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!w) throw notFound('WITHDRAWAL_NOT_FOUND', '提现申请不存在');
    if (w.status !== 'PENDING') throw new AppError(409, 'WITHDRAWAL_NOT_CANCELABLE', '只有待审核的提现可以撤销');
    if (!requireConfirmation(req, res, {
      action: 'withdrawal.cancel', params: { id },
      summary: { title: '确认撤销提现', lines: [['申请编号', `#${w.id}`], ['金额', fmt(w.amount_cents)], ['退回', '资金原路退回钱包余额']] },
    })) return;
    const mv = withTransaction(() => {
      const upd = db.prepare("UPDATE withdrawals SET status = 'FAILED', review_note = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'")
        .run('用户撤销', now(), now(), id);
      if (!upd.changes) throw new AppError(409, 'CONCURRENT_MODIFICATION', '该申请已被处理，请刷新后查看');
      if (w.transaction_id) db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('FAILED', w.transaction_id);
      return wallet.applyCash(db, { userId: req.user.id, delta: w.amount_cents, type: 'withdrawal_reversal', category: '提现', description: `提现 #${w.id} 已撤销，资金退回`, refType: 'withdrawal', refId: w.id });
    });
    oplog.record(db, req, { action: 'withdrawal.cancel', target_type: 'withdrawal', target_id: id, amount_cents: w.amount_cents });
    audit(req.user.id, req.user.email, 'withdrawal_cancel', `撤销提现 #${id} ${fmt(w.amount_cents)}`, req.clientIp);
    notify.push(db, { userId: req.user.id, kind: 'withdrawal', title: `提现已撤销 ${fmt(w.amount_cents)}`, body: '资金已退回钱包余额', refType: 'withdrawal', refId: id });
    res.json({ ok: true, message: '提现已撤销，资金已退回钱包', withdrawal_id: id, balance_cents: mv.balance });
  });

  // ---------- 安全中心 ----------
  app.post('/api/security/set-pin', auth, (req, res) => {
    const pin = String((req.body && req.body.pin) || '');
    const password = String((req.body && req.body.password) || '');
    if (!sec.isValidPin(pin)) throw badRequest('PIN_FORMAT', 'PIN 必须是 6 位数字');
    const row = db.prepare('SELECT password_salt, password_hash, pin_hash FROM users WHERE id = ?').get(req.user.id);
    if (!sec.verifyPassword(password, row.password_salt, row.password_hash)) return sendError(req, res, 403, 'PASSWORD_INCORRECT', '登录密码不正确');
    if (row.pin_hash) throw badRequest('PIN_ALREADY_SET', '已设置 PIN，请用修改 PIN');
    const { salt, hash } = sec.hashPin(pin);
    db.prepare('UPDATE users SET pin_salt = ?, pin_hash = ? WHERE id = ?').run(salt, hash, req.user.id);
    audit(req.user.id, req.user.email, 'set_pin', '设置支付 PIN', req.clientIp);
    res.json({ ok: true, message: '支付 PIN 设置成功' });
  });

  app.post('/api/security/change-pin', auth, (req, res) => {
    const oldPin = String((req.body && req.body.old_pin) || '');
    const newPin = String((req.body && req.body.new_pin) || '');
    if (!sec.isValidPin(oldPin) || !sec.isValidPin(newPin)) throw badRequest('PIN_FORMAT', 'PIN 必须是 6 位数字');
    const row = db.prepare('SELECT pin_salt, pin_hash FROM users WHERE id = ?').get(req.user.id);
    if (!row || !row.pin_hash || !sec.verifyPin(oldPin, row.pin_salt, row.pin_hash)) return sendError(req, res, 403, 'PIN_INCORRECT', '原 PIN 不正确');
    const { salt, hash } = sec.hashPin(newPin);
    db.prepare('UPDATE users SET pin_salt = ?, pin_hash = ? WHERE id = ?').run(salt, hash, req.user.id);
    audit(req.user.id, req.user.email, 'change_pin', '修改支付 PIN', req.clientIp);
    res.json({ ok: true, message: '支付 PIN 修改成功' });
  });

  app.post('/api/security/change-password', auth, (req, res) => {
    const oldPw = String((req.body && req.body.old_password) || '');
    const newPw = String((req.body && req.body.new_password) || '');
    if (newPw.length < 8) throw badRequest('PASSWORD_TOO_SHORT', '新密码至少 8 位');
    const row = db.prepare('SELECT password_salt, password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!sec.verifyPassword(oldPw, row.password_salt, row.password_hash)) return sendError(req, res, 403, 'PASSWORD_INCORRECT', '原密码不正确');
    const { salt, hash } = sec.hashPassword(newPw);
    db.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?').run(salt, hash, req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.sessionId);
    audit(req.user.id, req.user.email, 'change_password', '修改登录密码，已注销其他会话', req.clientIp);
    res.json({ ok: true, message: '密码修改成功，其他设备已退出' });
  });

  app.get('/api/security/audit', auth, (req, res) => {
    const items = db.prepare('SELECT action, detail, ip, created_at FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
    res.json({ ok: true, items });
  });

  // ---------- 会话 / 登录设备 ----------
  app.get('/api/security/sessions', auth, (req, res) => {
    const rows = db.prepare('SELECT id, ip, user_agent, last_seen_at, created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC')
      .all(req.user.id, now());
    const items = rows.map((s) => ({
      id: s.id, ip: s.ip, user_agent: s.user_agent, created_at: s.created_at, last_seen_at: s.last_seen_at || s.created_at,
      expires_at: s.expires_at, current: s.id === req.sessionId,
    }));
    res.json({ ok: true, items, count: items.length });
  });

  app.delete('/api/security/sessions/:id', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('ID_INVALID', '会话编号格式不正确');
    const row = db.prepare('SELECT id, user_id FROM sessions WHERE id = ?').get(id);
    if (!row || row.user_id !== req.user.id) throw notFound('SESSION_NOT_FOUND', '会话不存在');
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    audit(req.user.id, req.user.email, 'session_revoke', `注销登录设备 #${id}`, req.clientIp);
    res.json({ ok: true, message: '该设备已退出登录' });
  });

  app.post('/api/security/sessions/revoke-others', auth, (req, res) => {
    const r = db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.sessionId);
    audit(req.user.id, req.user.email, 'session_revoke_all', `注销其他设备 ${r.changes} 个`, req.clientIp);
    res.json({ ok: true, message: `已注销其他 ${r.changes} 个登录设备`, revoked: r.changes });
  });

  // ---------- 两步验证（TOTP） ----------
  // 绑定与解绑都需要登录密码，防止会话被盗后直接接管两步验证。
  app.post('/api/security/totp/setup', auth, (req, res) => {
    const password = String((req.body && req.body.password) || '');
    const row = db.prepare('SELECT password_salt, password_hash, totp_enabled FROM users WHERE id = ?').get(req.user.id);
    if (!sec.verifyPassword(password, row.password_salt, row.password_hash)) return sendError(req, res, 403, 'PASSWORD_INCORRECT', '登录密码不正确');
    if (row.totp_enabled) throw badRequest('TOTP_ALREADY_ENABLED', '两步验证已开启，如需更换请先关闭');
    const secret = sec.generateTotpSecret();
    db.prepare('UPDATE users SET totp_secret = ?, totp_recovery_json = NULL WHERE id = ?').run(secret, req.user.id);
    res.json({ ok: true, secret, otpauth_uri: sec.otpauthUri(secret, req.user.email), digits: 6, period: 30, algorithm: 'SHA1' });
  });

  app.post('/api/security/totp/enable', auth, (req, res) => {
    const code = String((req.body && req.body.code) || '').replace(/\s/g, '');
    const row = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
    if (!row.totp_secret) throw badRequest('TOTP_NOT_SETUP', '请先生成两步验证密钥');
    if (row.totp_enabled) throw badRequest('TOTP_ALREADY_ENABLED', '两步验证已开启');
    if (!sec.verifyTotp(row.totp_secret, code)) return sendError(req, res, 403, 'TOTP_INVALID', '动态码不正确，请检查手机时间后重试');
    const codes = sec.generateRecoveryCodes(10);
    const hashes = codes.map((c) => sec.hashToken(sec.normalizeRecoveryCode(c)));
    db.prepare('UPDATE users SET totp_enabled = 1, totp_recovery_json = ? WHERE id = ?').run(JSON.stringify(hashes), req.user.id);
    audit(req.user.id, req.user.email, 'totp_enabled', '开启两步验证', req.clientIp);
    res.json({ ok: true, message: '两步验证已开启，请妥善保存恢复码（只显示这一次）', recovery_codes: codes });
  });

  app.post('/api/security/totp/disable', auth, (req, res) => {
    const password = String((req.body && req.body.password) || '');
    const code = String((req.body && req.body.code) || '').replace(/\s/g, '');
    const row = db.prepare('SELECT password_salt, password_hash, totp_secret, totp_enabled, totp_recovery_json FROM users WHERE id = ?').get(req.user.id);
    if (!row.totp_enabled) throw badRequest('TOTP_NOT_ENABLED', '两步验证未开启');
    if (!sec.verifyPassword(password, row.password_salt, row.password_hash)) return sendError(req, res, 403, 'PASSWORD_INCORRECT', '登录密码不正确');
    if (!sec.verifyTotp(row.totp_secret, code) && !verifyRecoveryCode(row, code)) return sendError(req, res, 403, 'TOTP_INVALID', '动态码或恢复码不正确');
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery_json = NULL WHERE id = ?').run(req.user.id);
    audit(req.user.id, req.user.email, 'totp_disabled', '关闭两步验证', req.clientIp);
    res.json({ ok: true, message: '两步验证已关闭' });
  });

  app.get('/api/me', auth, (req, res) => {
    const row = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id);
    res.json({ ok: true, user: { ...req.user, totp_enabled: !!(row && row.totp_enabled) } });
  });

  // ---------- 运营后台 ----------
  require('./admin')(app, { db, backend, withTransaction, auth, requirePerm });

  // 未知 API 返回 JSON 404，其余路径交给前端单页
  app.use('/api', (req, res) => sendError(req, res, 404, 'NOT_FOUND', '接口不存在'));
  // 独立的开发者文档、商户后台与结账页（不经过主 SPA）
  app.get('/developers', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'developers.html')));
  app.get('/merchant', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'merchant.html')));
  app.get('/pay', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'pay.html')));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
  app.use(errorHandler);

  return { app, db, invest, merchant };
}

function start() {
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const { app, invest, merchant } = createApp();
  invest.startTicker();
  if (merchant && merchant.start) merchant.start();
  // 每小时清理过期会话、幂等键、确认令牌与 Webhook 重试
  const maintenance = setInterval(() => {
    try { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); } catch (e) { logger.warn('sessions.purge_failed', { err: e }); }
    try { db.prepare('DELETE FROM notifications WHERE created_at < ?').run(Date.now() - 90 * 24 * 3600 * 1000); } catch (e) { logger.warn('notifications.purge_failed', { err: e }); }
    try { purgeConfirmTokens(); } catch (e) { logger.warn('confirm.purge_failed', { err: e }); }
    try { purgeExpired(db); } catch (e) { logger.warn('idempotency.purge_failed', { err: e }); }
    if (merchant && merchant.tick) { try { merchant.tick(); } catch (e) { logger.warn('merchant.tick_failed', { err: e }); } }
  }, 60 * 60 * 1000);
  maintenance.unref();
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('server.listening', { port: PORT, demo: DEMO_MODE, backend, welcome_bonus: fmt(WELCOME_BONUS_CENTS), mail: mailMode() });
    verifyMail().then((r) => {
      if (r.ok) logger.info('mail.ready', r);
      else logger.error('mail.unavailable', r);
    });
  });
  server.headersTimeout = 20000;
  server.requestTimeout = REQUEST_TIMEOUT_MS + 5000;
  const shutdown = (sig) => {
    logger.info('server.shutdown', { signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => logger.error('process.unhandled_rejection', { err: e }));
  return server;
}

module.exports = { createApp, start };

if (require.main === module) start();
