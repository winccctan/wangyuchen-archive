// 把 site/data/*.json 合并成 site/data/archive.js（window.__ARCHIVE__ 全局变量）
// 目的：让站点在 file:// 直接打开时也能加载数据（fetch 在 file:// 下被 CORS 拦截）。
// 用法：node scripts/build-archive.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'site', 'data');
const OUT = resolve(DATA_DIR, 'archive.js');

function read(name, key) {
  try {
    const d = JSON.parse(readFileSync(resolve(DATA_DIR, name), 'utf8'));
    return key ? (d[key] || []) : d;
  } catch {
    return key ? [] : null;
  }
}

// 网页端瘦身：消息的 raw（原始接口报文）占了约一半体积，
// 但它只在「无正文可显示」时用于展示原始数据，因此对有内容的消息直接剔除。
// messages.json 仍保留全量存档，这里只压缩给网页用的 bundle。
function slimMessage(m) {
  if (!m || !m.raw) return m;
  const hasBody = m.text || m.link || m.reply || m.card ||
    (Array.isArray(m.images) && m.images.length) || m.audio || m.video;
  if (hasBody) {
    const { raw, ...rest } = m; // eslint-disable-line no-unused-vars
    return rest;
  }
  return m;
}

/* ---------------- 公演：按「她参加」筛选 + 挂 B 站跳转（手工维护） ---------------- */
// 接口没有参演成员数据，无法自动判断她参加了哪些公演；改由 site/data/performances-manual.json 手工维护：
//   herPerformances: 名称关键词数组（非空时，公演页只保留命中的）
//   bili: [{ match: 关键词, url: B站链接 }] —— 按名称模糊匹配挂到对应公演
const norm = (s) => String(s || '')
  .replace(/[０-９ａ-ｚＡ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角转半角
  .toLowerCase()
  .replace(/[\s\u3000]/g, '')
  .replace(/[《》「」『』（）()[\]【】·・:：,，.。!！?？~～\-—_/\\|'"“”‘’]/g, '');

function matchName(p, keyword) {
  const k = norm(keyword);
  if (!k) return false;
  const sub = norm(p.subTitle);
  const hay = norm((p.title || '') + (p.subTitle || ''));
  return sub.includes(k) || hay.includes(k) || (sub.length >= 4 && k.includes(sub));
}

function enrichPerformances(list, manual) {
  const keys = (manual?.herPerformances || []).filter(Boolean);
  const bili = (manual?.bili || []).filter((x) => x && x.match);
  let out = list;
  if (keys.length) out = out.filter((p) => keys.some((k) => matchName(p, k)));
  let biliHit = 0;
  out = out.map((p) => {
    const hit = bili.find((b) => matchName(p, b.match));
    if (!hit) return p;
    biliHit++;
    return { ...p, biliUrl: hit.url };
  });
  if (keys.length || bili.length) {
    console.log(`  公演：筛选后 ${out.length}/${list.length} 条，挂上 B 站链接 ${biliHit} 条`);
  }
  return out;
}

const manual = read('performances-manual.json') || {};

const archive = {
  meta: read('meta.json'),
  messages: read('messages.json', 'messages').map(slimMessage),
  live: read('live.json', 'live'),
  performances: enrichPerformances(read('performances.json', 'performances'), manual)
};

const js = `/* 由 scripts/build-archive.mjs 自动生成，请勿手动编辑 */\nwindow.__ARCHIVE__ = ${JSON.stringify(archive)};\n`;
writeFileSync(OUT, js);

console.log(
  `✓ 生成 ${OUT}\n  口袋发言 ${archive.messages.length} | 直播/录播 ${archive.live.length} | 公演 ${archive.performances.length}`
);
