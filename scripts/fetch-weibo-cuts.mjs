#!/usr/bin/env node
/**
 * 抓「GNZ48王语晨的甜橙小铺」（微博 uid 7794095795）的【公演cut】→ site/data/performance-cuts.js
 *
 * 为什么需要它：这条链路以前**根本没有自动脚本**，仓库里那份文件是 2026-09 手工导出的（34 条），
 * 之后应援会新发的 cut 一条都上不了站。本脚本把它接进每日（实际每 5 分钟）抓取链路：
 * 写完由 scrape.yml 后续的 sync-kv.mjs 推到 KV ⇒ 前端 /api/perf-cuts 直接读到，不需要部署。
 *
 * 🔴🔴 数据「不丢 / 不乱 / 不少」的三道闸门（改动前请先读完，别绕过）：
 *   闸门 0  Cookie 失效 / 接口异常 / 一条都没抓到 → **一个字节都不写**，退出码 2（CI 会开 issue 告警）。
 *           理由：这类数据走 KV replaceKey（整份替换），写进去一份空/残缺的清单 = 永久清掉线上老数据。
 *   闸门 1  **以现有文件为基底按 mblogid 取并集**：新抓到的只增不改，老条目（含深翻页才够得着的
 *           2026-05-31、06-07 那两条）永远不会被冲掉。
 *   闸门 2  并集后条数 < 基底条数、或比上一轮线上条数骤降 >5% → 拒写。
 *
 * 用法：
 *   node scripts/fetch-weibo-cuts.mjs            # 正常跑
 *   DRY=1 node scripts/fetch-weibo-cuts.mjs      # 只打印，不写文件
 *   WB_PAGES=20 node scripts/fetch-weibo-cuts.mjs # 深翻页（回填历史用；日常 8 页够了）
 *
 * Cookie 从哪来（依次尝试）：
 *   1) 环境变量 WEIBO_COOKIE
 *   2) 本地文件 private-data/weibo-cookie.txt（本机专用，已在 .gitignore）
 *   3) Cloudflare KV：GET /api/_secret/weibo-cookie（需 SYNC_TOKEN 或 GH_TOKEN）
 *      ⇒ Cookie 不进仓库；过期时站长在 Cloudflare 面板改 KV 即可，不用重新部署。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'site/data/performance-cuts.js');
const ARCHIVE = resolve(ROOT, 'site/data/archive.js');
const LOCAL_COOKIE = resolve(ROOT, 'private-data/weibo-cookie.txt');

const UID = '7794095795';
const ACCOUNT = 'GNZ48王语晨的甜橙小铺';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const WORKER_URL = (process.env.WORKER_URL || 'https://idol.wyc0518.cc').replace(/\/$/, '');
const MAX_PAGES = Number(process.env.WB_PAGES || 8);
const DRY = process.env.DRY === '1';
// 骤降保护阈值：并集结果比「上一轮线上/KV 条数」少超过这个比例就拒写
const DROP_GUARD = 0.95;

const CUT_RE = /公演\s*cut/i;

function log(...a) { console.log('[weibo-cuts]', ...a); }
function warn(...a) { console.warn('[weibo-cuts] ⚠️', ...a); }

/* ---------------- 1. 取 Cookie ---------------- */
async function getCookie() {
  if (process.env.WEIBO_COOKIE && process.env.WEIBO_COOKIE.trim()) {
    log('Cookie 来源：环境变量 WEIBO_COOKIE');
    return process.env.WEIBO_COOKIE.trim();
  }
  if (existsSync(LOCAL_COOKIE)) {
    const c = readFileSync(LOCAL_COOKIE, 'utf8').trim();
    if (c) { log('Cookie 来源：本地 private-data/weibo-cookie.txt'); return c; }
  }
  const tok = process.env.SYNC_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!tok) return '';
  const headers = process.env.SYNC_TOKEN ? { 'x-sync-token': tok } : { 'x-gh-token': tok };
  try {
    const r = await fetch(WORKER_URL + '/api/_secret/weibo-cookie', { headers });
    if (!r.ok) { warn(`取 Cookie 失败 HTTP ${r.status}`); return ''; }
    const j = await r.json();
    if (!j || !j.cookie) { warn('KV 里没有 WEIBO_COOKIE（请在 Cloudflare 面板 SECRETS 命名空间加这个键）'); return ''; }
    log(`Cookie 来源：Cloudflare KV（长度 ${j.len}）`);
    return j.cookie;
  } catch (e) {
    warn('取 Cookie 异常：' + (e && e.message));
    return '';
  }
}

