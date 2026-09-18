// 诊断用：验证 Cloudflare Pages Functions 是否在该项目上生效。
// GET /ping → "pong"。若线上返回 404，说明 Functions 未启用。
export async function onRequestGet() {
  return new Response('pong', {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  });
}
