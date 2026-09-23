/*
 * 从每场直播的弹幕 LRC 里提取「礼物播报」—— 2026-09-23 重大发现。
 *
 * 背景：站长给的 msg48.org 截图里有一行 `04:05 tenaimedo 送给SNH48-刘雨昕 1个瓶装玳花`。
 * 实测 source.48.cn 的 LRC **确实含系统礼物播报**，格式：
 *     [mm:ss.mmm]昵称\t送给<成员全名> N个<礼物名>
 * 之前误判「弹幕没有礼物」是因为 grep 关键词写成了「礼物|送出|打赏」，而官方文案是「送给」。
 *
 * 用法：
 *   env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
 *     node scripts/build-live-gifts.mjs --limit 40        # 采样
 *   ... --all                                            # 全量 787 场（约 17 分钟）
 *
 * 产物：
 *   .cache/live-gifts.jsonl        每行一条礼物事件
 *   .cache/live-gifts-progress.json 断点（已扫过的 liveId）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = await import(ROOT + '/scraper/lib/api.mjs');
const { POCKET48_TOKEN: TOKEN } = await import(ROOT + '/scraper/lib/config.mjs');

const ARG = process.argv.slice(2);
const LIMIT = ARG.includes('--all') ? Infinity
  : (ARG.includes('--limit') ? Number(ARG[ARG.indexOf('--limit') + 1]) : 40);

const OUT = ROOT + '/.cache/live-gifts.jsonl';
const PROG = ROOT + '/.cache/live-gifts-progress.json';

/* 直播场次：site/data/live.json */
const liveRaw = JSON.parse(fs.readFileSync(ROOT + '/site/data/live.json', 'utf8'));
const lives = (Array.isArray(liveRaw) ? liveRaw : (liveRaw.live || liveRaw.list || []))
  .filter((x) => x && x.liveId)
  .sort((a, b) => Number(b.ctime || 0) - Number(a.ctime || 0)); // 新的先跑

const done = fs.existsSync(PROG) ? new Set(JSON.parse(fs.readFileSync(PROG, 'utf8'))) : new Set();
const todo = lives.filter((x) => !done.has(x.liveId)).slice(0, LIMIT);

console.log(`总场次 ${lives.length} | 已完成 ${done.size} | 本次待跑 ${todo.length}\n`);

/* 礼物行： [00:04:05.600]tenaimedo\t送给GNZ48-刘思雨 1个瓶装桂花 */
const RE_GIFT = /^\[(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\]\s*(.+?)\t\s*送给\s*(.+?)\s+(\d+)\s*个\s*(.+?)\s*$/;

const results = [];
let scanned = 0, withAny = 0, giftLines = 0, lrcMissing = 0, noChange = 0;

for (const lv of todo) {
  const liveId = lv.liveId;
  let url = null;
  try {
    const d = await A.postJson('/live/api/v1/live/getLiveOne', { liveId }, { retries: 1, token: TOKEN });
    url = d?.content?.msgFilePath || null;
  } catch { /* 单场失败不中断 */ }

  if (!url) { lrcMissing++; done.add(liveId); continue; }

  let text = '';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    text = await res.text();
  } catch { lrcMissing++; done.add(liveId); continue; }

  const lines = text.split('\n').filter(Boolean);
  const before = giftLines;
  for (const line of lines) {
    const m = line.match(RE_GIFT);
    if (!m) continue;
    const [, time, nick, target, num, gift] = m;
    results.push({ liveId, ct: Number(lv.ctime || 0), time, nick: nick.trim(), target: target.trim(), num: Number(num), gift: gift.trim() });
    giftLines++;
  }
  if (giftLines > before) withAny++;
  else if (lines.length) noChange++;

  scanned++;
  done.add(liveId);
  if (scanned % 20 === 0) console.log(`  …已扫 ${scanned}/${todo.length}，累计礼物 ${giftLines} 条`);
}

/* 落盘 */
if (results.length) fs.appendFileSync(OUT, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(PROG, JSON.stringify([...done]));

/* 汇总 */
console.log(`\n══ 本次结果 ══`);
console.log(`扫描场次 ${scanned} | 有礼物场次 ${withAny} | 礼物条目 ${giftLines} | 无弹幕文件 ${lrcMissing} | 无礼物场次 ${noChange}`);
if (results.length) {
  const byNick = new Map(), byGift = new Map();
  for (const r of results) {
    byNick.set(r.nick, (byNick.get(r.nick) || 0) + r.num);
    byGift.set(r.gift, (byGift.get(r.gift) || 0) + r.num);
  }
  console.log(`\n送礼人数（唯一昵称）${byNick.size} | 礼物种类 ${byGift.size}`);
  console.log('\n── 送礼最多 Top10（按件数）──');
  [...byNick.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .forEach(([n, c]) => console.log(`  ${String(c).padStart(4)} 件  ${n}`));
  console.log('\n── 礼物种类分布 ──');
  [...byGift.entries()].sort((a, b) => b[1] - a[1])
    .forEach(([g, c]) => console.log(`  ${String(c).padStart(4)} 件  ${g}`));
}
