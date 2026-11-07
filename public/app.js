// SpacePay 前端。金额一律以整数分从服务端取得，只在显示时格式化（千分位 + 货币符号）。
// 资金类请求带 Idempotency-Key；关键操作由服务端返回 428 + 摘要，经确认弹窗二次提交。
'use strict';

// ---------- 状态 ----------
let token = '';
try { token = localStorage.getItem('spacepay_token') || localStorage.getItem('pay_token') || ''; } catch (_) { /* 隐私模式 */ }
let me = null;
let products = [];
let simDay = 0;
let currentRange = '1M';
let privacy = false;
let currentView = 'home';
let curProduct = null;
let curSide = 'BUY';
let curPreview = null;
const formKeys = {}; // 每个表单一次提交对应一个幂等键；成功后换新，失败重试沿用

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
const keyFor = (form) => (formKeys[form] = formKeys[form] || newKey());
const resetKey = (form) => { delete formKeys[form]; };

// ---------- 格式化 ----------
function cents(c, opts = {}) {
  if (c === null || c === undefined || Number.isNaN(c)) return '—';
  const neg = c < 0;
  const abs = Math.abs(c);
  const body = '$' + String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + String(abs % 100).padStart(2, '0');
  if (neg) return '−' + body;
  return opts.signed && c > 0 ? '+' + body : body;
}
const money = (c, opts) => (privacy ? '••••' : cents(c, opts));
// 坐标轴刻度：同一坐标轴统一精度（最大刻度 ≥ $1,000 时取整到美元，否则保留 2 位小数）
function axisMoney(c, top) {
  const abs = Math.abs(c);
  if ((top === undefined ? abs : top) >= 100000) return (c < 0 ? '−' : '') + '$' + String(Math.round(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return cents(Math.round(c));
}
function pct(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const s = Math.abs(v).toFixed(digits) + '%';
  return v > 0 ? '+' + s : v < 0 ? '−' + s : s;
}
function signedHtml(v, text) {
  const cls = v > 0 ? 'up' : v < 0 ? 'down' : '';
  const arrow = v > 0 ? '▲ ' : v < 0 ? '▼ ' : '';
  return `<span class="${cls}">${arrow}${text}</span>`;
}
const qtyFmt = (milli) => (milli / 1000).toFixed(3);
function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const TYPE_LABEL = {
  bonus: '体验金', topup: '充值', transfer_in: '转入', transfer_out: '转出', pay: '付款', refund: '退款',
  withdrawal: '提现', withdrawal_reversal: '提现退回', BUY: '买入', SELL: '卖出', FD_REDEEM: '定存兑付',
  DIVIDEND: '分红', INTEREST: '利息', demo_reset: '演示重置',
};
const STATUS = {
  SUCCEEDED: ['成功', 'success'], PENDING: ['处理中', 'warning'], FAILED: ['失败', 'danger'],
  PARTIALLY_REFUNDED: ['部分退款', 'info'], REFUNDED: ['已退款', ''],
};
const W_STATUS = { PENDING: ['待审核', 'warning'], SUCCEEDED: ['已出款', 'success'], FAILED: ['已驳回', 'danger'] };
const U_STATUS = { ACTIVE: ['正常', 'success'], FROZEN: ['已冻结', 'danger'] };
const ROLE_LABEL = { customer: '用户', viewer: '只读访客', finance: '财务', admin: '管理员' };
function badge(map, key) {
  const [label, cls] = map[key] || [key || '—', ''];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}
const can = (perm) => !!(me && me.permissions && me.permissions.includes(perm));

// ---------- 请求 ----------
// GET 遇到网络错误或 502/503/504 时自动重试 2 次（指数退避）；写请求不自动重试，由幂等键保证手动重试安全。
async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (opts.idemKey) headers['Idempotency-Key'] = opts.idemKey;
  const retries = method === 'GET' ? 2 : 0;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
    try {
      const r = await fetch(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: ctrl.signal });
      clearTimeout(timer);
      if (attempt < retries && [502, 503, 504].includes(r.status)) { await new Promise((ok) => setTimeout(ok, 300 * 2 ** attempt)); continue; }
      const j = await r.json().catch(() => ({ ok: false, error: '服务返回格式异常' }));
      if (r.status === 401 && me) logoutLocal('登录已过期，请重新登录');
      return { status: r.status, ...j };
    } catch (e) {
      clearTimeout(timer);
      if (attempt < retries) { await new Promise((ok) => setTimeout(ok, 300 * 2 ** attempt)); continue; }
      return { status: 0, ok: false, error: e.name === 'AbortError' ? '请求超时，请检查网络后重试' : '网络连接失败，请稍后重试' };
    }
  }
}
function errText(j) { return (j.error || '操作失败') + (j.request_id && j.status >= 500 ? `（错误编号 ${j.request_id}）` : ''); }

// ---------- 二次确认 ----------
let pendingConfirm = null;
async function submitConfirmed(path, body, idemKey) {
  const r = await api(path, { method: 'POST', body, idemKey });
  if (r.status !== 428) return r;
  return new Promise((resolve) => {
    pendingConfirm = { path, body, idemKey, token: r.confirm_token, resolve };
    $('confirmTitle').textContent = (r.summary && r.summary.title) || '确认操作';
    $('confirmBody').innerHTML = ((r.summary && r.summary.lines) || []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    msg('confirmMsg', '');
    $('confirmBtn').disabled = false;
    openModal('confirmModal');
  });
}
async function acceptConfirm() {
  if (!pendingConfirm) return;
  const p = pendingConfirm;
  $('confirmBtn').disabled = true;
  const r = await api(p.path, { method: 'POST', body: { ...p.body, confirm_token: p.token }, idemKey: p.idemKey });
  $('confirmBtn').disabled = false;
  if (r.code === 'CONFIRMATION_INVALID') return msg('confirmMsg', r.error, true);
  pendingConfirm = null;
  closeModal('confirmModal');
  p.resolve(r);
}
function cancelConfirm() {
  closeModal('confirmModal');
  if (pendingConfirm) { pendingConfirm.resolve({ ok: false, cancelled: true }); pendingConfirm = null; }
}

// ---------- 基础交互 ----------
function msg(id, text, isErr) { const e = $(id); if (!e) return; e.textContent = text || ''; e.className = 'msg' + (isErr ? ' err' : ''); }
function openModal(id) { $(id).hidden = false; const f = $(id).querySelector('input:not([type=hidden]),select,textarea'); if (f) setTimeout(() => f.focus(), 0); }
function closeModal(id) { $(id).hidden = true; }
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = [...document.querySelectorAll('.modal')].filter((m) => !m.hidden).pop();
  if (open) { if (open.id === 'confirmModal') cancelConfirm(); else closeModal(open.id); }
});
function showTab(t) {
  $('tabLogin').classList.toggle('active', t === 'login'); $('tabRegister').classList.toggle('active', t === 'register');
  $('loginPane').hidden = t !== 'login'; $('registerPane').hidden = t !== 'register'; msg('authMsg', '');
}
function logoutLocal(text) {
  token = ''; me = null;
  try { localStorage.removeItem('spacepay_token'); localStorage.removeItem('pay_token'); } catch (_) { /* ignore */ }
  $('appShell').hidden = true; $('bottomNav').hidden = true; $('authView').hidden = false; $('logoutBtn').hidden = true;
  $('topUser').textContent = ''; $('simDay').textContent = '';
  if (text) msg('authMsg', text, true);
}
function enterApp() {
  $('authView').hidden = true; $('appShell').hidden = false; $('bottomNav').hidden = false; $('logoutBtn').hidden = false;
  $('topUser').textContent = me.nickname + ' · ' + me.email;
  const staff = can('console.read');
  $('consoleNav').hidden = !staff;
  $('roleLabel').textContent = ROLE_LABEL[me.role] || me.role;
  $('cExportBtns').hidden = !can('tx.export');
  const v = (location.hash || '').slice(1);
  showView(v && $('view-' + v) && (!v.startsWith('c-') || staff) ? v : 'home');
}

