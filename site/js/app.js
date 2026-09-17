// 王语晨补档站 - 前端逻辑
const DATA = { meta: null, messages: [], live: [], performances: [] };
const state = { tab: 'messages', query: '', dateFrom: null, dateTo: null };

const $ = (sel) => document.querySelector(sel);
const panels = {
  messages: $('#panel-messages'),
  live: $('#panel-live'),
  performances: $('#panel-performances'),
  guide: $('#panel-guide')
};

/* ---------------- 新粉指南数据 ---------------- */
// 说明：微博用昵称路由（weibo.com/n/昵称）直达主页；
// 抖音 / 小红书 / B站 已通过短链解析出内部 ID，这里用「平台 scheme + ID」实现 App 内直达主页。
// accounts[].scheme 可覆盖 groups[].scheme（用于精确到某个账号的主页）。
const PROFILE = {
  name: '王语晨',
  aliases: '晨晨 / 壮壮 / 鱼鱼',
  facts: [
    ['生日', '2002.05.18'],
    ['星座', '金牛座'],
    ['出生地', '重庆'],
    ['MBTI', 'INFJ'],
    ['宠物', '小面包'],
    ['队伍', 'Team NIII'],
    ['期数', 'GNZ48 十三期'],
    ['粉丝名', '小甜橙'],
    ['应援色', '天蓝色']
  ],
  secretCode: '831882944',
  groups: [
    {
      label: '微博',
      scheme: 'sinaweibo://',
      color: '#e6162d',
      accounts: [
        { handle: 'GNZ48-王语晨', web: 'https://weibo.com/n/GNZ48-王语晨' },
        { handle: '忘记自己是鱼_', web: 'https://weibo.com/n/忘记自己是鱼_' }
      ]
    },
    {
      label: '抖音',
      scheme: 'snssdk1128://',
      color: '#111111',
      accounts: [
        {
          handle: 'Yuuuchen_',
          web: 'https://v.douyin.com/AOSQp6eBlwg/',
          scheme: 'snssdk1128://user/profile/MS4wLjABAAAADMlKYF7tTpgCmrD4up029mze5aSL3DshSGupCO2KxwnVUHLdRxJiXqoc21nTvfTm'
        },
        {
          handle: '是一只鱼',
          web: 'https://v.douyin.com/ZQ3QZpzoRNY/',
          scheme: 'snssdk1128://user/profile/MS4wLjABAAAAPoRpu29hMC-ZnzB-4iv_gdpKOkRvkIjo4l8C9Mn1zy0uWl3xCwrNhE9Syou8stCc'
        }
      ]
    },
    {
      label: '小红书',
      scheme: 'xhsdiscover://',
      color: '#ff2442',
      accounts: [
        {
          handle: 'Yuuuchen_',
          note: '3935 粉丝',
          web: 'https://xhslink.cn/o/5yLa5r0LeWV',
          scheme: 'xhsdiscover://user/5cedbceb00000000160097c0'
        }
      ]
    },
    {
      label: 'B站',
      scheme: 'bilibili://',
      color: '#00aeec',
      accounts: [
        {
          handle: '忘记自己是鱼_',
          web: 'https://space.bilibili.com/19994272',
          scheme: 'bilibili://space/19994272'
        }
      ]
    },
    {
      label: '往期舞台补档（微博）',
      scheme: 'sinaweibo://',
      color: '#e6162d',
      accounts: [
        { handle: '初星·王语晨', web: 'https://weibo.com/n/初星·王语晨' },
        { handle: '爱在黎明前_王语晨', web: 'https://weibo.com/n/爱在黎明前_王语晨' }
      ]
    },
    {
      label: '应援会微博',
      scheme: 'sinaweibo://',
      color: '#e6162d',
      accounts: [
        { handle: 'GNZ48-王语晨的甜橙小铺', web: 'https://weibo.com/n/GNZ48-王语晨的甜橙小铺' }
      ]
    }
  ]
};

