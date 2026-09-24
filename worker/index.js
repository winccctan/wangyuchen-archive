// 王语晨补档站 · Cloudflare Worker
// 职责：
//   1) 静态站点：dist/ 里的文件通过 env.ASSETS 提供（HTML/CSS/JS/数据）；
//   2) 同域翻译代理：GET /translate?tl=<目标语言>&q=<原文>  → { text: "译文" }
//      优先用 **Workers AI**（env.AI.run，Cloudflare 边缘自推理，不经过外部 IP，稳定、无需密钥）；
//      失败再兜底 Google 公开接口。
//      浏览器只与本站同源通信 → 规避跨域，也让**大陆直连用户**能用。
//   3) 健康检查：GET /ping → "pong"。
// 其它任何请求都透传给静态资源。
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/ping') {
      return new Response('pong', {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
      });
    }

    // 翻译使用统计：仅带 key 才返回（给 GitHub Pages 的统计页面用），否则 404
    if (url.pathname === '/stats' || url.pathname === '/stats/') {
      return handleStats(url, env);
    }

    // 统计页面只放 GitHub Pages 备份站；主域名上直接当作不存在（备份站不经 Worker，不受影响）
    if (url.pathname === '/stats.html') {
      return new Response('Not Found', { status: 404 });
    }

    // 站点动作统计（前端 track() 用 1x1 图片上报）：只记动作次数，不含任何内容
    if (url.pathname === '/track') {
      if (!isSameSite(request)) return new Response('forbidden', { status: 403 });
      return handleTrack(url, request, env, ctx);
    }

    if (url.pathname === '/translate') {
      if (!isSameSite(request)) return forbiddenNotSameSite();
      return handleTranslate(request, url, env, ctx);
    }

    // 手动触发抓取：POST /scrape → 经 GitHub API 触发仓库的 scrape.yml 工作流。
    // 这样前端的「刷新」按钮和「页面加载」都能真正去抓一次，而不是只重载旧静态数据。
    if (url.pathname === '/scrape' && request.method === 'POST') {
      if (!isSameSite(request)) return forbiddenNotSameSite();
      return handleScrape(env);
    }

    // 图片代理：社媒美图墙的微博图床图片（sinaimg.cn / weibocdn.com）。
    // 新浪 Tengine 对「浏览器 UA + 非微博来源」请求返回 403，故 Worker 以非浏览器 UA 取图并边缘缓存。
    if (url.pathname === '/img' || url.pathname === '/img/') {
      return handleImageProxy(url, ctx);
    }

    // ============ 数据 API（数据存 KV 命名空间 env.KV，前端经此读取 → 站点零部署更新）============
    // 读接口公开（前端同源 fetch 即可）；写接口 /api/sync 需 SYNC_TOKEN（见 isSyncAuthorized）。
    // 发言按月份分键：msg/YYYY-MM（单月远小于 KV 单值 25MB 上限 → 数据可无限增长、不被容量卡死）；
    // 浏览器首屏拉 /api/index（含 recent 最新若干条 + 月份列表 + meta），下滑「加载更早」惰性拉历史月。
    // ============ TEMP-D1：迁移引导接口（数据迁移完成后删除本段）============
    // 建表：POST /api/_d1_init
    if (url.pathname === '/api/_d1_init' && request.method === 'POST') {
      if (!(await isSyncAuthorized(request, env))) return json({ error: 'forbidden: sync token required' }, 403);
      if (!env.DB) return json({ error: 'd1-not-bound' }, 500);
      await env.DB.exec(
        'CREATE TABLE IF NOT EXISTS messages (' +
        '  mid TEXT PRIMARY KEY,' +
        '  month TEXT NOT NULL,' +
        '  msgTime INTEGER NOT NULL,' +
        '  data TEXT NOT NULL' +
        ');' +
        'CREATE INDEX IF NOT EXISTS idx_messages_month ON messages(month);' +
        'CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(msgTime DESC);'
      );
      const t = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      return json({ ok: true, tables: (t.results || []).map((r) => r.name) });
    }
    // 迁移某个月（从 KV 读 → 写 D1）：POST /api/_d1_migrate?m=YYYY-MM
    if (url.pathname === '/api/_d1_migrate' && request.method === 'POST') {
      if (!(await isSyncAuthorized(request, env))) return json({ error: 'forbidden: sync token required' }, 403);
      if (!env.DB) return json({ error: 'd1-not-bound' }, 500);
      const m = url.searchParams.get('m');
      if (!/^\d{4}-\d{2}$/.test(m || '')) return json({ error: 'bad month' }, 400);
      const arr = (await env.KV.get('msg/' + m, { type: 'json' })) || [];
      const CH = 100;                       // D1 batch 每批 ≤100 条
      let sent = 0;
      for (let i = 0; i < arr.length; i += CH) {
        const stmts = arr.slice(i, i + CH).map((x) => env.DB.prepare(
          'INSERT OR REPLACE INTO messages (mid, month, msgTime, data) VALUES (?, ?, ?, ?)'
        ).bind(msgKeyOf(x), m, Number(x.msgTime) || 0, JSON.stringify(x)));
        if (stmts.length) await env.DB.batch(stmts);
        sent += stmts.length;
      }
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE month = ?').bind(m).first();
      return json({ ok: true, month: m, kvCount: arr.length, sent, dbCount: (c && c.n) || 0 });
    }

    // 跨域预检：/api/mine 会从别的域名（演示站 / Pages）被 fetch
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          // 后台接口带 x-admin-token 头：同源 fetch 也会先发 OPTIONS 预检，不放行就一律登录失败
          'access-control-allow-headers': 'content-type, x-admin-token',
          'access-control-max-age': '86400',
        }
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(url, request, env, ctx);
    }

    if (env && env.ASSETS) {
      // HTML 单独用 identity 取回（避免拿到压缩流 → 无法注入 beacon）；
      // 其余资源（css/js/十几 MB 的数据文件）保持原请求，仍走压缩。
      let assetReq = request;
      if (isHtmlPath(url)) {
        const h = new Headers(request.headers);
        h.set('accept-encoding', 'identity');
        assetReq = new Request(request, { headers: h });
      }
      const res = await env.ASSETS.fetch(assetReq);
      return applyFreshPolicy(await injectRum(res), url);
    }
    return new Response('Not Found', { status: 404 });
  },

  // Cron 定时触发（见 wrangler.jsonc 的 triggers.crons = ["*/5 * * * *"]）：
  // Cloudflare 边缘每 5 分钟自动派发一次抓取，替代经常延迟/丢跑的 GitHub 原生 cron。
  // 走的是和「🔄 刷新」按钮完全相同的 handleScrape（含 1 分钟冷却，5 分钟间隔不会误挡）。
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScrape(env));
  }
};

/* ------------------------- 同站校验（防脚本滥用功能接口） -------------------------
 * /translate（消耗 Workers AI 额度）与 /scrape（触发 GitHub Actions，消耗 CI 分钟数）
 * 只应被「本站页面」调用。外部脚本（curl / 扫描器）直接拒绝。
 * 判定（满足任一即放行）：
 *   ① Origin 或 Referer 的 host 是本站域名（idol.wyc0518.cc，含 localhost 便于本地预览）；
 *   ② Sec-Fetch-Site 为 same-origin / same-site（现代浏览器 fetch 必带，脚本不会伪造）。
 * 正常粉丝在站点里点「翻译」「刷新」一定满足 ①（同源 fetch 必带 Referer）或 ②，不会被误伤；
 * 脚本 / 无头浏览器 / 第三方代抓一律拒绝 —— 它们不是同源，拿不到 same-origin，也不会带本站 Referer。
 * （初版曾放行 Sec-Fetch-Mode: navigate 方便调试，结果无头浏览器代抓也能绕过，已移除。）
 */
const SITE_HOSTS = new Set(['idol.wyc0518.cc', 'localhost', '127.0.0.1']);
function isSameSite(request) {
  const host = (h) => (h || '').toLowerCase();
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  for (const raw of [origin, referer]) {
    if (!raw) continue;
    try {
      if (SITE_HOSTS.has(host(new URL(raw).hostname))) return true;
    } catch (_) { /* 非法的 Origin/Referer，忽略 */ }
  }
  const site = (request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
  return site === 'same-origin' || site === 'same-site';
}
function forbiddenNotSameSite() {
  return json({ error: 'forbidden: same-site only' }, 403);
}

// 静态资源缓存策略：
//   HTML 与 /data/ 下的数据文件 → 强制「每次都向服务器校验」（no-cache + must-revalidate），
//   避免手机浏览器、CDN 长期缓存旧页面/旧数据（否则刷新后仍看到几小时前的内容）。
//   其余资源（css/js/图片）由构建注入 ?v=<时间戳> 做版本控制，可放心长缓存。
// 是否 HTML 页面请求（首页 / 目录 / .html）——决定缓存策略与是否注入 RUM beacon
function isHtmlPath(url) {
  const p = url.pathname;
  return p === '/' || p.endsWith('/') || p.endsWith('.html');
}

/* ---------------- Cloudflare Web Analytics（RUM）beacon 注入 ----------------
 * 站点跑在 Workers 上（静态资源经 env.ASSETS 提供），Cloudflare 的 RUM 自动注入
 * 不会作用于 Worker 产生的响应 ⇒ Web Analytics 收不到访客数据，只能手动注入。
 * 用 HTMLRewriter 流式改写 <head>（比整页 res.text() 省内存、不破坏响应流）；
 * 若拿到的是压缩响应则跳过——宁可不注入，也不返回一个坏页面。
 */
const RUM_TOKEN = 'c1ca5ef5789c483fb225ee3015fc3828';
const RUM_SNIPPET = '<script defer src="https://static.cloudflareinsights.com/beacon.min.js"'
  + ` data-cf-beacon='{"token":"${RUM_TOKEN}"}'></script>`;
class RumHeadHandler {
  element(el) { el.append(RUM_SNIPPET, { html: true }); }
}
async function injectRum(res) {
  if (!res || !res.ok) return res;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('text/html')) return res;
  if (res.headers.get('content-encoding')) return res;
  try {
    const headers = new Headers(res.headers);
    headers.delete('content-length');   // 内容被改写，原长度失效
    const src = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    return new HTMLRewriter().on('head', new RumHeadHandler()).transform(src);
  } catch (e) {
    return res;   // 注入失败就原样返回：宁可没统计，也不能让页面打不开
  }
}

