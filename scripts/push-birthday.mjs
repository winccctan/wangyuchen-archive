// 把「她给粉丝的生日祝福」推进 KV（bd/all），供 /api/mine 凭本人 uid 单条回取（前端「我的生贺」）。
//
// 🔴 数据源 .cache/birthday-uid.json 含粉丝 uid —— 只落本机 .cache（已 gitignore），
//    推到 KV 后也只在服务端：没有任何列举接口，前端永远拿不到别人的 uid。
//
// 用法：
//   node scripts/push-birthday.mjs            # 推线上
//   node scripts/push-birthday.mjs --dry      # 只统计不推
//
// 数据源由 scraper/scripts/fetch-her-birthday.mjs 产出（源：48动态 posts timeline）。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const SRC = resolve(ROOT, '.cache', 'birthday-uid.json');
const DRY = process.argv.includes('--dry');

// 零依赖读 scraper/.env 拿 GH_TOKEN（与 build-ticket.mjs 同一条授权通道）
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

if (!existsSync(SRC)) {
  console.error('[生日] 缺数据源 ' + SRC + '\n先跑：node scraper/scripts/fetch-her-birthday.mjs');
  process.exit(1);
}

const map = JSON.parse(readFileSync(SRC, 'utf8'));
const uids = Object.keys(map);
const posts = uids.reduce((a, u) => a + map[u].length, 0);
const years = {};
for (const u of uids) for (const w of map[u]) years[w.d.slice(0, 4)] = (years[w.d.slice(0, 4)] || 0) + 1;
console.log(`[生日] ${uids.length} 人 / ${posts} 条祝福，按年 ${JSON.stringify(years)}`);

// 🔴 人数骤降保护：bd/all 是整键覆盖写，抓少了会把线上历史冲掉。
//  2026-10-14 基线 87 人 / 112 条；低于下限（默认 60 人）视为抓取不完整，直接放弃这一轮。
//  确实要用更少的数据覆盖线上时：--force（或 env BD_FORCE=1）。
const MIN = Number(process.env.BD_MIN_UIDS || 60);
const FORCE = process.argv.includes('--force') || process.env.BD_FORCE === '1';
if (uids.length < MIN && !FORCE) {
  console.error(`[生日] 只有 ${uids.length} 人（下限 ${MIN}）→ 判定抓取不完整，放弃推送。确要覆盖用 --force`);
  process.exit(1);
}

const SITE = (process.env.SITE || 'https://idol.wyc0518.cc').replace(/\/$/, '');
const gh = process.env.GH_TOKEN || '';
const sync = process.env.SYNC_TOKEN || '';
if (DRY) { console.log('[生日] --dry 模式，不推送'); process.exit(0); }
if (!gh && !sync) { console.error('[生日] 缺 GH_TOKEN / SYNC_TOKEN，放弃'); process.exit(1); }

const headers = { 'content-type': 'application/json' };
if (sync) headers['x-sync-token'] = sync; else headers['x-gh-token'] = gh;

const res = await fetch(SITE + '/api/_fans_upsert', {
  method: 'POST', headers, body: JSON.stringify({ kind: 'bd', data: map }),
});
const txt = await res.text();
if (!res.ok) { console.error('[生日] 推送失败', res.status, txt.slice(0, 200)); process.exit(1); }
console.log('[生日] 已推送 →', txt.slice(0, 160));
