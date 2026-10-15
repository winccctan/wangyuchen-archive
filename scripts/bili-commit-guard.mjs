#!/usr/bin/env node
/**
 * 判断 B 站数据文件相比 HEAD 是否有**实质变化**（忽略「每轮都会变」的游标/时间戳字段）。
 *
 * 为什么需要它：bili-sync.yml 每 4 小时跑一次抓取，而 **每一次提交 main = 一次 Cloudflare 全站构建**。
 *   live-cuts.js / bili-videos.json 里都有 `updatedAt`（脚本每轮无条件重写），
 *   若拿 `git diff` 直接判断，就会「没抓到东西也提交」⇒ 一天白刷 6 次构建。
 *
 * 忽略字段
 *   updatedAt   —— 纯时间戳，只是记录「上次抓取时间」，对站点内容无影响
 *   progress    —— fetch-bili-videos 的翻页断点游标；它每轮都可能前进，
 *                  但它只在「历史续跑(BILI_BACKFILL=1)」时才有意义，日常快扫用不到。
 *                  （今天之前它也没被提交过，行为不变；真要跨轮续跑再单独落一个游标文件。）
 *
 * 退出码：0 = 有实质变化（应提交）；3 = 无变化（跳过提交）；1 = 出错
 * 另外把结果写进 $GITHUB_OUTPUT 的 changed=true/false，供 workflow 用 if 判断。
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// [相对路径, 全局变量名]；.json 走 JSON.parse，.js 走求值取全局量
const FILES = [
  ['site/data/live-cuts.js', 'LIVE_CUTS'],
  ['site/data/bili-videos.json', null],
  ['site/js/bili-cuts.js', '__BILI_CUTS__']
];
const VOLATILE = new Set(['updatedAt', 'progress']);

function readHead(rel) {
  try {
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (_) {
    return null;   // HEAD 里还没有这个文件（新增）
  }
}

// 与 sync-kv.mjs 的 parseGlobalJs 同款：让 JS 引擎完整求值，取挂在 window 上的全局量
function parse(rel, gvar, code) {
  if (code === null || code === undefined) return null;
  if (!code.trim()) return null;
  if (rel.endsWith('.json')) {
    try { return JSON.parse(code); } catch (e) { throw new Error(`${rel} 不是合法 JSON：${e.message}`); }
  }
  try {
    const fn = new Function('window', 'self', 'globalThis',
      code + `\n;return window.${gvar} || (self && self.${gvar}) || null;`);
    return fn({});
  } catch (e) {
    throw new Error(`${rel} 求值失败：${e.message}`);
  }
}

function countOf(v) {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') {
    if (Array.isArray(v.cuts)) return v.cuts.length;
    if (Array.isArray(v.videos)) return v.videos.length;
  }
  return '?';
}

/* 稳定性签名：对象键排序 + 剔除 volatile 字段，保证「字段顺序变了」不算变化 */
function sig(v) {
  const seen = new WeakSet();
  const norm = (x) => {
    if (x === null || typeof x !== 'object') return x;
    if (seen.has(x)) return '[循环]';
    seen.add(x);
    if (Array.isArray(x)) return x.map(norm);
    const out = {};
    for (const k of Object.keys(x).sort()) {
      if (VOLATILE.has(k)) continue;
      out[k] = norm(x[k]);
    }
    return out;
  };
  return JSON.stringify(norm(v));
}

let changed = false;
const details = [];
for (const [rel, gvar] of FILES) {
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs)) { details.push(`${rel}: 工作区缺失，跳过`); continue; }
  const nowCode = readFileSync(abs, 'utf8');
  const headCode = readHead(rel);
  try {
    const now = parse(rel, gvar, nowCode);
    const head = parse(rel, gvar, headCode);
    const diff = sig(now) !== sig(head);
    if (diff) changed = true;
    details.push(`${rel}: ${diff ? '有变化' : '无变化'}（条数 ${countOf(head)} → ${countOf(now)}）`);
  } catch (e) {
    // 解析不了就当成「有变化」：宁可多提一次，也不能把抓到的新数据吞掉
    changed = true;
    details.push(`${rel}: ${e.message} → 视为有变化`);
  }
}

for (const d of details) console.log('[guard] ' + d);
console.log(`[guard] 实质变化：${changed ? '是（应提交）' : '否（跳过提交，避免白刷全站构建）'}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
process.exit(changed ? 0 : 3);
