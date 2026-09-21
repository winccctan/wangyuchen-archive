// 王语晨补档站 · 抓取结果写入 Cloudflare KV（替代「提交 git → 部署」）
// 由 GitHub Actions 在 scraper 跑完 scrape.mjs 之后调用；也可本地手动跑做历史回填。
// 数据按「月」分键写 KV（msg/YYYY-MM），单月体积远小于 KV 单值 25MB 上限 → 可无限增长；
// 浏览器首屏读 /api/index（含 recent 最新若干条 + 月份列表），下滑「加载更早」惰性拉历史月。
//
// 依赖环境变量：
//   SYNC_TOKEN   必填，需与 Cloudflare 侧 SECRETS KV 里的 SYNC_TOKEN 一致（/api/sync 鉴权）
//   WORKER_URL   可选，默认 https://idol.wyc0518.cc
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '../site/data');
const WORKER_URL = (process.env.WORKER_URL || 'https://idol.wyc0518.cc').replace(/\/$/, '');
const TOKEN = process.env.SYNC_TOKEN;

if (!TOKEN) {
  console.error('[sync-kv] 缺少 SYNC_TOKEN 环境变量（在 GitHub Secrets / 本地环境变量中设置，值需与 Cloudflare SECRETS KV 的 SYNC_TOKEN 一致）');
  process.exit(1);
}

function loadJson(name) {
  try { return JSON.parse(readFileSync(resolve(DATA_DIR, name), 'utf8')); } catch (e) { return null; }
}

// 解析形如 `window.X = {...};` 的自动生成脚本，取出全局对象（SOCIAL_MEDIA / PERF_CUTS）
function parseGlobalJs(file, name) {
  try {
    const code = readFileSync(resolve(DATA_DIR, file), 'utf8');
    const fn = new Function('window', 'self', 'globalThis',
      code + `\n;return window.${name} || (self && self.${name}) || (typeof ${name} !== 'undefined' ? ${name} : null);`);
    return fn({});
  } catch (e) {
    console.warn(`[sync-kv] ${file} 解析失败（${name} 将为空）：${e.message}`);
    return null;
  }
}

function monthOf(ts) {
  const d = new Date((Number(ts) || Date.now()) + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function postSync(body) {
  const r = await fetch(WORKER_URL + '/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sync-token': TOKEN },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`/api/sync ${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

async function main() {
  const msgsDoc = loadJson('messages.json');
  const messages = (msgsDoc && msgsDoc.messages) || [];
  const live = (loadJson('live.json') || {}).live || [];
  const performances = (loadJson('performances.json') || {}).performances || [];
  const meta = loadJson('meta.json') || {};
  const social = parseGlobalJs('social-media.js', 'SOCIAL_MEDIA');
  const perfCuts = parseGlobalJs('performance-cuts.js', 'PERF_CUTS');

  // 1) 发言按月拆分，逐月 PUT（overwrite，避免单次请求体过大；KV 单值上限 25MB）
  const byMonth = new Map();
  for (const m of messages) {
    const k = monthOf(m.msgTime);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(m);
  }
  let done = 0;
  for (const [m, arr] of byMonth) {
    await postSync({ months: { [m]: arr }, mode: 'overwrite' });
    if (++done % 5 === 0) console.log(`[sync-kv] 已同步 ${done}/${byMonth.size} 个月`);
  }
  console.log(`[sync-kv] 发言：共 ${messages.length} 条，分 ${byMonth.size} 个月写入 KV`);

  // 2) 小数据全量覆盖（live / performances / social / perfCuts / meta）
  await postSync({ live, performances, social, perfCuts, meta });

  // 3) recent：取最新 60 条，供首屏秒更（无需等历史月全加载）
  const recent = messages
    .slice()
    .sort((a, b) => Number(b.msgTime || 0) - Number(a.msgTime || 0))
    .slice(0, 60);
  await postSync({ recent, meta });

  console.log('[sync-kv] live / performances / social / perf-cuts / meta / recent 同步完成');
}

main().catch((e) => { console.error('[sync-kv] 失败：', e.message); process.exit(1); });
