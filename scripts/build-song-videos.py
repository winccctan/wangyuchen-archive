#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「曲目 → B 站视频」映射灌进曲目库 songs.js（幂等：整份 vid 重建，可反复跑）

为什么要单独这个脚本
  曲目 lies 在 songs.js 里，加一个 `vid` 字段就够了 —— 不新增前端文件，
  免得漏进 build 白名单（CI 只认白名单里的文件，新文件不打进 dist 会线上 404）。

输入
  scripts/song-video-picks.json   apply-song-video-picks.py 的产物
                                  [{lid, day, song, perf, videos:[[bvid,p,src],...]}]
输出
  songs.js 的 `vid` 键： {"<liveId>|<曲名>": [[bvid, p, src], ...]}
    p > 1 才需要在网址后面拼 ?p=N；甜橙小铺的整条视频是 p=0，直接跳
  --target=demo 时写 ../demo-wyc/js/songs.js（demo 版本号独立，用 --bump=NN）

复跑：
  P=/Users/tansy/.workbuddy/binaries/python/envs/default/bin/python
  $P scripts/build-song-videos.py --dry                 # 只看会写多少条
  $P scripts/build-song-videos.py --bump=33             # 生产 site+dist，版本号 a33
  $P scripts/build-song-videos.py --target=demo --bump=62
"""
import argparse
import datetime
import importlib.util
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location('scu', os.path.join(ROOT, 'scripts', 'sync-cut-units.py'))
scu = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scu)

PICKS = os.path.join(ROOT, 'scripts', 'song-video-picks.json')
DEMO = os.path.normpath(os.path.join(ROOT, '..', 'demo-wyc'))


def vid_url(bvid, p):
    """B站视频地址：p>1 才拼 ?p=N"""
    u = 'https://www.bilibili.com/video/' + bvid
    return u + ('?p=%d' % p if p and p > 1 else '')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', default='prod', choices=['prod', 'demo'])
    ap.add_argument('--bump', type=int, default=0)
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()

    picks = json.load(open(PICKS, encoding='utf-8'))
    if a.target == 'demo':
        song_path = os.path.join(DEMO, 'js', 'songs.js')
        idx_path = os.path.join(DEMO, 'index.html')
        ver = '%04d%02d%02dd%02d'
    else:
        song_path = os.path.join(ROOT, 'site', 'js', 'songs.js')
        idx_path = os.path.join(ROOT, 'site', 'index.html')
        ver = '%04d%02d%02da%02d'

    d, head = scu.load_songs(song_path)
    old = dict(d.get('vid') or {})
    vid = {}
    for r in picks:
        k = '%s|%s' % (r['lid'], r['song'])
        vid[k] = r['videos']

    diff = {k: v for k, v in vid.items() if old.get(k) != v}
    gone = [k for k in old if k not in vid]
    print('%s：vid 将写入 %d 条（新增/变化 %d 条，被移除 %d 条，原有 %d 条）'
          % (a.target, len(vid), len(diff), len(gone), len(old)))
    for k in list(diff)[:12]:
        v = diff[k][0]
        print('   %s → %s (%s)' % (k.partition('|')[2], vid_url(v[0], v[1]), v[2]))
    if gone:
        print('   不再存在的旧键（说明这次没勾）:', gone[:12])
    if a.dry:
        print('[dry] 未写文件')
        return 0

    d['vid'] = vid
    out = head + json.dumps(d, ensure_ascii=False, separators=(',', ':')) + ';\n'
    open(song_path, 'w', encoding='utf-8').write(out)
    if a.target == 'prod':
        import shutil
        shutil.copyfile(song_path, os.path.join(ROOT, 'dist', 'js', 'songs.js'))
        print('已写 site/js/songs.js → dist/js/songs.js')
    else:
        print('已写 %s' % song_path)

    if a.bump:
        stamp = datetime.datetime.now(datetime.UTC) + datetime.timedelta(hours=8)
        newver = ver % (stamp.year, stamp.month, stamp.day, a.bump)
        targets = [idx_path] if a.target == 'demo' else [
            idx_path, os.path.join(ROOT, 'dist', 'index.html')]
        n = 0
        for f in targets:
            if not os.path.exists(f):
                continue
            s = open(f, encoding='utf-8').read()
            ns = re.sub(r'(songs\.js\?v=)[0-9a-zA-Z]+', r'\g<1>' + newver, s)
            if ns != s:
                open(f, 'w', encoding='utf-8').write(ns)
                n += 1
        print('index.html 版本号更新 %d 处 → %s' % (n, newver))
    else:
        print('⚠️ 没给 --bump，版本号没动（浏览器会用旧缓存）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
