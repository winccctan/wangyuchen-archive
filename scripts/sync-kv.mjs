// 王语晨补档站 · 抓取结果写入 Cloudflare KV（替代「提交 git → 部署」）
// 由 GitHub Actions 在抓取链路的最后一步调用；也可本地手动跑做回填/排查。
//
// ★ 关键：数据源是 site/data/archive.js（build-archive.mjs 生成的「成品」），不是原始 json。
//   因为站点真正用的就是这份成品：公演已按「她的公演记录」筛过、挂了 B 站备用源、修过失效流域名，
//   消息也已瘦身（去掉只用于兜底的 raw）。直接推原始 json 会让公演页混进她没参加的场次、且体积翻倍。
//
// ★ 只推「可能再变」的数据：发言按月份键、且只推最近窗口内的月份；直播/公演只推近期条目。
//   更早的历史在 KV 里已经存着、且永不再变，无需每轮重传。
//   Worker 侧一律按唯一键**并集合并**（只增不删），所以本地快照不含 KV 里最新数据也不会误删。
//
// 依赖环境变量：
//   SYNC_TOKEN        必填，需与 Cloudflare 侧 SECRETS KV 里的 SYNC_TOKEN 一致（/api/sync 鉴权）
//   WORKER_URL        可选，默认 https://idol.wyc0518.cc
//   SYNC_WINDOW_DAYS  可选，默认 60（只同步最近 N 天内的数据）
//   SYNC_CHUNK_BYTES  可选，默认 4MB（单次请求体积上限，超出则拆包）
//
// 用法：
//   node scripts/sync-kv.mjs              # 增量（日常）
//   node scripts/sync-kv.mjs --full       # 全量发言：把全部月份都推一遍（历史回填用）
//   node scripts/sync-kv.mjs --rebuild    # 重建：全量月份 + 直播/公演整份覆盖（修正历史脏数据用）
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '../site/data');
const WORKER_URL = (process.env.WORKER_URL || 'https://idol.wyc0518.cc').replace(/\/$/, '');
const TOKEN = process.env.SYNC_TOKEN || '';
// 临时兜底：本机没有 SYNC_TOKEN 副本时，可用 GH_TOKEN 授权回填（跑完即撤）
const GH_TOKEN = process.env.GH_TOKEN || '';
const AUTH_HEADER = TOKEN ? { 'x-sync-token': TOKEN } : { 'x-gh-token': GH_TOKEN };
const WINDOW_DAYS = Number(process.env.SYNC_WINDOW_DAYS || 60);
const CHUNK_BYTES = Number(process.env.SYNC_CHUNK_BYTES || 4 * 1024 * 1024);
// --rebuild：把 KV 按 archive.js 的现状重建一遍（声明「这份就是权威全集」）。
// 日常绝不要用：它是唯一会「删数据」的路径，只在数据口径变了、需要清掉历史脏条目时手动跑一次。
const REBUILD = process.argv.includes('--rebuild') || process.env.SYNC_REBUILD === '1';
// --refill：走 /api/_d1_refill 整月覆盖写回，用于给历史存量补回 sender uid（一次性，不必常跑）
const REFILL = process.argv.includes('--refill') || process.env.SYNC_REFILL === '1';
const FULL = REBUILD || REFILL || process.argv.includes('--full');
const PRIV_DIR = resolve(__dirname, '../scraper/data');

if (!TOKEN && !GH_TOKEN) {
  console.error('[sync-kv] 缺少 SYNC_TOKEN（或 GH_TOKEN）环境变量：值需与 Cloudflare SECRETS KV 里的一致');
  process.exit(1);
}

// 读 build-archive.mjs 生成的成品：`window.__ARCHIVE__ = {...};`
function readArchive(file) {
  const code = readFileSync(file, 'utf8');
  const anchor = 'window.__ARCHIVE__ =';
  const i = code.indexOf(anchor);
  if (i < 0) throw new Error('archive.js 格式不符：未找到 window.__ARCHIVE__（请先跑 node scripts/build-archive.mjs）');
  const start = i + anchor.length;
  const end = code.lastIndexOf(';');
  return JSON.parse(code.slice(start, end));
}

