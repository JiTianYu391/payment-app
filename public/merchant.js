// SpacePay 商户后台（原生 JS，无构建步骤）。
// 鉴权使用 httpOnly 会话 cookie；金额由服务端以整数分返回，这里只负责展示。
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cents = (c) => {
  if (c === null || c === undefined || Number.isNaN(c)) return '—';
  const neg = c < 0; const abs = Math.abs(c);
  return (neg ? '−' : '') + '$' + String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + String(abs % 100).padStart(2, '0');
};
const fmtTime = (ts) => { const d = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const PAY_STATUS = {
  CREATED: ['待支付', 'warning'], SUCCEEDED: ['成功', 'success'], PARTIALLY_REFUNDED: ['部分退款', 'info'],
  REFUNDED: ['已退款', ''], FAILED: ['失败', 'danger'], CANCELED: ['已取消', ''], EXPIRED: ['已过期', ''],
};
const PO_STATUS = { PENDING: ['审核中', 'warning'], SUCCEEDED: ['已出款', 'success'], FAILED: ['已驳回', 'danger'] };
const WH_STATUS = { PENDING: ['重试中', 'warning'], DELIVERED: ['已送达', 'success'], FAILED: ['失败', 'danger'] };
function badge(map, key) { const [label, cls] = map[key] || [key || '—', '']; return `<span class="badge ${cls}">${esc(label)}</span>`; }

let me = null;
let merchant = null;
let currentView = 'overview';
let pendingConfirm = null;
let paymentsPage = 1;
let detailPayment = null;

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.idemKey) headers['Idempotency-Key'] = opts.idemKey;
  const r = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  let j = null;
  try { j = await r.json(); } catch (_) { j = { ok: false, error: '服务返回格式异常' }; }
  return { status: r.status, ...j };
}
function msg(id, text, isErr) { const e = $(id); if (!e) return; e.textContent = text || ''; e.className = 'msg' + (isErr ? ' err' : ''); }
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('modal')) closeModal(e.target.id);
  const c = e.target.closest && e.target.closest('[data-close]');
  if (c) closeModal(c.closest('.modal').id);
  const go = e.target.closest && e.target.closest('[data-go]');
  if (go) showView(go.dataset.go);
  const cp = e.target.closest && e.target.closest('.copy');
  if (cp) copyText(cp.dataset.copy || cp.parentElement.querySelector('span').textContent, cp);
});
function copyText(text, btn) {
  const done = () => { const old = btn.textContent; btn.textContent = '已复制'; setTimeout(() => { btn.textContent = old; }, 1500); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => {});
  else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (_) {} ta.remove(); }
}
function toast(text) {
  const t = document.createElement('div');
  t.textContent = text;
  t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#0E1726;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;z-index:99;box-shadow:0 8px 24px rgba(0,0,0,.25)';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// ---------- 二次确认 ----------
function askConfirm(summary) {
  $('confirmTitle').textContent = (summary && summary.title) || '确认操作';
  $('confirmBody').innerHTML = ((summary && summary.lines) || []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  msg('confirmMsg', '');
  $('confirmOk').disabled = false;
  openModal('confirmModal');
}
async function postWithConfirm(path, body, idemKey) {
  let r = await api(path, { method: 'POST', body, idemKey });
  if (r.status !== 428) return r;
  return new Promise((resolve) => {
    pendingConfirm = { path, body, idemKey, token: r.confirm_token, resolve };
    askConfirm(r.summary);
  });
}
$('confirmOk').addEventListener('click', async () => {
  const p = pendingConfirm;
  if (!p) return;
  $('confirmOk').disabled = true;
  const r = await api(p.path, { method: 'POST', body: { ...p.body, confirm_token: p.token }, idemKey: p.idemKey });
  $('confirmOk').disabled = false;
  if (!r.ok) return msg('confirmMsg', r.error || '操作失败', true);
  closeModal('confirmModal');
  pendingConfirm = null;
  p.resolve(r);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = [...document.querySelectorAll('.modal')].filter((m) => !m.hidden).pop();
  if (open) closeModal(open.id);
});

// ---------- 入口 ----------
async function boot() {
  const mine = await api('/api/me');
  if (!mine.ok) return gate('请先登录', '商户后台需要登录 SpacePay 账户。登录后会自动回到这里。', `<a class="btn primary" href="/?next=${encodeURIComponent('/merchant')}">去登录</a>`);
  me = mine.user;
  $('logoutBtn').hidden = false;
  $('logoutBtn').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; });

  const st = await api('/api/merchant/status');
  if (!st.ok) return gate('无法加载商户信息', st.error || '请稍后重试', '<button class="btn" onclick="location.reload()">重试</button>');
  merchant = st.merchant;
  if (!merchant) return applyGate();
  if (merchant.status === 'PENDING') return gate('入驻申请审核中', `我们已收到「${esc(merchant.name)}」的入驻申请，审核通过后即可创建密钥并收款。`, '<a class="btn" href="/">返回钱包</a>');
  if (merchant.status === 'REJECTED') return gate('入驻申请未通过', '如需重新申请，请联系运营或在用户端反馈。', '<a class="btn" href="/">返回钱包</a>');
  if (merchant.status === 'SUSPENDED') return gate('商户已被暂停', '收款与结算暂时不可用。如有疑问请联系运营。', '<a class="btn" href="/">返回钱包</a>');
  enterConsole();
}

