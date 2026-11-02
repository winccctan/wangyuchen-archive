/* =======================================================================
   milestone.js —— ⑱ 里程碑：2026.11.28 首场定制公演（她自己排的整场）
   -----------------------------------------------------------------------
   ① 首页一条细窄倒计时（不占版面，一行 34px，压在 .tabs 之上）
   ② 点开 = 抽票根（16 款混着一个池子，本机 Canvas 合成）
   ③ 跨过 11-28 自动换状态，不用改代码
   ④ 记录只存 localStorage（wyc-ms-draw-v2）：不绑 uid、不上传服务器

   抽票根规则（站长 2026-11-02 定，同日修订）：
   · 🔴 不分「生写 / 微博」两套，浮层里也不写款名（站长：「不分微博和生写
     也不要写什么城市夜色」）—— 16 款进同一个池子混着抽：8 套配色 × 2 张照片
   · 款名（深夜剧场/城市夜色…）只留在代码里当 id 和排查用，绝不出现在界面上
   · 只有稀有款露一个小标签「稀有 / 隐藏」；常见款什么都不显示
   · 副券印收藏编号 NO.xxxx（0001-1128，首次抽到该款时定下，之后不变）
   · 座位不抽（真实座位由购票决定）→ 票面不写座位
   · 不限次抽；未集齐时优先出「未拥有」的款，集齐后才随机 → 保证能集齐
   · 🔴 导出的图不要白色边：canvas 满幅矩形、不做圆角裁切（圆角交给 CSS），
     否则 PNG 四角透明，进相册/拼图会变白角

   文案原则（站长 2026-10-30 定：「文案好土」）：
   票面上只放名词和数据 —— 名字、日期、场次、倒计时、编号。
   不写形容词、不写功能说明、不解释这张票是干嘛的。情感交给照片和颜色。

   🔴 生产版注意：
   - 日期/场名暂时写死在下面 MS 常量里。**绝不能写进 /api/schedule**
     —— 那个键每轮抓取都会整键覆盖，而且现在抓取只到 11-07，根本没有这场。
     以后要做成后台可改，就新开 KV 键 `milestone`，前端取不到时回退到这份常量。
   - 改日期/场名/款图后必须 bump index.html 里本文件的 `?v=`。
   - 保存图片走 app.js 的统一弹层 showAlbumLayer（手机端进相册，不是「文件」App）。
   - 埋点：ms:open（打开）/ ms:draw（抽一次）。🔴 必须同时在 worker 的 EVENTS
     白名单里登记，没登记会被静默丢弃，不会报错。
   ======================================================================= */
