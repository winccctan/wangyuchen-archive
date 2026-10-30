/* =======================================================================
   milestone.js —— ⑱ 里程碑：2026.11.28 首场定制公演（她自己排的整场）
   -----------------------------------------------------------------------
   ① 首页一条细窄倒计时（不占版面，一行 34px）
   ② 点开 → 票根（她的公演照铺满 + 压暗 + 金字，本机 Canvas 合成）
   ③ 跨过 11-28 自动换状态，不用改代码

   文案原则（站长 2026-10-30 定：「文案好土」）：
   票面上只放名词和数据 —— 名字、日期、场次、倒计时、编号。
   不写形容词、不写功能说明、不解释这张票是干嘛的。情感交给照片和颜色。
   同日再删两处：副券 `ADMIT ONE`、浮层那句「这场，是她自己排的」——
   站长一律不要解释性文案，浮层现在只有票根图 + 两个按钮。

   🔴 生产版注意（2026-10-30 首发）：
   - 日期/场名暂时写死在下面 MS 常量里。**绝不能写进 /api/schedule**
     —— 那个键每轮抓取都会整键覆盖，而且现在抓取只到 11-07，根本没有这场。
     以后要做成后台可改，就新开 KV 键 `milestone`，前端取不到时回退到这份常量。
   - 改日期/场名后必须 bump index.html 里本文件的 `?v=`。
   - 埋点：`trk('ms:open')` 已接（走 app.js 的全局 track）。
     🔴 想要统计生效，必须把 `ms:open` 加进 worker 的 EVENTS 白名单再部署 worker；
     没登记时这条会被丢弃，不会报错。
   ======================================================================= */
