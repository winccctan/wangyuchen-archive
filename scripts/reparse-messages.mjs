// 历史数据重解析：把 site/data/messages.json 里每条消息的 raw 用最新的
// parseMessage 重新解析一遍（不需要重新抓取口袋接口）。
//
// 背景：早期版本的解析只认「bodys 不是 JSON」的纯文本，导致 REPLY / GIFTREPLY /
// AUDIO / VIDEO / 表情包 / 分享卡片 等全部退化成「无文本内容」。
// raw.bodys 与 raw.extInfo 在存档里是完整保留的，因此可以离线补全。
//
// 用法：node scripts/reparse-messages.mjs
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseMessage } from '../scraper/lib/message.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, '..', 'site', 'data', 'messages.json');
const BAK = `${FILE}.bak`;

const conf = JSON.parse(readFileSync(FILE, 'utf8'));
const list = conf.messages || [];
if (!list.length) {
  console.error('messages.json 为空，退出');
  process.exit(1);
}

if (!existsSync(BAK)) {
  copyFileSync(FILE, BAK);
  console.log(`已备份原始文件 → ${BAK}`);
}

let repairedText = 0;
let repairedMedia = 0;
let repairedReply = 0;
let repairedCard = 0;
let stillEmpty = 0;
const emptyBefore = list.filter((m) => !m.text).length;

const out = list.map((m) => {
  const raw = {
    msgIdServer: m.msgIdServer,
    msgTime: m.msgTime,
    msgType: m.raw?.msgType || m.msgType,
    bodys: m.raw?.bodys,
    extInfo: m.raw?.extInfo
  };
  const next = parseMessage(raw);

  const hadText = !!m.text;
  const hadMedia = !!(m.images?.length || m.audio || m.video || m.link);
  const hadReply = !!m.reply;
  const hadCard = !!m.card;

  if (!hadText && next.text) repairedText++;
  if (!hadMedia && (next.images.length || next.audio || next.video || next.link)) repairedMedia++;
  if (!hadReply && next.reply) repairedReply++;
  if (!hadCard && next.card) repairedCard++;
  if (!next.text && !next.reply && !next.card && !next.images.length && !next.audio && !next.video && !next.link) stillEmpty++;

  return next;
});

writeFileSync(FILE, JSON.stringify({ ...conf, messages: out }, null, 2), 'utf8');

const typeStats = {};
for (const m of out) typeStats[m.msgType] = (typeStats[m.msgType] || 0) + 1;
const emptyByType = {};
for (const m of out) {
  const empty = !m.text && !m.reply && !m.card && !m.images.length && !m.audio && !m.video && !m.link;
  if (empty) emptyByType[m.msgType] = (emptyByType[m.msgType] || 0) + 1;
}

console.log(`✓ 重解析完成，共 ${out.length} 条`);
console.log(`  补回正文 ${repairedText} 条 | 补回媒体 ${repairedMedia} 条 | 补回引用 ${repairedReply} 条 | 补回卡片 ${repairedCard} 条`);
console.log(`  空内容：${emptyBefore} → ${stillEmpty}`);
console.log('  剩余空内容按类型：', JSON.stringify(emptyByType));
