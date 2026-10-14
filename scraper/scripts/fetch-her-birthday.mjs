// 抓取王语晨「给粉丝的生日祝福」——源：口袋「48动态」（posts timeline）。
//
// 🔴 正确源头（2026-10-14 站长指认 + 实测）：她主页的「48动态」标签，里面是一条条
//   title="生日祝福" 的动态帖，形如：<a href="snh48://<粉丝uid>">@<昵称></a><br/><span>感谢对我的支持…</span>
//   接口：POST /posts/api/v1/posts/timeline/home/new  body { userId, nextTime:0, nextId }
//   （实测 2026-10-14：272 条动态，其中 112 条 title=「生日祝福」＝生日祝福帖，覆盖 87 个 uid）
//
// ⚠️ 曾经的错误源头已废弃：从聊天室 messages-full.json 抽「生日快乐」——
//   聊天室混大量粉丝发言，她本人真正发的祝福只有 2 条巧合重叠，且易把粉丝祝她误收（已踩坑）。
//
// 🔴 隐私：mention 的 href 是**粉丝 uid**，一律剥掉，只保留昵称；
//   纯数字昵称按本站规则打码（前4****后2）。
//
// 输出：../../site/js/birthday-wishes.js → window.__BIRTHDAY__ = [...]
// 数据契约（站点 renderBirthday 读取）：{ id, to, text, images:[url], time }
//
// 用法：
//   env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
//     node scraper/scripts/fetch-her-birthday.mjs
import { MEMBER } from '../lib/config.mjs';
import { postJson } from '../lib/api.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '..', '..', 'site', 'js', 'birthday-wishes.js');
const HER = Number(MEMBER.userId);
const PATH_TX = '/posts/api/v1/posts/timeline/home/new';

const RE_MENTION = /href="snh48:\/\/(\d+)"[^>]*>@([^<]{1,40})</g;
const stripHtml = (s) => String(s || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const bjTime = (ts) => new Date(Number(ts) + 28800000).toISOString().slice(0, 10);

// 纯数字昵称打码：前4****后2（本站隐私铁律）
function maskNick(n) {
  const s = String(n || '').trim();
  if (!/^\d+$/.test(s)) return s;
  if (s.length > 6) return s.slice(0, 4) + '****' + s.slice(-2);
  if (s.length > 2) return s.slice(0, 1) + '****' + s.slice(-1);
  return '****';
}

async function crawl() {
  const posts = [];
  let nextId = 0, page = 0;
  while (page < 200) {
    const d = await postJson(PATH_TX, { userId: HER, nextTime: 0, nextId }, { retries: 2 });
    const arr = (d.content && d.content.postsInfo) || [];
    if (!arr.length) break;
    for (const x of arr) posts.push((x.data && x.data.postsInfo) || {});
    page++;
    const nx = d.content.nextId;
    if (nx == null || nx === nextId) break;
    nextId = nx;
  }
  return posts;
}

function toWish(q) {
  const html = String(q.postContent || q.previewText || '');
  const title = String(q.title || '');
  // 只要「生日祝福」帖：title 命中，或正文含生日祝福模板
  const isBday = title.includes('生日祝福') || /生日快乐|破壳日|生日祝福/.test(stripHtml(html));
  if (!isBday) return null;
  // 收礼对象：抽取第一个 @提及（昵称），uid 一律丢弃
  let to = '';
  RE_MENTION.lastIndex = 0;
  const m = RE_MENTION.exec(html);
  if (m) to = m[2].trim();
  // 正文：先把整个 <a>@昵称</a> 锚点删掉，避免「@昵称」在 to 与 text 里重复
  const text = stripHtml(html.replace(/<a[^>]*>[\s\S]*?<\/a>/gi, ''));
  const imgs = Array.isArray(q.previewImg) ? q.previewImg.filter(Boolean) : [];
  // 🔴 _uids 只用于服务端「我的生贺」（/api/mine 按本人 uid 回取），**绝不进前端 js**
  RE_MENTION.lastIndex = 0;
  const uids = [];
  let mm;
  while ((mm = RE_MENTION.exec(html))) { const u = String(mm[1] || '').trim(); if (u && !uids.includes(u)) uids.push(u); }
  return {
    id: 'dyn-' + String(q.postId || ''),
    to: maskNick(to),
    text,
    images: imgs,
    time: bjTime(q.createAt),
    _uids: uids
  };
}

async function main() {
  const posts = await crawl();
  const out = [];
  const seen = new Set();
  for (const q of posts) {
    const w = toWish(q);
    if (!w) continue;
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    out.push(w);
  }
  // 时间倒序（新在前）
  out.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));

  // 🔴 完整性闸门（2026-10-14 加，为每周自动流水线）：
  //   KV `bd/all` 是**整键覆盖写** —— 万一定时那次接口中途返回空，只抓到几十条就写上去，
  //   会把线上 112 条冲掉，粉丝从此查不到自己的祝福（比「这一轮不抓」严重得多）。
  //   她 48 动态的总数与祝福数都**只增不减**，所以下限阈值长期有效（2026-10-14 基线：272 条动态 / 112 条祝福）。
  //   阈值可用环境变量覆盖（BD_MIN_POSTS / BD_MIN_WISHES），紧急时置 0 可强制放行。
  const MIN_POSTS = Number(process.env.BD_MIN_POSTS || 200);
  const MIN_WISHES = Number(process.env.BD_MIN_WISHES || 90);
  if (posts.length < MIN_POSTS || out.length < MIN_WISHES) {
    console.error('[生日] 抓取不完整：48动态 ' + posts.length + ' 条（应 ≥' + MIN_POSTS + '）／祝福 '
      + out.length + ' 条（应 ≥' + MIN_WISHES + '）→ 放弃写文件，线上沿用上一轮数据');
    process.exit(1);
  }

  // 服务端专用：uid → 她给的生日祝福（只落 .cache，推 KV 给 /api/mine 按本人 uid 回取）
  const uidMap = {};
  for (const w of out) {
    for (const u of (w._uids || [])) {
      (uidMap[u] = uidMap[u] || []).push({ d: w.time, x: w.text });
    }
  }
  for (const u of Object.keys(uidMap)) uidMap[u].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  const uidPath = resolve(here, '..', '..', '.cache', 'birthday-uid.json');
  mkdirSync(dirname(uidPath), { recursive: true });
  writeFileSync(uidPath, JSON.stringify(uidMap));
  console.log('[生日] 服务端 uid 映射 ' + Object.keys(uidMap).length + ' 人 → ' + uidPath + '（含 uid，绝不提交）');

  // 前端 js：剥掉 _uids
  const pub = out.map((w) => ({ id: w.id, to: w.to, text: w.text, images: w.images, time: w.time }));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, '/* 自动生成：scraper/scripts/fetch-her-birthday.mjs（源：48动态 posts timeline；粉丝 uid 已剥离，纯数字昵称打码）*/\n'
    + 'window.__BIRTHDAY__ = ' + JSON.stringify(pub, null, 0) + ';\n');
  console.log('[生日] 48动态共 ' + posts.length + ' 条，抽到生日祝福 ' + out.length + ' 条 → ' + OUT);
  console.log('[生日] 时间跨度 ' + (out[out.length - 1]?.time || '-') + ' ~ ' + (out[0]?.time || '-'));
}
main().catch((e) => { console.error('[生日] 失败：', e.message); process.exit(1); });
