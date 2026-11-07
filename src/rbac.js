// 权限分级（参考 Stripe Dashboard 的预置角色：一个角色 = 一组权限，不做自定义角色）。
//   customer  终端用户：只能操作自己的账户（默认角色）
//   viewer    只读访客：可查看运营后台的交易、用户、提现、对账结果与操作日志，不能导出、不能操作
//   finance   财务：在只读基础上可导出报表、发起退款、审核提现、运行对账
//   admin     管理员：全部权限，另可冻结/解冻账户、调整角色
// 所有角色同时保留自己作为终端用户的钱包功能。
'use strict';

const { sendError } = require('./errors');

const PERMISSIONS = {
  'console.read': '查看运营后台',
  'tx.export': '导出交易报表',
  'refund.create': '发起退款',
  'withdrawal.review': '审核提现',
  'reconcile.run': '运行对账',
  'user.freeze': '冻结 / 解冻账户',
  'user.role': '调整用户角色',
};

const ROLES = {
  customer: { label: '用户', perms: [] },
  viewer: { label: '只读访客', perms: ['console.read'] },
  finance: { label: '财务', perms: ['console.read', 'tx.export', 'refund.create', 'withdrawal.review', 'reconcile.run'] },
  admin: { label: '管理员', perms: Object.keys(PERMISSIONS) },
};

function can(role, perm) {
  const r = ROLES[role] || ROLES.customer;
  return r.perms.includes(perm);
}

function permsOf(role) {
  return (ROLES[role] || ROLES.customer).perms.slice();
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) return sendError(req, res, 401, 'UNAUTHENTICATED', '未登录');
    if (!can(req.user.role, perm)) {
      return sendError(req, res, 403, 'FORBIDDEN', `当前角色（${(ROLES[req.user.role] || ROLES.customer).label}）没有「${PERMISSIONS[perm]}」权限`);
    }
    return next();
  };
}

function adminEmails() {
  return String(process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// 启动时与登录时调用：ADMIN_EMAILS 中的账号提升为管理员（只升不降）。
function bootstrapAdmins(db, email) {
  const list = adminEmails();
  if (!list.length) return 0;
  let n = 0;
  for (const e of email ? [email] : list) {
    if (!list.includes(e)) continue;
    n += db.prepare("UPDATE users SET role = 'admin' WHERE email = ? AND role != 'admin'").run(e).changes;
  }
  return n;
}

module.exports = { ROLES, PERMISSIONS, can, permsOf, requirePerm, bootstrapAdmins };
