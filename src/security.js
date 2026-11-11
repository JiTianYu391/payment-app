// 安全工具：PBKDF2-SHA256 加盐哈希、会话令牌哈希、验证码、TOTP、商户 API Key。
'use strict';

const crypto = require('crypto');

const PBKDF2_ITERATIONS = 120000;
const KEY_LEN = 32;
const SALT_LEN = 16;

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(SALT_LEN);
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function verifyPassword(password, saltHex, hashHex) {
  if (!saltHex || !hashHex) return false;
  const { hash } = hashPassword(password, saltHex);
  return safeEqualHex(hash, hashHex);
}

// 6 位支付 PIN 同样用 PBKDF2-SHA256，与密码独立加盐
function hashPin(pin, saltHex) { return hashPassword(pin, saltHex); }
function verifyPin(pin, saltHex, hashHex) { return verifyPassword(pin, saltHex, hashHex); }

// 常量时间比较：长度不同直接返回 false，避免抛异常泄露长度
function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a || ''), 'hex');
  const bb = Buffer.from(String(b || ''), 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 字符，仅返回给客户端一次
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex'); // 只存哈希，不存原文
}

// 验证码必须来自 CSPRNG：Math.random 的序列在知道少量输出后可被预测
function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}
function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim().toLowerCase());
}
function isValidPin(pin) { return /^\d{6}$/.test(String(pin || '')); }

// ============================================================
// TOTP（RFC 6238）/ HOTP（RFC 4226），配合 Google Authenticator 等应用
// ============================================================
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/=|\s|-/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Base32 字符不合法');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secretBase32, counter, digits = 6) {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

function totp(secretBase32, atMs = Date.now(), step = 30, digits = 6) {
  return hotp(secretBase32, Math.floor(atMs / 1000 / step), digits);
}

// window=1 表示允许前后各 1 个时间步（手机时钟误差 / 输入延迟）
function verifyTotp(secretBase32, code, opts = {}) {
  const step = opts.step || 30;
  const digits = opts.digits || 6;
  const window = opts.window === undefined ? 1 : opts.window;
  const clean = String(code || '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(clean)) return false;
  const counter = Math.floor(Date.now() / 1000 / step);
  for (let i = -window; i <= window; i++) {
    if (hotp(secretBase32, counter + i, digits) === clean) return true;
  }
  return false;
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160 位，与常见认证器一致
}

function otpauthUri(secretBase32, account, issuer = 'SpacePay') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// 恢复码：一次性使用，只存哈希。格式 xxxx-xxxx，去掉了易混淆字符。
function generateRecoveryCodes(count = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes = [];
  for (let i = 0; i < count; i++) {
    let s = '';
    for (let j = 0; j < 8; j++) s += alphabet[crypto.randomInt(alphabet.length)];
    codes.push(s.slice(0, 4) + '-' + s.slice(4));
  }
  return codes;
}
const normalizeRecoveryCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ============================================================
// 商户 API Key：sp_live_<keyId>_<secret>
// 只保存 secret 的 SHA-256；keyId 用于索引，secret 只在创建时返回一次。
// ============================================================
function generateApiKey(mode = 'live') {
  const keyId = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  return { keyId, secret, token: `sp_${mode}_${keyId}_${secret}`, hash: hashToken(secret) };
}

function parseApiKey(token) {
  const m = /^sp_(live|test)_([a-f0-9]{16})_([A-Za-z0-9_-]{20,64})$/.exec(String(token || '').trim());
  if (!m) return null;
  return { mode: m[1], keyId: m[2], secret: m[3] };
}

function verifyApiSecret(secret, hashHex) {
  return safeEqualHex(hashToken(secret), hashHex);
}

// 商户 Webhook 签名：HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
function signWebhook(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

module.exports = {
  hashPassword, verifyPassword, hashPin, verifyPin, safeEqualHex,
  generateToken, hashToken, generateCode, hashCode,
  isValidEmail, isValidPin,
  base32Encode, base32Decode, hotp, totp, verifyTotp, generateTotpSecret, otpauthUri,
  generateRecoveryCodes, normalizeRecoveryCode,
  generateApiKey, parseApiKey, verifyApiSecret, signWebhook,
  PBKDF2_ITERATIONS,
};
