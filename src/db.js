// SpacePay 数据层（FadeHost / PandaStack 适配）
// SQLite 单文件优先（node:sqlite，无原生编译），JSON 文件为同 API 降级后端。
// 默认路径：/data/app.db（SQLite）/ /data/app.json（JSON 降级）；本地 ./data/。
// 首次以 SQLite 启动且存在旧版 /data/app.json 时，自动迁移旧用户/钱包/账单后改名 .migrated.json（不删除）。
// 与 Serv00 版相同的对外接口：{ db, audit, withTransaction }
//   db.prepare(sql).get(...params) / .all(...params) / .run(...params)
//   db.exec(sql) / withTransaction(fn) / audit(userId, email, action, detail, ip)
//
// 后端选择（按顺序）：
//   1) DATABASE_PATH 以 .json 结尾，或 DB_BACKEND=json → 直接用 JSON 后端；
//   2) 否则尝试 Node 内置 node:sqlite（需要 Node >= 22.5，走这条路）；
//   3) node:sqlite 加载失败 → 自动降级到 JSON 后端，不报错、不中断。
// JSON 后端：纯 JS，无原生编译，在 Node 18+ 上即可运行；数据存在 app.json，
// 原子写入（写临时文件再重命名）。演示规模下完全够用；PandaStack 上应用是
// 单进程运行，不存在多进程同时写同一文件的问题。
//
// DATABASE_PATH 默认值（未设置环境变量时）：
//   - /data 存在时 → /data/app.json（FadeHost 持久盘，免费版 3GB，
//     数据存在这里才能跨部署、跨重启保留；仓库目录是只读的）；
//   - /workspace 存在时 → /workspace/data/app.json（PandaStack 卷挂载点，兼容旧版）；
//   - 都不存在时（本地开发）→ ./data/app.json。
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { retrySync } = require('./resilience');

// DATABASE_PATH 默认值：优先用 FadeHost 持久盘 /data/app.db（SQLite），
// 其次 /workspace/data/app.db，本地开发回退到项目内 ./data/app.db。
// 若 DATABASE_PATH 以 .json 结尾或 DB_BACKEND=json，则走 JSON 后端（见 forceJson）。
function defaultDbPath() {
  try {
    if (fs.existsSync('/data')) return '/data/app.db';
    if (fs.existsSync('/workspace')) return '/workspace/data/app.db';
  } catch (_) { /* 忽略 */ }
  return path.join(__dirname, '..', 'data', 'app.db');
}
function legacyJsonPath() {
  // 旧版 v1 的 JSON 文件位置（用于首次迁移）
  try {
    if (fs.existsSync('/data/app.json')) return '/data/app.json';
    if (fs.existsSync('/workspace/data/app.json')) return '/workspace/data/app.json';
    const sibling = dbPath.replace(/\.db$/i, '.json');
    if (sibling !== dbPath && fs.existsSync(sibling)) return sibling;
  } catch (_) {}
  const local = path.join(__dirname, '..', 'data', 'app.json');
  return fs.existsSync(local) ? local : null;
}
const dbPath = process.env.DATABASE_PATH || defaultDbPath();
const forceJson = process.env.DB_BACKEND === 'json' || /\.json$/i.test(dbPath);

const SCHEMA_TABLES = ['users', 'verification_codes', 'demo_inbox', 'sessions', 'wallets', 'transactions', 'audit_logs',
  'products', 'price_snapshots', 'holdings', 'holding_lots', 'orders', 'portfolio_snapshots', 'dividends', 'watchlist', 'alerts', 'goals', 'fixed_deposits', 'risk_targets',
  // SpacePay 新增：复式账本、支付/退款/提现、幂等键、操作日志
  'ledger_entries', 'payments', 'refunds', 'withdrawals', 'idempotency_keys', 'operation_logs',
  // 安全与体验：二次确认令牌、站内通知、退款申请
  'confirm_tokens', 'notifications', 'refund_requests',
  // 商户开放平台
  'merchants', 'merchant_keys', 'merchant_payments', 'merchant_refunds', 'merchant_payouts', 'webhook_deliveries', 'api_logs'];
// 有自增 id 的表；wallets 的主键是 user_id，没有 id 列
const AUTO_ID_TABLES = new Set(['users', 'verification_codes', 'demo_inbox', 'sessions', 'transactions', 'audit_logs',
  'price_snapshots', 'holding_lots', 'orders', 'portfolio_snapshots', 'dividends', 'alerts', 'goals', 'fixed_deposits',
  'ledger_entries', 'payments', 'refunds', 'withdrawals', 'idempotency_keys', 'operation_logs',
  'confirm_tokens', 'notifications', 'refund_requests',
  'merchants', 'merchant_keys', 'merchant_payments', 'merchant_refunds', 'merchant_payouts', 'webhook_deliveries', 'api_logs']);
