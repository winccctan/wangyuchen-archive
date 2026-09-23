/*
 * 把 .cache/live-gifts.jsonl（弹幕里的礼物播报）聚合成「粉丝送礼榜（鸡腿）」。
 * 数据来源 = build-live-gifts.mjs 扫出的每场直播 LRC。
 *
 * 用法：
 *   node scripts/build-live-gift-rank.mjs                 # 全量（含所有年份）
 *   node scripts/build-live-gift-rank.mjs --since 2026-01-01
 *
 * 产物：
 *   private-data/直播礼物榜-从弹幕提取.csv
 *
 * 口径要点（跟档案库对齐）：
 *   1. 只算 target 含「王语晨」的（同一场里给别人送的礼物不算她的）
 *   2. 剔除打分道具（_excludeNames）—— 那是投票道具不是礼物
 *   3. 礼物名 → 鸡腿：官方 /gift/api/v1/gift/list 优先，其次 data/gift-prices.json 手工价
 *   4. 昵称 → uid：用 scripts/lib/nick-uid.mjs（房间 + 直播榜 + 口袋动态三源合并，
 *      同一昵称被多个 uid 用过时取出现最多的，并标注「占优 / 存疑」置信度）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNickUidIndex, resolveNick } from './lib/nick-uid.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ARG = process.argv.slice(2);
const SINCE = ARG.includes('--since') ? Date.parse(ARG[ARG.indexOf('--since') + 1]) : 0;

const readJsonl = (p) => {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n')
    .map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
};

/* ---------- 1. 礼物价目 ---------- */
const giftPrices = JSON.parse(fs.readFileSync(ROOT + '/data/gift-prices.json', 'utf8'));
const manualPrices = giftPrices.prices || {};
const excludeNames = new Set(giftPrices._excludeNames || []);
// 合并字典（含倒推定出的下架限定礼物），先跑 build-gift-dict.mjs 才会有
let dictResolved = {};
try { dictResolved = JSON.parse(fs.readFileSync(ROOT + '/data/gift-dict.json', 'utf8')).resolved || {}; } catch { /* 没生成过也能跑 */ }
let official = [];
try {
  const A = await import(ROOT + '/scraper/lib/api.mjs');
  const d = await A.postJson('/gift/api/v1/gift/list', {}, { retries: 1 });
  official = (d.content || []).flatMap((t) => t.giftList || []);
} catch { console.warn('⚠️ 官方价目拉取失败，仅用手工价目'); }

const priceOf = (name) => {
  let g = official.find((x) => x.giftName === name);
  if (!g) g = official.find((x) => x.giftName && (x.giftName === name.replace(/-[A-Z]+$/, '')));
  if (!g) g = official.find((x) => x.giftName && name.startsWith(x.giftName));
  if (g) return g.money;
  if (manualPrices[name] != null) return manualPrices[name];
  // 最后兜底：data/gift-dict.json（由 scripts/build-gift-dict.mjs 生成，
  // 含「官方 Top20 总额倒推」出来的下架限定礼物价）。没有这层会把这类礼物静默丢掉。
  return (dictResolved[name] && dictResolved[name].price >= 0) ? dictResolved[name].price : null;
};
const isScoring = (name) => excludeNames.has(name) || /^\d+(\.\d+)?分$/.test(name);

/* ---------- 2. 昵称 → uid 索引（共用模块，与 build-fans.mjs 口径一致） ---------- */
const NICK_UID = buildNickUidIndex(ROOT + '/.cache/fans', ROOT + '/data/nick-uid-pins.json');

/* ---------- 3. 聚合 ---------- */
const rows = readJsonl(ROOT + '/.cache/live-gifts.jsonl');
const byPerson = new Map();   // key = uid 或昵称
const unknownGifts = new Map();
let kept = 0, droppedTarget = 0, droppedScoring = 0, noPrice = 0;

