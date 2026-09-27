/**
 * 分钟级推送探针（GitHub Actions 版，2026-09-27）
 *
 * 为什么它要跑在 GitHub Actions 上，而不是 Cloudflare Worker 里：
 *   🔴 实测 **从 Cloudflare 出去请求 pocketapi.48.cn 一律 nginx 403**（数据中心 IP 被口袋网关挡了）。
 *      A/B 对照：把 Worker 里算出的 pa 签名拿到本机用同一个签名请求 → **200 成功**，
 *      ⇒ 签名没问题，就是 CF 的出口 IP 不通。而 GitHub Actions 这条路抓了几个月一直正常
 *      （必要时还能走家里代理），所以「每分钟问一次口袋」这件活交给它。
 *
 * 工作方式：
 *   每 60 秒问一次口袋「最新 5 条发言」→ 发现新的 → POST 本站 /api/push/notify
 *   → Worker 侧比对游标 + 新鲜度闸后广播（去重、防旧内容都在 Worker 侧兜底）。
 *   本脚本**不写库**：档案数据仍由 scrape.yml 那 5 分钟一轮的正路负责。
 *
 * 首轮只记游标不推送（避免刚启动就把历史发言推一遍）。
 */
import { fetchMessagePage, fetchLiveListPage, fetchNewestLiveId } from './lib/api.mjs';
import { MEMBER, POCKET48_TOKEN } from './lib/config.mjs';
import { parseMessage } from './lib/message.mjs';

const WORKER = (process.env.WORKER_URL || 'https://idol.wyc0518.cc').replace(/\/+$/, '');
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';
const RUN_MS = Number(process.env.WATCH_SECONDS || 330) * 1000;
const INTERVAL_MS = Number(process.env.WATCH_INTERVAL || 60) * 1000;
const FRESH_MS = Number(process.env.WATCH_FRESH_MIN || 10) * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 推送文案：只取她自己说的话（粉丝的提问/昵称一个字都不往推送里塞） */
function msgText(raw) {
  let p = null;
  try { p = parseMessage(raw); } catch (_) { p = null; }
  if (p) {
    const t = String(p.text || '').replace(/\s+/g, ' ').trim();
    if (t) return t.length > 60 ? t.slice(0, 60) + '…' : t;
    if (p.images && p.images.length) return '［图 ' + p.images.length + ' 张］';
    if (p.video) return '［视频］';
    if (p.audio) return '［语音］';
    if (p.card && p.card.title) return String(p.card.title).slice(0, 40);
  }
  const type = String((raw && raw.msgType) || '');
  if (/IMAGE|PIC/i.test(type)) return '［图］';
  if (/AUDIO|VOICE/i.test(type)) return '［语音］';
  if (/VIDEO/i.test(type)) return '［视频］';
  if (/FLIPCARD|REPLY|GIFTREPLY/i.test(type)) return '［翻牌］';
  return '［新消息］';
}

// 鉴权：Actions 里有 SYNC_TOKEN；本机试跑时没有它，就用 GH_TOKEN 走另一条校验（x-gh-token）
const GH_TOKEN = process.env.GH_TOKEN || '';

async function notify(t, text, mt) {
  if (!SYNC_TOKEN && !GH_TOKEN) { console.log('[跳过] 没有 SYNC_TOKEN / GH_TOKEN，无法调用推送接口'); return; }
  const headers = { 'Content-Type': 'application/json' };
  if (SYNC_TOKEN) headers['x-sync-token'] = SYNC_TOKEN;
  if (GH_TOKEN) headers['x-gh-token'] = GH_TOKEN;
  try {
    const r = await fetch(WORKER + '/api/push/notify', {
      method: 'POST',
      headers,
      body: JSON.stringify({ t, text, mt: String(mt || '') })
    });
    const body = await r.text();
    console.log(`[notify] t=${t} http=${r.status} ${body.slice(0, 160)}`);
  } catch (e) {
    console.warn('[notify] 失败：' + String((e && e.message) || e).slice(0, 120));
  }
}

