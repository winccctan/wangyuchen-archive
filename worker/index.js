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

    // 翻译使用统计（站长自己看：浏览器打开 https://idol.wyc0518.cc/stats）
    if (url.pathname === '/stats' || url.pathname === '/stats/') {
      return handleStats(env);
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

    if (env && env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      return applyFreshPolicy(res, url);
    }
    return new Response('Not Found', { status: 404 });
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
const LANGS = ['en', 'es', 'fr', 'nl', 'pt', 'ro', 'ja', 'vi', 'ko', 'th'];
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

// 站长查看翻译使用情况：返回一张简单表格（累计次数 / 各语言 / 最近 7 天次数与独立访客）
async function handleStats(env) {
  const kv = env && env.SECRETS;
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
<h2>最近 7 天</h2><table><tr><td>日期</td><td class="n">次数</td><td class="n">独立访客</td></tr>${dayHtml}</table>`);
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
