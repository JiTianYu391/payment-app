/**
 * 支付管理 + 投资演示 — v2 正式版（FadeHost 适配）
 * 支付管理软件 — 演示版（FadeHost 适配版）
 * 虚拟资金，不可提现，不接入任何真实支付（Stripe/PayPal 均未接入）
 * 技术栈：Node.js 20+ + Express + JSON 文件存储 / node:sqlite（自动选择，见 src/db.js）
 * 运行环境：FadeHost（Git 应用托管，Firecracker 微虚拟机，Ubuntu 24.04）
 *   - 平台自动检测 package.json，执行 npm install 后用 npm start（node app.js）启动；
 *     平台自动注入 $PORT（默认 3000）与 $HOST，应用必须监听 process.env.PORT
 *     并绑定 0.0.0.0（见文件末尾的 app.listen）。
 *   - 每次部署都是一台全新的机器（蓝绿部署，健康检查通过后才切换流量）；
 *     休眠会完全释放沙箱，官方文档说明休眠后只保留部署时 baked 的产物，
 *     所以运行时数据不要只放在仓库目录里，务必挂载 Volume（见 README-pandastack.md）。
 *   - pandastack.json 里 auto_hibernate: false 表示常驻不休眠；注意官方计费文档
 *     明确说明：常驻应用几天内就会耗尽每月 $5.40 免费额度，额度用完后应用暂停
 *     到下个月（数据不删除）。想长期免费跑，请把 auto_hibernate 改回默认
 *     （删除该字段即恢复 15 分钟无流量休眠），或升级到 Pro。
 * 安全要点：
 *  - 密码 / 支付 PIN：PBKDF2-SHA256 加盐哈希（120000 次迭代）
 *  - 会话令牌：只存 SHA256 哈希，不存原文；7 天过期
 *  - 登录错 5 次锁定 15 分钟
 *  - 验证码：10 分钟过期，最多试 5 次；演示模式下显示在应用内演示收件箱
 *  - 转账 / 付款：必须验证 6 位支付 PIN
 */
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { db, audit, withTransaction } = require('./db');
const sec = require('./security');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const DEMO_MODE = String(process.env.DEMO_MODE || 'true') === 'true';
const WELCOME_BONUS_CENTS = parseInt(process.env.WELCOME_BONUS_CENTS || '5000', 10); // $50.00
const TOPUP_MAX_CENTS = parseInt(process.env.TOPUP_MAX_CENTS || '50000', 10); // $500
const LOCK_MINUTES = 15;
const MAX_LOGIN_FAILS = 5;
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
}
function centsToDollars(c) { return (c / 100).toFixed(2); }
function now() { return Date.now(); }

