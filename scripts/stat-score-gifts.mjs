#!/usr/bin/env node
/*
 * 统计某个人「送出过多少打分道具」—— 打分道具不是鸡腿，官方在算鸡腿时要剔除，
 * 但它本身是一种应援行为，站长想知道自己（或某个粉丝）到底打了多少分。
 *
 * 用法：
 *   node scripts/stat-score-gifts.mjs --uid 104006629            # 默认 2026 年
 *   node scripts/stat-score-gifts.mjs --uid 104006629 --year 2025
 *   node scripts/stat-score-gifts.mjs --uid 104006629 --all      # 全历史
 *   node scripts/stat-score-gifts.mjs --uid 104006629 --csv out.csv
 *
 * 两个来源：
 *   ① 口袋房间 .cache/fans/room.jsonl   —— 有 uid，最准；礼物在 g 字段 {id,nm,c,s}
 *   ② 直播弹幕 .cache/live-gifts.jsonl  —— 只有昵称，靠该 uid 的「历史昵称」反查
 *      （21.5% 的人改过名，只按现昵称搜会漏，所以昵称集合从 room.jsonl 全量收集）
 *
 * 打分道具判定（与 build-fans.mjs 的 isScoring 保持一致）：
 *   giftId 为 888 开头 6 位以内  ||  g.s === 1  ||  名字命中 data/gift-prices.json 的 _excludeNames
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const get = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? (argv[i + 1] || d) : d;
};
const UID = get('uid', '104006629');
const ALL = argv.includes('--all');
const YEAR = ALL ? null : Number(get('year', '2026'));
const CSV = get('csv', '');

/* ---------- 打分道具判定 ---------- */
const gp = JSON.parse(fs.readFileSync(ROOT + '/data/gift-prices.json', 'utf8'));
const EXCLUDE = new Set(gp._excludeNames || []);
const isScoreByGid = (id) => /^888\d{0,3}$/.test(String(id || ''));
const isScoreByName = (nm) => EXCLUDE.has(nm) || /^\d+(\.\d+)?分$/.test(String(nm || ''));
// 房间：g = { id, nm, c, s }
const roomIsScore = (g) => isScoreByGid(g.id) || Number(g.s) === 1 || isScoreByName(g.nm);
// 直播弹幕只有名字，没有 id 也没有 s 标志
const liveIsScore = (nm) => isScoreByName(nm);

const bjYear = (ms) => Number(new Date(Number(ms) + 8 * 3600e3).toISOString().slice(0, 4));
const bjMonth = (ms) => new Date(Number(ms) + 8 * 3600e3).toISOString().slice(0, 7);
const inRange = (ms) => (YEAR == null ? true : bjYear(ms) === YEAR);

/* ---------- ① 收集该 uid 的历史昵称（给直播侧用） ---------- */
const nicks = new Set();
for (const line of readLines(ROOT + '/.cache/fans/room.jsonl')) {
  const d = parse(line);
  if (d && d.u === UID && d.n) nicks.add(d.n);
}

/* ---------- ② 口袋房间 ---------- */
const room = { total: 0, score: 0, byName: new Map(), byMonth: new Map(), rows: [] };
for (const line of readLines(ROOT + '/.cache/fans/room.jsonl')) {
  const d = parse(line);
  if (!d || d.u !== UID || d.y !== 'GIFT_TEXT') continue;
  const g = d.g;
  if (!g) continue;
  if (!inRange(d.t)) continue;
  const c = Number(g.c || 1);
  room.total += c;
  if (!roomIsScore(g)) continue;
  room.score += c;
  room.byName.set(g.nm, (room.byName.get(g.nm) || 0) + c);
  room.byMonth.set(bjMonth(d.t), (room.byMonth.get(bjMonth(d.t)) || 0) + c);
  room.rows.push({ src: '口袋房间', at: bjMonth(d.t), name: g.nm, num: c, id: g.id });
}

/* ---------- ③ 直播弹幕 ---------- */
const live = { total: 0, score: 0, byName: new Map(), byMonth: new Map(), rows: [] };
for (const line of readLines(ROOT + '/.cache/live-gifts.jsonl')) {
  const d = parse(line);
  if (!d) continue;
  if (!nicks.has(d.nick)) continue;                 // 该 uid 用过的昵称才算
  if (!inRange(d.ct)) continue;
  const n = Number(d.num || 1);
  live.total += n;
  if (!liveIsScore(d.gift)) continue;
  live.score += n;
  live.byName.set(d.gift, (live.byName.get(d.gift) || 0) + n);
  live.byMonth.set(bjMonth(d.ct), (live.byMonth.get(bjMonth(d.ct)) || 0) + n);
  live.rows.push({ src: '直播', at: bjMonth(d.ct), name: d.gift, num: n, id: '' });
}

/* ---------- 输出 ---------- */
const tag = ALL ? '全历史' : YEAR + ' 年';
console.log(`\n══ uid ${UID} · ${tag} · 打分道具统计 ══`);
console.log(`历史昵称（用于匹配直播）：${[...nicks].join(' / ') || '（房间数据里没找到）'}\n`);
dump('口袋房间', room);
dump('直播', live);

const total = room.score + live.score;
console.log(`\n合计打分道具：${total} 个`);
console.log(`  口袋房间 ${room.score}  +  直播 ${live.score}`);
console.log(`（同期送礼总数：房间 ${room.total} 个、直播 ${live.total} 个；打分占比 ${room.total + live.total ? Math.round(total / (room.total + live.total) * 100) : 0}%）`);

if (CSV) {
  const rows = [...room.rows, ...live.rows].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const head = '来源,月份,道具名,数量,giftId\n';
  const body = rows.map((r) => [r.src, r.at, r.name, r.num, r.id].join(',')).join('\n');
  fs.writeFileSync(CSV, head + body + '\n');
  console.log(`\n已写出明细：${CSV}（${rows.length} 行）`);
}

function dump(label, o) {
  console.log(`【${label}】送礼 ${o.total} 个，其中打分道具 ${o.score} 个`);
  for (const [k, v] of [...o.byName.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${k}: ${v}`);
  }
  if (o.byMonth.size) {
    console.log('   按月: ' + [...o.byMonth.entries()].sort().map(([m, v]) => `${m} ${v}`).join(' | '));
  }
}

function readLines(file) {
  if (!fs.existsSync(file)) {
    console.error('缺少数据文件 ' + file);
    return [];
  }
  return fs.readFileSync(file, 'utf8').split('\n');
}
function parse(line) {
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}
