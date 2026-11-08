// SpacePay 投资模块（模拟交易，仅虚拟资金）
// 挂载方式：require('./invest')(app, { db, audit, withTransaction, sec, authz })
// 鉴权复用 src/auth.js；所有金额为整数分（src/money.js）；现金变动统一走 wallet.applyCash（含复式分录）；
// 每笔订单一个原子事务 + 幂等键；成本按 FIFO 批次核算。
const crypto = require('crypto');
const prod = require('./products');
const money = require('./money');
const wallet = require('./wallet');
const metrics = require('./metrics');
const logger = require('./logger');
const { AppError } = require('./errors');

const RISK_LEVELS = ['Conservative', 'Balanced', 'Growth', 'Aggressive'];
const RISK_ZH = { Conservative: '保守型', Balanced: '稳健型', Growth: '成长型', Aggressive: '进取型' };
const RISK_ORDER = { R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 };
const LEVEL_MAX_RISK = { Conservative: 'R2', Balanced: 'R3', Growth: 'R4', Aggressive: 'R5' };
// 建议配置（教育示例，非投资建议）：STOCK / ETF / FUND / GOLD / FIXED / CASH
const SUGGESTED = {
  Conservative: { STOCK: 5, ETF: 10, FUND: 45, GOLD: 5, FIXED: 15, CASH: 20 },
  Balanced: { STOCK: 15, ETF: 20, FUND: 30, GOLD: 5, FIXED: 10, CASH: 20 },
  Growth: { STOCK: 30, ETF: 25, FUND: 20, GOLD: 5, FIXED: 5, CASH: 15 },
  Aggressive: { STOCK: 45, ETF: 25, FUND: 10, GOLD: 10, FIXED: 0, CASH: 10 },
};
const QUIZ = [
  { q: '您计划这笔钱投资多久？', options: ['不到 1 年', '1–3 年', '3–5 年', '5–10 年', '10 年以上'] },
  { q: '如果投资一个月内下跌 20%，您会怎么做？', options: ['立即全部卖出', '卖出一部分', '持有不动', '补仓一点', '大幅补仓'] },
  { q: '您的收入稳定性如何？', options: ['不稳定', '一般', '稳定', '很稳定', '非常稳定且有结余'] },
  { q: '您的投资经验有多久？', options: ['没有经验', '不到 1 年', '1–3 年', '3–5 年', '5 年以上'] },
  { q: '您的投资目标主要是？', options: ['保住本金', '稳健增值', '平衡增长', '追求较高增长', '追求最高回报，不怕波动'] },
];
const CLASS_OF_TYPE = { STOCK: 'STOCK', ETF: 'ETF', FUND: 'FUND', GOLD: 'GOLD', FIXED_DEPOSIT: 'FIXED' };
const CLASS_ZH = { STOCK: '股票', ETF: 'ETF', FUND: '基金', GOLD: '黄金', FIXED: '定存', CASH: '现金' };
const TYPE_ZH = { STOCK: '股票', ETF: 'ETF', FUND: '基金', GOLD: '黄金', FIXED_DEPOSIT: '定存', BENCHMARK: '基准' };

function now() { return Date.now(); }
// 展示用：整数分 → "1,234.56"（不带货币符号，调用处自带 $）
function fmtC(c) { return money.formatCents(c).replace('$', ''); }
const PRODUCT_NOT_TRADEABLE = '产品不存在或不可交易';

// 下单数量：金额（2 位小数）或份数（3 位小数），全部按字符串解析为整数，不经过浮点
function parseQuantity(body, priceCents) {
  if (body.quantity_milli !== undefined) {
    const q = Number(body.quantity_milli);
    if (!Number.isInteger(q)) return { error: '数量格式不正确' };
    return { qtyMilli: q };
  }
  if (body.amount !== undefined) {
    const r = money.parseAmount(body.amount);
    if (!r.ok) return { error: r.message };
    return { qtyMilli: money.mulDiv(r.cents, 1000, priceCents) };
  }
  if (body.quantity !== undefined) {
    const r = money.parseDecimal(body.quantity, 3);
    if (!r.ok || r.value <= 0) return { error: '数量格式不正确，最多 3 位小数' };
    return { qtyMilli: r.value };
  }
  return { error: '请输入金额或数量' };
}

