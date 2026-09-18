// 抓取 GNZ48「当前场次」的参演名单，累积到 site/data/rosters.json。
//
// 背景：官方只公开「当前/预告场次」的参演名单（live.48.cn/Index/main/club/3 页面里 server-render），
// 历史场次名单不公开。故采用「往前累积」策略：每次运行把当前场次的名单记录下来，
// 时间久了就能覆盖越来越多的场次（对历史场次无能为力）。
//
// 每次运行会：
//   1) 抓 GNZ48 公演页，解析当前场次的 showId / 标题 / 日期 / 参演成员；
//   2) 以 showId 为键合并进 rosters.json（幂等，可反复运行）；
//   3) 若发现新场次或名单变化则写回文件。
//
// 用法：node scripts/capture-roster.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../site/data/rosters.json');
const CLUB_URL = 'https://live.48.cn/Index/main/club/3'; // club/3 = GNZ48

async function main() {
  const res = await fetch(CLUB_URL, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'zh-CN,zh;q=0.9' } });
  if (!res.ok) throw new Error('抓取失败 HTTP ' + res.status);
  const html = await res.text();

  const seg = html.slice(Math.max(0, html.indexOf('watchcontent')));
  const title = ((seg.match(/<h2>([^<]*)<\/h2>/) || [])[1] || '').trim();
  const pRaw = ((seg.match(/<p>([\s\S]*?)<\/p>/) || [])[1] || '').replace(/&nbsp;|\s+/g, ' ').trim();
  const idMatch = seg.match(/id="imglist(\d+)"/);
  const showId = idMatch ? idMatch[1] : '';
  if (!showId || !title) {
    console.log('未解析到场次信息（可能页面结构变化），跳过。');
    return;
  }

  const body = seg.slice(seg.indexOf(`id="imglist${showId}"`), seg.indexOf(`id="imglist${showId}"`) + 20000);
  const members = [...body.matchAll(/<span class="name">([^<]+)<\/span>/g)].map((m) => m[1].trim());
  const dm = pRaw.match(/(\d{4})年(\d{2})月(\d{2})日/);
  const date = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : '';

  const store = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { shows: {} };
  store.shows ||= {};
  const prev = store.shows[showId];
  const same = prev && prev.date === date && JSON.stringify(prev.members) === JSON.stringify(members);
  store.shows[showId] = { title, subtitle: pRaw, date, members, capturedAt: new Date().toISOString() };
  store.updatedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(store, null, 2));

  console.log(`[名单] showId=${showId} ${date} ${title} | ${pRaw.slice(0, 40)} | 成员 ${members.length} 人${same ? '（无变化）' : ''}`);
  console.log(`[名单] 累计已记录 ${Object.keys(store.shows).length} 个场次 → ${OUT}`);
}

main().catch((e) => { console.error('capture-roster 失败：', e.message); process.exit(1); });
