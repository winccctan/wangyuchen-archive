#!/usr/bin/env node
/**
 * 粉丝档案构建：把「口袋房间 + 直播间」两个来源聚合到每个 uid 身上，
 * 产出一行一行「只属于你自己」的档案，再（可选）灌进 Cloudflare D1。
 *
 * 为什么要这样：站长 2026-09-22 定下隐私红线 ——
 *   **粉丝名单不得以任何静态文件形式上公网**。于是：
 *   ① 名单只存在于 D1；② 前端凭本人 uid 经 /api/mine 回取自己那一份（见 worker/index.js）。
 *   本脚本不写任何会进入 git / dist / 静态资源的文件，中间产物一律落在 .cache/fans/。
 *
 * 数据源：
 *   1) POST /im/api/v1/team/message/list/all  —— 口袋房间全历史（留言数 / 活跃天 / 昵称 / 房间送礼）
 *   2) POST /live/api/v1/live/getLiveList     —— 她的全部历史直播
 *      POST /live/api/v2/live/getLiveRank     —— 每场贡献榜（官方直接给 money=鸡腿）
 *   3) POST /gift/api/v1/gift/list            —— 在售礼物价目 + data/gift-prices.json 人工补价
 *
 * 用法（务必直连，走代理慢 5 倍且易被限流：env -u HTTPS_PROXY ... SCRAPE_PROXY=）：
 *   node scripts/build-fans.mjs                 # 全量重建（房间 2022-11 起 + 全部直播）
 *   node scripts/build-fans.mjs --back 30       # 只补最近 30 天（日常增量）
 *   node scripts/build-fans.mjs --no-live       # 跳过直播榜（只想刷房间时）
 *   node scripts/build-fans.mjs --push          # 构建完顺手灌进 D1（需 SYNC_TOKEN / SITE）
 *   node scripts/build-fans.mjs --dry           # 只聚合、不抓取不灌库（改口径后本地校验用）
 *
 * 环境变量：
 *   POCKET48_TOKEN  抓取钥匙（CI 里由 secrets 注入）
 *   SYNC_TOKEN      Worker 写接口令牌（仅 --push 需要）
 *   SITE            站点地址，默认 https://idol.wyc0518.cc
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 昵称 → uid 归户索引：与 build-live-gift-rank.mjs 共用同一实现，
// 避免两处各写一套导致「同一昵称在档案库里算对、在导出表里为空」这类不一致。
import { buildNickUidIndex, resolveNick } from './lib/nick-uid.mjs';
// 榜单覆盖表的脱敏 key（"h:" + sha256(uid) 前 16 位）：CI 读不到明文表时靠它还原
import { hashUid, isHashed } from './lib/uid-hash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = await import(ROOT + '/scraper/lib/api.mjs');
const { POCKET48_TOKEN: TOKEN, MEMBER } = await import(ROOT + '/scraper/lib/config.mjs');

const CACHE = path.join(ROOT, '.cache/fans');
const ROOM_JSONL = path.join(CACHE, 'room.jsonl');
const ROOM_PROG = path.join(CACHE, 'room-progress.json');
const LIVE_JSONL = path.join(CACHE, 'live.jsonl');
const LIVE_PROG = path.join(CACHE, 'live-progress.json');
const CATALOG = path.join(CACHE, 'gift-catalog.json');
const OUT = path.join(CACHE, 'fans.json');
fs.mkdirSync(CACHE, { recursive: true });

/* ---- 年度活动「打分道具」分值表（目前只做 2026）----
 * 这类道具 giftId 888 开头、不是礼物、不产生鸡腿，只累计活动分数，
 * 所以算鸡腿时必须剔除（见下面 isScoring），但分数要单独累计给档案卡展示。
 * 分值来源：站长 2026-09-23 提供（午夜调频0.1 / 鎏光碟影1 / 迷迭音浪9 / 云境乐园99 / 告白讯号999）。
 */
const SCORE_FILE = path.join(ROOT, 'data/score-2026.json');
const SCORE = fs.existsSync(SCORE_FILE) ? JSON.parse(fs.readFileSync(SCORE_FILE, 'utf8')) : { byId: {}, byName: {} };
const SCORE_BY_ID = SCORE.byId || {};
const SCORE_BY_NAME = SCORE.byName || {};
// 房间记录有 giftId → 优先按 id 查；直播弹幕只有礼物名 → 按名字查
const scoreOfGift = (g) => {
  if (!g) return null;
  const byId = SCORE_BY_ID[String(g.id)];
  if (byId != null) return byId;
  const byName = SCORE_BY_NAME[g.nm];
  return byName != null ? byName : null;
};
// 弹幕只有名字
const scoreOfName = (nm) => (SCORE_BY_NAME[nm] != null ? SCORE_BY_NAME[nm] : null);
const round1 = (v) => Math.round(v * 10) / 10;

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);

