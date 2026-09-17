#!/usr/bin/env bash
# 自动补档：增量抓取 -> 重新生成站点 dist/ -> 推送到 GitHub
# 推送后 Cloudflare Pages（Connect to Git）会自动重新部署，站点即变最新。
#
# 用法：
#   bash scripts/auto-update.sh
#
# 需要：
#   - scraper/.env 里的 POCKET48_TOKEN 与 SCRAPE_PROXY（抓取用）
#   - scraper/.env 里的 GH_TOKEN（推送到 GitHub 用；或已配置 git 凭据）
set -euo pipefail

cd "$(dirname "$0")/.."

NODE="${NODE:-/Users/tansy/.workbuddy/binaries/node/versions/22.22.2/bin/node}"
MAX_PAGES="${MAX_PAGES:-3}"

# 从 scraper/.env 读取 GH_TOKEN（若未在环境变量中给出）
if [ -z "${GH_TOKEN:-}" ] && [ -f scraper/.env ]; then
  GH_TOKEN="$(grep -E '^GH_TOKEN=' scraper/.env | head -1 | cut -d= -f2- || true)"
fi

echo "[1/4] 增量抓取（口袋发言 / 直播 / 公演）..."
( cd scraper && MAX_PAGES="$MAX_PAGES" "$NODE" scrape.mjs )

echo "[2/4] 生成发布目录 dist/ ..."
"$NODE" scripts/build-dist.mjs

echo "[3/4] 提交变更..."
git add -A
if git diff --cached --quiet; then
  echo "    无变更，跳过提交"
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

echo "[5/5] 同步 GitHub Pages 镜像 (gh-pages) ..."
TMP="$(mktemp -d)"
cp -R dist/. "$TMP/"
( cd "$TMP" \
  && git init -q && git add -A \
  && git -c user.email=archive@local -c user.name=wangyuchen-archive \
        commit -q -m "auto: site update $(date '+%Y-%m-%d %H:%M')" \
  && git branch -M gh-pages \
  && if [ -n "${GH_TOKEN:-}" ]; then \
       git push -f "https://${GH_TOKEN}@github.com/winccctan/wangyuchen-archive.git" gh-pages; \
     else \
       git push -f origin gh-pages; \
     fi )
rm -rf "$TMP"

echo "✓ 完成：GitHub 已更新，Cloudflare Pages（Connect to Git）将自动部署最新版本"
