#!/usr/bin/env node
/**
 * 提交前的体积护栏（2026-10-26）
 *
 * 为什么有这个东西：仓库里躺着两个历史大文件 ——
 *   site/data/messages.json  40.7 MB
 *   site/data/archive.js     15.9 MB（dist 里还有一份 15.6 MB）
 * 它们从 2026-09-28 起就没再被提交过（抓取链路改成 contents: read + 只推 KV），
 * 但那是**靠人记得「只 add 指定文件」**撑着的。哪天某次提交用了 `git add -A`、
 * 或者新写一个 workflow 顺手 `git add site/data`，它们就会回去，
 * 而且 GitHub 对单文件是 50 MB 警告 / **100 MB 直接拒收 push**：
 *   push 被拒 → 抓取 workflow 的提交步骤失败 → 补档站数据从此停止更新。
 *
 * 用法（在 `git add` 之后、`git commit` 之前跑）：
 *   node scripts/git-size-guard.mjs            # 本地/人工：超限直接失败（退出码 1）
 *   node scripts/git-size-guard.mjs --drop     # CI：把超限文件从暂存区移除，**不阻断流程**
 *   MAX_MB=30 node scripts/git-size-guard.mjs  # 临时改阈值
 *
 * 只读检查：不写文件、不发请求、不改历史。检查的是**暂存区的 blob 大小**，
 * 所以工作区里 40 MB 未跟踪的文件不会误报。
 */
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const MODE = argv.includes('--drop') ? 'drop' : 'fail';
const LIMIT_MB = Number(process.env.MAX_MB || 10);
const LIMIT = LIMIT_MB * 1048576;

const git = (a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });

let names = [];
try {
  // -z：文件名里的特殊字符/中文不会被引号转义搞坏；ACMR = 新增/复制/修改/重命名
  names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
} catch (e) {
  console.error('体积护栏：读取暂存区失败 —— ' + String(e.message).slice(0, 200));
  process.exit(2);
}

if (!names.length) {
  console.log('体积护栏：暂存区没有文件，跳过');
  process.exit(0);
}

const big = [];
for (const f of names) {
  let size = 0;
  try { size = Number(git(['cat-file', '-s', ':' + f]).trim()); } catch { continue; }  // 读不到就跳过（例如子模块）
  if (size > LIMIT) big.push({ f, size });
}

if (!big.length) {
  console.log(`体积护栏：暂存区 ${names.length} 个文件，全部 < ${LIMIT_MB} MB ✓`);
  process.exit(0);
}

big.sort((a, b) => b.size - a.size);
const list = big.map((x) => `  ${(x.size / 1048576).toFixed(1)} MB  ${x.f}`).join('\n');

if (MODE === 'drop') {
  for (const x of big) {
    try { git(['reset', '-q', 'HEAD', '--', x.f]); } catch (_) { /* 新增文件不在 HEAD 里也试过 */ }
  }
  // ::warning:: 会显示在 GitHub Actions 的运行摘要里（不是 error，不会让整条流程变红）
  console.log(`::warning::体积护栏：${big.length} 个文件超过 ${LIMIT_MB} MB，已从本次提交移除（其它文件照常提交，流程不中断）`);
  console.log(list);
  console.log('如果确实要提交它们：本地用 MAX_MB=999 node scripts/git-size-guard.mjs 通过后再 commit。');
  process.exit(0);
}

console.error(`体积护栏：${big.length} 个文件超过 ${LIMIT_MB} MB —— GitHub 50 MB 开始警告、100 MB 直接拒收 push`);
console.error(list);
console.error('先把它挪出仓库（或 MAX_MB=999 强制放行），别直接把 40 MB 的存档塞回去。');
process.exit(1);
