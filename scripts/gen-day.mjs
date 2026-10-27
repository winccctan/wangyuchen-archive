// 生成「这一天」页面用的按天数据：site/day/index.json + site/day/YYYY-MM.json
//
// 为什么要单独一份：
//   页面要「点一天，看到那天的发言 / 直播 / 公演 / 微博 / 投稿」。
//   五套数据分别躺在 messages.json、live.json、performances.json、songs.js、
//   social-media.js、bili-videos.json 里，前端不可能为了看一天去拉几十 MB。
//   ⇒ 按天切好、按月分文件，打开一天只取当月那一个文件。
//
// 🔴 发言一律以线上接口为准（KV/D1 才是实时数据）：git 里的 messages.json 是兜底，
//    否则「今天」会缺一大截（站长 2026-10-27 报过「今天的发言不完整」）。
// 🔴 投稿只收站长指定账号（B站 Chzhnh，mid 358477444）发的、或标题里有「王语晨」的；
//    那批 UP 主是全团搬运号，别团的公演一条都不要进这一页。
//
// 用法：
//   node scripts/gen-day.mjs            # 有变化才写盘，输出改了哪些文件
//   node scripts/gen-day.mjs --check    # 只算不写（CI 用来判断要不要提交）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'site');
const OUT = path.join(SRC, 'day');
const CHECK_ONLY = process.argv.includes('--check');
const API = process.env.DAY_API || 'https://idol.wyc0518.cc';
// 站长指定：她的公演/切片都发在这个号（B站「Chzhnh」，签名「会一直更新到你毕业」）
const HER_MIDS = ['358477444'];

// 一律锁北京时间：按天切分不能用 UTC，否则晚上 8 点后的发言会被算到第二天
const bjDay = (ms) => new Date(Number(ms) + 8 * 3600 * 1000).toISOString().slice(0, 10);
const bjTime = (ms) => new Date(Number(ms) + 8 * 3600 * 1000).toISOString().slice(11, 16);

const byDay = new Map();
const put = (d, k, v) => {
  if (!byDay.has(d)) byDay.set(d, { msg: [], perf: [], live: [], weibo: [], bili: [] });
  byDay.get(d)[k].push(v);
};

let msgChars = 0;
function addMsg(m) {
  const ts = Number(m.msgTime);
  if (!ts) return;
  const text = String(m.text || '').replace(/\s+/g, ' ').trim();
  const imgs = (m.images || []).filter(Boolean);
  const nImg = imgs.length;
  const isVid = m.video ? 1 : 0;
  // 纯卡片/空消息既没字也没图，跳过，免得占位一堆空白行
  if (!text && !nImg && !isVid) return;
  const row = [ts, text];
  if (nImg || isVid) row.push(nImg, isVid);
  // 第 5 位放图片地址（只有带图的才有），前端点开能看大图（站长 2026-10-27：图片出不来）
  if (nImg) row.push(imgs);
  msgChars += text.length;
  put(bjDay(ts), 'msg', row);
}

// ---------- 1. 口袋发言 ----------
const gitMsgs = JSON.parse(fs.readFileSync(path.join(SRC, 'data/messages.json'), 'utf8')).messages || [];
const monthSet = new Set(gitMsgs.map((m) => bjDay(m.msgTime).slice(0, 7)));
monthSet.add(bjDay(Date.now()).slice(0, 7));
const monthsToFetch = [...monthSet].filter((m) => m >= '2022-01').sort();