// SQLite 建表语句里的列默认值（与原版 src/db.js 的 CREATE TABLE 一致）。
// JSON 后端插入时未指定的列要补上这些默认值，否则 `used = 0` 这类查询会查不到行。
const COLUMN_DEFAULTS = {
  users: { pin_salt: null, pin_hash: null, failed_login_attempts: 0, locked_until: null, risk_level: null, risk_score: null,
    role: 'customer', status: 'ACTIVE', frozen_reason: null, frozen_at: null,
    pin_failed_attempts: 0, pin_locked_until: null, totp_secret: null, totp_enabled: 0, totp_recovery_json: null,
    last_login_at: null, closed_at: null },
  verification_codes: { attempts: 0, used: 0 },
  sessions: { ip: null, user_agent: null, last_seen_at: null },
  wallets: { balance_cents: 0 },
  transactions: { product_id: null, order_id: null, counterparty_email: null, merchant: null, category: null,
    sim_day: null, status: 'SUCCEEDED', ref_type: null, ref_id: null },
  products: { dividend_yield: 0, is_active: 1, tradeable: 1 },
  price_snapshots: {},
  holdings: { quantity_milli: 0 },
  holding_lots: { quantity_milli: 0 },
  orders: { fee_cents: 0, realized_pl_cents: 0, status: 'FILLED', filled_at: null },
  portfolio_snapshots: {},
  dividends: {},
  watchlist: {},
  alerts: { status: 'ACTIVE', last_fired_at: null },
  goals: {},
  fixed_deposits: { status: 'ACTIVE' },
  risk_targets: {},
  ledger_entries: { user_id: null, ref_type: null, ref_id: null, memo: null },
  payments: { refunded_cents: 0, status: 'SUCCEEDED', note: null, transaction_id: null },
  refunds: { reason: null, operator_id: null, transaction_id: null },
  withdrawals: { status: 'PENDING', reviewed_by: null, review_note: null, reviewed_at: null, transaction_id: null },
  idempotency_keys: { status_code: null, response_json: null },
  operation_logs: { actor_id: null, actor_email: null, actor_role: null, target_type: null, target_id: null, amount_cents: null, reason: null, request_id: null, ip: null },
  confirm_tokens: { used_at: null },
  notifications: { read_at: null, ref_type: null, ref_id: null },
  refund_requests: { status: 'PENDING', reviewed_by: null, review_note: null, reviewed_at: null, refund_id: null },
  merchants: { owner_user_id: null, status: 'ACTIVE', website: null, description: null, webhook_url: null, webhook_secret: null },
  merchant_keys: { label: null, mode: 'live', last_used_at: null, revoked_at: null },
  merchant_payments: { refunded_cents: 0, status: 'CREATED', currency: 'USD', customer_email: null, customer_user_id: null,
    description: null, metadata_json: null, checkout_token: null, paid_at: null, transaction_id: null,
    success_url: null, cancel_url: null },
  merchant_refunds: { reason: null, status: 'SUCCEEDED' },
  merchant_payouts: { status: 'PENDING', destination: null, reviewed_by: null, review_note: null, reviewed_at: null },
  webhook_deliveries: { attempts: 0, status: 'PENDING', last_status_code: null, last_error: null, next_attempt_at: null, delivered_at: null },
  api_logs: { key_id: null, request_id: null, ip: null, duration_ms: null },
};
function applyDefaults(table, row) {
  const defs = COLUMN_DEFAULTS[table];
  if (!defs) return row;
  for (const [col, val] of Object.entries(defs)) {
    if (row[col] === undefined) row[col] = val;
  }
  return row;
}

