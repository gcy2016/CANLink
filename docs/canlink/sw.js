// 离线缓存：第一次打开时把网页文件存到本机；以后先尝试联网取新版本（3 秒没回应就用本机的），
// 联不上网、GitHub 打不开时也能打开。改了网页文件后把 VERSION 加 1。
const VERSION = 'canlink-20';
const FILES = ['./', 'index.html', 'app.js', 'slcan.js', 'recorder.js', 'transport.js', 'demo.js', 'dfu.js',
  'diag.js', 'flashfile.js', 'flash.js', 'secrets.enc.json', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'fw/vdlink-1.0.bin',
  'viewer/', 'viewer/index.html', 'viewer/canlog.js', 'viewer/plot.js', 'viewer/ai.js', 'viewer/uds.js', 'viewer/dbc.js', 'viewer/qn.js',
  'viewer/lib/xlsx.full.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('canlink-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const net = fetch(req, { cache: 'no-cache' }).then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    });
    const timeout = new Promise(r => setTimeout(r, 3000, null));
    try {
      const res = await Promise.race([net, timeout]);
      if (res && res.ok) return res;
    } catch (err) { /* 没网 */ }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    return net;  // 本机也没有：只能等网络
  })());
});
