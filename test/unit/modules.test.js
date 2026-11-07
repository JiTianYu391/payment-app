'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');

process.env.SESSION_SECRET = 'unit-test-secret';
process.env.LOG_LEVEL = 'silent';
const state = require('../../src/state');
const confirm = require('../../src/confirm');
const rbac = require('../../src/rbac');
const metrics = require('../../src/metrics');
const reports = require('../../src/reports');
const { buildXlsx, colName } = require('../../src/xlsx');
const { withRetry, withTimeout, retrySync } = require('../../src/resilience');
const logger = require('../../src/logger');

test('状态机：只允许定义过的迁移', () => {
  assert.ok(state.canTransition('payment', 'SUCCEEDED', 'PARTIALLY_REFUNDED'));
  assert.ok(state.canTransition('payment', 'PARTIALLY_REFUNDED', 'REFUNDED'));
  assert.ok(!state.canTransition('payment', 'REFUNDED', 'PARTIALLY_REFUNDED'));
  assert.ok(state.canTransition('withdrawal', 'PENDING', 'FAILED'));
  assert.ok(!state.canTransition('withdrawal', 'SUCCEEDED', 'FAILED'));
  assert.throws(() => state.assertTransition('withdrawal', 'FAILED', 'SUCCEEDED'), (e) => e.code === 'INVALID_STATE_TRANSITION' && e.status === 409);
});

test('二次确认令牌：绑定操作人、动作与参数，一次性', () => {
  const t = confirm.issue(7, 'refund.create', { id: 1, amount_cents: 500 });
  assert.equal(confirm.verify(t, 8, 'refund.create', { id: 1, amount_cents: 500 }).reason, 'mismatch'); // 换人
  assert.equal(confirm.verify(t, 7, 'refund.create', { id: 1, amount_cents: 501 }).reason, 'mismatch'); // 改金额
  assert.equal(confirm.verify(t + 'x', 7, 'refund.create', { id: 1, amount_cents: 500 }).reason, 'signature');
  assert.ok(confirm.verify(t, 7, 'refund.create', { id: 1, amount_cents: 500 }).ok);
  assert.equal(confirm.verify(t, 7, 'refund.create', { id: 1, amount_cents: 500 }).reason, 'used'); // 重放
});

test('权限：角色到权限的映射', () => {
  assert.ok(!rbac.can('customer', 'console.read'));
  assert.ok(rbac.can('viewer', 'console.read'));
  assert.ok(!rbac.can('viewer', 'tx.export'));
  assert.ok(rbac.can('finance', 'refund.create'));
  assert.ok(!rbac.can('finance', 'user.freeze'));
  assert.ok(rbac.can('admin', 'user.freeze'));
  assert.ok(!rbac.can('unknown-role', 'console.read'));
});

test('指标口径：收入/支出/投资往来分开汇总', () => {
  const s = metrics.summarize([
    { type: 'bonus', amount_cents: 5000 }, { type: 'pay', amount_cents: -1200 }, { type: 'refund', amount_cents: 200 },
    { type: 'BUY', amount_cents: -1000 }, { type: 'SELL', amount_cents: 1100 }, { type: 'DIVIDEND', amount_cents: 7 },
    { type: 'withdrawal', amount_cents: -300 }, { type: 'withdrawal_reversal', amount_cents: 300 },
  ]);
  assert.equal(s.inflow_cents, 5500);
  assert.equal(s.outflow_cents, 1500);
  assert.equal(s.net_flow_cents, 4000);
  assert.equal(s.investment_net_cents, 100);
  assert.equal(s.investment_income_cents, 7);
  assert.equal(s.count, 8);
});

