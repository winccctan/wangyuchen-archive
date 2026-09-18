// 口袋发言 · 历史深度补抓
//
// 接口行为（实测）：/im/api/v1/team/message/list/homeowner 的 nextTime 语义 ≈
//   「返回该时间之前约 7 天窗口内的最多 50 条消息」。
// 因此遇到「消息空档」时页链会直接断（空页 / nextTime=0），无法一口气从最新翻到最早。
//
// 策略（锚点跳转 + 段内顺序翻页 + 空档回退）：
//   1) 段内：从锚点 nextTime 顺序往回翻，用返回的 nextTime 续翻，直到链断，得到一个连续段；
//   2) 空档：把锚点往前挪 3 天（< ~7 天窗口，保证不遗漏）再试，直到重新命中数据；
//   3) 重复，直到到达 TARGET_START 或请求数达上限。
//
// 用法：node scripts/backfill-messages.mjs
// 环境变量：TARGET_START=2022-10-01  SEG_PAGES=1500  MAX_REQ=5000
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fetchMessagePage } from '../scraper/lib/api.mjs';
import { parseMessage } from '../scraper/lib/message.mjs';
import { MEMBER, POCKET48_TOKEN } from '../scraper/lib/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, '../site/data/messages.json');

const TARGET_START = Date.parse((process.env.TARGET_START || '2022-10-01') + 'T00:00:00+08:00');
const SEG_PAGES = Number(process.env.SEG_PAGES || 1500);
const MAX_REQ = Number(process.env.MAX_REQ || 5000);
const STEP = 3 * 86400000; // 空档回退步长 3 天（< ~7 天窗口）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const d = (t) => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '-');

if (!POCKET48_TOKEN) { console.error('缺少 POCKET48_TOKEN（scraper/.env）'); process.exit(1); }

const existing = JSON.parse(readFileSync(DATA, 'utf8')).messages || [];
const known = new Set(existing.map((m) => m.msgIdServer));
const merged = new Map(existing.map((m) => [m.msgIdServer, m]));
let frontier = Math.min(...existing.map((m) => Number(m.msgTime) || Infinity));
if (!Number.isFinite(frontier)) frontier = Date.now();
let addedTotal = 0, reqs = 0, seg = 0;

const page = (nextTime) => {
  reqs++;
  return fetchMessagePage({ serverId: MEMBER.serverId, channelId: MEMBER.channelId, nextTime, limit: 700, token: POCKET48_TOKEN });
};

console.log(`现有 ${existing.length} 条，最早 ${d(frontier)}；目标回溯到 ${d(TARGET_START)}`);

let anchor = frontier - 1;
let step = STEP;

while (anchor > TARGET_START && reqs < MAX_REQ) {
  seg++;
  let r;
  try { r = await page(anchor); }
  catch (e) { console.log(`[段${seg}] 锚点 ${d(anchor)} 请求失败：${e.message}`); anchor -= step; continue; }

  if (!r.messages.length) { // 空档：往回挪 3 天
    anchor -= step;
    continue;
  }

  // 命中数据 → 以此为一整段的起点，顺序往回翻到链断
  let segMin = Infinity, segAdd = 0, pages = 0;
  const consume = (ms) => {
    for (const raw of ms) {
      const t = Number(raw.msgTime);
      if (t && t < segMin) segMin = t;
      if (known.has(raw.msgIdServer)) continue;
      known.add(raw.msgIdServer);
      merged.set(raw.msgIdServer, parseMessage(raw));
      segAdd++;
    }
  };
  consume(r.messages); pages++;
  let nextTime = r.nextTime;
  while (nextTime && pages < SEG_PAGES && reqs < MAX_REQ) {
    let rr;
    try { rr = await page(nextTime); } catch (e) { console.log(`  段内请求失败：${e.message}`); break; }
    if (!rr.messages.length) break;
    consume(rr.messages); pages++;
    if (!rr.nextTime) break;
    nextTime = rr.nextTime;
    await sleep(120);
  }

  if (!Number.isFinite(segMin) || segMin >= frontier) {
    // 无进展：继续回退，防死循环
    anchor -= step;
    continue;
  }
  addedTotal += segAdd;
  frontier = segMin;
  anchor = segMin - 1;
  step = STEP;
  console.log(`[段${seg}] 翻 ${pages} 页 → 最早 ${d(segMin)}；段内新增 ${segAdd}，总 ${merged.size}，请求 ${reqs}`);
}

const list = [...merged.values()].sort((a, b) => b.msgTime - a.msgTime);
if (existsSync(DATA)) copyFileSync(DATA, DATA + '.bak');
writeFileSync(DATA, JSON.stringify({ messages: list }, null, 2));
const finalOldest = Math.min(...list.map((m) => Number(m.msgTime) || Infinity));
console.log(`\n✓ 完成：本次新增 ${addedTotal}，总数 ${list.length}，最早 ${d(finalOldest)}，请求 ${reqs}`);