let lastSeen = 0;

/** 通知 Worker：开播（type=live，走单独的开播游标/去重） */
async function notifyLive(id, t, title) {
  if (!SYNC_TOKEN && !GH_TOKEN) { console.log('[跳过] 没有凭据，无法调用推送接口'); return; }
  const headers = { 'Content-Type': 'application/json' };
  if (SYNC_TOKEN) headers['x-sync-token'] = SYNC_TOKEN;
  if (GH_TOKEN) headers['x-gh-token'] = GH_TOKEN;
  try {
    const r = await fetch(WORKER + '/api/push/notify', {
      method: 'POST', headers,
      body: JSON.stringify({ type: 'live', id: String(id), t: Number(t) || 0, text: title })
    });
    console.log('[notify-live] http=' + r.status + ' ' + (await r.text()).slice(0, 160));
  } catch (e) {
    console.warn('[notify-live] 失败：' + String((e && e.message) || e).slice(0, 120));
  }
}

/* ---------------- 开播盯梢 ----------------
 * 🔴 为什么必须单独查「正在进行的直播」：
 *   站内档案里的直播列表是 **record=true 的录播归档**，要等她下播才出现。
 *   以前「开播推送」读的就是那份 ⇒ 她开播时永远推不出来（2026-09-27 站长亲历：她 22:48 开播，站内毫无动静）。
 *   record=false 才是「直播中/刚结束」的列表（status=2），这里每轮顺带看一眼。
 */
let liveNext = '0';
let lastLiveId = '';
let lastLiveAt = 0;