const BACK_DAYS = Number(arg('back', 0));
const CHUNK_DAYS = Number(arg('chunk', 30));
const LANES = Math.max(1, Number(arg('lanes', 4)));
const PUSH = has('push');
const PUSH_ONLY = has('push-only');   // 跳过抓取，只把现有缓存聚合并灌库（不打断后台扫描）
const DRY = has('dry');               // 跳过抓取、只聚合、不灌库（本地校验口径用）
const DO_LIVE = !has('no-live');
const SITE = (process.env.SITE || 'https://idol.wyc0518.cc').replace(/\/$/, '');
const TZ_OFFSET_MS = 8 * 3600 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yearOf = (ms) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 4);
// 逐行容错：--push-only 时后台扫描进程可能正在 append，最后一行可能是半行
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

/* ============================ 1. 口袋房间 ============================ */
// 房间 IM 里 channelRole==='0' 是粉丝；GIFT_TEXT 的 bodys.giftInfo 带礼物名与件数。
async function scanRoom() {
  const FLOOR = Date.parse('2022-11-01T00:00:00+08:00');
  const START = Date.now();
  const end = BACK_DAYS ? START - BACK_DAYS * 86400e3 : FLOOR;
  const CH = CHUNK_DAYS * 86400e3;
  const queue = [];
  for (let s = START; s > end; s -= CH) queue.push([s, Math.max(end, s - CH)]);

  let prog = { chunks: {} };
  try { prog = JSON.parse(fs.readFileSync(ROOM_PROG, 'utf8')); if (!prog.chunks) prog.chunks = {}; } catch {}

  const seen = new Set(readLines(ROOM_JSONL).map((r) => r.i));
  const out = fs.createWriteStream(ROOM_JSONL, { flags: 'a' });
  const stat = { new: 0, pages: 0, gifts: 0, errors: 0 };
  let idx = 0;

  async function chunk(id, [from, to]) {
    const key = String(from);
    // ⚠️ 游标初值必须是本片上界 from：用 0 会「从最新一路翻到 to」，第 N 片要翻 N×30 天
    // → 总工作量 O(n²)，48 片慢 24 倍（越老的片越慢）。实测接口 nextTime=<时刻> 即从该时刻往前翻。
    let cursor = prog.chunks[key] === undefined ? from : prog.chunks[key];
    if (cursor === null) return;
    if (prog.chunks[key] === undefined) prog.chunks[key] = from;
    for (;;) {
      let r;
      try {
        r = await A.postJson('/im/api/v1/team/message/list/all',
          { channelId: MEMBER.channelId, serverId: MEMBER.serverId, nextTime: cursor, limit: 50 },
          { token: TOKEN, retries: 2 });
      } catch { stat.errors++; await sleep(2500); continue; }
      let list = (r.content && r.content.message) || [];
      stat.pages++;
      if (!list.length) {
        // 接口偶发返回空（限流/抖动）：重试一次再判定，避免把整片误标完成、永久漏抓这 30 天
        await sleep(1500);
        try {
          r = await A.postJson('/im/api/v1/team/message/list/all',
            { channelId: MEMBER.channelId, serverId: MEMBER.serverId, nextTime: cursor, limit: 50 },
            { token: TOKEN, retries: 2 });
        } catch { stat.errors++; break; }
        list = (r.content && r.content.message) || [];
        if (!list.length) break;
      }
      for (const m of list) {
        const t = Number(m.msgTime) || 0;
        if (!t || !m.msgIdClient || seen.has(m.msgIdClient)) continue;
        let ex = {}; try { ex = JSON.parse(m.extInfo || '{}'); } catch {}
        const u = ex.user || {};
        if (!u.userId) continue;
        seen.add(m.msgIdClient);
        const row = { i: m.msgIdClient, u: String(u.userId), t, y: String(m.msgType || ''), r: String(ex.channelRole ?? ''), n: u.nickName || '' };
        if (m.msgType === 'GIFT_TEXT') {
          try {
            const b = JSON.parse(m.bodys || '{}');
            const gi = b.giftInfo || {};
            if (gi.giftName) {
              row.g = { id: String(gi.giftId || ''), nm: String(gi.giftName), c: Number(gi.giftNum) || 1, s: Number(gi.isScore) || 0 };
              stat.gifts++;
            }
          } catch { /* bodys 非 JSON，跳过 */ }
        }
        out.write(JSON.stringify(row) + '\n');
        stat.new++;
      }
      const nt = Number(r.content.nextTime) || 0;
      if (!nt || (cursor !== 0 && nt >= cursor)) break;
      cursor = nt;
      prog.chunks[key] = cursor;
      if (cursor <= to) break;
      await sleep(120);
    }
    prog.chunks[key] = null;
    fs.writeFileSync(ROOM_PROG, JSON.stringify(prog));
    console.log(`  [room w${id}] ${new Date(from).toISOString().slice(0, 10)} → ${new Date(to).toISOString().slice(0, 10)} 完成 | 累计新增 ${stat.new}（礼物 ${stat.gifts}）`);
  }

  async function worker(id) {
    while (idx < queue.length) {
      const c = queue[idx++];
      try { await chunk(id, c); } catch (e) { console.warn(`  [room w${id}] 异常 ${String(e.message).slice(0, 80)}`); }
    }
  }
  console.log(`房间扫描：${queue.length} 片 × ${CHUNK_DAYS} 天，${LANES} 路并行（已有 ${seen.size} 条）`);
  await Promise.all(Array.from({ length: LANES }, (_, i) => worker(i + 1)));
  await new Promise((r) => out.end(r));
  console.log(`房间扫描完成：新增 ${stat.new} 条，翻 ${stat.pages} 页`);
}

