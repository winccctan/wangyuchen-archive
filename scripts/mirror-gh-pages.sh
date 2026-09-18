#!/usr/bin/env bash
# 镜像 dist/ 到 gh-pages 分支（供 GitHub Pages 备用访问）。
# 用途：
#   - 本地：auto-update.sh 调用
#   - CI：GitHub Actions 工作流调用（用 $GH_TOKEN 或默认 GITHUB_TOKEN 推送）
#
# 说明：Cloudflare Workers（Git 构建）会构建所有分支，故镜像分支根目录也要放一份
#       wrangler.jsonc + worker/，否则 Wrangler 报 "Missing entry-point" 而构建失败。
set -euo pipefail
cd "$(dirname "$0")/.."

TMP="$(mktemp -d)"
cp -R dist/. "$TMP/"
mkdir -p "$TMP/worker"
cp worker/index.js "$TMP/worker/index.js"
cp wrangler.jsonc "$TMP/wrangler.jsonc"
touch "$TMP/.nojekyll"

REMOTE="https://github.com/winccctan/wangyuchen-archive.git"
if [ -n "${GH_TOKEN:-}" ]; then
  # 必须用 x-access-token:<token> 形式，把 token 放在「密码」位。
  # 若写成 https://<token>@github.com，git 会把 token 当用户名、再去索要密码，
  # 非交互的 CI 环境会直接失败：could not read Password。
  REMOTE="https://x-access-token:${GH_TOKEN}@github.com/winccctan/wangyuchen-archive.git"
fi

( cd "$TMP" \
  && git init -q && git add -A \
  && git -c user.email=archive@local -c user.name=wangyuchen-archive \
        commit -q -m "auto: mirror update $(date '+%Y-%m-%d %H:%M')" \
  && git branch -M gh-pages \
  && git push -f "$REMOTE" gh-pages )
rm -rf "$TMP"
echo "✓ gh-pages 镜像已更新"