async function checkLive() {
  try {
    if (liveNext === '0') liveNext = (await fetchNewestLiveId({ groupId: MEMBER.groupId, record: true })) || '0';
    const { list } = await fetchLiveListPage({ userId: MEMBER.userId, next: liveNext, record: false });
    if (!list.length) return;
    // 取「最新的那场」（列表顺序不保证按时间，自己比一遍）
    let top = null;
    for (const x of list) {
      if (!x || !x.liveId) continue;
      if (!top || Number(x.ctime) > Number(top.ctime || 0)) top = x;
    }
    if (!top) return;
    if (Number(top.status) !== 2) return;                       // 2 = 直播中（3 = 已转录播）
    if (String(top.liveId) === String(lastLiveId)) return;      // 这场已经报过了
    // 🔴 单调闸：只报「比已报过那场更新」的。她关了重开时列表顺序会变，
    //    旧场次会重新冒出来 ⇒ 换进程后容易把一小时前那场又推一遍（站长明确不要旧内容）。
    if (lastLiveAt && Number(top.ctime) <= lastLiveAt) return;
    lastLiveId = String(top.liveId);
    if (Number(top.ctime) > lastLiveAt) lastLiveAt = Number(top.ctime);
    const title = String(top.title || top.announcement || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    console.log('[开播] ' + new Date(Number(top.ctime) + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' ' + (title || '（无标题）'));
    await notifyLive(top.liveId, Number(top.ctime), title || '点开看直播');
  } catch (e) {
    console.warn('[开播] 检查失败：' + String((e && e.message) || e).slice(0, 120));
  }
}

/**
 * 启动时先问 Worker「上次推到哪了」，从那儿接着跑。
 * 🔴 为什么要这个：值守是「一段段」跑的（CF 每 5 分钟拉起一次，GitHub schedule 又不靠谱），
 *    每段都是全新进程。若每段都把游标设成「当前最新」，**段与段之间的空档期发的言就永远漏推**。
 *    从 Worker 的游标接着走 ⇒ 换多少次进程都不漏、也不重（重了还有 D1 哨兵兜底）。
 */
async function fetchCursor() {
  try {
    const h = {};
    if (SYNC_TOKEN) h['x-sync-token'] = SYNC_TOKEN;
    if (GH_TOKEN) h['x-gh-token'] = GH_TOKEN;
    const r = await fetch(WORKER + '/api/push/probe', { headers: h });
    const j = await r.json();
    // 开播游标也一起接续（否则换进程后会把上一场在播的直播再报一遍）
    lastLiveAt = Number(j && j.lastLiveAt) || 0;
    return Number(j && j.cursor) || 0;
  } catch (_) { return 0; }
}

async function tick(first) {
  const { messages } = await fetchMessagePage({
    serverId: MEMBER.serverId,
    channelId: MEMBER.channelId,
    nextTime: 0,
    limit: 5,
    token: POCKET48_TOKEN
  });
  const list = (messages || [])
    .map((m) => ({ t: Number(m.msgTime) || 0, raw: m }))
    .filter((x) => x.t > 0)
    .sort((a, b) => a.t - b.t);
  const newest = list.length ? list[list.length - 1].t : 0;
  if (!newest) { console.log('[tick] 没拿到发言'); return; }
  if (first) {
    // 首轮：只把游标定好，绝不把历史发言推一遍。
    // 游标优先用 Worker 那份（跨进程接着跑，不漏也不重）；拿不到才退化为「当前最新」。
    if (!lastSeen) lastSeen = newest;
    console.log('[首轮] 游标设为 ' + new Date(lastSeen + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) +
      '（北京时间）' + (lastSeen === newest ? '＝当前最新' : '＝沿用 Worker 游标') + '，之后只推新的');
    return;
  }
  const fresh = list.filter((x) => x.t > lastSeen);
  if (!fresh.length) return;
  for (const f of fresh) {
    // 🔴 时间戳合理性：未来值（曾出现 1799999999999 这种）一律丢弃，也不许拿来推游标
    if (f.t > Date.now() + 2 * 60 * 1000) continue;
    lastSeen = Math.max(lastSeen, f.t);
    const mt = String((f.raw && f.raw.msgType) || '').toUpperCase();
    // 🔴 口袋每开一场直播会自动发一条 LIVEPUSH 系统提示，跟开播通知是同一件事
    //    ⇒ 再推一遍就是重复打扰（她一晚连开几十场 ⇒ 几十条）。开播走 type=live 那条路。
    if (mt === 'LIVEPUSH') { console.log('[跳过] 开播提示（开播通知已覆盖）'); continue; }
    if (Date.now() - f.t > FRESH_MS) {
      console.log('[跳过] 太旧：' + new Date(f.t + 8 * 3600e3).toISOString().slice(0, 19));
      continue;
    }
    console.log('[新发言] ' + new Date(f.t + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' ' + msgText(f.raw));
    await notify(f.t, msgText(f.raw), mt);
  }
}

async function main() {
  if (!POCKET48_TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }
  console.log(`开始值守：约 ${Math.round(RUN_MS / 1000)} 秒，每 ${Math.round(INTERVAL_MS / 1000)} 秒问一次口袋`);
  // 从 Worker 上次推到的位置接着跑（拿不到就是 0，首轮会退化成「当前最新」）
  lastSeen = await fetchCursor();
  if (lastSeen) console.log('[接续] Worker 游标：' + new Date(lastSeen + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19));
  const t0 = Date.now();
  let first = true;
  let n = 0;
  while (Date.now() - t0 < RUN_MS) {
    try {
      await tick(first);
    } catch (e) {
      console.warn('[tick] 失败：' + String((e && e.message) || e).slice(0, 140));
    }
    // 顺带看一眼她是不是在直播（开播 1 分钟内推送）
    try { await checkLive(); } catch (e) { console.warn('[开播] 异常：' + String((e && e.message) || e).slice(0, 100)); }
    first = false;
    n += 1;
    await sleep(INTERVAL_MS);
  }
  console.log(`值守结束，共 ${n} 轮`);
}

main();
