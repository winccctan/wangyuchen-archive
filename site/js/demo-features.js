/* =======================================================================
   demo-features.js —— 候选功能的演示实现
   ① 收藏 + 收藏码   ② 搜索类型筛选（仅口袋发言）   ③ 分享卡片（单条 / 多选 + 复制文字）
   ④ 随机考古 + 去年今日   ⑤ 发言热力图（点某天可跳转）   ⑥ 开播实时提醒
   —— 全部以「后处理装饰 DOM」的方式实现，不改动 app.js 的渲染逻辑。
   ======================================================================= */
(function () {
  'use strict';

  /* ============================ 工具 ============================ */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { return false; } return true; }
  };
  const bjDate = (ts) => {
    const d = new Date(Number(ts) + 8 * 3600e3);
    return d.toISOString().slice(0, 10);
  };
  const bjTime = (ts) => new Date(Number(ts) + 8 * 3600e3).toISOString().slice(11, 16);
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  // 时间戳 → 北京日期(YYYY-MM-DD)，避免 toISOString 的 UTC 偏移导致差一天
  const fmtBJ = (d) => { const x = new Date(Number(d.getTime ? d.getTime() : d) + 8 * 3600e3); return x.getUTCFullYear() + '-' + p2(x.getUTCMonth() + 1) + '-' + p2(x.getUTCDate()); };
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  // 分享卡上口袋表情的边长：单条正文 40px 字 / 多条拼图 36px 字，各配一个尺寸
  const SHARE_EM = 44, SHARE_EM_M = 38;

  /* ---- 埋点：口袋里这 7 个小功能用了多少（app.js 的 track() 走 /track 信标）----
     🔴 新增事件名必须同时加进 worker/index.js 的 EVENTS 白名单，否则记了也不显示。 */
  const trk = (ev) => { try { if (typeof track === 'function') track(ev); } catch (_) {} };

  /** 复制到剪贴板：优先 Clipboard API，失败回退 textarea + execCommand */
  async function copyText(text, okMsg) {
    const ok = okMsg || '✅ 已复制';
    try {
      await navigator.clipboard.writeText(text);
      toast(ok);
      return true;
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(ta);
        ta.select(); ta.setSelectionRange(0, ta.value.length);
        const done = document.execCommand('copy');
        ta.remove();
        toast(done ? ok : '复制失败，请手动选择文本');
        return done;
      } catch (_e2) {
        toast('复制失败，请手动选择文本');
        return false;
      }
    }
  }

  /** 若干条发言 → 纯文本（用于「复制文字」分享） */
  function msgsToText(msgs) {
    const head = msgs.length > 1
      ? `王语晨 · 口袋发言（共 ${msgs.length} 条）`
      : '王语晨 · 口袋发言';
    const body = msgs.map((m) => {
      const t = String(m.text || '').trim() || `［${TYPE_NAME[typeOfMsg(m)]}］`;
      const tags = [];
      if (m.images && m.images.length) tags.push(`［图 ${m.images.length} 张］`);
      if (m.video) tags.push('［视频］');
      if (m.audio) tags.push('［语音］');
      return `${bjDate(m.msgTime)} ${bjTime(m.msgTime)}\n${t}${tags.length ? '\n' + tags.join('') : ''}`;
    }).join('\n\n');
    return `${head}\n\n${body}\n\n—— 王语晨 · 补档站  idol.wyc0518.cc`;
  }

  /** 发言类型归类（用于「搜索增强」的类型筛选） */
  function typeOfMsg(m) {
    if (!m || !m.msgType) return 'text';
    const t = m.msgType;
    if (m.video || /VIDEO/.test(t)) return 'video';
    if (m.audio || /AUDIO/.test(t)) return 'audio';
    if (m.images && m.images.length) return 'image';
    if (/IMAGE/.test(t)) return 'image';
    if (t === 'LIVEPUSH') return 'livepush';
    if (/REPLY/.test(t)) return 'reply';
    return 'text';
  }
  const TYPE_NAME = {
    text: '文字', image: '图片', audio: '语音', video: '视频',
    reply: '回复', livepush: '直播推送'
  };

  /* ============================ 状态 ============================ */
  const FAV_KEY = 'wyc-demo-fav-v1';
  const HIS_KEY = 'wyc-demo-search-his-v1';
  const RECENT_KEY = 'wyc-demo-recent-v1';
  const NOTIFY_KEY = 'wyc-demo-notified-live-v1';

  const F = {
    typeFilter: 'all',       // 搜索增强：类型筛选
    favs: LS.get(FAV_KEY, []),      // 收藏
    his: LS.get(HIS_KEY, []),       // 搜索历史
    recent: LS.get(RECENT_KEY, []), // 最近观看（续看）
    multi: false,            // 多选分享模式
    sel: new Set()           // 多选：已选 msgKey 集合
  };

  /** 日期字符串(YYYY-MM-DD) → 北京时间当天 0 点的时间戳 */
  const dayTs = (day) => new Date(day + 'T00:00:00+08:00').getTime();
  const saveFavs = () => LS.set(FAV_KEY, F.favs);
  const saveHis = () => LS.set(HIS_KEY, F.his);
  const saveRecent = () => LS.set(RECENT_KEY, F.recent);
  const isFav = (k) => F.favs.some((x) => x.k === k);

  /* ======================= 通用：弹窗 ======================= */
  function modal(title, bodyHtml, opts) {
    closeModal();
    const wrap = document.createElement('div');
    wrap.className = 'dm-mask';
    wrap.id = 'dmModal';
    wrap.innerHTML = `<div class="dm-modal${opts && opts.wide ? ' dm-wide' : ''}" role="dialog">
      <div class="dm-modal-h"><b>${esc(title)}</b><button class="dm-x" type="button" aria-label="关闭">✕</button></div>
      <div class="dm-modal-b">${bodyHtml}</div>
      ${opts && opts.footer ? `<div class="dm-modal-f">${opts.footer}</div>` : ''}
    </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) closeModal(); });
    $('.dm-x', wrap).addEventListener('click', closeModal);
    return wrap;
  }
  function closeModal() { const m = $('#dmModal'); if (m) m.remove(); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'dm-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(() => toastEl.classList.add('on'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1900);
  }

  /* =====================================================================
     功能 ④ 搜索增强：类型筛选 chips + 搜索历史 + 关键词高亮
     ===================================================================== */
  function buildTypeChips() {
    const bar = document.createElement('div');
    bar.className = 'dm-chips';
    bar.id = 'dmTypeChips';
    const defs = [['all', '全部'], ['text', '文字'], ['image', '图片'], ['audio', '语音'],
      ['video', '视频'], ['reply', '回复'], ['livepush', '直播推送']];
    bar.innerHTML = defs.map(([k, n]) =>
      `<button class="dm-chip${k === 'all' ? ' on' : ''}" data-type="${k}" type="button">${n}</button>`
    ).join('');
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('.dm-chip');
      if (!b) return;
      F.typeFilter = b.dataset.type;
      trk('filter:type');   // 埋在「类型筛选」上：看有多少人在用这排 chips
      $$('.dm-chip', bar).forEach((x) => x.classList.toggle('on', x === b));
      applyTypeFilter();
    });
    return bar;
  }

  /** 按类型隐藏发言（在渲染后处理，不动原渲染逻辑） */
  function applyTypeFilter() {
    const panel = $('#panel-messages') || $('.panel');
    if (!panel) return;
    let hidden = 0;
    $$('.msg[data-mid]', panel).forEach((el) => {
      if (F.typeFilter === 'all') { el.classList.remove('dm-hide'); return; }
      const m = (typeof MSG_INDEX !== 'undefined') && MSG_INDEX.get(el.dataset.mid);
      const ok = m ? typeOfMsg(m) === F.typeFilter : true;
      el.classList.toggle('dm-hide', !ok);
      if (!ok) hidden++;
    });
    const note = $('#dmTypeNote');
    if (note) {
      note.textContent = F.typeFilter === 'all' ? ''
        : `已只看「${TYPE_NAME[F.typeFilter]}」，本屏隐藏 ${hidden} 条`;
      note.hidden = F.typeFilter === 'all';
    }
  }

  /** 关键词高亮：把 .msg-body 里命中的词包成 <mark> */
  function applyHighlight() {
    const q = (typeof state !== 'undefined' && state.query) ? state.query : '';
    const panel = $('#panel-messages') || $('.panel');
    if (!panel) return;
    if (!q) {
      $$('mark.dm-mark', panel).forEach((mk) => {
        const p = mk.parentNode;
        p.replaceChild(document.createTextNode(mk.textContent), mk);
        p.normalize();
      });
      return;
    }
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(' + safe + ')', 'ig');
    $$('.msg-body', panel).forEach((el) => {
      if (el.dataset.dmHl === q) return;
      const txt = el.textContent;
      if (!txt || !re.test(txt)) return;
      re.lastIndex = 0;
      el.innerHTML = esc(txt).replace(re, '<mark class="dm-mark">$1</mark>');
      el.dataset.dmHl = q;
    });
  }

  /** 搜索历史：聚焦搜索框时下拉 */
  function buildHisDropdown() {
    const input = $('#searchInput');
    if (!input) return;
    const box = document.createElement('div');
    box.className = 'dm-his';
    box.id = 'dmHis';
    box.hidden = true;
    input.parentNode.style.position = 'relative';
    input.parentNode.appendChild(box);

    const render = () => {
      if (!F.his.length) { box.hidden = true; return; }
      box.innerHTML = '<div class="dm-his-h">最近搜索 <button type="button" class="dm-his-clr">清空</button></div>'
        + F.his.map((h) => `<button class="dm-his-i" type="button" data-q="${esc(h)}">🔍 ${esc(h)}</button>`).join('');
      box.hidden = false;
    };
    input.addEventListener('focus', render);
    input.addEventListener('click', render);
    input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 180));
    box.addEventListener('mousedown', (e) => {
      const clr = e.target.closest('.dm-his-clr');
      if (clr) { F.his = []; saveHis(); box.hidden = true; return; }
      const it = e.target.closest('.dm-his-i');
      if (it) {
        input.value = it.dataset.q;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    // 回车 / 失焦时记入历史
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (v.length < 1) return;
      F.his = [v, ...F.his.filter((x) => x !== v)].slice(0, 8);
      saveHis();
    });
  }

  /* =====================================================================
     功能 ③ 分享卡片：Canvas 生成一张图，可直接下载发微博/群
     ===================================================================== */
  function wrapText(ctx, text, maxW) {
    const out = [];
    for (const para of String(text).split('\n')) {
      let cur = '';
      for (const ch of para) {
        if (ctx.measureText(cur + ch).width > maxW && cur) { out.push(cur); cur = ch; }
        else cur += ch;
      }
      out.push(cur);
    }
    return out;
  }

  /**
   * 分享卡片上的头像 = **她在口袋48里发言时用的头像**（m.sender.avatar，如
   * https://source3.48.cn/avatar/2023/.../....gif，50×50）。不是补档站那张公式照。
   * 实测该地址 crossOrigin='anonymous' 可正常加载（不会污染 canvas）。
   * 取不到就返回 null，卡片会退化成「鱼」字圆。
   */
  async function loadPocketAvatar(m, safe) {
    if (safe) return null;
    const raw = (m && m.sender && m.sender.avatar) ? m.sender.avatar : '';
    const u = raw ? (typeof toUrl === 'function' ? toUrl(raw) : raw) : '';
    if (!u || !/^https?:/i.test(u)) return null;
    try { return await loadImg(u, 4000); } catch (_) { return null; }
  }

  function loadImg(src, ms = 4000) {
    return new Promise((res, rej) => {
      const im = new Image(); im.crossOrigin = 'anonymous';
      let done = false;
      const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
      im.onload = () => finish(res, im);
      im.onerror = () => finish(rej, new Error('load fail'));
      // 之前 1.5s 超时太短：手机上图片慢一点就会退化成「鱼」字圆，看起来像头像丢了
      setTimeout(() => finish(rej, new Error('timeout')), ms);
      im.src = src;
    });
  }
  // 中心正方形裁剪绘制（cover），避免竖图被压扁
  function drawAvatarCover(g, img, dx, dy, size) {
    const ir = img.width / img.height;
    let sw, sh, sx, sy;
    if (ir > 1) { sh = img.height; sw = sh; sx = (img.width - sw) / 2; sy = 0; }
    else { sw = img.width; sh = sw; sx = 0; sy = (img.height - sh) / 2; }
    g.drawImage(img, sx, sy, sw, sh, dx, dy, size, size);
  }

  /* ---- 发言里的图片：画进分享卡片 ----
     图床（kd48-nosdn / source3.48.cn）响应头带 access-control-allow-origin: *，
     所以可以 crossOrigin='anonymous' 加载并安全画进 canvas（toDataURL 不会被污染）。
     加载失败的图直接跳过，不画占位 —— 保证画布永远不被污染、卡片永远能生成。 */
  async function loadMsgImages(m, limit) {
    const urls = ((m && m.images) || []).slice(0, limit || 4)
      .map((u) => (typeof toUrl === 'function' ? toUrl(u) : u))
      .filter((u) => /^https?:/i.test(u));
    const out = [];
    for (const u of urls) {
      try { out.push(await loadImg(u, 6000)); } catch (_) { /* 取不到就跳过这张 */ }
    }
    return out;
  }

  /** 图片区布局：1 张 → 等比完整显示；多张 → 两列网格（cover 裁切） */
  function layoutImages(imgs, x, y, availW, maxH1, cellH) {
    const GAP = 10;
    if (imgs.length === 1) {
      const im = imgs[0];
      const s = Math.min(availW / im.width, (maxH1 || 520) / im.height);
      const dw = im.width * s, dh = im.height * s;
      return { h: dh, cells: [{ img: im, dx: x, dy: y, dw, dh }] };
    }
    const cols = 2;
    const cw = (availW - GAP * (cols - 1)) / cols;
    // 默认正方形格子（跟微博/微信九宫格一致）：方图不裁切，横竖图按中心裁成方
    const chh = cellH && cellH > 0 ? Math.min(cw, cellH) : cw;
    const cells = [];
    imgs.slice(0, 4).forEach((im, i) => {
      const cx = x + (i % cols) * (cw + GAP);
      const cy = y + Math.floor(i / cols) * (chh + GAP);
      const ir = im.width / im.height, cr = cw / chh;
      let sw, sh, sx, sy;
      if (ir > cr) { sh = im.height; sw = sh * cr; sx = (im.width - sw) / 2; sy = 0; }
      else { sw = im.width; sh = sw / cr; sx = 0; sy = (im.height - sh) / 2; }
      cells.push({ img: im, sx, sy, sw, sh, dx: cx, dy: cy, dw: cw, dh: chh });
    });
    const rows = Math.ceil(Math.min(imgs.length, 4) / cols);
    return { h: rows * chh + (rows - 1) * GAP, cells };
  }

  /** 按布局把图片画出来（圆角矩形裁切） */
  function drawImages(g, lay, radius, offsetY) {
    if (!lay) return;
    const oy = offsetY || 0;
    lay.cells.forEach((c) => {
      g.save();
      roundRect(g, c.dx, c.dy + oy, c.dw, c.dh, radius == null ? 12 : radius); g.clip();
      if (c.sx != null) g.drawImage(c.img, c.sx, c.sy, c.sw, c.sh, c.dx, c.dy + oy, c.dw, c.dh);
      else g.drawImage(c.img, c.dx, c.dy + oy, c.dw, c.dh);
      g.restore();
    });
  }

  async function makeShareCard(m, safe) {
    const W = 880, PAD = 50, BODY_W = W - PAD * 2;
    // safe=true → 不加载任何远程图片（toDataURL 被污染时的兜底重画）
    const imgs = safe ? [] : await loadMsgImages(m, 4);
    const rawText = String(m.text || '').trim();
    // 有图就不必再写「［图片］」占位
    const text = rawText || (imgs.length ? '' : `［${TYPE_NAME[typeOfMsg(m)]}］`);
    const c = document.createElement('canvas');
    const g = c.getContext('2d');

    // 先量正文行数：口袋表情 [敲打] 要画成图，所以走 token 排版（不是纯文本换行）
    g.font = '500 40px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
    await preloadEmoji(text);
    const lines = text ? layoutTokens(g, tokenizeText(text), BODY_W, 0, SHARE_EM) : [];
    const LH = 58;
    const headH = 150, bodyH = lines.length * LH, footH = 106;
    const imgTop = headH + bodyH + (imgs.length ? 18 : 0);
    const imgLay = imgs.length ? layoutImages(imgs, PAD, imgTop, BODY_W, 660, 0) : null;
    const imgH = imgLay ? imgLay.h + 18 : 0;
    const H = headH + bodyH + imgH + footH + PAD;

    const dpr = 2;                    // 2 倍图，发出去更清晰
    c.width = W * dpr; c.height = H * dpr;
    g.scale(dpr, dpr);

    // 背景
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, H);
    // 顶部品牌渐变条
    const grd = g.createLinearGradient(0, 0, W, 8);
    grd.addColorStop(0, '#ff7aa2'); grd.addColorStop(1, '#ff9a62');
    g.fillStyle = grd; g.fillRect(0, 0, W, 8);
    // 右下角淡色圆（装饰）
    g.fillStyle = 'rgba(255,122,162,.07)';
    g.beginPath(); g.arc(W - 40, H - 30, 150, 0, Math.PI * 2); g.fill();

    // 头像：用她在口袋48发言时用的那张头像（m.sender.avatar）
    const avaSize = 88, ax = PAD, ay = 48;
    let drew = false;
    const avatarImg = await loadPocketAvatar(m, safe);
    if (avatarImg) {
      // 口袋头像原图只有 50×50，放大到 62px 会有点糊 → 开高质量平滑
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.save();
      g.beginPath(); g.arc(ax + avaSize / 2, ay + avaSize / 2, avaSize / 2, 0, Math.PI * 2); g.clip();
      drawAvatarCover(g, avatarImg, ax, ay, avaSize);
      g.restore();
      drew = true;
    }
    if (!drew) {
      g.fillStyle = '#ff7aa2';
      g.beginPath(); g.arc(ax + avaSize / 2, ay + avaSize / 2, avaSize / 2, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff';
      g.font = '600 42px "PingFang SC", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('鱼', ax + avaSize / 2, ay + avaSize / 2 + 1);
    }
    // 昵称 / 时间
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillStyle = '#1b1b1f';
    g.font = '600 36px "PingFang SC", sans-serif';
    g.fillText((m.sender && m.sender.nickname) || 'GNZ48-王语晨', ax + avaSize + 20, ay + 40);
    g.fillStyle = '#9a9aa2';
    g.font = '400 26px "PingFang SC", sans-serif';
    g.fillText(bjDate(m.msgTime) + ' ' + bjTime(m.msgTime) + ' · ' + (TYPE_NAME[typeOfMsg(m)] || ''), ax + avaSize + 20, ay + 78);

    // 正文
    g.fillStyle = '#26262c';
    g.font = '500 40px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
    lines.forEach((ln, i) => drawTokenLine(g, ln, PAD, headH + LH * (i + 1) - 12, 40, 'left', SHARE_EM));

    // 发言里的图片
    if (imgLay) {
      drawImages(g, imgLay, 14);
      // 右下角标一下张数
      if (imgs.length > 1) {
        g.fillStyle = 'rgba(0,0,0,.45)';
        roundRect(g, imgLay.cells[0].dx + imgLay.cells[0].dw - 80, imgLay.cells[0].dy + 14, 70, 36, 18); g.fill();
        g.fillStyle = '#fff'; g.font = '500 20px "PingFang SC", sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('共 ' + imgs.length + ' 张', imgLay.cells[0].dx + imgLay.cells[0].dw - 50, imgLay.cells[0].dy + 32);
        g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      }
    }

    // 页脚
    g.strokeStyle = '#eee'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(PAD, H - footH + 8); g.lineTo(W - PAD, H - footH + 8); g.stroke();
    g.fillStyle = '#b0b0b8';
    g.font = '400 26px "PingFang SC", sans-serif';
    g.fillText('王语晨 · 补档站', PAD, H - footH + 54);
    g.textAlign = 'right';
    g.fillText('idol.wyc0518.cc', W - PAD, H - footH + 54);
    g.textAlign = 'left';
    // （原来这里右侧有根小色条，正好压在网址末尾，看着像网址后面多了一根线 → 去掉）

    return c;
  }

  /** 手机（含 iPad）：手机上直接 a[download] 会落到「文件」App，进不了相册 */
  const isMobile = () => /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Mac/i.test(navigator.platform || ''));

  /**
   * 保存分享图。
   * 手机上优先用 Web Share API 调起系统分享面板 → 选「存储图像」直接进相册（iOS/Android 都行）；
   * 不支持（桌面浏览器等）就退回普通下载。
   */
  /** dataURL → File（同步转换，保住 click 的"用户手势"，否则部分浏览器会拒绝调起分享） */
  function dataUrlToFile(dataUrl, filename) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
    if (!m || typeof File !== 'function') return null;
    const bin = atob(m[2]);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new File([buf], filename, { type: m[1] || 'image/png' });
  }

  async function saveShareImage(dataUrl, filename) {
    // ⚠️ 手机上 a[download] 只会落到「文件」App 的下载文件夹，进不了相册（站长 2026-09-23 定）。
    // 所以手机端只有两条路：① Web Share 面板里的「存储图像」；② 长按图片保存。绝不退回下载。
    if (isMobile()) {
      try {
        const file = dataUrlToFile(dataUrl, filename);
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] });
          return true;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return true;      // 用户自己取消了，不算失败
      }
      toast('请在上方图片上长按 → 选「存储图像」存进相册');
      return true;
    }
    const a = document.createElement('a');
    a.href = dataUrl; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    toast('已下载');
    return true;
  }

  /** 保存按钮文案 + 弹窗提示文案（手机/桌面不同） */
  const saveBtnText = () => (isMobile() ? '⬇ 保存到相册' : '⬇ 下载图片');
  const saveTip = (copyWhat) => {
    const tail = copyWhat || '直接粘贴到微博、群里。';
    return isMobile()
      ? `长按图片选「存储图像」可直接存进相册；或点下面的按钮调起系统分享。也可以点「复制文字」${tail}`
      : `长按图片可保存 / 转发；也可以下载图片，或点「复制文字」${tail}`;
  };

  async function openShare(m) {
    trk('share:card');
    const mWrap = modal('生成分享卡片', '<div class="dm-share-loading">正在生成图片…</div>');
    try {
      let c = await makeShareCard(m);
      let url;
      try {
        url = c.toDataURL('image/png');
      } catch (_) {
        // 头像所在域名没开 CORS → canvas 被污染，toDataURL 会抛 SecurityError。
        // 这时重画一张不带头像的（纯 Canvas 绘制，绝不会失败）。
        c = await makeShareCard(m, true);
        url = c.toDataURL('image/png');
      }
      $('.dm-modal-b', mWrap).innerHTML =
        `<div class="dm-share-prev"><img src="${url}" alt="分享卡片预览" /></div>
         <div class="dm-share-tip">${saveTip()}</div>`;
      const f = document.createElement('div');
      f.className = 'dm-share-foot';
      f.innerHTML = `<button class="dm-btn primary" id="dmDl" type="button">${saveBtnText()}</button>
        <button class="dm-btn" id="dmCopy1" type="button">📋 复制文字</button>`;
      $('.dm-modal', mWrap).appendChild(f);
      $('#dmDl', mWrap).addEventListener('click', () => {
        saveShareImage(url, `wyc-${bjDate(m.msgTime)}-${bjTime(m.msgTime).replace(':', '')}.png`);
      });
      $('#dmCopy1', mWrap).addEventListener('click', () => {
        trk('share:text');
        copyText(msgsToText([m]), '✅ 已复制这条发言的文字');
      });
    } catch (e) {
      $('.dm-modal-b', mWrap).innerHTML = `<div class="dm-share-tip">生成失败：${esc(e.message)}</div>`;
    }
  }

  /* =====================================================================
     功能 ① 收藏 + 续看记忆
     ===================================================================== */
  function toggleFav(item) {
    const i = F.favs.findIndex((x) => x.k === item.k);
    if (i >= 0) { F.favs.splice(i, 1); trk('fav:del'); toast('已取消收藏'); }
    else { F.favs.unshift(item); trk('fav:add'); toast('⭐ 已加入收藏'); }
    saveFavs();
    syncFavButtons();
    const c = $('#dmFavCount'); if (c) c.textContent = F.favs.length ? String(F.favs.length) : '';
  }

  /** 把页面上的收藏按钮状态与数据对齐 */
  function syncFavButtons() {
    $$('.dm-fav').forEach((b) => {
      const on = isFav(b.dataset.k);
      b.classList.toggle('on', on);
      b.textContent = on ? '★' : '☆';
      b.title = on ? '取消收藏' : '收藏';
    });
  }

  function openFavList() {
    trk('fav:open');
    const items = F.favs;
    const body = items.length
      ? items.map((x) => `<div class="dm-favrow">
          <span class="dm-favtag t-${esc(x.t)}">${x.t === 'msg' ? '发言' : x.t === 'live' ? '直播' : x.t === 'perf' ? '公演' : '切片'}</span>
          <div class="dm-favmain">
            <div class="dm-fav-t">${esc(x.title)}</div>
            <div class="dm-fav-s">${esc(x.sub || '')}</div>
          </div>
          <button class="dm-fav-del" data-k="${esc(x.k)}" type="button">移除</button>
        </div>`).join('')
      : '<div class="dm-empty">还没有收藏。在发言、直播、公演或切片上点 ☆ 就能收藏。</div>';

    const recentH = F.recent.length
      ? `<div class="dm-sect-h">🕘 最近观看（接着看）</div>` + F.recent.map((x) => `
          <a class="dm-favrow link" href="${esc(x.url)}" target="_blank" rel="noopener">
            <span class="dm-favtag t-cut">${esc(x.tag || 'B站')}</span>
            <div class="dm-favmain"><div class="dm-fav-t">${esc(x.title)}</div>
            <div class="dm-fav-s">${esc(x.sub || '')}</div></div>
            <span class="dm-fav-go">继续看 ↗</span>
          </a>`).join('')
      : '';

    const codeBox = `
      <div class="dm-sect-h">📤 收藏码（换设备 / 备份）</div>
      <div class="dm-codebar">
        <button class="dm-btn" id="dmExport" type="button">复制收藏码</button>
        <button class="dm-btn ghost" id="dmImport" type="button">导入收藏码</button>
      </div>
      <textarea id="dmCode" class="dm-code" placeholder="把收藏码粘贴到这里，再点「导入收藏码」即可换设备恢复。"></textarea>`;

    const w = modal('⭐ 我的收藏', `<div class="dm-sect-h">收藏 ${items.length} 项</div>${body}${recentH}${codeBox}`);
    $('.dm-modal-b', w).addEventListener('click', (e) => {
      const del = e.target.closest('.dm-fav-del');
      if (del) {
        F.favs = F.favs.filter((x) => x.k !== del.dataset.k);
        saveFavs(); syncFavButtons(); openFavList();
      }
    });
    const ta = $('#dmCode', w);
    $('#dmExport', w).addEventListener('click', async () => {
      trk('fav:code');
      if (!F.favs.length) { toast('还没有可导出的收藏'); return; }
      // 收藏码 = 版本前缀 + base64(JSON)。带前缀便于识别与防误粘。
      const code = 'WYC1:' + btoa(unescape(encodeURIComponent(JSON.stringify(F.favs))));
      if (ta) ta.value = code;
      try {
        await navigator.clipboard.writeText(code);
        toast('✅ 收藏码已复制，换设备粘贴即可恢复');
      } catch (_) {
        if (ta) { ta.select(); ta.setSelectionRange(0, ta.value.length); }
        toast('已生成收藏码，请手动复制文本框内容');
      }
    });
    $('#dmImport', w).addEventListener('click', () => {
      trk('fav:code');
      const raw = (ta && ta.value || '').trim();
      if (!raw) { toast('请先粘贴收藏码'); return; }
      try {
        const json = raw.indexOf('WYC1:') === 0 ? raw.slice(5) : raw;
        const arr = JSON.parse(decodeURIComponent(escape(atob(json))));
        if (!Array.isArray(arr)) throw new Error('格式不对');
        // 合并去重（按 k），不覆盖本地原有，也不与任何人共享——纯本地
        const map = new Map(F.favs.map((x) => [x.k, x]));
        let added = 0;
        arr.forEach((x) => { if (x && x.k && !map.has(x.k)) { map.set(x.k, x); added++; } });
        F.favs = [...map.values()];
        saveFavs(); syncFavButtons(); openFavList();
        toast(added ? `✅ 已导入 ${added} 条收藏` : '没有新增（本地已存在）');
      } catch (e) {
        toast('收藏码无法识别：' + e.message);
      }
    });
  }

  /** 续看：记录点开过的 B 站视频 */
  function pushRecent(o) {
    F.recent = [o, ...F.recent.filter((x) => x.url !== o.url)].slice(0, 12);
    saveRecent();
  }

  /* ⚠️ 「进来自动定位到上次看到的位置」已按用户要求移除（定位不准）：
     原实现会在进站 900ms 后把发言页滚到上次的 scrollY 并弹「已回到上次看到的位置」。
     这里顺手把历史留下的数据清掉，避免残留。 */

  /* =====================================================================
     功能 ⑤ 随机考古 + 去年今日：随机跳一天 / 跳到往年今日
     —— 注意：必须用「北京时间当天 0 点」的时间戳设置 dateFrom/dateTo，
        否则筛选态是字符串（与数字比较恒为真或 NaN），会导致「时间筛选清除不了」。
     ===================================================================== */
  function jumpToDayWithMsg(day, m, tip) {
    if (typeof state === 'undefined') return;
    state.query = '';
    const si = $('#searchInput'); if (si) si.value = '';
    const ts = dayTs(day);
    state.dateFrom = ts;                 // 当天 0 点
    state.dateTo = ts + 86400000;        // 次日 0 点（含当天），与原站筛选用法一致
    state.dayLimit = 3;
    if (typeof switchTab === 'function') switchTab('messages');
    if (typeof renderAll === 'function') renderAll();
    setTimeout(() => {
      // m 可为空（热力图点某天时只定位到那天，不指定哪条）
      let el = null;
      if (m) {
        const mid = (typeof msgKey === 'function') ? msgKey(m) : m.msgTime;
        el = (mid != null)
          ? document.querySelector('.msg[data-mid="' + ((window.CSS && CSS.escape) ? CSS.escape(String(mid)) : String(mid)) + '"]')
          : null;
      }
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('dm-flash');
        setTimeout(() => el.classList.remove('dm-flash'), 2600);
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });   // 没指定那条就把列表滚到那天开头
      }
      toast(tip);
    }, 500);
  }

  /** 只跳到某一天（不定位到具体那条） */
  function jumpToDay(day, tip) { jumpToDayWithMsg(day, null, tip); }

  function randomDig() {
    trk('dig:rand');
    const msgs = (typeof DATA !== 'undefined' && DATA.messages) || [];
    const pool = msgs.filter((m) => m.text && String(m.text).trim().length >= 10);
    if (!pool.length) { toast('数据还在加载，稍后再试'); return; }
    const m = pool[Math.floor(Math.random() * pool.length)];
    const day = bjDate(m.msgTime);
    jumpToDayWithMsg(day, m, '🎲 考古到 ' + day);
  }

  /** 去年今日：找往年「今天（北京时间 月-日）」的发言，有就跳过去 */
  function lastYearToday() {
    trk('dig:last');
    const run = () => {
      const msgs = (typeof DATA !== 'undefined' && DATA.messages) || [];
      if (!msgs.length) { toast('数据还在加载，稍后再试'); return; }
      const now = new Date(Date.now() + 8 * 3600e3);
      const todayMD = p2(now.getUTCMonth() + 1) + '-' + p2(now.getUTCDate());
      const thisYear = String(now.getUTCFullYear());
      const hits = msgs.filter((m) => {
        const d = bjDate(m.msgTime);
        return d.slice(5) === todayMD && d.slice(0, 4) < thisYear;
      });
      if (!hits.length) { toast('📅 往年今天还没有历史发言'); return; }
      hits.sort((a, b) => Number(b.msgTime) - Number(a.msgTime));
      const m = hits[0];
      jumpToDayWithMsg(bjDate(m.msgTime), m, '📅 去年今日 · ' + bjDate(m.msgTime));
    };
    // 先确保历史全量已加载，否则可能漏掉早年同日的发言
    if (typeof allMonthsLoaded !== 'undefined' && !allMonthsLoaded && typeof loadRemainingMonths === 'function') {
      toast('正在补齐历史数据…');
      loadRemainingMonths().then(run);
    } else {
      run();
    }
  }

  /* =====================================================================
     DOM 装饰：给发言 / 卡片挂按钮
     ===================================================================== */
  function decorate() {
    // 发言：分享 + 收藏
    $$('.msg[data-mid]').forEach((el) => {
      if (el.dataset.dmDone) return;
      el.dataset.dmDone = '1';
      const mid = el.dataset.mid;
      const head = $('.msg-head', el);
      if (!head) return;
      const box = document.createElement('span');
      box.className = 'dm-msg-acts';
      box.innerHTML = `<button class="dm-fav" data-k="msg:${esc(mid)}" type="button" title="收藏">☆</button>
        <button class="dm-share" type="button" title="生成分享卡片">分享</button>`;
      head.appendChild(box);
    });

    // 直播 / 公演卡片：收藏
    $$('.card[data-k]').forEach((el) => {
      if (el.dataset.dmDone) return;
      el.dataset.dmDone = '1';
      const b = document.createElement('button');
      b.className = 'dm-fav dm-fav-card';
      b.type = 'button';
      b.dataset.k = el.dataset.k;
      b.dataset.t = el.dataset.t;
      b.dataset.title = el.dataset.title;
      b.dataset.time = el.dataset.time;
      b.textContent = '☆';
      el.appendChild(b);
    });

    // 直播切片 / 回放卡片：收藏 + 记录「最近观看」
    $$('.pc-card').forEach((el) => {
      if (el.dataset.dmDone) return;
      el.dataset.dmDone = '1';
      const b = document.createElement('button');
      b.className = 'dm-fav dm-fav-pc';
      b.type = 'button';
      b.dataset.k = 'cut:' + el.getAttribute('href');
      b.dataset.t = 'cut';
      b.dataset.title = (el.querySelector('.pc-ov.date') || {}).textContent || 'B站 视频';
      b.dataset.time = '';
      b.textContent = '☆';
      el.parentNode.insertBefore(b, el.nextSibling);
    });

    syncFavButtons();
    renderMultiChecks();
    applyTypeFilter();
    applyHighlight();
  }

  /** 多选：根据 F.multi 给发言挂 / 摘勾选框（不依赖 dmDone，可反复调用） */
  function renderMultiChecks() {
    $$('.msg[data-mid]').forEach((el) => {
      const mid = el.dataset.mid;
      const head = $('.msg-head', el);
      if (!head) return;
      let cb = el.querySelector('.dm-mcheck');
      if (F.multi) {
        if (!cb) {
          cb = document.createElement('input');
          cb.type = 'checkbox'; cb.className = 'dm-mcheck'; cb.dataset.mid = mid;
          cb.addEventListener('change', () => {
            if (cb.checked) F.sel.add(mid); else F.sel.delete(mid);
            el.classList.toggle('dm-sel', cb.checked);
            syncMultiBar();
          });
          head.insertBefore(cb, head.firstChild);
        }
        cb.checked = F.sel.has(mid);
        el.classList.toggle('dm-sel', cb.checked);
      } else if (cb) {
        cb.remove();
        el.classList.remove('dm-sel');
      }
    });
  }

  let multiBar = null;
  function toggleMulti() {
    F.multi = !F.multi;
    trk(F.multi ? 'multi:on' : 'multi:off');
    if (!F.multi) F.sel.clear();
    document.body.classList.toggle('dm-multi', F.multi);
    syncMultiBar();
    renderMultiChecks();
    if (!F.multi && multiBar) multiBar.hidden = true;
  }
  function syncMultiBar() {
    if (F.multi) {
      if (!multiBar) {
        multiBar = document.createElement('div');
        multiBar.className = 'dm-multibar';
        multiBar.innerHTML =
          `<span class="dm-multin">已选 <b>0</b> 条</span>
           <button class="dm-btn primary" id="dmMultiShare" type="button">🖼 生成分享图</button>
           <button class="dm-btn ghost" id="dmMultiClear" type="button">清空</button>
           <button class="dm-btn ghost" id="dmMultiExit" type="button">退出多选</button>`;
        document.body.appendChild(multiBar);
        $('#dmMultiShare', multiBar).addEventListener('click', openMultiShare);
        $('#dmMultiClear', multiBar).addEventListener('click', () => { F.sel.clear(); renderMultiChecks(); syncMultiBar(); });
        $('#dmMultiExit', multiBar).addEventListener('click', toggleMulti);
      }
      multiBar.hidden = false;
    } else if (multiBar) {
      multiBar.hidden = true;
    }
    const n = multiBar && multiBar.querySelector('.dm-multin b');
    if (n) n.textContent = F.sel.size;
  }

  /** 多张分享卡：把若干发言竖向堆叠成一张长图（每条最多带 2 张图，整体最多 8 张） */
  async function makeShareCardMulti(msgs, safe) {
    const W = 880, PAD = 50, BODY_W = W - PAD * 2;
    const g0 = document.createElement('canvas').getContext('2d');
    g0.font = '500 36px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
    const LH = 54, cardGap = 28, headH = 88;
    let imgBudget = safe ? 0 : 8;                 // 控制总图片数，避免长图太夸张
    const layout = [];
    for (const m of msgs.slice(0, 12)) {
      const imgs = imgBudget > 0 ? await loadMsgImages(m, Math.min(2, imgBudget)) : [];
      imgBudget -= imgs.length;
      const ava = await loadPocketAvatar(m, safe);     // 每条用它自己在口袋的头像
      const rawText = String(m.text || '').trim();
      const text = rawText || (imgs.length ? '' : `［${TYPE_NAME[typeOfMsg(m)]}］`);
      await preloadEmoji(text);
      const lines = text ? layoutTokens(g0, tokenizeText(text), BODY_W, 0, SHARE_EM_M) : [];
      const imgLay = imgs.length ? layoutImages(imgs, PAD + 16, 0, BODY_W - 32, 560, 0) : null;
      const imgH = imgLay ? imgLay.h + 14 : 0;
      layout.push({ m, lines, imgs, imgLay, imgH, ava, h: headH + lines.length * LH + 40 + imgH });
    }
    const H = PAD * 2 + layout.reduce((a, x) => a + x.h, 0) + cardGap * (layout.length - 1) + 76;
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    const dpr = 2;
    c.width = W * dpr; c.height = H * dpr; g.scale(dpr, dpr);
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    const grd = g.createLinearGradient(0, 0, W, 8);
    grd.addColorStop(0, '#ff7aa2'); grd.addColorStop(1, '#ff9a62');
    g.fillStyle = grd; g.fillRect(0, 0, W, 8);
    let y = PAD;
    for (const it of layout) {
      g.fillStyle = '#faf4f7';
      roundRect(g, PAD, y, BODY_W, it.h, 14); g.fill();
      if (it.ava) {
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
        g.save();
        g.beginPath(); g.arc(PAD + 30, y + 34, 24, 0, Math.PI * 2); g.clip();
        drawAvatarCover(g, it.ava, PAD + 6, y + 10, 48);
        g.restore();
      } else {
        g.fillStyle = '#ff7aa2';
        g.beginPath(); g.arc(PAD + 30, y + 34, 24, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff'; g.font = '600 26px "PingFang SC", sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('鱼', PAD + 30, y + 35);
      }
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      g.fillStyle = '#1b1b1f'; g.font = '600 30px "PingFang SC", sans-serif';
      g.fillText((it.m.sender && it.m.sender.nickname) || 'GNZ48-王语晨', PAD + 66, y + 44);
      g.fillStyle = '#9a9aa2'; g.font = '400 24px "PingFang SC", sans-serif';
      g.fillText(bjDate(it.m.msgTime) + ' ' + bjTime(it.m.msgTime), PAD + 66, y + 72);
      g.fillStyle = '#26262c'; g.font = '500 36px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
      it.lines.forEach((ln, i) => drawTokenLine(g, ln, PAD + 16, y + headH + LH * (i + 1) - 10, 36, 'left', SHARE_EM_M));
      if (it.imgLay) drawImages(g, it.imgLay, 12, y + headH + it.lines.length * LH + 10);
      y += it.h + cardGap;
    }
    g.fillStyle = '#b0b0b8'; g.font = '400 26px "PingFang SC", sans-serif';
    g.fillText('王语晨 · 补档站  idol.wyc0518.cc', PAD, H - 38);
    g.textAlign = 'right'; g.fillStyle = grd; g.fillText('共 ' + msgs.length + ' 条', W - PAD, H - 38);
    return c;
  }

  async function openMultiShare() {
    trk('multi:card');
    const msgs = [...F.sel].map((k) => (typeof MSG_INDEX !== 'undefined') && MSG_INDEX.get(k)).filter(Boolean);
    if (msgs.length < 1) { toast('先勾选几条发言'); return; }
    const w = modal('生成分享卡片', `<div class="dm-share-loading">正在拼接 ${msgs.length} 条…</div>`);
    try {
      let c = await makeShareCardMulti(msgs);
      let url;
      try { url = c.toDataURL('image/png'); }
      catch (_) { c = await makeShareCardMulti(msgs, true); url = c.toDataURL('image/png'); }
      $('.dm-modal-b', w).innerHTML =
        `<div class="dm-share-prev"><img src="${url}" alt="分享卡片预览" /></div>
         <div class="dm-share-tip">${saveTip('把这几条发言一次性复制走。')}</div>`;
      const f = document.createElement('div'); f.className = 'dm-share-foot';
      f.innerHTML = `<button class="dm-btn primary" id="dmDl2" type="button">${saveBtnText()}</button>
        <button class="dm-btn" id="dmCopy2" type="button">📋 复制文字</button>`;
      $('.dm-modal', w).appendChild(f);
      $('#dmDl2', w).addEventListener('click', () => {
        saveShareImage(url, `wyc-multi-${msgs.length}.png`);
      });
      $('#dmCopy2', w).addEventListener('click', () => {
        trk('multi:text');
        copyText(msgsToText(msgs), `✅ 已复制 ${msgs.length} 条发言文字`);
      });
    } catch (e) {
      $('.dm-modal-b', w).innerHTML = `<div class="dm-share-tip">生成失败：${esc(e.message)}</div>`;
    }
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* =====================================================================
     功能 ⑦ 发言热力图：按天聚合发言数，GitHub 风格年时视图
     ===================================================================== */
  function heatmapHtml() {
    const msgs = (typeof DATA !== 'undefined' && DATA.messages) || [];
    if (!msgs.length) return '<div class="dm-empty">数据加载中…</div>';
    const counts = {};
    msgs.forEach((m) => { const d = bjDate(m.msgTime); if (d) counts[d] = (counts[d] || 0) + 1; });
    const days = Object.keys(counts);
    const min = days.reduce((a, b) => (a < b ? a : b));
    const max = days.reduce((a, b) => (a > b ? a : b));
    const start = new Date(min + 'T00:00:00+08:00');
    let dow = start.getUTCDay(); if (dow === 0) dow = 7;
    start.setUTCDate(start.getUTCDate() - (dow - 1));      // 回退到周一
    const end = new Date(max + 'T00:00:00+08:00');
    const cols = [];
    const cur = new Date(start);
    while (cur <= end) {
      const week = [];
      for (let i = 0; i < 7; i++) { week.push(fmtBJ(cur)); cur.setUTCDate(cur.getUTCDate() + 1); }
      cols.push(week);
    }
    const maxC = Math.max(1, ...days.map((d) => counts[d]));
    const lvl = (c) => c === 0 ? 0 : c <= maxC * 0.15 ? 1 : c <= maxC * 0.4 ? 2 : c <= maxC * 0.7 ? 3 : 4;
    const MON = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    const monthRow = cols.map((week) => {
      const d = week[0]; const mm = Number(d.slice(5, 7)); const dd = Number(d.slice(8, 10));
      return `<span class="dm-hm-m">${dd <= 7 ? MON[mm - 1] : ''}</span>`;
    }).join('');
    // 年份行：4 年跨度只看「11月/12月」分不清是哪一年 → 每年 1 月 1 日所在那一列标年份
    //（第一列也要标，否则最早那年（从年中开始）没有标签）
    const yearRow = cols.map((week, i) => {
      const jan1 = week.find((d) => d.slice(5) === '01-01');
      const y = i === 0 ? week[0].slice(0, 4) : (jan1 ? jan1.slice(0, 4) : '');
      return `<span class="dm-hm-y">${y}</span>`;
    }).join('');
    const grid = cols.map((week) => `<div class="dm-hm-col">` + week.map((ds) => {
      const c = counts[ds] || 0;
      const t = ds + (c ? '：' + c + ' 条发言（点击跳到这天）' : '：无发言');
      return `<i class="dm-hm dm-hm${lvl(c)}" data-day="${ds}" data-count="${c}" title="${esc(t)}"></i>`;
    }).join('') + `</div>`).join('');
    const total = days.reduce((a, d) => a + counts[d], 0);
    return `<div class="dm-hm-head">共 <b>${total.toLocaleString()}</b> 条发言 · 跨度 <b>${min}</b> ~ <b>${max}</b>
        <span class="dm-hm-tip">点任意一天 → 直接跳到那天</span></div>
      <div class="dm-hm-scroll">
        <div class="dm-hm-years">${yearRow}</div>
        <div class="dm-hm-months">${monthRow}</div>
        <div class="dm-hm-grid">${grid}</div>
      </div>
      <div class="dm-hm-legend">少 <i class="dm-hm dm-hm0"></i><i class="dm-hm dm-hm1"></i><i class="dm-hm dm-hm2"></i><i class="dm-hm dm-hm3"></i><i class="dm-hm dm-hm4"></i> 多</div>`;
  }
  function openHeatmap() {
    trk('heat:open');
    const w = modal('🔥 发言热力图', heatmapHtml(), { wide: true });
    // 事件委托：点某一天 → 关弹窗 → 按那天筛选（挂 body 上，重渲后依然生效）
    $('.dm-modal-b', w).addEventListener('click', (e) => {
      const cell = e.target.closest('.dm-hm[data-day]');
      if (!cell) return;
      const day = cell.dataset.day;
      const c = Number(cell.dataset.count || 0);
      if (!c) { toast(day + ' 这天没有发言'); return; }
      trk('heat:day');
      closeModal();
      jumpToDay(day, '🗓 跳到 ' + day + '（' + c + ' 条发言）');
    });
    // 数据补齐后内容会变；监听数据就绪，补一次重渲
    if (typeof allMonthsLoaded !== 'undefined' && !allMonthsLoaded) {
      setTimeout(() => { const b = $('.dm-modal-b', w); if (b && !b.dataset.hmDone) { b.dataset.hmDone = '1'; b.innerHTML = heatmapHtml(); } }, 3500);
    }
  }

  /* =====================================================================
     功能 ⑧ 开播实时提醒：页面打开时轮询直播状态，开播用 Notification 弹通知
     （移动端网页在页面打开期间可用；后台静默推送需 iOS 16.4+，不在本演示范围）
     ===================================================================== */
  let notifyTimer = null, notifyOn = false;
  function fireNotify(it) {
    trk('notify:hit');   // 真检测到开播、真的弹了提醒才记
    const title = '🔴 王语晨开播啦！';
    const body = (it.title && !/^\d+$/.test(String(it.title))) ? it.title : '口袋48 直播中';
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification(title, { body, tag: 'wyc-live' }); } catch (_) {}
    }
    toast('🔴 开播提醒：' + body);
  }
  async function checkLive() {
    let live;
    try {
      const base = (typeof API_BASE !== 'undefined' && API_BASE) ? API_BASE : '';
      const r = await fetch(base + '/api/live', { cache: 'no-store' });
      if (!r.ok) return;
      live = await r.json();
    } catch (_) { return; }
    if (!Array.isArray(live)) return;
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem(NOTIFY_KEY) || '[]'); } catch (_) {}
    const seenSet = new Set(seen);
    let changed = false;
    for (const it of live) {
      const s = Number(it.status);
      const id = String(it.id || it.liveId || it.title || '');
      if (s === 2 && id && !seenSet.has(id)) {
        seenSet.add(id); changed = true;
        fireNotify(it);
      }
    }
    if (changed) localStorage.setItem(NOTIFY_KEY, JSON.stringify([...seenSet].slice(-50)));
  }
  function startNotify() {
    notifyOn = !notifyOn;
    trk(notifyOn ? 'notify:on' : 'notify:off');
    document.body.classList.toggle('dm-notify-on', notifyOn);
    if (notifyOn) {
      checkLive();
      notifyTimer = setInterval(checkLive, 60000);
      toast('🔔 开播提醒已开启（页面打开期间每 60 秒检查）');
    } else {
      clearInterval(notifyTimer); notifyTimer = null;
      toast('🔕 已关闭开播提醒');
    }
  }
  function toggleNotify() {
    if (!('Notification' in window)) { toast('当前浏览器不支持通知'); return; }
    if (Notification.permission === 'denied') { toast('通知被浏览器拒绝，请在站点设置里开启'); return; }
    if (Notification.permission === 'default') {
      Notification.requestPermission().then((p) => {
        if (p === 'granted') startNotify();
        else toast('未授权，开播提醒不会弹通知（可再点一次按钮重试）');
      });
      return;
    }
    startNotify();   // 已授权
  }

  // 事件委托：收藏 / 分享 / 最近观看
  document.addEventListener('click', (e) => {
    const fav = e.target.closest('.dm-fav');
    if (fav) {
      e.preventDefault(); e.stopPropagation();
      const k = fav.dataset.k;
      const t = fav.dataset.t || 'msg';
      let title = fav.dataset.title || '', sub = fav.dataset.time || '';
      if (k && k.indexOf('msg:') === 0) {
        const mid = k.slice(4);
        const m = (typeof MSG_INDEX !== 'undefined') && MSG_INDEX.get(mid);
        if (m) { title = String(m.text || `［${TYPE_NAME[typeOfMsg(m)]}］`).slice(0, 60); sub = bjDate(m.msgTime) + ' ' + bjTime(m.msgTime); }
      }
      toggleFav({ k, t, title, sub });
      return;
    }
    const share = e.target.closest('.dm-share');
    if (share) {
      e.preventDefault(); e.stopPropagation();
      const el = share.closest('.msg[data-mid]');
      const m = el && (typeof MSG_INDEX !== 'undefined') && MSG_INDEX.get(el.dataset.mid);
      if (m) openShare(m);
      return;
    }
    const pc = e.target.closest('.pc-card');
    if (pc) {   // 记入「最近观看」
      pushRecent({
        url: pc.getAttribute('href'),
        title: (pc.querySelector('.pc-ov.date') || {}).textContent || 'B站 视频',
        sub: (pc.querySelector('.pc-ov.song') || {}).textContent || '',
        tag: 'B站'
      });
    }
    const bili = e.target.closest('.bili-btn');
    if (bili) {
      const card = bili.closest('.card');
      pushRecent({
        url: bili.getAttribute('href'),
        title: card ? (card.dataset.title || '') : 'B站 视频',
        sub: card ? (card.dataset.time || '') : '',
        tag: 'B站'
      });
    }
  }, true);

  /* =====================================================================
     启动：注入 UI、等数据就绪、观察 DOM
     ===================================================================== */
  function injectToolbar() {
    const actions = $('.toolbar-actions');
    if (!actions) return;
    const wrap = document.createElement('span');
    wrap.className = 'dm-tools';
    wrap.innerHTML = `
      <button class="dm-tool" id="dmFavBtn" type="button" title="我的收藏 / 接着看">★<i id="dmFavCount">${F.favs.length || ''}</i></button>
      <button class="dm-tool" id="dmDigBtn" type="button" title="随机考古：随便挑一天看看">🎲</button>
      <button class="dm-tool" id="dmLastYr" type="button" title="去年今日：如果有往年今天的发言就跳过去">📜</button>
      <button class="dm-tool" id="dmHeatBtn" type="button" title="发言热力图">🔥</button>
      <button class="dm-tool" id="dmNotify" type="button" title="开播实时提醒（页面打开期间弹通知）">🔔</button>
      <button class="dm-tool" id="dmMulti" type="button" title="多选发言，拼成一张分享图 / 复制文字" aria-label="多选分享"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></button>
      <button class="dm-tool" id="dmCatchup" type="button" title="从头补档：按时间顺序一天天看，进度自动记住">📖</button>`;
    actions.insertBefore(wrap, actions.firstChild);
    $('#dmFavBtn').addEventListener('click', openFavList);
    $('#dmDigBtn').addEventListener('click', randomDig);
    $('#dmLastYr').addEventListener('click', lastYearToday);
    $('#dmHeatBtn').addEventListener('click', openHeatmap);
    $('#dmNotify').addEventListener('click', toggleNotify);
    $('#dmMulti').addEventListener('click', () => {
      toggleMulti();
      $('#dmMulti').classList.toggle('on', F.multi);
      toast(F.multi ? '已进入多选模式：勾选发言后可生成分享图或复制文字' : '已退出多选');
    });
  }

  function injectChips() {
    const toolbar = $('.toolbar');
    if (!toolbar || $('#dmTypeChips')) return;
    toolbar.insertAdjacentElement('afterend', buildTypeChips());
    const note = document.createElement('div');
    note.className = 'dm-typenote';
    note.id = 'dmTypeNote';
    note.hidden = true;
    $('#dmTypeChips').insertAdjacentElement('afterend', note);
  }

  /** 新增的工具栏按钮 + 类型筛选 chips 只在「口袋发言」页显示（用户要求：其他页不改） */
  function syncChipsTab() {
    const onMsg = (typeof state !== 'undefined') && state.tab === 'messages';
    const chips = $('#dmTypeChips'); if (chips) chips.hidden = !onMsg;
    const note = $('#dmTypeNote'); if (note) note.hidden = !onMsg || F.typeFilter === 'all';
    const tools = $('.dm-tools'); if (tools) tools.hidden = !onMsg;
  }

  /* =====================================================================
     功能 ⑨ 入坑必看清单（新粉：跟着看完就算入坑）
     —— 条目尽量从真实数据里「算」出来（最早发言/最早公演/最早直播/最活跃那天），
        荣誉类挂官微原帖链接，未来的日程标「即将到来」。看得进度存在本地。
     ===================================================================== */
  const START_KEY = 'wyc-demo-starter-v1';
  let startDone = LS.get(START_KEY, {});          // { '<日期>|<标题>': true }（不用序号：条目增删会错位）
  const stKey = (x) => (x ? x.date + '|' + x.t : '');
  const saveStart = () => LS.set(START_KEY, startDone);

  /** 从官方微博提及里按日期取原帖链接 */
  function omUrl(date) {
    const list = (typeof PROFILE !== 'undefined' && PROFILE.officialMentions) || [];
    const hit = list.find((x) => x.date === date);
    return hit && hit.url ? hit.url : '';
  }

  function starterItems() {
    const msgs = (typeof DATA !== 'undefined' && DATA.messages) || [];
    const perfs = (typeof DATA !== 'undefined' && DATA.performances) || [];
    const lives = (typeof DATA !== 'undefined' && DATA.live) || [];
    const minOf = (arr, f) => arr.length
      ? arr.reduce((a, b) => (Number(f(a)) < Number(f(b)) ? a : b)) : null;
    const firstMsg = minOf(msgs, (m) => m.msgTime);
    const firstPerf = minOf(perfs, (p) => p.stime || p.ctime);
    const firstLive = minOf(lives, (l) => l.ctime || l.stime);
    const times = msgs.map((m) => Number(m.msgTime)).filter(Boolean).sort((a, b) => a - b);
    const lastMsg = times.length ? times[times.length - 1] : null;
    const liveUrlOf = (l) => (l && (l.url || l.playUrl || l.m3u8 || '')) || '';

    const I = [];
    // 日期统一成 YYYY-MM-DD：否则「2022.10.02」和「2022-10-02」按字符串比会排错位置
    const push = (o) => { if (o && o.date) { o.date = String(o.date).replace(/\./g, '-'); I.push(o); } };

    // —— 起点：从她进团开始 ——
    if (firstMsg) push({ date: bjDate(firstMsg.msgTime), k: 'day', d: bjDate(firstMsg.msgTime),
      t: '第一条口袋发言', s: String(firstMsg.text || '').slice(0, 30) || '（图片/语音）', g: '起点' });
    if (firstPerf) push({ date: bjDate(firstPerf.stime || firstPerf.ctime), k: 'perf', d: bjDate(firstPerf.stime || firstPerf.ctime),
      t: '第一场公演', s: firstPerf.subTitle || firstPerf.title || '第一次站上剧场舞台', g: '公演' });
    if (firstLive) push({ date: bjDate(firstLive.ctime || firstLive.stime), k: 'live', u: liveUrlOf(firstLive),
      t: '第一场直播', s: firstLive.title && !/^\d+$/.test(String(firstLive.title)) ? firstLive.title : '第一次开播', g: '直播' });
    push({ date: '2023.01.15', k: 'day', d: '2023-01-15', t: '升格加入 Team NIII', s: '从预备生变成正常成员', g: '成长' });

    // —— 新人巡演（官微：2023 年度潜力新人 TOP16 巡演）——
    push({ date: '2024.03.10', k: 'perf', d: '2024-03-10',
      t: '「年度潜力新人 TOP16」汇报公演', s: '她唱了《白昼街灯 LIGHT IT UP》', g: '巡演', pick: 'TOP16' });

    // —— 高光：拿奖和代表作 ——
    push({ date: '2023.08.05', k: 'day', d: '2023-08-05', t: '年度潜力新人奖', s: '第一次站上年度盛典的舞台', g: '荣誉' });
    push({ date: '2024.08.03', k: 'day', d: '2024-08-03', t: 'NO.27 年度高飞成员奖', s: '第二次获奖', g: '荣誉' });
    push({ date: '2025.08.02', k: 'day', d: '2025-08-02', t: 'NO.45 年度梦想成员奖', s: '第三次获奖', g: '荣誉' });
    push({ date: '2026.01.02', k: 'url', u: 'https://weibo.com/5675361083/QlecNelig',
      t: '2025 第四季度「季度之星」（MVP）', s: '名单公布：恭喜王语晨', g: '荣誉', noCut: true });
    push({ date: '2026.04.25', k: 'perf', d: '2026-04-25',
      t: '季度 MVP 环节', s: '撕碎标签，挣脱傲慢偏见', g: '名场面',
      u: 'https://www.bilibili.com/video/BV1DFo9B3EWs', preferU: true, cutPick: '季度' });
    push({ date: '2026.08.08', k: 'url', u: omUrl('2026.08.08'),
      t: 'NO.22 年度高飞成员奖', s: '目前最好的名次（官微原帖）', g: '荣誉' });
    push({ date: '2026.07.04', k: 'perf', d: '2026-07-04',
      t: '个人作品《过去完成时》', s: '青春时刻 unit 首演 — "过往不恋，未来不忧，当下不负。"', g: '代表作', pick: '拾忆' });
    // —— 生日特别场（每年一场，走进偶像本人） ——
    push({ date: '2024.04.06', k: 'perf', d: '2024-04-06',
      t: '生日公演', s: '第一年的生日特别场', g: '公演', pick: 'NIII' });
    push({ date: '2024.10.26', k: 'perf', d: '2024-10-26',
      t: '生日公演《方寸之蝶》', s: '', g: '公演', pick: 'NIII' });
    push({ date: '2026.05.17', k: 'perf', d: '2026-05-17',
      t: '生日公演', s: '最近一次生日特别场', g: '公演', pick: 'NIII' });
    push({ date: '2026.05.21', k: 'url', u: omUrl('2026.05.21'),
      t: '生日公演精彩回顾', s: '官方发的回顾视频（官微原帖）', g: '公演' });
    push({ date: '2026.07.24', k: 'bili', u: 'https://www.bilibili.com/video/BV1ySge6AEiv',
      t: '《豪歌 2026》巅峰争夺战', s: '总决赛，她的唱歌舞台', g: '名场面' });
    push({ date: '2026.08.25', k: 'url', u: omUrl('2026.08.25'),
      t: '兼任 GNZ48 Team Z', s: '解锁新副本', g: '成长' });
    push({ date: '2026.09.05', k: 'url', u: omUrl('2026.09.05'),
      t: 'GROUP 首支电竞女子战队', s: '入选大名单', g: '名场面', noCut: true });

    // —— 补档小目标：数据里挑出来的 ——
    if (lastMsg) push({ date: bjDate(lastMsg), k: 'day', d: bjDate(lastMsg),
      t: '追到最新', s: '看她最近说了什么 → 从这里开始「从头补档」', g: '现在' });
    push({ date: '2026.11.28', k: 'future', t: '个人年V全场定制公演', s: '即将到来，别错过', g: '将来' });

    return I.sort((a, b) => (a.date > b.date ? 1 : -1));
  }

  window.renderStarter = function () {
    const items = starterItems();
    const doneN = items.filter((x) => startDone[stKey(x)]).length;
    const pct = items.length ? Math.round(doneN / items.length * 100) : 0;
    const rows = items.map((x, i) => {
      const on = !!startDone[stKey(x)];
      const go = x.k === 'url' && x.u ? '打开原帖 ↗'
        : x.k === 'day' ? '看这天的发言'
        : x.k === 'perf' || x.k === 'bili' ? '去看公演'
        : x.k === 'live' ? '去看直播'
        : x.k === 'future' ? '（还没到）' : '查看';
      return `<li class="st-item${on ? ' done' : ''}">
        <button class="st-chk" data-st-check="${i}" type="button" aria-label="标记已看">${on ? '✓' : ''}</button>
        <div class="st-main">
          <div class="st-date">${esc(x.date)} <span class="st-tag">${esc(x.g)}</span></div>
          <div class="st-title">${esc(x.t)}</div>
          ${x.s ? `<div class="st-sub">${esc(x.s)}</div>` : ''}
        </div>
        <div class="st-acts">
          <button class="st-go" data-st-go="${i}" type="button"${x.k === 'future' ? ' disabled' : ''}>${esc(go)}</button>
          ${cutOf(x) ? `<button class="st-cut" data-st-cut="${i}" type="button" title="${esc(cutOf(x)[1])}">✂️ B站cut</button>` : ''}
        </div>
      </li>`;
    }).join('');
    return `<section class="profile-block">
      <div class="st-head">
        <div class="st-h1">入坑必看清单</div>
        <div class="st-bar"><i style="width:${pct}%"></i></div>
        <div class="st-prog">已看 <b>${doneN}</b> / ${items.length} 条（${pct}%）</div>
      </div>
      <ol class="st-list">${rows}</ol>
    </section>`;
  };

  /** 这条清单条目对应的日期，有没有她的个人 cut（B 站合集 window.__BILI_CUTS__） */
  function cutOf(x) {
    if (!x || x.noCut) return null;                 // 条目本身不是公演（如「名单公布」）→ 不挂 cut
    const day = x.d || String(x.date || '').replace(/\./g, '-');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const all = (typeof window !== 'undefined' && window.__BILI_CUTS__) || [];
    const sameDay = all.filter((c) => c[0] === day);
    if (!sameDay.length) return null;
    // 同一天有多条 cut 时（如 04-25 既有刘力菲年度 MVP 也有她的季度 MVP），用 cutPick 挑对的那条
    if (x.cutPick) {
      const re = new RegExp(x.cutPick, 'i');
      return sameDay.find((c) => re.test(c[1] || '')) || sameDay[0];
    }
    return sameDay[0];
  }

  /** 按日期找公演 → 有回放就用站内播放器打开（hls.js），没有就落到公演页
   *  pick：可选的关键词/正则，用来在同一天的多场里挑对的那场（如生日冷餐会 vs 常规剧场公演） */
  function openPerfByDate(day, pick, fallbackUrl) {
    const perfs = (typeof DATA !== 'undefined' && DATA.performances) || [];
    const dayList = perfs.filter((x) => bjDate(x.stime || x.ctime) === day);
    const hasPlay = (x) => x.playUrl && /^https?:/i.test(String(x.playUrl));
    const like = (x) => !pick || new RegExp(pick).test((x.title || '') + ' ' + (x.subTitle || ''));
    // 优先级：① 含关键词且有回放 ② 含关键词 ③ 有回放 ④ 第一条
    const p = dayList.find((x) => like(x) && hasPlay(x))
      || dayList.find((x) => like(x))
      || dayList.find(hasPlay)
      || dayList[0];
    if (p && hasPlay(p) && typeof openPlayer === 'function') {
      closeModal();
      openPlayer(p.playUrl, `${p.subTitle || p.title || '公演'} · ${day}`);
      return;
    }
    // 没站内回放源但有 B 站录像 → 直接去看录像
    if (p && p.biliUrl && /^https?:/i.test(String(p.biliUrl))) {
      closeModal();
      window.open(p.biliUrl, '_blank', 'noopener');
      toast('这场没有站内回放源，已打开 B 站录像');
      return;
    }
    // 这天压根没有公演记录，但条目本身挂了原帖 → 还是去看原帖
    if (fallbackUrl && /^https?:/i.test(String(fallbackUrl))) {
      closeModal();
      window.open(fallbackUrl, '_blank', 'noopener');
      return;
    }
    closeModal();
    if (typeof switchTab === 'function') switchTab('performances');
    toast(p ? '这场没有可播的回放源，已切到公演页' : '这天没有公演记录');
  }

  function starterAction(x) {
    if (x.k === 'day' && x.d) { closeModal(); jumpToDay(x.d, '🗓 ' + x.date + ' · ' + x.t); return; }
    if (x.k === 'url' && x.u) { window.open(x.u, '_blank', 'noopener'); return; }
    if (x.k === 'bili' && x.u) { closeModal(); window.open(x.u, '_blank', 'noopener'); toast('这场没有站内回放，已打开 B 站录像'); return; }
    if (x.k === 'perf') {
      // preferU：用户手工指定的播放源优先于自动匹配（季度 MVP 那场自动抓的源不对）
      if (x.preferU && x.u) { closeModal(); window.open(x.u, '_blank', 'noopener'); return; }
      openPerfByDate(x.d || x.date.replace(/\./g, '-'), x.pick, x.u); return;
    }
    if (x.k === 'live') {
      if (x.u) { window.open(x.u, '_blank', 'noopener'); return; }
      closeModal(); if (typeof switchTab === 'function') switchTab('live');
    }
  }

  /* =====================================================================
     功能 ⑩ 从头补档：按年→月顺序翻，进度自动记住，下次接着看
     ===================================================================== */
  const CATCH_KEY = 'wyc-demo-catchup-v1';
  let catchUp = LS.get(CATCH_KEY, { done: {}, last: '' });
  const saveCatch = () => LS.set(CATCH_KEY, catchUp);
  const monthCache = new Map();

  /** 所有「有发言的日子」升序列表（依赖已加载的 DATA.messages） */
  function allDays() {
    const msgs = (typeof DATA !== 'undefined' && DATA.messages) || [];
    const cnt = {};
    msgs.forEach((m) => { const d = bjDate(m.msgTime); if (d) cnt[d] = (cnt[d] || 0) + 1; });
    return { days: Object.keys(cnt).sort(), cnt };
  }
  /** 某个月的发言（优先用 DATA，缺失就调 API 补） */
  async function monthMsgs(ym) {
    // 先看 DATA 里有没有这个月的
    const has = (typeof DATA !== 'undefined') && DATA.messages.some((m) => bjDate(m.msgTime).slice(0, 7) === ym);
    if (!has && typeof loadMonth === 'function') { try { await loadMonth(ym, true); } catch (_) {} }
    const msgs = (typeof DATA !== 'undefined' && DATA.messages) || [];
    const got = msgs.filter((m) => bjDate(m.msgTime).slice(0, 7) === ym);
    if (got.length) { monthCache.set(ym, got); return got; }
    if (monthCache.has(ym)) return monthCache.get(ym);
    try {
      const base = (typeof API_BASE !== 'undefined' && API_BASE) ? API_BASE : '';
      const r = await fetch(base + '/api/month?m=' + ym, { cache: 'no-store' });
      const arr = ((await r.json()) || {}).messages || [];
      monthCache.set(ym, arr);
      return arr;
    } catch (_) { return []; }
  }
  async function dayMsgs(day) {
    const arr = await monthMsgs(day.slice(0, 7));
    return arr.filter((m) => bjDate(m.msgTime) === day).sort((a, b) => Number(a.msgTime) - Number(b.msgTime));
  }

  async function ensureAllMonths() {
    if (typeof allMonthsLoaded !== 'undefined' && allMonthsLoaded) return;
    if (typeof loadRemainingMonths === 'function') { try { await loadRemainingMonths(); } catch (_) {} }
    let n = 0;
    while (typeof allMonthsLoaded !== 'undefined' && !allMonthsLoaded && n < 40) {
      await new Promise((r) => setTimeout(r, 500)); n++;
    }
  }

  async function openCatchup() {
    trk('catchup:open');
    const w = modal('📖 从头补档', '<div class="dm-empty">正在整理时间线…</div>', { wide: true });
    await ensureAllMonths();
    renderCatchup(w);
  }

  function renderCatchup(w) {
    const { days, cnt } = allDays();
    const done = catchUp.done || {};
    const doneN = days.filter((d) => done[d]).length;
    const pct = days.length ? Math.round(doneN / days.length * 100) : 0;
    const nextDay = days.find((d) => !done[d]) || days[days.length - 1] || '';
    const resume = catchUp.last || nextDay;

    // 年 → 月 → { 天数, 已补 }
    const years = {};
    days.forEach((d) => {
      const y = d.slice(0, 4), m = d.slice(5, 7);
      (years[y] = years[y] || {})[m] = (years[y][m] || 0) + 1;
    });
    const doneByMonth = {};
    days.filter((d) => done[d]).forEach((d) => {
      const y = d.slice(0, 4), m = d.slice(5, 7);
      doneByMonth[y + '-' + m] = (doneByMonth[y + '-' + m] || 0) + 1;
    });
    const yKeys = Object.keys(years).sort();
    const blocks = yKeys.map((y) => `<div class="cu-year">
        <div class="cu-yh">${y}</div>
        <div class="cu-months">${Object.keys(years[y]).sort().map((m) => {
          const tot = years[y][m], dn = doneByMonth[y + '-' + m] || 0;
          const cls = dn >= tot ? 'done' : (dn > 0 ? 'part' : '');
          return `<button class="cu-m ${cls}" data-cu-month="${y}-${m}" type="button">
            <b>${Number(m)}月</b><i>${dn}/${tot}</i></button>`;
        }).join('')}</div>
      </div>`).join('');

    $('.dm-modal-b', w).innerHTML = `
      <div class="cu-head">
        <div class="cu-bar"><i style="width:${pct}%"></i></div>
        <div class="cu-prog">已补 <b>${doneN}</b> / ${days.length} 天（${pct}%）${catchUp.last ? ' · 上次看到 ' + esc(catchUp.last) : ''}</div>
      </div>
      <div class="cu-acts">
        <button class="dm-btn primary" data-cu-resume="${esc(resume)}" type="button">▶ ${catchUp.last ? '继续补档（' + esc(catchUp.last) + '）' : '从头开始'}</button>
        ${days.length ? `<button class="dm-btn" data-cu-month="${days[0].slice(0, 7)}" type="button">⏮ 最早：${esc(days[0])}</button>` : ''}
      </div>
      <div class="cu-tip">点某个月 → 从那个月第一天开始补；每天看完点「✓ 看完并继续」，进度会自动存在本机。</div>
      <div class="cu-years">${blocks || '<div class="dm-empty">数据加载中…</div>'}</div>`;
  }

  async function openDayReader(day) {
    const w = modal('📖 ' + day, '<div class="dm-empty">加载中…</div>', { wide: true });
    const { days } = allDays();
    const idx = days.indexOf(day);
    const msgs = await dayMsgs(day);
    catchUp.last = day; saveCatch();
    const isDone = !!(catchUp.done && catchUp.done[day]);

    const body = msgs.length ? msgs.map((m) => {
      const t = String(m.text || '').trim();
      const tag = TYPE_NAME[typeOfMsg(m)] || '文字';
      const imgs = (m.images || []).slice(0, 4);
      const imgH = imgs.length
        ? `<div class="cu-imgs">${imgs.map((u) => {
            const url = (typeof toUrl === 'function') ? toUrl(u) : u;
            return `<img src="${esc(url)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" onerror="this.style.display='none'">`;
          }).join('')}</div>` : '';
      return `<div class="cu-msg">
        <div class="cu-mh"><b>${esc(bjTime(m.msgTime))}</b><span class="cu-tag">${esc(tag)}</span></div>
        <div class="cu-mt">${esc(t || '（' + tag + '）')}</div>
        ${imgH}
      </div>`;
    }).join('') : '<div class="dm-empty">这天没有发言</div>';

    $('.dm-modal-b', w).innerHTML = `
      <div class="cu-dayh">${esc(day)} · 第 ${idx + 1} / ${days.length} 天 · ${msgs.length} 条发言${isDone ? ' <b class="cu-ok">已看完 ✓</b>' : ''}</div>
      <div class="cu-body">${body}</div>`;
    const f = document.createElement('div'); f.className = 'cu-foot';
    f.innerHTML = `
      <button class="dm-btn" data-cu-day="${esc(days[idx - 1] || '')}" type="button"${idx <= 0 ? ' disabled' : ''}>← 前一天</button>
      <button class="dm-btn primary" data-cu-fin="${esc(day)}" type="button">${isDone ? '✓ 已看完，下一天 →' : '✓ 看完并继续 →'}</button>
      <button class="dm-btn" data-cu-day="${esc(days[idx + 1] || '')}" type="button"${idx >= days.length - 1 ? ' disabled' : ''}>后一天 →</button>`;
    $('.dm-modal', w).appendChild(f);
  }

  function finishDay(day) {
    catchUp.done = catchUp.done || {};
    catchUp.done[day] = true;
    saveCatch();
    const { days } = allDays();
    const nx = days[days.indexOf(day) + 1];
    if (nx) openDayReader(nx);
    else { closeModal(); toast('🎉 全部补完了！'); }
  }

  /* =====================================================================
     功能 ⑩ 今日盲盒：随机抽一张她的照片 + 随机「心动指数」
     —— 照片池 = ① 微博社媒美图（经 /img 代理取图）② 口袋房间她发过的图（直连）
     —— 心动指数按图片 URL 做稳定哈希：同一张照片每次抽到都是同一个值
        （不是每次刷新乱跳的数字，看起来才像「这张真的被打了分」）
     ===================================================================== */
  const BOX_KEY = 'wyc-demo-blindbox-v1';
  /** 已经判定为「不是照片」的图（表情包/海报/截图…）——存本地，下次直接跳过，不再白下载一遍。
   *  为什么需要：口袋池 2774 条里约 63% 是这类图，而判定必须先把图加载出来看像素尺寸。
   *  不记下来的话每次抽到都要重试，既慢又会让口袋侧的照片被「挤掉」（实测只占 29%，本应 50%）。 */
  const BOX_JUNK_KEY = 'wyc-demo-blindbox-junk-v1';
  const BOX_JUNK_MAX = 2500;
  // 站长 2026-09-24 定：口袋房间发的图只收 2023-09 之后（更早的那批又小又杂，不适合当盲盒主图）
  const PK_SINCE = Date.UTC(2023, 7, 31, 16, 0, 0);        // = 北京时间 2023-09-01 00:00
  /** ★ 站长点名的照片白名单（2026-09-24 从候选库里挑的 60 张）。
   *  这些确实是正常照片（自拍 / 对镜自拍 / 舞台 / 食物），只是分辨率偏低，
   *  被下面 boxOk() 的「小图」规则和 2023-09 时间门槛误挡 → 这里直接放行，
   *  跳过时间、体积、尺寸、比例全部关卡。键 = 图片链接的最后一段。
   *  以后站长再挑出一批，往这个数组里加即可（不用改逻辑）。 */
  const PK_OK_TAILS = [
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc4NTYwMjc3MjQ1M18wODZiZjViZi02OTI2LTQ2MGUtYjc4OC0zMzQzNDAyNTA3ODU=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc4NDM5MTY0MzkzMl8xN2Q2MjljNC1lNzEzLTQ3YTYtODJjZC03ZGNmZTczZTYzYmI=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc3NTc4OTIzMzk2N19kNzMyMWFiOC0wZTRkLTQ1ZWEtODVjZS1jMGFmOTFkNDhlNjY=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc3MzE1MTMyNDUzMl83ZWQwYThlZS0xYWM5LTRlMTgtOWEzNC0zNjk1NWE1NzEyOWQ=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc3MzE1MTMyNDUzMl8yOTBmYWI1NC01NzQ4LTQ0NDEtYmU2Ni0xMjc5ZjM0YjAyZmE=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc3MzE1MTMyNDUzMl9kNWFhNTdhYS1mZWNhLTQzNzUtYjc1Yy1lNGVlOWMyNTI5MzE=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2MzcyNjAyNDc0Nl82NjNhNjZiMS0wNzU1LTRlY2MtYjgzMi1lYWE4NDA3OGRiOGU=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2MTY4MDMyNjU5MF9iY2ZkMGJhNS0xNDg5LTRiODEtYjI3OS05MGJkM2U5YjYxNjE=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc0Njc5OTE1OTA4Ml8yNjk4NTU0Ni01ZDI2LTQ4MjctYTZmZC1jMTE3ZGFhNjUxNWY=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTczOTg4ODE1MTY5NF8xODNhOGJhYi1mMTU2LTQyNzUtOWYyYS01NzE4MmVhNzJkYjA=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcxODE2OTgwMzc0MF8wYzFjNDRhNy01M2JiLTQ3ZTEtYTE1Yi03YjNlYTFlNTdkZDA=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcxNzUxNDMyMzM0OF85NzNiYjg4NS1jZmRmLTQwNzgtYWEzYi02NDBmYWRiZmVmNmY=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcxNDc0NDUzMDc0M183ZGFhOWZkMi02M2QxLTRjZjktOGZlZS1jN2JlYmViOTExMjU=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcxMzYxMTgwNTU4OF85ZjYzMmEyNC0wYzA2LTQyZGItYTZmOS05NDRiMmVkMTExNjY=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcxMzAwNTg3MzU5OF9jNTdkNmNhZS01NzJmLTRlNTItYjNjMy1mM2I1MTc3MTQzYTg=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwNzUwMTcyODgzNV9mYzUyNzAxNC1iZWUzLTQ5NGQtYjVkZC1iNTM1MDM3NjllODE=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwNjUyNDI3MjI3Nl9lNDZlMGEyMS1lOWVjLTQ4MjctYjcwNS0yNzJlMzc5MTQ0MDM=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwNjM4MDUxMzMwNF9jMmVjMTg2OC03ODM5LTQxNzMtODQ4NC00ZDNmOTZiMjRkOTE=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwNTA3MjQ2MjEzMF9mZDI1ZThiMy1hMjEyLTRlOGYtOTg3YS05MGUxOWU0OTRmYjQ=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwNTA3MjQ2MjEzMF84ODM1ZDY2Ny0xMTdlLTQ3ODItYWZlMy1lODVjYThjZGNkY2U=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwNTA3MjQ2MjEzMF8xYWQ3MzkyZC0yN2Y0LTQzYjYtYjhjNy0yZjRhMTRhMTI1OGE=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwNDExNDczMTIzMF83N2Y5MDE2ZC0xNGJmLTQ0MGMtYTE4NC0zYTdiNmMxOWEyNGI=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwNDExNDczMTIzMF8zN2FjYjQ0NS0wMjc1LTQwMmMtYTliYy02OGUwNGU5OTYxZDM=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwMzUxNjY5MDcyMl8wZGM2MTc3Ny0xMWFlLTRhYWEtYjMwYy00MGU0NzE5N2M2ZjU=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwMjA1MjA1MDI1MF8zYmJhOTYyYS02YmM2LTQ4ODItOGQ3ZS0yOTI4ZWIzMzIyZGI=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwMjA1MjA1MDI1MF9iM2ExZWM3My1kYmM4LTRlMjQtOTMyZS0yZDBjMzgwNjc0OTU=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwMjA1MjA1MDI1MF9kYzlhMzI0OS1iOGZlLTQ1MmQtYjBkMy1mN2Q0ZmNmZGUyZjc=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwMjA1MjA1MDI1MF9mYjNkMzU1OS03NzQ0LTRhZmItODYzNC00YWYyYzI0MTAyMWM=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwMDQwMDUzNTY2OF9lOGJjNjZlZS01NjI5LTQ1YWItOTQwYi1mOGZkNDQ0OTE0YWM=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwMDQwMDUzNTY2OF85YzdiYzNiOC1lOTg2LTRjNzctOTJjMy1iNTZhNjcxY2Q2ZmQ=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY5OTYwMTU2NjA3M180MjE0ZGNkMC03OTcxLTQwMzMtODU2Ny05NDkyYmY2ZTc3N2Q=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY5ODQyNDMxNDIzM181MzBkYzA0ZS02YjE3LTRmYmEtOTU2ZC0yN2IyY2Y5ZDJkNzY=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY5ODQyNDMxNDIzM18xYzA1MjQyZS04YTU0LTQ3OTktOWVlNi04YWMzYWQ0ZjkzM2I=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY5ODQyNDMxNDIzM185OWZlZTU3NS1lMDJjLTRlZTAtODdhMS1kNGIzOWNiNjAyYjA=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY5ODQyNDMxNDIzM182MTExZGNhOC0xMDZhLTRkODctYmViYi1hZjFlZjVjMTY5MDA=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY5NzY1MjM1Njg0OF9iMDk0NDI5Ni1kNzNjLTQ2MzQtYTIzYS05YzFiNzE5NWE3YWI=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY5NjIyMTA5NjA5N19lNDI3ZGNjMS03NDMzLTRhYjQtOWNhNy0xMDJkZjQ2M2RhNjU=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY5NTIxNjcxMzQyMF81MzQxMDY3Mi0zNGY3LTRlMmItYTZjMy03NDY1NWI2ZjQxY2M=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY5NTIxNjcxMzQyMF9hZjg0OTFkYi02MWE3LTRiODUtYjFhNy05NGU4YzBjZDFlZjc=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY5MzA3Mzc5MzMzNV80N2U3M2QwZi04OTEwLTQ2ZTQtOTIxMi02MDEzN2I0NTEwMTg=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY5MDg5NDc5MzE1OV80ZDlhMDYwMi0wY2ExLTQ0ZDctYjg2Ny0wMGZlZDljNWM4YTg=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY4NTQ1NTM5NjkzN19jOTQ2YTdkNC1mYjRlLTRjYTEtYjFjZS01ZWJhMGNkMDk1MDU=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY4MzYzNDQyNDIxMV9hZDBlYzk2My02YWFkLTRlY2ItOGZkYi03OWY3M2Y3MGQxMjE=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY4MzYzNDQyNDIxMV84NjUyY2Q4My1iNGFiLTQ2ZWUtYTNkMy1mNmQ2MGU5NWU5MzY=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY4MzYzNDQyNDIxMV80MGMzYmU2MC05NWE4LTQ0YjktYjQwMS0wNDQ1ZGVkNTI5MDg=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY4MTQ3MTAyNzA5Nl9jNjUzNDVjYy0zMDE2LTRiOGEtOWNkYS1kNjgzNjA3Njk3YzI=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY3NDM4NzcxNzM1MV8yZWNhYzdjNy02ODVhLTQwZTMtYmIzOC1mYjk3ZWNmMWFmNGM=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY3NDM4NzcxNzM1MV81NTg1NjBiNy05ZWNkLTRjYjktYmEzOC0yNjJkZTc3Y2Y3MjA=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY3MTg5MjgyNjMxM185YjI2YWNkNS01NDVhLTRhN2ItOTRhZC01YjRiOWM4Zjk2MzI=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY3MDY3NDQ2NDU5MV9hNmUwOTg2ZC05ODRjLTRkNTAtODljOC0wZjMzZTMzOGU3ZTY=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY3MDY3NDQ2NDU5MV9mZmYxNzJlMS05MGUzLTRlOTktODVlYS1kNDUzNWI3NzFiOGM=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY2ODc3MTcyMTM5NF81NGRmN2ZiYy0zMGYzLTQ0MGQtODJkOS1mNTZlNzE2ODA0YmI=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY2ODc3MTcyMTM5NF9kMDQxNzlmMi1kYzVlLTRhZWItYmFjYS0wYzg5YzA0NjU1YTY=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY2NTMzNDA0NDkyOV8yZTNmNWU1Mi04MWJhLTQ4YWYtYjIyZC1hZGQ1NWI5MWJmZTc=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY4MTQ3MTAyNzA5NV83ZDIzMmE4OS1hOTc5LTRmNjctYjQ4Mi0wZGNhYmFhNzE5M2Y=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcyODkxNTAwNTEwNl84NTNjYjBhMi05NTIwLTQ0NTktYjIxMy0yYzQyYmNhNDQ2NGQ=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwMTY3MTY0MDM2OV83MWUzZjE0OS1hNTlmLTQxZWYtYmMwNC1jZmE4ZGYzOTRiODk=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcyMzI5MTI1MDcyOF9mZmIwNmJmZi0wMGY0LTRiOGQtOTI2ZC1hZjVlMGNkMWVlNzk=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcyODkxNTAwNTEwNl84YWM5Y2UzMS02NzQyLTQyN2MtYTM5Ni1jZWY3NDRiMTUwOWQ=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTY3NDM4NzcxNzM1Ml84Mzc2OTkzNS02NzJmLTRjMjgtYmExNC0zNzBkZTMzMjJhNjU=',
  ];
  function isPkOk(src) {
    if (!src) return false;
    for (let i = 0; i < PK_OK_TAILS.length; i++) {
      if (src.indexOf(PK_OK_TAILS[i]) >= 0) return true;
    }
    return false;
  }
  let boxPool = null, boxPoolLen = -1, boxWb = [], boxPk = [];
  let boxJunk = null;                                      // Set<url>：已判定不是照片的（懒加载自本地）
  let boxItem = null, boxDaily = true;

  function hash32(s) {
    const str = String(s == null ? '' : s);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

  /** 构建照片池：微博（photo 多图 + video 封面）+ 口袋房间（她发的照片）
   *  两个来源分开存：抽的时候**先五五开选来源**，再在来源内随机。
   *  （微博池只有几百张、口袋池上千张，混在一起抽的话微博几乎抽不到） */
  function buildBoxPool() {
    const msgs = (typeof DATA !== 'undefined' && DATA.messages) || [];
    const social = (typeof DATA !== 'undefined' && DATA.social) || [];
    const len = msgs.length * 1000 + social.length;   // 两个源任一变化都重建
    if (boxPool && boxPoolLen === len) return boxPool;
    const wb = [], pk = [], seen = new Set();
    const add = (arr, it) => { if (!it.src || seen.has(it.src)) return; seen.add(it.src); arr.push(it); };
    // ① 微博：照片条目逐张收，视频条目只收封面
    social.forEach((it) => {
      const srcs = (it.k === 'photo') ? (it.p || []) : (it.cover ? [it.cover] : []);
      srcs.forEach((u, i) => add(wb, {
        src: u, from: '微博',
        sub: it.k === 'photo' ? (srcs.length > 1 ? `第 ${i + 1}/${srcs.length} 张` : '单图') : '视频封面',
        date: it.d || '', text: String(it.t || '').replace(/\s+/g, ' ').trim(),
        link: it.u || '', wb: true
      }));
    });
    // ② 口袋房间：只收 IMAGE（EXPRESSIMAGE 是口袋表情贴图，不是照片）
    //    🔴 口袋里还混着大量「表情包 / 小图 / 截图」——她发的 IMAGE 不全是照片。
    //    raw.bodys 里带 { w, h, size, ext }，按「长边 < 900 或 体积 < 60KB」剔除，
    //    否则盲盒会抽到猫猫表情包（实测抽到过）。
    msgs.forEach((m) => {
      if (m.msgType !== 'IMAGE') return;
      const ts = Number(m.msgTime) || 0;
      const keep = (m.images || []).some(isPkOk);            // ★ 站长点名的图：不受下面任何门槛限制
      if (!keep && ts && ts < PK_SINCE) return;              // 早于 2023-09 的口袋图不进池
      let mt = null;
      try { mt = JSON.parse((m.raw && m.raw.bodys) || '{}'); } catch (_) { /* 老格式没有 JSON，放行 */ }
      if (mt && !keep) {
        const side = Math.max(Number(mt.w) || 0, Number(mt.h) || 0);
        const bytes = Number(mt.size) || 0;
        if (side && side < 900) return;
        if (bytes && bytes < 60 * 1024) return;
      }
      const arr = m.images || [];
      arr.forEach((u, i) => add(pk, {
        src: u, from: '口袋房间',
        sub: arr.length > 1 ? `第 ${i + 1}/${arr.length} 张` : '',
        date: bjDate(m.msgTime), text: '', link: '', wb: false
      }));
    });
    boxWb = wb; boxPk = pk; boxPool = wb.concat(pk); boxPoolLen = len;
    return boxPool;
  }

  /** 已判定为「图」的集合（懒加载） */
  function junkSet() {
    if (!boxJunk) boxJunk = new Set(LS.get(BOX_JUNK_KEY, []) || []);
    return boxJunk;
  }
  function markBoxJunk(src) {
    const j = junkSet();
    if (!src || j.has(src)) return;
    j.add(src);
    let arr = Array.from(j);
    if (arr.length > BOX_JUNK_MAX) arr = arr.slice(arr.length - BOX_JUNK_MAX);   // 只留最近的，别撑爆 localStorage
    LS.set(BOX_JUNK_KEY, arr);
  }
  /** 抽之前先把已知的「图」剔掉，照片才不会被这些杂质挤掉 */
  function boxCand(arr) {
    const j = junkSet();
    if (!j.size) return arr;
    const out = arr.filter((x) => !j.has(x.src));
    return out.length ? out : arr;
  }

  // 心动指数档位：下限 → 稀有度徽章 + 短评 + 备选文案（文案再按哈希挑一句）
  const BOX_TIERS = [
    { min: 96, tag: 'SSR', name: '一眼万年',   lines: ['这张请直接进我的壁纸库', '看第一眼就知道，今天不用再看别的了', '收藏夹又要多一位常住居民'] },
    { min: 88, tag: 'SR',  name: '心跳漏一拍', lines: ['心脏被轻轻捏了一下', '手比脑子快，已经点开大图了', '这种程度的心动值得循环一整天'] },
    { min: 78, tag: 'R',   name: '嘴角自动上扬', lines: ['不自觉笑了一下，被旁边的人看到了', '治愈程度：一杯全糖奶茶', '看完整个人都松下来了'] },
    { min: 68, tag: 'N',   name: '有点上头',   lines: ['再看一眼，就一眼', '今天的份量刚刚好', '已经偷偷存进相册了'] },
    { min: 0,  tag: 'N',   name: '稳稳的喜欢', lines: ['平平淡淡也是喜欢', '今天也要好好的', '安安静静看着就很满足'] }
  ];

  function heartOf(src) {
    const h = hash32(src);
    const val = 60 + (h % 40);                                  // 60 ~ 99
    const tier = BOX_TIERS.find((t) => val >= t.min) || BOX_TIERS[BOX_TIERS.length - 1];
    const line = tier.lines[(h >>> 7) % tier.lines.length];
    return { val, tier, line };
  }

  const boxDay = () => fmtBJ(new Date());                       // 北京日期，换日才换今日份

  /** mode='daily' 今日份（日期哈希决定，同一天固定）｜'rand' 随机；i = 第几次尝试（跳过不合格/重复） */
  /** flag：0 = 微博池，1 = 口袋池；不传就随机掷一个（daily 由日期哈希决定来源） */
  function drawBox(mode, i, flag) {
    buildBoxPool();
    if (!boxPool.length) return null;
    const tries = Number(i) || 0;
    if (mode === 'daily') {
      const day = boxDay();
      if (tries === 0) {
        const st = LS.get(BOX_KEY, {});
        if (st && st.day === day && st.src) {
          const hit = boxPool.find((x) => x.src === st.src);
          if (hit) return hit;                                  // 同一天打开 → 还是那张
        }
      }
      const seed = hash32('wyc-blindbox-' + day) + tries * 7919;  // 加个质数步长，逐次换候选
      const arr = boxCand(boxArr(seed));
      return arr[Math.floor(seed / 2) % arr.length];
    }
    // 随机抽：来源内随机；尽量别连着抽到同一张
    const src = (flag === 0 || flag === 1) ? flag : (Math.random() < 0.5 ? 0 : 1);
    const arr = boxCand(boxArr(src));
    let it = null;
    for (let k = 0; k < 8; k++) {
      it = arr[Math.floor(Math.random() * arr.length)];
      if (!boxItem || it.src !== boxItem.src) break;
    }
    return it;
  }

  /** 0 = 微博池，1 = 口袋池（某一池为空就回退到另一池） */
  function boxArr(flag) {
    const a = flag === 0 ? boxWb : boxPk;
    const b = flag === 0 ? boxPk : boxWb;
    return a.length ? a : b;
  }

  // 微博图必须走站点 /img 代理（新浪直链 403）；口袋图是云信直链，别走代理（会被 host 白名单拒）
  const boxSrc = (it) => (it.wb && typeof proxyImg === 'function') ? proxyImg(it.src) : it.src;
  // 出图时两个来源都走代理：代理响应带 CORS 头，画进 canvas 才不会被污染（见 loadCardImg）
  const boxProxy = (it) => (typeof proxyImg === 'function') ? proxyImg(it.src) : it.src;

  function boxMeta(it) {
    return [it.from, it.date, it.sub].filter(Boolean).map(esc).join(' · ');
  }

  function boxHtml(it, daily) {
    const h = heartOf(it.src);
    const tag = h.tier.tag.toLowerCase();
    const txt = it.text
      ? `<div class="bm-text">“${esc(it.text.length > 56 ? it.text.slice(0, 56) + '…' : it.text)}”</div>` : '';
    return ''
      + '<div class="bm-card">'
      +   `<div class="bm-shot"><img class="bm-img" src="${esc(boxSrc(it))}" alt="王语晨 照片" decoding="async"`
      +     ` referrerpolicy="no-referrer" onclick="window.__lightboxShow && window.__lightboxShow(this.src)"`
      +     ' onerror="window.__bmImgFail && window.__bmImgFail()" />'
      +     `<span class="bm-badge bm-${tag}">${h.tier.tag}</span>`
      +     `<span class="bm-flag">${daily ? '今日份' : '随机抽'}</span>`
      +   '</div>'
      +   '<div class="bm-heart">'
      +     '<div class="bm-hrow"><span class="bm-hlbl">心动指数</span>'
      +       `<span class="bm-hval bm-${tag}">${h.val}<i>%</i></span></div>`
      +     `<div class="bm-bar"><i data-w="${h.val}" style="width:0"></i></div>`
      +     `<div class="bm-tier"><b>${esc(h.tier.name)}</b><span>${esc(h.line)}</span></div>`
      +   '</div>'
      +   `<div class="bm-meta">${boxMeta(it)}</div>` + txt
      +   '<div class="bm-hint">长按图片可以保存到相册 · 也可以点下方「生成分享图」存成一张卡片</div>'
      + '</div>';
  }

  function boxText() {
    if (!boxItem) return '';
    const h = heartOf(boxItem.src);
    const meta = [boxItem.from, boxItem.date, boxItem.sub].filter(Boolean).join(' · ');
    let s = `【王语晨 · ${boxDaily ? '今日' : '随机'}盲盒】\n`
      + `💓 心动指数 ${h.val}%　${h.tier.tag} · ${h.tier.name}\n📷 ${meta}`;
    if (boxItem.text) s += `\n“${boxItem.text.length > 56 ? boxItem.text.slice(0, 56) + '…' : boxItem.text}”`;
    if (boxItem.link) s += `\n🔗 ${boxItem.link}`;
    return s + '\n—— 王语晨补档站';
  }

  function boxFooter() {
    const wb = boxItem && boxItem.link
      ? `<a class="dm-btn" href="${esc(boxItem.link)}" target="_blank" rel="noopener">↗ 看原帖</a>` : '';
    // 外层包一层 .bm-acts：只影响盲盒弹窗的按钮排布，不动其它弹窗的 footer 样式
    // 按钮顺序：换一张（最常用）→ 生成分享图（本次新增）→ 复制文案 → 看原帖
    return '<div class="bm-acts">'
      + '<button class="dm-btn primary bm-again" type="button">🎁 换一张</button>'
      + '<button class="dm-btn bm-dl" type="button">🖼 生成分享图</button>'
      + '<button class="dm-btn bm-copy" type="button">📋 复制文案</button>' + wb
      + '</div>';
  }

  function renderBlindBox() {
    const w = modal(boxDaily ? '🎁 今日盲盒' : '🎁 随机盲盒', boxHtml(boxItem, boxDaily), { footer: boxFooter() });
    requestAnimationFrame(() => {
      const bar = $('.bm-bar i', w);
      if (bar) bar.style.width = bar.dataset.w + '%';          // 进度条从 0 长到指数值
    });
  }

  function renderBoxLoading() {
    modal(boxDaily ? '🎁 今日盲盒' : '🎁 随机盲盒', '<div class="bm-loading">正在拆盒…</div>');
  }

  /** 预加载一张图：既是「出图前先确认能加载」，也顺手拿到真实像素尺寸 */
  function preloadBox(it) {
    return new Promise((resolve) => {
      const im = new Image();
      im.referrerPolicy = 'no-referrer';
      let settled = false;
      const fin = (ok) => { if (!settled) { settled = true; resolve({ ok, w: im.naturalWidth || 0, h: im.naturalHeight || 0 }); } };
      im.onload = () => fin(true);
      im.onerror = () => fin(false);
      im.src = boxSrc(it);
      setTimeout(() => fin(false), 12000);
    });
  }

  /** 口袋房间里的「图」远不全是照片 —— 还混着表情包、计分感谢榜海报、榜单名单截图、聊天长图、
   *  表单截图、模板图。四条规则拦下来：
   *    ① 长边 < 1500 → 表情包（1320×1320 那一大堆）、微信导出的设计图（960×1280 榜单海报）
   *       ← 她手机直出的照片是 3024 / 4284，门槛放 1500 既不误杀又挡得住贴图
   *    ② 宽高比 < 0.62 或 > 1.8 → 手机截图、名单长图、聊天记录
   *    ③ 方形（0.9~1.1）还要求长边 ≥ 2000 → 进一步挡方形贴图
   *    ④ 尺寸与照片完全相同、①②③ 拦不住的导出尺寸 → 见下面的黑名单
   *  🔴 KV 数据剥掉了 raw.bodys，前端拿不到原始 w/h/size/ext，也读不了像素
   *     （口袋图云信直链没有 CORS 头，画到 canvas 就被污染），所以只能靠「加载后的真实像素尺寸」判。
   *  微博池是她本人发的照片，已清洗过，不设卡。 */
  /** ④-a 已知是「非照片导出」的尺寸 —— 2026-09-24 离线把 2023-09 之后、能过①②③ 的口袋图逐张看过：
   *  这些尺寸下没有一张是她的照片。新增玩法时若发现漏网，按同样办法核对后往这里加。 */
  const PK_BAD_DIMS = new Set([
    '1024x1536',   // 计分感谢榜海报 ×6 + 「房间票打卡冲活动」文本卡 ×1
    '1620x2160',   // 「谷大歌 / 全员曲 / 花曲 / 流着串烧」模板图 ×5
    '2360x1640',   // 深色榜单界面截图 ×4
    '2388x1668',   // 手绘打招呼图 ×1
    '1179x1710',   // GNZ48 补贴 / 券 表单截图 ×1
    '1179x1722'    // 同上 ×1
  ]);
  /** ④-b 按链接尾段点名排除。两类：
   *  ① 粉丝做的「王语晨」应援海报（尺寸和她照片一样，尺寸规则挡不住）；
   *  ② ★ 带粉丝昵称水印的「合影 / 专属图」——2026-09-24 站长要求：
   *     口袋照片上带着昵称 ID 的一律不进盲盒（属于粉丝专属内容）。
   *     指纹 = 她一次连发一批（批内每张盖一个不同粉丝的昵称）。
   *     已定位两批：2024-07-10 17:22/17:40「这么多人要合影」后 6 张；
   *                2026-01-25 21:50~21:54「我要发图啦」后 24 张。
   *     ⚠️ 以后再有这种连发，要重新跑一遍审计脚本（技能 wyc-archive-publish 有流程）。 */
  const PK_BAD_TAILS = [
    'OTI3Zi00NWIzYjk1YTViMmQ=',      // 粉丝做的「王语晨」应援海报 ×1（尺寸和她照片一样，尺寸挡不住）
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcyMDU4NTcyNjM2Ml80ODUwMjk0OC0wYWUwLTRlZmEtOTE4OC1jMjE5ZGE0MTMxNWE=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcyMDU4NTcyNjM2Ml9hMjY5ZjFhNi1kMjFkLTQ4NjUtYmFlNi1iZTFmNDgwYzU2OTM=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcyMDU4NTcyNjM2Ml9iN2M1ZmFjOC1iYjlkLTRlNzktYjZlNC1lNmEzMTMyNGIzMjk=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcyMDU4NTcyNjM2Ml85N2IyZmZkMy01YmFhLTQ0NzktODBmMS0yYzVlNTc3NTBiYWM=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcyMDU4NTcyNjM2Ml9mYjY4ODY1YS0yMDk3LTRhNTQtYTZiMy0zZGYwMTc5OTNmMDE=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcyMDYwNDQzODI1Nl85ZGMyOWI1YS1lN2ZkLTQzYmMtYTdkNy02NzA3ZDNmOGFmYmU=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTMyNjQ1MDczMl81ZDY0YjhmNS1kNzBhLTQ2M2YtYWVhNC04MzNhMWM3ZGZlYmI=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTMyNjQ1MDczMl84ZjgyZmY5Yy00ZmZhLTQ3ODItYjllNS0yZjFmNTNjN2VlMzI=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTMyNjQ1MDczMl8xODA4NzhhZS1kYjIxLTQzYTYtOTU4Ni01YTY0MmNhYTJjNjg=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTMyNjQ1MDczMl85ZGNjYTYwYi02ZGI5LTRlZTEtYjQ5Ni01OTg2M2Y3OGQ2OWM=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTMyNjQ1MDczMl81M2RkOTMzMy1iNDQyLTQ1YjctOGYxYi1mNzcyMWYxZWQ4MmY=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTMyNjQ1MDczMl84YWEyYzk1YS01ZDRkLTQ1NTUtOGNmYy1lYzc0MmI3MWVhZTc=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTMyNjQ1MDczMl9iNzY0Y2Q5OC0wZmNlLTQxNTYtYjU0Zi0wNjM5YTlmZGFlOTQ=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTMyNjQ1MDczMl8zZjJhY2RjYy02MDMwLTRhNTAtYTY4YS04ODU3ZTI0YmJlODI=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTMyNjQ1MDczMl9lMTc1OTAzNC05NWVkLTQzYmQtOWVlMC05MTE5NjEwMDVhOGQ=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTM0OTEzMTE1Nl8zNDZlNDU2YS05Yzc2LTRlZGQtYmEyYS01YWE4MGQyNmI2ZjI=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTM0OTEzMTE1Nl8xYzBjYjY4NS1mZjVlLTQ3YzMtYWZlMC1mMmVhMjI4MjU5MDE=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTM0OTEzMTE1Nl9hOWMzNDAyNi05ZmRmLTQ0YmQtOTdjYy01YTQyMTMzYzBmZWY=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTM0OTEzMTE1Nl9lYWY2YjhjNi01MTZjLTQwYmUtOWJjNS1hZDJhYTJlYzVjMWM=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTM0OTEzMTE1Nl8zZTFiNGRmYS1lN2UxLTQ4ZDktODAyOS1jZDU3ODExMjMwMjc=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTM0OTEzMTE1Nl84Njk2MjNlNi1mYWE5LTQyM2MtYWU2NC0zM2Q1NWNjNzc1Mzk=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTM0OTEzMTE1Nl82ZTE1OGViZi1lM2EwLTQ2M2ItYWVmYi04OTg1N2E5OGQ5ZGI=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTM0OTEzMTE1Nl82NmMxNTA1Ny04YjQ1LTQ3OTgtYmYzMi01OTk2OTEyYWZiN2Y=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTM0OTEzMTE1Nl9mMGZjM2JjZi1mOWJkLTRjNGYtYmI0OS1iMzlkNmVkNGUwNjM=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTM0OTEzMTE1Nl8yMmZlZGMwYi1jYzUzLTQxYTctYWNhMy02ZGMyZmVlZGM1Yzk=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTM0OTIwMTY3Nl81NDNhNGJkNC1lMGMwLTQyMGQtOWNmZS1lZGJkOTg3MGFiYzA=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTM0OTIwMTY3Nl84ZmY5ZmQyMy03ZWZlLTRjZjItYjhmNC1iZjI2NzIzN2Y2MGY=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTM0OTIwMTY3Nl80MzdiZTQ2OS05ZmE1LTQyNjQtYmY1Zi0yYzQyNzczMDhhMmI=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTM0OTIwMTY3Nl83MDZkOGI2Ni03ZmE4LTRhOGYtOTUwNC0zZDYyMzliYTMxZmI=',
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2OTM0OTIwMTY3Nl9iY2U1YjdiMi1hZTM0LTQzOTUtODYyMS0zNzNhNGY4MWQ0Zjk=',
    /* ---- 2026-09-24 站长第二批点名（6 张）---- */
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc4ODUyNDIyMzQyN18yMWQzN2E2NC1mMzlmLTQ1M2YtOGQwNC1iZmQ3ZTlhMDIzYWM=',   // 2026-09-05 官方群像海报（带十几个成员名字）
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc4MzQyNDAxNTQ4OF85YTkzZGZhYi03OWFjLTQwY2YtYWZhMC1lYzdiYjcyNGQ1NjQ=',   // 2026-07-07 疑似昵称水印（1320x1760）
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc3NTM4NzA4ODU1Ml8xZmM3ODIyNy0yMzNmLTRlMTgtODQwOC1iNDZlMzM3MmJhY2E=',   // 2026-04-07 站长点名
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc3NDAxNTc3MTU4M19hNzBhNjdmZi1mMDlmLTRmNWYtOWU3OC0xODEyYzA3MTUzYTI=',   // 2026-03-22 奶茶杯外卖订单贴纸
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc3MzA3MTcyNjMwOV9kY2IyYmI1MS05ZDZlLTRjZWEtYWIzYy02ODM3MGE0ZTAyZTQ=',   // 2026-03-10 奶茶杯外卖订单贴纸
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc2NDg1MzkxNzEzM18xN2ViOGMyZi1jNWYyLTRhMGItOTk0MC1lNjk5MjEyNmRhNjI=',   // 2025-12-05 带成员名单的分组表

    /* ---- 2026-09-24 站长第三批点名（9 张：官方物料 / 证书 / 外卖贴纸）---- */
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcyMTY2OTgxNzkzOF84ZDhhNDg2Mi00NjFjLTRlZDAtOWM4NC0zNjIwOWZmYTk5MzE=',   // 2024-07-23 奶茶杯外卖订单贴纸
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc3NTM4NzA4ODU1Ml9mNzNlYzljYS01NjU4LTQxYWQtOWMzYi05MThlYjZkNzJiMjU=',   // 2026-04-07 官方券/物料
    'bmltYV8xMTMzMjAyNjQ4MDBfMTc3MDMxMDczMjUzMF84YzQ2MDlhYi0wODk5LTQwZGQtOGVjMS1iZmI4ZTY1N2ZiMTk=',   // 2026-02-08 见面会人气奖证书
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcyMzI5MTI1MDcyOF8wM2U1YThmYi05MTk1LTRjYTItOTk3Ny0yMGYzODBjZTMwODQ=',   // 2024-08-12 官方物料
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcyMzI5MTI1MDcyOF9mYjU4Yzk2Ni1jZjllLTQxYjAtYjAyZS00N2U1NTk1MmVlZTc=',   // 2024-08-12 官方物料
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcyMjY1NzkzMzA4M19lNDZiMjJhYS03YjJjLTQ5ZTEtOTI0MC02ODNhYTVjMDQ4ZWE=',   // 2024-08-04 签名券说明
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcyMDc1NzIxMDk1MV84YjU0MmI3Ni04ZDFkLTQyZTUtOTg4Zi05NGEyOGI4ZjMxYmM=',   // 2024-07-14 盛典海报
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcyMDc1NzIxMDk1Ml80NmViMGIwYS04YjdkLTRlYzAtODVjOC00ZmZjMDA3MGJkMzM=',   // 2024-07-14 盛典海报
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwOTI4MDYzODMzNV8zYTYzNTE0ZC02YTI2LTRmZGItOWRhMi0wYmM3MjUwNTVmYzQ=',   // 2024-03-01 官方物料

    /* ---- 2026-09-24 站长第四批点名（1 张：外卖订单贴纸）---- */
    'bmltYV8xMTMzMjAyNjQ4MDBfMTcwOTU2MjEzNzEyNl9kZDM5ZGYzMy03NWZlLTQ0NjEtODI1NC1hYmIzMjZjODJiZTg=',   // 2024-03-05 奶茶杯外卖订单贴纸

  ];

  function boxOk(it, m) {
    if (!m.ok) return false;
    if (isPkOk(it.src)) return true;                    // ★ 站长点名的图：无条件放行
    if (it.wb) return true;
    const side = Math.max(m.w, m.h);
    const ratio = m.w / m.h;
    if (side < 1500) return false;                      // 表情包 / 缩略小图
    if (ratio < 0.62 || ratio > 1.8) return false;      // 手机截图、名单长图、聊天记录
    if (ratio >= 0.9 && ratio <= 1.1 && side < 2000) return false;
    if (PK_BAD_DIMS.has(m.w + 'x' + m.h)) return false; // ④-a
    for (let i = 0; i < PK_BAD_TAILS.length; i++) {     // ④-b
      const t = PK_BAD_TAILS[i];
      if (it.src && it.src.slice(-t.length) === t) return false;
    }
    return true;
  }

  /** 抽一张「合格」的照片；daily=今日份（按日期定，同一天每次结果一样）
   *  🔴 随机模式下「先掷定来源、再在来源内找合格照片」，来源不会因为某池杂质多就被挤掉。
   *  口袋池里有 6 成是表情包/海报/截图（判定必须先加载出来看尺寸），若每次重试都重掷来源，
   *  口袋侧最后只能占 28%（实测），本应 50%。 */
  async function pickBox(mode) {
    if (!buildBoxPool().length) return null;
    let last = null;
    if (mode === 'daily') {
      for (let i = 0; i < 6; i++) {
        const it = drawBox('daily', i);
        if (!it) break;
        last = it;
        if (boxOk(it, await preloadBox(it))) {
          LS.set(BOX_KEY, { day: boxDay(), src: it.src });       // 定下来就是今天的份
          return it;
        }
        markBoxJunk(it.src);                                     // 记住它，下次不再抽到、也不再白下载
      }
      return last;
    }
    const first = Math.random() < 0.5 ? 0 : 1;
    for (const flag of [first, 1 - first]) {                     // 本侧实在找不到才退回另一侧
      for (let i = 0; i < 8; i++) {
        const it = drawBox('random', i, flag);
        if (!it) break;
        last = it;
        if (boxOk(it, await preloadBox(it))) return it;
        markBoxJunk(it.src);
      }
    }
    return last;                                                 // 极端情况：全不合格也给一张，别白点
  }

  /* ---------- 盲盒分享卡：把「照片 + 心动指数 + 文案」画成一张能保存/能分享的图 ----------
   * 出图后复用 app.js 里档案卡那套 showAlbumLayer：手机走系统分享面板（面板里选「存储到照片」）
   * 或引导长按保存；只有桌面才用 a[download]。🔴 手机上绝不用 a[download]——那样只会
   * 落进「文件」App 的下载文件夹，进不了相册（站长 2026-09-23 定的规矩）。
   *
   * ⚠️ canvas 导出要求图片「跨域安全」（响应带 CORS 头），否则画布被污染、toDataURL 直接抛错：
   *    · 微博图  → 站点 /img 代理（新浪图床），响应带 access-control-allow-origin: *
   *    · 口袋图  → 云信直链本身没有 CORS 头；上正式站时已给 /img 白名单加上
   *      kd48-nosdn.yunxinsvr.com / nim-nosdn.netease.im，所以同样走自家代理，不借第三方。
   *      （万一代理没生效 / 图床抽风 → 兜底借一次公共图片代理，只用于画图，不影响页面展示）
   */
  const CARD_FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Heiti SC",sans-serif';
  const WESERV = (u) => 'https://images.weserv.nl/?url='
    + encodeURIComponent(String(u).replace(/^https?:\/\//, '')) + '&w=1200&output=jpg&q=90';

  /** 带 crossOrigin 加载：拿到能画进 canvas 的图，失败返回 null */
  function loadImgCors(url) {
    return new Promise((resolve) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      im.onload = () => fin(im);
      im.onerror = () => fin(null);
      im.src = url;
      setTimeout(() => fin(null), 20000);
    });
  }

  async function loadCardImg(it) {
    // 一律先走自家 /img 代理（两个图床都在白名单里），失败才退到公共代理
    const cands = [boxProxy(it), WESERV(it.src)];
    for (let i = 0; i < cands.length; i++) {
      const im = await loadImgCors(cands[i]);
      if (im && im.naturalWidth) return im;
    }
    return null;
  }

  function rrect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /** 逐字符量宽换行（canvas 不认 \n，必须自己切）；超出行数末尾补省略号 */
  function wrapLines(ctx, text, maxW, maxLines) {
    const out = [];
    let cur = '';
    for (const ch of String(text || '')) {
      if (cur && ctx.measureText(cur + ch).width > maxW) {
        out.push(cur);
        if (out.length >= maxLines) return out;
        cur = ch;
      } else cur += ch;
    }
    if (cur) out.push(cur);
    if (out.length > maxLines) out.length = maxLines;
    return out;
  }

  const TIER_COLOR = { SSR: ['#ffb53d', '#ff7a2f', '#ff8a3d'], SR: ['#ff7aa2', '#ff5f7e', '#ff5f7e'],
    R: ['#4bd0e8', '#2bc4e0', '#2bc4e0'], N: ['#b9b9c2', '#9a9aa4', '#8a8a92'] };

  /** 画卡片：逻辑宽 900，整体放大 2 倍出图（字和间距都用逻辑坐标，等比放大） */
  function drawBoxCard(img, it, lines) {
    const SC = 2, W = 900, PAD = 48;
    const h = heartOf(it.src);
    const c = TIER_COLOR[h.tier.tag] || TIER_COLOR.N;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const pw = W - PAD * 2;
    // 照片按原始比例铺满宽度（尽量不裁脸）；只有极端长图/横幅才裁到 560~1150
    const ph = Math.round(Math.min(1150, Math.max(560, pw * ih / iw)));
    const textH = lines.length ? 14 + lines.length * 38 : 0;
    const H = PAD + ph + 28 + 349 + textH + PAD;   // 349 = 下方文字区固定高度（含条、档位、来源、底注）

    const cv = document.createElement('canvas');
    cv.width = W * SC; cv.height = Math.round(H) * SC;
    const ctx = cv.getContext('2d');
    ctx.scale(SC, SC);
    ctx.textBaseline = 'alphabetic';

    // 背景
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#fff8fa'); g.addColorStop(1, '#ffeaf1');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // 照片（圆角裁剪 + 居中裁满）
    ctx.save();
    rrect(ctx, PAD, PAD, pw, ph, 26);
    ctx.clip();
    const s = Math.max(pw / iw, ph / ih);
    const dw = iw * s, dh = ih * s;
    ctx.drawImage(img, PAD + (pw - dw) / 2, PAD + (ph - dh) / 2, dw, dh);
    ctx.restore();

    // 左上角稀有度徽章
    ctx.save();
    ctx.font = 'bold 26px ' + CARD_FONT;
    const bw = ctx.measureText(h.tier.tag).width + 44;
    rrect(ctx, PAD + 20, PAD + 20, bw, 50, 25);
    const bg = ctx.createLinearGradient(PAD + 20, PAD + 20, PAD + 20 + bw, PAD + 70);
    bg.addColorStop(0, c[0]); bg.addColorStop(1, c[1]);
    ctx.fillStyle = bg; ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(h.tier.tag, PAD + 20 + bw / 2, PAD + 46);
    // 右上角「今日份 / 随机抽」
    ctx.textAlign = 'right';
    ctx.font = '22px ' + CARD_FONT;
    const flag = boxDaily ? '今日份' : '随机抽';
    const fw = ctx.measureText(flag).width + 32;
    rrect(ctx, W - PAD - 20 - fw, PAD + 20, fw, 50, 25);
    ctx.fillStyle = 'rgba(0,0,0,.34)'; ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(flag, W - PAD - 36, PAD + 46);
    ctx.restore();

    let y = PAD + ph + 28;
    ctx.textBaseline = 'alphabetic';

    // 心动指数
    ctx.textAlign = 'left';
    ctx.font = '25px ' + CARD_FONT; ctx.fillStyle = '#8a8a92';
    ctx.fillText('心动指数', PAD, y + 44);
    ctx.textAlign = 'right';
    ctx.font = 'bold 64px ' + CARD_FONT; ctx.fillStyle = c[2];
    const num = String(h.val);
    ctx.font = 'bold 30px ' + CARD_FONT;
    const sw = ctx.measureText('%').width;
    ctx.font = 'bold 64px ' + CARD_FONT;
    ctx.fillText(num, W - PAD - sw - 2, y + 46);
    ctx.font = 'bold 30px ' + CARD_FONT;
    ctx.fillText('%', W - PAD, y + 46);
    y += 62;

    // 进度条
    ctx.save();
    rrect(ctx, PAD, y + 16, pw, 14, 7);
    ctx.fillStyle = '#f2e6ea'; ctx.fill();
    rrect(ctx, PAD, y + 16, Math.max(14, pw * h.val / 100), 14, 7);
    const pg = ctx.createLinearGradient(PAD, 0, W - PAD, 0);
    pg.addColorStop(0, '#ffd08a'); pg.addColorStop(1, c[1]);
    ctx.fillStyle = pg; ctx.fill();
    ctx.restore();
    y += 46;

    // 档位名 + 短评
    ctx.textAlign = 'left';
    ctx.font = 'bold 36px ' + CARD_FONT; ctx.fillStyle = '#26262c';
    ctx.fillText(h.tier.name, PAD, y + 32);
    y += 50;
    ctx.font = '26px ' + CARD_FONT; ctx.fillStyle = '#8a8a92';
    ctx.fillText(h.line, PAD, y + 24);
    y += 40;

    // 来源
    const meta = [it.from, it.date, it.sub].filter(Boolean).join(' · ');
    ctx.font = '23px ' + CARD_FONT; ctx.fillStyle = '#a8a8b0';
    ctx.fillText(meta, PAD, y + 20);
    y += 36;

    // 原文案（最多两行）
    if (lines.length) {
      y += 14;
      ctx.font = '27px ' + CARD_FONT; ctx.fillStyle = '#4a4a52';
      lines.forEach((ln, i) => ctx.fillText(ln, PAD, y + 26 + i * 38));
      y += lines.length * 38;
    }

    // 底注
    y += 24;
    ctx.fillStyle = '#e6d7dd'; ctx.fillRect(PAD, y, pw, 1);
    y += 30;
    ctx.textAlign = 'left';
    ctx.font = '24px ' + CARD_FONT; ctx.fillStyle = '#8a8a92';
    ctx.fillText('🎁 王语晨 · ' + (boxDaily ? '今日盲盒' : '随机盲盒'), PAD, y);
    ctx.textAlign = 'right';
    ctx.fillText('idol.wyc0518.cc', W - PAD, y);

    return cv;
  }

  async function makeBoxCard() {
    if (!boxItem) return;
    toast('正在生成分享图…');
    const img = await loadCardImg(boxItem);
    if (!img) { toast('这张图暂时画不出来，换一张试试'); return; }
    let cv = null;
    try {
      const m = document.createElement('canvas').getContext('2d');
      m.font = '27px ' + CARD_FONT;
      const lines = wrapLines(m, String(boxItem.text || '').replace(/\s+/g, ' ').trim(), 900 - 96, 2);
      cv = drawBoxCard(img, boxItem, lines);
    } catch (e) { toast('生成失败，稍后再试'); return; }
    const stamp = fmtBJ(new Date()) + '-' + heartOf(boxItem.src).val;
    // JPEG 而非 PNG：这张卡是照片为主，JPEG 画质看不出差别，数据量只有 PNG 的十分之一
    // （PNG 的 dataURL 实测 6.4MB，手机上分享/预览都容易卡）
    const url = cv.toDataURL('image/jpeg', 0.92);
    if (typeof track === 'function') track('box:card');
    if (typeof showAlbumLayer === 'function') showAlbumLayer(url, stamp, '王语晨盲盒');
    else { const a = document.createElement('a'); a.href = url; a.download = '王语晨盲盒.jpg'; a.click(); }
  }

  /** 线上数据是「首屏 recent + 历史月后台继续拉」，刚开页面就点盲盒的话池子只有几十张。
   *  这时先等历史月拉完（最多 6 秒）；池子够大就立刻抽，绝不让用户干等。 */
  async function waitBoxPool(min) {
    if (buildBoxPool().length >= min) return;
    let p = null;
    try { p = (typeof allMonthsPromise !== 'undefined' && allMonthsPromise) ? allMonthsPromise : null; } catch (_) { p = null; }
    if (!p) return;
    await Promise.race([p.catch(() => null), new Promise((r) => setTimeout(r, 6000))]);
  }

  let boxBusy = false;
  async function openBlindBox(daily) {
    if (!buildBoxPool().length) { toast('照片还没加载好，等一下再抽'); return; }
    if (boxBusy) return;
    boxBusy = true;
    boxDaily = daily !== false;
    renderBoxLoading();
    try {
      await waitBoxPool(300);
      const it = await pickBox(boxDaily ? 'daily' : 'rand');
      if (!it) { closeModal(); toast('照片还没加载好，等一下再抽'); return; }
      boxItem = it;
      renderBlindBox();
      if (typeof track === 'function') track('box:open');
    } finally { boxBusy = false; }
  }

  function injectBlindBox() {
    if ($('#bmFab')) return;
    const fab = document.createElement('button');
    fab.className = 'bm-fab';
    fab.type = 'button';
    fab.id = 'bmFab';
    fab.innerHTML = '<span class="bm-fab-ico">🎁</span><span class="bm-fab-txt">盲盒</span>';
    fab.title = '今日盲盒：随机抽一张她的照片 + 心动指数';
    fab.addEventListener('click', () => openBlindBox(true));
    document.body.appendChild(fab);

    // 兜底：出图前已预加载校验过，这里只会出现在中途断网/缓存失效的情况
    window.__bmImgFail = function () { toast('这张图暂时加载不出来，点「换一张」试试'); };

    document.addEventListener('click', (e) => {
      if (e.target.closest('.bm-again')) { openBlindBox(false); return; }
      if (e.target.closest('.bm-dl')) { makeBoxCard(); return; }
      if (e.target.closest('.bm-copy')) { copyText(boxText()); if (typeof track === 'function') track('box:copy'); return; }
    });
  }

  /* =====================================================================
     功能 ⑬ 追星日历（站长 2026-09-25 提出）
     月历视图 + 「我要去」标记 + 倒计时 + 照片记录打卡。

     🔴 照片记录 = 本地合成、绝不上传：照片经 FileReader 只进 Canvas 合成打卡图，
        原图**不落服务端**。票根 / 自拍 / 现场照都可能有二维码、订单号、他人正脸
        （部分票根还带实名），上传即泄露隐私，且与站长自定的盲盒判据
        「图上有 ID / 名字 / 订单信息的一律不要」正面冲突。所以只记「这场我去过」
        这个事实 + 一张仅供本机回看的照片标记，不收原图。

     标记只存 localStorage（与「鸡腿要不要写进分享图」那几个开关同一套路），
     不进 KV、不接登录。代价：换设备 / 清缓存会丢，可接受。
     ===================================================================== */
  const CAL_LS = 'wyc-demo-cal-v1';
  const CAL_MONTH_KEY = 'wyc-demo-cal-month-v1';   // 记住上次看的月份（换月即存）
  const CAL_KINDS = { '公演': '#185FA5', '见面会': '#993556' };
  // 🔴 站长 2026-09-25 定的两张卡口径，**别再互相串**：
  //    公演汇总 = 王语晨本人的场次（本月 / 今年 / 全部）→ 她的，跟谁看无关，**不查 uid**；
  //    我的公演档案 = 我打卡的（本月 / 今年 / 认识以后）→ 「认识以后」只认我自己 uid 的认识日，
  //    uid 没填或被清除 → 这一档整个不显示，不猜、不写死日期。
  const CAL_MAX_PHOTOS = 9;       // 每场最多留 9 张照片记录（本地缩略图，原图不上传）
  const calColor = (k) => CAL_KINDS[k] || '#888780';
  let calStore = LS.get(CAL_LS, { going: {}, went: {} });
  // 迁移：早期 went[k].photo 是 true / 单张字符串，统一成 photos 数组
  (function calMigrate() {
    const w = calStore.went || {};
    Object.keys(w).forEach((k) => {
      const r = w[k];
      if (!r || typeof r !== 'object') { w[k] = { ts: 0, photos: [] }; return; }
      if (!Array.isArray(r.photos)) r.photos = (typeof r.photo === 'string' && r.photo) ? [r.photo] : [];
      delete r.photo;
    });
  })();
  // 老键（"日期 时间 标题"）→ 新键（"日期|时间"）：把标题变更导致的孤儿记录救回来，
  // 救回后它们重新对应到当前条目 → 爱心出现、「取消」按钮出现，点了才真的从计数里去掉。
  (function calMigrateKey() {
    let ch = false;
    const fix = (o) => {
      if (!o) return;
      Object.keys(o).forEach((k) => {
        if (String(k).indexOf('|') >= 0) return;                 // 已是新键
        const p = String(k).split(' ');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p[0] || '')) return;     // 认不出日期就不动它
        const nk = p[0] + '|' + (p[1] || '');
        if (!o[nk]) o[nk] = o[k];
        delete o[k];
        ch = true;
      });
    };
    fix(calStore.went); fix(calStore.going);
    if (ch) LS.set(CAL_LS, calStore);
  })();
  /* 🔴「认识以后」起点 = 我的档案里那个 uid 的认识日（/api/mine 的 f = 他最早留下记录的时间戳）。
     站长 2026-09-25 定的规则：uid 在（没被清除）就显示这一档；uid 清掉了 → 整档不显示，不猜、不写死日期。 */
  const CAL_MET_KEY = 'wyc-demo-cal-met-v1';
  let calMetDate = '';      // '' = 不知道（没 uid / 没查到）→ 不显示「认识以后」
  let calMetUid = '?', calMetAt = 0;
  function calMetSave(uid, start) {
    calMetDate = /^\d{4}-\d{2}-\d{2}$/.test(String(start || '')) ? String(start) : '';
    try {
      if (calMetDate) localStorage.setItem(CAL_MET_KEY, JSON.stringify({ uid: String(uid), start: calMetDate }));
      else localStorage.removeItem(CAL_MET_KEY);
    } catch (_) {}
  }
  function calMetCache(uid) {
    try {
      const j = JSON.parse(localStorage.getItem(CAL_MET_KEY) || 'null');
      if (j && String(j.uid) === String(uid) && /^\d{4}-\d{2}-\d{2}$/.test(String(j.start || ''))) {
        calMetDate = String(j.start); return true;
      }
    } catch (_) {}
    return false;
  }
  const calMetUidNow = () => {
    try { return (typeof MINE_KEY !== 'undefined' ? localStorage.getItem(MINE_KEY) : '') || ''; } catch (_) { return ''; }
  };
  async function calFetchMet() {
    const uid = calMetUidNow();
    const ok = /^\d{4,12}$/.test(uid);
    // uid 没变就不重复打接口（拿不到也最多 60s 重试一次）；清掉 uid 会立刻重算 → 这一档消失
    if (uid === calMetUid && (calMetDate || !ok || Date.now() - calMetAt < 60000)) return;
    calMetUid = uid; calMetAt = Date.now();
    if (!ok) { calMetSave('', ''); calSig = ''; calRender(); return; }   // 没 uid / 被清除
    if (!calMetCache(uid)) {
      try {
        const base = /wyc0518\.cc$/.test(location.hostname) ? '' : 'https://idol.wyc0518.cc';
        const r = await fetch(base + '/api/mine', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: uid })
        });
        if (r.ok) {
          const d = await r.json() || {};
          const f = Number(d && d.f);                                    // 首条记录时间戳(ms) → 北京日期
          let day = (isFinite(f) && f > 0) ? bjDate(f) : '';
          if (!day && /^\d{4}-\d{2}-\d{2}$/.test(String((d && d.start) || ''))) day = String(d.start);
          calMetSave(uid, day);
        }
      } catch (_) { /* 拿不到就整档不显示，绝不白屏、绝不写死日期 */ }
    }
    calSig = ''; calRender();
    if (document.querySelector('.tkc-arc')) calOpenArchive();   // 档案弹窗正开着 → 顺手刷新成新口径
  }
  let calItems = [], calMonth = '', calSel = '', calSig = '', calTick = null, calFetched = false;

  const calStart = (t) => (String(t || '').trim() ? String(t).split('-')[0].trim() : '时间待定');
  // 🔴 键里**不能放标题**：d37 把标题从 p.title（「GNZ48剧场公演」）换成 p.subTitle（「拾忆：TEAM NIII·第二十六场」）后，
  //    之前存的标记键全部失配 → 变成「孤儿」：日历上找不到（没爱心、点不到取消），calMine 却照样计数，
  //    站长表现为「我取消了，档案卡还是显示 3」。改成只认 日期|时间，标题再变也不受影响。
  const calKey = (it) => String(it.date || '') + '|' + String(it.time || '');
  // 开演时刻（北京时间）：time 形如 "14:00" 或 "17:30-19:30"（取前半段）
  function calStartMs(it) {
    const t = calStart(it.time);
    if (!/^\d{1,2}:\d{2}$/.test(t)) return Date.parse(it.date + 'T00:00:00+08:00');  // 时间待定 → 按当天 0 点计，倒计时只到「天」
    const v = Date.parse(it.date + 'T' + t + ':00+08:00');
    return isFinite(v) ? v : Date.parse(it.date + 'T00:00:00+08:00');
  }
  // 🔴「已经发生」：汇总卡只统计开演过的场次（站长 2026-09-25 要求，未开演的不算进「本月/今年/认识以后」）
  //   过去日期 = 已发生；未来日期 = 未发生；今天看开演时间是否已过（时间待定则先不算）
  function calDone(x) {
    const today = fmtBJ(new Date());
    if (!x || !x.date) return false;
    if (x.date < today) return true;
    if (x.date > today) return false;
    if (!x.time) return false;
    const t = calStartMs(x);
    return !!(t && t <= Date.now());
  }
  /* 🔴 日历条目 = 公演档案（权威，**一条 = 一场**）+ 日程表里档案没有的条目。
     2026-09-25 修（站长：「丢公演了 为啥还是 263 应该是 277」）：
     原来用 `日期|kind` 去重 → 把**同一天两场**（如 2022-12-03 16:45 猜拳大会 + 19:45 TEAM G 公演，
     共 13 天）并成一场，于是「全部」数出 263（天数）而不是 277（场次）；今年 53≠56、认识以后 184≠191 同理。
     ⇒ 档案条目**全部保留**；日程条目只在「同一天 + 同 kind + 开演时间相近（≤2 小时）」时才判为同一场跳过。
     档案缺的场次（如 2026-10-03 周年庆）由日程补进来。 */
  function calLoad() {
    const S = window.__SCHEDULE__ || {};
    // items = 已确定场次；future = 更远的安排/预告（可能没有 time）。两者都要进日历
    const raw = (S.items || []).concat(S.future || []).filter((x) => x && x.date);
    const sched = raw.map((x) => ({
      date: x.date, weekday: x.weekday || '', time: x.time || '', title: x.title || '', kind: x.kind || ''
    }));
    // 公演档案（DATA.performances）：认识她以来每一场，一条 = 一场（同一天午场+晚场算两场）
    const perfs = (typeof DATA !== 'undefined' && DATA && DATA.performances) ? DATA.performances : [];
    const arr = [];
    perfs.forEach((p) => {
      const ts = Number(p.stime || p.ctime);
      if (!isFinite(ts) || ts <= 0) return;
      const d = new Date(ts + 8 * 3600e3);
      const time = p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
      // 🔵 具体公演名优先：p.title 大多是笼统的「GNZ48剧场公演」（279 场里 234 场都是），
      //    真正的剧目/队名在 p.subTitle（如「拾忆：TEAM NIII·第二十八场」）和 p.teamList（TEAM NIII）。
      //    站长 2026-09-25 要求显示具体名称而不是「GNZ48剧场公演」。
      const team = (Array.isArray(p.teamList) && p.teamList[0] && p.teamList[0].teamName) || '';
      let title = String(p.subTitle || '').trim();
      if (!title) title = team ? (team + ' 公演') : String(p.title || '').trim();
      if (!title) title = '公演';
      arr.push({ date: bjDate(ts), weekday: '', time: time, title: title, kind: '公演', src: 'archive' });
    });
    const toMin = (t) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
      return m ? (+m[1]) * 60 + (+m[2]) : -1;
    };
    sched.forEach((x) => {
      const a = toMin(x.time);
      const dup = arr.some((y) => {
        if (y.date !== x.date || y.kind !== x.kind) return false;
        const b = toMin(y.time);
        if (a < 0 || b < 0) return true;            // 有一方没写时间 → 当成同一场，别重复计
        return Math.abs(a - b) <= 120;
      });
      if (!dup) arr.push(x);
    });
    arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : calStartMs(a) - calStartMs(b)));
    return arr;
  }
  /* 「我要去」的场次过了开演 → 自动变「我去了」（站长 2026-09-25 要求）。
     取消：写 cancelled 墓碑（保留 key），这样之后再渲染不会被自动加回来。 */
  function calSyncGoing() {
    const now = Date.now();
    let changed = false;
    calItems.forEach((x) => {
      const gk = calGoingKeyOf(x);
      if (!gk || !calStore.going[gk]) return;
      const wk = calWentKeyOf(x) || calKey(x);
      if (calStartMs(x) < now - 6 * 3600e3 && !calStore.went[wk]) {
        calStore.went[wk] = { ts: Date.now(), auto: true, photos: [] };
        delete calStore.going[gk];
        changed = true;
      }
    });
    if (changed) LS.set(CAL_LS, calStore);
  }
  // 有效「我去了」= 有记录且未被取消
  function calIsWent(k) { const r = calStore.went[k]; return !!(r && !r.cancelled); }
  /* 🔴 打卡记录「认领」：先按 日期|时间 精确对；对不上就退到「同一天」。
     原因：后台改过开演时间 / 数据源换了一份（微博 vs 公演存档）时，键会变，
     老记录就变成「写了但显示不出来」的孤儿 —— 站长 2026-09-25 遇到的正是这个（关掉页面再看，爱心没了）。
     退到日期级后，时间怎么变都认得回来；同时 calMine 只从 calItems 反查，对不上任何场次的旧键不再计数。 */
  /* 🔴🔴 同一天两场必须「各算各的」（站长 2026-09-25 报：点一个「我要去」，另一场也跟着勾上）。
     上面那个「退到同一天」的兜底是为救孤儿记录设计的，但它在一天多场时会把两场串成一场：
     点第二场 → 认领到第一场的键 → 两场都显示已勾、实际只存得下一个。
     ⇒ 只有这天在 calItems 里**只有一场**时才允许退到日期级；多场一律精确匹配。 */
  let calDayN = {};
  function calReindex() {
    const m = {};
    calItems.forEach((x) => { m[x.date] = (m[x.date] || 0) + 1; });
    calDayN = m;
  }
  function calKeyOf(bag, it) {
    const k = calKey(it);
    if (bag[k]) return k;
    if ((calDayN[it.date] || 0) !== 1) return '';      // 这天有多场 → 不许按日期认领
    const pre = String(it.date || '') + '|';
    const hit = Object.keys(bag).filter((x) => x.slice(0, pre.length) === pre);
    return hit.length ? hit[0] : '';
  }
  const calWentKeyOf = (it) => calKeyOf(calStore.went, it);
  const calGoingKeyOf = (it) => calKeyOf(calStore.going, it);
  function calPhotos(k) { const r = calStore.went[k]; return (r && Array.isArray(r.photos)) ? r.photos : []; }
  function calSavePhotos(k, arr) {
    if (!calStore.went[k]) return true;
    calStore.went[k].photos = arr;
    const ok = LS.set(CAL_LS, calStore);
    if (!ok && typeof toast === 'function') toast('本地存不下了，照片可能太多');
    return ok;
  }

  // demo 域名下 API_BASE 指向生产 Worker；拿不到就用页面自带的 js/schedule.js 快照
  async function calFetch() {
    if (calFetched) return;
    calFetched = true;
    const base = /wyc0518\.cc$/.test(location.hostname) ? '' : 'https://idol.wyc0518.cc';
    try {
      const r = await fetch(base + '/api/schedule', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (j && Array.isArray(j.items) && j.items.length) {
        window.__SCHEDULE__ = Object.assign({}, window.__SCHEDULE__ || {}, j);
        calItems = calLoad();
        calReindex();
        calSig = '';
        calRender();
      }
    } catch (_) { /* 拿不到就用快照，绝不白屏 */ }
  }

  function calNext() {
    const now = Date.now();
    const mine = calItems.filter((x) => calStore.going[calKey(x)] && calStartMs(x) > now);
    const pool = mine.length ? mine : calItems.filter((x) => calStartMs(x) > now);
    return pool.length ? { it: pool[0], mine: mine.length > 0 } : null;
  }
  /* 🔴 「今天 / 明天 / 昨天」必须按**日历日期**判断，绝不能按「还剩（过）不到 24 小时」推。
     踩过的坑（站长 2026-09-25 反馈「下一场不是 9/26 吗，为啥显示今天」）：
     9/25 15:05 距 9/26 14:00 只有约 23 小时 → Math.floor(ms/86400000) = 0 →
     旧代码走进 `h > 0` 分支，那里把文案**写死成「今天」**，于是把明天的场次说成了今天。 */
  function calDayWord(dateStr) {
    const today = fmtBJ(new Date());
    if (dateStr === today) return '今天';
    if (dateStr === fmtBJ(new Date(Date.now() + 86400000))) return '明天';
    if (dateStr === fmtBJ(new Date(Date.now() - 86400000))) return '昨天';
    return '';
  }
  // a - b 相差几天（都按北京日期算，避免时区/夏令时误差）
  function calDayDiff(a, b) {
    return Math.round((Date.parse(a + 'T00:00:00+08:00') - Date.parse(b + 'T00:00:00+08:00')) / 86400000);
  }
  function calCountText() {
    const n = calNext();
    if (!n) return '暂无公演安排';
    const ms = calStartMs(n.it) - Date.now();
    if (ms <= 0) return '正在进行中';
    const pre = n.mine ? '你要去的下一场 · ' : '下一场 · ';
    const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), mi = Math.floor((ms % 3600000) / 60000);
    const word = calDayWord(n.it.date);   // 今天 / 明天 / ''（更远）
    if (!n.it.time) {
      return word ? pre + word + '（时间待定）' : pre + d + ' 天后（时间待定）';
    }
    // 时长按真实剩余量说：满 1 天就说「X 天 Y 小时」，不足 1 天才说「X 小时 Y 分」
    const dur = d > 0 ? d + ' 天 ' + h + ' 小时' : (h > 0 ? h + ' 小时 ' + mi + ' 分' : mi + ' 分钟');
    return word ? pre + word + ' ' + calStart(n.it.time) + ' · 还有 ' + dur : pre + dur;
  }
  // 上次见面：优先取「我去了」里最近的一场（你真的去了）；没标记过则退到上一次公演（整体）
  function calLastMetText() {
    const now = Date.now();
    const wentList = Object.keys(calStore.went).filter(calIsWent)
      .map((k) => calItems.find((x) => calKey(x) === k))
      .filter(Boolean)
      .sort((a, b) => calStartMs(b) - calStartMs(a));
    let it = wentList[0], fromWent = !!it;
    if (!it) {
      const past = calItems.filter((x) => calStartMs(x) < now).sort((a, b) => calStartMs(b) - calStartMs(a));
      it = past[0];
    }
    if (!it) return '还没有公演记录';
    // 同样按日历日期算，避免「昨天 16:00 的场、今天 15:00 看」被算成 0 天而说成「就是今天」
    const days = calDayDiff(fmtBJ(new Date()), it.date);
    const dlabel = days <= 0 ? '就是今天' : (days === 1 ? '昨天' : days + ' 天前');
    const who = fromWent ? '上次见面' : '上一次公演';
    const ttl = (it.title || '').replace(/[《》]/g, '');
    return who + '：' + dlabel + '（' + it.date.slice(5).replace('-', '/') + (ttl ? ' ' + ttl : '') + '）';
  }

  // 年份下拉范围：最早到 2022（入坑），最晚到数据里最大年份 +1（未来月份也能跳）
  function calYearRange() {
    const years = calItems.map((x) => Number(x.date.slice(0, 4))).filter((n) => n >= 2000 && n < 2100);
    const minY = Math.min(2022, years.length ? Math.min.apply(null, years) : 2022);
    const maxY = Math.max(new Date().getFullYear(), years.length ? Math.max.apply(null, years) : new Date().getFullYear());
    return [minY, maxY + 1];
  }

  function calGrid() {
    const y = Number(calMonth.slice(0, 4)), m = Number(calMonth.slice(5, 7));
    const dow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;   // 周一 = 0
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const today = fmtBJ(new Date());
    let s = '';
    for (let i = 0; i < dow; i++) s += '<i class="tkc-pad"></i>';
    for (let d = 1; d <= days; d++) {
      const k = calMonth + '-' + p2(d);
      const list = calItems.filter((x) => x.date === k);
      const mine = list.some((x) => !!calGoingKeyOf(x));
      const went = list.some((x) => calIsWent(calWentKeyOf(x)));
      let cls = 'tkc-cell';
      if (list.length) cls += ' has';
      if (mine) cls += ' mine';
      if (went) cls += ' went';
      if (k === today) cls += ' today';
      if (k === calSel) cls += ' sel';
      // 「我去了」的日格不画场次圆点（爱心本身就是标记，日期要落在爱心正中）
      const dots = (list.length && !went)
        ? '<span class="tkc-dots">' + list.slice(0, 3).map((x) => '<i style="background:' + calColor(x.kind) + '"></i>').join('') + '</span>' : '';
      // 描边爱心包住日期：照站长参考图（粗圆描边、无填充、数字在爱心内部）
      const heart = went ? '<svg class="tkc-heart" viewBox="0 0 24 24" aria-hidden="true" focusable="false" title="我去过">'
        + '<path d="M12 20.6C12 20.6 2.9 14.1 2.9 8.6 2.9 5.8 5.1 3.6 7.8 3.6c1.7 0 3.3.9 4.2 2.3.9-1.4 2.5-2.3 4.2-2.3 2.7 0 4.9 2.2 4.9 5 0 5.5-9.1 12-9.1 12z"/>'
        + '</svg>' : '';
      s += '<button type="button" class="' + cls + '" data-cal-day="' + k + '">' + heart + '<b>' + d + '</b>' + dots + '</button>';
    }
    return s;
  }

  function calDayHtml() {
    const list = calItems.filter((x) => x.date === calSel);
    if (!list.length) return '<div class="tkc-empty">这天没有安排</div>';
    const now = Date.now();
    return list.map((x) => {
      // 认领已有记录（时间变过也能对上）；没有就用当前这条的键
      const k = calWentKeyOf(x) || calKey(x);
      // 开演后 6 小时算已结束 —— 别让刚散场的人看不到「我去了」
      const past = calStartMs(x) < now - 6 * 3600e3;
      let act;
      if (past) {
        if (calIsWent(k)) {
          const np = calPhotos(k).length;
          act = '<span class="tkc-went">这场我在</span>'
            + '<button type="button" class="tkc-btn ghost" data-cal-photo="' + esc(k) + '">' + (np ? '照片 ' + np + '/' + CAL_MAX_PHOTOS : '加照片') + '</button>'
            + '<button type="button" class="tkc-btn ghost" data-cal-cancel="' + esc(k) + '">取消</button>';
        } else {
          act = '<button type="button" class="tkc-btn" data-cal-went="' + esc(k) + '">我去了</button>';
        }
      } else {
        const gk = calGoingKeyOf(x) || calKey(x);
        const g = calStore.going[gk];
        act = '<button type="button" class="tkc-btn' + (g ? ' on' : '') + '" data-cal-go="' + esc(gk) + '">' + (g ? '我要去 ✓' : '我要去') + '</button>'
          + '<button type="button" class="tkc-btn ghost" data-cal-share="' + esc(k) + '">分享</button>';
      }
      return '<div class="tkc-item"><span class="tkc-bar" style="background:' + calColor(x.kind) + '"></span>'
        + '<div class="tkc-main"><div class="tkc-t">' + esc(x.title) + '</div>'
        + '<div class="tkc-m">' + esc(x.date.slice(5).replace('-', '/')) + ' ' + esc(x.weekday) + ' · ' + esc(calStart(x.time)) + ' · ' + esc(x.kind || '活动') + '</div></div>'
        + '<div class="tkc-act">' + act + '</div></div>';
    }).join('');
  }

  function calSigNow() {
    return [calMonth, calSel, calItems.length,
      Object.keys(calStore.going).join(','), Object.keys(calStore.went).join(',')].join('|');
  }
  function calRender() {
    const box = $('#calBox');
    if (!box) return;
    try { localStorage.setItem(CAL_MONTH_KEY, calMonth); } catch (_) {}
    const y = calMonth.slice(0, 4), m = Number(calMonth.slice(5, 7));
    const nMonth = calItems.filter((x) => x.date.slice(0, 7) === calMonth).length;
    const yr = calYearRange();
    let yopts = '';
    for (let yy = yr[0]; yy <= yr[1]; yy++) yopts += '<option value="' + yy + '"' + (yy === Number(y) ? ' selected' : '') + '>' + yy + ' 年</option>';
    let mopts = '';
    for (let mm = 1; mm <= 12; mm++) mopts += '<option value="' + p2(mm) + '"' + (mm === m ? ' selected' : '') + '>' + mm + ' 月</option>';
    box.innerHTML = '<div class="tkc">'
      + '<div class="tkc-meet">'
      + '<div class="tkc-meet-c"><span class="tkc-meet-l">上次见面</span><b id="calLast">' + esc(calLastMetText()) + '</b></div>'
      + '<div class="tkc-meet-c"><span class="tkc-meet-l">下次见面</span><b id="calCount">' + esc(calCountText()) + '</b></div>'
      + '</div>'
      + '<div class="tkc-btns">'
      + (calNext() ? '<button type="button" class="tkc-share" id="calShareNext">📤 分享这张倒计时</button>' : '')
      + '<button type="button" class="tkc-share arc" id="calArc">📊 公演档案</button>'
      + '</div>'
      + '<div class="tkc-head">'
      + '<button type="button" class="tkc-nav" id="calPrev" aria-label="上个月">‹</button>'
      + '<div class="tkc-ymsel">'
      + '<select id="calYearSel" class="tkc-sel" aria-label="选择年份">' + yopts + '</select>'
      + '<select id="calMonthSel" class="tkc-sel" aria-label="选择月份">' + mopts + '</select>'
      + '</div>'
      + '<button type="button" class="tkc-nav" id="calNext" aria-label="下个月">›</button>'
      + (nMonth ? '<span class="tkc-n">' + nMonth + ' 场</span>' : '')
      + '</div>'
      + '<div class="tkc-wd">' + ['一', '二', '三', '四', '五', '六', '日'].map((d) => '<i>' + d + '</i>').join('') + '</div>'
      + '<div class="tkc-grid">' + calGrid() + '</div>'
      + '<div class="tkc-day"><div class="tkc-dayh">' + esc(calSel || '') + '</div>' + calDayHtml() + '</div>'
      + '</div>';
  }

  function calGotoMonth(delta) {
    const y = Number(calMonth.slice(0, 4)), m = Number(calMonth.slice(5, 7));
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    calMonth = d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1);
    // 切过去若该月有安排，自动选中第一个有安排的日子
    const first = calItems.filter((x) => x.date.slice(0, 7) === calMonth).map((x) => x.date)[0];
    if (calSel.slice(0, 7) !== calMonth && first) calSel = first;
    calSig = '';
    calRender();
  }

  /* ---- 照片记录打卡：图只在本地走一趟 Canvas ---- */
  let calFile = null, calPending = null, calDelIdx = 0;
  function calHasPhoto(k) { return calPhotos(k).length > 0; }
  // 每张照片只存一张缩略图（长边 ≤720px，卡片里放大也不糊），原图绝不上传
  const CAL_THUMB = 720;
  function calMakeThumb(src) {
    return new Promise((ok) => {
      const im = new Image();
      im.onload = () => {
        const sc = Math.min(1, CAL_THUMB / Math.max(im.naturalWidth || 1, im.naturalHeight || 1));
        const w = Math.max(1, Math.round((im.naturalWidth || 1) * sc));
        const h = Math.max(1, Math.round((im.naturalHeight || 1) * sc));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const cx = c.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);   // 透明 PNG 垫白，避免卡片里发黑
        cx.drawImage(im, 0, 0, w, h);
        try { ok(c.toDataURL('image/jpeg', 0.85)); } catch (e) { ok(''); }
      };
      im.onerror = () => ok('');
      im.src = src;
    });
  }
  // 照片管理弹窗：已有缩略图网格（每张可单独删）+ 加照片（满 9 张停）+ 生成打卡图
  function calPhotoModal(k) {
    calPending = calItems.find((x) => calKey(x) === k) || null;
    const photos = calPhotos(k);
    const cells = photos.map((u, i) => '<span class="tkc-thumb"><img src="' + esc(u) + '" alt="照片记录">'
      + '<button type="button" class="tkc-thumb-x" data-cal-delidx="' + i + '" aria-label="删除这张">×</button></span>').join('');
    const grid = photos.length
      ? '<div class="tkc-thumbs">' + cells + '</div>'
      : '<div class="tkc-hint tkc-thumb-none">还没有照片，点下面加一张</div>';
    const full = photos.length >= CAL_MAX_PHOTOS;
    modal('照片记录 ' + photos.length + '/' + CAL_MAX_PHOTOS,
      '<div class="tkc-mbody">' + grid
      + '<span class="tkc-hint">照片（票根 / 自拍 / 现场照都行）只在你手机上合成，不会上传' + (full ? ' · 已满 9 张' : '') + '</span></div>',
      { footer: (full ? '' : '<button type="button" class="tkc-btn" id="calPick">加一张照片</button>')
        + '<button type="button" class="tkc-btn ghost" id="calMakeCardBtn">生成打卡图</button>'
        + '<button type="button" class="tkc-btn ghost" id="calSkip">就这样</button>' });
  }
  function calMarkWent(k) {
    calStore.went[k] = { ts: Date.now(), photos: [] };
    // 写不进去（本机存储满了 / 无痕模式）必须出声，否则站长看到的就是「打了卡，关掉页面就没了」
    if (!LS.set(CAL_LS, calStore)) {
      if (typeof toast === 'function') toast('这台机器存不下了，打卡没记住');
      delete calStore.went[k];
      return;
    }
    calPending = calItems.find((x) => calKey(x) === k) || null;
    calSig = '';
    calRender();
    calPhotoModal(k);
  }
  function calDelPhotoAsk(idx) {
    calDelIdx = Number(idx) || 0;
    modal('删除照片记录', '<div class="tkc-mbody">确定删除这张照片记录吗？<br>'
      + '<span class="tkc-hint">删除后只能重新添加，原图不会保留</span></div>',
      { footer: '<button type="button" class="tkc-btn danger" id="calDelPhotoOk">确定删除</button>'
        + '<button type="button" class="tkc-btn ghost" id="calSkip">取消</button>' });
  }
  function calDelPhoto() {
    const k = calKey(calPending);
    const arr = calPhotos(k).slice();
    arr.splice(calDelIdx, 1);
    calSavePhotos(k, arr);
    closeModal();
    calSig = ''; calRender();
    if (typeof toast === 'function') toast('已删除这张照片记录');
  }
  // 取消「我去了」：打 cancelled 墓碑（保留 key），自动打卡就不会再把它加回来
  function calCancelWentAsk(k) {
    calPending = calItems.find((x) => calKey(x) === k) || null;
    modal('取消打卡', '<div class="tkc-mbody">取消后这场就不再算「我去了」，自动打卡的场次也不会再标记它。<br>'
      + '<span class="tkc-hint">已加的照片记录会一起清掉</span></div>',
      { footer: '<button type="button" class="tkc-btn danger" id="calCancelOk">取消打卡</button>'
        + '<button type="button" class="tkc-btn ghost" id="calSkip">返回</button>' });
  }
  function calCancelWent() {
    const k = calKey(calPending);
    calStore.went[k] = { cancelled: true, photos: [] };
    delete calStore.going[k];
    LS.set(CAL_LS, calStore);
    closeModal();
    calSig = ''; calRender();
    if (typeof toast === 'function') toast('已取消这场的打卡');
  }
  function calPickFile() {
    if (!calFile) {
      calFile = document.createElement('input');
      calFile.type = 'file';
      calFile.accept = 'image/*';
      calFile.multiple = true;            // 一次可多选（张数上限 9）
      calFile.style.display = 'none';
      calFile.addEventListener('change', () => {
        const fs = Array.prototype.slice.call(calFile.files || []);
        calFile.value = '';
        if (!fs.length) return;
        calAddFiles(fs);
      });
      document.body.appendChild(calFile);
    }
    calFile.click();
  }
  // 逐张压成缩略图追加（满 9 张停），原图不落任何存储
  async function calAddFiles(files) {
    const k = calKey(calPending);
    if (!k || !calStore.went[k]) return;
    const arr = calPhotos(k).slice();
    for (let i = 0; i < files.length; i++) {
      if (arr.length >= CAL_MAX_PHOTOS) { if (typeof toast === 'function') toast('最多 ' + CAL_MAX_PHOTOS + ' 张'); break; }
      const dataUrl = await new Promise((ok) => {
        const fr = new FileReader();
        fr.onload = () => ok(String(fr.result || '')); fr.onerror = () => ok('');
        fr.readAsDataURL(files[i]);
      });
      if (!dataUrl) continue;
      const thumb = await calMakeThumb(dataUrl);
      if (thumb) arr.push(thumb);
    }
    calSavePhotos(k, arr);
    calSig = ''; calRender();
    calPhotoModal(k);
  }
  const calLoadImg = (u) => new Promise((ok, no) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = no;
    im.src = u;
  });
  // cover 裁剪：把图铺满格子且不变形（多余部分居中裁掉）
  function calDrawCover(c, img, x, y, w, h) {
    const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
    const ir = iw / ih, br = w / h;
    let sw, sh, sx, sy;
    if (ir > br) { sh = ih; sw = sh * br; sx = (iw - sw) / 2; sy = 0; }
    else { sw = iw; sh = sw / br; sx = 0; sy = (ih - sh) / 2; }
    c.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  }
  // 圆角矩形路径（手写，Safari 老版本没有 ctx.roundRect）
  function calRoundRect(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.lineTo(x + w - rr, y); c.quadraticCurveTo(x + w, y, x + w, y + rr);
    c.lineTo(x + w, y + h - rr); c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    c.lineTo(x + rr, y + h); c.quadraticCurveTo(x, y + h, x, y + h - rr);
    c.lineTo(x, y + rr); c.quadraticCurveTo(x, y, x + rr, y);
    c.closePath();
  }
  // 照片排布：🔴 不管几张都**竖着一张张往下叠**（plog 感觉），不做九宫格拼接。
  // 每张都占满整行宽，高度按各自原图比例，钳在 [220, PH_MAX]；张数越多单张上限略收，免得卡片长得离谱。
  function calGridGeom(imgs, pw) {
    const n = imgs.length;
    if (!n) return { cols: 0, rows: 0, cw: 0, ch: 0, pw: pw, gap: 14, hs: [], h: 240 };
    const gap = 14;
    const PH_MAX = n <= 3 ? 540 : (n <= 6 ? 460 : 400);
    const hs = imgs.map((im) => {
      const r = (im.naturalHeight || 1) / (im.naturalWidth || 1);
      return Math.round(Math.max(220, Math.min(pw * r, PH_MAX)));
    });
    const h = hs.reduce((a, b) => a + b, 0) + gap * (n - 1);
    return { cols: 1, rows: n, cw: pw, ch: hs[0], pw: pw, gap: gap, hs: hs, h: h };
  }
  async function calMakeCard(it, src) {
    closeModal();
    if (!it) return;
    const wk = calKey(it);
    // 传了原图 = 新加一张（追加，满 9 张停）；没传 = 用已存的照片记录重绘
    if (src && calStore.went[wk]) {
      const arr = calPhotos(wk).slice();
      if (arr.length >= CAL_MAX_PHOTOS) {
        if (typeof toast === 'function') toast('最多 ' + CAL_MAX_PHOTOS + ' 张照片');
      } else {
        const thumb = await calMakeThumb(src);
        if (thumb) { arr.push(thumb); calSavePhotos(wk, arr); }
      }
    }
    const imgs = [];
    for (const u of calPhotos(wk)) { try { imgs.push(await calLoadImg(u)); } catch (_) {} }
    const W = 750, pad = 60, cw = W - pad * 2, cTop = 96;
    // 先量标题行数才能定卡片高度
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = '600 34px sans-serif';
    const lines = (typeof wrapText === 'function')
      ? wrapText(meas, it.title || '', cw - 80, 2) : [it.title || ''];
    const g = calGridGeom(imgs, cw - 80);
    const ph = g.h;
    const imgY = cTop + 72;
    const tY = imgY + ph + 62;
    const dY = tY + (lines.length - 1) * 46 + 44;
    const dashY = dY + 36;
    const footY = dashY + 56;
    const cardBot = footY + 44;
    const H = cardBot + 130;

    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = '#fbf7ee'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#fffdf8'; c.fillRect(pad, cTop, cw, cardBot - cTop);
    c.strokeStyle = '#e5dcc8'; c.lineWidth = 2;
    c.strokeRect(pad + 1, cTop + 1, cw - 2, cardBot - cTop - 2);

    c.textAlign = 'left';
    c.fillStyle = calColor(it.kind); c.font = '600 24px sans-serif';
    c.fillText('观演打卡 · ' + (it.kind || '活动'), pad + 40, cTop + 56);

    if (imgs.length) {
      const x = pad + 40, R = 14;
      let y = imgY;
      imgs.forEach((im, i) => {
        const h = g.hs[i];
        // 圆角裁切后 cover 铺满，竖着一张张往下叠
        calRoundRect(c, x, y, g.pw, h, R);
        c.save(); c.clip();
        calDrawCover(c, im, x, y, g.pw, h);
        c.restore();
        c.strokeStyle = '#e5dcc8'; c.lineWidth = 2;
        calRoundRect(c, x, y, g.pw, h, R); c.stroke();
        y += h + g.gap;
      });
      if (imgs.length > 1) {
        c.textAlign = 'right'; c.fillStyle = '#8a97a4'; c.font = '22px sans-serif';
        c.fillText('共 ' + imgs.length + ' 张', pad + 40 + g.pw, imgY - 14);
        c.textAlign = 'left';
      }
    } else {
      c.setLineDash([12, 10]); c.strokeStyle = '#d8cfbb'; c.lineWidth = 3;
      c.strokeRect(pad + 40, imgY, cw - 80, ph);
      c.setLineDash([]);
      c.textAlign = 'center'; c.fillStyle = '#b8ae9a'; c.font = '26px sans-serif';
      c.fillText('照片记录', W / 2, imgY + ph / 2 + 9);
      c.textAlign = 'left';
    }

    c.fillStyle = '#23303c'; c.font = '600 34px sans-serif';
    lines.forEach((t, i) => c.fillText(t, pad + 40, tY + i * 46));
    c.fillStyle = '#7b8794'; c.font = '26px sans-serif';
    c.fillText(it.date.replace(/-/g, '.') + ' ' + (it.weekday || '') + ' ' + calStart(it.time), pad + 40, dY);

    c.strokeStyle = '#d5cbb6'; c.setLineDash([12, 10]); c.lineWidth = 3;
    c.beginPath(); c.moveTo(pad + 40, dashY); c.lineTo(W - pad - 40, dashY); c.stroke();
    c.setLineDash([]);

    const wentKeys = Object.keys(calStore.went).filter(calIsWent)
      .sort((a, b) => (calStore.went[a].ts || 0) - (calStore.went[b].ts || 0));
    const nth = wentKeys.indexOf(calKey(it)) + 1;
    c.fillStyle = '#6b7684'; c.font = '26px sans-serif';
    c.fillText(nth > 0 ? '这是我去的第 ' + nth + ' 场' : '我去了这场', pad + 40, footY);
    c.textAlign = 'right'; c.fillStyle = '#3B7FD0'; c.font = '600 26px sans-serif';
    c.fillText('这场我在', W - pad - 40, footY);

    c.textAlign = 'center';
    c.fillStyle = '#8a97a4'; c.font = '600 23px sans-serif';
    c.fillText('王语晨补档站', W / 2, cardBot + 52);
    c.fillStyle = '#b3bcc4'; c.font = '20px Menlo, monospace';
    c.fillText('idol.wyc0518.cc', W / 2, cardBot + 86);

    let url = '';
    try { url = cv.toDataURL('image/jpeg', 0.92); } catch (_) { url = ''; }
    if (!url || url.length < 2000) { toast('图片生成失败，请重试'); return; }
    if (typeof showAlbumLayer === 'function') showAlbumLayer(url, it.date.replace(/\./g, '').replace(/-/g, ''), '观演打卡');
  }

  /* 倒计时预告卡：没去之前也能分享（图照旧只在本地 Canvas 合成，不上传） */
  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  function calMakeShare(it) {
    if (!it) return;
    const going = !!calStore.going[calKey(it)];
    const ms = calStartMs(it) - Date.now();
    // 完整倒计时放进大字（跨天时「天 + 小时」一起写），下面配固定说明，
    // 避免出现「8 天」配「还有 1 小时」这种看起来只剩 1 小时的歧义
    let big, sub;
    if (ms <= 0) { big = '已开演'; sub = (calDayWord(it.date) || '今天') + ' ' + calStart(it.time); }
    else {
      const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), mi = Math.floor((ms % 3600000) / 60000);
      if (d > 0) big = d + ' 天' + (h > 0 ? ' ' + h + ' 小时' : '');
      else if (h > 0) big = h + ' 小时' + (mi > 0 ? ' ' + mi + ' 分' : '');
      else big = mi + ' 分钟';
      sub = '距离开演';
    }
    const W = 750, pad = 60, cw = W - pad * 2, cTop = 96;
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = '600 34px sans-serif';
    const lines = (typeof wrapText === 'function') ? wrapText(meas, it.title || '', cw - 80, 2) : [it.title || ''];
    const cdY = cTop + 158;        // 倒计时大数字基线（88px，留足与顶部标签的间距）
    const subY = cdY + 52;
    const tagY = subY + 58;        // 「我要去这场」标签基线
    const lineY = tagY + 58;
    const tY = lineY + 58;
    const dY = tY + (lines.length - 1) * 46 + 44;
    const dashY = dY + 36;
    const footY = dashY + 58;
    const cardBot = footY + 30;
    const H = cardBot + 130;

    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = '#fbf7ee'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#fffdf8'; c.fillRect(pad, cTop, cw, cardBot - cTop);
    c.strokeStyle = '#e5dcc8'; c.lineWidth = 2;
    c.strokeRect(pad + 1, cTop + 1, cw - 2, cardBot - cTop - 2);

    c.textAlign = 'center';
    c.fillStyle = calColor(it.kind); c.font = '600 24px sans-serif';
    c.fillText((it.kind || '活动') + ' · 开演倒计时', W / 2, cTop + 56);

    c.fillStyle = '#0C447C';
    let bf = 88;
    c.font = '600 ' + bf + 'px sans-serif';
    while (c.measureText(big).width > cw - 80 && bf > 54) { bf -= 4; c.font = '600 ' + bf + 'px sans-serif'; }
    c.fillText(big, W / 2, cdY);
    c.fillStyle = '#7b8794'; c.font = '28px sans-serif';
    c.fillText(sub, W / 2, subY);

    if (going) {
      const tw = 232, th = 46, tx = W / 2 - tw / 2, ty = tagY - 32;
      c.fillStyle = 'rgba(15,110,86,0.10)';
      roundRect(c, tx, ty, tw, th, 23); c.fill();
      c.fillStyle = '#0F6E56'; c.font = '600 26px sans-serif';
      c.fillText('♥ 我要去这场', W / 2, tagY);
    }

    c.textAlign = 'left';
    c.strokeStyle = '#d5cbb6'; c.setLineDash([12, 10]); c.lineWidth = 3;
    c.beginPath(); c.moveTo(pad + 40, lineY); c.lineTo(W - pad - 40, lineY); c.stroke();
    c.setLineDash([]);

    c.fillStyle = '#23303c'; c.font = '600 34px sans-serif';
    lines.forEach((t, i) => c.fillText(t, pad + 40, tY + i * 46));
    c.fillStyle = '#7b8794'; c.font = '26px sans-serif';
    c.fillText(it.date.replace(/-/g, '.') + ' ' + (it.weekday || '') + ' ' + calStart(it.time), pad + 40, dY);

    c.strokeStyle = '#d5cbb6'; c.setLineDash([12, 10]); c.lineWidth = 3;
    c.beginPath(); c.moveTo(pad + 40, dashY); c.lineTo(W - pad - 40, dashY); c.stroke();
    c.setLineDash([]);

    c.textAlign = 'center';
    c.fillStyle = '#0F6E56'; c.font = '600 27px sans-serif';
    c.fillText(going ? '到时候见 ♥' : '你也想去看吗', W / 2, footY);

    c.textAlign = 'center';
    c.fillStyle = '#8a97a4'; c.font = '600 23px sans-serif';
    c.fillText('王语晨补档站', W / 2, cardBot + 52);
    c.fillStyle = '#b3bcc4'; c.font = '20px Menlo, monospace';
    c.fillText('idol.wyc0518.cc', W / 2, cardBot + 86);

    let url = '';
    try { url = cv.toDataURL('image/jpeg', 0.92); } catch (_) { url = ''; }
    if (!url || url.length < 2000) { toast('图片生成失败，请重试'); return; }
    if (typeof showAlbumLayer === 'function') showAlbumLayer(url, it.date.replace(/\./g, '').replace(/-/g, ''), '行程预告');
  }

  /* ---- 公演档案：两张汇总卡（都只在本机 Canvas 合成，绝不上传） ---- */
  // 她的：本月 / 今年 / 全部 / 认识以后
  //   全部 = 档案里所有已开演的公演（与谁在看无关，**不需要 uid**）
  //   认识以后 = 从我 uid 的认识日起算的她的公演场次（**需要 uid，且跟打不打卡无关**）
  function calSummary() {
    const perfs = calItems.filter((x) => x.kind === '公演' && calDone(x));
    const ym = fmtBJ(new Date()).slice(0, 7), y = ym.slice(0, 4);
    return {
      month: perfs.filter((x) => x.date.slice(0, 7) === ym).length,
      year: perfs.filter((x) => x.date.slice(0, 4) === y).length,
      total: perfs.length,
      // 🔴 副标题的起点**从数据里取**（calItems 已按日期排序 → 第一条就是最早那场），别写死月份：
      //    站长 2026-09-25 指出档案里最早一场是 2022-10-02，不是 2022-11。
      first: perfs.length ? perfs[0].date : '',
      met: calMetDate,
      all: calMetDate ? perfs.filter((x) => x.date >= calMetDate).length : 0
    };
  }
  // 我的：本月 / 今年 / 认识以后（认识以后 = 我打卡的场次里，晚于我 uid 认识日的那部分）
  // 🔴 只从 calItems 反查「认领得到」的打卡，**不直接数 localStorage 的键**：
  //    直接数键会把对不上任何场次的旧记录也计进来 —— 就是站长说的「我取消了，档案卡还是显示 3」。
  function calMine() {
    const ym = fmtBJ(new Date()).slice(0, 7), y = ym.slice(0, 4);
    const its = calItems.filter((x) => calIsWent(calWentKeyOf(x)));
    const dates = its.map((x) => x.date).filter(Boolean).sort();
    const first = dates[0] || '', last = dates[dates.length - 1] || '';
    const firstIt = first ? its.find((x) => x.date === first) : null;
    const lastIt = last ? its.filter((x) => x.date === last).pop() : null;
    return {
      total: dates.length,
      month: dates.filter((d) => d.slice(0, 7) === ym).length,
      year: dates.filter((d) => d.slice(0, 4) === y).length,
      photo: its.reduce((n, x) => n + calPhotos(calWentKeyOf(x)).length, 0),
      firstDate: first ? first.slice(5).replace('-', '/') : '',
      firstTitle: firstIt ? (firstIt.title || '').replace(/[《》]/g, '') : '',
      lastDate: last ? last.slice(5).replace('-', '/') : '',
      lastTitle: lastIt ? (lastIt.title || '').replace(/[《》]/g, '') : ''
    };
  }
  function calOpenArchive() {
    const s = calSummary(), m = calMine();
    // 「认识以后」是她的场次，挂公演汇总；没 uid（不知道认识日）就整档不出现
    const perfMet = s.met ? ' · 认识以后 <b>' + s.all + '</b>' : '';
    const html = '<div class="tkc-arc">'
      + '<div class="tkc-arc-c"><div class="tkc-arc-t">公演汇总</div>'
      + '<div class="tkc-arc-n">本月 <b>' + s.month + '</b> · 今年 <b>' + s.year + '</b> · 全部 <b>' + s.total + '</b>' + perfMet + ' 场</div>'
      + '<button type="button" class="tkc-btn" data-cal-sum="perf">生成汇总卡</button></div>'
      + '<div class="tkc-arc-c"><div class="tkc-arc-t">我的线下打卡</div>'
      + '<div class="tkc-arc-n">本月 <b>' + m.month + '</b> · 今年 <b>' + m.year + '</b> · 历史打卡 <b>' + m.total + '</b> 场</div>'
      + (m.total
        ? '<div class="tkc-arc-s">第一场 ' + m.firstDate + (m.firstTitle ? '《' + m.firstTitle + '》' : '') + '</div>'
        : '<div class="tkc-arc-s">还没标记「我去了」</div>')
      + '<button type="button" class="tkc-btn" data-cal-sum="mine">生成打卡卡</button></div>'
      + '</div>';
    modal('公演档案', html, { wide: true, footer: '' });
  }
  // 卡片骨架：米色底 + 一块内框（boxTop / boxH 显式给定，由调用方按内容实高算出，保证字都落在框内）+ 底部页脚
  function calCardBase(W, H, boxTop, boxH) {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    const pad = 54, cw = W - pad * 2;
    c.fillStyle = '#fbf7ee'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#fffdf8'; c.fillRect(pad, boxTop, cw, boxH);
    c.strokeStyle = '#e5dcc8'; c.lineWidth = 2;
    c.strokeRect(pad + 1, boxTop + 1, cw - 2, boxH - 2);
    return { c: c, pad: pad, cw: cw, boxTop: boxTop, boxH: boxH, boxBot: boxTop + boxH, W: W, H: H };
  }
  function calCardFoot(c, W, H) {
    c.textAlign = 'center';
    c.fillStyle = '#8a97a4'; c.font = '600 23px sans-serif';
    c.fillText('王语晨补档站', W / 2, H - 64);
    c.fillStyle = '#b3bcc4'; c.font = '20px Menlo, monospace';
    c.fillText('idol.wyc0518.cc', W / 2, H - 32);
  }
  // 数字 + 单位同一行居中（单位小一号、基线对齐）——避免「3」「场」上下分家
  function calNumUnit(c, cx, yBase, n, unit, numFont, numColor, unitFont) {
    const s = String(n);
    c.font = numFont; const nw = c.measureText(s).width;
    c.font = unitFont; const uw = c.measureText(unit).width;
    const gap = 9, x0 = cx - (nw + gap + uw) / 2;
    c.textAlign = 'left';
    c.font = numFont; c.fillStyle = numColor; c.fillText(s, x0, yBase);
    c.font = unitFont; c.fillStyle = '#8a97a4'; c.fillText(unit, x0 + nw + gap, yBase);
    c.textAlign = 'center';
  }
  // 一行文字按可用宽度自适应：先逐档缩字号，仍放不下再截断加省略号（防跑出内框）
  function calFitLine(c, text, x, y, maxW, fonts, color) {
    c.textAlign = 'left'; c.fillStyle = color;
    for (let i = 0; i < fonts.length; i++) {
      c.font = fonts[i];
      if (c.measureText(text).width <= maxW) { c.fillText(text, x, y); return; }
    }
    c.font = fonts[fonts.length - 1];
    let t = text;
    while (t.length > 1 && c.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    c.fillText(t + '…', x, y);
  }
  function calMakeSummary() {
    closeModal();
    const s = calSummary();
    const W = 750, boxTop = 96, rowH = 146, rowsStart = boxTop + 124;
    const rows = [
      { l: '本月', n: s.month, sub: fmtBJ(new Date()).slice(0, 7).replace('-', '.') },
      { l: '今年', n: s.year, sub: fmtBJ(new Date()).slice(0, 4) + ' 年' },
      { l: '全部', n: s.total, sub: s.first ? s.first.slice(0, 7).replace('-', '.') + ' 起' : '有记录以来' }
    ];
    // 认识日来自「我的档案」里的 uid：有就多一档（她的场次，跟打不打卡无关），没有就整档不出现
    if (s.met) rows.push({ l: '认识以后', n: s.all, sub: s.met.slice(0, 7).replace('-', '.') + ' 起' });
    // 内框高按内容实高算：最后一行副标题 + 底部留白，保证不溢出
    const contentBot = rowsStart + (rows.length - 1) * rowH + 112;
    const boxH = (contentBot - boxTop) + 56;
    const H = boxTop + boxH + 132;
    const o = calCardBase(W, H, boxTop, boxH); const c = o.c;
    c.textAlign = 'center';
    c.fillStyle = '#0C447C'; c.font = '600 30px sans-serif';
    c.fillText('王语晨 · 公演汇总', W / 2, boxTop + 62);
    rows.forEach((r, i) => {
      const y = rowsStart + i * rowH;
      c.fillStyle = '#7b8794'; c.font = '600 25px sans-serif'; c.fillText(r.l, W / 2, y);
      calNumUnit(c, W / 2, y + 76, r.n, '场', '600 70px sans-serif', '#185FA5', '24px sans-serif');
      c.textAlign = 'center'; c.fillStyle = '#8a97a4'; c.font = '21px sans-serif'; c.fillText(r.sub, W / 2, y + 112);
    });
    calCardFoot(c, W, H);
    let url = ''; try { url = cv_to(c); } catch (_) { url = ''; }
    if (!url || url.length < 2000) { toast('图片生成失败，请重试'); return; }
    if (typeof showAlbumLayer === 'function') showAlbumLayer(url, 'perf-summary', '公演汇总');
  }
  function calMakeMine() {
    closeModal();
    const m = calMine();
    const W = 750, boxTop = 96, rowH = 124, rowsStart = boxTop + 128;
    const rows = [
      { l: '本月', n: m.month },
      { l: '今年', n: m.year },
      { l: '历史打卡', n: m.total }        // 我打卡过的全部场次，跟 uid 无关，不需要查档案
    ];
    const rowsBot = rowsStart + (rows.length - 1) * rowH + 92;
    const footTop = rowsBot + 44;
    // 内框高按内容实高算：有打卡 → 第一场/最近一场（+ 可选照片行）；没打卡 → 两行空状态
    const contentBot = m.total ? (footTop + (m.photo ? 72 : 34) + 10) : (footTop + 44);
    const boxH = (contentBot - boxTop) + 56;
    const H = boxTop + boxH + 132;
    const o = calCardBase(W, H, boxTop, boxH); const c = o.c;
    c.textAlign = 'center';
    c.fillStyle = '#0F6E56'; c.font = '600 30px sans-serif'; c.fillText('我的公演档案', W / 2, boxTop + 60);
    rows.forEach((r, i) => {
      const y = rowsStart + i * rowH;
      c.textAlign = 'center'; c.fillStyle = '#7b8794'; c.font = '600 25px sans-serif'; c.fillText(r.l, W / 2, y);
      calNumUnit(c, W / 2, y + 68, r.n, '场', '600 62px sans-serif', '#0F6E56', '24px sans-serif');
    });
    if (m.total) {
      // 剧目名可能很长 → 整块统一缩字号（保证几行字号一致），仍放不下才截断，绝不跑出内框
      const maxW = o.cw - 88;
      const fs = ['23px sans-serif', '21px sans-serif', '19px sans-serif', '17px sans-serif'];
      const lines = [
        '第一场：' + m.firstDate + (m.firstTitle ? ' 《' + m.firstTitle + '》' : ''),
        '最近一场：' + m.lastDate + (m.lastTitle ? ' 《' + m.lastTitle + '》' : '')
      ];
      if (m.photo) lines.push('共留了 ' + m.photo + ' 张照片记录');
      let pick = fs[fs.length - 1];
      for (let i = 0; i < fs.length; i++) {
        c.font = fs[i];
        if (lines.every((t) => c.measureText(t).width <= maxW)) { pick = fs[i]; break; }
      }
      lines.forEach((t, i) => calFitLine(c, t, o.pad + 44, footTop + i * 38, maxW, [pick], i === 2 ? '#3B7FD0' : '#6b7684'));
    } else {
      c.textAlign = 'center'; c.fillStyle = '#b8ae9a'; c.font = '24px sans-serif';
      c.fillText('还没标记「我去了」', W / 2, footTop);
      c.fillText('去日历里点一场，记录你的陪伴', W / 2, footTop + 42);
    }
    calCardFoot(c, W, H);
    let url = ''; try { url = cv_to(c); } catch (_) { url = ''; }
    if (!url || url.length < 2000) { toast('图片生成失败，请重试'); return; }
    if (typeof showAlbumLayer === 'function') showAlbumLayer(url, 'mine-archive', '我的公演档案');
  }
  // 小工具：canvas → jpeg dataURL（统一 JPEG，手机预览/分享更快）
  function cv_to(c) { return c.canvas.toDataURL('image/jpeg', 0.92); }

  /* 注入到行程页顶部（app.js 会重渲这个 pane，靠 MutationObserver 反复补） */
  function injectCalendar() {
    const pane = $('#panel-schedule');
    if (!pane || !$('.sc-wrap', pane)) return;
    let box = $('#calBox', pane);
    if (!box) {
      if (!calItems.length) { calItems = calLoad(); calReindex(); }
      if (!calItems.length) return;
      const n = calNext();
      const today = fmtBJ(new Date());
      // 记住上次看的月份：不然每次打开都跳回「下一场」那个月，翻去上个月打的卡就看不见了
      if (!calMonth) {
        let saved = '';
        try { saved = localStorage.getItem(CAL_MONTH_KEY) || ''; } catch (_) {}
        calMonth = /^\d{4}-\d{2}$/.test(saved) ? saved : (n ? n.it.date : today).slice(0, 7);
      }
      if (!calSel) calSel = n ? n.it.date : today;
      box = document.createElement('div');
      box.id = 'calBox';
      pane.insertBefore(box, pane.firstChild);
      calSig = '';
    }
    // DATA.performances 可能晚于首次注入到达 → 等到有了且还没并过，就重算一次日历
    if (typeof DATA !== 'undefined' && DATA && DATA.performances && DATA.performances.length) {
      const hasArch = calItems.some((x) => x.src === 'archive');
      if (!hasArch) { calItems = calLoad(); calReindex(); calSig = ''; }
    }
    calSyncGoing();   // 「我要去」过了开演 → 自动变「我去了」
    calFetchMet();    // 「认识以后」起点（有 uid 才有；uid 清掉这一档就消失）
    const sig = calSigNow();
    if (sig !== calSig) { calSig = sig; calRender(); }
    calFetch();
    if (!calTick) calTick = setInterval(() => {
      const el = $('#calCount');
      if (el) el.textContent = calCountText();
    }, 60000);
  }

  document.addEventListener('click', (e) => {
    const day = e.target.closest('[data-cal-day]');
    if (day) { calSel = day.dataset.calDay; calSig = ''; calRender(); return; }
    const go = e.target.closest('[data-cal-go]');
    if (go) {
      const k = go.dataset.calGo;
      if (calStore.going[k]) delete calStore.going[k]; else calStore.going[k] = 1;
      LS.set(CAL_LS, calStore); calSig = ''; calRender(); return;
    }
    const went = e.target.closest('[data-cal-went]');
    if (went) { calMarkWent(went.dataset.calWent); return; }
    const photo = e.target.closest('[data-cal-photo]');
    if (photo) { calPhotoModal(photo.dataset.calPhoto); return; }
    const delidx = e.target.closest('[data-cal-delidx]');
    if (delidx) { calDelPhotoAsk(delidx.dataset.calDelidx); return; }
    const cancelWent = e.target.closest('[data-cal-cancel]');
    if (cancelWent) { calCancelWentAsk(cancelWent.dataset.calCancel); return; }
    const share = e.target.closest('[data-cal-share]');
    if (share) {
      const it = calItems.find((x) => calKey(x) === share.dataset.calShare);
      if (it) calMakeShare(it);
      return;
    }
    if (e.target.closest('#calShareNext')) { const n = calNext(); if (n) calMakeShare(n.it); return; }
    const card = e.target.closest('[data-cal-card]');
    if (card) {
      const it = calItems.find((x) => calKey(x) === card.dataset.calCard);
      if (it) calMakeCard(it, '');
      return;
    }
    if (e.target.closest('#calPrev')) { calGotoMonth(-1); return; }
    if (e.target.closest('#calNext')) { calGotoMonth(1); return; }
    if (e.target.closest('#calPick')) { calPickFile(); return; }
    if (e.target.closest('#calDelPhotoOk')) { calDelPhoto(); return; }
    if (e.target.closest('#calMakeCardBtn')) { if (calPending) calMakeCard(calPending, ''); return; }
    if (e.target.closest('#calCancelOk')) { calCancelWent(); return; }
    if (e.target.closest('#calSkip')) { closeModal(); return; }
    if (e.target.closest('#calArc')) { calOpenArchive(); return; }
    const sum = e.target.closest('[data-cal-sum]');
    if (sum) {
      const t = sum.dataset.calSum;
      if (t === 'perf') calMakeSummary();
      else if (t === 'mine') calMakeMine();
      return;
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t && (t.id === 'calYearSel' || t.id === 'calMonthSel')) {
      const sel = document.getElementById('calYearSel'), mos = document.getElementById('calMonthSel');
      if (!sel || !mos) return;
      const ny = Number(sel.value), nm = Number(mos.value);
      calMonth = ny + '-' + p2(nm);
      const first = calItems.filter((x) => x.date.slice(0, 7) === calMonth).map((x) => x.date)[0];
      if (calSel.slice(0, 7) !== calMonth) calSel = first || (calMonth + '-01');
      calSig = ''; calRender();
    }
  });

  function boot() {
    injectToolbar();
    injectCalendar();
    injectChips();
    buildHisDropdown();
    injectBlindBox();
    syncChipsTab();

    // DOM 变化 → 轻度重装饰（带防抖；已处理过的元素会跳过）
    let t = null;
    const obs = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { decorate(); syncChipsTab(); injectCalendar(); }, 120);
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // 搜索 / 筛选变化 → 重新高亮
    const si = $('#searchInput');
    if (si) si.addEventListener('input', () => setTimeout(() => { decorate(); }, 200));

    $('#dmCatchup').addEventListener('click', openCatchup);

    // 入坑清单 + 补档：都用事件委托（内容会重渲，挂 document 最稳）
    document.addEventListener('click', (e) => {
      // 入坑清单：勾选已看
      const chk = e.target.closest('[data-st-check]');
      if (chk) {
        const i = Number(chk.dataset.stCheck);
        const it = starterItems()[i]; const k = stKey(it);
        if (!k) return;
        if (startDone[k]) delete startDone[k]; else startDone[k] = true;
        saveStart();
        if (typeof renderGuideSub === 'function' && (typeof state !== 'undefined') && state.guideSub === 'starter') renderGuideSub();
        else if (typeof renderGuide === 'function' && (typeof state !== 'undefined') && state.tab === 'guide') renderGuideSub();
        return;
      }
      // 入坑清单：她的个人 cut（B 站合集）
      const cutBtn = e.target.closest('[data-st-cut]');
      if (cutBtn) {
        const x = starterItems()[Number(cutBtn.dataset.stCut)];
        const c = x && cutOf(x);
        if (c) { window.open('https://www.bilibili.com/video/' + c[2], '_blank', 'noopener'); toast('已打开她的个人 cut'); }
        return;
      }
      // 入坑清单：跳转
      const go = e.target.closest('[data-st-go]');
      if (go && !go.disabled) {
        const items = starterItems();
        const x = items[Number(go.dataset.stGo)];
        if (x) starterAction(x);
        return;
      }
      // 补档：点某个月 → 从该月第一天开始
      const mon = e.target.closest('[data-cu-month]');
      if (mon && mon.dataset.cuMonth) {
        const ym = mon.dataset.cuMonth;
        monthMsgs(ym).then((arr) => {
          const ds = [...new Set(arr.map((m) => bjDate(m.msgTime)))].sort();
          if (ds.length) openDayReader(ds[0]);
          else toast(ym + ' 没有发言');
        });
        return;
      }
      // 补档：继续 / 跳到指定天
      const res = e.target.closest('[data-cu-resume]');
      if (res && res.dataset.cuResume) { openDayReader(res.dataset.cuResume); return; }
      const dy = e.target.closest('[data-cu-day]');
      if (dy && dy.dataset.cuDay && !dy.disabled) { openDayReader(dy.dataset.cuDay); return; }
      const fin = e.target.closest('[data-cu-fin]');
      if (fin && fin.dataset.cuFin) { finishDay(fin.dataset.cuFin); return; }
    });

    // 切换 tab → 类型筛选 chips 仅在发言页出现
    document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', syncChipsTab));

    // 「进来自动定位」功能已移除：不再监听滚动存位置、不再 restoreView()
    try { localStorage.removeItem('wyc-demo-view-v1'); } catch (e) { /* 忽略 */ }

    decorate();
    console.log('[demo] 演示功能已就绪：收藏+收藏码 · 搜索类型筛选 · 去年今日 · 多选分享 · 热力图 · 开播提醒');
  }

  /* =====================================================================
     功能 ⑪ 生写小卡图鉴：17 张实物照片识别归组的 14 个系列 / 48 款卡面
     （数据来自 2026-09-24 实物归档，photos/ 5.5MB 随 demo 部署）
     ===================================================================== */
  const CARD_DIR = './cards/photos/';
  const CARD_SERIES = [
    { n: 'SNH48 花蝴蝶内封', c: '主题生写', p: '04_新的序章幻境-白纱裙.jpg', k: 2,
      d: '白色蕾丝纱裙 + 蓝色蝴蝶结发饰、木栅栏秋千背景；卡面左下手写体「王语晨」，竖排「花蝴蝶」。' },
    { n: 'SNH48 2024总选生写', c: '主题生写', p: '06_新的序章幻境-No27.jpg', k: 4,
      d: '蓝色格纹外套 + 白色内搭、马尾造型；左侧竖排「No.27 新的序章 幻境」，2024 年度青春盛典第 27 名。' },
    { n: 'SNH48 2024 青春盛典场限', c: '主题生写', p: '07_新的序章幻境-紫纱裙.jpg', k: 4,
      d: '淡紫色纱质荷叶边上衣；卡面左侧竖排「GNZ48 新的序章 幻境」。' },
    { n: 'GNZ48 2023 年秋季生写', c: '季度生写', p: '13_2023年秋季生写.jpg', k: 4,
      d: '白衬衫 + 黑蝴蝶结 + 珍珠发夹，粉樱背景。' },
    { n: 'GNZ48 2023 年冬季生写', c: '季度生写', p: '11_2023年冬季生写.jpg', k: 4,
      d: '护士装（白红制服 + 十字护士帽），手持红笔、持熊款。' },
    { n: 'GNZ48 2024 年春季生写', c: '季度生写', p: '10_2024年春季生写.jpg', k: 4,
      d: '国风造型（白衣 + 云纹长裙 + 团扇/书卷），松石与古风置景。' },
    { n: 'GNZ48 2024 年秋季生写', c: '季度生写', p: '05_2024年秋季生写.jpg', k: 4,
      d: '蓝黑格纹打歌服 + 白色蕾丝，缀满银色珠串与塑料球的悬浮置景。' },
    { n: 'GNZ48 七周年纪念生写', c: '纪念生写', p: '15_七周年纪念生写.jpg', k: 4,
      d: '白色婚纱礼服 + 金色玫瑰捧花、金色大厅背景。TEAM NIII。' },
    { n: '2023 年总选场限生写', c: '活动／企划', p: '14_2023年总选场限生写.jpg', k: 4,
      d: '黑裙黑帽复古款 + 水手服款；金色徽章「青春十载 / 星光闪耀」= SNH48 GROUP 十周年 2023 年度青春盛典现场限定。' },
    { n: 'GNZ48《天枢之弈》', c: '主题生写', p: '08_主题生写-废土风.jpg', k: 4,
      d: '棕色皮革短裙 + 圆形护目镜 + 白色光剑，棕金科幻置景。Team NIII 北京巡演生写。' },
    { n: '「因为你」', c: '主题生写', p: '09_因为你.jpg', k: 2,
      d: '黑白制服 + 双马尾蝴蝶结，粉教室 / 蓝色场景，手持粉色复古电话。' },
    { n: '偶像运动会（SNH48 GROUP）', c: '活动／企划', p: '12_偶像运动会.jpg', k: 4,
      d: '卡其色运动卫衣 / 棒球帽 + 滑板，青绿储物柜背景。' },
    { n: 'SNH48 十周年《重逢的世界》', c: '活动／企划', p: '16_INTO_THE_WORLD.jpg', k: 2,
      d: '蓝色牛仔套装 + 白衬衫，红木桌球室置景。INTO THE WORLD 内封生写。' },
    { n: 'GNZ48《左右为男》', c: '活动／企划', p: '17_左右系列-待确认.jpg', k: 2,
      d: '天蓝印花衬衫 + 阔腿牛仔裤，暗红背景。男装公演特殊生写，1 set 2 张。' },
    { n: '散卡合集 A', c: '散卡合影', p: '01_散卡合集A-桌面平铺.jpg', k: 15,
      d: '15 张摊开的散卡：白纱裙 / 蝴蝶结 / 水手服 / 女仆装等，末排为手写签名款。' },
    { n: '散卡合集 B', c: '散卡合影', p: '02_散卡合集B-签名款.jpg', k: 9,
      d: '9 张散卡特写：黑裙银饰签名款、白裙花环款、宝丽来白框小卡、黑西装红领带款等。' },
    { n: '全部收藏', c: '散卡合影', p: '03_全部收藏-整版俯瞰.jpg', k: 40,
      d: '4 行 × 10 列全部收藏合影，横跨各季度 / 主题 / 纪念系列，可作「集齐度」总览对照。' }
  ];
  const CARD_CATS = ['季度生写', '纪念生写', '主题生写', '活动／企划', '散卡合影'];
  const CARD_TAGC = { '季度生写': '#3b82f6', '纪念生写': '#f59e0b', '主题生写': '#8b5cf6', '活动／企划': '#10b981', '散卡合影': '#64748b' };

  window.renderCards = function () {
    let cat = 'all';
    try { cat = LS.get('wyc-demo-cardcat', 'all'); } catch (e) { /* 忽略 */ }
    const chips = ['all'].concat(CARD_CATS).map((c) =>
      `<button class="card-chip${cat === c ? ' active' : ''}" data-cardf="${esc(c)}">${c === 'all' ? '全部' : esc(c)}</button>`).join('');
    const list = CARD_SERIES.filter((s) => cat === 'all' || s.c === cat);
    const grid = list.map((s) => `
      <article class="cardx">
        <div class="cardx-thumb" data-card-img="${esc(CARD_DIR + s.p)}" data-card-name="${esc(s.n)}">
          <img src="${esc(CARD_DIR + s.p)}" loading="lazy" alt="${esc(s.n)}"
               onload="if(this.naturalHeight>this.naturalWidth)this.parentElement.classList.add('tall')">
          <span class="cardx-cnt">${s.k} 款</span>
        </div>
        <div class="cardx-body">
          <div class="cardx-name">${esc(s.n)}</div>
          <span class="cardx-tag" style="color:${CARD_TAGC[s.c]};background:${CARD_TAGC[s.c]}1a">${esc(s.c)}</span>
        </div>
      </article>`).join('');
    return `<section class="profile-block">
      <div class="st-h1">生写小卡图鉴</div>
      <div class="cardx-chips">${chips}</div>
      <div class="cardx-grid">${grid}</div>
    </section>`;
  };

  // 生写小卡：筛选 + 放大（事件委托，guideSub 内容会重渲）
  // ⚠️ cards:open 必须挂捕获阶段：app.js 的容器委托会对子标签点击 stopPropagation，
  //    冒泡到不了 document（cards:zoom 不受影响，因为卡片点击没被拦）。
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-sub="cards"]')) trk('cards:open');  // 只在真点子标签时记，筛选重渲不记
  }, true);
  document.addEventListener('click', (e) => {
    const f = e.target.closest('[data-cardf]');
    if (f) {
      LS.set('wyc-demo-cardcat', f.dataset.cardf);
      if (typeof state !== 'undefined' && state.guideSub === 'cards' && typeof renderGuideSub === 'function') renderGuideSub();
      return;
    }
    const im = e.target.closest('[data-card-img]');
    if (im) {
      trk('cards:zoom');
      const src = im.dataset.cardImg, name = im.dataset.cardName || '生写小卡';
      const w = modal(name, `
        <div class="cv-stage" id="cvStage"><img id="cvImg" src="${esc(src)}" alt="${esc(name)}"></div>
        <div class="cv-bar">
          <button class="cv-btn" id="cvRot" type="button">⟳ 旋转</button>
          <button class="cv-btn" id="cvSave" type="button">⬇ 保存图片</button>
        </div>`, { wide: true });
      const img = $('#cvImg', w), stage = $('#cvStage', w);
      let rot = 0;
      $('#cvRot', w).addEventListener('click', () => {
        rot = (rot + 90) % 360;
        img.style.transform = `rotate(${rot}deg)`;
        if (rot % 180) {   // 90/270：布局宽高互换才能不溢出
          img.style.maxWidth = stage.clientHeight + 'px';
          img.style.maxHeight = stage.clientWidth + 'px';
        } else {
          img.style.maxWidth = '100%';
          img.style.maxHeight = '';
        }
      });
      $('#cvSave', w).addEventListener('click', async () => {
        const btn = $('#cvSave', w);
        try {
          btn.disabled = true; btn.textContent = '…';
          const r = await fetch(src, { cache: 'force-cache' });
          const b = await r.blob();
          const ext = (src.match(/\.(\w+)(\?|$)/) || [, 'jpg'])[1];
          const fname = name.replace(/[\\/:*?"<>|]/g, '_') + '.' + ext;
          const file = new File([b], fname, { type: b.type || 'image/jpeg' });
          const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
            || (navigator.userAgentData && navigator.userAgentData.mobile);
          if (isMobile && navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: name });  // 手机走系统保存/分享
            trk('cards:save');
          } else {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(b); a.download = fname;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            trk('cards:save');
          }
        } catch (err) {
          if (!(err && err.name === 'AbortError')) window.open(src, '_blank');  // 兜底：新窗打开长按存
        } finally {
          btn.disabled = false; btn.textContent = '⬇ 保存图片';
        }
      });
    }
  });

  /* ═══ 功能 ⑫ 陪伴纪念票根（真数据版） ═══
     数据链路：scripts/build-ticket.mjs 把房间发言全文 + 房间/直播鸡腿按 uid×日期
     聚合进 KV tk/<uid末两位>；worker /api/mineDay 凭 uid+日期回「你自己那天」。
     与 /api/mine 同一隐私口径：uid 即凭证，只回本人那一份。 */
  function tkHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function tkFmt(d) { return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0'); }
  const tkCur = (() => { const t = new Date(); return new Date(t.getFullYear() - 1, t.getMonth(), t.getDate()); })();
  let tkHideLeg = LS.get('wyc-tk-hideleg') === '1';   /* 分享图里不显示鸡腿（默认显示） */
  window._tkCfg = null;                                /* 档案页传入的 uid + 真实起止（start/days） */
  const TK_DAY = new Map();                            /* 'YYYY-MM-DD' -> {n,dk,ms} | null（查过，没来） */
  let tkSeq = 0;                                       /* 竞态令牌：快速翻页时只让最后一次落版 */
  let tktOpenedUid = null;                             /* 埋点防重：同一 uid 这次进站只记一次 tkt:open */
  const TK_API = (typeof API_BASE !== 'undefined' ? API_BASE : location.origin) + '/api/mineDay';

  function tkRerender() {
    const slot = document.getElementById('tkSlot');
    if (slot) slot.outerHTML = window.renderTicket(window._tkCfg);
    else if (typeof renderGuideSub === 'function') renderGuideSub();
  }
  window.tkShift = function (n) { tkCur.setDate(tkCur.getDate() + n); tkRerender(); };
  window.tkLastYear = function () { const t = new Date(); tkCur.setFullYear(t.getFullYear() - 1); tkCur.setMonth(t.getMonth()); tkCur.setDate(t.getDate()); tkRerender(); };

  async function tkFetch(key) {
    const iso = key.replace(/\./g, '-');
    if (TK_DAY.has(iso)) return TK_DAY.get(iso);
    const seq = ++tkSeq;
    let row = null;
    try {
      const r = await fetch(TK_API, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uid: window._tkCfg && window._tkCfg.uid, date: iso }),
      });
      const d = await r.json();
      row = (d && d.found) ? { n: d.n, dk: d.dk, ms: d.ms || [] } : null;
    } catch (_) { row = null; }
    TK_DAY.set(iso, row);
    if (seq === tkSeq) tkRerender();     // 数据回来后整块重渲（只影响票根区）
    return row;
  }

  /* 那年今天 · 你说的话：全部真实发言（服务端已按时间升序、单条截断 120 字） */
  function tkMsgList(row, iso, start) {
    const head = '<div class="tkmsgs-h">那年今天 · 你说的话</div>';
    if (row === undefined) {
      return `<div class="tkmsgs"><div class="tkmsgs-h">那年今天 · 你说的话</div>
        <div class="tkmsgs-empty">正在翻那天的记录…</div></div>`;
    }
    if (!row || !row.ms) {
      const notyet = start && iso < start;
      return `<div class="tkmsgs">${head}
        <div class="tkmsgs-empty">${notyet ? '那天你还没来到她的房间。<br>往后翻翻，故事就要开始了。' : '那天你没有留言。<br>别遗憾，点「前一天」看看别的日子也好。'}</div></div>`;
    }
    return `<div class="tkmsgs"><div class="tkmsgs-h">那年今天 · 你说的 ${row.n} 句话</div>`
      + row.ms.map(([t, x]) => {
        const d = new Date(Number(t) + 8 * 3600e3);
        const tm = d.toISOString().slice(11, 16);
        return `<div class="tkmsg"><span class="tm">${tm}</span><span class="tx">${esc(x)}</span></div>`;
      }).join('') + `</div>`;
  }

  window.renderTicket = function (cfg) {
    if (cfg && cfg.uid !== (window._tkCfg && window._tkCfg.uid)) TK_DAY.clear();  // 换了 uid，缓存作废
    window._tkCfg = cfg || window._tkCfg || null;
    const uid = window._tkCfg && window._tkCfg.uid;
    /* 埋点：只看「有多少人用」，不带任何日期/uid 信息。
       renderTicket 翻页时会重跑，所以同一 uid 这次进站只记一次。 */
    if (uid && tktOpenedUid !== uid) { tktOpenedUid = uid; trk('tkt:open'); }
    const start = (window._tkCfg && window._tkCfg.start) || '2022.11.07';
    const startIso = start.replace(/\./g, '-');
    const days = (window._tkCfg && window._tkCfg.days) || Math.floor((Date.now() - new Date(2022, 10, 7)) / 86400000) + 1;
    const key = tkFmt(tkCur), iso = key.replace(/\./g, '-');
    const row = TK_DAY.get(iso);                        // undefined=没查过  null=查过（没来）
    const h = tkHash(key + '|' + (uid || 'demo'));
    const ms = (row && row.ms) || [];
    const msgs = row ? row.n : null;                    // null → 加载中
    const leg = row ? row.dk : 0;
    const wk = '日一二三四五六'[tkCur.getDay()];
    const quote = ms.length ? ms[0][1] : (row ? '没关系，第二天你回来就好。' : '');
    const line = row === undefined
      ? `正在翻那天的记录…`
      : (msgs > 0
        ? `你那天在她的房间<br>留下了 <b>${msgs}</b> 句话`
        : (iso < startIso ? `那天你还没来到她的房间` : `那天你没来留言<br>但她一直在房间里发光`));
    /* 这一行只在「那天送了鸡腿」且没开隐私开关时出现，其余情况整行不显示 */
    const meta = (leg > 0 && !tkHideLeg)
      ? `<span>来过房间</span><i></i><span>送出 <b>${leg}</b> 个鸡腿</span>`
      : '';
    /* 存根小条形图：直接用当天真实发言的小时分布 */
    const hh = new Array(24).fill(0);
    ms.forEach(([t]) => { hh[Number(new Date(Number(t) + 8 * 3600e3).toISOString().slice(11, 13))]++; });
    const mh = Math.max(1, ...hh);
    let bars = '';
    for (let i = 0; i < 24; i++) bars += `<i style="width:3px;height:${ms.length ? Math.max(8, Math.round(hh[i] / mh * 100)) : 30 + (tkHash(key + i) % 30)}%"></i>`;
    if (row === undefined) tkFetch(key);
    return `
    <div class="tkwrap" id="tkSlot">
      <div class="tkt" id="tkt">
        <div class="tkt-main">
          <div class="tkt-head"><span class="tkt-brand">陪伴纪念票根</span><span class="tkt-no">NO.${key.replace(/\./g, '')}-${h % 900 + 100}</span></div>
          <div class="tkt-date"><div class="lab">去 年 今 日</div><div class="val">${key}</div><div class="sub">星期${wk} · 一年前的今天</div></div>
          <div class="tkt-line">${line}</div>
          ${quote ? `<div class="tkt-quote"><p>${esc(quote)}</p><span>—— 你当时说的话</span></div>` : ''}
          ${meta ? `<div class="tkt-meta">${meta}</div>` : ''}
        </div>
        <div class="tkt-perf"></div>
        <div class="tkt-stub">
          <div class="tkt-stubinfo"><b>一只鱼鱼</b><br>始发 ${start} · 已陪伴 ${days} 天</div>
          <div class="tkt-bars">${bars}</div>
        </div>
      </div>
      <div class="tkt-ctrl">
        <div class="tkt-row">
          <button class="tkt-btn" data-tk="prev">‹ 前一天</button>
          <button class="tkt-btn" data-tk="lastyear">去年今日</button>
          <button class="tkt-btn" data-tk="next">后一天 ›</button>
        </div>
        <div class="tkt-row"><button class="tkt-btn tkt-primary" id="tkSave">⬇ 保存 / 分享图片</button></div>
        <div class="tkt-row"><button class="tkt-btn tkt-priv" id="tkPriv">${tkHideLeg ? '🫥 图里显示鸡腿：关' : '🫥 图里显示鸡腿：开'}</button></div>
        <p class="tkt-hint">来自你自己的口袋房间发言与鸡腿记录，<br>只有查到你的 uid 才能看到。</p>
      </div>
      ${tkMsgList(row, iso, startIso)}
    </div>`;
  };

  function tkSaveImage() {
    const W = 750;
    const $id = (id) => document.getElementById(id);
    const tkt = $id('tkt');
    if (!tkt) return;
    const el = (sel) => tkt.querySelector(sel);
    /* 先把内容取出来：票根高度按内容自适应，那天没留言/没鸡腿就不留大片空白 */
    const noTxt = el('.tkt-no').textContent;
    const dateVal = el('.tkt-date .val').textContent;
    const subTxt = el('.tkt-date .sub').textContent;
    const lineArr = el('.tkt-line').innerText.split('\n');
    const qEl = el('.tkt-quote p');
    const qTxt = qEl ? qEl.textContent.trim() : '';
    const mEl = el('.tkt-meta');
    const metaTxt = mEl ? mEl.innerText.replace(/\n/g, ' ').trim() : '';
    const stubTxt = el('.tkt-stubinfo').innerText.split('\n')[1] || '';

    let cur = 435 + (lineArr.length - 1) * 46;        // 正文最后一行
    const quoteTop = qTxt ? cur + 54 : 0;
    if (qTxt) cur = quoteTop + 150;                   // 引文框高 150
    const metaY = metaTxt ? cur + 90 : 0;
    if (metaTxt) cur = metaY;
    const dashY = cur + (metaTxt ? 60 : 90);          // 撕票虚线
    const cardTop = 70, cardBot = dashY + 175;
    const H = cardBot + 130;

    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = '#eef3f7'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#fbf7ee';
    c.beginPath(); c.moveTo(71, cardTop); c.arcTo(705, cardTop, 705, cardBot, 26); c.arcTo(705, cardBot, 45, cardBot, 26); c.arcTo(45, cardBot, 45, cardTop, 26); c.arcTo(45, cardTop, 705, cardTop, 26); c.closePath(); c.fill();
    c.textAlign = 'left'; c.fillStyle = '#8a97a4'; c.font = '600 24px sans-serif';
    c.fillText('陪 伴 纪 念 票 根', 90, 138);
    c.textAlign = 'right'; c.fillStyle = '#b3bcc4'; c.font = '20px Menlo, monospace';
    c.fillText(noTxt, 660, 136);
    c.textAlign = 'center';
    c.fillStyle = '#8a97a4'; c.font = '22px sans-serif'; c.fillText('去 年 今 日', 375, 205);
    c.fillStyle = '#17364f'; c.font = '700 92px sans-serif'; c.fillText(dateVal, 375, 305);
    c.fillStyle = '#9aa6b1'; c.font = '24px sans-serif'; c.fillText(subTxt, 375, 350);
    c.fillStyle = '#2c4a63'; c.font = '30px sans-serif';
    lineArr.forEach((t, i) => c.fillText(t, 375, 435 + i * 46));
    if (qTxt) {
      // 引言框：只有当天真说了话才画（否则会留一个空白框）
      c.fillStyle = '#f3ecdd';
      c.beginPath(); c.moveTo(131, quoteTop); c.arcTo(619, quoteTop, 619, quoteTop + 150, 20); c.arcTo(619, quoteTop + 150, 131, quoteTop + 150, 20); c.arcTo(131, quoteTop + 150, 131, quoteTop, 20); c.arcTo(131, quoteTop, 619, quoteTop, 20); c.closePath(); c.fill();
      // 真实发言可能很长：按像素宽折行，最多两行，超出加省略号
      c.fillStyle = '#3d5166'; c.font = '27px sans-serif';
      const lines = []; let buf = '';
      for (const ch of qTxt) {
        if (c.measureText(buf + ch).width > 440) { lines.push(buf); buf = ch; if (lines.length === 2) break; }
        else buf += ch;
      }
      if (lines.length < 2 && buf) lines.push(buf);
      if (lines.length === 2 && (lines.join('').length < qTxt.length)) lines[1] = lines[1].slice(0, -1) + '…';
      lines.forEach((t, i) => c.fillText(t, 375, quoteTop + 61 + i * 40));
      c.fillStyle = '#a39a86'; c.font = '20px sans-serif';
      c.fillText('—— 你当时说的话', 375, quoteTop + (lines.length === 2 ? 137 : 121));
    }
    if (metaTxt) { c.fillStyle = '#4a5c6d'; c.font = '26px sans-serif'; c.fillText(metaTxt, 375, metaY); }
    c.strokeStyle = '#d5cbb6'; c.setLineDash([12, 10]); c.lineWidth = 3;
    c.beginPath(); c.moveTo(70, dashY); c.lineTo(680, dashY); c.stroke(); c.setLineDash([]);
    c.textAlign = 'left'; c.fillStyle = '#8a97a4'; c.font = '22px sans-serif';
    c.fillText('一只鱼鱼', 90, dashY + 65);
    c.fillText(stubTxt, 90, dashY + 105);
    let x = 470, s = tkHash(dateVal); c.fillStyle = '#17364f';
    for (let i = 0; i < 40; i++) { s = Math.imul(s, 48271) % 2147483647; const bw = 2 + s % 4, bh = 30 + s % 25; c.fillRect(x, dashY + 110 - bh, bw, bh); x += bw + 3; }
    // 底部品牌行：放在票根卡片外面（原来贴在最底边线上，和边线重叠）
    c.textAlign = 'center';
    c.fillStyle = '#8a97a4'; c.font = '600 23px sans-serif';
    c.fillText('王语晨补档站', 375, cardBot + 52);
    c.fillStyle = '#b3bcc4'; c.font = '20px Menlo, monospace';
    c.fillText('idol.wyc0518.cc', 375, cardBot + 86);
    /* 出图一律走站内统一的保存弹层（showAlbumLayer）：手机上「保存到相册」走系统分享，
       不支持（微信/微博内置浏览器）就引导长按 —— 🔴 绝不退回 <a download>，那会把图存进「文件」App
       而不是相册（2026-09-25 站长反馈）。文件名 = 陪伴票根-<日期>.png */
    const stamp = dateVal.replace(/\./g, '');
    let url = '';
    try { url = cv.toDataURL('image/png'); } catch (_) { url = ''; }
    if (!url || url.length < 2000) { if (typeof toast === 'function') toast('图片生成失败，请重试'); return; }
    trk('tkt:save');   /* 图真的生成出来了才记 */
    if (typeof showAlbumLayer === 'function') {
      showAlbumLayer(url, stamp, '陪伴票根');
    } else {
      const a = document.createElement('a'); a.href = url; a.download = '陪伴票根-' + stamp + '.png';
      document.body.appendChild(a); a.click(); a.remove();
    }
  }

  // 票根按钮（委托；guideSub 内容会重渲）
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tk]');
    if (t) { if (t.dataset.tk === 'prev') tkShift(-1); else if (t.dataset.tk === 'next') tkShift(1); else tkLastYear(); return; }
    if (e.target.closest('#tkSave')) tkSaveImage();
    if (e.target.closest('#tkPriv')) {
      tkHideLeg = !tkHideLeg; LS.set('wyc-tk-hideleg', tkHideLeg ? '1' : '0');
      tkRerender();
    }
  });

  // 等 app.js 的 init() 把数据拉回来再启动
  (function waitData(n) {
    const ok = (typeof DATA !== 'undefined') && (DATA.messages.length > 0 || DATA.live.length > 0);
    if (ok) return boot();
    if (n > 120) return boot();       // 最多等 60 秒，超时也启动（UI 先出来）
    setTimeout(() => waitData(n + 1), 500);
  })(0);
})();