function gate(title, text, bodyHtml) {
  $('app').hidden = true;
  $('gate').hidden = false;
  $('gateTitle').textContent = title;
  $('gateText').innerHTML = text;
  $('gateBody').innerHTML = bodyHtml;
}
function applyGate() {
  gate('申请成为商户', '通过审核后可以创建 API Key、接收付款并申请结算。当前为虚拟资金环境。', `
    <label class="field"><span>商户名称</span><input id="applyName" maxlength="60" placeholder="例如：蓝湾咖啡"></label>
    <label class="field"><span>网站（选填）</span><input id="applySite" maxlength="300" placeholder="https://example.com"></label>
    <label class="field"><span>简介（选填）</span><textarea id="applyDesc" maxlength="300" rows="3"></textarea></label>
    <div class="actions"><button class="btn primary" id="applyBtn">提交申请</button></div>
    <p class="msg" id="applyMsg"></p>`);
  $('applyBtn').addEventListener('click', async () => {
    const g = $('applyBtn'); g.disabled = true;
    const r = await api('/api/merchant/apply', { method: 'POST', body: { name: $('applyName').value.trim(), website: $('applySite').value.trim(), description: $('applyDesc').value.trim() } });
    g.disabled = false;
    if (!r.ok) return msg('applyMsg', r.error || '提交失败', true);
    location.reload();
  });
}
function enterConsole() {
  $('gate').hidden = true;
  $('app').hidden = false;
  $('merchantName').textContent = merchant.name;
  $('merchantEmail').textContent = merchant.email;
  document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  const hash = location.hash.slice(1);
  showView(['overview', 'payments', 'payouts', 'keys', 'webhooks', 'profile'].includes(hash) ? hash : 'overview');
}
function showView(v) {
  currentView = v;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.m-main > section').forEach((s) => { s.hidden = s.id !== 'view-' + v; });
  if (location.hash.slice(1) !== v) history.replaceState(null, '', '#' + v);
  window.scrollTo(0, 0);
  ({ overview: loadOverview, payments: () => loadPayments(paymentsPage), payouts: loadPayouts, keys: loadKeys, webhooks: loadWebhooks, profile: loadProfile })[v]();
}

