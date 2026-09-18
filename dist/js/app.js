// 王语晨补档站 - 前端逻辑
const DATA = { meta: null, messages: [], live: [], performances: [] };
// msgKey → message，便于翻译时按 id 取到原文（重新渲染后 DOM 里只剩 mid）
const MSG_INDEX = new Map();
const state = { tab: 'messages', query: '', dateFrom: null, dateTo: null, dayLimit: 3, lang: 'zh', expanded: new Set(), guideSub: 'guide' };

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
  ],
  // 公式照（按年份倒序分组）：2026 官网，2025 白礼服+皇冠、2024 蓝格纹礼服（均来自微博）
  galleryByYear: [
    {
      year: '2026',
      source: 'SNH48 官网成员资料',
      photos: [
        './assets/member-gs1.jpg',
        './assets/member-gs2.jpg',
        './assets/member-gs4.jpg'
      ]
    },
    {
      year: '2025',
      source: '微博',
      photos: [
        './assets/gs2025-1.jpg',
        './assets/gs2025-2.jpg',
        './assets/gs2025-3.jpg',
        './assets/gs2025-4.jpg'
      ]
    },
    {
      year: '2024',
      source: '微博',
      photos: [
        './assets/gs2024-1.jpg',
        './assets/gs2024-2.jpg',
        './assets/gs2024-3.jpg',
        './assets/gs2024-4.jpg'
      ]
    }
  ],
  // 经历备注（SNH48 官网 member-detail，新→旧；tag: 高飞/梦想/新人）
  experience: [
    { date: '2026.08.08', tag: '高飞', text: 'SNH48 GROUP 年度青春盛典 NO.22 年度高飞成员奖' },
    { date: '2025.08.02', tag: '梦想', text: 'SNH48 GROUP 年度青春盛典 NO45 年度梦想成员奖' },
    { date: '2024.08.03', tag: '高飞', text: 'SNH48 GROUP 年度青春盛典 NO27 年度高飞成员奖' },
    { date: '2023.08.05', tag: '新人', text: 'SNH48 GROUP 年度青春盛典 年度潜力新人' },
    { date: '2023.01.15', tag: '', text: '升格加入 GNZ48 Team NIII 队（Team NIII）' },
    { date: '2022.10.02', tag: '', text: '加入 GNZ48 十三期生' }
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
// 时间戳 → <input type="date"> 需要的 YYYY-MM-DD（本地时区）
function toDateInput(ts) {
  const d = new Date(Number(ts));
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const TYPE_LABEL = {
  TEXT: '文字', IMAGE: '图片', REPLY: '回复', GIFTREPLY: '礼物回复',
  AUDIO: '语音', AUDIO_GIFT_REPLY: '语音回复', VIDEO: '视频',
  LIVEPUSH: '直播推送', OPEN_LIVE: '公演直播',
  FLIPCARD: '翻牌', FLIPCARD_AUDIO: '翻牌语音', FLIPCARD_VIDEO: '翻牌视频',
  EXPRESS: '表情', EXPRESSIMAGE: '表情包', PRESENT_NORMAL: '礼物',
  PRESENT_TEXT: '文字礼物', SHARE_POSTS: '分享', VOTE: '投票', TRIP_INFO: '行程',
  DELETE: '撤回', DISABLE_SPEAK: '禁言', SESSION_DIANTAI: '电台', CLOSE_ROOM_CHAT: '闭房',
  RED_PACKET_2024: '红包', RED_PACKET_2026: '红包', RED_PACKET_QIXI_2025: '七夕红包',
  ZHONGQIU_ACTIVITY_LANTERN_FANS: '中秋灯笼'
};

// 王语晨本人的口袋 userId：用于区分「她本人发言」与房间里的其他人（粉丝 / 袋王 / 队友）
const SELF_ID = '89653517';

// 语音/视频时长（传入毫秒）
function fmtDur(ms) {
  const s = Math.round(Number(ms) / 1000);
  if (!s || s < 0) return '';
  return s < 60 ? `${s}"` : `${Math.floor(s / 60)}'${pad(s % 60)}"`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 多语言翻译（浏览器按需，免费接口 + localStorage 缓存） ---------------- */
// 目标语言：中 / 英 / 西 / 日 / 越 / 韩。选「中文」时不做任何翻译。
// 翻译走 translate.googleapis.com 的公开 endpoint（浏览器端 CORS 已放行，无需密钥），
// 每条译文按「语言 + 文本哈希」缓存到 localStorage，重复查看不再请求、离线也能读缓存。
const TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t';
let proxyOk = null; // 同域代理是否可用：null=未探明 / true / false（首次探测后缓存，避免每次翻译都发无效请求）

function strHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function trCacheKey(text, lang) { return `wyc:tr:${lang}:${strHash(text)}`; }
function trGet(text, lang) { try { return localStorage.getItem(trCacheKey(text, lang)); } catch { return null; } }
function trSet(text, lang, val) { try { localStorage.setItem(trCacheKey(text, lang), val); } catch { /* 配额满则忽略 */ } }

// 一条消息里所有可翻译的文本片段（正文 / 引用原话 / 卡片标题 / 描述）
function trSegs(m) {
  const segs = [];
  if (m.text) segs.push({ label: '', text: m.text });
  if (m.reply?.text) {
    const who = m.reply.name ? `@${m.reply.name}：` : '';
    segs.push({ label: '↩︎ ' + who, text: m.reply.text });
  }
  if (m.card?.title) segs.push({ label: '标题：', text: m.card.title });
  if (m.card?.desc) segs.push({ label: '描述：', text: m.card.desc });
  return segs;
}
function hasTranslatable(m) {
  return !!(m.text || m.reply?.text || (m.card && (m.card.title || m.card.desc)));
}
// 稳定的消息 id（msgIdServer 可能缺失，兜底用 文本+时间 哈希）
function msgKey(m) {
  return m.msgIdServer || ('k' + strHash((m.text || '') + (m.reply?.text || '') + m.msgTime));
}

// 调接口翻译单段文本（失败抛错，由调用方决定如何展示）
// 多翻译源按顺序尝试，任一成功即用（覆盖国内/海外、镜像/file:// 各种网络环境）：
//   1) /translate   ：本站 Cloudflare 边缘代理（国内可用、质量最佳；未部署时 404 自动跳过）
//   2) google       ：直连 Google 公开接口（海外/镜像可用、质量最佳）
//   3) mymemory     ：欧洲公共服务（国内可直连、CORS 已放行，作为兜底）
async function translateText(text, target) {
  if (target === 'zh' || !text) return text;
  const q = encodeURIComponent(text);
  const tl = encodeURIComponent(target);
  const gParse = (d) => ((d && d[0]) || []).map((s) => s[0]).join('');

  const gUrl = `${TRANSLATE_ENDPOINT}&tl=${tl}&q=${q}`;
  const pParse = (d) => (d && d.text) || ''; // 同域代理 /translate 返回 { text }（Workers AI 或 Google）
  const mmParse = (d) => {
    if (!d || d.responseStatus !== '200') return '';
    const t = (d.responseData && d.responseData.translatedText) || '';
    if (/MYMEMORY WARNING|QUOTA|YOU USED ALL/i.test(t)) return ''; // 额度耗尽 → 换下一个源
    return t;
  };

  // 翻译源按「质量优先」依次尝试（前一个失败才用下一个）：
  //   1) Google 直连         —— 质量最好（海外/镜像可用；大陆被墙会快速失败后自动降级）
  //   2) 同域代理 /translate —— Cloudflare Workers AI 翻译（稳定可用、含大陆；质量中等）
  //   3) MyMemory            —— 公共兜底
  const sources = [];
  sources.push({ kind: 'google', url: gUrl, parse: gParse, timeout: 2500 });
  if (proxyOk !== false) sources.push({ kind: 'proxy', url: `/translate?tl=${tl}&q=${q}`, parse: pParse, timeout: 9000 });
  sources.push({ kind: 'mymemory', url: `https://api.mymemory.translated.net/get?langpair=zh|${target}&q=${q}`, parse: mmParse, timeout: 6000 });

  const errs = []; // 记录每个源失败原因，便于用户反馈时定位
  for (const s of sources) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), s.timeout);
    try {
      const r = await fetch(s.url, { cache: 'no-store', signal: ctrl.signal });
      if (s.kind === 'proxy') proxyOk = r.ok; // 记录代理可用性（失败后不再请求）
      if (!r.ok) { errs.push(`${s.kind}=HTTP${r.status}`); continue; }
      const out = s.parse(await r.json());
      if (out) return out;
      errs.push(`${s.kind}=空`);
    } catch (e) {
      errs.push(`${s.kind}=${(e && e.name) || '网络错误'}`);
      if (s.kind === 'proxy') proxyOk = false;
    } finally { clearTimeout(timer); }
  }
  throw new Error(errs.join(' / ') || '全部翻译源失败');
}

