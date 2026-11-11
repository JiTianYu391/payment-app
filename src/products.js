// 投资产品目录 + 种子化 GBM 模拟价格引擎（v2）
// 全部为模拟价格，不代表真实市场。价格路径由产品种子唯一决定，
// 用户交易绝不改变市场路径（市场流与交易流分离，见报告 §3.2）。
//   S(t+1) = S(t) * exp((μ − σ²/2)·Δt + σ·√Δt·Z)，Δt = 1/252，Z ~ N(0,1)
// 模拟日推进：每 10 分钟推进 1 个模拟日（setInterval）；首次启动时预生成 30 天历史，
// 因此图表 / TWR 上线即有数据。定存与货币基金不走 GBM，按固定利率计息。
const crypto = require('crypto');
const money = require('./money');
// 价格路径用浮点对数收益率生成（这是行情模型，不是金额运算），结果取整为整数分；
// 之后所有金额（市值、利息、分红）都按整数分 + money.mulDiv 计算。

// ---------- 确定性随机数 ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
// 给定产品种子，生成第 day 天的对数收益率序列（确定性，可复现）
function dailyReturn(product, day) {
  // 每一天用独立子流：seed ^ day，保证任意一天可单独复算，且与交易无关
  const rand = mulberry32((product.price_seed ^ Math.imul(day, 0x9E3779B1)) >>> 0);
  // Box-Muller 取一个标准正态
  let u1 = rand(), u2 = rand();
  if (u1 <= 0) u1 = 1e-12;
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const dt = 1 / 252;
  return (product.mu - (product.sigma * product.sigma) / 2) * dt + product.sigma * Math.sqrt(dt) * z;
}
const priceCache = new Map(); // `${id}:${day}` -> cents
function priceAt(product, day) {
  if (day <= 0) return product.base_price_cents;
  const key = product.id + ':' + day;
  if (priceCache.has(key)) return priceCache.get(key);
  let logP = Math.log(product.base_price_cents);
  for (let d = 1; d <= day; d++) logP += dailyReturn(product, d);
  let cents = Math.round(Math.exp(logP));
  if (!Number.isFinite(cents) || cents < 1) cents = 1;
  // 货币基金净值钉在 $1.00：价格四舍五入到 100 美分，避免 1 美分跳变
  if (product.id === 'SIM-FND-01') cents = 100;
  priceCache.set(key, cents);
  return cents;
}