module.exports = function mountInvest(app, ctx) {
  const { db, audit, withTransaction, sec, authz } = ctx;
  const { auth, requireActive, requirePin } = authz;
  let ticking = false;
  let lastTickAt = null;
  let lastTickError = null;

  // --- 初始化：产品、30 天历史、sim_day 列（SQLite；JSON 后端忽略） ---
  try { db.exec('ALTER TABLE transactions ADD COLUMN sim_day INTEGER'); } catch (_) { /* 列已存在或 JSON 后端 */ }
  prod.ensureHistory(db);

  function cashOf(userId) {
    return wallet.balanceOf(db, userId);
  }
  function holdingsDetail(userId) {
    const day = prod.currentDay(db);
    const rows = db.prepare('SELECT product_id, quantity_milli FROM holdings WHERE user_id = ? AND quantity_milli > 0').all(userId);
    const out = [];
    for (const h of rows) {
      const p = prod.PRODUCT_MAP[h.product_id];
      if (!p) continue;
      const lots = db.prepare('SELECT quantity_milli, unit_cost_cents FROM holding_lots WHERE user_id = ? AND product_id = ? AND quantity_milli > 0 ORDER BY id ASC').all(userId, h.product_id);
      const costBasis = lots.reduce((s, l) => s + prod.holdingValue(l.quantity_milli, l.unit_cost_cents), 0);
      const price = prod.priceAt(p, day);
      const prev = prod.priceAt(p, day - 1);
      const value = prod.holdingValue(h.quantity_milli, price);
      const hist = prod.priceHistory(db, h.product_id, 14).map((x) => x.price_cents);
      out.push({
        product_id: h.product_id, name: p.name, type: p.type, risk: p.risk,
        quantity_milli: h.quantity_milli, quantity: h.quantity_milli / 1000,
        avg_cost_cents: h.quantity_milli ? money.mulDiv(costBasis, 1000, h.quantity_milli) : 0,
        cost_basis_cents: costBasis, price_cents: price,
        day_change_pct: prev ? ((price - prev) / prev) * 100 : 0,
        market_value_cents: value,
        unrealized_pl_cents: value - costBasis,
        unrealized_pct: costBasis ? ((value - costBasis) / costBasis) * 100 : 0,
        sparkline: hist,
      });
    }
    return out;
  }
  function realizedPl(userId) {
    const rows = db.prepare('SELECT realized_pl_cents FROM orders WHERE user_id = ? AND side = ?').all(userId, 'SELL');
    return rows.reduce((s, r) => s + (r.realized_pl_cents || 0), 0);
  }

  // ---------- 定时推进（由 server.start() 调用 startTicker 启动；测试中不启动） ----------
  function runTick() {
    if (ticking) return null;
    ticking = true;
    try {
      const day = prod.tick(db, audit, withTransaction);
      lastTickAt = new Date().toISOString();
      lastTickError = null;
      logger.info('invest.tick', { simulated_day: day });
      return day;
    } catch (e) {
      lastTickError = e.message;
      logger.error('invest.tick_failed', { err: e });
      return null;
    } finally { ticking = false; }
  }
  let tickTimer = null;
  function startTicker() {
    if (tickTimer) return;
    tickTimer = setInterval(runTick, prod.TICK_MS);
    if (tickTimer.unref) tickTimer.unref();
  }

  // ---------- 产品 ----------
  app.get('/api/products', auth, (req, res) => {
    const { day, prices } = prod.latestPrices(db);
    const watched = new Set(db.prepare('SELECT product_id FROM watchlist WHERE user_id = ?').all(req.user.id).map((r) => r.product_id));
    const list = prod.PRODUCTS.map((p) => {
      const price = prices[p.id].price_cents;
      const prev = prod.priceAt(p, day - 1);
      return {
        id: p.id, name: p.name, en: p.en, type: p.type, type_zh: TYPE_ZH[p.type] || p.type,
        risk: p.risk, risk_label: p.riskLabel, base_price_cents: p.base_price_cents,
        price_cents: price, day_change_pct: prev ? ((price - prev) / prev) * 100 : 0,
        dividend_yield: p.dividend_yield, tradeable: !!p.tradeable,
        rate_bps: p.rateBps || null, term_days: p.termDays || null,
        desc: p.desc, watched: watched.has(p.id),
        sparkline: prod.priceHistory(db, p.id, 14).map((x) => x.price_cents),
        simulated: true,
      };
    });
    res.json({ ok: true, simulated_day: day, tick_note: '模拟市场：每小时推进 1 个模拟日；价格为模拟价格', items: list });
  });

  app.get('/api/products/:id', auth, (req, res) => {
    const p = prod.PRODUCT_MAP[req.params.id];
    if (!p) return res.status(404).json({ ok: false, error: '产品不存在' });
    const day = prod.currentDay(db);
    const price = prod.priceAt(p, day);
    const prev = prod.priceAt(p, day - 1);
    const range = String(req.query.range || 'ALL');
    const points = prod.priceHistory(db, p.id, range === '1D' ? 2 : range === '1W' ? 8 : range === '1M' ? 31 : 400);
    res.json({
      ok: true, id: p.id, name: p.name, type: p.type, type_zh: TYPE_ZH[p.type], risk: p.risk,
      risk_label: p.riskLabel, desc: p.desc, mu: p.mu, sigma: p.sigma, dividend_yield: p.dividend_yield,
      rate_bps: p.rateBps || null, term_days: p.termDays || null, tradeable: !!p.tradeable,
      price_cents: price, day_change_pct: prev ? ((price - prev) / prev) * 100 : 0,
      simulated_day: day, history: points, simulated: true,
      note: '模拟漂移/波动率（年化）：μ=' + (p.mu * 100).toFixed(1) + '%，σ=' + (p.sigma * 100).toFixed(1) + '%，仅供练习，不代表真实收益。',
    });
  });

  // ---------- 组合总览 ----------
  app.get('/api/portfolio', auth, (req, res) => {
    const day = prod.currentDay(db);
    const v = prod.portfolioValue(db, req.user.id, day);
    const holdings = holdingsDetail(req.user.id);
    const invested = v.invested_cents;
    const total = v.total_cents;
    // 今日盈亏 = 今日总资产 − 昨日快照总资产 − 今日净外部流入
    let todayPl = 0;
    const y = db.prepare('SELECT total_cents FROM portfolio_snapshots WHERE user_id = ? AND simulated_day = ?').get(req.user.id, day - 1);
    if (y) {
      const cfToday = db.prepare('SELECT type, amount_cents FROM transactions WHERE user_id = ? AND sim_day = ?').all(req.user.id, day)
        .filter((r) => metrics.EXTERNAL_FLOW_TYPES.includes(r.type))
        .reduce((s, r) => s + r.amount_cents, 0);
      todayPl = total - y.total_cents - cfToday;
    }
    // 配置：按资产类别（分母 = 总资产，含现金）
    const alloc = {};
    const addAlloc = (cls, amt) => { alloc[cls] = (alloc[cls] || 0) + amt; };
    for (const h of holdings) addAlloc(CLASS_OF_TYPE[prod.PRODUCT_MAP[h.product_id].type] || 'OTHER', h.market_value_cents);
    const fds = db.prepare("SELECT * FROM fixed_deposits WHERE user_id = ? AND status = 'ACTIVE'").all(req.user.id);
    for (const fd of fds) addAlloc('FIXED', fd.principal_cents + prod.accruedInterest(fd, day));
    addAlloc('CASH', v.cash_cents);
    const allocArr = Object.entries(alloc).map(([cls, amt]) => ({
      class: cls, class_zh: CLASS_ZH[cls] || cls, amount_cents: amt,
      pct_of_total: total ? (amt / total) * 100 : 0,
    })).sort((a, b) => b.amount_cents - a.amount_cents);
    const allocSum = allocArr.reduce((s, a) => s + a.pct_of_total, 0);
    const realized = realizedPl(req.user.id);
    const unrealized = holdings.reduce((s, h) => s + h.unrealized_pl_cents, 0);
    res.json({
      ok: true, simulated: true, simulated_day: day, as_of: '模拟日 day-' + day,
      cash_cents: v.cash_cents, invested_cents: invested, total_cents: total,
      today_pl_cents: todayPl,
      unrealized_pl_cents: unrealized, realized_pl_cents: realized,
      allocation: allocArr, allocation_sum_pct: allocSum,
      holdings_top: holdings.slice(0, 5),
      notice: '模拟演示：虚拟资金与模拟价格，不涉及真实交易。',
    });
  });

  app.get('/api/holdings', auth, (req, res) => {
    const holdings = holdingsDetail(req.user.id);
    const total = holdings.reduce((s, h) => s + h.market_value_cents, 0);
    for (const h of holdings) h.weight_pct = total ? (h.market_value_cents / total) * 100 : 0;
    const fds = db.prepare('SELECT * FROM fixed_deposits WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
    res.json({ ok: true, simulated_day: prod.currentDay(db), items: holdings, realized_pl_cents: realizedPl(req.user.id), fixed_deposits: fds });
  });

  // ---------- 下单：预览（不扣款）与执行 ----------
  function quote(product, side, qtyMilli) {
    const day = prod.currentDay(db);
    const price = prod.priceAt(product, day);
    const total = prod.holdingValue(qtyMilli, price);
    return { day, price_cents: price, total_cents: total, fee_cents: 0 };
  }
  app.post('/api/orders/preview', auth, (req, res) => {
    const p = prod.PRODUCT_MAP[String(req.body.product_id || '')];
    if (!p || !p.tradeable) return res.status(400).json({ ok: false, code: 'PRODUCT_NOT_TRADEABLE', error: PRODUCT_NOT_TRADEABLE });
    const side = String(req.body.side || 'BUY').toUpperCase();
    if (!['BUY', 'SELL'].includes(side)) return res.status(400).json({ ok: false, code: 'SIDE_INVALID', error: '方向不正确' });
    const pq = parseQuantity(req.body, prod.priceAt(p, prod.currentDay(db)));
    if (pq.error) return res.status(400).json({ ok: false, code: 'QUANTITY_INVALID', error: pq.error });
    const qtyMilli = pq.qtyMilli;
    if (qtyMilli < 10) return res.status(400).json({ ok: false, code: 'QUANTITY_TOO_SMALL', error: '数量太小：最少 0.01 份（或金额 $1 以上）' });
    if (p.type === 'FIXED_DEPOSIT' && side !== 'BUY') return res.status(400).json({ ok: false, error: '定存不支持卖出，到期自动兑付或提前支取' });
    const q = quote(p, side, qtyMilli);
    if (q.total_cents < 100) return res.status(400).json({ ok: false, error: '单笔最少 $1.00' });
    const cash = cashOf(req.user.id);
    let shortfall_cents = 0;
    if (side === 'BUY' && cash < q.total_cents) shortfall_cents = q.total_cents - cash;
    if (side === 'SELL') {
      const h = db.prepare('SELECT quantity_milli FROM holdings WHERE user_id = ? AND product_id = ?').get(req.user.id, p.id);
      if (!h || h.quantity_milli < qtyMilli) {
        return res.status(400).json({ ok: false, error: `可卖数量不足：持有 ${h ? (h.quantity_milli / 1000).toFixed(3) : '0'} 份`, holding_milli: h ? h.quantity_milli : 0 });
      }
    }
    // 风险提示：产品风险高于用户测评等级
    let riskWarning = null;
    if (req.user.risk_level && RISK_ORDER[p.risk] > RISK_ORDER[LEVEL_MAX_RISK[req.user.risk_level]]) {
      riskWarning = `该产品风险等级 ${p.risk}（${p.riskLabel}），高于您的测评等级 ${req.user.risk_level}（${RISK_ZH[req.user.risk_level]}，上限 ${LEVEL_MAX_RISK[req.user.risk_level]}）。本提示仅为教学演示，不构成适当性评估。`;
    } else if (!req.user.risk_level) {
      riskWarning = '您尚未完成风险测评（教育自测，非适当性评估）。建议先在投资页完成测评。';
    }
    res.json({
      ok: true, product_id: p.id, name: p.name, side, quantity_milli: qtyMilli, quantity: qtyMilli / 1000,
      price_cents: q.price_cents, total_cents: q.total_cents, fee_cents: 0,
      cash_cents: cash, cash_after_cents: side === 'BUY' ? cash - q.total_cents : cash + q.total_cents,
      shortfall_cents, simulated_day: q.day, risk_warning: riskWarning,
      note: '模拟成交：按确认时模拟价即时成交，无真实交易。手续费 $0。',
    });
  });

  function executeOrder(userId, email, product, side, qtyMilli, idemKey, opts = {}) {
    // 在事务内执行；调用方保证幂等键已查重
    return withTransaction(() => {
      const day = prod.currentDay(db);
      const price = prod.priceAt(product, day);
      const total = prod.holdingValue(qtyMilli, price);
      const cash = cashOf(userId);
      let realized = 0;
      if (side === 'BUY') {
        if (cash < total) {
          const e = new Error('SHORTFALL:' + (total - cash));
          e.code = 'SHORTFALL'; e.shortfall = total - cash; throw e;
        }
      } else {
        const h = db.prepare('SELECT quantity_milli FROM holdings WHERE user_id = ? AND product_id = ?').get(userId, product.id);
        if (!h || h.quantity_milli < qtyMilli) { const e = new Error('INSUFFICIENT_SHARES'); e.code = 'INSUFFICIENT_SHARES'; throw e; }
      }
      const order = db.prepare('INSERT INTO orders (user_id, product_id, side, quantity_milli, price_cents, total_cents, fee_cents, realized_pl_cents, status, idempotency_key, created_at, filled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(userId, product.id, side, qtyMilli, price, total, 0, 0, 'FILLED', idemKey, now(), now());
      const orderId = order.lastInsertRowid;
      let newCash;
      if (side === 'BUY') {
        newCash = wallet.applyCash(db, { userId, delta: -total, type: 'BUY', category: '投资买入', description: `模拟买入 ${product.name} ${qtyMilli / 1000} 份 @ $${fmtC(price)}`, product_id: product.id, order_id: orderId, refType: 'order', refId: orderId }).balance;
        const upd = db.prepare('UPDATE holdings SET quantity_milli = quantity_milli + ? WHERE user_id = ? AND product_id = ?').run(qtyMilli, userId, product.id);
        if (upd.changes === 0) db.prepare('INSERT INTO holdings (user_id, product_id, quantity_milli) VALUES (?,?,?)').run(userId, product.id, qtyMilli);
        db.prepare('INSERT INTO holding_lots (user_id, product_id, order_id, quantity_milli, unit_cost_cents, bought_at) VALUES (?,?,?,?,?,?)')
          .run(userId, product.id, orderId, qtyMilli, price, now());
      } else {
        // FIFO 消耗最老批次
        let remaining = qtyMilli;
        let costConsumed = 0;
        const lots = db.prepare('SELECT id, quantity_milli, unit_cost_cents FROM holding_lots WHERE user_id = ? AND product_id = ? AND quantity_milli > 0 ORDER BY id ASC').all(userId, product.id);
        for (const lot of lots) {
          if (remaining <= 0) break;
          const take = Math.min(lot.quantity_milli, remaining);
          costConsumed += prod.holdingValue(take, lot.unit_cost_cents);
          remaining -= take;
          if (take === lot.quantity_milli) db.prepare('DELETE FROM holding_lots WHERE id = ?').run(lot.id);
          else db.prepare('UPDATE holding_lots SET quantity_milli = quantity_milli - ? WHERE id = ?').run(take, lot.id);
        }
        realized = total - costConsumed;
        db.prepare('UPDATE orders SET realized_pl_cents = ? WHERE id = ?').run(realized, orderId);
        newCash = wallet.applyCash(db, { userId, delta: total, type: 'SELL', refType: 'order', refId: orderId, category: '投资卖出', description: `模拟卖出 ${product.name} ${qtyMilli / 1000} 份 @ $${fmtC(price)}，已实现盈亏 ${realized >= 0 ? '+' : '−'}$${fmtC(Math.abs(realized))}`, product_id: product.id, order_id: orderId }).balance;
        db.prepare('UPDATE holdings SET quantity_milli = quantity_milli - ? WHERE user_id = ? AND product_id = ?').run(qtyMilli, userId, product.id);
        const h = db.prepare('SELECT quantity_milli FROM holdings WHERE user_id = ? AND product_id = ?').get(userId, product.id);
        if (h && h.quantity_milli <= 0) db.prepare('DELETE FROM holdings WHERE user_id = ? AND product_id = ?').run(userId, product.id);
      }
      prod.snapshotUser(db, userId, day);
      return { orderId, price_cents: price, total_cents: total, fee_cents: 0, realized_pl_cents: realized, cash_after_cents: newCash, day };
    });
  }

  app.post('/api/orders', auth, requireActive, requirePin, (req, res) => {
    const p = prod.PRODUCT_MAP[String(req.body.product_id || '')];
    if (!p || !p.tradeable) return res.status(400).json({ ok: false, code: 'PRODUCT_NOT_TRADEABLE', error: PRODUCT_NOT_TRADEABLE });
    const side = String(req.body.side || 'BUY').toUpperCase();
    if (!['BUY', 'SELL'].includes(side)) return res.status(400).json({ ok: false, code: 'SIDE_INVALID', error: '方向不正确' });
    // 幂等键：请求头 Idempotency-Key 优先，兼容 body.idempotency_key；都没有时生成一个（不去重）
    const idemKey = String(req.get('Idempotency-Key') || req.body.idempotency_key || '').trim().slice(0, 255) || crypto.randomUUID();
    // 幂等：同一键直接返回已存订单，不重复执行
    const existing = db.prepare('SELECT * FROM orders WHERE idempotency_key = ? AND user_id = ?').get(idemKey, req.user.id);
    if (existing) {
      return res.json({ ok: true, duplicate: true, message: '该订单已执行（幂等键重复提交，未重复扣款）', order: existing });
    }
    const pq = parseQuantity(req.body, prod.priceAt(p, prod.currentDay(db)));
    if (pq.error) return res.status(400).json({ ok: false, code: 'QUANTITY_INVALID', error: pq.error });
    const qtyMilli = pq.qtyMilli;
    if (qtyMilli < 10) return res.status(400).json({ ok: false, code: 'QUANTITY_TOO_SMALL', error: '数量太小：最少 0.01 份（或金额 $1 以上）' });
    const q = quote(p, side, qtyMilli);
    if (q.total_cents < 100) return res.status(400).json({ ok: false, error: '单笔最少 $1.00' });
    if (p.type === 'FIXED_DEPOSIT') {
      if (side !== 'BUY') return res.status(400).json({ ok: false, error: '定存不支持卖出' });
      // 定存：按金额申购，生成定存单，不进持仓
      const cash = cashOf(req.user.id);
      if (cash < q.total_cents) return res.status(400).json({ ok: false, error: `余额不足：还差 $${fmtC(q.total_cents - cash)}`, shortfall_cents: q.total_cents - cash });
      const day = prod.currentDay(db);
      try {
        const result = withTransaction(() => {
          const fd = db.prepare('INSERT INTO fixed_deposits (user_id, product_id, principal_cents, rate_bps, start_day, maturity_day, status) VALUES (?,?,?,?,?,?,?)')
            .run(req.user.id, p.id, q.total_cents, p.rateBps, day, day + p.termDays, 'ACTIVE');
          const ord = db.prepare('INSERT INTO orders (user_id, product_id, side, quantity_milli, price_cents, total_cents, fee_cents, status, idempotency_key, created_at, filled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .run(req.user.id, p.id, 'BUY', qtyMilli, 100, q.total_cents, 0, 'FILLED', idemKey, now(), now());
          const newCash = wallet.applyCash(db, { userId: req.user.id, delta: -q.total_cents, type: 'BUY', journalType: 'FD_OPEN', category: '定存申购', description: `${p.name} 申购 $${fmtC(q.total_cents)}，年化 ${(p.rateBps / 100).toFixed(2)}%，${p.termDays} 个模拟日后到期`, product_id: p.id, order_id: ord.lastInsertRowid, refType: 'fixed_deposit', refId: fd.lastInsertRowid }).balance;
          prod.snapshotUser(db, req.user.id, day);
          return { fdId: fd.lastInsertRowid, cash_after_cents: newCash };
        });
        audit(req.user.id, req.user.email, 'fd_buy', `${p.name} 申购 $${fmtC(q.total_cents)}`, '');
        return res.json({ ok: true, message: '定存申购成功（模拟）', fixed_deposit_id: result.fdId, total_cents: q.total_cents, cash_after_cents: result.cash_after_cents, maturity_day: day + p.termDays });
      } catch (e) {
        if (e instanceof AppError) throw e;
        req.log.error('invest.fd_buy_failed', { err: e });
        return res.status(500).json({ ok: false, code: 'INTERNAL', error: '申购失败，请重试', request_id: req.id });
      }
    }
    try {
      const r = executeOrder(req.user.id, req.user.email, p, side, qtyMilli, idemKey);
      audit(req.user.id, req.user.email, 'order', `模拟${side === 'BUY' ? '买入' : '卖出'} ${p.name} ${qtyMilli / 1000} 份，总额 $${fmtC(r.total_cents)}`, '');
      res.json({
        ok: true, message: `模拟${side === 'BUY' ? '买入' : '卖出'}成功`, order_id: r.orderId,
        product_id: p.id, name: p.name, side, quantity: qtyMilli / 1000, price_cents: r.price_cents,
        total_cents: r.total_cents, fee_cents: 0, realized_pl_cents: r.realized_pl_cents,
        cash_after_cents: r.cash_after_cents, simulated_day: r.day, receipt_note: '模拟成交，无真实交易；手续费 $0。',
      });
    } catch (e) {
      if (e.code === 'SHORTFALL' || e.code === 'INSUFFICIENT_SHARES') req.log.warn('invest.order_rejected', { code: e.code });
      else req.log.error('invest.order_failed', { err: e });
      if (e.code === 'INSUFFICIENT_FUNDS') return res.status(400).json({ ok: false, code: e.code, error: e.message, shortfall_cents: e.details && e.details.shortfall_cents });
      if (e.code === 'SHORTFALL') return res.status(400).json({ ok: false, error: `余额不足：还差 $${fmtC(e.shortfall)}`, shortfall_cents: e.shortfall });
      if (e.code === 'INSUFFICIENT_SHARES') return res.status(400).json({ ok: false, error: '可卖数量不足' });
      return res.status(500).json({ ok: false, error: '下单失败，请重试' });
    }
  });

  app.get('/api/orders', auth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const items = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(req.user.id, limit);
    res.json({ ok: true, items: items.map((o) => ({ ...o, name: (prod.PRODUCT_MAP[o.product_id] || {}).name || o.product_id })) });
  });

  // ---------- 定存 ----------
  app.get('/api/fixed-deposits', auth, (req, res) => {
    const rows = db.prepare('SELECT * FROM fixed_deposits WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
    const day = prod.currentDay(db);
    res.json({
      ok: true, simulated_day: day,
      items: rows.map((fd) => {
        return { ...fd, accrued_cents: prod.accruedInterest(fd, day), days_left: Math.max(0, fd.maturity_day - day) };
      }),
    });
  });
  app.post('/api/fixed-deposits/:id/break', auth, requireActive, requirePin, (req, res) => {
    const fd = db.prepare('SELECT * FROM fixed_deposits WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!fd) return res.status(404).json({ ok: false, error: '定存单不存在' });
    if (fd.status !== 'ACTIVE') return res.status(400).json({ ok: false, error: '该定存单已结束' });
    const day = prod.currentDay(db);
    const accrued = prod.accruedInterest(fd, day);
    const total = fd.principal_cents + accrued;
    withTransaction(() => {
      // 条件更新防止重复支取：只有仍为 ACTIVE 的定存单才能支取
      const upd = db.prepare("UPDATE fixed_deposits SET status = 'BROKEN' WHERE id = ? AND status = 'ACTIVE'").run(fd.id);
      if (!upd.changes) throw new AppError(409, 'FD_ALREADY_CLOSED', '该定存单已结束');
      // 本金（投资往来）与利息（投资收益）分开入账，口径见 metrics.js
      wallet.applyCash(db, { userId: req.user.id, delta: fd.principal_cents, type: 'FD_REDEEM', journalType: 'FD_CLOSE', category: '定存提前支取', description: `定存提前支取本金 $${fmtC(fd.principal_cents)}（模拟）`, product_id: fd.product_id, refType: 'fixed_deposit', refId: fd.id });
      if (accrued > 0) wallet.applyCash(db, { userId: req.user.id, delta: accrued, type: 'INTEREST', category: '定存利息', description: `定存提前支取已计利息 $${fmtC(accrued)}（模拟）`, product_id: fd.product_id, refType: 'fixed_deposit', refId: fd.id });
      prod.snapshotUser(db, req.user.id, day);
    });
    res.json({ ok: true, message: '定存已提前支取（模拟）', principal_cents: fd.principal_cents, interest_cents: accrued, total_cents: total });
  });

  // ---------- 业绩：TWR + MWR（Modified Dietz）+ 简单回报 ----------
  app.get('/api/performance', auth, (req, res) => {
    const range = String(req.query.range || '1M').toUpperCase();
    const day = prod.currentDay(db);
    // 先刷新当日快照：转账、付款、充值等非投资操作不会更新快照，若不刷新，期末值会滞后于当日资金流，导致回报率失真
    withTransaction(() => prod.snapshotUser(db, req.user.id, day));
    const windowDays = range === '1D' ? 2 : range === '1W' ? 8 : range === '1M' ? 31 : range === '1Y' ? 366 : 10000;
    const snaps = db.prepare('SELECT * FROM portfolio_snapshots WHERE user_id = ? ORDER BY simulated_day ASC').all(req.user.id);
    const series = snaps.slice(-windowDays);
    // 外部资金流（按模拟日）：bonus/topup/transfer_in 为流入（+），transfer_out/pay 为流出（−）
    const flows = {};
    const flowRows = db.prepare('SELECT sim_day, type, amount_cents FROM transactions WHERE user_id = ?').all(req.user.id)
      .filter((r) => metrics.EXTERNAL_FLOW_TYPES.includes(r.type));
    for (const f of flowRows) {
      const d = f.sim_day === null || f.sim_day === undefined ? 0 : f.sim_day;
      flows[d] = (flows[d] || 0) + f.amount_cents;
    }
    let twr = null, mwr = null, simpleReturn = null;
    if (series.length >= 2) {
      // TWR：按日切分，R_d = (EV − BV − CF) / BV，链式相乘
      let chain = 1, valid = true;
      for (let i = 1; i < series.length; i++) {
        const bv = series[i - 1].total_cents;
        const ev = series[i].total_cents;
        const cf = flows[series[i].simulated_day] || 0;
        if (bv <= 0) { valid = false; break; }
        chain *= 1 + (ev - bv - cf) / bv;
      }
      if (valid) twr = (chain - 1) * 100;
      // MWR（Modified Dietz）：R = (EV − BV − CF) / (BV + Σ CFi·Wi)
      const bv0 = series[0].total_cents;
      const evN = series[series.length - 1].total_cents;
      const totalDays = Math.max(1, series[series.length - 1].simulated_day - series[0].simulated_day);
      let cfSum = 0, weighted = 0;
      for (let i = 1; i < series.length; i++) { // 首日为期初资金，不计入期间资金流
        const cf = flows[series[i].simulated_day] || 0;
        if (!cf) continue;
        cfSum += cf;
        const w = (series[series.length - 1].simulated_day - series[i].simulated_day) / totalDays;
        weighted += cf * w;
      }
      const denom = bv0 + weighted;
      if (denom > 0) mwr = ((evN - bv0 - cfSum) / denom) * 100;
      // 简单回报：(当前总资产 − 累计净投入) / 累计净投入
      const netIn = flowRows.reduce((s, f) => s + f.amount_cents, 0);
      if (netIn > 0) simpleReturn = ((evN - netIn) / netIn) * 100;
    }
    const startDay = series.length ? series[0].simulated_day : day;
    const bench = series.map((s) => {
      const bp = prod.priceAt(prod.PRODUCT_MAP['SIM-INDEX'], s.simulated_day);
      const bp0 = prod.priceAt(prod.PRODUCT_MAP['SIM-INDEX'], startDay);
      return { day: s.simulated_day, price_cents: bp, indexed: bp0 ? (bp / bp0) * 100 : 100 };
    });
    const divRows = db.prepare("SELECT amount_cents FROM transactions WHERE user_id = ? AND type = 'DIVIDEND'").all(req.user.id);
    const intRows = db.prepare("SELECT amount_cents FROM transactions WHERE user_id = ? AND type = 'INTEREST'").all(req.user.id);
    res.json({
      ok: true, range, simulated_day: day,
      series: series.map((s) => ({ day: s.simulated_day, date: s.snapshot_date, cash_cents: s.cash_cents, invested_cents: s.invested_cents, total_cents: s.total_cents })),
      benchmark: bench,
      twr_pct: twr, twr_method: 'TWR 时间加权回报 = [(1+R1)×(1+R2)×…×(1+Rn)] − 1；衡量投资策略本身，剔除资金进出时点影响，适合与基准对比。',
      mwr_pct: mwr, mwr_method: 'MWR 货币加权回报（Modified Dietz）R = (EV − BV − CF) / (BV + Σ CFi·Wi)；衡量这笔钱实际经历的回报，包含您追加/取出资金的时点影响。',
      simple_return_pct: simpleReturn,
      simple_method: '简单回报 = (当前总资产 − 累计净投入) / 累计净投入；累计净投入 = 收入 − 支出（' + metrics.DEFINITIONS.inflow + '；' + metrics.DEFINITIONS.outflow + '）。',
      period: { from_day: series.length ? series[0].day : day, to_day: day, label: series.length ? `模拟日 day-${series[0].simulated_day} 至 day-${series[series.length - 1].simulated_day}` : '暂无数据' },
      income: {
        dividends_cents: divRows.reduce((s, r) => s + r.amount_cents, 0),
        interest_cents: intRows.reduce((s, r) => s + r.amount_cents, 0),
        note: '分红与利息与价格收益分开列示；本演示为现金分红/付息，无红利再投（DRIP）。',
      },
      helm_example: '示例（Helm）：先涨 +5% 再跌 −20%，TWR 恒为 −16%。若 $10,000 在期初投入，MWR 也是 −16%；若在中点（大跌前）才投入，MWR 为 −24%——同一组投资，只因投入时点不同，个人回报差 8 个百分点。',
      note: '收益数字为模拟演示，不代表真实收益；原始余额变化（含体验金/充值）不是回报率。',
    });
  });

  // ---------- 分红 / 利息明细 ----------
  app.get('/api/income', auth, (req, res) => {
    const rows = db.prepare("SELECT * FROM transactions WHERE user_id = ? AND type IN ('DIVIDEND','INTEREST') ORDER BY created_at DESC LIMIT 100").all(req.user.id);
    res.json({ ok: true, items: rows });
  });

  // ---------- 自选 + 提醒 ----------
  app.get('/api/watchlist', auth, (req, res) => {
    const rows = db.prepare('SELECT product_id FROM watchlist WHERE user_id = ?').all(req.user.id);
    const day = prod.currentDay(db);
    res.json({
      ok: true,
      items: rows.map((r) => {
        const p = prod.PRODUCT_MAP[r.product_id];
        if (!p) return null;
        const price = prod.priceAt(p, day), prev = prod.priceAt(p, day - 1);
        return { product_id: p.id, name: p.name, type: p.type, risk: p.risk, price_cents: price, day_change_pct: prev ? ((price - prev) / prev) * 100 : 0, sparkline: prod.priceHistory(db, p.id, 14).map((x) => x.price_cents) };
      }).filter(Boolean),
    });
  });
  app.post('/api/watchlist', auth, (req, res) => {
    const p = prod.PRODUCT_MAP[String(req.body.product_id || '')];
    if (!p) return res.status(400).json({ ok: false, error: '产品不存在' });
    const ex = db.prepare('SELECT product_id FROM watchlist WHERE user_id = ? AND product_id = ?').get(req.user.id, p.id);
    if (ex) {
      db.prepare('DELETE FROM watchlist WHERE user_id = ? AND product_id = ?').run(req.user.id, p.id);
      return res.json({ ok: true, watched: false });
    }
    db.prepare('INSERT INTO watchlist (user_id, product_id, created_at) VALUES (?,?,?)').run(req.user.id, p.id, now());
    res.json({ ok: true, watched: true });
  });
  app.get('/api/alerts', auth, (req, res) => {
    const rows = db.prepare('SELECT * FROM alerts WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
    res.json({ ok: true, items: rows.map((a) => ({ ...a, name: (prod.PRODUCT_MAP[a.product_id] || {}).name || a.product_id })) });
  });
  app.post('/api/alerts', auth, (req, res) => {
    const p = prod.PRODUCT_MAP[String(req.body.product_id || '')];
    if (!p) return res.status(400).json({ ok: false, error: '产品不存在' });
    const condition = String(req.body.condition || '').toUpperCase();
    if (!['ABOVE', 'BELOW', 'DAY_CHANGE'].includes(condition)) return res.status(400).json({ ok: false, error: '提醒条件不正确（ABOVE / BELOW / DAY_CHANGE）' });
    const mode = String(req.body.mode || 'ONCE').toUpperCase();
    if (!['ONCE', 'RECURRING'].includes(mode)) return res.status(400).json({ ok: false, error: '提醒方式不正确（ONCE / RECURRING）' });
    let threshold;
    if (condition === 'DAY_CHANGE') {
      const pct = parseFloat(req.body.threshold_pct);
      if (!Number.isFinite(pct) || pct <= 0) return res.status(400).json({ ok: false, error: '请输入日涨跌幅阈值（%）' });
      threshold = Math.round(pct * 100); // 存基点
    } else {
      const r = money.parseAmount(req.body.threshold_price);
      if (!r.ok) return res.status(400).json({ ok: false, code: r.code, error: '触发价格：' + r.message });
      threshold = r.cents;
    }
    const ex = db.prepare('SELECT id FROM alerts WHERE user_id = ? AND product_id = ? AND condition = ? AND status = ?').get(req.user.id, p.id, condition, 'ACTIVE');
    if (ex) return res.status(400).json({ ok: false, error: '该产品已有同类生效提醒（每目标一个提醒）' });
    const r = db.prepare('INSERT INTO alerts (user_id, product_id, condition, threshold_cents, mode, status) VALUES (?,?,?,?,?,?)')
      .run(req.user.id, p.id, condition, threshold, mode, 'ACTIVE');
    res.json({ ok: true, message: '提醒已创建（仅应用内提醒）', alert_id: r.lastInsertRowid });
  });
  app.delete('/api/alerts/:id', auth, (req, res) => {
    db.prepare('DELETE FROM alerts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  // ---------- 风险测评与目标配置 ----------
  app.get('/api/risk-quiz', auth, (req, res) => res.json({ ok: true, questions: QUIZ, note: '教育自测，非适当性评估；结果仅用于生成示例配置，不构成投资建议。' }));
  app.post('/api/risk-quiz', auth, (req, res) => {
    const answers = req.body.answers;
    if (!Array.isArray(answers) || answers.length !== QUIZ.length) return res.status(400).json({ ok: false, error: '请回答全部 5 道题' });
    const score = answers.reduce((s, a) => s + (Math.max(0, Math.min(4, parseInt(a, 10) || 0))), 0);
    const level = score <= 5 ? 'Conservative' : score <= 10 ? 'Balanced' : score <= 15 ? 'Growth' : 'Aggressive';
    db.prepare('UPDATE users SET risk_level = ?, risk_score = ? WHERE id = ?').run(level, score, req.user.id);
    const weights = SUGGESTED[level];
    const ex = db.prepare('SELECT user_id FROM risk_targets WHERE user_id = ?').get(req.user.id);
    if (ex) db.prepare('UPDATE risk_targets SET weights_json = ?, updated_at = ? WHERE user_id = ?').run(JSON.stringify(weights), now(), req.user.id);
    else db.prepare('INSERT INTO risk_targets (user_id, weights_json, updated_at) VALUES (?,?,?)').run(req.user.id, JSON.stringify(weights), now());
    res.json({ ok: true, score, level, level_zh: RISK_ZH[level], max_risk: LEVEL_MAX_RISK[level], suggested: weights, note: '示例配置，仅供教学参考，不构成投资建议。' });
  });
  app.get('/api/risk', auth, (req, res) => {
    const u = db.prepare('SELECT risk_level, risk_score FROM users WHERE id = ?').get(req.user.id);
    const t = db.prepare('SELECT weights_json FROM risk_targets WHERE user_id = ?').get(req.user.id);
    res.json({
      ok: true, level: u.risk_level, level_zh: u.risk_level ? RISK_ZH[u.risk_level] : null, score: u.risk_score,
      max_risk: u.risk_level ? LEVEL_MAX_RISK[u.risk_level] : null,
      target: t ? JSON.parse(t.weights_json) : null, suggested: SUGGESTED,
    });
  });
  app.post('/api/risk/target', auth, (req, res) => {
    const w = req.body.weights || {};
    const keys = ['STOCK', 'ETF', 'FUND', 'GOLD', 'FIXED', 'CASH'];
    const weights = {};
    let sum = 0;
    for (const k of keys) { const v = Math.max(0, Math.min(100, Number(w[k]) || 0)); weights[k] = v; sum += v; }
    if (Math.abs(sum - 100) > 0.01) return res.status(400).json({ ok: false, error: `目标权重合计必须为 100%，当前为 ${sum}%` });
    const ex = db.prepare('SELECT user_id FROM risk_targets WHERE user_id = ?').get(req.user.id);
    if (ex) db.prepare('UPDATE risk_targets SET weights_json = ?, updated_at = ? WHERE user_id = ?').run(JSON.stringify(weights), now(), req.user.id);
    else db.prepare('INSERT INTO risk_targets (user_id, weights_json, updated_at) VALUES (?,?,?)').run(req.user.id, JSON.stringify(weights), now());
    res.json({ ok: true, target: weights });
  });

  // ---------- 再平衡预览与执行 ----------
  function rebalancePlan(userId) {
    const t = db.prepare('SELECT weights_json FROM risk_targets WHERE user_id = ?').get(userId);
    if (!t) return { error: '请先完成风险测评或设置目标配置' };
    const target = JSON.parse(t.weights_json);
    const v = prod.portfolioValue(db, userId);
    const total = v.total_cents;
    const cur = { STOCK: 0, ETF: 0, FUND: 0, GOLD: 0, FIXED: 0, CASH: v.cash_cents };
    for (const h of holdingsDetail(userId)) {
      const cls = CLASS_OF_TYPE[prod.PRODUCT_MAP[h.product_id].type];
      if (cls) cur[cls] = (cur[cls] || 0) + h.market_value_cents;
    }
    const fds = db.prepare("SELECT * FROM fixed_deposits WHERE user_id = ? AND status = 'ACTIVE'").all(userId);
    const fdDay = prod.currentDay(db);
    for (const fd of fds) cur.FIXED += fd.principal_cents + prod.accruedInterest(fd, fdDay);
    const items = Object.keys(target).map((cls) => {
      const targetAmt = money.mulDiv(total, Math.round(target[cls] * 100), 10000); // 目标权重最多 2 位小数
      const curAmt = cur[cls] || 0;
      const driftPct = total ? ((curAmt - targetAmt) / total) * 100 : 0;
      const band = Math.min(5, 0.25 * target[cls]); // 5/25 规则：min(5pp, 25%×目标)
      return {
        class: cls, class_zh: CLASS_ZH[cls], target_pct: target[cls], target_cents: targetAmt,
        current_cents: curAmt, current_pct: total ? (curAmt / total) * 100 : 0,
        drift_pct: driftPct, band_pp: band, breached: Math.abs(driftPct) > band,
        delta_cents: targetAmt - curAmt,
      };
    });
    return { total_cents: total, target, items, breached: items.filter((i) => i.breached) };
  }
  app.get('/api/rebalance/preview', auth, (req, res) => {
    const plan = rebalancePlan(req.user.id);
    if (plan.error) return res.status(400).json({ ok: false, error: plan.error });
    // 建议交易：按类别差额，买入取该类首个可交易产品，卖出按持有市值从大到小
    const suggestions = [];
    for (const it of plan.items) {
      if (it.delta_cents === 0 || it.class === 'CASH') continue;
      if (it.delta_cents > 0) {
        const cand = prod.PRODUCTS.find((p) => CLASS_OF_TYPE[p.type] === it.class && p.tradeable && p.type !== 'FIXED_DEPOSIT');
        if (cand) suggestions.push({ class: it.class, class_zh: it.class_zh, side: 'BUY', product_id: cand.id, name: cand.name, amount_cents: it.delta_cents });
      } else {
        const hs = holdingsDetail(req.user.id).filter((h) => CLASS_OF_TYPE[prod.PRODUCT_MAP[h.product_id].type] === it.class)
          .sort((a, b) => b.market_value_cents - a.market_value_cents);
        let need = -it.delta_cents;
        for (const h of hs) {
          if (need <= 0) break;
          const amt = Math.min(h.market_value_cents, need);
          suggestions.push({ class: it.class, class_zh: it.class_zh, side: 'SELL', product_id: h.product_id, name: h.name, amount_cents: amt });
          need -= amt;
        }
      }
    }
    res.json({ ok: true, ...plan, suggestions, rule: '5/25 规则：当 |偏离| > min(5 个百分点, 25%×目标权重) 时提示再平衡；例如目标 60% 的类别区间为 55–65%，目标 5% 的类别区间为 3.75–6.25%。再平衡仅为练习建议，不构成投资建议，不自动交易。' });
  });
  app.post('/api/rebalance/execute', auth, requireActive, requirePin, (req, res) => {
    const plan = rebalancePlan(req.user.id);
    if (plan.error) return res.status(400).json({ ok: false, error: plan.error });
    const results = [];
    // 复用预览的建议逻辑（现金不足/持仓不足时单项跳过并注明）
    const preview = { items: plan.items };
    for (const it of preview.items) {
      if (it.delta_cents === 0 || it.class === 'CASH') continue;
      if (it.delta_cents > 0) {
        const cand = prod.PRODUCTS.find((p) => CLASS_OF_TYPE[p.type] === it.class && p.tradeable && p.type !== 'FIXED_DEPOSIT');
        if (!cand) { results.push({ class: it.class, side: 'BUY', skipped: true, reason: '该类别无可交易产品' }); continue; }
        const cash = cashOf(req.user.id);
        const amt = Math.min(it.delta_cents, cash);
        if (amt < 100) { results.push({ class: it.class, side: 'BUY', skipped: true, reason: '现金不足（还差 $' + fmtC(it.delta_cents - cash) + '）' }); continue; }
        const qtyMilli = money.mulDiv(amt, 1000, prod.priceAt(cand, prod.currentDay(db)));
        try {
          const r = executeOrder(req.user.id, req.user.email, cand, 'BUY', qtyMilli, crypto.randomUUID());
          results.push({ class: it.class, side: 'BUY', product_id: cand.id, name: cand.name, amount_cents: r.total_cents, order_id: r.orderId });
        } catch (e) { results.push({ class: it.class, side: 'BUY', skipped: true, reason: e.code === 'SHORTFALL' ? '余额不足' : '执行失败' }); }
      } else {
        const hs = holdingsDetail(req.user.id).filter((h) => CLASS_OF_TYPE[prod.PRODUCT_MAP[h.product_id].type] === it.class)
          .sort((a, b) => b.market_value_cents - a.market_value_cents);
        let need = -it.delta_cents;
        for (const h of hs) {
          if (need <= 0) break;
          const amt = Math.min(h.market_value_cents, need);
          const qtyMilli = money.mulDiv(amt, 1000, h.price_cents);
          const sellQty = Math.min(qtyMilli, h.quantity_milli);
          if (sellQty < 10) continue;
          try {
            const r = executeOrder(req.user.id, req.user.email, prod.PRODUCT_MAP[h.product_id], 'SELL', sellQty, crypto.randomUUID());
            results.push({ class: it.class, side: 'SELL', product_id: h.product_id, name: h.name, amount_cents: r.total_cents, order_id: r.orderId });
            need -= r.total_cents;
          } catch (e) { results.push({ class: it.class, side: 'SELL', skipped: true, reason: '执行失败' }); }
        }
      }
    }
    audit(req.user.id, req.user.email, 'rebalance', `再平衡执行 ${results.filter((r) => !r.skipped).length} 笔`, '');
    res.json({ ok: true, message: '再平衡执行完成（模拟）', results });
  });

  // ---------- 目标 ----------
  app.get('/api/goals', auth, (req, res) => {
    const rows = db.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
    const v = prod.portfolioValue(db, req.user.id);
    res.json({
      ok: true,
      items: rows.map((g) => ({
        ...g, current_cents: v.total_cents,
        progress_pct: g.target_cents ? Math.min(100, (v.total_cents / g.target_cents) * 100) : 0,
        projection_note: '按模拟年化 5% 测算的达成时间仅为教学演示，不是承诺。',
      })),
    });
  });
  app.post('/api/goals', auth, (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 40);
    const targetDate = String(req.body.target_date || '').slice(0, 10);
    if (!name) return res.status(400).json({ ok: false, error: '请输入目标名称' });
    const tr = money.parseAmount(req.body.target_amount);
    if (!tr.ok) return res.status(400).json({ ok: false, code: tr.code, error: '目标金额：' + tr.message });
    const targetCents = tr.cents;
    const r = db.prepare('INSERT INTO goals (user_id, name, target_cents, target_date, created_at) VALUES (?,?,?,?,?)')
      .run(req.user.id, name, targetCents, targetDate, now());
    res.json({ ok: true, goal_id: r.lastInsertRowid });
  });
  app.delete('/api/goals/:id', auth, (req, res) => {
    db.prepare('DELETE FROM goals WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  // ---------- 备份 / 导出 / 演示重置 ----------
  app.get('/api/backup/export', auth, (req, res) => {
    const data = {
      exported_at: new Date().toISOString(), user: req.user.email,
      wallets: db.prepare('SELECT * FROM wallets WHERE user_id = ?').all(req.user.id),
      holdings: db.prepare('SELECT * FROM holdings WHERE user_id = ?').all(req.user.id),
      holding_lots: db.prepare('SELECT * FROM holding_lots WHERE user_id = ?').all(req.user.id),
      orders: db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id ASC').all(req.user.id),
      transactions: db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id ASC').all(req.user.id),
      portfolio_snapshots: db.prepare('SELECT * FROM portfolio_snapshots WHERE user_id = ? ORDER BY simulated_day ASC').all(req.user.id),
      goals: db.prepare('SELECT * FROM goals WHERE user_id = ?').all(req.user.id),
      fixed_deposits: db.prepare('SELECT * FROM fixed_deposits WHERE user_id = ?').all(req.user.id),
      payments: db.prepare('SELECT * FROM payments WHERE user_id = ?').all(req.user.id),
      withdrawals: db.prepare('SELECT * FROM withdrawals WHERE user_id = ?').all(req.user.id),
    };
    res.json({ ok: true, export: data });
  });
  app.post('/api/backup/db', auth, (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'data', 'backups');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, 'app-' + stamp + '.db');
    try {
      // 热备份：VACUUM INTO（SQLite），绝不用 cp 直接复制运行中的库文件
      db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
      const chk = db.prepare('PRAGMA integrity_check').get();
      res.json({ ok: true, message: '备份完成', file: dest, integrity: chk ? Object.values(chk)[0] : 'unknown' });
    } catch (e) {
      // JSON 后端：写一份 JSON 导出作为备份
      const destJson = path.join(dir, 'app-' + stamp + '.json');
      try {
        const data = { wallets: db.prepare('SELECT * FROM wallets WHERE user_id = ?').all(req.user.id) };
        fs.writeFileSync(destJson, JSON.stringify(data));
        res.json({ ok: true, message: '已导出 JSON 备份（JSON 后端）', file: destJson });
      } catch (e2) { res.status(500).json({ ok: false, error: '备份失败：' + e2.message }); }
    }
  });
  app.post('/api/demo/reset', auth, requireActive, (req, res) => {
    const password = String(req.body.password || '');
    const row = db.prepare('SELECT password_salt, password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!sec.verifyPassword(password, row.password_salt, row.password_hash)) return res.status(403).json({ ok: false, error: '登录密码不正确' });
    const BONUS = parseInt(process.env.WELCOME_BONUS_CENTS || '5000', 10);
    const pendingW = db.prepare("SELECT COUNT(*) AS c FROM withdrawals WHERE user_id = ? AND status = 'PENDING'").get(req.user.id).c;
    if (pendingW) return res.status(409).json({ ok: false, code: 'PENDING_WITHDRAWAL', error: '有待审核的提现申请，审核完成后才能重置演示', request_id: req.id });
    withTransaction(() => {
      // 账本只追加不删除：先用冲正分录把钱包清零，再发放体验金；其余演示历史（含流水明细）按原逻辑清空
      for (const t of ['transactions', 'holding_lots', 'orders', 'holdings', 'portfolio_snapshots', 'dividends', 'watchlist', 'alerts', 'goals', 'fixed_deposits']) { // holding_lots 引用 orders，必须先删
        db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(req.user.id);
      }
      const current = cashOf(req.user.id);
      if (current !== 0) wallet.applyCash(db, { userId: req.user.id, delta: -current, type: 'demo_reset', allowNegative: true, category: '演示重置', description: '演示重置：清空余额' });
      if (BONUS > 0) wallet.applyCash(db, { userId: req.user.id, delta: BONUS, type: 'bonus', category: '体验金', description: `演示重置：恢复体验金 $${fmtC(BONUS)}（虚拟资金）` });
      prod.backfillCashHistory(db, req.user.id, BONUS);
    });
    audit(req.user.id, req.user.email, 'demo_reset', '演示重置，恢复 $50 体验金', '');
    res.json({ ok: true, message: `演示已重置，恢复体验金 $${fmtC(BONUS)}`, balance_cents: BONUS });
  });

  // 供 server.js /api/health 使用
  return {
    status: () => ({ ok: true, simulated_day: prod.currentDay(db), products: prod.PRODUCTS.length, tick: '每小时推进 1 个模拟日', last_tick_at: lastTickAt, last_tick_error: lastTickError }),
    runTick,
    startTicker,
  };
};