// 从缓存生成译文块（已展开但缓存缺失时返回「翻译中…」占位）
function trBlocksHtml(m, lang) {
  return trSegs(m).map((s) => {
    const t = trGet(s.text, lang);
    const body = t != null
      ? escapeHtml(t)
      : '<span class="tr-loading">翻译中…</span>';
    const lab = s.label ? `<span class="tr-label">${escapeHtml(s.label)}</span>` : '';
    return `<div class="tr-item">${lab}<span class="tr-text">${body}</span></div>`;
  }).join('');
}

// 翻译一条消息的全部片段，写入 #tr-<mid>；逐个请求并加微小间隔避免限流
async function doTranslate(mid) {
  const m = MSG_INDEX.get(mid);
  if (!m) return;
  const lang = state.lang;
  if (lang === 'zh') return;
  const segs = trSegs(m);
  if (!segs.length) return;
  for (const s of segs) {
    let t = trGet(s.text, lang);
    if (t == null) {
      try {
        t = await translateText(s.text, lang);
        trSet(s.text, lang, t);
      } catch (e) {
        t = '__ERR__' + ((e && e.message) || '失败');
      }
    }
    s._t = t;
    await new Promise((r) => setTimeout(r, 120));
  }
  const box = document.getElementById('tr-' + mid);
  if (box) {
    box.innerHTML = segs.map((s) => {
      const isErr = typeof s._t === 'string' && s._t.startsWith('__ERR__');
      const body = isErr
        ? `<span class="tr-err">翻译失败（${escapeHtml(s._t.slice(7))}）</span>`
        : escapeHtml(s._t);
      return `<div class="tr-item">${s.label ? `<span class="tr-label">${escapeHtml(s.label)}</span>` : ''}` +
        `<span class="tr-text">${body}</span></div>`;
    }).join('');
  }
}

