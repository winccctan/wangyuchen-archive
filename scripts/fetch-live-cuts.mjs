// 王语晨补档站 · 抓取 B 站「直播切片」（粉丝 UP 剪的直播片段）
//
// 数据源（用户指定）：
//   忘记自己是猪  mid=1805448354   （无合集 → 只能走空间投稿列表）
//   Chzhnh       mid=358477444    （有合集 → 优先走合集接口，稳定且不受风控）
//
// 只收标题里含「王语晨 / 语晨」的投稿（这些 UP 也会发别的内容）。
//
// ★ B 站风控要点（2026-09 实测，踩了很久）：
//   1) /x/space/arc/search 已停用，必须用 /x/space/wbi/arc/search 且带 **wbi 签名**
//      （未签名一律 code=-799「请求过于频繁」）。
//   2) 签名之外还要先访问一次 www.bilibili.com 拿 buvid3 cookie，否则 code=-352「风控校验失败」。
//   3) 数据中心 IP（含本机/代理）很容易吃到 code=-412「request was banned」；
//      此时换出口（SCRAPE_PROXY）或等限流窗口过去。
//   4) 合集接口 /x/polymer/web-space/* 不需要签名、不触发风控 → **优先使用**。
//
// 输出：site/data/live-cuts.js  →  window.LIVE_CUTS = { updatedAt, count, targets, cuts: [...] }
// 增量：与已有文件按 bvid 并集（单轮抓不全也不会丢已抓到的）。
//
// 环境变量：
//   SCRAPE_PROXY / HTTPS_PROXY  出口代理（CONNECT 隧道），可选
//   BILI_PAGE_BUDGET            单轮最多请求多少页（限流用），默认 0=不限
//   PAGE_SLEEP                  每页间隔毫秒，默认 2500
//   RESET=1                     忽略断点续传
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../site/data/live-cuts.js');
const LIVE_JSON = resolve(__dirname, '../site/data/live.json');
const PROXY_URL = process.env.SCRAPE_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || '';
const PAGE_SLEEP = Number(process.env.PAGE_SLEEP || 2500);
const PAGE_BUDGET = Number(process.env.BILI_CUT_PAGE_BUDGET || 0);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rndHex = (n) => Array.from({ length: n }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('');
let pagesUsed = 0;
const budgetLeft = () => PAGE_BUDGET <= 0 || pagesUsed < PAGE_BUDGET;

const UP_TARGETS = [
  { mid: '1805448354', label: '忘记自己是猪' },
  { mid: '358477444', label: 'Chzhnh' }
];
// 只保留她的直播切片：标题必须出现她的名字（全名或常用简称）
const KEEP_TITLE = /王语晨|语晨/i;

/* ---------------- 出口：直连 或 走代理 CONNECT 隧道 ---------------- */
// buvid3 等 cookie：缺它空间接口会返回 -352「风控校验失败」，故预热一次并带在所有请求上
let EXTRA_COOKIE = '';

function proxyGet(urlStr, referer) {
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
      path: `${t.hostname}:443`, headers, timeout: 25000,
      // 该出口代理是自建/自有（scraper/lib/api.mjs 同样这么设）：它会用自家证书做中间人，
      // 不做证书校验才能建隧道；走的只是公开的 B 站接口数据，没有敏感信息。
      rejectUnauthorized: false
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error('proxy CONNECT ' + res.statusCode)); }
      const s = tls.connect({ socket, servername: t.hostname, rejectUnauthorized: false }, () => {
        s.write([
          `GET ${t.pathname}${t.search} HTTP/1.1`,
          `Host: ${t.hostname}`,
          `User-Agent: ${UA}`,
          `Referer: ${referer}`,
          'Accept: application/json, text/plain, */*',
          'Accept-Encoding: identity',
          ...(EXTRA_COOKIE ? [`Cookie: ${EXTRA_COOKIE}`] : []),
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

async function directGet(urlStr, referer) {
  const r = await fetch(urlStr, {
    headers: {
      'User-Agent': UA,
      Referer: referer,
      Accept: 'application/json, text/plain, */*',
      ...(EXTRA_COOKIE ? { Cookie: EXTRA_COOKIE } : {})
    }
  });
  return { status: r.status, text: await r.text() };
}

// 取 JSON：先直连；被风控（-799/-412/-352 或返回 HTML）时改走代理再试
async function getJson(urlStr, referer, tries = 2) {
  let lastMsg = '';
  const routes = PROXY_URL ? ['direct', 'proxy'] : ['direct'];
  for (const route of routes) {
    for (let n = 0; n < tries; n++) {
      let res;
      try {
        res = route === 'proxy' ? await proxyGet(urlStr, referer) : await directGet(urlStr, referer);
      } catch (e) {
        lastMsg = `${route}:${e.message}`;
        await sleep(1200 * (n + 1));
        continue;
      }
      let d = null;
      try { d = JSON.parse(res.text); } catch { /* HTML = 被风控 */ }
      if (d && d.code === 0) return d;
      lastMsg = d ? `${route}:code=${d.code} ${d.message || ''}` : `${route}:非JSON(HTTP ${res.status})`;
      const hard = d && /-799|-412|-352/.test(String(d.code));
      if (!hard && d) return d; // 业务错误（如空合集）不重试
      await sleep(hard ? 3000 * (n + 1) : 1200 * (n + 1));
    }
  }
  throw new Error(lastMsg);
}

/* ---------------- wbi 签名（空间投稿接口必需） ---------------- */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
];
let WBI_KEY = null;
async function ensureWbiKey() {
  if (WBI_KEY) return WBI_KEY;
  // 预热：拿 buvid3 cookie（缺它会 -352「风控校验失败」）
  try {
    const r = await fetch('https://www.bilibili.com/', { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    const ck = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    const buvid = ck.map((c) => c.split(';')[0])
      .filter((c) => /^(buvid3|buvid4|b_nut|_uuid|fingerprint|buvid_fp|b_lsid)=/.test(c)).join('; ');
    if (buvid) EXTRA_COOKIE = buvid;
    // ★ b_lsid 是 B 站前端现算的会话 id，接口并不下发；缺它时空间/动态接口会直接返回
    //   -352「风控校验失败」（实测：只带 buvid3 必 -352，补上 b_lsid 后 code=0）。
    //   格式是 16 位大写十六进制，自己按格式伪造一个即可。
    if (!/b_lsid=/.test(EXTRA_COOKIE)) {
      EXTRA_COOKIE += (EXTRA_COOKIE ? '; ' : '') + 'b_lsid=' + rndHex(16);
    }
    await r.text().catch(() => {});
  } catch (_) { /* 拿不到也继续试 */ }
  const nav = await getJson('https://api.bilibili.com/x/web-interface/nav', 'https://www.bilibili.com/');
  const pick = (u) => String(u).slice(String(u).lastIndexOf('/') + 1).split('.')[0];
  const raw = pick(nav?.data?.wbi_img?.img_url || '') + pick(nav?.data?.wbi_img?.sub_url || '');
  if (raw.length < 32) throw new Error('拿不到 wbi key');
  WBI_KEY = MIXIN_TAB.map((n) => raw[n]).join('').slice(0, 32);
  return WBI_KEY;
}
function signQuery(params) {
  const p = { ...params, wts: Math.round(Date.now() / 1000) };
  const q = Object.keys(p).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return q + '&w_rid=' + createHash('md5').update(q + WBI_KEY).digest('hex');
}

/* ---------------- 状态：增量并集 + 断点续传 ---------------- */
const prev = existsSync(OUT) ? parseOut(OUT) : null;
const merged = new Map((prev?.cuts || []).map((c) => [c.bvid, c]));
const progress = process.env.RESET === '1' ? {} : (prev?.progress || {});

// ★ CI 每次都从仓库里的 live-cuts.js 出发，而空间投稿列表通道很容易被 B 站限流
//   （同一轮抓不到就整批丢了）。所以先读一次线上 KV 里已有的数据做**并集**，
//   让「抓到多少就永久累积在 KV 里」，单轮抓不全也不会把历史条目弄丢。
const WORKER_URL = (process.env.WORKER_URL || 'https://idol.wyc0518.cc').replace(/\/$/, '');
async function seedFromKV() {
  try {
    const r = await fetch(WORKER_URL + '/api/live-cuts', { headers: { 'user-agent': 'wyc-archive-fetch-live-cuts' } });
    if (!r.ok) return 0;
    const d = await r.json();
    let n = 0;
    for (const c of (d.cuts || [])) {
      if (c && c.bvid && !merged.has(c.bvid)) { merged.set(c.bvid, c); n++; }
    }
    return n;
  } catch (_) { return 0; }
}

function parseOut(file) {
  const code = readFileSync(file, 'utf8');
  const i = code.indexOf('window.LIVE_CUTS');
  if (i < 0) return null;
  try { return JSON.parse(code.slice(code.indexOf('{', i), code.lastIndexOf(';'))); } catch { return null; }
}

const bjDate = (sec) => new Date(Number(sec) * 1000 + 8 * 3600e3).toISOString().slice(0, 10);
const cleanTitle = (t) => String(t || '').replace(/<[^>]+>/g, '').trim();

// ★ 标题里的日期优先于发布时间：本 UP 的回放标题写作「【王语晨】20260921 直播回放」，
//   而发布时间常在次日（如 09-18 发布、内容是 09-17 的直播）——
//   用发布时间做日期匹配会整体错一天，必须从标题里取。
function titleDate(title) {
  const t = String(title || '');
  let m = t.match(/(20\d{2})[-/.]?(\d{2})[-/.]?(\d{2})/);           // 20260921 / 2026-09-21
  if (m) return okDate(`${m[1]}-${m[2]}-${m[3]}`);
  m = t.match(/(?:^|[^\d])(\d{2})月(\d{1,2})日/);                    // 9月21日
  if (m) return okDate(`${new Date().getFullYear()}-${m[1]}-${String(m[2]).padStart(2, '0')}`);
  return '';
}
// 兜底：UP 手滑会把年份写错（实见「【王语晨】20560526 直播回放」），
// 未来日期一律不认，交给发布时间去兜。
function okDate(d) {
  const max = new Date(Date.now() + 8 * 3600e3 + 86400000).toISOString().slice(0, 10);
  return d >= '2020-01-01' && d <= max ? d : '';
}
// 类别：回放 / 切片。判据优先看所属合集名（UP 的合集分得很干净），标题只作兜底。
// 无合集（从空间投稿列表抓来的号，如「忘记自己是猪」）默认按「切片」算 ——
// 这些号的投稿本身就是切片，标题形如「【王语晨】cc：方琪你是我的神！」。
function kindOf(collection, title) {
  if (/回放/.test(`${collection} ${title}`)) return 'replay';
  return 'cut';
}

let added = 0;
function put(v, up, collection) {
  const bvid = v.bvid;
  if (!bvid || !KEEP_TITLE.test(cleanTitle(v.title))) return;
  if (merged.has(bvid)) return;
  const created = v.pubdate || v.created || 0;
  const title_ = cleanTitle(v.title);
  const td = titleDate(title_);
  merged.set(bvid, {
    bvid,
    title: title_,
    created,
    date: bjDate(created),                 // 发布时间（北京时间）
    titleDate: td || '',                   // 标题里写的日期（回放用它对上直播）
    kind: kindOf(collection, title_),      // replay / cut
    cover: v.pic || '',
    url: `https://www.bilibili.com/video/${bvid}`,
    up: up.label,
    mid: up.mid,
    collection: collection || ''
  });
  added++;
}

function save() {
  // 规范化：titleDate / kind 每次保存都从 title + collection 重新推导一遍，
  // 这样以后修解析规则能自动作用于已有条目（不必重新抓一遍）。
  for (const c of merged.values()) {
    c.titleDate = titleDate(c.title);
    c.kind = kindOf(c.collection, c.title);
    c.date = bjDate(c.created);
  }
  const cuts = [...merged.values()].sort((a, b) => b.created - a.created);
  // ---------- 匹配对应的直播场次 ----------
  // ⚠️ 切片的【发布时间】不是【直播时间】：切片都是直播结束后才剪出来发的，
  //    实测同一直播的切片可跨 3 天发布（16/17/18 号各一条）；直播跨零点时 UP 还会把
  //    日期写成次日。所以匹配必须用「时间点」，不能用「发布日 ±1 天」。
  // 用 245 条「回放」（标题自带直播日期＝真值）做过验证：
  //   旧规则「发布日 ±1 天」67.3%  →  新规则「发布时间之前最近的一场直播」91.8%
  //   剩余差异主要是 UP 标题年份手滑（写 2025 实为 2026）与跨零点日期口径，并非匹配错误。
  // 发布-直播开始间隔：中位 2.9h、P75 8h、max 40.5h；切片更晚，故窗口放宽到 72h。
  const liveList = [];
  try {
    const lj = JSON.parse(readFileSync(LIVE_JSON, 'utf8'));
    for (const l of (lj.live || [])) {
      const ms = Number(l.ctime);
      if (!ms) continue;
      liveList.push({ liveId: String(l.liveId), ctime: ms, day: bjDate(Math.round(ms / 1000)) });
    }
    liveList.sort((a, b) => a.ctime - b.ctime);
  } catch (_) { /* 没 live.json 就先不匹配 */ }
  const liveByDay = new Map();
  for (const l of liveList) if (!liveByDay.has(l.day)) liveByDay.set(l.day, l);
  const MATCH_WINDOW_MS = 72 * 3600e3;

  for (const c of cuts) {
    // 「公演cut」对应的是公演（另一套 performance 数据），不参与直播匹配
    if (/公演/.test(c.collection || '')) { delete c.liveId; delete c.liveDate; continue; }
    let hit = null;
    // ① 标题自带日期（回放基本都有）→ 精确命中；UP 把年份写错时试相邻年份
    if (c.titleDate) {
      hit = liveByDay.get(c.titleDate) || null;
      if (!hit) {
        for (const dy of [-1, 1]) {
          const alt = (Number(c.titleDate.slice(0, 4)) + dy) + c.titleDate.slice(4);
          const h2 = liveByDay.get(alt);
          if (h2) { hit = h2; break; }
        }
      }
    }
    // ② 没有可用日期（多数切片）→ 取「发布时间之前最近的一场直播」，且限制在 72h 内
    if (!hit && liveList.length) {
      const t = Number(c.created) * 1000;
      let lo = 0, hi = liveList.length - 1, best = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (liveList[mid].ctime <= t) { best = liveList[mid]; lo = mid + 1; } else hi = mid - 1;
      }
      if (best && (t - best.ctime) <= MATCH_WINDOW_MS) hit = best;
    }
    if (hit) { c.liveId = hit.liveId; c.liveDate = hit.day; }
    else { delete c.liveId; delete c.liveDate; }
  }
  const matched = cuts.filter((c) => c.liveId).length;
  const replays = cuts.filter((c) => c.kind === 'replay');
  const clips = cuts.filter((c) => c.kind === 'cut');
  const payload = {
    updatedAt: new Date().toISOString(),
    count: cuts.length,
    matched,
    replays: replays.length,
    clips: clips.length,
    targets: UP_TARGETS,
    progress,
    cuts
  };
  const tmp = OUT + '.tmp';
  writeFileSync(tmp, 'window.LIVE_CUTS = ' + JSON.stringify(payload, null, 2) + ';\n');
  renameSync(tmp, OUT);
  return { total: cuts.length, matched, replays: replays.length, clips: clips.length };
}

/* ---------------- 通道 1：合集 / 系列（无风控，优先） ---------------- */
async function crawlSeasons(up) {
  const { mid } = up;
  const referer = `https://space.bilibili.com/${mid}/channel/series`;
  let d;
  try { d = await getJson(`https://api.bilibili.com/x/polymer/web-space/seasons_series_list?mid=${mid}&page_num=1&page_size=20`, referer); }
  catch (e) { console.warn(`   [合集列表] 失败：${e.message}`); return 0; }
  const il = d.data?.items_lists || {};
  const seasons = il.seasons_list || [];
  const series = il.series_list || [];
  console.log(`   [合集列表] 合集 ${seasons.length} / 系列 ${series.length}`);
  let got = 0;
  for (const s of seasons) {
    const m = s.meta || {};
    got += await crawlSeasonArchives(up, m.season_id, m.name, m.total);
  }
  for (const s of series) {
    const m = s.meta || {};
    got += await crawlSeriesArchives(up, m.series_id, m.name, m.total);
  }
  return got;
}

async function crawlSeasonArchives(up, sid, name, totalHint) {
  if (!sid) return 0;
  const key = `${up.mid}:season:${sid}`;
  const referer = `https://space.bilibili.com/${up.mid}/channel/collectiondetail?sid=${sid}`;
  let total = totalHint || 0, got = 0;

  const scan = async (pn) => {
    if (!budgetLeft()) return null;
    pagesUsed++;
    let d;
    try {
      d = await getJson(`https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${up.mid}&season_id=${sid}&page_num=${pn}&page_size=30&sort_reverse=false`, referer);
    } catch (e) {
      console.warn(`   [合集 ${name}] 第 ${pn} 页失败：${e.message}`);
      return null;
    }
    if (d.data?.page?.total) total = d.data.page.total;
    const ar = d.data?.archives || [];
    if (!ar.length) {
      console.log(`   [合集 ${name}] 第 ${pn} 页 0 条（已到末尾）`);
      return false;
    }
    const before = added;
    ar.forEach((v) => put(v, up, name));
    got += added - before;
    console.log(`   [合集 ${name}] 第 ${pn} 页 ${ar.length} 条（新增 ${added - before}）`);
    await sleep(PAGE_SLEEP);
    return true;
  };

  // ① 先扫第 1 页：拿到真实 total（合集列表给的 total 可能滞后），也覆盖排序变成倒序的情况
  const r1 = await scan(1);
  if (r1 === null) return got; // 预算用尽
  const lastPage = Math.max(1, Math.ceil(total / 30));
  // ② fresh 段：本接口按「加入合集的顺序」正序返回 ⇒ 新投稿永远落在【最后一页】。
  const done = new Set([1]);
  for (let i = 0; i < FRESH_SEASON_PAGES; i++) {
    const pn = lastPage - i;
    if (pn <= 1 || done.has(pn)) continue;
    done.add(pn);
    await scan(pn);
  }
  // ③ 深翻段：按断点补历史（上面扫过的页跳过）
  for (let pn = Math.max(1, Number(progress[key]) || 1); pn <= lastPage; pn++) {
    if (done.has(pn)) continue;
    if (!budgetLeft()) { console.log('   [预算] 本轮页数用完，保存进度下次续跑'); progress[key] = pn; return got; }
    const r = await scan(pn);
    if (r !== true) break;
    progress[key] = pn + 1;
  }
  progress[key] = lastPage + 1; // 本轮已确认扫到末尾，下次从新增长的页继续
  return got;
}

async function crawlSeriesArchives(up, sid, name, totalHint) {
  if (!sid) return 0;
  const key = `${up.mid}:series:${sid}`;
  const referer = `https://space.bilibili.com/${up.mid}/channel/seriesdetail?sid=${sid}`;
  let total = totalHint || 0, got = 0;

  const scan = async (pn) => {
    if (!budgetLeft()) return null;
    pagesUsed++;
    let d;
    try {
      d = await getJson(`https://api.bilibili.com/x/series/archives?mid=${up.mid}&series_id=${sid}&only_normal=true&sort=desc&pn=${pn}&ps=30`, referer);
    } catch (e) {
      console.warn(`   [系列 ${name}] 第 ${pn} 页失败：${e.message}`);
      return null;
    }
    if (d.data?.page?.total) total = d.data.page.total;
    const ar = d.data?.archives || [];
    if (!ar.length) {
      console.log(`   [系列 ${name}] 第 ${pn} 页 0 条（已到末尾）`);
      return false;
    }
    const before = added;
    ar.forEach((v) => put(v, up, name));
    got += added - before;
    console.log(`   [系列 ${name}] 第 ${pn} 页 ${ar.length} 条（新增 ${added - before}）`);
    await sleep(PAGE_SLEEP);
    return true;
  };

  // 本接口 sort=desc ⇒ 新投稿在第 1 页；但为防排序口径变化，末尾页也一并扫
  const done = new Set();
  const r1 = await scan(1);
  if (r1 === null) return got;
  done.add(1);
  const lastPage = Math.max(1, Math.ceil(total / 30));
  for (let i = 0; i < FRESH_SEASON_PAGES; i++) {
    const pn = lastPage - i;
    if (pn <= 1 || done.has(pn)) continue;
    done.add(pn);
    await scan(pn);
  }
  for (let pn = Math.max(1, Number(progress[key]) || 1); pn <= lastPage; pn++) {
    if (done.has(pn)) continue;
    if (!budgetLeft()) { console.log('   [预算] 本轮页数用完，保存进度下次续跑'); progress[key] = pn; return got; }
    const r = await scan(pn);
    if (r !== true) break;
    progress[key] = pn + 1;
  }
  progress[key] = lastPage + 1;
  return got;
}

/* ★★ 2026-09-27 修复：断点只前进不回头 ⇒ 新投稿永远上不了站 ★★
 * 症状：抓取每轮都在跑、从不报错，但库里最新一条停在 2026-09-24 —— 站长发现两个 UP 都更新了却抓不到。
 * 根因：progress 里存的是「下一页页码」，翻到深处就不再回头；而页码一旦超过总页数，
 *       旧代码是 `if (!ar.length) break` **静默退出（连日志都没有）**，看上去像"抓过了"。
 *       但两个通道的新投稿位置恰好都在断点之外：
 *         · 合集/系列 seasons_archives_list 按【加入顺序正序】返回 ⇒ 新投稿在【最后一页】
 *         · 空间 arc/search 按 order=pubdate 【倒序】返回 ⇒ 新投稿在【第 1 页】
 * 修法：每个通道拆两段 —— ① fresh 段每轮必扫「新投稿所在的那几页」（不看 progress）
 *       ② 深翻段再按 progress 往深处回填历史（受页数预算限制）。
 */
const FRESH_SEASON_PAGES = Number(process.env.BILI_CUT_FRESH_SEASON || 2); // 合集/系列：末尾扫几页
const FRESH_SPACE_PAGES = Number(process.env.BILI_CUT_FRESH_SPACE || 1);   // 空间列表：从第 1 页扫几页
const FRESH_DYN_PAGES = Number(process.env.BILI_CUT_FRESH_DYN || 2);       // 动态：扫几页（每页约 12 条）

/* ---------------- 通道 2：空间投稿列表（wbi 签名，易被风控） ---------------- */
// 单轮最多翻几页：空间接口最容易被限流，靠「每轮翻一点 + 断点续传」慢慢补全，
// 而不是一次把整个列表拽下来（那样必吃 -412）。
const SPACE_PAGES_PER_RUN = Number(process.env.BILI_CUT_SPACE_PAGES || 6);
async function crawlSpaceList(up) {
  const { mid } = up;
  const key = `${mid}:space`;
  let got = 0;
  let pages = 0;
  try { await ensureWbiKey(); } catch (e) { console.warn(`   [空间列表] wbi 签名不可用：${e.message}`); return 0; }
  let count = 0;

  const scan = async (pn) => {
    if (!budgetLeft()) return null;
    pagesUsed++;
    pages++;
    const q = signQuery({ mid, ps: 50, pn, order: 'pubdate', platform: 'web', web_location: 1550101 });
    let d;
    try {
      d = await getJson('https://api.bilibili.com/x/space/wbi/arc/search?' + q, `https://space.bilibili.com/${mid}/video`);
    } catch (e) {
      // ⚠️ 被风控（大多是 -412/-352）时**不要**改 progress：那会覆盖掉已经翻到的深度
      console.warn(`   [空间列表] 第 ${pn} 页失败：${e.message}`);
      return null;
    }
    count = d.data?.page?.count || count;
    const vl = d.data?.list?.vlist || [];
    if (!vl.length) return false;
    const before = added;
    vl.forEach((v) => put(v, up, ''));
    got += added - before;
    console.log(`   [空间列表] 第 ${pn} 页 ${vl.length} 条（新增 ${added - before}，库 ${merged.size}/${count}）`);
    await sleep(PAGE_SLEEP);
    return true;
  };

  // ① fresh 段：order=pubdate 倒序 ⇒ 新投稿永远在第 1 页，每轮必扫
  for (let pn = 1; pn <= FRESH_SPACE_PAGES; pn++) {
    const r = await scan(pn);
    if (r === null) return got;          // 风控：后面深翻也多半一样，本轮到此为止
    if (r === false) break;
    progress[key] = Math.max(Number(progress[key]) || 1, pn + 1);
  }
  // ② 深翻段：按断点补历史
  for (let pn = Math.max(FRESH_SPACE_PAGES + 1, Number(progress[key]) || 1); pn <= 200; pn++) {
    if (!budgetLeft()) { console.log('   [预算] 本轮页数用完，保存进度下次续跑'); return got; }
    if (pages >= SPACE_PAGES_PER_RUN) { console.log(`   [空间列表] 本轮已达 ${SPACE_PAGES_PER_RUN} 页上限，下次续跑`); return got; }
    const r = await scan(pn);
    if (r === null) return got;
    if (r === false) break;
    progress[key] = pn + 1;
    if (pn * 50 >= count) break;
  }
  return got;
}

/* ---------------- 通道 3：动态（风控最轻，无合集 UP 的救命通道） ---------------- */
// 「忘记自己是猪」没有合集，只能走空间投稿列表，而那个接口最容易吃 -412（直接返回 HTML 拦截页）。
// 动态接口 /x/polymer/web-dynamic/v1/feed/space 同样要 wbi 签名，但实测风控轻得多：
// 带齐 buvid3 + b_nut + b_lsid 就能拿到 code=0（空间接口同条件下仍然 -412）。
// 代价：archive 里没有 pubdate，改用动态的 pub_ts —— 投稿视频的动态就是投稿那一刻发的，
//       对「对上直播场次」的匹配（按发布时间找最近一场）来说足够用。
async function crawlDynamics(up) {
  const { mid } = up;
  let got = 0;
  try { await ensureWbiKey(); } catch (e) { console.warn(`   [动态] wbi 签名不可用：${e.message}`); return 0; }
  let offset = '';
  for (let page = 1; page <= FRESH_DYN_PAGES; page++) {
    if (!budgetLeft()) return got;
    pagesUsed++;
    const params = offset ? { host_mid: mid, offset, platform: 'web', web_location: 333.33 }
                          : { host_mid: mid, page, platform: 'web', web_location: 333.33 };
    const q = signQuery(params);
    let d;
    try {
      d = await getJson('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?' + q, `https://space.bilibili.com/${mid}/dynamic`);
    } catch (e) { console.warn(`   [动态] 第 ${page} 页失败：${e.message}`); return got; }
    const items = d.data?.items || [];
    // ⚠️ 别静默 break：之前合集通道就是靠「空页直接退出、连日志都没有」骗过了所有人
    if (!items.length) { console.log(`   [动态] 第 ${page} 页 0 条（code=${d.code} ${d.message || ''}）`); break; }
    const before = added;
    for (const it of items) {
      const a = it.modules?.module_dynamic?.major?.archive;
      if (!a || !a.bvid) continue;
      const ts = Number(it.modules?.module_author?.pub_ts) || 0;
      // 动态里的字段名跟投稿接口不一样（cover 而非 pic、没有 pubdate）⇒ 先归一成 put() 认识的形状
      put({ bvid: a.bvid, title: a.title, pic: a.cover, pubdate: ts }, up, '');
    }
    got += added - before;
    console.log(`   [动态] 第 ${page} 页 ${items.length} 条（新增 ${added - before}）`);
    if (!d.data?.has_more || !d.data?.offset) break;
    offset = d.data.offset;
    await sleep(PAGE_SLEEP);
  }
  return got;
}

/* ---------------- 主流程 ---------------- */
console.log(`[直播切片] 目标 ${UP_TARGETS.map((t) => `${t.label}(${t.mid})`).join('、')}`
  + ` | 出口：${PROXY_URL ? '直连→代理兜底' : '直连'}`);
const seeded = await seedFromKV();
if (seeded) console.log(`[直播切片] 已从线上 KV 合并回 ${seeded} 条历史记录（单轮抓不全也不会丢）`);
let ok = 0;
for (const up of UP_TARGETS) {
  console.log(`\n===== ${up.label} (mid=${up.mid}) =====`);
  let n = 0;
  try { n += await crawlSeasons(up); } catch (e) { console.warn(`   [合集通道] 异常：${e.message}`); }
  // 空间列表：无合集的号只能靠它；有合集的号也跑一遍兜底（预算内）
  try { n += await crawlSpaceList(up); } catch (e) { console.warn(`   [空间通道] 异常：${e.message}`); }
  // 动态：风控最轻，且在空间接口被封（-412）时仍能拿到最新投稿 ⇒ 无合集 UP 的主要来源
  try { n += await crawlDynamics(up); } catch (e) { console.warn(`   [动态通道] 异常：${e.message}`); }
  if (n > 0) ok++;
  save();
}

const stat = save() || { total: merged.size, matched: 0, replays: 0, clips: 0 };
console.log(`\n[直播切片] 完成：库中 ${stat.total} 条`
  + `（直播回放 ${stat.replays} / 直播切片 ${stat.clips}；其中对上直播场次的 ${stat.matched} 条），本次新增 ${added} 条`);
console.log(`[直播切片] 输出：${OUT}`);
if (ok === 0 && merged.size === 0) {
  console.warn('[直播切片] 两个号都没抓到内容（多半是 B 站风控限流），本轮跳过，历史数据保持不变');
}
