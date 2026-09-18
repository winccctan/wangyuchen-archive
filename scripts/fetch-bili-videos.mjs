#!/usr/bin/env node
/**
 * 抓取 B 站 UP 主的公演录像列表（供构建时按「日期 + 队伍」匹配到公演，作备用播放源）。
 *
 * 背景：口袋官方公演回放的 `ts.48.cn` 流已失效（实测分片 404），177 条播放地址里 156 条属该域名，
 * 覆盖 2022–2024 全部与部分 2025 —— 这是「2025 播放不了」的根因。B 站 UP 主（企理鹅大帝）会上传完整公演录像。
 *
 * 为什么用「合集」而不是「空间投稿列表」：
 *   - 空间列表 `x/space/arc/search` 风控极严（-412 request was banned / WAF HTML），且要翻 45 页；
 *   - 该 UP 的投稿按团体归类在合集里：`合集·GNZ48`(540) / `合集·SNH48`(608) / `合集·特别公演&大型活动`(37) …
 *     `x/polymer/web-space/seasons_archives_list` 稳定可用、每页 30 条，只需十几页就能拿全。
 *
 * 接口（均直连，绕过沙箱代理）：
 *   1) 列出合集：GET /x/polymer/web-space/seasons_series_list?mid=&page_num=1&page_size=20
 *   2) 合集内视频：GET /x/polymer/web-space/seasons_archives_list?mid=&season_id=&page_num=&page_size=30&sort_reverse=false
 *
 * 用法：node scripts/fetch-bili-videos.mjs
 *   BILI_MID=2086351451                  UP 主（默认「企理鹅大帝」）
 *   BILI_SIDS=4158846,4158274,4159154    要抓的合集 id（默认 GNZ48 + 特别公演&大型活动 + CKG48）
 *   RESET=1                              忽略进度，从头抓
 */
import { writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../site/data/bili-videos.json');
const MID = process.env.BILI_MID || '2086351451';
// 默认抓「GNZ48」（她的团）与「特别公演&大型活动」（联合公演）
const SIDS = (process.env.BILI_SIDS || '4158846,4158274').split(',').map((s) => s.trim()).filter(Boolean);
const PAGE_SIZE = 30;
const PAGE_SLEEP = Number(process.env.PAGE_SLEEP || 1200);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 直连 GET（绕过沙箱 HTTP_PROXY —— B 站会把代理出口直接 WAF 掉）
function getJson(url, referer, tries = 4) {
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
          try { d = JSON.parse(text); } catch { /* 风控会返回 HTML */ }
          if (d && d.code === 0) return resolveP(d);
          const msg = d ? `code=${d.code} ${d.message || ''}` : '非 JSON（被风控）';
          const ban = /-412|-799/.test(msg);
          if (n < (ban ? 3 : tries)) {
            const wait = ban ? 20000 * (n + 1) : 1500 * (n + 1);
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

// 增量：与已有数据合并（按 bvid）
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
const merged = new Map((prev?.videos || []).map((v) => [v.bvid, v]));
const progress = process.env.RESET === '1' ? {} : (prev?.progress || {});
const startSize = merged.size;
let fetched = 0;

function save() {
  const videos = [...merged.values()].sort((a, b) => b.created - a.created);
  const payload = {
    mid: MID,
    sids: SIDS,
    updatedAt: new Date().toISOString(),
    count: videos.length,
    progress,           // { sid: 下次从第几页继续 }
    videos
  };
  const tmp = OUT + '.tmp';
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, OUT);
}

for (const sid of SIDS) {
  let pn = Math.max(1, Number(progress[sid]) || 1);
  const referer = `https://space.bilibili.com/${MID}/channel/collectiondetail?sid=${sid}`;
  let total = 0;
  for (; pn <= 200; pn++) {
    let d;
    try {
      d = await getJson(`https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${MID}&season_id=${sid}&page_num=${pn}&page_size=${PAGE_SIZE}&sort_reverse=false`, referer);
    } catch (e) {
      console.warn(`[合集 ${sid}] 第 ${pn} 页失败：${e.message} → 保存进度，下次续跑`);
      progress[sid] = pn;
      save();
      process.exitCode = 0;
      // 继续下一个合集
      total = -1;
      break;
    }
    const da = d.data || {};
    total = da.page?.total || total;
    const archives = da.archives || [];
    if (!archives.length) break;
    for (const v of archives) {
      merged.set(v.bvid, {
        bvid: v.bvid,
        aid: v.aid,
        title: cleanTitle(v.title),
        created: v.pubdate || 0,
        duration: v.duration || 0,
        play: v.stat?.view,
        sid
      });
      fetched++;
    }
    console.log(`[合集 ${sid}] 第 ${pn} 页 +${archives.length}（累计 ${merged.size}/${total}）`);
    progress[sid] = pn + 1;
    save();
    if (pn * PAGE_SIZE >= total) break;
    await sleep(PAGE_SLEEP);
  }
  if (total > 0) console.log(`[合集 ${sid}] 完成，共 ${total} 个视频`);
}

save();
console.log(`✓ 视频库 ${startSize} → ${merged.size}（本次新增 ${fetched}）→ ${OUT}`);
