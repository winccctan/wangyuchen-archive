#!/usr/bin/env node
/**
 * 抓取 B 站 UP 主的公演录像列表 → site/data/bili-videos.json
 * （构建时由 scripts/build-archive.mjs 按「日期 + 队伍」匹配到公演，作备用播放源）
 *
 * 背景：口袋官方公演回放里 `ts.48.cn` 域名已失效（分片 404），虽已在构建时改写为 `perform-vod.48.cn` 救回，
 * 但仍有大量场次没有官方回放；B 站 UP 主会上传完整录像，标题形如
 *   「【GNZ48】20260913 Team NIII 《拾忆：TEAM NIII》公演」  ← 含日期 + 队伍，可精确匹配。
 *
 * 三条可用通道（都直连，绕过沙箱 HTTP_PROXY —— 走代理会被 B 站 WAF 直接拦）：
 *   1) 合集：GET /x/polymer/web-space/seasons_series_list?mid=            → 列出合集(seasons)/系列(series)
 *           GET /x/polymer/web-space/seasons_archives_list?mid=&season_id=&page_num=&page_size=30&sort_reverse=false
 *   2) 系列：GET /x/series/archives?mid=&series_id=&only_normal=true&sort=desc&pn=&ps=30
 *   3) 空间投稿列表：GET /x/space/arc/search?mid=&ps=50&pn=&order=pubdate
 *      —— 风控最严（-412 request was banned / -799 / WAF HTML），时通时断，故**可断点续传**慢慢补。
 *
 * 用法：node scripts/fetch-bili-videos.mjs
 *   RESET=1        忽略进度从头抓
 *   PAGE_SLEEP=... 每页间隔（默认 2000ms）
 */
import { writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../site/data/bili-videos.json');
const PAGE_SLEEP = Number(process.env.PAGE_SLEEP || 2000);
// 单轮最多处理多少页（自动补档时用它限流，避免长时间占用整轮；默认不限）
const PAGE_BUDGET = Number(process.env.BILI_PAGE_BUDGET || 0);
let pagesUsed = 0;
const budgetLeft = () => PAGE_BUDGET <= 0 || pagesUsed < PAGE_BUDGET;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 要抓的 UP 与通道 ---------------- */
const UP_TARGETS = [
  // 企理鹅大帝：公演录像按团体放在「合集」里（稳定、快）
  { mid: '2086351451', label: '企理鹅大帝', seasons: ['4158846', '4158274'] },
  // 寒影AkiNa：无合集，早年「系列」是 2017/2023 的 SNH48 内容，需靠空间投稿列表（只保留 GNZ48 相关）
  { mid: '1315101', label: '寒影AkiNa', series: ['967578'], space: { keep: /GNZ48/i, maxPages: 400 } },
];

function getJson(url, referer, tries = 4, banTries = Number(process.env.BILI_BAN_TRIES ?? 2)) {
  return new Promise((resolveP, rejectP) => {
    const attempt = (n) => {
      const req = httpsGet(url, {
        headers: { 'User-Agent': UA, Referer: referer, Accept: 'application/json, text/plain, */*' },
        timeout: 20000
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', async () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let d = null;
          try { d = JSON.parse(text); } catch { /* 风控返回 HTML */ }
          if (d && d.code === 0) return resolveP(d);
          const msg = d ? `code=${d.code} ${d.message || ''}` : '非 JSON（被风控）';
          const ban = /-412|-799/.test(msg);
          // 空间投稿列表的限流窗口较长（-799 常持续数十分钟），故等得久一点
          if (n < (ban ? banTries : tries)) {
            const wait = ban ? 60000 * (n + 1) : 1500 * (n + 1);
            console.warn(`  [重试] ${msg} → 等 ${Math.round(wait / 1000)}s`);
            await sleep(wait);
            return attempt(n + 1);
          }
          rejectP(new Error(msg));
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', async (e) => {
        if (n < tries) { await sleep(1500 * (n + 1)); return attempt(n + 1); }
        rejectP(e);
      });
    };
    attempt(0);
  });
}

const cleanTitle = (t) => String(t || '').replace(/<[^>]+>/g, '').trim();

/* ---------------- 状态：增量 + 断点续传 ---------------- */
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
const merged = new Map((prev?.videos || []).map((v) => [v.bvid, v]));
const progress = process.env.RESET === '1' ? {} : (prev?.progress || {});
const startSize = merged.size;
let added = 0;

function save() {
  const videos = [...merged.values()].sort((a, b) => b.created - a.created);
  const tmp = OUT + '.tmp';
  writeFileSync(tmp, JSON.stringify({
    updatedAt: new Date().toISOString(),
    count: videos.length,
    targets: UP_TARGETS.map((t) => ({ mid: t.mid, label: t.label })),
    progress,
    videos
  }, null, 2));
  renameSync(tmp, OUT);
}

function put(v, mid) {
  const bvid = v.bvid;
  if (!bvid) return;
  if (merged.has(bvid)) return;
  merged.set(bvid, {
    bvid,
    aid: v.aid,
    title: cleanTitle(v.title),
    created: v.pubdate || v.created || 0,
    duration: v.duration || 0,
    play: v.stat?.view,
    mid
  });
  added++;
}

/* ---------------- 通道 1：合集 ---------------- */
async function crawlSeasons(mid) {
  const referer = `https://space.bilibili.com/${mid}/channel/series`;
  let d;
  try {
    d = await getJson(`https://api.bilibili.com/x/polymer/web-space/seasons_series_list?mid=${mid}&page_num=1&page_size=20`, referer);
  } catch (e) { console.warn(`[合集列表 ${mid}] ${e.message}`); return; }
  const il = d.data?.items_lists || {};
  console.log(`[合集列表 ${mid}] 合集 ${(il.seasons_list || []).length} 个 / 系列 ${(il.series_list || []).length} 个`);
  for (const s of il.seasons_list || []) {
    const m = s.meta || {};
    if (!/GNZ48|公演|特别/i.test(m.name || '')) continue;
    await crawlSeasonArchives(mid, m.season_id, m.name, m.total);
  }
  for (const s of il.series_list || []) {
    const m = s.meta || {};
    if (!/GNZ48|公演|特别/i.test(m.name || '')) continue;
    await crawlSeries(mid, m.series_id, m.name, m.total);
  }
}

async function crawlSeasonArchives(mid, sid, name, totalHint) {
  const key = `${mid}:season:${sid}`;
  const referer = `https://space.bilibili.com/${mid}/channel/collectiondetail?sid=${sid}`;
  let total = totalHint || 0;
  for (let pn = Math.max(1, Number(progress[key]) || 1); pn <= 300; pn++) {
    if (!budgetLeft()) { console.log('   [预算] 本轮页数已用完，保存进度下次续跑'); save(); return; }
    pagesUsed++;
    let d;
    try {
      d = await getJson(`https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${mid}&season_id=${sid}&page_num=${pn}&page_size=30&sort_reverse=false`, referer);
    } catch (e) { console.warn(`   [合集 ${name}] 第 ${pn} 页失败：${e.message}`); progress[key] = pn; save(); return; }
    total = d.data?.page?.total || total;
    const ar = d.data?.archives || [];
    if (!ar.length) break;
    ar.forEach((v) => put(v, mid));
    progress[key] = pn + 1;
    save();
    console.log(`   [合集 ${name}] 第 ${pn} 页 +${ar.length}（库 ${merged.size}/${total}）`);
    if (pn * 30 >= total) break;
    await sleep(PAGE_SLEEP);
  }
}

/* ---------------- 通道 2：系列 ---------------- */
async function crawlSeries(mid, sid, name, totalHint) {
  const key = `${mid}:series:${sid}`;
  const referer = `https://space.bilibili.com/${mid}/channel/seriesdetail?sid=${sid}`;
  let total = totalHint || 0;
  for (let pn = Math.max(1, Number(progress[key]) || 1); pn <= 300; pn++) {
    if (!budgetLeft()) { console.log('   [预算] 本轮页数已用完，保存进度下次续跑'); save(); return; }
    pagesUsed++;
    let d;
    try {
      d = await getJson(`https://api.bilibili.com/x/series/archives?mid=${mid}&series_id=${sid}&only_normal=true&sort=desc&pn=${pn}&ps=30`, referer);
    } catch (e) { console.warn(`   [系列 ${name}] 第 ${pn} 页失败：${e.message}`); progress[key] = pn; save(); return; }
    total = d.data?.page?.total || total;
    const ar = d.data?.archives || [];
    if (!ar.length) break;
    ar.forEach((v) => put(v, mid));
    progress[key] = pn + 1;
    save();
    console.log(`   [系列 ${name}] 第 ${pn} 页 +${ar.length}（库 ${merged.size}/${total}）`);
    if (pn * 30 >= total) break;
    await sleep(PAGE_SLEEP);
  }
}

/* ---------------- 通道 3：空间投稿列表（风控严，可续传，按标题过滤） ---------------- */
async function crawlSpace(mid, keep, maxPages) {
  const key = `${mid}:space`;
  const referer = `https://space.bilibili.com/${mid}/video`;
  let total = 0;
  for (let pn = Math.max(1, Number(progress[key]) || 1); pn <= maxPages; pn++) {
    if (!budgetLeft()) { console.log('   [预算] 本轮页数已用完，保存进度下次续跑'); save(); return; }
    pagesUsed++;
    let d;
    try {
      d = await getJson(`https://api.bilibili.com/x/space/arc/search?mid=${mid}&ps=50&pn=${pn}&order=pubdate`, referer, 2, Number(process.env.BILI_SPACE_BAN_TRIES ?? 2));
    } catch (e) {
      console.warn(`   [空间 ${mid}] 第 ${pn} 页失败：${e.message} → 保存进度，下次续跑`);
      progress[key] = pn;
      save();
      return;
    }
    total = d.data?.page?.count || total;
    const vl = d.data?.list?.vlist || [];
    if (!vl.length) { progress[key] = pn + 1; save(); break; }
    const before = merged.size;
    vl.filter((v) => keep.test(cleanTitle(v.title))).forEach((v) => put(v, mid));
    progress[key] = pn + 1;
    save();
    console.log(`   [空间 ${mid}] 第 ${pn}/${Math.ceil(total / 50)} 页（保留 ${merged.size - before}/${vl.length}，库 ${merged.size}）`);
    await sleep(PAGE_SLEEP);
  }
}

/* ---------------- 主流程 ---------------- */
for (const t of UP_TARGETS) {
  console.log(`\n===== ${t.label}（mid=${t.mid}）=====`);
  if (t.seasons || t.series) {
    try { await crawlSeasons(t.mid); } catch (e) { console.warn('  合集/系列通道失败：' + e.message); }
  }
  if (t.space) {
    await crawlSpace(t.mid, t.space.keep, t.space.maxPages);
  }
}

save();
console.log(`\n✓ B 站视频库 ${startSize} → ${merged.size}（本次新增 ${added}）→ ${OUT}`);
