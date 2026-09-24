#!/usr/bin/env node
/**
 * 陪伴票根真数据：按 uid × 日期聚合「你那天说了什么 / 送了几个鸡腿」。
 *
 * 数据源（全部是服务端私有缓存，绝不进 git / dist / 公开 KV）：
 *   1) .cache/fans/fw-raw.jsonl   —— 房间 TEXT 全文扫描（build-first-words.mjs 的原始产物，
 *      含多次扫描的重复行，必须按消息 id 去重；字段 i/u/t/x/n）
 *   2) .cache/fans/room.jsonl     —— 房间元数据（GIFT_TEXT 的 g={id,nm,c,s}，折鸡腿 = 价目×件数）
 *   3) .cache/fans/live.jsonl     —— 官方直播贡献榜 Top20（u/ct/m，m 即鸡腿）
 *   4) .cache/live-gifts.jsonl    —— 直播弹幕送礼播报（只有昵称，归户后折鸡腿；2026-04 起才有）
 *
 * 直播两个来源（榜单 vs 弹幕）按「同一人同一天取较大值」合并 —— 与 build-fans.mjs
 * 的档案口径（按人取 max 防双算）同原则，只是粒度细到天。
 *
 * 产物 .cache/fans/tk/tk-<uid末两位>.json：
 *   { [uid]: { [YYYY-MM-DD]: [n, dk, ms] } }
 *   n  = 当天发言条数（TEXT，去重后）
 *   dk = 当天鸡腿（房间礼物 + 直播，四舍五入到 0.1）
 *   ms = [[时间戳, 正文(≤120字)], ...] 按时间升序
 *
 * 隐私红线（站长 2026-09-22 定）：粉丝名单与发言只存在于私有 KV/私有缓存；
 * 前端凭本人 uid 经 /api/mineDay 回取自己那一份，与 /api/mine 同口径。
 *
 * 用法：
 *   node scripts/build-ticket.mjs            # 只构建到 .cache/fans/tk/
 *   node scripts/build-ticket.mjs --push     # 构建完灌进 KV（经 worker /api/_fans_upsert kind:tk）
 *   node scripts/build-ticket.mjs --uid 104006629   # 只看某人校验口径
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNickUidIndex, resolveNick } from './lib/nick-uid.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache/fans');
const OUT_DIR = path.join(CACHE, 'tk');
const TZ = 8 * 3600 * 1000;

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ONLY_UID = arg('uid', '');
const PUSH = has('push');

const readLines = (p) => {
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* 半行，跳过 */ }
  }
  return out;
};
const dayOf = (t) => new Date(Number(t) + TZ).toISOString().slice(0, 10);
const round1 = (v) => Math.round(v * 10) / 10;

/* ---- 价目表：与 build-fans.mjs 同源同序（官方在售 → 人工补价 → 限定礼物倒推）---- */
function loadPrice() {
  const PRICE = new Map();
  let catalog = {};
  try { catalog = JSON.parse(fs.readFileSync(path.join(CACHE, 'gift-catalog.json'), 'utf8')); } catch {}
  // ⚠️ content 是「分类数组」[{typeName, giftList:[{giftName, money}]}]（build-fans 2026-09-23 踩过）
  const flat = Array.isArray(catalog) ? catalog.flatMap((t) => (t && t.giftList) || []) : ((catalog && catalog.list) || []);
  for (const g of flat) if (g.giftName && !PRICE.has(g.giftName)) PRICE.set(g.giftName, Number(g.money) || 0);
  try {
    const manual = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/gift-prices.json'), 'utf8'));
    for (const [nm, money] of Object.entries(manual.prices || {})) if (!PRICE.has(nm)) PRICE.set(nm, Number(money) || 0);
    for (const nm of manual._excludeNames || []) PRICE.set(nm, -1);
  } catch {}
  try {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/gift-dict.json'), 'utf8'));
    for (const [nm, e] of Object.entries(dict.resolved || {})) {
      if (!PRICE.has(nm) && e && Number(e.price) >= 0) PRICE.set(nm, Number(e.price) || 0);
    }
  } catch {}
  return PRICE;
}

/* ---- 2026 打分道具分值表：这类道具不算鸡腿 ---- */
const SCORE = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data/score-2026.json'), 'utf8')); } catch { return { byId: {}, byName: {} }; }
})();
const isScoringName = (nm) => SCORE.byName[nm] != null;

