// 交易查询与导出：多维筛选（时间、类型、状态、金额区间、商户、关键字、用户）、排序、分页，
// 以及按同一筛选条件导出 CSV / Excel。SQLite 后端在数据库里完成筛选与排序；
// JSON 降级后端只支持简单 SQL，读出后在内存中按同一组条件处理（两条路径共用 matches / compare）。
'use strict';

const v = require('./validate');
const money = require('./money');
const metrics = require('./metrics');
const { buildXlsx } = require('./xlsx');

const SORT_FIELDS = { created_at: 'created_at', amount: 'ABS(amount_cents)', id: 'id' };
const MAX_EXPORT_ROWS = 10000;

function parseFilters(q) {
  const f = {
    from: v.dateMs(q.from, '开始日期', false),
    to: v.dateMs(q.to, '结束日期', true),
    types: v.idList(q.type, Object.keys(metrics.TX_TYPES), '交易类型'),
    statuses: v.idList(q.status, Object.keys(metrics.TX_STATUSES), '交易状态'),
    min: v.optionalAmount(q.min_amount, '最小金额'),
    max: v.optionalAmount(q.max_amount, '最大金额'),
    merchant: q.merchant ? v.str(q, 'merchant', { max: 80, label: '商户' }) : '',
    category: q.category ? v.str(q, 'category', { max: 30, label: '分类' }) : '',
    q: q.q ? v.str(q, 'q', { max: 80, label: '关键字' }) : '',
    email: q.email ? v.str(q, 'email', { max: 120, label: '用户邮箱' }).toLowerCase() : '',
  };
  if (f.from !== null && f.to !== null && f.from > f.to) throw require('./errors').badRequest('DATE_RANGE_INVALID', '开始日期不能晚于结束日期');
  if (f.min !== null && f.max !== null && f.min > f.max) throw require('./errors').badRequest('AMOUNT_RANGE_INVALID', '最小金额不能大于最大金额');
  return f;
}

function parsePaging(q) {
  const sort = q.sort ? v.oneOf(String(q.sort), Object.keys(SORT_FIELDS), '排序字段') : 'created_at';
  const order = q.order ? v.oneOf(String(q.order).toLowerCase(), ['asc', 'desc'], '排序方向') : 'desc';
  const pageSize = v.intInRange(q.page_size, { min: 1, max: 200, def: 20, label: '每页条数' });
  const page = v.intInRange(q.page, { min: 1, max: 100000, def: 1, label: '页码' });
  return { sort, order, page, pageSize };
}

function includesCI(hay, needle) {
  return String(hay || '').toLowerCase().includes(needle.toLowerCase());
}

function matches(row, f, userIds) {
  if (userIds && !userIds.includes(row.user_id)) return false;
  if (f.from !== null && row.created_at < f.from) return false;
  if (f.to !== null && row.created_at > f.to) return false;
  if (f.types.length && !f.types.includes(row.type)) return false;
  if (f.statuses.length && !f.statuses.includes(row.status || 'SUCCEEDED')) return false;
  const abs = Math.abs(row.amount_cents);
  if (f.min !== null && abs < f.min) return false;
  if (f.max !== null && abs > f.max) return false;
  if (f.merchant && !includesCI(row.merchant, f.merchant)) return false;
  if (f.category && row.category !== f.category) return false;
  if (f.q && !(includesCI(row.description, f.q) || includesCI(row.merchant, f.q) || includesCI(row.counterparty_email, f.q))) return false;
  return true;
}

function compare(sort, order) {
  const dir = order === 'asc' ? 1 : -1;
  const key = sort === 'amount' ? (r) => Math.abs(r.amount_cents) : (r) => r[sort];
  return (a, b) => (key(a) - key(b) || a.id - b.id) * dir;
}

const escLike = (s) => '%' + s.replace(/[\\%_]/g, (c) => '\\' + c) + '%';

function sqlWhere(f, scopeUserId, userIds) {
  const w = [];
  const p = [];
  if (scopeUserId) { w.push('user_id = ?'); p.push(scopeUserId); }
  if (userIds) { w.push(`user_id IN (${userIds.map(() => '?').join(',')})`); p.push(...userIds); }
  if (f.from !== null) { w.push('created_at >= ?'); p.push(f.from); }
  if (f.to !== null) { w.push('created_at <= ?'); p.push(f.to); }
  if (f.types.length) { w.push(`type IN (${f.types.map(() => '?').join(',')})`); p.push(...f.types); }
  if (f.statuses.length) { w.push(`status IN (${f.statuses.map(() => '?').join(',')})`); p.push(...f.statuses); }
  if (f.min !== null) { w.push('ABS(amount_cents) >= ?'); p.push(f.min); }
  if (f.max !== null) { w.push('ABS(amount_cents) <= ?'); p.push(f.max); }
  if (f.merchant) { w.push("merchant LIKE ? ESCAPE '\\'"); p.push(escLike(f.merchant)); }
  if (f.category) { w.push('category = ?'); p.push(f.category); }
  if (f.q) { w.push("(description LIKE ? ESCAPE '\\' OR merchant LIKE ? ESCAPE '\\' OR counterparty_email LIKE ? ESCAPE '\\')"); p.push(escLike(f.q), escLike(f.q), escLike(f.q)); }
  return { where: w.length ? ' WHERE ' + w.join(' AND ') : '', params: p };
}