test('报表筛选：日期 / 金额区间校验与匹配', () => {
  const f = reports.parseFilters({ from: '2026-01-01', to: '2026-01-31', min_amount: '1.00', max_amount: '10', type: 'pay,refund', merchant: 'Cafe' });
  assert.equal(f.to - f.from, 31 * 86400000 - 1);
  const row = { id: 1, user_id: 1, type: 'pay', status: 'SUCCEEDED', amount_cents: -500, merchant: 'Blue Cafe', created_at: Date.parse('2026-01-15') };
  assert.ok(reports.matches(row, f));
  assert.ok(!reports.matches({ ...row, amount_cents: -1001 }, f));
  assert.ok(!reports.matches({ ...row, type: 'topup' }, f));
  assert.throws(() => reports.parseFilters({ from: '2026-02-01', to: '2026-01-01' }), (e) => e.code === 'DATE_RANGE_INVALID');
  assert.throws(() => reports.parseFilters({ min_amount: '5', max_amount: '1' }), (e) => e.code === 'AMOUNT_RANGE_INVALID');
  assert.throws(() => reports.parseFilters({ type: 'bogus' }), (e) => e.code === 'FIELD_INVALID');
  assert.throws(() => reports.parsePaging({ page_size: '1000' }), (e) => e.code === 'FIELD_INVALID');
});

test('CSV：BOM、转义、防公式注入', () => {
  const csv = reports.toCsv([{ header: 'a' }, { header: '金额', type: 'amount' }], [['=HYPERLINK("x")', '-12.50'], ['x,"y"', '3.00']]);
  assert.ok(csv.startsWith('﻿'));
  assert.match(csv, /"'=HYPERLINK\(""x""\)",-12.50/); // 文本前加 '，金额列保留负号
  assert.match(csv, /"x,""y""",3.00/);
});

// 读出 zip 里的文件（测试用最小实现）
function unzip(buf) {
  const files = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const csize = buf.readUInt32LE(i + 18);
    const nlen = buf.readUInt16LE(i + 26);
    const elen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nlen).toString('utf8');
    const data = buf.slice(i + 30 + nlen + elen, i + 30 + nlen + elen + csize);
    files[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    i += 30 + nlen + elen + csize;
  }
  return files;
}

test('XLSX：生成合法的 zip 包，金额为数值单元格', () => {
  const buf = buildXlsx({ sheetName: '交易明细', columns: [{ header: '编号', type: 'int' }, { header: '说明' }, { header: '金额', type: 'amount' }], rows: [[1, '<咖啡&茶>', '-1234.50'], [2, '', '0.00']] });
  const files = unzip(buf);
  assert.ok(files['[Content_Types].xml'].includes('spreadsheetml.sheet.main+xml'));
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.ok(sheet.includes('<c r="C2" s="1"><v>-1234.50</v></c>'));
  assert.ok(sheet.includes('&lt;咖啡&amp;茶&gt;'));
  assert.ok(sheet.includes('state="frozen"'));
  assert.ok(files['xl/styles.xml'].includes('#,##0.00'));
  assert.equal(colName(0), 'A');
  assert.equal(colName(27), 'AB');
  assert.throws(() => buildXlsx({ columns: [{ header: 'x', type: 'amount' }], rows: [['1e3']] }));
});

test('重试：只对可重试错误重试，次数有上限', async () => {
  let n = 0;
  const v = await withRetry(async () => { n++; if (n < 3) throw new Error('flaky'); return 'ok'; }, { retries: 3, baseMs: 1 });
  assert.equal(v, 'ok');
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(withRetry(async () => { n++; const e = new Error('bad request'); e.status = 400; throw e; }, { retries: 3, baseMs: 1, retryOn: (e) => e.status >= 500 }));
  assert.equal(n, 1);
  n = 0;
  assert.throws(() => retrySync(() => { n++; throw new Error('database is locked'); }, { retries: 2, baseMs: 1 }));
  assert.equal(n, 3);
});

test('超时：超过时限抛出 TIMEOUT', async () => {
  await assert.rejects(withTimeout(new Promise((r) => setTimeout(r, 200)), 20, '测试'), (e) => e.code === 'TIMEOUT');
  assert.equal(await withTimeout(Promise.resolve(1), 50), 1);
});

test('结构化日志：JSON 行，敏感字段打码', () => {
  const lines = [];
  logger.setSink((l) => lines.push(l));
  logger.setLevel('info');
  logger.info('unit.test', { pin: '123456', nested: { password: 'p' }, amount_cents: 5 });
  logger.setLevel('silent');
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.msg, 'unit.test');
  assert.equal(rec.pin, '[REDACTED]');
  assert.equal(rec.nested.password, '[REDACTED]');
  assert.equal(rec.amount_cents, 5);
});
