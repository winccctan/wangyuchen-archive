#!/usr/bin/env node
/**
 * 直播 / 录播「历史补档」——可断点续传
 *
 * 背景：口袋直播列表接口 getLiveList 是**按团（GNZ48）返回**的、每页 20 条、userId 不过滤，
 *      她本人的直播只占 ~2%。要把 2022 年以来的直播全部捞回，需要顺序翻全团列表 1600+ 页，
 *      耗时很长且中途容易被网络/沙箱中断。因此本脚本把「翻页游标」持久化到磁盘，
 *      每次运行只跑一小段（可用 MAX_PAGES / MAX_DETAILS 限制），下次运行自动接着上次继续。
 *
 * 用法：
 *   node scripts/backfill-live.mjs                 # 默认：本轮翻 300 页 + 补 150 条播放地址
 *   MAX_PAGES=2000 MAX_DETAILS=800 node scripts/backfill-live.mjs   # 一口气跑到底
 *   RESET=1 node scripts/backfill-live.mjs         # 清空游标，从最新重新开始
 *
 * 产物：
 *   site/data/live.json      —— 合并后的直播/录播（与 scrape.mjs 同格式，含 playUrl）
 *   site/data/meta.json      —— 同步 counts.live
 *   scraper/.live-cursor.json—— 断点游标（已 gitignore）
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'site/data');
const LIVE_FILE = resolve(DATA_DIR, 'live.json');
const META_FILE = resolve(DATA_DIR, 'meta.json');
const CURSOR_FILE = resolve(ROOT, 'scraper/.live-cursor.json');
const LOCKDIR = '/tmp/wyc-auto-update.lock';

const { MEMBER } = await import(resolve(ROOT, 'scraper/lib/config.mjs'));
const { fetchLiveListPage, fetchLiveOne, fetchNewestLiveId } = await import(resolve(ROOT, 'scraper/lib/api.mjs'));

const MAX_PAGES = Number(process.env.MAX_PAGES || 300);      // 本轮最多翻多少页列表
const MAX_DETAILS = Number(process.env.MAX_DETAILS || 150);  // 本轮最多补多少条播放地址
const PAGE_SLEEP = Number(process.env.PAGE_SLEEP || 250);
const DETAIL_SLEEP = Number(process.env.DETAIL_SLEEP || 150);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (t) => (t && Number.isFinite(Number(t))) ? new Date(Number(t)).toISOString().slice(0, 10) : '-';

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}
// 原子写：先写临时文件再 rename，避免中途被杀留下半个 JSON
function writeJson(p, obj) {
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, p);
}

/* ---------- 互斥锁：与 scripts/auto-update.sh 共用，避免两边同时写 live.json ---------- */
let lockHeld = false;
if (process.env.NO_LOCK !== '1') {
  try {
    // mkdir 是原子操作；已存在则说明有实例在跑
    mkdirSync(LOCKDIR);
    lockHeld = true;
  } catch {
    console.log('已有补档实例在运行（锁被占用），本次退出');
    process.exit(0);
  }
}
const releaseLock = () => { if (lockHeld) { try { rmSync(LOCKDIR, { recursive: true, force: true }); } catch {} lockHeld = false; } };
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

/* ---------------------------- 主流程 ---------------------------- */
const liveData = readJson(LIVE_FILE, { live: [] });
const map = new Map((liveData.live || []).map((x) => [String(x.liveId), x]));
const before = map.size;

let cursor = readJson(CURSOR_FILE, null);
if (process.env.RESET === '1' || !cursor) {
  // next 起点必须是「全团最新一条的 liveId」——next=0 时服务端会忽略 userId、返回全团。
  const seed = await fetchNewestLiveId({ groupId: MEMBER.groupId, record: true });
  cursor = { next: seed, listDone: false, pages: 0, scanned: 0, herFound: before, startedAt: new Date().toISOString() };
  console.log(`[直播补档] 已播种 next=${seed}（全团最新 liveId）`);
}

console.log(`[直播补档] 起始：已有 ${before} 条；游标 next=${cursor.next} listDone=${cursor.listDone}（累计已翻 ${cursor.pages} 页 / 扫 ${cursor.scanned} 条）`);

let added = 0;
let listPages = 0;
let oldest = Infinity;

