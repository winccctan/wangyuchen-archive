/**
 * 礼物价目字典构建 —— 官方在售 + 站长手工 + 弹幕反向累积，三层合并
 * ============================================================================
 * 背景（2026-09-23 定论，别再重复论证）：
 *   官方**没有**「全量含下架礼物」的接口。/gift/api/v1/gift/list 任何参数
 *   （{} / giftType / status / isAll / userId …）都只返回当前在售的 38 件，
 *   分类数组形态 [{typeName, giftList:[{giftId, giftName, money, melee}]}]。
 *   下列路径全部实测 404：
 *     /gift/api/v1/gift/all          /gift/api/v1/gift/config
 *     /gift/api/v1/gift/list/all     /gift/api/v1/gift/list/history
 *     /gift/api/v1/gift/offline/list /gift/api/v1/gift/info
 *     /gift/api/v1/gift/search       /im/api/v1/gift/list
 *     /live/api/v1/live/gift/config  /live/api/v1/live/gift/list
 *     /api/v1/gift/list（无产品前缀的老写法）
 *   → 限定/节日/已下架礼物只能靠「弹幕/房间记录里出现 → 人工核实 → 写进手工表」累积。
 *
 * 三层来源优先级（先命中先用）：
 *   1. manual  —— data/gift-prices.json 手工表（含下架限定，站长 App 内逐个核实）
 *   2. dict    —— data/gift-dict.json 上一次的本 script 产物快照（离线兜底）
 *   3. official—— /gift/api/v1/gift/list 实时拉取并缓存到 .cache/gift-official.json
 *   特殊值 -1 = 明确不是礼物（年度活动打分道具等），必然剔除。
 *
 * 用法：
 *   node scripts/build-gift-dict.mjs              # 构建并打印未定价清单
 *   node scripts/build-gift-dict.mjs --write-prices   # 把可确认的新礼物写回手工表（谨慎）
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const MANUAL_FILE = path.join(ROOT, 'data/gift-prices.json');
const DICT_FILE = path.join(ROOT, 'data/gift-dict.json');
const OFFICIAL_CACHE = path.join(CACHE, 'gift-official.json');
const DANMU_FILE = path.join(CACHE, 'live-gifts.jsonl');
const UNRESOLVED_FILE = path.join(ROOT, 'data/gift-dict-unresolved.json');
const TOP20_FILE = path.join(CACHE, 'fans/live.jsonl');   // 官方每场 Top20 榜：{liveId,ct,u,nick,m}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };

/* ---------- 1. 官方在售（联网，失败用缓存） ---------- */
async function official() {
  let catalog = null, live = false;
  try {
    const A = await import(path.join(ROOT, 'scraper/lib/api.mjs'));
    const { POCKET48_TOKEN } = await import(path.join(ROOT, 'scraper/lib/config.mjs'));
    const r = await A.postJson('/gift/api/v1/gift/list', {}, { token: POCKET48_TOKEN, retries: 2 });
    if (r && r.status === 200 && Array.isArray(r.content)) { catalog = r.content; live = true; }
  } catch { /* 离线也能跑 */ }
  if (!catalog) catalog = readJson(OFFICIAL_CACHE, null);
  const flat = Array.isArray(catalog) ? catalog.flatMap((t) => (t && t.giftList) || []) : [];
  return {
    live,
    map: new Map(flat.filter((g) => g && g.giftName).map((g) => [g.giftName, { money: Number(g.money) || 0, id: String(g.giftId || ''), cat: '' }])),
    raw: catalog,
  };
}

/* ---------- 2. 合并三层 ---------- */
const manual = readJson(MANUAL_FILE, { prices: {}, _excludeNames: [] });
const MANUAL = new Map(Object.entries(manual.prices || {}));
const EXCLUDE = new Set(manual._excludeNames || []);
const SNAP = readJson(DICT_FILE, { resolved: {} });