// 翻译当前可见的全部消息（带并发上限，避免一次性打爆接口）
async function translateAllVisible() {
  const boxes = [...panels.messages.querySelectorAll('.msg-tr')];
  let i = 0;
  const worker = async () => {
    while (i < boxes.length) {
      const box = boxes[i++];
      const mid = box.id.replace(/^tr-/, '');
      if (!MSG_INDEX.get(mid)) continue;
      state.expanded.add(mid);
      await doTranslate(mid);
    }
  };
  panels.messages.querySelectorAll('.tr-btn').forEach((b) => { b.textContent = '🌐 隐藏翻译'; });
  await Promise.all(Array.from({ length: 4 }, worker));
}

/* ---------------- 数据加载 ---------------- */
// 加载策略（兼顾「快」与「新」，且对手机/弱网友好）：
//   ① 先用 ~500 字节的 meta.json 取当前数据版本（lastUpdated），该请求每次都取最新（开销可忽略）；
//   ② 再以 <script src="./data/archive.js?v=<版本>"> 加载大文件：
//        数据没变 → 版本号没变 → 浏览器/CDN 直接命中缓存（秒开，不再重下十几 MB）；
//        数据一变 → 版本号随之变化 → URL 不同 → 自动拉到最新，且不会命中旧缓存。
//   ③ 失败自动换一种 URL 再试一次（弱网、连接中断很常见），仍失败才提示，并附上真实原因。
// 说明：改用 <script> 注入而非 fetch + new Function()，让浏览器原生解析，
//      避免再把十几 MB 的源码字符串复制一份交给 V8 编译，显著降低手机端内存峰值。
function injectScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => { if (s.parentNode) s.parentNode.removeChild(s); resolve(); };
    s.onerror = () => { if (s.parentNode) s.parentNode.removeChild(s); reject(new Error('无法下载数据文件 data/archive.js')); };
    (document.head || document.body).appendChild(s);
  });
}

