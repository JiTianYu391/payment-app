// 复式账本（只追加）。
// 约定：每笔分录 amount_cents 为带符号整数；同一 journal 内全部分录之和必须为 0。
// 账户余额 = 该账户分录之和。用户钱包账户为 account='wallet' + user_id，其余额必须等于 wallets.balance_cents。
// 对手科目（平台/外部/清算）见 CONTRA_ACCOUNTS；清算科目（clearing:*）在全部往来完成后应归零或等于在途金额。
'use strict';

const crypto = require('crypto');

const WALLET = 'wallet';

// 流水类型 → 对手科目。流水类型沿用历史值（bonus / topup / transfer_in …），保证旧数据与接口不变。
const CONTRA_ACCOUNTS = {
  bonus: 'platform:promotions',          // 体验金：平台营销支出
  topup: 'external:topup_source',        // 演示充值：外部资金来源
  transfer_out: 'clearing:p2p',          // 用户间转账：经 P2P 清算科目，往来两笔后清算科目归零
  transfer_in: 'clearing:p2p',
  pay: 'external:merchants',             // 商户付款
  refund: 'external:merchants',          // 商户退款
  withdrawal: 'clearing:withdrawals',    // 提现申请：资金转入在途科目，等待审核
  withdrawal_reversal: 'clearing:withdrawals', // 提现驳回：从在途科目退回钱包
  BUY: 'market:simulated',               // 模拟市场买卖
  SELL: 'market:simulated',
  DIVIDEND: 'market:income',             // 分红 / 利息
  INTEREST: 'market:income',
  FD_OPEN: 'deposits:fixed',             // 定存申购 / 支取 / 到期
  FD_CLOSE: 'deposits:fixed',
  demo_reset: 'platform:demo_reset',
  opening_balance: 'platform:opening_balance', // 升级前已有余额的期初分录
};

function contraFor(type, override) {
  return override || CONTRA_ACCOUNTS[type] || 'platform:other';
}

function newJournalId() {
  return 'jnl_' + crypto.randomUUID().replace(/-/g, '');
}

// 写入一个平衡的 journal。entries: [{ account, user_id?, amount_cents }]
function post(db, { journalType, entries, refType, refId, memo, journalId }) {
  if (!Array.isArray(entries) || entries.length < 2) throw new Error('journal 至少需要两条分录');
  let sum = 0;
  for (const e of entries) {
    if (!Number.isInteger(e.amount_cents)) throw new Error('分录金额必须是整数分');
    sum += e.amount_cents;
  }
  if (sum !== 0) throw new Error(`journal 借贷不平衡（差额 ${sum}）`);
  const id = journalId || newJournalId();
  const now = Date.now();
  const stmt = db.prepare('INSERT INTO ledger_entries (journal_id, journal_type, account, user_id, amount_cents, currency, ref_type, ref_id, memo, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const e of entries) {
    stmt.run(id, journalType, e.account, e.user_id === undefined ? null : e.user_id, e.amount_cents, 'USD', refType || null, refId === undefined ? null : refId, memo || null, now);
  }
  return id;
}

function walletLedgerBalance(db, userId) {
  const r = db.prepare('SELECT SUM(amount_cents) AS s FROM ledger_entries WHERE account = ? AND user_id = ?').get(WALLET, userId);
  return (r && r.s) || 0;
}

function accountBalance(db, account) {
  const r = db.prepare('SELECT SUM(amount_cents) AS s FROM ledger_entries WHERE account = ?').get(account);
  return (r && r.s) || 0;
}

