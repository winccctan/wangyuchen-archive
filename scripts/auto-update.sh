#!/usr/bin/env bash
# 自动补档：增量抓取 -> 重新生成站点 dist/ -> 推送到 GitHub
# 推送后 Cloudflare Workers（Git 构建）会自动重新部署，站点即变最新。
#
# 用法：
#   bash scripts/auto-update.sh            # 单次增量补档
#   LOOP=1 bash scripts/auto-update.sh     # 循环模式：每 5 分钟一次，运行约 55 分钟
#                                          # （由系统每小时定时触发，即可实现"每 5 分钟自动更新"）
#
# 需要：
#   - scraper/.env 里的 POCKET48_TOKEN 与 SCRAPE_PROXY（抓取用）
#   - scraper/.env 里的 GH_TOKEN（推送到 GitHub 用；或已配置 git 凭据）
#
# 保护：
#   - 文件锁防止上一次未结束又启动（高频定时不会互相写坏 site/data）
#   - 数据条数（消息/直播/公演）无变化时跳过提交与部署，避免空跑 Cloudflare 构建
set -euo pipefail

cd "$(dirname "$0")/.."

# ---------- 防重叠：同一时刻只允许一个实例（用 mkdir 原子锁，免依赖 flock） ----------
LOCKDIR=/tmp/wyc-auto-update.lock
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "已有实例在运行，本次跳过"
  exit 0
fi
trap 'rm -rf "$LOCKDIR"' EXIT

NODE="${NODE:-/Users/tansy/.workbuddy/binaries/node/versions/22.22.2/bin/node}"
MAX_PAGES="${MAX_PAGES:-3}"

# 从 scraper/.env 读取 GH_TOKEN（若未在环境变量中给出）
if [ -z "${GH_TOKEN:-}" ] && [ -f scraper/.env ]; then
  GH_TOKEN="$(grep -E '^GH_TOKEN=' scraper/.env | head -1 | cut -d= -f2- || true)"
fi