// ============================================================
// 后端 A：node:sqlite（原版逻辑，原样保留）
// ============================================================
function createSqliteBackend() {
  const { DatabaseSync } = require('node:sqlite');
  const sqlitePath = /\.json$/i.test(dbPath)
    ? dbPath.replace(/\.json$/i, '.db')
    : dbPath;
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new DatabaseSync(sqlitePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  nickname TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  pin_salt TEXT,
  pin_hash TEXT,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  risk_level TEXT,
  risk_score INTEGER,
  role TEXT NOT NULL DEFAULT 'customer',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  frozen_reason TEXT,
  frozen_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'register',
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS demo_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'register',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  counterparty_email TEXT,
  merchant TEXT,
  category TEXT,
  description TEXT,
  product_id TEXT,
  order_id INTEGER,
  sim_day INTEGER,
  status TEXT NOT NULL DEFAULT 'SUCCEEDED',
  ref_type TEXT,
  ref_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  email TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  risk TEXT NOT NULL,
  base_price_cents INTEGER NOT NULL,
  mu REAL NOT NULL,
  sigma REAL NOT NULL,
  dividend_yield REAL NOT NULL DEFAULT 0,
  price_seed INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  tradeable INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id),
  simulated_day INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(product_id, simulated_day)
);
CREATE TABLE IF NOT EXISTS holdings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity_milli INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, product_id)
);
CREATE TABLE IF NOT EXISTS holding_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  order_id INTEGER REFERENCES orders(id),
  quantity_milli INTEGER NOT NULL,
  unit_cost_cents INTEGER NOT NULL,
  bought_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  side TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  realized_pl_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'FILLED',
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  filled_at INTEGER
);
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snapshot_date TEXT NOT NULL,
  simulated_day INTEGER NOT NULL,
  cash_cents INTEGER NOT NULL,
  invested_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  UNIQUE(user_id, snapshot_date)
);
CREATE TABLE IF NOT EXISTS dividends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  amount_cents INTEGER NOT NULL,
  ex_date TEXT,
  paid_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlist (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, product_id)
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  condition TEXT NOT NULL,
  threshold_cents INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'ONCE',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  last_fired_at INTEGER
);
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target_cents INTEGER NOT NULL,
  target_date TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fixed_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  principal_cents INTEGER NOT NULL,
  rate_bps INTEGER NOT NULL,
  start_day INTEGER NOT NULL,
  maturity_day INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE IF NOT EXISTS risk_targets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  weights_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user_created ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user_created ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_code_email ON verification_codes(email, expires_at);
CREATE INDEX IF NOT EXISTS idx_session_token ON sessions(token_hash);
`);
  // 旧库升级：给已有表补列（列已存在时 SQLite 报错，忽略即可）
  for (const ddl of [
    "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'customer'",
    "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'",
    'ALTER TABLE users ADD COLUMN frozen_reason TEXT',
    'ALTER TABLE users ADD COLUMN frozen_at INTEGER',
    'ALTER TABLE users ADD COLUMN pin_failed_attempts INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN pin_locked_until INTEGER',
    'ALTER TABLE users ADD COLUMN totp_secret TEXT',
    'ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN totp_recovery_json TEXT',
    'ALTER TABLE users ADD COLUMN last_login_at INTEGER',
    'ALTER TABLE users ADD COLUMN closed_at INTEGER',
    'ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER',
    'ALTER TABLE transactions ADD COLUMN sim_day INTEGER',
    "ALTER TABLE transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'SUCCEEDED'",
    'ALTER TABLE transactions ADD COLUMN ref_type TEXT',
    'ALTER TABLE transactions ADD COLUMN ref_id INTEGER',
  ]) {
    try { db.exec(ddl); } catch (_) { /* 列已存在 */ }
  }
  db.exec(`
-- 复式账本：只追加，不更新、不删除。同一 journal_id 的 amount_cents 之和必须为 0。
-- 账户余额 = 该账户全部分录之和；钱包账户 account='wallet' + user_id。
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id TEXT NOT NULL,
  journal_type TEXT NOT NULL,
  account TEXT NOT NULL,
  user_id INTEGER,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  ref_type TEXT,
  ref_id INTEGER,
  memo TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant TEXT NOT NULL,
  category TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0 AND refunded_cents <= amount_cents),
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'SUCCEEDED',
  note TEXT,
  transaction_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'SUCCEEDED',
  operator_id INTEGER,
  transaction_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  destination TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  transaction_id INTEGER,
  reviewed_by INTEGER,
  review_note TEXT,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  scope TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  status_code INTEGER,
  response_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, scope, idem_key)
);
CREATE TABLE IF NOT EXISTS operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  actor_email TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  amount_cents INTEGER,
  reason TEXT,
  result TEXT NOT NULL,
  request_id TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_journal ON ledger_entries(journal_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account, user_id);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oplog_created ON operation_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at DESC);
`);
  // 安全、通知与商户开放平台
  db.exec(`
