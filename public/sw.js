const CACHE = 'wordwise-v28';
// 预缓存清单必须覆盖 public/js 下所有实际存在的模块（含视图静态 import 的依赖），
// 否则新装设备离线冷启动时对应功能直接挂掉。新增 JS 模块后务必同步这里并 bump CACHE。
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './icons/icon.svg', './css/styles.css',
  './js/app.js', './js/api.js', './js/ai.js', './js/bridge.js',
  './js/anchor.js', './js/nlpcross.js', './js/article-vocab.js', './js/vocab1000.js', './js/review.js', './js/drill.js',
  './js/auth.js', './js/login-screen.js', './js/textsplit.js', './js/dict.js', './js/mdx.js', './js/gaokao.js',
  './js/ebook.js', './js/tts.js',
  './js/reminder.js', './js/router.js', './js/srs.js',
  './js/backtrans.js', './js/hardsent.js', './js/nlp.js', './js/profile.js',
  './js/stats.js', './js/store.js', './js/ui.js', './js/viz.js',
  './js/views/home.js', './js/views/import.js', './js/views/words.js', './js/views/learn.js',
  './js/views/reader.js', './js/views/history.js', './js/views/lookup.js',
  './js/views/quiz.js', './js/views/dashboard.js', './js/views/settings.js',
  './vendor/pdfjs/pdf.min.mjs', './vendor/pdfjs/pdf.worker.min.mjs',
  './vendor/mammoth.min.js', './vendor/jszip.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()).catch((err) => {
    // 预缓存任一资源失败都会让整个 install 失败、PWA 失去离线能力——必须留下可查日志
    console.error('[sw] 预缓存失败，离线能力不可用:', err);
  }));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
    self.clients.claim()
  ]));
});

/** 应用自身代码：必须走网络优先，否则改了代码用户永远拿不到新版 */
function isAppCode(url) {
  return /\.(?:js|mjs|css|html)$/i.test(url.pathname) || url.pathname === '/' || url.pathname.endsWith('/');
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;

  // 导航请求：网络优先，失败回退缓存（离线可用）
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put('./index.html', copy));
      return r;
    }).catch(() => caches.match('./index.html')));
    return;
  }

  // 应用代码：网络优先，拿到新的就更新缓存；离线时回退缓存
  if (isAppCode(url)) {
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request)));
    return;
  }

  // 静态资源（字体、cmap、词典数据）：缓存优先，命中即返回
  e.respondWith(caches.match(e.request).then((cached) => {
    if (cached) return cached;
    return fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    });
  }));
});

self.addEventListener('push', (e) => {
  const title = '该背单词啦！';
  const options = {
    body: '今日试卷已准备好，花 5 分钟完成一次学习循环。',
    icon: './icons/icon.svg',
    badge: './icons/icon.svg',
    tag: 'wordwise-daily',
    data: { url: '#/quiz?mode=take' }
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.url || '#/home';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const client of list) {
      if ('focus' in client) {
        client.focus();
        // hash 深链必须以站点根为基准解析，直接 navigate(target) 会相对 sw.js 解析成 /sw.js#/...
        client.navigate(`/${target}`).catch(() => client.navigate('/'));
        return;
      }
    }
    return clients.openWindow(`/${target}`);
  }));
});
