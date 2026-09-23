/* 诊断：逐场打印 LRC 行数 / 礼物数，定位「到底哪些场次有礼物播报」 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPEND = process.argv.includes('--append');   // 累加模式：按月分批跑时用
const A = await import(ROOT + '/scraper/lib/api.mjs');
const { POCKET48_TOKEN: T } = await import(ROOT + '/scraper/lib/config.mjs');

const ARG = process.argv.slice(2);
const MONTH = (ARG.find((a) => a.startsWith('--month=')) || '').split('=')[1] || '';
const YEAR = (ARG.find((a) => a.startsWith('--year=')) || '').split('=')[1] || '';
const EVERY = ARG.includes('--every') ? Number(ARG[ARG.indexOf('--every') + 1]) : 1;

const RE = /^\[(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\]\s*(.+?)\t\s*送给\s*(.+?)\s+(\d+)\s*个\s*(.+?)\s*$/;
const list = JSON.parse(fs.readFileSync(ROOT + '/site/data/live.json', 'utf8'));
let arr = (Array.isArray(list) ? list : list.live || list.list || []).filter((x) => x && x.liveId);
arr.sort((a, b) => Number(b.ctime || 0) - Number(a.ctime || 0));
if (MONTH) arr = arr.filter((x) => x.ctime && new Date(+x.ctime).toISOString().slice(0, 7) === MONTH);
if (YEAR) arr = arr.filter((x) => x.ctime && new Date(+x.ctime).toISOString().slice(0, 4) === YEAR);
if (EVERY > 1) arr = arr.filter((_, i) => i % EVERY === 0);

console.log(`候选场次 ${arr.length}\n`);
let totLines = 0, totGift = 0, withG = 0, noLrc = 0, empty = 0;
const rows = [];
for (const lv of arr) {
  let url = null;
  try {
    const d = await A.postJson('/live/api/v1/live/getLiveOne', { liveId: lv.liveId }, { retries: 1, token: T });
    url = d?.content?.msgFilePath || null;
  } catch (e) { console.log(`${new Date(+lv.ctime).toISOString().slice(0, 10)} ${lv.liveId}  API-ERR ${String(e.message).slice(0, 40)}`); noLrc++; continue; }
  if (!url) { console.log(`${new Date(+lv.ctime).toISOString().slice(0, 10)} ${lv.liveId}  无 msgFilePath`); noLrc++; continue; }
  let t = '';
  try { const r = await fetch(url); t = await r.text(); } catch (e) { console.log(`${lv.liveId} fetch-ERR`); noLrc++; continue; }
  const L = t.split('\n').filter(Boolean);
  if (!L.length) { empty++; console.log(`${new Date(+lv.ctime).toISOString().slice(0, 10)}  空文件 len=${t.length}`); continue; }
  const gs = [];
  for (const line of L) {
    const m = line.match(RE);
    if (m) gs.push({ liveId: lv.liveId, ct: Number(lv.ctime || 0), nick: m[2].trim(), target: m[3].trim(), num: Number(m[4]), gift: m[5].trim() });
  }
  totLines += L.length; totGift += gs.length; if (gs.length) withG++;
  rows.push(...gs);
  const flag = gs.length ? '🎁' : '  ';
  console.log(`${flag} ${new Date(+lv.ctime).toISOString().slice(0, 10)} ${lv.liveId}  行${String(L.length).padStart(5)}  礼${String(gs.length).padStart(4)}  len=${t.length}`);
}
console.log(`\n合计：场次 ${arr.length} | 有礼物场次 ${withG} | 礼物条目 ${totGift} | 弹幕总行数 ${totLines} | 无LRC ${noLrc} | 空文件 ${empty}`);
const OUT = ROOT + '/.cache/live-gifts.jsonl';
const SUM = ROOT + '/.cache/live-gifts-summary.csv';
if (rows.length) fs.appendFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
if (APPEND) {
  if (!fs.existsSync(SUM)) fs.writeFileSync(SUM, 'month,lives,withGift,giftItems,danmuLines,noLrc,empty\n');
  fs.appendFileSync(SUM, [MONTH || YEAR || 'all', arr.length, withG, totGift, totLines, noLrc, empty].join(',') + '\n');
  console.log(`→ 已累加写入 ${OUT}（礼物 ${rows.length} 条）+ ${SUM}`);
}
