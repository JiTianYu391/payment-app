// 运营后台 API（/api/admin/*）。权限见 src/rbac.js；关键操作需二次确认（src/confirm.js）并写操作日志（src/oplog.js）。
'use strict';

const money = require('./money');
const v = require('./validate');
const wallet = require('./wallet');
const ledger = require('./ledger');
const metrics = require('./metrics');
const reports = require('./reports');
const rbac = require('./rbac');
const state = require('./state');
const oplog = require('./oplog');
const notify = require('./notify');
const { idempotent } = require('./idempotency');
const { requireConfirmation } = require('./confirm');
const { AppError, badRequest, notFound, conflict } = require('./errors');

const fmt = (c) => money.formatCents(c);
const now = () => Date.now();
const DAY_MS = 24 * 3600 * 1000;

function idParam(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('ID_INVALID', '编号格式不正确');
  return id;
}

function reasonOf(body, required) {
  return v.str(body, 'reason', { required, min: required ? 2 : 0, max: 200, label: '原因' });
}

module.exports = function mountAdmin(app, { db, backend, withTransaction, auth, requirePerm }) {
  const read = [auth, requirePerm('console.read')];

  // 角色与权限说明（前端据此显示菜单）
  app.get('/api/admin/roles', auth, (req, res) => {
    res.json({ ok: true, roles: rbac.ROLES, permissions: rbac.PERMISSIONS, mine: { role: req.user.role, permissions: req.user.permissions } });
  });

  // ---------- 概览：关键指标 + 近 14 天按日收支（口径见 metrics.js） ----------
  app.get('/api/admin/overview', ...read, (req, res) => {
    const days = v.intInRange(req.query.days, { min: 7, max: 90, def: 14, label: '统计天数' });
    const todayStart = Math.floor(now() / DAY_MS) * DAY_MS;
    const since = todayStart - (days - 1) * DAY_MS;
    const rows = db.prepare('SELECT type, amount_cents, created_at FROM transactions WHERE created_at >= ?').all(since);
    const buckets = [];
    for (let i = 0; i < days; i++) buckets.push({ date: new Date(since + i * DAY_MS).toISOString().slice(0, 10), rows: [] });
    for (const r of rows) {
      const idx = Math.floor((r.created_at - since) / DAY_MS);
      if (idx >= 0 && idx < days) buckets[idx].rows.push(r);
    }
    const series = buckets.map((b) => { const s = metrics.summarize(b.rows); return { date: b.date, inflow_cents: s.inflow_cents, outflow_cents: s.outflow_cents, count: s.count }; });
    const period = metrics.summarize(rows);
    const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const frozen = db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'FROZEN'").get().c;
    const pending = db.prepare("SELECT COUNT(*) AS c, SUM(amount_cents) AS s FROM withdrawals WHERE status = 'PENDING'").get();
    const walletTotal = db.prepare('SELECT SUM(balance_cents) AS s FROM wallets').get().s || 0;
    res.json({
      ok: true,
      period: { from: since, to: todayStart + DAY_MS - 1, days, label: `近 ${days} 天（UTC，${buckets[0].date} 至 ${buckets[days - 1].date}）` },
      kpis: {
        users, frozen_users: frozen, wallet_total_cents: walletTotal,
        pending_withdrawals: pending.c, pending_withdrawals_cents: pending.s || 0,
        inflow_cents: period.inflow_cents, outflow_cents: period.outflow_cents, transactions: period.count,
      },
      series, definitions: metrics.DEFINITIONS,
    });
  });

  // ---------- 交易：筛选 / 排序 / 分页 / 导出 ----------
  app.get('/api/admin/transactions', ...read, (req, res) => {
    const f = reports.parseFilters(req.query);
    const paging = reports.parsePaging(req.query);
    const r = reports.query(db, backend, f, paging);
    const emails = reports.emailMap(db, r.items);
    res.json({
      ok: true, items: r.items.map((t) => ({ ...t, user_email: emails.get(t.user_id) || null })),
      filtered_total: r.filtered_total, summary: r.summary, page: paging.page, page_size: paging.pageSize,
      total_pages: Math.max(1, Math.ceil(r.filtered_total / paging.pageSize)), sort: paging.sort, order: paging.order,
      period: { from: f.from, to: f.to, label: metrics.periodLabel(f.from, f.to) },
    });
  });

  app.get('/api/admin/transactions/export', auth, requirePerm('tx.export'), (req, res) => {
    const f = reports.parseFilters(req.query);
    const paging = reports.parsePaging(req.query);
    const format = v.oneOf(String(req.query.format || 'csv'), ['csv', 'xlsx'], '导出格式');
    const out = reports.buildExport(db, backend, f, paging, { format, includeUser: true });
    oplog.record(db, req, { action: 'tx.export', target_type: 'transactions', reason: `${format.toUpperCase()} ${out.count} 笔；筛选 ${JSON.stringify(req.query)}` });
    res.set('Content-Type', out.contentType);
    res.set('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.body);
  });

  // ---------- 用户：列表 / 冻结 / 解冻 / 角色 ----------
  app.get('/api/admin/users', ...read, (req, res) => {
    const q = v.str(req.query, 'q', { max: 120 }).toLowerCase();
    const status = req.query.status ? v.oneOf(String(req.query.status), ['ACTIVE', 'FROZEN'], '账户状态') : '';
    const page = v.intInRange(req.query.page, { min: 1, max: 100000, def: 1, label: '页码' });
    const pageSize = v.intInRange(req.query.page_size, { min: 1, max: 100, def: 20, label: '每页条数' });
    let rows = db.prepare('SELECT id, email, nickname, role, status, frozen_reason, frozen_at, created_at FROM users ORDER BY id DESC').all();
    if (q) rows = rows.filter((u) => u.email.includes(q) || String(u.nickname).toLowerCase().includes(q));
    if (status) rows = rows.filter((u) => (u.status || 'ACTIVE') === status);
    const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
    const balances = new Map(db.prepare('SELECT user_id, balance_cents FROM wallets').all().map((w) => [w.user_id, w.balance_cents]));
    res.json({
      ok: true, page, page_size: pageSize, filtered_total: rows.length,
      items: pageRows.map((u) => ({ ...u, role: u.role || 'customer', status: u.status || 'ACTIVE', balance_cents: balances.get(u.id) || 0 })),
    });
  });

  function loadUser(id) {
    const u = db.prepare('SELECT id, email, nickname, role, status FROM users WHERE id = ?').get(id);
    if (!u) throw notFound('USER_NOT_FOUND', '用户不存在');
    u.status = u.status || 'ACTIVE';
    u.role = u.role || 'customer';
    return u;
  }

  function setFrozen(freeze) {
    const action = freeze ? 'user.freeze' : 'user.unfreeze';
    return (req, res) => {
      const id = idParam(req);
      const reason = reasonOf(req.body, true);
      const u = loadUser(id);
      if (u.id === req.user.id) throw badRequest('SELF_ACTION_FORBIDDEN', '不能冻结或解冻自己的账户');
      const to = freeze ? 'FROZEN' : 'ACTIVE';
      try { state.assertTransition('user', u.status, to); } catch (e) {
        oplog.record(db, req, { action, target_type: 'user', target_id: id, reason, result: 'REJECTED:' + e.code });
        throw e;
      }
      if (!requireConfirmation(req, res, {
        action, params: { id, reason },
        summary: { title: freeze ? '确认冻结账户' : '确认解冻账户', lines: [['账户', `${u.email}（#${u.id}）`], ['当前状态', state.LABELS[u.status]], ['变更为', state.LABELS[to]], ['原因', reason], ['影响', freeze ? '冻结后该账户不能转账、付款、提现、下单，也不能接收转账' : '解冻后恢复全部资金操作']] },
      })) return;
      const r = db.prepare('UPDATE users SET status = ?, frozen_reason = ?, frozen_at = ? WHERE id = ? AND status = ?')
        .run(to, freeze ? reason : null, freeze ? now() : null, id, u.status);
      if (!r.changes) throw conflict('CONCURRENT_MODIFICATION', '账户状态已被其他人修改，请刷新后重试');
      oplog.record(db, req, { action, target_type: 'user', target_id: id, reason });
      res.json({ ok: true, message: freeze ? '账户已冻结' : '账户已解冻', user_id: id, status: to });
    };
  }
  app.post('/api/admin/users/:id/freeze', auth, requirePerm('user.freeze'), setFrozen(true));
  app.post('/api/admin/users/:id/unfreeze', auth, requirePerm('user.freeze'), setFrozen(false));

  app.post('/api/admin/users/:id/role', auth, requirePerm('user.role'), (req, res) => {
    const id = idParam(req);
    const role = v.oneOf(String((req.body && req.body.role) || ''), Object.keys(rbac.ROLES), '角色');
    const u = loadUser(id);
    if (u.id === req.user.id) throw badRequest('SELF_ACTION_FORBIDDEN', '不能修改自己的角色');
    if (!requireConfirmation(req, res, {
      action: 'user.role', params: { id, role },
      summary: { title: '确认调整角色', lines: [['账户', `${u.email}（#${u.id}）`], ['当前角色', rbac.ROLES[u.role].label], ['调整为', rbac.ROLES[role].label]] },
    })) return;
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    oplog.record(db, req, { action: 'user.role', target_type: 'user', target_id: id, reason: `${u.role} → ${role}` });
    res.json({ ok: true, message: '角色已更新', user_id: id, role });
  });

  // ---------- 支付与退款 ----------
  app.get('/api/admin/payments', ...read, (req, res) => {
    const status = req.query.status ? v.oneOf(String(req.query.status), Object.keys(state.MACHINES.payment), '支付状态') : '';
    const email = v.str(req.query, 'email', { max: 120 }).toLowerCase();
    let rows = db.prepare('SELECT * FROM payments ORDER BY id DESC').all();
    if (status) rows = rows.filter((p) => p.status === status);
    const emails = new Map(db.prepare('SELECT id, email FROM users').all().map((u) => [u.id, u.email]));
    if (email) rows = rows.filter((p) => (emails.get(p.user_id) || '').includes(email));
    const page = v.intInRange(req.query.page, { min: 1, max: 100000, def: 1, label: '页码' });
    const pageSize = v.intInRange(req.query.page_size, { min: 1, max: 100, def: 20, label: '每页条数' });
    res.json({
      ok: true, page, page_size: pageSize, filtered_total: rows.length,
      items: rows.slice((page - 1) * pageSize, page * pageSize).map((p) => ({ ...p, user_email: emails.get(p.user_id) || null, refundable_cents: p.amount_cents - p.refunded_cents })),
    });
  });

  app.get('/api/admin/payments/:id/refunds', ...read, (req, res) => {
    const id = idParam(req);
    res.json({ ok: true, items: db.prepare('SELECT * FROM refunds WHERE payment_id = ? ORDER BY id DESC').all(id) });
  });

  // 退款事务：管理员直接退款与退款申请审核共用
  function performRefund(p, amountCents, reason, operatorId) {
    const nextStatus = p.refunded_cents + amountCents === p.amount_cents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    state.assertTransition('payment', p.status, nextStatus);
    return withTransaction(() => {
      // 乐观锁：仅当已退金额仍等于读取时的值才更新，防止并发退款叠加超额
      const upd = db.prepare('UPDATE payments SET refunded_cents = refunded_cents + ?, status = ?, updated_at = ? WHERE id = ? AND refunded_cents = ?')
        .run(amountCents, nextStatus, now(), p.id, p.refunded_cents);
      if (!upd.changes) throw conflict('CONCURRENT_MODIFICATION', '该支付刚刚被其他人退款，请刷新后重试');
      const rf = db.prepare('INSERT INTO refunds (payment_id, user_id, amount_cents, reason, status, operator_id, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(p.id, p.user_id, amountCents, reason, 'SUCCEEDED', operatorId, now());
      const mv = wallet.applyCash(db, { userId: p.user_id, delta: amountCents, type: 'refund', merchant: p.merchant, category: '退款', description: `${p.merchant} 退款（支付 #${p.id}）：${reason}`, refType: 'refund', refId: rf.lastInsertRowid });
      db.prepare('UPDATE refunds SET transaction_id = ? WHERE id = ?').run(mv.transactionId, rf.lastInsertRowid);
      if (p.transaction_id) db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run(nextStatus, p.transaction_id);
      return { refundId: rf.lastInsertRowid, nextStatus, ...mv };
    });
  }

  app.post('/api/admin/payments/:id/refunds', auth, requirePerm('refund.create'), idempotent(db, 'refund'), (req, res) => {
    const id = idParam(req);
    const amountCents = v.amount(req.body, 'amount', { label: '退款金额' }); // 零金额 / 负数 / 格式错误在此拒绝
    const reason = reasonOf(req.body, true);
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    if (!p) throw notFound('PAYMENT_NOT_FOUND', '支付记录不存在');
    const remaining = p.amount_cents - p.refunded_cents;
    if (amountCents > remaining) {
      oplog.record(db, req, { action: 'refund.create', target_type: 'payment', target_id: id, amount_cents: amountCents, reason, result: 'REJECTED:REFUND_EXCEEDS_REMAINING' });
      throw badRequest('REFUND_EXCEEDS_REMAINING', `退款金额超过可退余额：最多可退 ${fmt(remaining)}`, { refundable_cents: remaining });
    }
    const nextStatus = p.refunded_cents + amountCents === p.amount_cents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    state.assertTransition('payment', p.status, nextStatus);
    const owner = db.prepare('SELECT email FROM users WHERE id = ?').get(p.user_id) || {};
    if (!requireConfirmation(req, res, {
      action: 'refund.create', params: { id, amount_cents: amountCents, reason, refunded_before: p.refunded_cents },
      summary: { title: '确认退款', lines: [['支付编号', `#${p.id}`], ['付款用户', owner.email || '—'], ['商户', p.merchant], ['原支付金额', fmt(p.amount_cents)], ['已退金额', fmt(p.refunded_cents)], ['本次退款', fmt(amountCents)], ['退款后状态', state.LABELS[nextStatus]], ['原因', reason]] },
    })) return;
    const out = performRefund(p, amountCents, reason, req.user.id);
    oplog.record(db, req, { action: 'refund.create', target_type: 'payment', target_id: id, amount_cents: amountCents, reason });
    notify.notify(db, { userId: p.user_id, kind: 'refund', title: `收到退款 ${fmt(amountCents)}`, body: `${p.merchant}：${reason}`, refType: 'refund', refId: out.refundId, log: req.log });
    res.json({ ok: true, message: `已退款 ${fmt(amountCents)}`, refund_id: out.refundId, payment_id: id, payment_status: out.nextStatus, refunded_cents: p.refunded_cents + amountCents, refundable_cents: remaining - amountCents });
  });

  // ---------- 用户退款申请审核 ----------
  app.get('/api/admin/refund-requests', ...read, (req, res) => {
    const status = req.query.status ? v.oneOf(String(req.query.status), ['PENDING', 'APPROVED', 'REJECTED'], '状态') : '';
    let rows = db.prepare('SELECT * FROM refund_requests ORDER BY id DESC').all();
    if (status) rows = rows.filter((r) => r.status === status);
    const emails = new Map(db.prepare('SELECT id, email FROM users').all().map((u) => [u.id, u.email]));
    const pays = new Map(db.prepare('SELECT id, merchant, amount_cents, refunded_cents, status FROM payments').all().map((p) => [p.id, p]));
    res.json({
      ok: true, filtered_total: rows.length,
      items: rows.slice(0, 200).map((r) => ({ ...r, user_email: emails.get(r.user_id) || null, payment: pays.get(r.payment_id) || null })),
    });
  });

  function reviewRefundRequest(approve) {
    return (req, res) => {
      const id = idParam(req);
      const note = v.str(req.body, 'reason', { max: 200, label: '审核备注' });
      const r = db.prepare('SELECT * FROM refund_requests WHERE id = ?').get(id);
      if (!r) throw notFound('REFUND_REQUEST_NOT_FOUND', '退款申请不存在');
      if (r.status !== 'PENDING') throw conflict('REFUND_REQUEST_DONE', '该申请已处理');
      const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(r.payment_id);
      if (!p) throw notFound('PAYMENT_NOT_FOUND', '支付记录不存在');
      if (r.user_id === req.user.id) throw new AppError(403, 'MAKER_CHECKER', '不能审核自己提交的退款申请');
      if (approve) {
        const remaining = p.amount_cents - p.refunded_cents;
        if (r.amount_cents > remaining) throw badRequest('REFUND_EXCEEDS_REMAINING', `可退余额已变化，当前最多可退 ${fmt(remaining)}`);
      }
      if (!requireConfirmation(req, res, {
        action: approve ? 'refund_request.approve' : 'refund_request.reject', params: { id, note },
        summary: { title: approve ? '确认批准退款申请' : '确认驳回退款申请', lines: [['申请编号', `#${r.id}`], ['支付编号', `#${p.id}`], ['商户', p.merchant], ['申请金额', fmt(r.amount_cents)], ['原因', r.reason], ['处理', approve ? '批准：资金退回用户钱包' : '驳回：不退款']] },
      })) return;
      if (approve) {
        const out = performRefund(p, r.amount_cents, r.reason || note || '用户退款申请', req.user.id);
        db.prepare("UPDATE refund_requests SET status = 'APPROVED', reviewed_by = ?, review_note = ?, reviewed_at = ?, refund_id = ? WHERE id = ?")
          .run(req.user.id, note || null, now(), out.refundId, id);
        notify.notify(db, { userId: r.user_id, kind: 'refund', title: `退款申请已通过 ${fmt(r.amount_cents)}`, body: note || '', refType: 'refund', refId: out.refundId, log: req.log });
      } else {
        db.prepare("UPDATE refund_requests SET status = 'REJECTED', reviewed_by = ?, review_note = ?, reviewed_at = ? WHERE id = ?")
          .run(req.user.id, note || null, now(), id);
        notify.push(db, { userId: r.user_id, kind: 'refund', title: '退款申请未通过', body: note || '如有疑问请联系客服', refType: 'refund_request', refId: id });
      }
      oplog.record(db, req, { action: approve ? 'refund_request.approve' : 'refund_request.reject', target_type: 'refund_request', target_id: id, amount_cents: r.amount_cents, reason: note || null });
      res.json({ ok: true, message: approve ? '已批准并退款' : '已驳回退款申请', refund_request_id: id, status: approve ? 'APPROVED' : 'REJECTED' });
    };
  }
  app.post('/api/admin/refund-requests/:id/approve', auth, requirePerm('refund_request.review'), reviewRefundRequest(true));
  app.post('/api/admin/refund-requests/:id/reject', auth, requirePerm('refund_request.review'), reviewRefundRequest(false));

  // ---------- 提现审核 ----------
  app.get('/api/admin/withdrawals', ...read, (req, res) => {
    const status = req.query.status ? v.oneOf(String(req.query.status), Object.keys(state.MACHINES.withdrawal), '提现状态') : '';
    let rows = db.prepare('SELECT * FROM withdrawals ORDER BY id DESC').all();
    if (status) rows = rows.filter((w) => w.status === status);
    const emails = new Map(db.prepare('SELECT id, email FROM users').all().map((u) => [u.id, u.email]));
    res.json({ ok: true, filtered_total: rows.length, items: rows.slice(0, 200).map((w) => ({ ...w, user_email: emails.get(w.user_id) || null })) });
  });

  function reviewWithdrawal(approve) {
    const action = approve ? 'withdrawal.approve' : 'withdrawal.reject';
    return (req, res) => {
      const id = idParam(req);
      const reason = reasonOf(req.body, !approve);
      const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
      if (!w) throw notFound('WITHDRAWAL_NOT_FOUND', '提现申请不存在');
      if (w.user_id === req.user.id) throw new AppError(403, 'MAKER_CHECKER', '不能审核自己提交的提现申请');
      const to = approve ? 'SUCCEEDED' : 'FAILED';
      try { state.assertTransition('withdrawal', w.status, to); } catch (e) {
        oplog.record(db, req, { action, target_type: 'withdrawal', target_id: id, amount_cents: w.amount_cents, reason, result: 'REJECTED:' + e.code });
        throw e;
      }
      const owner = db.prepare('SELECT email FROM users WHERE id = ?').get(w.user_id) || {};
      if (!requireConfirmation(req, res, {
        action, params: { id, reason },
        summary: { title: approve ? '确认批准提现' : '确认驳回提现', lines: [['申请编号', `#${w.id}`], ['申请用户', owner.email || '—'], ['金额', fmt(w.amount_cents)], ['收款账户', `尾号 ${w.destination}`], ['处理结果', approve ? '批准：模拟出款，资金离开平台' : '驳回：资金退回用户钱包'], ['备注', reason || '—']] },
      })) return;
      withTransaction(() => {
        const upd = db.prepare('UPDATE withdrawals SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND status = ?')
          .run(to, req.user.id, reason || null, now(), now(), id, 'PENDING');
        if (!upd.changes) throw conflict('CONCURRENT_MODIFICATION', '该申请已被其他人处理，请刷新');
        if (w.transaction_id) db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run(to, w.transaction_id);
        if (approve) {
          ledger.post(db, {
            journalType: 'withdrawal_payout',
            entries: [
              { account: 'clearing:withdrawals', amount_cents: -w.amount_cents },
              { account: 'external:bank_payouts', amount_cents: w.amount_cents },
            ],
            refType: 'withdrawal', refId: w.id, memo: `提现 #${w.id} 出款（模拟）`,
          });
        } else {
          wallet.applyCash(db, { userId: w.user_id, delta: w.amount_cents, type: 'withdrawal_reversal', category: '提现', description: `提现 #${w.id} 已驳回，资金退回：${reason}`, refType: 'withdrawal', refId: w.id });
        }
      });
      oplog.record(db, req, { action, target_type: 'withdrawal', target_id: id, amount_cents: w.amount_cents, reason });
      notify.notify(db, {
        userId: w.user_id, kind: 'withdrawal',
        title: approve ? `提现已出款 ${fmt(w.amount_cents)}` : `提现被驳回 ${fmt(w.amount_cents)}`,
        body: reason || (approve ? '资金已出款' : '资金已退回钱包'), refType: 'withdrawal', refId: id, log: req.log,
      });
      res.json({ ok: true, message: approve ? '已批准提现' : '已驳回提现，资金已退回用户钱包', withdrawal_id: id, status: to });
    };
  }
  app.post('/api/admin/withdrawals/:id/approve', auth, requirePerm('withdrawal.review'), reviewWithdrawal(true));
  app.post('/api/admin/withdrawals/:id/reject', auth, requirePerm('withdrawal.review'), reviewWithdrawal(false));

  // ---------- 对账 ----------
  app.get('/api/admin/reconciliation', auth, requirePerm('reconcile.run'), (req, res) => {
    const r = ledger.reconcile(db);
    oplog.record(db, req, { action: 'reconcile.run', target_type: 'ledger', reason: r.ok ? '无差异' : `差异 ${r.issues.length} 项`, result: r.ok ? 'SUCCEEDED' : 'MISMATCH' });
    if (!r.ok) req.log.error('reconcile.mismatch', { issues: r.issues.slice(0, 20) });
    res.json({ ok: true, reconciliation: r });
  });

  // ---------- 操作日志 ----------
  app.get('/api/admin/operation-logs', ...read, (req, res) => {
    const action = req.query.action ? v.oneOf(String(req.query.action), Object.keys(oplog.ACTION_LABELS), '操作类型') : '';
    const page = v.intInRange(req.query.page, { min: 1, max: 100000, def: 1, label: '页码' });
    const pageSize = v.intInRange(req.query.page_size, { min: 1, max: 100, def: 30, label: '每页条数' });
    let rows = db.prepare('SELECT * FROM operation_logs ORDER BY id DESC').all();
    if (action) rows = rows.filter((r) => r.action === action);
    res.json({ ok: true, page, page_size: pageSize, filtered_total: rows.length, labels: oplog.ACTION_LABELS, items: rows.slice((page - 1) * pageSize, page * pageSize) });
  });
};
