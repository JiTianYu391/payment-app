// 接口幂等（参考 Stripe Idempotency-Key 与 PayPal-Request-Id 的做法）：
// - 客户端在请求头 Idempotency-Key（兼容 body.idempotency_key）里带一个唯一键（建议 UUID v4）；
// - 键按（用户, 接口 scope, 键）唯一；请求体（去掉 PIN 等敏感字段）做 SHA-256 摘要；
// - 首次请求成功（2xx）后保存状态码与响应体，24 小时内同键同参数重放原响应，响应头带 Idempotent-Replayed: true；
// - 同键不同参数 → 422 IDEMPOTENCY_KEY_REUSED；同键请求仍在处理中 → 409 IDEMPOTENCY_IN_PROGRESS；
// - 首次请求失败（非 2xx）时删除占位记录，客户端可用同一个键安全重试（失败请求不产生资金变动，均在事务内回滚）。
'use strict';

const crypto = require('crypto');
const { sendError } = require('./errors');

const TTL_MS = 24 * 3600 * 1000;
const KEY_RE = /^[A-Za-z0-9_\-:.]{8,255}$/;
const OMIT = new Set(['pin', 'password', 'idempotency_key', 'confirm_token']);

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => !OMIT.has(k)).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function requestHash(req) {
  return crypto.createHash('sha256').update(req.method + ' ' + req.baseUrl + req.path + '\n' + stableStringify(req.body || {})).digest('hex');
}

function readKey(req) {
  const h = req.get('Idempotency-Key');
  if (h) return String(h).trim();
  if (req.body && req.body.idempotency_key) return String(req.body.idempotency_key).trim();
  return '';
}

// required=false 时没有键的请求照常处理（兼容旧客户端）；新前端总会带键。
function idempotent(db, scope, opts = {}) {
  return (req, res, next) => {
    const key = readKey(req);
    if (!key) {
      if (opts.required) return sendError(req, res, 400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少 Idempotency-Key 请求头');
      return next();
    }
    if (!KEY_RE.test(key)) return sendError(req, res, 400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key 格式不正确：8–255 位字母、数字或 - _ : .');
    const userId = req.user ? req.user.id : 0;
    const hash = requestHash(req);
    const now = Date.now();
    const existing = db.prepare('SELECT * FROM idempotency_keys WHERE user_id = ? AND scope = ? AND idem_key = ?').get(userId, scope, key);
    if (existing && now - existing.created_at > TTL_MS) {
      db.prepare('DELETE FROM idempotency_keys WHERE id = ?').run(existing.id);
    } else if (existing) {
      if (existing.request_hash !== hash) {
        return sendError(req, res, 422, 'IDEMPOTENCY_KEY_REUSED', '同一个 Idempotency-Key 已用于参数不同的请求，请为新操作生成新的键');
      }
      if (existing.state !== 'DONE') {
        return sendError(req, res, 409, 'IDEMPOTENCY_IN_PROGRESS', '相同请求正在处理中，请稍后查询结果，不要重复提交');
      }
      if (req.log) req.log.info('idempotency.replay', { scope, key });
      res.set('Idempotent-Replayed', 'true');
      return res.status(existing.status_code).json(JSON.parse(existing.response_json));
    }
    let rowId;
    try {
      rowId = db.prepare('INSERT INTO idempotency_keys (user_id, scope, idem_key, request_hash, state, created_at) VALUES (?,?,?,?,?,?)')
        .run(userId, scope, key, hash, 'IN_PROGRESS', now).lastInsertRowid;
    } catch (e) {
      // UNIQUE 冲突：另一进程刚刚插入同一个键
      return sendError(req, res, 409, 'IDEMPOTENCY_IN_PROGRESS', '相同请求正在处理中，请稍后查询结果，不要重复提交');
    }
    const origJson = res.json.bind(res);
    res.json = (body) => {
      try {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          db.prepare('UPDATE idempotency_keys SET state = ?, status_code = ?, response_json = ? WHERE id = ?')
            .run('DONE', res.statusCode, JSON.stringify(body), rowId);
        } else {
          db.prepare('DELETE FROM idempotency_keys WHERE id = ?').run(rowId);
        }
      } catch (e) {
        if (req.log) req.log.error('idempotency.persist_failed', { err: e, scope });
      }
      return origJson(body);
    };
    return next();
  };
}

function purgeExpired(db) {
  return db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(Date.now() - TTL_MS).changes;
}

module.exports = { idempotent, purgeExpired, requestHash, TTL_MS };
