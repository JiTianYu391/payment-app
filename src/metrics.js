// 指标口径（唯一来源）。首页、钱包、流水、运营后台、导出报表都引用这里的定义，保证同一指标处处一致。
'use strict';

// 流水类型与中文名
const TX_TYPES = {
  bonus: '体验金', topup: '充值', transfer_in: '转入', transfer_out: '转出', pay: '付款', refund: '退款',
  withdrawal: '提现', withdrawal_reversal: '提现退回', BUY: '买入', SELL: '卖出', FD_REDEEM: '定存兑付',
  DIVIDEND: '分红', INTEREST: '利息', demo_reset: '演示重置',
};

// 交易状态（语义化徽标用）
const TX_STATUSES = {
  SUCCEEDED: '成功', PENDING: '处理中', FAILED: '失败', PARTIALLY_REFUNDED: '部分退款', REFUNDED: '已退款',
};

// 外部资金流入 / 流出：资金跨越钱包边界（进入或离开用户的 SpacePay 账户）
const INFLOW_TYPES = ['bonus', 'topup', 'transfer_in', 'refund', 'withdrawal_reversal'];
const OUTFLOW_TYPES = ['transfer_out', 'pay', 'withdrawal'];
const EXTERNAL_FLOW_TYPES = [...INFLOW_TYPES, ...OUTFLOW_TYPES];
// 投资往来（钱包 ↔ 持仓，不改变总资产）与投资收益
const INVEST_TYPES = ['BUY', 'SELL', 'FD_REDEEM'];
const INCOME_TYPES = ['DIVIDEND', 'INTEREST'];

const DEFINITIONS = {
  inflow: '收入 = 体验金 + 充值 + 转入 + 退款 + 提现退回（外部资金流入）',
  outflow: '支出 = 付款 + 转出 + 提现（外部资金流出）',
  net_flow: '净流入 = 收入 − 支出',
  investment_net: '投资净额 = 卖出 + 定存兑付 − 买入（钱包与持仓之间的往来，不计入收支）',
  investment_income: '投资收益 = 分红 + 利息',
  total_assets: '总资产 = 现金余额 + 持仓市值 + 定存本息',
};

// 按口径汇总一组流水（rows: [{ type, amount_cents }]）。金额为整数分。
function summarize(rows) {
  const out = { inflow_cents: 0, outflow_cents: 0, net_flow_cents: 0, investment_net_cents: 0, investment_income_cents: 0, count: 0 };
  for (const r of rows) {
    out.count++;
    if (INFLOW_TYPES.includes(r.type)) out.inflow_cents += r.amount_cents;
    else if (OUTFLOW_TYPES.includes(r.type)) out.outflow_cents += -r.amount_cents;
    else if (INVEST_TYPES.includes(r.type)) out.investment_net_cents += r.amount_cents;
    else if (INCOME_TYPES.includes(r.type)) out.investment_income_cents += r.amount_cents;
  }
  out.net_flow_cents = out.inflow_cents - out.outflow_cents;
  return out;
}

function periodLabel(fromMs, toMs) {
  const d = (ms) => new Date(ms).toISOString().slice(0, 10);
  if (!fromMs && !toMs) return '全部历史';
  if (fromMs && toMs) return `${d(fromMs)} 至 ${d(toMs)}（UTC）`;
  if (fromMs) return `${d(fromMs)} 起（UTC）`;
  return `截至 ${d(toMs)}（UTC）`;
}

module.exports = { TX_TYPES, TX_STATUSES, INFLOW_TYPES, OUTFLOW_TYPES, EXTERNAL_FLOW_TYPES, INVEST_TYPES, INCOME_TYPES, DEFINITIONS, summarize, periodLabel };