function applyFreshPolicy(res, url) {
  if (!res || !res.headers) return res;
  const p = url.pathname;
  // 后台页（会重定向到无扩展名的 /admin-7f2a，绕开下面 HTML 的判定）：
  // 改完必须立刻能用，且 CDN 上也不该留一份拷贝 —— 直接 no-store。
  if (p.indexOf('/admin') === 0) {
    const ah = new Headers(res.headers);
    ah.set('Cache-Control', 'no-store');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: ah });
  }
  const isHtml = isHtmlPath(url);
  const isData = p.startsWith('/data/');
  // 带内容版本号的数据文件（如 /data/archive.js?v=<lastUpdated>）内容不可变：
  //   允许浏览器与 CDN 长期缓存（数据一变版本号就变 → URL 变 → 自动失效），
  //   这样重复访问不再重下十几 MB，只剩一次 500 字节的 meta.json 校验。
  const ver = url.searchParams.get('v');
  if (isData && ver) {
    const h = new Headers(res.headers);
    h.set('Cache-Control', 'public, max-age=31536000, immutable');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
  if (!isHtml && !isData) return res;
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-cache, must-revalidate');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// m2m100 需明确源语言；本站发言以中文为主
const SRC_LANG = 'zh';
const AI_MODEL = '@cf/meta/m2m100-1.2b';

/* ------------------------- 翻译使用统计（存 KV，供 /stats 查看） -------------------------
 * 复用已绑定的 KV 命名空间 env.SECRETS（本来只存 GH_TOKEN），键统一加 `stat:tr:` 前缀：
 *   stat:tr:total              累计调用次数
 *   stat:tr:lang:<tl>          按目标语言累计
 *   stat:tr:day:<YYYY-MM-DD>   按北京时间每日次数
 *   stat:tr:u:<day>:<ipHash>   当日出现的独立访客（只存 IP 的短哈希，不落明文 IP）
 * 统计失败一律静默（绝不能影响翻译本身）。
 */
// 站点动作统计的事件清单（前端 app.js 的 track() 上报）
const EVENTS = [
  ['tab:messages', '口袋发言 tab'],
  ['tab:live', '直播·录播 tab'],
  ['tab:performances', '公演 tab'],
  ['tab:schedule', '行程 tab'],
  ['tab:guide', '新粉指南 tab'],
  ['tab:mine', '我的·档案卡 tab'],
  // 档案卡漏斗：查 → 查没查到 → 有没有把卡片存下来。
  // 只记动作，绝不带上 uid；「没查到」直接反映历史补档的覆盖缺口（越高说明越该补档）。
  ['mine:query', '档案 查了一次'],
  ['mine:hit', '档案 查到了'],
  ['mine:miss', '档案 没查到'],
  ['mine:save', '档案 保存/分享卡片'],
  // 行程转发图：进了勾选模式 / 真的把图生成出来了（记了也不显示的老毛病见 EVENTS 是白名单）
  ['sch:pick', '行程 进入选图'],
  ['sch:poster', '行程 生成转发图'],
  ['sch:copy', '行程 复制文案'],
  ['sub:replay', '公演回放 子标签'],
  ['sub:cuts', '公演cut 子标签'],
  ['sub:social', '社媒美图 子标签'],
  ['sub:gallery', '公式照 子标签'],
  ['sub:exp', '经历备注 子标签'],
  ['play', '视频播放'],
  ['refresh', '手动刷新'],
  ['social:open', '美图点开大图'],
  ['bili', 'B 站跳转'],
  ['search', '搜索'],
  ['filter:date', '时间筛选']
];
const LANGS = ['en', 'es', 'fr', 'nl', 'pt', 'ro', 'ja', 'vi', 'ko', 'th'];
// 统计数据的读取密钥：只有带这个 key 才拿得到，避免统计接口挂在主域名上被随手访问。
// 可用 KV 里的 STATS_KEY 覆盖（无需改代码）。
const STATS_KEY = 'wyc-stats-2026';
const LANG_NAME = { en: '英语', es: '西班牙语', fr: '法语', nl: '荷兰语', pt: '葡萄牙语', ro: '罗马尼亚语', ja: '日语', vi: '越南语', ko: '韩语', th: '泰语' };
// 访客国家（request.cf.country，ISO 3166-1 alpha-2）→ 中文名。没收录的就原样显示代码。
// 香港/澳门/台湾按规范写「中国香港 / 中国澳门 / 中国台湾」。
const CC_NAME = {
  CN: '中国', HK: '中国香港', MO: '中国澳门', TW: '中国台湾',
  JP: '日本', KR: '韩国', SG: '新加坡', MY: '马来西亚', TH: '泰国', VN: '越南',
  ID: '印度尼西亚', PH: '菲律宾', IN: '印度', PK: '巴基斯坦', BD: '孟加拉国',
  LK: '斯里兰卡', NP: '尼泊尔', KH: '柬埔寨', MM: '缅甸', LA: '老挝', BN: '文莱',
  MN: '蒙古', KZ: '哈萨克斯坦', UZ: '乌兹别克斯坦',
  US: '美国', CA: '加拿大', MX: '墨西哥', BR: '巴西', AR: '阿根廷', CL: '智利', CO: '哥伦比亚',
  GB: '英国', IE: '爱尔兰', FR: '法国', DE: '德国', NL: '荷兰', BE: '比利时', LU: '卢森堡',
  CH: '瑞士', AT: '奥地利', IT: '意大利', ES: '西班牙', PT: '葡萄牙', GR: '希腊',
  SE: '瑞典', NO: '挪威', DK: '丹麦', FI: '芬兰', IS: '冰岛', PL: '波兰', CZ: '捷克',
  HU: '匈牙利', RO: '罗马尼亚', UA: '乌克兰', RU: '俄罗斯', TR: '土耳其', IL: '以色列',
  AE: '阿联酋', SA: '沙特阿拉伯', QA: '卡塔尔', KW: '科威特', EG: '埃及', ZA: '南非', NG: '尼日利亚',
  AU: '澳大利亚', NZ: '新西兰',
  T1: 'Tor 匿名网络', XX: '未知'
};
function p2(n) { return String(n).padStart(2, '0'); }
function bjDay(ts) { // 北京时间日期
  const d = new Date((ts == null ? Date.now() : ts) + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}
async function shortHash(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return Array.from(new Uint8Array(d)).slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function incKV(kv, k) {
  const n = Number((await kv.get(k)) || 0) + 1;
  await kv.put(k, String(n));
}
// 「独立访客」：把去重后的 IP 短哈希存成一个小 JSON 数组（单个动作最多几百个 → 几 KB）。
// 为什么不用「一个访客一个 KV 键」：那样读统计要 kv.list 分页、写也要多一次 put；
// 数组方案读统计只要 1 次 get/动作，且**同一访客重复点同一功能时直接 return，不再写盘**
// （KV 免费额度只有 1000 写/天，必须省着用）。
const UNIQ_CAP = 20000; // 兜底：极端情况下不让单个值无限长大（远超本站真实访客量级）
async function addUniq(kv, key, hash) {
  let arr = [];
  try {
    const raw = await kv.get(key);
    if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) arr = p; }
  } catch (_) { arr = []; }
  if (arr.includes(hash)) return; // 已记过 → 不写盘
  arr.push(hash);
  if (arr.length > UNIQ_CAP) arr = arr.slice(-UNIQ_CAP);
  await kv.put(key, JSON.stringify(arr));
}
async function readUniqCount(kv, key) {
  try {
    const raw = await kv.get(key);
    if (!raw) return 0;
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.length : 0;
  } catch (_) { return 0; }
}
async function bumpStat(env, tl, request) {
  try {
    const kv = env && env.SECRETS;
    if (!kv || typeof kv.get !== 'function') return;
    const day = bjDay();
    const ip = (request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '?').split(',')[0].trim();
    await incKV(kv, 'stat:tr:total');
    await incKV(kv, 'stat:tr:lang:' + tl);
    await incKV(kv, 'stat:tr:day:' + day);
    await kv.put(`stat:tr:u:${day}:${await shortHash(ip)}`, '1');
  } catch (_) { /* 统计失败不影响翻译 */ }
}

async function handleTranslate(request, url, env, ctx) {
  const q = url.searchParams.get('q');
  const tl = url.searchParams.get('tl') || 'en';
  if (!q) return json({ error: 'missing q' }, 400);

  // 记一次使用（waitUntil 不阻塞响应）。注意：**缓存命中也要计数**，
  // 否则同一段文字被多人反复翻译只会记 1 次，统计严重偏低。
  const count = () => {
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(bumpStat(env, tl, request));
    else bumpStat(env, tl, request).catch(() => {});
  };
  const ok = (obj) => { count(); return respondCached(obj, cache, cacheKey, ctx); };

  // 边缘缓存：同一段文本 24h 内不再重复推理/回源（省 AI 额度、降延迟）
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) { count(); return hit; }

  // 1) Workers AI（Cloudflare 边缘自推理）
  if (env && env.AI) {
    try {
      const out = await env.AI.run(AI_MODEL, { text: q, source_lang: SRC_LANG, target_lang: tl });
      const text = out && (out.translated_text || out.response || out.result);
      if (text && String(text).trim()) {
        return ok({ text: String(text).trim(), via: 'workers-ai' });
      }
    } catch (e) {
      // 落 Google 兜底
    }
  }

  // 2) 兜底：Google 公开接口（海外可用；数据中心 IP 可能被反滥用页拦）
  try {
    const api = new URL('https://translate.googleapis.com/translate_a/single');
    api.searchParams.set('client', 'gtx');
    api.searchParams.set('sl', 'auto');
    api.searchParams.set('dt', 't');
    api.searchParams.set('tl', tl);
    api.searchParams.set('q', q);
    const r = await fetch(api.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://translate.google.com/'
      }
    });
    const body = await r.text();
    if (!/<html/i.test(body)) {
      const d = JSON.parse(body);
      const text = ((d && d[0]) || []).map((s) => s[0]).join('');
      if (text) return ok({ text, via: 'google' });
    }
  } catch (e) {
    // 忽略
  }

  return json({ error: 'translate-failed' }, 502);
}

// 1x1 透明 GIF：track 请求的响应（浏览器把它当图片加载，不报错、不阻塞）
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));
function gif() {
  return new Response(GIF, {
    headers: { 'content-type': 'image/gif', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }
  });
}

// 站点动作统计：?e=<事件名>
async function handleTrack(url, request, env, ctx) {
  const raw = String(url.searchParams.get('e') || '').toLowerCase();
  // 只接受 [a-z0-9:_-]，避免任意键写进 KV
  const ev = raw.replace(/[^a-z0-9:_-]/g, '').slice(0, 40);
  if (ev) {
    const job = (async () => {
      try {
        const kv = env && env.SECRETS;
        if (!kv || typeof kv.get !== 'function') return;
        const day = bjDay();
        // ── 每日写入总闸 ──
        // 统计是「锦上添花」，绝不能把 KV 每天 1000 次的写入额度抢光、连累数据同步
        // （2026-09-22 事故）。超过上限就不再记录，页面照常用。
        // 2026-09-23 提到 600：补了档案卡 4 个埋点后事件变多，原 300 太容易在下午就打满、
        // 导致后半天的动作一个都不记。Workers 已转 Paid（KV 写 100 万/月），600/天很安全。
        const gateKey = 'stat:gate:' + day;
        const gateMax = 600;
        let used = 0;
        try { used = Number((await kv.get(gateKey)) || 0); } catch (_) { used = 0; }
        if (used >= gateMax) return;
        // 计数器本身也占写入 → 用 1/5 抽样自增（近似值，用于封顶足够）
        if (Math.random() < 0.2) { try { await kv.put(gateKey, String(used + 5)); } catch (_) {} }
        const ip = (request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '?').split(',')[0].trim();
        const hash = await shortHash(ip);
        await incKV(kv, 'stat:ev:' + ev);
        await incKV(kv, 'stat:evd:' + day + ':' + ev);
        // 该动作的独立访客（累计 / 当日）：按 IP 短哈希去重，重复访客不重复写盘
        await addUniq(kv, 'stat:evu:' + ev, hash);
        await addUniq(kv, `stat:evud:${day}:${ev}`, hash);
        // 站点级「当日独立访客」：原来每次上报都写一遍，改成只在当天首次出现时写（省 KV 写额度）
        const uKey = `stat:u:${day}:${hash}`;
        if (!(await kv.get(uKey))) {
          await kv.put(uKey, '1');
          // 访客国家：Cloudflare 每个请求都带（request.cf.country），不用前端传、也不碰 IP 明文。
          // 同样只在当天首次出现时记一次，所以一天最多写「国家数」条，几乎不占额度。
          const cc = String((request.cf && request.cf.country) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (cc) await incKV(kv, `stat:ctryu:${day}:${cc}`);
        }
      } catch (_) { /* 统计失败不影响页面 */ }
    })();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
  }
  return gif();
}

// 站长查看翻译使用情况：返回一张简单表格（累计次数 / 各语言 / 最近 7 天次数与独立访客）
async function handleStats(url, env) {
  // 站长看统计走 GitHub Pages（docs/stats.html），本域名上**不暴露任何统计页面**：
  // 未带正确 key 一律 404（看起来就像没有这个地址），带 key 才返回数据。
  const wantJson = url.searchParams.get('format') === 'json';
  const kv = env && env.SECRETS;
  let key = STATS_KEY;
  if (kv && typeof kv.get === 'function') {
    try { key = (await kv.get('STATS_KEY')) || STATS_KEY; } catch (_) { /* 用默认值 */ }
  }
  if (url.searchParams.get('k') !== key) {
    return new Response('Not Found', { status: 404 });
  }
  // 统计读起来很重（上百个 KV 键），缓存 60 秒：站长反复刷新页面不会每次都把 KV 打一遍
  const cacheKey = 'https://wyc-stats.local/stats?k=' + key + (wantJson ? '&format=json' : '&format=html');
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;
  } catch (_) { /* 没命中就自己算 */ }
  let res;
  try {
    res = await Promise.race([
      handleStatsBody(url, env, kv, wantJson),
      new Promise((_, rej) => setTimeout(() => rej(new Error('stats timeout')), 15000)),
    ]);
  } catch (_) {
    // 超时也要给响应，不能让浏览器一直挂着（否则前端等到自己的超时才报「读取失败」）
    return wantJson
      ? new Response(JSON.stringify({ error: 'stats-timeout' }), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }
      })
      : new Response('<meta charset="utf-8"><p>统计读取超时，请稍后重试</p>', {
        status: 503, headers: { 'content-type': 'text/html; charset=utf-8' }
      });
  }
  try { await caches.default.put(cacheKey, res.clone()); } catch (_) { /* 写不进就算了 */ }
  return res;
}

