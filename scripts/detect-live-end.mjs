#!/usr/bin/env node
/**
 * detect-live-end.mjs —— 她刚下播、且回放弹幕（LRC）已生成时，拨一次 fans-sync 重算档案。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 档案里的鸡腿 = live2026 + room2026（该粉丝这一年送她的，直播 + 口袋房间）。
 * 这两个值由 scripts/build-fans.mjs **全量重算**，原来只在每天 01:23 跑一次
 * （实测 GitHub 的 schedule 常延后到 03:30）。
 * ⇒ 她正在播、或刚下播的这一场，要等**次日凌晨**才进档案。
 *
 * 而实测 fans-sync 一次只要 **3~4 分钟**（2026-10-24 19:34:51→19:38:10）。
 * ⇒ 关播后立刻拨一次，档案几分钟内就更新，直播礼物和房间礼物一起被算进去。
 *
 * ── 🔴 为什么不做「增量改 D1」 ──────────────────────────────────────────────
 * build-fans 里 `live2026 = max(榜单累计, 弹幕累计)` —— 它是 max 出来的**结果值**，
 * 不是可累加的原始量。硬 += 会和次日全量重建打架（可能被回退、也可能重复计）。
 * 而且 /api/mine 以 KV 桶（`fan/<uid末两位>`，整桶覆盖）为主路径，
 * 改一个人也要重写整桶，并发时还会丢更新。**重跑全量最稳，代价只有 3~4 分钟。**
 *
 * ── 🔴 为什么先检查 LRC ────────────────────────────────────────────────────
 * `getLiveOne` 的 `msgFilePath` 只在 status 变 3 **之后**才生成。
 * 没生成就重算等于白跑，还白占一次 KV 写配额（fans-sync 一次约 200 次 KV 写）。
 *
 * ── 防重复（不依赖状态文件）──────────────────────────────────────────────
 * 查 fans-sync 最近几次运行：若已有一轮在该场「结束时间 + 2 分钟」之后成功跑完，
 * 说明这场已经被算进去了，直接退出。场次靠 liveId 区分（一天两场也不会混）。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────────
 *   node scripts/detect-live-end.mjs --dry          # 只看判断结果，不触发
 *   node scripts/detect-live-end.mjs                # 判断 + 真的 dispatch
 *
 * CI 里把结果写进 $GITHUB_OUTPUT：ready=1 / ready=0 与 reason。
 * 需要 env：POCKET48_TOKEN、GITHUB_TOKEN（workflow 的 secrets.GITHUB_TOKEN 即可）、
 *          GITHUB_REPOSITORY（Actions 自动提供）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const A = await import(ROOT + '/scraper/lib/api.mjs');
const CFG = await import(ROOT + '/scraper/lib/config.mjs');
const TOKEN = CFG.POCKET48_TOKEN;
const HER_UID = String(process.env.HER_UID || '89653517');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes('--dry');
const MAX_AGE_H = Math.max(0.5, Number(arg('max-age', 6)) || 6);   // 太旧的场次交给每日 cron

const GH = process.env.GITHUB_TOKEN || '';
const REPO = process.env.GITHUB_REPOSITORY || '';
const WF = 'fans-sync.yml';
const API = 'https://api.github.com';

const out = (k, v) => {
  console.log(`[detect] ${k} = ${v}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
};
const finish = (ready, reason) => { out('ready', ready ? '1' : '0'); out('reason', reason); process.exit(0); };

const iso = (t) => new Date(t + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);

async function gh(pathname, init) {
  const r = await fetch(API + pathname, {
    ...init,
    headers: {
      authorization: 'Bearer ' + GH,
      accept: 'application/vnd.github+json',
      'user-agent': 'wyc-live-end-detect',
      'content-type': 'application/json',
      ...((init && init.headers) || {}),
    },
  });
  const txt = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`GitHub ${r.status} ${pathname}: ${txt.slice(0, 120)}`);
  return txt ? JSON.parse(txt) : null;
}

/* ── 1. 最近一场直播的状态 ── */
const r = await A.postJson('/live/api/v1/live/getLiveList',
  { userId: Number(CFG.MEMBER && CFG.MEMBER.starId) || Number(HER_UID), limit: 5, nextTime: 0, next: '0' },
  { token: TOKEN, retries: 2 });
const list = ((r && r.content && r.content.liveList) || [])
  .map((x) => ({
    liveId: String(x.liveId || x.id || ''),
    status: Number(x.status) || 0,
    startTime: Number(x.startTime || x.ctime || 0),
  }))
  .filter((x) => x.liveId);

if (!list.length) finish(false, '没拿到直播列表');

