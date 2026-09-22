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
 *
 * 环境变量：
 *   POCKET48_TOKEN  抓取钥匙（CI 里由 secrets 注入）
 *   SYNC_TOKEN      Worker 写接口令牌（仅 --push 需要）
 *   SITE            站点地址，默认 https://idol.wyc0518.cc
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);

const BACK_DAYS = Number(arg('back', 0));
const CHUNK_DAYS = Number(arg('chunk', 30));
const LANES = Math.max(1, Number(arg('lanes', 4)));
const PUSH = has('push');
const DO_LIVE = !has('no-live');
const SITE = (process.env.SITE || 'https://idol.wyc0518.cc').replace(/\/$/, '');
const TZ_OFFSET_MS = 8 * 3600 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yearOf = (ms) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 4);
const readLines = (p) => {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
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
    let cursor = prog.chunks[key] === undefined ? 0 : prog.chunks[key];
    if (cursor === null) return;
    if (prog.chunks[key] === undefined) prog.chunks[key] = 0;
    for (;;) {
      let r;
      try {
        r = await A.postJson('/im/api/v1/team/message/list/all',
          { channelId: MEMBER.channelId, serverId: MEMBER.serverId, nextTime: cursor, limit: 50 },
          { token: TOKEN, retries: 2 });
      } catch { stat.errors++; await sleep(2500); continue; }
      const list = (r.content && r.content.message) || [];
      stat.pages++;
      if (!list.length) break;
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
  for (const g of (catalog && catalog.list) || []) if (g.giftName && !PRICE.has(g.giftName)) PRICE.set(g.giftName, Number(g.money) || 0);
  try {
    const manual = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/gift-prices.json'), 'utf8'));
    for (const [nm, money] of Object.entries(manual.prices || {})) if (!PRICE.has(nm)) PRICE.set(nm, Number(money) || 0);
    for (const nm of manual._excludeNames || []) PRICE.set(nm, -1);       // -1 = 明确不是礼物
  } catch { /* 价目文件缺失也能跑，只是缺价更多 */ }
  return PRICE;
}

/* ============================ 4. 聚合 ============================ */
function build(PRICE) {
  const isScoring = (g) => /^888\d{0,3}$/.test(String(g.id || '')) || Number(g.s) === 1 || PRICE.get(g.nm) === -1;
  const fans = new Map();      // uid -> row
  const touch = (uid, nick) => {
    uid = String(uid);
    if (!uid || uid === '0') return null;
    let f = fans.get(uid);
    if (!f) {
      f = { uid, nick: '', live: 0, live26: 0, lives: 0, lives26: 0, room: 0, room26: 0, gifts: 0, gifts26: 0, msgs: 0, first: 0, last: 0, days: {} };
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
    if (yearOf(r.ct) === '2026') { f.live26 += r.m; f.lives26 += 1; }
  }

  for (const r of readLines(ROOM_JSONL)) {
    const f = touch(r.u, r.n);
    if (!f) continue;
    if (r.r === '0') {                                        // 粉丝自己的发言
      f.msgs += 1;
      if (!f.first || r.t < f.first) f.first = r.t;
      if (!f.last || r.t > f.last) f.last = r.t;
      f.days[new Date(r.t + TZ_OFFSET_MS).toISOString().slice(0, 10)] = 1;
    }
    if (!r.g) continue;
    if (isScoring(r.g)) continue;                             // 打分道具：非礼物
    const p = PRICE.get(r.g.nm);
    if (!p || p < 0) continue;
    const c = Number(r.g.c) || 1;
    f.room += p * c; f.gifts += c;
    if (yearOf(r.t) === '2026') { f.room26 += p * c; f.gifts26 += c; }
  }

  const list = [...fans.values()]
    .map((f) => ({
      uid: f.uid,
      nick: f.nick,
      live: f.live, live2026: f.live26, lives: f.lives, lives2026: f.lives26,
      room: f.room, room2026: f.room26, gifts: f.gifts, gifts2026: f.gifts26,
      total: f.live + f.room, total2026: f.live26 + f.room26,
      msgs: f.msgs, first: f.first, last: f.last, days: Object.keys(f.days).length,
    }))
    .filter((x) => x.total > 0 || x.msgs > 0)
    .sort((a, b) => b.total - a.total);
  list.forEach((x, i) => { x.rank = i + 1; });
  return list;
}

/* ============================ 5. 灌库 ============================ */
async function push(list) {
  const tok = process.env.SYNC_TOKEN || '';
  if (!tok) { console.log('未设置 SYNC_TOKEN，跳过灌库（产物在 ' + OUT + '）'); return; }
  const post = async (p, body) => {
    const res = await fetch(SITE + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-token': tok },
      body: JSON.stringify(body || {}),
    });
    const t = await res.text();
    let j = {}; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 120) }; }
    return { status: res.status, j };
  };
  const init = await post('/api/_fans_init');
  console.log('建表：', init.status, JSON.stringify(init.j).slice(0, 120));
  if (init.status !== 200) return;
  let sent = 0;
  for (let i = 0; i < list.length; i += 500) {
    const r = await post('/api/_fans_upsert', { rows: list.slice(i, i + 500) });
    if (r.status !== 200) { console.log('灌库失败', r.status, JSON.stringify(r.j).slice(0, 160)); return; }
    sent += Math.min(500, list.length - i);
    process.stdout.write(`  已灌 ${sent}/${list.length}\r`);
    await sleep(150);
  }
  console.log(`\n灌库完成：${sent} 条 → ${SITE}`);
}

/* ============================ main ============================ */
const t0 = Date.now();
await scanRoom();
if (DO_LIVE) await scanLive();
const PRICE = await priceMap();
const list = build(PRICE);
fs.writeFileSync(OUT, JSON.stringify({ builtAt: Date.now(), people: list.length, list }, null, 0));
const sum = (k) => list.reduce((s, x) => s + x[k], 0);
console.log(`\n===== 粉丝档案：${list.length} 人 =====（本地产物 ${OUT} 不进 git）`);
console.log(`直播 ${sum('live').toLocaleString()} / 房间 ${sum('room').toLocaleString()} / 合计 ${sum('total').toLocaleString()} 鸡腿`);
console.log(`发言 ${sum('msgs').toLocaleString()} 条，2026 年合计 ${sum('total2026').toLocaleString()} 鸡腿`);
if (PUSH) await push(list);
console.log(`耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
