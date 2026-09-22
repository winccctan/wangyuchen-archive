/**
 * 身份脱敏 —— 口袋48 侧所有用户数据上线前的唯一出口
 *
 * 红线（站长 2026-09-22 定）：
 *   口袋48 侧的一切第三方用户身份（uid / avatar / level / 主页地址）不得出现在任何
 *   线上可访问的地方（CDN 静态文件、公开仓库、API 响应、KV / D1）。
 *   只有本人 userId（公开 starId）可以保留。
 *   昵称属于「已公开在房间里说过的话」的一部分，保留。
 *   社媒侧数据不归本模块管（社媒本身就是公开渠道）。
 *
 * 用法：
 *   import { scrubMessages } from './scrub.mjs';
 *   messages = scrubMessages(messages, MEMBER.starId);
 */

// 需要抹掉的身份类字段（命中且值不等于本人 id 时删除）
const ID_KEYS = new Set([
  'userId', 'uid', 'userid', 'Uid', 'UserId',
  'pfUrl',            // 个人主页地址，含 uid
  'level', 'vip', 'vipLevel', 'roleId', 'roleid',
  'teamLogo',         // 队伍角标，间接指向身份
]);
// 明确要保留的关键信息（不能被上面的规则误伤）
const KEEP_KEYS = new Set(['nickName', 'nickname', 'name', 'nick']);

// 图片类字段：路径里可能以 uid 开头（红包封面 / 头像）→ 归属非本人时整字段删除
const PATH_KEYS = new Set([
  'avatar', 'avatarUrl', 'headImgUrl',
  'pic', 'coverUrl', 'image', 'img', 'imageUrl', 'thumbnail', 'cover',
]);

/**
 * 找出图片路径里隐含的「属主 uid」
 *   /avatar/2025/0119/63xezg4ldmwvdmr41ff71jp00o.jpg  -> 63
 *   /2026/0213/826829x7rb0awmfm0cn2yz8wy4bnp1.jpg    -> 826829
 * @returns {string|null}
 */
export function pathOwner(val) {
  if (typeof val !== 'string') return null;
  // /avatar/2025/0119/63x... 或 /2026/0213/826829x...（第二段是「月日」四位）
  const m = val.match(/^\/?(?:avatar\/)?\d{4}\/\d{2,4}\/(\d{4,12})(?=[a-z0-9])/);
  return m ? m[1] : null;
}

/**
 * 递归清洗任意对象里的第三方身份字段。
 * - userId / uid 等：等于 selfId 保留，否则删除
 * - avatar：路径里通常含 userId 前缀，非本人的一律删除
 * @param {any} node
 * @param {(string|number)} selfId
 * @param {number} depth
 */
function scrubDeep(node, selfId, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return node;
  if (Array.isArray(node)) {
    for (const item of node) scrubDeep(item, selfId, depth + 1);
    return node;
  }
  for (const key of Object.keys(node)) {
    const val = node[key];

    // 任何以 / 开头的路径值，只要隐含他人 uid → 整字段删除（对象形态）
    if (typeof val === 'string' && val.startsWith('/')) {
      const owner = pathOwner(val);
      if (owner && String(owner) !== String(selfId)) { delete node[key]; continue; }
    }

    // 图片 / 头像类（含数组）：逐条筛，归属非本人的剔除
    if (PATH_KEYS.has(key) && (typeof val === 'string' || Array.isArray(val))) {
      const list = Array.isArray(val) ? val : [val];
      const keep = list.filter((v) => {
        const owner = pathOwner(v);
        return owner === null || String(owner) === String(selfId);
      });
      if (Array.isArray(val)) node[key] = keep;
      else delete node[key];
      continue;
    }
    if (key === 'avatar' || key === 'avatarUrl' || key === 'headImgUrl') continue; // 已被上面处理

    if (ID_KEYS.has(key) && !KEEP_KEYS.has(key)) {
      const isSelf = String(val) === String(selfId);
      // 纯数字 id 且不是本人 → 抹掉；布尔类（vip:false）留着无害，也一并抹掉求稳
      if (!isSelf && (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean')) {
        delete node[key];
        continue;
      }
    }

    if (typeof val === 'object' && val !== null) scrubDeep(val, selfId, depth + 1);
  }
  return node;
}

/**
 * 字符串层面的 URL 清洗：把隐含第三方 uid 的图片值清空（保留键，结构不变）
 * 用于 raw.bodys / extInfo 这类「JSON 字符串」字段 —— 不走 JSON 往返，
 * 因为 bodys 里有 packetId 大于 2^53 的大整数，parse+stringify 会掉精度。
 *   "...\"coverUrl\":\"/2026/0213/826829x7rb...jpg\"" -> "...\"coverUrl\":\"\""
 */
export function scrubUrlInText(str, selfId) {
  if (typeof str !== 'string') return str;
  // 不枚举字段名（coverUrl / pic / openImgUrl / ***Url 会不断冒出来），
  // 改成按「值的形态」判定：任意键的值只要是一条隐含他人 uid 的路径 → 清空
  return str.replace(
    /"([A-Za-z_][\w]*)":"(\/[a-zA-Z0-9][^"]*)"/g,
    (full, key, val) => {
      const owner = pathOwner(val);
      return owner && String(owner) !== String(selfId) ? `"${key}":""` : full;
    }
  );
}

