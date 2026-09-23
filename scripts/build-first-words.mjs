#!/usr/bin/env node
/**
 * 抓取「每个粉丝在口袋房间说过的第一句话」。
 *
 * 为什么单独一个脚本：build-fans.mjs 扫描房间时只留元数据（uid/时间/角色/礼物），
 * **没有保存发言正文**（当初只为了算鸡腿和活跃度）。要做「我对她说的第一句话」，
 * 只能把房间 IM 再翻一遍，这次把正文留下来。
 *
 * 隐私：正文是房间里的公开留言，不含 uid —— 产物 .cache/fans/first-words.json
 * 的 key 是 uid，但落在 .cache/（gitignore），只有 uid 本人经 /api/mine 能看到自己那句。
 *
 * 用法：
 *   set -a; . ./scraper/.env; set +a
 *   node scripts/build-first-words.mjs            # 全历史（2022-11 起）
 *   node scripts/build-first-words.mjs --back 30  # 只补最近 30 天（增量）
 *   node scripts/build-first-words.mjs --lanes 6
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = await import(ROOT + '/scraper/lib/api.mjs');
const { POCKET48_TOKEN: TOKEN, MEMBER } = await import(ROOT + '/scraper/lib/config.mjs');

const CACHE = path.join(ROOT, '.cache/fans');
const RAW = path.join(CACHE, 'fw-raw.jsonl');          // 扫描落盘（可断点续传）
const PROG = path.join(CACHE, 'fw-progress.json');
const OUT = path.join(CACHE, 'first-words.json');      // 聚合产物：uid -> {t, x, n}
fs.mkdirSync(CACHE, { recursive: true });

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);
const BACK_DAYS = Number(arg('back', 0));
// --stop YYYY-MM-DD：只扫 [FLOOR, 该日期] 这段（补扫旧区间用；网格锚点固定，可反复复用）
const STOP = arg('stop', '');
const CHUNK_DAYS = Number(arg('chunk', 30));
const LANES = Math.max(1, Number(arg('lanes', 4)));
const MAXLEN = 120;                                    // 正文截断（分享卡画得下就够）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STAR_UID = String(MEMBER.starId || '89653517');   // 她自己：不算粉丝

/** 只收「粉丝本人说的、有正文的普通文本」 */
function pickText(m) {
  if (String(m.msgType || '') !== 'TEXT') return '';
  if (!m.bodys) return '';
  let s = '';
  if (typeof m.bodys === 'string') {
    // TEXT 的 bodys 就是正文；少数情况下是 JSON（礼物/卡片走别的 msgType），直接判掉
    if (/^[{[]/.test(m.bodys.trim())) return '';
    s = m.bodys;
  } else if (typeof m.bodys === 'number') s = String(m.bodys);
  else return '';
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > MAXLEN ? s.slice(0, MAXLEN) : s;
}

async function scan() {
  const FLOOR = Date.parse('2022-11-01T00:00:00+08:00');
  const CH = CHUNK_DAYS * 86400e3;
  /* ⚠️ 分片网格必须锚在固定日期上（这里用 FLOOR），不能用 Date.now()：
     用 Date.now() 时每次启动的片边界都会整体平移几小时，progress 里的 key 对不上，
     等于每次重启都从头重扫一遍（踩过：白跑 40 分钟）。
     锚定后 key = FLOOR + k*30d，跨天、跨次启动都能接着扫。 */
  const GRID = FLOOR;
  const top = STOP ? Date.parse(STOP + 'T00:00:00+08:00') : Date.now();
  const end = BACK_DAYS ? top - BACK_DAYS * 86400e3 : FLOOR;
  // 从 top 往下按网格切：k 号片 = [GRID+k*CH, GRID+(k+1)*CH)，最新那片是不满 30 天的零头
  const K = Math.floor((top - GRID) / CH);
  const queue = [];
  for (let k = K; k >= 0; k--) {
    const from = Math.min(top, GRID + (k + 1) * CH);
    const to = Math.max(end, GRID + k * CH);
    if (from <= end) break;                 // 已经比 back 窗口更旧，不用再往下
    queue.push([from, to, String(GRID + k * CH), k === K]);   // 第 4 位：最新零头片，不吃断点
  }

  let prog = { chunks: {} };
  try { prog = JSON.parse(fs.readFileSync(PROG, 'utf8')); if (!prog.chunks) prog.chunks = {}; } catch {}

  const out = fs.createWriteStream(RAW, { flags: 'a' });
  const stat = { new: 0, kept: 0, pages: 0, errors: 0 };
  let idx = 0;

  async function chunk(id, [from, to, key, fresh]) {
    // ⚠️ 游标初值必须是本片上界 from（用 0 会一路翻到底，O(n²)）
    // fresh = 最新那片零头：它的上界每次运行都在变，吃旧断点会漏掉中间的新消息
    let cursor = (prog.chunks[key] === undefined || fresh) ? from : prog.chunks[key];
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
        if (!t || !m.msgIdClient) continue;
        let ex = {}; try { ex = JSON.parse(m.extInfo || '{}'); } catch {}
        const u = ex.user || {};
        const uid = String(u.userId || '');
        if (!uid || uid === '0' || uid === STAR_UID) continue;
        if (String(ex.channelRole ?? '') !== '0') continue;    // 只要粉丝自己的发言
        const x = pickText(m);
        if (!x) continue;
        out.write(JSON.stringify({ i: m.msgIdClient, u: uid, t, x, n: String(u.nickName || '') }) + '\n');
        stat.new++; stat.kept++;
      }
      const nt = Number(r.content.nextTime) || 0;
      if (!nt || (cursor !== 0 && nt >= cursor)) break;
      cursor = nt;
      prog.chunks[key] = cursor;
      if (cursor <= to) break;
      await sleep(120);
    }
    prog.chunks[key] = null;
    fs.writeFileSync(PROG, JSON.stringify(prog));
    console.log(`  [fw w${id}] ${new Date(from).toISOString().slice(0, 10)} → ${new Date(to).toISOString().slice(0, 10)} 完成 | 累计 ${stat.new}`);
  }

  async function worker(id) {
    while (idx < queue.length) {
      const c = queue[idx++];
      try { await chunk(id, c); } catch (e) { console.warn(`  [fw w${id}] 异常 ${String(e.message).slice(0, 80)}`); }
    }
  }
  console.log(`第一句话扫描：${queue.length} 片 × ${CHUNK_DAYS} 天，${LANES} 路并行`);
  await Promise.all(Array.from({ length: LANES }, (_, i) => worker(i + 1)));
  await new Promise((r) => out.end(r));
  console.log(`扫描完成：新增 ${stat.new} 条正文，翻 ${stat.pages} 页`);
}

function aggregate() {
  const first = new Map();     // uid -> {t, x, n}
  if (!fs.existsSync(RAW)) { console.log('没有扫描产物，先跑扫描'); return; }
  let rows = 0;
  for (const line of fs.readFileSync(RAW, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    rows++;
    const cur = first.get(o.u);
    if (!cur || o.t < cur.t) first.set(o.u, { t: o.t, x: o.x, n: o.n });
  }
  const obj = {};
  for (const [uid, v] of first) obj[uid] = v;
  fs.writeFileSync(OUT, JSON.stringify({ builtAt: Date.now(), people: first.size, map: obj }));
  console.log(`\n聚合完成：${rows} 条正文 → ${first.size} 人的「第一句话」→ ${OUT}`);
  // 抽样看看
  const sample = Object.entries(obj).slice(0, 5);
  for (const [uid, v] of sample) {
    console.log(`  ${new Date(v.t + 8 * 3600e3).toISOString().slice(0, 10)}  ${v.x.slice(0, 40)}`);
  }
}

const t0 = Date.now();
if (!has('agg-only')) await scan();
aggregate();
console.log(`耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