/* ============================ 2. 直播间 ============================ */
async function scanLive() {
  let prog = { done: [], lives: null };
  try { prog = JSON.parse(fs.readFileSync(LIVE_PROG, 'utf8')); } catch {}
  const doneSet = new Set(prog.done || []);

  let lives = prog.lives;
  if (!lives || !lives.length || has('renew-lives')) {
    lives = [];
    let next = '0';
    for (let page = 0; page < 200; page++) {
      const r = await A.postJson('/live/api/v1/live/getLiveList',
        { userId: Number(MEMBER.starId), limit: 20, nextTime: 0, next },
        { token: TOKEN, retries: 2 });
      const list = (r.content && r.content.liveList) || [];
      if (!list.length) break;
      for (const l of list) lives.push({ liveId: String(l.liveId), ct: Number(l.ctime) || 0 });
      next = r.content.next || '';
      if (!next) break;
      await sleep(300);
    }
    prog.lives = lives;
    fs.writeFileSync(LIVE_PROG, JSON.stringify(prog));
  }
  const targets = lives.filter((l) => !doneSet.has(l.liveId));
  console.log(`直播榜：共 ${lives.length} 场，待抓 ${targets.length} 场`);

  const out = fs.createWriteStream(LIVE_JSONL, { flags: 'a' });
  let cur = 0, rows = 0, money = 0, done = 0;
  async function worker() {
    for (;;) {
      const lv = targets[cur++];
      if (!lv) return;
      let got = [];
      for (let att = 0; att < 3 && !got.length; att++) {
        try {
          const r = await A.postJson('/live/api/v2/live/getLiveRank',
            { type: 1, liveId: lv.liveId }, { token: TOKEN, retries: 1, timeout: 15000 });
          for (const it of (r.content && r.content.data) || []) {
            const uid = String((it.user || {}).userId || '');
            const mo = Number(it.money) || 0;
            if (uid && mo > 0) got.push({ liveId: lv.liveId, ct: lv.ct, u: uid, nick: String((it.user || {}).userName || ''), m: mo });
          }
        } catch { await sleep(1200 * (att + 1)); }
      }
      if (got.length) {
        out.write(got.map((x) => JSON.stringify(x)).join('\n') + '\n');
        rows += got.length; money += got.reduce((s, x) => s + x.m, 0);
      }
      doneSet.add(lv.liveId);
      if (++done % 50 === 0) {
        prog.done = [...doneSet];
        fs.writeFileSync(LIVE_PROG, JSON.stringify(prog));
        console.log(`  [live] ${done}/${targets.length} | ${rows} 条 | ${money.toLocaleString()} 鸡腿`);
      }
      await sleep(200);
    }
  }
  await Promise.all(Array.from({ length: Math.min(LANES, Math.max(1, targets.length)) }, worker));
  await new Promise((r) => out.end(r));
  prog.done = [...doneSet];
  fs.writeFileSync(LIVE_PROG, JSON.stringify(prog));
  console.log(`直播榜完成：新增 ${rows} 条 / ${money.toLocaleString()} 鸡腿`);
}

/* ============================ 3. 礼物价目 ============================ */
async function priceMap() {
  const PRICE = new Map();
  let catalog = null;
  if (!BACK_DAYS) {
    try {
      const r = await A.postJson('/gift/api/v1/gift/list', {}, { token: TOKEN, retries: 2 });
      catalog = r.content;
      fs.writeFileSync(CATALOG, JSON.stringify(catalog));
    } catch { /* 失败就退回缓存 */ }
  }
  if (!catalog) { try { catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8')); } catch { catalog = {}; } }
  // ⚠️ 形态坑（2026-09-23 修）：/gift/list 的 content 是「分类数组」
  //   [{typeName, giftList:[{giftName, money}]}]，不是 {list:[...]}。
  //   早期按 catalog.list 取 → 官方在售价目一个都没进表，只剩人工补价的 35 个礼物，
  //   房间鸡腿被严重低估（2026 年只算出 12.5 万，实际 48.6 万）。
  const flat = Array.isArray(catalog)
    ? catalog.flatMap((t) => (t && t.giftList) || [])
    : ((catalog && catalog.list) || []);
  for (const g of flat) if (g.giftName && !PRICE.has(g.giftName)) PRICE.set(g.giftName, Number(g.money) || 0);
  try {
    const manual = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/gift-prices.json'), 'utf8'));
    for (const [nm, money] of Object.entries(manual.prices || {})) if (!PRICE.has(nm)) PRICE.set(nm, Number(money) || 0);
    for (const nm of manual._excludeNames || []) PRICE.set(nm, -1);       // -1 = 明确不是礼物
  } catch { /* 价目文件缺失也能跑，只是缺价更多 */ }
  // 最后兜底：build-gift-dict.mjs 的产物（含「由官方 Top20 总额倒推」出来的限定礼物价）。
  // 没有这层的话，遇到下架限定礼物会 p==null → 该条礼物被静默丢弃，人就被算小了。
  try {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/gift-dict.json'), 'utf8'));
    for (const [nm, e] of Object.entries(dict.resolved || {})) {
      if (!PRICE.has(nm) && e && Number(e.price) >= 0) PRICE.set(nm, Number(e.price) || 0);
    }
  } catch { /* 字典产物还没生成过也能跑 */ }
  return PRICE;
}

/* ============================ 4. 聚合 ============================ */
/* 第三方礼物榜覆盖表（2026 年度 / 2024 年起累计）。
 *
 * ⚠️ 隐私红线（站长 2026-09-23 定）：榜单带 uid，只能留在 D1，绝不进 GitHub 仓库。
 *    读取顺序：D1（权威；本机与 CI 都走它）→ 本机明文文件（data/ 下、已 gitignore）→ 都没有就大声告警。
 *    历史做法：把 sha256 脱敏表 commit 进仓库供 CI 读取 —— 已废弃，仓库里现在一份榜单数据都没有。
 */
const PERIODS = ['2026', '2024plus'];
const OVR_FILE = { '2026': 'data/fans-2026-gift.json', '2024plus': 'data/fans-2024plus-gift.json' };
const OVR = { '2026': { map: {}, src: '无' }, '2024plus': { map: {}, src: '无' } };

function loadOverrideLocal() {
  for (const p of PERIODS) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, OVR_FILE[p]), 'utf8'));
      if (j && j.map && Object.keys(j.map).length) OVR[p] = { map: j.map, src: '本机文件' };
    } catch { /* 本机没有就算了 */ }
  }
}