// ---------- 概览 ----------
async function loadOverview() {
  const [s, p] = await Promise.all([api('/api/merchant/summary'), api('/api/merchant/payments?page_size=8')]);
  if (!s.ok) return toast(s.error || '加载失败');
  const k = s.kpis;
  $('overviewSub').textContent = `商户已启用 · ${merchant.name}`;
  $('kToday').textContent = cents(k.today_cents);
  $('kTodayNote').textContent = `${k.today_count} 笔`;
  $('kNet').textContent = cents(k.net_cents);
  $('kGrossNote').textContent = `累计收款 ${cents(k.gross_cents)} · 退款 ${cents(k.refunded_cents)}`;
  $('kAvailable').textContent = cents(k.balance.available_cents);
  $('kPending').textContent = cents(k.balance.pending_payout_cents);
  $('kPendingNote').textContent = '审核通过后出款';
  const rows = p.ok ? p.items : [];
  $('recentPayments').innerHTML = rows.length ? rows.map((x) => `<tr><td class="mono">${esc(x.id)}<div class="muted" style="font-size:11px">${esc(x.reference)}</div></td><td>${badge(PAY_STATUS, x.status)}</td><td class="num">${cents(x.amount_cents)}</td><td class="hide-s">${fmtTime(x.created_at)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">还没有支付单，去「API 文档」创建第一笔。</td></tr>';
}

// ---------- 支付单 ----------
async function loadPayments(page) {
  paymentsPage = page;
  const status = $('payStatus').value;
  const qs = new URLSearchParams({ page, page_size: 20 });
  if (status) qs.set('status', status);
  const r = await api('/api/merchant/payments?' + qs);
  if (!r.ok) { $('paymentsBody').innerHTML = `<tr><td colspan="7" class="empty">${esc(r.error || '加载失败')}</td></tr>`; return; }
  const pages = Math.max(1, Math.ceil(r.filtered_total / r.page_size));
  $('paymentsBody').innerHTML = r.items.length ? r.items.map((x) => `<tr>
    <td class="mono">${esc(x.id)}</td><td class="mono">${esc(x.reference)}</td><td>${badge(PAY_STATUS, x.status)}</td>
    <td class="num">${cents(x.amount_cents)}</td><td class="num">${x.refunded_cents ? cents(x.refunded_cents) : '—'}</td>
    <td class="hide-s">${fmtTime(x.created_at)}</td><td><button class="btn sm ghost" data-pay="${x.numeric_id}">详情</button></td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">没有符合条件的支付单。</td></tr>';
  $('payPageInfo').textContent = `第 ${r.items.length ? (page - 1) * r.page_size + 1 : 0}–${Math.min(r.filtered_total, page * r.page_size)} 条，共 ${r.filtered_total} 条`;
  $('payPrev').disabled = page <= 1;
  $('payNext').disabled = page >= pages;
  $('paymentsBody').querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', () => openPayment(Number(b.dataset.pay))));
  if (r.balance) { $('pBalance') && ($('pBalance').textContent = cents(r.balance.available_cents)); }
}
$('payPrev').addEventListener('click', () => loadPayments(Math.max(1, paymentsPage - 1)));
$('payNext').addEventListener('click', () => loadPayments(paymentsPage + 1));
$('payStatus').addEventListener('change', () => loadPayments(1));

async function openPayment(id) {
  const r = await api('/api/merchant/payments/' + id);
  if (!r.ok) return toast(r.error || '加载失败');
  const p = r.payment;
  detailPayment = p;
  const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
  $('payDetailBody').innerHTML = row('支付单', `<span class="mono">${esc(p.id)}</span>`)
    + row('订单号', esc(p.reference)) + row('状态', badge(PAY_STATUS, p.status))
    + row('金额', `<b>${cents(p.amount_cents)}</b>`) + row('已退款', cents(p.refunded_cents))
    + row('可退', cents(p.refundable_cents)) + row('说明', esc(p.description || '—'))
    + row('付款人', esc(r.payer_email || p.customer_email || '—'))
    + row('创建时间', fmtTime(p.created_at)) + (p.paid_at ? row('付款时间', fmtTime(p.paid_at)) : '')
    + (r.refunds && r.refunds.length ? row('退款记录', r.refunds.map((x) => `${cents(x.amount_cents)}（${esc(x.reason || '')}）`).join('<br>')) : '');
  const canRefund = p.refundable_cents > 0 && ['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(p.status) && (me.permissions || []).includes('merchant.refund');
  $('refundBox').hidden = !canRefund;
  $('rfAmount').value = (p.refundable_cents / 100).toFixed(2);
  $('rfReason').value = '';
  msg('rfMsg', '');
  openModal('payDetailModal');
}

$('rfSubmit').addEventListener('click', async () => {
  if (!detailPayment) return;
  const reason = $('rfReason').value.trim();
  if (reason.length < 2) return msg('rfMsg', '请填写退款原因', true);
  $('rfSubmit').disabled = true;
  const r = await postWithConfirm(`/api/merchant/payments/${detailPayment.numeric_id}/refunds`, { amount: $('rfAmount').value.trim(), reason }, newKey());
  $('rfSubmit').disabled = false;
  if (!r.ok) return msg('rfMsg', r.error || '退款失败', true);
  toast(r.message || '已退款');
  closeModal('payDetailModal');
  loadPayments(paymentsPage);
});

// ---------- 结算 ----------
async function loadPayouts() {
  const r = await api('/api/merchant/payouts');
  if (!r.ok) return toast(r.error || '加载失败');
  $('pBalance').textContent = cents(r.balance.available_cents);
  $('pPending').textContent = cents(r.balance.pending_payout_cents);
  $('payoutsBody').innerHTML = r.items.length ? r.items.map((x) => `<tr><td class="mono">${esc(x.id)}</td><td>${badge(PO_STATUS, x.status)}</td><td class="num">${cents(x.amount_cents)}</td><td class="hide-s">${fmtTime(x.created_at)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">还没有结算记录。</td></tr>';
  msg('poMsg', '');
}
$('poSubmit').addEventListener('click', async () => {
  const amount = $('poAmount').value.trim();
  if (!amount) return msg('poMsg', '请输入金额', true);
  $('poSubmit').disabled = true;
  const r = await postWithConfirm('/api/merchant/payouts', { amount, destination: $('poDest').value.trim() }, newKey());
  $('poSubmit').disabled = false;
  if (!r.ok) return msg('poMsg', r.error || '提交失败', true);
  msg('poMsg', r.message || '已提交');
  $('poAmount').value = '';
  loadPayouts();
});

// ---------- API 密钥 ----------
async function loadKeys() {
  const r = await api('/api/merchant/keys');
  if (!r.ok) return toast(r.error || '加载失败');
  $('keysBody').innerHTML = r.items.length ? r.items.map((k) => `<tr>
    <td class="mono">${esc(k.masked)}</td><td>${esc(k.mode)}</td><td>${esc(k.label || '—')}</td>
    <td class="hide-s">${k.last_used_at ? fmtTime(k.last_used_at) : '—'}</td>
    <td>${k.revoked_at ? badge({ X: ['已吊销', 'danger'] }, 'X') : badge({ X: ['有效', 'success'] }, 'X')}</td>
    <td>${k.revoked_at ? '' : `<button class="btn sm danger" data-revoke="${k.id}">吊销</button>`}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">还没有密钥。点击右上角创建。</td></tr>';
  $('keysBody').querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('吊销后使用该密钥的请求会立即失败，确定继续？')) return;
    const x = await api('/api/merchant/keys/' + b.dataset.revoke + '/revoke', { method: 'POST', body: {} });
    toast(x.ok ? '已吊销' : (x.error || '操作失败'));
    loadKeys();
  }));
}
$('keyCreate').addEventListener('click', () => { $('newKeyLabel').value = ''; msg('newKeyMsg', ''); openModal('createKeyModal'); });
$('newKeyOk').addEventListener('click', async () => {
  $('newKeyOk').disabled = true;
  const r = await api('/api/merchant/keys', { method: 'POST', body: { label: $('newKeyLabel').value.trim(), mode: $('newKeyMode').value } });
  $('newKeyOk').disabled = false;
  if (!r.ok) return msg('newKeyMsg', r.error || '创建失败', true);
  closeModal('createKeyModal');
  $('newKeyToken').textContent = r.key.token;
  $('newKeyCopy').dataset.copy = r.key.token;
  openModal('tokenModal');
  loadKeys();
});

