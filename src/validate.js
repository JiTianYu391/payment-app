// 外部输入校验：每个函数要么返回规范化后的值，要么抛出 AppError(400)。
// 错误信息面向用户（说明哪个字段、正确格式是什么）；完整上下文由错误中间件写入日志。
'use strict';

const { badRequest } = require('./errors');
const money = require('./money');

function str(body, field, opts = {}) {
  const raw = body ? body[field] : undefined;
  if (raw === undefined || raw === null || raw === '') {
    if (opts.required) throw badRequest('FIELD_REQUIRED', `${opts.label || field}不能为空`, { field });
    return opts.default === undefined ? '' : opts.default;
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') throw badRequest('FIELD_INVALID', `${opts.label || field}格式不正确`, { field });
  const v = String(raw).trim();
  if (opts.max && v.length > opts.max) throw badRequest('FIELD_TOO_LONG', `${opts.label || field}不能超过 ${opts.max} 个字符`, { field });
  if (opts.min && v.length < opts.min) throw badRequest('FIELD_TOO_SHORT', `${opts.label || field}至少 ${opts.min} 个字符`, { field });
  if (opts.pattern && !opts.pattern.test(v)) throw badRequest('FIELD_INVALID', opts.message || `${opts.label || field}格式不正确`, { field });
  return v;
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw badRequest('FIELD_INVALID', `${label}只能是：${allowed.join(' / ')}`);
  return value;
}

function amount(body, field, opts = {}) {
  const r = money.parseAmount(body ? body[field] : undefined, opts);
  if (!r.ok) throw badRequest(r.code, (opts.label ? opts.label + '：' : '') + r.message, { field });
  return r.cents;
}

function optionalAmount(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const r = money.parseAmount(value, { allowZero: true });
  if (!r.ok) throw badRequest(r.code, `${label}：${r.message}`);
  return r.cents;
}

function intInRange(value, { min, max, def, label }) {
  if (value === undefined || value === null || value === '') return def;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest('FIELD_INVALID', `${label}必须是 ${min}–${max} 之间的整数`);
  return n;
}

// 日期：接受 YYYY-MM-DD 或 ISO 时间。endOfDay=true 时，纯日期取当天 23:59:59.999（含当天）。
function dateMs(value, label, endOfDay) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  let ms;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    ms = Date.parse(s + 'T00:00:00.000Z');
    if (endOfDay) ms += 24 * 3600 * 1000 - 1;
  } else {
    ms = Date.parse(s);
  }
  if (!Number.isFinite(ms)) throw badRequest('DATE_INVALID', `${label}格式不正确，请使用 YYYY-MM-DD`);
  return ms;
}

function idList(value, allowed, label) {
  if (value === undefined || value === null || value === '') return [];
  const items = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  for (const it of items) if (!allowed.includes(it)) throw badRequest('FIELD_INVALID', `${label}不支持「${it}」`);
  return items;
}

module.exports = { str, oneOf, amount, optionalAmount, intInRange, dateMs, idList };
