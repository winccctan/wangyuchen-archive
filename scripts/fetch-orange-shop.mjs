#!/usr/bin/env node
/**
 * 抓取「GNZ48王语晨的甜橙小铺」的**全部视频** → scripts/orange-shop.json
 * （她本人的官方应援号，视频多为「一视频一首」的单曲直拍，是曲目页「只看这首」的数据源之一）
 *
 * 🔴 与 scripts/fetch-bili-videos.mjs 的区别（别合并成一个）：
 *    那边抓的是**完整公演录像**（给 build-archive.mjs 做备用播放源，写 site/data/bili-videos.json，不进 git）；
 *    这边抓的是**单曲视频**（给 build-song-videos.py 生成 songs.js 的 vid 用，要进 git）。
 *    通道也不同：那边的 UP 需要代理/签名兜底，这个号实测**零风控**，直连即可且不用签名。
 *
 * 通道（全部走公开 web 接口，无需 cookie / wbi / appkey）：
 *   1) 合集列表：GET /x/polymer/web-space/seasons_series_list?mid=&page_num=1&page_size=20
 *   2) 合集内页：GET /x/polymer/web-space/seasons_archives_list?mid=&season_id=&page_num=&page_size=30&sort_reverse=false
 *   3) 系列内页：GET /x/series/archives?mid=&series_id=&only_normal=true&sort=desc&pn=&ps=30
 *   ⚠️ 不像 fetch-bili-videos.mjs 那样按名字过滤合集 —— 这个号整体就是她的，全要。
 *
 * 用法：node scripts/fetch-orange-shop.mjs
 *   RESET=1         忽略已有清单从头抓
 *   PAGE_SLEEP=...  每页间隔（默认 1200ms）
 *
 * 产物：
 *   scripts/orange-shop.json  全量清单 [{bvid,title,created,dur}]，按 created 倒序
 *   scripts/orange-new.json   本次**新出现**的视频（含从标题解析出的 8 位日期），给下一轮人工勾选用
 */
import { writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, 'orange-shop.json');
const NEW_OUT = resolve(__dirname, 'orange-new.json');
const MID = process.env.ORANGE_MID || '3461575572719698';
const LABEL = 'GNZ48王语晨的甜橙小铺';
const PAGE_SLEEP = Number(process.env.PAGE_SLEEP || 1200);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 🔴 只收「能挂到曲目上」的视频：单曲直拍（4K60 FOCUS / VR Focus）与各类公演 cut。
   这个号还发【口袋直播】【口袋电台】【抖音更新】【微博更新】【冷餐直播】等一大堆非曲目内容
   （实测全抓 538 条里只有 ~240 条是曲目相关），不筛的话以后生成的待勾清单一半是噪音。
   🔴 对**整个标题**匹配，不是只取「【…】」里的前缀 —— 有两条标题写成
      「GNZ48王语晨 | 4K60 FOCUS】倩兮盼兮|20240505 …」（缺左中括号），只取前缀会漏掉它们。
   ORANGE_ALL=1 可关掉过滤全抓（排查用）。 */
const KEEP = /4K\s*60\s*FOCUS|VR\s*Focus|公演\s*CUT|云公演|官方\s*cut|金曲/i;
const keepAll = process.env.ORANGE_ALL === '1';
let skipped = 0;

