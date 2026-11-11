// SpacePay service worker
// - 页面（导航请求）：网络优先，断网时回退到缓存的应用外壳；
// - 静态资源（CSS / JS / 图标）：同样网络优先，断网时才用缓存。
//   不用 stale-while-revalidate：发布新版后它会让新 HTML 配上旧 app.js，元素对不上导致页面出错；
// - /api/ 请求一律不经过缓存：余额与交易数据必须实时，断网时由页面提示。
// 发布新版本时修改 VERSION，旧缓存会在 activate 时清理。
const VERSION = 'spacepay-4.0.0';
const SHELL = [
  '/', '/styles.css', '/app.js', '/charts.js', '/icons.js', '/manifest.webmanifest',
  '/brand/favicon.svg', '/brand/spacepay-logo-light.svg', '/brand/spacepay-logo-dark.svg',
  '/brand/spacepay-mark-light.svg', '/brand/spacepay-mark-dark.svg', '/brand/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put('/', copy));
        return res;
      }).catch(() => caches.match('/')),
    );
    return;
  }

  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req)),
  );
});