// 取当前数据版本：用体积极小的 meta.json（每次都强制取最新）。取不到则返回空串。
async function dataVersion() {
  try {
    const r = await fetch(`./data/meta.json?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) {
      const m = await r.json();
      if (m && m.lastUpdated) return String(m.lastUpdated);
    }
  } catch (_) { /* 取不到版本就退回不带版本号的 URL */ }
  return '';
}

async function loadArchive() {
  const isFile = location.protocol === 'file:';
  let candidates;
  if (isFile) {
    // file:// 下带查询串会取不到文件，只能直接加载
    candidates = ['./data/archive.js'];
  } else {
    const ver = await dataVersion();
    candidates = ver
      ? [`./data/archive.js?v=${encodeURIComponent(ver)}`, `./data/archive.js?t=${Date.now()}`]
      : [`./data/archive.js?t=${Date.now()}`];
  }
  let lastErr = null;
  for (const src of candidates) {
    try {
      await injectScript(src);
      if (window.__ARCHIVE__) return window.__ARCHIVE__;
      lastErr = new Error('数据文件内容为空');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('加载数据文件 data/archive.js 失败');
}

async function init() {
  let data = null;
  let err = null;
  try {
    data = await loadArchive();
  } catch (e) {
    err = e;
    if (window.__ARCHIVE__) data = window.__ARCHIVE__; // 兜底层：拿不到新数据时先用已加载的旧数据
  }
  if (!data) {
    document.querySelector('.content').innerHTML =
      `<div class="empty-state">数据加载失败：${escapeHtml((err && err.message) || '未知原因')}<br/>` +
      `请检查网络后刷新重试；若持续失败，说明数据可能尚未部署完成。</div>`;
    return;
  }
  DATA.meta = data.meta;
  DATA.messages = data.messages || [];
  DATA.live = data.live || [];
  DATA.performances = data.performances || [];
  rebuildIndex();
  renderMeta();
  bindEvents();
  switchTab(state.tab); // 走一遍 tab 切换逻辑：正确显示/隐藏「时间」按钮并渲染当前面板
}

function rebuildIndex() {
  MSG_INDEX.clear();
  for (const m of DATA.messages) MSG_INDEX.set(msgKey(m), m);
}

async function fetchJson(name) {
  const res = await fetch(`./data/${name}`);
  if (!res.ok) throw new Error(`加载 ${name} 失败: ${res.status}`);
  return res.json();
}

/* ---------------- 检查更新 ---------------- */
function showToast(msg, isError, linkUrl) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  if (linkUrl) {
    t.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = msg + ' ';
    const a = document.createElement('a');
    a.href = linkUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '点此在 GitHub 手动触发';
    a.style.color = '#fff';
    a.style.textDecoration = 'underline';
    t.appendChild(span);
    t.appendChild(a);
  } else {
    t.textContent = msg;
  }
  t.style.background = isError ? '#c0392b' : '#2bc4e0';
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 4200);
}

/* ---------------- 刷新：触发一次最新抓取 + 拉取最新数据 ----------------
 * 点刷新 = 经 Worker 静默触发一次后台抓取（Worker 内部有 15 分钟冷却，粉丝狂点也不会把 GitHub 打爆），
 * 随后立即重新加载当前已部署的最新数据。全程不弹提示、不开新标签，对外完全无感；
 * 若 Cloudflare 密钥未配置导致触发失败，则仅拉取最新数据，不影响浏览。 */
async function checkForUpdates() {
  const btn = document.getElementById('refreshBtn');
  if (!btn || btn.disabled) return;
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '刷新中…';
  // 1) 静默触发一次后台抓取（失败也不提示）
  fetch('/scrape', { method: 'POST', cache: 'no-store' }).catch(() => {});
  // 2) 重新加载当前已部署的最新数据（?t= 绕过缓存，粉丝点一下即见最新快照）
  try {
    const data = await loadArchive();
    DATA.meta = data.meta;
    DATA.messages = data.messages || [];
    DATA.live = data.live || [];
    DATA.performances = data.performances || [];
    rebuildIndex();
    renderMeta();
    renderAll();
  } catch (e) {
    /* 静默失败，对外不暴露错误 */
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

function renderMeta() {
  const m = DATA.meta;
  if (!m) return;
  $('#memberName').textContent = m.member.name || '王语晨';
  $('#memberSub').textContent = `${m.member.groupName || 'GNZ48'} ${m.member.team || ''} · ${m.member.period || ''}`.trim();
  $('#statMsg').textContent = m.counts.messages ?? DATA.messages.length;
  $('#statLive').textContent = m.counts.live ?? DATA.live.length;
  $('#statPerf').textContent = m.counts.performances ?? DATA.performances.length;
  // 更新时间：宽屏显示完整时间，窄屏（≤560px）自动切换成「HH:MM 更新」，避免挤到右侧按钮
  const upEl = $('#updatedAt');
  if (upEl) {
    if (!m.lastUpdated) {
      upEl.textContent = '';
    } else {
      const d = new Date(m.lastUpdated);
      const pad = (n) => String(n).padStart(2, '0');
      upEl.innerHTML =
        `<span class="upd-full">更新于 ${d.toLocaleString('zh-CN')}</span>` +
        `<span class="upd-mini">${pad(d.getHours())}:${pad(d.getMinutes())} 更新</span>`;
    }
  }
}

/* ---------------- 事件 ---------------- */
function bindEvents() {
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', checkForUpdates);

  // 多语言：切换目标语言 → 清空展开态、显隐「翻译本页」、重渲染消息列表
  const langSelect = document.getElementById('langSelect');
  if (langSelect) {
    langSelect.addEventListener('change', (e) => {
      state.lang = e.target.value;
      state.expanded.clear();
      const trAll = document.getElementById('trAllBtn');
      if (trAll) trAll.hidden = state.lang === 'zh';
      if (state.tab === 'messages') renderMessages();
    });
  }
  const trAllBtn = document.getElementById('trAllBtn');
  if (trAllBtn) {
    trAllBtn.addEventListener('click', async () => {
      panels.messages.querySelectorAll('.msg-tr').forEach((box) => {
        state.expanded.add(box.id.replace(/^tr-/, ''));
      });
      renderMessages();
      await translateAllVisible();
    });
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  $('#searchInput').addEventListener('input', (e) => { state.query = e.target.value.trim().toLowerCase(); renderAll(); });
  // 时间筛选：弹窗 + 点「确认」才刷新；含「全部 / 近 N 天」快捷
  const dateModal = document.getElementById('dateModal');
  const openDateModal = () => {
    $('#dateFrom').value = state.dateFrom ? toDateInput(state.dateFrom) : '';
    $('#dateTo').value = state.dateTo ? toDateInput(state.dateTo - 1) : ''; // dateTo 存的是「次日 0 点」，回填减一天
    dateModal.hidden = false;
  };
  const closeDateModal = () => { dateModal.hidden = true; };
  const dateToggle = document.getElementById('dateToggleBtn');
  if (dateToggle) dateToggle.addEventListener('click', openDateModal);
  if (dateModal) {
    dateModal.addEventListener('click', (e) => { if (e.target === dateModal) closeDateModal(); });
    document.getElementById('dateCancel').addEventListener('click', closeDateModal);
    dateModal.querySelectorAll('[data-quick]').forEach((b) => {
      b.addEventListener('click', () => {
        const q = b.dataset.quick;
        if (q === 'all') { $('#dateFrom').value = ''; $('#dateTo').value = ''; return; }
        const days = Number(q) || 7;
        $('#dateFrom').value = toDateInput(Date.now() - (days - 1) * 86400000);
        $('#dateTo').value = toDateInput(Date.now());
      });
    });
    document.getElementById('dateConfirm').addEventListener('click', () => {
      const f = $('#dateFrom').value, t = $('#dateTo').value;
      state.dateFrom = f ? new Date(f + 'T00:00:00').getTime() : null;          // 本地 0 点
      state.dateTo = t ? new Date(t + 'T00:00:00').getTime() + 86400000 : null; // 次日 0 点（含当天）
      closeDateModal();
      state.dayLimit = 3;
      renderAll(); // 发言 / 直播录播 / 公演 三个页都要按新时间范围刷新
      showToast(state.dateFrom || state.dateTo ? '✅ 已按时间筛选' : '✅ 已显示全部时间');
    });
  }
  // 图片放大预览：支持在新标签打开原图 / 下载，方便保存
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `
    <div class="lb-bar">
      <a class="lb-btn" id="lbOpen" href="#" target="_blank" rel="noopener">⤢ 打开原图</a>
      <a class="lb-btn" id="lbSave" href="#" download>⤓ 下载</a>
      <button class="lb-btn" id="lbClose" type="button">✕ 关闭</button>
    </div>
    <div class="lb-stage">
      <img alt="图片预览" referrerpolicy="no-referrer" />
    </div>
    <div class="lb-tip">点击空白处关闭</div>`;
  const lbImg = lb.querySelector('img');
  lbImg.addEventListener('load', () => lb.classList.remove('loading'));
  lbImg.addEventListener('error', () => {
    lb.classList.remove('loading');
    lb.classList.add('broken');
  });

  window.__lightboxShow = (src) => {
    if (!src) return;
    lb.classList.add('show', 'loading');
    lb.classList.remove('broken');
    lbImg.src = src;
    lb.querySelector('#lbOpen').href = src;
    const save = lb.querySelector('#lbSave');
    save.href = src;
    save.setAttribute('download', (src.split('/').pop().split('?')[0] || 'image.jpg'));
  };
  lb.querySelector('#lbClose').addEventListener('click', () => lb.classList.remove('show'));
  lb.addEventListener('click', (e) => {
    // 点图片本体或工具栏时不关闭
    if (e.target.closest('.lb-bar') || e.target.tagName === 'IMG') return;
    lb.classList.remove('show');
  });
  document.body.appendChild(lb);
  window.__lightbox = lb;

  // 视频播放器事件
  $('#playerClose').addEventListener('click', closePlayer);
  $('#playerModal').addEventListener('click', (e) => { if (e.target === $('#playerModal')) closePlayer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#playerModal').hidden) closePlayer(); });

  // 卡片「播放」按钮 + 新粉指南社交按钮（事件委托）
  document.querySelector('.content').addEventListener('click', (e) => {
    // 翻译开关：点开才请求译文，再点收起
    const trBtn = e.target.closest('.tr-btn');
    if (trBtn) {
      e.stopPropagation();
      const mid = trBtn.dataset.mid;
      const box = document.getElementById('tr-' + mid);
      if (state.expanded.has(mid)) {
        state.expanded.delete(mid);
        trBtn.textContent = '🌐 翻译';
        if (box) box.innerHTML = '';
      } else {
        state.expanded.add(mid);
        trBtn.textContent = '🌐 隐藏翻译';
        if (box) box.innerHTML = trBlocksHtml(MSG_INDEX.get(mid) || {}, state.lang);
        doTranslate(mid);
      }
      return;
    }
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
      return;
    }
    // 新粉指南子标签切换
    const subBtn = e.target.closest('.subtab');
    if (subBtn) {
      e.stopPropagation();
      state.guideSub = subBtn.dataset.sub;
      panels.guide.querySelectorAll('.subtab').forEach((b) =>
        b.classList.toggle('active', b.dataset.sub === state.guideSub));
      renderGuideSub();
      return;
    }
    // 开播推送卡片 → 站内「直播 / 录播」页
    const gotoBtn = e.target.closest('[data-goto]');
    if (gotoBtn) {
      e.stopPropagation();
      switchTab(gotoBtn.dataset.goto);
      return;
    }
    // 列表上方的「清除筛选」
    if (e.target.closest('.filter-clear')) {
      e.stopPropagation();
      state.dateFrom = null;
      state.dateTo = null;
      state.dayLimit = 3;
      const f = $('#dateFrom'), t = $('#dateTo');
      if (f) f.value = '';
      if (t) t.value = '';
      renderAll();
      showToast('✅ 已清除时间筛选');
    }
  });
}

/* ---------------- 渲染 ---------------- */
function switchTab(name) {
  state.tab = name;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  Object.entries(panels).forEach(([k, el]) => el.classList.toggle('active', k === name));
  // 「📅 时间」筛选与「搜索」仅对「发言 / 直播录播 / 公演」有意义；新粉指南页自带内容，隐藏这两项
  const isGuide = name === 'guide';
  const df = $('#dateToggleBtn');
  if (df) df.hidden = isGuide;
  const si = $('#searchInput');
  if (si) si.hidden = isGuide;
  renderAll();
}

/* ---------- 时间筛选（发言 / 直播录播 / 公演 共用 state.dateFrom/dateTo） ---------- */
const dateFilterActive = () => !!(state.dateFrom || state.dateTo);
function inDateRange(ts) {
  const t = Number(ts);
  if (!t) return false;
  if (state.dateFrom && t < state.dateFrom) return false;
  if (state.dateTo && t > state.dateTo) return false; // dateTo 存「次日 0 点」，故含当天
  return true;
}
// 筛选生效时在列表上方显示一条提示 + 一键清除
function filterNote(count) {
  if (!dateFilterActive()) return '';
  const f = state.dateFrom ? fmtDate(state.dateFrom) : '最早';
  const t = state.dateTo ? fmtDate(state.dateTo - 86400000) : '最新';
  return `<div class="filter-note">📅 <b>${escapeHtml(f)}</b> ~ <b>${escapeHtml(t)}</b> · 共 ${count} 条` +
    `<button class="filter-clear" type="button">清除筛选</button></div>`;
}

function renderAll() {
  if (state.tab === 'messages') renderMessages();
  else if (state.tab === 'live') renderLive();
  else if (state.tab === 'guide') renderGuide();
  else renderPerformances();
}

/* ---------------- 新粉指南（含子标签：新粉指南 / 公式照 / 经历备注） ---------------- */
const GUIDE_SUBS = [
  ['guide', '新粉指南'],
  ['gallery', '公式照'],
  ['exp', '经历备注']
];

function renderGuide() {
  const panel = panels.guide;
  const subtabs = GUIDE_SUBS.map(([k, label]) =>
    `<button class="subtab${state.guideSub === k ? ' active' : ''}" data-sub="${k}">${escapeHtml(label)}</button>`
  ).join('');
  panel.innerHTML = `
    <div class="guide">
      <div class="subtabs">${subtabs}</div>
      <div class="guide-sub" id="guideSub"></div>
    </div>`;
  renderGuideSub();
}

// 仅刷新子标签内容，不重建整块（切换更快，且保留滚动位置）
function renderGuideSub() {
  const box = $('#guideSub');
  if (!box) return;
  if (state.guideSub === 'gallery') box.innerHTML = renderGallery();
  else if (state.guideSub === 'exp') box.innerHTML = renderExperience();
  else box.innerHTML = renderGuideMain();
}

// 子标签一：新粉指南（资料卡 + 社交账号）
function renderGuideMain() {
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

  return `
    <div class="guide-card">
      <div class="guide-facts">
        <div class="guide-aliases">昵称：${escapeHtml(PROFILE.aliases)}</div>
        <div class="facts-grid">${facts}</div>
        <div class="guide-code">神秘代码：<strong>${escapeHtml(PROFILE.secretCode)}</strong></div>
      </div>
      <img class="guide-poster" src="./assets/newfan-guide.jpg" alt="王语晨 新粉指南" loading="lazy" />
    </div>
    <div class="guide-socials">${groups}</div>
    <p class="guide-tip">在手机上点击会直接打开对应 App 并进入 TA 的主页；未安装 App 或唤起失败时，会自动跳转到网页版。</p>`;
}

// 子标签二：公式照（按年份分组：2024 / 2025 / 2026）
function renderGallery() {
  const groups = (PROFILE.galleryByYear || []).map((g) => {
    const items = g.photos.map((src, i) =>
      `<figure class="formula-item"><img src="${escapeHtml(src)}" alt="${escapeHtml(g.year)} 公式照 ${i + 1}" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('figure').classList.add('broken')" /><figcaption>${g.photos.length > 1 ? `${i + 1} / ${g.photos.length}` : '公式照'}</figcaption></figure>`
    ).join('');
    return `
      <section class="formula-year">
        <h3 class="formula-year-title">${escapeHtml(g.year)} 年公式照<span class="formula-year-count">${g.photos.length} 张</span></h3>
        <div class="formula-gallery">${items}</div>
        <p class="formula-year-source">来源：${escapeHtml(g.source)}</p>
      </section>`;
  }).join('');
  return `<section class="profile-block">${groups}</section>`;
}