// ---------- 鉴权中间件 ----------
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.cookies.session || '');
  if (!token) return res.status(401).json({ ok: false, error: '未登录' });
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sec.hashToken(token), now());
  if (!row) return res.status(401).json({ ok: false, error: '会话已过期，请重新登录' });
  const user = db.prepare('SELECT id, email, nickname, pin_hash IS NOT NULL as has_pin, created_at FROM users WHERE id = ?').get(row.user_id);
  if (!user) return res.status(401).json({ ok: false, error: '用户不存在' });
  req.user = user;
  req.sessionId = row.id;
  next();
}
function requirePin(req, res, next) {
  const pin = String(req.body.pin || '');
  if (!sec.isValidPin(pin)) return res.status(400).json({ ok: false, error: '请输入 6 位支付 PIN' });
  const row = db.prepare('SELECT pin_salt, pin_hash FROM users WHERE id = ?').get(req.user.id);
  if (!row || !row.pin_hash) return res.status(400).json({ ok: false, error: '请先在安全中心设置支付 PIN' });
  if (!sec.verifyPin(pin, row.pin_salt, row.pin_hash)) {
    audit(req.user.id, req.user.email, 'pin_failed', '支付 PIN 验证失败', clientIp(req));
    return res.status(403).json({ ok: false, error: '支付 PIN 不正确' });
  }
  next();
}
function addTransaction(userId, type, amountCents, balanceAfter, opts = {}) {
  db.prepare(`INSERT INTO transactions (user_id, type, amount_cents, balance_after_cents, counterparty_email, merchant, category, description, product_id, order_id, sim_day, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(userId, type, amountCents, balanceAfter,
    opts.counterparty || null, opts.merchant || null, opts.category || null, opts.description || '',
    opts.product_id || null, opts.order_id || null, require('./products').currentDay(db), now());
}

// ---------- 投资系统（v2，见 src/invest.js + src/products.js） ----------
const investStatus = require('./invest')(app, { db, audit, withTransaction, sec });

// ---------- 健康检查 ----------
app.get('/api/health', (req, res) => res.json({ ok: true, demo: DEMO_MODE, welcome_bonus_cents: WELCOME_BONUS_CENTS, time: new Date().toISOString(), invest: investStatus.status() }));

// ---------- 验证码（演示模式：显示在应用内演示收件箱） ----------
app.post('/api/auth/request-code', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const purpose = String(req.body.purpose || 'register');
  if (!sec.isValidEmail(email)) return res.status(400).json({ ok: false, error: '邮箱格式不正确' });
  if (!['register', 'reset_password'].includes(purpose)) return res.status(400).json({ ok: false, error: '用途不正确' });
  // 1 分钟内只能发一次（防刷）
  const recent = db.prepare('SELECT created_at FROM verification_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(email);
  if (recent && now() - recent.created_at < 60 * 1000) return res.status(429).json({ ok: false, error: '验证码发送太频繁，请 1 分钟后再试' });
  const code = sec.generateCode();
  db.prepare('INSERT INTO verification_codes (email, code_hash, purpose, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run(email, sec.hashCode(code), purpose, now() + CODE_TTL_MS, now());
  if (DEMO_MODE) {
    db.prepare('INSERT INTO demo_inbox (email, code, purpose, created_at) VALUES (?,?,?,?)').run(email, code, purpose, now());
  }
  // 演示版不发真实邮件；生产如需发邮件，在此接入 SMTP / 邮件服务商
  return res.json({ ok: true, demo: DEMO_MODE, message: DEMO_MODE ? '演示模式：验证码已发送到应用内演示邮箱收件箱' : '验证码已发送' });
});

// 演示邮箱收件箱：仅演示用，明确标注虚拟
app.get('/api/demo-inbox', (req, res) => {
  if (!DEMO_MODE) return res.status(404).json({ ok: false, error: '演示收件箱未开启' });
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!sec.isValidEmail(email)) return res.status(400).json({ ok: false, error: '邮箱格式不正确' });
  const rows = db.prepare('SELECT code, purpose, created_at FROM demo_inbox WHERE email = ? ORDER BY id DESC LIMIT 5').all(email);
  res.json({ ok: true, demo: true, notice: '演示模式：验证码仅显示在此收件箱，不会发送真实邮件', items: rows });
});

function verifyCode(email, code, purpose) {
  const row = db.prepare('SELECT * FROM verification_codes WHERE email = ? AND purpose = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1')
    .get(email, purpose, now());
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
  const email = String(req.body.email || '').trim().toLowerCase();
  const nickname = String(req.body.nickname || '').trim();
  const password = String(req.body.password || '');
  const code = String(req.body.code || '').trim();
  if (!sec.isValidEmail(email)) return res.status(400).json({ ok: false, error: '邮箱格式不正确' });
  if (!nickname || nickname.length > 30) return res.status(400).json({ ok: false, error: '昵称不能为空且不超过 30 字' });
  if (password.length < 8) return res.status(400).json({ ok: false, error: '密码至少 8 位' });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: '请输入 6 位验证码' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(400).json({ ok: false, error: '该邮箱已注册，请直接登录' });
  const v = verifyCode(email, code, 'register');
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

  const { salt, hash } = sec.hashPassword(password);
  let userId;
  try {
    userId = withTransaction(() => {
      const u = db.prepare('INSERT INTO users (email, nickname, password_salt, password_hash, created_at) VALUES (?,?,?,?,?)')
        .run(email, nickname, salt, hash, now());
      db.prepare('INSERT INTO wallets (user_id, balance_cents, updated_at) VALUES (?,?,?)').run(u.lastInsertRowid, WELCOME_BONUS_CENTS, now());
      addTransaction(u.lastInsertRowid, 'bonus', WELCOME_BONUS_CENTS, WELCOME_BONUS_CENTS, { category: '体验金', description: '新用户注册赠送 $50.00 虚拟体验金（不可提现）' });
      return u.lastInsertRowid;
    });
  } catch (e) { return res.status(500).json({ ok: false, error: '注册失败，请重试' }); }
  try { require('./products').backfillCashHistory(db, userId, WELCOME_BONUS_CENTS); } catch (_) { /* 快照失败不阻塞注册 */ }
  audit(userId, email, 'register', `新用户注册，赠送 $${centsToDollars(WELCOME_BONUS_CENTS)} 虚拟体验金`, clientIp(req));
  return res.json({ ok: true, message: `注册成功，已到账 $${centsToDollars(WELCOME_BONUS_CENTS)} 虚拟体验金（不可提现）` });
});

// ---------- 登录 ----------
app.post('/api/auth/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!sec.isValidEmail(email) || !password) return res.status(400).json({ ok: false, error: '邮箱或密码不正确' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(401).json({ ok: false, error: '邮箱或密码不正确' });
  if (user.locked_until && user.locked_until > now()) {
    const mins = Math.ceil((user.locked_until - now()) / 60000);
    return res.status(423).json({ ok: false, error: `账户已锁定，请 ${mins} 分钟后再试` });
  }
  if (!sec.verifyPassword(password, user.password_salt, user.password_hash)) {
    const fails = (user.failed_login_attempts || 0) + 1;
    const lockedUntil = fails >= MAX_LOGIN_FAILS ? now() + LOCK_MINUTES * 60 * 1000 : null;
    db.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?').run(fails, lockedUntil, user.id);
    audit(user.id, email, 'login_failed', `登录失败 ${fails} 次`, clientIp(req));
    if (lockedUntil) return res.status(423).json({ ok: false, error: `密码错误 5 次，账户已锁定 ${LOCK_MINUTES} 分钟` });
    return res.status(401).json({ ok: false, error: `邮箱或密码不正确（已失败 ${fails} 次，5 次锁定）` });
  }
  db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
  const token = sec.generateToken();
  db.prepare('INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent, created_at) VALUES (?,?,?,?,?,?)')
    .run(user.id, sec.hashToken(token), now() + SESSION_TTL_MS, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200), now());
  audit(user.id, email, 'login', '登录成功', clientIp(req));
  return res.json({ ok: true, token, user: { id: user.id, email: user.email, nickname: user.nickname, has_pin: !!user.pin_hash } });
});

app.post('/api/auth/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.sessionId);
  audit(req.user.id, req.user.email, 'logout', '退出登录', clientIp(req));
  res.json({ ok: true });
});

// ---------- 钱包 / 统计 ----------
app.get('/api/wallet', auth, (req, res) => {
  const w = db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(req.user.id);
  res.json({ ok: true, balance_cents: w ? w.balance_cents : 0, balance: centsToDollars(w ? w.balance_cents : 0), currency: 'USD', virtual: true, notice: '虚拟资金，不可提现' });
});

app.get('/api/stats', auth, (req, res) => {
  const rows = db.prepare(`SELECT category, type, SUM(amount_cents) as total FROM transactions WHERE user_id = ? GROUP BY category, type`).all(req.user.id);
  let income = 0, expense = 0;
  const byCategory = {};
  for (const r of rows) {
    if (r.type === 'topup' || r.type === 'bonus' || r.type === 'transfer_in') income += r.total;
    else expense += Math.abs(r.total);
    const key = r.category || '其他';
    byCategory[key] = (byCategory[key] || 0) + r.total;
  }
  const recent = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5').all(req.user.id);
  res.json({ ok: true, income_cents: income, expense_cents: expense, by_category: byCategory, recent });
});

// ---------- 账单 ----------
app.get('/api/transactions', auth, (req, res) => {
  const { type, category, q, from, to, limit = 50, offset = 0 } = req.query;
  let sql = 'SELECT * FROM transactions WHERE user_id = ?';
  const params = [req.user.id];
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (q) { sql += ' AND (description LIKE ? OR merchant LIKE ? OR counterparty_email LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (from) { sql += ' AND created_at >= ?'; params.push(new Date(from).getTime()); }
  if (to) { sql += ' AND created_at <= ?'; params.push(new Date(to).getTime()); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Math.min(parseInt(limit, 10) || 50, 200), parseInt(offset, 10) || 0);
  const items = db.prepare(sql).all(...params);
  const total = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE user_id = ?').get(req.user.id).c;
  res.json({ ok: true, total, items });
});

// ---------- 转账 ----------
app.post('/api/transfer', auth, requirePin, (req, res) => {
  const toEmail = String(req.body.to_email || '').trim().toLowerCase();
  const amountCents = Math.round(parseFloat(req.body.amount) * 100);
  const note = String(req.body.note || '').slice(0, 100);
  if (!sec.isValidEmail(toEmail)) return res.status(400).json({ ok: false, error: '收款邮箱格式不正确' });
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ ok: false, error: '转账金额必须大于 0' });
  if (toEmail === req.user.email) return res.status(400).json({ ok: false, error: '不能给自己转账' });
  const recipient = db.prepare('SELECT id, email, nickname FROM users WHERE email = ?').get(toEmail);
  if (!recipient) return res.status(404).json({ ok: false, error: '收款方不存在，请确认邮箱' });
  const senderWallet = db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(req.user.id);
  if (!senderWallet || senderWallet.balance_cents < amountCents) return res.status(400).json({ ok: false, error: '余额不足' });
  let result;
  try {
    result = withTransaction(() => {
      const newSender = senderWallet.balance_cents - amountCents;
      db.prepare('UPDATE wallets SET balance_cents = ?, updated_at = ? WHERE user_id = ?').run(newSender, now(), req.user.id);
      addTransaction(req.user.id, 'transfer_out', -amountCents, newSender, { counterparty: toEmail, category: '转账', description: note || `转账给 ${toEmail}` });
      const rw = db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(recipient.id);
      const newRecv = (rw ? rw.balance_cents : 0) + amountCents;
      db.prepare('UPDATE wallets SET balance_cents = ?, updated_at = ? WHERE user_id = ?').run(newRecv, now(), recipient.id);
      addTransaction(recipient.id, 'transfer_in', amountCents, newRecv, { counterparty: req.user.email, category: '转账', description: note || `来自 ${req.user.email} 的转账` });
      return { newSender, newRecv };
    });
  } catch (e) { return res.status(500).json({ ok: false, error: '转账失败，请重试' }); }
  audit(req.user.id, req.user.email, 'transfer', `转账 $${centsToDollars(amountCents)} 给 ${toEmail}`, clientIp(req));
  res.json({ ok: true, message: '转账成功', balance_cents: result.newSender });
});

// ---------- 商户付款 / 缴费 ----------
app.post('/api/pay', auth, requirePin, (req, res) => {
  const merchant = String(req.body.merchant || '').trim().slice(0, 80);
  const category = String(req.body.category || '购物').trim().slice(0, 30);
  const amountCents = Math.round(parseFloat(req.body.amount) * 100);
  const note = String(req.body.note || '').slice(0, 100);
  if (!merchant) return res.status(400).json({ ok: false, error: '请输入商户名称' });
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ ok: false, error: '付款金额必须大于 0' });
  const w = db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(req.user.id);
  if (!w || w.balance_cents < amountCents) return res.status(400).json({ ok: false, error: '余额不足' });
  const newBal = w.balance_cents - amountCents;
  db.prepare('UPDATE wallets SET balance_cents = ?, updated_at = ? WHERE user_id = ?').run(newBal, now(), req.user.id);
  addTransaction(req.user.id, 'pay', -amountCents, newBal, { merchant, category, description: note || `向 ${merchant} 付款` });
  audit(req.user.id, req.user.email, 'pay', `向 ${merchant} 付款 $${centsToDollars(amountCents)}（${category}）`, clientIp(req));
  res.json({ ok: true, message: '付款成功', balance_cents: newBal });
});

// ---------- 演示充值（单次上限 $500） ----------
app.post('/api/topup', auth, (req, res) => {
  const amountCents = Math.round(parseFloat(req.body.amount) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ ok: false, error: '充值金额必须大于 0' });
  if (amountCents > TOPUP_MAX_CENTS) return res.status(400).json({ ok: false, error: `演示充值单次上限 $${centsToDollars(TOPUP_MAX_CENTS)}` });
  const w = db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(req.user.id);
  const newBal = (w ? w.balance_cents : 0) + amountCents;
  db.prepare('UPDATE wallets SET balance_cents = ?, updated_at = ? WHERE user_id = ?').run(newBal, now(), req.user.id);
  addTransaction(req.user.id, 'topup', amountCents, newBal, { category: '充值', description: '演示充值（虚拟资金）' });
  audit(req.user.id, req.user.email, 'topup', `演示充值 $${centsToDollars(amountCents)}`, clientIp(req));
  res.json({ ok: true, message: '充值成功（虚拟资金）', balance_cents: newBal });
});

// ---------- 安全中心 ----------
app.post('/api/security/set-pin', auth, (req, res) => {
  const pin = String(req.body.pin || '');
  const password = String(req.body.password || '');
  if (!sec.isValidPin(pin)) return res.status(400).json({ ok: false, error: 'PIN 必须是 6 位数字' });
  const row = db.prepare('SELECT password_salt, password_hash, pin_hash FROM users WHERE id = ?').get(req.user.id);
  if (!sec.verifyPassword(password, row.password_salt, row.password_hash)) return res.status(403).json({ ok: false, error: '登录密码不正确' });
  if (row.pin_hash) return res.status(400).json({ ok: false, error: '已设置 PIN，请用修改 PIN' });
  const { salt, hash } = sec.hashPin(pin);
  db.prepare('UPDATE users SET pin_salt = ?, pin_hash = ? WHERE id = ?').run(salt, hash, req.user.id);
  audit(req.user.id, req.user.email, 'set_pin', '设置支付 PIN', clientIp(req));
  res.json({ ok: true, message: '支付 PIN 设置成功' });
});

app.post('/api/security/change-pin', auth, (req, res) => {
  const oldPin = String(req.body.old_pin || '');
  const newPin = String(req.body.new_pin || '');
  if (!sec.isValidPin(oldPin) || !sec.isValidPin(newPin)) return res.status(400).json({ ok: false, error: 'PIN 必须是 6 位数字' });
  const row = db.prepare('SELECT pin_salt, pin_hash FROM users WHERE id = ?').get(req.user.id);
  if (!row || !row.pin_hash || !sec.verifyPin(oldPin, row.pin_salt, row.pin_hash)) return res.status(403).json({ ok: false, error: '原 PIN 不正确' });
  const { salt, hash } = sec.hashPin(newPin);
  db.prepare('UPDATE users SET pin_salt = ?, pin_hash = ? WHERE id = ?').run(salt, hash, req.user.id);
  audit(req.user.id, req.user.email, 'change_pin', '修改支付 PIN', clientIp(req));
  res.json({ ok: true, message: '支付 PIN 修改成功' });
});

app.post('/api/security/change-password', auth, (req, res) => {
  const oldPw = String(req.body.old_password || '');
  const newPw = String(req.body.new_password || '');
  if (newPw.length < 8) return res.status(400).json({ ok: false, error: '新密码至少 8 位' });
  const row = db.prepare('SELECT password_salt, password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!sec.verifyPassword(oldPw, row.password_salt, row.password_hash)) return res.status(403).json({ ok: false, error: '原密码不正确' });
  const { salt, hash } = sec.hashPassword(newPw);
  db.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?').run(salt, hash, req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.sessionId);
  audit(req.user.id, req.user.email, 'change_password', '修改登录密码，已注销其他会话', clientIp(req));
  res.json({ ok: true, message: '密码修改成功，其他设备已退出' });
});

app.get('/api/security/audit', auth, (req, res) => {
  const items = db.prepare('SELECT action, detail, ip, created_at FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  res.json({ ok: true, items });
});

app.get('/api/me', auth, (req, res) => res.json({ ok: true, user: req.user }));

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ---- FadeHost：平台自动注入 $PORT（默认 3000）与 $HOST，
// 应用必须监听 process.env.PORT 并绑定 0.0.0.0；部署时的健康检查会请求该端口。
// 本地开发时 PORT 未设置则默认 3000。
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[payment-app] listening on 0.0.0.0:${PORT} demo=${DEMO_MODE} welcome=$${centsToDollars(WELCOME_BONUS_CENTS)}`);
});
