/**
 * SpacePay 服务端入口（Express）。
 * 演示环境：全部为虚拟资金，不接入任何真实支付渠道，提现为模拟出款。
 *
 * 结构：
 *   createApp()  组装中间件与路由，返回 { app, db, ... }，测试直接使用，不监听端口；
 *   直接运行本文件或 app.js 时调用 start() 监听 $PORT（FadeHost / PandaStack 注入）。
 *
 * 资金安全要点：
 *   - 金额一律为整数分（src/money.js），钱包变动只走 wallet.applyCash（条件扣款 + 流水 + 复式分录）；
 *   - 资金类 POST 支持 Idempotency-Key（src/idempotency.js）；
 *   - 退款 / 冻结 / 提现等关键操作需要二次确认（src/confirm.js）并写入操作日志（src/oplog.js）；
 *   - 密码 / PIN 使用 PBKDF2-SHA256；会话令牌只存哈希；登录错 5 次锁 15 分钟。
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
const { requireConfirmation } = require('./confirm');
const oplog = require('./oplog');
const { deliverCode } = require('./notifier');
const { requestTimeout, degrade } = require('./resilience');
const { AppError, badRequest, sendError, errorHandler } = require('./errors');

const DEMO_MODE = String(process.env.DEMO_MODE || 'true') === 'true';
const WELCOME_BONUS_CENTS = parseInt(process.env.WELCOME_BONUS_CENTS || '5000', 10);
const TOPUP_MAX_CENTS = parseInt(process.env.TOPUP_MAX_CENTS || '50000', 10);
const WITHDRAW_MAX_CENTS = parseInt(process.env.WITHDRAW_MAX_CENTS || '50000', 10);
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

function createApp() {
  const app = express();
  const { auth, requireActive, requirePin, requirePerm } = createAuth({ db, sec, audit });

  // ---------- 启动时数据维护 ----------
  const opened = ledger.backfillOpeningBalances(db, withTransaction);
  if (opened) logger.info('ledger.opening_balances_backfilled', { wallets: opened });
  const promoted = rbac.bootstrapAdmins(db);
  if (promoted) logger.info('rbac.admins_bootstrapped', { count: promoted });
  try { purgeExpired(db); } catch (e) { logger.warn('idempotency.purge_failed', { err: e }); }

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

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

  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true, exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed', 'Content-Disposition'] }));
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

  // ---------- 健康检查（含降级状态） ----------
  app.get('/api/health', (req, res) => {
    const dbCheck = degrade('db', () => { db.prepare('SELECT COUNT(*) AS c FROM users').get(); return { ok: true, backend }; }, (e) => ({ ok: false, backend, error: e.message }), req.log);
    const inv = degrade('invest', () => invest.status(), (e) => ({ ok: false, error: e.message }), req.log);
    const degraded = !dbCheck.value.ok || inv.degraded || (inv.value && inv.value.last_tick_error);
    res.status(dbCheck.value.ok ? 200 : 503).json({
      ok: dbCheck.value.ok, status: degraded ? 'degraded' : 'ok', service: 'SpacePay', demo: DEMO_MODE,
      welcome_bonus_cents: WELCOME_BONUS_CENTS, time: new Date().toISOString(),
      components: { db: dbCheck.value, invest: inv.value }, invest: inv.value,
    });
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
    return res.json({ ok: true, demo: DEMO_MODE, message: DEMO_MODE ? '演示模式：验证码已发送到应用内演示收件箱' : '验证码已发送' });
  }));

  app.get('/api/demo-inbox', (req, res) => {
    if (!DEMO_MODE) return sendError(req, res, 404, 'NOT_FOUND', '演示收件箱未开启');
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!sec.isValidEmail(email)) return sendError(req, res, 400, 'EMAIL_INVALID', '邮箱格式不正确');
    const rows = db.prepare('SELECT code, purpose, created_at FROM demo_inbox WHERE email = ? ORDER BY id DESC LIMIT 5').all(email);
    return res.json({ ok: true, demo: true, notice: '演示模式：验证码仅显示在此收件箱，不会发送真实邮件', items: rows });
  });

  function verifyCode(email, code, purpose) {
    const row = db.prepare('SELECT * FROM verification_codes WHERE email = ? AND purpose = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1').get(email, purpose, now());
    if (!row) return { ok: false, error: '验证码不存在或已过期，请重新获取' };
    if (row.attempts >= CODE_MAX_ATTEMPTS) return { ok: false, error: '验证码尝试次数过多，请重新获取' };
    if (sec.hashCode(String(code)) !== row.code_hash) {
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
  app.post('/api/auth/login', (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    if (!sec.isValidEmail(email) || !password) return sendError(req, res, 400, 'CREDENTIALS_INVALID', '邮箱或密码不正确');
    rbac.bootstrapAdmins(db, email);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return sendError(req, res, 401, 'CREDENTIALS_INVALID', '邮箱或密码不正确');
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
    db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
    const token = sec.generateToken();
    db.prepare('INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent, created_at) VALUES (?,?,?,?,?,?)')
      .run(user.id, sec.hashToken(token), now() + SESSION_TTL_MS, req.clientIp, String(req.headers['user-agent'] || '').slice(0, 200), now());
    audit(user.id, email, 'login', '登录成功', req.clientIp);
    const role = user.role || 'customer';
    return res.json({ ok: true, token, user: { id: user.id, email: user.email, nickname: user.nickname, has_pin: !!user.pin_hash, role, status: user.status || 'ACTIVE', permissions: rbac.permsOf(role) } });
  });

  app.post('/api/auth/logout', auth, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(req.sessionId);
    audit(req.user.id, req.user.email, 'logout', '退出登录', req.clientIp);
    res.json({ ok: true });
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

  // ---------- 演示充值 ----------
  app.post('/api/topup', auth, requireActive, idempotent(db, 'topup'), (req, res) => {
    const amountCents = v.amount(req.body, 'amount', { label: '充值金额', max: Math.max(TOPUP_MAX_CENTS, 1) });
    const mv = withTransaction(() => wallet.applyCash(db, { userId: req.user.id, delta: amountCents, type: 'topup', category: '充值', description: '演示充值（虚拟资金）' }));
    audit(req.user.id, req.user.email, 'topup', `演示充值 ${fmt(amountCents)}`, req.clientIp);
    res.json({ ok: true, message: '充值成功（虚拟资金）', balance_cents: mv.balance, transaction_id: mv.transactionId });
  });

  // ---------- 提现（模拟出款，需财务审核） ----------
  app.get('/api/withdrawals', auth, (req, res) => {
    const items = db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
    res.json({ ok: true, items });
  });

  app.post('/api/withdrawals', auth, requireActive, requirePin, idempotent(db, 'withdrawal'), (req, res) => {
    const amountCents = v.amount(req.body, 'amount', { label: '提现金额', max: WITHDRAW_MAX_CENTS });
    const destination = v.str(req.body, 'destination', { required: true, label: '收款银行卡尾号', pattern: /^\d{4}$/, message: '收款银行卡尾号应为 4 位数字' });
    const bal = wallet.balanceOf(db, req.user.id);
    if (bal < amountCents) throw new AppError(400, 'INSUFFICIENT_FUNDS', `余额不足：还差 ${fmt(amountCents - bal)}`, { shortfall_cents: amountCents - bal });
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
    res.json({ ok: true, message: '提现申请已提交，等待审核', withdrawal_id: r.id, status: 'PENDING', balance_cents: r.balance });
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

  app.get('/api/me', auth, (req, res) => res.json({ ok: true, user: req.user }));

  // ---------- 运营后台 ----------
  require('./admin')(app, { db, backend, withTransaction, auth, requirePerm });

  // 未知 API 返回 JSON 404，其余路径交给前端单页
  app.use('/api', (req, res) => sendError(req, res, 404, 'NOT_FOUND', '接口不存在'));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
  app.use(errorHandler);

  return { app, db, invest };
}

function start() {
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const { app, invest } = createApp();
  invest.startTicker();
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('server.listening', { port: PORT, demo: DEMO_MODE, backend, welcome_bonus: fmt(WELCOME_BONUS_CENTS) });
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
