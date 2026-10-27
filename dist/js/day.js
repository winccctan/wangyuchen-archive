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
  var IMG = 'https://idol.wyc0518.cc/img?u=';

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
  function hhmm(ts) {
    var d = new Date(Number(ts) + 8 * 3600 * 1000);
    return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
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
    $('#dyPrev').disabled = !nearest(-1);
    $('#dyNext').disabled = !nearest(1);
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

    $('#dyCal').innerHTML = head + '<div class="dy-cal-grid">' + cells + '</div>';
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
        return '<article class="dy-c dy-pf">'
          + '<div class="dy-pf-top"><b>' + esc(p.t || '公演') + '</b>'
          + (p.tm ? '<time>' + esc(p.tm) + '</time>' : '') + '</div>'
          + (p.songs && p.songs.length
            ? '<div class="dy-songs">' + p.songs.map(function (s) { return '<span>' + esc(s) + '</span>'; }).join('') + '</div>'
            : '<div class="dy-pf-empty">这场没有收录曲目</div>')
          + '</article>';
      }).join('') + '</section>';
  }

  function liveHtml(list) {
    return list.slice().sort(function (a, b) { return (a.tm || '') < (b.tm || '') ? -1 : 1; })
      .map(function (l) {
        var title = /^\d+$/.test(l.t) || !l.t ? '直播' : l.t;
        var meta = [l.tm, dur(l.dur)].filter(Boolean).join(' · ');
        return '<article class="dy-c dy-lv">'
          // 封面走主站 /img 代理：48.cn 原图 900KB+，代理那头有 1 年边缘缓存，第二次秒开
          + (l.cov ? '<img class="dy-lv-cov" src="' + IMG + encodeURIComponent(l.cov) + '" alt="">' : '')
          + '<div class="dy-lv-b"><b>' + esc(title) + '</b>'
          + (meta ? '<div class="dy-meta">' + esc(meta) + '</div>' : '') + '</div>'
          + '</article>';
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
  // 这一页问的是「她这一天干了什么」⇒ 标题点她名字的、或她所在的 NIII 队排前面，
  // 别团（SNH48 / BEJ48 / CKG48 / GNZ 其他队）一律折在按钮后面，不占版面。
  function biliSplit(list) {
    var mine = [], team = [], other = [];
    list.forEach(function (v) {
      var t = String(v.t || '');
      if (/王语晨/.test(t)) mine.push(v);
      else if (/NIII|NⅢ/i.test(t)) team.push(v);
      else other.push(v);
    });
    var byNew = function (a, b) { return (b.tm || '') < (a.tm || '') ? -1 : 1; };
    return { mine: mine.sort(byNew), team: team.sort(byNew), other: other.sort(byNew),
      main: mine.concat(team).sort(byNew) };
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
    var rows, more = '';

    if (g.main.length) {
      // 有她的：相关全列，别团折叠
      rows = g.main.map(function (v) { return biliRow(v, ''); }).join('')
        + g.other.map(function (v) { return biliRow(v, ' dy-hidden'); }).join('');
      if (g.other.length) {
        more = '<button type="button" class="dy-more" data-expand="bv">另有 '
          + g.other.length + ' 条其他团公演</button>';
      }
    } else {
      // 这一天只有别团的公演（全团联排 / 其他队），列前 6 条，余下折叠
      rows = g.other.slice(0, LIMIT).map(function (v) { return biliRow(v, ''); }).join('')
        + g.other.slice(LIMIT).map(function (v) { return biliRow(v, ' dy-hidden'); }).join('');
      if (g.other.length > LIMIT) {
        more = '<button type="button" class="dy-more" data-expand="bv">展开全部 '
          + g.other.length + ' 条（都是其他团）</button>';
      }
    }

    return '<div class="dy-c dy-bvlist" data-box="bv">' + rows + '</div>' + more + '</section>';
  }

  function msgHtml(list) {
    var LIMIT = 8;
    var lastT = '';
    var rows = list.map(function (m, i) {
      var ts = m[0], text = m[1] || '', nImg = m[2] || 0, isVid = m[3] || 0;
      var body;
      if (text) {
        var tags = '';
        if (nImg) tags += '<span class="dy-tag">图片 ×' + nImg + '</span>';
        if (isVid) tags += '<span class="dy-tag">视频</span>';
        body = '<p>' + esc(text) + tags + '</p>';
      } else {
        var bits = [];
        if (nImg) bits.push('图片 ×' + nImg);
        if (isVid) bits.push('视频');
        body = '<p class="blank">' + (bits.join(' · ') || '语音 / 卡片') + '</p>';
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
    if (day.bili && day.bili.length) html += secHead('bv', '投稿', day.bili.length) + biliHtml(day.bili);
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
    var mk = monthKey(cur);
    $('#dyFeed').innerHTML = '<div class="dy-loading">读取中…</div>';
    loadMonth(mk).then(function (j) {
      if (monthKey(cur) !== mk) return;      // 期间又切走了
      renderFeed((j.d || {})[cur]);
    });
  }

  function bind() {
    $('#dyPrev').addEventListener('click', function () { var d = nearest(-1); if (d) go(d); });
    $('#dyNext').addEventListener('click', function () { var d = nearest(1); if (d) go(d); });

    $('#dyInput').addEventListener('change', function (e) {
      var v = e.target.value;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) go(v);
    });

    document.addEventListener('click', function (e) {
      var calT = e.target.closest('[data-calopen]');
      if (calT) { calOpen = !calOpen; renderCal(); return; }

      var cell = e.target.closest('[data-day]');
      if (cell) { e.preventDefault(); go(cell.getAttribute('data-day')); return; }

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
      if (e.key === 'ArrowLeft') { var p = nearest(-1); if (p) go(p); }
      if (e.key === 'ArrowRight') { var n = nearest(1); if (n) go(n); }
    });

    // 外部改 hash（分享链接 / 浏览器前进后退）也要跟着走
    window.addEventListener('hashchange', function () {
      var h = (location.hash || '').replace('#', '');
      if (h && h !== cur && /^\d{4}-\d{2}-\d{2}$/.test(h)) go(h, false);
    });
  }

  // ---------------- 启动 ----------------
  function boot() {
    if (window.__DAY_BOOTED__) return;
    window.__DAY_BOOTED__ = true;

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
