// 王语晨补档站 · Cloudflare Worker
// 职责：
//   1) 静态站点：dist/ 里的文件通过 env.ASSETS 提供（HTML/CSS/JS/数据）；
//   2) 同域翻译代理：GET /translate?tl=<目标语言>&q=<原文>
//      由 Cloudflare 边缘节点去请求 Google 翻译，再原样回传。
//      这样浏览器只与本站同源通信 —— 规避跨域，也让**大陆直连用户**能用（他们无法直连 Google）。
//   3) 健康检查：GET /ping → "pong"（用于确认 Worker 已生效）。
// 其它任何请求都透传给静态资源。
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ping') {
      return new Response('pong', {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
      });
    }

    if (url.pathname === '/translate') {
      return handleTranslate(url);
    }

    if (env && env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not Found', { status: 404 });
  }
};

async function handleTranslate(url) {
  const q = url.searchParams.get('q');
  const tl = url.searchParams.get('tl') || 'en';
  if (!q) return json({ error: 'missing q' }, 400);

  const api = new URL('https://translate.googleapis.com/translate_a/single');
  api.searchParams.set('client', 'gtx');
  api.searchParams.set('sl', 'auto');
  api.searchParams.set('dt', 't');
  api.searchParams.set('tl', tl);
  api.searchParams.set('q', q);

  try {
    // 边缘缓存：同样的文本 24h 内不再回源 Google，降低延迟与被限流风险
    const r = await fetch(api.toString(), { cf: { cacheTtl: 86400, cacheEverything: true } });
    const body = await r.text();
    return new Response(body, {
      status: r.status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=86400'
      }
    });
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }
  });
}
