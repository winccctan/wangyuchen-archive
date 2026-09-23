/*
 * 把含明文 uid 的 2026 榜单覆盖表转成「脱敏版」，供 CI 使用。
 *
 * 背景：data/fans-2026-gift.json 的 map key 就是 uid，不能进公开仓库；
 * 但 .github/workflows/fans-sync.yml 每天要跑 build-fans.mjs --push，
 * 读不到这张表就会把 191 人的 total2026 静默打回自算值。
 *
 * 做法见 scripts/lib/uid-hash.mjs：key 换成 "h:" + sha256(uid) 前 16 位。
 *
 * 用法：node scripts/hash-gift-override.mjs
 * 产物：data/fans-2026-gift-hashed.json（进 git）
 * 输入：data/fans-2026-gift.json（含明文 uid，已 gitignore，本机专用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashUid, isHashed } from './lib/uid-hash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data/fans-2026-gift.json');
const OUT = path.join(ROOT, 'data/fans-2026-gift-hashed.json');

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const map = {};
for (const [uid, v] of Object.entries(src.map || {})) {
  const key = isHashed(uid) ? uid : hashUid(uid);   // 已经是 hash key 就原样保留
  // 不带 nick：构建只需要「金额 + 名次」，昵称留着反而可能夹带明文线索
  // （榜单里就有一个昵称本身就是 12 位数字），CI 那边 list 里本来也有自己的昵称。
  map[key] = { v: v.v, rank: v.rank };
}

fs.writeFileSync(OUT, JSON.stringify({
  source: src.source,
  note: (src.note || '') + '　⚠️ 本文件是脱敏版：key = "h:" + sha256(uid) 前 16 位，供 CI 使用，无法反查。',
  hashed: true,
  map,
}, null, 1), 'utf8');

console.log(`已生成 ${path.relative(ROOT, OUT)}：${Object.keys(map).length} 条（key 已脱敏为 sha256 前 16 位）`);