// 子标签三：经历备注（SNH48 官网，新→旧）
function renderExperience() {
  const exp = (PROFILE.experience || []).map((e) => {
    const tag = e.tag
      ? `<span class="exp-tag exp-tag-${escapeHtml(e.tag)}">${escapeHtml(e.tag)}</span>`
      : '';
    return `<li class="exp-item">
      <div class="exp-dot"></div>
      <div class="exp-body">
        <div class="exp-date">${escapeHtml(e.date)}</div>
        <div class="exp-text">${tag}${escapeHtml(e.text)}</div>
      </div>
    </li>`;
  }).join('');
  return `<section class="profile-block"><ul class="exp-timeline">${exp}</ul></section>`;
}

// 一条消息可用于搜索的全部文字
function msgSearchText(m) {
  return [m.text, m.reply?.name, m.reply?.text, m.card?.title, m.card?.desc]
    .filter(Boolean).join(' ').toLowerCase();
}

function matchQuery(m) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return msgSearchText(m).includes(q) || (m.sender?.nickname || '').toLowerCase().includes(q);
}

function renderMessages() {
  const panel = panels.messages;
  let list = DATA.messages;
  const filtering = !!(state.dateFrom || state.dateTo || state.query);
  if (state.dateFrom || state.dateTo) {
    list = list.filter((m) => {
      const t = m.msgTime;
      if (state.dateFrom && t < state.dateFrom) return false;
      if (state.dateTo && t > state.dateTo) return false;
      return true;
    });
  }
  if (state.query) list = list.filter((m) => matchQuery(m));

  if (!list.length) {
    panel.innerHTML = filterNote(0) +
      `<div class="empty-state">${dateFilterActive() ? '该时间范围内没有发言，点上方「清除筛选」看全部。' : '暂无口袋发言数据。<br/>若尚未抓取，请设置 <code>POCKET48_TOKEN</code> 后运行 <code>node scrape.mjs</code>。'}</div>`;
    return;
  }

  const groups = {};
  for (const m of list) {
    const d = fmtDate(m.msgTime) || '未知日期';
    (groups[d] ||= []).push(m);
  }
  const sortedDays = Object.keys(groups).sort((a, b) => (b > a ? 1 : -1));

  // 全量存档有 400+ 天、1.5 万条，一次性渲染会让手机卡顿/内存吃紧：
  // 默认只渲染最近若干天，底部提供「加载更早」；搜索或日期筛选时直接全量展示。
  const limit = filtering ? sortedDays.length : Math.min(state.dayLimit, sortedDays.length);
  const shown = sortedDays.slice(0, limit);
  const restDays = sortedDays.length - limit;
  const restCount = restDays > 0
    ? sortedDays.slice(limit).reduce((n, d) => n + groups[d].length, 0)
    : 0;

  // 单条消息渲染异常不应拖垮整个列表
  const renderDay = (day) => `<div class="day-group">
      <div class="day-label">${day}（${groups[day].length}）</div>
      ${groups[day].map((m) => {
        try {
          return renderMsg(m);
        } catch (err) {
          return `<div class="msg"><div class="msg-body empty">［该条消息渲染失败］</div></div>`;
        }
      }).join('')}
    </div>`;

  const matchedCount = sortedDays.reduce((n, d) => n + groups[d].length, 0);
  panel.innerHTML = filterNote(matchedCount) + shown.map(renderDay).join('')
    + (restDays > 0
      ? `<button class="load-more" id="loadMore" type="button">加载更早的消息（还有 ${restCount} 条 / ${restDays} 天）</button>`
      : '');

  const moreBtn = document.getElementById('loadMore');
  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      const y = window.scrollY;
      state.dayLimit += 7;
      renderMessages();
      window.scrollTo(0, y);
    });
  }

  // 已展开的消息：若译文块还停留在「翻译中…」占位（缓存缺失），异步补抓
  if (state.lang !== 'zh' && state.expanded.size) {
    shown.forEach((day) => groups[day].forEach((m) => {
      const mid = msgKey(m);
      if (!state.expanded.has(mid)) return;
      const box = document.getElementById('tr-' + mid);
      if (box && box.querySelector('.tr-loading')) doTranslate(mid);
    }));
  }
}