/** 从 D1 读覆盖表（需 SYNC_TOKEN / GH_TOKEN）。这是 CI 的唯一来源。 */
async function loadOverrideD1() {
  const tok = process.env.SYNC_TOKEN || '';
  const gh = process.env.GH_TOKEN || '';
  if (!tok && !gh) return;
  const H = tok ? { 'x-sync-token': tok } : { 'x-gh-token': gh };
  for (const p of PERIODS) {
    try {
      const res = await fetch(`${SITE}/api/_gift_override?period=${p}`, { headers: H });
      if (!res.ok) { console.warn(`  · D1 覆盖表 ${p}：HTTP ${res.status}`); continue; }
      const j = await res.json();
      const rows = Array.isArray(j.rows) ? j.rows : [];
      const map = {};
      for (const r of rows) if (r && r.uid && Number(r.v) > 0) map[String(r.uid)] = { v: Number(r.v), rank: Number(r.rank) || 0, nick: r.nick || '' };
      if (Object.keys(map).length) OVR[p] = { map, src: 'D1' };
    } catch (e) {
      console.warn(`  · 从 D1 读「${p}」覆盖表失败：${String((e && e.message) || e).slice(0, 90)}`);
    }
  }
}

function reportOverride() {
  for (const p of PERIODS) {
    const o = OVR[p];
    if (Object.keys(o.map).length) console.log(`[${p} 榜单覆盖] ${Object.keys(o.map).length} 人，来源：${o.src}`);
    else console.warn(`⚠️ 拿不到「${p}」榜单覆盖表（D1 和本机都没有）→ 上榜的人会退回自算值，数值会变小`);
  }
}

/* ---- 「我在房间里说的第一句话」 ----
 * 由 scripts/build-first-words.mjs 单独扫一遍房间 IM 得到（本脚本扫房间时只留元数据、
 * 没存正文，所以第一句话要另抓一次）。产物落在 .cache/fans/first-words.json，
 * key 是 uid —— 和档案库一样只在服务端，只有本人经 /api/mine 能看到自己那句。
 * 文件不存在就静默跳过（档案卡那一块不显示），不影响鸡腿/活跃度统计。
 */
const FW_FILE = path.join(CACHE, 'first-words.json');
let FW = {};
if (fs.existsSync(FW_FILE)) {
  try { FW = JSON.parse(fs.readFileSync(FW_FILE, 'utf8')).map || {}; } catch { FW = {}; }
  if (Object.keys(FW).length) console.log(`[第一句话] 读到 ${Object.keys(FW).length} 人的首条留言`);
}

