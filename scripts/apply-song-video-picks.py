#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把站长从《曲目视频待补清单》勾出来的行，还原成「场次 liveId + 曲目 + BV + 分P」

输入
  scripts/boss-song-video-picks.txt    站长粘贴的原样清单（不能改格式）
  /tmp/song-video-report.json          song-video-report.py 生成的三类候选（含已解析好的 lid/p）
  site/data/archive.js                日期 → 场次（同日多场时用它人工兜底）
输出
  scripts/song-video-picks.json        [{lid,day,song,bvid,p,src,perf}]
  控制台：匹配统计 + 对不上的行

复跑：
  P=/Users/tansy/.workbuddy/binaries/python/envs/default/bin/python
  $P scripts/apply-song-video-picks.py
"""
import json
import os
import re
import sys
import importlib.util
import collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location('scu', os.path.join(ROOT, 'scripts', 'sync-cut-units.py'))
scu = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scu)

PICKS = os.path.join(ROOT, 'scripts', 'boss-song-video-picks.txt')
REPORT = '/tmp/song-video-report.json'
OUT = os.path.join(ROOT, 'scripts', 'song-video-picks.json')

# 站长口头指定：「2024-04-06 是 20240406 那场 NIII 的」（当天还有一场生日冷餐会）
DAY_FORCE_LID = {
    ('2024-04-06', '981586716347142144'),      # 启程：TEAM NIII·第五十六场 18:45
}


def parse_picks():
    """行格式：`2024-06-30  等价交换  BVBV12S411A7wL（我看不像歌，你要确认）`
       🔴 复制时脚本给 BV 号前面又拼了一个 'BV' ⇒ 必须剥掉；曲名里可能有空格，按两个以上空格切字段"""
    out = []
    for ln in open(PICKS, encoding='utf-8'):
        ln = ln.rstrip('\n')
        if not ln.strip():
            continue
        note = '（我看不像歌，你要确认）' in ln
        ln = ln.replace('（我看不像歌，你要确认）', '')
        fields = [f.strip() for f in re.split(r'\s{2,}', ln.strip()) if f.strip()]
        if len(fields) < 3:
            print('! 无法解析：', ln)
            continue
        day, song, bv = fields[0], '  '.join(fields[1:-1]), fields[-1]
        bv = bv.strip()
        if bv.startswith('BVBV'):
            bv = bv[2:]
        if not re.fullmatch(r'BV[0-9A-Za-z]{10}', bv):
            print('! BV 号不合法：', bv, '←', ln)
            continue
        out.append({'day': day, 'song': song, 'bvid': bv, 'note': note})
    return out


def main():
    rep = json.load(open(REPORT, encoding='utf-8'))
    perfs = scu.load_archive()
    bylid = {str(p['liveId']): p for p in perfs}
    by_day_lid = collections.defaultdict(list)
    for p in perfs:
        d = scu.bj(p['stime'], '%Y-%m-%d')
        by_day_lid[d].append(p)

    cand = collections.defaultdict(list)
    for grp in ('new', 'missing', 'have'):
        for r in rep.get(grp) or []:
            cand[(r['day'], r['song'], r['bvid'])].append((grp, r))

    picks = parse_picks()
    print('清单 %d 行' % len(picks))

    done, problems = [], []
    used = collections.Counter()
    for pk in picks:
        key = (pk['day'], pk['song'], pk['bvid'])
        hits = cand.get(key) or []
        if not hits:
            problems.append(('报表里找不到', pk))
            continue
        # 同一 key 在报表里出现多次 → 按出现顺序取第 n 次（清单里也可能重复同一行）
        n = used[key]
        used[key] += 1
        if n >= len(hits):
            problems.append(('重复次数超出候选', pk))
            continue
        grp, r = hits[n]
        lid = r.get('lid') or ''
        # 同日多场：报表 pick_live 会返回 None（lid 为空），用站长口头指定的场次兜底
        if not lid:
            forced = [v for (d, v) in DAY_FORCE_LID if d == pk['day']]
            if len(forced) == 1:
                lid = forced[0]
            else:
                problems.append(('同日多场、未指定挂哪场', pk))
                continue
        p = bylid.get(lid)
        if not p:
            problems.append(('archive.js 里没有这个 liveId %s' % lid, pk))
            continue
        done.append({'lid': lid, 'day': pk['day'],
                     'song': pk['song'], 'bvid': pk['bvid'],
                     'p': int(r.get('p') or 0), 'src': r.get('src', ''),
                     'perf': (p.get('subTitle') or p.get('title') or '').strip()})

    print('匹配成功 %d 条；problem %d 条' % (len(done), len(problems)))
    for why, pk in problems[:40]:
        print('   [%s] %s  %s  %s' % (why, pk['day'], pk['song'], pk['bvid']))

    # 同一 (lid,song) 出现多条视频 → **都留着**，但排好优先级：
    #   ① 甜橙小铺（4K60 FOCUS 单曲直拍，点开就是这一首）> ② Chzhnh 全场 cut 的分 P
    #   UI 只取第一条，其余留作以后可切换，不丢数据。
    buckets = collections.OrderedDict()
    for r in done:
        buckets.setdefault((r['lid'], r['song']), {'day': r['day'], 'perf': r['perf'], 'videos': []})
        buckets[(r['lid'], r['song'])]['videos'].append(
            [r['bvid'], r['p'], r['src']])
    uniq = []
    dupn = 0
    for (lid, song), b in buckets.items():
        vs = sorted(b['videos'], key=lambda v: 0 if '甜橙' in v[2] else 1)
        if len(vs) > 1:
            dupn += 1
            print('   多源：%s %s → %s' % (b['day'], song, ' | '.join(
                '%s%s(%s)' % (v[0], '?p=%d' % v[1] if v[1] > 1 else '', v[2]) for v in vs)))
        uniq.append({'lid': lid, 'day': b['day'], 'song': song,
                     'perf': b['perf'], 'videos': vs})
    print('→ 去重后 (场次,曲目) 唯一键 %d 条，其中 %d 条有多个源' % (len(uniq), dupn))

    json.dump(uniq, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('→ %s' % OUT)

    lids = len({r['lid'] for r in uniq})
    songs = len({r['song'] for r in uniq})
    print('覆盖 %d 个场次 / %d 首曲目' % (lids, songs))
    for src, n in collections.Counter(v[2] for r in uniq for v in r['videos']).items():
        print('   源 %s：%d 条视频' % (src, n))
    print('首选项占比：甜橙小铺 %d / Chzhnh %d' % (
        len([1 for r in uniq if '甜橙' in r['videos'][0][2]]),
        len([1 for r in uniq if '甜橙' not in r['videos'][0][2]])))
    return 0


if __name__ == '__main__':
    sys.exit(main())
