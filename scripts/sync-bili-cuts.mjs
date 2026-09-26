#!/usr/bin/env node
/**
 * 把 bili-videos.json 里 Chzhnh 的「公演cut / 云公演」视频自动合并进 bili-cuts.js。
 * 这是「公演cut 页」与「公演回放页 ✂️ B站cut 入口」共用的数据源。
 *
 * 背景：bili-cuts.js 原本由 tools/fetch-bili-cuts.mjs 从 Chzhnh 单个合集 season 4752040
 * 静态导出（只覆盖 2024-04 起），老公演 cut（如 2022 云公演cut）不在其中，需手工补。
 * 改为：以现有 bili-cuts.js 为基底（保留全部历史条目与封面），仅从 bili-videos.json
 * （fetch-bili-videos.mjs 已抓全 Chzhnh 空间投稿）补充「新增的」老公演cut —— 按 BV 去重，
 * 不覆盖、不丢失现有数据。这样定时抓取会自动把新老公演cut 并入，不再需要手工补。
 *
 * 字段：[日期, 标题, BV号, 封面URL]。日期为北京时间 YYYY-MM-DD，优先从标题 8 位日期解析
 *（例 20221021），解析不到则回退上传时间(pubdate)转北京时间；与公演 stime 转北京时间一致，
 * 保证能挂到对应公演。
 *
 * 用法：node scripts/sync-bili-cuts.mjs   （由 scrape.mjs 在 fetch-bili-videos 后自动调用）
 *   DRY=1   只打印将新增的条目，不写文件
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const VIDEOS = resolve(ROOT, 'site/data/bili-videos.json');
const CUTS_SITE = resolve(ROOT, 'site/js/bili-cuts.js');
const CUTS_DIST = resolve(ROOT, 'dist/js/bili-cuts.js');
const INDEX_SITE = resolve(ROOT, 'site/index.html');
const INDEX_DIST = resolve(ROOT, 'dist/index.html');

// Chzhnh 的 mid（与王语晨公演cut / 直播切片同源的 UP）
const CH_MID = '358477444';
// 只取「公演cut / 云公演」，不要直播切片等其它来源
const KEEP = /公演\s*cut|云公演|公演cut/i;

/* 读现有 bili-cuts.js 数组（基底，保留全部 + 封面）。
 * 用 new Function 让 JS 引擎完整求值数组，避免正则截断。 */
function readCuts(path) {
  if (!existsSync(path)) return [];
  const code = readFileSync(path, 'utf8');
  return new Function('window', code + '\nreturn window.__BILI_CUTS__;')({});
}

/* 解析公演日期（北京时间 YYYY-MM-DD）：
 * 1) 标题里的 8 位日期 20221021
 * 2) 标题里的 6 位日期 260425（年占前两位）
 * 3) 上传时间 pubdate 转北京时间 */
function parseDate(v) {
  const t = v.title || '';
  let m = t.match(/(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/(\d{2})(\d{2})(\d{2})/);
  if (m) return `20${m[1]}-${m[2]}-${m[3]}`;
  if (v.created) {
    const d = new Date(Number(v.created) * 1000 + 8 * 3600 * 1000);
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }
  return '';
}

function main() {
  const A = JSON.parse(readFileSync(VIDEOS, 'utf8'));
  const vids = (A.videos || []).filter((v) => v.mid === CH_MID && KEEP.test(v.title || ''));
  console.log(`[sync-bili-cuts] bili-videos 中 Chzhnh 公演cut/云公演候选：${vids.length} 条`);

  // 基底：保留现有全部条目（含封面）
  const base = readCuts(CUTS_SITE);
  console.log(`[sync-bili-cuts] 现有 bili-cuts.js 基底：${base.length} 条`);

  const byBv = new Map(base.map((c) => [c[2], c]));
  let added = 0;
  const dry = process.env.DRY === '1';
  for (const v of vids) {
    if (byBv.has(v.bvid)) continue;           // 已有（含手工/合集），保留，不覆盖
    const date = parseDate(v);
    if (!date) { console.warn(`  [跳过] 无法解析日期：${v.bvid} ${v.title}`); continue; }
    const entry = [date, v.title, v.bvid, '']; // 新增无封面（bili-videos 不含封面字段）
    byBv.set(v.bvid, entry);
    added++;
    if (dry) console.log(`  [+新增] ${date} ${v.bvid} ${v.title}`);
  }

  const merged = [...byBv.values()].sort((a, b) => b[0].localeCompare(a[0])); // 日期降序
  const min = merged[merged.length - 1]?.[0] || '';
  const max = merged[0]?.[0] || '';

  if (dry) {
    console.log(`[sync-bili-cuts][DRY] 将写入 ${merged.length} 条（本次 +${added}），覆盖 ${min} → ${max}`);
    return;
  }

  const head =
`/**
 * 王语晨补档站 - B 站个人 cut 清单（公演cut 页 / 公演回放页「✂️ B站cut」入口共用的数据源）
 * 自动合并生成：由 scripts/sync-bili-cuts.mjs 从 site/data/bili-videos.json（Chzhnh 空间投稿，
 * 已由 fetch-bili-videos.mjs 抓全）筛「公演cut / 云公演」类、按 BV 去重并入本清单。
 * 以历史手工/合集条目为基底（保留封面），仅补充新增的老公演 cut，不覆盖、不丢失。
 * 字段：[日期, 标题, BV号, 封面URL]。日期为北京时间 YYYY-MM-DD（优先从标题 8 位日期解析，
 *       解析不到回退上传时间），与公演 stime 转北京时间一致，确保能挂到对应公演。
 * 注：本文件随站上线（静态资源，不进 KV）；改它并 bump index.html 的 ?v= 即生效。
 * 共 ${merged.length} 条，覆盖 ${min} → ${max}。
 */`;
  const body = merged.map((c) => '  ' + JSON.stringify(c)).join(',\n') + (merged.length ? ',' : '');
  const file = `${head}\nwindow.__BILI_CUTS__ = [\n${body}\n];\n`;

  writeFileSync(CUTS_SITE, file);
  writeFileSync(CUTS_DIST, file);
  console.log(`[sync-bili-cuts] 已写 site + dist js/bili-cuts.js：${merged.length} 条（本次 +${added}）`);

  // bump index.html 里 bili-cuts.js 的版本号（绕开 CDN 缓存；build-dist 之后会整体再 bump 一次）
  for (const idx of [INDEX_SITE, INDEX_DIST]) {
    if (!existsSync(idx)) continue;
    let h = readFileSync(idx, 'utf8');
    if (!h.includes('bili-cuts.js')) continue;
    const ver = String(Date.now());
    const next = h.replace(/(bili-cuts\.js\?v=)[^"']+/g, `$1${ver}`);
    if (next !== h) { writeFileSync(idx, next); console.log(`[sync-bili-cuts] bump ${idx.split('/').slice(-2).join('/')} ?v=${ver}`); }
  }
}

main();