function build(PRICE) {
  const isScoring = (g) => /^888\d{0,3}$/.test(String(g.id || '')) || Number(g.s) === 1 || PRICE.get(g.nm) === -1;
  const fans = new Map();      // uid -> row
  // 昵称 → uid 归户索引（scripts/lib/nick-uid.mjs：房间发言+礼物 / 官方直播榜 / 口袋动态 @提及 三源合并）
  const nickUid = buildNickUidIndex(CACHE, path.join(ROOT, 'data/nick-uid-pins.json'));
  const touch = (uid, nick) => {
    uid = String(uid);
    if (!uid || uid === '0') return null;
    let f = fans.get(uid);
    if (!f) {
      f = { uid, nick: '', live: 0, live26: 0, live24: 0, lives: 0, lives26: 0, lives24: 0,
            room: 0, room26: 0, room24: 0, gifts: 0, gifts26: 0, gifts24: 0,
            score26: 0,                                   // 2026 活动打分（房间侧，含小数）
            msgs: 0, first: 0, last: 0, days: {}, hs: new Array(24).fill(0) };
      fans.set(uid, f);
    }
    if (nick) f.nick = nick;
    return f;
  };

  for (const r of readLines(LIVE_JSONL)) {
    if (String(r.u) === '0') continue;                       // 神秘守护者：不并入个人
    const f = touch(r.u, r.nick);
    if (!f) continue;
    f.live += r.m; f.lives += 1;
    const y = yearOf(r.ct);
    if (y === '2026') { f.live26 += r.m; f.lives26 += 1; }
    if (y >= '2024') { f.live24 += r.m; f.lives24 += 1; }        // 「2024 年至今」档
  }

  for (const r of readLines(ROOM_JSONL)) {
    const f = touch(r.u, r.n);
    if (!f) continue;
    if (r.r === '0') {                                        // 粉丝自己的发言
      f.msgs += 1;
      if (!f.first || r.t < f.first) f.first = r.t;
      if (!f.last || r.t > f.last) f.last = r.t;
      f.days[new Date(r.t + TZ_OFFSET_MS).toISOString().slice(0, 10)] = 1;
      f.hs[Number(new Date(r.t + TZ_OFFSET_MS).toISOString().slice(11, 13))] += 1;
    }
    if (!r.g) continue;
    if (isScoring(r.g)) {
      // 打分道具：不算鸡腿，但要单独累计 2026 活动分数
      const sv = scoreOfGift(r.g);
      if (sv != null && yearOf(r.t) === '2026') f.score26 += sv * (Number(r.g.c) || 1);
      continue;
    }
    const p = PRICE.get(r.g.nm);
    if (!p || p < 0) continue;
    const c = Number(r.g.c) || 1;
    f.room += p * c; f.gifts += c;
    const y = yearOf(r.t);
    if (y === '2026') { f.room26 += p * c; f.gifts26 += c; }
    if (y >= '2024') { f.room24 += p * c; f.gifts24 += c; }
  }

  // ---- 活跃日历：按「天序号」编成位图再 base64（前端 decodeDayBitmap 直接可用）----
  const START_MS = Date.parse('2022-11-01T00:00:00Z');       // 与前端 start 字段严格一致
  const dayIdxOf = (key) => Math.floor((Date.parse(key + 'T00:00:00Z') - START_MS) / 86400e3);
  const encodeBitmap = (idxs) => {
    const max = idxs.length ? Math.max(...idxs) : -1;
    if (max < 0) return '';
    const bytes = new Uint8Array((max >> 3) + 1);
    for (const i of idxs) bytes[i >> 3] |= 1 << (i & 7);
    return Buffer.from(bytes).toString('base64');
  };
  const bestStreak = (dayMap) => {
    const idxs = Object.keys(dayMap).map(dayIdxOf).filter((i) => i >= 0).sort((a, b) => a - b);
    let best = 0, run = 0, prev = null;
    for (const i of idxs) { run = prev !== null && i === prev + 1 ? run + 1 : 1; prev = i; if (run > best) best = run; }
    return best;
  };

  /* ---- 直播礼物第二个数据源：弹幕 LRC 里的系统送礼播报 ----
   * 官方自 2026-04 末起，把「昵称\t送给GNZ48-王语晨 N个礼物」写进每场直播的弹幕文件
   * （getLiveOne → msgFilePath → source.48.cn 的 .lrc，免签名直取）。
   * 相比 getLiveRank 的 Top20 榜，它**不受每场前 20 名限制**，能捞到 21 名以后的送礼人。
   * 交叉验证见 scripts/cmp-live-gift-sources.mjs：同场同人金额对得上 ~88%，
   * 因此这里按「同一人取两个来源的较大值」合并，不会把谁算小。
   * 数据由 scripts/diag-live-gifts.mjs 按月分批扫出。
   */
  const DM_FILE = path.join(ROOT, '.cache/live-gifts.jsonl');
  const dmByName = new Map();        // 昵称 -> 2026 鸡腿
  const dmScoreByName = new Map();   // 昵称 -> 2026 活动打分
  let dmRows = 0, dmUsed = 0, dmPriceMiss = 0, dmWrongTarget = 0, dmScoreUsed = 0;
  if (fs.existsSync(DM_FILE)) {
    for (const line of fs.readFileSync(DM_FILE, 'utf8').trim().split('\n')) {
      if (!line) continue;
      let g; try { g = JSON.parse(line); } catch { continue; }
      dmRows++;
      if (!/王语晨/.test(g.target || '')) { dmWrongTarget++; continue; }   // 别的成员那场不算
      // 打分道具：不算鸡腿，单独累计 2026 活动分数（弹幕源补齐历史后也要限定 2026）
      const sv = scoreOfName(g.gift);
      if (sv != null) {
        if (yearOf(Number(g.ct) || 0) === '2026') {
          dmScoreByName.set(g.nick, (dmScoreByName.get(g.nick) || 0) + sv * (Number(g.num) || 1));
          dmScoreUsed++;
        }
        dmPriceMiss++;
        continue;
      }
      const p = PRICE.get(g.gift);
      if (p == null || p < 0) { dmPriceMiss++; continue; }                 // 无价目
      dmByName.set(g.nick, (dmByName.get(g.nick) || 0) + p * (Number(g.num) || 1));
      dmUsed++;
    }
  }
  const dmByUid = new Map();         // uid -> 2026 鸡腿（只收能归户的）
  let dmNoUid = 0, dmNoUidLegs = 0, dmAmbiguous = 0;
  for (const [nick, v] of dmByName) {
    const res = resolveNick(nickUid, nick);
    if (!res.uid) { dmNoUid++; dmNoUidLegs += v; continue; }
    if (res.how !== '唯一') dmAmbiguous++;                  // 昵称被多个 uid 用过，取出现最多的
    dmByUid.set(res.uid, (dmByUid.get(res.uid) || 0) + v);
  }
  const dmScoreByUid = new Map();    // uid -> 2026 活动打分（只收能归户的）
  let dmScoreNoUid = 0;
  for (const [nick, v] of dmScoreByName) {
    const res = resolveNick(nickUid, nick);
    if (!res.uid) { dmScoreNoUid++; continue; }
    dmScoreByUid.set(res.uid, (dmScoreByUid.get(res.uid) || 0) + v);
  }
  if (dmRows) {
    console.log(`[弹幕礼物] ${dmRows} 条播报 → 采用 ${dmUsed} 条（剔除 ${dmPriceMiss} 打分道具/无价目、${dmWrongTarget} 非本人场次）`);
    console.log(`[弹幕礼物] 归户 ${dmByUid.size} 人；无法归户 ${dmNoUid} 人（${dmNoUidLegs.toLocaleString()} 鸡腿，未并入）${dmAmbiguous ? `，其中 ${dmAmbiguous} 人昵称重名已按最常出现取` : ''}`);
    if (dmScoreUsed) console.log(`[弹幕打分] ${dmScoreUsed} 条道具播报 → 归户 ${dmScoreByUid.size} 人，合计 ${round1([...dmScoreByUid.values()].reduce((a, b) => a + b, 0)).toLocaleString()} 分；无法归户 ${dmScoreNoUid} 人（未并入）`);
  }

  // ---- 2026 年第三方礼物榜（站长提供，前 201 名，含直播间 + 口袋房间）----
  // 这部分人 2026 年以榜单为准：官方榜接口的鸡腿会混进「神秘守护者」匿名池，
  // 自算值经常显著偏低。其余所有人仍用自算的 直播+房间。
  // 两边取较大值，避免把谁的 2026 反而算小。
  const list = [...fans.values()]
    .map((f) => {
      const dm = dmByUid.get(f.uid) || 0;                 // 弹幕播报出来的直播鸡腿
      const live = Math.max(f.live, dm);                  // 与 Top20 榜取较大值
      const live26 = Math.max(f.live26, dm);              // 弹幕数据目前只落在 2026 年
      const live24 = Math.max(f.live24, dm);              // 2026 ⊂ 「2024 年起」，同样并入
      if (dm > f.live26) f._dmLifted = true;
      // 2026 活动打分：口袋房间 + 直播弹幕（两侧都只统计 2026）
      const score26 = round1(f.score26 + (dmScoreByUid.get(f.uid) || 0));
      return ({
      uid: f.uid,
      nick: f.nick,
      live, live2026: live26, lives: f.lives, lives2026: f.lives26,
      room: f.room, room2026: f.room26, gifts: f.gifts, gifts2026: f.gifts26,
      score2026: score26,
      total: live + f.room, total2026: live26 + f.room26,
      liveSince2024: live24, roomSince2024: f.room24, totalSince2024: live24 + f.room24,
      // 以下字段名沿用旧 room-stats 口径（n/f/l/d/b/h/m），前端渲染逻辑不用改
      n: f.msgs, f: f.first, l: f.last, d: Object.keys(f.days).length,
      b: bestStreak(f.days), h: f.hs.join(','), m: encodeBitmap(Object.keys(f.days).map(dayIdxOf)),
      start: '2022-11-01',
      // 第一句话：只有真的抓到正文才带上（没有就整块不显示，不写空串占位）
      ...(FW[f.uid] ? { fw: String(FW[f.uid].x || '').slice(0, 120), fwt: Number(FW[f.uid].t) || 0 } : {}),
      });
    })
    // 注：只送过打分道具、没送过礼物也没发言的人也要留档（否则档案里查不到他的分）
    .filter((x) => x.total > 0 || x.n > 0 || (x.score2026 || 0) > 0);

  /* ---- 第三方榜单覆盖：2026 档 与 2024 年起档，规则完全一致 ----
   * 两边取较大值（自算 vs 榜单），保证不会把谁算小；
   * 并打上 src*='list' —— 前端据此显示「榜单口径」而不是拆开直播/房间。
   * 覆盖表来自 D1（权威）或本机明文文件，绝不在 GitHub 仓库里。
   */
  const uidIdx = new Map(list.map((x) => [x.uid, x]));
  const applyOvr = (period, valKey, srcKey, rankKey) => {
    const map = OVR[period].map;
    if (!Object.keys(map).length) return { applied: 0, lifted: 0 };
    let applied = 0, lifted = 0;
    for (const [uid, o] of Object.entries(map)) {
      let x = uidIdx.get(uid);
      if (!x) {                                   // 榜单上有、但我们一条记录都没抓到的人
        x = { uid, nick: o.nick, live: 0, live2026: 0, lives: 0, lives2026: 0, room: 0, room2026: 0,
              gifts: 0, gifts2026: 0, total: 0, total2026: 0,
              liveSince2024: 0, roomSince2024: 0, totalSince2024: 0,
              n: 0, f: 0, l: 0, d: 0, b: 0, h: '', m: '', start: '2022-11-01' };
        list.push(x); uidIdx.set(uid, x);
      }
      if (!x.nick) x.nick = o.nick;
      if (o.v > (Number(x[valKey]) || 0)) { lifted++; x[valKey] = o.v; }
      x[srcKey] = 'list';
      x[rankKey] = o.rank;
      applied++;
    }
    return { applied, lifted };
  };
  const r26 = applyOvr('2026', 'total2026', 'src26', 'rank26');
  const r24 = applyOvr('2024plus', 'totalSince2024', 'srcSince2024', 'rankSince2024');
  if (r26.applied) console.log(`[2026 榜单口径] 采用 ${r26.applied} 人，其中 ${r26.lifted} 人以榜单为准上调`);
  if (r24.applied) console.log(`[2024 起榜单口径] 采用 ${r24.applied} 人，其中 ${r24.lifted} 人以榜单为准上调`);

  const ranked = list.sort((a, b) => b.total - a.total);
  ranked.forEach((x, i) => { x.rank = i + 1; });
  return ranked;
}

