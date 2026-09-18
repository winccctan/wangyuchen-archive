// 把 site/data/*.json 合并成 site/data/archive.js（window.__ARCHIVE__ 全局变量）
// 目的：让站点在 file:// 直接打开时也能加载数据（fetch 在 file:// 下被 CORS 拦截）。
// 用法：node scripts/build-archive.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'site', 'data');
const OUT = resolve(DATA_DIR, 'archive.js');

function read(name, key) {
  try {
    const d = JSON.parse(readFileSync(resolve(DATA_DIR, name), 'utf8'));
    return key ? (d[key] || []) : d;
  } catch {
    return key ? [] : null;
  }
}

// 网页端瘦身：消息的 raw（原始接口报文）占了约一半体积，
// 但它只在「无正文可显示」时用于展示原始数据，因此对有内容的消息直接剔除。
// messages.json 仍保留全量存档，这里只压缩给网页用的 bundle。
function slimMessage(m) {
  if (!m || !m.raw) return m;
  const hasBody = m.text || m.link || m.reply || m.card ||
    (Array.isArray(m.images) && m.images.length) || m.audio || m.video;
  if (hasBody) {
    const { raw, ...rest } = m; // eslint-disable-line no-unused-vars
    return rest;
  }
  return m;
}

/* ---------------- 公演：按「她参加」筛选 + 挂 B 站跳转 ---------------- */
// site/data/performances-manual.json 维护：
//   rule:            { fromDate, requireTeam, excludeSubtitleKeywords } —— 近似规则（无实拍名单时用）
//   herPerformances: 显式名称关键词数组（命中即保留，优先级高于 rule）
//   bili:            [{ match, url }] —— 按名称模糊匹配挂 B 站链接
// site/data/rosters.json 为 scripts/capture-roster.mjs 前瞻累积的「实拍名单」，按日期匹配，命中即以名单为准。
const norm = (s) => String(s || '')
  .replace(/[０-９ａ-ｚＡ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角转半角
  .toLowerCase()
  .replace(/[\s\u3000]/g, '')
  .replace(/[《》「」『』（）()[\]【】·・:：,，.。!！?？~～\-—_/\\|'"“”‘’]/g, '');

function matchName(p, keyword) {
  const k = norm(keyword);
  if (!k) return false;
  const sub = norm(p.subTitle);
  const hay = norm((p.title || '') + (p.subTitle || ''));
  return sub.includes(k) || hay.includes(k) || (sub.length >= 4 && k.includes(sub));
}

const shDate = (ms) => (Number.isFinite(Number(ms)) ? new Date(Number(ms) + 8 * 3600 * 1000).toISOString().slice(0, 10) : '');

/* ---------------- 官方流域名修正 + B 站备用源 ----------------
 * ① 域名修正：官方公演回放里 `ts.48.cn` 已失效（分片 404），但**同样的路径在 `perform-vod.48.cn` 上完全可用**
 *    （实测 2022-10-02 / 2023-10-29 / 2025-05-02 三条换域名后 m3u8 与分片均 200）。
 *    177 条播放地址里有 156 条属 ts.48.cn —— 这就是「2025 播放不了」的根因，改域名即可救回。
 * ② B 站备用源（scripts/fetch-bili-videos.mjs）：UP 主上传的完整公演录像，标题形如
 *    「【GNZ48】20260913 Team NIII 《拾忆：TEAM NIII》公演」，含**日期 + 队伍**，按此精确匹配挂 `biliUrl`。 */
const STREAM_HOST_FIX = { 'ts.48.cn': 'perform-vod.48.cn' };
const biliData = read('bili-videos.json') || { videos: [] };
const biliByDate = new Map();
for (const v of biliData.videos || []) {
  const m = String(v.title || '').match(/(20\d{2})(\d{2})(\d{2})/);
  if (!m) continue;
  const key = m[1] + m[2] + m[3];
  if (!biliByDate.has(key)) biliByDate.set(key, []);
  biliByDate.get(key).push(v);
}

function attachBiliAndPruneDead(list) {
  let biliHit = 0, pruned = 0;
  for (const p of list) {
    // 1) 修正失效的官方流域名（ts.48.cn → perform-vod.48.cn，路径一致）
    if (p.playUrl) {
      for (const [from, to] of Object.entries(STREAM_HOST_FIX)) {
        if (p.playUrl.includes(`//${from}/`)) {
          p.playUrlFixed = p.playUrl;
          p.playUrl = p.playUrl.replace(`//${from}/`, `//${to}/`);
          pruned++;
        }
      }
    }
    // 2) 按「日期 + 队伍」匹配 B 站录像
    if (!p.biliUrl && p.stime) {
      const key = shDate(p.stime).replace(/-/g, '');
      const cands = biliByDate.get(key) || [];
      const teams = (p.teamList || []).map((t) => t.teamName).filter(Boolean);
      const hit = cands.find((v) => /niii/i.test(v.title))
        || (teams.length > 1 ? cands.find((v) => /gnz48/i.test(v.title)) : null);
      if (hit) {
        p.biliUrl = `https://www.bilibili.com/video/${hit.bvid}`;
        p.biliTitle = hit.title;
        biliHit++;
      }
    }
  }
  console.log(`  公演：修正失效官方流域名 ${pruned} 条；挂 B 站源 ${biliHit} 条（B 站库 ${(biliData.videos || []).length} 个视频）`);
  return list;
}

function enrichPerformances(list, manual, rosters) {
  const rule = manual?.rule || {};
  const from = rule.fromDate ? Date.parse(rule.fromDate + 'T00:00:00+08:00') : null;
  const requireTeam = rule.requireTeam || '';
  const excSub = (rule.excludeSubtitleKeywords || []).filter(Boolean);
  const keys = (manual?.herPerformances || []).filter(Boolean);
  const bili = (manual?.bili || []).filter((x) => x && x.match);

  const rosterByDate = {};
  for (const s of Object.values(rosters?.shows || {})) {
    if (s?.date && Array.isArray(s.members) && s.members.length) rosterByDate[s.date] = s.members;
  }

  const teamsOf = (p) => (p.teamList || []).map((t) => t?.teamName).filter(Boolean);
  const subHas = (p, kw) => norm((p.subTitle || '') + (p.title || '')).includes(norm(kw));
  const hasRule = !!(from || requireTeam || excSub.length);

  let dropped = 0, byRoster = 0;
  const kept = [];
  for (const p of list) {
    const roster = rosterByDate[shDate(p.stime)];
    if (roster) { // 1) 有实拍名单 → 以名单为准
      if (roster.includes('王语晨')) { kept.push(p); byRoster++; } else dropped++;
      continue;
    }
    if (keys.length && keys.some((k) => matchName(p, k))) { kept.push(p); continue; } // 2) 显式关键词
    if (!hasRule) { kept.push(p); continue; } // 4) 无规则 → 全保留
    const okDate = from == null || Number(p.stime) >= from;
    const okTeam = !requireTeam || teamsOf(p).includes(requireTeam);
    const okExc = !excSub.some((k) => subHas(p, k));
    if (okDate && okTeam && okExc) kept.push(p); else dropped++; // 3) 规则近似
  }

  let biliHit = 0;
  const out = kept.map((p) => {
    const hit = bili.find((b) => matchName(p, b.match));
    if (!hit) return p;
    biliHit++;
    return { ...p, biliUrl: hit.url };
  });

  if (hasRule || keys.length || bili.length) {
    console.log(`  公演：保留 ${out.length}/${list.length}（筛掉 ${dropped}，其中按实拍名单保留 ${byRoster}）；挂 B 站链接 ${biliHit} 条；已累积名单天数 ${Object.keys(rosterByDate).length}`);
  }
  return out;
}

const manual = read('performances-manual.json') || {};
const rosters = read('rosters.json') || { shows: {} };

// 「排期」累积（scripts/capture-schedule.mjs）：口袋 App 成员页「公演」标签展示的就是这些
// 「即将开始」的场次，官方接口只保留很短窗口，必须定期抓取累积。
// 这里把它们并进公演列表（若历史列表里已有同 liveId 则跳过，避免重复），同样走下面的筛选规则。
const perfRaw = read('performances.json', 'performances');

// ★ 权威数据源：「她参加的公演记录」（scripts/scrape-hers-performances.mjs）
// 来自口袋 App 成员个人页「公演」标签的同一接口（/im/.../chatroom/msg/list/aim/type, OPEN_LIVE）。
// 这是官方按成员给的记录，直接就是「她参加过的公演」，无需再用规则近似。
const hersStore = read('performances-hers.json') || { shows: {} };
const hersShows = Object.values(hersStore.shows || {}).filter((s) => s && s.liveId);
const oldById = new Map(perfRaw.map((p) => [String(p.liveId), p]));

let baseList = perfRaw;
let usedHers = false;
if (hersShows.length) {
  usedHers = true;
  baseList = hersShows.map((s) => {
    const old = oldById.get(String(s.liveId)) || {};
    const teams = (s.teams && s.teams.length) ? s.teams : (old.teamList || []).map((t) => t.teamName).filter(Boolean);
    return {
      liveId: String(s.liveId),
      title: s.title || old.title || 'GNZ48剧场公演',
      subTitle: s.subTitle || old.subTitle || '',
      coverPath: s.coverUrl || old.coverPath || '',
      stime: String(s.startTime || old.stime || ''),
      teamList: teams.map((t) => ({ teamName: t })),
      status: old.status != null ? old.status : 3,
      playUrl: s.playUrl || old.playUrl || '',
      hers: true
    };
  });
  console.log(`  公演：使用「她的公演记录」${baseList.length} 场（${hersShows.filter((s) => s.fetchedAt).length} 场已补详情）`);
}

// 注意：**不要再把「按队伍抓的公演排期」并进来**。
// 排期（getOpenLiveList record=false）是按 teamList 过滤的——「队伍有场次」不等于「她参加」，
// 例如 2026-09-19 拾忆·TEAM NIII·第二十七场 队伍在演但**她本人没参加**，并进来就是错数据。
// 权威判断只能是「她的公演记录」(OPEN_LIVE)：有记录才说明她参加（见 performances-hers.json）。

// 有「她的公演记录」时不再套规则近似（记录本身就是她参加过的），仅保留 B 站链接匹配。
const manualForUse = usedHers ? { ...manual, rule: {}, herPerformances: [] } : manual;

// 先按规则/权威源整理，再修正失效官方流域名并按「日期+队伍」挂 B 站备用源
const performances = attachBiliAndPruneDead(
  enrichPerformances(baseList, manualForUse, rosters)
);

const archive = {
  meta: read('meta.json'),
  messages: read('messages.json', 'messages').map(slimMessage),
  live: read('live.json', 'live'),
  performances
};

// 页头统计以「实际渲染的条数」为准：公演经过筛选、直播经过补档合并，
// 可能与 meta.json 里抓取时记录的原始计数不同（否则页头会显示 383 但列表只有 155）。
archive.meta = archive.meta || {};
archive.meta.counts = {
  messages: archive.messages.length,
  live: archive.live.length,
  performances: archive.performances.length
};

const js = `/* 由 scripts/build-archive.mjs 自动生成，请勿手动编辑 */\nwindow.__ARCHIVE__ = ${JSON.stringify(archive)};\n`;
writeFileSync(OUT, js);

console.log(
  `✓ 生成 ${OUT}\n  口袋发言 ${archive.messages.length} | 直播/录播 ${archive.live.length} | 公演 ${archive.performances.length}`
);
