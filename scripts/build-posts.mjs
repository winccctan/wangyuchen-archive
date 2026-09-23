/*
 * 抓取成员「口袋动态」（posts timeline），从中抽取「uid ↔ 昵称」样本。
 *
 * 为什么有用：她发的生日祝福帖里是 `<a href="snh48://<uid>">@<昵称></a>`，
 * 这是**官方在同一时刻把 uid 和昵称绑定写死**的记录，比从房间消息里反推可靠得多。
 * 每份样本带时间，可直接当「历史昵称」库用 —— 改过名的人也能对上。
 *
 * 用法（务必直连）：
 *   cd wangyuchen-archive
 *   env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
 *     node scripts/build-posts.mjs > .cache/fans/posts.jsonl
 *   node scripts/build-posts.mjs --dry | head          # 只看统计，不写文件
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = await import(ROOT + '/scraper/lib/api.mjs');
const { MEMBER } = await import(ROOT + '/scraper/lib/config.mjs');

const DRY = process.argv.includes('--dry');
const UID = Number(MEMBER.userId);
const PATH_TX = '/posts/api/v1/posts/timeline/home/new';
const OUT = ROOT + '/.cache/fans/posts.jsonl';
const RE_MENTION = /href="snh48:\/\/(\d+)"[^>]*>@([^<]{1,40})</g;

const stripHtml = (s) => String(s || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .trim();

async function crawl() {
  const posts = [];
  let nextId = 0, page = 0;
  while (page < 200) {
    const d = await A.postJson(PATH_TX, { userId: UID, nextTime: 0, nextId }, { retries: 2 });
    const arr = (d.content && d.content.postsInfo) || [];
    if (!arr.length) break;
    for (const x of arr) {
      const q = (x.data && x.data.postsInfo) || {};
      const at = Number(q.createAt) || 0;
      const html = String(q.postContent || q.previewText || '');
      const mentions = [];
      let m;
      RE_MENTION.lastIndex = 0;
      while ((m = RE_MENTION.exec(html))) mentions.push({ u: m[1], n: m[2].trim() });
      const pics = Array.isArray(q.previewImg) ? q.previewImg.filter(Boolean) : [];
      posts.push({
        id: String(q.postId || ''), at,
        title: q.title || '',
        text: stripHtml(html).slice(0, 500),
        pics, mentions,
        like: Number(q.likeCount) || 0, cmt: Number(q.commentCount) || 0, view: Number(q.viewCount) || 0,
        type: q.postType,
      });
    }
    page++;
    const nx = d.content.nextId;
    if (nx == null || nx === nextId) break;
    nextId = nx;
  }
  return posts;
}

const posts = await crawl();
// 同一 postId 去重
const seen = new Set();
const uniq = posts.filter((p) => (p.id && seen.has(p.id) ? false : (seen.add(p.id), true)));

const withMention = uniq.filter((p) => p.mentions.length);
const withPic = uniq.filter((p) => p.pics.length);
const pairMap = new Map();     // uid -> Set(nick)
let pairCount = 0;
for (const p of uniq) for (const mn of p.mentions) {
  pairCount++;
  if (!pairMap.has(mn.u)) pairMap.set(mn.u, new Set());
  pairMap.get(mn.u).add(mn.n);
}
const multi = [...pairMap.entries()].filter(([, s]) => s.size > 1);

const years = {};
for (const p of uniq) {
  const y = new Date(p.at).getFullYear();
  years[y] = (years[y] || 0) + 1;
}
const oldest = uniq.length ? new Date(Math.min(...uniq.map((p) => p.at))) : null;
const newest = uniq.length ? new Date(Math.max(...uniq.map((p) => p.at))) : null;
const atText = (d) => d ? d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-';

console.error(`动态总数 ${uniq.length} 条（原始 ${posts.length}）  时间跨度 ${atText(oldest)} ~ ${atText(newest)}`);
console.error(`  含 @提及 ${withMention.length} 条，共 ${pairCount} 次提及，覆盖 ${pairMap.size} 个不同 uid`);
console.error(`  含图片 ${withPic.length} 条，图片总计 ${withPic.reduce((s, p) => s + p.pics.length, 0)} 张`);
console.error(`  改过名（同一 uid 多个昵称）的：${multi.length} 个`);
console.error('  按年：' + Object.entries(years).sort().map(([y, n]) => `${y}:${n}`).join(' '));

if (!DRY) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, uniq.map((p) => JSON.stringify(p)).join('\n') + '\n');
  console.error('→ ' + OUT);
} else {
  console.error('(--dry 未写文件)');
}
console.error('\n== 抽取到的 uid↔昵称 样例（前 12）==');
[...pairMap.entries()].slice(0, 12).forEach(([u, s]) => console.error(`   ${u.padEnd(12)} ${[...s].join(' / ')}`));