/* ============================ 5. 灌库 ============================ */
async function push(list, coverage) {
  const tok = process.env.SYNC_TOKEN || '';
  const gh = process.env.GH_TOKEN || '';
  if (!tok && !gh) { console.log('未设置 SYNC_TOKEN（或 GH_TOKEN），跳过灌库（产物在 ' + OUT + '）'); return; }
  const authHeader = tok ? { 'x-sync-token': tok } : { 'x-gh-token': gh };
  // 网络不稳（尤其走代理出口时 ECONNRESET 常见）：单次 20s 超时 + 最多 4 次重试。
  // 2026-09-23 加：之前推送常在 30 桶前后崩掉，全靠 .cache/fans/kv 断点续传才收得完。
  const post = async (p, body, tries = 4) => {
    let last;
    for (let i = 1; i <= tries; i++) {
      try {
        const res = await fetch(SITE + p, {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, authHeader),
          body: JSON.stringify(body || {}),
          signal: AbortSignal.timeout(20000),
        });
        const t = await res.text();
        let j = {}; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 120) }; }
        return { status: res.status, j };
      } catch (e) {
        last = e;
        if (i < tries) { process.stdout.write(`  [重试 ${i}/${tries}] ${String(e.code || e.message).slice(0, 30)}…\r`); await sleep(1500); }
      }
    }
    return { status: 0, j: { error: String(last && (last.code || last.message)) } };
  };
  // ⚠️ 人数骤降保护（2026-09-23 加）
  // 为什么需要：整桶覆盖写没有「部分更新」的余地 —— 一旦拿一份不完整的名单去灌
  // （典型案例：GitHub Actions 的 .cache/fans 只积累到 2025-02，房间 21.6 万鸡腿，
  //   而线上是全历史 253 万），桶里的人会直接少一大截，别人的档案就此消失。
  // 所以推送前先和线上人数比一比，骤降就停手。确认真要覆盖时加 --force-push。
  const FLOOR = 0.85;
  if (!has('force-push')) {
    const rd = await post('/api/_fans_ready');
    const online = (rd.status === 200 && rd.j) ? Number(rd.j.people) || 0 : 0;
    if (online > 0 && list.length < online * FLOOR) {
      const low = (100 - (list.length / online) * 100).toFixed(0);
      console.log(`\n⛔ 拒绝推送：本轮只有 ${list.length} 人，线上已是 ${online} 人（少 ${low}%）。`);
      console.log('   整桶覆盖会把线上多出来的人抹掉。多半是抓取缓存不完整 ——');
      console.log('   先补 `--back 0`（全量）或从有全历史的那台机器推；确实要覆盖请加 --force-push。');
      return;
    }
    if (online > 0) console.log(`人数校验：线上 ${online} 人 → 本轮 ${list.length} 人，通过`);
    else console.log('人数校验：读不到线上就绪标记，跳过（首次灌库属正常）');
  }

  // D1 只是尽力同步（免费版读配额常打满）；查询主路径是 KV，失败就当没这层。
  const init = await post('/api/_fans_init');
  console.log('D1 建表：', init.status, JSON.stringify(init.j).slice(0, 80));
  // 按 uid 末两位分桶整桶覆盖写 KV：≤100 次写/轮（KV 写上限 1000/天），查询时只读 1 个桶。
  const buckets = new Map();
  for (const x of list) {
    const b = String(x.uid).slice(-2);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(x);
  }
  // 只推内容变了的桶：KV 免费版只有 1000 写/天，全量 100 桶刷几次就见底了。
  const KVDIR = path.join(CACHE, 'kv');
  fs.mkdirSync(KVDIR, { recursive: true });
  let sent = 0, bNo = 0, skipped = 0;
  for (const [b, rows] of buckets) {
    const json = JSON.stringify(rows);
    const fp = path.join(KVDIR, b + '.json');
    if (fs.existsSync(fp) && fs.readFileSync(fp, 'utf8') === json) { skipped++; continue; }
    const r = await post('/api/_fans_upsert', { bucket: b, rows });
    if (r.status !== 200) { console.log('灌库失败', b, r.status, JSON.stringify(r.j).slice(0, 160)); return; }
    fs.writeFileSync(fp, json);
    sent += rows.length; bNo++;
    process.stdout.write(`  已灌 ${sent}/${list.length}（${bNo}/${buckets.size} 桶）\r`);
    await sleep(60);
  }
  if (skipped) console.log(`  ${skipped} 个桶内容未变，跳过`);
  // 收尾打就绪标记：在此之前 /api/mine 会明确回「档案正在生成」，
  // 而不是让所有人看到「你没在房间里留过记录」。
  const fin = await post('/api/_fans_upsert', { ready: true, coverage: coverage || {} });
  console.log(`\n灌库完成：${sent} 条 → ${SITE}（就绪标记 ${fin.status === 200 ? '已打上' : '失败 ' + fin.status}）`);
}

