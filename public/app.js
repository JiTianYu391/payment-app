// v2 前端：首页 / 投资 / 钱包 / 流水 / 设置；全部金额为模拟虚拟资金
let token = localStorage.getItem('pay_token') || '';
let me = null;
let products = [];
let simDay = 0;
let currentRange = '1M';
let privacy = false;
let curProduct = null, curSide = 'BUY', curPreview = null;
let perfData = null;
const $ = (id) => document.getElementById(id);
const headers = () => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) });
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: headers() });
  const j = await r.json().catch(() => ({ ok: false, error: '网络错误' }));
  if (!r.ok && r.status === 401) logoutLocal();
  return { status: r.status, ...j };
}
function msg(id, text, isErr) { const el = $(id); if (!el) return; el.textContent = text || ''; el.className = 'msg' + (isErr ? ' err' : ''); }
function showTab(t) { $('tabLogin').classList.toggle('active', t === 'login'); $('tabRegister').classList.toggle('active', t === 'register'); $('loginPane').hidden = t !== 'login'; $('registerPane').hidden = t !== 'register'; }
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }
function logoutLocal() { token = ''; localStorage.removeItem('pay_token'); me = null; $('appCard') && ($('appCard').hidden = true); document.querySelectorAll('.view').forEach((v) => (v.hidden = true)); $('authCard').hidden = false; $('topUser').textContent = ''; }
function fmt(c) { return '$' + (Math.abs(c) / 100).toFixed(2); }
function fmtSigned(c) { if (!c) return '$0.00'; return (c > 0 ? '+' : '−') + fmt(c); }
function chgHtml(pct, cents) {
  const arrow = pct > 0.05 || (cents !== undefined && cents > 0) ? '▲' : pct < -0.05 || (cents !== undefined && cents < 0) ? '▼' : '—';
  const cls = (pct > 0.05 || (cents !== undefined && cents > 0)) ? 'up' : (pct < -0.05 || (cents !== undefined && cents < 0)) ? 'down' : '';
  const sign = pct > 0 ? '+' : '';
  return `<span class="${cls}">${arrow} ${sign}${pct.toFixed(2)}%</span>`;
}
function fmtTime(ts) { return new Date(ts).toLocaleString('zh-CN'); }
function moneyOrHidden(c) { return privacy ? '****' : fmt(c); }
const TYPE_LABEL = { bonus: '体验金', topup: '充值', transfer_in: '转入', transfer_out: '转出', pay: '付款', BUY: '买入', SELL: '卖出', DIVIDEND: '分红', INTEREST: '利息' };

// ---------- 视图切换 ----------
function showView(v) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => (s.hidden = s.id !== 'view-' + v));
  if (!me) return;
  if (v === 'home') { loadHome(); }
  if (v === 'invest') { loadInvest(); }
  if (v === 'wallet') { loadWallet(); loadStats(); loadIncome(); loadTx(); }
  if (v === 'activity') { loadOrders(); loadActivityTx(); }
  if (v === 'settings') { loadAudit(); }
}
function togglePrivacy() { privacy = !privacy; $('privacyBtn').textContent = privacy ? '显示金额' : '隐藏金额'; loadHome(); loadWallet(); }

// ---------- 认证（v1 流程保留） ----------
async function requestCode() {
  const email = $('regEmail').value.trim(); if (!email) return msg('authMsg', '请先填邮箱', true);
  const j = await api('/api/auth/request-code', { method: 'POST', body: JSON.stringify({ email, purpose: 'register' }) });
  msg('authMsg', j.ok ? j.message + '（演示模式请点“查看演示收件箱”）' : j.error, !j.ok);
  if (j.ok) showDemoInbox();
}
async function showDemoInbox() {
  const email = $('regEmail').value.trim(); if (!email) return msg('authMsg', '请先填邮箱', true);
  const r = await fetch('/api/demo-inbox?email=' + encodeURIComponent(email)); const j = await r.json();
  const box = $('demoInbox'); box.hidden = false;
  if (!j.ok) { box.innerHTML = '获取失败：' + (j.error || ''); return; }
  box.innerHTML = '<b>演示邮箱收件箱（仅演示，不发真实邮件）</b><br>' + j.notice + '<br>' + (j.items.length ? j.items.map((x) => `验证码 <b>${x.code}</b> · ${x.purpose} · ${fmtTime(x.created_at)}`).join('<br>') : '暂无验证码，请先点“获取验证码”');
}
async function doRegister() {
  const body = { email: $('regEmail').value.trim(), nickname: $('regNickname').value.trim(), password: $('regPassword').value, code: $('regCode').value.trim() };
  const j = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(body) });
  msg('authMsg', j.ok ? j.message : j.error, !j.ok);
  if (j.ok) { showTab('login'); $('loginEmail').value = body.email; }
}
async function doLogin() {
  const j = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: $('loginEmail').value.trim(), password: $('loginPassword').value }) });
  if (!j.ok) return msg('authMsg', j.error, true);
  token = j.token; localStorage.setItem('pay_token', token); me = j.user; msg('authMsg', '登录成功');
  $('authCard').hidden = true; $('topUser').textContent = me.nickname + ' · ' + me.email;
  if (!me.has_pin) alert('提示：请先在安全中心设置 6 位支付 PIN，转账 / 付款 / 下单都需要验证 PIN。');
  showView('home'); await refreshAll();
}
async function doLogout() { await api('/api/auth/logout', { method: 'POST' }); logoutLocal(); }
async function refreshAll() { await loadHome(); await loadInvest(); await loadWallet(); await loadStats(); await loadTx(); await loadAudit(); }

