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
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
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
    if (i >= 0) { F.favs.splice(i, 1); toast('已取消收藏'); }
    else { F.favs.unshift(item); toast('⭐ 已加入收藏'); }
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
    const msgs = (typeof DATA !== 'undefined' && DATA.messages) || [];
    const pool = msgs.filter((m) => m.text && String(m.text).trim().length >= 10);
    if (!pool.length) { toast('数据还在加载，稍后再试'); return; }
    const m = pool[Math.floor(Math.random() * pool.length)];
    const day = bjDate(m.msgTime);
    jumpToDayWithMsg(day, m, '🎲 考古到 ' + day);
  }

  /** 去年今日：找往年「今天（北京时间 月-日）」的发言，有就跳过去 */
  function lastYearToday() {
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
    const w = modal('🔥 发言热力图', heatmapHtml(), { wide: true });
    // 事件委托：点某一天 → 关弹窗 → 按那天筛选（挂 body 上，重渲后依然生效）
    $('.dm-modal-b', w).addEventListener('click', (e) => {
      const cell = e.target.closest('.dm-hm[data-day]');
      if (!cell) return;
      const day = cell.dataset.day;
      const c = Number(cell.dataset.count || 0);
      if (!c) { toast(day + ' 这天没有发言'); return; }
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

  function boot() {
    injectToolbar();
    injectChips();
    buildHisDropdown();
    syncChipsTab();

    // DOM 变化 → 轻度重装饰（带防抖；已处理过的元素会跳过）
    let t = null;
    const obs = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { decorate(); syncChipsTab(); }, 120);
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

  // 等 app.js 的 init() 把数据拉回来再启动
  (function waitData(n) {
    const ok = (typeof DATA !== 'undefined') && (DATA.messages.length > 0 || DATA.live.length > 0);
    if (ok) return boot();
    if (n > 120) return boot();       // 最多等 60 秒，超时也启动（UI 先出来）
    setTimeout(() => waitData(n + 1), 500);
  })(0);
})();