async function handleStatsBody(url, env, kv, wantJson) {
  // 注意：这里必须是可缓存的头（no-store 的话 caches.default.put 存不进去）
  const html = (s) => new Response(s, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' }
  });
  if (!kv || typeof kv.get !== 'function') {
    return html('<meta charset="utf-8"><p>统计未启用：Worker 未绑定 KV 命名空间。</p>');
  }
  // 🔴 别再一个一个 await：34 个事件 × 4 + 7 天 × 3 + 10 种语言 … 共 169 次串行 KV 读，
  // 累计 30s+ 直接把 GitHub Pages 上那个 8 秒超时的统计页拖成「读取失败」。这里全部并发。
  const days7 = [];
  for (let i = 0; i < 7; i++) days7.push(bjDay(Date.now() - i * 86400000));
  const evDefs = EVENTS.concat(LANGS.map((l) => ['lang:' + l, '切换为' + (LANG_NAME[l] || l)]));
  const evToday = days7[0];
  const g = (k) => kv.get(k).catch(() => null);
  const ls = (p, lim) => kv.list(lim ? { prefix: p, limit: lim } : { prefix: p }).catch(() => null);

  const [totalRaw, langVals, dayVals, trUvLists, siteUvLists, ctryLists, evTotals, evDayVals, evUniqT, evUniqD] = await Promise.all([
    g('stat:tr:total'),
    Promise.all(LANGS.map((l) => g('stat:tr:lang:' + l))),
    Promise.all(days7.map((d) => g('stat:tr:day:' + d))),
    Promise.all(days7.map((d) => ls(`stat:tr:u:${d}:`))),
    Promise.all(days7.map((d) => ls(`stat:u:${d}:`, 1000))),
    Promise.all(days7.map((d) => ls(`stat:ctryu:${d}:`, 200))),   // 当天都出现过哪些国家
    Promise.all(evDefs.map((e) => g('stat:ev:' + e[0]))),
    Promise.all(evDefs.map((e) => g(`stat:evd:${evToday}:${e[0]}`))),
    Promise.all(evDefs.map((e) => readUniqCount(kv, 'stat:evu:' + e[0]))),
    Promise.all(evDefs.map((e) => readUniqCount(kv, `stat:evud:${evToday}:${e[0]}`))),
  ]);

  const total = Number(totalRaw || 0);

  const langRows = [];
  LANGS.forEach((l, i) => {
    const n = Number(langVals[i] || 0);
    if (n > 0) langRows.push([l, n]);
  });
  langRows.sort((a, b) => b[1] - a[1]);

  // 「今日独立访客」原先取的是**翻译功能**的 UV，结果翻译没人用就显示 0，
  // 全站到底来了多少人一直看不到。改成站点级 UV（stat:u:<day>:<hash>，
  // 每个访客当天首次出现时写一条），7 天各算一次。
  const days = days7.map((d, i) => [
    d,
    Number(dayVals[i] || 0),
    (trUvLists[i] && trUvLists[i].keys) ? trUvLists[i].keys.length : 0,
    (siteUvLists[i] && siteUvLists[i].keys) ? siteUvLists[i].keys.length : 0,
  ]);
  const siteUvToday = days[0][3];

  // 访客国家：list 只给键名不给值，所以先列出 7 天出现过的国家，再并发把这些键的值读出来
  const ccSet = new Set();
  (ctryLists || []).forEach((l) => ((l && l.keys) || []).forEach((k) => {
    const cc = String((k && k.name) || '').split(':').pop();
    if (cc) ccSet.add(cc);
  }));
  const ccs = Array.from(ccSet);
  const ctryVals = await Promise.all(days7.map((d) => Promise.all(ccs.map((c) => g(`stat:ctryu:${d}:${c}`)))));
  const countries = ccs.map((c, ci) => {
    const per = days7.map((d, di) => Number(ctryVals[di][ci] || 0));
    return {
      cc: c,
      name: CC_NAME[c] || c,
      today: per[0],
      d7: per.reduce((a, b) => a + b, 0),
    };
  });
  countries.sort((a, b) => (b.d7 - a.d7) || (b.today - a.today));

  const langHtml = langRows.length
    ? langRows.map(([l, n]) => `<tr><td>${LANG_NAME[l] || l}</td><td class="n">${n}</td></tr>`).join('')
    : '<tr><td colspan="2" class="dim">暂无记录</td></tr>';
  const dayHtml = days.map(([d, n, u, su]) => `<tr><td>${d}</td><td class="n">${su}</td><td class="n">${n}</td><td class="n">${u}</td></tr>`).join('');

  // 站点动作（tab 切换 / 视频播放 / 刷新 / 搜索 …）
  // 除「次数」外还算「独立访客」：累计 = 该功能一共有多少人来用过，今日 = 今天有多少人用过。
  const evList = [];
  evDefs.forEach(([key, name], i) => {
    const t = Number(evTotals[i] || 0);
    const d = Number(evDayVals[i] || 0);
    if (t <= 0 && d <= 0) return;
    evList.push({ key: key, name: name, total: t, today: d, uniqTotal: evUniqT[i] || 0, uniqToday: evUniqD[i] || 0 });
  });
  evList.sort((a, b) => b.total - a.total);
  const evHtml = evList.length
    ? evList.map((e) => `<tr><td>${e.name}</td><td class="n">${e.total}</td><td class="n">${e.today}</td>`
      + `<td class="n">${e.uniqTotal}</td><td class="n">${e.uniqToday}</td></tr>`).join('')
    : '<tr><td colspan="5" class="dim">暂无记录</td></tr>';
  const ctryHtml = countries.length
    ? countries.map((c) => `<tr><td>${c.name}</td><td class="n">${c.today}</td><td class="n">${c.d7}</td></tr>`).join('')
    : '<tr><td colspan="3" class="dim">暂无记录（从启用当天开始累计）</td></tr>';

  // JSON 模式：给 GitHub Pages 上的统计页面跨域读取（docs/stats.html）
  if (wantJson) {
    return new Response(JSON.stringify({
      total,
      today: { day: days[0][0], count: days[0][1], visitors: siteUvToday },
      siteUvToday,
      langs: langRows.map(([l, n]) => ({ lang: l, name: LANG_NAME[l] || l, count: n })),
      days: days.map(([d, n, u, su]) => ({ day: d, count: n, visitors: u, siteUv: su })),
      countries: countries,
      events: evList
    }), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=60',
        'access-control-allow-origin': '*'
      }
    });
  }

  return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>翻译使用统计</title>
<style>
 body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#12131a;color:#e8eaf2;margin:0;padding:24px}
 h1{font-size:19px;margin:0 0 4px} .dim{color:#8b90a0;font-size:13px;margin:0 0 18px}
 .cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
 .card{background:#1c1f2b;border-radius:12px;padding:14px 18px;min-width:120px}
 .card .k{font-size:12px;color:#8b90a0} .card .v{font-size:24px;font-weight:700;margin-top:4px}
 h2{font-size:15px;margin:18px 0 8px}
 table{border-collapse:collapse;width:100%;max-width:640px;background:#1c1f2b;border-radius:10px;overflow:hidden}
 td{padding:8px 12px;border-bottom:1px solid #2a2e3d;font-size:14px}
 tr:last-child td{border-bottom:none} td.n{text-align:right;font-variant-numeric:tabular-nums}
</style>
<h1>翻译功能使用统计</h1>
<p class="dim">累计统计自启用之时；「独立访客」按 IP 短哈希去重估算（不保存明文 IP），同一 WiFi 下多人会算作 1 人，实际人数只会更多。KV 有约 1 分钟同步延迟。</p>
<div class="cards"><div class="card"><div class="k">累计翻译次数</div><div class="v">${total}</div></div>
<div class="card"><div class="k">今日次数</div><div class="v">${days[0][1]}</div></div>
<div class="card"><div class="k">今日独立访客</div><div class="v">${siteUvToday}</div></div></div>
<h2>各语言使用次数</h2><table>${langHtml}</table>
<h2>访客来自哪里（今日 / 近 7 天）</h2><table><tr><td>国家·地区</td><td class="n">今日</td><td class="n">近 7 天</td></tr>${ctryHtml}</table>
<p class="dim">按 Cloudflare 给出的国家（ISO 代码）统计独立访客，不记 IP 明文。近 7 天＝每天独立访客相加，同一个人多天都来会重复计；数据从启用当天开始累计。</p>
<h2>功能使用（次数 / 独立访客）</h2><table><tr><td>动作</td><td class="n">累计</td><td class="n">今日</td><td class="n">独立累计</td><td class="n">独立今日</td></tr>${evHtml}</table>
<h2>最近 7 天（每天来了多少人 / 翻译次数）</h2><table><tr><td>日期</td><td class="n">到访人数</td><td class="n">翻译次数</td><td class="n">翻译访客</td></tr>${dayHtml}</table>`);
}

// 手动触发抓取：调用 GitHub REST API 触发 scrape.yml 的 workflow_dispatch。
// 需要 env.GH_TOKEN（具备 actions:write 的 PAT，由 wrangler secret put 配置）
// 与 env.REPO（owner/repo，默认值见 wrangler.jsonc 的 vars）。
// 自带很短的服务端冷却（1 分钟，只用于防止同一秒被重复点击打爆 GitHub Actions）：
// 粉丝点「刷新」应当**立即**真的触发抓取，不再像以前那样被 15 分钟冷却挡住。
const SCRAPE_COOLDOWN_MIN = 1;
async function handleScrape(env) {
  const repo = (env && env.REPO) || 'winccctan/wangyuchen-archive';
  // token 来源：优先 KV（运行时读取，Git 构建也能用），否则退回 dashboard Secret(env.GH_TOKEN)
  let token = env && env.GH_TOKEN;
  if (!token && env && env.SECRETS && typeof env.SECRETS.get === 'function') {
    token = await env.SECRETS.get('GH_TOKEN');
  }
  const ref = (env && env.SCRAPE_REF) || 'main';
  if (!token) {
    return json({ error: 'worker-missing-gh-token', hint: '请在 Cloudflare KV 命名空间 SECRETS 中存入键 GH_TOKEN' }, 500);
  }
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'wyc-archive-worker'
  };
  // 1) 冷却检查：查最近一次运行，15 分钟内则跳过
  try {
    const runsApi = `https://api.github.com/repos/${repo}/actions/workflows/scrape.yml/runs?per_page=1`;
    const runsRes = await fetch(runsApi, { headers });
    if (runsRes.ok) {
      const runs = await runsRes.json();
      const last = runs.workflow_runs && runs.workflow_runs[0];
      if (last && last.created_at) {
        const elapsedMin = (Date.now() - new Date(last.created_at).getTime()) / 60000;
        if (elapsedMin < SCRAPE_COOLDOWN_MIN) {
          return json({ ok: true, skipped: true, message: '近期已抓取，稍候刷新即可' });
        }
      }
    }
  } catch (_) { /* 查冷却失败不阻断触发 */ }
  // 2) 真正触发
  const api = `https://api.github.com/repos/${repo}/actions/workflows/scrape.yml/dispatches`;
  try {
    const r = await fetch(api, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ref })
    });
    if (r.status === 204) {
      return json({ ok: true, message: '已触发抓取，约 1~3 分钟后刷新即可看到最新' });
    }
    const t = await r.text();
    return json({ ok: false, status: r.status, body: t.slice(0, 400) }, 502);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  }
}

// 图片代理：把微博图床（sinaimg.cn / weibocdn.com）图片转发给浏览器。
// 关键：用非浏览器 UA（如 curl）取图，绕过新浪 Tengine 对浏览器 UA 的 403；
// 仅放行这两个图床域名，避免变成开放代理；边缘缓存 1 年（图片 URL 含尺寸后缀，内容不可变）。
async function handleImageProxy(url, ctx) {
  const target = url.searchParams.get('u');
  if (!target) return new Response('missing u', { status: 400 });
  let t;
  try { t = new URL(target); } catch (e) { return new Response('bad url', { status: 400 }); }
  if (!/^https?:$/i.test(t.protocol)) return new Response('bad protocol', { status: 400 });
  if (!/(^|\.)sinaimg\.cn$|(^|\.)weibocdn\.com$/.test(t.hostname)) {
    return new Response('forbidden host', { status: 403 });
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const upstream = await fetch(t.toString(), {
    headers: {
      // 非浏览器 UA：新浪 Tengine 据此放行（浏览器 UA 一律 403）
      'User-Agent': 'curl/8.7.1',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
    }
  });
  if (!upstream.ok) {
    return new Response('upstream ' + upstream.status, { status: 502 });
  }
  const headers = new Headers(upstream.headers);
  const ct = headers.get('content-type') || 'image/jpeg';
  headers.set('content-type', ct);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('access-control-allow-origin', '*');
  const res = new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// 成功结果：加长缓存并写入边缘缓存
function respondCached(obj, cache, cacheKey, ctx) {
  const res = json(obj, 200);
  res.headers.set('cache-control', 'public, max-age=86400');
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }
  });
}
/* ------------------------- 数据 API（数据存 KV 命名空间 env.KV） -------------------------
 * 设计要点：
 *   - 口袋发言按「月」分键：msg/YYYY-MM。单月体积远小于 KV 单值 25MB 上限，
 *     故数据可无限增长、永远不会被容量卡死；浏览器首屏拉 /api/index（含 recent 最新若干条 + 月份列表），
 *     下滑「加载更早」再惰性拉历史月。
 *   - 读取接口公开（前端同源 fetch 即可）；写入 /api/sync 需 SYNC_TOKEN（存在 SECRETS KV，键名 SYNC_TOKEN）。
 *   - 抓取仍由 GitHub Actions（Node）完成：scripts/sync-kv.mjs 读 site/data/archive.js（已加工成品：
 *     公演按「她的公演记录」筛选 + 挂 B 站备用源 + 失效流域名修正 + 消息瘦身），
 *     只推「可能再变的近期数据」，Worker 在边缘**并集合并**写入 KV。
 *   - ★ 合并语义 = 只增不删：Actions 每次从仓库快照出发，本地并不含 KV 里最新的全部历史，
 *     若用「整月覆盖」会把 KV 里较新的发言/直播整段抹掉。故一律按唯一键并集：
 *     发言按 msgIdServer（缺则文本哈希）、直播/公演按 liveId、其余小数据（社媒美图/公演 cut）整体替换。
 *   - ★ 只在内容真变化时落盘：Worker 先读旧值做规范化比较（stableStringify），相同就跳过写。
 *     否则每 3 分钟一轮会把 KV 免费额度（1000 写/天）瞬间打爆。
 */