// 回复 / 礼物回复的引用块：她回复了谁、原话是什么
function renderQuote(reply) {
  if (!reply || (!reply.name && !reply.text)) return '';
  const who = reply.name ? `回复 <b>@${escapeHtml(reply.name)}</b>` : '引用';
  return `<div class="msg-quote">
    <div class="msg-quote-who">↩︎ ${who}</div>
    ${reply.text ? `<div class="msg-quote-text">${escapeHtml(reply.text)}</div>` : ''}
  </div>`;
}

// 卡片消息（直播推送 / 分享 / 红包）
// 注意：函数名必须区别于直播面板的 renderCard(item, timeKey)，否则会被后者覆盖
/** 图片：点击放大预览，预览层支持「打开原图 / 下载 / 关闭」 */
function imgHtml(url, cls) {
  const u = escapeHtml(toUrl(url));
  return `<img class="${cls}" loading="lazy" decoding="async" referrerpolicy="no-referrer"
    src="${u}" alt="图片"
    onclick="window.__lightboxShow(this.src)"
    onerror="this.classList.add('failed');this.setAttribute('data-src',this.src)" />`;
}

function renderMsgCard(card) {
  if (!card) return '';
  const pic = card.pic ? imgHtml(card.pic, 'msg-card-pic') : '';
  // 开播推送：跳站内「直播 / 录播」页（原始 shortPath 无跳转意义）
  const link = card.kind === 'live'
    ? `<button class="msg-card-link as-btn" type="button" data-goto="live">前往直播 / 录播 ›</button>`
    : (card.url
      ? (/^https?:/i.test(card.url)
        ? `<a class="msg-card-link" href="${escapeHtml(card.url)}" target="_blank" rel="noopener">查看详情 ›</a>`
        : `<span class="msg-card-link muted">${escapeHtml(card.url)}</span>`)
      : '');
  return `<div class="msg-card msg-card-${escapeHtml(card.kind || 'info')}">
    ${pic}
    <div class="msg-card-main">
      <div class="msg-card-title">${escapeHtml(card.title || '')}</div>
      ${card.desc ? `<div class="msg-card-desc">${escapeHtml(card.desc)}</div>` : ''}
      ${link}
    </div>
  </div>`;
}

