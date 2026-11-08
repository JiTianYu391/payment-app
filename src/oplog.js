// 操作日志：记录运营后台和关键资金操作（谁、对谁、做了什么、金额、原因、结果、请求编号）。
// 只追加，不提供修改或删除接口。与 audit_logs（用户自己的安全日志）分开存放。
'use strict';

function record(db, req, entry) {
  const actor = req.user || {};
  db.prepare(`INSERT INTO operation_logs (actor_id, actor_email, actor_role, action, target_type, target_id, amount_cents, reason, result, request_id, ip, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    actor.id || null, actor.email || null, actor.role || null, entry.action, entry.target_type || null,
    entry.target_id === undefined ? null : entry.target_id, entry.amount_cents === undefined ? null : entry.amount_cents,
    entry.reason || null, entry.result || 'SUCCEEDED', req.id || null, req.clientIp || null, Date.now(),
  );
  if (req.log) req.log.info('operation', { action: entry.action, target_type: entry.target_type, target_id: entry.target_id, amount_cents: entry.amount_cents, result: entry.result || 'SUCCEEDED' });
}

const ACTION_LABELS = {
  'refund.create': '发起退款',
  'user.freeze': '冻结账户',
  'user.unfreeze': '解冻账户',
  'user.role': '调整角色',
  'withdrawal.create': '申请提现',
  'withdrawal.approve': '批准提现',
  'withdrawal.reject': '驳回提现',
  'tx.export': '导出交易',
  'reconcile.run': '运行对账',
};

module.exports = { record, ACTION_LABELS };
