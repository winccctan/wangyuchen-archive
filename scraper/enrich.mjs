// 一次性补数据脚本：读取已抓取的 live.json / performances.json，
// 1) 公演按王语晨所在队伍（TEAM NIII）过滤；
// 2) 为每条直播/公演补充视频播放地址（m3u8）；
// 3) 写回并重新生成 archive.js。
// 用法（在 scraper 目录）：node enrich.mjs
//
// 健壮性设计：
// - 并发抓取（CONCURRENCY 路）；
// - 单条硬超时 ITEM_TIMEOUT（底层 TLS 握手可能挂死，Promise.race 兜底）；
// - 每 CHECKPOINT_EVERY 条增量落盘，中断重跑自动续补（跳过已有 playUrl 的记录）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MEMBER, POCKET48_TOKEN } from './lib/config.mjs';
import { fetchLiveOne, fetchOpenLiveOne } from './lib/api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '../site/data');
const CONCURRENCY = 6;
const ITEM_TIMEOUT = 25000;
const CHECKPOINT_EVERY = 50;

function isHerTeam(item) {
  const teams = item.teamList || [];
  return teams.some((t) => t.teamName === MEMBER.team || String(t.teamId) === String(MEMBER.teamId));
}
function pickBestStream(streams) {
  if (!streams || !streams.length) return '';
  const hd = streams.find((s) => /高清|hd|fhd|蓝光|超清|original/i.test(s.name || ''));
  return (hd || streams[0]).path || '';
}
async function loadJson(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

// 单条硬超时：无论内部卡在哪一层，超过 ms 一律按失败处理（避免整体挂死）
function withTimeout(promise, ms, tag) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${tag} 超时 ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function main() {
  const liveData = (await loadJson(resolve(DATA_DIR, 'live.json'))) || { live: [] };
  const perfData = (await loadJson(resolve(DATA_DIR, 'performances.json'))) || { performances: [] };

  const perfAll = perfData.performances || [];
  // 已过滤过则保持，否则按队伍过滤
  const alreadyFiltered = perfAll.every(isHerTeam);
  const perfKept = alreadyFiltered ? perfAll : perfAll.filter(isHerTeam);
  console.log(`公演：原始 ${perfAll.length} -> TEAM NIII ${perfKept.length}${alreadyFiltered ? '（已过滤过）' : ''}`);

  const liveList = liveData.live || [];

  // 增量落盘：保存当前进度到 JSON
  async function checkpoint() {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(resolve(DATA_DIR, 'live.json'), JSON.stringify({ live: liveList }, null, 2), 'utf8');
    await writeFile(resolve(DATA_DIR, 'performances.json'), JSON.stringify({ performances: perfKept }, null, 2), 'utf8');
    const meta = (await loadJson(resolve(DATA_DIR, 'meta.json'))) || {};
    if (meta.counts) {
      meta.counts.performances = perfKept.length;
      meta.counts.live = liveList.length;
      await writeFile(resolve(DATA_DIR, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    }
  }

  async function pool(items, worker, label) {
    const todo = items.filter((m) => !m.playUrl);
    let done = 0, ok = 0, i = 0;
    console.log(`[${label}] 待补 ${todo.length}/${items.length}`);
    async function runner() {
      while (i < todo.length) {
        const idx = i++;
        let added = false;
        try {
          added = await withTimeout(worker(todo[idx]), ITEM_TIMEOUT, label + '单条');
        } catch (e) {
          todo[idx].playUrl = todo[idx].playUrl || '';
        }
        if (added) ok++;
        done++;
        if (done % 20 === 0 || done === todo.length) {
          process.stdout.write(`\r[${label}] 进度 ${done}/${todo.length} (可播放 ${ok})`);
        }
        // 增量落盘，保证中断不丢进度
        if (done % CHECKPOINT_EVERY === 0 || done === todo.length) await checkpoint();
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(todo.length, 1)) }, runner));
    process.stdout.write('\n');
    return ok;
  }

  const liveAdded = await pool(liveList, async (it) => {
    const r = await fetchLiveOne(it.liveId, POCKET48_TOKEN || undefined);
    it.playUrl = r.playStreamPath || '';
    return !!it.playUrl;
  }, '直播');

  const perfAdded = await pool(perfKept, async (it) => {
    const r = await fetchOpenLiveOne(it.liveId, POCKET48_TOKEN || undefined);
    it.playUrl = pickBestStream(r.streams) || '';
    return !!it.playUrl;
  }, '公演');

  await checkpoint();

  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, [resolve(__dirname, '../scripts/build-archive.mjs')], { stdio: 'inherit' });
  } catch (e) { console.warn('[警告] archive.js 生成失败：' + e.message); }

  console.log(`完成：直播新增播放流 ${liveAdded}（共 ${liveList.filter((m) => m.playUrl).length}/${liveList.length} 可播放）`);
  console.log(`完成：公演新增播放流 ${perfAdded}（共 ${perfKept.filter((m) => m.playUrl).length}/${perfKept.length} 可播放）`);
}

main().catch((e) => { console.error('失败：', e); process.exit(1); });