function renderMsg(m) {
  const typeLabel = TYPE_LABEL[m.msgType] || m.msgType || '其他';
  let body = '';

  // 1) 引用块（回复谁 / 什么礼物 / 什么提问）
  body += renderQuote(m.reply);
  // 2) 正文
  if (m.text) body += `<div class="msg-body">${escapeHtml(m.text)}</div>`;
  // 3) 媒体
  if (m.images?.length) {
    body += `<div class="msg-images">${m.images.map((u) => imgHtml(u, '')).join('')}</div>`;
  }
  if (m.audio) {
    const dur = fmtDur(m.duration);
    body += `<div class="msg-media msg-audio">
      ${dur ? `<span class="voice-badge">语音 ${dur}</span>` : ''}
      <audio controls preload="none" src="${escapeHtml(toUrl(m.audio))}"></audio>
    </div>`;
  }
  if (m.video) {
    body += `<div class="msg-media"><video controls preload="metadata" src="${escapeHtml(toUrl(m.video))}"></video></div>`;
  }
  if (m.link) body += `<div class="msg-link">🔗 <a href="${escapeHtml(m.link)}" target="_blank" rel="noopener">${escapeHtml(m.link)}</a></div>`;
  // 4) 卡片
  body += renderMsgCard(m.card);

  if (!body) {
    body = `<div class="msg-body empty">［${typeLabel}］无文本内容</div>
      <div class="msg-raw"><details><summary>查看原始数据</summary><pre>${escapeHtml(JSON.stringify(m.raw, null, 2))}</pre></details></div>`;
  }

  // 她本人的消息不重复标注昵称；房间里其他人的消息（粉丝 / 袋王 / 队友）标注出来
  const isSelf = String(m.sender?.userId || '') === SELF_ID;
  const sender = !isSelf && m.sender?.nickname
    ? `<span class="msg-sender other">@${escapeHtml(m.sender.nickname)}</span>`
    : '';

  // 多语言：选择非中文语言后，每条含文字的发言显示「翻译」开关（点开才请求，避免一次性打爆接口）
  let footer = '';
  if (state.lang !== 'zh' && hasTranslatable(m)) {
    const mid = msgKey(m);
    const expanded = state.expanded.has(mid);
    footer = `<div class="msg-tr-row">
      <button class="tr-btn" type="button" data-mid="${escapeHtml(mid)}">${expanded ? '🌐 隐藏翻译' : '🌐 翻译'}</button>
      <div class="msg-tr" id="tr-${escapeHtml(mid)}">${expanded ? trBlocksHtml(m, state.lang) : ''}</div>
    </div>`;
  }

  return `<div class="msg${isSelf ? '' : ' from-other'}">
    <div class="msg-head">
      <span class="msg-time">${fmtTime(m.msgTime)}</span>
      <span class="msg-type">${typeLabel}</span>
      ${sender}
    </div>
    ${body}
    ${footer}
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
  // 排期累积来的场次（尚未开演 / 尚无录播）标记为 upcoming；
  // playUrlDead = 官方回放流已失效（ts.48.cn），此时若挂了 B 站备用源就只显示 B 站按钮
  const noPlayText = item.upcoming ? '即将开演' : (item.playUrlDead ? '官方回放已失效' : '无视频');
  const playBtn = canPlay
    ? `<button class="play-btn" data-play="${escapeHtml(item.playUrl)}" data-title="${escapeHtml(title + ' · ' + time)}">▶ 播放</button>`
    : (item.biliUrl ? '' : `<span class="no-play">${noPlayText}</span>`);
  // 无录播（或有）时的 B 站跳转（按名称手工匹配挂上）
  const biliBtn = item.biliUrl
    ? `<a class="bili-btn" href="${escapeHtml(item.biliUrl)}" target="_blank" rel="noopener">📺 B 站观看</a>`
    : '';
  return `<div class="card">
    ${cover ? `<img class="card-img" loading="lazy" referrerpolicy="no-referrer" src="${escapeHtml(cover)}" alt="" onclick="window.__lightboxShow(this.src)" onerror="this.classList.add('failed')" />` : ''}
    <div class="card-body">
      <p class="card-title">${escapeHtml(title)}</p>
      ${sub ? `<p class="card-sub">${escapeHtml(sub)}</p>` : ''}
      <div class="card-meta">
        ${item.upcoming ? '<span class="badge soon">即将开始</span>' : liveStatusBadge(item.status)}
        <span>🕒 ${escapeHtml(time)}</span>
        ${playNum ? `<span>▶ ${escapeHtml(String(playNum))}</span>` : ''}
      </div>
      <div class="card-actions">${playBtn}${biliBtn}</div>
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
  if (dateFilterActive()) list = list.filter((m) => inDateRange(m.ctime));
  if (!list.length) {
    panel.innerHTML = filterNote(0) +
      `<div class="empty-state">${dateFilterActive() ? '该时间范围内没有直播 / 录播，点上方「清除筛选」看全部。' : '暂无直播 / 录播数据。'}</div>`;
    return;
  }
  panel.innerHTML = filterNote(list.length) +
    `<div class="card-grid">${list.map((m) => renderCard(m, 'ctime')).join('')}</div>`;
}

function renderPerformances() {
  const panel = panels.performances;
  let list = DATA.performances;
  if (state.query) list = list.filter((m) => (m.title || '').toLowerCase().includes(state.query));
  if (dateFilterActive()) list = list.filter((m) => inDateRange(m.stime));
  if (!list.length) {
    panel.innerHTML = filterNote(0) +
      `<div class="empty-state">${dateFilterActive() ? '该时间范围内没有公演，点上方「清除筛选」看全部。' : '暂无公演数据。'}</div>`;
    return;
  }
  panel.innerHTML = filterNote(list.length) +
    `<div class="card-grid">${list.map((m) => renderCard(m, 'stime')).join('')}</div>`;
}

init();