(function () {
  'use strict';

  // 埋点：生产站用 app.js 的全局 track()；demo 站没有这个函数，静默跳过
  function trk(ev) {
    try {
      if (typeof window.track === 'function') window.track(ev);
    } catch (_) {}
  }

  var MS = {
    date: '2026-11-28',
    badge: '11.28',
    title: '首场定制公演',
    who: '王语晨 · GNZ48 TEAM NIII'
  };

  var FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';

  // 票面照片：官方生写，原图底部有 ©GNZ48 水印，只用到 88% 高度
  var PHOTO = new Image();
  PHOTO.src = './assets/member-gs1.jpg';
  var PHOTO_OK = false;
  PHOTO.addEventListener('load', function () { PHOTO_OK = true; });

  /* ---------------------------- 日期 ---------------------------- */
  // 一律按北京时间切日（+8h 后取 UTC 字段），否则 0~8 点会算错一天
  function bjToday0() {
    var d = new Date(Date.now() + 8 * 3600e3);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  function msDay0() {
    var p = MS.date.split('-');
    return Date.UTC(+p[0], +p[1] - 1, +p[2]);
  }
  function daysLeft() { return Math.round((msDay0() - bjToday0()) / 864e5); }
  function numText(n) {
    if (n > 0) return '距开演 ' + n + ' 天';
    if (n === 0) return '就是今天';
    return '已开演';
  }

  /* ------------------------ 细窄倒计时条 ------------------------ */
  function buildBar() {
    if (document.getElementById('msBar')) return;
    var nav = document.querySelector('.tabs');
    if (!nav) return;
    var n = daysLeft();
    var bar = document.createElement('button');
    bar.type = 'button';
    bar.id = 'msBar';
    bar.className = 'ms-bar';
    bar.setAttribute('aria-label', MS.badge + ' ' + MS.title + '，' + numText(n));
    bar.innerHTML =
      '<span class="ms-badge">' + MS.badge + '</span>' +
      '<span class="ms-t">' + MS.title + '</span>' +
      '<span class="ms-sp"></span>' +
      '<span class="ms-n">' + numText(n) + '</span>' +
      '<span class="ms-a" aria-hidden="true">\u203A</span>';
    bar.addEventListener('click', openTicket);
    // 站长 2026-10-30：「放到 tab 上面」——条属于头部的信息，不该夹在
    // 导航和列表中间（那样会被当成列表内容的一部分，也会把首屏内容往下压）
    nav.insertAdjacentElement('beforebegin', bar);
  }

  /* --------------------------- 票根绘制 --------------------------- */
  function roundRect(x, px, py, pw, ph, r) {
    x.beginPath();
    x.moveTo(px + r, py);
    x.arcTo(px + pw, py, px + pw, py + ph, r);
    x.arcTo(px + pw, py + ph, px, py + ph, r);
    x.arcTo(px, py + ph, px, py, r);
    x.arcTo(px, py, px + pw, py, r);
    x.closePath();
  }

  // 照片「cover」铺满（等比放大后裁切），focusX / focusY 控制取景位置
  // focusX: 0 = 取原图左侧（人物被推到画面右边，给左边文字让位）
  function coverPhoto(x, dx, dy, dw, dh, focusX, focusY) {
    if (!PHOTO_OK || !PHOTO.naturalWidth) return;
    var iw = PHOTO.naturalWidth;
    var ih = Math.round(PHOTO.naturalHeight * 0.88);
    var s = Math.max(dw / iw, dh / ih);
    var sw = dw / s, sh = dh / s;
    var sx = (iw - sw) * (focusX == null ? 0.5 : focusX);
    var sy = (ih - sh) * (focusY == null ? 0.35 : focusY);
    x.drawImage(PHOTO, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  // 条码只求「像票」：固定种子 → 每次生成图案一致
  function barcode(x, x0, y0, w, h, seed, color) {
    var s = seed >>> 0, cx = x0, end = x0 + w;
    x.fillStyle = color;
    x.fillRect(cx, y0, 1.6, h); cx += 3.2;
    while (cx < end - 2) {
      s = (s * 1664525 + 1013904223) >>> 0;
      var bw = 0.9 + (s % 4) * 0.45;
      var gap = 0.9 + ((s >>> 7) % 4) * 0.5;
      if (cx + bw > end) break;
      x.fillRect(cx, y0, bw, h);
      cx += bw + gap;
    }
  }

  function drawTicket() {
    // 逻辑画布 360×158（细长条，才像票根）；手机上显示约 330 宽 ≈ 0.92 倍
    var W = 360, H = 158, S = 3, STUB = 262;
    var c = document.createElement('canvas');
    c.width = W * S; c.height = H * S;
    var x = c.getContext('2d');
    x.scale(S, S);
    x.textBaseline = 'middle';

    var CREAM = '#f7ecd8', GOLD = '#e0c08a', MUTED = '#b8cbcf';

    // 照片满铺 → 压暗 → 左侧再压一层，保证左上角文字压得住
    x.save();
    roundRect(x, 0, 0, W, H, 12);
    x.clip();
    x.fillStyle = '#0f2e37';
    x.fillRect(0, 0, W, H);
    // 人物取画面偏右，左边留出暗部给文字（否则日期会压在她脸上）
    coverPhoto(x, 0, 0, W, H, 0.02, 0.14);
    x.fillStyle = 'rgba(11,36,44,.46)';
    x.fillRect(0, 0, W, H);
    var g = x.createLinearGradient(0, 0, 268, 0);
    g.addColorStop(0, 'rgba(9,30,38,.86)');
    g.addColorStop(0.55, 'rgba(9,30,38,.42)');
    g.addColorStop(1, 'rgba(9,30,38,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 268, H);
    // 副券再压一层，和主区拉开
    x.fillStyle = 'rgba(8,26,32,.42)';
    x.fillRect(STUB, 0, W - STUB, H);
    x.restore();

    // 金色细内框
    x.strokeStyle = 'rgba(224,192,138,.5)';
    x.lineWidth = 0.6;
    roundRect(x, 6.5, 6.5, W - 13, H - 13, 7);
    x.stroke();

    // 撕口虚线
    x.save();
    x.strokeStyle = 'rgba(224,192,138,.45)';
    x.lineWidth = 0.7;
    x.setLineDash([2.5, 3.5]);
    x.beginPath();
    x.moveTo(STUB + 0.5, 16);
    x.lineTo(STUB + 0.5, H - 16);
    x.stroke();
    x.restore();

    // —— 主区 ——
    x.fillStyle = MUTED;
    x.font = '500 8.5px ' + FONT;
    x.fillText(MS.who, 24, 28);

    x.fillStyle = CREAM;
    x.font = '600 24px ' + FONT;
    x.fillText('2026.11.28', 24, 62);

    x.fillStyle = GOLD;
    x.font = '400 10.5px ' + FONT;
    x.fillText('星期六 · 首场定制公演', 24, 86);

    x.fillStyle = GOLD;
    roundRect(x, 24, 116, 2.4, 18, 1.2);
    x.fill();

    x.fillStyle = '#fdf3e0';
    x.font = '600 18px ' + FONT;
    x.fillText(numText(daysLeft()), 34, 125);

    // —— 副券 ——
    // 只有三段：日期 / 条码 / 编号。上下各留 30 左右，垂直均分，不塞英文标签
    var cx = (STUB + W) / 2;
    x.textAlign = 'center';

    x.fillStyle = CREAM;
    x.font = '600 23px ' + FONT;
    x.fillText('11.28', cx, 40);

    barcode(x, cx - 34, 68, 68, 34, 20261128, GOLD);

    x.fillStyle = MUTED;
    x.font = '400 8.5px ' + FONT;
    x.fillText('NO.1128', cx, 124);

    x.textAlign = 'left';

    try {
      return c.toDataURL('image/png');
    } catch (err) {
      return '';
    }
  }

  /* --------------------------- 浮层 --------------------------- */
  var modal = null, pic = null, url = '';

  function ensureModal() {
    if (modal) return;
    modal = document.createElement('div');
    modal.className = 'ms-modal';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="ms-sheet" role="dialog" aria-modal="true" aria-label="11.28 票根">' +
        '<img class="ms-pic" id="msPic" alt="2026.11.28 首场定制公演 票根">' +
        '<div class="ms-acts">' +
          '<button type="button" class="ms-btn primary" id="msSave">保存图片</button>' +
          '<button type="button" class="ms-btn" id="msClose">关掉</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    pic = modal.querySelector('#msPic');

    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    modal.querySelector('#msClose').addEventListener('click', close);
    modal.querySelector('#msSave').addEventListener('click', save);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.hidden) close();
    });
  }

  function render() {
    url = drawTicket();
    pic.src = url || '';
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    trk('ms:open');
  }

  function openTicket() {
    ensureModal();
    if (PHOTO_OK) { render(); return; }
    // 照片还没下载完：等一拍再画，避免出一张没照片的空票
    var done = false;
    var go = function () { if (done) return; done = true; render(); };
    PHOTO.addEventListener('load', go, { once: true });
    PHOTO.addEventListener('error', go, { once: true });
    setTimeout(go, 1500);
  }

  function close() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = '';
  }

  function save() {
    if (!url) return;
    var a = document.createElement('a');
    a.href = url;
    a.download = '王语晨-1128-票根.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // iOS Safari 不认 download 属性，只能长按保存 → 按钮上直接告诉用户
    var b = modal.querySelector('#msSave');
    b.textContent = '已存 / 长按图片也能存';
    setTimeout(function () { b.textContent = '保存图片'; }, 2400);
  }

  /* --------------------------- 启动 --------------------------- */
  function boot() {
    buildBar();
    // 切 tab 只重渲面板，nav 不重建；这里兜一层，防止极端情况下被冲掉
    var t = null;
    new MutationObserver(function () {
      clearTimeout(t);
      t = setTimeout(buildBar, 200);
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
