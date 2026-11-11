// 交易状态机：只允许表中列出的状态迁移，其余一律拒绝（409）。
'use strict';

const { AppError } = require('./errors');

const MACHINES = {
  // 支付：即时成功；之后只能被（部分）退款，终态 REFUNDED
  payment: {
    SUCCEEDED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
    PARTIALLY_REFUNDED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
    REFUNDED: [],
  },
  // 提现：申请后待审核；批准 → 成功，驳回 → 失败（资金冲正退回钱包）
  withdrawal: {
    PENDING: ['SUCCEEDED', 'FAILED'],
    SUCCEEDED: [],
    FAILED: [],
  },
  // 账户
  user: {
    ACTIVE: ['FROZEN'],
    FROZEN: ['ACTIVE'],
  },
  // 商户支付单（开放平台）：创建 → 付款成功 / 失败 / 取消 / 过期 → 退款
  merchant_payment: {
    CREATED: ['SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED'],
    SUCCEEDED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
    PARTIALLY_REFUNDED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
    FAILED: [],
    CANCELED: [],
    EXPIRED: [],
    REFUNDED: [],
  },
  // 商户结算提现：申请 → 财务批准 / 驳回
  merchant_payout: {
    PENDING: ['SUCCEEDED', 'FAILED'],
    SUCCEEDED: [],
    FAILED: [],
  },
  // 商户准入：申请 → 通过 / 拒绝；通过后可暂停与恢复
  merchant: {
    PENDING: ['ACTIVE', 'REJECTED'],
    ACTIVE: ['SUSPENDED'],
    SUSPENDED: ['ACTIVE'],
    REJECTED: [],
  },
};

const LABELS = {
  SUCCEEDED: '成功', PARTIALLY_REFUNDED: '部分退款', REFUNDED: '已退款', PENDING: '待审核', FAILED: '已驳回',
  ACTIVE: '正常', FROZEN: '已冻结',
  CREATED: '待支付', CANCELED: '已取消', EXPIRED: '已过期', SUSPENDED: '已暂停', REJECTED: '已拒绝',
};

function canTransition(machine, from, to) {
  const m = MACHINES[machine];
  return !!(m && m[from] && m[from].includes(to));
}

function assertTransition(machine, from, to) {
  if (!canTransition(machine, from, to)) {
    throw new AppError(409, 'INVALID_STATE_TRANSITION', `当前状态「${LABELS[from] || from}」不能变更为「${LABELS[to] || to}」`, { machine, from, to });
  }
}

module.exports = { MACHINES, LABELS, canTransition, assertTransition };
