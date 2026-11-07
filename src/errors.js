// 统一错误：对用户返回可读的 error（中文）+ 机器可读的 code + request_id；
// 对日志输出完整堆栈与上下文。保留历史字段 { ok: false, error }，只追加 code / request_id。
'use strict';

const logger = require('./logger');

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

const badRequest = (code, message, details) => new AppError(400, code, message, details);
const forbidden = (code, message) => new AppError(403, code, message);
const notFound = (code, message) => new AppError(404, code, message);
const conflict = (code, message, details) => new AppError(409, code, message, details);

function sendError(req, res, status, code, message, extra) {
  return res.status(status).json({ ok: false, error: message, code, request_id: req.id, ...(extra || {}) });
}

// Express 错误处理中间件（四个参数）
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const log = req.log || logger;
  if (err && err.type === 'entity.parse.failed') {
    log.warn('request.bad_json', { err });
    return sendError(req, res, 400, 'BAD_JSON', '请求格式不正确（JSON 解析失败）');
  }
  if (err && err.type === 'entity.too.large') {
    return sendError(req, res, 413, 'PAYLOAD_TOO_LARGE', '请求内容过大');
  }
  if (err instanceof AppError) {
    log.warn('request.rejected', { code: err.code, status: err.status, details: err.details });
    return sendError(req, res, err.status, err.code, err.message, err.details ? { details: err.details } : undefined);
  }
  log.error('request.failed', { err, path: req.path, method: req.method });
  if (res.headersSent) return undefined;
  return sendError(req, res, 500, 'INTERNAL', `系统繁忙，请稍后重试（错误编号 ${req.id}）`);
}

module.exports = { AppError, badRequest, forbidden, notFound, conflict, sendError, errorHandler };