/* ------------------------- 边缘缓存（Cache API） -------------------------
 * 为什么必须自己缓存：Worker 的响应**不会**自动进 Cloudflare CDN 缓存，
 * 而前端一次加载要读 44 个月 ≈ 5.5 万条发言。D1 免费版只有 500 万行读/天，
 * 约 90 次全量访问就打满（打满后虽能回退 KV，但等于白架了 D1）。
 * 这里在 Worker 内部用 Cache API 兜住：历史月 12h、当月 60s、其余 5min。
 */
async function withEdgeCache(key, ttl, make) {
  let cache = null;
  try { cache = caches.default; } catch (_) { cache = null; }
  const ck = 'https://wyc-edge-cache.local' + key;
  if (cache) {
    try {
      const hit = await cache.match(ck);
      if (hit) {
        const r = new Response(hit.body, hit);
        r.headers.set('x-wyc-cache', 'hit');
        return r;
      }
    } catch (_) { /* 命中失败就当没命中 */ }
  }
  const res = await make();
  try {
    if (cache && res && res.status === 200) {
      const c = res.clone();
      c.headers.set('cache-control', 'public, max-age=' + ttl);
      res.headers.set('x-wyc-cache', 'miss');
      await cache.put(ck, c);
      return res;
    }
    if (res) res.headers.set('x-wyc-cache', 'bypass');
  } catch (_) { /* 写缓存失败不影响正常响应 */ }
  return res;
}

function apiJson(obj, cacheControl) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheControl || 'no-store',
      'access-control-allow-origin': '*'
    }
  });
}

// 与前端 app.js 的 msgKey 同源的去重键（不要求算法一致，只要各自稳定即可）
function strHash(s) {
  let h = 5381;
  s = String(s || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function msgKeyOf(m) {
  return m.msgIdServer || ('k' + strHash((m.text || '') + ((m.reply && m.reply.text) || '') + (m.msgTime || '')));
}
function byTimeDesc(a, b) {
  return (Number(b.msgTime) || 0) - (Number(a.msgTime) || 0);
}

// 规范化序列化（对象键排序、递归）：让「读回来的旧值」和「新拼好的值」可以直接字符串比较，
// 不会因为字段顺序不同而误判为「有变化」→ 避免每轮都白写一遍。
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  const parts = [];
  for (const k of keys) {
    if (v[k] === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + stableStringify(v[k]));
  }
  return '{' + parts.join(',') + '}';
}

// 「每次抓取都会变、但不代表内容真的变了」的顶层字段。
// ⚠️ live-cuts.js / performance-cuts.js 顶层都带 updatedAt（抓取时间），live-cuts 还带 progress（断点续传）。
// 旧实现是拿整个 JSON 串比对，于是这两个键**每轮同步都被判定为「变了」→ 每轮都写**，
// 还会把 dataChanged 置真、连 index 一起写 —— 一轮 3~4 写 × 288 轮/天，直接吃满
// Cloudflare KV 免费版 1000 次写/天的额度（2026-09-22 事故根因）。
// 比较「是否值得写盘」时剔除这些字段，只在真正的数据变化时才写。
const VOLATILE_KEYS = ['updatedAt', 'lastUpdated', 'fetchedAt', 'generatedAt', 'progress'];
function contentSig(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = {};
    for (const k of Object.keys(v)) if (VOLATILE_KEYS.indexOf(k) < 0) o[k] = v[k];
    return stableStringify(o);
  }
  return stableStringify(v);
}

function safeParseArr(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

// /api/sync 写权限：比对请求头 x-sync-token 与 SECRETS KV 里的 SYNC_TOKEN
async function isSyncAuthorized(request, env) {
  const tok = request.headers.get('x-sync-token') || '';
  if (!tok) return false;
  let expect = env && env.SYNC_TOKEN;
  if (!expect && env && env.SECRETS && typeof env.SECRETS.get === 'function') {
    try { expect = await env.SECRETS.get('SYNC_TOKEN'); } catch (_) { /* 忽略 */ }
  }
  return !!expect && tok === expect;
}

/** 临时授权：证明「持有本仓库的有效 PAT」（回填结束后删除）
 *  本机没有 SYNC_TOKEN 副本，而 SECRETS KV 里的 GH_TOKEN 与本地不是同一个；
 *  所以改用「拿 token 去 GitHub 验一次身份，login 必须是仓库 owner」来放行。 */
async function isGhAuthorized(request, env) {
  const gh = request.headers.get('x-gh-token') || '';
  if (!gh) return false;
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: { 'user-agent': 'wyc-archive', authorization: 'Bearer ' + gh }
    });
    if (!r.ok) return false;
    const u = await r.json();
    return !!u && String(u.login) === 'winccctan';
  } catch (_) { return false; }
}

async function handleApi(url, request, env, ctx) {
  const p = url.pathname;
  // index 带 meta.lastUpdated，刷新按钮靠它比对 → 只缓存 15s，不影响「刷新」的即时性
  if (p === '/api/index') return withEdgeCache('/api/index', 15, () => handleApiIndex(env));
  if (p === '/api/month') return handleApiMonth(url, env);
  if (p === '/api/live') return withEdgeCache('/api/live', 300, () => handleApiKey('live', env));
  if (p === '/api/performances') return withEdgeCache('/api/performances', 300, () => handleApiKey('performances', env));
  if (p === '/api/social') return withEdgeCache('/api/social', 300, () => handleApiKey('social', env));
  if (p === '/api/perf-cuts') return withEdgeCache('/api/perf-cuts', 300, () => handleApiKey('perf-cuts', env));
  if (p === '/api/live-cuts') return withEdgeCache('/api/live-cuts', 300, () => handleApiKey('live-cuts', env));
  // ---- 粉丝个人档案：凭 uid 只取回「你自己」的那一份 ----
  // 隐私红线（站长 2026-09-22 定）：粉丝名单不得以任何静态文件形式上公网；
  // 浏览器download不到全量 ⇒ 无从遍历。真实 uid 是 9~10 位随机数，本身即不可猜测的凭证。
  if (p === '/api/mine' && request.method === 'POST') return handleApiMine(request, env);
  // 写接口（需 SYNC_TOKEN，由 CI / 本地脚本调用）
  if (p === '/api/_fans_init' && request.method === 'POST') return handleFansInit(request, env);
  if (p === '/api/_fans_upsert' && request.method === 'POST') return handleFansUpsert(request, env);
  if (p === '/api/_fans_ready' && (request.method === 'GET' || request.method === 'POST')) return handleFansReady(request, env);
  // ---- 第三方礼物榜覆盖表：带 uid，只存 D1，读写都要鉴权（绝不进 GitHub 仓库）----
  if (p === '/api/_gift_override') {
    if (!(await authorizedForWrite(request, env))) return json({ error: 'forbidden: sync token required' }, 403);
    return handleGiftOverride(request, env, url);
  }
  if (p === '/api/_gift_override_bootstrap' && request.method === 'POST') {
    if (!(await authorizedForWrite(request, env))) return json({ error: 'forbidden: sync token required' }, 403);
    return handleGiftOverrideBootstrap(request, env);
  }
  // ---- 底层回填：把含 uid 的原始发言整月覆盖写回（历史存量补 uid 用） ----
  if (p === '/api/_d1_refill' && request.method === 'POST') {
    if (!(await authorizedForWrite(request, env))) {
      return json({ error: 'forbidden: sync token required' }, 403);
    }
    return handleD1Refill(request, env);
  }

  /* ---- 行程存档 / 手机后台（站长专用）----
   * GET  /api/schedule        公开读，边缘缓存 60s（行程页读它，读不到就回退本地 js 文件）
   * POST /api/admin/login     密码换 token
   * GET  /api/admin/schedule  取当前行程 + 最近提交日志（需 token）
   * POST /api/admin/schedule  发布行程：默认**去重合并（只增不删）**，可传 replace/remove 纠错（需 token）
   * POST /api/admin/parse     把粘贴的微博正文解析成条目（需 token）
   * POST /api/admin/pass      改后台密码（需 token）
   */
  if (p === '/api/schedule') return withEdgeCache('/api/schedule', 60, () => handleScheduleGet(env));
  if (p === '/api/admin/login' && request.method === 'POST') return handleAdminLogin(request, env);
  if (p === '/api/admin/schedule') {
    if (!(await adminOk(request, env))) return json({ error: 'forbidden: admin token required' }, 403);
    return (request.method === 'POST') ? handleAdminSchedulePost(request, env) : handleAdminScheduleGet(env);
  }
  if (p === '/api/admin/parse' && request.method === 'POST') {
    if (!(await adminOk(request, env))) return json({ error: 'forbidden: admin token required' }, 403);
    return handleAdminParse(request, env);
  }
  if (p === '/api/admin/pass' && request.method === 'POST') {
    if (!(await adminOk(request, env))) return json({ error: 'forbidden: admin token required' }, 403);
    return handleAdminPass(request, env);
  }
  if (p === '/api/sync' && request.method === 'POST') {
    if (!(await isSyncAuthorized(request, env))) return json({ error: 'forbidden: sync token required' }, 403);
    return handleApiSync(request, env, ctx);
  }
  return json({ error: 'unknown api: ' + p }, 404);
}

/* ------------------------- 粉丝档案（fans 表） -------------------------
 * 为什么必须走服务端查询：只要把「280 人 × 金额」的名单文件放上 CDN，
 * 别人 curl 一下就全拿走了（哪怕删掉 uid）。所以名单只存 D1，
 * 前端只能凭 uid 单条回取，且一轮 batches 也只能拿到自己那份。
 *
 * D1 表：fans(uid TEXT PRIMARY KEY, nick TEXT, total INTEGER, data TEXT, updatedAt INTEGER)
 *   data 里是该粉丝自己的完整画像（直播/房间/发言/排名），永远不含他人信息。
 */
const MINE_RATE = new Map();   // ip -> { n, reset }（进程内滑动窗口，够挡住批量遍历）
function mineRateOk(ip, limit = 40, winMs = 10 * 60 * 1000) {
  const now = Date.now();
  const r = MINE_RATE.get(ip);
  if (!r || now > r.reset) { MINE_RATE.set(ip, { n: 1, reset: now + winMs }); return true; }
  if (r.n >= limit) return false;
  r.n += 1;
  return true;
}

async function handleApiMine(request, env) {
  const ip = String(request.headers.get('cf-connecting-ip') || 'unknown');
  if (!mineRateOk(ip)) return json({ error: '稍慢一点再试' }, 429);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const uid = String(body.uid || '').trim();
  if (!/^\d{4,12}$/.test(uid)) return json({ error: 'uid 是纯数字' }, 400);
  if (!env || !env.DB) return json({ error: 'd1-not-bound' }, 500);

  const kv = (env && env.KV && typeof env.KV.get === 'function') ? env.KV : null;

  // 覆盖区间 + 就绪标记：先查 KV 副本，没有再查 D1。
  // （D1 免费版行读配额容易打满，KV 读 10 万/天宽裕得多，所以 KV 是查询主路径。）
  let cov = null;
  if (kv) {
    try { const r = await kv.get('fan/__ready__'); if (r) cov = JSON.parse(r); } catch (_) { cov = null; }
  }
  if (!cov && env && env.DB) {
    let ready = null;
    try {
      ready = await env.DB.prepare("SELECT data AS d FROM fans WHERE uid = '__ready__'").first();
    } catch {
      return json({ error: '档案还在准备中，过一会儿再来看看～' }, 503);
    }
    if (ready) { try { cov = JSON.parse(ready.d || '{}'); } catch { cov = {}; } }
  }
  // 首次全量灌库要跑很久，期间没有数据 —— 必须和「查不到这个人」区分开，
  // 否则所有人都会看到「你没在房间里留过记录」。
  if (!cov) return json({ error: '档案正在生成（首次需要跑一段时间），过一会儿再来看看～' }, 503);

  let data = null, nick = '';
  if (kv) {
    try {
      const b = await kv.get('fan/' + uid.slice(-2));       // 按 uid 末两位分桶
      if (b) { const map = JSON.parse(b) || {}; if (map[uid]) { data = map[uid]; } }
    } catch (_) { data = null; }
  }
  if (!data && env && env.DB) {
    try {
      const row = await env.DB.prepare('SELECT nick, data FROM fans WHERE uid = ?').bind(uid).first();
      if (row) { try { data = JSON.parse(row.data || '{}'); } catch { data = {}; } nick = row.nick || ''; }
    } catch (_) { data = null; }
  }
  if (!data) {
    // 档案只覆盖部分时段时，查不到 ≠ 没记录。带上覆盖起点让前端说实话。
    const FLOOR = Date.parse('2022-11-01T00:00:00+08:00');
    if (cov.since && cov.since > FLOOR + 86400e3) return json({ found: false, partial: true, since: cov.since });
    return json({ found: false });
  }
  return json(Object.assign({ found: true }, data, {
    nick: nick || data.nick || '',
    since: cov.since || 0,                       // 档案覆盖起点（0 = 已全量）
  }));
}

/** 写接口统一授权：正常走 x-sync-token；临时允许「PAT 验明仓库 owner」（回填/灌库结束后整段删除） */
async function authorizedForWrite(request, env) {
  return (await isSyncAuthorized(request, env)) || (await isGhAuthorized(request, env));
}

