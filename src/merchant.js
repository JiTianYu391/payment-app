// 商户开放平台
//   /api/merchant/*  商户后台（会话 + RBAC）
//   /api/admin/*     商户审批、结算审核、商户列表（运营）
//   /api/v1/*        对外开放 API（API Key 鉴权、每个 Key 限流、Idempotency-Key）
//   /api/checkout/*  付款人结账（登录用户 + 支付 PIN）
// 资金路径：付款人钱包 → merchant:payable（商户待结算）→ 提现时转入 clearing:merchant_payouts → 出款。
// 所有金额为整数分，全部变动走 wallet.applyCash 或平衡的复式分录。
'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const money = require('./money');
const v = require('./validate');
const sec = require('./security');
const wallet = require('./wallet');
const ledger = require('./ledger');
const state = require('./state');
const oplog = require('./oplog');
const logger = require('./logger');
const notify = require('./notify');
const { idempotent } = require('./idempotency');
const { requireConfirmation } = require('./confirm');
const { AppError, badRequest, forbidden, notFound, conflict, sendError } = require('./errors');

const now = () => Date.now();
const fmt = (c) => money.formatCents(c);
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const PAYMENT_TTL_MS = 30 * 60 * 1000;
const PAYOUT_CLEARING = 'clearing:merchant_payouts';
const PAYABLE = 'merchant:payable';
const API_RATE_LIMIT = parseInt(process.env.MERCHANT_RATE_LIMIT || '120', 10);
const RETRY_DELAYS = [0, 60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3, 6 * 3600e3];
const WEBHOOK_TIMEOUT_MS = 10000;
const ALLOW_HTTP_WEBHOOK = String(process.env.WEBHOOK_ALLOW_HTTP || '') === 'true';

// ---------- 小工具 ----------
function parseJson(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch (_) { return fallback; }
}

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === '::1') return true;
  // IPv6 唯一本地地址 fc00::/7 与链路本地 fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// 投递前再做一次解析校验：防止商户把域名解析到内网（DNS rebinding / SSRF）
async function safeWebhookTarget(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return false; }
  if (ALLOW_HTTP_WEBHOOK && u.protocol === 'http:') return true;
  if (u.protocol !== 'https:') return false;
  try {
    const addrs = await dns.lookup(u.hostname, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateHost(a.address));
  } catch (_) {
    return false;
  }
}

// Webhook 地址必须是 HTTPS 且不能指向内网：避免把商户可配置的地址变成 SSRF 跳板
function validateWebhookUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.length > 500) throw badRequest('WEBHOOK_URL_INVALID', 'Webhook 地址过长');
  let u;
  try { u = new URL(s); } catch (_) { throw badRequest('WEBHOOK_URL_INVALID', 'Webhook 地址格式不正确'); }
  const okProtocol = u.protocol === 'https:' || (ALLOW_HTTP_WEBHOOK && u.protocol === 'http:');
  if (!okProtocol) throw badRequest('WEBHOOK_URL_INVALID', 'Webhook 地址必须使用 HTTPS');
  // WEBHOOK_ALLOW_HTTP 仅用于本地联调：允许 http 与本机/内网地址；生产环境必须保持 HTTPS
  if (isPrivateHost(u.hostname) && !(ALLOW_HTTP_WEBHOOK && u.protocol === 'http:')) {
    throw badRequest('WEBHOOK_URL_INVALID', 'Webhook 地址不能指向内网或本机');
  }
  return u.toString();
}

function merchantView(m) {
  return {
    id: m.id, name: m.name, email: m.email, status: m.status, website: m.website || null,
    description: m.description || null, webhook_url: m.webhook_url || null,
    webhook_configured: !!m.webhook_url, created_at: m.created_at, updated_at: m.updated_at,
  };
}

function paymentView(p, req) {
  const meta = parseJson(p.metadata_json, {});
  return {
    id: `pay_${p.id}`, object: 'payment', numeric_id: p.id, reference: p.reference,
    amount_cents: p.amount_cents, amount: money.centsToDecimal(p.amount_cents), currency: p.currency,
    status: p.status, refunded_cents: p.refunded_cents, refundable_cents: p.amount_cents - p.refunded_cents,
    description: p.description || null, customer_email: p.customer_email || null,
    metadata: meta, checkout_url: p.checkout_token && req ? `${baseUrl(req)}/pay.html?token=${encodeURIComponent(p.checkout_token)}` : null,
    created_at: p.created_at, paid_at: p.paid_at || null, expires_at: p.created_at + PAYMENT_TTL_MS,
  };
}

