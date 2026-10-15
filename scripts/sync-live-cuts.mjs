#!/usr/bin/env node
/**
 * 只把 site/data/live-cuts.js（B站 直播切片 / 直播回放）推到 Cloudflare KV 的 `live-cuts` 键。
 *
 * 为什么不直接跑 sync-kv.mjs：那个是「全量同步器」——会顺带推发言（按月份分片，最大件）、
 * 直播、公演、社媒、meta。bili-sync.yml 只管 B站 这一路数据，没必要动其它键，
 * 也避免在只有部分上下文（比如没有 scraper/data/archive-full.js）时把别的数据搅进来。
 *
 * 🔴 安全闸门：推之前先读一次线上 KV，若「本次要推的条数 < 线上已有条数」就**拒绝推送并报错**。
 *    历史事故就是这么来的：残留的旧快照把 697 条盖回 635 条。宁可报错让人来看，也不能静默回退。
 *
 * 环境变量：SYNC_TOKEN 必填（与 Cloudflare SECRETS KV 里的 SYNC_TOKEN 一致）；WORKER_URL 可选。
 *   GH_TOKEN 兜底：本机没有 SYNC_TOKEN 副本时，可用 GH_TOKEN 授权推一次（与 sync-kv.mjs 同款兜底，跑完即撤）。
 * 用法：node scripts/sync-live-cuts.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = resolve(ROOT, 'site/data/live-cuts.js');
const WORKER_URL = (process.env.WORKER_URL || 'https://idol.wyc0518.cc').replace(/\/$/, '');
const TOKEN = process.env.SYNC_TOKEN || '';
const GH_TOKEN = process.env.GH_TOKEN || '';
const AUTH = TOKEN ? { 'x-sync-token': TOKEN } : { 'x-gh-token': GH_TOKEN };

if (!TOKEN && !GH_TOKEN) {
  console.error('[sync-live-cuts] 缺少 SYNC_TOKEN（或 GH_TOKEN）环境变量');
  process.exit(1);
}

function readLiveCuts() {
  const code = readFileSync(FILE, 'utf8');
  const fn = new Function('window', 'self', 'globalThis', code + '\n;return window.LIVE_CUTS || null;');
  const d = fn({});
  if (!d || !Array.isArray(d.cuts)) throw new Error(`${FILE} 里没有 window.LIVE_CUTS.cuts`);
  return d;
}

async function kvCount() {
  try {
    const r = await fetch(WORKER_URL + '/api/live-cuts', {
      headers: { 'user-agent': 'wyc-archive-sync-live-cuts' }
    });
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d.cuts) ? d.cuts.length : null;
  } catch (_) { return null; }
}

const liveCuts = readLiveCuts();
const mine = liveCuts.cuts.length;
const online = await kvCount();
console.log(`[sync-live-cuts] 本地 ${mine} 条 / 线上 KV ${online === null ? '未知' : online + ' 条'}`);

if (online !== null && mine < online) {
  console.error(`[sync-live-cuts] ❌ 拒绝推送：本地 ${mine} 条少于线上 ${online} 条（像是拿到了旧快照）`);
  process.exit(1);
}
if (online !== null && mine === online) {
  console.log('[sync-live-cuts] 条数一致，仍推一次（条目字段可能被修正过；worker 侧比对后相同就不落盘）');
}

const r = await fetch(WORKER_URL + '/api/sync', {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, AUTH),
  body: JSON.stringify({ liveCuts })
});
if (!r.ok) {
  console.error(`[sync-live-cuts] ❌ /api/sync ${r.status}: ${(await r.text()).slice(0, 300)}`);
  process.exit(1);
}
const out = await r.json();
// worker 的 replaceKey 只回 { total, wrote }：wrote=false 表示内容与线上一致（没空写 KV）
const w = (out.wrote && out.wrote.liveCuts) || {};
console.log(`[sync-live-cuts] ✅ KV 现有 ${w.total ?? '?'} 条`
  + `，落盘 ${w.wrote ? '是（内容有变化）' : '否（与线上一致，未空写）'}`);