async function handleFansInit(request, env) {
  if (!(await authorizedForWrite(request, env))) return json({ error: 'forbidden: sync token required' }, 403);
  if (!env || !env.DB) return json({ error: 'd1-not-bound' }, 500);
  await env.DB.exec(
    'CREATE TABLE IF NOT EXISTS fans (' +
    '  uid TEXT PRIMARY KEY,' +
    '  nick TEXT,' +
    '  total INTEGER DEFAULT 0,' +
    '  data TEXT NOT NULL,' +
    '  updatedAt INTEGER DEFAULT 0' +
    ');' +
    'CREATE INDEX IF NOT EXISTS idx_fans_total ON fans(total DESC);'
  );
  // 重新灌库 → 先清掉就绪标记，期间 /api/mine 会明确告知「正在生成」
  await env.DB.prepare("DELETE FROM fans WHERE uid = '__ready__'").run();
  const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM fans').first();
  return json({ ok: true, rows: (c && c.n) || 0 });
}

/** 只读：线上档案的就绪标记（人数 / 覆盖起点 / 直播是否已跑）。
 *  用途是灌库前的「人数骤降保护」—— 整桶覆盖没有部分更新，必须先在本地判断
 *  这一份是不是比线上还少（少就说明抓取缓存不完整，别灌）。需要写权限，避免
 *  对外开放人数这种内部指标。 */
async function handleFansReady(request, env) {
  if (!(await authorizedForWrite(request, env))) return json({ error: 'forbidden: sync token required' }, 403);
  let cov = null;
  const kv = (env && env.KV && typeof env.KV.get === 'function') ? env.KV : null;
  if (kv) {
    try { const r = await kv.get('fan/__ready__'); if (r) cov = JSON.parse(r); } catch (_) { cov = null; }
  }
  if (!cov && env && env.DB) {
    try {
      const row = await env.DB.prepare("SELECT data AS d FROM fans WHERE uid = '__ready__'").first();
      if (row) cov = JSON.parse(row.d || '{}');
    } catch (_) { /* 读不到就当没有 */ }
  }
  return json({
    ready: !!cov,
    people: (cov && Number(cov.people)) || 0,
    since: (cov && Number(cov.since)) || 0,
    liveDone: !!(cov && cov.liveDone),
  });
}

async function handleFansUpsert(request, env) {
  if (!(await authorizedForWrite(request, env))) return json({ error: 'forbidden: sync token required' }, 403);
  if (!env || !env.DB) return json({ error: 'd1-not-bound' }, 500);
  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const kv = (env && env.KV && typeof env.KV.put === 'function') ? env.KV : null;

  // ready:true → 灌库收尾，打上就绪标记（此后 /api/mine 才对外发档案）
  if (body.ready === true) {
    // coverage：本批档案实际覆盖到哪天（首次全量要跑很久，中途会先灌一批开放测试）。
    // /api/mine 查不到人时用它区分「你真的没记录」和「历史还没补到」。
    const cov = (body.coverage && typeof body.coverage === 'object') ? body.coverage : {};
    const covJson = JSON.stringify({ since: Number(cov.since) || 0, liveDone: !!cov.liveDone, people: Number(cov.people) || 0 });
    if (kv) await kv.put('fan/__ready__', covJson);
    try {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO fans (uid, nick, total, data, updatedAt) VALUES ('__ready__', '', 0, ?, ?)"
      ).bind(covJson, Date.now()).run();
    } catch (_) { /* D1 写不动没关系，KV 已经是权威副本 */ }
    if (!rows.length) return json({ ok: true, written: 0, ready: true });
  }

  // bucket + replace：整桶覆盖写 KV（查询主路径）。D1 只做尽力同步。
  if (body.bucket) {
    const b = String(body.bucket).replace(/\D/g, '').slice(0, 4);
    const map = {};
    for (const r of rows) { const u = String(r.uid || ''); if (/^\d{1,12}$/.test(u)) map[u] = r; }
    if (kv) await kv.put('fan/' + b, JSON.stringify(map));
    let d1 = 0;
    try {
      for (let i = 0; i < rows.length; i += 100) {
        const stmts = rows.slice(i, i + 100).map((r) => env.DB.prepare(
          'INSERT OR REPLACE INTO fans (uid, nick, total, data, updatedAt) VALUES (?, ?, ?, ?, ?)'
        ).bind(String(r.uid), String(r.nick || '').slice(0, 64), Number(r.total) || 0, JSON.stringify(r), Date.now()));
        if (stmts.length) { await env.DB.batch(stmts); d1 += stmts.length; }
      }
    } catch (_) { /* 忽略：KV 已写入 */ }
    return json({ ok: true, bucket: b, written: Object.keys(map).length, d1 });
  }
  if (!rows.length) return json({ ok: true, written: 0 });
  if (rows.length > 2000) return json({ error: '单批最多 2000 条' }, 400);
  const now = Date.now();
  let written = 0;
  const CH = 100;                       // D1 batch 每批 ≤100 条
  try {
    for (let i = 0; i < rows.length; i += CH) {
      const stmts = rows.slice(i, i + CH).map((r) => {
        const uid = String(r.uid || '');
        if (!/^\d{1,12}$/.test(uid)) return null;
        return env.DB.prepare(
          'INSERT OR REPLACE INTO fans (uid, nick, total, data, updatedAt) VALUES (?, ?, ?, ?, ?)'
        ).bind(uid, String(r.nick || '').slice(0, 64), Number(r.total) || 0, JSON.stringify(r), now);
      }).filter(Boolean);
      if (stmts.length) { await env.DB.batch(stmts); written += stmts.length; }
    }
  } catch (e) {
    // D1 抛错在线上只剩一个 1101 页面，根本没法定位 —— 把消息带回去
    return json({ ok: false, written, d1Error: String((e && e.message) || e).slice(0, 300) }, 500);
  }
  let rowsN = 0;
  try { const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM fans').first(); rowsN = (c && c.n) || 0; } catch (_) {}
  return json({ ok: true, written, rows: rowsN });
}

/* ------------------------- 第三方礼物榜覆盖表（gift_override） -------------------------
 * 榜单内容是「uid → 鸡腿」，属于粉丝名单 —— 绝不能出现在 GitHub 仓库或任何静态文件里。
 * 以前的做法是把 sha256 脱敏表 commit 进仓库给 CI 读；2026-09-23 起改为只存 D1：
 * 仓库里一份榜单数据都没有，build-fans（本机用 GH_TOKEN、CI 用 SYNC_TOKEN）从 D1 读写。
 *
 * D1 表：gift_override(uid, period, v, rank, nick, updatedAt, PRIMARY KEY(uid, period))
 *   period = '2026'（2026 年度）| '2024plus'（2024 年起累计）
 */
const GIFT_OVERRIDE_DDL =
  'CREATE TABLE IF NOT EXISTS gift_override (' +
  '  uid TEXT NOT NULL,' +
  '  period TEXT NOT NULL,' +
  '  v INTEGER NOT NULL DEFAULT 0,' +
  '  rank INTEGER NOT NULL DEFAULT 0,' +
  '  nick TEXT,' +
  '  updatedAt INTEGER DEFAULT 0,' +
  '  PRIMARY KEY (uid, period)' +
  ');';

async function handleGiftOverride(request, env, url) {
  if (!env || !env.DB) return json({ error: 'd1-not-bound' }, 500);
  await env.DB.exec(GIFT_OVERRIDE_DDL);

  if (request.method === 'GET') {
    const period = String(url.searchParams.get('period') || '');
    if (!period) return json({ error: 'period required' }, 400);
    const r = await env.DB.prepare('SELECT uid, nick, v, rank FROM gift_override WHERE period = ?').bind(period).all();
    return json({
      period,
      rows: (r.results || []).map((x) => ({
        uid: String(x.uid), nick: x.nick || '', v: Number(x.v) || 0, rank: Number(x.rank) || 0,
      })),
    });
  }

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const period = String(body.period || '');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!period) return json({ error: 'period required' }, 400);
  if (!rows.length) return json({ error: 'rows required' }, 400);
  try {
    if (body.replace === true) await env.DB.prepare('DELETE FROM gift_override WHERE period = ?').bind(period).run();
    let n = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const stmts = rows.slice(i, i + 100)
        .filter((r) => /^\d{1,12}$/.test(String(r.uid || '')) && Number(r.v) > 0)
        .map((r) => env.DB.prepare(
          'INSERT OR REPLACE INTO gift_override (uid, period, v, rank, nick, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(String(r.uid), period, Number(r.v) || 0, Number(r.rank) || 0, String(r.nick || '').slice(0, 64), Date.now()));
      if (stmts.length) { await env.DB.batch(stmts); n += stmts.length; }
    }
    return json({ ok: true, period, written: n });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e).slice(0, 200) }, 500);
  }
}

/** 一次性回填：把 fans 表里已标 src*='list' 的人抄进 gift_override。
 *  为什么需要：D1 里本来就有正确的榜单值（本机推过），一条 SQL 抄过来即可，
 *  不必把带 uid 的榜单文件搬到任何地方 —— 也就永远不用进 GitHub 仓库。 */
async function handleGiftOverrideBootstrap(request, env) {
  if (!env || !env.DB) return json({ error: 'd1-not-bound' }, 500);
  await env.DB.exec(GIFT_OVERRIDE_DDL);
  const SPEC = {
    '2026': { src: '$.src26', v: '$.total2026', rank: '$.rank26' },
    '2024plus': { src: '$.srcSince2024', v: '$.totalSince2024', rank: '$.rankSince2024' },
  };
  const out = {};
  for (const [period, s] of Object.entries(SPEC)) {
    try {
      const r = await env.DB.prepare(
        'INSERT OR REPLACE INTO gift_override (uid, period, v, rank, nick, updatedAt) ' +
        "SELECT uid, ?, CAST(json_extract(data, ?) AS INTEGER), CAST(COALESCE(json_extract(data, ?), 0) AS INTEGER), nick, ? " +
        "FROM fans WHERE json_extract(data, ?) = 'list' AND CAST(COALESCE(json_extract(data, ?), 0) AS INTEGER) > 0"
      ).bind(period, s.v, s.rank, Date.now(), s.src, s.v).run();
      out[period] = (r && r.meta && (r.meta.rows_written ?? r.meta.changes)) ?? 'ok';
    } catch (e) {
      out[period] = 'error: ' + String((e && e.message) || e).slice(0, 120);
    }
  }
  return json({ ok: true, written: out });
}

/* ------------------------- 索引（index 键） -------------------------
 * {
 *   months:   ["2026-09", ...]        降序
 *   counts:   { "2026-09": 1234 }     每月条数（用于页头精确总数）
 *   recent:   [ ...最多 60 条 ]       首屏秒更用
 *   meta:     { member, lastUpdated, ... }
 *   liveCount / perfCount             live / performances 的实际条数
 *   updatedAt                         最近一次「数据真变化」的时间
 * }
 */
function normIndex(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  return {
    months: Array.isArray(o.months) ? o.months : [],
    counts: (o.counts && typeof o.counts === 'object') ? o.counts : {},
    recent: Array.isArray(o.recent) ? o.recent : [],
    meta: (o.meta && typeof o.meta === 'object') ? o.meta : {},
    updatedAt: Number(o.updatedAt) || 0,
    liveCount: Number(o.liveCount) || 0,
    perfCount: Number(o.perfCount) || 0
  };
}

// 索引「实质内容」指纹：刻意不含 meta / updatedAt（它们每轮都变），
// 免得抓取明明没新数据、却因为时间戳变化而每轮都写一次索引。
function idxSignature(i) {
  return JSON.stringify([i.months, i.counts, i.recent, i.liveCount, i.perfCount]);
}

// 逐月求和：只有当**每个月都记了条数**时结果才可信（刚上线、老月份还没回填计数时不能当总数用）
function countAll(i) {
  let total = 0, counted = 0;
  for (const m of i.months) {
    const n = Number(i.counts[m]);
    if (Number.isFinite(n)) { total += n; counted++; }
  }
  return { total, counted, all: i.months.length > 0 && counted === i.months.length };
}

async function handleApiIndex(env) {
  const kv = env && env.KV;
  if (!kv || typeof kv.get !== 'function') return json({ error: 'kv-not-bound' }, 500);
  const idx = normIndex(await kv.get('index', { type: 'json' }));
  const meta = Object.assign({}, idx.meta);
  // 页头统计以「KV 里实际存了多少」为准，而不是抓取端的本地文件条数
  // （公演经过「她参加」筛选后条数远小于原始列表，用原始数会显示 383 而列表只有 277）。
  // 注意：逐月求和只在**每个月都有计数**时才可信，否则整体回退到 meta.counts，
  // 绝不能用「部分月份的求和」当总数——那会把 5 万条显示成几千条。
  const cAll = countAll(idx);
  meta.counts = {
    messages: cAll.all ? cAll.total : (Number(meta.counts && meta.counts.messages) || cAll.total),
    live: idx.liveCount || Number(meta.counts && meta.counts.live) || 0,
    performances: idx.perfCount || Number(meta.counts && meta.counts.performances) || 0
  };
  // 首屏数据：no-store 保证刷新即拿最新
  return apiJson({
    months: idx.months,
    counts: idx.counts,
    recent: scrubList(idx.recent),
    updatedAt: idx.updatedAt,
    meta
  }, 'no-store');
}