function showView(v) {
  currentView = v;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => (s.hidden = s.id !== 'view-' + v));
  if (location.hash.slice(1) !== v) history.replaceState(null, '', '#' + v);
  window.scrollTo(0, 0);
  refreshCurrent();
}
function refreshCurrent() {
  if (!me) return;
  const loaders = {
    home: loadHome, wallet: loadWallet, activity: () => { loadTxTable('me'); loadOrders(); }, invest: loadInvest, settings: loadAudit,
    'c-overview': loadAdminOverview, 'c-tx': () => loadTxTable('admin'), 'c-payments': () => loadAdminPayments(1),
    'c-withdrawals': loadAdminWithdrawals, 'c-users': () => loadAdminUsers(1), 'c-recon': () => {}, 'c-logs': () => loadOpLogs(1),
  };
  (loaders[currentView] || (() => {}))();
}
function togglePrivacy() { privacy = !privacy; $('privacyBtn').textContent = privacy ? '显示金额' : '隐藏金额'; refreshCurrent(); }

// ---------- 认证 ----------
async function requestCode() {
  const email = $('regEmail').value.trim();
  if (!email) return msg('authMsg', '请先填写邮箱', true);
  const j = await api('/api/auth/request-code', { method: 'POST', body: { email, purpose: 'register' } });
  msg('authMsg', j.ok ? j.message : errText(j), !j.ok);
  if (j.ok && j.demo) showDemoInbox();
}
async function showDemoInbox() {
  const email = $('regEmail').value.trim();
  const j = await api('/api/demo-inbox?email=' + encodeURIComponent(email));
  const box = $('demoInbox');
  box.hidden = false;
  if (!j.ok) { box.textContent = errText(j); return; }
  box.innerHTML = '<div class="hint">演示收件箱（不发送真实邮件）</div>' + (j.items.length ? j.items.map((x) => `验证码 <b class="mono">${esc(x.code)}</b> <span class="hint">${fmtTime(x.created_at)}</span>`).join('<br>') : '暂无验证码');
}
async function doRegister() {
  const body = { email: $('regEmail').value.trim(), nickname: $('regNickname').value.trim(), password: $('regPassword').value, code: $('regCode').value.trim() };
  const j = await api('/api/auth/register', { method: 'POST', body });
  if (!j.ok) return msg('authMsg', errText(j), true);
  showTab('login'); $('loginEmail').value = body.email; msg('authMsg', j.message);
}
async function doLogin() {
  const j = await api('/api/auth/login', { method: 'POST', body: { email: $('loginEmail').value.trim(), password: $('loginPassword').value } });
  if (!j.ok) return msg('authMsg', errText(j), true);
  token = j.token;
  try { localStorage.setItem('spacepay_token', token); } catch (_) { /* ignore */ }
  me = j.user; $('loginPassword').value = '';
  enterApp();
  if (!me.has_pin) setTimeout(() => { showView('settings'); msg('secMsg', '请先设置 6 位支付 PIN：转账、付款、提现和下单都需要验证 PIN。', true); }, 0);
}
async function doLogout() { await api('/api/auth/logout', { method: 'POST' }); logoutLocal(); }