/* 把本机的榜单覆盖表灌进 D1（--push-override）。
 * 榜单带 uid，只能留在 D1；这份数据从此不再以任何形式进 GitHub 仓库。 */
async function pushOverride() {
  const tok = process.env.SYNC_TOKEN || '';
  const gh = process.env.GH_TOKEN || '';
  if (!tok && !gh) { console.log('未设置 SYNC_TOKEN / GH_TOKEN，无法写 D1'); return; }
  const H = Object.assign({ 'content-type': 'application/json' },
    tok ? { 'x-sync-token': tok } : { 'x-gh-token': gh });
  for (const p of PERIODS) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(ROOT, OVR_FILE[p]), 'utf8')); }
    catch { console.log(`跳过「${p}」：本机没有 ${OVR_FILE[p]}`); continue; }
    const rows = Object.entries(j.map || {})
      .map(([uid, o]) => ({ uid: String(uid), nick: o.nick || '', v: Number(o.v) || 0, rank: Number(o.rank) || 0 }))
      .filter((r) => r.v > 0);
    if (!rows.length) { console.log(`跳过「${p}」：表是空的`); continue; }
    const res = await fetch(SITE + '/api/_gift_override', {
      method: 'POST', headers: H,
      body: JSON.stringify({ period: p, replace: true, rows }),
      signal: AbortSignal.timeout(30000),
    });
    const t = await res.text();
    console.log(`「${p}」→ D1：HTTP ${res.status} ${t.slice(0, 120)}`);
  }
}