/* ---------------- 2. 解析一条微博 → cut 条目 ---------------- */
function bjDate(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function parsePost(b) {
  const text = b.text_raw || b.text || '';
  if (!CUT_RE.test(text)) return null;

  // 日期：优先标题里的 8 位日期（公演当天），解析不到才退回发布时间
  let date = '';
  const m8 = text.match(/(\d{4})(\d{2})(\d{2})/);
  if (m8) date = `${m8[1]}-${m8[2]}-${m8[3]}`;
  if (!date && b.created_at) {
    const t = new Date(b.created_at.replace('+0800', '+08:00'));
    if (!isNaN(t)) date = bjDate(t.getTime());
  }
  if (!date) return null;

  // 正文按行拆：#超话# / 【…公演cut】20260913 / 场次名 / 空行 / 《曲名》 / 王语晨cut
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const titleIdx = lines.findIndex((l) => CUT_RE.test(l));
  const perf = (titleIdx >= 0 ? lines[titleIdx + 1] : lines[1]) || '';
  // 曲名取「场次名那一行之后」的第一个《…》，避免把场次名里的《剧目》当成曲名
  const after = lines.slice(titleIdx >= 0 ? titleIdx + 2 : 2).join(' ');
  const sm = after.match(/《([^》]+)》/);
  let song = sm ? sm[1].trim() : '';
  // 有一部分 cut 不是歌曲而是 MC 环节（正文写「MC1 “……”」）⇒ 标成 MC1/MC2，
  // 这样「公演cut」页卡片不会顶着场次名、也便于曲目侧一眼排除（MC 不是曲目）。
  if (!song) {
    const mc = after.match(/\bMC\s*(\d)/i);
    if (mc) song = 'MC' + mc[1];
  }

  const mblogid = b.mblogid || b.id || '';
  if (!mblogid) return null;

  const pi = b.page_info || {};
  const mi = pi.media_info || {};
  let h5 = mi.h5_url || '';
  if (!h5 && pi.object_id) h5 = 'https://video.weibo.com/show?fid=' + pi.object_id;
  let cover = typeof pi.page_pic === 'string' ? pi.page_pic : (pi.page_pic && pi.page_pic.url) || '';
  // 微博封面默认给 orj480，换成 orj1080（与现有 34 条口径一致）
  cover = cover.replace(/\/orj480\//, '/orj1080/').replace(/\/mw\d+\//, '/orj1080/');

  return {
    date,
    perf,
    song,
    mblogid: String(mblogid),
    uid: Number(UID),
    url: `https://weibo.com/${UID}/${mblogid}`,
    h5,
    cover,
    text,
    liveId: ''
  };
}

/* ---------------- 3. 日期 → 场次 liveId ---------------- */
function loadPerfIndex() {
  const byDay = new Map();
  try {
    const s = readFileSync(ARCHIVE, 'utf8');
    const j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    for (const p of j.performances || []) {
      const day = bjDate(p.stime || p.ctime || 0);
      if (!day) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(p);
    }
  } catch (e) {
    warn('读 archive.js 失败（liveId 将留空）：' + (e && e.message));
  }
  return byDay;
}

function pickLiveId(entry, byDay) {
  const same = byDay.get(entry.date) || [];
  if (!same.length) return '';
  if (same.length === 1) return String(same[0].liveId || '');
  const m = (entry.perf || '').match(/《([^》]+)》/);
  if (m) {
    const hit = same.filter((p) => ((p.subTitle || '') + (p.title || '')).includes(m[1]));
    if (hit.length === 1) return String(hit[0].liveId || '');
  }
  return '';
}

/* ---------------- 4. 读现有文件（基底） ---------------- */
function readBase() {
  if (!existsSync(OUT)) return { uid: Number(UID), account: ACCOUNT, updatedAt: '', cuts: [] };
  try {
    const code = readFileSync(OUT, 'utf8');
    const fn = new Function('window', 'self', code + '\n;return window.PERF_CUTS || null;');
    const o = fn({});
    if (o && Array.isArray(o.cuts)) return o;
  } catch (e) {
    warn('解析现有 performance-cuts.js 失败：' + (e && e.message));
  }
  return { uid: Number(UID), account: ACCOUNT, updatedAt: '', cuts: [] };
}

/* ---------------- 5. 线上现有条数（骤降保护的基准） ---------------- */
async function prevCount() {
  try {
    const r = await fetch(WORKER_URL + '/api/perf-cuts', { headers: { 'User-Agent': UA } });
    if (!r.ok) return 0;
    const j = await r.json();
    return Array.isArray(j && j.cuts) ? j.cuts.length : 0;
  } catch { return 0; }
}

/* ---------------- 6. Cookie 失效时开 GitHub issue 告警（会发邮件给站长） ---------------- */
async function alertOnce(title, body) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return;
  try {
    const h = { authorization: 'Bearer ' + token, 'user-agent': 'wyc-archive', accept: 'application/vnd.github+json' };
    const r = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&labels=weibo-cookie&per_page=1`, { headers: h });
    const open = r.ok ? await r.json() : [];
    if (Array.isArray(open) && open.length) { log('已存在未关闭的同款告警 issue，不再重复开'); return; }
    const c = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, h),
      body: JSON.stringify({ title, body, labels: ['weibo-cookie'] })
    });
    log(c.ok ? `已开告警 issue（会邮件通知）` : `开 issue 失败 HTTP ${c.status}`);
  } catch (e) {
    warn('告警失败：' + (e && e.message));
  }
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const cookie = await getCookie();
  if (!cookie) {
    console.error('[weibo-cuts] ❌ 拿不到微博 Cookie：本轮跳过，一个字节都不写（其余链路不受影响）');
    await alertOnce(
      '🔴 微博 Cookie 缺失：公演 cut 自动抓取已停',
      '自动抓取在 Cloudflare KV（命名空间 `SECRETS`）里没读到键 `WEIBO_COOKIE`，已跳过本轮，'
      + '**没有写入任何数据**（老数据完好）。\n\n'
      + '怎么修：Cloudflare 面板 → Workers & Pages → KV → 命名空间 `SECRETS` → Add entry，\n'
      + '键填 `WEIBO_COOKIE`，值填登录 weibo.com 后的 Cookie（开发者工具 → Network → 任一请求 → Request Headers → cookie）。\n\n'
      + '修好后关闭本 issue 即可恢复。'
    );
    process.exit(2);
  }

  const headers = { Cookie: cookie, 'User-Agent': UA, Referer: `https://weibo.com/u/${UID}`, 'X-Requested-With': 'XMLHttpRequest' };
  const posts = [];
  const seen = new Set();
  let totalPosts = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let list = [];
    try {
      const r = await fetch(`https://weibo.com/ajax/statuses/mymblog?uid=${UID}&page=${page}&feature=0`, { headers });
      if (!r.ok) { warn(`第 ${page} 页 HTTP ${r.status}`); break; }
      const j = await r.json().catch(() => null);
      list = (j && j.data && j.data.list) || [];
      if (!j || (j.ok === 0 && !list.length)) { warn(`第 ${page} 页返回异常（多半是 Cookie 失效）：${JSON.stringify(j).slice(0, 160)}`); break; }
    } catch (e) {
      warn(`第 ${page} 页请求失败：${e && e.message}`);
      break;
    }
    if (!list.length) break;
    totalPosts += list.length;
    for (const b of list) {
      const id = b.mblogid || b.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      posts.push(b);
    }
    await new Promise((s) => setTimeout(s, 1200));   // 别惹风控
  }

  log(`时间线抓到 ${posts.length} 条微博（${MAX_PAGES} 页内）`);
  const parsed = posts.map(parsePost).filter(Boolean);
  log(`其中「公演cut」${parsed.length} 条`);

  /* 闸门 0：一条都没抓到 ⇒ 判 Cookie 失效 / 接口变了，绝不落盘 */
  if (!parsed.length) {
    console.error('[weibo-cuts] ❌ 一条「公演cut」都没抓到（时间线 ' + totalPosts + ' 条）'
      + ' ⇒ 判定 Cookie 失效或接口变更，本轮不写文件（线上老数据完好）');
    await alertOnce(
      '🔴 微博 Cookie 失效：公演 cut 抓到 0 条',
      `本轮时间线抓到 ${totalPosts} 条微博，但「公演cut」0 条 ⇒ 判定 Cookie 已失效。\n\n`
      + '**已跳过写入，线上数据没有被动过。**\n\n'
      + '怎么修：重新登录 weibo.com → 开发者工具 Network → 复制 cookie → '
      + 'Cloudflare 面板 Workers & Pages → KV → 命名空间 `SECRETS` → 更新键 `WEIBO_COOKIE`。'
    );
    process.exit(2);
  }

  /* 闸门 1：以现有文件为基底，按 mblogid 并集 */
  const base = readBase();
  const baseCuts = Array.isArray(base.cuts) ? base.cuts : [];
  log(`现有基底 ${baseCuts.length} 条`);

  const byId = new Map();
  for (const c of baseCuts) if (c && c.mblogid) byId.set(String(c.mblogid), c);   // 老条目原样保留
  const byDay = loadPerfIndex();
  let added = 0, updated = 0;
  for (const e of parsed) {
    const old = byId.get(e.mblogid);
    if (old) {
      // 已存在：只补空字段（liveId / h5 / cover），绝不覆盖已有非空值
      let touched = false;
      if (!old.liveId) { const lid = pickLiveId(e, byDay); if (lid) { old.liveId = lid; touched = true; } }
      if (!old.h5 && e.h5) { old.h5 = e.h5; touched = true; }
      if (!old.cover && e.cover) { old.cover = e.cover; touched = true; }
      if (touched) updated++;
      continue;
    }
    e.liveId = pickLiveId(e, byDay);
    byId.set(e.mblogid, e);
    added++;
    if (DRY) log(`  [+新增] ${e.date} 《${e.song}》 ${e.url}`);
  }

  const cuts = [...byId.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  /* 闸门 2：条数只能增不能减 */
  if (cuts.length < baseCuts.length) {
    console.error(`[weibo-cuts] ❌ 并集后 ${cuts.length} 条 < 基底 ${baseCuts.length} 条 ⇒ 拒写`);
    process.exit(3);
  }
  const prev = Number(process.env.PERF_CUTS_PREV || 0) || await prevCount();
  if (prev > 0) log(`线上现有 ${prev} 条（骤降保护基准）`);
  if (prev > 0 && cuts.length < prev * DROP_GUARD) {
    console.error(`[weibo-cuts] ❌ 骤降保护：${cuts.length} 条 < 上一轮 ${prev} 条的 ${DROP_GUARD * 100}% ⇒ 拒写`);
    process.exit(3);
  }

  log(`并集 ${cuts.length} 条（本次新增 ${added}，补全 ${updated}）`
    + `，覆盖 ${cuts[cuts.length - 1]?.date} → ${cuts[0]?.date}`);
  if (DRY) { log('[DRY] 未写文件'); return; }

  const out = {
    uid: Number(UID),
    account: ACCOUNT,
    updatedAt: new Date().toISOString(),
    cuts
  };
  writeFileSync(OUT, 'window.PERF_CUTS = ' + JSON.stringify(out, null, 1) + ';\n');
  log(`已写 ${OUT}（${cuts.length} 条）`);
}

main().catch((e) => {
  console.error('[weibo-cuts] ❌ 未捕获异常（未写文件）：', e && e.stack || e);
  process.exit(4);
});
