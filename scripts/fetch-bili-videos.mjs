#!/usr/bin/env node
/**
 * 抓取 B 站 UP 主的公演录像列表 → site/data/bili-videos.json
 * （构建时由 scripts/build-archive.mjs 按「日期 + 队伍」匹配到公演，作备用播放源）
 *
 * 背景：口袋官方公演回放里 `ts.48.cn` 域名已失效（分片 404），虽已在构建时改写为 `perform-vod.48.cn` 救回，
 * 但仍有大量场次没有官方回放；B 站 UP 主会上传完整录像，标题形如
 *   「【GNZ48】20260913 Team NIII 《拾忆：TEAM NIII》公演」  ← 含日期 + 队伍，可精确匹配。
 *
 * 三条可用通道：默认直连；遇 B 站 WAF 风控（-412/-799）自动改走 SCRAPE_PROXY 隧道兜底
 * （实测杭州阿里云出口可绕过数据中心 IP 限流，与 fetch-live-cuts.mjs 同款逻辑）。
 *   1) 合集：GET /x/polymer/web-space/seasons_series_list?mid=            → 列出合集(seasons)/系列(series)
 *           GET /x/polymer/web-space/seasons_archives_list?mid=&season_id=&page_num=&page_size=30&sort_reverse=false
 *   2) 系列：GET /x/series/archives?mid=&series_id=&only_normal=true&sort=desc&pn=&ps=30
 *   3) 空间投稿列表兜底：GET /x/series/recArchivesByKeywords?mid=&keywords=&pn=&ps=30（appkey 签名）
 *      —— /x/space/arc/search 已停用且需 wbi 签名（nav 现强要登录态、拿不到 wbi 密钥），
 *         改用阈值更宽松的 recArchivesByKeywords；仍可能 -412，故**可断点续传**慢慢补。
 *
 * 用法：node scripts/fetch-bili-videos.mjs
 *   RESET=1        忽略进度从头抓
 *   PAGE_SLEEP=... 每页间隔（默认 2000ms）
 */
import { writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
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
// 出口代理：数据中心 IP 易被 B 站 WAF 限流，SCRAPE_PROXY（杭州阿里云）可绕过
const PROXY_URL = process.env.SCRAPE_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || '';

/* ---------------- 要抓的 UP 与通道 ---------------- */
// 用户指定的三个 B 站数据源：企理鹅大帝 + 忘记自己是猪 + Chzhnh
// （寒影AkiNa 已移除：非用户指定，且多为 SNH48 内容，对王语晨无意义且易被 WAF 封）
const UP_TARGETS = [
  // 企理鹅大帝：公演录像按团体放在「合集」里（稳定、快）
  { mid: '2086351451', label: '企理鹅大帝', seasons: ['4158846', '4158274'] },
  // Chzhnh：有合集（含公演 cut），与直播切片同源；直连/代理均可，空间列表兜底
  { mid: '358477444', label: 'Chzhnh', seasons: [], space: { keep: /GNZ48|公演|特别|王语晨|语晨/i, maxPages: 300 } },
];

/* 出口：直连优先，遇 B 站 WAF 风控（-412/-799）自动改走 SCRAPE_PROXY 隧道兜底
 * （与 fetch-live-cuts.mjs 同款逻辑，实测杭州阿里云出口可绕过数据中心 IP 限流） */
function directGet(urlStr, referer, ua = UA) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': ua, Referer: referer, Accept: 'application/json, text/plain, */*' };
    const req = https.get(urlStr, {
      headers,
      timeout: 20000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function proxyGet(urlStr, referer, ua = UA) {
  return new Promise((resolve, reject) => {
    const p = new URL(PROXY_URL);
    const t = new URL(urlStr);
    const headers = { Host: `${t.hostname}:443` };
    if (p.username) {
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(
        `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password || '')}`
      ).toString('base64');
    }
    const req = https.request({
      host: p.hostname, port: Number(p.port) || 443, method: 'CONNECT',
      path: `${t.hostname}:443`, headers, timeout: 25000, rejectUnauthorized: false
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error('proxy CONNECT ' + res.statusCode)); }
      const s = tls.connect({ socket, servername: t.hostname, rejectUnauthorized: false }, () => {
        s.write([
          `GET ${t.pathname}${t.search} HTTP/1.1`,
          `Host: ${t.hostname}`,
          `User-Agent: ${ua}`,
          `Referer: ${referer}`,
          'Accept: application/json, text/plain, */*',
          'Accept-Encoding: identity',
          'Connection: close',
          '', ''
        ].join('\r\n'));
      });
      const chunks = [];
      s.on('data', (c) => chunks.push(c));
      s.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const sep = raw.indexOf('\r\n\r\n');
        if (sep < 0) return reject(new Error('代理响应异常'));
        const head = raw.slice(0, sep);
        let body = raw.slice(sep + 4);
        if (/transfer-encoding:\s*chunked/i.test(head)) {
          let out = '', rest = body;
          for (;;) {
            const nl = rest.indexOf('\r\n');
            if (nl < 0) break;
            const size = parseInt(rest.slice(0, nl), 16);
            if (!size) break;
            out += rest.slice(nl + 2, nl + 2 + size);
            rest = rest.slice(nl + 2 + size + 2);
          }
          body = out;
        }
        resolve({ status: Number(head.slice(9, 12)), text: body });
      });
      s.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('proxy timeout')));
    req.on('error', reject);
    req.end();
  });
}

