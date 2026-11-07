let token = localStorage.getItem('pay_token') || '';
let me = null;
const $ = id => document.getElementById(id);
function headers(){ return { 'Content-Type':'application/json', ...(token ? { Authorization:'Bearer '+token } : {}) }; }
async function api(path, opts={}){ const r = await fetch(path, { ...opts, headers: headers() }); const j = await r.json().catch(()=>({ok:false,error:'网络错误'})); if(!r.ok && r.status===401){ logoutLocal(); } return { status:r.status, ...j }; }
function msg(id, text, isErr){ const el=$(id); if(!el) return; el.textContent=text||''; el.className='msg'+(isErr?' err':''); }
function showTab(t){ $('tabLogin').classList.toggle('active', t==='login'); $('tabRegister').classList.toggle('active', t==='register'); $('loginPane').hidden = t!=='login'; $('registerPane').hidden = t!=='register'; }
function openModal(id){ $(id).hidden=false; } function closeModal(id){ $(id).hidden=true; }
function logoutLocal(){ token=''; localStorage.removeItem('pay_token'); me=null; $('appCard').hidden=true; $('authCard').hidden=false; $('topUser').textContent=''; }
function fmt(c){ return '$'+(c/100).toFixed(2); }
function fmtTime(ts){ return new Date(ts).toLocaleString('zh-CN'); }
const TYPE_LABEL={bonus:'体验金',topup:'充值',transfer_in:'转入',transfer_out:'转出',pay:'付款'};

