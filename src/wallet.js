// 钱包资金变动的唯一入口。所有改动 wallets.balance_cents 的代码都必须调用 applyCash：
//   1) 条件更新余额（扣款时 WHERE balance_cents >= 扣款额，原子地防止透支与并发重复扣款）；
//   2) 写一条用户流水（transactions，含交易后余额）；
//   3) 写一个平衡的复式 journal（钱包科目 ± 金额，对手科目 ∓ 金额）。
// 调用方负责把它放进 withTransaction，使三步同时成功或同时回滚。
'use strict';

const ledger = require('./ledger');
const { AppError } = require('./errors');
const money = require('./money');

function currentSimDay(db) {
  try { return require('./products').currentDay(db); } catch (_) { return null; }
}

function balanceOf(db, userId) {
  const w = db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(userId);
  return w ? w.balance_cents : 0;
}

/**
 * @param {object} db
 * @param {object} p
 * @param {number} p.userId
 * @param {number} p.delta        带符号整数分：入账为正，出账为负
 * @param {string} p.type         流水类型（bonus/topup/transfer_in/transfer_out/pay/refund/withdrawal/...）
 * @param {string} [p.journalType] 账本 journal 类型（默认同 type）
 * @param {string} [p.contra]     对手科目（默认按类型映射）
 * @param {boolean} [p.allowNegative] 允许透支（仅演示重置清零等内部场景）
 */
function applyCash(db, p) {
  if (!Number.isInteger(p.delta)) throw new TypeError('delta 必须是整数分');
  const now = Date.now();
  if (p.delta < 0 && !p.allowNegative) {
    const debit = -p.delta;
    const r = db.prepare('UPDATE wallets SET balance_cents = balance_cents - ?, updated_at = ? WHERE user_id = ? AND balance_cents >= ?')
      .run(debit, now, p.userId, debit);
    if (!r.changes) {
      const have = balanceOf(db, p.userId);
      throw new AppError(400, 'INSUFFICIENT_FUNDS', `余额不足：还差 ${money.formatCents(debit - have)}`, { shortfall_cents: debit - have });
    }
  } else {
    const r = db.prepare('UPDATE wallets SET balance_cents = balance_cents + ?, updated_at = ? WHERE user_id = ?').run(p.delta, now, p.userId);
    if (!r.changes) {
      db.prepare('INSERT INTO wallets (user_id, balance_cents, updated_at) VALUES (?,?,?)').run(p.userId, p.delta, now);
    }
  }
  const balance = balanceOf(db, p.userId);
  const tx = db.prepare(`INSERT INTO transactions (user_id, type, amount_cents, balance_after_cents, counterparty_email, merchant, category, description, product_id, order_id, sim_day, status, ref_type, ref_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    p.userId, p.type, p.delta, balance, p.counterparty || null, p.merchant || null, p.category || null, p.description || '',
    p.product_id || null, p.order_id || null, p.simDay === undefined ? currentSimDay(db) : p.simDay,
    p.status || 'SUCCEEDED', p.refType || null, p.refId === undefined ? null : p.refId, now,
  );
  const journalId = ledger.post(db, {
    journalType: p.journalType || p.type,
    entries: [
      { account: ledger.WALLET, user_id: p.userId, amount_cents: p.delta },
      // contraUserId：对手科目不是钱包时（如 merchant:payable 按商户记账）指定其主体编号
      { account: ledger.contraFor(p.journalType || p.type, p.contra), user_id: p.contraUserId === undefined ? null : p.contraUserId, amount_cents: -p.delta },
    ],
    refType: p.refType || 'transaction',
    refId: p.refId === undefined ? tx.lastInsertRowid : p.refId,
    memo: p.description || null,
  });
  return { balance, transactionId: tx.lastInsertRowid, journalId };
}

module.exports = { applyCash, balanceOf };