function tryReadArchive(file) {
  try { return readArchive(file); } catch (_) { return null; }
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

const mb = (n) => (n / 1048576).toFixed(2) + 'MB';

async function postSync(body, path) {
  const r = await fetch(WORKER_URL + (path || '/api/sync'), {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, AUTH_HEADER),
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`/api/sync ${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

async function main() {
  const arc = readArchive(resolve(DATA_DIR, 'archive.js'));
  // 发言源优先用「内部版」（scraper/data/archive-full.js，含 sender uid）：
  // 底层 D1/KV 要保留 uid，出口由 Worker 统一脱敏，浏览器仍拿不到。
  let messages = arc.messages || [];
  const arcFull = tryReadArchive(resolve(PRIV_DIR, 'archive-full.js'));
  if (arcFull && Array.isArray(arcFull.messages) && arcFull.messages.length) {
    if (arcFull.messages.length === messages.length) {
      messages = arcFull.messages;
      console.log('[sync-kv] 发言源：内部版（含 uid）→ 底层保留第三身份');
    } else {
      console.warn(`[sync-kv] ⚠️ 内部版 ${arcFull.messages.length} 条 ≠ 脱敏版 ${messages.length} 条，改用脱敏版（底层将缺 uid）`);
    }
  } else {
    console.warn('[sync-kv] ⚠️ 无 scraper/data/archive-full.js，发言按脱敏版同步（底层将缺 uid）');
  }
  const live = arc.live || [];
  const performances = arc.performances || [];
  const meta = Object.assign({}, arc.meta || {});
  // 页头统计由 Worker 按 KV 实际内容算，本地的 counts 是抓取端局部数字（公演未经筛选），丢掉避免误导
  delete meta.counts;
  const social = parseGlobalJs('social-media.js', 'SOCIAL_MEDIA') || [];
  const perfCuts = parseGlobalJs('performance-cuts.js', 'PERF_CUTS') || { cuts: [] };
  const liveCuts = parseGlobalJs('live-cuts.js', 'LIVE_CUTS') || { cuts: [] };

  const now = Date.now();
  const cutoff = now - WINDOW_DAYS * 86400000;
  const startMonth = monthOf(cutoff);

  // 1) 发言：按月分片。日常只取窗口内的月份（更早月份永不再变）；--full 时全量
  const byMonth = new Map();
  for (const m of messages) {
    const mo = monthOf(m.msgTime);
    if (!FULL && mo < startMonth) continue;
    if (!byMonth.has(mo)) byMonth.set(mo, []);
    byMonth.get(mo).push(m);
  }

  // 2) 直播 / 公演：日常只推近期条目（更早的 playUrl / 状态不会再变）；
  //    --rebuild 时推全量并声明「整份覆盖」，用于清掉口径变更前留下的脏条目。
  const livePush = REBUILD ? live : live.filter((x) => Number(x.ctime || 0) >= cutoff);
  const perfPush = REBUILD ? performances : performances.filter((x) => Number(x.stime || x.ctime || 0) >= cutoff);

  console.log(`[sync-kv] 源：发言 ${messages.length} 条 / 直播 ${live.length} 条 / 公演 ${performances.length} 条`
    + ` | 社媒美图 ${social.length} 条 | 公演 cut ${(perfCuts.cuts || []).length} 条 | 直播切片 ${(liveCuts.cuts || []).length} 条`);
  console.log(`[sync-kv] 窗口：最近 ${WINDOW_DAYS} 天（${REBUILD ? '★ --rebuild 重建模式' : (FULL ? '★ --full 全量月份' : startMonth + ' 起')}）`
    + ` → 发言 ${[...byMonth.values()].reduce((a, b) => a + b.length, 0)} 条 / ${byMonth.size} 个月，`
    + `直播 ${livePush.length} 条，公演 ${perfPush.length} 条`);

  // 3) 装箱：按体积拆成若干请求，避免单请求过大
  const parts = [];
  for (const [m, arr] of [...byMonth.entries()].sort()) {
    parts.push({ name: 'msg/' + m, body: { months: { [m]: arr } }, size: JSON.stringify(arr).length });
  }
  // --refill 只回填发言（整月覆盖写回 D1/KV 补 uid），不动直播/公演/社媒等
  if (!REFILL) {
    if (livePush.length) parts.push({ name: 'live', body: { live: livePush, ...(REBUILD ? { replace: ['live'] } : {}) }, size: JSON.stringify(livePush).length });
    if (perfPush.length) parts.push({ name: 'performances', body: { performances: perfPush, ...(REBUILD ? { replace: ['live', 'performances'] } : {}) }, size: JSON.stringify(perfPush).length });
    if (social.length) parts.push({ name: 'social', body: { social }, size: JSON.stringify(social).length });
    if (perfCuts && (perfCuts.cuts || []).length) parts.push({ name: 'perf-cuts', body: { perfCuts }, size: JSON.stringify(perfCuts).length });
    if (liveCuts && (liveCuts.cuts || []).length) parts.push({ name: 'live-cuts', body: { liveCuts }, size: JSON.stringify(liveCuts).length });
    parts.push({ name: 'meta', body: { meta }, size: JSON.stringify(meta).length });
  }

  const batches = [];
  let cur = null;
  for (const p of parts) {
    if (!cur || (cur.size + p.size > CHUNK_BYTES && cur.parts.length)) {
      cur = { parts: [], size: 0 };
      batches.push(cur);
    }
    cur.parts.push(p);
    cur.size += p.size;
  }

  let totalBytes = 0;
  const agg = { dataChanged: false, indexWritten: false, months: {}, live: null, performances: null, social: null, perfCuts: null, liveCuts: null, counts: null, updatedAt: 0 };
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    // 注意：同一批里可能有多个「月份」分片，必须逐个合并进同一个 months 对象；
    // 若直接用 Object.assign 覆盖，body.months 会被最后一个月份顶掉 → 前面几个月根本没发出去。
    const body = {};
    for (const p of b.parts) {
      if (p.body.months) {
        body.months = body.months || {};
        Object.assign(body.months, p.body.months);
        for (const k of Object.keys(p.body)) {
          if (k !== 'months') body[k] = p.body[k];
        }
      } else {
        Object.assign(body, p.body);
      }
    }
    const out = await postSync(body, REFILL ? '/api/_d1_refill' : '/api/sync');
    totalBytes += b.size;
    if (REFILL) {
      console.log(`[sync-kv] 第 ${i + 1}/${batches.length} 批（${mb(b.size)}）→ D1 写回 `
        + Object.entries(out.d1 || {}).map(([m, v]) => `${m}:${v && v.sent}${(v && v.error) ? '(' + v.error + ')' : ''}`).join(', ')
        + (out.errors && out.errors.length ? ` ❌ ${out.errors.join(' | ')}` : ''));
      continue;
    }
    console.log(`[sync-kv] 第 ${i + 1}/${batches.length} 批（${mb(b.size)}，含 ${b.parts.map((p) => p.name).join(', ')}）`
      + ` → 索引写入 ${out.indexWritten ? '是' : '否'}`);
    agg.dataChanged = agg.dataChanged || !!out.dataChanged;
    agg.indexWritten = agg.indexWritten || !!out.indexWritten;
    agg.counts = out.counts || agg.counts;
    agg.updatedAt = out.updatedAt || agg.updatedAt;
    if (out.wrote) {
      for (const [m, v] of Object.entries(out.wrote.months || {})) {
        const a = agg.months[m] || { total: 0, added: 0, wrote: false };
        agg.months[m] = { total: v.total, added: a.added + v.added, wrote: a.wrote || v.wrote };
      }
      for (const k of ['live', 'performances', 'social', 'perfCuts', 'liveCuts']) {
        const v = out.wrote[k];
        if (!v) continue;
        const a = agg[k] || { total: 0, added: 0, updated: 0, wrote: false };
        agg[k] = {
          total: v.total,
          added: (a.added || 0) + (v.added || 0),
          updated: (a.updated || 0) + (v.updated || 0),
          wrote: a.wrote || v.wrote
        };
      }
    }
  }

  const addedMsg = Object.values(agg.months).reduce((a, v) => a + (v.added || 0), 0);
  console.log(`[sync-kv] 完成：上传 ${mb(totalBytes)} / ${batches.length} 批`);
  console.log(`[sync-kv] 新增发言 ${addedMsg} 条`
    + ` | 直播 新增${(agg.live && agg.live.added) || 0}/更新${(agg.live && agg.live.updated) || 0}`
    + ` | 公演 新增${(agg.performances && agg.performances.added) || 0}/更新${(agg.performances && agg.performances.updated) || 0}`);
  if (agg.counts) {
    console.log(`[sync-kv] KV 现有：发言 ${agg.counts.messages} 条 / 直播 ${agg.counts.live} 条 / 公演 ${agg.counts.performances} 条`);
  }
  if (!agg.dataChanged) console.log('[sync-kv] 数据无实质变化（未产生多余写入）');
}

main().catch((e) => { console.error('[sync-kv] 失败：', e.message); process.exit(1); });
