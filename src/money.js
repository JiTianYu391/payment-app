// 金额工具：全部以最小货币单位（分，整数）运算，禁止浮点数参与金额计算。
// - 输入解析：把 "12.34" / 12.34 这类十进制文本按字符串逐位解析成整数分，不经过 parseFloat。
// - 乘除：用 BigInt 计算 a×b÷c 并四舍五入（half-up，按绝对值），避免中间结果溢出或产生小数。
// - 展示：整数分 → "$1,234.56"，千分位与货币符号统一在这里处理。
'use strict';

const MAX_AMOUNT_CENTS = 1_000_000_000; // 单笔上限 $10,000,000.00，防止溢出与误输入

const CURRENCIES = {
  USD: { symbol: '$', scale: 2 },
};

// 把十进制文本解析为按 scale 放大的整数。成功返回 { ok: true, value }，失败返回 { ok: false, reason }。
function parseDecimal(input, scale) {
  if (input === null || input === undefined) return { ok: false, reason: 'missing' };
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, reason: 'format' };
    // JSON 数字统一转成最短十进制文本再按字符串解析（12.3 → "12.3"），不做浮点乘法
    input = String(input);
  }
  if (typeof input !== 'string') return { ok: false, reason: 'format' };
  const s = input.trim().replace(/,/g, '');
  const m = /^(-)?(\d{1,15})(?:\.(\d+))?$/.exec(s);
  if (!m) return { ok: false, reason: 'format' };
  const frac = m[3] || '';
  if (frac.length > scale) return { ok: false, reason: 'precision' };
  const digits = m[2] + frac.padEnd(scale, '0');
  const value = Number(BigInt(digits));
  return { ok: true, value: m[1] ? -value : value };
}

// 解析用户输入的金额（单位：元/美元），返回整数分。
// opts.allowZero：是否允许 0；opts.max：上限（分）。
function parseAmount(input, opts = {}) {
  const r = parseDecimal(input, 2);
  if (!r.ok) {
    if (r.reason === 'missing') return { ok: false, code: 'AMOUNT_REQUIRED', message: '请输入金额' };
    if (r.reason === 'precision') return { ok: false, code: 'AMOUNT_PRECISION', message: '金额最多保留 2 位小数' };
    return { ok: false, code: 'AMOUNT_INVALID', message: '金额格式不正确，例如 12.50' };
  }
  const cents = r.value;
  if (cents < 0) return { ok: false, code: 'AMOUNT_NEGATIVE', message: '金额不能为负数' };
  if (cents === 0 && !opts.allowZero) return { ok: false, code: 'AMOUNT_ZERO', message: '金额必须大于 0' };
  const max = opts.max === undefined ? MAX_AMOUNT_CENTS : opts.max;
  if (cents > max) return { ok: false, code: 'AMOUNT_TOO_LARGE', message: `金额不能超过 ${formatCents(max)}` };
  return { ok: true, cents };
}

function toBig(n) {
  if (typeof n === 'bigint') return n;
  if (!Number.isInteger(n)) throw new TypeError('金额运算只接受整数，收到: ' + n);
  return BigInt(n);
}

// 整数除法，四舍五入（按绝对值 half-up）。
function divRound(numerator, denominator) {
  const n = toBig(numerator);
  const d = toBig(denominator);
  if (d === 0n) throw new RangeError('除数不能为 0');
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  let q = an / ad;
  if ((an % ad) * 2n >= ad) q += 1n;
  const out = neg ? -q : q;
  const num = Number(out);
  if (!Number.isSafeInteger(num)) throw new RangeError('金额超出安全整数范围');
  return num;
}

// a × b ÷ c，全程整数。
function mulDiv(a, b, c) {
  return divRound(toBig(a) * toBig(b), c);
}

function groupThousands(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 整数分 → "1234.56"（无千分位，供 CSV/Excel 等机器可读场景）
function centsToDecimal(cents) {
  if (!Number.isInteger(cents)) throw new TypeError('cents 必须是整数');
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = String(Math.floor(abs / 100)) + '.' + String(abs % 100).padStart(2, '0');
  return (neg ? '-' : '') + s;
}

// 整数分 → "$1,234.56"；opts.signed 时正数带 "+"；负号统一使用 "−"（U+2212）。
function formatCents(cents, opts = {}) {
  const cur = CURRENCIES[opts.currency || 'USD'];
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const body = cur.symbol + groupThousands(String(Math.floor(abs / 100))) + '.' + String(abs % 100).padStart(2, '0');
  if (neg) return '−' + body;
  if (opts.signed && cents > 0) return '+' + body;
  return body;
}

module.exports = { parseDecimal, parseAmount, divRound, mulDiv, centsToDecimal, formatCents, MAX_AMOUNT_CENTS };
