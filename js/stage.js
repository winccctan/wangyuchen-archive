/* ===== 舞台纪念页 · 在人间凑数的日子（独立页 stage.html）=====
 * 独立运行，不依赖 app.js / demo-features.js。
 * 寄语走 /api/stage-wishes（GET 公开读，POST 同源限流），KV 只存文字+署名+时间，无 uid。
 * 出图在本机 Canvas 合成，不上传。
 *
 * 本版（demo 试验）：
 *   ① 大屏模式 ?screen=1  —— 隐藏卡片/按钮，泡泡字号放大、同屏更多，右下角现场扫码二维码
 *   ② 星星随寄语变多      —— 24 颗起，每多一条寄语 +2 颗，封顶 96
 *   ③ 寄语成册            —— 本机 Canvas 排成 A4 多页图集（1080×1528 PNG），可翻页/长按保存/下载
 *   ④ 册子独立成页        —— ?book=1 打开就是整本，可单独分享链接；「‹ 返回舞台」回主页面
 *   ⑤ 入场仪式            —— 推门走进来的过场（黑场→光亮→一句淡话散开），只首次播一次
 *   ⑥ 寄语沉淀成光        —— 每条寄语化作一粒微光落进舞台，积成会呼吸的光点海
 *   ⑦ 深夜模式            —— 22:00–4:00 自动更暗/星星更多/光柱更暖（?night=1 白天可预览）
 */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  }); }
  // 稳定哈希：落点用文字算，刷新不跳位（纯展示，非隐私）
  function hash32(str) {
    var h = 2166136261 >>> 0;
    str = String(str || '');
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h;
  }

  var BG = [
    { f: './assets/stage-mvp.jpg', label: 'MVP定制公演', candle: 1 },  // 这张里有蜡烛 → 挂氛围光
    { f: './assets/wb-night.jpg', label: '夜色' },
    { f: './assets/wb-red.jpg', label: '热烈' },
    { f: './assets/wb-warm.jpg', label: '暖光' },
    { f: './assets/wb-silver.jpg', label: '银辉' }
  ];
  // 舞台瞬间（舞台语境，非剧情台词；含喊 call 应援、安可 Call 声）
  var MOMENTS = [
    { tag: '开场', title: '灯亮起来的那一刻', text: '在人间凑数的日子里，\n你是那个不凑数的例外。' },
    { tag: 'UNIT', title: '属于你的那支舞', text: '舞台就这么大，\n你站上去，就满了。' },
    { tag: '喊 call', title: '全场一起喊出你的名字', text: '这一声 call 是给你的，\n今晚的主角，是你。' },
    { tag: 'MVP', title: '年度 MVP 加冕', text: '这一年所有的努力，\n都在今晚闪闪发光。' },
    { tag: '安可', title: '最后的 Call 声', text: '歌会唱完，但这一声声 call，\n我会一直带在身上。' },
    { tag: '谢幕', title: '鞠躬，转身，灯暗', text: '散场了也别难过，\n因为下一次见面已经在路上。' }
  ];
  // 舞台氛围短句（星星；非访客寄语，不署名）
  var AMBIENT = ['GNZ48 · TEAM NIII', '2025 年度 MVP 定制公演', '11.28 星梦剧院', '喊 call 应援', '这一场 我们都在'];

  // 寄语来源：页面在正式域 → 同源；在演示域 → 直连生产（CORS 为 *，只读）。
  // 写：演示域不写生产（只存本机，避免把测试内容混进真实寄语墙）。
  var SELF_HOST = /(^|\.)wyc0518\.cc$/.test(location.hostname);
  var API = SELF_HOST ? './api/stage-wishes' : 'https://idol.wyc0518.cc/api/stage-wishes';
  var LOCAL_KEY = 'wyc-demo-stage-wishes-v1';
  var QR_URL = SELF_HOST ? (location.origin + '/stage.html') : 'https://idol.wyc0518.cc/stage.html';

  var bgIdx = 0, momentIdx = 0, wishes = [], collapsed = true;   // 默认收起：舞台画面干净 + 悬浮写寄语按钮常显
  var SIGN_KEY = 'wyc-stage-sign-v1';
  var isScreen = /[?&]screen=1(?:&|$)/.test(location.search);
  var isBook = /[?&]book=1(?:&|$)/.test(location.search);   // 独立册子页：只显示整本寄语集
  // 深夜模式：北京时间 22:00–4:00 自动开启；?night=1 白天强制预览，?day=1 强制白天
  var nightMode = (function () {
    if (/[?&]night=1(?:&|$)/.test(location.search)) return true;
    if (/[?&]day=1(?:&|$)/.test(location.search)) return false;
    var bjHour = (new Date(Date.now() + 28800000)).getUTCHours();
    return bjHour >= 22 || bjHour < 4;
  })();

  /* ---------- 背景 ---------- */
  function renderBg() {
    $('#stageBg').style.backgroundImage = 'url("' + BG[bgIdx].f + '")';
    var bar = $('#stageBgbar');
    bar.innerHTML = BG.map(function (x, i) {
      return '<button type="button" class="stage-bgdot' + (i === bgIdx ? ' on' : '') +
        '" data-bg="' + i + '" title="' + esc(x.label) + '" aria-label="' + esc(x.label) + '"></button>';
    }).join('');
    placeCandle();
  }

  /* ---------- 蜡烛氛围光定位 ----------
   * 原图 1020×1578，蜡烛中心约在 (28.1%, 52.9%)，宽 11.5% / 高 9.8%。
   * 必须按 background-size:cover + background-position:center 22% 反算屏幕坐标，
   * 才能和背景图里的蜡烛严格重合（改 CSS 的位置就同步改这里）。
   */
  var CANDLE = { u: 0.310, v: 0.540, w: 0.105, h: 0.130 };
  var CANDLE_W = 1020, CANDLE_H = 1578;
  function placeCandleIn(bg, c) {
    if (!bg || !c) return;
    var W = bg.clientWidth, H = bg.clientHeight;
    if (!W || !H) { c.style.display = 'none'; return; }
    var s = Math.max(W / CANDLE_W, H / CANDLE_H);              // cover
    var dw = CANDLE_W * s, dh = CANDLE_H * s;
    var ox = (W - dw) * 0.5;                                    // background-position x: center
    var oy = (H - dh) * 0.22;                                   // background-position y: 22%
    var cw = CANDLE.w * dw, ch = CANDLE.h * dh;
    c.style.display = 'block';
    c.style.width = cw + 'px';
    c.style.height = ch + 'px';
    c.style.left = (ox + CANDLE.u * dw - cw / 2) + 'px';
    c.style.top = (oy + CANDLE.v * dh - ch / 2) + 'px';
  }
  function placeCandle() {
    var bg = $('#stageBg'), c = $('#stageCandle');
    if (!bg || !c) return;
    if (!BG[bgIdx].candle) { c.style.display = 'none'; return; }
    placeCandleIn(bg, c);
  }

  /* ---------- 名场面卡 ----------
   * 骨架只建一次；切换名场面只改 chip/title/quote 三个文字节点，
   * 寄语列表和按钮不重建 ⇒ 卡片高度不变、页面不跳动。
   */
  function buildCard() {
    $('#stageCardBody').innerHTML =
      '<div class="stage-card-meta"><span class="stage-card-chip" id="mChip"></span><b id="mTitle"></b></div>' +
      '<div class="stage-card-quote" id="mQuote"></div>' +
      '<div class="stage-wish-list">' +
        '<div class="stage-wish-list-hd"><span class="swl-title">💌 大家写下的舞台寄语 <span id="wishTotal"></span></span>' +
        '<button class="swl-book" type="button" id="wishBook">📖 成册</button></div>' +
        '<div class="stage-wish-scroll" id="wishScroll"></div></div>' +
      '<div class="stage-card-foot"><button class="stage-next" type="button" id="stageNext">💧 下一场</button>' +
      '<button class="stage-write" type="button" id="stageWrite">✍️ 写应援寄语</button></div>';
    $('#stageNext').addEventListener('click', function (e) { e.preventDefault(); switchMoment(1); });
    $('#stageWrite').addEventListener('click', openWrite);
    $('#wishBook').addEventListener('click', function (e) { e.preventDefault(); makeBook(); });
  }
  function renderMoment() {
    var m = MOMENTS[momentIdx];
    $('#mChip').textContent = m.tag;
    $('#mTitle').textContent = m.title;
    $('#mQuote').innerHTML = String(m.text).split('\n').map(esc).join('<br>');
  }
  function switchMoment(delta) {
    momentIdx = (momentIdx + delta + MOMENTS.length) % MOMENTS.length;
    renderMoment();   // 只更新文字，卡片高度不变
  }
  function renderCard() { renderMoment(); renderWishList(); }

  /* ---------- 寄语列表（可滚动） ---------- */
  function timeStr(d) {
    var n = Number(d) || 0; if (!n) return '';
    var dt = new Date(n);
    return (dt.getMonth() + 1) + '.' + dt.getDate();
  }
  function renderWishList() {
    var box = $('#wishScroll'); if (!box) return;
    var total = $('#wishTotal');
    if (total) total.textContent = wishes.length ? '(' + wishes.length + ')' : '';
    if (!wishes.length) {
      box.innerHTML = '<div class="stage-wish-empty">还没有人写寄语，来做第一个吧 ✨</div>';
      return;
    }
    box.innerHTML = wishes.map(function (w) {
      return '<div class="stage-wish-item"><span class="swi-ico">🐟</span>' +
        '<span class="swi-txt">' + esc(w.t) + '</span>' +
        (w.s ? '<span class="swi-sign">— ' + esc(w.s) + '</span>' : '') +
        (w.d ? '<span class="swi-date">' + esc(timeStr(w.d)) + '</span>' : '') + '</div>';
    }).join('');
  }

  /* ---------- 星星（随寄语数量增长）/ 小鱼泡泡浮层 ---------- */
  var STAR_BASE = 24, STAR_MAX = 96;
  var skyTimer = null;
  function starTarget() {
    var base = STAR_BASE + wishes.length * 2;
    if (nightMode) base = Math.round(base * 1.6);   // 深夜星星更多
    return Math.min(STAR_MAX, base);
  }
  function makeStar() {
    var sl = 3 + Math.random() * 94, st = 4 + Math.random() * 78;
    var sd = (2 + Math.random() * 3.6).toFixed(1);
    var el = document.createElement('span');
    el.className = 'stage-star';
    el.style.left = sl + '%'; el.style.top = st + '%';
    el.style.setProperty('--sd', sd + 's');
    return el;
  }
  // 只补不删：寄语变多时星星增多，已有星星不重建（避免闪烁）
  function syncStars() {
    var box = $('#stageStars'); if (!box) return;
    var target = starTarget(), cur = box.children.length;
    for (var i = cur; i < target; i++) box.appendChild(makeStar());
  }
  // 泡泡池：氛围短句（⭐）+ 全部访客寄语（🐟），不截断（长祝福一条不落）
  function bubblePool() {
    var pool = AMBIENT.map(function (s) { return { ico: '⭐', t: s, s: '' }; });
    wishes.forEach(function (w) { pool.push({ ico: '🐟', t: w.t, s: w.s || '' }); });
    return pool;
  }
  // 循环游标：所有寄语按顺序一条接一条轮流上屏（纯轮询，非随机），一直循环
  var bubbleCursor = 0;
  // 生成一个泡泡：从底部升起 → 飘到顶部淡出 → 自动移除
  // age（秒，可选）：负动画延迟 = 让它「已经升了这么久」，用于大屏模式一开画面就不空
  function spawnBubble(age) {
    var float = $('#stageSkyFloat'); if (!float) return;
    var pool = bubblePool(); if (!pool.length) return;
    // 同屏上限 = min(普通 12 / 大屏 18, 池子大小)：寄语多时热闹，寄语少时不重复
    var skyMax = Math.min(isScreen ? 18 : 12, pool.length);
    if (float.querySelectorAll('.wish-bubble').length >= skyMax) return;
    // 从游标位置顺序找一条「当前不在屏上」的；若全在屏上（寄语很少）就强制取游标那条，保证一直滚
    var shown = Array.prototype.map.call(float.querySelectorAll('.wish-bubble'), function (n) { return n.getAttribute('data-t'); });
    var item = null, start = bubbleCursor % pool.length;
    for (var k = 0; k < pool.length; k++) {
      var cand = pool[(start + k) % pool.length];
      if (shown.indexOf(cand.t) < 0) { item = cand; bubbleCursor = (start + k + 1) % pool.length; break; }
    }
    if (!item) { item = pool[start]; bubbleCursor = (start + 1) % pool.length; }
    // 水平位置：普通模式全幅随机；大屏模式偏向两侧（中间是她本人，少压脸）
    var left;
    if (isScreen) {
      var rr = Math.random();
      left = rr < .44 ? (1 + Math.random() * 24)          // 左带 1~25%
           : rr < .86 ? (58 + Math.random() * 24)         // 右带 58~82%
           : (30 + Math.random() * 22);                   // 中间 30~52%（少量，保持热闹）
    } else {
      left = 3 + Math.random() * 70;
    }
    var dur = (isScreen ? 16 : 13) + Math.random() * 8;   // 上浮 13~24s（长句慢慢滚，看得清全文）
    var dx = Math.round(Math.random() * 40 - 20);   // 左右轻摆
    var el = document.createElement('span');
    el.className = 'wish-bubble';
    el.setAttribute('data-t', item.t);
    el.style.left = left + '%';
    el.style.setProperty('--dur', dur.toFixed(1) + 's');
    el.style.setProperty('--dx', dx + 'px');
    var aged = Number(age) || 0;
    if (aged > 0) el.style.animationDelay = '-' + aged.toFixed(1) + 's';
    // 全文显示：长句换行不缩写；署名放第二行
    el.innerHTML = '<span class="wico">' + item.ico + '</span><span class="wtxt">' + esc(item.t) +
      (item.s ? '<span class="wsign">\n— ' + esc(item.s) + '</span>' : '') + '</span>';
    float.appendChild(el);
    var life = Math.max(0.8, dur - aged + 0.5) * 1000;
    setTimeout(function () {
      if (!el.parentNode) return;
      bubbleToLight(el);   // 飘完化作一粒暖光落下（视觉连续）
      el.parentNode.removeChild(el);
    }, life);
  }
  function renderSky() {
    var sky = $('#stageSky'); if (!sky) return;
    // 星星点点 + 泡泡容器只初始化一次，不被后续数据刷新打断
    if (!$('#stageStars')) {
      var sdiv = document.createElement('div'); sdiv.id = 'stageStars';
      sky.appendChild(sdiv);
      var fdiv = document.createElement('div'); fdiv.id = 'stageSkyFloat'; fdiv.className = 'stage-sky-float';
      sky.appendChild(fdiv);
      // 点一颗星星 → 从寄语里随机抽一条，在那颗星星的位置展开一句话（事件委托，星星增删/刷新都有效）
      sdiv.addEventListener('click', function (e) {
        var st = e.target.closest('.stage-star');
        if (st) revealFromStar(st);
      });
    }
    syncStars();
    if (isScreen) {
      // 投屏：先撒几个「已经升到半空」的，一开画面就铺满，不用等它们慢慢升上来
      for (var a = 0; a < 6; a++) {
        (function (aa) { setTimeout(function () { spawnBubble(3 + aa * 2.4); }, aa * 30); })(a);
      }
      for (var b2 = 0; b2 < 6; b2++) setTimeout(spawnBubble, b2 * 700);
    } else {
      for (var j = 0; j < 8; j++) setTimeout(spawnBubble, j * 500);
    }
    if (!skyTimer) skyTimer = setInterval(spawnBubble, isScreen ? 1500 : 1400);
  }

  /* ---------- C. 寄语沉淀成光：泡泡飘完化作一粒暖光落进舞台，积成会呼吸的光点海 ----------
   * 🔴 用户指出「消失变光点」的效果没有 —— 之前是进页面就撒好一堆点，只有结果没有过程。
   *    现在：基底只铺少量装饰点（不空屏）；真正的「积成星海」靠每个泡泡飘到顶消失时，
   *    从它的位置落下一粒光点（bubbleToLight），刚寄出的那句也从字幕落一粒（dropSediment）。
   * 落点用文字哈希算 → 刷新不跳位；落在画面下段（像台下举起的星海），卡片在其上不重叠。
   * 只增不重建：一句只化一次光，已化的不再重复（避免闪烁/刷屏）。 */
  function sdTopFor(key) { return (62 + ((hash32(key) >>> 7) % 26)).toFixed(1) + '%'; }
  function sdLeftFor(key) { return (4 + (hash32(key) % 88)).toFixed(1) + '%'; }
  function sdSeen(box, key) {
    var dup = false;
    Array.prototype.forEach.call(box.children, function (n) { if (n.getAttribute('data-t') === key) dup = true; });
    return dup;
  }
  // 基底：少量装饰点（纯氛围），让首屏不那么空；真正的星海由泡泡转化而来
  function renderSediment() {
    var sky = $('#stageSky'); if (!sky) return;
    var box = $('#stageSediment');
    if (!box) {
      box = document.createElement('div'); box.id = 'stageSediment'; box.className = 'stage-sediment';
      sky.appendChild(box);
      // 光点也可点击：跟星星一样随机弹一句寄语（事件委托，点增删/刷新都有效）
      box.addEventListener('click', function (e) {
        var d = e.target.closest('.sd-dot');
        if (d) revealFromStar(d);
      });
    }
    var baseCount = nightMode ? 16 : 10;   // 夜里基础更密
    var have = 0;
    Array.prototype.forEach.call(box.children, function (n) {
      if (String(n.getAttribute('data-t') || '').indexOf('base-') === 0) have++;
    });
    for (var i = have; i < baseCount; i++) {
      var el = document.createElement('i');
      el.className = 'sd-dot';
      el.setAttribute('data-t', 'base-' + i);
      el.style.left = (4 + Math.random() * 88).toFixed(1) + '%';
      el.style.top = (62 + Math.random() * 24).toFixed(1) + '%';
      el.style.animationDelay = (Math.random() * 4.6).toFixed(2) + 's';
      box.appendChild(el);
    }
  }
  // 泡泡飘到顶消失的那一下：从它所在列落下一粒光点（视觉连续：泡泡上去 → 光点落下）
  function bubbleToLight(el) {
    var key = el.getAttribute('data-t'); if (!key) return;
    var box = $('#stageSediment'); if (!box) return;
    var cap = (isScreen ? 220 : 140) + (nightMode ? 40 : 0);
    if (box.children.length >= cap) return;
    if (sdSeen(box, key)) return;                      // 这句已化过光，不重复落
    var d = document.createElement('i');
    d.className = 'sd-dot sd-drop';
    d.setAttribute('data-t', key);
    d.style.left = el.style.left || sdLeftFor(key);    // 同列落下，视觉连续
    d.style.top = sdTopFor(key);
    d.style.animationDelay = '0s, ' + (Math.random() * 4.6).toFixed(2) + 's';
    box.appendChild(d);
  }
  // 刚寄出的那句：从字幕位置落下来，有个「被放下」的动作
  function dropSediment(rec) {
    var box = $('#stageSediment'); if (!box) return;
    var key = rec.t || ''; if (!key) return;
    if (sdSeen(box, key)) return;
    var el = document.createElement('i');
    el.className = 'sd-dot sd-new';
    el.setAttribute('data-t', key);
    el.style.left = sdLeftFor(key);
    el.style.top = sdTopFor(key);
    el.style.animationDelay = '0s, 2.1s';
    box.appendChild(el);
  }

  /* ---------- 点星星：随机展开一句寄语（用现有 wishes 池，零写入） ---------- */
  function revealFromStar(star) {
    var sky = $('#stageSky'); if (!sky) return;
    // 候选池：访客寄语优先；一条都没有就退回氛围短句
    var pool = wishes.slice();
    if (!pool.length) pool = AMBIENT.map(function (s) { return { t: s, s: '' }; });
    if (!pool.length) { toast('还没有寄语，先写一条吧'); return; }
    var w = pool[Math.floor(Math.random() * pool.length)];
    var sr = star.getBoundingClientRect(), skyR = sky.getBoundingClientRect();
    // 星星在舞台内的像素坐标
    var sx = sr.left - skyR.left, sy = sr.top - skyR.top;
    var vw = skyR.width, vh = skyR.height;
    // 水平：永远居中（卡片最宽 400，左右各留 16px 安全，居中绝不溢出）；垂直：随星星但夹在安全区
    var cx = vw / 2;
    var cy = Math.min(vh * 0.64, Math.max(64, sy + 14));
    var el = document.createElement('span');
    el.className = 'star-wish';
    el.style.left = cx + 'px';
    el.style.top = cy + 'px';
    el.innerHTML = '<span class="wico">⭐</span><span class="wtxt">' + esc(w.t) +
      (w.s ? '<span class="wsign">\n— ' + esc(w.s) + '</span>' : '') + '</span>';
    sky.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 4600);
  }

  /* ---------- 读取寄语（生产数据 + 本机新增） ---------- */
  function localWishes() {
    try { var a = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function localAdd(rec) {
    var a = localWishes(); a.unshift(rec);
    if (a.length > 50) a.length = 50;
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(a)); return true; } catch (e) { return false; }
  }
  function loadWishes() {
    fetch(API + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { wishes: [] }; })
      .then(function (j) { mergeWishes(Array.isArray(j.wishes) ? j.wishes : []); })
      .catch(function () { mergeWishes([]); });
  }
  function mergeWishes(remote) {
    // 演示站把本机写的也并进来；正式站不并（服务端已是真源，并了会重复）
    var mine = SELF_HOST ? [] : localWishes();
    // 本机写的排前面（最新），避免和服务端同文重复显示
    var seen = {};
    wishes = mine.concat(remote.filter(function (w) {
      var sig = (w.t || '') + '|' + (w.d || '');
      if (seen[sig]) return false; seen[sig] = 1; return true;
    }));
    renderWishList(); renderSky(); renderSediment();
    // 独立册子页：数据到了就直接排版成册；一条都没有就退回舞台页，别留个空页面
    if (isBook) setTimeout(function () {
      if (!wishes.length) {
        toast('册子里还没有寄语');
        setTimeout(function () { location.href = stageUrl(); }, 1400);
        return;
      }
      makeBook();
    }, 60);
  }

  /* ---------- 写寄语弹窗 ---------- */
  function openWrite() {
    var saved = '';
    try { saved = localStorage.getItem(SIGN_KEY) || ''; } catch (e) {}
    $('#stgSign').value = saved;
    $('#stgText').value = '';
    $('#stgCount').textContent = '0/60';
    $('#stgMsg').textContent = '';
    $('#stgMask').classList.add('on');
    setTimeout(function () { $('#stgText').focus(); }, 60);
  }
  function closeWrite() { $('#stgMask').classList.remove('on'); }

  function submitWish() {
    var text = ($('#stgText').value || '').trim();
    var sign = ($('#stgSign').value || '').trim();
    var msg = $('#stgMsg');
    if (!text) { msg.textContent = '先写一句应援寄语吧'; return; }
    if (msg.textContent === '寄出中…') return;
    msg.style.color = '#8a97a4'; msg.textContent = '寄出中…';
    try { localStorage.setItem(SIGN_KEY, sign); } catch (e) {}

    var rec = { t: text, s: sign, d: Date.now() };
    var done = function (ok, errText, dup) {
      if (!ok) { msg.style.color = '#c0392b'; msg.textContent = errText || '寄出失败，稍后再试'; return; }
      if (SELF_HOST) {
        // 正式站：服务端就是真源，不写本机缓存（写了刷新后自己那条会出现两遍）
        if (!dup) wishes.unshift(rec);
      } else {
        localAdd(rec);          // 演示站：不写生产，只记本机（存不下也要先上屏一次）
        wishes.unshift(rec);
      }
      if (wishes.length > 200) wishes.length = 200;
      renderWishList(); renderSky(); renderSediment(); dropSediment(rec);
      closeWrite();
      makeCard(text, sign);
    };

    if (SELF_HOST) {
      // 正式站：真写入 KV
      fetch(API, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ t: text, s: sign })
      }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, j: j }; });
      }).then(function (res) {
        done(res.ok, res.j && res.j.error, res.j && res.j.dup);
      }).catch(function () { done(false, '网络出了点问题，稍后再试'); });
    } else {
      // 演示站：不写生产，只记在本机（刷新后仍在，不会污染真实寄语墙）
      setTimeout(function () { done(true); }, 260);
    }
  }

  /* ---------- 本机出图（不上传） ---------- */
  // Canvas 里别用 -apple-system（canvas 不认这个 CSS 关键字，会整串失效回落到默认字体）
  var F_SANS = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif';
  function makeCard(wish, sign) {
    var bg = BG[bgIdx];
    var img = new Image();
    img.onload = function () {
      try {
        var W = 900, H = Math.round(W * img.naturalHeight / img.naturalWidth);
        var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        var c = cv.getContext('2d');
        c.drawImage(img, 0, 0, W, H);
        var gTop = c.createLinearGradient(0, 0, 0, H * 0.4);
        gTop.addColorStop(0, 'rgba(8,10,18,.78)'); gTop.addColorStop(1, 'rgba(8,10,18,0)');
        c.fillStyle = gTop; c.fillRect(0, 0, W, H * 0.4);
        var gBot = c.createLinearGradient(0, H * 0.45, 0, H);
        gBot.addColorStop(0, 'rgba(8,10,18,0)'); gBot.addColorStop(1, 'rgba(8,10,18,.92)');
        c.fillStyle = gBot; c.fillRect(0, H * 0.45, W, H * 0.55);
        c.textAlign = 'center'; c.textBaseline = 'alphabetic';
        c.fillStyle = 'rgba(255,224,170,.92)'; c.font = '600 22px ' + F_SANS;
        c.fillText('✦  舞 台 现 场  ·  在 人 间 凑 数 的 日 子', W / 2, 62);
        var chars = Array.from(wish), maxW = W - 120, line = '', lines = [];
        c.font = '600 44px ' + F_SANS;
        for (var m = 0; m < chars.length; m++) {
          var ch = chars[m];
          if (ch === '\n') { lines.push(line); line = ''; continue; }
          var test = line + ch;
          if (c.measureText(test).width > maxW && line && NO_HEAD.indexOf(ch) < 0) { lines.push(line); line = ch; }
          else line = test;
        }
        if (line) lines.push(line);
        lines = lines.slice(0, 4);
        var lh = 62, y = H - 210 - (lines.length - 1) * lh;
        c.fillStyle = '#fff'; c.shadowColor = 'rgba(0,0,0,.5)'; c.shadowBlur = 12;
        c.font = '600 44px ' + F_SANS;
        lines.forEach(function (ln) { c.fillText(ln, W / 2, y); y += lh; });
        c.shadowBlur = 0;
        c.strokeStyle = 'rgba(255,255,255,.4)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(W / 2 - 60, H - 118); c.lineTo(W / 2 + 60, H - 118); c.stroke();
        c.fillStyle = 'rgba(255,255,255,.86)'; c.font = '400 24px ' + F_SANS;
        c.fillText(sign ? ('—— ' + sign) : '—— 一个陪你追舞台的人', W / 2, H - 78);
        c.fillStyle = 'rgba(255,224,170,.72)'; c.font = '400 19px ' + F_SANS;
        c.fillText('王语晨 · 2025 年度 MVP 定制公演 · 11.28', W / 2, H - 40);
        showAlbum(cv.toDataURL('image/jpeg', 0.94));
      } catch (e) { toast('生成失败，换张背景再试'); }
    };
    img.onerror = function () { toast('背景加载失败，换一张再试'); };
    img.src = bg.f;
  }

  /* ---------- 寄语成册（A4 多页图集，本机合成） ----------
   * 1080×1528（A4 比例）：手机预览缩到 390 宽时正文还有 12px+，不会糊成一坨。
   * 每页按可用高度把条目间距均分，避免底部大片空白。
   */
  var BOOK_W = 1080, BOOK_H = 1528, BOOK_PAD = 84;
  var bookPages = [], bookIdx = 0;

  function rrect(c, x, y, w, h, r) {
    if (w < 2 * r) r = w / 2; if (h < 2 * r) r = h / 2;
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }
  // 按可用宽度逐字换行（中文可断任意处）
  // 🔴 标点不能出现在行首（「。」单独占一行很难看）：遇到收尾标点直接跟上，宁可这行多一个字
  var NO_HEAD = '，。、！？：；）」』】》…—,.;:!?)]}';
  function wrapText(c, text, maxW) {
    var chars = Array.from(String(text || '')), lines = [], line = '';
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      if (ch === '\n') { lines.push(line); line = ''; continue; }
      var test = line + ch;
      if (c.measureText(test).width > maxW && line && NO_HEAD.indexOf(ch) < 0) { lines.push(line); line = ch; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }

  var F_BODY = '400 38px ' + F_SANS;    // 正文（1080 宽画布；手机全宽预览时约 12.6px，清楚）
  var F_SIGN = '400 23px ' + F_SANS;    // 署名（比正文小一档，别抢正文）
  var F_META = '400 24px ' + F_SANS;    // 日期 / 页脚
  var BODY_LH = 58;                     // 正文行高
  var SIGN_GAP = 26;                    // 正文 → 署名
  var ITEM_MIN_GAP = 52;                // 条与条之间最小间隔（别挤在一起）

  // 量一条寄语：正文换行后的行 + 署名区高度
  function measureWish(ctx, w) {
    ctx.font = F_BODY;
    var lines = wrapText(ctx, w.t, BOOK_W - BOOK_PAD * 2);
    return { lines: lines, h: lines.length * BODY_LH + SIGN_GAP + 34 };
  }

  function drawWishBlock(ctx, w, y, lines, showDate) {
    var x = BOOK_PAD;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.font = F_BODY; ctx.fillStyle = '#eef3ff';
    for (var i = 0; i < lines.length; i++) ctx.fillText(lines[i], x, y + i * BODY_LH);
    var sy = y + lines.length * BODY_LH + SIGN_GAP;
    ctx.font = F_SIGN; ctx.fillStyle = 'rgba(255,217,138,.6)';
    ctx.fillText(w.s ? ('—— ' + w.s) : '—— 一个陪你追舞台的人', x, sy);
    if (w.d && showDate !== false) {
      ctx.font = F_META; ctx.fillStyle = 'rgba(255,255,255,.3)';
      ctx.textAlign = 'right';
      ctx.fillText(timeStr(w.d), BOOK_W - BOOK_PAD, sy + 3);
      ctx.textAlign = 'left';
    }
    return sy + 34;
  }

  function bookPageBase(ctx) {
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#0d1018'; ctx.fillRect(0, 0, BOOK_W, BOOK_H);
    var g = ctx.createLinearGradient(0, 0, BOOK_W, BOOK_H * 0.5);
    g.addColorStop(0, 'rgba(60,42,20,.42)');
    g.addColorStop(.5, 'rgba(18,22,36,.2)');
    g.addColorStop(1, 'rgba(13,16,24,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, BOOK_W, BOOK_H * 0.5);
  }
  function bookFooter(ctx, pageNo, pageTotal) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.font = F_META;
    ctx.fillStyle = 'rgba(255,224,170,.6)';
    ctx.fillText('王语晨 · 2025 年度 MVP 定制公演 · 11.28', BOOK_W / 2, BOOK_H - 80);
    ctx.fillStyle = 'rgba(255,255,255,.28)';
    ctx.fillText(pageNo + ' / ' + pageTotal, BOOK_W / 2, BOOK_H - 44);
    ctx.textAlign = 'left';
  }

  function makeBook() {
    if (!wishes.length) { toast('还没有寄语，先写一条吧'); return; }
    toast('正在排版…');
    var img = new Image();
    img.onload = function () {
      try { buildBookPages(img); }
      catch (e) { toast('生成失败，稍后再试'); }
    };
    img.onerror = function () { try { buildBookPages(null); } catch (e) { toast('生成失败'); } };
    img.src = BG[0].f;
  }

  function buildBookPages(coverImg) {
    var list = wishes.slice();             // 全部寄语，按现有顺序（最新在前）
    var pages = [], ctxs = [];

    // —— 先分页（只测量，不画）——
    // 🔴 占用高度必须把「条间最小间隔」算进去，否则会看到满页塞进 8 条、最后几条跑到页脚外面
    var tmp = document.createElement('canvas').getContext('2d');
    var top = 186, bottom = BOOK_H - 190;   // 页脚上方留足呼吸空间
    var avail = bottom - top;
    var items = list.map(function (w) {
      var m = measureWish(tmp, w);
      return { w: w, lines: m.lines, h: m.h };
    });
    var groups = [], cur = [], sumH = 0, used = 0;
    for (var i = 0; i < items.length; i++) {
      var need = items[i].h + (cur.length ? ITEM_MIN_GAP : 0);
      if (used + need > avail && cur.length) {
        groups.push({ items: cur, sumH: sumH });
        cur = []; sumH = 0; used = 0;
        need = items[i].h;
      }
      cur.push(items[i]); sumH += items[i].h; used += need;
    }
    if (cur.length) groups.push({ items: cur, sumH: sumH });

    var total = groups.length + 1;   // + 封面

    // —— 封面 ——
    var cv0 = document.createElement('canvas'); cv0.width = BOOK_W; cv0.height = BOOK_H;
    var c0 = cv0.getContext('2d');
    if (coverImg) {
      var s = Math.max(BOOK_W / coverImg.naturalWidth, BOOK_H / coverImg.naturalHeight);
      var dw = coverImg.naturalWidth * s, dh = coverImg.naturalHeight * s;
      c0.drawImage(coverImg, (BOOK_W - dw) / 2, (BOOK_H - dh) * 0.22, dw, dh);
    } else {
      c0.fillStyle = '#0d1018'; c0.fillRect(0, 0, BOOK_W, BOOK_H);
    }
    var gTop = c0.createLinearGradient(0, 0, 0, BOOK_H * 0.45);
    gTop.addColorStop(0, 'rgba(8,10,18,.86)'); gTop.addColorStop(1, 'rgba(8,10,18,0)');
    c0.fillStyle = gTop; c0.fillRect(0, 0, BOOK_W, BOOK_H * 0.45);
    var gBot = c0.createLinearGradient(0, BOOK_H * 0.42, 0, BOOK_H);
    gBot.addColorStop(0, 'rgba(8,10,18,0)'); gBot.addColorStop(1, 'rgba(8,10,18,.95)');
    c0.fillStyle = gBot; c0.fillRect(0, BOOK_H * 0.42, BOOK_W, BOOK_H * 0.58);

    c0.textAlign = 'center'; c0.textBaseline = 'alphabetic';
    c0.fillStyle = 'rgba(255,224,170,.94)';
    c0.font = '600 30px ' + F_SANS;
    c0.fillText('✦  舞 台 寄 语 集', BOOK_W / 2, 168);
    c0.fillStyle = '#fff';
    c0.font = '700 92px ' + F_SANS;
    c0.fillText('在人间凑数的日子', BOOK_W / 2, BOOK_H - 552);
    c0.font = '400 32px ' + F_SANS;
    c0.fillStyle = 'rgba(255,255,255,.8)';
    c0.fillText('王语晨 · 2025 年度 MVP 定制公演 · 11.28', BOOK_W / 2, BOOK_H - 486);

    c0.strokeStyle = 'rgba(255,255,255,.28)'; c0.lineWidth = 1;
    c0.beginPath(); c0.moveTo(BOOK_W / 2 - 96, BOOK_H - 424); c0.lineTo(BOOK_W / 2 + 96, BOOK_H - 424); c0.stroke();

    c0.fillStyle = '#ffd98a';
    c0.font = '700 52px ' + F_SANS;
    c0.fillText('共 ' + list.length + ' 条寄语', BOOK_W / 2, BOOK_H - 340);

    // 日期范围
    var ds = list.filter(function (w) { return w.d; }).map(function (w) { return Number(w.d); });
    if (ds.length) {
      var minD = new Date(Math.min.apply(null, ds)), maxD = new Date(Math.max.apply(null, ds));
      var fmt = function (d) { return d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate()); };
      c0.fillStyle = 'rgba(255,255,255,.56)';
      c0.font = '400 24px ' + F_SANS;
      var f1 = fmt(minD), f2 = fmt(maxD);
      c0.fillText(f1 === f2 ? f1 : (f1 + ' — ' + f2), BOOK_W / 2, BOOK_H - 282);
    }
    c0.fillStyle = 'rgba(255,224,170,.6)';
    c0.font = '400 23px ' + F_SANS;
    c0.fillText('写在这一个舞台上，也留给以后翻看的我们', BOOK_W / 2, BOOK_H - 108);
    c0.textAlign = 'left';
    pages.push(cv0.toDataURL('image/jpeg', 0.97));   // 封面是真人照片，压太狠会糊

    // —— 内容页 ——
    for (var g = 0; g < groups.length; g++) {
      var G = groups[g], n = G.items.length;
      var cv = document.createElement('canvas'); cv.width = BOOK_W; cv.height = BOOK_H;
      var c = cv.getContext('2d');
      bookPageBase(c);
      // 页头
      c.textAlign = 'center'; c.textBaseline = 'alphabetic';
      c.fillStyle = 'rgba(255,224,170,.9)';
      c.font = '600 26px ' + F_SANS;
      c.fillText('✦  舞台寄语 · 第 ' + (g + 1) + ' 页', BOOK_W / 2, 98);
      c.textAlign = 'left';
      c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(BOOK_PAD, 132); c.lineTo(BOOK_W - BOOK_PAD, 132); c.stroke();

      // 条目间距：本页剩余高度均分给条与条之间（上限 120），余下的留白上下平分 ⇒ 每页都居中
      var gap = n > 1 ? Math.min(120, (avail - G.sumH) / (n - 1)) : 0;
      var contentH = G.sumH + gap * (n - 1);
      var yy = top + Math.max(0, (avail - contentH) / 2);
      for (var j = 0; j < n; j++) {
        // 连续同一天只标一次日期（比的是显示出来的「11.20」，不是原始时间戳）
        var showDate = j === 0 || timeStr(G.items[j].w.d) !== timeStr(G.items[j - 1].w.d);
        drawWishBlock(c, G.items[j].w, yy, G.items[j].lines, showDate);
        yy += G.items[j].h + gap;
      }
      // 末页收个尾：留白多的时候在下方打个「✦ + 谢谢」，不让最后一页空得突兀
      if (g === groups.length - 1) {
        var restTop = yy - gap, rest = bottom - restTop;
        if (rest > 150) {
          var cy = restTop + Math.min(rest * 0.58, 300);
          c.textAlign = 'center'; c.textBaseline = 'alphabetic';
          c.fillStyle = 'rgba(255,224,170,.5)'; c.font = '400 32px ' + F_SANS;
          c.fillText('✦', BOOK_W / 2, cy);
          c.fillStyle = 'rgba(255,255,255,.38)'; c.font = '400 24px ' + F_SANS;
          c.fillText('谢谢每一个写下这些话的你', BOOK_W / 2, cy + 52);
          c.textAlign = 'left';
        }
      }
      bookFooter(c, g + 2, total);
      pages.push(cv.toDataURL('image/jpeg', 0.95));
    }

    showBook(pages);
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /* ---------- 预览层（单图 / 多页） ---------- */
  function isMobile() { return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent); }
  function setAlbumTitle(t) { var el = $('#stgAlbumTitle'); if (el) el.textContent = t; }
  function stageUrl() {
    var m = location.search.match(/[?&]sharecode=([^&]+)/);
    return './stage.html' + (m ? '?sharecode=' + m[1] : '');
  }
  // 分享出去的册子链接：保留 sharecode（演示站没有它会被 403），生产站自然就没有这一段
  function bookShareUrl() {
    var m = location.search.match(/[?&]sharecode=([^&]+)/);
    var base = /stage\.html$/.test(location.pathname)
      ? location.origin + location.pathname
      : location.origin + location.pathname.replace(/[^/]*$/, '') + 'stage.html';
    return base + '?book=1' + (m ? '&sharecode=' + m[1] : '');
  }
  function dataUrlToBlob(u) {
    var parts = String(u).split(','), mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/png';
    var bin = atob(parts[1]), len = bin.length, arr = new Uint8Array(len);
    for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  /* ---------- 分享面板 ----------
   * 之前「分享」只有：系统面板 / 静默复制链接 → 微信里经常既不弹面板也复制不到，
   * 用户就看不到链接。改成所有分享入口都先开这个面板：二维码 + 完整链接 + 复制按钮，
   * 面板里再提供「发当前页图片」走系统分享。任何环境都至少拿得到链接。
   */
  function buildShareQr(u) {
    var box = $('#stgShareQr'); if (!box) return;
    var html = '';
    if (typeof qrcode === 'function') {
      try {
        var q = qrcode(0, 'M'); q.addData(u); q.make();
        html = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      } catch (e) { html = ''; }
    }
    box.innerHTML = html || '<div style="color:#333;font-size:11px;line-height:150px">二维码<br>生成失败</div>';
  }
  function openShare() {
    var u = bookShareUrl();
    var box = $('#stgShareUrl');
    if (box) box.textContent = u;
    buildShareQr(u);
    $('#stgShare').classList.add('on');
  }
  function closeShare() { $('#stgShare').classList.remove('on'); }
  // 复制：Clipboard API 优先，失败退回 Range 选中 + execCommand（微信 iOS 里只有后者常可用）
  function copyShareLink() {
    var box = $('#stgShareUrl'); if (!box) return;
    var u = (box.textContent || '').trim();
    var ok = function () { toast('链接已复制'); };
    var pick = function () {
      try {
        var r = document.createRange(); r.selectNodeContents(box);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        document.execCommand('copy') ? ok() : toast('请长按链接手动复制');
      } catch (e) { toast('请长按链接手动复制'); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(u).then(ok, pick);
    } else { pick(); }
  }
  // 只发当前页图片（面板里的次级动作）；发不了就退成下载
  function sharePageImage() {
    var url = bookPages[bookIdx] || ($('#stgAlbumImg') || {}).src;   // 单张纪念卡也能发
    if (!url) { toast('这一页还没有图'); return; }
    var link = bookShareUrl();
    var blob = dataUrlToBlob(url);
    var ext = /jpe?g/.test(blob.type) ? 'jpg' : 'png';
    var name = (bookIdx === 0 ? '舞台寄语集-封面' : '舞台寄语集-第' + bookIdx + '页') + '.' + ext;
    var file = null;
    try { file = new File([blob], name, { type: blob.type }); } catch (e) { file = null; }
    var canFiles = false;
    try { canFiles = !!(file && navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { canFiles = false; }
    if (canFiles) {
      navigator.share({ files: [file], title: '舞台寄语集', text: '整本在这里：' + link })
        .catch(function () {});
      return;
    }
    try {
      var a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
      toast('图片已保存 · 链接在上面');
    } catch (e) { toast('这台设备存不了图，可以长按图片保存'); }
  }

  function showAlbum(url) {
    document.body.classList.add('album-open');
    bookPages = []; bookIdx = 0;
    $('#stgBookNav').classList.remove('on');
    $('#stgAlbum').classList.remove('book');
    $('#stgBookLive').classList.remove('on');
    $('#stgAlbumImg').style.visibility = '';
    setAlbumTitle('舞台纪念卡');
    $('#stgAlbum').classList.remove('chrome-off');
    var im = $('#stgAlbumImg'); im.src = url;
    var dl = $('#stgAlbumDl');
    dl.href = url; dl.setAttribute('download', '舞台纪念卡.jpg');
    $('#stgAlbum').classList.add('on');
  }
  function showBook(pages) {
    document.body.classList.add('album-open');
    bookPages = pages; bookIdx = 0;
    $('#stgAlbum').classList.add('book');
    $('#stgBookNav').classList.add('on');
    setAlbumTitle('舞台寄语集');
    $('#stgAlbum').classList.remove('chrome-off');
    // 排版完就把「正在排版…」收掉，别压在封面上
    var tt = $('#stgToast'); if (tt) { tt.classList.remove('on'); clearTimeout(toast._t); }
    $('#stgAlbum').classList.add('on');     // 先显示：活封面要拿得到图片的实际尺寸
    renderBookPage();
  }

  /* ---------- 册子封面：活的舞台画面 ----------
   * 封面不做成死图：背景 + 动态星星 + 蜡烛氛围光，跟寄语页一个味道。
   * 尺寸严格取静态封面图的 rect（同一张 1080×1528），翻页时不会跳。
   */
  function syncLiveSize() {
    var im = $('#stgAlbumImg'), lv = $('#stgBookLive'), box = $('#stgPageBox');
    if (!im || !lv || !box || !lv.classList.contains('on')) return;
    var r = im.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // 位置直接取图片的 rect：页面盒上下内边距不等（顶栏 50 / 翻页 56），
    // 按盒子中心居中会整体偏下 3px，翻到内页就看得出来在跳。这里逐像素对齐。
    var b = box.getBoundingClientRect();
    lv.style.transform = 'none';
    lv.style.left = (r.left - b.left) + 'px';
    lv.style.top = (r.top - b.top) + 'px';
    lv.style.width = r.width + 'px';
    lv.style.height = r.height + 'px';
    lv.style.setProperty('--cw', r.width + 'px');
    placeCandleIn($('#stgLiveBg'), $('#stgLiveCandle'));
  }
  function renderLiveSky() {
    var box = $('#stgLiveSky'); if (!box) return;
    box.innerHTML = '';
    var n = Math.min(56, 22 + wishes.length);
    for (var i = 0; i < n; i++) {
      var st = document.createElement('span');
      st.className = 'stage-star';
      st.style.left = (2 + Math.random() * 96) + '%';
      st.style.top = (2 + Math.random() * 92) + '%';
      st.style.setProperty('--sd', (2 + Math.random() * 3.6).toFixed(1) + 's');
      st.style.animationDelay = (Math.random() * 3).toFixed(2) + 's';
      box.appendChild(st);
    }
  }
  function renderLiveMeta() {
    var c = $('#stgLiveCount'); if (c) c.textContent = wishes.length;
    var dEl = $('#stgLiveDate'); if (!dEl) return;
    var ds = wishes.filter(function (w) { return w.d; }).map(function (w) { return Number(w.d); });
    if (!ds.length) { dEl.textContent = ''; return; }
    var fmt = function (d) { return d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate()); };
    var a = fmt(new Date(Math.min.apply(null, ds))), b = fmt(new Date(Math.max.apply(null, ds)));
    dEl.textContent = a === b ? a : (a + ' — ' + b);
  }
  function showLiveCover() {
    var im = $('#stgAlbumImg'), lv = $('#stgBookLive');
    if (!lv) return;
    im.style.visibility = 'hidden';      // 保留占位：活封面要用它的尺寸对齐
    lv.classList.add('on');
    renderLiveSky(); renderLiveMeta();
    var fit = function () { syncLiveSize(); };
    if (im.complete && im.naturalWidth) fit();
    else im.addEventListener('load', fit, { once: true });
    requestAnimationFrame(fit);
    setTimeout(fit, 140);                // 兜底：首屏布局/字体稳定后再校一次
  }

  // 翻页：先把目标页解码好，再换 src；并锁住滚动位置 —— 点按钮时画面一丝都不许动
  var preloaded = {};
  function preloadPage(i) {
    var u = bookPages[i];
    if (!u || preloaded[u]) return;
    preloaded[u] = true;
    var im = new Image(); im.src = u;
  }
  function goPage(delta) {
    var next = bookIdx + delta;
    if (next < 0 || next >= bookPages.length) return;
    var sy = window.scrollY, sx = window.scrollX, as = $('#stgAlbum').scrollTop;
    bookIdx = next;
    renderBookPage();
    if (window.scrollY !== sy || window.scrollX !== sx) window.scrollTo(sx, sy);
    if ($('#stgAlbum').scrollTop !== as) $('#stgAlbum').scrollTop = as;
  }

  function renderBookPage() {
    if (!bookPages.length) return;
    var url = bookPages[bookIdx];
    var im = $('#stgAlbumImg'), lv = $('#stgBookLive');
    im.src = url;
    // 第 1 页（封面）用活画面；其余页是排版好的图
    if (bookIdx === 0 && bookPages.length > 1) showLiveCover();
    else { lv.classList.remove('on'); im.style.visibility = ''; }
    preloadPage(bookIdx - 1); preloadPage(bookIdx + 1);   // 相邻页预热，翻页不等解码
    $('#stgBookIdx').textContent = (bookIdx + 1) + ' / ' + bookPages.length;
    $('#stgBookPrev').disabled = bookIdx <= 0;
    $('#stgBookNext').disabled = bookIdx >= bookPages.length - 1;
    var dl = $('#stgAlbumDl');
    dl.href = url;
    dl.setAttribute('download', (bookIdx === 0 ? '舞台寄语集-封面' : '舞台寄语集-第' + bookIdx + '页') + '.jpg');
  }
  // 关掉预览：从册子页进来的 → 回舞台页；否则只是关闭浮层
  function closeAlbum() {
    closeShare();
    document.body.classList.remove('album-open');
    $('#stgAlbum').classList.remove('on');
    if (isBook) location.href = stageUrl();
  }
  function toast(msg) {
    var t = $('#stgToast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('on'); }, 2200);
  }

  /* ---------- 背景音乐（默认关闭；点击播放整首，循环）---------- */
  var bgm = null, bgmOn = false, bgmFade = null;
  function fadeVol(el, target, ms) {
    clearInterval(bgmFade);
    var from = el.volume, steps = Math.max(1, Math.round(ms / 40)), i = 0;
    bgmFade = setInterval(function () {
      i += 1;
      try { el.volume = Math.min(1, Math.max(0, from + (target - from) * (i / steps))); } catch (e) {}
      if (i >= steps) clearInterval(bgmFade);
    }, 40);
  }
  function initMusic() {
    var btn = $('#stageMusic'); if (!btn) return;
    bgm = new Audio();
    bgm.src = './audio/stage-bgm-260328.mp3';   // 《降落伞》260328 前座 Cut（换歌换文件名，天然绕开缓存）
    bgm.loop = true;          // 整首放完接着放
    bgm.preload = 'none';     // 不点不下载（4.6MB，省流量）
    bgm.volume = 0;
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (bgmOn) {                                  // 关：立刻暂停
        bgmOn = false; bgm.pause(); btn.classList.remove('on');
        btn.setAttribute('aria-label', '播放背景音乐'); btn.title = '播放背景音乐';
        return;
      }
      btn.classList.add('loading');
      var p = bgm.play();
      if (p && p.then) p.then(function () {
        bgmOn = true; btn.classList.remove('loading'); btn.classList.add('on');
        btn.setAttribute('aria-label', '暂停背景音乐'); btn.title = '暂停背景音乐';
        fadeVol(bgm, 0.72, 700);                    // 淡入，避免一上来太响
      }).catch(function () {
        btn.classList.remove('loading'); toast('音乐没加载出来，再点一下试试');
      });
    });
  }

  /* ---------- 大屏模式：现场投屏 + 扫码 ---------- */
  function buildQr() {
    var box = $('#qrBox'); if (!box) return;
    if (typeof qrcode !== 'function') return;
    try {
      var q = qrcode(0, 'M');
      q.addData(QR_URL);
      q.make();
      box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) {
      box.innerHTML = '<div style="font-size:9px;color:#333;text-align:center;padding-top:36px">二维码<br>生成失败</div>';
    }
  }
  function initScreenMode() {
    if (!isScreen) return;
    document.body.classList.add('screen');
    buildQr();
    // 投屏时背景慢速轮换，画面不呆板（卡片已隐藏，不打扰）
    setInterval(function () {
      bgIdx = (bgIdx + 1) % BG.length;
      renderBg();
    }, 50000);
  }

  /* ---------- E. 入场仪式：推门走进来（只首次播一次） ---------- */
  function initIntro() {
    var intro = $('#stageIntro');
    if (!intro) return;
    // 独立册子页 / 大屏投屏 不播过场（要的是干净画面 / 现场直接铺满）
    var reduced = false;
    try { reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    if (isBook || isScreen || reduced) { intro.parentNode.removeChild(intro); return; }
    // 同一会话只播一次：第二次回到舞台不再等 2.6s
    var SEEN = 'wyc-stage-intro-seen-v1';
    var seen = false;
    try { seen = sessionStorage.getItem(SEEN) === '1'; } catch (e) {}
    if (seen) { intro.parentNode.removeChild(intro); return; }
    try { sessionStorage.setItem(SEEN, '1'); } catch (e) {}
    intro.hidden = false;
    // 动画结束就拆掉，不留一层盖在页面上
    setTimeout(function () { if (intro.parentNode) intro.parentNode.removeChild(intro); }, 2700);
  }

  /* ---------- 启动 ---------- */
  function init() {
    initScreenMode();
    if (nightMode) document.body.classList.add('night');   // 深夜：更暗 / 星星更多 / 光柱更暖
    initIntro();                                           // 推门过场（只首次）
    if (isBook) document.body.classList.add('book-only');   // 独立册子页：底下的舞台 UI 全隐
    buildCard(); renderBg(); renderCard(); renderSky(); renderSediment(); initMusic(); loadWishes();
    // 初始化收起态的 DOM（变量 collapsed=true）
    $('#stageCard').classList.add('collapsed');
    $('.stage-ov').classList.add('card-collapsed');
    document.addEventListener('click', function (e) {
      var bd = e.target.closest('[data-bg]');
      if (bd) { e.preventDefault(); bgIdx = Number(bd.dataset.bg); renderBg(); return; }
    });
    $('#cardPrev').addEventListener('click', function (e) { e.preventDefault(); switchMoment(-1); });
    $('#cardNext').addEventListener('click', function (e) { e.preventDefault(); switchMoment(1); });
    $('#stageFab').addEventListener('click', openWrite);   // 底部悬浮写寄语按钮
    // 视口变化 / 横竖屏切换：重算蜡烛光斑位置（背景图 cover 映射会变）
    var ct = null;
    var reCandle = function () {
      clearTimeout(ct);
      ct = setTimeout(function () { placeCandle(); syncLiveSize(); }, 160);   // 横竖屏切换：活封面也要重新量
    };
    window.addEventListener('resize', reCandle);
    window.addEventListener('orientationchange', reCandle);
    $('#stgWriteCancel').addEventListener('click', closeWrite);
    $('#stgGo').addEventListener('click', submitWish);
    $('#stgMask').addEventListener('click', function (e) { if (e.target === this) closeWrite(); });
    $('#stgAlbumClose').addEventListener('click', function (e) { e.stopPropagation(); closeAlbum(); });
    $('#stgAlbumBack').addEventListener('click', function (e) { e.stopPropagation(); closeAlbum(); });
    $('#stgAlbumShare').addEventListener('click', function (e) { e.stopPropagation(); openShare(); });
    // 分享面板
    $('#stgShareCopy').addEventListener('click', function (e) { e.stopPropagation(); copyShareLink(); });
    $('#stgShareImg').addEventListener('click', function (e) { e.stopPropagation(); sharePageImage(); });
    $('#stgShareClose').addEventListener('click', function (e) { e.stopPropagation(); closeShare(); });
    $('#stgShare').addEventListener('click', function (e) { if (e.target === this) closeShare(); });
    $('#stgAlbum').addEventListener('click', function (e) { if (e.target === this) closeAlbum(); });
    // 点一下画面：顶栏 / 翻页一起隐掉，只剩干净的封面和内页；再点一下回来
    $('#stgPageBox').addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      $('#stgAlbum').classList.toggle('chrome-off');
    });
    $('#stgBookPrev').addEventListener('click', function (e) {
      e.stopPropagation(); this.blur(); goPage(-1);
    });
    $('#stgBookNext').addEventListener('click', function (e) {
      e.stopPropagation(); this.blur(); goPage(1);
    });
    $('#stgText').addEventListener('input', function () { $('#stgCount').textContent = this.value.length + '/60'; });
    $('#cardToggle').addEventListener('click', function () {
      collapsed = !collapsed;
      $('#stageCard').classList.toggle('collapsed', collapsed);
      $('.stage-ov').classList.toggle('card-collapsed', collapsed);
      this.classList.toggle('arr-down', !collapsed);
      this.classList.toggle('arr-up', collapsed);
      this.setAttribute('aria-label', collapsed ? '展开卡片' : '收起卡片');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeWrite();
        if ($('#stgShare').classList.contains('on')) { closeShare(); return; }
        if ($('#stgAlbum').classList.contains('on')) closeAlbum();
      }
      if (bookPages.length && $('#stgAlbum').classList.contains('on')) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); goPage(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); goPage(1); }
      }
    });
    // 主页「写寄语」按钮跳过来（?write=1）→ 自动打开写寄语弹窗
    if (/[?&]write=1(?:&|$)/.test(location.search)) setTimeout(openWrite, 400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
