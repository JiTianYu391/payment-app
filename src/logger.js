// 结构化日志：每行一个 JSON 对象，字段固定（ts / level / msg / 其余上下文）。
// 敏感字段（密码、PIN、令牌、验证码）一律打码后再输出。
'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SENSITIVE = /^(pin|old_pin|new_pin|password|old_password|new_password|token|code|authorization|cookie|confirm_token)$/i;
let minLevel = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;
let sink = (line) => process.stdout.write(line + '\n');

function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  return out;
}

function serializeError(err) {
  if (!err || typeof err !== 'object') return err;
  return { name: err.name, message: err.message, code: err.code, stack: err.stack };
}

function write(level, msg, ctx) {
  if (LEVELS[level] < minLevel) return;
  const rec = { ts: new Date().toISOString(), level, msg };
  if (ctx) {
    for (const [k, v] of Object.entries(redact(ctx))) rec[k] = k === 'err' ? serializeError(ctx.err) : v;
  }
  try { sink(JSON.stringify(rec)); } catch (_) { /* 日志失败不影响业务 */ }
}

function child(base) {
  return {
    debug: (msg, ctx) => write('debug', msg, { ...base, ...ctx }),
    info: (msg, ctx) => write('info', msg, { ...base, ...ctx }),
    warn: (msg, ctx) => write('warn', msg, { ...base, ...ctx }),
    error: (msg, ctx) => write('error', msg, { ...base, ...ctx }),
    child: (more) => child({ ...base, ...more }),
  };
}

const logger = child({ service: 'spacepay' });
logger.setLevel = (lvl) => { minLevel = LEVELS[lvl] || LEVELS.info; };
logger.setSink = (fn) => { sink = fn; };
logger.redact = redact;

module.exports = logger;
