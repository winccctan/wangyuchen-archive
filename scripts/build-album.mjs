// 口袋相册：从**发言 KV**（/api/month，msg/YYYY-MM）聚合出「她本人发的图」→ 推回 KV 单键 `album`。
//
// 🔴 为什么改成这条路（2026-10-14 站长指出「相册图片要和发言一样同时更新」）：
//   相册原本是**一次性生成的静态文件** site/js/her-album.js（738KB，3414 组），只有人手动跑脚本才会更新
//   ⇒ 她 10-14 之后新发的图一条都进不去。而静态文件要更新还得提交 + 触发 Cloudflare 全站重建，
//   跟项目「数据上线 = 推 KV（不是改静态文件）」的既定做法也是冲突的。
//
// ✅ 新链路：发言本来就在 KV 的 msg/YYYY-MM 里（CI 每轮都写），相册直接从它聚合
//   ⇒ 不需要本机那份 31MB 全量原始（CI 上根本没有，也不该进仓库），也不需要提交任何文件。
//   实测（2026-10-14）：48 个月 → 55,362 条发言 → 本人发图 **3417 组**（比当时的静态文件还多 3 组）。
//
// 过滤口径：sender.userId === 89653517（她本人）。⚠️ 不能不过滤 —— 她的房间里还有别的人和粉丝发言。
//
// 用法：
//   node scripts/build-album.mjs            # 聚合 + 推 KV（需要 SYNC_TOKEN / GH_TOKEN）
//   node scripts/build-album.mjs --dry      # 只统计不推
//   node scripts/build-album.mjs --write    # 顺带更新本地静态兜底 site/js/her-album.js（默认不写）
//
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const STATIC_OUT = resolve(ROOT, 'site', 'js', 'her-album.js');

const HER = 89653517;
const IMG_DOM = /kd48-nosdn\.yunxinsvr\.com|nim-nosdn\.netease\.im|source\.48\.cn/;
const MONTH_FROM = '2022-11';                 // 补档起点（与 fans 档案同口径）
const DRY = process.argv.includes('--dry');
const WRITE = process.argv.includes('--write');

