#!/usr/bin/env node
/**
 * 直播榜单「实时抓»——后台常驻监听她是否开播，在播期间定时抓贡献榜快照。
 *
 * 为什么需要它（2026-09-22 用户提示）：
 *   直播进行中，榜上有真实昵称 + userId；直播结束后，部分人会变成「神秘守护者」(userId=0)。
 *   → 历史数据（事后补抓）拿不到这些人的身份，只有在播那一刻抓才拿得到。
 *
 * 数据源：
 *   1) POST /live/api/v1/live/getLiveList  { userId, limit:5, nextTime:0, next:'0' }
 *        status: 1=预告 2=直播中 3=已结束   ← 2 就是「正在播」
 *   2) POST /live/api/v2/live/getLiveRank  { type:1, liveId }  → Top20 { user.userId, user.userName, money }
 *        ⚠️ 只有 type=1 有效（type=0/2/3/4/5 实测返回 0 条）；写死 Top20 无分页
 *
 * 输出 .cache/room-msgs/live-snapshots/<liveId>.jsonl
 *   每行 = 一次快照 { ts, liveId, status, n, anon, sum, rank:[{u,nick,m}] }
 *
 * 退场阶梯：某场从 status 2 → 3 时，额外在 +30s / +5min / +30min / +2h 各补一张快照，
 *   用于对比「直播中」与「结束后」的匿名数变化，据此判定匿名到底是时间还是个人开关。
 *
 * 用法：
 *   node tools/watch-live-rank.mjs                 # 常驻，轮询间隔 120s
 *   node tools/watch-live-rank.mjs --interval 45
 *   node tools/watch-live-rank.mjs --single        # 只跑一轮就退出（GitHub Actions 用）
 *   node tools/watch-live-rank.mjs --once <liveId> # 只对某场抓一张快照（对比/补抓用）
 *   node tools/watch-live-rank.mjs --probe         # 只打一次当前直播状态就退出
 *
 * ⚠️ 必须直连：env -u HTTPS_PROXY ... SCRAPE_PROXY=
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const HOME = process.env.HOME || '/Users/tansy';
const ROOT = path.join(HOME, 'WorkBuddy/2026-09-17-16-15-19');
const REPO = process.env.REPO_ROOT || path.join(ROOT, 'wangyuchen-archive');   // 提供 scraper/lib/api.mjs 的仓库

const A = await import(REPO + '/scraper/lib/api.mjs');
const { POCKET48_TOKEN: TOKEN, MEMBER } = await import(REPO + '/scraper/lib/config.mjs');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const INTERVAL = Number(arg('interval', 120)) || 120;
const ONCE = arg('once', '');
const PROBE = process.argv.includes('--probe');
const SINGLE = process.argv.includes('--single');
const OUT_DIR = arg('out', '') || path.join(ROOT, '.cache/room-msgs/live-snapshots');
const STATE = path.join(OUT_DIR, '_state.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = t => new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' CST';
const hourOf = t => Number(new Date(t + 8 * 3600e3).toISOString().slice(11, 13));

await fs.mkdir(OUT_DIR, { recursive: true });

async function rankOf(liveId, status) {
  const r = await A.postJson('/live/api/v2/live/getLiveRank', { type: 1, liveId }, { token: TOKEN, retries: 2 });
  const list = (r.content && r.content.data) || [];
  const rank = list.map(x => ({
    u: String((x.user && x.user.userId) || '0'),
    nick: (x.user && x.user.userName) || '神秘守护者',
    m: Number(x.money) || 0,
  })).sort((a, b) => b.m - a.m);
  const snap = {
    ts: Date.now(), liveId, status,
    n: rank.length,
    anon: rank.filter(x => x.u === '0').length,
    sum: rank.reduce((s, x) => s + x.m, 0),
    rank,
  };
  await fs.appendFile(path.join(OUT_DIR, liveId + '.jsonl'), JSON.stringify(snap) + '\n');
  return snap;
}

async function pubViews() {
  const r = await A.postJson('/live/api/v1/live/getLiveList',
    { userId: Number(MEMBER.starId), limit: 5, nextTime: 0, next: '0' },
    { token: TOKEN, retries: 2 });
  return (r.content && r.content.liveList) || [];
}

if (ONCE) {
  const s = await rankOf(ONCE, 'once');
  console.log('[once]', iso(s.ts), 'liveId', ONCE, '榜', s.n, '匿名', s.anon, '鸡腿', s.sum);
  process.exit(0);
}

console.log('== 直播榜单实时监听 ==  间隔', INTERVAL, 's   成员', MEMBER.starId, '  输出', OUT_DIR);

if (PROBE) {
  const lives = await pubViews();
  for (const l of lives) console.log('  ', new Date(Number(l.ctime)).toISOString(), 'status=' + l.status, l.liveId, JSON.stringify(l.title || ''));
  process.exit(0);
}

// 每场的状态机（--single 模式下从磁盘读回，跨进程续跑）
const SECOND_STATE = {};
try { Object.assign(SECOND_STATE, JSON.parse(await fs.readFile(STATE, 'utf-8'))); } catch {}
const seen = {};   // liveId -> { last, endedAt, ladder:[] }
const LADDER = [30e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3];

function ensure(liveId) {
  if (!SECOND_STATE[liveId]) SECOND_STATE[liveId] = { last: 0, endedAt: 0 };
  if (!seen[liveId]) {
    seen[liveId] = {
      last: SECOND_STATE[liveId].last || 0,
      endedAt: SECOND_STATE[liveId].endedAt || 0,
      ladder: LADDER.map((ms, i) => ({ ms, done: !!(SECOND_STATE[liveId].ladderDone || [])[i] })),
    };
  }
  return seen[liveId];
}
const saveState = async () => {
  const obj = {};
  for (const [k, v] of Object.entries(seen)) {
    obj[k] = { last: v.last, endedAt: v.endedAt, ladderDone: v.ladder.map(x => x.done) };
  }
  await fs.writeFile(STATE, JSON.stringify(obj));
};

let round = 0;
// eslint-disable-next-line no-constant-condition
while (true) {
  round++;
  try {
    const lives = await pubViews();
    for (const l of lives) {
      const st = ensure(l.liveId);
      const status = Number(l.status);
      const isNew = !st.last;
      if (status === 2) {
        if (!st.last || Date.now() - st.last >= INTERVAL * 1000 - 2000) {
          const s = await rankOf(l.liveId, 2);
          st.last = Date.now();
          console.log('[在播]', iso(s.ts), l.liveId, '榜', s.n, '匿名', s.anon, '鸡腿', s.sum);
        }
      } else if (status === 3) {
        if (isNew) { st.endedAt = Date.now(); continue; }   // 老直播，不重复抓
        if (!st.endedAt) {
          st.endedAt = Date.now();
          console.log('[下播]', iso(st.endedAt), l.liveId, '— 开始退场阶梯补抓');
        }
        for (const step of st.ladder) {
          if (!step.done && Date.now() - st.endedAt >= step.ms) {
            step.done = true;
            const s = await rankOf(l.liveId, 3);
            console.log('[退场+' + Math.round(step.ms / 1000) + 's]', iso(s.ts), '榜', s.n, '匿名', s.anon, '鸡腿', s.sum);
          }
        }
      } else if (status === 1) {
        console.log('[预告]', iso(Date.now()), l.liveId, JSON.stringify(l.title || ''));
      }
    }
    // 心跳：每小时打一次，顺便放宽夜间轮询（凌晨 4-9 点她基本不会播）
    if (round % Math.max(1, Math.round(3600 / INTERVAL)) === 0) {
      const h = hourOf(Date.now());
      console.log('[心跳]', iso(Date.now()), '已跑', round, '轮  ' + (h >= 4 && h < 9 ? '夜间休眠中' : '活跃监听'));
    }
    await saveState();
    if (SINGLE) { console.log('[single] 单轮完成，退出'); break; }
    // 凌晨 4-9 点把间隔拉到 15 分钟省请求
    const h = hourOf(Date.now());
    await sleep((h >= 4 && h < 9 ? 900 : INTERVAL) * 1000);
  } catch (e) {
    console.log('[错误]', iso(Date.now()), String(e).slice(0, 140));
    await sleep(60 * 1000);
  }
}
