/* 全站直播悬浮小窗（画中画）
 * 职责：王语晨开播时，任意页面右下角自动弹出可收起的小窗，直接看直播流。
 * 数据源：
 *   - 在播态：GET /api/pocket/events（既有 pocket 探针写 KV `pocket:live:89653517`，live.liveId 非空即在播）
 *   - 流地址：GET /api/live-one?liveId= （Worker 经 msg48.org 取 HLS 等候选流）
 * 🔴 只新增、不改动既有逻辑；不在播时小窗完全隐藏，零打扰。
 * 🔴 站点在 wyc0518.cc 域下用相对路径；其它域（演示站）跨域打到生产 Worker。
 */
(function () {
  'use strict';
  var API = (location.hostname.indexOf('wyc0518.cc') >= 0) ? '' : 'https://idol.wyc0518.cc';
  var CHECK_MS = 30000;          // 在播态轮询间隔
  var shownLiveId = '';          // 当前已取流并显示的那场
  var closedForLiveId = '';      // 用户手动关掉的那场（同一场不再弹）
  var timer = null;

  function el(id) { return document.getElementById(id); }
  function on(node, ev, fn) { if (node) node.addEventListener(ev, fn); }

  /* ---------- 取可播放的流（优先 HLS） ---------- */
  function pickPlayable(cands) {
    var list = (Array.isArray(cands) ? cands : [cands]).filter(function (s) { return typeof s === 'string' && s; });
    var ok = function (s) { return /^https?:\/\//i.test(s); };
    var hls = list.find(function (s) { return ok(s) && /\.m3u8(\?|$)/i.test(s); });
    if (hls) return hls;
    return list.find(ok) || '';
  }
  // 真正支持原生 HLS 的只有 Safari 系（iOS/macOS Safari、微信内置浏览器）
  function isNativeHls() {
    var ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return false;
    return /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR/i.test(ua);
  }
  function ensureHls(cb) {
    if (window.Hls) return cb(window.Hls);
    if (window.__hlsLoading) return setTimeout(function () { ensureHls(cb); }, 300);
    window.__hlsLoading = true;
    var s = document.createElement('script');
    s.src = (API ? API : '') + './vendor/hls.min.js';
    s.onload = function () { window.__hlsLoading = false; cb(window.Hls); };
    s.onerror = function () { window.__hlsLoading = false; cb(null); };
    document.head.appendChild(s);
  }
  function attachHls(v, src) {
    if (!/\.m3u8(\?|$)/i.test(src)) { v.src = src; return; }
    if (isNativeHls()) { v.src = src; return; }   // Safari/iOS 原生播
    v.removeAttribute('src'); v.load && v.load();  // 否则 Chrome 会先报一次"不支持的源"
    ensureHls(function (Hls) {
      if (!Hls || !Hls.isSupported()) {
        v.src = src;
        markFail('这个浏览器放不了 m3u8 直播，点「新窗口打开」用系统播放器看。');
        return;
      }
      try {
        var h = new Hls();
        h.loadSource(src); h.attachMedia(v);
        h.on(Hls.Events.ERROR, function (e, data) {
          if (!data || !data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) markFail('直播流加载失败（网络），点「新窗口打开」重试。');
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { try { h.recoverMediaError(); } catch (e2) {} }
          else markFail('直播播放出错，点「新窗口打开」重试。');
        });
      } catch (e2) { v.src = src; }
    });
  }
  function markFail(msg) { var h = el('liveFabHint'); if (h) h.textContent = msg; }

  /* ---------- 小窗显隐 / 折叠 ---------- */
  function fab() { return el('liveFab'); }
  function show() { var f = fab(); if (f) f.hidden = false; }
  function hide() { var f = fab(); if (f) f.hidden = true; }
  function expand() { var f = fab(); if (f) f.classList.remove('collapsed'); }
  function collapse() { var f = fab(); if (f) f.classList.add('collapsed'); }

  function setLive(live) {
    var liveId = live && live.liveId ? String(live.liveId) : '';
    if (!liveId) { hide(); shownLiveId = ''; closedForLiveId = ''; return; }
    if (liveId === closedForLiveId) { hide(); return; }      // 这場用户关过了，别再弹
    if (liveId === shownLiveId) return;                       // 同一场，不重复取流
    shownLiveId = liveId;
    var t = el('liveFabTitle');
    if (t) t.textContent = '王语晨 正在直播' + (live.title ? '：' + live.title : '');
    show(); expand();
    fetchStream(liveId);
  }

  function fetchStream(liveId) {
    var body = el('liveFabBody');
    var video = el('liveFabVideo');
    var open = el('liveFabOpen');
    var hint = el('liveFabHint');
    if (hint) hint.textContent = '';
    if (body) body.hidden = false;
    if (body) body.innerHTML = '<div class="live-fab-loading">正在获取直播流…</div>';
    if (video) video.hidden = true;
    if (open) open.hidden = true;
    fetch(API + '/api/live-one?liveId=' + encodeURIComponent(liveId), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.error) { if (body) body.innerHTML = '<div class="live-fab-none">获取直播流失败，点「新窗口打开」到口袋48 看。</div>'; return; }
        var u = pickPlayable([j.hlsStreamPath, j.liveStreamPath, j.streamPath, j.playStreamPath, j.rtmpPath]);
        if (!u) {
          if (body) body.innerHTML = '<div class="live-fab-none">这场直播暂无网页可播的流（可能仅 rtmp / App 专有）—— 请到口袋48 App 看。</div>';
          return;
        }
        if (body) body.hidden = true;
        if (video) { video.hidden = false; attachHls(video, u); video.play && video.play().catch(function () {}); }
        if (open) { open.href = u; open.hidden = false; }
      })
      .catch(function () { if (body) body.innerHTML = '<div class="live-fab-none">网络错误，点「新窗口打开」重试。</div>'; });
  }

  /* ---------- 轮询在播态 ---------- */
  function tick() {
    fetch(API + '/api/pocket/events', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var live = j && j.live;
        if (live && live.liveId) setLive({ liveId: String(live.liveId), title: live.title || '' });
        else { hide(); shownLiveId = ''; closedForLiveId = ''; }
      })
      .catch(function () { /* 静默，下次再试 */ });
  }

  function init() {
    if (!fab()) return;                       // 没有小窗 DOM 就跳过（旧页/异常）
    on(el('liveFabClose'), 'click', function () { hide(); closedForLiveId = shownLiveId; });
    on(el('liveFabCollapse'), 'click', collapse);
    on(el('liveFabExpand'), 'click', expand);
    tick();
    timer = setInterval(tick, CHECK_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
