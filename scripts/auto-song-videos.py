#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""自动补全曲目库的 vid（曲目弹窗里的「只看这首」链接）。

规则（站长 2026-10-15 定）：按**日期 + 该场公演的曲目名**挂链接。
  ① B站切片：Chzhnh 的「公演cut」视频分P（part 名如 `unit:City Lights`）→ (场次, 曲目) → [BV, p, 'Chzhnh']
  ② B站直拍：甜橙小铺 FOCUS 单曲视频（标题里带日期 + 曲名）→ [BV, 0, '甜橙小铺']
只补「曲目库 byLive 里**有**这首歌、但 vid **还没有**」的 (场次, 曲目)。
曲名必须能对上该场曲目单（canon 匹配），对不上的写进待确认清单，绝不擅自建歌/乱挂。

数据源
  scripts/cut-units.json         已核对的 unit（首选，不联网、最准）
  site/data/bili-videos.json      Chzhnh 投稿；`--fetch` 时按需解析其中「她的公演cut」的分P
  scripts/cut-unit-auto.json      本脚本解析出的分P 缓存（避免每次重复请求 B站）
  scripts/orange-shop.json        甜橙小铺视频清单（直拍）
产出
  scripts/song-video-picks.json   合并新增（vid 的源数据）
  scripts/song-video-pending.json 对不上曲目单的候选（人工确认用）
  site/js/songs.js + dist/js/songs.js   重建 vid
  index.html songs.js?v=          升版本号

用法
  python3 scripts/auto-song-videos.py --fetch     # 允许联网解析分P（默认只吃缓存 + cut-units）
  python3 scripts/auto-song-videos.py --dry       # 只打印，不写文件
  python3 scripts/auto-song-videos.py --fetch --limit 120
