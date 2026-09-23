/*
 * 昵称 → uid 归户索引（全站唯一实现，2026-09-23 抽公用）。
 *
 * 背景：弹幕 LRC 的礼物播报只有「当时昵称」，没有 uid，必须靠历史昵称反查。
 * 同一个昵称可能被多个 uid 用过（改名后昵称被后来者复用），所以索引存的是
 * 「昵称 → Map(uid → 出现次数)」，取次数最多的那个作为归属，并返回归属比
 * （最多者 / 总数）供调用方判断可信度。
 *
 * 索引来源（三源合并）：
 *   1. .cache/fans/room.jsonl  口袋房间的发言 + 礼物记录（n / u 字段）
 *   2. .cache/fans/live.jsonl  官方直播榜 Top20（nick / u 字段，含 uid）
 *   3. .cache/fans/posts.jsonl 口袋动态的 @提及（mentions[]，官方 snh48://<uid> 绑定，
 *                              是质量最高的「uid ↔ 当时昵称」来源）
 *
 * ⚠️ 此前 build-fans.mjs 与 build-live-gift-rank.mjs 各写了一套归户逻辑，
 *    前者「取出现最多」（能归户），后者「必须唯一命中」（有歧义就丢），
 *    导致同一个「痞痞酱」（3482320959×738 / 127861557×7）在站点里算对了、
 *    在导出表里却是空 uid。统一到本模块后不会再出现两边不一致。
 */
import fs from 'node:fs';

export function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n')
    .map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
}

/**
 * 人工锁定表：昵称 → uid。站长在 App 内核实过的归属，优先级高于统计。
 * 为什么需要：模糊匹配会把「王语晨的歌迷」串到「王语晨的狗」这种相似昵称上
 * （2026-09-23 实测踩到）。文件含 uid，只存本地（已 gitignore）。
 */
export function loadPins(pinsPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(pinsPath, 'utf8'));
    const pins = new Map();
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('_')) continue;                 // _note / _cases 等注释键
      if (/^\d{4,12}$/.test(String(v))) pins.set(k, String(v));
    }
    return pins;
  } catch { return new Map(); }
}

/** 建立 昵称 → Map(uid → 次数) 索引（pinsPath 存在时套用人工锁定，优先级最高） */
export function buildNickUidIndex(cacheDir, pinsPath) {
  const index = new Map();
  const add = (nick, uid) => {
    if (!nick || !uid) return;
    if (String(uid) === '0') return;                 // 匿名池（神秘守护者）不建索引
    if (!index.has(nick)) index.set(nick, new Map());
    const m = index.get(nick);
    m.set(String(uid), (m.get(String(uid)) || 0) + 1);
  };
  for (const f of ['room.jsonl', 'live.jsonl']) {
    for (const r of readJsonl(cacheDir + '/' + f)) add(r.n || r.nick, r.u || r.uid);
  }
  for (const p of readJsonl(cacheDir + '/posts.jsonl')) {
    for (const m of (p.mentions || [])) add(m.n, m.u);
  }
  // 人工锁定最后套用，直接压倒统计结果（次数给一个大值，保证「占优 100%」）
  if (pinsPath) {
    for (const [nick, uid] of loadPins(pinsPath)) {
      index.set(nick, new Map([[uid, 1e9]]));
    }
  }
  return index;
}

/**
 * 归户单个昵称。
 * @returns {{uid: string|null, how: '唯一'|'占优'|'存疑'|'无来源', ratio: number,
 *            label: string, candidates: Array<[uid, count]>}}
 *   how 语义：唯一 = 只被一个 uid 用过；占优 = 有歧义但最多者占比 ≥ 80%；
 *             存疑 = 有歧义且最多者占比 < 80%（仍取最多者，但需人工复核）；
 *             无来源 = 索引里查不到这个昵称。
 */
export function resolveNick(index, nick) {
  const m = index.get(nick);
  if (!m || !m.size) return { uid: null, how: '无来源', ratio: 0, label: '无来源', candidates: [] };
  const e = [...m.entries()].sort((a, b) => b[1] - a[1]);
  if (e.length === 1) return { uid: e[0][0], how: '唯一', ratio: 1, label: '唯一命中', candidates: e };
  const total = e.reduce((a, x) => a + x[1], 0);
  const ratio = e[0][1] / total;
  if (ratio >= 0.8) {
    return { uid: e[0][0], how: '占优', ratio, label: `占优 ${(ratio * 100).toFixed(1)}%`, candidates: e };
  }
  return { uid: e[0][0], how: '存疑', ratio, label: `存疑 ${(ratio * 100).toFixed(1)}%`, candidates: e };
}
