// 口袋48 消息解析（共用模块）
// 被 scrape.mjs（新抓取）与 scripts/reparse-messages.mjs（历史数据重解析）共用。
//
// 背景：口袋里不同 msgType 的 bodys 结构完全不同，早期版本只把
// 「bodys 不是 JSON」的情况当正文，导致 REPLY / GIFTREPLY / AUDIO 等
// 全部退化成「无文本内容」。这里按类型精确提取：
//   REPLY            → replyInfo.text 是她的回复正文，replyInfo.replyText 是被回复的原话
//   GIFTREPLY        → giftReplyInfo.text 是感谢语，replyText 是礼物信息
//   AUDIO_GIFT_REPLY → giftReplyInfo.voiceUrl 是语音回复
//   AUDIO / VIDEO / IMAGE / EXPRESSIMAGE → bodys.url 或 expressImgInfo.emotionRemote
//   LIVEPUSH / SHARE_POSTS / RED_PACKET_* → 卡片信息

export function safeJson(str) {
  if (typeof str !== 'string') return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const MEDIA_RE = {
  video: /\.(mp4|m3u8|mov|webm)(\?|$)/i,
  audio: /\.(mp3|m4a|wav|amr|aac|ogg)(\?|$)/i,
  image: /\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i
};

const isUrl = (v) => typeof v === 'string' && /^(https?:)?\/\//i.test(v);

// 从对象里按 key 优先级取字符串值
function pick(o, keys) {
  if (!o) return '';
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function pickAny(objList, keys) {
  for (const o of objList) {
    const v = pick(o, keys);
    if (v) return v;
  }
  return '';
}

function mkReply(ri) {
  const name = pick(ri, ['replyName', 'replyUserName', 'userName', 'nickname']);
  const text = pick(ri, ['replyText', 'replyContent', 'text', 'content']);
  if (!name && !text) return null;
  return { name, text };
}

// 深度兜底扫描：把所有像 URL 的字符串按扩展名 / 域名归类
function deepCollect(v, out, depth = 0) {
  if (depth > 6 || v == null) return;
  if (typeof v === 'string') {
    if (!isUrl(v)) return;
    if (MEDIA_RE.video.test(v)) (out.videos ||= []).push(v);
    else if (MEDIA_RE.audio.test(v)) (out.audios ||= []).push(v);
    else if (MEDIA_RE.image.test(v)) (out.images.push(v));
    else if (/48\.cn|yunxinsvr|nosdn/i.test(v)) (out.others ||= []).push(v);
    else if (!out.link) out.link = v;
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x) => deepCollect(x, out, depth + 1));
    return;
  }
  if (typeof v === 'object') {
    // 已知的媒体键优先
    const knownKeys = ['url', 'src', 'voiceUrl', 'emotionRemote', 'imageUrl', 'originUrl', 'playUrl',
      'fileUrl', 'coverPath', 'coverUrl', 'sharePic', 'liveCover', 'path'];
    for (const k of knownKeys) if (v[k]) deepCollect(v[k], out, depth + 1);
    for (const [k, val] of Object.entries(v)) {
      if (knownKeys.includes(k)) continue;
      deepCollect(val, out, depth + 1);
    }
  }
}

/**
 * 把接口返回的一条原始消息规范化成前端可渲染的结构。
 * @param {object} raw 口袋48 /api/message 返回的单条消息
 */
