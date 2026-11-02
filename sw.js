/* ============================================================================
 * 王语晨 · 补档站 —— 推送 Service Worker（demo d65，2026-09-27）
 * ----------------------------------------------------------------------------
 * 职责只有两件：收到 push 就弹通知；点通知就把已开的页面拉到对应位置。
 *
 * 🔴 三条硬约束（改这个文件前必须知道）：
 *   1) **不做任何 fetch 拦截**：本站数据全靠 app.js 现拉，一旦在这里加 cache-first，
 *      页面会读到旧数据，且 Service Worker 缓存极难清理（站长自己都刷不掉）。
 *   2) **不缓存 sw.js 自己**：部署时由 index.html 的 ?v= 控制版本即可。
 *   3) 通知的「内容」全部由服务端 push 的 JSON 决定，这里只负责排版与点击跳转，
 *      **不在这里写死任何文案**（否则改文案要等所有客户端 SW 更新）。
 *
 * 通知 payload 约定（服务端 → 本文件）：
 *   { title, body, tag, url, topic }
 *     topic: 'msg'  = 新口袋发言   / 'live' = 开直播   / 'perf' = 公演开播
 * ========================================================================== */
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

/* ------------------------- 收到推送 ------------------------- */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = {}; }
  if (!d.body && e.data) { try { d.body = e.data.text(); } catch (_) {} }

  const title = d.title || '王语晨 · 补档站';
  const opt = {
    body: d.body || '',
    icon: './assets/avatar-round.png',
    badge: './assets/avatar-round.png',
    // 同 topic 用同一个 tag ⇒ 连发多条时是「替换」而不是堆叠成 7 条（站长担心刷屏的兜底）
    tag: d.tag || ('wyc-' + (d.topic || 'msg')),
    renotify: true,
    lang: 'zh-CN',
    timestamp: Date.now(),
    data: { url: d.url || './', topic: d.topic || '' }
  };
  e.waitUntil(self.registration.showNotification(title, opt));
});

/* ------------------------- 点通知 ------------------------- */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        // 已开着的本站页面：直接跳到目标位置并聚焦（不要每次都新开标签）
        if (c.url.indexOf(self.location.origin) === 0 && 'focus' in c) {
          try { c.navigate(url); } catch (_) {}
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