/* ---------------- 出口脱敏：第三方身份一律不得下发 ----------------
 * 红线（站长 2026-09-22 定）：口袋48 侧任何第三方用户的 uid / 头像路径 / 等级 / 主页
 * 不得出现在任何线上响应里。昵称属于房间里公开说过的话的一部分，保留。
 * 本人 userId 是公开 starId，保留。
 *
 * ⚠️ 这里是「最后一道闸门」：D1 / KV 里可能还存着脱敏前写进去的旧数据，
 * 所以读取侧必须清洗；写入侧（/api/sync）同样会清洗，保证存量逐步被替换干净。
 */
const SELF_ID = '89653517';

/** 取图片路径里隐含的属主 uid：/avatar/2025/0119/63x… 或 /2026/0213/826829x… → "63"/"826829" */
function pathOwnerId(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^\/?(?:avatar\/)?\d{4}\/\d{2,4}\/(\d{1,12})(?=[a-z0-9])/);
  return m ? m[1] : null;
}

const ID_KEYS = new Set(['userId', 'uid', 'userid', 'Uid', 'UserId', 'pfUrl', 'level', 'vip', 'vipLevel', 'roleId', 'roleid', 'teamLogo']);
// 昵称类字段：正常保留（房间里公开说过的话），但值是纯数字时——那往往就是 uid 本身——必须打码
const NICK_KEYS = new Set(['nickname', 'nickName', 'nick', 'name']);
function maskNumericNick(v) {
  if (typeof v !== 'string' || !/^\d{8,12}$/.test(v) || v === SELF_ID) return v;
  return v.slice(0, 4) + '****' + v.slice(-2);
}

/** 递归清洗对象里的第三方身份（就地修改） */
function scrubNode(node, depth) {
  if (!node || typeof node !== 'object' || (depth || 0) > 8) return node;
  if (Array.isArray(node)) {
    for (const it of node) scrubNode(it, (depth || 0) + 1);
    return node;
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (typeof val === 'string' && val.charAt(0) === '/') {
      const owner = pathOwnerId(val);
      if (owner && owner !== SELF_ID) { delete node[key]; continue; }
    }
    if (Array.isArray(val) && key !== 'extInfo') {
      node[key] = val.filter((v) => {
        const owner = pathOwnerId(v);
        return !(typeof v === 'string' && owner && owner !== SELF_ID);
      });
    }
    if (NICK_KEYS.has(key) && typeof val === 'string') { node[key] = maskNumericNick(val); continue; }
    if (ID_KEYS.has(key) && String(val) !== SELF_ID) { delete node[key]; continue; }
    if (val && typeof val === 'object') scrubNode(val, (depth || 0) + 1);
  }
  return node;
}

/** 字符串形式的 JSON（raw.bodys / raw.extInfo）：把隐含他人 uid 的路径值清空 */
function scrubJsonText(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/"([A-Za-z_]\w*)":"(\/[^"]*)"/g, (full, k, v) => {
    const owner = pathOwnerId(v);
    return owner && owner !== SELF_ID ? `"${k}":""` : full;
  });
}

/** 单条房间消息脱敏 */
function scrubMsg(m) {
  if (!m || typeof m !== 'object') return m;
  if (m.sender && typeof m.sender === 'object') {
    if (String(m.sender.userId) === SELF_ID) {
      m.sender = { self: true, userId: m.sender.userId, nickname: m.sender.nickname, avatar: m.sender.avatar };
    } else {
      m.sender = { nickname: m.sender.nickname };   // 第三方：只留昵称
    }
  }
  if (m.reply && typeof m.reply === 'object') m.reply = { name: m.reply.name, text: m.reply.text };
  if (m.raw && typeof m.raw === 'object') {
    for (const k of Object.keys(m.raw)) {
      if (typeof m.raw[k] === 'string') m.raw[k] = scrubJsonText(m.raw[k]);
      else if (m.raw[k] && typeof m.raw[k] === 'object') scrubNode(m.raw[k], 0);
    }
    if (typeof m.raw.extInfo === 'string') {
      try { m.raw.extInfo = JSON.stringify(scrubNode(JSON.parse(m.raw.extInfo), 0)); } catch (_) { m.raw.extInfo = ''; }
    }
  }
  return scrubNode(m, 0);
}

/** 批量脱敏 */
function scrubList(arr) {
  if (!Array.isArray(arr)) return arr;
  for (const m of arr) scrubMsg(m);
  return arr;
}

/** 当前（UTC+8）月份，形如 2026-09 */
function tzCurrentMonth() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function handleApiMonth(url, env) {
  const m = url.searchParams.get('m');
  if (!/^\d{4}-\d{2}$/.test(m || '')) return json({ error: 'bad month' }, 400);
  // 历史月内容永不再变 → 边缘缓存 12h；当月仍在增长 → 只缓存 60s，保证看得到新发言。
  const ttl = m >= tzCurrentMonth() ? 60 : 12 * 3600;
  return withEdgeCache('/api/month?m=' + m, ttl, () => readMonthUncached(m, env));
}

async function readMonthUncached(m, env) {
  // ── 读路径：D1 优先，未绑定或出错时回退 KV ──
  // 发言已迁到 D1（免费 10 万写/天，是 KV 1000 的 100 倍）；KV 里的月份键仍保留作备份，
  // 所以这里任何异常都能无损回退，绝不会「读不到数据」。
  let arr = null;
  let src = 'kv';                       // 数据来源：d1 / kv（便于线上核对是否真的走了 D1）
  let d1err = '';
  if (env && env.DB) {
    try {
      const rs = await env.DB.prepare(
        'SELECT data FROM messages WHERE month = ? ORDER BY msgTime DESC'
      ).bind(m).all();
      arr = (rs.results || [])
        .map((r) => { try { return JSON.parse(r.data); } catch (_) { return null; } })
        .filter(Boolean);
      src = 'd1';
    } catch (e) { arr = null; d1err = String((e && e.message) || e).slice(0, 160); }
  }
  if (arr === null) {
    const kv = env && env.KV;
    if (!kv) return json({ error: 'kv-not-bound' }, 500);
    arr = await kv.get('msg/' + m, { type: 'json' }) || [];
    src = 'kv';
  }
  // 出库前统一脱敏：D1/KV 里可能仍有脱敏之前落库的旧数据
  const cur = tzCurrentMonth();
  const res = apiJson(scrubList(arr), m >= cur ? 'public, max-age=60' : 'public, max-age=86400');
  res.headers.set('x-data-source', src);
  if (d1err) res.headers.set('x-d1-error', d1err.replace(/[\r\n]+/g, ' '));
  return res;
}

async function handleApiKey(key, env) {
  const kv = env && env.KV;
  if (!kv) return json({ error: 'kv-not-bound' }, 500);
  const v = await kv.get(key, { type: 'json' });
  if (v == null) return apiJson((key === 'perf-cuts' || key === 'live-cuts') ? { cuts: [] } : [], 'public, max-age=60');
  return apiJson(v, 'public, max-age=60');
}

/* ------------------------- 写入：并集合并 ------------------------- */

// 发言：按月并集（按 msgKey 去重，新值覆盖同键旧值 → 文本重解析也能生效），永不丢历史。
async function mergeMonth(kv, m, msgs) {
  const key = 'msg/' + m;
  const prevJson = await kv.get(key);
  const prev = prevJson ? safeParseArr(prevJson) : [];
  const map = new Map();
  for (const x of prev) map.set(msgKeyOf(x), x);
  let added = 0;
  for (const x of msgs) {
    const k = msgKeyOf(x);
    if (!map.has(k)) added++;
    map.set(k, x);
  }
  const merged = [...map.values()].sort(byTimeDesc);
  const mergedJson = stableStringify(merged);
  let wrote = false;
  if (mergedJson !== prevJson) {
    await kv.put(key, mergedJson);
    wrote = true;
  }
  return { total: merged.length, added, wrote, head: merged.slice(0, 120) };
}

// 发言写入 D1：只写「比库里最新一条还要新」的条目。
// 发言一旦落库几乎不再变动，所以「只插新增」既保证正确、又把写入量压到每天几十条。
// （若每轮把窗口内 3000 条全量 REPLACE，96 轮/天 = 28.8 万，会超过 D1 免费 10 万/天的写入额度。）
// D1 故障绝不能影响 KV 主路径 —— 整个函数吞掉异常。
async function writeMonthToD1(db, m, msgs) {
  if (!db || !Array.isArray(msgs) || !msgs.length) return 0;
  try {
    const row = await db.prepare('SELECT MAX(msgTime) AS t FROM messages WHERE month = ?').bind(m).first();
    const last = Number(row && row.t) || 0;
    const news = msgs.filter((x) => (Number(x.msgTime) || 0) > last);
    let sent = 0;
    for (let i = 0; i < news.length; i += 100) {
      const stmts = news.slice(i, i + 100).map((x) => db.prepare(
        'INSERT OR REPLACE INTO messages (mid, month, msgTime, data) VALUES (?, ?, ?, ?)'
      ).bind(msgKeyOf(x), m, Number(x.msgTime) || 0, JSON.stringify(x)));
      if (stmts.length) await db.batch(stmts);
      sent += stmts.length;
    }
    return sent;
  } catch (_) { return 0; }
}

/* 全量 upsert（回填专用）：不看 msgTime，整月覆盖写回，用于给历史存量补回 uid */
async function upsertMonthToD1(db, m, msgs, size) {
  const N = Math.max(1, Number(size) || 25);
  if (!db) return { sent: 0, error: 'db-not-bound' };
  if (!Array.isArray(msgs) || !msgs.length) return { sent: 0, error: null };
  try {
    let sent = 0;
    for (let i = 0; i < msgs.length; i += N) {
      const stmts = msgs.slice(i, i + N).map((x) => db.prepare(
        'INSERT OR REPLACE INTO messages (mid, month, msgTime, data) VALUES (?, ?, ?, ?)'
      ).bind(msgKeyOf(x), m, Number(x.msgTime) || 0, JSON.stringify(x)));
      if (stmts.length) { await db.batch(stmts); sent += stmts.length; }
    }
    return { sent, error: null };
  } catch (e) { return { sent: -1, error: String(e && e.message || e).slice(0, 160) }; }
}

/* ---------------- 底层回填（含 uid 的原始发言） ----------------
 * 红线修订（站长 2026-09-23）：脱敏只在「出口」做，底层 D1 / KV 必须保留 sender uid ——
 * 否则以后任何身份相关分析（匹配、去重、统计）都无从下手。
 * D1 / KV 只能被 Worker 读到，而 Worker 的 /api/index、/api/month 出口一律 scrub，
 * 静态兜底 archive.js 也是脱敏版 ⇒ 浏览器侧仍然零 uid。
 * 本端点仅供「历史存量补 uid」临时使用，需 x-sync-token。
 */
async function handleD1Refill(request, env) {
  const kv = env && env.KV;
  if (!kv || typeof kv.put !== 'function') return json({ error: 'kv-not-bound' }, 500);
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
  const months = (body && body.months) || {};
  const out = { months: {}, d1: {}, errors: [] };
  for (const m of Object.keys(months)) {
    if (!/^\d{4}-\d{2}$/.test(m)) continue;
    const msgs = months[m];
    if (!Array.isArray(msgs)) continue;
    try {
      await kv.put('msg/' + m, stableStringify(msgs));
      out.months[m] = msgs.length;
      out.d1[m] = await upsertMonthToD1(env.DB, m, msgs, body && body.batch);
      // 诊断（仅授权调用可见）：该月是否存在第三方 uid，确认底层真的存下来了
      const s = msgs.find((x) => x && x.sender && String(x.sender.userId) !== SELF_ID);
      out.sample = out.sample || {};
      out.sample[m] = s ? String(s.sender.userId) : null;
    } catch (e) { out.errors.push(m + ': ' + (e && e.message)); }
  }
  out.ok = out.errors.length === 0;
  return json(out);
}

// 直播 / 公演：按 liveId 并集；同键只覆盖「有值且真变化」的字段（空字符串不覆盖，避免抹掉已有的 playUrl）。
async function mergeById(kv, key, incoming, sortFn) {
  const prevJson = await kv.get(key);
  const prev = prevJson ? safeParseArr(prevJson) : [];
  const map = new Map();
  for (const x of prev) map.set(String(x.liveId), x);
  let added = 0, updated = 0;
  for (const it of incoming) {
    const k = String(it.liveId);
    const old = map.get(k);
    if (!old) { map.set(k, it); added++; continue; }
    const merged = Object.assign({}, old);
    let diff = false;
    for (const f of Object.keys(it)) {
      const v = it[f];
      if (v === '' || v == null) continue;
      // 必须用 stableStringify 比较（与下面的落盘判断同一口径）：
      // 直接 JSON.stringify 对嵌套对象是「键顺序敏感」的，会把同一份数据误判成「有变化」，
      // 导致日志里每轮都报「更新 N 条」而实际没写盘，排查时极易被误导。
      if (stableStringify(old[f]) !== stableStringify(v)) { merged[f] = v; diff = true; }
    }
    if (diff) { map.set(k, merged); updated++; }
  }
  const out = [...map.values()].sort(sortFn);
  const outJson = stableStringify(out);
  let wrote = false;
  if (outJson !== prevJson) {
    await kv.put(key, outJson);
    wrote = true;
  }
  return { total: out.length, added, updated, wrote };
}