// ---------- 产品目录 ----------
// type: STOCK | ETF | FUND | GOLD | FIXED_DEPOSIT | BENCHMARK
// risk: R1–R5（演示标签；黄金 R3/R4 各机构口径不一，本演示取 R3 并注明）
// dividend_yield: 年化分红率；定存用 rateBps/termDays（年化利率/期限模拟日）
const PRODUCTS = [
  { id: 'SIM-STK-01', name: '蓝筹科技股', en: 'BlueChip Tech', type: 'STOCK', risk: 'R4', riskLabel: '中高风险', base_price_cents: 12000, mu: 0.06, sigma: 0.30, dividend_yield: 0.012, price_seed: 101, tradeable: 1, desc: '模拟大型科技股，波动较大，含季度分红。' },
  { id: 'SIM-STK-02', name: '成长消费股', en: 'Growth Consumer', type: 'STOCK', risk: 'R4', riskLabel: '中高风险', base_price_cents: 4550, mu: 0.08, sigma: 0.38, dividend_yield: 0.005, price_seed: 202, tradeable: 1, desc: '模拟成长型消费股，波动大，分红较少。' },
  { id: 'SIM-ETF-01', name: '宽基指数ETF', en: 'Broad Index ETF', type: 'ETF', risk: 'R3', riskLabel: '中风险', base_price_cents: 8800, mu: 0.05, sigma: 0.15, dividend_yield: 0.018, price_seed: 303, tradeable: 1, desc: '模拟宽基指数，一篮子股票，分散风险。' },
  { id: 'SIM-ETF-02', name: '科技主题ETF', en: 'Tech Theme ETF', type: 'ETF', risk: 'R3', riskLabel: '中风险', base_price_cents: 6420, mu: 0.07, sigma: 0.22, dividend_yield: 0.008, price_seed: 404, tradeable: 1, desc: '模拟科技主题指数，波动高于宽基。' },
  { id: 'SIM-FND-01', name: '货币市场基金', en: 'Money Market Fund', type: 'FUND', risk: 'R1', riskLabel: '低风险', base_price_cents: 100, mu: 0.02, sigma: 0.005, dividend_yield: 0.02, price_seed: 505, tradeable: 1, desc: '净值恒为 $1.00，按日计息，收益计入利息（与价格收益分开列示）。' },
  { id: 'SIM-FND-02', name: '债券基金', en: 'Bond Fund', type: 'FUND', risk: 'R2', riskLabel: '中低风险', base_price_cents: 1050, mu: 0.03, sigma: 0.04, dividend_yield: 0.035, price_seed: 606, tradeable: 1, desc: '模拟债券基金，波动小，定期分红。' },
  { id: 'SIM-FND-03', name: '混合基金', en: 'Balanced Fund', type: 'FUND', risk: 'R3', riskLabel: '中风险', base_price_cents: 1280, mu: 0.05, sigma: 0.12, dividend_yield: 0.02, price_seed: 707, tradeable: 1, desc: '股债混合，风险收益居中。' },
  { id: 'SIM-GLD-01', name: '黄金ETF', en: 'Gold ETF', type: 'GOLD', risk: 'R3', riskLabel: '中风险', base_price_cents: 9500, mu: 0.03, sigma: 0.15, dividend_yield: 0, price_seed: 808, tradeable: 1, desc: '模拟黄金价格，无分红。风险等级各机构口径不一（R3/R4），本系统取 R3。' },
  { id: 'SIM-FD-01', name: '7天定存', en: '7-Day Fixed Deposit', type: 'FIXED_DEPOSIT', risk: 'R1', riskLabel: '低风险', base_price_cents: 100, mu: 0.02, sigma: 0, dividend_yield: 0, price_seed: 901, tradeable: 1, rateBps: 200, termDays: 7, desc: '锁定 7 个模拟日，年化 2.00%，到期还本付息；提前支取按已存天数计息。' },
  { id: 'SIM-FD-02', name: '90天定存', en: '90-Day Fixed Deposit', type: 'FIXED_DEPOSIT', risk: 'R1', riskLabel: '低风险', base_price_cents: 100, mu: 0.032, sigma: 0, dividend_yield: 0, price_seed: 902, tradeable: 1, rateBps: 320, termDays: 90, desc: '锁定 90 个模拟日，年化 3.20%，到期还本付息；提前支取按已存天数计息。' },
  { id: 'SIM-INDEX', name: '模拟基准指数', en: 'Simulated Benchmark', type: 'BENCHMARK', risk: 'R3', riskLabel: '中风险', base_price_cents: 10000, mu: 0.05, sigma: 0.15, dividend_yield: 0, price_seed: 999, tradeable: 0, desc: '仅用于业绩对比的模拟基准，不是真实指数，不可买卖。' },
];
for (const p of PRODUCTS) p.dividend_bps = Math.round(p.dividend_yield * 10000); // 年化分红率（基点，整数）
const PRODUCT_MAP = Object.fromEntries(PRODUCTS.map((p) => [p.id, p]));
const MMF_RATE_BPS = 200; // 货币基金年化 2.00%

// 定存已计利息（单利，按模拟日计）：本金 × 年化基点 × 天数 ÷ (10000 × 365)
function accruedInterest(fd, day) {
  const elapsed = Math.max(0, Math.min(day - fd.start_day, fd.maturity_day - fd.start_day));
  return money.mulDiv(fd.principal_cents * fd.rate_bps, elapsed, 10000 * 365);
}
function holdingValue(quantityMilli, priceCents) {
  return money.mulDiv(quantityMilli, priceCents, 1000);
}
const HISTORY_DAYS = 30;      // 首次启动预生成的历史天数
const TICK_MS = 10 * 60 * 1000; // 每 10 分钟推进 1 个模拟日