for (const r of rows) {
  if (SINCE && !(r.ct >= SINCE)) continue;
  if (!/王语晨/.test(r.target || '')) { droppedTarget++; continue; }   // 别人的场次
  if (isScoring(r.gift)) { droppedScoring++; continue; }

  const price = priceOf(r.gift);
  if (price == null) { noPrice++; unknownGifts.set(r.gift, (unknownGifts.get(r.gift) || 0) + r.num); }

  const res = resolveNick(NICK_UID, r.nick);
  const uid = res.uid;
  const key = uid || ('nick:' + r.nick);

  if (!byPerson.has(key)) byPerson.set(key, { key, uid, nicks: new Set(), gifts: new Map(), num: 0, legs: 0, first: Infinity, last: 0, unpriced: 0, labels: new Set(), cands: [] });
  const P = byPerson.get(key);
  P.nicks.add(r.nick);
  P.labels.add(res.label);
  if (res.candidates.length > 1 && !P.cands.length) P.cands = res.candidates;
  P.gifts.set(r.gift, (P.gifts.get(r.gift) || 0) + r.num);
  P.num += r.num;
  if (price != null) P.legs += price * r.num; else P.unpriced += r.num;
  if (r.ct) { P.first = Math.min(P.first, r.ct); P.last = Math.max(P.last, r.ct); }
  kept++;
}

/* ---------- 4. 输出 ---------- */
const list = [...byPerson.values()].sort((a, b) => b.legs - a.legs);
const csvEsc = (s) => (/[",\n]/.test(String(s)) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s));
const out = [
  '排名,uid,昵称,鸡腿,礼物件数,送礼场次(首),送礼场次(末),未定价件数,归户依据,候选uid(次数),主要礼物',
];
list.forEach((p, i) => {
  const top = [...p.gifts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([g, c]) => `${g}×${c}`).join(' ');
  out.push([
    i + 1,
    p.uid || '',
    [...p.nicks].join(' / '),
    p.legs,
    p.num,
    p.first === Infinity ? '' : new Date(p.first).toISOString().slice(0, 10),
    p.last ? new Date(p.last).toISOString().slice(0, 10) : '',
    p.unpriced,
    [...p.labels].join(' / ') || (p.uid ? '唯一命中' : '无来源'),
    p.cands.length ? p.cands.map(([u, c]) => `${u}×${c}`).join(' ') : '',
    top,
  ].map(csvEsc).join(','));
});

const dir = ROOT + '/private-data';
fs.mkdirSync(dir, { recursive: true });
const file = dir + '/' + (SINCE ? `直播礼物榜-从弹幕提取-${new Date(SINCE).toISOString().slice(0, 10)}起.csv` : '直播礼物榜-从弹幕提取.csv');
fs.writeFileSync(file, out.join('\n'), 'utf8');

const total = list.reduce((s, p) => s + p.legs, 0);
const withUid = list.filter((p) => p.uid);
const noUid = list.filter((p) => !p.uid);
const legsWith = withUid.reduce((s, p) => s + p.legs, 0);
const amb = list.filter((p) => [...p.labels].some((l) => l.startsWith('占优') || l.startsWith('存疑')));
console.log(`
══ 直播礼物榜（来源：弹幕 LRC 礼物播报）══
礼物事件 ${rows.length} 条 → 采用 ${kept} 条
  剔除：不是送给她 ${droppedTarget} 条 / 打分道具 ${droppedScoring} 条
归户 ${list.length} 人 → 对上 uid ${withUid.length} 人（${legsWith.toLocaleString()} 鸡腿 = ${total ? (legsWith / total * 100).toFixed(1) : 0}%）
  昵称被多个 uid 用过、按出现次数归户的：${amb.length} 人（已在 CSV「归户依据」列标注）
未能归户 ${noUid.length} 人 / ${(total - legsWith).toLocaleString()} 鸡腿（该昵称在房间/直播/动态三个来源里都没出现过）
落选：无价目 ${noPrice} 条
合计鸡腿 ${total.toLocaleString()}

── Top 15 ──`);
list.slice(0, 15).forEach((p, i) => {
  console.log(`  ${String(i + 1).padStart(2)}. ${String(p.legs).padStart(9)} 鸡腿  ${p.num}件  ${p.uid || '(无uid)'}  ${[...p.nicks].join('/').slice(0, 24)}`);
});
if (unknownGifts.size) {
  console.log('\n⚠️ 查不到价目的礼物（需要站长补价）：');
  [...unknownGifts.entries()].sort((a, b) => b[1] - a[1]).forEach(([g, c]) => console.log(`   ${String(c).padStart(3)}件  ${g}`));
}
if (noUid.length) {
  console.log('\n⚠️ 未能归户（昵称在房间/直播/动态里都没出现过，需人工核对）：');
  noUid.sort((a, b) => b.legs - a.legs).slice(0, 20)
    .forEach((p) => console.log(`   ${String(p.legs).padStart(7)} 鸡腿  ${[...p.nicks].join(' / ').slice(0, 28)}`));
}
console.log('\n产物：' + file);