/** 清洗 raw：逐字段处理，extInfo 额外做 JSON 级精洗 */
function scrubRaw(raw, selfId) {
  if (!raw || typeof raw !== 'object') return raw;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') {
      out[k] = scrubUrlInText(v, selfId);
    } else if (v && typeof v === 'object') {
      out[k] = scrubDeep(JSON.parse(JSON.stringify(v)), selfId);
    } else {
      out[k] = v;
    }
  }
  // extInfo 再做一次 JSON 级精洗（上面的正则只覆盖了图片/@人结构）
  if (typeof out.extInfo === 'string') {
    try {
      out.extInfo = JSON.stringify(scrubDeep(JSON.parse(out.extInfo), selfId));
    } catch {
      out.extInfo = '';
    }
  }
  return out;
}

/**
 * 清洗单条房间消息
 * @param {object} m
 * @param {(string|number)} selfId 本人 userId（公开 starId）
 */
export function scrubMessage(m, selfId) {
  if (!m || typeof m !== 'object') return m;
  const out = { ...m };

  // ── sender ────────────────────────────────────────────────
  if (out.sender && typeof out.sender === 'object') {
    const isSelf = String(out.sender.userId) === String(selfId);
    if (isSelf) {
      out.sender = { self: true, userId: out.sender.userId, nickname: out.sender.nickname, avatar: out.sender.avatar };
    } else {
      // 第三方：只保留昵称
      out.sender = { nickname: out.sender.nickname };
    }
  }

  // ── reply：本身只有 name / text，再兜一层底 ────────────────
  if (out.reply && typeof out.reply === 'object') {
    out.reply = { name: out.reply.name, text: out.reply.text };
    if (out.reply.name === undefined) delete out.reply.name;
  }

  // ── raw：整个原始报文，98% 的 uid 藏在这里 ─────────────────
  if (out.raw) out.raw = scrubRaw(out.raw, selfId);

  // ── 兜底：thumbnails / images / card / 红包字段等任何角落 ───
  return scrubDeep(out, selfId);
}

/**
 * 批量清洗 + 自检
 * @returns {{messages: object[], removed: number}} removed = 抹掉的 third-party 身份字段次数
 */
export function scrubMessages(list, selfId) {
  let removed = 0;
  const messages = (list || []).map((m) => {
    const before = m && m.sender ? m.sender.userId : undefined;
    const out = scrubMessage(m, selfId);
    if (before !== undefined && String(before) !== String(selfId)) removed++;
    return out;
  });
  return { messages, removed };
}

/**
 * 泄露自检：扫一遍序列化后的文本，找出任何残留的第三方 uid 字面量
 * @param {any} data 任意待上线的数据
 * @param {Set<string>} knownUids 已知的第三方 uid 集合（用于验证是否漏网）
 */
export function audit(data, knownUids = new Set()) {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  const leaked = [];
  for (const uid of knownUids) {
    // 只认「结构化」出现的位置：作为字符串值 / 数字值 / 路径首段。
    // 不认 UUID、md5、纯数字昵称里的片段，避免误报刷屏。
    const probes = [
      `"${uid}"`,          // "123456"
      `:${uid}(?=[,}\\]])`, // :123456,
      `/${uid}(?=[a-z0-9])`, // /123456x...（图片路径）
    ];
    if (probes.some((p) => new RegExp(p).test(text))) leaked.push(uid);
  }
  return { leakedCount: leaked.length, leaked: leaked.slice(0, 20) };
}
