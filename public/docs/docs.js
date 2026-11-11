// SpacePay 开发者文档站：侧栏、搜索、页内目录、代码语言标签、复制、上一页/下一页。
// 无构建步骤；每个页面只写正文，导航与交互由这里统一生成。
'use strict';

const NAV = [
  { group: '快速开始', items: [
    { id: 'index', title: '首次调用 API', href: '/docs' },
    { id: 'checkout', title: '结账流程', href: '/docs/checkout' },
    { id: 'changelog', title: '更新日志', href: '/docs/changelog' },
  ] },
  { group: '接口参考', items: [
    { id: 'payments', title: '创建支付', href: '/docs/payments' },
    { id: 'payment-query', title: '查询支付与列表', href: '/docs/payment-query' },
    { id: 'refunds', title: '退款', href: '/docs/refunds' },
    { id: 'settlement', title: '结算余额与提现', href: '/docs/settlement' },
  ] },
  { group: '事件', items: [
    { id: 'webhooks', title: 'Webhook 与签名', href: '/docs/webhooks' },
  ] },
  { group: '参考', items: [
    { id: 'errors', title: '错误码', href: '/docs/errors' },
    { id: 'limits', title: '限流与幂等', href: '/docs/limits' },
    { id: 'security', title: '密钥与安全', href: '/docs/security' },
  ] },
];

const flat = NAV.flatMap((g) => g.items);
const page = document.body.dataset.page || 'index';

// ---------- 顶部导航（各页面共用，避免重复维护） ----------
(function header() {
  const h = document.getElementById('docHeader');
  if (!h) return;
  h.innerHTML = `
    <button class="icon-btn doc-menu-btn" id="menuBtn" aria-label="打开文档目录"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
    <a class="brand" href="/" aria-label="SpacePay 首页"><picture><source srcset="/brand/spacepay-logo-dark.svg" media="(prefers-color-scheme: dark)"><img src="/brand/spacepay-logo-light.svg" alt="SpacePay"></picture></a>
    <nav class="topnav"><a href="/docs" class="active">文档</a><a href="/merchant">控制台</a><a href="/">钱包</a></nav>
    <span class="spacer"></span>
    <div class="actions">
      <button class="icon-btn" id="themeBtn" aria-label="切换主题"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>
      <a class="btn sm primary" href="/merchant">获取 API Key</a>
    </div>`;
})();

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

// ---------- 主题 ----------
(function theme() {
  try {
    const t = localStorage.getItem('spacepay_theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (_) {}
  const btn = document.getElementById('themeBtn');
  if (btn) btn.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('spacepay_theme', next); } catch (_) {}
  });
})();

// ---------- 侧栏 ----------
(function sidebar() {
  const nav = document.getElementById('docNav');
  if (!nav) return;
  for (const g of NAV) {
    nav.appendChild(el('div', 'grp', g.group));
    for (const item of g.items) {
      const a = el('a', item.id === page ? 'active' : '', item.title);
      a.href = item.href;
      a.dataset.title = (g.group + ' ' + item.title).toLowerCase();
      nav.appendChild(a);
    }
  }
  const input = document.getElementById('docSearch');
  if (input) {
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      let visible = 0;
      nav.querySelectorAll('a').forEach((a) => {
        const hit = !q || a.dataset.title.includes(q) || a.textContent.toLowerCase().includes(q);
        a.hidden = !hit;
        if (hit) visible++;
      });
      nav.querySelectorAll('.grp').forEach((g) => {
        let s = g.nextElementSibling, any = false;
        while (s && !s.classList.contains('grp')) { if (s.tagName === 'A' && !s.hidden) { any = true; break; } s = s.nextElementSibling; }
        g.hidden = !any;
      });
      let empty = nav.querySelector('.empty');
      if (!visible) {
        if (!empty) { empty = el('div', 'empty', '没有匹配的页面'); nav.appendChild(empty); }
        empty.hidden = false;
      } else if (empty) empty.hidden = true;
    });
  }
  // 移动端抽屉
  const side = document.getElementById('docSide');
  const scrim = document.getElementById('docScrim');
  const menu = document.getElementById('menuBtn');
  const close = () => { side.classList.remove('open'); scrim.classList.remove('open'); };
  if (menu) menu.addEventListener('click', () => { side.classList.toggle('open'); scrim.classList.toggle('open'); });
  if (scrim) scrim.addEventListener('click', close);
  nav.addEventListener('click', (e) => { if (e.target.tagName === 'A') close(); });
})();

// ---------- 页内目录 ----------
(function toc() {
  const article = document.querySelector('.doc-article');
  const box = document.getElementById('docToc');
  if (!article || !box) return;
  const heads = [...article.querySelectorAll('h2, h3')];
  if (!heads.length) return;
  const list = el('div');
  list.appendChild(el('div', 'title', '本页目录'));
  const links = [];
  for (const h of heads) {
    if (!h.id) h.id = h.textContent.trim().toLowerCase().replace(/[^\w一-龥]+/g, '-').replace(/^-|-$/g, '');
    const a = el('a', h.tagName === 'H3' ? 'lvl-3' : '', h.textContent.trim());
    a.href = '#' + h.id;
    list.appendChild(a);
    links.push({ a, h });
    const anchor = el('a', 'anchor', '#');
    anchor.href = '#' + h.id;
    anchor.setAttribute('aria-label', '链接到本节');
    h.appendChild(anchor);
  }
  box.appendChild(list);
  const spy = () => {
    let current = links[0];
    const top = 80;
    for (const l of links) if (l.h.getBoundingClientRect().top <= top) current = l;
    links.forEach((l) => l.a.classList.toggle('active', l === current));
  };
  window.addEventListener('scroll', spy, { passive: true });
  spy();
})();

// ---------- 代码语言标签与复制 ----------
document.querySelectorAll('.codeblock').forEach((block) => {
  const tabs = block.querySelectorAll('.lang-tabs button');
  const panes = block.querySelectorAll('pre[data-lang]');
  tabs.forEach((tab) => tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    panes.forEach((p) => { p.hidden = p.dataset.lang !== tab.dataset.lang; });
  }));
  const copy = block.querySelector('.copy');
  if (copy) copy.addEventListener('click', () => {
    const visible = [...panes].find((p) => !p.hidden) || panes[0];
    const text = visible ? visible.textContent : '';
    const done = () => { const old = copy.textContent; copy.textContent = '已复制'; setTimeout(() => { copy.textContent = old; }, 1500); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (_) {}
      ta.remove();
    }
  });
});

// ---------- 上一页 / 下一页 ----------
(function prevnext() {
  const box = document.getElementById('pageNav');
  if (!box) return;
  const i = flat.findIndex((x) => x.id === page);
  const prev = i > 0 ? flat[i - 1] : null;
  const next = i >= 0 && i < flat.length - 1 ? flat[i + 1] : null;
  if (prev) {
    const a = el('a', '', `<span class="dir">上一页</span><span class="t">${prev.title}</span>`);
    a.href = prev.href;
    box.appendChild(a);
  } else box.appendChild(el('a', 'empty'));
  if (next) {
    const a = el('a', 'next', `<span class="dir">下一页</span><span class="t">${next.title}</span>`);
    a.href = next.href;
    box.appendChild(a);
  } else box.appendChild(el('a', 'empty'));
})();

// ---------- 站点地址 ----------
document.querySelectorAll('[data-origin]').forEach((n) => { n.textContent = location.origin; });
