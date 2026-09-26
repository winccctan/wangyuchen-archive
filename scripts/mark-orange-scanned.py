#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「甜橙小铺」里**历史上已有的** cut 视频标记为「已扫过分P」，
让 sync-cut-units.py 只自动处理**以后新出现**的视频 —— 与 Chzhnh 那批 133 条老 cut 同样的处理，
避免第一次接进 CI 就把上百条没核对过的 unit 一次性灌进曲目库。

用法：python3 scripts/mark-orange-scanned.py [--revert]
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORANGE = os.path.join(ROOT, 'scripts', 'orange-shop.json')
SCANNED = os.path.join(ROOT, 'scripts', 'cut-units-scanned.json')

HER = re.compile(r'王语晨')
KEEP = re.compile(r'公演\s*cut|云公演', re.I)

orange = json.load(open(ORANGE, encoding='utf-8'))
bvs = sorted({v['bvid'] for v in orange
              if v.get('bvid') and HER.search(v.get('title') or '') and KEEP.search(v.get('title') or '')})
scanned = set(json.load(open(SCANNED, encoding='utf-8')))

if '--revert' in sys.argv:
    scanned -= set(bvs)
    todo = '（撤销标记）'
else:
    scanned |= set(bvs)
    todo = ''

before = len(json.load(open(SCANNED, encoding='utf-8')))
json.dump(sorted(scanned), open(SCANNED, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('甜橙小铺的 cut 视频 %d 条%s；cut-units-scanned.json %d → %d 条'
      % (len(bvs), todo, before, len(scanned)))
