#!/usr/bin/env node
/**
 * 抓取「王语晨参加的公演」（口袋 App 成员个人页「公演」标签的数据源）
 *
 * 接口（由第三方客户端 yaya_msg_mobile 的 API_MAP 逆向得到，已实测）：
 *   POST /im/api/v1/chatroom/msg/list/aim/type
 *   { extMsgType: 'OPEN_LIVE', roomId: '', ownerId: <她的 userId>, nextTime: <游标> }
 *   → content.message[]，每条 extInfo 里有 startTime / coverUrl / jumpPath(含 liveId)
 *   → 这就是「成员公演记录」，实测 277 场，覆盖 2022-10-02（她出道当天）→ 至今。
 *   注意：extInfo.id 超过 2^53，JSON.parse 会丢精度，必须用 msgidClient（字符串）。
 *
 * 详情（名称 / 播放地址）再用 getOpenLiveOne(liveId) 补：content.subTitle 是完整场次名。
 *
 * 产物：site/data/performances-hers.json
 *   { updatedAt, shows: { "<liveId>": { liveId, startTime, coverUrl, title, subTitle, teams, playUrl, fetchedAt } } }
 * 支持断点续传：只补「还没抓详情」的场次；可用 MAX_DETAILS 限制单轮请求数。
 *
 * 用法：node scripts/scrape-hers-performances.mjs
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'site/data/performances-hers.json');

const { MEMBER, POCKET48_TOKEN } = await import(resolve(ROOT, 'scraper/lib/config.mjs'));
const { postJson, fetchOpenLiveOne } = await import(resolve(ROOT, 'scraper/lib/api.mjs'));

const LIST_PATH = '/im/api/v1/chatroom/msg/list/aim/type';
const MAX_DETAILS = Number(process.env.MAX_DETAILS || 400);
const MAX_PAGES = Number(process.env.MAX_PAGES || 80);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(p, fb) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fb; } }
function writeJson(p, obj) { const t = p + '.tmp'; writeFileSync(t, JSON.stringify(obj, null, 2)); renameSync(t, p); }

/* ---------------- 阶段 1：翻出全部公演记录 ---------------- */
let nextTime = 0, pages = 0;
const recs = new Map();
while (pages < MAX_PAGES) {
  let d;
  try {
    d = await postJson(LIST_PATH, { extMsgType: 'OPEN_LIVE', roomId: '', ownerId: String(MEMBER.userId), nextTime: Number(nextTime) || 0 }, { token: POCKET48_TOKEN });
  } catch (e) { console.warn(`[列表] 请求失败：${e.message}`); break; }
  const c = d?.content || {};
  const list = c.message || [];
  if (!list.length) break;
  for (const m of list) {
    let ex = {}; try { ex = JSON.parse(m.extInfo || '{}'); } catch { /* ignore */ }
    const id = String(m.msgidClient || ex.id || '');
    if (!id) continue;
    recs.set(id, {
      liveId: id,
      startTime: Number(ex.startTime || m.msgTime) || 0,
      coverUrl: ex.coverUrl || '',
      title: ex.title || 'GNZ48剧场公演'
    });
  }
  pages++;
  const nt = c.nextTime;
  if (!nt || String(nt) === String(nextTime)) break;
  nextTime = nt;
  await sleep(250);
}
const found = [...recs.values()].sort((a, b) => b.startTime - a.startTime);
if (!found.length) { console.error('未取到任何公演记录（检查 token / 接口是否变化）'); process.exit(1); }
const fmt = (t) => new Date(t + 8 * 3600e3).toISOString().slice(0, 10);
console.log(`[列表] ${found.length} 场（${fmt(found[found.length - 1].startTime)} → ${fmt(found[0].startTime)}）`);

/* ---------------- 阶段 2：补详情（名称 / 播放地址），可续 ---------------- */
const store = readJson(OUT, { shows: {} });
store.shows ||= {};
for (const r of found) {
  const prev = store.shows[r.liveId];
  if (prev) { store.shows[r.liveId] = { ...prev, coverUrl: r.coverUrl || prev.coverUrl, startTime: r.startTime || prev.startTime }; }
  else store.shows[r.liveId] = { ...r, subTitle: '', teams: [], playUrl: '', fetchedAt: '' };
}
const need = found.filter((r) => !store.shows[r.liveId].fetchedAt);
console.log(`[详情] 待补 ${need.length} 场（已有 ${found.length - need.length} 场）`);

let done = 0;
for (const r of need.slice(0, MAX_DETAILS)) {
  try {
    const det = await fetchOpenLiveOne(r.liveId, POCKET48_TOKEN || undefined);
    const rec = store.shows[r.liveId];
    rec.subTitle = det.subTitle || rec.subTitle || '';
    rec.title = det.title || rec.title;
    // fetchOpenLiveOne 已按「高清优先」给出 playStreamPath。
    // 官方部分场次给的是已失效的 ts.48.cn 域名，同样路径在 perform-vod.48.cn 上可用 → 直接改写。
    rec.playUrl = (det.playStreamPath || '').replace('//ts.48.cn/', '//perform-vod.48.cn/');
    rec.streamCount = (det.streams || []).length;
    rec.fetchedAt = new Date().toISOString();
    done++;
  } catch (e) {
    // 失败留空，下轮重试
    if (done === 0 && need.length === 1) console.warn('  详情失败：' + String(e.message).slice(0, 120));
  }
  await sleep(120);
  if ((done + 1) % 50 === 0) console.log(`  [详情] 已补 ${done} 场`);
}
console.log(`[详情] 本轮补了 ${done} 场`);

store.updatedAt = new Date().toISOString();
writeJson(OUT, store);
console.log(`✓ 共 ${Object.keys(store.shows).length} 场 → ${OUT}`);
