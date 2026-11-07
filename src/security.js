// 安全工具：PBKDF2-SHA256 加盐哈希、会话令牌哈希、验证码生成
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
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(hashHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 6 位支付 PIN 同样用 PBKDF2-SHA256，与密码独立加盐
function hashPin(pin, saltHex) { return hashPassword(pin, saltHex); }
function verifyPin(pin, saltHex, hashHex) { return verifyPassword(pin, saltHex, hashHex); }

function generateToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 字符，仅返回给客户端一次
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex'); // 只存哈希，不存原文
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 位数字
}
function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim().toLowerCase());
}
function isValidPin(pin) { return /^\d{6}$/.test(String(pin || '')); }

module.exports = {
  hashPassword, verifyPassword, hashPin, verifyPin,
  generateToken, hashToken, generateCode, hashCode,
  isValidEmail, isValidPin, PBKDF2_ITERATIONS,
};