// ---------- Webhook ----------
async function loadWebhooks() {
  const [p, d] = await Promise.all([api('/api/merchant/profile'), api('/api/merchant/webhook-deliveries')]);
  if (p.ok) $('whUrl').value = p.merchant.webhook_url || '';
  $('deliveriesBody').innerHTML = d.ok && d.items.length ? d.items.map((x) => `<tr>
    <td>${esc(x.event_type)}</td><td>${badge(WH_STATUS, x.status)}</td><td class="num">${x.attempts}</td>
    <td class="mono">${x.last_status_code || x.last_error || '—'}</td><td class="hide-s">${fmtTime(x.created_at)}</td>
    <td>${x.status !== 'DELIVERED' ? `<button class="btn sm ghost" data-retry="${x.id}">重投</button>` : ''}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">还没有投递记录。</td></tr>';
  $('deliveriesBody').querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
    const x = await api('/api/merchant/webhook-deliveries/' + b.dataset.retry + '/retry', { method: 'POST', body: {} });
    toast(x.ok ? '已重新投递' : (x.error || '操作失败'));
    loadWebhooks();
  }));
  msg('whMsg', '');
}
$('whSave').addEventListener('click', async () => {
  const url = $('whUrl').value.trim();
  $('whSave').disabled = true;
  const r = await api('/api/merchant/profile', { method: 'PATCH', body: { webhook_url: url } });
  $('whSave').disabled = false;
  msg('whMsg', r.ok ? '已保存' : (r.error || '保存失败'), !r.ok);
  if (r.ok) toast('Webhook 地址已保存');
});
$('whRotate').addEventListener('click', async () => {
  if (!confirm('重置后旧签名密钥立即失效，你的服务端需要同步更新。继续？')) return;
  const r = await api('/api/merchant/webhook-secret', { method: 'POST', body: {} });
  if (!r.ok) return msg('whMsg', r.error || '操作失败', true);
  $('whSecret').textContent = r.webhook_secret;
  $('whSecretCopy').dataset.copy = r.webhook_secret;
  $('whSecretBox').hidden = false;
  msg('whMsg', '密钥已重置');
});

// ---------- 资料 ----------
async function loadProfile() {
  const r = await api('/api/merchant/profile');
  if (!r.ok) return toast(r.error || '加载失败');
  $('pfName').value = r.merchant.name;
  $('pfWebsite').value = r.merchant.website || '';
  $('pfDesc').value = r.merchant.description || '';
  msg('pfMsg', '');
}
$('pfSave').addEventListener('click', async () => {
  $('pfSave').disabled = true;
  const r = await api('/api/merchant/profile', { method: 'PATCH', body: { name: $('pfName').value.trim(), website: $('pfWebsite').value.trim(), description: $('pfDesc').value.trim() } });
  $('pfSave').disabled = false;
  msg('pfMsg', r.ok ? '已保存' : (r.error || '保存失败'), !r.ok);
  if (r.ok) { merchant.name = r.merchant.name; $('merchantName').textContent = merchant.name; toast('资料已更新'); }
});

boot().catch((e) => { console.error(e); gate('加载失败', '请刷新页面重试。', ''); });
window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if ($('app').hidden === false && ['overview', 'payments', 'payouts', 'keys', 'webhooks', 'profile'].includes(v)) showView(v);
});