"""
import argparse
import datetime
import importlib.util
import json
import os
import re
import shutil
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location('scu', os.path.join(ROOT, 'scripts', 'sync-cut-units.py'))
scu = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scu)

SONGS_SITE = os.path.join(ROOT, 'site', 'js', 'songs.js')
SONGS_DIST = os.path.join(ROOT, 'dist', 'js', 'songs.js')
PICKS = os.path.join(ROOT, 'scripts', 'song-video-picks.json')
PENDING = os.path.join(ROOT, 'scripts', 'song-video-pending.json')
CUT_UNITS = os.path.join(ROOT, 'scripts', 'cut-units.json')
CUT_PENDING = os.path.join(ROOT, 'scripts', 'cut-units-pending.json')
CUT_AUTO = os.path.join(ROOT, 'scripts', 'cut-unit-auto.json')
ORANGE = os.path.join(ROOT, 'scripts', 'orange-shop.json')
VIDEOS = os.path.join(ROOT, 'site', 'data', 'bili-videos.json')

DATE8 = re.compile(r'(20\d{2})[-.]?(\d{2})[-.]?(\d{2})')
DATE6 = re.compile(r'(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)')
# 标题里不是曲名的噪声段（剧目名 / 场次 / 环节）
NOISE = re.compile(
    r'公演|云公演|OFF\s*vocal|伴奏|第[X一二三四五六七八九十百\d]+场|新人TOP|汇报|全团|特殊|生日|冷餐|'
    r'金曲|MVP|助演|前座曲|大歌|unit|开场|环节|MC|读信|全程|返场|PV|花絮|抽奖|致辞|自我介绍|'
    r'巡演|首演|Team|王语晨|语晨|启程|拾忆|天枢|之弈|没有我的世界|Focus|4K', re.I)


def load_json(path, default=None):
    try:
        return json.load(open(path, encoding='utf-8'))
    except Exception:
        return default


def find_day(text):
    """标题 → YYYY-MM-DD。先找 8 位，再找 6 位（YYMMDD，如 250531）。"""
    m = DATE8.search(text or '')
    if m:
        return '%s-%s-%s' % m.groups()
    for m in DATE6.finditer(text or ''):
        yy, mm, dd = m.groups()
        if 1 <= int(mm) <= 12 and 1 <= int(dd) <= 31:
            return '20%s-%s-%s' % (yy, mm, dd)
    return None


def strip_date(text):
    t = DATE8.sub('', text or '')
    t = DATE6.sub('', t)
    return t


def parse_orange_title(title):
    """甜橙小铺标题 → (day, [曲名候选])。"""
    t = re.sub(r'[【][^】]*[】]', '', title or '').strip()
    t = re.sub(r'^GNZ48王语晨\s*[|｜]\s*', '', t, flags=re.I).strip()
    day = find_day(t)
    if not day:
        return None
    segs = [s.strip(' 　|｜/-') for s in re.split(r'[｜|]', strip_date(t))]
    return day, [s for s in segs if s]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fetch', action='store_true', help='联网解析 B站 分P（默认只吃缓存）')
    ap.add_argument('--dry', action='store_true')
    ap.add_argument('--limit', type=int, default=int(os.environ.get('AUTO_SV_LIMIT', '100')),
                    help='本轮最多解析多少个 B站 视频的分P')
    ap.add_argument('--ver')
    a = ap.parse_args()

    d, head = scu.load_songs(SONGS_SITE)
    perfs = scu.load_archive()
    byLive = d.get('byLive') or {}
    vid = d.get('vid') or {}
    info = d.get('info') or {}
    idx = {scu.norm(k): k for k in d.get('bySong') or {}}
    aliases = scu.load_aliases()

    def canon(s):
        try:
            return scu.canon(s, idx, aliases)
        except Exception:
            return None

    allpairs = {(lid, s) for lid, arr in byLive.items() for s in arr}
    missing = {(lid, s) for lid, s in allpairs if not vid.get(lid + '|' + s)}
    print('[自动补视频] 曲目库 (场次,曲目) 共 %d，其中 %d 条还缺 vid' % (len(allpairs), len(missing)))
    if not missing:
        print('  没有缺的，收工')
        return 0

    cands = {}      # (lid, song) -> {}  bvid|p -> [bvid, p, src]
    origin = {}     # (lid, song) -> set(src)

    def add(lid, song, bvid, p, src):
        if not (lid and bvid):
            return
        key = (lid, song)
        if key in allpairs:
            cands.setdefault(key, {})['%s|%d' % (bvid, p or 0)] = [bvid, p or 0, src]
            origin.setdefault(key, set()).add(src)
        else:
            pend.setdefault((lid, song), set()).add('%s|%d|%s' % (bvid, p or 0, src))

    pend = {}

    # ── 源①：unit 清单（已核对 cut-units.json + 未核对 cut-units-pending.json）──
    #   只收「曲名能对上该场曲目单」的条目（add 里会再按 allpairs 过滤），
    #   所以 pending 里那些对得上现有曲目的也能安全采用；对不上的进待确认清单。
    n_units = 0
    for path in (CUT_UNITS, CUT_PENDING):
        for u in load_json(path, []) or []:
            if not u.get('bvid'):        # 微博 cut（无 B站 BV）→ vid 用不上，跳过
                continue
            perf = scu.pick_live(u.get('d'), perfs)
            if not perf:
                continue
            cn = canon(u.get('song') or '')
            if not cn:
                continue
            n_units += 1
            add(str(perf.get('liveId')), cn, u.get('bvid'), u.get('p') or 0, 'Chzhnh')

    # ── 源②：B站「她的公演cut」分P（按需解析 + 缓存）──
    auto = load_json(CUT_AUTO, {}) or {}
    missing_lids = {lid for lid, _ in missing}
    videos = (load_json(VIDEOS, {}) or {}).get('videos') or []
    todo = []
    for v in videos:
        title = v.get('title') or ''
        if not (scu.HER.search(title) and scu.KEEP.search(title)):
            continue
        day = find_day(title)
        if not day:
            continue
        perf = scu.pick_live(day, perfs, title_hint=title)
        if not perf:
            continue
        lid = str(perf.get('liveId'))
        if lid not in missing_lids:
            continue
        if v['bvid'] in auto:
            continue
        todo.append((v['bvid'], lid, day, title))
    if a.fetch and todo:
        todo = todo[:max(0, a.limit)]
        print('  解析 B站 分P：待处理 %d 个视频（上限 %d）…' % (len(todo), a.limit))
        for i, (bv, lid, day, title) in enumerate(todo, 1):
            r = scu.http_json('https://api.bilibili.com/x/player/pagelist?bvid=%s&jsonp=jsonp' % bv,
                              'https://www.bilibili.com/video/' + bv)
            parts = []
            if r and r.get('code') == 0:
                for pg in r.get('data') or []:
                    songs = scu.part_to_songs(pg.get('part'))
                    if songs:
                        parts.append({'p': pg.get('page'), 'songs': songs})
            auto[bv] = {'lid': lid, 'day': day, 'parts': parts}
            print('    [%d/%d] %s → %d 段' % (i, len(todo), bv, len(parts)))
            time.sleep(1.2)
        if not a.dry:
            json.dump(auto, open(CUT_AUTO, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
            print('  分P 缓存已写 %s（累计 %d 个视频）' % (os.path.basename(CUT_AUTO), len(auto)))
    n_auto = 0
    for bv, e in auto.items():
        lid = str(e.get('lid') or '')
        for pg in e.get('parts') or []:
            for s in pg.get('songs') or []:
                cn = canon(s)
                if not cn:
                    continue
                n_auto += 1
                add(lid, cn, bv, pg.get('p') or 0, 'Chzhnh')

    # ── 源③：甜橙小铺直拍（标题里的日期 + 曲名）──
    n_orange = 0
    for v in load_json(ORANGE, []) or []:
        r = parse_orange_title(v.get('title'))
        if not r:
            continue
        day, segs = r
        perf = scu.pick_live(day, perfs, title_hint=v.get('title') or '')
        if not perf:
            continue
        lid = str(perf.get('liveId'))
        for s in segs:
            if NOISE.search(s) or len(s) > 30:
                continue
            cn = canon(s)
            if not cn:
                continue
            n_orange += 1
            add(lid, cn, v.get('bvid'), 0, '甜橙小铺')

    print('  候选来源：cut-units %d 条 / 分P %d 条 / 直拍 %d 条'
          % (n_units, n_auto, n_orange))

    hit = {k: v for k, v in cands.items() if k in missing}
    print('  落在「缺失」上的可补 (场次,曲目)：%d 对，涉及 %d 个视频条目'
          % (len(hit), sum(len(v) for v in hit.values())))

    if not hit:
        print('  没有可自动补的，收工')
        return 0

    # ── 合并进 picks → 重建 vid ──
    picks = load_json(PICKS, []) or []
    by_key = {(str(p.get('lid')), p.get('song')): p for p in picks}

    def show_of(lid):
        it = info.get(lid) or {}
        perf = next((x for x in perfs if str(x.get('liveId')) == lid), None)
        name = (it.get('n') or (perf and (perf.get('subTitle') or perf.get('title'))) or '').strip()
        day = it.get('d') or (perf and scu.bj(perf['stime'], '%Y-%m-%d')) or ''
        return day, name

    added_videos = 0
    for (lid, song), vids in sorted(hit.items()):
        p = by_key.get((lid, song))
        if not p:
            day, name = show_of(lid)
            p = {'lid': lid, 'day': day, 'song': song, 'perf': name, 'videos': []}
            picks.append(p)
            by_key[(lid, song)] = p
        have = {tuple(x) for x in (p.get('videos') or [])}
        for it in vids.values():
            t = tuple(it)
            if t not in have:
                p['videos'].append(list(it))
                have.add(t)
                added_videos += 1

    # 重建 vid
    newvid = {}
    for p in picks:
        vv = p.get('videos') or []
        if vv:
            newvid['%s|%s' % (str(p.get('lid')), p.get('song'))] = vv
    before = len(vid)
    d['vid'] = newvid
    covered = len([1 for k in allpairs if newvid.get(k[0] + '|' + k[1])])
    print('  vid：%d → %d 键；曲目库覆盖 %d/%d (%.1f%%)'
          % (before, len(newvid), covered, len(allpairs), covered * 100.0 / len(allpairs)))

    if pend:
        print('  对不上曲目单、留待确认的候选：%d 对' % len(pend))

    if a.dry:
        print('\n[dry] 未写文件')
        return 0

    if pend:
        json.dump([{'lid': k[0], 'song': k[1], 'videos': sorted(v)} for k, v in sorted(pend.items())],
                  open(PENDING, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    json.dump(picks, open(PICKS, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    out = head + json.dumps(d, ensure_ascii=False, separators=(',', ':')) + ';\n'
    open(SONGS_SITE, 'w', encoding='utf-8').write(out)
    shutil.copyfile(SONGS_SITE, SONGS_DIST)
    stamp = datetime.datetime.now(datetime.UTC) + datetime.timedelta(hours=8)
    newver = a.ver or str(int(time.time()))
    scu.bump_index(newver)
    print('已写 %s / %s；新增 %d 个视频条目' % (os.path.basename(PICKS), os.path.basename(SONGS_SITE), added_videos))
    return 0


if __name__ == '__main__':
    sys.exit(main())
