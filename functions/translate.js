// Cloudflare Pages Function：把浏览器翻译请求代理到 Google 翻译。
// 作用：
//   1) 解决中国大陆网络访问不了 translate.googleapis.com（浏览器直连会被墙，fetch 直接网络报错 → “翻译失败”）；
//   2) 顺带规避任何潜在的跨域问题——浏览器只与本站点同源通信，由 Cloudflare 边缘节点去访问 Google。
// 路由：GET /translate?tl=<目标语言>&q=<原文>
// 返回：Google 原始 JSON（前端按 data[0].map(s=>s[0]).join('') 解析），并带 CORS + 边缘缓存。
export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const q = url.searchParams.get('q');
  const tl = url.searchParams.get('tl') || 'en';
  if (!q) {
    return new Response(JSON.stringify({ error: 'missing q' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }
  const api = new URL('https://translate.googleapis.com/translate_a/single');
  api.searchParams.set('client', 'gtx');
  api.searchParams.set('sl', 'auto');
  api.searchParams.set('dt', 't');
  api.searchParams.set('tl', tl);
  api.searchParams.set('q', q);
  try {
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
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { 'content-type': 'application/json' }
    });
  }
}