// 小数据（社媒美图 / 公演 cut）：整体替换（来源本身就是全量快照）
async function replaceKey(kv, key, value) {
  const prevJson = await kv.get(key);
  const outJson = stableStringify(value);
  let wrote = false;
  // 用 contentSig（剔除 updatedAt / progress 等易变字段）判断「内容是否真的变了」，
  // 而不是比对整个 JSON 串 —— 否则每轮都会空写一次 KV。
  let prev = null;
  if (prevJson) { try { prev = JSON.parse(prevJson); } catch (_) { prev = null; } }
  if (prev === null || contentSig(value) !== contentSig(prev)) {
    await kv.put(key, outJson);
    wrote = true;
  }
  const total = Array.isArray(value)
    ? value.length
    : (value && Array.isArray(value.cuts) ? value.cuts.length : 1);
  return { total, wrote };
}

// 全量覆盖（仅用于「重建」：调用方声明这份列表就是权威全集，多出来的旧条目要删掉）。
// 典型场景：公演从「按队伍抓的原始列表(383)」改为「她的公演记录(277)」后，
// 并集合并永远删不掉那 106 条她没参加的场次，必须显式重建一次。
async function replaceList(kv, key, incoming, sortFn) {
  const prevJson = await kv.get(key);
  const out = incoming.slice().sort(sortFn);
  const outJson = stableStringify(out);
  let wrote = false;
  if (outJson !== prevJson) {
    await kv.put(key, outJson);
    wrote = true;
  }
  return { total: out.length, added: 0, updated: 0, wrote, replaced: true };
}

// body: {
//   months: { "2026-09": [msg,...] },    // 只推「可能再变」的近期月份
//   live, performances: [...],           // 只推近期条目
//   social: [...], perfCuts: {...},      // 全量小数据
//   meta: {...},                         // 站点元信息（member / lastUpdated 等）
//   replace: ["live","performances"]     // 可选：这些键改为「整份覆盖」（重建时用）
// }
// 返回每部分「新增/更新/写入」情况，便于 Actions 日志核对。
async function handleApiSync(request, env, ctx) {
  const kv = env && env.KV;
  if (!kv || typeof kv.put !== 'function') return json({ error: 'kv-not-bound' }, 500);
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
  const { months, live, performances, social, perfCuts, liveCuts, meta } = body || {};
  const replace = new Set(Array.isArray(body && body.replace) ? body.replace : []);

  const idx = normIndex(await kv.get('index', { type: 'json' }));
  const oldSig = idxSignature(idx);
  const result = { months: {}, live: null, performances: null, social: null, perfCuts: null, liveCuts: null };
  let dataChanged = false;
  const latest = [];

  // ---- 1) 发言：按月并集 ----
  if (months && typeof months === 'object') {
    const mset = new Set(idx.months);
    for (const m of Object.keys(months)) {
      if (!/^\d{4}-\d{2}$/.test(m)) continue;
      const msgs = months[m];
      if (!Array.isArray(msgs)) continue;
      mset.add(m);
      // ⚠️ 这里**不要**脱敏：底层（D1 / KV）必须保留 sender uid，以后做身份相关分析才有依据。
      // 脱敏统一放在出口（/api/index、/api/month、静态 archive.js），浏览器永远拿不到 uid。
      const r = await mergeMonth(kv, m, msgs);
      // 同步写 D1（只插新增）；KV 继续保留该月数据作为备份/回退
      const d1Sent = await writeMonthToD1(env.DB, m, msgs);
      idx.counts[m] = r.total;
      result.months[m] = { total: r.total, added: r.added, wrote: r.wrote, d1: d1Sent };
      if (r.wrote) dataChanged = true;
      for (const x of r.head) latest.push(x);
    }
    idx.months = [...mset].sort().reverse();
  }

  // ---- 2) 直播 / 录播 ----
  if (Array.isArray(live)) {
    const sortByCtime = (a, b) => (Number(b.ctime) || 0) - (Number(a.ctime) || 0);
    const r = replace.has('live')
      ? await replaceList(kv, 'live', live, sortByCtime)
      : await mergeById(kv, 'live', live, sortByCtime);
    idx.liveCount = r.total;
    result.live = r;
    if (r.wrote) dataChanged = true;
  }

  // ---- 3) 公演 ----
  if (Array.isArray(performances)) {
    const sortByStime = (a, b) => (Number(b.stime || b.ctime) || 0) - (Number(a.stime || a.ctime) || 0);
    const r = replace.has('performances')
      ? await replaceList(kv, 'performances', performances, sortByStime)
      : await mergeById(kv, 'performances', performances, sortByStime);
    idx.perfCount = r.total;
    result.performances = r;
    if (r.wrote) dataChanged = true;
  }

  // ---- 4) 小数据 ----
  if (Array.isArray(social)) {
    const r = await replaceKey(kv, 'social', social);
    result.social = r;
    if (r.wrote) dataChanged = true;
  }
  if (perfCuts && typeof perfCuts === 'object') {
    const r = await replaceKey(kv, 'perf-cuts', perfCuts);
    result.perfCuts = r;
    if (r.wrote) dataChanged = true;
  }
  if (liveCuts && typeof liveCuts === 'object') {
    const r = await replaceKey(kv, 'live-cuts', liveCuts);
    result.liveCuts = r;
    if (r.wrote) dataChanged = true;
  }

  // ---- 5) meta（仅随索引一起落盘，不单独触发写入）----
  if (meta && typeof meta === 'object') idx.meta = Object.assign({}, meta);

  // ---- 6) recent：取本轮各月最新的 60 条（没新发言时内容不变 → 不触发索引写入）----
  if (latest.length) {
    const rec = latest.sort(byTimeDesc).slice(0, 60);
    if (stableStringify(rec) !== stableStringify(idx.recent)) {
      idx.recent = rec;
    }
  }

  // ---- 7) 索引：只有「实质内容」变化才落盘 ----
  const newSig = idxSignature(idx);
  let indexWritten = false;
  if (dataChanged || newSig !== oldSig) {
    idx.updatedAt = Date.now();
    await kv.put('index', stableStringify(idx));
    indexWritten = true;
  }

  return json({
    ok: true,
    dataChanged,
    indexWritten,
    updatedAt: idx.updatedAt,
    counts: {
      messages: countAll(idx).total,
      live: idx.liveCount,
      performances: idx.perfCount
    },
    wrote: result
  });
}

/* ===================== 行程存档 + 手机后台（2026-09-23 新增） =====================
 * 站长诉求：① 行程要存档、以后能回顾 ② 过期的自动归到「已结束」 ③ 手机上就能更新，不用开电脑。
 * 存储（数据 KV env.KV）：
 *   schedule      = 当前全量行程（含已过期条目，按日期排序）——「存档」就是它，绝不整份覆盖
 *   schedule:log  = 每次提交的记录（最近 60 条：新增/更新/删除了什么、来源链接），误操作可回溯
 * 密码（密钥 KV env.SECRETS）：admin:pass = sha256(盐+密码)；没有就用内置初始口令的哈希。
 * token：HMAC(sha256(密码哈希), 'sch'+过期时间) —— 密码哈希不上公网，外部伪造不了；改密码后旧 token 自动失效。
 * 🔴 为什么不用「给微博链接自动抓」：实测 m.weibo.cn 的 statuses/show 与 detail 接口在未登录时
 *    一律 302 跳登录页，服务端没有 cookie 抓不到正文。所以改成「粘贴正文 → 解析 → 可编辑 → 发布」，
 *    链接只存在 source.url 里当出处，点得回原文。
 */
const SCHED_KEY = 'schedule';
const SCHED_LOG = 'schedule:log';
const ADMIN_SALT = 'wyc-sch-2026';
// 初始口令 Wyc0518@Sch 的 sha256(盐+口令)（后台里可改，改完存 KV 优先）
const ADMIN_PASS_SHA_DEFAULT = 'b7af23bbdef0bf10fff6fa375cbe2a43c6ae97a4c29aad9acead137115b6db81';

