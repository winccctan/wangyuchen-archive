/* ===== 舞台纪念页 · 在人间凑数的日子（独立页 stage.html）=====
 * 独立运行，不依赖 app.js / demo-features.js。
 * 寄语走 /api/stage-wishes（GET 公开读，POST 同源限流），KV 只存文字+署名+时间，无 uid。
 * 出图在本机 Canvas 合成，不上传。
 */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  }); }

  var BG = [
    { f: './assets/stage-mvp.jpg', label: 'MVP定制公演' },
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
  var ICONS = ['⭐', '🐟', '✨', '💫', '🌟'];

  var bgIdx = 0, momentIdx = 0, wishes = [], collapsed = true;   // 默认收起：舞台画面干净 + 悬浮写寄语按钮常显
  var SIGN_KEY = 'wyc-stage-sign-v1';

  /* ---------- 背景 ---------- */
  function renderBg() {
    $('#stageBg').style.backgroundImage = 'url("' + BG[bgIdx].f + '")';
    var bar = $('#stageBgbar');
    bar.innerHTML = BG.map(function (x, i) {
      return '<button type="button" class="stage-bgdot' + (i === bgIdx ? ' on' : '') +
        '" data-bg="' + i + '" title="' + esc(x.label) + '" aria-label="' + esc(x.label) + '"></button>';
    }).join('');
  }

  /* ---------- 名场面卡 ----------
   * 骨架只建一次；切换名场面只改 chip/title/quote 三个文字节点，
   * 寄语列表和按钮不重建 ⇒ 卡片高度不变、页面不跳动。
   */
  function buildCard() {
    $('#stageCardBody').innerHTML =
      '<div class="stage-card-meta"><span class="stage-card-chip" id="mChip"></span><b id="mTitle"></b></div>' +
      '<div class="stage-card-quote" id="mQuote"></div>' +
      '<div class="stage-wish-list"><div class="stage-wish-list-hd">💌 大家写下的舞台寄语 <span id="wishTotal"></span></div>' +
      '<div class="stage-wish-scroll" id="wishScroll"></div></div>' +
      '<div class="stage-card-foot"><button class="stage-next" type="button" id="stageNext">💧 下一场</button>' +
      '<button class="stage-write" type="button" id="stageWrite">✍️ 写应援寄语</button></div>';
    $('#stageNext').addEventListener('click', function (e) { e.preventDefault(); switchMoment(1); });
    $('#stageWrite').addEventListener('click', openWrite);
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
    var total = $('#wishTotal'); if (total) total.textContent = wishes.length ? '(' + wishes.length + ')' : '';
    if (!wishes.length) { box.innerHTML = '<div class="stage-wish-empty">还没有人写寄语，来做第一个吧 ✨</div>'; return; }
    box.innerHTML = wishes.map(function (w) {
      return '<div class="stage-wish-item"><span class="swi-ico">🐟</span><span class="swi-txt">' + esc(w.t) + '</span>' +
        (w.s ? '<span class="swi-sign">— ' + esc(w.s) + '</span>' : '') +
        (w.d ? '<span class="swi-date">' + esc(timeStr(w.d)) + '</span>' : '') + '</div>';
    }).join('');
  }

  /* ---------- 星星 / 小鱼泡泡浮层 ---------- */
  var skyTimer = null;
  // 泡泡池：氛围短句（⭐）+ 全部访客寄语（🐟），不截断（长祝福一条不落）
  function bubblePool() {
    var pool = AMBIENT.map(function (s) { return { ico: '⭐', t: s, s: '' }; });
    wishes.forEach(function (w) { pool.push({ ico: '🐟', t: w.t, s: w.s || '' }); });
    return pool;
  }
  // 循环游标：所有寄语按顺序一条接一条轮流上屏（纯轮询，非随机），一直循环
  var bubbleCursor = 0;
  // 生成一个泡泡：从底部升起 → 飘到顶部淡出 → 自动移除
  function spawnBubble() {
    var float = $('#stageSkyFloat'); if (!float) return;
    var pool = bubblePool(); if (!pool.length) return;
    // 同屏上限 = min(12, 池子大小)：寄语多时最多 12 条热闹，寄语少时不重复
    var skyMax = Math.min(12, pool.length);
    if (float.querySelectorAll('.wish-bubble').length >= skyMax) return;
    // 从游标位置顺序找一条「当前不在屏上」的；若全在屏上（寄语很少）就强制取游标那条，保证一直滚
    var shown = Array.prototype.map.call(float.querySelectorAll('.wish-bubble'), function (n) { return n.getAttribute('data-t'); });
    var item = null, start = bubbleCursor % pool.length;
    for (var k = 0; k < pool.length; k++) {
      var cand = pool[(start + k) % pool.length];
      if (shown.indexOf(cand.t) < 0) { item = cand; bubbleCursor = (start + k + 1) % pool.length; break; }
    }
    if (!item) { item = pool[start]; bubbleCursor = (start + 1) % pool.length; }
    var left = 3 + Math.random() * 70;              // 水平随机 3%~73%
    var dur = 13 + Math.random() * 8;               // 上浮 13~21s（长句慢慢滚，看得清全文）
    var dx = Math.round(Math.random() * 40 - 20);   // 左右轻摆
    var el = document.createElement('span');
    el.className = 'wish-bubble';
    el.setAttribute('data-t', item.t);
    el.style.left = left + '%';
    el.style.setProperty('--dur', dur.toFixed(1) + 's');
    el.style.setProperty('--dx', dx + 'px');
    // 全文显示：长句换行不缩写；署名放第二行
    el.innerHTML = '<span class="wico">' + item.ico + '</span><span class="wtxt">' + esc(item.t) +
      (item.s ? '<span class="wsign">\n— ' + esc(item.s) + '</span>' : '') + '</span>';
    float.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, (dur + 0.5) * 1000);
  }
  function renderSky() {
    var sky = $('#stageSky'); if (!sky) return;
    // 星星点点 + 泡泡容器只初始化一次，不被后续数据刷新打断
    if (!$('#stageStars')) {
      var stars = '';
      for (var i = 0; i < 22; i++) {
        var sl = 3 + Math.random() * 94, st = 6 + Math.random() * 70;
        var sd = (2 + Math.random() * 3).toFixed(1);
        stars += '<span class="stage-star" style="left:' + sl + '%;top:' + st + '%;--sd:' + sd + 's"></span>';
      }
      var sdiv = document.createElement('div'); sdiv.id = 'stageStars'; sdiv.innerHTML = stars;
      sky.appendChild(sdiv);
      var fdiv = document.createElement('div'); fdiv.id = 'stageSkyFloat'; fdiv.className = 'stage-sky-float';
      sky.appendChild(fdiv);
    }
    for (var j = 0; j < 8; j++) setTimeout(spawnBubble, j * 500);    // 起手先铺 8 个，立刻热闹
    if (!skyTimer) skyTimer = setInterval(spawnBubble, 1400);        // 之后持续补新泡泡，保持滚动
  }

  /* ---------- 读取寄语 ---------- */
  function loadWishes() {
    fetch('./api/stage-wishes?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { wishes: [] }; })
      .then(function (j) {
        wishes = Array.isArray(j.wishes) ? j.wishes : [];
        renderWishList(); renderSky();
      })
      .catch(function () { /* 读不到就只显示氛围短句 */ });
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
    fetch('./api/stage-wishes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t: text, s: sign })
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j, status: r.status }; });
    }).then(function (res) {
      if (!res.ok) { msg.style.color = '#c0392b'; msg.textContent = res.j.error || '寄出失败，稍后再试'; return; }
      // 本机即时上屏（KV 最终一致，先本地插一条；服务器去重由后端判）
      var rec = { t: text, s: sign, d: Date.now() };
      if (!res.j.dup) { wishes.unshift(rec); if (wishes.length > 200) wishes.length = 200; }
      renderWishList(); renderSky();
      closeWrite();
      makeCard(text, sign);
    }).catch(function () {
      msg.style.color = '#c0392b'; msg.textContent = '网络出了点问题，稍后再试';
    });
  }

  /* ---------- 本机出图（不上传） ---------- */
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
        c.fillStyle = 'rgba(255,224,170,.92)'; c.font = '600 22px -apple-system,"PingFang SC",sans-serif';
        c.fillText('✦  舞 台 现 场  ·  在 人 间 凑 数 的 日 子', W / 2, 62);
        var chars = Array.from(wish), maxW = W - 120, line = '', lines = [];
        c.font = '600 44px -apple-system,"PingFang SC",sans-serif';
        for (var k = 0; k < chars.length; k++) {
          var ch = chars[k];
          if (ch === '\n') { lines.push(line); line = ''; continue; }
          var test = line + ch;
          if (c.measureText(test).width > maxW && line) { lines.push(line); line = ch; }
          else line = test;
        }
        if (line) lines.push(line);
        lines = lines.slice(0, 4);
        var lh = 62, y = H - 210 - (lines.length - 1) * lh;
        c.fillStyle = '#fff'; c.shadowColor = 'rgba(0,0,0,.5)'; c.shadowBlur = 12;
        c.font = '600 44px -apple-system,"PingFang SC",sans-serif';
        lines.forEach(function (ln) { c.fillText(ln, W / 2, y); y += lh; });
        c.shadowBlur = 0;
        c.strokeStyle = 'rgba(255,255,255,.4)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(W / 2 - 60, H - 118); c.lineTo(W / 2 + 60, H - 118); c.stroke();
        c.fillStyle = 'rgba(255,255,255,.86)'; c.font = '400 24px -apple-system,"PingFang SC",sans-serif';
        c.fillText(sign ? ('—— ' + sign) : '—— 一个陪你追舞台的人', W / 2, H - 78);
        c.fillStyle = 'rgba(255,224,170,.72)'; c.font = '400 19px -apple-system,"PingFang SC",sans-serif';
        c.fillText('王语晨 · 2025 年度 MVP 定制公演 · 11.28', W / 2, H - 40);
        showAlbum(cv.toDataURL('image/jpeg', 0.92));
      } catch (e) { toast('生成失败，换张背景再试'); }
    };
    img.onerror = function () { toast('背景加载失败，换一张再试'); };
    img.src = bg.f;
  }
  function showAlbum(url) {
    var im = $('#stgAlbumImg'); im.src = url;
    var dl = $('#stgAlbumDl');
    dl.href = url;
    dl.style.display = 'none'; // 手机端隐藏下载，引导长按（桌面端 JS 再放开）
    if (!/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) dl.style.display = 'inline-block';
    $('#stgAlbum').classList.add('on');
  }
  function toast(msg) {
    var t = $('#stgToast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('on'); }, 2200);
  }

  /* ---------- 启动 ---------- */
  function init() {
    buildCard(); renderBg(); renderCard(); renderSky(); loadWishes();
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
    $('#stgWriteCancel').addEventListener('click', closeWrite);
    $('#stgGo').addEventListener('click', submitWish);
    $('#stgMask').addEventListener('click', function (e) { if (e.target === this) closeWrite(); });
    $('#stgAlbumClose').addEventListener('click', function () { $('#stgAlbum').classList.remove('on'); });
    $('#stgAlbum').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('on'); });
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
      if (e.key === 'Escape') { closeWrite(); $('#stgAlbum').classList.remove('on'); }
    });
    // 主页「写寄语」按钮跳过来（?write=1）→ 自动打开写寄语弹窗
    if (/[?&]write=1(?:&|$)/.test(location.search)) setTimeout(openWrite, 400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
