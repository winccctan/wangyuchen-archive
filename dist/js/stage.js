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
  // 舞台瞬间（舞台语境，非剧情台词；无「全场大合唱」，改为喊 call 应援）
  var MOMENTS = [
    { tag: '开场', title: '灯亮起来的那一刻', text: '在人间凑数的日子里，\n你是那个不凑数的例外。' },
    { tag: 'UNIT', title: '属于你的那支舞', text: '舞台就这么大，\n你站上去，就满了。' },
    { tag: '喊 call', title: '全场一起喊出你的名字', text: '这一声 call 是给你的，\n今晚的主角，是你。' },
    { tag: 'MVP', title: '年度 MVP 加冕', text: '这一年所有的努力，\n都在今晚闪闪发光。' },
    { tag: '安可', title: '最后一首合唱', text: '歌会唱完，但今晚的感动，\n我会一直带在身上。' },
    { tag: '谢幕', title: '鞠躬，转身，灯暗', text: '散场了也别难过，\n因为下一次见面已经在路上。' }
  ];
  // 舞台氛围短句（星星；非访客寄语，不署名）
  var AMBIENT = ['GNZ48 · TEAM NIII', '2025 年度 MVP 定制公演', '11.28 星梦剧院', '喊 call 应援', '这一场 我们都在'];
  var ICONS = ['⭐', '🐟', '✨', '💫', '🌟'];

  var bgIdx = 0, momentIdx = 0, wishes = [], collapsed = false;
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

  /* ---------- 名场面卡 ---------- */
  function renderCard() {
    var m = MOMENTS[momentIdx];
    var lines = String(m.text).split('\n').map(esc).join('<br>');
    $('#stageCardBody').innerHTML =
      '<div class="stage-card-meta"><span class="stage-card-chip">' + esc(m.tag) + '</span><b>' + esc(m.title) + '</b></div>' +
      '<div class="stage-card-quote">' + lines + '</div>' +
      '<div class="stage-wish-list"><div class="stage-wish-list-hd">💌 大家写下的舞台寄语 <span id="wishTotal"></span></div>' +
      '<div class="stage-wish-scroll" id="wishScroll"></div></div>' +
      '<div class="stage-card-foot"><button class="stage-next" type="button" id="stageNext">💧 下一场</button>' +
      '<button class="stage-write" type="button" id="stageWrite">✍️ 写应援寄语</button></div>' +
      '<div class="stage-card-info">寄语保存在服务器，所有来看这场舞台的人都能看到 · 生成纪念卡只在本机合成，不上传</div>';
    $('#stageNext').addEventListener('click', function () {
      momentIdx = (momentIdx + 1) % MOMENTS.length; renderCard();
    });
    $('#stageWrite').addEventListener('click', openWrite);
    renderWishList();
  }

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
  function renderSky() {
    var sky = $('#stageSky');
    // 星星点点
    var stars = '';
    for (var i = 0; i < 22; i++) {
      var sl = 3 + Math.random() * 94, st = 6 + Math.random() * 70;
      var sd = (2 + Math.random() * 3).toFixed(1);
      stars += '<span class="stage-star" style="left:' + sl + '%;top:' + st + '%;--sd:' + sd + 's"></span>';
    }
    // 氛围短句（星星，不署名）
    var ambient = AMBIENT.map(function (s, i) {
      var p = skyPos(i, 6);
      return bubbleHtml('⭐', esc(s), '', p, i);
    }).join('');
    // 访客寄语（小鱼泡泡，带署名）——最多取最新 12 条上屏
    var fb = wishes.slice(0, 12).map(function (w, i) {
      var p = skyPos(i + 2, 12);
      return bubbleHtml('🐟', esc(w.t), w.s ? esc(w.s) : '', p, i + 6);
    }).join('');
    sky.innerHTML = stars + '<div class="stage-sky-float">' + ambient + fb + '</div>';
  }
  function skyPos(i, base) {
    var rows = [ [8,12], [64,16], [14,30], [70,36], [6,52], [62,60], [20,70], [58,74] ];
    var p = rows[i % rows.length];
    return { l: p[0] + (Math.random() * 4 - 2), t: p[1] + (Math.random() * 4 - 2) };
  }
  function bubbleHtml(ico, txt, sign, pos, i) {
    var dur = (7 + Math.random() * 5).toFixed(1), del = (Math.random() * 3).toFixed(1);
    var dx = (Math.random() * 16 - 8).toFixed(0);
    return '<span class="wish-bubble" style="left:' + pos.l + '%;top:' + pos.t + '%;--dur:' + dur + 's;--del:' + del + 's;--dx:' + dx + 'px">' +
      '<span class="wico">' + ico + '</span><span class="wtxt">' + txt + '</span>' +
      (sign ? '<span class="wsign">—' + sign + '</span>' : '') + '</span>';
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
    renderBg(); renderCard(); renderSky(); loadWishes();
    document.addEventListener('click', function (e) {
      var bd = e.target.closest('[data-bg]');
      if (bd) { bgIdx = Number(bd.dataset.bg); renderBg(); return; }
    });
    $('#cardPrev').addEventListener('click', function () {
      momentIdx = (momentIdx - 1 + MOMENTS.length) % MOMENTS.length; renderCard();
    });
    $('#stgWriteCancel').addEventListener('click', closeWrite);
    $('#stgGo').addEventListener('click', submitWish);
    $('#stgMask').addEventListener('click', function (e) { if (e.target === this) closeWrite(); });
    $('#stgAlbumClose').addEventListener('click', function () { $('#stgAlbum').classList.remove('on'); });
    $('#stgAlbum').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('on'); });
    $('#stgText').addEventListener('input', function () { $('#stgCount').textContent = this.value.length + '/60'; });
    $('#cardToggle').addEventListener('click', function () {
      collapsed = !collapsed;
      $('#stageCard').classList.toggle('collapsed', collapsed);
      this.textContent = collapsed ? '⌃' : '⌄';
      this.setAttribute('aria-label', collapsed ? '展开卡片' : '收起卡片');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeWrite(); $('#stgAlbum').classList.remove('on'); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
