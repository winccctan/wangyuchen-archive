/**
 * 社媒美图（@忘记自己是鱼_ uid 7648263890）增量更新
 * ==================================================
 * 抓微博时间线 → 挑「本人发的、带图/带视频」的帖 → 与 site/data/social-media.js 比对 →
 * 只把缺的补进去 → 同步 dist/。
 *
 * 用法（在仓库根目录）：
 *   node scripts/update-social-media.mjs                 # dry-run：只打印将要新增的条目
 *   node scripts/update-social-media.mjs --write         # 落盘 site/ + dist/
 *   node scripts/update-social-media.mjs --only=RjNHRrChR --write   # 只补指定 mblogid 那一条
 *   node scripts/update-social-media.mjs --fetch         # 忽略 /tmp 缓存，现抓
 *
 * 🔴 跑完还要把数据推到线上 KV（页面读的是 /api/social，不是这个 js 文件）：
 *    git add site/data/social-media.js dist/data/social-media.js && git commit && git push
 *    然后手动触发 Actions「抓取并同步到 KV」（sync-kv 会把这份 social 写进 KV）。
 *    本机没有 SYNC_TOKEN，无法直连写 KV。
 *
 * 🔴 口径（与既有 107 条保持一致，别随手放宽）
 *   - 只收**本人发布**、带 pic_ids 或视频的帖；纯文字 / 转发 / 点赞卡片一律不收
 *   - 图片统一 mw690（既有 456 张全是 mw690）；日期取 created_at 的**北京时间**
 *   - 去重按微博链接 u（mblogid）
 *   - 数组顺序：置顶帖在第 0 位，其后按时间降序；前端按月分组，组内沿用数组顺序
 *
 * 🔴 Cookie：`private-data/weibo-cookie.txt`（已 gitignore），一行，含
 *    SUBP / SUB / ALF / WBPSESS / XSRF-TOKEN 五个字段（值不要写进仓库，任何文件里都别写）
 *    过期表现 = list 为空 / HTTP 非 200 → 让站长重新从浏览器 F12 → Network → 第一条请求 → 复制 Cookie 行。
 *    ⚠️ 时间线**必须真登录**：匿名 / 访客 SUB 一律拿不到（m.weibo.cn 302，mymblog 403）。
 */
import fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const UID = '7648263890';
const SITE = resolve(ROOT, 'site/data/social-media.js');
const DIST = resolve(ROOT, 'dist/data/social-media.js');
const COOKIE_FILE = resolve(ROOT, 'private-data/weibo-cookie.txt');
const MAX_PAGES = 12;

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const FETCH = argv.includes('--fetch') || !fs.existsSync('/tmp/wb_p1.json');
const onlyArg = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ---------- 1) 抓时间线（默认复用 /tmp/wb_pN.json；--fetch 才联网） ---------- */
async function fetchAll(cookie) {
  const posts = [];
  const seen = new Set();
  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = `https://weibo.com/ajax/statuses/mymblog?uid=${UID}&page=${p}&feature=0`;
    const r = await fetch(url, {
      headers: { Cookie: cookie, 'User-Agent': UA, Referer: `https://weibo.com/u/${UID}`, 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!r.ok) { console.warn(`  第 ${p} 页 HTTP ${r.status}，停`); break; }
    const j = await r.json();
    const list = (j && j.data && j.data.list) || [];
    if (!list.length) break;
    for (const b of list) { if (!seen.has(b.mblogid)) { seen.add(b.mblogid); posts.push(b); } }
    if (p < MAX_PAGES) await new Promise((s) => setTimeout(s, 2000));   // 每页 2s，实测零风控
  }
  return posts;
}

let posts = [];
if (FETCH) {
  if (!fs.existsSync(COOKIE_FILE)) throw new Error('缺少 ' + COOKIE_FILE + '（微博登录 Cookie，一行）');
  posts = await fetchAll(fs.readFileSync(COOKIE_FILE, 'utf8').trim());
} else {
  for (let p = 1; p <= MAX_PAGES; p++) {
    const f = `/tmp/wb_p${p}.json`;
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const b of (j.data?.list || [])) posts.push(b);
    } catch { /* 忽略坏页 */ }
  }
  const seen = new Set();
  posts = posts.filter((b) => (seen.has(b.mblogid) ? false : (seen.add(b.mblogid), true)));
}
console.log(`微博帖（去重后） ${posts.length} 条${FETCH ? '（本次现抓）' : '（复用 /tmp/wb_pN.json）'}`);