// 零依赖读 scraper/.env 拿 SYNC_TOKEN / GH_TOKEN（与 push-birthday.mjs 同一条通道）
function loadEnv() {
  try {
    const text = readFileSync(resolve(ROOT, 'scraper', '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch { /* 没有 .env 就用系统环境变量 */ }
}
loadEnv();

const SITE = (process.env.SITE || process.env.WORKER_URL || 'https://idol.wyc0518.cc').replace(/\/$/, '');
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36' };

// 北京时间「当月」
function bjNowMonth() {
  return new Date(Date.now() + 28800000).toISOString().slice(0, 7);
}
function monthRange(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

async function month(m) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${SITE}/api/month?m=${m}`, { headers: UA });
      if (!r.ok) return [];
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j.msgs || j.messages || j.data || []);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      await new Promise((r2) => setTimeout(r2, 800 * (i + 1)));
    }
  }
  return [];
}

// ⚡ 默认**增量**：只重刷最近几个月，跟 KV 里已有的合并（几十秒 → 几秒，才能高频跑）。
//   KV 里还没数据（首次）或加 --full 时才全量扫 2022-11 起。
async function fetchCurrent() {
  try {
    const r = await fetch(SITE + '/api/album', { headers: UA });
    if (!r.ok) return [];
    const j = await r.json();
    const a = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
function lastNMonths(n) {
  const [y0, m0] = bjNowMonth().split('-').map(Number);
  const out = [];
  let y = y0, m = m0;
  for (let i = 0; i < n; i++) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m -= 1; if (m < 1) { m = 12; y -= 1; }
  }
  return out.reverse();
}
const FULL = process.argv.includes('--full') || process.env.ALBUM_FULL === '1';
const base = FULL ? [] : await fetchCurrent();
const months = base.length ? lastNMonths(3) : monthRange(MONTH_FROM, bjNowMonth());
console.log(`[相册] ${base.length ? '增量（刷最近 ' + months.length + ' 个月）' : '全量'}｜KV 现有 ${base.length} 组`);

const out = [];
let totalMsgs = 0;
let emptyMonths = 0;
for (let i = 0; i < months.length; i += 6) {
  const batch = months.slice(i, i + 6);
  const rs = await Promise.all(batch.map(month));
  for (const arr of rs) {
    if (!arr.length) { emptyMonths++; continue; }
    totalMsgs += arr.length;
    for (const m of arr) {
      const uid = Number(m.sender && (m.sender.userId || m.sender.uid));
      if (uid !== HER) continue;                        // ★ 只取她本人
      const imgs = (Array.isArray(m.images) ? m.images : []).filter((u) => IMG_DOM.test(u));
      if (!imgs.length) continue;
      const ts = Number(m.msgTime) || 0;
      out.push({
        id: 'ph-' + (m.msgIdServer || out.length),
        text: m.text || '',
        images: imgs,
        time: ts ? new Date(ts + 28800000).toISOString().slice(0, 10) : '',
        ts,                                             // 「查看原发言」跳回聊天位置要用
      });
    }
  }
}
// 合并：本次刷到的覆盖同 id 旧值（发言重解析后图可能变），其余沿用 KV 已有的历史
if (base.length) {
  const merged = new Map();
  for (const it of base) if (it && it.id) merged.set(it.id, it);
  for (const it of out) merged.set(it.id, it);
  const keep = [];
  for (const it of merged.values()) if (it && Array.isArray(it.images) && it.images.length) keep.push(it);
  out.length = 0;
  out.push(...keep);
}
out.sort((a, b) => (b.ts || 0) - (a.ts || 0) || String(b.time).localeCompare(String(a.time)));

const years = {};
for (const it of out) { const y = (it.time || '').slice(0, 4) || '?'; years[y] = (years[y] || 0) + 1; }
console.log(`[相册] 月份 ${months.length} 个（空 ${emptyMonths}）｜发言 ${totalMsgs} 条 → 本人发图 ${out.length} 组，按年 ${JSON.stringify(years)}`);

// 🔴 完整性闸门：album 是整键覆盖写。发言 KV 若只回来一部分（接口抽风/并发限流），
//    组数会骤降 —— 这时宁可不推，也不能把线上 3400 组冲成几百组。
//    她的发图只增不减，所以下限长期有效（2026-10-14 基线 3417 组）。
const MIN = Number(process.env.ALBUM_MIN || 3000);
const FORCE = process.argv.includes('--force') || process.env.ALBUM_FORCE === '1';
if (out.length < MIN && !FORCE) {
  console.error(`[相册] 只有 ${out.length} 组（下限 ${MIN}）→ 判定数据不完整，放弃推送。确要覆盖用 --force`);
  process.exit(1);
}

if (WRITE) {
  writeFileSync(STATIC_OUT, '/* 自动生成：scripts/build-album.mjs（源：发言 KV /api/month，sender.userId 过滤本人发图）*/\n'
    + 'window.__HER_ALBUM__ = ' + JSON.stringify(out, null, 0) + ';\n');
  console.log('[相册] 已更新本地静态兜底 ' + STATIC_OUT);
}

// 没变化就不写：她没发新图时一次 KV 写入都不产生（高频跑也不费额度）
if (base.length && out.length === base.length && out[0] && base[0] && out[0].ts === base[0].ts && !FORCE) {
  console.log('[相册] 与线上一致（最新一条未变），跳过推送');
  process.exit(0);
}

if (DRY) { console.log('[相册] --dry 模式，不推送'); process.exit(0); }

const sync = process.env.SYNC_TOKEN || '';
const gh = process.env.GH_TOKEN || '';
if (!sync && !gh) { console.error('[相册] 缺 SYNC_TOKEN / GH_TOKEN，放弃'); process.exit(1); }
const headers = { 'content-type': 'application/json', ...UA };
if (sync) headers['x-sync-token'] = sync; else headers['x-gh-token'] = gh;

// 🔴 端点是 /api/_fans_upsert（不是 /api/sync）：kind 类写入（bd 生日祝福 / tk 票根 / album 相册）
//    全部走这一个函数 handleFansUpsert；/api/sync 只认 rows/bucket 那套发言档案格式。
const res = await fetch(SITE + '/api/_fans_upsert', {
  method: 'POST', headers, body: JSON.stringify({ kind: 'album', data: out }),
});
const txt = await res.text();
if (!res.ok) { console.error('[相册] 推送失败', res.status, txt.slice(0, 300)); process.exit(1); }
console.log('[相册] 已推送 →', txt.slice(0, 160));
