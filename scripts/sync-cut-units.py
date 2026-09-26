#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 B 站「她的公演 cut」的分 P unit 曲目并入曲目库 site/js/songs.js（**幂等，只加不删**）

背景：曲目库 songs.js 原本由 /tmp/gen_songs_js.py 一次性灌入（xlsx 真曲目清单 + 微博应援会
+ 站长给的 Chzhnh cut 分P表 406 条）。它不会自己更新 —— 之后 UP 新传的 cut（含他在 2026-09
陆续补传的 2022 老档）都进不了曲目。本脚本补上这条增量通道。

数据分层：
  scripts/cut-units.json   本次及以后解析出来的 unit 清单（仓库内的**源数据**，可累积、可人工改）
                           字段：[{bvid, p, d, occ, song, type}]
  scripts/cut-units-scanned.json  已扫过分 P 的 BV 清单（避免重复请求；换 `--all` 可全量重扫）
  site/js/songs.js         站点曲目库（生成物，本脚本只做**增量合并**）
  site/data/archive.js     日期 → 场次 liveId 的唯一真相（🔴 不是 performances.json：
                           performances.json 缺 2022-10-21 这类场次，只看它会误判「没这一场」）

用法：
  python3 scripts/sync-cut-units.py --fetch [--only=BV1fRhD6xEvc] [--all]
      从 site/data/bili-videos.json 取 UP「Chzhnh」投稿里她的「公演cut / 云公演」，
      逐个调 B 站分 P 接口 https://api.bilibili.com/x/player/pagelist?bvid=... 解析 unit，
      追加进 scripts/cut-units.json（按 bvid+p 去重）。默认**只处理新的**（cut-units.json 里没有的 BV）；
      --all 强制全部重扫。
  python3 scripts/sync-cut-units.py [--dry] [--target=demo|prod]
      合并进曲目库 → 写 site/js/songs.js 与 dist/js/songs.js → 给 index.html 的 songs.js?v= 升版本号。
      --dry 只打印将新增的「场次 → 曲目」，不写任何文件。

合并规则（与 /tmp/gen_songs_js.py 保持一致，避免同一首歌出两个名字）：
  - 类型前缀 `unit:` `助演:` `MVP舞台:` `生日表演:` … 一律剥掉只留曲名
  - `游戏环节` `MC` `开场读须知` `全程` `返场` 这类不是曲目，丢弃
  - 括号里是成员名 / 场合注释，剥掉
  - 新曲名先和已有 198 首做「规范化 + 最长公共子串」匹配，命中就归到老名字下
  - 找不到对应公演场次的日期不动声色跳过（打印出来），不产生假数据