function normTitle(s) {
  return String(s || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[《》〈〉()（）\[\]【】""''「」『』,，。.、:：;；!！?？~—\-_/|｜]/g, '')
    .toLowerCase();
}
function schedKey(it) { return String(it && it.date || '') + '|' + normTitle(it && it.title); }
function pad2(n) { return String(n).padStart(2, '0'); }
function weekdayOf(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return '';
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return '周' + '日一二三四五六'[dt.getUTCDay()];
}
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.prototype.slice.call(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function hmacHex(keyStr, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(keyStr),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return Array.prototype.slice.call(new Uint8Array(sig)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function adminPassHash(env) {
  try {
    const v = (env && env.SECRETS) ? await env.SECRETS.get('admin:pass') : null;
    if (v && /^[0-9a-f]{64}$/.test(v)) return v;
  } catch (_) { /* 读不到就用内置初始口令 */ }
  return ADMIN_PASS_SHA_DEFAULT;
}
async function makeToken(env, days) {
  const exp = Date.now() + (days || 7) * 86400000;
  const sig = await hmacHex(await sha256hex(await adminPassHash(env)), 'sch' + exp);
  return exp + '.' + sig;
}
async function verifyToken(env, token) {
  const m = /^(\d{10,14})\.([0-9a-f]{64})$/.exec(String(token || ''));
  if (!m) return false;
  const exp = Number(m[1]);
  if (!exp || Date.now() > exp) return false;
  const want = await hmacHex(await sha256hex(await adminPassHash(env)), 'sch' + exp);
  return want === m[2];
}
async function adminOk(request, env) {
  const h = request.headers.get('x-admin-token')
    || String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return await verifyToken(env, h);
}
// 口令暴力破解防护：同一 IP 10 分钟内最多 8 次登录尝试
const ADMIN_RATE = new Map();
function adminRateOk(ip) {
  const now = Date.now();
  const r = ADMIN_RATE.get(ip);
  if (!r || now > r.reset) { ADMIN_RATE.set(ip, { n: 1, reset: now + 10 * 60 * 1000 }); return true; }
  if (r.n >= 8) return false;
  r.n += 1;
  return true;
}

async function handleScheduleGet(env) {
  const kv = env && env.KV;
  let cur = null;
  if (kv) { try { cur = await kv.get(SCHED_KEY, { type: 'json' }); } catch (_) { cur = null; } }
  if (!cur || !Array.isArray(cur.items)) return json({ ok: true, empty: true, items: [] });
  return json(Object.assign({ ok: true }, cur));
}

async function handleAdminLogin(request, env) {
  const ip = String(request.headers.get('cf-connecting-ip') || 'unknown');
  if (!adminRateOk(ip)) return json({ error: '试太多次了，10 分钟后再来' }, 429);
  let body = {};
  try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
  const pass = String(body.pass || '');
  if (!pass) return json({ error: '请输入密码' }, 400);
  const h = await sha256hex(ADMIN_SALT + pass);
  if (h !== (await adminPassHash(env))) return json({ error: '密码不对' }, 401);
  const exp = Date.now() + 7 * 86400000;
  return json({ ok: true, token: await makeToken(env, 7), exp: exp });
}

async function handleAdminPass(request, env) {
  let body = {};
  try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
  const np = String(body.next || '');
  if (np.length < 8) return json({ error: '新密码至少 8 位' }, 400);
  if ((await sha256hex(ADMIN_SALT + String(body.old || ''))) !== (await adminPassHash(env))) {
    return json({ error: '原密码不对' }, 401);
  }
  await env.SECRETS.put('admin:pass', await sha256hex(ADMIN_SALT + np));
  return json({ ok: true, token: await makeToken(env, 7) });   // 换密码后旧 token 失效，发新的
}

async function handleAdminScheduleGet(env) {
  const kv = env && env.KV;
  let cur = null, log = [];
  if (kv) {
    try { cur = await kv.get(SCHED_KEY, { type: 'json' }); } catch (_) { cur = null; }
    try { log = (await kv.get(SCHED_LOG, { type: 'json' })) || []; } catch (_) { log = []; }
  }
  return json({ ok: true, schedule: cur || { items: [] }, log: log });
}

async function handleAdminSchedulePost(request, env) {
  let body = {};
  try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
  const kv = env && env.KV;
  if (!kv) return json({ error: 'kv-not-bound' }, 500);
  let cur = null;
  try { cur = await kv.get(SCHED_KEY, { type: 'json' }); } catch (_) { cur = null; }
  const base = (cur && Array.isArray(cur.items)) ? cur : { items: [] };

  const map = new Map();
  base.items.forEach((it) => map.set(schedKey(it), Object.assign({}, it)));
  const added = [], updated = [], removed = [];

  // 删除（后台手工纠错用，走 log，可追溯）
  if (Array.isArray(body.remove)) {
    body.remove.forEach((r) => {
      const k = String(r.date || '') + '|' + normTitle(r.title);
      if (map.has(k)) { removed.push(map.get(k).title); map.delete(k); }
    });
  }
  const incoming = Array.isArray(body.items) ? body.items : [];
  incoming.forEach((it) => {
    const date = String((it && it.date) || '').slice(0, 10);
    const title = String((it && it.title) || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !title) return;
    const row = {
      date: date,
      weekday: it.weekday || weekdayOf(date),
      time: String(it.time || '').trim(),
      title: title,
      kind: (it.kind === '见面会') ? '见面会' : '公演',
    };
    const k = schedKey(row);
    const old = map.get(k);
    if (Array.isArray(it.flags) && it.flags.length) row.flags = it.flags;
    else if (old && old.flags) row.flags = old.flags;
    if (old) { updated.push(title); map.set(k, Object.assign({}, old, row)); }
    else { added.push(title); map.set(k, row); }
  });

  let items = Array.from(map.values()).sort((a, b) => String(a.date).localeCompare(String(b.date))
    || String(a.time || '').localeCompare(String(b.time || '')));
  if (body.replace === true) {
    // 整份替换（仅在后台明确点「覆盖」时用）：仍然保留一份进 log，方便回看
    items = incoming.filter((it) => /^\d{4}-\d{2}-\d{2}$/.test(String(it.date || '')) && it.title)
      .map((it) => ({
        date: String(it.date).slice(0, 10),
        weekday: it.weekday || weekdayOf(it.date),
        time: String(it.time || '').trim(),
        title: String(it.title).trim(),
        kind: (it.kind === '见面会') ? '见面会' : '公演',
      })).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    removed.length = 0;
    removed.push('（整份替换，原 ' + base.items.length + ' 条被覆盖）');
  }

  const keep = (v, d) => (v === undefined ? d : v);
  const next = {
    updatedAt: Date.now(),
    source: keep(body.source, base.source || null),
    ticket: keep(body.ticket, base.ticket || ''),
    callUrl: keep(body.callUrl, base.callUrl || ''),
    note: keep(body.note, base.note || ''),
    score: keep(body.score, base.score || null),
    items: items,
  };
  await kv.put(SCHED_KEY, JSON.stringify(next));
  let log = [];
  try { log = (await kv.get(SCHED_LOG, { type: 'json' })) || []; } catch (_) { log = []; }
  log.unshift({
    at: next.updatedAt,
    added: added, updated: updated, removed: removed,
    n: items.length,
    src: (body.source && body.source.url) || body.srcNote || '',
  });
  await kv.put(SCHED_LOG, JSON.stringify(log.slice(0, 60)));
  // 顺手清掉 /api/schedule 的边缘缓存，否则站长手机上发完，访客最多要等 60 秒才看到新行程
  try { await caches.default.delete('https://wyc-edge-cache.local/api/schedule'); } catch (_) { /* 清不掉就等缓存自己过期 */ }
  return json({ ok: true, added: added, updated: updated, removed: removed, total: items.length });
}

/* ---------------- 微博正文 → 行程条目 ----------------
 * 规则解析为主（毫秒级、稳）；规则一条都没解析出来、或后台点了「用 AI 再试」→ 调 Workers AI 兜底。
 * 识别：日期（9月26日 / 2026-10-03 / 10/3）、时间（14:00、17:30-19:30）、星期、
 *       类型（含「见面会/握手/签名/合影/答谢」= 见面会，其余 = 公演）、其余文字作标题。
 */
/* --- 时间/文本的通用片段：14:00、14：00、14点、14点30、下午5点半 --- */
const TIME_HALF = '(?:上午|中午|下午|晚上|傍晚|凌晨|早上)?';
const TIME_ONE = '\\d{1,2}\\s*(?:[:：]\\s*\\d{2}|\\s*点\\s*(?:\\d{1,2}\\s*分?|半)?)';
const TIME_RE = new RegExp('(上午|中午|下午|晚上|傍晚|凌晨|早上)?\\s*(' + TIME_ONE + ')'
  + '(?:\\s*[-–—~～至到]\\s*(上午|中午|下午|晚上|傍晚|凌晨|早上)?\\s*(' + TIME_ONE + '))?');
const TIME_RE_G = new RegExp('(?:上午|中午|下午|晚上|傍晚|凌晨|早上)?\\s*' + TIME_ONE
  + '(?:\\s*[-–—~～至到]\\s*(?:上午|中午|下午|晚上|傍晚|凌晨|早上)?\\s*' + TIME_ONE + ')?', 'g');

/* 全角归一化：１４：００ → 14:00，全角空格 → 普通空格 */
function normSchedText(s) {
  return String(s || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248))
    .replace(/[：﹕]/g, ':')
    .replace(/[－−ー]/g, '-')
    .replace(/[\u3000\u00A0]/g, ' ')
    .replace(/\r/g, '');
}

/* 单个时间点 → HH:MM（认不出返回空） */
function toHHMM(t, half) {
  if (!t) return '';
  let h = 0, mi = 0, m = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(t);
  if (m) { h = Number(m[1]); mi = Number(m[2]); }
  else {
    m = /(\d{1,2})\s*点\s*(?:(\d{1,2})\s*分?|半)?/.exec(t);
    if (!m) return '';
    h = Number(m[1]);
    mi = m[2] ? Number(m[2]) : (/半/.test(t) ? 30 : 0);
  }
  if (half === '下午' || half === '晚上' || half === '傍晚' || half === '中午') { if (h < 12) h += 12; }
  else if ((half === '上午' || half === '早上' || half === '凌晨') && h === 12) h = 0;
  if (h === 24) h = 0;
  if (h > 23 || mi > 59) return '';
  return pad2(h) + ':' + pad2(mi);
}

/* 一行里的完整时间（支持区间） */
function schedTimeOf(line) {
  const m = TIME_RE.exec(normSchedText(line));
  if (!m) return '';
  const a = toHHMM(m[2], m[1]);
  const b = toHHMM(m[4], m[3]);
  if (!a) return '';
  return a + (b && b !== a ? '-' + b : '');
}

/* 不转冒号版：保留《拾忆：TEAM NIII》这类原文标点，标题才不会被改样 */
function normSchedKeep(s) {
  return String(s || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248))
    .replace(/[\u3000\u00A0]/g, ' ')
    .replace(/\r/g, '');
}

/* 去掉日期/星期/时间/emoji，剩下当标题 */
function schedTitleOf(line) {
  return normSchedKeep(line)
    .replace(/(\d{1,2})\s*[:：]\s*(\d{2})/g, (x, a, b) => a + ':' + b)   // 只把「时间里的」全角冒号转半角
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/gu, ' ')
    .replace(/\d{4}\s*[-年/.]\s*\d{1,2}\s*[-月/.]\s*\d{1,2}\s*日?/g, ' ')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日?/g, ' ')
    .replace(/(星期|周)\s*[一二三四五六日天]/g, ' ')
    .replace(TIME_RE_G, ' ')
    .replace(/[（(][^（）()]{0,8}[)）]/g, (x) => (/开演|开场|开始|入场|检票|签到|演出/.test(x) ? ' ' : x))
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(/[;；]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-—·•|｜、,，:：]+/, '')
    .replace(/[\s\-—·•|｜、,，;；:：（(]+$/, '')
    .trim();
}

/* 整段不换行也能拆：在每个日期、每个时间前面补换行（时间区间作为一个整体，不会切断 17:30-19:30） */
function splitSchedLines(text) {
  let s = normSchedKeep(text);   // 不转冒号，保住《拾忆：TEAM NIII》这类原文
  s = s.replace(/(\d{1,2}\s*月\s*\d{1,2}\s*日?)/g, '\n$1');
  s = s.replace(new RegExp('((?:上午|中午|下午|晚上|傍晚|凌晨|早上)?\\s*' + TIME_ONE
    + '(?:\\s*[-–—~～至到]\\s*(?:上午|中午|下午|晚上|傍晚|凌晨|早上)?\\s*' + TIME_ONE + ')?)', 'g'), '\n$1');
  return s.split('\n').map((x) => x.trim()).filter(Boolean);
}

function ruleParseSchedule(text, yearHint) {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const curYear = now.getUTCFullYear(), curMon = now.getUTCMonth() + 1;
  const lines = splitSchedLines(text);
  const out = [];
  let curDate = '';
  let pendTime = '';     // 时间先出现（或日期行里带时间），等下一行的标题
  let lastEntry = null;  // 标题先出现，等下一行的时间回填
  for (let i = 0; i < lines.length; i++) {
    const line = normSchedKeep(lines[i]).trim();
    if (!line) continue;
    let y = '', mo = '', dd = '';
    // 「2026年9-10月行程」是范围不是某一天 → 后面紧跟「月」就不当日期
    let m = /(\d{4})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})\s*日?(?!\s*月)/.exec(line);
    if (m) { y = m[1]; mo = m[2]; dd = m[3]; }
    else {
      m = /(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(line);
      if (m) { mo = m[1]; dd = m[2]; }
    }
    if (mo && dd) {
      let yy = y ? Number(y) : (yearHint ? Number(yearHint) : curYear);
      if (!y && Number(mo) < curMon - 6) yy = curYear + 1;   // 「1月」出现在 9 月 → 指明年
      curDate = yy + '-' + pad2(Number(mo)) + '-' + pad2(Number(dd));
      pendTime = '';
      lastEntry = null;
    }
    const tm = schedTimeOf(line);
    if (tm) {
      if (lastEntry && !lastEntry.time) { lastEntry.time = tm; lastEntry = null; pendTime = ''; continue; }
      pendTime = tm;
    }
    const title = schedTitleOf(line);
    if (!curDate || title.length < 2) continue;              // 纯日期行 / 纯时间行不算条目
    if (!/[一-龥A-Za-z0-9《]/.test(title)) continue;          // 只剩符号
    if (/^[#＃]/.test(title) || /#[^#]{1,20}#/.test(title)) continue;   // 微博话题标签行不是行程
    if (/^(?:开演|开场|开始|入场|检票|签到|演出|待定|以上|暂无|上午|中午|下午|晚上|早上|凌晨|傍晚)$/.test(title)) continue;
    // 「备注：…」「购票方式」这类说明行不是行程
    if (/^(?:备注|说明|注意|购票|票价|地点|地址|时间|须知|温馨|提示|ps)\s*[:：]?/i.test(title)) continue;
    const e = {
      date: curDate,
      weekday: weekdayOf(curDate),
      time: tm || pendTime,
      title: title,
      kind: /见面会|握手|签名|合影|答谢|生日会|茶话会|见面/.test(line) ? '见面会' : '公演',
    };
    out.push(e);
    pendTime = '';
    lastEntry = e.time ? null : e;
  }
  return out;
}

async function aiParseSchedule(env, text, yearHint) {
  if (!env || !env.AI) return null;
  const sys = '你是行程整理助手。把用户给的中文行程文本解析成 JSON 数组，每项含：'
    + 'date(YYYY-MM-DD)、weekday(如 周六)、time(如 14:00 或 17:30-19:30，没有就空字符串)、'
    + 'title(活动名称)、kind(只能是 公演 或 见面会)。只输出 JSON 数组，不要任何解释文字。'
    + '年份缺失时按 ' + (yearHint || '当前年份') + ' 推断。';
  const models = ['@cf/meta/llama-3.1-8b-instruct', '@cf/qwen/qwen2.5-7b-instruct'];
  for (let i = 0; i < models.length; i++) {
    try {
      const out = await env.AI.run(models[i], {
        messages: [{ role: 'system', content: sys }, { role: 'user', content: String(text).slice(0, 4000) }],
        max_tokens: 1200,
      });
      const s = String((out && (out.response || out.text)) || '');
      const m = /\[[\s\S]*\]/.exec(s);
      if (!m) continue;
      const arr = JSON.parse(m[0]);
      if (!Array.isArray(arr)) continue;
      const items = arr.filter((x) => x && /\d{4}-\d{2}-\d{2}/.test(String(x.date || '')) && x.title)
        .map((x) => ({
          date: String(x.date).slice(0, 10),
          weekday: x.weekday || weekdayOf(String(x.date).slice(0, 10)),
          time: String(x.time || '').trim(),
          title: String(x.title).trim(),
          kind: (x.kind === '见面会') ? '见面会' : '公演',
        }));
      if (items.length) return items;
    } catch (_) { /* 换下一个模型 */ }
  }
  return null;
}

async function handleAdminParse(request, env) {
  let body = {};
  try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
  const text = String(body.text || '').slice(0, 8000);
  if (!text.trim()) return json({ error: '没有内容' }, 400);
  let items = ruleParseSchedule(text, body.year);
  let via = 'rule';
  const ruleFilled = items.filter((x) => x.time).length;
  // 一条都没出、或一半以上没认出时间、或后台点了「用 AI 再试」→ 走 AI 兜底
  const needAi = !items.length || body.ai || (items.length > 0 && ruleFilled < items.length / 2);
  if (needAi && env && env.AI) {
    const ai = await aiParseSchedule(env, text, body.year);
    if (ai && ai.length) {
      const aiFilled = ai.filter((x) => x.time).length;
      if (!items.length || aiFilled > ruleFilled) { items = ai; via = 'ai'; }
    }
  }
  const noTime = items.filter((x) => !x.time).length;
  return json({ ok: true, via: via, items: items, noTime: noTime });
}