run_once() {
  # ---------- 记录抓取前的条数（用于判断是否有新数据） ----------
  local old_counts=""
  if [ -f site/data/meta.json ]; then
    old_counts="$(python3 -c "import json;print(json.load(open('site/data/meta.json'))['counts'])")"
  fi

  echo "[1/4] 增量抓取（口袋发言 / 直播 / 公演）..."
  ( cd scraper && MAX_PAGES="$MAX_PAGES" "$NODE" scrape.mjs )

  # ---------- 抓取后条数对比 ----------
  local new_counts="$(python3 -c "import json;print(json.load(open('site/data/meta.json'))['counts'])")"
  # 历史消息按最新解析规则重跑一遍（幂等，无需重新抓取；解析规则更新后自动生效）
  "$NODE" scripts/reparse-messages.mjs >/dev/null 2>&1 || true
  # 前瞻累积「当前场次」的参演名单（官方只公开当前场次名单，历史场次靠日积月累）
  "$NODE" scripts/capture-roster.mjs >/dev/null 2>&1 || true
  # 前瞻累积「公演排期 / 即将开始」（口袋 App 成员页「公演」标签的内容，窗口很短，必须定期累积）
  "$NODE" scripts/capture-schedule.mjs >/dev/null 2>&1 || true
  # ★ 抓「她参加的公演记录」（口袋成员页「公演」标签的权威数据源；只补缺详情的场次，增量很快）
  MAX_DETAILS=40 "$NODE" scripts/scrape-hers-performances.mjs >/dev/null 2>&1 || true
  # B 站公演录像备用源（UP 主投稿列表；接口有风控，脚本可断点续传，每轮只翻几页慢慢补全）
  MAX_PAGES=3 PAGE_SLEEP=6000 "$NODE" scripts/fetch-bili-videos.mjs >/dev/null 2>&1 || true
  echo "    抓取前条数: ${old_counts:-（无）}"
  echo "    抓取后条数: ${new_counts}"

  # 注意：只比 messages.json 会漏掉「直播状态变化」（status 2→3 不改变条数），
  # 导致直播结束后状态永远不更新。故改为比较全部三个数据文件。
  if [ -n "${old_counts}" ] && [ "$old_counts" = "$new_counts" ] \
     && git diff --quiet -- site/data/messages.json site/data/live.json site/data/performances.json site/data/rosters.json site/data/schedule.json site/data/performances-hers.json site/data/bili-videos.json; then
    echo "→ 数据条数与内容均未变化，跳过提交与部署（不触发空构建）"
    return 0
  fi

  echo "[2/4] 生成发布目录 dist/ ..."
  "$NODE" scripts/build-dist.mjs

  echo "[3/4] 提交变更..."
  git add -A
  if git diff --cached --quiet; then
    echo "    无文件变化，跳过提交"
  else
    git -c user.email=archive@local -c user.name=wangyuchen-archive \
        commit -q -m "auto: 增量补档 $(date '+%Y-%m-%d %H:%M')"
  fi

  echo "[4/5] 推送到 GitHub (main) ..."
  if [ -n "${GH_TOKEN:-}" ]; then
    git push "https://${GH_TOKEN}@github.com/winccctan/wangyuchen-archive.git" main
  else
    git push origin main
  fi

  echo "[5/5] 同步分支镜像 (gh-pages) ..."
  # 该分支用于 GitHub Pages 镜像。注意：Cloudflare Workers（Git 构建）会构建**所有分支**，
  # 所以镜像分支根目录也要放一份 wrangler.jsonc + worker/，否则 Wrangler 会报
  # "Missing entry-point to Worker script or to assets directory" 而构建失败。
  # 这里让镜像分支的 Worker 配置与 main 等价（静态目录改为分支根 ./），内容一致、无副作用。
  local TMP="$(mktemp -d)"
  cp -R dist/. "$TMP/"
  mkdir -p "$TMP/worker"
  cp worker/index.js "$TMP/worker/index.js"
  cat > "$TMP/wrangler.jsonc" <<'JSONC'
{
  "name": "wangyuchen-archive",
  "compatibility_date": "2026-09-17",
  "main": "worker/index.js",
  "assets": { "directory": "./", "binding": "ASSETS", "run_worker_first": true },
  "ai": { "binding": "AI" }
}
JSONC
  touch "$TMP/.nojekyll"
  ( cd "$TMP" \
    && git init -q && git add -A \
    && git -c user.email=archive@local -c user.name=wangyuchen-archive \
          commit -q -m "auto: mirror update $(date '+%Y-%m-%d %H:%M')" \
    && git branch -M gh-pages \
    && if [ -n "${GH_TOKEN:-}" ]; then \
         git push -f "https://${GH_TOKEN}@github.com/winccctan/wangyuchen-archive.git" gh-pages; \
       else \
         git push -f origin gh-pages; \
       fi )
  rm -rf "$TMP"

  echo "✓ 完成：GitHub 已更新，Cloudflare Workers（Git 构建）将自动部署最新版本"
}

# ---------- 循环模式：每 5 分钟一次，运行至整点附近，避免与整点触发重叠 ----------
if [ "${LOOP:-0}" = "1" ]; then
  echo "=== 循环模式：每 5 分钟一次（运行约 55 分钟）==="
  END=$(( $(date +%s) + 55 * 60 ))
  while [ "$(date +%s)" -lt "$END" ]; do
    run_once || true
    # 对齐到下一个 5 分钟整点，减少漂移
    NOW=$(date +%s)
    NEXT=$(( (NOW / 300 + 1) * 300 ))
    SLEEP=$(( NEXT - NOW ))
    [ "$SLEEP" -gt 0 ] && sleep "$SLEEP"
  done
  echo "=== 循环结束，等待下次整点定时触发 ==="
else
  run_once
fi
