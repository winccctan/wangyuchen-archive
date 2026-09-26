// 王语晨补档站 - 抓取主程序
// 用法：在 scraper 目录下，先设置 token，然后 node scrape.mjs
//   POCKET48_TOKEN=xxxx node scrape.mjs
// 说明：
//   - 口袋发言 需要 token（且依赖 wasm 生成 pa 签名）
//   - 直播 / 公演 无需 token（按成员 / 团体筛选）
// 输出写入 ../site/data/{messages,live,performances,meta}.json
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MEMBER, POCKET48_TOKEN, MAX_PAGES, API_BASE } from './lib/config.mjs';
import {
  fetchMessagePage,
  fetchLiveListPage,
  fetchOpenLivePage,
  fetchLiveOne,
  fetchOpenLiveOne
} from './lib/api.mjs';
// 消息解析统一走 lib/message.mjs（按 msgType 精确提取正文 / 引用 / 媒体 / 卡片）
import { parseMessage } from './lib/message.mjs';
// 上线前身份脱敏（红线：第三方 uid / 头像 / 等级不得出现在任何线上数据里）
import { scrubMessages } from './lib/scrub.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '../site/data');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function loadJson(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function saveJson(p, obj) {
  await writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
}

/* ----------------------- 抓取：口袋发言 ----------------------- */
async function scrapeMessages() {
  if (!POCKET48_TOKEN) {
    console.warn('[跳过] 口袋发言：未设置 POCKET48_TOKEN，跳过（直播/公演不受影响）');
    return null;
  }
  const existing = (await loadJson(resolve(DATA_DIR, 'messages.json')))?.messages || [];
  const known = new Set(existing.map((m) => m.msgIdServer));

  // 常规增量：从最新往回翻（取最新几页即可）。
  // BACKFILL=1：从「现有最早一条」继续往回翻，用于补齐历史 —— 避免白翻已有页面（每页仅 50 条）。
  let nextTime = 0;
  if (process.env.BACKFILL === '1' && existing.length) {
    const oldestKnown = Math.min(...existing.map((m) => Number(m.msgTime) || Infinity));
    if (Number.isFinite(oldestKnown)) nextTime = oldestKnown + 1;
  }
  const merged = new Map(existing.map((m) => [m.msgIdServer, m]));
  let pages = 0;
  let total = existing.length;
  let oldestTs = Infinity;

  console.log('[抓取] 口袋发言 ...');
  while (pages < MAX_PAGES) {
    const { messages, nextTime: nt } = await fetchMessagePage({
      serverId: MEMBER.serverId,
      channelId: MEMBER.channelId,
      nextTime,
      limit: 700,
      token: POCKET48_TOKEN
    });
    if (!messages.length) break;
    let added = 0;
    for (const raw of messages) {
      const t = Number(raw.msgTime);
      if (t && t < oldestTs) oldestTs = t;
      if (known.has(raw.msgIdServer)) continue;
      known.add(raw.msgIdServer);
      merged.set(raw.msgIdServer, parseMessage(raw));
      added++;
    }
    total += added;
    pages++;
    if (pages === 1 || pages % 20 === 0) {
      console.log(`  [发言] 第 ${pages} 页，本页 ${messages.length} 条，累计 ${total} 条，最早 ${oldestTs < Infinity ? new Date(oldestTs).toISOString().slice(0, 10) : '-'}`);
    }
    if (!nt || nt === 0) break;
    nextTime = nt;
    await sleep(300);
  }
  const list = [...merged.values()].sort((a, b) => b.msgTime - a.msgTime);
  console.log(`[完成] 口袋发言：共 ${list.length} 条（本次新增 ${total - existing.length >= 0 ? list.length - existing.length : 0}）`);
  return list;
}