CREATE TABLE IF NOT EXISTS confirm_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  ref_type TEXT,
  ref_id INTEGER,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS refund_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  reviewed_by INTEGER,
  review_note TEXT,
  reviewed_at INTEGER,
  refund_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  website TEXT,
  description TEXT,
  webhook_url TEXT,
  webhook_secret TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS merchant_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  label TEXT,
  mode TEXT NOT NULL DEFAULT 'live',
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS merchant_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  reference TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'CREATED',
  customer_email TEXT,
  customer_user_id INTEGER,
  description TEXT,
  metadata_json TEXT,
  success_url TEXT,
  cancel_url TEXT,
  checkout_token TEXT UNIQUE,
  refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0 AND refunded_cents <= amount_cents),
  transaction_id INTEGER,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(merchant_id, reference)
);
CREATE TABLE IF NOT EXISTS merchant_refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES merchant_payments(id),
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'SUCCEEDED',
  transaction_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS merchant_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'PENDING',
  destination TEXT,
  requested_by INTEGER,
  reviewed_by INTEGER,
  review_note TEXT,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payment_id INTEGER,
  url TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_status_code INTEGER,
  last_error TEXT,
  next_attempt_at INTEGER,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE TABLE IF NOT EXISTS api_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER,
  key_id TEXT,
  method TEXT,
  path TEXT,
  status_code INTEGER,
  request_id TEXT,
  ip TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_confirm_nonce ON confirm_tokens(nonce);