(function () {
  'use strict';

  // 埋点：生产站用 app.js 的全局 track()；没有这个函数时静默跳过
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
  var LS = 'wyc-ms-draw-v2';   // 键沿用 a:xxx / b:xxx（只当内部 id），旧记录直接兼容

  /* 八套配色（两套照片共用）。zoom 越大人物越大；fx 0=取左 1=取右；fy 0=取上 1=取下。 */
  var LOOK = [
    { id: 'night',  name: '深夜剧场', rare: 0, bg: '#0f2e37', cream: '#f7ecd8', gold: '#e0c08a', muted: '#b8cbcf' },
    { id: 'red',    name: '首演朱红', rare: 0, bg: '#3a1114', cream: '#fbeedd', gold: '#e8b873', muted: '#c9a49a' },
    { id: 'spot',   name: '舞台追光', rare: 0, bg: '#1b1a2e', cream: '#efe9ff', gold: '#b9a6ff', muted: '#9a94b8' },
    { id: 'warm',   name: '后台暖黄', rare: 0, bg: '#3a2a14', cream: '#fdf0d5', gold: '#e8c07a', muted: '#c9b49a' },
    { id: 'film',   name: '胶片做旧', rare: 0, bg: '#2b2620', cream: '#f0e6d2', gold: '#c9a06a', muted: '#a89880' },
    { id: 'city',   name: '城市夜色', rare: 0, bg: '#0e1a2b', cream: '#e6f0ff', gold: '#7fa8d9', muted: '#8fa4c0' },
    { id: 'ink',    name: '墨黑金',   rare: 1, bg: '#15161a', cream: '#f2ece0', gold: '#d9b978', muted: '#a09a8c' },
    { id: 'silver', name: '银白冷调', rare: 2, light: true, bg: '#e9edf1', cream: '#12222a', gold: '#8a6a3a', muted: '#5a6b72' }
  ];

  /* 同款名 → 两套各自的照片与取景。crop=取照片上方多少比例（生写要切掉底部 ©GNZ48）。 */
  var SHOTS = {
    a: {
      night:  { photo: './assets/member-gs1.jpg', zoom: 1.50, fx: 0.34, fy: 0.12, crop: 0.88 },
      red:    { photo: './assets/member-gs4.jpg', zoom: 1.50, fx: 0.32, fy: 0.12, crop: 0.88 },
      spot:   { photo: './assets/gs2024-3.jpg',   zoom: 1.55, fx: 0.34, fy: 0.13, crop: 0.88 },
      warm:   { photo: './assets/gs2025-1.jpg',   zoom: 1.50, fx: 0.34, fy: 0.13, crop: 0.88 },
      film:   { photo: './assets/member-gs2.jpg', zoom: 1.48, fx: 0.30, fy: 0.12, crop: 0.88 },
      city:   { photo: './assets/gs2024-4.jpg',   zoom: 1.15, fx: 0.45, fy: 0.34, crop: 0.88 },
      ink:    { photo: './assets/gs2025-2.jpg',   zoom: 1.15, fx: 0.45, fy: 0.34, crop: 0.88 },
      silver: { photo: './assets/gs2024-1.jpg',   zoom: 1.50, fx: 0.34, fy: 0.13, crop: 0.88 }
    },
    b: {
      // 微博图取景：目标让人脸落在 x≈180-235（文字右边界 155 之后、副券线 262 之前）
      night:  { photo: './assets/wb-night.jpg',  zoom: 1.10, fx: 0.30, fy: 0.10, crop: 1 },
      red:    { photo: './assets/wb-red.jpg',    zoom: 1.22, fx: 0.02, fy: 0.26, crop: 1 },
      spot:   { photo: './assets/wb-spot.jpg',   zoom: 1.22, fx: 0.06, fy: 0.32, crop: 1 },
      warm:   { photo: './assets/wb-warm.jpg',   zoom: 1.05, fx: 0.40, fy: 0.32, crop: 1 },
      film:   { photo: './assets/wb-film.jpg',   zoom: 1.22, fx: 0.08, fy: 0.24, crop: 1 },
      city:   { photo: './assets/wb-city.jpg',   zoom: 1.05, fx: 0.20, fy: 0.22, crop: 1 },
      ink:    { photo: './assets/wb-ink.jpg',    zoom: 1.15, fx: 0.04, fy: 0.30, crop: 1 },
      silver: { photo: './assets/wb-silver.jpg', zoom: 1.05, fx: 0.20, fy: 0.22, crop: 1 }
    }
  };

  /* 一套池子：8 套配色 × 2 张照片（a=生写 / b=微博）= 16 款，混在一起抽。
     🔴 站长 2026-11-02：不分「生写/微博」、不显示款名 —— 照片来源对抽的人没意义，
     款名（深夜剧场/城市夜色…）只当内部 id，绝不渲染到界面。 */
  var SETS = ['a', 'b'];

  function themesOf(setId) {
    return LOOK.map(function (l) {
      var s = SHOTS[setId][l.id];
      var t = {};
      for (var k in l) t[k] = l[k];
      for (var j in s) t[j] = s[j];
      t.key = setId + ':' + l.id;
      return t;
    });
  }
  var POOL = [];
  SETS.forEach(function (sid) { POOL = POOL.concat(themesOf(sid)); });
  var TOTAL = POOL.length;   // 16

  /* 预载所有图（16 张，本地文件，canvas 不会跨域污染） */
  var IMGS = {};
  POOL.forEach(function (t) {
    var im = new Image();
    im.addEventListener('load', function () { im._ok = true; });
    im.src = t.photo;
    IMGS[t.key] = im;
  });

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

  /* ------------------------ 抽卡状态（本地） ------------------------ */
  var state = { owned: [], nums: {}, count: 0, last: null };

  function themeOfKey(key) {
    for (var i = 0; i < POOL.length; i++) if (POOL[i].key === key) return POOL[i];
    return null;
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(LS) || localStorage.getItem('wyc-ms-draw-v1');
      if (!raw) return;
      var s = JSON.parse(raw);
      if (!s) return;
      var owned = [];
      (s.owned || []).forEach(function (id) {
        // v1 的键只有款 id、没有套系前缀 → 当时只有生写套，补 a:
        var k = String(id).indexOf(':') >= 0 ? id : 'a:' + id;
        if (themeOfKey(k) && owned.indexOf(k) < 0) owned.push(k);
      });
      var nums = {};
      for (var k2 in (s.nums || {})) {
        var nk = k2.indexOf(':') >= 0 ? k2 : 'a:' + k2;
        if (themeOfKey(nk)) nums[nk] = s.nums[k2];
      }
      var last = s.last ? (String(s.last).indexOf(':') >= 0 ? s.last : 'a:' + s.last) : null;
      state = {
        owned: owned,
        nums: nums,
        count: s.count || 0,
        // 合并成一池后不再分套系：上次那张不存在就退回最近拥有的一张
        last: (last && themeOfKey(last)) ? last : (owned.length ? owned[owned.length - 1] : null)
      };
    } catch (_) {}
  }
  function saveState() {
    try { localStorage.setItem(LS, JSON.stringify(state)); } catch (_) {}
  }
  function isOwned(key) { return state.owned.indexOf(key) >= 0; }

  // 未集齐时优先出未拥有款；集齐后随机。稀有款权重低，但池子缩小到只剩它时必出 → 保证集齐。
  function pickTheme() {
    var pool = POOL.filter(function (t) { return !isOwned(t.key); });
    if (!pool.length) pool = POOL.slice();
    var w = pool.map(function (t) { return t.rare === 0 ? 10 : (t.rare === 1 ? 3 : 2); });
    var sum = w.reduce(function (a, b) { return a + b; }, 0);
    var r = Math.random() * sum;
    for (var i = 0; i < pool.length; i++) {
      r -= w[i];
      if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  function drawOnce() {
    var t = pickTheme();
    if (!isOwned(t.key)) state.owned.push(t.key);
    if (!state.nums[t.key]) state.nums[t.key] = 1 + Math.floor(Math.random() * 1128);
    state.count += 1;
    state.last = t.key;
    saveState();
    return t;
  }

  /* --------------------------- 绘制 --------------------------- */
  function hexA(hex, a) {
    var h = String(hex).replace('#', '');
    var r = parseInt(h.substr(0, 2), 16);
    var g = parseInt(h.substr(2, 2), 16);
    var b = parseInt(h.substr(4, 2), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function roundRect(x, px, py, pw, ph, r) {
    x.beginPath();
    x.moveTo(px + r, py);
    x.arcTo(px + pw, py, px + pw, py + ph, r);
    x.arcTo(px + pw, py + ph, px, py + ph, r);
    x.arcTo(px, py + ph, px, py, r);
    x.arcTo(px, py, px + pw, py, r);
    x.closePath();
  }

  // cover 铺满：zoom 控制人物大小，fx/fy 控制取景位置（0=左/上，1=右/下）
  function coverPhoto(x, im, dx, dy, dw, dh, zoom, fx, fy, crop) {
    if (!im || !im.naturalWidth) return;
    var iw = im.naturalWidth;
    var ih = Math.round(im.naturalHeight * (crop || 1));
    var s = Math.max(dw / iw, dh / ih) * (zoom || 1);
    var sw = dw / s, sh = dh / s;
    var sx = (iw - sw) * (fx == null ? 0.34 : fx);
    var sy = (ih - sh) * (fy == null ? 0.12 : fy);
    x.drawImage(im, sx, sy, sw, sh, dx, dy, dw, dh);
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

  function pad4(n) {
    var s = '000' + n;
    return s.slice(-4);
  }

  function drawTicket(t, serial) {
    // 逻辑画布 360×158（细长条，才像票根）；手机上显示约 330 宽 ≈ 0.92 倍
    var W = 360, H = 158, S = 3, STUB = 262;
    var c = document.createElement('canvas');
    c.width = W * S; c.height = H * S;
    var x = c.getContext('2d');
    x.scale(S, S);
    x.textBaseline = 'middle';

    var CREAM = t.cream, GOLD = t.gold, MUTED = t.muted;
    var im = IMGS[t.key];
    if (!im || !im._ok) im = null;

    /* 🔴 满幅直角：不 clip 圆角。圆角只由 CSS 做，导出的 PNG 四角是照片不是透明，
       否则存进相册/拼图时四角会变白，看起来像有白边。 */
    x.fillStyle = t.bg;
    x.fillRect(0, 0, W, H);

    if (im) coverPhoto(x, im, 0, 0, W, H, t.zoom, t.fx, t.fy, t.crop);

    if (t.light) {
      /* —— 珠光银（2026-11-02 重做：原来是「白蒙蒙一片」，站长说太朴素）——
         冷银渐变纸底 + 照片只压薄薄一层（人看得见）+ 细斜纹织纹 + 对角铜版纸反光
         + 副券银箔区 + 外银内金双描边 */
      var pg = x.createLinearGradient(0, 0, W * 0.85, H);
      pg.addColorStop(0, '#fcfdfe');
      pg.addColorStop(0.45, '#e9eef3');
      pg.addColorStop(1, '#d7e0e8');
      x.fillStyle = pg;
      x.fillRect(0, 0, W, H);

      if (im) {
        x.save();
        x.globalAlpha = 0.94;
        coverPhoto(x, im, 0, 0, W, H, t.zoom, t.fx, t.fy, t.crop);
        x.restore();
        x.fillStyle = 'rgba(255,255,255,.26)';
        x.fillRect(0, 0, W, H);
      }

      // 左侧银白渐变：深色文字压得住，又不至于把整张刷白
      var gl = x.createLinearGradient(0, 0, 252, 0);
      gl.addColorStop(0, 'rgba(252,253,254,.96)');
      gl.addColorStop(0.52, 'rgba(244,248,250,.78)');
      gl.addColorStop(1, 'rgba(244,248,250,0)');
      x.fillStyle = gl;
      x.fillRect(0, 0, 252, H);

      // 副券：银箔区（近乎不透明，条码才压得住；留一点透，还是同一张纸）
      x.fillStyle = 'rgba(238,244,249,.93)';
      x.fillRect(STUB, 0, W - STUB, H);
      var sg = x.createLinearGradient(STUB, 0, W, H);
      sg.addColorStop(0, 'rgba(198,214,227,.60)');
      sg.addColorStop(0.55, 'rgba(255,255,255,.34)');
      sg.addColorStop(1, 'rgba(208,222,234,.48)');
      x.fillStyle = sg;
      x.fillRect(STUB, 0, W - STUB, H);
      // 压痕：左缘亮线 + 右缘暗线
      x.fillStyle = 'rgba(255,255,255,.85)';
      x.fillRect(STUB, 0, 0.8, H);
      x.fillStyle = 'rgba(150,170,186,.30)';
      x.fillRect(STUB + 0.8, 0, 0.8, H);

      // 珠光纸细织纹（很淡，一层就够；太浓会像纱窗糊在人脸上）
      var k;
      x.save();
      x.globalAlpha = 0.10;
      x.strokeStyle = 'rgba(255,255,255,.9)';
      x.lineWidth = 0.45;
      for (k = -H; k < W + H; k += 4) {
        x.beginPath(); x.moveTo(k, 0); x.lineTo(k + H, H); x.stroke();
      }
      x.restore();

      // 对角高光（铜版纸反光）
      var hg = x.createLinearGradient(0, 0, W, H);
      hg.addColorStop(0, 'rgba(255,255,255,.48)');
      hg.addColorStop(0.30, 'rgba(255,255,255,0)');
      hg.addColorStop(0.70, 'rgba(255,255,255,0)');
      hg.addColorStop(1, 'rgba(255,255,255,.26)');
      x.fillStyle = hg;
      x.fillRect(0, 0, W, H);
    } else {
      // 深色款：整张压主题色 → 左侧深渐变 → 副券再压一层
      x.fillStyle = hexA(t.bg, 0.55);
      x.fillRect(0, 0, W, H);
      var g = x.createLinearGradient(0, 0, 268, 0);
      g.addColorStop(0, hexA(t.bg, 0.94));
      g.addColorStop(0.55, hexA(t.bg, 0.50));
      g.addColorStop(1, hexA(t.bg, 0));
      x.fillStyle = g;
      x.fillRect(0, 0, 268, H);
      x.fillStyle = hexA(t.bg, 0.40);
      x.fillRect(STUB, 0, W - STUB, H);
    }

    // 内框：浅色款走「外银 + 内金」双线，比单根金线精致
    if (t.light) {
      x.strokeStyle = 'rgba(136,156,172,.85)';
      x.lineWidth = 1;
      roundRect(x, 6.5, 6.5, W - 13, H - 13, 7);
      x.stroke();
      x.strokeStyle = 'rgba(150,116,60,.42)';
      x.lineWidth = 0.5;
      roundRect(x, 10.5, 10.5, W - 21, H - 21, 4.5);
      x.stroke();
    } else {
      x.strokeStyle = hexA(GOLD, 0.5);
      x.lineWidth = 0.6;
      roundRect(x, 6.5, 6.5, W - 13, H - 13, 7);
      x.stroke();
    }

    // 撕口
    x.save();
    x.strokeStyle = t.light ? 'rgba(110,132,150,.55)' : hexA(GOLD, 0.45);
    x.lineWidth = t.light ? 0.8 : 0.7;
    x.setLineDash(t.light ? [] : [2.5, 3.5]);
    x.beginPath();
    x.moveTo(STUB + 0.5, 16);
    x.lineTo(STUB + 0.5, H - 16);
    x.stroke();
    x.restore();

    // 主区
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

    x.fillStyle = CREAM;
    x.font = '600 18px ' + FONT;
    x.fillText(numText(daysLeft()), 34, 125);

    // 副券：11.28 / 条码 / 收藏编号
    var cx = (STUB + W) / 2;
    x.textAlign = 'center';

    x.fillStyle = CREAM;
    x.font = '600 23px ' + FONT;
    x.fillText('11.28', cx, 40);

    barcode(x, cx - 34, 68, 68, 34, 20261128, t.light ? 'rgba(38,56,68,.78)' : GOLD);

    x.fillStyle = MUTED;
    x.font = '400 8.5px ' + FONT;
    x.fillText('NO.' + pad4(serial || 1), cx, 124);

    x.textAlign = 'left';

    try {
      return c.toDataURL('image/png');
    } catch (err) {
      return '';
    }
  }

  /* --------------------------- 浮层 --------------------------- */
  var modal = null, pic = null, stage = null, rareEl = null, progEl = null;
  var saveBtn = null, drawBtn = null, url = '', drawing = false;

  function ensureModal() {
    if (modal) return;
    modal = document.createElement('div');
    modal.className = 'ms-modal';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="ms-sheet" role="dialog" aria-modal="true" aria-label="11.28 抽票根">' +
        '<div class="ms-stage" id="msStage">' +
          '<span class="ms-empty" aria-hidden="true">?</span>' +
          '<img class="ms-pic" id="msPic" alt="2026.11.28 首场定制公演 票根">' +
        '</div>' +
        '<div class="ms-head">' +
          '<span class="ms-rare" id="msRare" hidden></span>' +
          '<span class="ms-prog" id="msProg"></span>' +
        '</div>' +
        '<div class="ms-acts">' +
          '<button type="button" class="ms-btn primary" id="msDraw">抽一张</button>' +
          '<button type="button" class="ms-btn" id="msSave" disabled>保存图片</button>' +
          '<button type="button" class="ms-btn" id="msClose">关掉</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    pic = modal.querySelector('#msPic');
    stage = modal.querySelector('#msStage');
    rareEl = modal.querySelector('#msRare');
    progEl = modal.querySelector('#msProg');
    saveBtn = modal.querySelector('#msSave');
    drawBtn = modal.querySelector('#msDraw');

    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    modal.querySelector('#msClose').addEventListener('click', close);
    saveBtn.addEventListener('click', save);
    drawBtn.addEventListener('click', doDraw);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.hidden) close();
    });
  }

  // 只给稀有款贴一个小标签；常见款什么都不显示（站长：不写款名）
  function paintRare(t) {
    if (t.rare > 0) {
      rareEl.hidden = false;
      rareEl.textContent = t.rare === 2 ? '隐藏' : '稀有';
      rareEl.className = 'ms-rare' + (t.rare === 2 ? ' is-h' : ' is-r');
    } else {
      rareEl.hidden = true;
      rareEl.className = 'ms-rare';
    }
  }

  function updateProg() {
    var n = state.owned.length;
    progEl.textContent = n >= TOTAL
      ? '集齐 ' + TOTAL + ' / ' + TOTAL + ' · 已集齐'
      : (n ? '集齐 ' + n + ' / ' + TOTAL : '共 ' + TOTAL + ' 款');
    progEl.className = 'ms-prog' + (n >= TOTAL ? ' is-full' : '');
  }

  function renderTicket(t) {
    var serial = state.nums[t.key] || 1;
    url = drawTicket(t, serial);
    pic.src = url || '';
    stage.classList.add('has-ticket');

    paintRare(t);
    updateProg();
    saveBtn.disabled = !url;

    // 照片还没加载完 → 加载后重画这一款（避免抽出无照片的空票）
    var im = IMGS[t.key];
    if (im && !im._ok) {
      var on = function () {
        im.removeEventListener('load', on);
        if (state.last === t.key && !modal.hidden) renderTicket(t);
      };
      im.addEventListener('load', on);
    }
  }

  function showEmpty() {
    url = '';
    pic.removeAttribute('src');
    stage.classList.remove('has-ticket');
    rareEl.hidden = true;
    updateProg();
    saveBtn.disabled = true;
  }

  function openTicket() {
    ensureModal();
    var t = state.last ? themeOfKey(state.last) : null;
    if (t) renderTicket(t); else showEmpty();
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    trk('ms:open');
  }

  function doDraw() {
    if (drawing) return;
    drawing = true;
    drawBtn.disabled = true;
    drawBtn.textContent = '抽取中…';
    stage.classList.remove('has-ticket');
    stage.classList.add('is-drawing');

    setTimeout(function () {
      var t = drawOnce();
      renderTicket(t);
      stage.classList.remove('is-drawing');
      drawing = false;
      drawBtn.disabled = false;
      drawBtn.textContent = '再抽一张';
      trk('ms:draw');
    }, 430);
  }

  function close() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = '';
  }

  function save() {
    if (!url) return;
    // 🔴 2026-11-02 修：改用站内统一的「保存到相册」弹层（app.js 的 showAlbumLayer），
    // 跟站里其它「保存图片」行为一致 —— 手机端走系统分享面板 / 长按，直接进相册；
    // 绝不用 <a download>，那在手机上只会落进「文件」App 的下载文件夹、进不了相册
    // （站长 2026-09-23 定：凡是「保存到相册」按钮，点了就必须进相册）。
    // 没有 showAlbumLayer 时降级回 download，避免按钮失灵。
    if (typeof window.showAlbumLayer === 'function') {
      window.showAlbumLayer(url, MS.date.replace(/-/g, ''), '王语晨-1128-票根');
      return;
    }
    var a = document.createElement('a');
    a.href = url;
    a.download = '王语晨-1128-票根.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
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

  /* --------------------------- 启动 --------------------------- */
  function boot() {
    loadState();
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