/* ----------------------- 抓取：直播 / 录播（按成员） ----------------------- */
async function scrapeLiveByMember(record) {
  const all = new Map();
  let next = '0';
  // 起点：next=0 时服务端会忽略 userId（返回全团），所以先取全团最新一条的 liveId 作为 next。
  // 直播 / 录播两种模式都要播种（此前只对「直播」播种，导致录播退化成翻全团列表）。
  const first = await fetchLiveListPage({ groupId: MEMBER.groupId, next: '0', record });
  const top = first.list[0];
  if (top) {
    next = top.liveId;
    // 起点那条若正好是她本人的，别漏掉
    if (String(top.userInfo?.userId) === String(MEMBER.userId)) all.set(top.liveId, top);
  }
  let pages = 0;
  let oldest = Infinity;   // 本页最早的时间（只返回她本人时，即她的回溯进度）
  let scanned = 0;         // 已扫条目数
  while (pages < MAX_PAGES) {
    // 注意：按成员查询时只传 userId、不带 groupId，服务端才会只返回她本人
    const { list, next: nx } = await fetchLiveListPage({
      groupId: MEMBER.groupId,
      userId: MEMBER.userId,
      next,
      record
    });
    if (!list.length) break;
    for (const it of list) {
      const t = Number(it.ctime) || 0;
      if (t && t < oldest) oldest = t;
      scanned++;
      if (String(it.userInfo?.userId) === String(MEMBER.userId)) all.set(it.liveId, it);
    }
    if (!nx || nx === '0') break;
    next = nx;
    pages++;
    if (pages % 10 === 0) {
      const d = Number.isFinite(oldest) ? new Date(oldest).toISOString().slice(0, 10) : '-';
      console.log(`  [直播] record=${record} 第 ${pages} 页（共 ${scanned} 条，回溯至 ${d}），她本人 ${all.size} 条`);
    }
    await sleep(300);
  }
  return [...all.values()];
}

/* ----------------------- 当前「直播中」集合（用于直播结束判定） -----------------------
 * 背景（已实测）：口袋48 的直播结束后，若官方未生成回放，该条目会从「直播中」和「录播」
 * 两个列表同时消失，抓取端再也拿不到这个 liveId 的新状态 —— 本地 status 会永远停在
 * 2（直播中），前端于是一直显示「直播中 / 无视频」。
 * 这里改从「谁还在播」反推：record=false 的列表接口**不按 userId 过滤**（实测传了 userId
 * 也返回全团正在直播），正好用来取当前全团直播中的 liveId 集合。 */
async function fetchLiveNowIds() {
  const ids = new Set();
  let next = '0';
  for (let p = 0; p < 5; p++) {
    const r = await fetchLiveListPage({ groupId: MEMBER.groupId, next, record: false });
    const list = r.list || [];
    if (!list.length) break;
    for (const it of list) {
      if (Number(it.status) === 2) ids.add(String(it.liveId));
    }
    if (!r.next || r.next === '0') break;
    next = r.next;
    await sleep(200);
  }
  return ids;
}

/* ----------------------- 抓取：公演（只保留王语晨所在队伍 TEAM NIII） ----------------------- */
function isHerTeam(item) {
  const teams = item.teamList || [];
  return teams.some((t) => t.teamName === MEMBER.team || String(t.teamId) === String(MEMBER.teamId));
}

async function scrapePerformances(record) {
  const all = new Map();
  let next = 0;
  let pages = 0;
  while (pages < MAX_PAGES) {
    const { list, next: nx } = await fetchOpenLivePage({ groupId: MEMBER.groupId, next, record });
    if (!list.length) break;
    for (const it of list) {
      if (isHerTeam(it)) all.set(it.liveId, it);
    }
    if (!nx || nx === 0) break;
    next = nx;
    pages++;
    await sleep(300);
  }
  return [...all.values()];
}

/* ----------------------- 补充播放地址（直播/公演 => m3u8） -----------------------
 * 口袋48 的列表接口不含视频地址，需对每个 liveId 调详情接口：
 *   直播：getLiveOne           -> content.playStreamPath
 *   公演：getOpenLiveOne       -> content.playStreams[].streamPath
 * 视频 CDN（idol-vod.48.cn / perform-vod.48.cn）全球可直连且带 CORS:*，
 * 因此把地址存进数据后，前端用 hls.js 即可直接播放（境外浏览器也能看）。
 */
function pickBestStream(streams) {
  if (!streams || !streams.length) return '';
  // 优先「高清」，其次任意一个
  const hd = streams.find((s) => /高清|hd|fhd|蓝光|超清/i.test(s.name || ''));
  return (hd || streams[0]).path || '';
}