// 返回 { items, filtered_total, summary }；opts.scopeUserId 限定为某个用户；opts.limit/offset 优先于 page。
function query(db, backend, f, paging, opts = {}) {
  let userIds = null;
  if (f.email) {
    userIds = db.prepare('SELECT id FROM users WHERE email LIKE ?').all('%' + f.email + '%').map((r) => r.id);
    if (!userIds.length) return { items: [], filtered_total: 0, summary: metrics.summarize([]) };
  }
  const limit = opts.limit !== undefined ? opts.limit : paging.pageSize;
  const offset = opts.offset !== undefined ? opts.offset : (paging.page - 1) * paging.pageSize;
  if (backend === 'sqlite') {
    const { where, params } = sqlWhere(f, opts.scopeUserId, userIds);
    const dir = paging.order === 'asc' ? 'ASC' : 'DESC';
    const items = db.prepare(`SELECT * FROM transactions${where} ORDER BY ${SORT_FIELDS[paging.sort]} ${dir}, id ${dir} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const typeSums = db.prepare(`SELECT type, SUM(amount_cents) AS amount_cents, COUNT(*) AS c FROM transactions${where} GROUP BY type`).all(...params);
    const summary = metrics.summarize([]);
    let count = 0;
    for (const t of typeSums) {
      const s = metrics.summarize([{ type: t.type, amount_cents: t.amount_cents }]);
      for (const k of Object.keys(summary)) if (k !== 'count') summary[k] += s[k];
      count += t.c;
    }
    summary.count = count;
    return { items, filtered_total: count, summary };
  }
  const base = opts.scopeUserId
    ? db.prepare('SELECT * FROM transactions WHERE user_id = ?').all(opts.scopeUserId)
    : db.prepare('SELECT * FROM transactions').all();
  const rows = base.filter((r) => matches(r, f, userIds)).sort(compare(paging.sort, paging.order));
  return { items: rows.slice(offset, offset + limit), filtered_total: rows.length, summary: metrics.summarize(rows) };
}

function emailMap(db, items) {
  const ids = [...new Set(items.map((r) => r.user_id))];
  if (!ids.length) return new Map();
  const rows = db.prepare(`SELECT id, email FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return new Map(rows.map((r) => [r.id, r.email]));
}

function fmtTime(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function exportColumns(includeUser) {
  const cols = [
    { key: 'id', header: '交易编号', type: 'int', width: 10 },
    { key: 'time', header: '时间（UTC）', width: 20 },
  ];
  if (includeUser) cols.push({ key: 'user', header: '用户邮箱', width: 26 });
  cols.push(
    { key: 'type', header: '类型', width: 10 },
    { key: 'status', header: '状态', width: 10 },
    { key: 'party', header: '商户 / 对方', width: 22 },
    { key: 'desc', header: '说明', width: 40 },
    { key: 'amount', header: '金额', type: 'amount', width: 14 },
    { key: 'currency', header: '币种', width: 6 },
    { key: 'balance', header: '交易后余额', type: 'amount', width: 14 },
  );
  return cols;
}

function exportRows(items, cols, emails) {
  return items.map((r) => cols.map((c) => {
    switch (c.key) {
      case 'id': return r.id;
      case 'time': return fmtTime(r.created_at);
      case 'user': return emails.get(r.user_id) || '';
      case 'type': return metrics.TX_TYPES[r.type] || r.type;
      case 'status': return metrics.TX_STATUSES[r.status || 'SUCCEEDED'] || r.status;
      case 'party': return r.merchant || r.counterparty_email || '';
      case 'desc': return r.description || '';
      case 'amount': return money.centsToDecimal(r.amount_cents);
      case 'currency': return 'USD';
      case 'balance': return money.centsToDecimal(r.balance_after_cents);
      default: return '';
    }
  }));
}

// CSV：UTF-8 BOM（Excel 正确识别中文）；以 = + - @ 开头的文本加单引号前缀，防止公式注入。
function toCsv(cols, rows) {
  const cell = (val, col) => {
    let s = val === null || val === undefined ? '' : String(val);
    if (col.type !== 'amount' && col.type !== 'int' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.map((c) => cell(c.header, {})).join(',')];
  for (const r of rows) lines.push(r.map((x, i) => cell(x, cols[i])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function buildExport(db, backend, f, paging, { format, scopeUserId, includeUser }) {
  const res = query(db, backend, f, paging, { scopeUserId, limit: MAX_EXPORT_ROWS + 1, offset: 0 });
  if (res.filtered_total > MAX_EXPORT_ROWS) {
    throw require('./errors').badRequest('EXPORT_TOO_LARGE', `符合条件的交易有 ${res.filtered_total} 笔，单次最多导出 ${MAX_EXPORT_ROWS} 笔，请缩小时间范围`);
  }
  const cols = exportColumns(includeUser);
  const rows = exportRows(res.items, cols, includeUser ? emailMap(db, res.items) : new Map());
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'xlsx') {
    return {
      body: buildXlsx({ sheetName: '交易明细', columns: cols, rows }),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `spacepay-transactions-${stamp}.xlsx`, count: rows.length,
    };
  }
  return { body: Buffer.from(toCsv(cols, rows), 'utf8'), contentType: 'text/csv; charset=utf-8', filename: `spacepay-transactions-${stamp}.csv`, count: rows.length };
}

module.exports = { parseFilters, parsePaging, query, emailMap, buildExport, toCsv, matches, compare, MAX_EXPORT_ROWS };