function getJson(urlStr, referer, tries = 4, banTries = Number(process.env.BILI_BAN_TRIES ?? 2), ua = UA, proxyFirst = false) {
  return new Promise(async (resolveP, rejectP) => {
    // 默认直连优先；空间投稿列表走 proxyFirst（直连是数据中心 IP，必被 -412，住宅代理才是通的）
    const routes = PROXY_URL ? (proxyFirst ? ['proxy', 'direct'] : ['direct', 'proxy']) : ['direct'];
    let lastMsg = '';
    const maxAttempts = Math.max(tries, banTries);
    for (const route of routes) {
      for (let n = 0; n < maxAttempts; n++) {
        let res;
        try {
          res = route === 'proxy' ? await proxyGet(urlStr, referer, ua) : await directGet(urlStr, referer, ua);
        } catch (e) {
          lastMsg = `${route}:${e.message}`;
          await sleep(1500 * (n + 1));
          continue;
        }
        let d = null;
        try { d = JSON.parse(res.text); } catch { /* HTML = 被风控 */ }
        if (d && d.code === 0) return resolveP(d);
        const msg = d ? `code=${d.code} ${d.message || ''}` : `HTTP ${res.status} 非 JSON`;
        lastMsg = `${route}:${msg}`;
        const ban = /-412|-799/.test(msg);
        // 修正旧 bug：banTries 之前被外层 tries 卡死（只试 2 次）。现按 ban/普通分别用各自上限。
        const limit = ban ? banTries : tries;
        if (n < limit - 1) {
          const wait = ban ? 60000 * (n + 1) : 1500 * (n + 1);
          console.warn(`  [重试] ${lastMsg} → 等 ${Math.round(wait / 1000)}s`);
          await sleep(wait);
          continue;
        }
      }
    }
    rejectP(new Error(lastMsg));
  });
}

const cleanTitle = (t) => String(t || '').replace(/<[^>]+>/g, '').trim();

/* ---------------- 空间投稿列表兜底通道：recArchivesByKeywords（appkey 签名） ---------------- */
// 参考 bilibili-scrape-safe 技能：/x/space/arc/search 已停用且需 wbi 签名，而 wbi 密钥要从
// /x/web-interface/nav 取，但该接口现强要登录态（直连/代理都回 -101），拿不到密钥，故 wbi 路线走不通。
// 改用 recArchivesByKeywords：只需公开的 appkey 签名、阈值宽松得多，是空间列表最稳的兜底通道。
const APPKEY = '1d8b6e7d45233436';
const APPSEC = '560c52ccd288fed045859ed18bffd973';
const BILI_DROID_UA = 'Mozilla/5.0 BiliDroid/7.0.0';
function appkeySign(params) {
  const p = { ...params, ts: Math.round(Date.now() / 1000) };
  const q = Object.keys(p).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]))}`).join('&');
  return q + '&sign=' + createHash('md5').update(q + APPSEC).digest('hex');
}


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
    if (!/GNZ48|公演|特别|王语晨|语晨/i.test(m.name || '')) continue;
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

/* ---------------- 通道 3：空间投稿列表兜底（recArchivesByKeywords，appkey 签名，可续传） ---------------- */
async function crawlSpace(mid, keep, maxPages) {
  const key = `${mid}:space`;
  const referer = `https://space.bilibili.com/${mid}/video`;
  // 用 recArchivesByKeywords（appkey 签名，阈值宽松；比已停用的 wbi/arc/search 稳）兜底抓空间投稿。
  // 每次都从第 1 页开始扫：新上传/重投的视频会被推荐到前面，断点续传会跳过它们，故强制从 pn=1 起；
  // 已入库的 bvid 由 put() 去重，重复扫描安全。
  for (let pn = 1; pn <= maxPages; pn++) {
    if (!budgetLeft()) { console.log('   [预算] 本轮页数已用完，保存进度下次续跑'); save(); return; }
    pagesUsed++;
    let d;
    try {
      const qs = appkeySign({ mid, keywords: '', pn, ps: 30 });
      d = await getJson(`https://api.bilibili.com/x/series/recArchivesByKeywords?${qs}`, referer, 2, Number(process.env.BILI_SPACE_BAN_TRIES ?? 3), BILI_DROID_UA, true);
    } catch (e) {
      console.warn(`   [空间 ${mid}] 第 ${pn} 页失败：${e.message} → 保存进度，下次续跑`);
      progress[key] = pn;
      save();
      return;
    }
    const ar = d.data?.archives || [];
    if (!ar.length) { progress[key] = pn + 1; save(); break; }
    const before = merged.size;
    ar.filter((v) => keep.test(cleanTitle(v.title))).forEach((v) => put(v, mid));
    progress[key] = pn + 1;
    save();
    console.log(`   [空间 ${mid}] 第 ${pn} 页 +${ar.length}（命中 ${merged.size - before}，库 ${merged.size}）`);
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