const off = await official();
if (off.live && off.raw) fs.writeFileSync(OFFICIAL_CACHE, JSON.stringify(off.raw));

const dict = new Map();     // name -> {price, via, id}
for (const nm of EXCLUDE) dict.set(nm, { price: -1, via: 'exclude' });
for (const [nm, v] of Object.entries(SNAP.resolved || {})) if (!dict.has(nm)) dict.set(nm, { price: v.price, via: 'snapshot', id: v.id });
for (const [nm, money] of MANUAL) dict.set(nm, { price: Number(money) || 0, via: 'manual' });      // 手工表最权威，覆盖快照
for (const [nm, g] of off.map) if (!dict.has(nm) || dict.get(nm).via === 'snapshot') dict.set(nm, { price: g.money, via: 'official', id: g.id });

/* ---------- 3. 扫描实际出现过的礼物名，找出 dar 未定价的 ---------- */
const seen = new Map();      // name -> {n, num}
const bump = (nm, num) => {
  const c = seen.get(nm) || { n: 0, num: 0 };
  c.n++; c.num += Number(num) || 1; seen.set(nm, c);
};
for (const line of readLines(DANMU_FILE)) {
  let g; try { g = JSON.parse(line); } catch { continue; }
  if (g && g.gift) bump(g.gift, g.num);
}
for (const f of ['live.jsonl', 'room.jsonl']) {
  for (const line of readLines(path.join(CACHE, 'fans', f))) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    for (const key of ['nm', 'gift', 'giftName']) if (r && r[key]) { bump(r[key], r.num || r.n || 1); break; }
  }
}

/* ---------- 3.5 未知礼物自动定价：用官方 Top20 总额倒推 ----------
 * 思路（2026-09-23 验证有效）：同一场直播里，某人的官方 Top20 金额 m
 * 减去他在这场里「已能定价的礼物」之和，剩下的差额就是他那件未知礼物的单价。
 * 前提：该送礼人在这场的官方榜 m 里只差这一件未知礼物。多个候选取最小值（保守）。
 * 样例：2026-07-18 那场 狗头猫头鹰 Top1 m=5065，已定价只有 3×荧光棒-NIII=15
 *       → 穹宇猫萌一 = 5050（该场同批核对：饺子榜de小胖纸 110=110、光语 5=5 全部吻合）
 */