CREATE INDEX IF NOT EXISTS idx_confirm_expire ON confirm_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_notification_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refund_req_status ON refund_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_merchant_key ON merchant_keys(key_id);
CREATE INDEX IF NOT EXISTS idx_mpay_merchant ON merchant_payments(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mpay_checkout ON merchant_payments(checkout_token);
CREATE INDEX IF NOT EXISTS idx_mpay_ref ON merchant_payments(merchant_id, reference);
CREATE INDEX IF NOT EXISTS idx_mpayout_merchant ON merchant_payouts(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_status ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_apilog_merchant ON api_logs(merchant_id, created_at DESC);
`);
  // 支持嵌套调用：已在事务中时直接执行（由最外层负责提交/回滚）。
  // 写锁冲突（SQLITE_BUSY，多进程共享同一库文件时可能出现）时整体回滚后退避重试。
  let depth = 0;
  function withTransaction(fn) {
    if (depth > 0) return fn();
    return retrySync(() => {
      db.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw e;
      } finally {
        depth--;
      }
    }, { label: 'sqlite.transaction' });
  }
  function audit(userId, email, action, detail, ip) {
    db.prepare('INSERT INTO audit_logs (user_id, email, action, detail, ip, created_at) VALUES (?,?,?,?,?,?)')
      .run(userId || null, email || null, action, detail || '', ip || '', Date.now());
  }
  return { db, audit, withTransaction, backend: 'sqlite', path: sqlitePath };
}

// ============================================================
// 后端 B：纯 JS JSON 存储（node:sqlite 不可用时自动启用）
// 实现 server.js 用到的 SQL 子集：
//   SELECT（列 / * / COUNT(*) / SUM() / col IS NOT NULL、WHERE 的 = != <> > < >= <= LIKE
//          与 AND / 括号 OR 组、GROUP BY、ORDER BY、LIMIT / OFFSET，? 占位符与字面量）
//   INSERT INTO t (cols) VALUES (...)
//   UPDATE t SET col = ? / col = 数字 / col = NULL / col = col + 1 WHERE ...
//   DELETE FROM t WHERE ...
//   exec() 里的 CREATE TABLE / CREATE INDEX / PRAGMA / BEGIN / COMMIT / ROLLBACK
// ============================================================
function createJsonBackend() {
  const jsonPath = /\.json$/i.test(dbPath) ? dbPath : dbPath + '.json';
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });

  let store = null; // { tables: {name: [row]}, seq: {name: nextId} }
  let inTx = false;
  let txSnapshot = null;

  function emptyStore() {
    const tables = {};
    const seq = {};
    for (const t of SCHEMA_TABLES) { tables[t] = []; seq[t] = 1; }
    return { tables, seq };
  }
  function load() {
    try {
      const raw = fs.readFileSync(jsonPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.tables) {
        store = parsed;
        // 旧文件里的行也补上列默认值（防止历史数据缺少字段）；新增的表补空表
        for (const t of SCHEMA_TABLES) {
          if (!Array.isArray(store.tables[t])) store.tables[t] = [];
          if (!store.seq) store.seq = {};
          if (store.seq[t] === undefined) store.seq[t] = 1;
        }
        for (const t of SCHEMA_TABLES) {
          if (Array.isArray(store.tables[t])) store.tables[t].forEach((row) => applyDefaults(t, row));
        }
        return;
      }
    } catch (_) { /* 文件不存在或损坏 → 从空库开始（损坏时不覆盖旧文件，改写新文件） */ }
    store = emptyStore();
  }
  function save() {
    if (inTx) return; // 事务中只写内存，COMMIT 时再落盘
    const tmp = jsonPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, jsonPath);
  }
  load();

  const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
  const cmp = (a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const sa = a === null || a === undefined ? '' : String(a);
    const sb = b === null || b === undefined ? '' : String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  };
  const likeMatch = (value, pattern) => {
    const re = new RegExp('^' + String(pattern)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
    return re.test(value === null || value === undefined ? '' : String(value));
  };

  // 解析 WHERE 子句，返回按文本顺序消耗 ? 的谓词函数
  function parseWhere(whereStr, params) {
    if (!whereStr) return () => true;
    let p = 0;
    const nextParam = () => params[p++];
    // 按顶层 AND 切分（括号深度为 0 处）
    const topParts = splitTopLevel(whereStr, /\s+AND\s+/i);
    const preds = topParts.map((part) => parseConditionGroup(part.trim(), nextParam));
    return (row) => preds.every((fn) => fn(row));
  }
  function splitTopLevel(str, sepRe) {
    const out = [];
    let depth = 0, last = 0, i = 0;
    while (i < str.length) {
      const ch = str[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0) {
        const rest = str.slice(i);
        const m = rest.match(sepRe);
        if (m && m.index === 0) {
          out.push(str.slice(last, i));
          i += m[0].length;
          last = i;
          continue;
        }
      }
      i++;
    }
    out.push(str.slice(last));
    return out.map((s) => s.trim()).filter(Boolean);
  }
  function parseConditionGroup(part, nextParam) {
    if (part.startsWith('(') && part.endsWith(')')) {
      const inner = splitTopLevel(part.slice(1, -1), /\s+OR\s+/i);
      const fns = inner.map((c) => parseSingleCondition(c.trim(), nextParam));
      return (row) => fns.some((fn) => fn(row));
    }
    return parseSingleCondition(part, nextParam);
  }
  function parseSingleCondition(cond, nextParam) {
    // IN / NOT IN（字面量列表，如 type IN ('bonus','topup')）
    let mIn = cond.match(/^(\w+)\s+(NOT\s+)?IN\s*\(([^)]*)\)$/i);
    if (mIn) {
      const col = mIn[1], neg = !!mIn[2];
      const vals = mIn[3].split(',').map((s) => {
        s = s.trim();
        if (s === '?') return nextParam();
        if (/^NULL$/i.test(s)) return null;
        if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
        return Number(s);
      });
      return (row) => {
        const v = row[col];
        const hit = vals.some((x) => (x == null ? v == null : (typeof v === 'number' || typeof x === 'number' ? Number(v) === Number(x) : v === x)));
        return neg ? !hit : hit;
      };
    }
    let m = cond.match(/^(\w+)\s+IS\s+(NOT\s+)?NULL$/i);
    if (m) {
      const col = m[1], neg = !!m[2];
      return (row) => neg ? row[col] !== null && row[col] !== undefined : (row[col] === null || row[col] === undefined);
    }
    m = cond.match(/^(\w+)\s*(=|!=|<>|>=|<=|>|<|LIKE)\s*(\?|NULL|'(?:[^']*)'|-?\d+(?:\.\d+)?)$/i);
    if (!m) throw new Error('JSON 后端不支持的 WHERE 条件: ' + cond);
    const col = m[1], op = m[2].toUpperCase(), raw = m[3];
    let value;
    if (raw === '?') value = nextParam();
    else if (/^NULL$/i.test(raw)) value = null;
    else if (raw.startsWith("'")) value = raw.slice(1, -1);
    else value = Number(raw);
    return (row) => {
      const v = row[col];
      switch (op) {
        // '='：数字与数字比较用数值相等；数字与数字字符串也视为相等
        //（与 SQLite 的类型亲和行为接近）；其余用严格相等。null 只等于 null。
        case '=':
          if (v == null || value == null) return v == null && value == null;
          if (typeof v === 'number' || typeof value === 'number') return Number(v) === Number(value);
          return v === value;
        case '!=':
        case '<>': return v != value;
        case '>': return cmp(v, value) > 0;
        case '<': return cmp(v, value) < 0;
        case '>=': return cmp(v, value) >= 0;
        case '<=': return cmp(v, value) <= 0;
        case 'LIKE': return likeMatch(v, value);
        default: return false;
      }
    };
  }
  // 注：'=' 用宽松比较（数字与数字字符串相等时视为相等），与 SQLite 的类型亲和行为接近；
  // token_hash、email 等关键字段在写入时类型一致，不会因此误判。

  function parseSelect(sql) {
    const m = norm(sql).match(/^SELECT\s+(.+?)\s+FROM\s+(\w+)([\s\S]*)$/i);
    if (!m) throw new Error('JSON 后端不支持的 SELECT: ' + sql);
    const colsPart = m[1], table = m[2];
    let rest = m[3] || '';
    let whereStr = '', groupBy = [], orderBy = null, orderDir = 'ASC', limit = null, offset = null;
    const take = (re) => { const mm = rest.match(re); if (!mm) return null; rest = rest.replace(re, ' ').trim(); return mm; };
    // 注意：take() 每次都会 trim，剩余字符串开头可能没有空格，
    // 所以下面各子句的正则开头必须用 \s*（不能用 \s+），否则 GROUP BY / ORDER BY 会匹配失败。
    let w = take(/\s*WHERE\s+([\s\S]+?)(?=\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|\s+OFFSET|$)/i);
    if (w) whereStr = w[1].trim();
    let g = take(/\s*GROUP\s+BY\s+([\w\s,]+?)(?=\s+ORDER\s+BY|\s+LIMIT|\s+OFFSET|$)/i);
    if (g) groupBy = g[1].split(',').map((s) => s.trim()).filter(Boolean);
    let o = take(/\s*ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?/i);
    if (o) { orderBy = o[1]; orderDir = (o[2] || 'ASC').toUpperCase(); }
    let l = take(/\s*LIMIT\s+(\?|\d+)/i);
    if (l) limit = l[1];
    let f = take(/\s*OFFSET\s+(\?|\d+)/i);
    if (f) offset = f[1];
    // 列解析
    const cols = splitTopLevel(colsPart, /,/).map((c) => {
      const t = c.trim();
      if (t === '*') return { kind: 'star' };
      let cm = t.match(/^COUNT\(\*\)(?:\s+AS\s+|\s+)(\w+)$/i);
      if (cm) return { kind: 'count', alias: cm[1] };
      cm = t.match(/^SUM\((\w+)\)(?:\s+AS\s+|\s+)(\w+)$/i);
      if (cm) return { kind: 'sum', col: cm[1], alias: cm[2] };
      cm = t.match(/^(\w+)\s+IS\s+NOT\s+NULL(?:\s+AS\s+|\s+)(\w+)$/i);
      if (cm) return { kind: 'isNotNull', col: cm[1], alias: cm[2] };
      cm = t.match(/^(\w+)(?:\s+AS\s+|\s+)(\w+)$/i);
      if (cm) return { kind: 'col', col: cm[1], alias: cm[2] };
      return { kind: 'col', col: t, alias: t };
    });
    return { cols, table, whereStr, groupBy, orderBy, orderDir, limit, offset };
  }

  function runSelect(parsed, params) {
    let p = 0;
    const nextParam = () => params[p++];
    const pred = parseWhere(parsed.whereStr, params.slice(0)); // WHERE 的 ? 按文本顺序消耗
    // 注意：parseWhere 内部自己维护指针，需用同一份 params 副本按顺序消费；
    // LIMIT/OFFSET 的 ? 在 WHERE 之后，单独处理。
    let rows = (store.tables[parsed.table] || []).filter(pred);
    // 重新统计 WHERE 消耗的 ? 个数：数 whereStr 中 ? 的数量
    const whereQs = (parsed.whereStr.match(/\?/g) || []).length;
    let li = whereQs;
    const takeParam = (v) => (v === '?' ? params[li++] : Number(v));

    if (parsed.groupBy.length) {
      const groups = new Map();
      for (const r of rows) {
        const key = JSON.stringify(parsed.groupBy.map((c) => r[c]));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      rows = [...groups.values()].map((grows) => {
        const out = {};
        for (const col of parsed.cols) {
          if (col.kind === 'count') out[col.alias] = grows.length;
          else if (col.kind === 'sum') out[col.alias] = grows.reduce((s, r) => s + (Number(r[col.col]) || 0), 0);
          else if (col.kind === 'col') out[col.alias] = grows[0][col.col];
          else if (col.kind === 'isNotNull') out[col.alias] = (grows[0][col.col] !== null && grows[0][col.col] !== undefined) ? 1 : 0;
        }
        return out;
      });
    } else if (parsed.cols.some((c) => c.kind === 'count' || c.kind === 'sum')) {
      const out = {};
      for (const col of parsed.cols) {
        if (col.kind === 'count') out[col.alias] = rows.length;
        else if (col.kind === 'sum') out[col.alias] = rows.reduce((s, r) => s + (Number(r[col.col]) || 0), 0);
        else if (col.kind === 'col') out[col.alias] = rows.length ? rows[0][col.col] : null;
      }
      rows = [out];
    } else {
      // 先排序再投影：ORDER BY 的列不一定在 SELECT 列表里（如 SELECT balance_after_cents … ORDER BY id）
      if (parsed.orderBy) {
        const dir = parsed.orderDir === 'DESC' ? -1 : 1;
        rows = rows.slice().sort((a, b) => cmp(a[parsed.orderBy], b[parsed.orderBy]) * dir);
        parsed = { ...parsed, orderBy: null };
      }
      rows = rows.map((r) => {
        if (parsed.cols.length === 1 && parsed.cols[0].kind === 'star') return { ...r };
        const out = {};
        for (const col of parsed.cols) {
          if (col.kind === 'col') out[col.alias] = r[col.col];
          else if (col.kind === 'isNotNull') out[col.alias] = (r[col.col] !== null && r[col.col] !== undefined) ? 1 : 0;
        }
        return out;
      });
    }
    if (parsed.orderBy) {
      const dir = parsed.orderDir === 'DESC' ? -1 : 1;
      rows.sort((a, b) => cmp(a[parsed.orderBy], b[parsed.orderBy]) * dir);
    }
    if (parsed.limit !== null && parsed.limit !== undefined) {
      const n = takeParam(parsed.limit);
      const off = parsed.offset !== null && parsed.offset !== undefined ? takeParam(parsed.offset) : 0;
      rows = rows.slice(off, off + n);
    }
    return rows;
  }

  function prepare(sql) {
    const s = norm(sql);
    if (/^SELECT\s/i.test(s)) {
      const parsed = parseSelect(s);
      return {
        get: (...params) => runSelect(parsed, params)[0],
        all: (...params) => runSelect(parsed, params),
        run: () => { throw new Error('SELECT 不能用 run() 执行'); },
      };
    }
    let m = s.match(/^INSERT INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)$/i);
    if (m) {
      const table = m[1];
      const cols = m[2].split(',').map((x) => x.trim());
      const vals = splitTopLevel(m[3], /,/).map((x) => x.trim());
      return {
        run: (...params) => {
          let p = 0;
          const row = {};
          cols.forEach((col, i) => {
            const v = vals[i];
            row[col] = v === '?' ? params[p++] : /^NULL$/i.test(v) ? null : v.startsWith("'") ? v.slice(1, -1) : Number(v);
          });
          if (AUTO_ID_TABLES.has(table) && row.id === undefined) row.id = store.seq[table]++;
          applyDefaults(table, row);
          store.tables[table].push(row);
          save();
          return { lastInsertRowid: row.id, changes: 1 };
        },
        get: () => { throw new Error('INSERT 不能用 get() 执行'); },
        all: () => { throw new Error('INSERT 不能用 all() 执行'); },
      };
    }
    m = s.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/i);
    if (m) {
      const table = m[1], setPart = m[2], whereStr = m[3] || '';
      return {
        run: (...params) => {
          let p = 0;
          const assignments = splitTopLevel(setPart, /,/).map((a) => {
            const am = a.trim().match(/^(\w+)\s*=\s*(.+)$/);
            const col = am[1], expr = am[2].trim();
            let fn;
            if (expr === '?') { const v = params[p++]; fn = () => v; }
            else if (/^NULL$/i.test(expr)) fn = () => null;
            else if (/^-?\d+(?:\.\d+)?$/.test(expr)) { const v = Number(expr); fn = () => v; }
            else if (expr.startsWith("'")) { const v = expr.slice(1, -1); fn = () => v; }
            else {
              const em = expr.match(/^(\w+)\s*([+-])\s*(\d+(?:\.\d+)?|\?)$/);
              if (!em) throw new Error('JSON 后端不支持的 SET 表达式: ' + expr);
              if (em[3] === '?') { // col +/- ?（占位符操作数，如 quantity_milli = quantity_milli + ?）
                const v = params[p++];
                fn = (row) => (Number(row[em[1]]) || 0) + (em[2] === '+' ? Number(v) : -Number(v));
              } else {
                fn = (row) => (Number(row[em[1]]) || 0) + (em[2] === '+' ? Number(em[3]) : -Number(em[3]));
              }
            }
            return { col, fn };
          });
          const pred = parseWhere(whereStr, params.slice(p));
          let changes = 0;
          for (const row of store.tables[table]) {
            if (!pred(row)) continue;
            for (const { col, fn } of assignments) row[col] = fn(row);
            changes++;
          }
          save();
          return { changes };
        },
        get: () => { throw new Error('UPDATE 不能用 get() 执行'); },
        all: () => { throw new Error('UPDATE 不能用 all() 执行'); },
      };
    }
    m = s.match(/^DELETE FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/i);
    if (m) {
      const table = m[1], whereStr = m[2] || '';
      return {
        run: (...params) => {
          const pred = parseWhere(whereStr, params);
          const before = store.tables[table].length;
          store.tables[table] = store.tables[table].filter((r) => !pred(r));
          save();
          return { changes: before - store.tables[table].length };
        },
        get: () => { throw new Error('DELETE 不能用 get() 执行'); },
        all: () => { throw new Error('DELETE 不能用 all() 执行'); },
      };
    }
    throw new Error('JSON 后端不支持的 SQL: ' + sql);
  }

  const db = {
    prepare,
    exec(execSql) {
      for (const raw of String(execSql).split(';')) {
        const stmt = norm(raw);
        if (!stmt) continue;
        if (/^PRAGMA/i.test(stmt)) continue;
        if (/^CREATE TABLE/i.test(stmt)) {
          const m = stmt.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i) || stmt.match(/CREATE TABLE\s+(\w+)/i);
          if (m && !store.tables[m[1]]) { store.tables[m[1]] = []; store.seq[m[1]] = 1; }
          continue;
        }
        if (/^CREATE (UNIQUE )?INDEX/i.test(stmt)) continue;
        if (/^BEGIN/i.test(stmt)) {
          inTx = true;
          txSnapshot = JSON.stringify(store);
          continue;
        }
        if (/^COMMIT/i.test(stmt)) {
          inTx = false;
          txSnapshot = null;
          save();
          continue;
        }
        if (/^ROLLBACK/i.test(stmt)) {
          if (txSnapshot) store = JSON.parse(txSnapshot);
          inTx = false;
          txSnapshot = null;
          continue;
        }
        throw new Error('JSON 后端 exec() 不支持: ' + stmt);
      }
    },
  };

  function withTransaction(fn) {
    if (inTx) return fn(); // 嵌套：由最外层事务提交/回滚
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }
  function audit(userId, email, action, detail, ip) {
    db.prepare('INSERT INTO audit_logs (user_id, email, action, detail, ip, created_at) VALUES (?,?,?,?,?,?)')
      .run(userId || null, email || null, action, detail || '', ip || '', Date.now());
  }
  return { db, audit, withTransaction, backend: 'json', jsonPath };
}

// ============================================================
// 后端选择
// ============================================================
let impl;
let backendName;
let jsonPathInfo = null;
if (forceJson) {
  impl = createJsonBackend();
  backendName = 'json';
  jsonPathInfo = impl.jsonPath;
} else {
  try {
    impl = createSqliteBackend();
    backendName = 'sqlite';
  } catch (e) {
    logger.warn('db.sqlite_unavailable', { fallback: 'json', err: e });
    impl = createJsonBackend();
    backendName = 'json';
    jsonPathInfo = impl.jsonPath;
  }
}
logger.info('db.ready', { backend: backendName, path: backendName === 'json' ? jsonPathInfo : dbPath });

// ---------- v1 JSON -> SQLite 一次性迁移 ----------
// 仅当使用 SQLite 且 users 表为空、且存在旧版 app.json 时执行；迁移后把旧文件改名
// 为 .migrated.json（永不删除）。JSON 后端本身不需要迁移（同一文件格式）。
function migrateLegacyJson() {
  if (backendName !== 'sqlite') return;
  try {
    const count = impl.db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    if (count > 0) return;
    const legacy = legacyJsonPath();
    if (!legacy) return;
    const raw = fs.readFileSync(legacy, 'utf8');
    const store = JSON.parse(raw);
    if (!store || !store.tables || !Array.isArray(store.tables.users) || !store.tables.users.length) return;
    // v1 七表 + v2 投资表（orders 在 holding_lots 之前，满足 FK 顺序；v1 文件里没有的表按空处理）
    const tables = ['users', 'verification_codes', 'demo_inbox', 'sessions', 'wallets', 'transactions', 'audit_logs',
      'products', 'orders', 'holdings', 'holding_lots', 'price_snapshots', 'portfolio_snapshots', 'dividends',
      'watchlist', 'alerts', 'goals', 'fixed_deposits', 'risk_targets'];
    impl.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of tables) {
        const realCols = new Set(impl.db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name));
        const rows = store.tables[table] || [];
        for (const row of rows) {
          const r = applyDefaults(table, { ...row });
          const cols = Object.keys(r).filter((c) => r[c] !== undefined && realCols.has(c));
          if (!cols.length) continue;
          const placeholders = cols.map(() => '?').join(',');
          impl.db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`)
            .run(...cols.map((c) => r[c]));
        }
      }
      impl.db.exec('COMMIT');
    } catch (e) {
      try { impl.db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
    fs.renameSync(legacy, legacy + '.migrated.json');
    logger.info('db.legacy_migrated', { from: legacy, renamed_to: legacy + '.migrated.json' });
  } catch (e) {
    logger.warn('db.legacy_migration_skipped', { err: e });
  }
}
migrateLegacyJson();

module.exports = { db: impl.db, audit: impl.audit, withTransaction: impl.withTransaction, backend: backendName, dbPath };