function seedProducts(db) {
  for (const p of PRODUCTS) {
    try {
      db.prepare('INSERT INTO products (id, name, type, risk, base_price_cents, mu, sigma, dividend_yield, price_seed, is_active, tradeable) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(p.id, p.name, p.type, p.risk, p.base_price_cents, p.mu, p.sigma, p.dividend_yield, p.price_seed, 1, p.tradeable);
    } catch (e) { /* 已存在则跳过（主键冲突） */ }
  }
}

function currentDay(db) {
  const row = db.prepare('SELECT simulated_day FROM price_snapshots ORDER BY simulated_day DESC LIMIT 1').get();
  return row ? row.simulated_day : 0;
}

function ensureHistory(db) {
  seedProducts(db);
  if (currentDay(db) > 0) return currentDay(db);
  const now = Date.now();
  for (let day = 1; day <= HISTORY_DAYS; day++) {
    for (const p of PRODUCTS) {
      db.prepare('INSERT INTO price_snapshots (product_id, simulated_day, price_cents, created_at) VALUES (?,?,?,?)')
        .run(p.id, day, priceAt(p, day), now);
    }
  }
  return HISTORY_DAYS;
}

function priceHistory(db, productId, maxPoints) {
  const p = PRODUCT_MAP[productId];
  if (!p) return [];
  const rows = db.prepare('SELECT simulated_day, price_cents FROM price_snapshots WHERE product_id = ? ORDER BY simulated_day ASC').all(productId);
  const pts = [{ day: 0, price_cents: p.base_price_cents }];
  for (const r of rows) pts.push({ day: r.simulated_day, price_cents: r.price_cents });
  return maxPoints ? pts.slice(-maxPoints) : pts;
}

function latestPrices(db) {
  const day = currentDay(db);
  const out = {};
  for (const p of PRODUCTS) out[p.id] = { price_cents: priceAt(p, day), day };
  return { day, prices: out };
}

// ---------- 组合估值 ----------
function portfolioValue(db, userId, day) {
  const d = day === undefined ? currentDay(db) : day;
  const w = db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(userId);
  const cash = w ? w.balance_cents : 0;
  const holdings = db.prepare('SELECT product_id, quantity_milli FROM holdings WHERE user_id = ? AND quantity_milli > 0').all(userId);
  let invested = 0;
  const byProduct = [];
  for (const h of holdings) {
    const p = PRODUCT_MAP[h.product_id];
    if (!p) continue;
    const price = priceAt(p, d);
    const value = holdingValue(h.quantity_milli, price);
    invested += value;
    byProduct.push({ product_id: h.product_id, quantity_milli: h.quantity_milli, price_cents: price, value_cents: value });
  }
  // 定存按本金+已计利息计入投资市值
  const fds = db.prepare("SELECT * FROM fixed_deposits WHERE user_id = ? AND status = 'ACTIVE'").all(userId);
  for (const fd of fds) {
    const accrued = accruedInterest(fd, d);
    invested += fd.principal_cents + accrued;
    byProduct.push({ product_id: fd.product_id, quantity_milli: 0, price_cents: 100, value_cents: fd.principal_cents + accrued, fixed_deposit_id: fd.id });
  }
  return { day: d, cash_cents: cash, invested_cents: invested, total_cents: cash + invested, byProduct };
}

// 新用户回填：以 $50 体验金为起点，在已生成的 30 天模拟历史内按现金持有回填，
// 使图表 / TWR / MWR 上线即有完整序列；期初资金不计入期间资金流（见 performance）。
// 这是演示约定，已在 README 与业绩页注明。
function backfillCashHistory(db, userId, cashCents) {
  const day = currentDay(db);
  // 期初资金（体验金）记为第 1 天流入，与回填口径一致；否则 TWR 会在注册日算出 -100%
  try {
    db.prepare("UPDATE transactions SET sim_day = 1 WHERE user_id = ? AND type = 'bonus' AND sim_day = ?").run(userId, day);
  } catch (_) { /* JSON 后端无 sim_day 列时忽略（列不存在不影响 JSON 存储） */ }
  for (let d = 1; d < day; d++) {
    const date = 'day-' + d;
    const ex = db.prepare('SELECT id FROM portfolio_snapshots WHERE user_id = ? AND snapshot_date = ?').get(userId, date);
    if (!ex) {
      db.prepare('INSERT INTO portfolio_snapshots (user_id, snapshot_date, simulated_day, cash_cents, invested_cents, total_cents) VALUES (?,?,?,?,?,?)')
        .run(userId, date, d, cashCents, 0, cashCents);
    }
  }
  return snapshotUser(db, userId, day);
}

function snapshotUser(db, userId, day) {
  const d = day === undefined ? currentDay(db) : day;
  const v = portfolioValue(db, userId, d);
  const date = 'day-' + d;
  const ex = db.prepare('SELECT id FROM portfolio_snapshots WHERE user_id = ? AND snapshot_date = ?').get(userId, date);
  if (ex) {
    db.prepare('UPDATE portfolio_snapshots SET cash_cents = ?, invested_cents = ?, total_cents = ? WHERE id = ?')
      .run(v.cash_cents, v.invested_cents, v.total_cents, ex.id);
  } else {
    db.prepare('INSERT INTO portfolio_snapshots (user_id, snapshot_date, simulated_day, cash_cents, invested_cents, total_cents) VALUES (?,?,?,?,?,?)')
      .run(userId, date, d, v.cash_cents, v.invested_cents, v.total_cents);
  }
  return v;
}

// ---------- 每日推进（tick）：价格快照 + 分红/利息 + 定存到期 + 提醒 + 组合快照 ----------
function tick(db, audit, withTransaction) {
  return withTransaction(() => {
    const day = currentDay(db) + 1;
    const now = Date.now();
    for (const p of PRODUCTS) {
      db.prepare('INSERT INTO price_snapshots (product_id, simulated_day, price_cents, created_at) VALUES (?,?,?,?)')
        .run(p.id, day, priceAt(p, day), now);
    }
    const users = db.prepare('SELECT id FROM users').all();
    for (const u of users) {
      // 季度分红：模拟日每 90 天派发一次（第 90/180/270… 天）
      if (day % 90 === 0) {
        const holdings = db.prepare('SELECT product_id, quantity_milli FROM holdings WHERE user_id = ? AND quantity_milli > 0').all(u.id);
        for (const h of holdings) {
          const p = PRODUCT_MAP[h.product_id];
          if (!p || !p.dividend_bps || p.id === 'SIM-FND-01') continue;
          const price = priceAt(p, day);
          const perShare = money.mulDiv(price, p.dividend_bps, 40000); // 每份季度分红 = 价格 × 年化率 ÷ 4
          const amount = holdingValue(h.quantity_milli, perShare);
          if (amount <= 0) continue;
          creditCash(db, u.id, amount, 'DIVIDEND', { product_id: p.id, description: `${p.name} 季度分红（模拟）` });
          db.prepare('INSERT INTO dividends (user_id, product_id, amount_cents, ex_date, paid_at) VALUES (?,?,?,?,?)')
            .run(u.id, p.id, amount, 'day-' + day, now);
        }
      }
      // 货币基金按日计息
      const mmf = db.prepare('SELECT quantity_milli FROM holdings WHERE user_id = ? AND product_id = ?').get(u.id, 'SIM-FND-01');
      if (mmf && mmf.quantity_milli > 0) {
        const value = holdingValue(mmf.quantity_milli, 100);
        const interest = money.mulDiv(value, MMF_RATE_BPS, 10000 * 365);
        if (interest > 0) creditCash(db, u.id, interest, 'INTEREST', { product_id: 'SIM-FND-01', description: '货币市场基金当日利息（模拟）' });
      }
      // 定存到期
      const fds = db.prepare("SELECT * FROM fixed_deposits WHERE user_id = ? AND status = 'ACTIVE' AND maturity_day <= ?").all(u.id, day);
      for (const fd of fds) {
        const interest = accruedInterest(fd, fd.maturity_day);
        // 本金与利息分两笔入账：本金是投资往来（FD_REDEEM），利息才是投资收益（INTEREST），口径见 metrics.js
        creditCash(db, u.id, fd.principal_cents, 'FD_REDEEM', { product_id: fd.product_id, category: '定存兑付', journalType: 'FD_CLOSE', description: '定存到期兑付本金 ' + money.formatCents(fd.principal_cents) + '（模拟）' });
        if (interest > 0) creditCash(db, u.id, interest, 'INTEREST', { product_id: fd.product_id, description: '定存到期利息 ' + money.formatCents(interest) + '（模拟）' });
        db.prepare("UPDATE fixed_deposits SET status = 'MATURED' WHERE id = ?").run(fd.id);
      }
      // 提醒检查
      const alerts = db.prepare("SELECT * FROM alerts WHERE user_id = ? AND status = 'ACTIVE'").all(u.id);
      for (const a of alerts) {
        const p = PRODUCT_MAP[a.product_id];
        if (!p) continue;
        const cur = priceAt(p, day); // tick 内 day 已推进，取当日价
        let fired = false;
        if (a.condition === 'ABOVE' && cur >= a.threshold_cents) fired = true;
        if (a.condition === 'BELOW' && cur <= a.threshold_cents) fired = true;
        if (a.condition === 'DAY_CHANGE') {
          const prev = priceAt(p, day - 1);
          const chg = Math.abs(cur - prev) / prev;
          if (chg * 10000 >= a.threshold_cents) fired = true; // threshold 存为基点
        }
        if (fired) {
          if (a.mode === 'ONCE') db.prepare("UPDATE alerts SET status = 'FIRED', last_fired_at = ? WHERE id = ?").run(now, a.id);
          else db.prepare('UPDATE alerts SET last_fired_at = ? WHERE id = ?').run(now, a.id);
          if (audit) audit(u.id, null, 'alert_fired', `${p.name} 提醒触发（${a.condition}，现价 $${(cur / 100).toFixed(2)}）`, '');
        }
      }
      snapshotUser(db, u.id, day);
    }
    return day;
  });
}

// 入账统一走 wallet.applyCash（条件更新 + 流水 + 复式分录）
function creditCash(db, userId, amountCents, type, opts = {}) {
  const { applyCash } = require('./wallet');
  return applyCash(db, {
    userId, delta: amountCents, type, journalType: opts.journalType, category: opts.category || '投资收益',
    description: opts.description || '', product_id: opts.product_id || null,
  }).balance;
}

module.exports = {
  PRODUCTS, PRODUCT_MAP, HISTORY_DAYS, TICK_MS,
  priceAt, priceHistory, latestPrices, currentDay, ensureHistory, seedProducts,
  portfolioValue, snapshotUser, backfillCashHistory, tick, creditCash, dailyReturn, accruedInterest, holdingValue,
};