// 官方回放 CDN 域名（VOD）。旧地址若是它，说明已经是「已结束后的回放地址」，可直接复用。
// 注意：口袋48 的 VOD 域名有多个前缀（实测：idol-vod / cychengyuan-vod / perform-vod），
// 统一按 `-vod.48.cn` 匹配，切勿只写死某几个前缀（曾因漏掉 cychengyuan-vod 导致 527 条被反复重抓）。
const isVodUrl = (u) => /vod\.48\.cn/i.test(String(u || ''));

async function attachPlayUrls(list, type, existingMap) {
  let n = 0;
  for (const it of list) {
    const prev = existingMap.get(it.liveId);
    const ended = Number(it.status) === 3;
    // 复用策略（重要）：已结束的条目若旧值已是 VOD 回放地址，直接复用 ——
    // 否则每轮都要对上百条已结束条目重新请求（700+ 次），既慢又容易被限流，
    // 且个别条目偶发失败后永远补不上（表现为前端「无视频」）。
    // 只有「缺地址」或「旧地址非 VOD（可能是失效的直播流）」时才重新请求。
    // ⚠️ 旧值是 rtmp:// 时必须重取：那是「直播进行中」抓到的拉流地址，浏览器播不了。
    // 只要该条 status 一直停在 2（直播中），下面 !ended 分支就会一直复用它 → 回放永远补不上
    // （2026-09-19 那场就是如此：官方回放早已生成，站点却仍存着 rtmp，点开必「播放失败」）。
    const prevUrl = prev?.playUrl || '';
    if (/^https?:/i.test(prevUrl) && (isVodUrl(prevUrl) || !ended)) {
      it.playUrl = prevUrl;
      continue;
    }
    // 请求回放 / 直播地址；空结果或异常都重试几次（偶发限流、网络抖动时常返回空）。
    let got = '';
    for (let attempt = 0; attempt < 3 && !got; attempt++) {
      try {
        if (type === 'live') {
          const r = await fetchLiveOne(it.liveId);
          got = r.playStreamPath || '';
        } else {
          const r = await fetchOpenLiveOne(it.liveId, POCKET48_TOKEN || undefined);
          got = pickBestStream(r.streams) || '';
        }
      } catch { /* 下轮重试 */ }
      if (!got) await sleep(500);
    }
    // 拿不到则退回旧值（不破坏已有数据）；旧值也没有就留空（前端显示「无回放 / 无视频」）。
    it.playUrl = got || prev?.playUrl || '';
    if (got) n++;
    await sleep(150);
  }
  return n;
}

/* ----------------------- 主流程 ----------------------- */
async function safe(label, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error(`[失败] ${label}：${e.message}`);
    return null;
  }
}