function getJson(urlStr, referer, tries = 3) {
  return new Promise((res, rej) => {
    const once = (n) => {
      const req = https.get(urlStr, {
        headers: { 'User-Agent': UA, Referer: referer, Accept: 'application/json, text/plain, */*' },
        timeout: 20000
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let d = null;
          try { d = JSON.parse(text); } catch { /* 非 JSON = 被风控 */ }
          if (d && d.code === 0) return res(d);
          const msg = d ? `code=${d.code} ${d.message || ''}` : `HTTP ${r.statusCode} 非 JSON`;
          if (n < tries) { setTimeout(() => once(n + 1), 1500 * (n + 1)); return; }
          rej(new Error(msg));
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => {
        if (n < tries) { setTimeout(() => once(n + 1), 1500 * (n + 1)); return; }
        rej(e);
      });
    };
    once(1);
  });
}

const cleanTitle = (t) => String(t || '').replace(/<[^>]+>/g, '').trim();
// 标题里的公演日期：先找 8 位（20231217），找不到再找 6 位（230501 → 2023-05-01）。
// 🔴 必须支持 6 位：VR Focus / 公演cut 那批标题就写 230501、250531 这种，漏了它血亏一整类视频。
const dateOf = (t) => {
  const s = String(t || '');
  const m8 = s.match(/(20)(\d{2})(\d{2})(\d{2})/);
  if (m8) {
    const [, y4, mo, d] = m8;
    return ok(y4, mo, d) ? `${y4}-${mo}-${d}` : '';
  }
  const m6 = s.match(/(?<![0-9])(2[2-9])(\d{2})(\d{2})(?![0-9])/);
  if (m6) {
    const [, yy, mo, d] = m6;
    return ok('20' + yy, mo, d) ? `20${yy}-${mo}-${d}` : '';
  }
  return '';
};
function ok(y4, mo, d) {
  const Y = Number(y4), M = Number(mo), D = Number(d);
  return Y >= 2022 && Y <= 2100 && M >= 1 && M <= 12 && D >= 1 && D <= 31;
}

/* ---------------- 已有的：增量合并 ---------------- */
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : [];
const merged = new Map(prev.map((v) => [v.bvid, v]));
const startSize = merged.size;
const fresh = [];

function put(v) {
  const bvid = v.bvid;
  if (!bvid || merged.has(bvid)) return;
  const title = cleanTitle(v.title);
  if (!keepAll && !KEEP.test(title)) { skipped++; return; }
  const row = {
    bvid,
    title,
    created: v.pubdate || v.created || 0,
    dur: Number(v.duration) || 0
  };
  merged.set(bvid, row);
  fresh.push({ ...row, date: dateOf(row.title) });
}

function save() {
  const videos = [...merged.values()].sort((a, b) => b.created - a.created);
  const tmp = OUT + '.tmp';
  writeFileSync(tmp, JSON.stringify(videos, null, 2) + '\n');
  renameSync(tmp, OUT);
  return videos.length;
}

/* ---------------- 主流程 ---------------- */
const referer = `https://space.bilibili.com/${MID}/video`;
let seasons = [], series = [];
try {
  const d = await getJson(`https://api.bilibili.com/x/polymer/web-space/seasons_series_list?mid=${MID}&page_num=1&page_size=20`, referer);
  const il = d.data?.items_lists || {};
  seasons = il.seasons_list || [];
  series = il.series_list || [];
  console.log(`[${LABEL}] 合集 ${seasons.length} 个 / 系列 ${series.length} 个`);
} catch (e) {
  console.warn(`[合集列表] ${e.message}`);
}

// 合集
for (const s of seasons) {
  const m = s.meta || {};
  const sid = m.season_id, name = m.name, totalHint = m.total || 0;
  if (!sid) continue;
  for (let pn = 1; pn <= 200; pn++) {
    let d;
    try {
      d = await getJson(`https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${MID}&season_id=${sid}&page_num=${pn}&page_size=30&sort_reverse=false`,
        `https://space.bilibili.com/${MID}/channel/collectiondetail?sid=${sid}`);
    } catch (e) { console.warn(`   [合集 ${name}] 第 ${pn} 页失败：${e.message}`); break; }
    const ar = d.data?.archives || [];
    if (!ar.length) break;
    const before = merged.size;
    ar.forEach(put);
    console.log(`   [合集 ${name}] 第 ${pn} 页 +${merged.size - before}（库 ${merged.size}/${d.data?.page?.total || totalHint}）`);
    if (pn * 30 >= (d.data?.page?.total || totalHint)) break;
    await sleep(PAGE_SLEEP);
  }
}

// 系列
for (const s of series) {
  const m = s.meta || {};
  const sid = m.series_id, name = m.name, totalHint = m.total || 0;
  if (!sid) continue;
  for (let pn = 1; pn <= 200; pn++) {
    let d;
    try {
      d = await getJson(`https://api.bilibili.com/x/series/archives?mid=${MID}&series_id=${sid}&only_normal=true&sort=desc&pn=${pn}&ps=30`,
        `https://space.bilibili.com/${MID}/channel/seriesdetail?sid=${sid}`);
    } catch (e) { console.warn(`   [系列 ${name}] 第 ${pn} 页失败：${e.message}`); break; }
    const ar = d.data?.archives || [];
    if (!ar.length) break;
    const before = merged.size;
    ar.forEach(put);
    console.log(`   [系列 ${name}] 第 ${pn} 页 +${merged.size - before}（库 ${merged.size}/${d.data?.page?.total || totalHint}）`);
    if (pn * 30 >= (d.data?.page?.total || totalHint)) break;
    await sleep(PAGE_SLEEP);
  }
}

const n = save();
fresh.sort((a, b) => b.created - a.created);
// 🔴 只有「真的有新视频」或「文件还不存在」时才写 orange-new.json ——
//    否则每次跑都会因为 updatedAt 变化产生 diff，CI 里变成天天提交空改动。
if (fresh.length || !existsSync(NEW_OUT)) {
  writeFileSync(NEW_OUT, JSON.stringify({
    updatedAt: new Date().toISOString(),
    mid: MID, label: LABEL,
    count: fresh.length,
    videos: fresh
  }, null, 2) + '\n');
}

console.log(`\n✓ 甜橙小铺视频 ${startSize} → ${n}（本次新增 ${fresh.length}）→ ${OUT}`);
if (!keepAll && skipped) console.log(`   （按曲目口径过滤掉 ${skipped} 条非曲目视频：口袋直播 / 电台 / 抖音 / 微博 / 冷餐等）`);
if (fresh.length) {
  console.log('  新增明细（下一轮人工勾选要用）：');
  fresh.slice(0, 30).forEach((v) => console.log(`   ${v.date || '------- '}  ${v.bvid}  ${v.title}`));
  if (fresh.length > 30) console.log(`   … 其余 ${fresh.length - 30} 条见 ${NEW_OUT}`);
}
