// 超时、重试、降级。
// - withTimeout：给异步操作加超时，超时抛 TIMEOUT。
// - withRetry：指数退避 + 抖动重试，只对可重试错误重试。
// - retrySync：同步版重试（SQLite 写锁 SQLITE_BUSY 时用），退避期间阻塞当前线程。
// - degrade：执行失败时记录日志并返回兜底值，用于非关键数据（不影响主流程）。
// - requestTimeout：Express 中间件，超过时限仍未响应则返回 503。
'use strict';

const logger = require('./logger');

class TimeoutError extends Error {
  constructor(ms, label) { super(`${label || '操作'}超时（${ms}ms）`); this.code = 'TIMEOUT'; }
}

function withTimeout(promiseOrFn, ms, label) {
  let timer;
  const p = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
  return Promise.race([
    p,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt, baseMs, maxMs) {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2)); // 抖动，避免同时重试
}

async function withRetry(fn, opts = {}) {
  const retries = opts.retries === undefined ? 3 : opts.retries;
  const baseMs = opts.baseMs || 100;
  const maxMs = opts.maxMs || 2000;
  const retryOn = opts.retryOn || (() => true);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (attempt === retries || !retryOn(e)) break;
      const wait = backoff(attempt, baseMs, maxMs);
      logger.warn('retry.scheduled', { label: opts.label, attempt: attempt + 1, wait_ms: wait, err: e });
      await sleep(wait);
    }
  }
  throw lastErr;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusyError(e) {
  const msg = String((e && e.message) || '');
  return (e && (e.errcode === 5 || e.errcode === 6)) || /database is locked|SQLITE_BUSY/i.test(msg);
}

function retrySync(fn, opts = {}) {
  const retries = opts.retries === undefined ? 4 : opts.retries;
  const retryOn = opts.retryOn || isBusyError;
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt >= retries || !retryOn(e)) throw e;
      const wait = backoff(attempt, opts.baseMs || 25, opts.maxMs || 500);
      logger.warn('retry.sync', { label: opts.label, attempt: attempt + 1, wait_ms: wait, err: e });
      sleepSync(wait);
    }
  }
}

function degrade(label, fn, fallback, log) {
  try {
    return { value: fn(), degraded: false };
  } catch (e) {
    (log || logger).warn('degraded', { component: label, err: e });
    return { value: typeof fallback === 'function' ? fallback(e) : fallback, degraded: true };
  }
}

function requestTimeout(ms) {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      (req.log || logger).error('request.timeout', { timeout_ms: ms, path: req.path });
      res.status(503).json({ ok: false, error: '请求处理超时，请稍后重试', code: 'REQUEST_TIMEOUT', request_id: req.id });
    }, ms);
    if (timer.unref) timer.unref();
    const clear = () => clearTimeout(timer);
    res.on('finish', clear);
    res.on('close', clear);
    next();
  };
}

module.exports = { withTimeout, withRetry, retrySync, degrade, requestTimeout, isBusyError, TimeoutError, sleep };