(async () => {
  const t0 = Date.now();
  const PRICE = loadPrice();
  console.log(`[价目] ${PRICE.size} 个礼物价目（其中 -1 排除 ${[...PRICE.values()].filter((v) => v === -1).length} 个）`);

  // ---- 1. 发言全文：fw-raw 按 id 去重 ----
  // ⚠️ fw-raw 是多次扫描的追加产物，不去重会把同一句话算三四遍（曾见 22659 vs 真实 3218）
  const raw = readLines(path.join(CACHE, 'fw-raw.jsonl'));
  const seen = new Set();
  const msgs = [];                       // { u, t, x }
  let dup = 0, bad = 0;
  for (const r of raw) {
    if (!r || !r.i || !r.u || r.u === '0') { bad++; continue; }
    if (seen.has(r.i)) { dup++; continue; }
    seen.add(r.i);
    if (!r.x) continue;                  // 无正文（理论上有，防御一下）
    msgs.push({ u: String(r.u), t: Number(r.t) || 0, x: String(r.x) });
  }
  console.log(`[发言] 原始 ${raw.length} 行 → 去重 ${dup} / 无 id ${bad} → 有效 ${msgs.length} 条`);

  // ---- 2. 昵称归户索引（直播弹幕源只有昵称）----
  const nickUid = buildNickUidIndex(CACHE, path.join(ROOT, 'data/nick-uid-pins.json'));

  // ---- 3. 按天聚合容器 ----
  // per: uid -> day -> { ms: [], dk: 0 }
  const per = new Map();
  const dayOfUid = (uid, d) => {
    let m = per.get(uid);
    if (!m) { m = new Map(); per.set(uid, m); }
    let row = m.get(d);
    if (!row) { row = { ms: [], dk: 0 }; m.set(d, row); }
    return row;
  };

  for (const m of msgs) {
    if (ONLY_UID && m.u !== ONLY_UID) continue;
    dayOfUid(m.u, dayOf(m.t)).ms.push([m.t, m.x.slice(0, 120)]);
  }

  // ---- 4. 房间礼物折鸡腿（GIFT_TEXT 自带 uid，不用归户）----
  let roomUsed = 0, roomSkip = 0, roomLegs = 0;
  for (const r of readLines(path.join(CACHE, 'room.jsonl'))) {
    if (!r || r.y !== 'GIFT_TEXT' || !r.g || !r.u || r.u === '0') continue;
    if (ONLY_UID && String(r.u) !== ONLY_UID) continue;
    if (/^888\d{0,3}$/.test(String(r.g.id || '')) || Number(r.g.s) === 1 || isScoringName(r.g.nm)) { roomSkip++; continue; }
    const p = PRICE.get(r.g.nm);
    if (p == null || p < 0) { roomSkip++; continue; }
    const c = Number(r.g.c) || 1;
    dayOfUid(String(r.u), dayOf(r.t)).dk += p * c;
    roomUsed++; roomLegs += p * c;
  }
  console.log(`[房间礼物] 采用 ${roomUsed} 条（剔除 ${roomSkip} 打分道具/无价目）→ ${round1(roomLegs).toLocaleString()} 鸡腿`);

  // ---- 5. 直播两源按「人×天」取较大值 ----
  // 5a. 官方 Top20 榜（自带 uid）
  const rankBy = new Map();              // uid|day -> legs
  let rankUsed = 0;
  for (const r of readLines(path.join(CACHE, 'live.jsonl'))) {
    if (!r || !r.u || r.u === '0' || !r.m) continue;
    if (ONLY_UID && String(r.u) !== ONLY_UID) continue;
    const k = String(r.u) + '|' + dayOf(r.ct);
    rankBy.set(k, (rankBy.get(k) || 0) + (Number(r.m) || 0));
    rankUsed++;
  }
  // 5b. 弹幕播报（昵称归户）
  const dmBy = new Map();
  let dmUsed = 0, dmNoUid = 0;
  for (const r of readLines(path.join(ROOT, '.cache/live-gifts.jsonl'))) {
    if (!r || !/王语晨/.test(r.target || '')) continue;
    if (isScoringName(r.gift)) continue;
    const p = PRICE.get(r.gift);
    if (p == null || p < 0) continue;
    const res = resolveNick(nickUid, r.nick);
    if (!res.uid) { dmNoUid++; continue; }
    if (ONLY_UID && res.uid !== ONLY_UID) continue;
    const k = res.uid + '|' + dayOf(r.ct);
    dmBy.set(k, (dmBy.get(k) || 0) + p * (Number(r.num) || 1));
    dmUsed++;
  }
  const keys = new Set([...rankBy.keys(), ...dmBy.keys()]);
  let liveLegs = 0, lifted = 0;
  for (const k of keys) {
    const [uid, d] = k.split('|');
    const a = rankBy.get(k) || 0, b = dmBy.get(k) || 0;
    const v = Math.max(a, b);            // 与档案口径同原则：取大防双算
    if (b > a) lifted++;
    dayOfUid(uid, d).dk += v;
    liveLegs += v;
  }
  console.log(`[直播] 榜 ${rankUsed} 条 / 弹幕 ${dmUsed} 条（无法归户 ${dmNoUid}）→ 按「人×天取大」并入 ${keys.size} 人日，弹幕补高 ${lifted} 人日，合计 ${round1(liveLegs).toLocaleString()} 鸡腿`);

  // ---- 6. 产出桶文件 ----
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const buckets = new Map();             // uu -> { uid: { day: [n, dk, ms] } }
  let daysTotal = 0, textTotal = 0;
  for (const [uid, m] of per) {
    for (const [d, row] of m) {
      row.ms.sort((a, b) => a[0] - b[0]);
      row.dk = round1(row.dk);
      if (!row.ms.length && !row.dk) continue;   // 只有发言或鸡腿至少一样才留
    }
    const days = {};
    for (const [d, row] of m) {
      if (!row.ms.length && !row.dk) continue;
      days[d] = [row.ms.length, row.dk, row.ms.length ? row.ms : []];
      daysTotal++; textTotal += row.ms.length;
    }
    if (!Object.keys(days).length) continue;
    const uu = String(uid).slice(-2);
    if (!buckets.has(uu)) buckets.set(uu, {});
    buckets.get(uu)[uid] = days;
  }
  for (const [uu, data] of buckets) {
    fs.writeFileSync(path.join(OUT_DIR, `tk-${uu}.json`), JSON.stringify(data));
  }
  console.log(`[产出] ${buckets.size} 个桶 / ${per.size} 人 / ${daysTotal} 人日 / ${textTotal} 条发言 → ${OUT_DIR}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  // ---- 7. 口径校验：与档案 n 对不上就大声说 ----
  const me = ONLY_UID || '104006629';
  const myDays = (buckets.get(me.slice(-2)) || {})[me];
  if (myDays) {
    const nSum = Object.values(myDays).reduce((a, r) => a + r[0], 0);
    const dkSum = round1(Object.values(myDays).reduce((a, r) => a + r[1], 0));
    console.log(`[校验] ${me} 发言合计 ${nSum} 条（档案口径 n 见 /api/mine）、鸡腿合计 ${dkSum.toLocaleString()}、活跃 ${Object.keys(myDays).length} 天`);
  } else {
    console.log(`[校验] ${me} 没有聚合到任何数据 —— 检查数据源是否完整`);
  }

  // ---- 8. --push：经 worker 写接口灌 KV（与 fans 桶同一鉴权通道）----
  if (PUSH) {
    const SITE = (process.env.SITE || 'https://idol.wyc0518.cc').replace(/\/$/, '');
    const sync = process.env.SYNC_TOKEN || '';
    const gh = process.env.GH_TOKEN || '';
    if (!sync && !gh) { console.error('[push] 缺 SYNC_TOKEN / GH_TOKEN，放弃'); process.exit(1); }
    // 两条授权通道：SYNC_TOKEN 走 x-sync-token；GH PAT 走 x-gh-token（worker 拿它去 GitHub 验 owner）
    const headers = { 'content-type': 'application/json' };
    if (sync) headers['x-sync-token'] = sync; else headers['x-gh-token'] = gh;
    let ok = 0, fail = 0;
    for (const [uu, data] of buckets) {
      const res = await fetch(SITE + '/api/_fans_upsert', {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'tk', bucket: uu, data }),
      });
      if (res.ok) { ok++; } else { fail++; console.error('[push] tk-' + uu, res.status, (await res.text()).slice(0, 120)); }
    }
    console.log(`[push] 完成：${ok} 个桶成功 / ${fail} 失败`);
  }
})();
