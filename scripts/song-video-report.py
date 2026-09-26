#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""曲目「视频待补」清单生成器（两个源：甜橙小铺 + Chzhnh）

用途：把「B 站视频看起来是她唱的某首歌，但曲目库里没有」的候选列出来，
      交给站长勾选，勾完再写回 cut-units.json / 曲目库。
      🔴 本脚本只读 + 输出页面，**不碰** site/js/songs.js。

输入
  scripts/orange-shop.json      甜橙小铺（mid 3461575572719698）视频清单
  scripts/cut-units-pending.json  Chzhnh 全量 unit（未核对）
  scripts/cut-units.json        已确认的 unit（用来排除重复）
  site/data/bili-videos.json    拿 BV → 标题（给 pick_live 当 hint，救回同日多场）
输出
  <工作区>/曲目视频待补清单.html

复跑：
  P=/Users/tansy/.workbuddy/binaries/python/envs/default/bin/python
  $P scripts/song-video-report.py            # 生成清单页
  $P scripts/song-video-report.py --fetch    # 先重抓甜橙小铺再生成
"""
import json
import os
import re
import subprocess
import sys
import time
import collections
import importlib.util

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

_spec = importlib.util.spec_from_file_location('scu', os.path.join(ROOT, 'scripts', 'sync-cut-units.py'))
scu = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scu)

ORANGE = os.path.join(ROOT, 'scripts', 'orange-shop.json')
PENDING = os.path.join(ROOT, 'scripts', 'cut-units-pending.json')
CONFIRMED = os.path.join(ROOT, 'scripts', 'cut-units.json')
OUT = os.path.join(os.path.dirname(ROOT), '曲目视频待补清单.html')

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
ORANGE_MID = '3461575572719698'
ORANGE_SEASONS = [('1977668', 'FOCUS'), ('3147519', '官方cut')]
ORANGE_SERIES = [('3867541', '公演CUT')]

# ── 标题里「不是曲目名」的噪声段（甜橙小铺用） ──────────────────────
ORANGE_NOISE = re.compile(
    r'公演|云公演|OFF vocal|Instrument|伴奏|第[X一二三四五六七八九十百\d]+场|'
    r'新人TOP|汇报|全团|特殊|生日|冷餐|金曲大赏|MVP|助演|前座曲|大歌|unit|'
    r'开场|环节|MC|读信|全程|返场|PV|花絮|抽奖|致辞|自我介绍|认识新宝宝|'
    r'上海|广州|北京|FOCUS|Focus|2019|2020|2021|2022|2023|2024|2025|2026', re.I)
# 疑似「不像歌」的候选，页面上默认划掉
SUSPECT = re.compile(
    r'今日之星|击掌|串场|队伍MC|生日祝福|生日蛋糕|生日信|开场读须知|'
    r'对粉丝说的话|问答|goodbye|告别|发表|感想|眼泪| Talking|talking|'
    r'自我介绍|认识新宝宝|全套|回顾|合集|应援会\s*pv|^pv[：:]|\bpv\b|studio_video_|DSC_|^IMG\d', re.I)


def _get(url, mid):
    for _ in range(3):
        out = subprocess.run(
            ['curl', '-s', '--noproxy', '*', '--max-time', '25', '-A', UA,
             '-H', 'Referer: https://space.bilibili.com/%s/video' % mid, url],
            capture_output=True, text=True).stdout
        try:
            r = json.loads(out)
            if r.get('code') == 0:
                return r
        except Exception:
            pass
        time.sleep(2)
    return None


def fetch_orange():
    """合集/系列接口，不需要签名也不需要 cookie（实测零风控）"""
    got = {}
    for sid, tag in ORANGE_SEASONS:
        for pn in range(1, 8):
            r = _get('https://api.bilibili.com/x/polymer/web-space/seasons_archives_list'
                     '?mid=%s&season_id=%s&page_num=%d&page_size=30&sort_reverse=false'
                     % (ORANGE_MID, sid, pn), ORANGE_MID)
            if not r:
                break
            a = (r.get('data') or {}).get('archives') or []
            for x in a:
                got[x['bvid']] = {'bvid': x['bvid'], 'title': x.get('title', ''),
                                  'created': x.get('pubdate') or x.get('ctime') or 0,
                                  'dur': x.get('duration') or 0, 'src': tag}
            if len(a) < 30:
                break
            time.sleep(1.2)
    for sid, tag in ORANGE_SERIES:
        for pn in range(1, 8):
            r = _get('https://api.bilibili.com/x/series/archives?mid=%s&series_id=%s'
                     '&only_normal=true&sort=desc&pn=%d&ps=30' % (ORANGE_MID, sid, pn), ORANGE_MID)
            if not r:
                break
            a = (r.get('data') or {}).get('archives') or []
            for x in a:
                got[x['bvid']] = {'bvid': x['bvid'], 'title': x.get('title', ''),
                                  'created': x.get('pubdate') or x.get('ctime') or 0,
                                  'dur': x.get('duration') or 0, 'src': tag}
            if len(a) < 30:
                break
            time.sleep(1.2)
    json.dump(list(got.values()), open(ORANGE, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('甜橙小铺抓到 %d 条' % len(got))


def parse_orange(title):
    """【GNZ48王语晨|4K60 FOCUS】20240310 曲名 / 曲名｜20240310 上海…
       剥【】前缀 → 按 ｜ 切段 → 找 8 位日期 → 剔除噪声段，剩下的当曲名候选"""
    t = re.sub(r'[【][^】]*[】]', '', title).strip()
    t = re.sub(r'^GNZ48王语晨\s*\|\s*4K60\s*FOCUS[】\s]*', '', t, flags=re.I).strip()
    t = re.sub(r'^GNZ48王语晨\s*[|｜]\s*', '', t, flags=re.I).strip()
    segs = [s.strip() for s in re.split(r'[｜|]', t) if s.strip()]
    day, cands = None, []
    for s in segs:
        mo = re.search(r'(20\d{2})[-.]?(\d{2})[-.]?(\d{2})', s)
        if mo:
            day = '%s-%s-%s' % mo.groups()
            rest = re.sub(r'(20\d{2})[-.]?(\d{2})[-.]?(\d{2})', '', s).strip()
            if rest:
                cands.append(rest)
        elif len(segs) == 1:
            cands.append(s)
        else:
            cands.append(s)
    good = [s for s in cands if s and not ORANGE_NOISE.search(s) and len(s) <= 34]
    return (day, good) if (day and good) else None


def main():
    ap = [a for a in sys.argv[1:] if a != '--fetch']
    if '--fetch' in sys.argv:
        fetch_orange()

    songs, _ = scu.load_songs(os.path.join(ROOT, 'site', 'js', 'songs.js'))
    perfs = scu.load_archive()
    idx = {scu.norm(k): k for k in songs['bySong']}
    confirmed = {(x.get('bvid'), x.get('p'), x.get('song')) for x in
                 json.load(open(CONFIRMED, encoding='utf-8'))}
    # BV → 标题（给 pick_live 当 hint）
    bvtitle = {v.get('bvid'): v.get('title', '') for v in
               json.load(open(os.path.join(ROOT, 'site', 'data', 'bili-videos.json'), encoding='utf-8'))['videos']}

    rows = []          # 候选：{src, day, raw, song, lid, perf, bvid, p, suspect}
    seen = set()

    def add(src, day, raw, song, perf, bvid, p):
        key = (src, day, song, bvid, p)
        if key in seen:
            return
        seen.add(key)
        rows.append({'src': src, 'day': day, 'raw': raw, 'song': song,
                     'lid': str(perf['liveId']) if perf else '',
                     'perf': (perf.get('subTitle') or perf.get('title') or '').strip() if perf else '',
                     'bvid': bvid, 'p': p,
                     'suspect': bool(SUSPECT.search(raw or song))})

    # ---- 源 1：甜橙小铺 ----
    orange = json.load(open(ORANGE, encoding='utf-8'))
    for v in orange:
        pr = parse_orange(v['title'])
        if not pr:
            continue
        day, cands = pr
        hit = None
        for raw in cands:
            s = scu.canon(raw, dict(idx))
            if s in songs['bySong']:
                hit = (s, raw)
                break
        if not hit:
            continue                      # 库里完全没这首歌 → 由下一轮「补曲目」处理
        song, raw = hit
        perf = scu.pick_live(day, perfs, v['title'])
        if not perf:
            perf = scu.pick_live(day, perfs, '')
        add('甜橙小铺', day, raw, song, perf, v['bvid'], 0)

    # ---- 源 2：Chzhnh 全量 unit ----
    pend = json.load(open(PENDING, encoding='utf-8'))
    for u in pend:
        day, raw = u.get('d') or '', u.get('song')
        if not day or not raw:
            continue
        # 🔴 先按抽取口径剥前缀（大歌:迷宫 → 迷宫）再 canon 去重：
        #    confirmed 里存的是规范曲名，pending 里是原始文字，不剥前缀会重复列一遍。
        for sr0 in (scu.part_to_songs(raw) or [raw]):
            sr = LOCAL_PREFIX.sub('', sr0).strip() or sr0
            song = ALIAS.get(sr) or scu.canon(sr, dict(idx))
            if (u.get('bvid'), u.get('p'), song) in confirmed:
                continue
            # 直接用它自带的 lid（人工指定过的）
            if u.get('lid'):
                perf = next((p for p in perfs if str(p['liveId']) == str(u['lid'])), None)
            else:
                perf = scu.pick_live(day, perfs, bvtitle.get(u.get('bvid'), ''))
                if not perf:
                    perf = scu.pick_live(day, perfs, '')
            if not perf:
                continue
            add('Chzhnh', day, sr, song, perf, u.get('bvid'), u.get('p'))

    # ---- 分堆：新歌（曲目库完全没） / 已有歌但没这场 / 已有组合 ----
    new_song, missing_pair, have = [], [], []
    for r in rows:
        already = r['song'] in (songs['byLive'].get(r['lid']) or [])
        isnew = r['song'] not in songs['bySong']
        if isnew:
            new_song.append(r)
        elif already:
            have.append(r)
        else:
            missing_pair.append(r)

    print('候选合计 %d 条' % len(rows))
    print('  A 全新曲名（库里没有这首歌）      : %d' % len(new_song))
    print('  B 歌有、这场没记   　            : %d' % len(missing_pair))
    print('  C 这场已经有了（只用于跳转，不用补）: %d' % len(have))
    print('  其中自动标记为「不像歌」建议剔除   : %d'
          % len([r for r in new_song + missing_pair if r['suspect']]))

    json.dump({'new': new_song, 'missing': missing_pair, 'have': have},
              open('/tmp/song-video-report.json', 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    build_html(new_song, missing_pair, have)


# B站标题写错导致的同歌异写 → 统一到曲目库规范名（否则会被当成新歌反复问）
ALIAS = {"ROSE' SECRET": "ROSE'S SECRET"}

# sync-cut-units 的 PREFIX_RE 只剥「开头的助演/大歌」，剥不掉「洪静雯季度mvp助演辛德瑞拉」
# 「唐莉佳两分半助演：恋爱告急」这种**带别人名字**的前缀 ⇒ 会被当全新曲名重复问站长。
# 这里补一层二次剥离（口径一致：别人名 + 助演 = 她参与唱的那首，算曲目）。
LOCAL_PREFIX = re.compile(
    r'^\s*(?:[^：:]{0,16}?(?:MVP|两分半|季度)\s*)?助演\s*[：:]?\s*'
    r'|^\s*开场大歌\s*[：:]\s*', re.I)


def esc(s):
    return (str(s or '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            .replace('"', '&quot;'))


def card(r, cls, note=''):
    return ('<label class="row{off}"><input type="checkbox" data-song="{song}" '
            'data-lid="{lid}" data-day="{day}" data-bvid="{bvid}" data-p="{p}"{chk} />'
            '<span class="sof">{song}</span><span class="sd">{day}</span>'
            '<span class="sp">{perf}</span><span class="ss">{src}{pv}</span>'
            '<span class="sraw">{raw}</span></label>').format(
        off=' off' if cls else '', song=esc(r['song']), lid=esc(r['lid']), day=esc(r['day']),
        bvid=esc(r['bvid']), p=r['p'], chk='' if cls else ' checked',
        perf=esc(r['perf'][:30] or '（场次待定）'), src=esc(r['src']),
        pv=' P%s' % r['p'] if r['p'] else '', raw=esc(r['raw'][:40]))


def build_html(new_song, missing_pair, have):
    def block(title, sub, arr, chk):
        if not arr:
            return '<h2>' + title + ' <small>' + sub + '</small></h2><div class="empty">这一类是空的</div>'
        groups = collections.defaultdict(list)
        for r in arr:
            groups[(r['day'], r['perf'])].append(r)
        out = ['<h2>' + title + ' <small>' + sub + '</small></h2>']
        for (day, perf), rs in sorted(groups.items()):
            out.append('<div class="perf"><div class="ph"><span class="d">' + esc(day) +
                       '</span><span class="t">' + esc(perf[:36]) + '</span></div>')
            for r in rs:
                out.append(card(r, chk))
            out.append('</div>')
        return '\n'.join(out)

    n1 = len([r for r in new_song if not r['suspect']])
    n2 = len([r for r in missing_pair if not r['suspect']])
    html = """<h2 class="sr-only">曲目视频待补清单</h2>
