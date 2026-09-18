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
