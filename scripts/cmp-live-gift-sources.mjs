/*
 * 交叉验证：同一场直播里，「官方 Top20 榜」与「弹幕 LRC 提取」两份数据是否吻合。
 * 用来判断「弹幕礼物播报」是否完整（如果每场都系统性偏少，说明播报只覆盖部分礼物）。
 *
 * 用法：
 *   env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy node scripts/cmp-live-gift-sources.mjs --n 3
 *   ... --detail            # 打印逐场逐人明细
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = await import(ROOT + '/scraper/lib/api.mjs');

const ARG = process.argv.slice(2);
const N = ARG.includes('--n') ? Number(ARG[ARG.indexOf('--n') + 1]) : 3;
const DETAIL = ARG.includes('--detail');

const readJsonl = (p) => (!fs.existsSync(p) ? [] : fs.readFileSync(p, 'utf8').trim().split('\n')
  .map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean));

/* 价目 */
const gp = JSON.parse(fs.readFileSync(ROOT + '/data/gift-prices.json', 'utf8'));
const manual = gp.prices || {};
const exclude = new Set(gp._excludeNames || []);
let offi = [];
try { const d = await A.postJson('/gift/api/v1/gift/list', {}, { retries: 1 }); offi = (d.content || []).flatMap((t) => t.giftList || []); } catch {}
const priceOf = (n) => { const g = offi.find((x) => x.giftName === n) || offi.find((x) => x.giftName && n.startsWith(x.giftName)); return g ? g.money : (manual[n] ?? null); };

const rank = readJsonl(ROOT + '/.cache/fans/live.jsonl');
const gifts = readJsonl(ROOT + '/.cache/live-gifts.jsonl');
const live = JSON.parse(fs.readFileSync(ROOT + '/site/data/live.json', 'utf8'));
const arr = (Array.isArray(live) ? live : live.live || []);
const ctById = new Map(arr.map((x) => [String(x.liveId), Number(x.ctime || 0)]));

const byLive = new Map();
for (const r of rank) { const k = String(r.liveId); if (!byLive.has(k)) byLive.set(k, []); byLive.get(k).push(r); }
const giftByLive = new Map();
for (const g of gifts) { const k = String(g.liveId); if (!giftByLive.has(k)) giftByLive.set(k, []); giftByLive.get(k).push(g); }

const cands = [...byLive.entries()]
  .map(([id, rs]) => ({ id, ct: ctById.get(id) || 0, rs }))
  .filter((x) => x.rs.length >= 15)
  .sort((a, b) => b.ct - a.ct)
  .slice(0, N);

console.log('══ 同一场：官方 Top20 榜 vs 弹幕 LRC 提取 ══\n');
let sumRank = 0, sumDm = 0, totNotice = 0, totHit = 0;
for (const c of cands) {
  const gl = giftByLive.get(c.id) || [];
  const dmByName = new Map();
  for (const g of gl) {
    if (exclude.has(g.gift)) continue;
    const p = priceOf(g.gift); if (p == null) continue;
    dmByName.set(g.nick, (dmByName.get(g.nick) || 0) + p * g.num);
  }
  const rankByName = new Map();
  for (const r of c.rs) rankByName.set(r.nick, Number(r.m || 0));

  let a = 0, b = 0, hit = 0, miss = 0, over = 0;
  for (const [n, m] of rankByName) { a += m; const dm = dmByName.get(n) || 0; if (dm > 0) { hit++; b += dm; if (dm > m) over++; } else miss++; }
  sumRank += a; sumDm += b; totHit += hit; totNotice += rankByName.size;

  console.log(`── ${new Date(c.ct).toISOString().slice(0, 16).replace('T', ' ')}  Top20 ${c.rs.length}人 合计 ${a.toLocaleString()} | 弹幕 ${gl.length}条`);
  console.log(`   昵称命中 ${hit}/${rankByName.size}（${(hit / rankByName.size * 100).toFixed(0)}%） | 金额 ${b.toLocaleString()}/${a.toLocaleString()}（${(b / a * 100).toFixed(1)}%）| 超出 ${over} 人`);
  if (DETAIL) {
    [...rankByName.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).forEach(([n, m]) => {
      const dm = dmByName.get(n) || 0;
      console.log(`     ${n.slice(0, 22).padEnd(24)} 榜 ${String(m).padStart(8)}  弹幕 ${String(dm).padStart(8)}  ${dm > m ? '✅偏多' : dm === m ? '✅一致' : dm > 0 ? '⚠️偏少' : '❌无'}`);
    });
  }
}
console.log(`\n合计 ${cands.length} 场：Top20榜 ${sumRank.toLocaleString()} 鸡腿 | 弹幕同源 ${sumDm.toLocaleString()}（${(sumDm / sumRank * 100).toFixed(1)}%）`);
console.log(`昵称命中率 ${totHit}/${totNotice} = ${(totHit / totNotice * 100).toFixed(1)}%`);
console.log(`\n判读：命中率高 = 弹幕播报没漏人；金额占比低 = 每人送的礼物里有一部分没播报（多半是小額/连击合并）。`);