async function run() {
  await ensureDir(DATA_DIR);

  const skipMessages = process.env.SKIP_MESSAGES === '1';
  const messages = skipMessages ? null : await safe('口袋发言', scrapeMessages);
  if (skipMessages) console.log('[跳过] 口袋发言（SKIP_MESSAGES=1）');

  const skipLive = process.env.SKIP_LIVE === '1';
  let liveOk = false;
  let liveList = [];
  if (skipLive) {
    console.log('[跳过] 直播 / 录播（SKIP_LIVE=1）');
  } else {
    console.log('[抓取] 直播（直播中）...');
    const liveNow = await safe('直播-直播中', () => scrapeLiveByMember(false));
    console.log('[抓取] 直播（录播）...');
    const liveRec = await safe('直播-录播', () => scrapeLiveByMember(true));
    liveOk = liveNow !== null || liveRec !== null;
    const liveFresh = [...(liveNow || []), ...(liveRec || [])]
      .filter((v, i, a) => a.findIndex((x) => x.liveId === v.liveId) === i)
      .sort((a, b) => Number(b.ctime || 0) - Number(a.ctime || 0));
    // 关键：与已有数据合并。翻页上限（MAX_PAGES）较小时本次只拿到最新几页，
    // 若不合并会把历史直播/公演“截断”。新条目优先，旧条目保留。
    const livePrev = ((await loadJson(resolve(DATA_DIR, 'live.json')))?.live) || [];
    const liveMap = new Map(livePrev.map((m) => [String(m.liveId), m]));
    for (const it of liveFresh) {
      const k = String(it.liveId);
      liveMap.set(k, { ...(liveMap.get(k) || {}), ...it });
    }
    liveList = [...liveMap.values()].sort((a, b) => Number(b.ctime || 0) - Number(a.ctime || 0));

    // ---- 直播「结束判定」：修「结束后状态不更新」的坑（见 fetchLiveNowIds 注释）----
    // 本地标记为直播中、却已不在「当前全团直播中集合」、且开播已超过宽限期的条目，
    // 判定为已结束（status=3）。宽限期用于避开「刚开播、列表尚未刷新」的误判。
    const liveNowIds = await safe('直播中集合', fetchLiveNowIds);
    // 集合为空说明当轮接口异常（正常情况下同时在线直播通常 >0），此时不做任何判定，避免误伤。
    if (liveNowIds && liveNowIds.size > 0) {
      const NOW = Date.now();
      const GRACE = Number(process.env.LIVE_END_GRACE_MS || 20 * 60 * 1000);
      let ended = 0;
      for (const it of liveList) {
        if (Number(it.status) !== 2) continue;              // 只处理「直播中」
        if (liveNowIds.has(String(it.liveId))) continue;    // 仍在播 → 保持
        if (NOW - Number(it.ctime || 0) < GRACE) continue;  // 开播未超宽限期 → 保持
        it.status = 3;
        it.endedInferred = true;                            // 标记：状态由「结束时不在列表」推断
        ended++;
      }
      if (ended) console.log(`[直播] 推断已结束 ${ended} 条（不在当前直播中列表，且开播已超 ${Math.round(GRACE / 60000)} 分钟）`);
    }
  }

  const skipPerf = process.env.SKIP_PERF === '1';
  let perfOk = false;
  let performances = [];
  if (skipPerf) {
    console.log('[跳过] 公演（SKIP_PERF=1）');
  } else {
    console.log('[抓取] 公演（直播）...');
    const perfNow = await safe('公演-直播', () => scrapePerformances(false));
    console.log('[抓取] 公演（录播）...');
    const perfRec = await safe('公演-录播', () => scrapePerformances(true));
    perfOk = perfNow !== null || perfRec !== null;
    const perfFresh = [...(perfNow || []), ...(perfRec || [])]
      .filter((v, i, a) => a.findIndex((x) => x.liveId === v.liveId) === i)
      .sort((a, b) => Number(b.stime || b.ctime || 0) - Number(a.stime || a.ctime || 0));
    // 同上：与已有公演数据合并，避免翻页上限导致历史被截断。
    const perfPrev = ((await loadJson(resolve(DATA_DIR, 'performances.json')))?.performances) || [];
    const perfMap = new Map(perfPrev.map((m) => [String(m.liveId), m]));
    for (const it of perfFresh) {
      const k = String(it.liveId);
      perfMap.set(k, { ...(perfMap.get(k) || {}), ...it });
    }
    performances = [...perfMap.values()]
      .sort((a, b) => Number(b.stime || b.ctime || 0) - Number(a.stime || a.ctime || 0));
  }

  // 补充视频播放地址（增量：已有 playUrl 的复用，避免重复请求）
  if (liveOk && liveList.length) {
    const prev = new Map(((await loadJson(resolve(DATA_DIR, 'live.json')))?.live || []).map((m) => [m.liveId, m]));
    const added = await attachPlayUrls(liveList, 'live', prev);
    console.log(`[播放地址] 直播：新增 ${added} 条有播放流，共 ${liveList.filter((m) => m.playUrl).length}/${liveList.length} 条可播放`);
  }
  if (perfOk && performances.length) {
    const prev = new Map(((await loadJson(resolve(DATA_DIR, 'performances.json')))?.performances || []).map((m) => [m.liveId, m]));
    const added = await attachPlayUrls(performances, 'openlive', prev);
    console.log(`[播放地址] 公演：新增 ${added} 条有播放流，共 ${performances.filter((m) => m.playUrl).length}/${performances.length} 条可播放`);
  }

  const meta = {
    member: MEMBER,
    apiBase: API_BASE,
    lastUpdated: new Date().toISOString(),
    counts: {
      messages: messages ? messages.length : (await loadJson(resolve(DATA_DIR, 'messages.json')))?.messages?.length || 0,
      live: liveOk ? liveList.length : (await loadJson(resolve(DATA_DIR, 'live.json')))?.live?.length || 0,
      performances: perfOk ? performances.length : (await loadJson(resolve(DATA_DIR, 'performances.json')))?.performances?.length || 0
    },
    note: '由 48tools 接口逆向抓取，仅供个人补档 / 学习用途。'
  };

  // 发言：落盘前必须脱敏。messages.json 会进公开仓库并同步到 CDN / KV / D1，
  // 所以这里是源头闸门。全量原始另行备份到 scraper/data/messages-full.json（gitignore）。
  const selfId = MEMBER.starId || MEMBER.userId;
  let messagesOut = messages;
  if (messages) {
    // 全量原始备份到 gitignore 目录，供 reparse / 重解析用（绝不上lineage）
    try {
      const privDir = resolve(__dirname, 'data');
      await mkdir(privDir, { recursive: true });
      await writeFile(resolve(privDir, 'messages-full.json'), JSON.stringify({ messages }), 'utf-8');
    } catch (e) {
      console.warn('[脱敏] 全量原始备份失败：' + e.message);
    }
    const r = scrubMessages(messages, selfId);
    messagesOut = r.messages;
    console.log(`[脱敏] 发言 ${r.messages.length} 条，抹掉第三方 sender ${r.removed} 处`);
  }
  if (messagesOut) await saveJson(resolve(DATA_DIR, 'messages.json'), { messages: messagesOut });
  if (liveOk) await saveJson(resolve(DATA_DIR, 'live.json'), { live: liveList });
  if (perfOk) await saveJson(resolve(DATA_DIR, 'performances.json'), { performances });
  await saveJson(resolve(DATA_DIR, 'meta.json'), meta);

  // 刷新 B 站视频库（公演备用源 + 直播切片来源）：按用户指定的三个账号
  // （企理鹅大帝 / 忘记自己是猪 / Chzhnh）抓取公演与直播切片，走 SCRAPE_PROXY 代理兜底绕过 B 站 WAF。
  // 增量 + 断点续传；失败仅警告、不影响后续流程（下轮续跑）。
  if (process.env.SKIP_BILI_VIDEOS !== '1') {
    try {
      const { execFileSync: ef } = await import('node:child_process');
      const fetchBili = resolve(__dirname, '../scripts/fetch-bili-videos.mjs');
      console.log('[B站库] 刷新公演 / 直播切片视频库...');
      ef(process.execPath, [fetchBili], { stdio: 'inherit' });
    } catch (e) {
      console.warn('[警告] B 站视频库刷新失败（不影响 JSON 数据，下轮续跑）：' + e.message);
    }
  } else {
    console.log('[跳过] B 站视频库（SKIP_BILI_VIDEOS=1）');
  }

  // 自动把 Chzhnh 老公演cut 合并进 bili-cuts.js（公演cut 页 / 公演回放页 ✂️ 入口共用数据源）。
  // 依赖上一步刷新的 bili-videos.json；失败仅警告，不影响主数据与后续流程（下轮续跑）。
  try {
    const { execFileSync: ef2 } = await import('node:child_process');
    const syncBili = resolve(__dirname, '../scripts/sync-bili-cuts.mjs');
    console.log('[B站cut] 合并老公演cut 进 bili-cuts.js...');
    ef2(process.execPath, [syncBili], { stdio: 'inherit' });
  } catch (e) {
    console.warn('[警告] bili-cuts 合并失败（不影响其它数据，下轮续跑）：' + e.message);
  }

  // 生成 archive.js（供 file:// 直接打开时也能加载数据，无需本地服务器）
  try {
    const { execFileSync } = await import('node:child_process');
    const script = resolve(__dirname, '../scripts/build-archive.mjs');
    execFileSync(process.execPath, [script], { stdio: 'inherit' });
  } catch (e) {
    console.warn('[警告] archive.js 生成失败（不影响 JSON 数据）：' + e.message);
  }

  console.log('==================== 抓取完成 ====================');
  console.log(`口袋发言：${meta.counts.messages} 条`);
  console.log(`直播/录播：${meta.counts.live} 条`);
  console.log(`公演：${meta.counts.performances} 条`);
  console.log(`数据目录：${DATA_DIR}`);
}

run().catch((e) => {
  console.error('抓取失败：', e);
  process.exit(1);
});