/* 阶段 1：翻全团列表，筛出她本人的直播 */
while (!cursor.listDone && listPages < MAX_PAGES) {
  let r;
  try {
    r = await fetchLiveListPage({ groupId: MEMBER.groupId, userId: MEMBER.userId, next: cursor.next, record: true });
  } catch (e) {
    console.warn(`[列表] 请求失败（游标已保存，下次可续）：${e.message}`);
    break;
  }
  const list = r.list || [];
  if (!list.length) { console.log('[列表] 空页 → 视为翻到底'); cursor.listDone = true; break; }

  for (const it of list) {
    const t = Number(it.ctime) || 0;
    if (t && t < oldest) oldest = t;
    if (String(it.userInfo?.userId) === String(MEMBER.userId)) {
      const k = String(it.liveId);
      const prev = map.get(k) || {};
      map.set(k, { ...prev, ...it });
      if (!prev.liveId) added++;
    }
  }
  cursor.scanned += list.length;
  cursor.pages++;
  listPages++;

  const nx = r.next;
  if (!nx || nx === '0') { cursor.listDone = true; cursor.next = '0'; }
  else cursor.next = nx;

  writeJson(CURSOR_FILE, cursor); // 每页都落盘，随时可续
  if (listPages % 20 === 0) {
    console.log(`  [列表] 本轮 ${listPages} 页（累计 ${cursor.pages} 页 / 扫 ${cursor.scanned} 条，回溯至 ${fmt(oldest)}），她本人共 ${map.size} 条`);
  }
  await sleep(PAGE_SLEEP);
}
console.log(`[列表] 本轮翻 ${listPages} 页，listDone=${cursor.listDone}，回溯至 ${fmt(oldest)}`);

/* 落盘（可在任意阶段调用）：
 * 写之前重读一次磁盘，把「并发写入（自动补档）」的新条目合并进来，避免互相覆盖。
 * 列表阶段结束就先存一次 —— 这样即使后续补播放地址时被中断，已翻到的条目也不会丢；
 * 缺 playUrl 的条目下一轮会被自动重新识别（needDetail）并续补，天然自愈。 */
function saveLive(final = false) {
  const fresh = readJson(LIVE_FILE, { live: [] });
  let rescued = 0;
  for (const x of fresh.live || []) {
    const k = String(x.liveId);
    const cur = map.get(k);
    if (!cur) { map.set(k, x); rescued++; }
    else if (!cur.playUrl && x.playUrl) map.set(k, { ...cur, playUrl: x.playUrl });
  }
  if (rescued) console.log(`[合并] 写回前从磁盘补回 ${rescued} 条（并发写入的新数据）`);
  const list = [...map.values()].sort((a, b) => Number(b.ctime || 0) - Number(a.ctime || 0));
  writeJson(LIVE_FILE, { live: list });
  const meta = readJson(META_FILE, { counts: {} });
  meta.counts = meta.counts || {};
  meta.counts.live = list.length;
  if (final) meta.lastUpdated = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  writeJson(META_FILE, meta);
  return list;
}

// 列表阶段结束立即落盘（保命）
const savedAfterList = saveLive(false);
console.log(`[落盘] 列表阶段结束，已保存 ${savedAfterList.length} 条`);

/* 阶段 2：给缺 playUrl 的条目补播放地址（可续，本轮限量） */
let detailDone = 0;
let detailTried = 0;
const needDetail = [...map.values()].filter((x) => !x.playUrl);
for (const it of needDetail) {
  if (detailTried >= MAX_DETAILS) break;
  detailTried++;
  try {
    const r = await fetchLiveOne(it.liveId);
    it.playUrl = r.playStreamPath || '';
    detailDone++;
  } catch { /* 失败留空，下轮重试 */ }
  await sleep(DETAIL_SLEEP);
}
console.log(`[播放地址] 本轮尝试 ${detailTried} 条，成功 ${detailDone} 条；仍缺 ${Math.max(0, needDetail.length - detailDone)} 条`);

/* 写回数据（全部完成则顺带刷新 lastUpdated） */
const allDone = cursor.listDone && needDetail.length - detailDone <= 0;
const list = saveLive(allDone);

if (allDone) {
  console.log('✓ 直播补档全部完成');
  try { rmSync(CURSOR_FILE, { force: true }); } catch {}
}

console.log(`[完成] 直播/录播：${before} → ${list.length} 条（本轮新增 ${added}）；listDone=${cursor.listDone}`);
console.log('数据目录：' + DATA_DIR);