// 点击社交账号：移动端先尝试唤起对应 App，未成功则回退网页
function openSocial(web, scheme) {
  const ua = navigator.userAgent || '';
  const isMobile = /iPhone|iPad|iPod|Android/i.test(ua);
  if (!isMobile || !scheme) {
    window.open(web, '_blank', 'noopener');
    return;
  }
  let fallbackTimer = setTimeout(() => { window.location.href = web; }, 1400);
  const cancel = () => clearTimeout(fallbackTimer);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); }, { once: true });
  window.addEventListener('pagehide', cancel, { once: true });
  try {
    window.location.href = scheme;
  } catch {
    cancel();
    window.open(web, '_blank', 'noopener');
  }
}

/* ---------------- 工具函数 ---------------- */
function toUrl(path) {
  if (!path) return '';
  if (/^(https?:|data:)/i.test(path)) return path;
  return 'https://source3.48.cn' + (path.startsWith('/') ? '' : '/') + path;
}

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(ts) {
  const d = new Date(Number(ts));
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtTime(ts) {
  const d = new Date(Number(ts));
  if (isNaN(d)) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const TYPE_LABEL = {
  TEXT: '文字', IMAGE: '图片', REPLY: '回复', GIFTREPLY: '礼物回复',
  AUDIO: '语音', VIDEO: '视频', LIVEPUSH: '直播', OPEN_LIVE: '公演直播',
  FLIPCARD: '翻牌', FLIPCARD_AUDIO: '翻牌语音', FLIPCARD_VIDEO: '翻牌视频',
  EXPRESS: '表情', EXPRESSIMAGE: '表情包', PRESENT_NORMAL: '礼物',
  PRESENT_TEXT: '文字礼物', VOTE: '投票', TRIP_INFO: '行程', DELETE: '撤回',
  DISABLE_SPEAK: '禁言', SESSION_DIANTAI: '电台', CLOSE_ROOM_CHAT: '闭房',
  RED_PACKET_2024: '红包', ZHONGQIU_ACTIVITY_LANTERN_FANS: '中秋灯笼'
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 数据加载 ---------------- */
// 优先使用 archive.js（window.__ARCHIVE__，file:// 直接打开可用）；
// 若以 HTTP 部署则回退到 fetch 加载 JSON。
async function init() {
  let data = window.__ARCHIVE__;
  if (!data) {
    try {
      const [meta, msg, live, perf] = await Promise.all([
        fetchJson('meta.json'), fetchJson('messages.json'),
        fetchJson('live.json'), fetchJson('performances.json')
      ]);
      data = {
        meta,
        messages: msg.messages || [],
        live: live.live || [],
        performances: perf.performances || []
      };
    } catch (e) {
      document.querySelector('.content').innerHTML =
        `<div class="empty-state">数据加载失败：${escapeHtml(e.message)}<br/>请先运行抓取脚本（详见 README）。</div>`;
      return;
    }
  }
  DATA.meta = data.meta;
  DATA.messages = data.messages || [];
  DATA.live = data.live || [];
  DATA.performances = data.performances || [];
  renderMeta();
  bindEvents();
  renderAll();
}

async function fetchJson(name) {
  const res = await fetch(`./data/${name}`);
  if (!res.ok) throw new Error(`加载 ${name} 失败: ${res.status}`);
  return res.json();
}

function renderMeta() {
  const m = DATA.meta;
  if (!m) return;
  $('#memberName').textContent = m.member.name || '王语晨';
  $('#memberSub').textContent = `${m.member.groupName || 'GNZ48'} ${m.member.team || ''} · ${m.member.period || ''}`.trim();
  $('#statMsg').textContent = m.counts.messages ?? DATA.messages.length;
  $('#statLive').textContent = m.counts.live ?? DATA.live.length;
  $('#statPerf').textContent = m.counts.performances ?? DATA.performances.length;
  $('#updatedAt').textContent = m.lastUpdated ? '更新于 ' + new Date(m.lastUpdated).toLocaleString('zh-CN') : '';
}

/* ---------------- 事件 ---------------- */
function bindEvents() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      Object.entries(panels).forEach(([k, el]) => el.classList.toggle('active', k === state.tab));
      $('#dateFilter').hidden = state.tab !== 'messages';
      renderAll();
    });
  });
  $('#searchInput').addEventListener('input', (e) => { state.query = e.target.value.trim().toLowerCase(); renderAll(); });
  $('#dateFrom').addEventListener('change', (e) => { state.dateFrom = e.target.value ? new Date(e.target.value).getTime() : null; renderMessages(); });
  $('#dateTo').addEventListener('change', (e) => {
    state.dateTo = e.target.value ? new Date(e.target.value).getTime() + 86400000 : null; renderMessages();
  });
  $('#dateClear').addEventListener('click', () => {
    state.dateFrom = state.dateTo = null;
    $('#dateFrom').value = ''; $('#dateTo').value = '';
    renderMessages();
  });
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = '<img alt="预览" />';
  lb.addEventListener('click', () => lb.classList.remove('show'));
  document.body.appendChild(lb);
  window.__lightbox = lb;

  // 视频播放器事件
  $('#playerClose').addEventListener('click', closePlayer);
  $('#playerModal').addEventListener('click', (e) => { if (e.target === $('#playerModal')) closePlayer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#playerModal').hidden) closePlayer(); });

  // 卡片「播放」按钮 + 新粉指南社交按钮（事件委托）
  document.querySelector('.content').addEventListener('click', (e) => {
    const playBtn = e.target.closest('.play-btn');
    if (playBtn) {
      e.stopPropagation();
      openPlayer(playBtn.dataset.play, playBtn.dataset.title);
      return;
    }
    const socialBtn = e.target.closest('.social-btn');
    if (socialBtn) {
      e.stopPropagation();
      openSocial(socialBtn.dataset.web, socialBtn.dataset.scheme);
    }
  });
}

/* ---------------- 渲染 ---------------- */
function renderAll() {
  if (state.tab === 'messages') renderMessages();
  else if (state.tab === 'live') renderLive();
  else if (state.tab === 'guide') renderGuide();
  else renderPerformances();
}

/* ---------------- 新粉指南 ---------------- */
function renderGuide() {
  const panel = panels.guide;
  const facts = PROFILE.facts
    .map(([k, v]) => `<div class="fact"><span class="fact-k">${escapeHtml(k)}</span><span class="fact-v">${escapeHtml(v)}</span></div>`)
    .join('');

  const groups = PROFILE.groups.map((g) => {
    const accounts = g.accounts.map((a) =>
      `<button class="social-btn" style="--social:${g.color}" data-web="${escapeHtml(a.web)}" data-scheme="${escapeHtml(a.scheme || g.scheme)}">
        <span class="social-handle">@${escapeHtml(a.handle)}</span>
        ${a.note ? `<span class="social-note">${escapeHtml(a.note)}</span>` : ''}
        <span class="social-go">打开主页 ›</span>
      </button>`
    ).join('');
    return `<div class="social-group">
      <div class="social-label"><span class="social-dot" style="background:${g.color}"></span>${escapeHtml(g.label)}</div>
      <div class="social-list">${accounts}</div>
    </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="guide">
      <div class="guide-card">
        <div class="guide-facts">
          <div class="guide-aliases">昵称：${escapeHtml(PROFILE.aliases)}</div>
          <div class="facts-grid">${facts}</div>
          <div class="guide-code">神秘代码：<strong>${escapeHtml(PROFILE.secretCode)}</strong></div>
        </div>
        <img class="guide-poster" src="./assets/newfan-guide.jpg" alt="王语晨 新粉指南" loading="lazy" />
      </div>
      <div class="guide-socials">${groups}</div>
      <p class="guide-tip">在手机上点击会直接打开对应 App 并进入 TA 的主页；未安装 App 或唤起失败时，会自动跳转到网页版。</p>
    </div>`;
}

function matchQuery(text, sender) {
  if (!state.query) return true;
  return (text || '').toLowerCase().includes(state.query) || (sender || '').toLowerCase().includes(state.query);
}

function renderMessages() {
  const panel = panels.messages;
  let list = DATA.messages;
  if (state.dateFrom || state.dateTo) {
    list = list.filter((m) => {
      const t = m.msgTime;
      if (state.dateFrom && t < state.dateFrom) return false;
      if (state.dateTo && t > state.dateTo) return false;
      return true;
    });
  }
  if (state.query) list = list.filter((m) => matchQuery(m.text, m.sender?.nickname));

  if (!list.length) {
    panel.innerHTML = `<div class="empty-state">暂无口袋发言数据。<br/>若尚未抓取，请设置 <code>POCKET48_TOKEN</code> 后运行 <code>node scrape.mjs</code>。</div>`;
    return;
  }

  const groups = {};
  for (const m of list) {
    const d = fmtDate(m.msgTime) || '未知日期';
    (groups[d] ||= []).push(m);
  }
  const sortedDays = Object.keys(groups).sort((a, b) => (b > a ? 1 : -1));
  panel.innerHTML = sortedDays.map((day) => `
    <div class="day-group">
      <div class="day-label">${day}（${groups[day].length}）</div>
      ${groups[day].map(renderMsg).join('')}
    </div>`).join('');
}

function renderMsg(m) {
  const typeLabel = TYPE_LABEL[m.msgType] || m.msgType || '其他';
  let body = '';
  if (m.text) body += `<div class="msg-body">${escapeHtml(m.text)}</div>`;
  if (m.images?.length) {
    body += `<div class="msg-images">${m.images.map((u) => `<img loading="lazy" src="${escapeHtml(toUrl(u))}" onclick="window.__lightbox.querySelector('img').src=this.src;window.__lightbox.classList.add('show')" />`).join('')}</div>`;
  }
  if (m.audio) body += `<div class="msg-media"><audio controls src="${escapeHtml(toUrl(m.audio))}"></audio></div>`;
  if (m.video) body += `<div class="msg-media"><video controls src="${escapeHtml(toUrl(m.video))}"></video></div>`;
  if (m.link) body += `<div class="msg-link">🔗 <a href="${escapeHtml(m.link)}" target="_blank" rel="noopener">${escapeHtml(m.link)}</a></div>`;
  if (!body) {
    body = `<div class="msg-body empty">［${typeLabel}］无文本内容</div>
      <div class="msg-raw"><details><summary>查看原始数据</summary><pre>${escapeHtml(JSON.stringify(m.raw, null, 2))}</pre></details></div>`;
  }
  const sender = m.sender?.nickname ? `<span class="msg-sender">@${escapeHtml(m.sender.nickname)}</span>` : '';
  return `<div class="msg">
    <div class="msg-head">
      <span class="msg-time">${fmtTime(m.msgTime)}</span>
      <span class="msg-type">${typeLabel}</span>
      ${sender}
    </div>
    ${body}
  </div>`;
}

function liveStatusBadge(status) {
  const s = Number(status);
  if (s === 2) return '<span class="badge live">直播中</span>';
  if (s === 1) return '<span class="badge rec">录播</span>';
  if (s === 0) return '<span class="badge soon">预告</span>';
  return '<span class="badge end">已结束</span>';
}

// 视频播放器（hls.js 播放 m3u8；Safari 原生支持）
let hlsInstance = null;
function setPlayerStatus(text, isError) {
  const hint = $('#playerHint');
  if (!hint) return;
  hint.textContent = text || '';
  hint.style.color = isError ? '#ff9a9a' : '#cfe';
}
function openPlayer(playUrl, title) {
  const modal = $('#playerModal');
  const video = $('#playerVideo');
  if (!playUrl) {
    $('#playerTitle').textContent = title || '视频回放';
    setPlayerStatus('该条目暂无可用播放地址（可能是尚未生成录播的旧公演）。', true);
    modal.hidden = false;
    return;
  }
  $('#playerTitle').textContent = title || '视频回放';
  modal.hidden = false;

  // 释放上一次
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  video.pause();
  video.removeAttribute('src');
  video.load();

  const url = playUrl.replace(/^http:/, 'https:');
  setPlayerStatus('正在加载视频流…');
  const rawLine = `\n直链（可复制到 VLC 等播放器打开）：${url}`;

  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ lowLatencyMode: false, enableWorker: true });
    hlsInstance = hls;
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      setPlayerStatus('已解析，正在缓冲…（若未自动播放，请点播放器上的 ▶）');
      video.play().catch(() => {});
    });
    hls.on(window.Hls.Events.FRAG_LOADED, () => setPlayerStatus(''));
    hls.on(window.Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      let msg = '播放失败：' + (data.details || data.type);
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        msg += '（网络请求被拦截 / 跨域 / 源受限）';
      } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        try { hls.recoverMediaError(); msg += '（已尝试自动恢复）'; } catch { /* ignore */ }
      }
      setPlayerStatus(msg + rawLine, true);
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.play().catch(() => {});
    setPlayerStatus('使用浏览器原生播放器（Safari / 部分 iOS）');
  } else {
    setPlayerStatus('当前环境无法内嵌播放 m3u8（hls.js 未加载或被拦截）。' + rawLine, true);
  }
}
function closePlayer() {
  const modal = $('#playerModal');
  const video = $('#playerVideo');
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  video.pause();
  video.removeAttribute('src');
  video.load();
  modal.hidden = true;
}

