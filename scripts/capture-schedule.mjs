// 抓取 GNZ48「公演排期 / 即将开始」并累积到 site/data/schedule.json
//
// 背景：口袋 App 里成员个人页的「公演」标签，展示的是**排期（即将开始）**的场次，
// 对应接口 getOpenLiveList 的 record=false（官方注释：false=排期/进行中）。
// 该列表只保留很短的窗口（GNZ48 通常只有 2~4 条），过几天就会被新场次顶掉，
// 因此必须**定期抓取 + 累积**，才能逐渐沉淀出「她参加过的公演」。
// （历史回放列表 record=true 由 scrape.mjs 抓取；这里只负责「排期」这一路。）
//
// 用法：node scripts/capture-schedule.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'site/data/schedule.json');

const { MEMBER } = await import(resolve(ROOT, 'scraper/lib/config.mjs'));
const { fetchOpenLivePage } = await import(resolve(ROOT, 'scraper/lib/api.mjs'));

const teamsOf = (it) => (it.teamList || []).map((t) => t.teamName).filter(Boolean);
// 她本人所在队；全团联合公演（teamList 含 TEAM NIII）也计入
const isHers = (it) => teamsOf(it).includes(MEMBER.team);

async function main() {
  const { list } = await fetchOpenLivePage({ groupId: MEMBER.groupId, next: 0, record: false });
  const store = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { shows: {} };
  store.shows ||= {};

  let added = 0, updated = 0;
  const seen = [];
  for (const it of list) {
    if (!isHers(it)) continue;
    const key = String(it.liveId);
    const rec = {
      liveId: key,
      name: it.subTitle || it.title || '',
      stime: String(it.stime || ''),
      date: it.stime ? new Date(Number(it.stime) + 8 * 3600 * 1000).toISOString().slice(0, 10) : '',
      time: it.stime ? new Date(Number(it.stime) + 8 * 3600 * 1000).toISOString().slice(11, 16) : '',
      teams: teamsOf(it),
      status: it.status,
      coverPath: it.coverPath || '',
      lastSeenAt: new Date().toISOString()
    };
    const prev = store.shows[key];
    if (!prev) { store.shows[key] = { ...rec, firstSeenAt: rec.lastSeenAt }; added++; }
    else { store.shows[key] = { ...prev, ...rec }; updated++; }
    seen.push(`${rec.date} ${rec.time} ${rec.name}`);
  }

  store.updatedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(store, null, 2));

  console.log(`[排期] 本次窗口 ${list.length} 条，其中她的 ${seen.length} 条（新增 ${added} / 更新 ${updated}）`);
  for (const s of seen) console.log('   ', s);
  console.log(`[排期] 累计已记录 ${Object.keys(store.shows).length} 个场次 → ${OUT}`);
}

main().catch((e) => { console.error('capture-schedule 失败：', e.message); process.exit(1); });