/* ============================ main ============================ */
const t0 = Date.now();

// 榜单覆盖表：本机明文文件兜底，D1 为准（CI 只有 D1 这一条路）
loadOverrideLocal();
await loadOverrideD1();
reportOverride();

// --push-override：只把榜单表灌进 D1，不抓取、不重建档案
if (has('push-override')) { await pushOverride(); process.exit(0); }

// --push-only：跳过抓取，直接用现有 .cache/fans 聚合并灌库。
// 用于「后台还在补历史，但想先拿已有的那部分开放测试」——不打断正在跑的扫描进程。
if (!PUSH_ONLY && !DRY) {
  await scanRoom();
  if (DO_LIVE) await scanLive();
}
const PRICE = await priceMap();
const list = build(PRICE);
fs.writeFileSync(OUT, JSON.stringify({ builtAt: Date.now(), people: list.length, list }, null, 0));
const sum = (k) => list.reduce((s, x) => s + x[k], 0);
// 覆盖区间：房间发言最早到哪一天。用它告诉用户「档案还没补完，查不到不代表没记录」。
let since = 0;
for (const r of readLines(ROOM_JSONL)) if (r.t && (!since || r.t < since)) since = r.t;
const coverage = { since, liveDone: readLines(LIVE_JSONL).length > 0, people: list.length };
console.log(`\n===== 粉丝档案：${list.length} 人 =====（本地产物 ${OUT} 不进 git）`);
console.log(`直播 ${sum('live').toLocaleString()} / 房间 ${sum('room').toLocaleString()} / 合计 ${sum('total').toLocaleString()} 鸡腿`);
console.log(`发言 ${sum('n').toLocaleString()} 条，2026 年合计 ${sum('total2026').toLocaleString()} 鸡腿`);
console.log(`2024 年起合计 ${sum('totalSince2024').toLocaleString()} 鸡腿（${list.filter((x) => (x.totalSince2024 || 0) > 0).length} 人）`);
if (since) console.log(`覆盖区间：${new Date(since + TZ_OFFSET_MS).toISOString().slice(0, 10)} 起${coverage.liveDone ? '（含直播榜）' : '（直播榜尚未开跑）'}`);
if ((PUSH || PUSH_ONLY) && !DRY) await push(list, coverage);
console.log(`耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
