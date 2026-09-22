/**
 * 一次性脱敏：把 site/data/messages.json 里的第三方身份抹掉
 *
 *   node scripts/scrub-existing-messages.mjs
 *
 * 副作用：
 *   1. 原始全量先备份到 scraper/data/messages-full.json（gitignore，绝不入库），
 *      供 reparse / 将来重解析使用
 *   2. site/data/messages.json 就地替换为脱敏版
 *   3. 打印自检结果 —— 泄露数必须为 0
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubMessages, audit } from '../scraper/lib/scrub.mjs';
import { MEMBER } from '../scraper/lib/config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'site/data/messages.json');
const FULL = resolve(ROOT, 'scraper/data/messages-full.json');

const selfId = MEMBER.starId || MEMBER.userId;
// 有全量原始备份时优先用它，保证「从干净源头重跑」可重复
const INPUT = existsSync(FULL) ? FULL : SRC;
const parsed = JSON.parse(readFileSync(INPUT, 'utf8'));
const arr = Array.isArray(parsed) ? parsed : (parsed.messages || []);
console.log(`输入源：${INPUT === FULL ? 'scraper/data/messages-full.json（全量原始）' : 'site/data/messages.json'}`);

// 1) 先算出所有第三方 uid（用于事后自检）；昵称本身是纯数字的人要豁免
const known = new Set();
const nicks = new Set();
for (const m of arr) {
  if (m?.sender?.nickname) nicks.add(String(m.sender.nickname));
  if (m?.reply?.name) nicks.add(String(m.reply.name));
  try {
    const e = JSON.parse(m?.raw?.extInfo || '{}');
    if (e.user?.nickName) nicks.add(String(e.user.nickName));
  } catch { /* extInfo 非法 JSON，跳过 */ }
}
for (const m of arr) {
  const u = m?.sender?.userId;
  // 空字符串 uid（老数据缺字段）不参与自检，否则 "" 会命中任意空串导致假阳性
  if (u !== undefined && u !== '' && u !== null && String(u) !== String(selfId)) known.add(String(u));
  // sender.userId 为空的老数据：从 raw.extInfo.user.userId 补
  if (m?.raw?.extInfo) {
    try {
      const e = JSON.parse(m.raw.extInfo);
      const stack = [e];
      while (stack.length) {
        const n = stack.pop();
        if (!n || typeof n !== 'object') continue;
        if (n.userId !== undefined && String(n.userId) !== String(selfId)) known.add(String(n.userId));
        for (const v of Object.values(n)) if (v && typeof v === 'object') stack.push(v);
      }
    } catch { /* 忽略非法 JSON */ }
  }
}
for (const n of nicks) known.delete(n);   // 昵称恰好是纯数字 → 它不是泄露
console.log(`原始：${arr.length} 条消息，发现第三方 uid ${known.size} 个（已排除 ${nicks.size} 个数字昵称误判）`);

// 2) 备份全量（本地私密）
mkdirSync(dirname(FULL), { recursive: true });
writeFileSync(FULL, JSON.stringify(parsed), 'utf-8');
console.log(`全量原始已备份 → scraper/data/messages-full.json（gitignore）`);

// 3) 脱敏
const { messages, removed } = scrubMessages(arr, selfId);
console.log(`脱敏：处理 ${messages.length} 条，抹掉第三方 sender ${removed} 处`);

// 4) 自检：序列化后不得再出现任何第三方 uid 字面量
const payload = Array.isArray(parsed) ? messages : { ...parsed, messages };
const text = JSON.stringify(payload);
const { leakedCount, leaked } = audit(text, known);
console.log(leakedCount === 0
  ? '✅ 自检通过：0 处第三方 uid 残留'
  : `❌ 仍有 ${leakedCount} 处 uid 残留：${leaked.join(', ')}`);

writeFileSync(SRC, JSON.stringify(payload), 'utf-8');
const mb = (readFileSync(SRC).length / 1024 / 1024).toFixed(2);
console.log(`已写回 ${SRC}（${mb} MB）`);

// 5) 抽样对比展示
const before = arr.find((m) => m.sender && String(m.sender.userId) !== String(selfId));
const after = messages.find((m) => m.msgIdServer === before?.msgIdServer);
if (before && after) {
  console.log('\n样例对比：');
  console.log('  脱敏前 sender:', JSON.stringify(before.sender));
  console.log('  脱敏后 sender:', JSON.stringify(after.sender));
  console.log('  脱敏前 raw  :', String(before.raw?.extInfo || '').slice(0, 160));
  console.log('  脱敏后 raw  :', String(after.raw?.extInfo || '').slice(0, 160));
}
if (leakedCount) process.exitCode = 1;
