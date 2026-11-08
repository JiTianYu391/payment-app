'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const money = require('../../src/money');

test('parseAmount: 按字符串解析为整数分，不经过浮点', () => {
  assert.deepEqual(money.parseAmount('12.34'), { ok: true, cents: 1234 });
  assert.deepEqual(money.parseAmount('0.1'), { ok: true, cents: 10 });
  assert.deepEqual(money.parseAmount(0.3), { ok: true, cents: 30 }); // 0.1+0.2 场景：JSON 数字按最短十进制文本解析
  assert.deepEqual(money.parseAmount('1,000.50'), { ok: true, cents: 100050 });
  assert.deepEqual(money.parseAmount(' 7 '), { ok: true, cents: 700 });
  // 浮点陷阱：parseFloat('1.005')*100 = 100.49999999999999
  assert.deepEqual(money.parseAmount('1.00'), { ok: true, cents: 100 });
  assert.equal(money.parseAmount('19.99').cents, 1999);
});

test('parseAmount: 边界与错误输入', () => {
  assert.equal(money.parseAmount('0').code, 'AMOUNT_ZERO');
  assert.equal(money.parseAmount('0.00').code, 'AMOUNT_ZERO');
  assert.deepEqual(money.parseAmount('0', { allowZero: true }), { ok: true, cents: 0 });
  assert.equal(money.parseAmount('-1').code, 'AMOUNT_NEGATIVE');
  assert.equal(money.parseAmount('1.234').code, 'AMOUNT_PRECISION');
  assert.equal(money.parseAmount('abc').code, 'AMOUNT_INVALID');
  assert.equal(money.parseAmount('1e5').code, 'AMOUNT_INVALID');
  assert.equal(money.parseAmount(Infinity).code, 'AMOUNT_INVALID');
  assert.equal(money.parseAmount(NaN).code, 'AMOUNT_INVALID');
  assert.equal(money.parseAmount(undefined).code, 'AMOUNT_REQUIRED');
  assert.equal(money.parseAmount('').code, 'AMOUNT_INVALID');
  assert.equal(money.parseAmount({}).code, 'AMOUNT_INVALID');
  assert.equal(money.parseAmount('10000000.01').code, 'AMOUNT_TOO_LARGE');
  assert.equal(money.parseAmount('500.01', { max: 50000 }).code, 'AMOUNT_TOO_LARGE');
  assert.equal(money.parseAmount('500.00', { max: 50000 }).cents, 50000);
});

test('parseDecimal: 份额按 3 位小数解析', () => {
  assert.deepEqual(money.parseDecimal('0.5', 3), { ok: true, value: 500 });
  assert.deepEqual(money.parseDecimal('2.125', 3), { ok: true, value: 2125 });
  assert.equal(money.parseDecimal('2.1255', 3).reason, 'precision');
});

test('divRound / mulDiv: 整数运算，四舍五入（half-up）', () => {
  assert.equal(money.divRound(5, 2), 3);
  assert.equal(money.divRound(4, 3), 1);
  assert.equal(money.divRound(-5, 2), -3);
  assert.equal(money.mulDiv(119, 8372, 1000), 996); // 0.119 份 × $83.72 = $9.96268
  // 大数不溢出：1e9 分 × 320 基点 × 90 天
  assert.equal(money.mulDiv(1_000_000_000 * 320, 90, 10000 * 365), 7890411);
  assert.throws(() => money.mulDiv(1.5, 2, 3), TypeError);
  assert.throws(() => money.divRound(1, 0), RangeError);
});

test('formatCents / centsToDecimal: 千分位与货币符号', () => {
  assert.equal(money.formatCents(0), '$0.00');
  assert.equal(money.formatCents(5), '$0.05');
  assert.equal(money.formatCents(123456789), '$1,234,567.89');
  assert.equal(money.formatCents(-1050), '−$10.50');
  assert.equal(money.formatCents(1050, { signed: true }), '+$10.50');
  assert.equal(money.centsToDecimal(-5), '-0.05');
  assert.equal(money.centsToDecimal(100000), '1000.00');
});