async function fetchMonth(mk) {
  const res = await fetch(`${API}/api/month?m=${mk}`, {
    headers: { 'user-agent': 'wyc-archive-day-gen/1.0' },
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) throw new Error('status ' + res.status);
  const j = await res.json();
  return Array.isArray(j) ? j : (j && j.messages) || [];
}

let apiOk = 0;
const apiFailed = [];
const CONCURRENCY = 4;
for (let i = 0; i < monthsToFetch.length; i += CONCURRENCY) {
  const batch = monthsToFetch.slice(i, i + CONCURRENCY);
  await Promise.all(batch.map((mk) => fetchMonth(mk).then((arr) => {
    if (!arr.length) throw new Error('empty');
    arr.forEach(addMsg);
    apiOk += 1;
  }).catch((e) => {
    apiFailed.push(mk + '(' + String((e && e.message) || e).slice(0, 24) + ')');
  })));
}
// 接口拿不到的月份退回 git 里那份
const failedSet = new Set(apiFailed.map((x) => x.slice(0, 7)));
gitMsgs.forEach((m) => {
  if (failedSet.has(bjDay(m.msgTime).slice(0, 7))) addMsg(m);
});

// ---------- 2. 直播 ----------
const live = JSON.parse(fs.readFileSync(path.join(SRC, 'data/live.json'), 'utf8')).live || [];
live.forEach((l) => {
  const ts = Number(l.ctime);
  if (!ts) return;
  const dur = Number(l.duration) || 0;
  // 🔴 标题就是原文，别改写：口袋上很多场次标题本来就叫「1」（站长确认这是她自己的取名）
  put(bjDay(ts), 'live', {
    id: String(l.liveId),
    t: String(l.title || '').trim(),
    tm: bjTime(ts),
    dur: dur > 1000 ? Math.round(dur / 1000) : dur, // 有的记录是毫秒，有的是秒
    cov: l.coverPath ? 'https://source.48.cn' + l.coverPath : ''
  });
});

// ---------- 3. 公演 + 当天唱的曲目 ----------
global.window = {};
eval(fs.readFileSync(path.join(SRC, 'js/songs.js'), 'utf8'));
const S = global.window.__SONGS__;
const perfs = JSON.parse(fs.readFileSync(path.join(SRC, 'data/performances.json'), 'utf8')).performances || [];
const perfById = new Map(perfs.map((p) => [String(p.liveId), p]));

Object.keys(S.info).forEach((lid) => {
  const info = S.info[lid];
  if (!info.d) return;
  const p = perfById.get(lid);
  const name = (p && (p.subTitle || p.title)) || info.n || '公演';
  put(info.d, 'perf', {
    id: lid,
    t: String(name).replace(/^GNZ48\s*[·・]?\s*/, '').trim(),
    tm: info.t || '',
    songs: S.byLive[lid] || [],
    cov: p && p.coverPath ? 'https://source.48.cn' + p.coverPath : ''
  });
});

// ---------- 4. 微博（只收她自己发的媒体帖） ----------
global.window = {};
eval(fs.readFileSync(path.join(SRC, 'data/social-media.js'), 'utf8'));
const social = global.window.SOCIAL_MEDIA || [];
social.forEach((s) => {
  const d = String(s.d || '').replace(/\//g, '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
  put(d, 'weibo', {
    t: String(s.t || '').trim(),
    u: s.u || '',
    k: s.k || 'photo',
    cov: s.cover || (s.p && s.p[0]) || ''
  });
});

// ---------- 5. B 站投稿：只留她的 ----------
const bv = JSON.parse(fs.readFileSync(path.join(SRC, 'data/bili-videos.json'), 'utf8'));
let biliAll = 0, biliKept = 0;
(bv.videos || []).forEach((v) => {
  const ts = Number(v.created) * 1000;
  if (!ts) return;
  biliAll += 1;
  const title = String(v.title || '').trim();
  const mine = HER_MIDS.indexOf(String(v.mid)) >= 0 || /王语晨/.test(title);
  if (!mine) return;
  biliKept += 1;
  put(bjDay(ts), 'bili', {
    bv: v.bvid,
    t: title,
    dur: Number(v.duration) || 0,
    tm: bjTime(ts),
    mid: String(v.mid || '')
  });
});

// ---------- 6. 回放链接：B站 Chzhnh 的「公演 cut」和「直播回放」按日期挂上去 ----------
// 站长 2026-10-27：按天看里她的公演 / 直播要能直接点开看回放。
global.window = {};
eval(fs.readFileSync(path.join(SRC, 'data/live-cuts.js'), 'utf8'));
const LC = global.window.LIVE_CUTS || {};
const lcList = Array.isArray(LC) ? LC : (LC.cuts || []);
const repByDay = new Map();   // day → 回放 url（当天第一场直播的回放）
const repByLiveId = new Map(); // liveId → 回放 url（精确，优先用这个）
const cutByDay = new Map();   // day → [{ url, title }]
lcList.forEach((x) => {
  if (!x || !x.titleDate) {
    // 没有 titleDate 的（部分切片）仍可能带 liveId，回放照样能精确定位
    if (x && x.kind === 'replay' && x.liveId && (x.url || x.bvid)) {
      const u = x.url || 'https://www.bilibili.com/video/' + x.bvid;
      if (!repByLiveId.has(String(x.liveId))) repByLiveId.set(String(x.liveId), u);
    }
    return;
  }
  const url = x.url || (x.bvid ? 'https://www.bilibili.com/video/' + x.bvid : '');
  if (!url) return;
  if (x.kind === 'replay') {
    if (!repByDay.has(x.titleDate)) repByDay.set(x.titleDate, url);
    // 同一天可能有好几场直播 ⇒ 有 liveId 就按 liveId 精确挂，别都指到第一场
    if (x.liveId && !repByLiveId.has(String(x.liveId))) repByLiveId.set(String(x.liveId), url);
  } else {
    if (!cutByDay.has(x.titleDate)) cutByDay.set(x.titleDate, []);
    cutByDay.get(x.titleDate).push({ url: url, title: String(x.title || '') });
  }
});

// 标题归一：去掉符号/日期/场次号，「4班《4 Future》首演」和「…4班《4 Future》首演cut」能对上
const normKey = (s) => String(s || '').toUpperCase()
  .replace(/[【】\[\]《》：:·・,，.。、\s\-—_]/g, '')
  .replace(/第[0-9一二三四五六七八九十百]+场/g, '');

let rvPerf = 0, rvLive = 0, perfTotal = 0, liveTotal = 0;
byDay.forEach((v, day) => {
  const cuts = cutByDay.get(day) || [];
  const rep = repByDay.get(day) || '';
  (v.perf || []).forEach((p) => {
    perfTotal += 1;
    const key = normKey(p.t);
    const hit = cuts.find((c) => {
      const ck = normKey(c.title);
      return key && (ck.indexOf(key) >= 0 || key.indexOf(ck) >= 0);
    }) || (cuts.length === 1 && v.perf.length === 1 ? cuts[0] : null);
    if (hit) { p.rv = hit.url; rvPerf += 1; }
  });
  const lives = v.live || [];
  lives.forEach((l) => {
    liveTotal += 1;
    // 精确优先：liveId 对上就用它；否则当天只有一场直播时退回「当天第一场回放」
    const byId = l.id ? repByLiveId.get(String(l.id)) : '';
    const u = byId || (lives.length === 1 ? rep : '');
    if (u) { l.rv = u; rvLive += 1; }
  });
});

// ---------- 输出：按月分文件 + 一份总索引（日期 → 各类条数） ----------
if (!CHECK_ONLY) fs.mkdirSync(OUT, { recursive: true });

const days = [...byDay.keys()].sort();
const index = {};
const months = new Map(); // 'YYYY-MM' → { m, d: { 'YYYY-MM-DD': {...} } }

days.forEach((d) => {
  const v = byDay.get(d);
  const n = { msg: v.msg.length, perf: v.perf.length, live: v.live.length, weibo: v.weibo.length, bili: v.bili.length };
  const any = n.msg + n.perf + n.live + n.weibo + n.bili;
  if (!any) return;
  index[d] = n;
  const mo = d.slice(0, 7);
  if (!months.has(mo)) months.set(mo, { m: mo, d: {} });
  months.get(mo).d[d] = v;
});

let changed = 0;
const write = (name, body) => {
  const p = path.join(OUT, name);
  const old = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  if (old === body) return false;
  if (!CHECK_ONLY) fs.writeFileSync(p, body);
  changed += 1;
  return true;
};

let total = 0;
for (const [mo, obj] of months) {
  const body = JSON.stringify(obj);
  total += body.length;
  if (write(mo + '.json', body)) console.log('  改', mo + '.json', (body.length / 1024).toFixed(1) + 'KB');
}
const idxBody = JSON.stringify({ range: [days[0], days[days.length - 1]], days: index });
write('index.json', idxBody);

// 清理已经不该存在的月份文件（例如某月数据被修成空）
const keep = new Set([...months.keys()].map((m) => m + '.json').concat('index.json'));
if (!CHECK_ONLY) {
  for (const f of fs.readdirSync(OUT)) {
    if (/^\d{4}-\d{2}\.json$/.test(f) && !keep.has(f)) {
      fs.rmSync(path.join(OUT, f));
      console.log('  删', f);
      changed += 1;
    }
  }
}

console.log(
  `${CHECK_ONLY ? '[check] ' : ''}天数 ${Object.keys(index).length} | 月份 ${months.size} | 数据 ${(total / 1048576).toFixed(2)}MB` +
  ` | 索引 ${(idxBody.length / 1024).toFixed(0)}KB | 发言 ${(msgChars / 1048576).toFixed(1)}M 字` +
  ` | 投稿 ${biliKept}/${biliAll} 条（只留她的） | 改动 ${changed}`
);
console.log(`  发言来源：接口 ${apiOk} 个月${apiFailed.length ? '，退回 git：' + apiFailed.join(' ') : ''}`);
console.log(`  回放：公演 ${rvPerf}/${perfTotal} 场 · 直播 ${rvLive}/${liveTotal} 场 能点开看`);
console.log(`  范围 ${days[0]} ~ ${days[days.length - 1]}`);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}
