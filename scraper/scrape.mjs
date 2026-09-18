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
  fetchOpenLivePage
} from './lib/api.mjs';
// 消息解析统一走 lib/message.mjs（按 msgType 精确提取正文 / 引用 / 媒体 / 卡片）
import { parseMessage } from './lib/message.mjs';

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

  let nextTime = 0;
  const merged = new Map(existing.map((m) => [m.msgIdServer, m]));
  let pages = 0;
  let total = existing.length;

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
      if (known.has(raw.msgIdServer)) continue;
      known.add(raw.msgIdServer);
      merged.set(raw.msgIdServer, parseMessage(raw));
      added++;
    }
    total += added;
    pages++;
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
  // 48tools 的修复逻辑：next=0 且指定 userId 时先用分组列表取最新 liveId 作为起点
  if (!record) {
    const first = await fetchLiveListPage({ groupId: MEMBER.groupId, userId: undefined, next: '0', record: false });
    const top = first.list[0];
    if (top) {
      next = top.liveId;
      if (String(top.userInfo?.userId) === String(MEMBER.userId)) all.set(top.liveId, top);
    }
  }
  let pages = 0;
  while (pages < MAX_PAGES) {
    const { list, next: nx } = await fetchLiveListPage({
      groupId: MEMBER.groupId,
      userId: MEMBER.userId,
      next,
      record
    });
    if (!list.length) break;
    for (const it of list) {
      if (String(it.userInfo?.userId) === String(MEMBER.userId)) all.set(it.liveId, it);
    }
    if (!nx || nx === '0') break;
    next = nx;
    pages++;
    await sleep(300);
  }
  return [...all.values()];
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

async function attachPlayUrls(list, type, existingMap) {
  let n = 0;
  for (const it of list) {
    const prev = existingMap.get(it.liveId);
    // 已结束的直播：旧的 playUrl 可能是「直播中」抓到的失效直播流（直播结束后该地址失效），
    // 必须重新向 getLiveOne 请求回放 m3u8，否则前端会拿到一个播不了的死链。
    if (it.status === 3) {
      try {
        if (type === 'live') {
          const r = await fetchLiveOne(it.liveId);
          it.playUrl = r.playStreamPath || '';
        } else {
          const r = await fetchOpenLiveOne(it.liveId, POCKET48_TOKEN || undefined);
          it.playUrl = pickBestStream(r.streams) || '';
        }
        if (it.playUrl) n++;
      } catch {
        it.playUrl = prev?.playUrl || ''; // 获取失败则退回旧值，不破坏已有数据
      }
      await sleep(150);
      continue;
    }
    // 直播中 / 其他状态：有旧地址则复用（直播流仍有效，避免每次重抓）；
    // 无旧地址才去请求，拿到后保存到数据。
    if (prev?.playUrl) {
      it.playUrl = prev.playUrl;
      continue;
    }
    try {
      if (type === 'live') {
        const r = await fetchLiveOne(it.liveId);
        it.playUrl = r.playStreamPath || '';
      } else {
        const r = await fetchOpenLiveOne(it.liveId, POCKET48_TOKEN || undefined);
        it.playUrl = pickBestStream(r.streams) || '';
      }
      if (it.playUrl) n++;
    } catch {
      it.playUrl = '';
    }
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

  const messages = await safe('口袋发言', scrapeMessages);

  console.log('[抓取] 直播（直播中）...');
  const liveNow = await safe('直播-直播中', () => scrapeLiveByMember(false));
  console.log('[抓取] 直播（录播）...');
  const liveRec = await safe('直播-录播', () => scrapeLiveByMember(true));
  const liveOk = liveNow !== null || liveRec !== null;
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
  const liveList = [...liveMap.values()].sort((a, b) => Number(b.ctime || 0) - Number(a.ctime || 0));

  console.log('[抓取] 公演（直播）...');
  const perfNow = await safe('公演-直播', () => scrapePerformances(false));
  console.log('[抓取] 公演（录播）...');
  const perfRec = await safe('公演-录播', () => scrapePerformances(true));
  const perfOk = perfNow !== null || perfRec !== null;
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
  const performances = [...perfMap.values()]
    .sort((a, b) => Number(b.stime || b.ctime || 0) - Number(a.stime || a.ctime || 0));

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

  if (messages) await saveJson(resolve(DATA_DIR, 'messages.json'), { messages });
  if (liveOk) await saveJson(resolve(DATA_DIR, 'live.json'), { live: liveList });
  if (perfOk) await saveJson(resolve(DATA_DIR, 'performances.json'), { performances });
  await saveJson(resolve(DATA_DIR, 'meta.json'), meta);

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
