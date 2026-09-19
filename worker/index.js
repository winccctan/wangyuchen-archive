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

    if (url.pathname === '/translate') {
      return handleTranslate(request, url, env, ctx);
    }

    // 手动触发抓取：POST /scrape → 经 GitHub API 触发仓库的 scrape.yml 工作流。
    // 这样前端的「刷新」按钮和「页面加载」都能真正去抓一次，而不是只重载旧静态数据。
    if (url.pathname === '/scrape' && request.method === 'POST') {
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

async function handleTranslate(request, url, env, ctx) {
  const q = url.searchParams.get('q');
  const tl = url.searchParams.get('tl') || 'en';
  if (!q) return json({ error: 'missing q' }, 400);

  // 边缘缓存：同一段文本 24h 内不再重复推理/回源（省 AI 额度、降延迟）
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  // 1) Workers AI（Cloudflare 边缘自推理）
  if (env && env.AI) {
    try {
      const out = await env.AI.run(AI_MODEL, { text: q, source_lang: SRC_LANG, target_lang: tl });
      const text = out && (out.translated_text || out.response || out.result);
      if (text && String(text).trim()) {
        return respondCached({ text: String(text).trim(), via: 'workers-ai' }, cache, cacheKey, ctx);
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
      if (text) return respondCached({ text, via: 'google' }, cache, cacheKey, ctx);
    }
  } catch (e) {
    // 忽略
  }

  return json({ error: 'translate-failed' }, 502);
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