export function parseMessage(raw) {
  const bodyRaw = raw?.bodys;
  const bodyParsed = safeJson(bodyRaw);
  const bodyObj = asObj(bodyParsed);
  const extObj = asObj(safeJson(raw?.extInfo)) || {};
  const msgType = raw?.msgType || 'UNKNOWN';

  const out = {
    text: '',
    reply: null,
    images: [],
    audio: '',
    video: '',
    link: '',
    card: null,
    duration: 0
  };

  // bodys 不是 JSON 对象时（含 "5" 这种纯数字被 JSON.parse 吃掉的情况）原样作为正文
  const plain = typeof bodyRaw === 'string' && !bodyObj ? bodyRaw : '';
  const plainTrim = str(plain) || (typeof bodyParsed === 'number' ? String(bodyParsed) : '');

  switch (msgType) {
    case 'REPLY':
    case 'FLIPCARD':
    case 'FLIPCARD_AUDIO':
    case 'FLIPCARD_VIDEO': {
      const ri = asObj(bodyObj?.replyInfo) || asObj(bodyObj?.flipCardInfo) || bodyObj || {};
      out.text = pick(ri, ['text', 'replyText', 'content']) || plainTrim;
      // 翻牌/回复：text 她的回答，replyText 粉丝原话
      const qName = pick(ri, ['replyName', 'userName', 'nickname']);
      const qText = pick(ri, ['replyText', 'question', 'content']);
      if (qName || qText) out.reply = { name: qName, text: qText };
      // 翻牌可能带语音/图片
      const vu = pick(ri, ['voiceUrl', 'audioUrl', 'videoUrl']);
      if (vu) {
        if (MEDIA_RE.video.test(vu)) out.video = vu;
        else out.audio = vu;
      }
      out.duration = num(ri.duration) * 1000; // duration 单位为秒，统一成毫秒
      break;
    }

    case 'GIFTREPLY':
    case 'AUDIO_GIFT_REPLY': {
      const gi = asObj(bodyObj?.giftReplyInfo) || asObj(bodyObj?.replyInfo) || bodyObj || {};
      out.text = pick(gi, ['text', 'content']) || plainTrim;
      out.reply = mkReply(gi);
      const vu = pick(gi, ['voiceUrl', 'audioUrl', 'url']);
      if (vu) out.audio = vu;
      out.duration = num(gi.duration) * 1000; // duration 单位为秒，统一成毫秒
      break;
    }

    case 'AUDIO': {
      out.audio = pickAny([bodyObj, bodyObj?.ext], ['url', 'voiceUrl', 'audioUrl']) || plainTrim;
      out.duration = num(bodyObj?.dur); // 已是毫秒
      break;
    }

    case 'VIDEO': {
      out.video = pickAny([bodyObj, bodyObj?.ext], ['url', 'videoUrl', 'playUrl']) || plainTrim;
      out.duration = num(bodyObj?.dur); // 已是毫秒
      const cover = pick(bodyObj, ['cover', 'coverPath', 'coverUrl']);
      if (cover) out.images.push(cover);
      break;
    }

    case 'IMAGE': {
      const u = pick(bodyObj, ['url', 'imageUrl', 'originUrl', 'src']) || plainTrim;
      if (u) out.images.push(u);
      break;
    }

    case 'EXPRESSIMAGE':
    case 'EXPRESS': {
      const info = asObj(bodyObj?.expressImgInfo) || asObj(bodyObj?.expressInfo) || bodyObj || {};
      const u = pick(info, ['emotionRemote', 'url', 'imageUrl', 'src']);
      if (u) out.images.push(u);
      break;
    }

    case 'LIVEPUSH':
    case 'OPEN_LIVE': {
      const li = asObj(bodyObj?.livePushInfo) || bodyObj || {};
      out.card = {
        kind: 'live',
        title: pick(li, ['liveTitle', 'title']) || '开播啦',
        desc: '',
        pic: pick(li, ['liveCover', 'cover', 'coverUrl']),
        url: pick(li, ['shortPath', 'jumpPath'])
      };
      break;
    }

    case 'SHARE_POSTS': {
      const si = asObj(bodyObj?.shareInfo) || bodyObj || {};
      out.card = {
        kind: 'share',
        title: pick(si, ['shareTitle', 'title']) || '分享',
        desc: pick(si, ['shareDesc', 'desc']),
        pic: pick(si, ['sharePic', 'pic', 'coverUrl']),
        url: pick(si, ['jumpPath', 'url'])
      };
      break;
    }

    default: {
      if (/^RED_PACKET/.test(msgType) || msgType === 'ZHONGQIU_ACTIVITY_LANTERN_FANS') {
        out.card = {
          kind: 'redpacket',
          title: pick(bodyObj, ['blessMessage', 'title']) || '红包',
          desc: pick(bodyObj, ['creatorName']) ? `来自 ${pick(bodyObj, ['creatorName'])}` : '',
          pic: pick(bodyObj, ['coverUrl', 'cover', 'openImgUrl']),
          url: ''
        };
      } else {
        // 兜底：仍尝试把 bodys 当正文
        out.text = plainTrim;
      }
    }
  }

  // 兜底扫描：正文/引用/卡片都没内容时，深挖 bodys 里的媒体与链接
  const hasContent = out.text || out.reply || out.card ||
    out.images.length || out.audio || out.video || out.link;
  if (!hasContent) {
    const bag = { images: [] };
    deepCollect(bodyObj ?? bodyParsed, bag);
    if (bag.images.length) out.images = bag.images;
    if (bag.audios?.length) out.audio = bag.audios[0];
    if (bag.videos?.length) out.video = bag.videos[0];
    if (!out.link) out.link = bag.others?.[0] || bag.link || '';
    if (!out.text && typeof bodyParsed === 'string') out.text = str(bodyParsed);
  }

  // 发送者：口袋是 extInfo.user（注意 nickName 大写 N）
  const sender = asObj(extObj.user) || asObj(extObj.userInfo) || asObj(extObj.sender) || {};
  const nickname = pick(sender, ['nickName', 'nickname', 'userName', 'name']);

  return {
    msgIdServer: raw?.msgIdServer,
    msgTime: num(raw?.msgTime),
    msgType,
    text: out.text,
    reply: out.reply,
    images: out.images,
    audio: out.audio,
    video: out.video,
    link: out.link,
    card: out.card,
    duration: out.duration,
    sender: {
      userId: sender.userId || sender.sourceId || '',
      nickname,
      avatar: pick(sender, ['avatar', 'userAvatar'])
    },
    raw: {
      bodys: raw?.bodys,
      extInfo: raw?.extInfo,
      msgType
    }
  };
}
