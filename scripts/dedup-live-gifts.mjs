#!/usr/bin/env node
/**
 * 直播弹幕礼物去重 —— 每次 build-live-gifts.mjs 抓完都要跑一遍。
 *
 * 为什么需要：build-live-gifts.mjs 是 appendFileSync 追加写，靠 progress 文件避免重复扫。
 * 一旦断点丢失/被并发覆盖，同一个场次会被再扫一遍并原样追加；而 build-fans.mjs 读这份文件
 * 时**完全不去重**（第 456 行直接 +=），重复行数会让 2026 鸡腿和活动分逐天翻倍。
 *
 * 去重策略：按「场次首块保留」。
 * ⚠️ 不能用 (liveId,time,nick,gift,num) 做键 —— 本文件里 time 字段恒为 undefined，
 *    键会退化成 (liveId,nick,gift,num)，把「同一场次同一人连送两次同名礼物」误删（反而少算分）。
 * ✅ 由于抓取是逐场次 append，同一场次的行必然连续；重复表现为「同一 liveId 的完整块再次出现」。
 *    所以保留每个场次首次出现的那一块、丢弃后续块即可 —— 既不漏算真实重复礼物，又精确去掉副本。
 *
 * 幂等：对没有重复的文件运行无任何写入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = path.join(ROOT, '.cache/live-gifts.jsonl');

if (!fs.existsSync(P)) {
  console.log('[弹幕去重] 无 .cache/live-gifts.jsonl，跳过');
  process.exit(0);
}

const lines = fs.readFileSync(P, 'utf8').split('\n').filter(Boolean);
const parsed = lines.map((l) => {
  try { return [l, JSON.parse(l)]; } catch { return [l, {}]; }
});

const out = [];
const done = new Set();
let i = 0;
while (i < parsed.length) {
  const key = String(parsed[i][1].liveId || '_none_');
  if (done.has(key)) { i++; continue; }           // 该场次已保留过一块 → 后续副本整块丢弃
  while (i < parsed.length && String(parsed[i][1].liveId || '_none_') === key) {
    out.push(parsed[i][0]);
    i++;
  }
  done.add(key);
}

const dup = lines.length - out.length;
if (dup) {
  fs.writeFileSync(P, out.join('\n') + '\n');
  console.log(`[弹幕去重] ${lines.length} → ${out.length}（丢弃重复 ${dup} 条 / 现有 ${done.size} 个场次）`);
} else {
  console.log(`[弹幕去重] 无需去重（${out.length} 条 / ${done.size} 个场次）`);
}