// ---------- 总览 ----------
async function loadHome() {
  const [pf, perf, tx] = await Promise.all([api('/api/portfolio'), api('/api/performance?range=' + currentRange), api('/api/transactions?page_size=6')]);
  if (!pf.ok) return;
  simDay = pf.simulated_day;
  $('simDay').textContent = '模拟日 day-' + simDay;
  $('homeAsOf').textContent = `数据截至模拟日 day-${simDay}（每小时推进 1 个模拟日）`;
  $('kTotal').textContent = money(pf.total_cents);
  $('kCash').textContent = money(pf.cash_cents);
  $('kInvested').textContent = money(pf.invested_cents);
  $('kInvestedNote').textContent = `未实现盈亏 ${privacy ? '••••' : cents(pf.unrealized_pl_cents, { signed: true })}`;
  $('kToday').innerHTML = privacy ? '••••' : signedHtml(pf.today_pl_cents, cents(Math.abs(pf.today_pl_cents)));
  Charts.hbar($('allocChart'), {
    items: pf.allocation.map((a) => ({ label: a.class_zh, value: a.amount_cents, note: a.pct_of_total.toFixed(1) + '%' })),
    format: (v) => (privacy ? '••••' : cents(Math.round(v))), axisFormat: (v) => (privacy ? '' : axisMoney(v)),
  });
  $('allocSub').textContent = `按资产类别，金额与占总资产比例；截至模拟日 day-${simDay}`;
  if (perf.ok) {
    const s = perf.series;
    const base = s.length ? s[0].total_cents : 0;
    Charts.line($('perfChart'), {
      xLabels: s.map((p) => 'day-' + p.day),
      series: [
        { name: '总资产', cls: 'line-1', values: s.map((p) => p.total_cents) },
        { name: '模拟基准指数', cls: 'line-2', values: perf.benchmark.map((b) => Math.round((base * b.indexed) / 100)) },
      ],
      format: (v) => (privacy ? '••••' : cents(Math.round(v))), axisFormat: (v) => (privacy ? '' : axisMoney(v)),
      emptyText: '历史不足：新账户从今天开始积累数据',
    });
    const label = perf.period ? perf.period.label : '—';
    $('perfPeriod').textContent = '统计周期：' + label;
    $('retPeriod').textContent = '统计周期：' + label;
    const row = (k, v, extra) => `<dt>${k}</dt><dd>${v}${extra ? `<div class="hint">${extra}</div>` : ''}</dd>`;
    $('perfGrid').innerHTML =
      row('时间加权回报（TWR）', perf.twr_pct === null ? '<span class="muted">历史不足</span>' : signedHtml(perf.twr_pct, pct(perf.twr_pct))) +
      row('货币加权回报（MWR）', perf.mwr_pct === null ? '<span class="muted">历史不足</span>' : signedHtml(perf.mwr_pct, pct(perf.mwr_pct))) +
      row('简单回报', perf.simple_return_pct === null ? '<span class="muted">—</span>' : signedHtml(perf.simple_return_pct, pct(perf.simple_return_pct))) +
      row('分红收入', money(perf.income.dividends_cents)) + row('利息收入', money(perf.income.interest_cents));
  }
  if (tx.ok) {
    $('homeRecent').innerHTML = tx.items.map((t) => `<tr><td>${fmtTime(t.created_at).slice(5)}</td><td class="wrap">${esc(TYPE_LABEL[t.type] || t.type)}<span class="sub">${esc(t.merchant || t.counterparty_email || t.category || '')}</span></td><td>${badge(STATUS, t.status || 'SUCCEEDED')}</td><td class="num">${money(t.amount_cents, { signed: true })}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">暂无交易</td></tr>';
  }
}
function setRange(r) {
  currentRange = r;
  document.querySelectorAll('#rangeTabs button').forEach((b) => b.classList.toggle('active', b.dataset.r === r));
  loadHome();
}

// ---------- 钱包 ----------
async function loadWallet() {
  const [w, st, pays, wds] = await Promise.all([api('/api/wallet'), api('/api/stats'), api('/api/payments'), api('/api/withdrawals')]);
  if (w.ok) $('wBalance').textContent = money(w.balance_cents);
  if (st.ok) {
    $('wIn').textContent = money(st.income_cents);
    $('wOut').textContent = money(st.expense_cents);
    $('wIncome').textContent = money(st.investment_income_cents);
    $('wPeriod').textContent = `统计周期：${st.period.label}。口径：${st.definitions.inflow}；${st.definitions.outflow}；${st.definitions.investment_income}。`;
  }
  if (pays.ok) {
    $('myPayments').innerHTML = pays.items.map((p) => `<tr><td>${fmtTime(p.created_at)}</td><td>${esc(p.merchant)}<span class="sub">${esc(p.category || '')}</span></td><td>${badge(STATUS, p.status)}</td><td class="num">${money(p.amount_cents)}</td><td class="num">${p.refunded_cents ? money(p.refunded_cents) : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">暂无付款</td></tr>';
  }
  if (wds.ok) {
    $('myWithdrawals').innerHTML = wds.items.map((x) => `<tr><td>${fmtTime(x.created_at)}</td><td>尾号 ${esc(x.destination)}</td><td>${badge(W_STATUS, x.status)}${x.review_note ? `<span class="sub">${esc(x.review_note)}</span>` : ''}</td><td class="num">${money(x.amount_cents)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">暂无提现</td></tr>';
  }
}

async function moneyAction(form, path, body, msgId, btnId, modalId, okText) {
  const btn = btnId && $(btnId);
  if (btn) btn.disabled = true;
  const j = await submitConfirmed(path, body, keyFor(form));
  if (btn) btn.disabled = false;
  if (j.cancelled) return null;
  if (!j.ok) { msg(msgId, errText(j), true); return null; }
  resetKey(form);
  msg(msgId, '');
  closeModal(modalId);
  toast(okText || j.message);
  refreshCurrent();
  return j;
}
function doTopup() { return moneyAction('topup', '/api/topup', { amount: $('topupAmount').value.trim() }, 'topupMsg', null, 'topupModal'); }
function doTransfer() {
  return moneyAction('transfer', '/api/transfer', { to_email: $('trEmail').value.trim(), amount: $('trAmount').value.trim(), note: $('trNote').value.trim(), pin: $('trPin').value.trim() }, 'trMsg', 'trBtn', 'transferModal')
    .then((j) => { if (j) { $('trPin').value = ''; $('trAmount').value = ''; } });
}
function doPay() {
  return moneyAction('pay', '/api/pay', { merchant: $('payMerchant').value.trim(), category: $('payCategory').value, amount: $('payAmount').value.trim(), pin: $('payPin').value.trim() }, 'payMsg', 'payBtn', 'payModal')
    .then((j) => { if (j) { $('payPin').value = ''; $('payAmount').value = ''; } });
}
async function openWithdraw() {
  const w = await api('/api/wallet');
  $('wdAvail').textContent = w.ok ? cents(w.balance_cents) : '—';
  msg('wdMsg', '');
  openModal('withdrawModal');
}
function doWithdraw() {
  return moneyAction('withdraw', '/api/withdrawals', { amount: $('wdAmount').value.trim(), destination: $('wdDest').value.trim(), pin: $('wdPin').value.trim() }, 'wdMsg', null, 'withdrawModal')
    .then((j) => { if (j) { $('wdPin').value = ''; $('wdAmount').value = ''; } });
}
let toastTimer;
function toast(text) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); t.className = 'notice ok'; Object.assign(t.style, { position: 'fixed', right: '16px', bottom: '72px', zIndex: 60, maxWidth: '360px' }); document.body.appendChild(t); }
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ---------- 交易表（我的交易 / 运营后台交易 共用） ----------
const TX = {
  me: { el: 'meTx', list: '/api/transactions', exp: '/api/transactions/export', admin: false, page: 1, size: 20, sort: 'created_at', order: 'desc', built: false },
  admin: { el: 'adminTx', list: '/api/admin/transactions', exp: '/api/admin/transactions/export', admin: true, page: 1, size: 25, sort: 'created_at', order: 'desc', built: false },
};
function buildTxShell(key) {
  const c = TX[key];
  if (c.built) return;
  c.built = true;
  const typeOpts = Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  const statusOpts = Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('');
  $(c.el).innerHTML = `
    <form class="filters" onsubmit="event.preventDefault(); TX['${key}'].page = 1; loadTxTable('${key}')">
      <label>开始日期<input type="date" name="from"></label>
      <label>结束日期<input type="date" name="to"></label>
      <label>类型<select name="type"><option value="">全部</option>${typeOpts}</select></label>
      <label>状态<select name="status"><option value="">全部</option>${statusOpts}</select></label>
      <label>最小金额<input name="min_amount" class="narrow" inputmode="decimal" placeholder="0.00"></label>
      <label>最大金额<input name="max_amount" class="narrow" inputmode="decimal" placeholder="不限"></label>
      <label>商户<input name="merchant" placeholder="包含"></label>
      ${c.admin ? '<label>用户邮箱<input name="email" placeholder="包含"></label>' : '<label>关键字<input name="q" placeholder="说明 / 对方"></label>'}
      <button class="btn sm primary">查询</button>
      <button type="button" class="btn sm" onclick="this.form.reset(); TX['${key}'].page = 1; loadTxTable('${key}')">重置</button>
    </form>
    <div class="table-wrap"><table class="data"><thead><tr>
      <th class="sortable" data-sort="created_at">时间</th>${c.admin ? '<th>用户</th>' : ''}<th>类型</th><th>商户 / 对方 / 说明</th><th>状态</th>
      <th class="num sortable" data-sort="amount">金额</th><th class="num">交易后余额</th></tr></thead>
      <tbody></tbody><tfoot></tfoot></table></div>
    <div class="pager"><span class="p-info"></span><span class="row"><select class="p-size" aria-label="每页条数">${[10, 25, 50, 100].map((n) => `<option ${n === c.size ? 'selected' : ''}>${n}</option>`).join('')}</select><button class="btn sm p-prev">上一页</button><button class="btn sm p-next">下一页</button></span></div>`;
  const root = $(c.el);
  root.querySelectorAll('th.sortable').forEach((th) => th.addEventListener('click', () => {
    const s = th.dataset.sort;
    c.order = c.sort === s && c.order === 'desc' ? 'asc' : 'desc';
    c.sort = s; c.page = 1; loadTxTable(key);
  }));
  root.querySelector('.p-prev').addEventListener('click', () => { if (c.page > 1) { c.page--; loadTxTable(key); } });
  root.querySelector('.p-next').addEventListener('click', () => { c.page++; loadTxTable(key); });
  root.querySelector('.p-size').addEventListener('change', (e) => { c.size = Number(e.target.value); c.page = 1; loadTxTable(key); });
}
function txQuery(key, extra) {
  const c = TX[key];
  const qs = new URLSearchParams();
  const f = $(c.el).querySelector('form.filters');
  for (const [k, v] of new FormData(f)) if (String(v).trim()) qs.set(k, String(v).trim());
  for (const [k, v] of Object.entries(extra || {})) qs.set(k, v);
  qs.set('sort', c.sort); qs.set('order', c.order);
  return qs;
}
async function loadTxTable(key) {
  buildTxShell(key);
  const c = TX[key];
  const root = $(c.el);
  const qs = txQuery(key, { page: c.page, page_size: c.size });
  const j = await api(c.list + '?' + qs.toString());
  const body = root.querySelector('tbody');
  const cols = c.admin ? 7 : 6;
  if (!j.ok) { body.innerHTML = `<tr><td colspan="${cols}" class="empty">${esc(errText(j))}</td></tr>`; return; }
  const total = j.filtered_total;
  const pages = Math.max(1, Math.ceil(total / c.size));
  if (c.page > pages) { c.page = pages; return loadTxTable(key); }
  const m = c.admin ? cents : money;
  body.innerHTML = j.items.map((t) => `<tr>
    <td>${fmtTime(t.created_at)}<span class="sub mono">#${t.id}</span></td>
    ${c.admin ? `<td>${esc(t.user_email || '#' + t.user_id)}</td>` : ''}
    <td>${esc(TYPE_LABEL[t.type] || t.type)}</td>
    <td class="wrap">${esc(t.merchant || t.counterparty_email || '')}<span class="sub">${esc(t.description || '')}</span></td>
    <td>${badge(STATUS, t.status || 'SUCCEEDED')}</td>
    <td class="num">${m(t.amount_cents, { signed: true })}</td>
    <td class="num">${m(t.balance_after_cents)}</td></tr>`).join('') || `<tr><td colspan="${cols}" class="empty">没有符合条件的交易</td></tr>`;
  root.querySelector('tfoot').innerHTML = total ? `<tr><td colspan="${cols - 2}">筛选结果合计（${j.period.label}）：收入 ${m(j.summary.inflow_cents)} · 支出 ${m(j.summary.outflow_cents)} · 净流入 ${m(j.summary.net_flow_cents, { signed: true })}</td><td class="num" colspan="2">${total} 笔</td></tr>` : '';
  root.querySelectorAll('th.sortable').forEach((th) => th.setAttribute('aria-sort', th.dataset.sort === c.sort ? (c.order === 'asc' ? 'ascending' : 'descending') : 'none'));
  root.querySelector('.p-info').textContent = `共 ${total} 笔 · 第 ${c.page} / ${pages} 页`;
  root.querySelector('.p-prev').disabled = c.page <= 1;
  root.querySelector('.p-next').disabled = c.page >= pages;
}
async function exportTx(key, format) {
  buildTxShell(key);
  const c = TX[key];
  const qs = txQuery(key, { format });
  try {
    const r = await fetch(c.exp + '?' + qs.toString(), { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) { const j = await r.json().catch(() => ({})); return toast(j.error || '导出失败'); }
    const blob = await r.blob();
    const name = ((r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/) || [])[1] || `spacepay-transactions.${format}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) { toast('导出失败：网络错误'); }
}
async function loadOrders() {
  const j = await api('/api/orders');
  if (!j.ok) return;
  $('orderBody').innerHTML = j.items.map((o) => `<tr><td>${fmtTime(o.created_at)}</td><td>${esc(o.name || o.product_id)}</td><td>${o.side === 'BUY' ? '买入' : '卖出'}</td>
    <td class="num">${qtyFmt(o.quantity_milli)}</td><td class="num">${cents(o.price_cents)}</td><td class="num">${money(o.total_cents)}</td>
    <td class="num">${o.side === 'SELL' ? signedHtml(o.realized_pl_cents, money(Math.abs(o.realized_pl_cents))) : '—'}</td><td>${badge({ FILLED: ['已成交', 'success'] }, o.status)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">暂无订单</td></tr>';
}

// ---------- 投资 ----------
async function loadInvest() {
  await loadProducts();
  await Promise.all([loadHoldings(), loadAlerts(), loadRisk()]);
}
async function loadProducts() {
  const j = await api('/api/products');
  if (!j.ok) return;
  products = j.items; simDay = j.simulated_day;
  $('simDay').textContent = '模拟日 day-' + simDay;
  $('alertProduct').innerHTML = products.filter((p) => p.tradeable).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  renderProducts();
}
function renderProducts() {
  const type = $('prodType').value, risk = $('prodRisk').value, q = $('prodQ').value.trim();
  const list = products.filter((p) => (!type || p.type === type) && (!risk || p.risk === risk) && (!q || p.name.includes(q)));
  $('productBody').innerHTML = list.map((p) => `<tr>
    <td class="wrap">${esc(p.name)}<span class="sub">${esc(p.desc)}</span></td><td>${esc(p.type_zh)}</td><td><span class="badge plain">${esc(p.risk)} ${esc(p.risk_label)}</span></td>
    <td class="num">${cents(p.price_cents)}</td><td class="num">${signedHtml(p.day_change_pct, pct(p.day_change_pct))}</td>
    <td>${Charts.spark(p.sparkline)}</td>
    <td><span class="row" style="flex-wrap:nowrap">${p.tradeable ? `<button class="btn sm primary" onclick="openProduct('${esc(p.id)}')">交易</button>` : '<span class="hint">仅作基准</span>'}<button class="btn sm" onclick="toggleWatch('${esc(p.id)}')" aria-pressed="${p.watched}">${p.watched ? '已自选' : '加自选'}</button></span></td></tr>`).join('') || '<tr><td colspan="7" class="empty">没有符合条件的产品</td></tr>';
}
async function loadHoldings() {
  const j = await api('/api/holdings');
  if (!j.ok) return;
  $('holdBody').innerHTML = j.items.map((h) => `<tr><td>${esc(h.name)}<span class="sub">${esc(h.type)} · ${esc(h.risk)}</span></td>
    <td class="num">${qtyFmt(h.quantity_milli)}</td><td class="num">${cents(h.avg_cost_cents)}</td><td class="num">${cents(h.price_cents)}</td>
    <td class="num">${money(h.market_value_cents)}</td>
    <td class="num">${signedHtml(h.unrealized_pl_cents, money(Math.abs(h.unrealized_pl_cents)))}<span class="sub">${pct(h.unrealized_pct)}</span></td>
    <td class="num">${h.weight_pct.toFixed(1)}%</td><td>${Charts.spark(h.sparkline)}</td>
    <td><button class="btn sm" onclick="openProduct('${esc(h.product_id)}','SELL')">卖出</button></td></tr>`).join('') || '<tr><td colspan="9" class="empty">暂无持仓</td></tr>';
  $('realizedLine').innerHTML = `已实现盈亏（累计）：${signedHtml(j.realized_pl_cents, money(Math.abs(j.realized_pl_cents)))}，与未实现盈亏分开列示。`;
  const fds = j.fixed_deposits || [];
  $('fdCard').hidden = !fds.length;
  const fdStatus = { ACTIVE: ['持有中', 'info'], MATURED: ['已到期', 'success'], BROKEN: ['已提前支取', ''] };
  const fdList = await api('/api/fixed-deposits');
  const accrued = new Map((fdList.items || []).map((x) => [x.id, x.accrued_cents]));
  $('fdBody').innerHTML = fds.map((fd) => {
    const p = products.find((x) => x.id === fd.product_id) || { name: fd.product_id };
    return `<tr><td>${esc(p.name)}</td><td class="num">${money(fd.principal_cents)}</td><td class="num">${(fd.rate_bps / 100).toFixed(2)}%</td><td class="num">${fd.status === 'ACTIVE' ? money(accrued.get(fd.id) || 0) : '—'}</td>
      <td>day-${fd.maturity_day}</td><td>${badge(fdStatus, fd.status)}</td><td>${fd.status === 'ACTIVE' ? `<button class="btn sm" onclick="breakFd(${fd.id})">提前支取</button>` : ''}</td></tr>`;
  }).join('');
}
async function breakFd(id) {
  const pin = prompt('提前支取按已存天数计息。请输入 6 位支付 PIN 确认：');
  if (!pin) return;
  const j = await api('/api/fixed-deposits/' + id + '/break', { method: 'POST', body: { pin } });
  toast(j.ok ? `${j.message}：本金 ${cents(j.principal_cents)}，利息 ${cents(j.interest_cents)}` : errText(j));
  if (j.ok) loadInvest();
}
async function toggleWatch(id) {
  const j = await api('/api/watchlist', { method: 'POST', body: { product_id: id } });
  if (j.ok) loadProducts();
}
async function loadAlerts() {
  const j = await api('/api/alerts');
  if (!j.ok) return;
  const cond = { ABOVE: '价格高于', BELOW: '价格低于', DAY_CHANGE: '日涨跌幅超过' };
  const st = { ACTIVE: ['生效中', 'info'], FIRED: ['已触发', 'success'] };
  $('alertBody').innerHTML = j.items.map((a) => `<tr><td>${esc(a.name)}</td><td>${cond[a.condition] || esc(a.condition)}</td>
    <td class="num">${a.condition === 'DAY_CHANGE' ? (a.threshold_cents / 100).toFixed(2) + '%' : cents(a.threshold_cents)}</td>
    <td>${a.mode === 'ONCE' ? '触发一次' : '每次触发'}</td><td>${badge(st, a.status)}</td><td><button class="btn sm" onclick="delAlert(${a.id})">删除</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">暂无提醒</td></tr>';
}
async function addAlert() {
  const condition = $('alertCond').value;
  const body = { product_id: $('alertProduct').value, condition, mode: $('alertMode').value };
  const v = $('alertThreshold').value.trim();
  if (condition === 'DAY_CHANGE') body.threshold_pct = v; else body.threshold_price = v;
  const j = await api('/api/alerts', { method: 'POST', body });
  toast(j.ok ? j.message : errText(j));
  if (j.ok) { $('alertThreshold').value = ''; loadAlerts(); }
}
async function delAlert(id) { await api('/api/alerts/' + id, { method: 'DELETE' }); loadAlerts(); }

function openProduct(id, side) {
  const p = products.find((x) => x.id === id);
  if (!p) return;
  curProduct = p; curPreview = null;
  $('pmName').textContent = p.name;
  $('pmMeta').textContent = `${p.type_zh} · ${p.risk} ${p.risk_label} · 现价 ${cents(p.price_cents)} · 模拟日 day-${simDay}`;
  $('pmInfo').textContent = p.type === 'FIXED_DEPOSIT'
    ? `按金额申购，年化 ${(p.rate_bps / 100).toFixed(2)}%，${p.term_days} 个模拟日后到期；提前支取按已存天数计息。`
    : `${p.desc} 年化分红率 ${(p.dividend_yield * 100).toFixed(1)}%。`;
  setSide(side || 'BUY');
  $('pmAmount').value = ''; $('pmQty').value = ''; msg('pmMsg', '');
  $('pmChart').innerHTML = '';
  openModal('productModal');
  api('/api/products/' + encodeURIComponent(id) + '?range=1M').then((j) => {
    if (!j.ok) return;
    Charts.line($('pmChart'), { xLabels: j.history.map((h) => 'day-' + h.day), series: [{ name: '价格', cls: 'line-1', values: j.history.map((h) => h.price_cents) }], format: (v) => cents(Math.round(v)), axisFormat: (v) => cents(Math.round(v)), height: 200 });
  });
}
function setSide(s) {
  curSide = s;
  $('pmBuyBtn').classList.toggle('active', s === 'BUY');
  $('pmSellBtn').classList.toggle('active', s === 'SELL');
}
async function previewOrder() {
  const body = { product_id: curProduct.id, side: curSide };
  const amt = $('pmAmount').value.trim(), qty = $('pmQty').value.trim();
  if (amt) body.amount = amt; else if (qty) body.quantity = qty; else return msg('pmMsg', '请输入金额或数量', true);
  const j = await api('/api/orders/preview', { method: 'POST', body });
  if (!j.ok) return msg('pmMsg', errText(j), true);
  curPreview = { ...j, idempotency_key: newKey() };
  const dd = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  $('reviewBody').innerHTML = dd('产品', esc(j.name)) + dd('方向', j.side === 'BUY' ? '买入' : '卖出') + dd('数量', qtyFmt(j.quantity_milli) + ' 份')
    + dd(`成交价（day-${j.simulated_day}）`, cents(j.price_cents)) + dd('手续费', cents(0)) + dd('成交额', '<b>' + cents(j.total_cents) + '</b>') + dd('成交后现金', cents(j.cash_after_cents));
  $('reviewWarn').innerHTML = (j.shortfall_cents ? `<p class="notice" style="margin-top:var(--space-3)">余额不足，还差 ${cents(j.shortfall_cents)}。</p>` : '')
    + (j.risk_warning ? `<p class="notice" style="margin-top:var(--space-3)">${esc(j.risk_warning)}</p>` : '');
  $('confirmOrderBtn').textContent = `确认${j.side === 'BUY' ? '买入' : '卖出'} ${cents(j.total_cents)}`;
  $('reviewPin').value = ''; msg('reviewMsg', '');
  closeModal('productModal'); openModal('reviewModal');
}
async function confirmOrder() {
  if (!curPreview) return;
  const btn = $('confirmOrderBtn');
  btn.disabled = true;
  const j = await api('/api/orders', { method: 'POST', idemKey: curPreview.idempotency_key, body: { product_id: curPreview.product_id, side: curPreview.side, quantity_milli: curPreview.quantity_milli, pin: $('reviewPin').value.trim(), idempotency_key: curPreview.idempotency_key } });
  btn.disabled = false;
  if (!j.ok) return msg('reviewMsg', errText(j), true);
  const o = j.duplicate ? j.order : j;
  const dd = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  $('receiptBody').innerHTML = dd('订单号', '#' + (o.order_id || o.id || j.fixed_deposit_id) + (j.duplicate ? '（重复提交，未重复成交）' : ''))
    + (j.name ? dd('产品', esc(j.name)) : '') + (j.side ? dd('方向', j.side === 'BUY' ? '买入' : '卖出') : '')
    + (j.quantity !== undefined ? dd('数量', Number(j.quantity).toFixed(3) + ' 份') : '') + (j.price_cents ? dd('成交价', cents(j.price_cents)) : '')
    + dd('成交额', cents(o.total_cents)) + (j.side === 'SELL' ? dd('已实现盈亏', signedHtml(j.realized_pl_cents, cents(Math.abs(j.realized_pl_cents)))) : '')
    + (j.cash_after_cents !== undefined ? dd('成交后现金', cents(j.cash_after_cents)) : '');
  closeModal('reviewModal'); openModal('receiptModal');
}

// 风险测评 / 目标 / 再平衡
async function openRiskQuiz() {
  const j = await api('/api/risk-quiz');
  if (!j.ok) return toast(errText(j));
  $('quizBox').innerHTML = j.questions.map((q, i) => `<fieldset style="border:0;padding:0;margin:0 0 var(--space-4)"><legend style="font-weight:500;margin-bottom:var(--space-2)">${i + 1}. ${esc(q.q)}</legend>
    ${q.options.map((o, k) => `<label class="row" style="margin:var(--space-1) 0;flex-wrap:nowrap"><input type="radio" name="q${i}" value="${k}"> ${esc(o)}</label>`).join('')}</fieldset>`).join('');
  $('quizResult').innerHTML = '';
  openModal('riskModal');
}
async function submitQuiz() {
  const answers = [];
  for (let i = 0; i < 5; i++) {
    const sel = document.querySelector(`input[name="q${i}"]:checked`);
    if (!sel) { $('quizResult').innerHTML = `<p class="msg err">请回答第 ${i + 1} 题</p>`; return; }
    answers.push(Number(sel.value));
  }
  const j = await api('/api/risk-quiz', { method: 'POST', body: { answers } });
  if (!j.ok) { $('quizResult').innerHTML = `<p class="msg err">${esc(errText(j))}</p>`; return; }
  $('quizResult').innerHTML = `<div class="notice ok">结果：${esc(j.level_zh)}，得分 ${j.score}/20，可买产品风险上限 ${esc(j.max_risk)}。示例配置：${Object.entries(j.suggested).map(([k, v]) => `${k} ${v}%`).join('，')}。</div>`;
  loadRisk();
}
async function loadRisk() {
  const j = await api('/api/risk');
  if (!j.ok) return;
  $('riskLine').textContent = j.level ? `风险等级：${j.level_zh}（${j.score}/20），可买产品风险上限 ${j.max_risk}` : '尚未完成风险测评。';
}
async function openGoals() {
  const j = await api('/api/goals');
  $('goalsList').innerHTML = j.ok && j.items.length
    ? `<table class="data"><thead><tr><th>目标</th><th class="num">目标金额</th><th class="num">进度</th><th></th></tr></thead><tbody>${j.items.map((g) => `<tr><td>${esc(g.name)}<span class="sub">${esc(g.target_date || '')}</span></td><td class="num">${money(g.target_cents)}</td><td class="num">${g.progress_pct.toFixed(1)}%</td><td><button class="btn sm" onclick="delGoal(${g.id})">删除</button></td></tr>`).join('')}</tbody></table><p class="hint" style="margin-top:var(--space-2)">进度 = 当前总资产 ÷ 目标金额</p>`
    : '<p class="hint">暂无目标。</p>';
  msg('goalMsg', '');
  openModal('goalsModal');
}
async function addGoal() {
  const j = await api('/api/goals', { method: 'POST', body: { name: $('goalName').value.trim(), target_amount: $('goalAmount').value.trim(), target_date: $('goalDate').value } });
  if (!j.ok) return msg('goalMsg', errText(j), true);
  $('goalName').value = ''; $('goalAmount').value = '';
  openGoals();
}
async function delGoal(id) { await api('/api/goals/' + id, { method: 'DELETE' }); openGoals(); }
async function openRebalance() {
  const j = await api('/api/rebalance/preview');
  if (!j.ok) $('rebalanceBody').innerHTML = `<p class="notice">${esc(j.error)}。请先完成风险测评。</p>`;
  else {
    $('rebalanceBody').innerHTML = `<table class="data"><thead><tr><th>类别</th><th class="num">目标</th><th class="num">当前</th><th class="num">偏离</th><th class="num">容忍区间</th><th>状态</th></tr></thead><tbody>
      ${j.items.map((i) => `<tr><td>${esc(i.class_zh)}</td><td class="num">${i.target_pct}%</td><td class="num">${i.current_pct.toFixed(1)}%</td><td class="num">${i.drift_pct >= 0 ? '+' : '−'}${Math.abs(i.drift_pct).toFixed(1)}pp</td><td class="num">±${i.band_pp.toFixed(2)}pp</td><td>${i.breached ? '<span class="badge warning">超出区间</span>' : '<span class="badge success">区间内</span>'}</td></tr>`).join('')}</tbody></table>
      <h3 style="margin:var(--space-4) 0 var(--space-2)">建议交易</h3>
      ${j.suggestions.length ? `<dl class="kv">${j.suggestions.map((s) => `<dt>${s.side === 'BUY' ? '买入' : '卖出'} ${esc(s.name)}</dt><dd>${cents(s.amount_cents)}</dd>`).join('')}</dl>` : '<p class="hint">各类别均在区间内，无需交易。</p>'}`;
  }
  msg('rebMsg', '');
  openModal('rebalanceModal');
}
async function executeRebalance() {
  const btn = $('rebExecBtn'); btn.disabled = true;
  const j = await api('/api/rebalance/execute', { method: 'POST', body: { pin: $('rebPin').value.trim() } });
  btn.disabled = false;
  if (!j.ok) return msg('rebMsg', errText(j), true);
  msg('rebMsg', j.message + '：' + j.results.map((r) => (r.skipped ? `${r.class} 跳过（${r.reason}）` : `${r.side === 'BUY' ? '买入' : '卖出'} ${r.name} ${cents(r.amount_cents)}`)).join('；'));
  $('rebPin').value = '';
  loadInvest();
}

// ---------- 设置 ----------
async function setPin() {
  const j = await api('/api/security/set-pin', { method: 'POST', body: { pin: $('pinNew').value.trim(), password: $('pinPw').value } });
  msg('secMsg', j.ok ? j.message : errText(j), !j.ok);
  if (j.ok) { me.has_pin = 1; $('pinNew').value = ''; $('pinPw').value = ''; loadAudit(); }
}
async function changePin() {
  const j = await api('/api/security/change-pin', { method: 'POST', body: { old_pin: $('pinOld').value.trim(), new_pin: $('pinNew2').value.trim() } });
  msg('secMsg', j.ok ? j.message : errText(j), !j.ok);
  if (j.ok) { $('pinOld').value = ''; $('pinNew2').value = ''; loadAudit(); }
}
async function changePw() {
  const j = await api('/api/security/change-password', { method: 'POST', body: { old_password: $('pwOld').value, new_password: $('pwNew').value } });
  msg('secMsg', j.ok ? j.message : errText(j), !j.ok);
  if (j.ok) { $('pwOld').value = ''; $('pwNew').value = ''; loadAudit(); }
}
async function loadAudit() {
  const j = await api('/api/security/audit');
  if (j.ok) $('auditBody').innerHTML = j.items.map((a) => `<tr><td>${fmtTime(a.created_at)}</td><td>${esc(a.action)}</td><td class="wrap">${esc(a.detail || '')}</td><td class="mono">${esc(a.ip || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">暂无记录</td></tr>';
}
async function exportData() {
  const j = await api('/api/backup/export');
  if (!j.ok) return msg('backupMsg', errText(j), true);
  $('exportBox').hidden = false;
  $('exportBox').textContent = JSON.stringify(j.export, null, 2);
  msg('backupMsg', '已导出本账户数据（不含密码与 PIN 哈希）。');
}
async function backupDb() {
  const j = await api('/api/backup/db', { method: 'POST' });
  msg('backupMsg', j.ok ? `${j.message}：${j.file}（完整性检查：${j.integrity || '—'}）` : errText(j), !j.ok);
}
async function resetDemo() {
  if (!confirm('重置后，本账户的交易、持仓和订单将被清空，余额恢复为 $50.00。继续？')) return;
  const j = await api('/api/demo/reset', { method: 'POST', body: { password: $('resetPw').value } });
  msg('resetMsg', j.ok ? j.message : errText(j), !j.ok);
  if (j.ok) $('resetPw').value = '';
}

// ---------- 运营后台 ----------
async function loadAdminOverview() {
  const j = await api('/api/admin/overview?days=14');
  if (!j.ok) return;
  const k = j.kpis;
  $('cPeriod').textContent = '统计周期：' + j.period.label;
  $('cUsers').textContent = k.users.toLocaleString('en-US');
  $('cFrozen').textContent = `其中已冻结 ${k.frozen_users} 个`;
  $('cWallet').textContent = cents(k.wallet_total_cents);
  $('cFlow').textContent = cents(k.inflow_cents - k.outflow_cents, { signed: true });
  $('cFlowNote').textContent = `收入 ${cents(k.inflow_cents)} · 支出 ${cents(k.outflow_cents)} · ${k.transactions} 笔`;
  $('cPending').textContent = String(k.pending_withdrawals);
  $('cPendingAmt').textContent = '金额合计 ' + cents(k.pending_withdrawals_cents);
  $('flowPeriod').textContent = '统计周期：' + j.period.label;
  Charts.columns($('flowChart'), {
    categories: j.series.map((s) => s.date),
    series: [{ name: '收入', cls: 'bar-1', values: j.series.map((s) => s.inflow_cents) }, { name: '支出', cls: 'bar-2', values: j.series.map((s) => s.outflow_cents) }],
    format: (v) => cents(Math.round(v)), axisFormat: axisMoney,
  });
}

function pager(id, page, size, total, fn) {
  const pages = Math.max(1, Math.ceil(total / size));
  $(id).innerHTML = `<span>共 ${total} 条 · 第 ${page} / ${pages} 页</span><span class="row"><button class="btn sm" ${page <= 1 ? 'disabled' : ''} onclick="${fn}(${page - 1})">上一页</button><button class="btn sm" ${page >= pages ? 'disabled' : ''} onclick="${fn}(${page + 1})">下一页</button></span>`;
}

let paymentsCache = [];
async function loadAdminPayments(page) {
  const qs = new URLSearchParams({ page, page_size: 20 });
  if ($('cpEmail').value.trim()) qs.set('email', $('cpEmail').value.trim());
  if ($('cpStatus').value) qs.set('status', $('cpStatus').value);
  const j = await api('/api/admin/payments?' + qs);
  if (!j.ok) { $('cpBody').innerHTML = `<tr><td colspan="9" class="empty">${esc(errText(j))}</td></tr>`; return; }
  paymentsCache = j.items;
  $('cpBody').innerHTML = j.items.map((p) => `<tr><td class="mono">#${p.id}</td><td>${fmtTime(p.created_at)}</td><td>${esc(p.user_email)}</td><td>${esc(p.merchant)}<span class="sub">${esc(p.category || '')}</span></td>
    <td>${badge(STATUS, p.status)}</td><td class="num">${cents(p.amount_cents)}</td><td class="num">${p.refunded_cents ? cents(p.refunded_cents) : '—'}</td><td class="num">${cents(p.refundable_cents)}</td>
    <td>${can('refund.create') && p.refundable_cents > 0 ? `<button class="btn sm" onclick="openRefund(${p.id})">退款</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">没有符合条件的支付</td></tr>';
  pager('cpPager', j.page, j.page_size, j.filtered_total, 'loadAdminPayments');
}

// 运营操作弹窗：先填原因（和金额），提交后服务端返回摘要，再在确认弹窗中确认
let op = null;
function openOp(cfg) {
  op = cfg;
  $('opTitle').textContent = cfg.title;
  $('opInfo').innerHTML = cfg.info.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('opAmountField').hidden = !cfg.amount;
  $('opRoleField').hidden = !cfg.role;
  $('opReasonField').hidden = cfg.reason === false;
  $('opReasonLabel').textContent = cfg.reasonLabel || '原因（必填，记入操作日志）';
  $('opAmount').value = cfg.amountDefault || '';
  $('opReason').value = '';
  if (cfg.role) $('opRole').value = cfg.roleDefault;
  $('opBtn').className = 'btn ' + (cfg.danger ? 'danger solid' : 'primary');
  msg('opMsg', '');
  formKeys.op = newKey();
  openModal('opModal');
}
async function submitOp() {
  if (!op) return;
  const body = {};
  if (op.amount) body.amount = $('opAmount').value.trim();
  if (op.role) body.role = $('opRole').value;
  if (op.reason !== false) body.reason = $('opReason').value.trim();
  $('opBtn').disabled = true;
  const j = await submitConfirmed(op.path, body, op.idempotent ? keyFor('op') : undefined);
  $('opBtn').disabled = false;
  if (j.cancelled) return;
  if (!j.ok) return msg('opMsg', errText(j), true);
  closeModal('opModal');
  toast(j.message);
  op.done && op.done();
}
function openRefund(id) {
  const p = paymentsCache.find((x) => x.id === id);
  openOp({
    title: '退款', path: `/api/admin/payments/${id}/refunds`, amount: true, amountDefault: (p.refundable_cents / 100).toFixed(2), idempotent: true,
    info: [['支付编号', '#' + p.id], ['用户', p.user_email], ['商户', p.merchant], ['支付金额', cents(p.amount_cents)], ['可退金额', cents(p.refundable_cents)]],
    done: () => loadAdminPayments(1),
  });
}

async function loadAdminWithdrawals() {
  const s = $('cwStatus').value;
  const j = await api('/api/admin/withdrawals' + (s ? '?status=' + s : ''));
  if (!j.ok) return;
  const review = can('withdrawal.review');
  $('cwBody').innerHTML = j.items.map((w) => `<tr><td class="mono">#${w.id}</td><td>${fmtTime(w.created_at)}</td><td>${esc(w.user_email)}</td><td>尾号 ${esc(w.destination)}</td>
    <td>${badge(W_STATUS, w.status)}</td><td class="num">${cents(w.amount_cents)}</td><td class="wrap">${esc(w.review_note || '')}</td>
    <td>${review && w.status === 'PENDING' && w.user_id !== me.id ? `<span class="row"><button class="btn sm" onclick="reviewW(${w.id},true)">批准</button><button class="btn sm danger" onclick="reviewW(${w.id},false)">驳回</button></span>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">没有符合条件的提现</td></tr>';
  window._wd = j.items;
}
function reviewW(id, approve) {
  const w = (window._wd || []).find((x) => x.id === id);
  openOp({
    title: approve ? '批准提现' : '驳回提现', path: `/api/admin/withdrawals/${id}/${approve ? 'approve' : 'reject'}`, danger: !approve,
    reasonLabel: approve ? '审核备注（选填）' : '驳回原因（必填，用户可见）',
    info: [['申请编号', '#' + w.id], ['用户', w.user_email], ['金额', cents(w.amount_cents)], ['收款账户', '尾号 ' + w.destination]],
    done: loadAdminWithdrawals,
  });
}

let usersCache = [];
async function loadAdminUsers(page) {
  const qs = new URLSearchParams({ page, page_size: 20 });
  if ($('cuQ').value.trim()) qs.set('q', $('cuQ').value.trim());
  if ($('cuStatus').value) qs.set('status', $('cuStatus').value);
  const j = await api('/api/admin/users?' + qs);
  if (!j.ok) return;
  usersCache = j.items;
  const canFreeze = can('user.freeze'), canRole = can('user.role');
  $('cuBody').innerHTML = j.items.map((u) => `<tr><td class="mono">#${u.id}</td><td>${esc(u.email)}</td><td>${esc(u.nickname)}</td><td>${esc(ROLE_LABEL[u.role] || u.role)}</td>
    <td>${badge(U_STATUS, u.status)}${u.frozen_reason ? `<span class="sub">${esc(u.frozen_reason)}</span>` : ''}</td><td class="num">${cents(u.balance_cents)}</td><td>${fmtTime(u.created_at)}</td>
    <td>${u.id === me.id ? '<span class="hint">当前账户</span>' : `<span class="row">${canFreeze ? (u.status === 'FROZEN' ? `<button class="btn sm" onclick="freezeU(${u.id},false)">解冻</button>` : `<button class="btn sm danger" onclick="freezeU(${u.id},true)">冻结</button>`) : ''}${canRole ? `<button class="btn sm" onclick="roleU(${u.id})">角色</button>` : ''}</span>`}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">没有符合条件的用户</td></tr>';
  pager('cuPager', j.page, j.page_size, j.filtered_total, 'loadAdminUsers');
}
function freezeU(id, freeze) {
  const u = usersCache.find((x) => x.id === id);
  openOp({ title: freeze ? '冻结账户' : '解冻账户', path: `/api/admin/users/${id}/${freeze ? 'freeze' : 'unfreeze'}`, danger: freeze, info: [['账户', u.email], ['余额', cents(u.balance_cents)]], done: () => loadAdminUsers(1) });
}
function roleU(id) {
  const u = usersCache.find((x) => x.id === id);
  openOp({ title: '调整角色', path: `/api/admin/users/${id}/role`, role: true, roleDefault: u.role, reason: false, info: [['账户', u.email], ['当前角色', ROLE_LABEL[u.role]]], done: () => loadAdminUsers(1) });
}

async function runRecon() {
  const j = await api('/api/admin/reconciliation');
  if (!j.ok) { $('reconResult').innerHTML = `<p class="notice">${esc(errText(j))}</p>`; return; }
  const r = j.reconciliation;
  const names = { journal_balanced: '分录借贷不平衡', wallet_vs_ledger: '钱包余额与账本不一致', wallet_vs_last_transaction: '钱包余额与最后一笔流水不一致', non_negative_balance: '余额为负', clearing_p2p_zero: '转账清算科目未归零', clearing_withdrawals_matches_pending: '提现在途与待审核金额不一致' };
  $('reconResult').innerHTML = `
    <p class="notice ${r.ok ? 'ok' : ''}" style="margin-bottom:var(--space-5)">${r.ok ? '对账通过，未发现差异。' : `发现 ${r.issues.length} 项差异，请逐项核查。`} 检查时间 ${fmtTime(Date.parse(r.checked_at))}</p>
    <div class="kpis">
      <div class="kpi"><div class="kpi-label">分录 / 凭证</div><div class="kpi-value">${r.entries.toLocaleString('en-US')}</div><div class="kpi-note">${r.journals.toLocaleString('en-US')} 个凭证</div></div>
      <div class="kpi"><div class="kpi-label">钱包余额合计</div><div class="kpi-value">${cents(r.wallet_total_cents)}</div><div class="kpi-note">${r.wallets} 个钱包</div></div>
      <div class="kpi"><div class="kpi-label">转账清算科目</div><div class="kpi-value">${cents(r.clearing.p2p_cents)}</div><div class="kpi-note">应为 $0.00</div></div>
      <div class="kpi"><div class="kpi-label">提现在途</div><div class="kpi-value">${cents(r.clearing.withdrawals_in_transit_cents)}</div><div class="kpi-note">应等于待审核提现合计</div></div>
    </div>
    ${r.issues.length ? `<div class="card"><div class="table-wrap"><table class="data"><thead><tr><th>检查项</th><th>对象</th><th class="num">差额</th><th>明细</th></tr></thead><tbody>${r.issues.map((i) => `<tr><td>${esc(names[i.check] || i.check)}</td><td>${esc(i.user_id ? '用户 #' + i.user_id : i.journal_id || '—')}</td><td class="num">${i.difference_cents !== undefined ? cents(i.difference_cents) : '—'}</td><td class="mono wrap">${esc(JSON.stringify(i))}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
}

let logLabels = null;
async function loadOpLogs(page) {
  const a = $('clAction').value;
  const j = await api('/api/admin/operation-logs?' + new URLSearchParams({ page, page_size: 30, ...(a ? { action: a } : {}) }));
  if (!j.ok) return;
  if (!logLabels) {
    logLabels = j.labels;
    $('clAction').innerHTML = '<option value="">全部</option>' + Object.entries(j.labels).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  }
  const res = (r) => (r === 'SUCCEEDED' ? '<span class="badge success">成功</span>' : r === 'MISMATCH' ? '<span class="badge warning">有差异</span>' : `<span class="badge danger">已拒绝</span><span class="sub">${esc(r.replace('REJECTED:', ''))}</span>`);
  $('clBody').innerHTML = j.items.map((l) => `<tr><td>${fmtTime(l.created_at)}</td><td>${esc(l.actor_email || '—')}</td><td>${esc(ROLE_LABEL[l.actor_role] || l.actor_role || '—')}</td>
    <td>${esc(j.labels[l.action] || l.action)}</td><td>${esc(l.target_type ? l.target_type + (l.target_id ? ' #' + l.target_id : '') : '—')}</td>
    <td class="num">${l.amount_cents !== null ? cents(l.amount_cents) : '—'}</td><td class="wrap">${esc(l.reason || '')}</td><td>${res(l.result)}</td><td class="mono">${esc(l.request_id || '')}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">暂无记录</td></tr>';
  pager('clPager', j.page, j.page_size, j.filtered_total, 'loadOpLogs');
}

// ---------- 启动：恢复登录 ----------
(async () => {
  if (!token) return;
  $('authView').hidden = true; // 正在恢复会话，避免闪现登录框
  const j = await api('/api/me');
  if (j.ok) { me = j.user; enterApp(); } else logoutLocal();
})();