function renderCard(item, timeKey) {
  const cover = toUrl(item.coverPath || item.cover);
  // 直播标题常为默认数字（如 "1"），回退到成员昵称；公演用 title + subTitle
  const rawTitle = item.title || item.subTitle || '';
  const isGeneric = /^\d+$/.test(rawTitle.trim());
  const fallback = item.userInfo?.nickname || item.teamList?.[0]?.teamName || '';
  const title = !rawTitle || isGeneric ? (fallback || '未命名') : rawTitle;
  const sub = item.subTitle && item.subTitle !== title ? item.subTitle : '';
  const time = fmtDate(item[timeKey]) + ' ' + fmtTime(item[timeKey]);
  const playNum = item.playNum || item.playCount || '';
  const canPlay = !!item.playUrl;
  const playBtn = canPlay
    ? `<button class="play-btn" data-play="${escapeHtml(item.playUrl)}" data-title="${escapeHtml(title + ' · ' + time)}">▶ 播放</button>`
    : `<span class="no-play">无视频</span>`;
  return `<div class="card">
    ${cover ? `<img class="card-img" loading="lazy" src="${escapeHtml(cover)}" alt="" onclick="window.__lightbox.querySelector('img').src=this.src;window.__lightbox.classList.add('show')" />` : ''}
    <div class="card-body">
      <p class="card-title">${escapeHtml(title)}</p>
      ${sub ? `<p class="card-sub">${escapeHtml(sub)}</p>` : ''}
      <div class="card-meta">
        ${liveStatusBadge(item.status)}
        <span>🕒 ${escapeHtml(time)}</span>
        ${playNum ? `<span>▶ ${escapeHtml(String(playNum))}</span>` : ''}
      </div>
      <div class="card-actions">${playBtn}</div>
    </div>
  </div>`;
}

function renderLive() {
  const panel = panels.live;
  let list = DATA.live;
  if (state.query) list = list.filter((m) =>
    (m.title || '').toLowerCase().includes(state.query) ||
    (m.userInfo?.nickname || '').toLowerCase().includes(state.query)
  );
  if (!list.length) { panel.innerHTML = '<div class="empty-state">暂无直播 / 录播数据。</div>'; return; }
  panel.innerHTML = `<div class="card-grid">${list.map((m) => renderCard(m, 'ctime')).join('')}</div>`;
}

function renderPerformances() {
  const panel = panels.performances;
  let list = DATA.performances;
  if (state.query) list = list.filter((m) => (m.title || '').toLowerCase().includes(state.query));
  if (!list.length) { panel.innerHTML = '<div class="empty-state">暂无公演数据。</div>'; return; }
  panel.innerHTML = `<div class="card-grid">${list.map((m) => renderCard(m, 'stime')).join('')}</div>`;
}

init();
