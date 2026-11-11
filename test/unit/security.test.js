// 安全工具单元测试：RFC 6238 TOTP 向量、Base32、API Key、验证码格式。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sec = require('../../src/security');

test('TOTP 与 RFC 6238 测试向量一致', () => {
  const secret = sec.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(sec.hotp(secret, Math.floor(59 / 30), 8), '94287082');
  assert.equal(sec.hotp(secret, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(sec.hotp(secret, Math.floor(2000000000 / 30), 8), '69279037');
});

test('Base32 编解码可往返', () => {
  for (const buf of [Buffer.from('a'), Buffer.from('hello world'), require('crypto').randomBytes(20)]) {
    assert.deepEqual(sec.base32Decode(sec.base32Encode(buf)), buf);
  }
});

test('verifyTotp 接受当前时间步、拒绝错误值', () => {
  const secret = sec.generateTotpSecret();
  assert.equal(sec.verifyTotp(secret, sec.totp(secret)), true);
  assert.equal(sec.verifyTotp(secret, '000000'), false);
  assert.equal(sec.verifyTotp(secret, 'abcdef'), false);
  assert.equal(sec.verifyTotp(secret, ''), false);
});

test('验证码为 6 位数字且来自 CSPRNG 接口', () => {
  for (let i = 0; i < 200; i++) assert.match(sec.generateCode(), /^\d{6}$/);
});

test('API Key：解析、校验与错误格式', () => {
  const k = sec.generateApiKey('live');
  assert.match(k.token, /^sp_live_[a-f0-9]{16}_[A-Za-z0-9_-]{20,}$/);
  const parsed = sec.parseApiKey(k.token);
  assert.equal(parsed.keyId, k.keyId);
  assert.equal(parsed.secret, k.secret);
  assert.equal(parsed.mode, 'live');
  assert.equal(sec.verifyApiSecret(k.secret, k.hash), true);
  assert.equal(sec.verifyApiSecret('wrong-secret', k.hash), false);
  assert.equal(sec.parseApiKey('not-a-key'), null);
  assert.equal(sec.parseApiKey('sp_live_short_x'), null);
});

test('恢复码规范化与哈希稳定', () => {
  const codes = sec.generateRecoveryCodes(3);
  assert.equal(codes.length, 3);
  for (const c of codes) assert.match(c, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const h1 = sec.hashToken(sec.normalizeRecoveryCode(codes[0]));
  const h2 = sec.hashToken(sec.normalizeRecoveryCode(codes[0].toLowerCase().replace('-', ' ')));
  assert.equal(h1, h2);
});

test('Webhook 签名稳定且随内容变化', () => {
  const a = sec.signWebhook('secret', 1000, '{"a":1}');
  const b = sec.signWebhook('secret', 1000, '{"a":1}');
  const c = sec.signWebhook('secret', 1001, '{"a":1}');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-f0-9]{64}$/);
});
