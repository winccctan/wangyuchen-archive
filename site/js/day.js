/* =======================================================================
   day.js —— 「这一天」：把发言 / 直播 / 公演 / 微博 / 投稿 按北京时间的
   同一天串成一条时间线。纯只读（没有任何写操作，也不写 localStorage）。
   数据：./day/index.json（日期 → 各类条数）+ ./day/YYYY-MM.json（按月）
   生成：node scripts/gen-day.mjs（CI 每天自动跑，见 .github/workflows/day-sync.yml）
   ======================================================================= */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $all = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var IMG = './img?u=';

  var IDX = null;          // { range:[a,b], days:{ 'YYYY-MM-DD': {msg,perf,live,weibo,bili} } }
  var DAYS = [];           // 有记录的日期，升序
  var cur = '';            // 当前日期
  var calY = 0, calM = 0;  // 月历当前月（0 基）
  var calOpen = false;     // 月历默认收起：首屏先给内容
  var monthCache = {};     // 'YYYY-MM' -> {d:{...}}

  // ---------------- 小工具 ----------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  // 口袋图床（kd48-nosdn / source.48.cn）直连有些网络会挂，统一走站内 /img 代理（边缘缓存一年）
  function proxy(u) {
    if (!u) return '';
    if (/^\//.test(u)) return IMG + encodeURIComponent('https://source.48.cn' + u);
    return IMG + encodeURIComponent(u);
  }
  // 点小图看大图：自己撑一个浮层，不依赖主页面的 lightbox
  function openBig(src) {
    var el = document.getElementById('dyBig');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dyBig';
      el.className = 'dy-big';
      el.innerHTML = '<img alt="图片" referrerpolicy="no-referrer">';
      el.addEventListener('click', function () { el.classList.remove('on'); });
      document.body.appendChild(el);
    }
    el.querySelector('img').src = src;
    el.classList.add('on');
  }
  function hhmm(ts) {
    var d = new Date(Number(ts) + 8 * 3600 * 1000);
    return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  // 上一天 / 下一天：字面加减一天（不是「跳到下一个有记录的日子」）
  // 站长 2026-10-27：「日历可以有上一天下一天这样吗 方便切换」⇒ 逐日步进，空档页会告诉你去哪有档。
  function shiftDay(d, n) {
    var t = new Date(d + 'T00:00:00');
    t.setDate(t.getDate() + n);
    return ymd(t);
  }
  function canShift(n) {
    var d = shiftDay(cur, n);
    if (n > 0) return d <= ymd(new Date());                 // 不翻到未来
    var lo = (IDX && IDX.range && IDX.range[0]) || '';
    return !lo || d >= lo;                                  // 不翻到补档起点之前
  }
  function bjDay(ms) { return new Date(Number(ms) + 8 * 3600 * 1000).toISOString().slice(0, 10); }
  function dur(sec) {
    sec = Number(sec) || 0;
    if (sec <= 0) return '';
    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    if (h && m) return h + ' 小时 ' + m + ' 分';
    if (h) return h + ' 小时';
    return m + ' 分钟';
  }
  function durShort(sec) {
    sec = Number(sec) || 0;
    if (sec <= 0) return '';
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h) return h + ':' + pad(m) + ':' + pad(s);
    return m + ':' + pad(s);
  }
  function monthKey(d) { return d.slice(0, 7); }

  // ---------------- 数据 ----------------
  function loadIndex() {
    return fetch('./day/index.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('index ' + r.status);
      return r.json();
    });
  }
  function loadMonth(mk) {
    if (monthCache[mk]) return Promise.resolve(monthCache[mk]);
    return fetch('./day/' + mk + '.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('month ' + r.status);
      return r.json();
    }).then(function (j) {
      monthCache[mk] = j;
      return j;
    }).catch(function () {
      monthCache[mk] = { d: {} };
      return monthCache[mk];
    });
  }

  // 「今天」的发言必须是最新的：静态文件由 CI 每 6 小时才重建一次，
  // 所以当月额外向接口要一次（约 200~300KB），失败就退回静态文件。
  var apiCache = {};
  function loadApiMonth(mk) {
    if (apiCache[mk] !== undefined) return Promise.resolve(apiCache[mk]);
    return fetch('./api/month?m=' + mk, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('api ' + r.status);
      return r.json();
    }).then(function (res) {
      var arr = Array.isArray(res) ? res : (res && res.messages) || [];
      var map = {};
      arr.forEach(function (m) {
        var ts = Number(m.msgTime) || 0;
        if (!ts) return;
        var text = String(m.text || '').replace(/\s+/g, ' ').trim();
        var imgs = (m.images || []).filter(Boolean);
        var nImg = imgs.length;
        var isVid = m.video ? 1 : 0;
        if (!text && !nImg && !isVid) return;
        var row = [ts, text];
        if (nImg || isVid) row.push(nImg, isVid);
        if (nImg) row.push(imgs);          // 与静态文件同构：第 5 位是图片地址
        var d = bjDay(ts);
        (map[d] = map[d] || []).push(row);
      });
      Object.keys(map).forEach(function (d) {
        map[d].sort(function (a, b) { return a[0] - b[0]; });
      });
      apiCache[mk] = map;
      return map;
    }).catch(function () { apiCache[mk] = null; return null; });
  }

  // 把接口拿到的当月发言并进静态数据（发言以接口为准，其余类型仍用静态文件）
  function applyApiMsg(mk, map) {
    if (!map) return false;
    var j = monthCache[mk] || (monthCache[mk] = { d: {} });
    if (!j.d) j.d = {};
    Object.keys(map).forEach(function (d) {
      if (!j.d[d]) j.d[d] = { msg: [], perf: [], live: [], weibo: [], bili: [] };
      j.d[d].msg = map[d];
      if (!IDX.days[d]) IDX.days[d] = { msg: 0, perf: 0, live: 0, weibo: 0, bili: 0 };
      IDX.days[d].msg = map[d].length;
      if (DAYS.indexOf(d) < 0) { DAYS.push(d); DAYS.sort(); }
    });
    return true;
  }

  function nearest(dir) {
    var i;
    if (dir < 0) {
      for (i = DAYS.length - 1; i >= 0; i--) if (DAYS[i] < cur) return DAYS[i];
    } else {
      for (i = 0; i < DAYS.length; i++) if (DAYS[i] > cur) return DAYS[i];
    }
    return '';
  }

  // ---------------- 渲染：顶栏 ----------------
  function renderBar() {
    var d = new Date(cur + 'T00:00:00');
    var y = cur.slice(0, 4), m = cur.slice(5, 7), dd = cur.slice(8, 10);
    $('#dyNum').innerHTML = y + '.<em>' + m + '</em>.' + dd;
    $('#dyWd').textContent = WD[d.getDay()];
    var inp = $('#dyInput');
    if (inp) inp.value = cur;
    $('#dyPrev').disabled = !canShift(-1);
    $('#dyNext').disabled = !canShift(1);
  }

  // ---------------- 渲染：概览 ----------------
  function renderOv(n) {
    var items = [
      ['perf', 'pf', '公演', n.perf],
      ['live', 'lv', '直播', n.live],
      ['weibo', 'wb', '微博', n.weibo],
      ['bili', 'bv', '投稿', n.bili],
      ['msg', 'ms', '发言', n.msg]
    ].filter(function (x) { return x[3] > 0; });

    var box = $('#dyOv');
    if (!items.length) { box.innerHTML = ''; return; }
    box.innerHTML = items.map(function (x) {
      return '<button type="button" class="dy-ovc ' + x[1] + '" data-jump="sec-' + x[0] + '">'
        + '<i></i>' + x[2] + '<b>' + x[3] + '</b></button>';
    }).join('');
  }

  // ---------------- 渲染：月历 ----------------
  function renderCal() {
    var mPrefix = calY + '-' + pad(calM + 1);
    var nDays = DAYS.filter(function (d) { return d.slice(0, 7) === mPrefix; }).length;
    var today = ymd(new Date());

    var head = '<div class="dy-cal-h">'
      + '<button type="button" class="dy-cal-t" data-calopen="1">'
      + calY + ' 年 ' + (calM + 1) + ' 月'
      + '<span>本月 ' + nDays + ' 天有记录</span>'
      + '<i>' + (calOpen ? '⌃' : '⌄') + '</i></button>'
      + (calOpen ? '<span class="dy-cal-nav"><button type="button" data-cal="-1">‹</button>'
        + '<button type="button" data-cal="1">›</button></span>' : '')
      + '</div>';

    if (!calOpen) {
      $('#dyCal').innerHTML = head;
      $('#dyCal').classList.add('closed');
      return;
    }
    $('#dyCal').classList.remove('closed');

    var first = new Date(calY, calM, 1);
    var startCol = (first.getDay() + 6) % 7;          // 周一 = 0
    var dim = new Date(calY, calM + 1, 0).getDate();

    var cells = ['一', '二', '三', '四', '五', '六', '日'].map(function (w) {
      return '<div class="dy-cal-wd">' + w + '</div>';
    }).join('');

    for (var i = 0; i < startCol; i++) cells += '<div></div>';

    for (var d = 1; d <= dim; d++) {
      var key = calY + '-' + pad(calM + 1) + '-' + pad(d);
      var rec = IDX.days[key];
      var cls = 'dy-cell';
      if (rec) {
        cls += ' has';
        if (rec.perf) cls += ' pf';
      }
      if (key === cur) cls += ' on';
      cells += '<button type="button" class="' + cls + '" data-day="' + key + '"'
        + (key > today ? ' disabled' : '') + '>' + d + '</button>';
    }

    // 日历展开时，底部给「上一天 / 下一天」两个按钮：逐日翻，比在格子里找准。
    var jumpRow = '<div class="dy-cal-j">'
      + '<button type="button" data-shift="-1"' + (canShift(-1) ? '' : ' disabled') + '>‹ 上一天</button>'
      + '<button type="button" class="dy-cal-today" data-calend="1">回今天</button>'
      + '<button type="button" data-shift="1"' + (canShift(1) ? '' : ' disabled') + '>下一天 ›</button>'
      + '</div>';

    $('#dyCal').innerHTML = head + '<div class="dy-cal-grid">' + cells + '</div>' + jumpRow;
  }

  // ---------------- 渲染：主体 ----------------
  function secHead(kind, label, n) {
    return '<section class="dy-sec" id="sec-' + kind + '">'
      + '<div class="dy-sec-h"><span class="dy-dot ' + kind + '"></span><b>' + label + '</b>'
      + '<span class="dy-n">' + n + '</span></div>';
  }

  function perfHtml(list) {
    return list.slice().sort(function (a, b) { return (a.tm || '') < (b.tm || '') ? -1 : 1; })
      .map(function (p) {
        var body = '<div class="dy-pf-top"><b>' + esc(p.t || '公演') + '</b>'
          + (p.tm ? '<time>' + esc(p.tm) + '</time>' : '') + '</div>'
          + (p.songs && p.songs.length
            ? '<div class="dy-songs">' + p.songs.map(function (s) { return '<span>' + esc(s) + '</span>'; }).join('') + '</div>'
            : '<div class="dy-pf-empty">这场没有收录曲目</div>');
        // 有回放就整卡可点（站长 2026-10-27：她的公演要能直接看回放）
        if (p.rv) {
          return '<a class="dy-c dy-pf dy-hit" href="' + esc(p.rv) + '" target="_blank" rel="noopener" data-play="pf">'
            + body + '<span class="dy-play">▶ 看回放</span></a>';
        }
        return '<article class="dy-c dy-pf">' + body + '</article>';
      }).join('') + '</section>';
  }

  function liveHtml(list) {
    return list.slice().sort(function (a, b) { return (a.tm || '') < (b.tm || '') ? -1 : 1; })
      .map(function (l) {
        var title = l.t || '直播';   // 标题原样显示（「1」就是她自己的标题），只有空标题才兜底
        var meta = [l.tm, dur(l.dur)].filter(Boolean).join(' · ');
        var body = (l.cov ? '<img class="dy-lv-cov" src="' + IMG + encodeURIComponent(l.cov) + '" alt="">' : '')
          + '<div class="dy-lv-b"><b>' + esc(title) + '</b>'
          + (meta ? '<div class="dy-meta">' + esc(meta) + '</div>' : '') + '</div>';
        if (l.rv) {
          return '<a class="dy-c dy-lv dy-hit" href="' + esc(l.rv) + '" target="_blank" rel="noopener" data-play="lv">'
            + body + '<span class="dy-play">▶ 看回放</span></a>';
        }
        return '<article class="dy-c dy-lv">' + body + '</article>';
      }).join('') + '</section>';
  }

  function weiboHtml(list) {
    return list.map(function (w) {
      var img = w.cov ? '<img class="dy-wb-img" loading="lazy" src="' + IMG + encodeURIComponent(w.cov) + '" alt="">' : '';
      return '<article class="dy-c dy-wb">'
        + (w.t ? '<p>' + esc(w.t) + '</p>' : '<p class="dy-meta">（无正文）</p>')
        + img
        + (w.u ? '<a class="dy-link" href="' + esc(w.u) + '" target="_blank" rel="noopener">原微博 →</a>' : '')
        + '</article>';
    }).join('') + '</section>';
  }

  // B 站那批 UP 主是全团搬运号，一天能带进七八条别团的公演。
  // 🔴 只收**她的号**（B站「Chzhnh」mid 358477444，站长指定）发的，或标题里有「王语晨」的；
  //    别团、别的队，哪怕写着 GNZ48 / Team NIII 但没点她名字的，一律不出现（站长 2026-10-27 定死）。
  var HER_MID = '358477444';
  function biliSplit(list) {
    var main = list.filter(function (v) {
      return String(v.mid || '') === HER_MID || /王语晨/.test(String(v.t || ''));
    });
    main.sort(function (a, b) { return (a.tm || '') < (b.tm || '') ? -1 : 1; });
    return { main: main };
  }

  function biliRow(v, cls) {
    var t = String(v.t || '');
    // UP 主会在这天补传几年前的旧档，标题里的日期和页面日期差很多。
    // 不标一下会让人误以为「2022 年那场是今天演的」⇒ 差 7 天以上标「补档」。
    var tag = '';
    var m = t.match(/(20\d{2})[.\-]?(\d{2})[.\-]?(\d{2})/);
    if (m && /^20\d{6}$/.test(m[1] + m[2] + m[3]) && cur) {
      var gap = Math.abs((Date.parse(m[1] + '-' + m[2] + '-' + m[3]) - Date.parse(cur)) / 86400000);
      if (gap > 7) tag = '<em class="dy-old" title="当天上传的是 ' + m[1] + '.' + m[2] + '.' + m[3] + ' 的档">补档</em>';
    }
    return '<a class="dy-bv' + (cls || '') + '" href="https://www.bilibili.com/video/' + esc(v.bv) + '"'
      + ' target="_blank" rel="noopener"><b>' + esc(t || v.bv) + '</b>'
      + (v.dur ? '<i>' + durShort(v.dur) + '</i>' : '') + tag + '</a>';
  }

  function biliHtml(list) {
    var g = biliSplit(list);
    var LIMIT = 6;
    if (!g.main.length) return '';          // 全是别团的 → 整块不出现
    var rows = g.main.map(function (v, i) { return biliRow(v, i >= LIMIT ? ' dy-hidden' : ''); }).join('');
    var more = g.main.length > LIMIT
      ? '<button type="button" class="dy-more" data-expand="bv">展开全部 ' + g.main.length + ' 条</button>'
      : '';
    return '<div class="dy-c dy-bvlist" data-box="bv">' + rows + '</div>' + more + '</section>';
  }

  function msgHtml(list) {
    var LIMIT = 8;
    var lastT = '';
    var rows = list.map(function (m, i) {
      var ts = m[0], text = m[1] || '', nImg = m[2] || 0, isVid = m[3] || 0, imgs = m[4] || null;
      var body;
      if (text) {
        var tags = '';
        // 有真实图片地址就直接出图，不再打「图片 ×N」这个占位标
        if (nImg && !(imgs && imgs.length)) tags += '<span class="dy-tag">图片 ×' + nImg + '</span>';
        if (isVid) tags += '<span class="dy-tag">视频</span>';
        body = '<p>' + esc(text) + tags + '</p>';
      } else {
        var bits = [];
        if (nImg && !(imgs && imgs.length)) bits.push('图片 ×' + nImg);
        if (isVid) bits.push('视频');
        body = '<p class="blank">' + (bits.join(' · ') || (imgs && imgs.length ? '' : '语音 / 卡片')) + '</p>';
      }
      if (imgs && imgs.length) {
        var grid = 'dy-imgs' + (imgs.length === 1 ? ' one' : imgs.length === 2 ? ' two' : '');
        body += '<div class="' + grid + '">' + imgs.slice(0, 9).map(function (u) {
          var s = esc(proxy(u));
          return '<img loading="lazy" decoding="async" referrerpolicy="no-referrer" src="' + s + '" alt="图片" data-big="' + s + '">';
        }).join('') + (imgs.length > 9 ? '<span class="dy-more-img">+' + (imgs.length - 9) + '</span>' : '') + '</div>';
      }
      var t = hhmm(ts);
      var same = (t === lastT);            // 同一分钟的连发只标一次时间
      lastT = t;
      return '<div class="dy-m' + (i >= LIMIT ? ' dy-hidden' : '') + (same ? ' same' : '') + '">'
        + '<time>' + (same ? '' : t) + '</time><div class="dy-m-b">' + body + '</div></div>';
    }).join('');
    var more = list.length > LIMIT
      ? '<button type="button" class="dy-more" data-expand="ms">展开全部 ' + list.length + ' 条</button>'
      : '';
    return '<div class="dy-c dy-msgs" data-box="ms">' + rows + '</div>' + more + '</section>';
  }

  function renderFeed(day) {
    var box = $('#dyFeed');
    var n = IDX.days[cur] || { msg: 0, perf: 0, live: 0, weibo: 0, bili: 0 };
    // 投稿只算「她的」：数据里也过滤过，这里再兜一层（旧缓存/接口数据可能是全量的）
    if (day && day.bili) n = { msg: n.msg, perf: n.perf, live: n.live, weibo: n.weibo, bili: biliSplit(day.bili).main.length };
    renderOv(n);

    if (!day) {
      var pv = nearest(-1), nx = nearest(1);
      box.innerHTML = '<div class="dy-empty"><b>这一天没有记录</b>'
        + '她可能只是休息，也可能这一天还没被补档。'
        + (pv ? '<br><a href="#' + pv + '" data-day="' + pv + '">← 上一个有记录的日子 ' + pv + '</a>' : '')
        + (nx ? '<a href="#' + nx + '" data-day="' + nx + '">下一个有记录的日子 ' + nx + ' →</a>' : '')
        + '</div>';
      return;
    }

    var html = '';
    if (day.perf && day.perf.length) html += secHead('pf', '公演', day.perf.length) + perfHtml(day.perf);
    if (day.live && day.live.length) html += secHead('lv', '直播', day.live.length) + liveHtml(day.live);
    if (day.weibo && day.weibo.length) html += secHead('wb', '微博', day.weibo.length) + weiboHtml(day.weibo);
    if (day.bili && day.bili.length) {
      var bh = biliHtml(day.bili);
      if (bh) html += secHead('bv', '投稿', biliSplit(day.bili).main.length) + bh;
    }
    if (day.msg && day.msg.length) html += secHead('ms', '发言', day.msg.length) + msgHtml(day.msg);

    box.innerHTML = html || '<div class="dy-empty"><b>这一天没有记录</b></div>';
  }

  // ---------------- 主流程 ----------------
  function go(d, push) {
    if (!d) return;
    cur = d;
    calY = Number(d.slice(0, 4));
    calM = Number(d.slice(5, 7)) - 1;
    if (push !== false) {
      try { history.replaceState(null, '', '#' + cur); } catch (e) { location.hash = cur; }
    }
    renderBar();
    renderCal();
    // 切天时回到页面顶部：内容长短差别很大，不归位的话旧滚动位置会把新内容顶到半截，
    // 看着就像「页面自己滑了一下」（站长 2026-10-27 提的）。
    try { window.scrollTo(0, 0); } catch (e) { /* 老浏览器忽略 */ }
    var mk = monthKey(cur);
    $('#dyFeed').innerHTML = '<div class="dy-loading">读取中…</div>';
    var isCurMonth = mk === monthKey(ymd(new Date()));
    loadMonth(mk).then(function () {
      if (monthKey(cur) !== mk) return;      // 期间又切走了
      // 🔴 当月先把接口数据并进来再渲染（不是渲染两次）：站长 2026-10-27 要求「点击不要随便位移」，
      //    先画静态再补接口会导致发言从 6 条突然变 45 条、下面的内容整体跳一下。
      var step = isCurMonth
        ? loadApiMonth(mk).then(function (map) {
            if (map) { applyApiMsg(mk, map); renderCal(); }
          })
        : Promise.resolve();
      step.then(function () {
        if (monthKey(cur) !== mk) return;
        renderFeed((monthCache[mk].d || {})[cur]);
      });
    });
  }

  function bind() {
    $('#dyPrev').addEventListener('click', function () { if (canShift(-1)) go(shiftDay(cur, -1)); });
    $('#dyNext').addEventListener('click', function () { if (canShift(1)) go(shiftDay(cur, 1)); });

    $('#dyInput').addEventListener('change', function (e) {
      var v = e.target.value;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) go(v);
    });

    document.addEventListener('click', function (e) {
      // 点公演 / 直播回放（统计页里「这一天 · 点回放」）
      var play = e.target.closest('[data-play]');
      if (play) track('day:play');

      var big = e.target.closest('.dy-imgs img');
      if (big) { openBig(big.getAttribute('data-big') || big.src); return; }

      var calT = e.target.closest('[data-calopen]');
      if (calT) { calOpen = !calOpen; renderCal(); return; }

      var cell = e.target.closest('[data-day]');
      if (cell) { e.preventDefault(); go(cell.getAttribute('data-day')); return; }

      var sh = e.target.closest('[data-shift]');
      if (sh) {
        var n = Number(sh.getAttribute('data-shift')) || 0;
        if (n && canShift(n)) go(shiftDay(cur, n));
        return;
      }

      var ctd = e.target.closest('[data-calend]');
      if (ctd) { go(ymd(new Date())); return; }

      var calBtn = e.target.closest('[data-cal]');
      if (calBtn) {
        calM += Number(calBtn.getAttribute('data-cal'));
        if (calM < 0) { calM = 11; calY--; }
        if (calM > 11) { calM = 0; calY++; }
        renderCal();
        return;
      }

      var jump = e.target.closest('[data-jump]');
      if (jump) {
        var el = document.getElementById(jump.getAttribute('data-jump'));
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }

      var more = e.target.closest('[data-expand]');
      if (more) {
        var box = more.previousElementSibling;
        if (box) {
          $all('.dy-hidden', box).forEach(function (x) { x.classList.remove('dy-hidden'); });
        }
        more.remove();
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'ArrowLeft') { if (canShift(-1)) go(shiftDay(cur, -1)); }
      if (e.key === 'ArrowRight') { if (canShift(1)) go(shiftDay(cur, 1)); }
    });

    // 外部改 hash（分享链接 / 浏览器前进后退）也要跟着走
    window.addEventListener('hashchange', function () {
      var h = (location.hash || '').replace('#', '');
      if (h && h !== cur && /^\d{4}-\d{2}-\d{2}$/.test(h)) go(h, false);
    });
  }

  // ---------------- 埋点（与主站同一套 /track，带 ?notrack=1 的浏览器不上报） ----------------
  function track(ev) {
    try {
      if (localStorage.getItem('wyc-notrack') === '1') return;
      new Image().src = './track?e=' + encodeURIComponent(String(ev).slice(0, 40)) + '&t=' + Date.now();
    } catch (_) { /* 忽略 */ }
  }
  // 打开页面报一条（一次浏览器会话一次，刷新不重复）——统计页里就是「这一天 · 打开」
  function trackOpen() {
    var first = true;
    try {
      var d = ymd(new Date(Date.now() + 8 * 3600e3)); // 北京时间当天
      var k = 'wyc-day-open-' + d;
      if (sessionStorage.getItem(k)) first = false;
      else sessionStorage.setItem(k, '1');
    } catch (_) { /* 无痕模式照报一次 */ }
    if (first) track('day:open');
  }

  // ---------------- 启动 ----------------
  function boot() {
    if (window.__DAY_BOOTED__) return;
    window.__DAY_BOOTED__ = true;
    trackOpen();

    // iOS Safari 不认 meta 里的 user-scalable=no，双指缩放只能这样拦
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
    document.addEventListener('dblclick', function (e) { e.preventDefault(); }, { passive: false });

    loadIndex().then(function (j) {
      IDX = j;
      DAYS = Object.keys(j.days).sort();
      var hash = (location.hash || '').replace('#', '');
      var latest = DAYS[DAYS.length - 1];
      // 🔴 空白日也要能停在原地（显示「这一天没有记录」），不能悄悄跳回最新一天
      cur = /^\d{4}-\d{2}-\d{2}$/.test(hash) ? hash : latest;
      bind();
      go(cur, false);
    }).catch(function (e) {
      $('#dyFeed').innerHTML = '<div class="dy-empty"><b>数据读不到</b>' + esc(e.message) + '</div>';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
