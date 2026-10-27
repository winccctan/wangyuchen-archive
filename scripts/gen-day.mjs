// 生成「这一天」页面用的按天数据：site/day/index.json + site/day/YYYY-MM.json
//
// 为什么要单独一份：
//   页面要「点一天，看到那天的发言 / 直播 / 公演 / 微博 / 投稿」。
//   五套数据分别躺在 messages.json（40MB）、live.json、performances.json、songs.js、
//   social-media.js、bili-videos.json 里，前端不可能为了看一天去拉几十 MB。
//   ⇒ 按天切好、按月分文件，打开一天只取当月那一个文件。
//
// 用法：
//   node scripts/gen-day.mjs            # 有变化才写盘，输出改了哪些文件
//   node scripts/gen-day.mjs --check    # 只算不写（CI 用来判断要不要提交）
//
// 退出码：0 = 有改动（或 --check 时有改动）/ 没改动，看输出统计即可
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'site');
const OUT = path.join(SRC, 'day');
const CHECK_ONLY = process.argv.includes('--check');

// 一律锁北京时间：按天切分不能用 UTC，否则晚上 8 点后的发言会被算到第二天
const bjDay = (ms) => new Date(Number(ms) + 8 * 3600 * 1000).toISOString().slice(0, 10);
const bjTime = (ms) => new Date(Number(ms) + 8 * 3600 * 1000).toISOString().slice(11, 16);

// ---------- 1. 口袋发言 ----------
const msgs = JSON.parse(fs.readFileSync(path.join(SRC, 'data/messages.json'), 'utf8')).messages;
const byDay = new Map();
const put = (d, k, v) => {
  if (!byDay.has(d)) byDay.set(d, { msg: [], perf: [], live: [], weibo: [], bili: [] });
  byDay.get(d)[k].push(v);
};

let msgChars = 0;
msgs.forEach((m) => {
  const ts = Number(m.msgTime);
  if (!ts) return;
  const d = bjDay(ts);
  const text = String(m.text || '').replace(/\s+/g, ' ').trim();
  const nImg = (m.images || []).length;
  const isVid = m.video ? 1 : 0;
  // 纯卡片/空消息既没字也没图，跳过，免得占位一堆空白行
  if (!text && !nImg && !isVid) return;
  const row = [ts, text];
  if (nImg || isVid) row.push(nImg, isVid);
  msgChars += text.length;
  put(d, 'msg', row);
});

// ---------- 2. 直播 ----------
const live = JSON.parse(fs.readFileSync(path.join(SRC, 'data/live.json'), 'utf8')).live || [];
live.forEach((l) => {
  const ts = Number(l.ctime);
  if (!ts) return;
  const dur = Number(l.duration) || 0;
  put(bjDay(ts), 'live', {
    id: String(l.liveId),
    t: String(l.title || '').trim() || '直播',
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

// ---------- 5. B 站投稿（含别团搬运号，前端会分「她的 / NIII / 别团」） ----------
const bv = JSON.parse(fs.readFileSync(path.join(SRC, 'data/bili-videos.json'), 'utf8'));
(bv.videos || []).forEach((v) => {
  const ts = Number(v.created) * 1000;
  if (!ts) return;
  put(bjDay(ts), 'bili', {
    bv: v.bvid,
    t: String(v.title || '').trim(),
    dur: Number(v.duration) || 0,
    tm: bjTime(ts)
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
  ` | 索引 ${(idxBody.length / 1024).toFixed(0)}KB | 发言 ${msgs.length} 条 ${(msgChars / 1048576).toFixed(1)}M 字 | 改动文件 ${changed}`
);
console.log(`  范围 ${days[0]} ~ ${days[days.length - 1]}`);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}