const liveNow = list.find((x) => x.status === 2);
if (liveNow) finish(false, `正在播（${liveNow.liveId}），下播后再说`);

/* 已结束的场次按结束时间倒序 —— 口袋的 startTime 是开播时间，
 * 结束时间要另取；列表本身已按时间倒序，直接取第一条 status=3。 */
const last = list.find((x) => x.status === 3);
if (!last) finish(false, '没有已结束的场次');

/* 拿这一场的详情：只要能确认 msgFilePath（弹幕 LRC）存不存在。
 * ⚠️ 这个接口**没有结束时间字段**，别指望 endTime。 */
let detail = null;
try {
  const d = await A.postJson('/live/api/v1/live/getLiveOne', { liveId: last.liveId },
    { retries: 1, token: TOKEN });
  detail = (d && d.content) || null;
} catch (e) {
  finish(false, `getLiveOne 失败：${String(e.message).slice(0, 60)}`);
}

/* ── 3. LRC 就绪？ ── */
const lrc = (detail && detail.msgFilePath) || '';
if (!lrc) finish(false, `LRC 还没生成（${last.liveId}），等下一轮`);

/* LRC 的 Last-Modified 才是「这批弹幕定稿」的时刻，也是最可靠的时间锚点。
 * 🔴 实测（2026-10-24 那场）：关播约 16:07，LRC 的 last-modified 是 17:22，
 *    **关播后 ~75 分钟才定稿**。所以「下播 5 分钟就进档案」做不到 —— 瓶颈在对方生成，
 *    我们能做的是「定稿后 10 分钟内进档案」（原来要等次日 03:30）。
 * 🔴 getLiveOne 里**没有 endTime / liveEndTime**（只有 ctime = 开播时间），
 *    所以别指望用接口字段算结束时间。 */
async function lrcMtime(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) return 0;
    const lm = r.headers.get('last-modified');
    return lm ? Date.parse(lm) : 0;
  } catch { return 0; }
}
const mtime = await lrcMtime(lrc);
if (!mtime) finish(false, `LRC 的 last-modified 读不到（${last.liveId}）`);

const ageH = (Date.now() - mtime) / 3600e3;
if (ageH > MAX_AGE_H) {
  finish(false, `LRC 定稿于 ${ageH.toFixed(1)}h 前（超过 ${MAX_AGE_H}h，交给每日重建）`);
}
out('lrcMtime', iso(mtime));

/* 定稿后留 2 分钟再动（避免半截文件）；超过 45 分钟还没触发成功就放弃这轮 ——
 * 说明中间已经有一轮 fans-sync 处理过了，或者出了别的问题，别无限重试。 */
const anchor = mtime + 2 * 60000;
const windowEnd = mtime + 45 * 60000;
if (Date.now() < anchor) finish(false, `LRC 刚定稿（${iso(mtime)}），2 分钟后再动`);
if (Date.now() > windowEnd) finish(false, `LRC 定稿已超过 45 分钟窗口（${iso(mtime)}）`);

/* ── 4. 这一场是不是已经被重算过 ── */
if (!GH || !REPO) finish(false, '缺 GITHUB_TOKEN / GITHUB_REPOSITORY，无法判断是否已触发');
let already = false, lastRunAt = 0;
try {
  const j = await gh(`/repos/${REPO}/actions/workflows/${WF}/runs?per_page=10`);
  for (const run of (j && j.workflow_runs) || []) {
    const created = Date.parse(run.created_at || 0) || 0;
    if (created > lastRunAt) lastRunAt = created;
    if (run.status !== 'completed') continue;
    if (run.conclusion !== 'success') continue;
    // 锚点用 LRC 定稿时间：定稿之后跑过一轮，就说明这场已经被算进档案了
    if (created >= anchor) { already = true; break; }
  }
} catch (e) {
  finish(false, `查运行记录失败：${String(e.message).slice(0, 80)}`);
}
if (already) {
  finish(false, `LRC 定稿（${iso(mtime)}）后已重算过`
    + (lastRunAt ? `（最近一次 ${iso(lastRunAt)}）` : ''));
}

/* ── 5. 触发 ── */
if (DRY) {
  out('lrc', lrc.slice(0, 60));
  finish(true, `[dry] 会触发 ${WF}（${last.liveId} 已下播且 LRC 就绪）`);
}

try {
  await gh(`/repos/${REPO}/actions/workflows/${WF}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'main' }),
  });
} catch (e) {
  finish(false, `dispatch 失败：${String(e.message).slice(0, 100)}`);
}
finish(true, `已触发 ${WF} 重算档案（场次 ${last.liveId}${endAt ? '，结束于 ' + iso(endAt) : ''}）`);