function deriveUnknown(unresolvedNames) {
  if (!unresolvedNames.size) return new Map();
  const priceOf = (nm) => { const e = dict.get(nm); return e && e.price != null ? e.price : null; };

  // 官方每场 Top20：`liveId|nick` -> 该场总额（同一天多场可能重名，取最大）
  const top20 = new Map();
  for (const line of readLines(TOP20_FILE)) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || r.liveId == null || !r.nick) continue;
    const k = `${r.liveId}|${r.nick}`;
    if (Number(r.m) > (top20.get(k) || 0)) top20.set(k, Number(r.m));
  }
  // 把弹幕按「这场这个人」分组，避免 O(n^2) 反复读文件
  const groups = new Map();
  for (const line of readLines(DANMU_FILE)) {
    let g; try { g = JSON.parse(line); } catch { continue; }
    if (!g || !g.nick) continue;
    const k = `${g.liveId}|${g.nick}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(g);
  }

  const cand = new Map();          // name -> Set(推算单价)
  for (const [key, items] of groups) {
    const total = top20.get(key);
    if (total == null) continue;                          // 官方榜里没有这个人 → 无从倒推
    const unknown = items.filter((x) => priceOf(x.gift) == null);
    if (unknown.length !== 1) continue;                   // 有 0 件（无需）或多件未知（推不准）
    let known = 0;
    for (const x of items) { const p = priceOf(x.gift); if (p != null) known += p * (Number(x.num) || 1); }
    const delta = total - known;
    if (delta <= 0) continue;
    const num = Number(unknown[0].num) || 1;
    if (!cand.has(unknown[0].gift)) cand.set(unknown[0].gift, new Set());
    cand.get(unknown[0].gift).add(Math.round(delta / num));
  }
  const out = new Map();
  for (const [nm, set] of cand) out.set(nm, { price: Math.min(...set), candidates: [...set] });
  return out;
}
const unresolved0 = [];
for (const [nm, c] of [...seen]) { const e = dict.get(nm); if (!e || e.price == null) unresolved0.push({ name: nm, ...c }); }

// 用官方 Top20 总额倒推定价（只对这场只缺一件未知礼物的人有效）
const derived = deriveUnknown(new Set(unresolved0.map((u) => u.name)));
const derivedPretty = [];
for (const [nm, d] of derived) {
  dict.set(nm, { price: d.price, via: 'derived', id: '' });
  const c = seen.get(nm);
  derivedPretty.push(`   ${nm.padEnd(18)} = ${String(d.price).padStart(6)} 鸡腿` +
    (d.candidates.length > 1 ? `（候选 ${d.candidates.join('/')}，取最小）` : '') +
    `  ${c.num} 件 / ${c.n} 次`);
}
const unresolved = [];
const rows = [];
for (const [nm, c] of [...seen].sort((a, b) => b[1].num - a[1].num)) {
  const e = dict.get(nm);
  if (!e || e.price == null) unresolved.push({ name: nm, ...c });
  else rows.push({ name: nm, price: e.price, via: e.via, id: e.id || '', ...c });
}

/* ---------- 4. 落盘 ---------- */
const resolved = {};
for (const [nm, e] of dict) if (e.price >= 0) resolved[nm] = { price: e.price, via: e.via, id: e.id || '' };
const out = {
  _comment: '礼物价目字典（自动合并产物，勿手改）。来源优先级：手工表 > 上次快照 > 官方在售。',
  _note: '官方无「含下架」接口，限定礼物靠弹幕/房间记录里出现后人工核价补入 data/gift-prices.json。',
  builtAt: Date.now(),
  officialLive: off.live,
  counts: { total: Object.keys(resolved).length, manual: MANUAL.size, official: off.map.size, exclude: EXCLUDE.size },
  resolved,
};
fs.writeFileSync(DICT_FILE, JSON.stringify(out, null, 1));
fs.writeFileSync(UNRESOLVED_FILE, JSON.stringify({ builtAt: Date.now(), names: unresolved }, null, 1));

console.log(`\n===== 礼物价目字典 =====`);
console.log(`官方接口 ${off.live ? '实时' : '（离线，用缓存）'} ${off.map.size} 件 | 手工表 ${MANUAL.size} 条 | 打分道具剔除名单 ${EXCLUDE.size} 条`);
console.log(`合并后可定价 ${Object.keys(resolved).length} 种 → ${DICT_FILE}`);
console.log(`\n记录里实际出现 ${seen.size} 种礼物：`);
console.log(`  可定价 ${rows.length} 种    来源分布：` +
  Object.entries(rows.reduce((m, r) => (m[r.via] = (m[r.via] || 0) + 1, m), {})).map(([k, v]) => `${k}=${v}`).join(' '));
if (derivedPretty.length) {
  console.log(`\n🔎 由官方 Top20 总额倒推定出 ${derivedPretty.length} 种（建议站长在 App 内复核后再转手工表）：`);
  derivedPretty.forEach((s) => console.log(s));
}
if (unresolved.length) {
  console.log(`\n❌ 未定价 ${unresolved.length} 种（会被 build-fans 静默丢弃！请逐个核实后补进 data/gift-prices.json）：`);
  for (const u of unresolved) console.log(`   ${u.name.padEnd(18)} ${String(u.num).padStart(5)} 件 / ${String(u.n).padStart(4)} 次`);
} else {
  console.log('\n✅ 全部礼物都能定价，无丢弃。');
}