// 升级前已有余额的钱包没有分录：补一条期初 journal，使钱包余额与账本一致。幂等（只处理无分录的钱包）。
function backfillOpeningBalances(db, withTransaction) {
  const withEntries = new Set(
    db.prepare('SELECT user_id, COUNT(*) AS c FROM ledger_entries WHERE account = ? GROUP BY user_id').all(WALLET).map((r) => r.user_id),
  );
  let count = 0;
  const wallets = db.prepare('SELECT user_id, balance_cents FROM wallets').all();
  withTransaction(() => {
    for (const w of wallets) {
      if (withEntries.has(w.user_id) || !w.balance_cents) continue;
      post(db, {
        journalType: 'opening_balance',
        entries: [
          { account: WALLET, user_id: w.user_id, amount_cents: w.balance_cents },
          { account: CONTRA_ACCOUNTS.opening_balance, amount_cents: -w.balance_cents },
        ],
        memo: '升级到 SpacePay 账本时的期初余额',
      });
      count++;
    }
  });
  return count;
}

// 对账：返回全部差异；ok=true 表示三项检查全部通过。
function reconcile(db) {
  const issues = [];
  // 1) 每个 journal 借贷平衡
  const journals = db.prepare('SELECT journal_id, SUM(amount_cents) AS s, COUNT(*) AS c FROM ledger_entries GROUP BY journal_id').all();
  for (const j of journals) {
    if (j.s !== 0) issues.push({ check: 'journal_balanced', journal_id: j.journal_id, difference_cents: j.s });
  }
  // 2) 钱包余额 = 账本钱包科目余额
  const ledgerByUser = new Map(
    db.prepare('SELECT user_id, SUM(amount_cents) AS s FROM ledger_entries WHERE account = ? GROUP BY user_id').all(WALLET).map((r) => [r.user_id, r.s]),
  );
  const wallets = db.prepare('SELECT user_id, balance_cents FROM wallets').all();
  let walletTotal = 0;
  for (const w of wallets) {
    walletTotal += w.balance_cents;
    const l = ledgerByUser.get(w.user_id) || 0;
    if (l !== w.balance_cents) issues.push({ check: 'wallet_vs_ledger', user_id: w.user_id, wallet_cents: w.balance_cents, ledger_cents: l, difference_cents: w.balance_cents - l });
    // 3) 钱包余额 = 最后一条流水的交易后余额
    const last = db.prepare('SELECT balance_after_cents FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(w.user_id);
    if (last && last.balance_after_cents !== w.balance_cents) {
      issues.push({ check: 'wallet_vs_last_transaction', user_id: w.user_id, wallet_cents: w.balance_cents, last_balance_after_cents: last.balance_after_cents, difference_cents: w.balance_cents - last.balance_after_cents });
    }
  }
  for (const w of wallets) {
    if (w.balance_cents < 0) issues.push({ check: 'non_negative_balance', user_id: w.user_id, wallet_cents: w.balance_cents });
  }
  // 清算科目：P2P 应为 0；提现在途科目余额 = 待审核提现金额合计
  const p2p = accountBalance(db, 'clearing:p2p');
  if (p2p !== 0) issues.push({ check: 'clearing_p2p_zero', balance_cents: p2p });
  const pendingW = db.prepare("SELECT SUM(amount_cents) AS s FROM withdrawals WHERE status = 'PENDING'").get();
  const pendingCents = (pendingW && pendingW.s) || 0;
  const wClearing = accountBalance(db, 'clearing:withdrawals');
  if (wClearing !== pendingCents) issues.push({ check: 'clearing_withdrawals_matches_pending', balance_cents: wClearing, pending_cents: pendingCents });

  const totalEntries = db.prepare('SELECT COUNT(*) AS c FROM ledger_entries').get().c;
  return {
    ok: issues.length === 0,
    checked_at: new Date().toISOString(),
    journals: journals.length,
    entries: totalEntries,
    wallets: wallets.length,
    wallet_total_cents: walletTotal,
    clearing: { p2p_cents: p2p, withdrawals_in_transit_cents: wClearing },
    issues,
  };
}

module.exports = { WALLET, CONTRA_ACCOUNTS, contraFor, post, newJournalId, walletLedgerBalance, accountBalance, backfillOpeningBalances, reconcile };