<div class="wrap">
<h1>曲目 · 视频待补清单</h1>
<p class="lead">扫出 __TOT__ 条候选，分成三类。<b>橙色划掉的是我看不像歌的，默认没勾</b>；
你觉得是对的勾回来就行。勾完点「复制我选的」贴给助理。</p>
<div class="bar">
 <button id="bGood" class="on">只选我看好的</button>
 <button id="bAll">全选</button>
 <button id="bNone">全不选</button>
 <button id="bCopy" class="on">复制我选的</button>
 <span id="cnt"></span>
</div>
<div id="shot"><span id="tip" class="mini"></span><textarea id="out" readonly rows="4"></textarea></div>
__NEWB__
__MISSB__
__HAVEB__
</div>
<style>
.wrap{font:14px/1.6 -apple-system,"PingFang SC",sans-serif;max-width:920px;margin:0 auto;padding:16px}
h1{font-size:20px;font-weight:500;margin:0 0 6px}
h2{font-size:15px;font-weight:500;margin:22px 0 8px;padding-top:10px;border-top:1px solid #eee}
h2 small{color:#888;font-weight:400;font-size:12px}
.lead{color:#555;font-size:13px;margin:0 0 12px}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.bar button{font-size:13px;padding:6px 12px;border:1px solid #d0d0d0;background:#fff;border-radius:8px;cursor:pointer}
.bar button.on{border-color:#2563eb;color:#2563eb;font-weight:500}
#cnt{font-size:12.5px;color:#888}
#out{width:100%;display:none;font:12px/1.5 ui-monospace,monospace;color:#374151;border:1px solid #e5e7eb;
 border-radius:8px;padding:8px;background:#fff;resize:vertical;margin-top:6px}
#tip{display:block;font-size:12.5px;color:#2563eb}
.perf{border:1px solid #eee;border-radius:10px;padding:8px 10px;margin-bottom:8px;background:#fafafa}
.ph{display:flex;gap:10px;align-items:baseline;margin-bottom:4px}
.d{font-size:12.5px;color:#6b7280}.t{font-size:13px;font-weight:500}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:4px 2px;border-radius:6px}
.row.off{opacity:.5;text-decoration:line-through;text-decoration-color:#f59e0b}
.row:hover{background:#fff}
.sof{font-size:13.5px;font-weight:500;min-width:120px}
.sd{font-size:12px;color:#6b7280}
.sp{font-size:12px;color:#374151}
.ss{font-size:11px;color:#2563eb;background:#eff6ff;border-radius:5px;padding:1px 6px}
.sraw{font-size:11px;color:#9ca3af}
.empty{color:#9ca3af;font-size:13px}
</style>
<script>
var KEY='wycSongVideoPick';
var cbs=[].slice.call(document.querySelectorAll('input[type=checkbox]'));
var ta=document.getElementById('out'),tip=document.getElementById('tip');
function kk(c){return (c.getAttribute('data-lid')||'')+'|'+(c.getAttribute('data-song')||'')+'|'+(c.getAttribute('data-day')||'');}
function cnt(){document.getElementById('cnt').textContent='已选 '+cbs.filter(function(x){return x.checked}).length+' / '+cbs.length;}
function save(){try{var o={};cbs.forEach(function(c){o[kk(c)]=c.checked});localStorage.setItem(KEY,JSON.stringify(o));}catch(e){}}
function load(){try{var raw=localStorage.getItem(KEY);if(!raw)return 0;var o=JSON.parse(raw);
 cbs.forEach(function(c){if(kk(c) in o)c.checked=o[kk(c)];});return 1;}catch(e){return 0;}}
function well(){cbs.forEach(function(c){c.checked=!c.parentNode.className.match(/\\boff\\b/)});}
function snap(){return cbs.filter(function(c){return c.checked}).map(function(c){
 var jk=c.parentNode.className.match(/\\boff\\b/)?'（我看不像歌，你要确认）':'';
 return c.getAttribute('data-day')+'  '+c.getAttribute('data-song')+'  BV'+c.getAttribute('data-bvid')+jk;});}
cbs.forEach(function(c){c.addEventListener('change',function(){cnt();save();});});
function wire(id,fn){var b=document.getElementById(id);if(b)b.onclick=fn;}
wire('bAll',function(){cbs.forEach(function(c){c.checked=true});cnt();save();});
wire('bNone',function(){cbs.forEach(function(c){c.checked=false});cnt();save();});
wire('bGood',function(){well();cnt();save();});
wire('bCopy',function(){var L=snap();var t='我选了 '+L.length+' 条：\\n'+L.join('\\n');
 ta.value=t;ta.style.display='block';ta.focus();ta.select();ta.setSelectionRange(0,99999);
 var ok=false;try{ok=document.execCommand('copy');}catch(e){}
 if(!ok&&navigator.clipboard){try{navigator.clipboard.writeText(t);ok=true;}catch(e){}}
 tip.textContent=ok?('已复制 '+L.length+' 条，粘贴给助理就行'):('自动复制被浏览器挡了，请手动全选下面文本框复制');
 tip.style.color=ok?'#059669':'#c2410c';});
if(!load())well();
cnt();
</script>"""
    html = (html.replace('__TOT__', str(len(new_song) + len(missing_pair)))
                .replace('__NEWB__', block('A. 全新曲名', '曲目库里压根没这首歌 · 推荐 %d 条' % n1, new_song, True))
                .replace('__MISSB__', block('B. 歌有、这场没记', '推荐 %d 条' % n2, missing_pair, True))
                .replace('__HAVEB__', block('C. 这场已经有了', '不用补，只用于「只看这首」跳转 · %d 条' % len(have), have, False)))
    open(OUT, 'w', encoding='utf-8').write(html)
    print('清单页 → %s' % OUT)


if __name__ == '__main__':
    main()