"""
import json, os, re, sys, time, urllib.request, datetime, shutil, argparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UNITS = os.path.join(ROOT, 'scripts', 'cut-units.json')
# 「已经扫过分 P 的 BV」清单。存在的意义：把历史上那 133 条老 cut 标记为「已看过」，
# 免得第一次接 CI 就把几百首歌一次性灌进曲目库（没人工核对过的新Project／脏写法会污染曲目）。
# 想补老账就用 `--all`（会忽略这个清单，全量重扫）。
SCANNED = os.path.join(ROOT, 'scripts', 'cut-units-scanned.json')
VIDEOS = os.path.join(ROOT, 'site', 'data', 'bili-videos.json')
ARCHIVE = os.path.join(ROOT, 'site', 'data', 'archive.js')
SONGS_SITE = os.path.join(ROOT, 'site', 'js', 'songs.js')
SONGS_DIST = os.path.join(ROOT, 'dist', 'js', 'songs.js')
INDEX_SITE = os.path.join(ROOT, 'site', 'index.html')
INDEX_DIST = os.path.join(ROOT, 'dist', 'index.html')

CH_MID = '358477444'                       # UP「Chzhnh」
KEEP = re.compile(r'公演\s*cut|云公演', re.I)
HER = re.compile(r'王语晨')

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'


def bj(ms, fmt='%Y-%m-%d %H:%M'):
    return (datetime.datetime.fromtimestamp(int(ms) / 1000, datetime.UTC)
            + datetime.timedelta(hours=8)).strftime(fmt)


# ---------------------------------------------------------------- 分 P 解析
# 🔴 分 P 名 ≠ 曲目：UP 会把「自我介绍 / 生日环节 / MC / 抽奖」这类也标成 unit:xxx，
#    抽出来得进曲目库就得逐个人工核对 ⇒ 这些明显是「环节」的一律丢。
#    ⚠️ 这正是历史 133 条老 cut 不自动全量灌的原因（实测第一条就抽出「90秒认识新宝宝」——那是新成员介绍环节）。
BAD_PART = re.compile(r'环节|读信|^生日|全程|返场|^MC|【|^\d{6,}'
                      r'|认识新宝宝|自我介绍|新宝宝|生日祝福|生日信|生日蛋糕'
                      r'|感言|致辞|寄语|发言|抽奖|连线|问答|投稿|回顾|花絮|片头|片尾|预告|工作人员', re.I)
# 类型前缀：`unit:糖` → 糖（与已有 406 条同口径）
# 🔴 分隔符必须**可选**：Chzhnh 有一部分分 P 直接写 `unit米迦勒`（没冒号），
#    剥不掉就会以「unit米迦勒」这种脏名字进曲目库，跟已有的「米迦勒」变成两首歌。
PREFIX_RE = re.compile(r'^(大歌|unit|乐曜曲|助演|前座曲|才艺表演|MVP舞台|两分半|生日表演)\s*[:：·\-\s]*', re.I)


def part_to_songs(part):
    """分 P 标题 → 曲目列表（0 首表示这条不是曲目）"""
    n = re.sub(r'[\u2019\u2018\u00b4\u0301\u0060]', "'", str(part or '').strip())
    n = re.sub(r'[《》]', '', n)
    n = re.sub(r'[（(][^）)]*[）)]', '', n)          # 剥括号（成员名 / 场合注释）
    n = PREFIX_RE.sub('', n.strip())                 # 剥 `unit:` 这类前缀
    n = n.strip().strip('：:·-— ').strip()
    if not n or BAD_PART.search(n):
        return []
    out = []
    for seg in re.split(r'[&+＋、/]', n):            # 「不放手&不负众望」是两首
        p = seg.strip()
        if not p or BAD_PART.search(p):
            continue
        # 纯 ASCII 的曲名统一大写（站长 2026-09-26 要求）
        out.append((p.upper() if re.fullmatch(r"[0-9A-Za-z\s'´`\-\.&/]+", p) else p))
    return out


def http_json(url, referer):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Referer': referer, 'Origin': 'https://www.bilibili.com',
        'Accept': 'application/json, text/plain, */*'})
    if os.environ.get('NO_PROXY'):
        req = urllib.request.Request(url, headers=dict(req.headers))
    try:
        op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        return json.loads(op.open(req, timeout=25).read().decode('utf-8'))
    except Exception as e:
        print('   ! 请求失败 %s: %s' % (url, e))
        return None


def fetch(args):
    if not os.path.exists(VIDEOS):
        print('缺少', VIDEOS); return 1
    vids = json.load(open(VIDEOS, encoding='utf-8'))['videos']
    mine = [v for v in vids if str(v.get('mid') or v.get('owner', {}).get('mid') or '') == CH_MID
            and HER.search(v.get('title') or '') and KEEP.search(v.get('title') or '')]
    print('Chzhnh 投稿里她的「公演cut / 云公演」共 %d 条' % len(mine))

    old = json.load(open(UNITS, encoding='utf-8')) if os.path.exists(UNITS) else []
    scanned = set(json.load(open(SCANNED, encoding='utf-8'))) if os.path.exists(SCANNED) else set()
    seen = {(u.get('bvid'), str(u.get('p'))) for u in old}
    known_bv = {u.get('bvid') for u in old}

    todo = []
    for v in mine:
        bv = v.get('bvid') or v.get('BV号') or ''
        if not bv:
            continue
        if args.only and bv != args.only:
            continue
        if not args.all and (bv in known_bv or bv in scanned):
            continue
        todo.append((bv, v.get('title') or ''))

    print('待扫 %d 条%s' % (len(todo), ('（限定 %s）' % args.only) if args.only else ''))
    added, skipped = [], []
    for i, (bv, title) in enumerate(todo, 1):
        d = re.search(r'(\d{4})(\d{2})(\d{2})', title)          # 日期优先取标题里的 8 位
        day = ('%s-%s-%s' % d.groups()) if d else ''
        url = ('https://api.bilibili.com/x/player/pagelist?bvid=%s&jsonp=jsonp' % bv)
        r = http_json(url, 'https://www.bilibili.com/video/' + bv)
        pages = (r or {}).get('data') or []
        got = 0
        for p in pages:
            for song in part_to_songs(p.get('part')):
                key = (bv, str(p.get('page')))
                if key in seen:
                    continue
                seen.add(key)
                old.append({'bvid': bv, 'p': p.get('page'), 'd': day, 'occ': '',
                            'song': song, 'type': 'unit'})
                added.append([day, bv, 'P%s' % p.get('page'), song])
                got += 1
        skipped.append([bv, len(pages), got])
        print('  [%d/%d] %s %s  分P=%d 提取unit=%d' % (i, len(todo), bv, title[:28], len(pages), got))
        scanned.add(bv)                              # 扫过就记下，下次不再白请求
        time.sleep(1.2)                              # 别惹风控

    json.dump(old, open(UNITS, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    json.dump(sorted(scanned), open(SCANNED, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('\n新增 %d 条 unit → %s（现共 %d 条）' % (len(added), os.path.basename(UNITS), len(old)))
    for a in added:
        print('   ', a)
    return 0


# ---------------------------------------------------------------- 曲名归一（避免同一首出两个名字）
def norm(s):
    return re.sub(r'[^0-9a-z\u4e00-\u9fff]', '', str(s or '').lower())


def lcs_len(a, b):
    if not a or not b:
        return 0
    prev = [0] * (len(b) + 1)
    best = 0
    for i in range(1, len(a) + 1):
        cur = [0] * (len(b) + 1)
        for j in range(1, len(b) + 1):
            if a[i - 1] == b[j - 1]:
                cur[j] = prev[j - 1] + 1
                best = max(best, cur[j])
        prev = cur
    return best


def canon(song, idx):
    """新曲名 → 曲库里的规范名（idx = {norm: 原名}）"""
    k = norm(song)
    if k in idx:
        return idx[k]
    best, bl = None, 0
    for kk, nn in idx.items():
        l = lcs_len(k, kk)
        if l >= 2 and l / max(len(k), len(kk)) >= 0.6 and l > bl:
            best, bl = nn, l
    if best:
        return best
    idx.setdefault(k, song)
    return song


def py_of(name):
    from pypinyin import lazy_pinyin, Style
    s = str(name).strip()
    if not s:
        return ['', '', '#']
    extra = ''.join(re.findall(r'[（(]([^）)]*)[）)]', s))
    extra = re.sub(r'[^a-z0-9]', '', extra.lower())
    base = re.sub(r'[（(][^）)]*[）)]', '', s).strip() or s
    letter, full, abbr = '#', '', ''
    if re.match(r'[A-Za-z]', base[0]):
        low = re.sub(r'[^a-z0-9]', '', base.lower())
        full, abbr, letter = low, low, base[0].upper()
    elif re.findall(r'[\u4e00-\u9fff]', base):
        full = re.sub(r'[^a-z0-9]', '', ''.join(lazy_pinyin(base)).lower())
        abbr = re.sub(r'[^a-z0-9]', '', ''.join(lazy_pinyin(base, style=Style.FIRST_LETTER)).lower())
        letter = (abbr[0].upper() if abbr else '#')
    if not full:
        full = base.lower()
    return [full + extra, abbr + extra, letter]


def load_songs(path):
    s = open(path, encoding='utf-8').read()
    head = 'window.__SONGS__ = '
    body = s[s.index(head) + len(head):s.rindex(';')]
    return json.loads(body), head


def load_archive():
    s = open(ARCHIVE, encoding='utf-8').read()
    return json.loads(s[s.index('{'):s.rindex('}') + 1])['performances']


def pick_live(day, perfs, title_hint=''):
    """某天的公演场次 → liveId。同日多场用剧目名二次匹配；匹配不了返回 None（不乱挂）"""
    same = [p for p in perfs if p.get('stime') and bj(p['stime']).startswith(day)]
    if len(same) == 1:
        return same[0]
    if len(same) > 1:
        m = re.search(r'《([^》]+)》', title_hint or '')
        if m:
            hit = [p for p in same if m.group(1) in ((p.get('subTitle') or '') + (p.get('title') or ''))]
            if len(hit) == 1:
                return hit[0]
        return None
    return None


def merge(args):
    if not os.path.exists(UNITS):
        print('没有 %s，先跑 --fetch 或手工建' % UNITS); return 1
    units = json.load(open(UNITS, encoding='utf-8'))
    d, head = load_songs(SONGS_SITE)
    perfs = load_archive()

    idx = {norm(k): k for k in d['bySong']}
    added, nomatch = [], []
    new_lids = set()
    for u in units:
        day, raw_song = u.get('d') or '', u.get('song')
        if not day or not raw_song:
            continue
        song = canon(raw_song, idx)
        p = pick_live(day, perfs, '')
        if not p:
            nomatch.append([day, song, '当天没有唯一对应的公演场次'])
            continue
        lid = str(p['liveId'])
        if lid not in d['info']:
            d['info'][lid] = {'d': day, 't': bj(p['stime'], '%H:%M'),
                              'n': (p.get('subTitle') or p.get('title') or '公演').strip()}
            new_lids.add(lid)
        if song in (d['byLive'].get(lid) or []):
            continue                                  # 已有，跳过（幂等）
        d['byLive'].setdefault(lid, []).append(song)
        d['bySong'].setdefault(song, []).append(lid)
        if song not in d['py']:
            d['py'][song] = py_of(song)
        added.append([day, (p.get('subTitle') or p.get('title') or '')[:26], song])

    if not added:
        print('没有需要新增的曲目（已全部收录）')
        for n in nomatch[:20]:
            print('   跳过:', n)
        return 0

    # order 重算（= [曲名, 场次数] 降序）
    d['order'] = sorted([[k, len(v)] for k, v in d['bySong'].items()], key=lambda x: (-x[1], x[0]))
    # 🔴 stat 不能按现有数据重算：它的 rows 是「源表行数」（去重前），perfs 与 len(info) 口径也不一致，
    #    各自保持原口径 + 本次增量即可，否则历史数字会整体漂移。
    st = dict(d.get('stat') or {})
    st['rows'] = int(st.get('rows') or 0) + len(added)
    st['perfs'] = int(st.get('perfs') or 0) + len(new_lids)
    st['songs'] = len(d['bySong'])
    d['stat'] = st

    print('将新增 %d 条：' % len(added))
    for a in added:
        print('   %s  %s  →  %s' % (a[0], a[1], a[2]))
    print('曲目库：%d 场 / %d 条 / %d 首' % (st['perfs'], st['rows'], st['songs']))
    if nomatch:
        print('没对上场次的 %d 条：' % len(nomatch))
        for n in nomatch[:20]:
            print('   ', n)
    if args.dry:
        print('\n[dry] 未写文件')
        return 0

    out = head + json.dumps(d, ensure_ascii=False, separators=(',', ':')) + ';\n'
    open(SONGS_SITE, 'w', encoding='utf-8').write(out)
    shutil.copyfile(SONGS_SITE, SONGS_DIST)
    print('已写 %s → %s' % (SONGS_SITE, SONGS_DIST))

    stamp = datetime.datetime.now(datetime.UTC) + datetime.timedelta(hours=8)
    newver = args.ver or ('%04d%02d%02da%d' % (stamp.year, stamp.month, stamp.day, args.bump))
    bump_index(newver)
    print('版本号已升到 %s' % newver)
    return 0


def bump_index(newver):
    n = 0
    for f in (INDEX_SITE, INDEX_DIST):
        if not os.path.exists(f):
            continue
        s = open(f, encoding='utf-8').read()
        ns = re.sub(r'(songs\.js\?v=)[0-9a-zA-Z]+', r'\g<1>' + newver, s)
        if ns != s:
            open(f, 'w', encoding='utf-8').write(ns)
            n += 1
    print('index.html 版本号更新 %d 处 → %s' % (n, newver))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--fetch', action='store_true')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--only')
    ap.add_argument('--dry', action='store_true')
    ap.add_argument('--bump', type=int, default=29)
    ap.add_argument('--ver')
    a = ap.parse_args()
    sys.exit(fetch(a) if a.fetch else merge(a))
