// 站内通知：交易、审核结果、安全事件。写入 notifications 表，用户可在通知中心查看。
// 邮件通知是可选的附加通道（SMTP），失败只记日志，不影响业务。
'use strict';

const { sendNotification } = require('./notifier');

function push(db, { userId, kind, title, body, refType, refId }) {
  if (!userId) return null;
  const r = db.prepare('INSERT INTO notifications (user_id, kind, title, body, ref_type, ref_id, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(userId, kind || 'system', title, body || '', refType || null, refId === undefined ? null : refId, Date.now());
  return r.lastInsertRowid;
}

// 邮件通知：同步查用户邮箱，异步发送（不阻塞请求）
function email(db, userId, subject, text, log) {
  try {
    const u = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
    if (!u || !u.email) return;
    sendNotification({ to: u.email, subject, text, log }).catch(() => {});
  } catch (_) { /* 通知失败不影响主流程 */ }
}

// 同时写站内通知与邮件
function notify(db, { userId, kind, title, body, refType, refId, emailText, log }) {
  push(db, { userId, kind, title, body, refType, refId });
  if (emailText) email(db, userId, title, emailText, log);
}

function unreadCount(db, userId) {
  const r = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId);
  return (r && r.c) || 0;
}

module.exports = { push, email, notify, unreadCount };
