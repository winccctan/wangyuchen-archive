# 部署说明（王语晨补档站）

站点为**纯静态**（`dist/` 自包含，3.8MB 左右），任意静态托管都能跑，无需后端。
数据（口袋发言/直播/公演）已全部打包进 `dist/data/archive.js`，托管后别人打开即用。

> 注意：抓取（写入数据）仍需在你本机用 `node scraper/scrape.mjs` 跑（需国内 IP + 你自己的 `POCKET48_TOKEN`）。托管只负责"展示"，不负责"抓取"。重新抓取后需重跑 `node scripts/build-dist.mjs` 并重新上传 `dist/`。

---

## 方案 A：Cloudflare Pages（★推荐，国内外都能开，免费持久）

最适合"国内国外朋友都能访问"。全球 CDN，域名 `xxx.pages.dev`，可绑自定义域名。

1. 注册 Cloudflare 账号（免费）。
2. Cloudflare 控制台 → **Workers & Pages** → **Create** → **Pages** → 连接 Git 仓库（先把本仓库推到 GitHub/GitLab）。
3. 构建设置：
   - **Framework preset**: `None`
   - **Build command**: 留空（或 `node scripts/build-dist.mjs`，二选一；若留空请确保先本地生成好 `dist/`）
   - **Build output directory**: `dist`
4. 部署完成，拿到 `https://<项目名>.pages.dev`，发给朋友即可。

> 想用命令行直传（无需 Git）：装 `wrangler` 后执行 `npx wrangler pages deploy dist`。

---

## 方案 B：GitHub Pages（免费持久，国外稳、国内偶尔慢）

1. 在 GitHub 新建仓库，把本仓库 push 上去。
2. 仓库 **Settings → Pages**，Source 选 `main` 分支（或用 `gh-pages` 分支只放 `dist/` 内容）。
3. 仓库根已放 `.nojekyll`（防止 GitHub 误当 Jekyll 处理）。
4. 访问 `https://<用户名>.github.io/<仓库名>/`。

> 若站点不在仓库根目录而在 `dist/`，可改用 `gh-pages` 分支或设置 `/dist` 路径；本项目默认把 `dist/` 内容作为站点根更省事（见下方"推送到 gh-pages"）。

---

## 方案 C：继续用 CloudStudio（已部署，最简单）

当前链接：`https://3ea9fdf1e28c47a7b747bdb025af13a8.app.workbuddy.host`
- 腾讯云，国内外基本都能开；属临时沙箱，长期建议迁到 A/B。
- 更新内容：本地改完跑 `node scripts/build-dist.mjs`，再让我重新部署即可。

---

## 推送到 gh-pages（仅放 dist 内容，GitHub Pages 用）

```bash
# 需先在 GitHub 建好空仓库并 git remote add origin <url>
node scripts/build-dist.mjs
git add -A && git commit -m "update archive"
git push -u origin main
# 或只发布 dist：
npx gh-pages -d dist
```

## 更新数据后重新发布

```bash
# 1) 本机抓最新数据（需国内 IP + POCKET48_TOKEN）
cd scraper && node scrape.mjs && cd ..
# 2) 重新构建 dist（含 ?v= 缓存版本号）
node scripts/build-dist.mjs
# 3) 重新上传到你的托管（Cloudflare 自动重部署 / GitHub push / CloudStudio 重新部署）
```