async function requestCode(){
  const email=$('regEmail').value.trim(); if(!email) return msg('authMsg','请先填邮箱',true);
  const j=await api('/api/auth/request-code',{method:'POST',body:JSON.stringify({email,purpose:'register'})});
  msg('authMsg', j.ok ? j.message+'（演示模式请点“查看演示收件箱”）' : j.error, !j.ok);
  if(j.ok) showDemoInbox();
}
async function showDemoInbox(){
  const email=$('regEmail').value.trim(); if(!email) return msg('authMsg','请先填邮箱',true);
  const r=await fetch('/api/demo-inbox?email='+encodeURIComponent(email)); const j=await r.json();
  const box=$('demoInbox'); box.hidden=false;
  if(!j.ok) { box.innerHTML='获取失败：'+(j.error||''); return; }
  box.innerHTML='<b>📬 演示邮箱收件箱（仅演示，不发真实邮件）</b><br>'+j.notice+'<br>'+ (j.items.length? j.items.map(x=>`验证码 <b>${x.code}</b> · ${x.purpose} · ${fmtTime(x.created_at)}`).join('<br>') : '暂无验证码，请先点“获取验证码”');
}
async function doRegister(){
  const body={email:$('regEmail').value.trim(), nickname:$('regNickname').value.trim(), password:$('regPassword').value, code:$('regCode').value.trim()};
  const j=await api('/api/auth/register',{method:'POST',body:JSON.stringify(body)});
  msg('authMsg', j.ok? j.message : j.error, !j.ok);
  if(j.ok){ showTab('login'); $('loginEmail').value=body.email; }
}
async function doLogin(){
  const j=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:$('loginEmail').value.trim(), password:$('loginPassword').value})});
  if(!j.ok) return msg('authMsg', j.error, true);
  token=j.token; localStorage.setItem('pay_token', token); me=j.user; msg('authMsg','登录成功');
  $('authCard').hidden=true; $('appCard').hidden=false; $('topUser').textContent=me.nickname+' · '+me.email;
  if(!me.has_pin) alert('提示：请先在安全中心设置 6 位支付 PIN，转账 / 付款都需要验证 PIN。');
  await refreshAll();
}
async function doLogout(){ await api('/api/auth/logout',{method:'POST'}); logoutLocal(); }
async function refreshAll(){ await loadWallet(); await loadStats(); await loadTx(); await loadAudit(); }
async function loadWallet(){ const j=await api('/api/wallet'); if(j.ok){ $('balanceAmount').textContent=fmt(j.balance_cents); $('balanceSub').textContent='USD · 虚拟资金，不可提现'; } }
async function loadStats(){
  const j=await api('/api/stats'); if(!j.ok) return;
  $('statsBox').innerHTML=`收入 <b style="color:#065f46">${fmt(j.income_cents)}</b> &nbsp; 支出 <b style="color:#b91c1c">${fmt(j.expense_cents)}</b><br>`+Object.entries(j.by_category).map(([k,v])=>`${k}：${fmt(v)}`).join(' · ');
  drawChart(j.by_category);
}
function drawChart(byCat){
  const c=$('chart'); const ctx=c.getContext('2d'); ctx.clearRect(0,0,c.width,c.height);
  const entries=Object.entries(byCat).filter(([,v])=>v<0); if(!entries.length){ ctx.fillStyle='#999'; ctx.fillText('暂无支出数据',10,70); return; }
  const colors=['#0f1e3d','#f59e0b','#10b981','#ef4444','#8b5cf6','#06b6d4'];
  let x=10; const total=entries.reduce((s,[,v])=>s+Math.abs(v),0);
  entries.forEach(([k,v],i)=>{ const w=Math.max(20, Math.abs(v)/total*280); ctx.fillStyle=colors[i%colors.length]; ctx.fillRect(x,40,w,48); ctx.fillStyle='#333'; ctx.font='12px sans-serif'; ctx.fillText(k, x, 30); ctx.fillText(fmt(v), x, 105); x+=w+6; });
}
async function loadTx(){
  const type=$('fType').value, q=$('fQ').value.trim();
  const qs=new URLSearchParams(); if(type) qs.set('type',type); if(q) qs.set('q',q);
  const j=await api('/api/transactions?'+qs.toString()); if(!j.ok) return;
  $('txBody').innerHTML=j.items.map(t=>`<tr><td>${fmtTime(t.created_at)}</td><td>${TYPE_LABEL[t.type]||t.type}</td><td>${t.merchant||t.counterparty_email||t.category||''}<br><span class="hint">${t.description||''}</span></td><td style="color:${t.amount_cents>=0?'#065f46':'#b91c1c'}">${t.amount_cents>=0?'+':''}${fmt(t.amount_cents)}</td><td>${fmt(t.balance_after_cents)}</td></tr>`).join('') || '<tr><td colspan="5">暂无账单</td></tr>';
}
async function doTopup(){
  const j=await api('/api/topup',{method:'POST',body:JSON.stringify({amount:parseFloat($('topupAmount').value)})});
  msg('topupMsg', j.ok? j.message : j.error, !j.ok); if(j.ok){ closeModal('topupModal'); await refreshAll(); }
}
async function doTransfer(){
  const j=await api('/api/transfer',{method:'POST',body:JSON.stringify({to_email:$('trEmail').value.trim(), amount:parseFloat($('trAmount').value), pin:$('trPin').value.trim(), note:$('trNote').value.trim()})});
  msg('trMsg', j.ok? j.message : j.error, !j.ok); if(j.ok){ closeModal('transferModal'); await refreshAll(); }
}
async function doPay(){
  const j=await api('/api/pay',{method:'POST',body:JSON.stringify({merchant:$('payMerchant').value.trim(), category:$('payCategory').value, amount:parseFloat($('payAmount').value), pin:$('payPin').value.trim()})});
  msg('payMsg', j.ok? j.message : j.error, !j.ok); if(j.ok){ closeModal('payModal'); await refreshAll(); }
}
async function setPin(){
  const j=await api('/api/security/set-pin',{method:'POST',body:JSON.stringify({pin:$('pinNew').value.trim(), password:$('pinPw').value})});
  msg('secMsg', j.ok? j.message : j.error, !j.ok); if(j.ok) await loadAudit();
}
async function changePin(){
  const j=await api('/api/security/change-pin',{method:'POST',body:JSON.stringify({old_pin:$('pinOld').value.trim(), new_pin:$('pinNew2').value.trim()})});
  msg('secMsg', j.ok? j.message : j.error, !j.ok); if(j.ok) await loadAudit();
}
async function changePw(){
  const j=await api('/api/security/change-password',{method:'POST',body:JSON.stringify({old_password:$('pwOld').value, new_password:$('pwNew').value})});
  msg('secMsg', j.ok? j.message : j.error, !j.ok); if(j.ok) await loadAudit();
}
async function loadAudit(){ const j=await api('/api/security/audit'); if(j.ok) $('auditBox').innerHTML=j.items.map(a=>`${fmtTime(a.created_at)} · ${a.action} · ${a.detail||''} · ${a.ip||''}`).join('<br>')||'暂无记录'; }

// 自动恢复登录
(async()=>{ if(token){ const j=await api('/api/me'); if(j.ok){ me=j.user; $('authCard').hidden=true; $('appCard').hidden=false; $('topUser').textContent=me.nickname+' · '+me.email; await refreshAll(); } else { logoutLocal(); } } })();
