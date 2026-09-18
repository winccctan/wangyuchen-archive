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

    if (env && env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not Found', { status: 404 });
  }
};

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
async function handleScrape(env) {
  const repo = (env && env.REPO) || 'winccctan/wangyuchen-archive';
  const token = env && env.GH_TOKEN;
  const ref = (env && env.SCRAPE_REF) || 'main';
  if (!token) {
    return json({ error: 'worker-missing-gh-token', hint: '请在 Cloudflare 配置 GH_TOKEN（wrangler secret put GH_TOKEN）' }, 500);
  }
  const api = `https://api.github.com/repos/${repo}/actions/workflows/scrape.yml/dispatches`;
  try {
    const r = await fetch(api, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'wyc-archive-worker',
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