// ---------- 图表（手绘 canvas，无外部依赖） ----------
function drawLine(canvas, series, bench) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!series || series.length < 2) { ctx.fillStyle = '#5B6B7C'; ctx.font = '14px sans-serif'; ctx.fillText('暂无足够历史数据（新用户从今天开始积累）', 16, H / 2); return; }
  const vals = series.map((s) => s.total_cents);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max === min) { max += 100; min -= 100; }
  const padL = 64, padR = 14, padT = 14, padB = 26;
  const X = (i) => padL + ((W - padL - padR) * i) / (series.length - 1);
  const Y = (v) => padT + ((H - padT - padB) * (max - v)) / (max - min);
  ctx.strokeStyle = '#E3E8EE'; ctx.fillStyle = '#5B6B7C'; ctx.font = '12px sans-serif';
  for (let g = 0; g <= 3; g++) {
    const v = min + ((max - min) * g) / 3, y = Y(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(fmt(v), 6, y + 4);
  }
  const first = series[0].day, last = series[series.length - 1].day;
  ctx.fillText('day-' + first, padL, H - 8); ctx.fillText('day-' + last, W - 70, H - 8);
  // 基准（灰色虚线，归一化到起点）
  if (bench && bench.length === series.length) {
    const b0 = bench[0].indexed || 100;
    const base = series[0].total_cents;
    ctx.strokeStyle = '#9AA7B5'; ctx.setLineDash([5, 4]); ctx.beginPath();
    bench.forEach((b, i) => { const v = base * ((b.indexed || 100) / b0); const x = X(i), y = Y(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle = '#0B2A4A'; ctx.lineWidth = 2; ctx.beginPath();
  series.forEach((s, i) => { const x = X(i), y = Y(s.total_cents); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke(); ctx.lineWidth = 1;
  const lastPt = series[series.length - 1];
  ctx.fillStyle = '#0B2A4A'; ctx.beginPath(); ctx.arc(X(series.length - 1), Y(lastPt.total_cents), 4, 0, 7); ctx.fill();
  ctx.fillText('总资产 ' + fmt(lastPt.total_cents), Math.max(padL, X(series.length - 1) - 110), Y(lastPt.total_cents) - 10);
}
function drawDonut(canvas, alloc) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const total = alloc.reduce((s, a) => s + a.amount_cents, 0);
  const colors = ['#0B2A4A', '#1B5FAA', '#2E9E6B', '#E8B84B', '#7A5A9E', '#5B6B7C'];
  if (!total) { ctx.fillStyle = '#5B6B7C'; ctx.font = '14px sans-serif'; ctx.fillText('暂无资产', W / 2 - 30, H / 2); return; }
  let start = -Math.PI / 2;
  alloc.forEach((a, i) => {
    const frac = a.amount_cents / total;
    ctx.beginPath(); ctx.moveTo(W / 2, H / 2);
    ctx.arc(W / 2, H / 2, 96, start, start + frac * Math.PI * 2);
    ctx.closePath(); ctx.fillStyle = colors[i % colors.length]; ctx.fill();
    start += frac * Math.PI * 2;
  });
  ctx.beginPath(); ctx.arc(W / 2, H / 2, 58, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
}
function drawSpark(canvas, values) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!values || values.length < 2) return;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max === min ? 1 : max - min;
  const up = values[values.length - 1] >= values[0];
  ctx.strokeStyle = up ? '#0B7A45' : '#B42318'; ctx.lineWidth = 1.5; ctx.beginPath();
  values.forEach((v, i) => {
    const x = (W * i) / (values.length - 1), y = 3 + ((H - 6) * (max - v)) / span;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke(); ctx.lineWidth = 1;
}
const DONUT_COLORS = ['#0B2A4A', '#1B5FAA', '#2E9E6B', '#E8B84B', '#7A5A9E', '#5B6B7C'];

// ---------- 首页 ----------
async function loadHome() {
  const [pf, perf] = await Promise.all([api('/api/portfolio'), api('/api/performance?range=' + currentRange)]);
  if (!pf.ok) return;
  simDay = pf.simulated_day;
  $('simDay').textContent = '模拟日 day-' + simDay;
  $('sideDay').textContent = 'day-' + simDay;
  $('totalAssets').textContent = privacy ? '****' : fmt(pf.total_cents);
  $('donutTotal').textContent = privacy ? '****' : fmt(pf.total_cents);
  const tp = pf.today_pl_cents;
  $('todayPl').className = 'capsule ' + (tp > 0 ? 'up' : tp < 0 ? 'down' : 'muted');
  $('todayPl').textContent = '今日盈亏 ' + (tp > 0 ? '▲ +' : tp < 0 ? '▼ −' : '') + (privacy ? '****' : fmt(Math.abs(tp)));
  const sr = perf.ok ? perf.simple_return_pct : null;
  $('totalReturn').className = 'capsule ' + (sr > 0 ? 'up' : sr < 0 ? 'down' : 'muted');
  $('totalReturn').textContent = '累计简单回报 ' + (sr === null || sr === undefined ? '—' : (sr > 0 ? '▲ +' : sr < 0 ? '▼ −' : '') + Math.abs(sr).toFixed(2) + '%');
  $('asOf').textContent = pf.as_of + ' · 模拟价格';
  const cashPct = pf.total_cents ? (pf.cash_cents / pf.total_cents) * 100 : 0;
  const invPct = 100 - cashPct;
  $('splitBar').innerHTML = `<span style="width:${cashPct}%;background:#1B5FAA"></span><span style="width:${invPct}%;background:#0B2A4A"></span>`;
  $('splitLegend').innerHTML = `<span><i style="display:inline-block;width:10px;height:10px;background:#1B5FAA;border-radius:2px"></i> 现金 ${privacy ? '****' : fmt(pf.cash_cents)}（${cashPct.toFixed(1)}%）</span><span><i style="display:inline-block;width:10px;height:10px;background:#0B2A4A;border-radius:2px"></i> 投资 ${privacy ? '****' : fmt(pf.invested_cents)}（${invPct.toFixed(1)}%）</span>`;
  drawDonut($('donut'), pf.allocation);
  $('allocList').innerHTML = pf.allocation.map((a, i) => `<div class="alloc-row"><span><span class="swatch" style="background:${DONUT_COLORS[i % DONUT_COLORS.length]}"></span>${a.class_zh}</span><span><b>${privacy ? '****' : fmt(a.amount_cents)}</b> · ${a.pct_of_total.toFixed(1)}%</span></div>`).join('') || '暂无配置数据';
  $('topHoldings').innerHTML = pf.holdings_top.length ? pf.holdings_top.map((h) => `<div class="kv"><span>${h.name}</span><span>${privacy ? '****' : fmt(h.market_value_cents)} ${chgHtml(h.unrealized_pct)}</span></div>`).join('') : '暂无持仓，去投资页看看模拟产品。';
  if (perf.ok) {
    perfData = perf;
    drawLine($('perfChart'), perf.series, perf.benchmark);
    $('perfGrid').innerHTML = `
      <div class="perf-cell"><div class="label">TWR 时间加权回报</div><div class="val">${perf.twr_pct === null || perf.twr_pct === undefined ? '—' : (perf.twr_pct > 0 ? '▲ +' : perf.twr_pct < 0 ? '▼ −' : '') + Math.abs(perf.twr_pct).toFixed(2) + '%'}</div><div class="hint">衡量策略本身，适合与基准对比</div></div>
      <div class="perf-cell"><div class="label">MWR 货币加权回报（个人）</div><div class="val">${perf.mwr_pct === null || perf.mwr_pct === undefined ? '—' : (perf.mwr_pct > 0 ? '▲ +' : perf.mwr_pct < 0 ? '▼ −' : '') + Math.abs(perf.mwr_pct).toFixed(2) + '%'}</div><div class="hint">Modified Dietz，含追加资金时点影响</div></div>
      <div class="perf-cell"><div class="label">分红 / 利息收入</div><div class="val">${privacy ? '****' : fmt(perf.income.dividends_cents + perf.income.interest_cents)}</div><div class="hint">分红 ${privacy ? '****' : fmt(perf.income.dividends_cents)} · 利息 ${privacy ? '****' : fmt(perf.income.interest_cents)}</div></div>`;
    $('perfNote').textContent = '总资产曲线（含体验金/充值等资金进出，不等于投资回报）。TWR 与 MWR 口径不同：' + (perf.helm_example || '');
  }
  const tx = await api('/api/transactions?limit=5');
  if (tx.ok) $('homeRecent').innerHTML = tx.items.map((t) => `<div class="kv"><span>${fmtTime(t.created_at)} · ${TYPE_LABEL[t.type] || t.type} · ${t.description || t.merchant || ''}</span><span class="${t.amount_cents >= 0 ? 'up' : 'down'}">${t.amount_cents >= 0 ? '+' : '−'}${privacy ? '****' : fmt(Math.abs(t.amount_cents))}</span></div>`).join('') || '暂无动态';
}
function setRange(r) {
  currentRange = r;
  document.querySelectorAll('#rangeTabs button').forEach((b) => b.classList.toggle('active', b.dataset.r === r));
  loadHome();
}

// ---------- 投资页 ----------
async function loadInvest() {
  await loadProducts();
  await loadHoldings();
  await loadWatchlist();
  await loadAlerts();
  await loadRisk();
  await loadGoalsBox();
}
async function loadProducts() {
  const j = await api('/api/products');
  if (!j.ok) return;
  products = j.items; simDay = j.simulated_day;
  $('simDay').textContent = '模拟日 day-' + simDay;
  $('alertProduct').innerHTML = products.filter((p) => p.tradeable).map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  renderProducts();
}
function renderProducts() {
  const type = $('prodType').value, risk = $('prodRisk').value, q = ($('prodQ').value || '').trim();
  const list = products.filter((p) => (!type || p.type === type) && (!risk || p.risk === risk) && (!q || p.name.includes(q)));
  $('productGrid').innerHTML = list.map((p) => `
    <div class="prod-card">
      <h4>${p.name}<span class="sim-tag">模拟</span></h4>
      <div class="meta">${p.type_zh} · <span class="risk-badge r${p.risk.slice(1)}">${p.risk} ${p.risk_label}</span> ${p.watched ? '★ 已自选' : ''}</div>
      <div class="price num">${privacy ? '****' : fmt(p.price_cents)}</div>
      <div>${chgHtml(p.day_change_pct)}</div>
      <canvas class="spark" width="200" height="36" data-pid="${p.id}"></canvas>
      <p class="meta">${p.desc}</p>
      <div class="row">
        ${p.tradeable ? `<button class="btn primary" onclick="openProduct('${p.id}')">买入 / 卖出</button>` : `<button class="btn" disabled>基准（不可交易）</button>`}
        <button class="star ${p.watched ? 'on' : ''}" onclick="toggleWatch('${p.id}')" aria-label="自选">${p.watched ? '★' : '☆'}</button>
      </div>
    </div>`).join('') || '没有符合条件的产品';
  document.querySelectorAll('canvas.spark').forEach((c) => {
    const p = products.find((x) => x.id === c.dataset.pid);
    if (p) drawSpark(c, p.sparkline);
  });
}
async function loadHoldings() {
  const j = await api('/api/holdings');
  if (!j.ok) return;
  const total = j.items.reduce((s, h) => s + h.market_value_cents, 0);
  $('holdBody').innerHTML = j.items.map((h) => {
    const w = total ? (h.market_value_cents / total) * 100 : 0;
    return `<tr><td>${h.name}<br><span class="hint">${h.type} · ${h.risk}</span></td>
      <td class="num">${h.quantity.toFixed(3)}</td><td class="num">${fmt(h.avg_cost_cents)}</td><td class="num">${fmt(h.price_cents)}</td>
      <td class="num">${privacy ? '****' : fmt(h.market_value_cents)}</td>
      <td class="${h.unrealized_pl_cents >= 0 ? 'up' : 'down'}">${h.unrealized_pl_cents >= 0 ? '▲ +' : '▼ −'}${privacy ? '****' : fmt(Math.abs(h.unrealized_pl_cents))}<br><span class="hint">${chgHtml(h.unrealized_pct)}</span></td>
      <td class="num">${w.toFixed(1)}%</td>
      <td><canvas class="spark" width="90" height="28" data-h="${h.product_id}"></canvas></td>
      <td><button class="btn" onclick="openProduct('${h.product_id}','SELL')">卖出</button></td></tr>`;
  }).join('') || '<tr><td colspan="9">暂无持仓 — 去产品市场看看模拟产品。</td></tr>';
  document.querySelectorAll('canvas.spark[data-h]').forEach((c) => {
    const h = j.items.find((x) => x.product_id === c.dataset.h);
    if (h) drawSpark(c, h.sparkline);
  });
  $('realizedLine').textContent = `已实现盈亏（累计卖出）：${j.realized_pl_cents >= 0 ? '▲ +' : '▼ −'}${fmt(Math.abs(j.realized_pl_cents))}（按 FIFO 批次核算，与未实现盈亏分开列示）`;
  $('fdBox').innerHTML = j.fixed_deposits.length ? '<h4>定存单</h4>' + j.fixed_deposits.map((fd) => {
    const p = products.find((x) => x.id === fd.product_id) || { name: fd.product_id };
    return `<div class="kv"><span>${p.name} · 本金 ${fmt(fd.principal_cents)} · 年化 ${(fd.rate_bps / 100).toFixed(2)}% · ${fd.status === 'ACTIVE' ? '到期 day-' + fd.maturity_day : fd.status}</span><span>${fd.status === 'ACTIVE' ? `<button class="btn" onclick="breakFd(${fd.id})">提前支取</button>` : fd.status}</span></div>`;
  }).join('') : '';
}
async function breakFd(id) {
  const pin = prompt('提前支取需要验证支付 PIN，请输入 6 位 PIN：');
  if (!pin) return;
  const j = await api('/api/fixed-deposits/' + id + '/break', { method: 'POST', body: JSON.stringify({ pin }) });
  alert(j.ok ? j.message + `（本金 ${fmt(j.principal_cents)} + 利息 ${fmt(j.interest_cents)}）` : j.error);
  if (j.ok) loadInvest();
}
async function loadWatchlist() {
  const j = await api('/api/watchlist');
  if (!j.ok) return;
  $('watchBox').innerHTML = j.items.length ? j.items.map((w) => `<div class="kv"><span>★ ${w.name} · ${w.type} · ${w.risk}</span><span>${fmt(w.price_cents)} ${chgHtml(w.day_change_pct)}</span></div>`).join('') : '暂无自选，点产品卡上的 ☆ 加入。';
}
async function toggleWatch(id) {
  const j = await api('/api/watchlist', { method: 'POST', body: JSON.stringify({ product_id: id }) });
  if (j.ok) { await loadProducts(); await loadWatchlist(); }
}
async function loadAlerts() {
  const j = await api('/api/alerts');
  if (!j.ok) return;
  $('alertBox').innerHTML = j.items.length ? j.items.map((a) => `<div class="kv"><span>${a.name} · ${a.condition === 'ABOVE' ? '高于' : a.condition === 'BELOW' ? '低于' : '日涨跌幅超过'} ${a.condition === 'DAY_CHANGE' ? (a.threshold_cents / 100).toFixed(2) + '%' : fmt(a.threshold_cents)} · ${a.mode === 'ONCE' ? '一次' : '每次'} · ${a.status === 'ACTIVE' ? '生效中' : a.status === 'FIRED' ? '已触发' : a.status}</span><span><button class="btn" onclick="delAlert(${a.id})">删除</button></span></div>`).join('') : '暂无提醒。';
}
async function addAlert() {
  const cond = $('alertCond').value;
  const body = { product_id: $('alertProduct').value, condition: cond, mode: $('alertMode').value };
  const v = parseFloat($('alertThreshold').value);
  if (cond === 'DAY_CHANGE') body.threshold_pct = v; else body.threshold_price = v;
  const j = await api('/api/alerts', { method: 'POST', body: JSON.stringify(body) });
  alert(j.ok ? j.message : j.error);
  if (j.ok) loadAlerts();
}
async function delAlert(id) { await api('/api/alerts/' + id, { method: 'DELETE' }); loadAlerts(); }

// ---------- 下单：详情 → 预览 → 复核(PIN) → 回单 ----------
function openProduct(id, side) {
  const p = products.find((x) => x.id === id);
  if (!p) return;
  curProduct = p; curSide = side || 'BUY'; curPreview = null;
  $('pmName').textContent = p.name + '（模拟）';
  $('pmMeta').textContent = `${p.type_zh} · ${p.risk} ${p.risk_label} · 现价 ${fmt(p.price_cents)} · 日涨跌 ${chgHtml(p.day_change_pct)} · 模拟日 day-${simDay}`;
  $('pmInfo').innerHTML = `<p class="hint">${p.desc}</p><p class="hint">${p.type === 'FIXED_DEPOSIT' ? '定存：按金额申购，年化 ' + (p.rate_bps / 100).toFixed(2) + '%，' + p.term_days + ' 个模拟日后到期；提前支取按已存天数计息。' : '模拟漂移/波动率（年化）：μ=' + (p.mu * 100).toFixed(1) + '%，σ=' + (p.sigma * 100).toFixed(1) + '%。分红率 ' + (p.dividend_yield * 100).toFixed(1) + '%/年。'}</p>`;
  setSide(curSide);
  $('pmAmount').value = ''; $('pmQty').value = ''; $('pmQuote').textContent = '输入金额或数量后点“预览订单”。'; msg('pmMsg', '');
  api('/api/products/' + id + '?range=1M').then((j) => {
    if (j.ok) drawLine($('pmChart'), j.history.map((h) => ({ day: h.day, total_cents: h.price_cents })), null);
  });
  openModal('productModal');
}
function setSide(s) {
  curSide = s;
  $('pmBuyBtn').className = 'btn ' + (s === 'BUY' ? 'primary' : '');
  $('pmSellBtn').className = 'btn ' + (s === 'SELL' ? 'primary' : '');
}
async function previewOrder() {
  const body = { product_id: curProduct.id, side: curSide };
  const amt = parseFloat($('pmAmount').value);
  const qty = parseFloat($('pmQty').value);
  if (Number.isFinite(amt) && amt > 0) body.amount = amt;
  else if (Number.isFinite(qty) && qty > 0) body.quantity = qty;
  else return msg('pmMsg', '请先输入金额或数量', true);
  const j = await api('/api/orders/preview', { method: 'POST', body: JSON.stringify(body) });
  if (!j.ok) return msg('pmMsg', j.error, true);
  curPreview = { ...j, idempotency_key: crypto.randomUUID() };
  $('pmQuote').innerHTML = `预估：${j.quantity} 份 @ ${fmt(j.price_cents)}，总额 <b>${fmt(j.total_cents)}</b>，手续费 $0.00，成交后现金 ${fmt(j.cash_after_cents)}。${j.shortfall_cents ? '<b style="color:#B42318">余额不足：还差 ' + fmt(j.shortfall_cents) + '</b>' : ''}${j.risk_warning ? '<br><b>风险提示：</b>' + j.risk_warning : ''}`;
  $('reviewBody').innerHTML = `
    <table class="review-table">
      <tr><td>产品</td><td>${j.name}（模拟）</td></tr>
      <tr><td>方向</td><td>${j.side === 'BUY' ? '买入' : '卖出'}</td></tr>
      <tr><td>数量</td><td>${j.quantity} 份</td></tr>
      <tr><td>成交价（模拟日 day-${j.simulated_day}）</td><td>${fmt(j.price_cents)}</td></tr>
      <tr><td>总额</td><td>${fmt(j.total_cents)}</td></tr>
      <tr><td>手续费</td><td>$0.00</td></tr>
      <tr><td>成交后现金</td><td>${fmt(j.cash_after_cents)}</td></tr>
    </table>
    ${j.shortfall_cents ? '<p class="msg err">余额不足：还差 ' + fmt(j.shortfall_cents) + '，请先演示充值或减少数量。</p>' : ''}
    ${j.risk_warning ? '<p class="hint">风险提示：' + j.risk_warning + '</p>' : ''}`;
  $('confirmOrderBtn').textContent = '确认' + (j.side === 'BUY' ? '买入' : '卖出') + ' — ' + fmt(j.total_cents);
  $('reviewPin').value = ''; msg('reviewMsg', '');
  closeModal('productModal'); openModal('reviewModal');
}
async function confirmOrder() {
  if (!curPreview) return;
  const btn = $('confirmOrderBtn');
  btn.disabled = true;
  const pin = $('reviewPin').value.trim();
  const j = await api('/api/orders', {
    method: 'POST',
    body: JSON.stringify({ product_id: curPreview.product_id, side: curPreview.side, quantity_milli: curPreview.quantity_milli, pin, idempotency_key: curPreview.idempotency_key }),
  });
  btn.disabled = false;
  if (!j.ok) return msg('reviewMsg', j.error, true);
  $('receiptBody').innerHTML = `
    <table class="review-table">
      <tr><td>订单号</td><td>#${j.order_id}${j.duplicate ? '（重复提交，已去重）' : ''}</td></tr>
      <tr><td>产品</td><td>${j.name}（模拟）</td></tr>
      <tr><td>方向 / 数量</td><td>${j.side === 'BUY' ? '买入' : '卖出'} ${j.quantity} 份</td></tr>
      <tr><td>成交价</td><td>${fmt(j.price_cents)}</td></tr>
      <tr><td>总额</td><td>${fmt(j.total_cents)}</td></tr>
      <tr><td>手续费</td><td>$0.00</td></tr>
      ${j.side === 'SELL' ? `<tr><td>已实现盈亏</td><td>${j.realized_pl_cents >= 0 ? '▲ +' : '▼ −'}${fmt(Math.abs(j.realized_pl_cents))}</td></tr>` : ''}
      <tr><td>成交后现金</td><td>${fmt(j.cash_after_cents)}</td></tr>
    </table><p class="hint">${j.receipt_note || ''}回单可在“流水 → 订单记录”查看。</p>`;
  closeModal('reviewModal'); openModal('receiptModal');
}

// ---------- 风险测评 / 目标 / 再平衡 ----------
async function openRiskQuiz() {
  const j = await api('/api/risk-quiz');
  if (!j.ok) return alert(j.error);
  $('quizBox').innerHTML = j.questions.map((q, i) => `<div><b>${i + 1}. ${q.q}</b><br>${q.options.map((o, k) => `<label style="display:inline-block;margin:4px 8px 4px 0"><input type="radio" name="q${i}" value="${k}" style="width:auto"> ${o}</label>`).join('')}</div>`).join('');
  $('quizResult').innerHTML = '';
  openModal('riskModal');
}
async function submitQuiz() {
  const answers = [];
  for (let i = 0; i < 5; i++) {
    const sel = document.querySelector(`input[name="q${i}"]:checked`);
    if (!sel) return alert('请回答第 ' + (i + 1) + ' 题');
    answers.push(parseInt(sel.value, 10));
  }
  const j = await api('/api/risk-quiz', { method: 'POST', body: JSON.stringify({ answers }) });
  if (!j.ok) return alert(j.error);
  $('quizResult').innerHTML = `<p>测评结果：<b>${j.level_zh}（${j.level}）</b>，得分 ${j.score}/20，可买产品风险上限 ${j.max_risk}。</p>
    <p>建议配置（示例，非投资建议）：${Object.entries(j.suggested).map(([k, v]) => k + ' ' + v + '%').join(' · ')}</p>
    <p class="hint">已按测评结果保存目标配置；如需调整，可在再平衡预览中修改。</p>`;
  loadRisk();
}
async function loadRisk() {
  const j = await api('/api/risk');
  if (!j.ok) return;
  $('riskLine').textContent = j.level ? `您的风险等级：${j.level_zh}（${j.level}），得分 ${j.score}/20，可买产品风险上限 ${j.max_risk}。目标配置：${j.target ? Object.entries(j.target).map(([k, v]) => k + ' ' + v + '%').join(' · ') : '未设置'}` : '尚未完成风险测评（教育自测，非适当性评估）。';
}
async function loadGoalsBox() {
  const j = await api('/api/goals');
  if (!j.ok) return;
  $('goalsBox').innerHTML = j.items.length ? j.items.map((g) => `<div class="kv"><span>${g.name} · 目标 ${fmt(g.target_cents)}${g.target_date ? ' · ' + g.target_date : ''}</span><span>${g.progress_pct.toFixed(1)}%（当前总资产 ${fmt(g.current_cents)}）</span></div>`).join('') : '<p class="hint">暂无目标。目标进度按当前总资产/目标金额计算，达成时间测算仅为教学演示。</p>';
}
async function openGoals() {
  await loadGoalsBox();
  $('goalsList').innerHTML = $('goalsBox').innerHTML;
  openModal('goalsModal');
}
async function addGoal() {
  const j = await api('/api/goals', { method: 'POST', body: JSON.stringify({ name: $('goalName').value.trim(), target_amount: parseFloat($('goalAmount').value), target_date: $('goalDate').value }) });
  msg('goalMsg', j.ok ? '目标已创建' : j.error, !j.ok);
  if (j.ok) { await loadGoalsBox(); $('goalsList').innerHTML = $('goalsBox').innerHTML; }
}
async function openRebalance() {
  const j = await api('/api/rebalance/preview');
  if (!j.ok) { $('rebalanceBody').innerHTML = '<p class="msg err">' + j.error + '（请先完成风险测评）</p>'; }
  else {
    $('rebalanceBody').innerHTML = `<p class="hint">${j.rule}</p>
      <table class="table"><thead><tr><th>类别</th><th>目标</th><th>当前</th><th>偏离</th><th>区间</th><th>状态</th></tr></thead><tbody>
      ${j.items.map((i) => `<tr><td>${i.class_zh}</td><td>${i.target_pct}%</td><td>${i.current_pct.toFixed(1)}%</td><td>${i.drift_pct >= 0 ? '+' : ''}${i.drift_pct.toFixed(1)}pp</td><td>±${i.band_pp.toFixed(2)}pp</td><td>${i.breached ? '<b style="color:#B42318">超出区间</b>' : '区间内'}</td></tr>`).join('')}
      </tbody></table>
      <h4>建议交易</h4>
      ${j.suggestions.length ? j.suggestions.map((s) => `<div class="kv"><span>${s.side === 'BUY' ? '买入' : '卖出'} ${s.name}</span><span>${fmt(s.amount_cents)}</span></div>`).join('') : '当前配置均在区间内，无需交易。'}`;
  }
  msg('rebMsg', '');
  openModal('rebalanceModal');
}
async function executeRebalance() {
  const btn = $('rebExecBtn'); btn.disabled = true;
  const j = await api('/api/rebalance/execute', { method: 'POST', body: JSON.stringify({ pin: $('rebPin').value.trim() }) });
  btn.disabled = false;
  if (!j.ok) return msg('rebMsg', j.error, true);
  msg('rebMsg', j.message + '：' + j.results.map((r) => r.skipped ? `${r.class} 跳过（${r.reason}）` : `${r.side === 'BUY' ? '买入' : '卖出'} ${r.name} ${fmt(r.amount_cents)}`).join('；'));
  loadInvest();
}

// ---------- 钱包（v1 流程保留） ----------
async function loadWallet() { const j = await api('/api/wallet'); if (j.ok) { $('balanceAmount').textContent = privacy ? '****' : fmt(j.balance_cents); } }
async function loadStats() {
  const j = await api('/api/stats'); if (!j.ok) return;
  $('statsBox').innerHTML = `收入 <b style="color:#0B7A45">${privacy ? '****' : fmt(j.income_cents)}</b> &nbsp; 支出 <b style="color:#B42318">${privacy ? '****' : fmt(j.expense_cents)}</b><br>` + Object.entries(j.by_category).map(([k, v]) => `${k}：${privacy ? '****' : fmt(v)}`).join(' · ');
}
async function loadIncome() {
  const j = await api('/api/performance?range=ALL');
  if (!j.ok) return;
  $('incomeBox').innerHTML = `分红累计 <b>${privacy ? '****' : fmt(j.income.dividends_cents)}</b> · 利息累计 <b>${privacy ? '****' : fmt(j.income.interest_cents)}</b><br><span class="hint">${j.income.note}</span>`;
}
async function loadTx() {
  const type = $('fType').value, q = $('fQ').value.trim();
  const qs = new URLSearchParams(); if (type) qs.set('type', type); if (q) qs.set('q', q);
  const j = await api('/api/transactions?' + qs.toString()); if (!j.ok) return;
  $('txBody').innerHTML = j.items.map((t) => `<tr><td>${fmtTime(t.created_at)}</td><td>${TYPE_LABEL[t.type] || t.type}</td><td>${t.merchant || t.counterparty_email || t.category || ''}<br><span class="hint">${t.description || ''}</span></td><td class="${t.amount_cents >= 0 ? 'up' : 'down'}">${t.amount_cents >= 0 ? '+' : '−'}${privacy ? '****' : fmt(Math.abs(t.amount_cents))}</td><td>${privacy ? '****' : fmt(t.balance_after_cents)}</td></tr>`).join('') || '<tr><td colspan="5">暂无账单</td></tr>';
}
async function doTopup() {
  const j = await api('/api/topup', { method: 'POST', body: JSON.stringify({ amount: parseFloat($('topupAmount').value) }) });
  msg('topupMsg', j.ok ? j.message : j.error, !j.ok); if (j.ok) { closeModal('topupModal'); await refreshAll(); }
}
async function doTransfer() {
  const j = await api('/api/transfer', { method: 'POST', body: JSON.stringify({ to_email: $('trEmail').value.trim(), amount: parseFloat($('trAmount').value), pin: $('trPin').value.trim(), note: $('trNote').value.trim() }) });
  msg('trMsg', j.ok ? j.message : j.error, !j.ok); if (j.ok) { closeModal('transferModal'); await refreshAll(); }
}
async function doPay() {
  const j = await api('/api/pay', { method: 'POST', body: JSON.stringify({ merchant: $('payMerchant').value.trim(), category: $('payCategory').value, amount: parseFloat($('payAmount').value), pin: $('payPin').value.trim() }) });
  msg('payMsg', j.ok ? j.message : j.error, !j.ok); if (j.ok) { closeModal('payModal'); await refreshAll(); }
}

// ---------- 流水 ----------
async function loadOrders() {
  const j = await api('/api/orders');
  if (!j.ok) return;
  $('orderBody').innerHTML = j.items.map((o) => `<tr><td>${fmtTime(o.created_at)}</td><td>${o.name || o.product_id}</td><td>${o.side === 'BUY' ? '买入' : '卖出'}</td><td class="num">${(o.quantity_milli / 1000).toFixed(3)}</td><td class="num">${fmt(o.price_cents)}</td><td class="num">${fmt(o.total_cents)}</td><td class="${o.realized_pl_cents >= 0 ? 'up' : 'down'}">${o.side === 'SELL' ? (o.realized_pl_cents >= 0 ? '▲ +' : '▼ −') + fmt(Math.abs(o.realized_pl_cents)) : '—'}</td><td>${o.status === 'FILLED' ? '已成交' : o.status}</td></tr>`).join('') || '<tr><td colspan="8">暂无订单</td></tr>';
}
async function loadActivityTx() {
  const type = $('aType').value;
  const qs = new URLSearchParams(); if (type) qs.set('type', type);
  const j = await api('/api/transactions?' + qs.toString()); if (!j.ok) return;
  $('actTxBody').innerHTML = j.items.map((t) => `<tr><td>${fmtTime(t.created_at)}</td><td>${TYPE_LABEL[t.type] || t.type}</td><td>${t.description || t.merchant || t.category || ''}</td><td class="${t.amount_cents >= 0 ? 'up' : 'down'}">${t.amount_cents >= 0 ? '+' : '−'}${privacy ? '****' : fmt(Math.abs(t.amount_cents))}</td><td>${privacy ? '****' : fmt(t.balance_after_cents)}</td></tr>`).join('') || '<tr><td colspan="5">暂无流水</td></tr>';
}

// ---------- 设置 ----------
async function setPin() {
  const j = await api('/api/security/set-pin', { method: 'POST', body: JSON.stringify({ pin: $('pinNew').value.trim(), password: $('pinPw').value }) });
  msg('secMsg', j.ok ? j.message : j.error, !j.ok); if (j.ok) await loadAudit();
}
async function changePin() {
  const j = await api('/api/security/change-pin', { method: 'POST', body: JSON.stringify({ old_pin: $('pinOld').value.trim(), new_pin: $('pinNew2').value.trim() }) });
  msg('secMsg', j.ok ? j.message : j.error, !j.ok); if (j.ok) await loadAudit();
}
async function changePw() {
  const j = await api('/api/security/change-password', { method: 'POST', body: JSON.stringify({ old_password: $('pwOld').value, new_password: $('pwNew').value }) });
  msg('secMsg', j.ok ? j.message : j.error, !j.ok); if (j.ok) await loadAudit();
}
async function loadAudit() { const j = await api('/api/security/audit'); if (j.ok) $('auditBox').innerHTML = j.items.map((a) => `${fmtTime(a.created_at)} · ${a.action} · ${a.detail || ''} · ${a.ip || ''}`).join('<br>') || '暂无记录'; }
async function exportData() {
  const j = await api('/api/backup/export');
  if (!j.ok) return msg('backupMsg', j.error, true);
  $('exportBox').hidden = false;
  $('exportBox').textContent = JSON.stringify(j.export, null, 2);
  msg('backupMsg', '导出完成（仅当前账号数据，不含密码/PIN 哈希）。');
}
async function backupDb() {
  const j = await api('/api/backup/db', { method: 'POST' });
  msg('backupMsg', j.ok ? j.message + '：' + j.file + '（完整性：' + (j.integrity || '—') + '）' : j.error, !j.ok);
}
async function resetDemo() {
  if (!confirm('确定重置演示吗？当前账号的全部演示历史将被清空，恢复 $50.00 体验金。')) return;
  const j = await api('/api/demo/reset', { method: 'POST', body: JSON.stringify({ password: $('resetPw').value }) });
  msg('resetMsg', j.ok ? j.message : j.error, !j.ok);
  if (j.ok) await refreshAll();
}

// 自动恢复登录
(async () => {
  if (token) {
    const j = await api('/api/me');
    if (j.ok) {
      me = j.user; $('authCard').hidden = true; $('topUser').textContent = me.nickname + ' · ' + me.email;
      showView('home'); await refreshAll();
    } else logoutLocal();
  }
})();