module.exports = function mountMerchant(app, ctx) {
  const { db, withTransaction, sec: _sec, auth, requireActive, requirePin, requirePerm } = ctx;
  const rateBuckets = new Map(); // keyId -> { count, resetAt }

  // ============================================================
  // 数据访问
  // ============================================================
  function payableOf(merchantId) {
    const r = db.prepare('SELECT SUM(amount_cents) AS s FROM ledger_entries WHERE account = ? AND user_id = ?').get(PAYABLE, merchantId);
    return (r && r.s) || 0;
  }
  function pendingPayoutOf(merchantId) {
    const r = db.prepare("SELECT SUM(amount_cents) AS s FROM merchant_payouts WHERE merchant_id = ? AND status = 'PENDING'").get(merchantId);
    return (r && r.s) || 0;
  }
  function merchantOfUser(userId) {
    return db.prepare('SELECT * FROM merchants WHERE owner_user_id = ?').get(userId) || null;
  }
  function requireMerchant(req, res, next) {
    const m = merchantOfUser(req.user.id);
    if (!m) return sendError(req, res, 403, 'MERCHANT_REQUIRED', '当前账户不是商户，请先申请入驻');
    if (m.status === 'SUSPENDED') return sendError(req, res, 403, 'MERCHANT_SUSPENDED', '商户已被暂停，请联系运营');
    if (m.status !== 'ACTIVE') return sendError(req, res, 403, 'MERCHANT_INACTIVE', '商户尚未通过审核');
    req.merchant = m;
    return next();
  }
  function merchantPayment(req) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('ID_INVALID', '支付编号格式不正确');
    const p = db.prepare('SELECT * FROM merchant_payments WHERE id = ? AND merchant_id = ?').get(id, req.merchant.id);
    if (!p) throw notFound('PAYMENT_NOT_FOUND', '支付单不存在');
    return p;
  }
  function expireIfNeeded(p) {
    if (p.status === 'CREATED' && now() - p.created_at > PAYMENT_TTL_MS) {
      db.prepare("UPDATE merchant_payments SET status = 'EXPIRED', updated_at = ? WHERE id = ? AND status = 'CREATED'").run(now(), p.id);
      return { ...p, status: 'EXPIRED' };
    }
    return p;
  }

  // ============================================================
  // Webhook
  // ============================================================
  function enqueueWebhook(merchant, eventType, data) {
    if (!merchant || !merchant.webhook_url) return null;
    const event = {
      id: 'evt_' + crypto.randomUUID().replace(/-/g, ''),
      type: eventType,
      created: Math.floor(now() / 1000),
      data,
    };
    const payload = JSON.stringify(event);
    const r = db.prepare(`INSERT INTO webhook_deliveries (merchant_id, event_id, event_type, payment_id, url, payload_json, status, attempts, next_attempt_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(merchant.id, event.id, eventType, data && data.numeric_id ? data.numeric_id : null, merchant.webhook_url, payload, 'PENDING', 0, now(), now());
    setImmediate(() => deliverWebhook(r.lastInsertRowid).catch((e) => logger.warn('webhook.deliver_failed', { err: e })));
    return event.id;
  }

  async function deliverWebhook(id) {
    const d = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id);
    if (!d || d.status !== 'PENDING') return;
    const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(d.merchant_id);
    if (!m || !m.webhook_secret || m.status === 'SUSPENDED') {
      db.prepare("UPDATE webhook_deliveries SET status = 'FAILED', last_error = ? WHERE id = ?").run('merchant unavailable', id);
      return;
    }
    if (!(await safeWebhookTarget(d.url))) {
      db.prepare("UPDATE webhook_deliveries SET status = 'FAILED', attempts = attempts + 1, last_error = ? WHERE id = ?").run('blocked target', id);
      return;
    }
    const timestamp = Math.floor(now() / 1000);
    const signature = sec.signWebhook(m.webhook_secret, timestamp, d.payload_json);
    let statusCode = null, error = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
      const r = await fetch(d.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'SpacePay-Webhooks/1.0',
          'X-SpacePay-Event': d.event_type,
          'X-SpacePay-Delivery': d.event_id,
          'X-SpacePay-Signature': `t=${timestamp},v1=${signature}`,
        },
        body: d.payload_json,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      statusCode = r.status;
      if (!r.ok) error = 'HTTP ' + r.status;
    } catch (e) {
      error = e.name === 'AbortError' ? 'timeout' : e.message;
    }
    const attempts = (d.attempts || 0) + 1;
    if (!error) {
      db.prepare("UPDATE webhook_deliveries SET status = 'DELIVERED', attempts = ?, last_status_code = ?, last_error = NULL, delivered_at = ? WHERE id = ?")
        .run(attempts, statusCode, now(), id);
      return;
    }
    const final = attempts >= RETRY_DELAYS.length;
    const nextAt = final ? null : now() + RETRY_DELAYS[attempts];
    db.prepare("UPDATE webhook_deliveries SET status = ?, attempts = ?, last_status_code = ?, last_error = ?, next_attempt_at = ? WHERE id = ?")
      .run(final ? 'FAILED' : 'PENDING', attempts, statusCode, String(error).slice(0, 300), nextAt, id);
  }

  function tick() {
    // 到期的 Webhook 重试（本进程内）
    const rows = db.prepare("SELECT id, next_attempt_at FROM webhook_deliveries WHERE status = 'PENDING'").all()
      .filter((r) => !r.next_attempt_at || r.next_attempt_at <= now()).slice(0, 20);
    for (const r of rows) setImmediate(() => deliverWebhook(r.id).catch(() => {}));
    // 未支付且超过有效期的支付单标记过期
    const stale = db.prepare("SELECT id, created_at FROM merchant_payments WHERE status = 'CREATED'").all()
      .filter((p) => now() - p.created_at > PAYMENT_TTL_MS).slice(0, 50);
    for (const p of stale) {
      db.prepare("UPDATE merchant_payments SET status = 'EXPIRED', updated_at = ? WHERE id = ? AND status = 'CREATED'").run(now(), p.id);
    }
    // API 日志保留最近 5 万条
    try {
      const c = db.prepare('SELECT COUNT(*) AS c FROM api_logs').get().c;
      if (c > 50000) {
        const cut = db.prepare('SELECT id FROM api_logs ORDER BY id DESC LIMIT 1 OFFSET ?').get(50000);
        if (cut) db.prepare('DELETE FROM api_logs WHERE id <= ?').run(cut.id);
      }
    } catch (_) { /* 非关键 */ }
  }

  // ============================================================
  // 对外开放 API：鉴权、限流、日志
  // ============================================================
  function apiAuth(req, res, next) {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-api-key'] || '').trim();
    const parsed = sec.parseApiKey(token);
    if (!parsed) return sendError(req, res, 401, 'INVALID_API_KEY', '缺少或格式不正确的 API Key');
    const key = db.prepare('SELECT * FROM merchant_keys WHERE key_id = ?').get(parsed.keyId);
    if (!key || key.revoked_at) return sendError(req, res, 401, 'INVALID_API_KEY', 'API Key 无效或已吊销');
    if (!sec.verifyApiSecret(parsed.secret, key.secret_hash)) return sendError(req, res, 401, 'INVALID_API_KEY', 'API Key 无效');
    const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(key.merchant_id);
    if (!m) return sendError(req, res, 401, 'INVALID_API_KEY', 'API Key 无效');
    if (m.status !== 'ACTIVE') return sendError(req, res, 403, 'MERCHANT_INACTIVE', '商户未启用或已被暂停');
    db.prepare('UPDATE merchant_keys SET last_used_at = ? WHERE id = ?').run(now(), key.id);
    req.merchant = m;
    req.apiKey = key;
    req.apiMode = parsed.mode;
    // 每个 Key 每分钟限流（单进程内存桶）
    const b = rateBuckets.get(key.key_id) || { count: 0, resetAt: now() + 60000 };
    if (now() > b.resetAt) { b.count = 0; b.resetAt = now() + 60000; }
    b.count++;
    rateBuckets.set(key.key_id, b);
    if (b.count > API_RATE_LIMIT) return sendError(req, res, 429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
    return next();
  }

  function apiLog(req, res, next) {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      try {
        db.prepare('INSERT INTO api_logs (merchant_id, key_id, method, path, status_code, request_id, ip, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(req.merchant ? req.merchant.id : null, req.apiKey ? req.apiKey.key_id : null, req.method, req.path,
            res.statusCode, req.id || null, req.clientIp || null, Math.round(Number(process.hrtime.bigint() - start) / 1e6), now());
      } catch (_) { /* 日志失败不影响请求 */ }
    });
    next();
  }

  const api = [apiLog, apiAuth];

  // ============================================================
  // /api/v1 —— 对外 API
  // ============================================================
  app.post('/api/v1/payments', ...api, (req, res, next) => idempotent(db, `v1_payment_create_${req.merchant.id}`)(req, res, next), ah(async (req, res) => {
    const body = req.body || {};
    const amountCents = v.amount(body, 'amount', { label: '金额' });
    const currency = v.oneOf(String(body.currency || 'USD').toUpperCase(), ['USD'], '币种');
    const reference = v.str(body, 'reference', { max: 80, label: '商户订单号' });
    const description = v.str(body, 'description', { max: 200, label: '商品描述' });
    const customerEmail = v.str(body, 'customer_email', { max: 120, label: '付款人邮箱' }).toLowerCase();
    if (customerEmail && !sec.isValidEmail(customerEmail)) throw badRequest('EMAIL_INVALID', '付款人邮箱格式不正确');
    const successUrl = body.success_url ? validateUrl(body.success_url) : '';
    const cancelUrl = body.cancel_url ? validateUrl(body.cancel_url) : '';
    const metadata = body.metadata === undefined ? {} : body.metadata;
    if (typeof metadata !== 'object' || Array.isArray(metadata) || metadata === null) throw badRequest('METADATA_INVALID', 'metadata 必须是对象');
    const metadataJson = JSON.stringify(metadata);
    if (metadataJson.length > 2000) throw badRequest('METADATA_TOO_LARGE', 'metadata 序列化后不能超过 2KB');

    if (reference) {
      const ex = db.prepare('SELECT * FROM merchant_payments WHERE merchant_id = ? AND reference = ?').get(req.merchant.id, reference);
      if (ex) {
        if (ex.amount_cents === amountCents && ex.currency === currency) return res.json({ ok: true, payment: paymentView(ex, req), duplicate: true });
        throw conflict('REFERENCE_CONFLICT', '商户订单号已用于另一笔支付，请换一个新的 reference');
      }
    }
    const ref = reference || 'ref_' + crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(24).toString('base64url');
    let r;
    try {
      r = db.prepare(`INSERT INTO merchant_payments (merchant_id, reference, amount_cents, currency, status, customer_email, description, metadata_json, success_url, cancel_url, checkout_token, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(req.merchant.id, ref, amountCents, currency, 'CREATED', customerEmail || null, description || null, metadataJson, successUrl || null, cancelUrl || null, token, now(), now());
    } catch (e) {
      // 并发创建同一 reference：数据库唯一约束兜底
      if (/UNIQUE|constraint/i.test(String(e.message))) throw conflict('REFERENCE_CONFLICT', '商户订单号已用于另一笔支付，请换一个新的 reference');
      throw e;
    }
    const p = db.prepare('SELECT * FROM merchant_payments WHERE id = ?').get(r.lastInsertRowid);
    res.status(201).json({ ok: true, payment: paymentView(p, req) });
  }));

  app.get('/api/v1/payments/:id', ...api, (req, res) => {
    const id = apiId(req.params.id);
    const p = db.prepare('SELECT * FROM merchant_payments WHERE id = ? AND merchant_id = ?').get(id, req.merchant.id);
    if (!p) throw notFound('PAYMENT_NOT_FOUND', '支付单不存在');
    const refunds = db.prepare('SELECT * FROM merchant_refunds WHERE payment_id = ? ORDER BY id DESC').all(id);
    res.json({ ok: true, payment: paymentView(p, req), refunds: refunds.map(refundView) });
  });

  app.get('/api/v1/payments', ...api, (req, res) => {
    const limit = v.intInRange(req.query.limit, { min: 1, max: 100, def: 20, label: '每页条数' });
    const after = req.query.starting_after ? apiId(req.query.starting_after) : null;
    const status = req.query.status ? v.oneOf(String(req.query.status), Object.keys(state.MACHINES.merchant_payment), '状态') : '';
    let rows = db.prepare('SELECT * FROM merchant_payments WHERE merchant_id = ? ORDER BY id DESC').all(req.merchant.id);
    if (status) rows = rows.filter((p) => p.status === status);
    if (after !== null) rows = rows.filter((p) => p.id < after);
    const items = rows.slice(0, limit).map((p) => paymentView(p, req));
    res.json({ ok: true, items, has_more: rows.length > limit, next_starting_after: items.length ? `pay_${items[items.length - 1].numeric_id}` : null });
  });

  app.post('/api/v1/payments/:id/refund', ...api, (req, res, next) => idempotent(db, `v1_refund_${req.merchant.id}`)(req, res, next), (req, res) => {
    const id = apiId(req.params.id);
    const p = db.prepare('SELECT * FROM merchant_payments WHERE id = ? AND merchant_id = ?').get(id, req.merchant.id);
    if (!p) throw notFound('PAYMENT_NOT_FOUND', '支付单不存在');
    const amountCents = req.body && req.body.amount !== undefined && req.body.amount !== '' ? v.amount(req.body, 'amount', { label: '退款金额' }) : p.amount_cents - p.refunded_cents;
    const out = doRefund({ payment: p, amountCents, reason: (req.body && req.body.reason) || '商户发起退款', req, merchant: req.merchant });
    res.json({ ok: true, refund: refundView(out.refund), payment: paymentView(out.payment, req) });
  });

  app.get('/api/v1/balance', ...api, (req, res) => {
    res.json({ ok: true, balance: balanceView(req.merchant.id) });
  });

  app.get('/api/v1/payouts', ...api, (req, res) => {
    const rows = db.prepare('SELECT * FROM merchant_payouts WHERE merchant_id = ? ORDER BY id DESC').all(req.merchant.id).slice(0, 50);
    res.json({ ok: true, items: rows.map(payoutView), balance: balanceView(req.merchant.id) });
  });

  app.post('/api/v1/payouts', ...api, (req, res, next) => idempotent(db, `v1_payout_${req.merchant.id}`)(req, res, next), (req, res) => {
    const amountCents = v.amount(req.body, 'amount', { label: '提现金额' });
    const destination = v.str(req.body, 'destination', { max: 80, label: '收款账户', default: '' });
    const out = createPayout({ merchant: req.merchant, amountCents, destination, actorId: null, req });
    res.status(201).json({ ok: true, payout: payoutView(out) });
  });

  // 结账（付款人视角，公开读取 + 登录付款）
  app.get('/api/checkout/:token', (req, res) => {
    const p = findCheckout(req.params.token);
    res.json({ ok: true, payment: checkoutView(p, req) });
  });

  app.post('/api/checkout/:token/pay', auth, requireActive, requirePin,
    (req, res, next) => idempotent(db, `checkout_pay_${req.user.id}`)(req, res, next), (req, res) => {
      const p = findCheckout(req.params.token);
      if (p.status !== 'CREATED') throw conflict('PAYMENT_NOT_PAYABLE', `该支付单当前状态为「${state.LABELS[p.status] || p.status}」，不能付款`);
      if (now() - p.created_at > PAYMENT_TTL_MS) throw conflict('PAYMENT_EXPIRED', '支付单已过期，请让商户重新创建');
      const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(p.merchant_id);
      if (!m || m.status !== 'ACTIVE') throw conflict('MERCHANT_INACTIVE', '商户暂不可收款');
      if (p.customer_email && p.customer_email !== req.user.email) throw forbidden('CUSTOMER_MISMATCH', '该支付单指定了其他付款人');
      const out = withTransaction(() => {
        const upd = db.prepare("UPDATE merchant_payments SET status = 'SUCCEEDED', customer_user_id = ?, paid_at = ?, updated_at = ? WHERE id = ? AND status = 'CREATED'")
          .run(req.user.id, now(), now(), p.id);
        if (!upd.changes) throw conflict('PAYMENT_NOT_PAYABLE', '该支付单已被处理，请刷新后查看');
        const mv = wallet.applyCash(db, {
          userId: req.user.id, delta: -p.amount_cents, type: 'pay', merchant: m.name, category: '购物',
          description: p.description || `向 ${m.name} 付款`, refType: 'merchant_payment', refId: p.id,
          journalType: 'merchant_payment', contra: PAYABLE, contraUserId: m.id,
        });
        db.prepare('UPDATE merchant_payments SET transaction_id = ? WHERE id = ?').run(mv.transactionId, p.id);
        return mv;
      });
      const paid = db.prepare('SELECT * FROM merchant_payments WHERE id = ?').get(p.id);
      notify.notify(db, { userId: req.user.id, kind: 'payment', title: `付款成功 ${fmt(p.amount_cents)}`, body: `向 ${m.name} 付款 ${fmt(p.amount_cents)}`, refType: 'merchant_payment', refId: p.id, log: req.log });
      if (m.owner_user_id) notify.notify(db, { userId: m.owner_user_id, kind: 'sale', title: `收到一笔付款 ${fmt(p.amount_cents)}`, body: `支付单 ${p.reference}`, refType: 'merchant_payment', refId: p.id, log: req.log });
      enqueueWebhook(m, 'payment.succeeded', paymentView(paid, req));
      res.json({ ok: true, message: '付款成功', payment: paymentView(paid, req), balance_cents: out.balance, transaction_id: out.transactionId, success_url: paid.success_url || null });
    });

  app.post('/api/checkout/:token/cancel', auth, (req, res) => {
    const p = findCheckout(req.params.token);
    if (p.status !== 'CREATED') throw conflict('PAYMENT_NOT_CANCELABLE', '该支付单不能取消');
    if (p.customer_email && p.customer_email !== req.user.email) throw forbidden('CUSTOMER_MISMATCH', '无权取消该支付单');
    db.prepare("UPDATE merchant_payments SET status = 'CANCELED', updated_at = ? WHERE id = ? AND status = 'CREATED'").run(now(), p.id);
    res.json({ ok: true, message: '已取消', cancel_url: p.cancel_url || null });
  });

  function findCheckout(token) {
    const t = String(token || '').trim();
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(t)) throw notFound('PAYMENT_NOT_FOUND', '支付链接无效');
    const p = db.prepare('SELECT * FROM merchant_payments WHERE checkout_token = ?').get(t);
    if (!p) throw notFound('PAYMENT_NOT_FOUND', '支付链接无效或已失效');
    return expireIfNeeded(p);
  }

  function checkoutView(p, req) {
    const m = db.prepare('SELECT id, name, website, status FROM merchants WHERE id = ?').get(p.merchant_id) || { name: '商户' };
    return {
      id: `pay_${p.id}`, reference: p.reference, amount_cents: p.amount_cents, amount: money.centsToDecimal(p.amount_cents),
      currency: p.currency, status: p.status, description: p.description || null, customer_email: p.customer_email || null,
      merchant: { name: m.name, website: m.website || null }, expires_at: p.created_at + PAYMENT_TTL_MS,
      created_at: p.created_at, paid_at: p.paid_at || null,
    };
  }

  // ============================================================
  // 退款 / 结算
  // ============================================================
  function refundView(r) {
    return { id: `ref_${r.id}`, numeric_id: r.id, payment_id: r.payment_id, amount_cents: r.amount_cents, amount: money.centsToDecimal(r.amount_cents), reason: r.reason || null, status: r.status, created_at: r.created_at };
  }

  function doRefund({ payment, amountCents, reason, req, merchant }) {
    if (!['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(payment.status)) {
      throw badRequest('PAYMENT_NOT_REFUNDABLE', '只有已成功的支付才能退款');
    }
    const remaining = payment.amount_cents - payment.refunded_cents;
    if (remaining <= 0) throw badRequest('REFUND_EXCEEDS_REMAINING', '该支付已全额退款');
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw badRequest('AMOUNT_INVALID', '退款金额格式不正确');
    if (amountCents > remaining) throw badRequest('REFUND_EXCEEDS_REMAINING', `退款金额超过可退余额：最多可退 ${fmt(remaining)}`, { refundable_cents: remaining });
    const available = payableOf(merchant.id);
    if (available < amountCents) throw badRequest('INSUFFICIENT_MERCHANT_BALANCE', `商户可结算余额不足，当前 ${fmt(available)}`);
    const nextStatus = payment.refunded_cents + amountCents === payment.amount_cents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    state.assertTransition('merchant_payment', payment.status, nextStatus);
    const out = withTransaction(() => {
      const upd = db.prepare('UPDATE merchant_payments SET refunded_cents = refunded_cents + ?, status = ?, updated_at = ? WHERE id = ? AND refunded_cents = ?')
        .run(amountCents, nextStatus, now(), payment.id, payment.refunded_cents);
      if (!upd.changes) throw conflict('CONCURRENT_MODIFICATION', '该支付刚刚被退款，请刷新后重试');
      const rf = db.prepare('INSERT INTO merchant_refunds (payment_id, merchant_id, amount_cents, reason, status, created_at) VALUES (?,?,?,?,?,?)')
        .run(payment.id, merchant.id, amountCents, reason || null, 'SUCCEEDED', now());
      let mv = null;
      if (payment.customer_user_id) {
        mv = wallet.applyCash(db, {
          userId: payment.customer_user_id, delta: amountCents, type: 'refund', merchant: merchant.name, category: '退款',
          description: `${merchant.name} 退款（支付 #${payment.id}）${reason ? '：' + reason : ''}`,
          refType: 'merchant_refund', refId: rf.lastInsertRowid, journalType: 'merchant_refund', contra: PAYABLE, contraUserId: merchant.id,
        });
        db.prepare('UPDATE merchant_refunds SET transaction_id = ? WHERE id = ?').run(mv.transactionId, rf.lastInsertRowid);
        if (payment.transaction_id) db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run(nextStatus, payment.transaction_id);
      } else {
        // 付款人账户已不存在：只减商户待结算，资金回到平台外部科目
        ledger.post(db, {
          journalType: 'merchant_refund', refType: 'merchant_payment', refId: payment.id,
          entries: [{ account: PAYABLE, user_id: merchant.id, amount_cents: -amountCents }, { account: 'external:merchants', amount_cents: amountCents }],
          memo: `支付 #${payment.id} 退款（付款人已注销）`,
        });
      }
      return { refund: db.prepare('SELECT * FROM merchant_refunds WHERE id = ?').get(rf.lastInsertRowid), mv };
    });
    const updated = db.prepare('SELECT * FROM merchant_payments WHERE id = ?').get(payment.id);
    if (payment.customer_user_id) {
      notify.notify(db, { userId: payment.customer_user_id, kind: 'refund', title: `收到退款 ${fmt(amountCents)}`, body: `${merchant.name} 退款`, refType: 'merchant_refund', refId: out.refund.id, log: req && req.log });
    }
    enqueueWebhook(merchant, 'payment.refunded', paymentView(updated, req));
    if (req) oplog.record(db, req, { action: 'merchant.refund', target_type: 'merchant_payment', target_id: payment.id, amount_cents: amountCents, reason: reason || null });
    return { refund: out.refund, payment: updated };
  }

  function balanceView(merchantId) {
    return {
      available_cents: payableOf(merchantId), available: money.centsToDecimal(payableOf(merchantId)),
      pending_payout_cents: pendingPayoutOf(merchantId), pending_payout: money.centsToDecimal(pendingPayoutOf(merchantId)),
      currency: 'USD',
    };
  }

  function createPayout({ merchant, amountCents, destination, actorId, req }) {
    const available = payableOf(merchant.id);
    if (amountCents > available) throw badRequest('INSUFFICIENT_MERCHANT_BALANCE', `可结算余额不足，当前 ${fmt(available)}`, { available_cents: available });
    const r = withTransaction(() => {
      const ins = db.prepare('INSERT INTO merchant_payouts (merchant_id, amount_cents, status, destination, requested_by, created_at) VALUES (?,?,?,?,?,?)')
        .run(merchant.id, amountCents, 'PENDING', destination || null, actorId || null, now());
      ledger.post(db, {
        journalType: 'merchant_payout_hold', refType: 'merchant_payout', refId: ins.lastInsertRowid,
        entries: [{ account: PAYABLE, user_id: merchant.id, amount_cents: -amountCents }, { account: PAYOUT_CLEARING, amount_cents: amountCents }],
        memo: `商户结算提现 #${ins.lastInsertRowid}`,
      });
      return ins.lastInsertRowid;
    });
    if (req) oplog.record(db, req, { action: 'merchant.payout.create', target_type: 'merchant_payout', target_id: r, amount_cents: amountCents });
    return db.prepare('SELECT * FROM merchant_payouts WHERE id = ?').get(r);
  }

  function payoutView(p) {
    return {
      id: `po_${p.id}`, numeric_id: p.id, merchant_id: p.merchant_id, amount_cents: p.amount_cents, amount: money.centsToDecimal(p.amount_cents),
      status: p.status, destination: p.destination || null, review_note: p.review_note || null,
      created_at: p.created_at, reviewed_at: p.reviewed_at || null,
    };
  }

  // ============================================================
  // 商户后台（会话 + RBAC）
  // ============================================================
  const mread = [auth, requirePerm('merchant.read')];
  const mwrite = [auth, requirePerm('merchant.write')];

  app.post('/api/merchant/apply', auth, (req, res) => {
    const me = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(req.user.id);
    if (merchantOfUser(me.id)) throw conflict('MERCHANT_EXISTS', '该账户已提交过商户申请或已是商户');
    const name = v.str(req.body, 'name', { required: true, min: 2, max: 60, label: '商户名称' });
    const website = req.body && req.body.website ? validateUrl(req.body.website) : '';
    const description = v.str(req.body, 'description', { max: 300, label: '商户简介' });
    if (db.prepare('SELECT id FROM merchants WHERE email = ?').get(me.email)) throw conflict('MERCHANT_EMAIL_TAKEN', '该邮箱已被其他商户使用');
    db.prepare('INSERT INTO merchants (name, email, owner_user_id, status, website, description, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(name, me.email, me.id, 'PENDING', website || null, description || null, now(), now());
    const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
    for (const a of admins) notify.push(db, { userId: a.id, kind: 'merchant', title: '新的商户入驻申请', body: `${name}（${me.email}）`, refType: 'merchant_apply', refId: me.id });
    res.status(201).json({ ok: true, message: '申请已提交，等待运营审核', status: 'PENDING' });
  });

  // 任何登录用户都可以查询自己的商户状态（申请中 / 已通过 / 未申请）
  app.get('/api/merchant/status', auth, (req, res) => {
    const m = merchantOfUser(req.user.id);
    res.json({ ok: true, merchant: m ? { ...merchantView(m), webhook_configured: !!m.webhook_url } : null, can_apply: !m });
  });

  app.get('/api/merchant/profile', ...mread, requireMerchant, (req, res) => {
    res.json({ ok: true, merchant: merchantView(req.merchant), balance: balanceView(req.merchant.id) });
  });

  app.patch('/api/merchant/profile', ...mwrite, requireMerchant, (req, res) => {
    const b = req.body || {};
    const name = b.name !== undefined ? v.str(b, 'name', { required: true, min: 2, max: 60, label: '商户名称' }) : req.merchant.name;
    const website = b.website !== undefined ? validateUrl(b.website) : (req.merchant.website || '');
    const description = b.description !== undefined ? v.str(b, 'description', { max: 300, label: '商户简介' }) : (req.merchant.description || '');
    const webhookUrl = b.webhook_url !== undefined ? validateWebhookUrl(b.webhook_url) : (req.merchant.webhook_url || '');
    db.prepare('UPDATE merchants SET name = ?, website = ?, description = ?, webhook_url = ?, updated_at = ? WHERE id = ?')
      .run(name, website || null, description || null, webhookUrl || null, now(), req.merchant.id);
    res.json({ ok: true, message: '商户资料已更新', merchant: merchantView(db.prepare('SELECT * FROM merchants WHERE id = ?').get(req.merchant.id)) });
  });

  app.post('/api/merchant/webhook-secret', ...mwrite, requireMerchant, (req, res) => {
    const secret = 'whsec_' + crypto.randomBytes(24).toString('base64url');
    db.prepare('UPDATE merchants SET webhook_secret = ?, updated_at = ? WHERE id = ?').run(secret, now(), req.merchant.id);
    oplog.record(db, req, { action: 'merchant.webhook_secret', target_type: 'merchant', target_id: req.merchant.id });
    res.json({ ok: true, message: 'Webhook 签名密钥已重置，请立即更新你的服务端配置', webhook_secret: secret });
  });

  app.get('/api/merchant/keys', ...mread, requireMerchant, (req, res) => {
    const rows = db.prepare('SELECT id, key_id, label, mode, last_used_at, revoked_at, created_at FROM merchant_keys WHERE merchant_id = ? ORDER BY id DESC').all(req.merchant.id);
    res.json({ ok: true, items: rows.map((k) => ({ ...k, masked: `sp_${k.mode}_${k.key_id}_${'•'.repeat(12)}` })) });
  });

  app.post('/api/merchant/keys', ...mwrite, requireMerchant, (req, res) => {
    const label = v.str(req.body, 'label', { max: 40, label: '备注' });
    const mode = v.oneOf(String((req.body && req.body.mode) || 'live'), ['live', 'test'], '密钥类型');
    const k = sec.generateApiKey(mode);
    db.prepare('INSERT INTO merchant_keys (merchant_id, key_id, secret_hash, label, mode, created_at) VALUES (?,?,?,?,?,?)')
      .run(req.merchant.id, k.keyId, k.hash, label || null, mode, now());
    oplog.record(db, req, { action: 'merchant.key.create', target_type: 'merchant', target_id: req.merchant.id, reason: `${mode} ${label || ''}`.trim() });
    res.status(201).json({ ok: true, message: '密钥已创建，请立即复制保存（只显示这一次）', key: { token: k.token, key_id: k.keyId, mode, label: label || null } });
  });

  app.post('/api/merchant/keys/:id/revoke', ...mwrite, requireMerchant, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('ID_INVALID', '密钥编号格式不正确');
    const r = db.prepare('UPDATE merchant_keys SET revoked_at = ? WHERE id = ? AND merchant_id = ? AND revoked_at IS NULL').run(now(), id, req.merchant.id);
    if (!r.changes) throw notFound('KEY_NOT_FOUND', '密钥不存在或已吊销');
    oplog.record(db, req, { action: 'merchant.key.revoke', target_type: 'merchant', target_id: req.merchant.id, reason: `key #${id}` });
    res.json({ ok: true, message: '密钥已吊销' });
  });

  app.get('/api/merchant/payments', ...mread, requireMerchant, (req, res) => {
    const page = v.intInRange(req.query.page, { min: 1, max: 100000, def: 1, label: '页码' });
    const pageSize = v.intInRange(req.query.page_size, { min: 1, max: 100, def: 20, label: '每页条数' });
    const status = req.query.status ? v.oneOf(String(req.query.status), Object.keys(state.MACHINES.merchant_payment), '状态') : '';
    let rows = db.prepare('SELECT * FROM merchant_payments WHERE merchant_id = ? ORDER BY id DESC').all(req.merchant.id);
    if (status) rows = rows.filter((p) => p.status === status);
    res.json({
      ok: true, page, page_size: pageSize, filtered_total: rows.length,
      items: rows.slice((page - 1) * pageSize, page * pageSize).map((p) => paymentView(p, req)),
      balance: balanceView(req.merchant.id),
    });
  });

  app.get('/api/merchant/payments/:id', ...mread, requireMerchant, (req, res) => {
    const p = merchantPayment(req);
    const refunds = db.prepare('SELECT * FROM merchant_refunds WHERE payment_id = ? ORDER BY id DESC').all(p.id);
    const payer = p.customer_user_id ? db.prepare('SELECT email FROM users WHERE id = ?').get(p.customer_user_id) : null;
    res.json({ ok: true, payment: paymentView(p, req), refunds: refunds.map(refundView), payer_email: payer ? payer.email : p.customer_email });
  });

  app.post('/api/merchant/payments/:id/refunds', ...mwrite, requirePerm('merchant.refund'), requireMerchant,
    idempotent(db, 'merchant_refund'), (req, res) => {
      const p = merchantPayment(req);
      const amountInput = req.body && req.body.amount;
      const reason = v.str(req.body, 'reason', { required: true, min: 2, max: 200, label: '退款原因' });
      const amountCents = amountInput === undefined || amountInput === '' ? p.amount_cents - p.refunded_cents : v.amount(req.body, 'amount', { label: '退款金额' });
      if (!requireConfirmation(req, res, {
        action: 'merchant.refund', params: { id: p.id, amount_cents: amountCents, reason, refunded_before: p.refunded_cents },
        summary: { title: '确认退款', lines: [['支付单', `pay_${p.id}（${p.reference}）`], ['原支付金额', fmt(p.amount_cents)], ['已退金额', fmt(p.refunded_cents)], ['本次退款', fmt(amountCents)], ['原因', reason]] },
      })) return;
      const out = doRefund({ payment: p, amountCents, reason, req, merchant: req.merchant });
      res.json({ ok: true, message: `已退款 ${fmt(amountCents)}`, refund: refundView(out.refund), payment: paymentView(out.payment, req) });
    });

  app.get('/api/merchant/payouts', ...mread, requireMerchant, (req, res) => {
    const rows = db.prepare('SELECT * FROM merchant_payouts WHERE merchant_id = ? ORDER BY id DESC').all(req.merchant.id).slice(0, 100);
    res.json({ ok: true, items: rows.map(payoutView), balance: balanceView(req.merchant.id) });
  });

  app.post('/api/merchant/payouts', ...mwrite, requirePerm('merchant.payout'), requireMerchant,
    idempotent(db, 'merchant_payout'), (req, res) => {
      const amountCents = v.amount(req.body, 'amount', { label: '提现金额' });
      const destination = v.str(req.body, 'destination', { max: 80, label: '收款账户' });
      if (amountCents > payableOf(req.merchant.id)) throw badRequest('INSUFFICIENT_MERCHANT_BALANCE', `可结算余额不足，当前 ${fmt(payableOf(req.merchant.id))}`);
      if (!requireConfirmation(req, res, {
        action: 'merchant.payout', params: { amount_cents: amountCents, destination },
        summary: { title: '确认结算提现', lines: [['提现金额', fmt(amountCents)], ['收款账户', destination || '—'], ['到账方式', '需财务审核，审核通过后出款'], ['提现后可用余额', fmt(payableOf(req.merchant.id) - amountCents)]] },
      })) return;
      const p = createPayout({ merchant: req.merchant, amountCents, destination, actorId: req.user.id, req });
      res.json({ ok: true, message: '结算提现已提交，等待审核', payout: payoutView(p), balance: balanceView(req.merchant.id) });
    });

  app.get('/api/merchant/webhook-deliveries', ...mread, requireMerchant, (req, res) => {
    const rows = db.prepare('SELECT * FROM webhook_deliveries WHERE merchant_id = ? ORDER BY id DESC').all(req.merchant.id).slice(0, 100);
    res.json({ ok: true, items: rows.map((d) => ({ id: d.id, event_id: d.event_id, event_type: d.event_type, status: d.status, attempts: d.attempts, last_status_code: d.last_status_code, last_error: d.last_error, next_attempt_at: d.next_attempt_at, created_at: d.created_at, delivered_at: d.delivered_at })) });
  });

  app.post('/api/merchant/webhook-deliveries/:id/retry', ...mwrite, requireMerchant, (req, res) => {
    const id = Number(req.params.id);
    const d = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ? AND merchant_id = ?').get(id, req.merchant.id);
    if (!d) throw notFound('DELIVERY_NOT_FOUND', '投递记录不存在');
    db.prepare("UPDATE webhook_deliveries SET status = 'PENDING', next_attempt_at = ? WHERE id = ?").run(now(), id);
    setImmediate(() => deliverWebhook(id).catch(() => {}));
    res.json({ ok: true, message: '已重新投递' });
  });

  app.get('/api/merchant/api-logs', ...mread, requireMerchant, (req, res) => {
    const rows = db.prepare('SELECT * FROM api_logs WHERE merchant_id = ? ORDER BY id DESC').all(req.merchant.id).slice(0, 100);
    res.json({ ok: true, items: rows });
  });

  app.get('/api/merchant/summary', ...mread, requireMerchant, (req, res) => {
    const payments = db.prepare('SELECT * FROM merchant_payments WHERE merchant_id = ?').all(req.merchant.id);
    const ok = payments.filter((p) => ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status));
    const gross = ok.reduce((s, p) => s + p.amount_cents, 0);
    const refunded = ok.reduce((s, p) => s + p.refunded_cents, 0);
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const today = ok.filter((p) => p.paid_at && p.paid_at >= todayStart.getTime());
    res.json({
      ok: true,
      kpis: {
        payments_total: payments.length, payments_paid: ok.length, payments_pending: payments.filter((p) => p.status === 'CREATED').length,
        gross_cents: gross, refunded_cents: refunded, net_cents: gross - refunded,
        today_count: today.length, today_cents: today.reduce((s, p) => s + p.amount_cents, 0),
        balance: balanceView(req.merchant.id),
      },
      merchant: merchantView(req.merchant),
    });
  });

  // ============================================================
  // 运营后台：商户审批、结算审核
  // ============================================================
  const read = [auth, requirePerm('console.read')];

  app.get('/api/admin/merchants', ...read, (req, res) => {
    const status = req.query.status ? v.oneOf(String(req.query.status), ['PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED'], '状态') : '';
    let rows = db.prepare('SELECT * FROM merchants ORDER BY id DESC').all();
    if (status) rows = rows.filter((m) => m.status === status);
    const ownerEmails = new Map(db.prepare('SELECT id, email FROM users').all().map((u) => [u.id, u.email]));
    res.json({
      ok: true, filtered_total: rows.length,
      items: rows.map((m) => ({ ...merchantView(m), owner_email: m.owner_user_id ? ownerEmails.get(m.owner_user_id) || null : null, available_cents: payableOf(m.id), pending_payout_cents: pendingPayoutOf(m.id) })),
    });
  });

  app.post('/api/admin/merchants/:id/approve', auth, requirePerm('merchant.manage'), (req, res) => {
    const id = Number(req.params.id);
    const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(id);
    if (!m) throw notFound('MERCHANT_NOT_FOUND', '商户不存在');
    state.assertTransition('merchant', m.status, 'ACTIVE');
    if (!requireConfirmation(req, res, {
      action: 'merchant.approve', params: { id },
      summary: { title: '确认通过商户入驻', lines: [['商户', m.name], ['邮箱', m.email], ['当前状态', state.LABELS[m.status] || m.status], ['变更为', '正常'], ['影响', '通过后商户可创建 API Key、收款与申请结算']] },
    })) return;
    const secret = m.webhook_secret || 'whsec_' + crypto.randomBytes(24).toString('base64url');
    withTransaction(() => {
      db.prepare("UPDATE merchants SET status = 'ACTIVE', webhook_secret = ?, updated_at = ? WHERE id = ? AND status = ?").run(secret, now(), id, m.status);
      if (m.owner_user_id) {
        const u = db.prepare('SELECT role FROM users WHERE id = ?').get(m.owner_user_id);
        if (u && u.role !== 'admin') db.prepare("UPDATE users SET role = 'merchant' WHERE id = ?").run(m.owner_user_id);
      }
    });
    if (m.owner_user_id) notify.push(db, { userId: m.owner_user_id, kind: 'merchant', title: '商户入驻已通过', body: '你可以创建 API Key 并开始收款了', refType: 'merchant', refId: id });
    oplog.record(db, req, { action: 'merchant.approve', target_type: 'merchant', target_id: id });
    res.json({ ok: true, message: '商户已通过审核', merchant: merchantView(db.prepare('SELECT * FROM merchants WHERE id = ?').get(id)) });
  });

  app.post('/api/admin/merchants/:id/reject', auth, requirePerm('merchant.manage'), (req, res) => {
    const id = Number(req.params.id);
    const reason = v.str(req.body, 'reason', { required: true, min: 2, max: 200, label: '原因' });
    const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(id);
    if (!m) throw notFound('MERCHANT_NOT_FOUND', '商户不存在');
    state.assertTransition('merchant', m.status, 'REJECTED');
    db.prepare("UPDATE merchants SET status = 'REJECTED', updated_at = ? WHERE id = ?").run(now(), id);
    if (m.owner_user_id) notify.push(db, { userId: m.owner_user_id, kind: 'merchant', title: '商户入驻未通过', body: reason, refType: 'merchant', refId: id });
    oplog.record(db, req, { action: 'merchant.reject', target_type: 'merchant', target_id: id, reason });
    res.json({ ok: true, message: '已拒绝申请' });
  });

  app.post('/api/admin/merchants/:id/suspend', auth, requirePerm('merchant.manage'), (req, res) => {
    const id = Number(req.params.id);
    const reason = v.str(req.body, 'reason', { required: true, min: 2, max: 200, label: '原因' });
    const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(id);
    if (!m) throw notFound('MERCHANT_NOT_FOUND', '商户不存在');
    state.assertTransition('merchant', m.status, 'SUSPENDED');
    db.prepare("UPDATE merchants SET status = 'SUSPENDED', updated_at = ? WHERE id = ?").run(now(), id);
    oplog.record(db, req, { action: 'merchant.suspend', target_type: 'merchant', target_id: id, reason });
    res.json({ ok: true, message: '商户已暂停' });
  });

  app.post('/api/admin/merchants/:id/activate', auth, requirePerm('merchant.manage'), (req, res) => {
    const id = Number(req.params.id);
    const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(id);
    if (!m) throw notFound('MERCHANT_NOT_FOUND', '商户不存在');
    state.assertTransition('merchant', m.status, 'ACTIVE');
    db.prepare("UPDATE merchants SET status = 'ACTIVE', updated_at = ? WHERE id = ?").run(now(), id);
    oplog.record(db, req, { action: 'merchant.activate', target_type: 'merchant', target_id: id });
    res.json({ ok: true, message: '商户已恢复' });
  });

  app.get('/api/admin/merchant-payouts', ...read, (req, res) => {
    const status = req.query.status ? v.oneOf(String(req.query.status), ['PENDING', 'SUCCEEDED', 'FAILED'], '状态') : '';
    let rows = db.prepare('SELECT * FROM merchant_payouts ORDER BY id DESC').all();
    if (status) rows = rows.filter((p) => p.status === status);
    const names = new Map(db.prepare('SELECT id, name FROM merchants').all().map((m) => [m.id, m.name]));
    res.json({ ok: true, filtered_total: rows.length, items: rows.slice(0, 200).map((p) => ({ ...payoutView(p), merchant_name: names.get(p.merchant_id) || null })) });
  });

  function reviewPayout(approve) {
    return (req, res) => {
      const id = Number(req.params.id);
      const reason = v.str(req.body, 'reason', approve ? { max: 200, label: '备注' } : { required: true, min: 2, max: 200, label: '驳回原因' });
      const p = db.prepare('SELECT * FROM merchant_payouts WHERE id = ?').get(id);
      if (!p) throw notFound('PAYOUT_NOT_FOUND', '结算提现不存在');
      const m = db.prepare('SELECT * FROM merchants WHERE id = ?').get(p.merchant_id);
      if (!m) throw notFound('MERCHANT_NOT_FOUND', '商户不存在');
      state.assertTransition('merchant_payout', p.status, approve ? 'SUCCEEDED' : 'FAILED');
      if (!requireConfirmation(req, res, {
        action: approve ? 'merchant_payout.approve' : 'merchant_payout.reject', params: { id, reason },
        summary: { title: approve ? '确认批准结算提现' : '确认驳回结算提现', lines: [['商户', m.name], ['金额', fmt(p.amount_cents)], ['收款账户', p.destination || '—'], ['结果', approve ? '批准：资金出款（模拟）' : '驳回：资金退回商户可结算余额']] },
      })) return;
      withTransaction(() => {
        const upd = db.prepare('UPDATE merchant_payouts SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = ? WHERE id = ? AND status = ?')
          .run(approve ? 'SUCCEEDED' : 'FAILED', req.user.id, reason || null, now(), id, 'PENDING');
        if (!upd.changes) throw conflict('CONCURRENT_MODIFICATION', '该提现已被其他人处理，请刷新');
        ledger.post(db, {
          journalType: approve ? 'merchant_payout_paid' : 'merchant_payout_reversal', refType: 'merchant_payout', refId: id,
          entries: approve
            ? [{ account: PAYOUT_CLEARING, amount_cents: -p.amount_cents }, { account: 'external:merchant_payouts', amount_cents: p.amount_cents }]
            : [{ account: PAYOUT_CLEARING, amount_cents: -p.amount_cents }, { account: PAYABLE, user_id: m.id, amount_cents: p.amount_cents }],
          memo: `商户结算 #${id} ${approve ? '出款' : '驳回退回'}`,
        });
      });
      if (m.owner_user_id) notify.push(db, { userId: m.owner_user_id, kind: 'payout', title: approve ? `结算提现已出款 ${fmt(p.amount_cents)}` : `结算提现被驳回 ${fmt(p.amount_cents)}`, body: reason || '', refType: 'merchant_payout', refId: id });
      oplog.record(db, req, { action: approve ? 'merchant.payout.approve' : 'merchant.payout.reject', target_type: 'merchant_payout', target_id: id, amount_cents: p.amount_cents, reason: reason || null });
      res.json({ ok: true, message: approve ? '已批准出款' : '已驳回，资金退回商户余额', payout: payoutView(db.prepare('SELECT * FROM merchant_payouts WHERE id = ?').get(id)) });
    };
  }
  app.post('/api/admin/merchant-payouts/:id/approve', auth, requirePerm('merchant.payout.review'), reviewPayout(true));
  app.post('/api/admin/merchant-payouts/:id/reject', auth, requirePerm('merchant.payout.review'), reviewPayout(false));

  // ============================================================
  // 内部工具
  // ============================================================
  function apiId(raw) {
    const s = String(raw || '').replace(/^pay_/, '');
    const id = Number(s);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('ID_INVALID', '支付编号格式不正确');
    return id;
  }
  function validateUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (s.length > 300) throw badRequest('URL_INVALID', '地址过长');
    let u;
    try { u = new URL(s); } catch (_) { throw badRequest('URL_INVALID', '地址格式不正确'); }
    if (!['https:', 'http:'].includes(u.protocol)) throw badRequest('URL_INVALID', '地址必须是 http(s)');
    return u.toString();
  }

  return { start: () => { setInterval(() => { try { tick(); } catch (e) { logger.warn('merchant.tick_failed', { err: e }); } }, 60 * 1000).unref(); }, tick };
};

module.exports.payableOf = (db, merchantId) => {
  const r = db.prepare('SELECT SUM(amount_cents) AS s FROM ledger_entries WHERE account = ? AND user_id = ?').get('merchant:payable', merchantId);
  return (r && r.s) || 0;
};
module.exports.PAYOUT_CLEARING = PAYOUT_CLEARING;
module.exports.PAYABLE = PAYABLE;
