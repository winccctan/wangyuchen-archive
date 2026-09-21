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
    if (url.pathname.startsWith('/api/')) {
      return handleApi(url, request, env, ctx);
    }

    if (env && env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      return applyFreshPolicy(res, url);
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
function applyFreshPolicy(res, url) {
  if (!res || !res.headers) return res;
  const p = url.pathname;
  const isHtml = p === '/' || p.endsWith('/') || p.endsWith('.html');
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
  ['tab:guide', '新粉指南 tab'],
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
        const ip = (request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '?').split(',')[0].trim();
        await incKV(kv, 'stat:ev:' + ev);
        await incKV(kv, 'stat:evd:' + day + ':' + ev);
        await kv.put(`stat:u:${day}:${await shortHash(ip)}`, '1');
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
  const html = (s) => new Response(s, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  });
  if (!kv || typeof kv.get !== 'function') {
    return html('<meta charset="utf-8"><p>统计未启用：Worker 未绑定 KV 命名空间。</p>');
  }
  const total = Number((await kv.get('stat:tr:total')) || 0);

  const langRows = [];
  for (const l of LANGS) {
    const n = Number((await kv.get('stat:tr:lang:' + l)) || 0);
    if (n > 0) langRows.push([l, n]);
  }
  langRows.sort((a, b) => b[1] - a[1]);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = bjDay(Date.now() - i * 86400000);
    const n = Number((await kv.get('stat:tr:day:' + d)) || 0);
    let u = 0;
    try {
      const list = await kv.list({ prefix: `stat:tr:u:${d}:` });
      u = (list && list.keys ? list.keys.length : 0);
    } catch (_) { /* 忽略 */ }
    days.push([d, n, u]);
  }

  const langHtml = langRows.length
    ? langRows.map(([l, n]) => `<tr><td>${LANG_NAME[l] || l}</td><td class="n">${n}</td></tr>`).join('')
    : '<tr><td colspan="2" class="dim">暂无记录</td></tr>';
  const dayHtml = days.map(([d, n, u]) => `<tr><td>${d}</td><td class="n">${n}</td><td class="n">${u}</td></tr>`).join('');

  // 站点动作（tab 切换 / 视频播放 / 刷新 / 搜索 …）
  const evDefs = EVENTS.concat(LANGS.map((l) => ['lang:' + l, '切换为' + (LANG_NAME[l] || l)]));
  const evList = [];
  for (const [key, name] of evDefs) {
    const t = Number((await kv.get('stat:ev:' + key)) || 0);
    const d = Number((await kv.get(`stat:evd:${days[0][0]}:${key}`)) || 0);
    if (t > 0 || d > 0) evList.push({ key, name, total: t, today: d });
  }
  evList.sort((a, b) => b.total - a.total);
  const evHtml = evList.length
    ? evList.map((e) => `<tr><td>${e.name}</td><td class="n">${e.total}</td><td class="n">${e.today}</td></tr>`).join('')
    : '<tr><td colspan="3" class="dim">暂无记录</td></tr>';

  // JSON 模式：给 GitHub Pages 上的统计页面跨域读取（docs/stats.html）
  if (wantJson) {
    return new Response(JSON.stringify({
      total,
      today: { day: days[0][0], count: days[0][1], visitors: days[0][2] },
      langs: langRows.map(([l, n]) => ({ lang: l, name: LANG_NAME[l] || l, count: n })),
      days: days.map(([d, n, u]) => ({ day: d, count: n, visitors: u })),
      events: evList
    }), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
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
 table{border-collapse:collapse;width:100%;max-width:520px;background:#1c1f2b;border-radius:10px;overflow:hidden}
 td{padding:8px 12px;border-bottom:1px solid #2a2e3d;font-size:14px}
 tr:last-child td{border-bottom:none} td.n{text-align:right;font-variant-numeric:tabular-nums}
</style>
<h1>翻译功能使用统计</h1>
<p class="dim">累计统计自启用之时；独立访客按 IP 短哈希去重估算（不保存明文 IP）。KV 有约 1 分钟同步延迟。</p>
<div class="cards"><div class="card"><div class="k">累计翻译次数</div><div class="v">${total}</div></div>
<div class="card"><div class="k">今日次数</div><div class="v">${days[0][1]}</div></div>
<div class="card"><div class="k">今日独立访客</div><div class="v">${days[0][2]}</div></div></div>
<h2>各语言使用次数</h2><table>${langHtml}</table>
<h2>功能使用（累计 / 今日）</h2><table><tr><td>动作</td><td class="n">累计</td><td class="n">今日</td></tr>${evHtml}</table>
<h2>最近 7 天（翻译）</h2><table><tr><td>日期</td><td class="n">次数</td><td class="n">独立访客</td></tr>${dayHtml}</table>`);
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

async function handleApi(url, request, env, ctx) {
  const p = url.pathname;
  if (p === '/api/index') return handleApiIndex(env);
  if (p === '/api/month') return handleApiMonth(url, env);
  if (p === '/api/live') return handleApiKey('live', env);
  if (p === '/api/performances') return handleApiKey('performances', env);
  if (p === '/api/social') return handleApiKey('social', env);
  if (p === '/api/perf-cuts') return handleApiKey('perf-cuts', env);
  if (p === '/api/sync' && request.method === 'POST') {
    if (!(await isSyncAuthorized(request, env))) return json({ error: 'forbidden: sync token required' }, 403);
    return handleApiSync(request, env, ctx);
  }
  return json({ error: 'unknown api: ' + p }, 404);
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
    recent: idx.recent,
    updatedAt: idx.updatedAt,
    meta
  }, 'no-store');
}

async function handleApiMonth(url, env) {
  const m = url.searchParams.get('m');
  if (!/^\d{4}-\d{2}$/.test(m || '')) return json({ error: 'bad month' }, 400);
  const kv = env && env.KV;
  if (!kv) return json({ error: 'kv-not-bound' }, 500);
  const arr = await kv.get('msg/' + m, { type: 'json' }) || [];
  // 历史月内容不可变 → 允许浏览器/CDN 缓存 5 分钟（重复访问不再重拉）
  return apiJson(arr, 'public, max-age=300');
}

async function handleApiKey(key, env) {
  const kv = env && env.KV;
  if (!kv) return json({ error: 'kv-not-bound' }, 500);
  const v = await kv.get(key, { type: 'json' });
  if (v == null) return apiJson(key === 'perf-cuts' ? { cuts: [] } : [], 'public, max-age=60');
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
      if (JSON.stringify(old[f]) !== JSON.stringify(v)) { merged[f] = v; diff = true; }
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
  if (outJson !== prevJson) {
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
  const { months, live, performances, social, perfCuts, meta } = body || {};
  const replace = new Set(Array.isArray(body && body.replace) ? body.replace : []);

  const idx = normIndex(await kv.get('index', { type: 'json' }));
  const oldSig = idxSignature(idx);
  const result = { months: {}, live: null, performances: null, social: null, perfCuts: null };
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
      const r = await mergeMonth(kv, m, msgs);
      idx.counts[m] = r.total;
      result.months[m] = { total: r.total, added: r.added, wrote: r.wrote };
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