/* ---------- 2) 读现有数据 ---------- */
const raw = fs.readFileSync(SITE, 'utf8');
const mm = raw.match(/window\.SOCIAL_MEDIA\s*=\s*(\[[\s\S]*\]);?\s*$/);
if (!mm) throw new Error('解析失败：social-media.js 里没找到 window.SOCIAL_MEDIA = [...]');
const cur = JSON.parse(mm[1]);
const have = new Set(cur.map((x) => x.u));
console.log(`现有条目 ${cur.length}`);

/* ---------- 3) 转条目 ---------- */
function bjDate(s) {                       // created_at(+0800) → 北京时间 YYYY-MM-DD
  const d = new Date(String(s).replace('+0800', ' GMT+0800'));
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
const toMw690 = (u) => String(u || '').replace(/\/(large|orj480|bmiddle|thumbnail|mw1024)\//, '/mw690/');

function toEntry(b) {
  const dt = bjDate(b.created_at);
  const pics = (b.pic_ids || []).map((id) => {
    const info = (b.pic_infos || {})[id] || {};
    const u = (info.largest || info.mw690 || info.original || info.bmiddle || {}).url;
    return u ? toMw690(u) : null;
  }).filter(Boolean);
  const pi = b.page_info || {};
  const isVid = pi.type === 'video' || !!b.mix_media_info;
  if (!pics.length && !isVid) return null;
  return {
    m: dt.slice(0, 7).replace('-', ''),
    d: dt.replace(/-/g, '/'),
    t: String(b.text_raw || '').replace(/\s+$/, ''),
    u: `https://weibo.com/${UID}/${b.mblogid}`,
    k: isVid ? 'video' : 'photo',
    n: isVid ? 0 : pics.length,
    p: isVid ? [] : pics,
    cover: isVid ? (pi.page_pic?.url || null) : null,
  };
}

const cand = posts.map(toEntry).filter(Boolean);
const add = cand.filter((x) => !have.has(x.u) && (!onlyArg || x.u.endsWith('/' + onlyArg)));
add.sort((a, b) => b.d.localeCompare(a.d));

console.log(`\n=== 将要新增 ${add.length} 条 ===`);
add.forEach((x) => console.log(`  ${x.d}  ${x.k}  ${x.n} 张  ${JSON.stringify(x.t.slice(0, 46))}`));

if (!WRITE || !add.length) {
  console.log(WRITE ? '\n（没有新增，未落盘）' : '\n（dry-run；加 --write 落盘）');
  process.exit(0);
}

/* ---------- 4) 插到置顶帖之后、降序列表最前 ---------- */
const out = [cur[0], ...add, ...cur.slice(1)];
const header = [
  '// 王语晨补档站 · 社媒美图数据（@忘记自己是鱼_ 本人发的照片/视频）',
  '// 自动生成，不要手改。来源：微博 mymblog 时间线（uid 7648263890），脚本 scripts/update-social-media.mjs 增量合并。',
  '// 图片为微博图床原始 URL，由前端经 Worker 图片代理 /img/?u=<encoded> 获取（直链会被 403 拦截）。',
].join('\n');
const body = header + '\nwindow.SOCIAL_MEDIA = ' + JSON.stringify(out) + ';\n';
fs.writeFileSync(SITE, body, 'utf8');
fs.writeFileSync(DIST, body, 'utf8');

/* ---------- 5) 自证：除新增外逐字未变 ---------- */
const back = JSON.parse(fs.readFileSync(SITE, 'utf8').match(/window\.SOCIAL_MEDIA\s*=\s*(\[[\s\S]*\]);?\s*$/)[1]);
const oldSet = new Set(cur.map((x) => JSON.stringify(x)));
const changed = back.filter((x) => !oldSet.has(JSON.stringify(x)));
const lost = cur.filter((x) => !back.some((y) => y.u === x.u));
console.log(`\n已写入 site/ 与 dist/：${cur.length} → ${back.length} 条`);
console.log(`校验：新增 ${changed.length} 条 / 丢失 ${lost.length} 条（丢失必须为 0）`);
